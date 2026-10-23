import { RpcTarget } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type {
  AiChatAuthorInfo, AiChatMessage, AiChatMessageBody,
} from "@gadgets/workshop-shared/api";
import type { ActionDescription, ActionField } from "@gadgets/workshop-shared/gatekeeper";
import {
  MAX_INSTANCE_ADMIN_ACTION_CHARS, assertInstanceAdminActionFits, assertPlainAdminResult,
  canonicalAdminCall, instanceAdminActionChars, instanceAdminActivationCard,
  instanceAdminApprovedNudge, instanceAdminCallCard, instanceAdminReadObservation,
  instanceAdminRunExpired, instanceAdminStringField, instanceAdminViewObservation,
  isBlueprintProposal, isInstanceAdminCapsule, sentenceCase, turnAnswersOwner,
} from "../src/instance-admin";
import type { GatekeeperRecord } from "../src/storage-schema/overseer-storage";

class Target extends RpcTarget {}

const R13 = "This call's arguments are too large for an approval card: with the card that shows " +
  "them, they may take at most 40,000 characters.";

function field(fields: ActionField[] | undefined, label: string): ActionField | undefined {
  return fields?.find(f => f.label === label);
}

// The text a json field shows, decoded back to its value.
function decoded(f: ActionField | undefined): unknown {
  expect(f?.kind).toBe("json");
  return JSON.parse((f as { value: string }).value);
}

describe("canonicalAdminCall", () => {
  it("accepts JSON values, sorts keys at every level and drops what JSON drops", () => {
    let proto = JSON.parse('{"__proto__": {"polluted": true}, "b": 1}') as object;
    let call = canonicalAdminCall([
      { z: 1, a: { y: [true, null, "s"], x: -2.5 }, skipped: undefined },
      proto,
      "text",
      undefined,
      undefined,
    ]);
    expect(call.json).toBe(
      '[{"a":{"x":-2.5,"y":[true,null,"s"]},"z":1},{"__proto__":{"polluted":true},"b":1},"text"]');
    expect(call.args).toHaveLength(3);
    expect(Object.hasOwn(call.args[1] as object, "__proto__")).toBe(true);
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it("sorts integer-like keys as strings, which object key order would not", () => {
    expect(canonicalAdminCall([{ 10: "a", 2: "b", x: "c" }]).json)
      .toBe('[{"10":"a","2":"b","x":"c"}]');
  });

  it("keeps a value two arguments share", () => {
    let shared = { a: 1 };
    expect(canonicalAdminCall([shared, [shared]]).json).toBe('[{"a":1},[{"a":1}]]');
  });

  it("refuses a value shared at every level with R13 as soon as its JSON passes the bound", () => {
    // RPC keeps shared references: 40 levels make a JSON of 2^40 leaves from a tiny message.
    let doubling: unknown = 1;
    for (let i = 0; i < 40; i++) doubling = [doubling, doubling];
    expect(() => canonicalAdminCall([doubling])).toThrow(/at most 40,000 characters/);
  });

  it("refuses with R13 a shared object of undefined members visited past the bound", () => {
    // Its JSON is "{}" at each visit, but each visit walks every key.
    let empty: Record<string, unknown> = {};
    for (let i = 0; i < 1_000; i++) empty[`k${i}`] = undefined;
    expect(canonicalAdminCall([Array(40).fill(empty)]).json).toBe(`[[${Array(40).fill("{}")}]]`);
    expect(() => canonicalAdminCall([Array(41).fill(empty)])).toThrow(/at most 40,000 characters/);
  });

  it("drops trailing undefined arguments without walking a sparse array's length", () => {
    let sparse: unknown[] = ["a", undefined];
    sparse.length = 4_294_967_295;
    expect(canonicalAdminCall(sparse).json).toBe('["a"]');
    let gap: unknown[] = [];
    gap[2] = 1;
    expect(() => canonicalAdminCall(gap)).toThrow(/args\[0\]: undefined/);
  });

  it("accepts a JSON of exactly 40,000 characters", () => {
    let fill = { k: "x".repeat(40_000 - '[{"k":""},"y"]'.length) };
    let call = canonicalAdminCall([fill, "y"]);
    expect(call.json).toHaveLength(40_000);
    expect(() => canonicalAdminCall([{ ...fill, k: `${fill.k}x` }, "y"])).toThrow(/40,000/);
  });

  it("refuses each kind of value JSON can't carry, naming its path", () => {
    let cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    let deep: unknown = 1;
    for (let i = 0; i < 65; i++) deep = [deep];
    let cases: [unknown[], string][] = [
      [[() => 1], "args[0]: a function or stub"],
      [[new Target()], "args[0]: an RpcTarget"],
      [[{ when: new Date() }], "args[0].when: a Date"],
      [[new Map()], "args[0]: a Map"],
      [[new Set()], "args[0]: a Set"],
      [[new Uint8Array(2)], "args[0]: bytes"],
      [[new ArrayBuffer(2)], "args[0]: bytes"],
      [[1n], "args[0]: a bigint"],
      [[{ "odd key": Symbol("s") }], 'args[0]["odd key"]: a symbol'],
      [[NaN], "args[0]: NaN"],
      [[{ n: Infinity }], "args[0].n: Infinity"],
      [[[1, undefined]], "args[0][1]: undefined"],
      // eslint-disable-next-line no-sparse-arrays
      [[[1, , 3]], "args[0][1]: an empty array slot"],
      [[undefined, 1], "args[0]: undefined"],
      [[cyclic], "args[0].self: a cycle"],
      [[new (class Point { x = 1; })()], "args[0]: an object that isn't plain"],
    ];
    for (let [args, prefix] of cases) {
      expect(() => canonicalAdminCall(args)).toThrow(TypeError);
      expect(() => canonicalAdminCall(args))
        .toThrow(`${prefix} can't be queued for approval; only JSON values can.`);
    }
    expect(() => canonicalAdminCall([deep])).toThrow(/nesting deeper than 64 levels/);
  });

  it("accepts 64 levels of nesting", () => {
    let deep: unknown = 1;
    for (let i = 0; i < 64; i++) deep = [deep];
    expect(canonicalAdminCall([deep]).args).toEqual([deep]);
  });

  it("gives R13 when the JSON alone passes the bound", () => {
    expect(() => canonicalAdminCall(["x".repeat(MAX_INSTANCE_ADMIN_ACTION_CHARS)])).toThrow(R13);
    expect(canonicalAdminCall(["x".repeat(MAX_INSTANCE_ADMIN_ACTION_CHARS - 4)]).json)
      .toHaveLength(MAX_INSTANCE_ADMIN_ACTION_CHARS);
  });
});

describe("assertInstanceAdminActionFits", () => {
  it("refuses a call whose JSON fits but whose card pushes the total past the bound", () => {
    // JSON.stringify leaves zero-width spaces as they are; the card's json field escapes each to
    // six characters.
    let call = canonicalAdminCall(["\u200B".repeat(7_000)]);
    expect(call.json.length).toBeLessThan(MAX_INSTANCE_ADMIN_ACTION_CHARS);
    let card = instanceAdminCallCard("change", "setSiteName", call);
    expect(field(card.fields, "Argument 1")?.kind).toBe("json");
    expect(instanceAdminActionChars(call, card)).toBeGreaterThan(MAX_INSTANCE_ADMIN_ACTION_CHARS);
    expect(() => assertInstanceAdminActionFits(call, card)).toThrow(R13);
  });

  it("fits the longest instance instructions, even shown as a json field", () => {
    let text = "a".repeat(7_999) + "\u202E";
    let call = canonicalAdminCall([text]);
    let card = instanceAdminCallCard("change", "setInstanceInstructions", call);
    expect(decoded(field(card.fields, "Argument 1"))).toBe(text);
    expect(() => assertInstanceAdminActionFits(call, card)).not.toThrow();
  });

  it("refuses 8,000 characters dense in what the card escapes", () => {
    let call = canonicalAdminCall(["\u200B".repeat(8_000)]);
    expect(call.json.length).toBeLessThan(8_010);
    let card = instanceAdminCallCard("change", "setInstanceInstructions", call);
    expect(() => assertInstanceAdminActionFits(call, card)).toThrow(R13);
  });

  it("refuses 8,000 characters dense in what the JSON escapes", () => {
    // U+0001 is one JSON.stringify writes as \u0001, six characters. \b, \t, \n, \f and \r escape
    // to two, and tab and LF show as a text field rather than json, so 8,000 of those fit.
    expect(() => canonicalAdminCall(["\u0001".repeat(8_000)])).toThrow(R13);
    let newlines = canonicalAdminCall(["\n".repeat(8_000)]);
    let card = instanceAdminCallCard("change", "setInstanceInstructions", newlines);
    expect(() => assertInstanceAdminActionFits(newlines, card)).not.toThrow();
  });

  it("counts the JSON, the title, the description and every label and value", () => {
    let call = canonicalAdminCall(["v"]);
    let card: ActionDescription = {
      title: "tt", description: "ddd", implementsRevert: false,
      fields: [
        { label: "L", kind: "inline", value: "vv" },
        { label: "LL", kind: "list", items: ["a", "bc"] },
      ],
    };
    expect(instanceAdminActionChars(call, card)).toBe(call.json.length + 2 + 3 + 1 + 2 + 2 + 3);
  });
});

describe("instanceAdminStringField", () => {
  it("shows a short plain string inline", () => {
    expect(instanceAdminStringField("Name", "Acme")).toEqual(
      { label: "Name", kind: "inline", value: "Acme" });
  });

  it("shows text that one line can't show exactly as text", () => {
    expect(instanceAdminStringField("Text", "one\ntwo")).toEqual(
      { label: "Text", kind: "text", value: "one\ntwo" });
    expect(instanceAdminStringField("Text", "x".repeat(121)).kind).toBe("text");
    expect(instanceAdminStringField("Text", " edge").kind).toBe("text");
    expect(instanceAdminStringField("Text", "a  b").kind).toBe("text");
  });

  it("escapes an invisible or reordering character, or a CR, as json that decodes to the value", () => {
    for (let value of ["admin\u202Etxt.exe", "admin\u200B@x.com", "one\r\ntwo", "tag\u{E0041}"]) {
      let f = instanceAdminStringField("Value", value);
      expect(decoded(f)).toBe(value);
      expect((f as { value: string }).value).not.toMatch(/[\u202E\u200B\r]|\u{E0041}/u);
    }
  });

  it("cuts a value over maxChars and says so in UTF-8 bytes", () => {
    let f = instanceAdminStringField("Title", "é".repeat(300), 256);
    expect(f).toEqual({
      label: "Title", kind: "text", value: "é".repeat(256),
      truncated: { shownBytes: 512, totalBytes: 600 },
    });
  });

  it("never cuts between the halves of a surrogate pair", () => {
    let f = instanceAdminStringField("Title", "a" + "😀".repeat(10), 4);
    expect((f as { value: string }).value).toBe("a😀");
  });
});

describe("cards", () => {
  let activation = instanceAdminActivationCard(false);
  let reactivation = instanceAdminActivationCard(true);
  let change = instanceAdminCallCard("change", "setAnnouncement", canonicalAdminCall(["Hello"]));
  let confirm = instanceAdminCallCard("confirm", "testGatewayModel",
    canonicalAdminCall(["@cf/model"]));
  let inspect = instanceAdminCallCard("inspect", "inspectWorkspace",
    canonicalAdminCall(["ws-1", "Abuse report", { access: "full" }]), "Team \u202Eplans");

  it("titles each kind", () => {
    expect(activation.title).toBe("Turn on deployment admin access in this workspace");
    expect(reactivation.title).toBe("Turn deployment admin access back on in this workspace");
    expect(change.title).toBe("Set announcement (deployment admin)");
    expect(confirm.title).toBe("Test gateway model (deployment admin, billed)");
    expect(inspect.title).toBe("Inspect a workspace with full access (deployment admin)");
  });

  it("is complete, never auto-approvable, and waited on", () => {
    for (let card of [activation, reactivation, change, confirm, inspect]) {
      expect(card.descriptionIsComplete).toBe(true);
      expect(card.implementsRevert).toBe(false);
      expect(card.awaitDecision).toBe(true);
      expect(card).not.toHaveProperty("actionKind");
      expect(card).not.toHaveProperty("autoApprovable");
    }
  });

  it("shows the method and each argument exactly", () => {
    expect(change.fields).toEqual([
      { label: "Method", kind: "inline", value: "AdminApi.setAnnouncement" },
      { label: "Argument 1", kind: "inline", value: "Hello" },
    ]);
    expect(decoded(field(inspect.fields, "Argument 3"))).toEqual({ access: "full" });
    let bidi = instanceAdminCallCard("change", "setSiteName", canonicalAdminCall(["evil\u202Egnp"]));
    expect(decoded(field(bidi.fields, "Argument 1"))).toBe("evil\u202Egnp");
  });

  it("states the approval window in minutes", () => {
    expect(confirm.description).toContain("within 15 minutes");
    expect(confirm.description).toContain("which the providers bill");
    expect(inspect.description).toContain("within 15 minutes");
  });

  it("names the workspace an inspection opens, with its directory title escaped", () => {
    expect(field(inspect.fields, "Workspace")).toEqual(
      { label: "Workspace", kind: "inline", value: "ws-1" });
    expect(decoded(field(inspect.fields, "Title in the directory"))).toBe("Team \u202Eplans");
    let long = instanceAdminCallCard("inspect", "inspectWorkspace",
      canonicalAdminCall(["ws-1", "r", { access: "full" }]), "t".repeat(300));
    expect(field(long.fields, "Title in the directory")?.truncated)
      .toEqual({ shownBytes: 256, totalBytes: 300 });
  });

  it("warns about exfiltration in both activation texts", () => {
    for (let card of [activation, reactivation]) {
      for (let phrase of [
        "Prompt injection can leak what the agent reads", "other connections", "its gadgets",
        "blueprints you publish", "AI model provider", "AI Gateway logs", "instance instructions",
        "the names of its standard formats", "Use a dedicated workspace",
        "such as Web Search, are in this one too", "a search query can carry data out",
        "remove the optional ones from Connectors (which removes them from all your workspaces)",
        "ask an admin to disable them",
      ]) expect(card.description).toContain(phrase);
    }
  });

  it("states the turn rule, callbacks and slash commands excluded, in both activation texts", () => {
    for (let card of [activation, reactivation]) {
      expect(card.description).toContain("in turns that answer a message you wrote yourself here");
      expect(card.description).toContain("callback");
      expect(card.description).toContain("slash command");
    }
    expect(reactivation.description).toContain("Admin API as you again");
  });

  it("says other admins can still inspect the workspace, in both activation texts", () => {
    for (let card of [activation, reactivation]) {
      expect(card.description).toContain("Other deployment admins can still inspect it, as they " +
        "can any workspace; their inspections are recorded in the admin audit log.");
    }
    expect(activation.description).toContain("**Part of this is permanent.**");
    expect(reactivation.description).toContain("already is yours alone and restricted");
  });
});

describe("observations", () => {
  it("records a read, bounded and restricted", () => {
    let o = instanceAdminReadObservation("listUsers", [{ query: "x".repeat(20_000) }],
      { value: { users: [1, 2, 3], hasMore: false, cursor: "c" } });
    expect(o.title).toBe("List users (deployment admin)");
    expect(o.description).toBe(
      "Your agent read deployment admin data through the Admin API, as you.");
    expect(o.containsRestrictedData).toBe(true);
    expect(field(o.fields, "Method")).toEqual(
      { label: "Method", kind: "inline", value: "AdminApi.listUsers" });
    let args = field(o.fields, "Arguments") as { value: string; truncated?: unknown };
    expect(args.value.length).toBeLessThanOrEqual(16 * 1024);
    expect(args.truncated).toEqual({ shownBytes: 16 * 1024, totalBytes: expect.any(Number) });
    expect(field(o.fields, "Result")).toEqual(
      { label: "Result", kind: "inline", value: "users: 3, hasMore: false" });
    expect(JSON.stringify(o)).not.toContain('"c"');
  });

  it("bounds its walk of arguments that share a value at every level", () => {
    let doubling: unknown = 1;
    for (let i = 0; i < 40; i++) doubling = [doubling, doubling];
    let o = instanceAdminReadObservation("listUsers", [doubling], { value: null });
    expect(field(o.fields, "Arguments")).toEqual(
      { label: "Arguments", kind: "inline", value: "(too large to show)" });
  });

  it("bounds its walk by the indentation of deeply nested arguments", () => {
    let leaves: unknown = Array.from({ length: 100_000 }, () => [0]);
    for (let i = 0; i < 64; i++) leaves = [leaves];
    let o = instanceAdminReadObservation("getSettings", [leaves], { value: null });
    expect(field(o.fields, "Arguments")).toEqual(
      { label: "Arguments", kind: "inline", value: "(too large to show)" });
  });

  it("shows a long list of booleans as text, not inline", () => {
    let settings = Object.fromEntries(
      Array.from({ length: 12 }, (_, i) => [`someSettingNumber${i}Enabled`, true]));
    let o = instanceAdminReadObservation("getSettings", [], { value: settings });
    let result = field(o.fields, "Result") as { kind: string; value: string };
    expect(result.value.length).toBeGreaterThan(120);
    expect(result.kind).toBe("text");
  });

  it("summarises a result that is an array or a boolean, and leaves out one with nothing to say", () => {
    let items = instanceAdminReadObservation("testNewGatewayModel", [{}], { value: [{}, {}] });
    expect(field(items.fields, "Result")).toMatchObject({ value: "items: 2" });
    let featured = instanceAdminReadObservation("isBlueprintFeatured", ["b"], { value: true });
    expect(field(featured.fields, "Result")).toMatchObject({ value: "value: true" });
    for (let value of [undefined, null]) {
      let o = instanceAdminReadObservation("inspectWorkspace", ["ws"], { value });
      expect(field(o.fields, "Result")).toBeUndefined();
    }
  });

  it("records an approved call that returned, and one that threw", () => {
    let ran = instanceAdminReadObservation("testGatewayModel", ["m"], { value: { ok: true } }, 7);
    expect(ran.description).toBe(
      "Your agent made the call you approved to the deployment's Admin API, as you.");
    expect(field(ran.fields, "Approved as")).toEqual(
      { label: "Approved as", kind: "inline", value: "action 7" });

    let failed = instanceAdminReadObservation("testNewGatewayModel", [{}],
      { error: new Error("boom ".repeat(1_000)) }, 8);
    expect(failed.description).toBe("Your agent made the call you approved to the deployment's " +
      "Admin API, as you, and it failed.");
    let error = field(failed.fields, "Error") as { value: string; truncated?: unknown };
    expect(error.value.length).toBe(2_000);
    expect(error.truncated).toEqual({ shownBytes: 2_000, totalBytes: 5_000 });
    expect(field(failed.fields, "Result")).toBeUndefined();
    expect(field(failed.fields, "Approved as")).toMatchObject({ value: "action 8" });

    let thrownString = instanceAdminReadObservation("testGatewayModel", ["m"], { error: "nope" }, 9);
    expect(field(thrownString.fields, "Error")).toMatchObject({ value: "nope" });
  });

  it("records a view call, bounded and restricted", () => {
    let o = instanceAdminViewObservation({ workspaceId: "ws-1", reason: "Abuse\u202E report" },
      "readFile", [1, "x".repeat(20_000)]);
    expect(o.title).toBe("Inspect workspace: readFile (deployment admin)");
    expect(o.containsRestrictedData).toBe(true);
    expect(field(o.fields, "Workspace")).toMatchObject({ kind: "inline", value: "ws-1" });
    expect(decoded(field(o.fields, "Reason"))).toBe("Abuse\u202E report");
    expect(field(o.fields, "Method")).toMatchObject({ value: "AdminWorkspaceView.readFile" });
    let args = field(o.fields, "Arguments") as { value: string; truncated?: unknown };
    expect(args.value.length).toBeLessThanOrEqual(16 * 1024);
    expect(args.truncated).toMatchObject({ shownBytes: 16 * 1024 });
  });
});

describe("instanceAdminApprovedNudge", () => {
  it("names each title, says nothing ran, and says to repeat the call", () => {
    expect(instanceAdminApprovedNudge(["Turn on A", "Test B"])).toBe(
      'Your user approved "Turn on A", "Test B". Nothing ran when you asked: make those calls ' +
      "again now, with the same arguments. An approved single call runs once, as the identical " +
      "call, within 15 minutes.");
  });
});

describe("assertPlainAdminResult", () => {
  it("refuses a function or an RpcTarget at any depth", () => {
    let message = "AdminApi.listUsers returned a capability, which the instance admin binding " +
      "passes on only from AdminApi.inspectWorkspace().";
    for (let value of [
      () => 1, new Target(), { users: [{ name: "a", leak: () => 1 }] },
      [[[new Target()]]], new Map([["k", () => 1]]),
    ]) expect(() => assertPlainAdminResult("AdminApi.listUsers", value)).toThrow(message);
  });

  it("accepts plain data, dates and bytes", () => {
    expect(() => assertPlainAdminResult("AdminApi.getSettings", {
      a: [1, "s", null, true], when: new Date(), bytes: new Uint8Array(1_000), none: undefined,
    })).not.toThrow();
    expect(() => assertPlainAdminResult("AdminApi.getSettings", null)).not.toThrow();
  });

  it("stops on cycles", () => {
    let cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    expect(() => assertPlainAdminResult("AdminApi.getSettings", cyclic)).not.toThrow();
  });

  it("refuses a value nested deeper than it walks", () => {
    let deep: unknown = 1;
    for (let i = 0; i < 65; i++) deep = { next: deep };
    expect(() => assertPlainAdminResult("AdminApi.getSettings", deep))
      .toThrow("AdminApi.getSettings returned a value nested deeper than 64 levels.");
    let fits: unknown = 1;
    for (let i = 0; i < 64; i++) fits = { next: fits };
    expect(() => assertPlainAdminResult("AdminApi.getSettings", fits)).not.toThrow();
  });
});

function capsuleRecord(creationSpec: GatekeeperRecord["creationSpec"]): GatekeeperRecord {
  return { id: 1, class: {}, creationSpec } as unknown as GatekeeperRecord;
}

describe("isInstanceAdminCapsule", () => {
  it("holds only for an ambient record of the instance admin vendor", () => {
    expect(isInstanceAdminCapsule(
      capsuleRecord({ type: "ambient", vendorId: "instanceadmin", accountId: 1 }))).toBe(true);
    expect(isInstanceAdminCapsule(
      capsuleRecord({ type: "ambient", vendorId: "websearch", accountId: 1 }))).toBe(false);
    expect(isInstanceAdminCapsule(capsuleRecord({
      type: "gatekeeper", vendorId: "instanceadmin", typeUrlPattern: "instanceadmin://*",
    }))).toBe(false);
    expect(isInstanceAdminCapsule(capsuleRecord(undefined))).toBe(false);
    expect(isInstanceAdminCapsule(undefined)).toBe(false);
  });
});

describe("turnAnswersOwner", () => {
  const owner: AiChatAuthorInfo = { type: "user", id: "owner@example.test", name: "Owner" };
  const other: AiChatAuthorInfo = { type: "user", id: "other@example.test", name: "Other" };
  const agent: AiChatAuthorInfo = { type: "agent", id: "model", name: "Agent" };
  const gadget: AiChatAuthorInfo = { type: "gadget", id: "owner@example.test", name: "Gadget" };

  let sequence = 0;
  let record = (author: AiChatAuthorInfo, body: AiChatMessageBody): AiChatMessage =>
    ({ chatId: 1, sequence: ++sequence, timestamp: new Date(sequence), author, ...body });
  let prompt = (author = owner, extra: Partial<Extract<AiChatMessageBody, { type: "message" }>> = {}) =>
    record(author, { type: "message", message: "hello", ...extra });
  let reply = () => record(agent, { type: "message", message: "done" });
  let nudge = (text: string) => record(owner, { type: "agentNudge", text });
  let callback = () => record(gadget,
    { type: "agentCallback", methodName: "onEvent", argsSummary: "[]" });
  let compact = () => record(owner,
    { type: "slashCommand", request: { id: { builtin: true, commandId: "compact" }, args: "" } });
  let gatekeeperCommand = () => record(owner, {
    type: "slashCommand", request: { id: { gatekeeperId: 5, commandId: "skill" }, args: "" },
  });
  // A connection's slash command: its record, then the expansion its provider wrote, logged as the
  // invoking user's.
  let slashCommand = () => {
    let command = gatekeeperCommand();
    return [command, prompt(owner, { generatedBySlashCommandSequence: command.sequence })];
  };
  // The log oldest first, as the chat wrote it; turnAnswersOwner reads it newest first.
  let answers = (log: AiChatMessage[]) => turnAnswersOwner(log.toReversed(), owner.id);

  it("holds for the owner's prompt, and past the records that continue it", () => {
    expect(answers([prompt()])).toBe(true);
    expect(answers([prompt(), reply(), nudge("The changes you submitted have been approved"),
      reply(), nudge("Retry the previous request."), reply()])).toBe(true);
  });

  it("fails for a task a callback started, whatever continues it", () => {
    expect(answers([prompt(), reply(), callback()])).toBe(false);
    expect(answers([callback(), reply(), nudge("Retry the previous request.")])).toBe(false);
    expect(answers([callback(), prompt(owner, { steered: true })])).toBe(false);
  });

  it("fails for a gadget's or another user's prompt, and for an empty log", () => {
    expect(answers([prompt(gadget)])).toBe(false);
    expect(answers([prompt(other)])).toBe(false);
    expect(answers([])).toBe(false);
  });

  it("fails for a connection's slash command, its resumptions and its retries", () => {
    expect(answers([prompt(), reply(), ...slashCommand()])).toBe(false);
    expect(answers([...slashCommand(), reply(),
      nudge("The changes you submitted have been approved")])).toBe(false);
    expect(answers([...slashCommand(), reply(), nudge("Retry the previous request.")])).toBe(false);
  });

  it("holds again for the owner's own message after a slash command", () => {
    expect(answers([...slashCommand(), reply(), prompt()])).toBe(true);
  });

  it("passes over a gatekeeper command record with no expansion", () => {
    expect(answers([prompt(), reply(), gatekeeperCommand()])).toBe(true);
  });

  it("passes over the built-in /compact, so a retry after it continues the task before it", () => {
    expect(answers([prompt(), reply(), compact(), nudge("Retry the previous request.")]))
      .toBe(true);
    expect(answers([callback(), reply(), compact(), nudge("Retry the previous request.")]))
      .toBe(false);
    expect(answers([...slashCommand(), reply(), compact(), nudge("Retry the previous request.")]))
      .toBe(false);
    expect(answers([compact()])).toBe(false);
  });
});

function first(author: AiChatAuthorInfo, body: AiChatMessageBody): AiChatMessage {
  return { chatId: 1, sequence: 1, timestamp: new Date(1), author, ...body };
}

describe("isBlueprintProposal", () => {
  const user: AiChatAuthorInfo = { type: "user", id: "u", name: "U" };
  const agent: AiChatAuthorInfo = { type: "agent", id: "m", name: "A" };
  let merges = [{}] as unknown as Extract<AiChatMessageBody, { type: "changes" }>["blueprintMerges"];

  it("holds only for a user's changes record carrying blueprint merges", () => {
    expect(isBlueprintProposal(first(user, { type: "changes", blueprintMerges: merges }))).toBe(true);
    expect(isBlueprintProposal(first(agent, { type: "changes", blueprintMerges: merges })))
      .toBe(false);
    expect(isBlueprintProposal(first(user, { type: "changes", blueprintMerges: [] }))).toBe(false);
    expect(isBlueprintProposal(first(user, { type: "message", message: "hi" }))).toBe(false);
    expect(isBlueprintProposal(undefined)).toBe(false);
  });
});

describe("instanceAdminRunExpired", () => {
  it("expires a run only past its first 10 minutes", () => {
    expect(instanceAdminRunExpired(1_000, 1_000 + 600_000)).toBe(false);
    expect(instanceAdminRunExpired(1_000, 1_000 + 600_001)).toBe(true);
  });
});

describe("sentenceCase", () => {
  it("turns a method name into words", () => {
    expect(sentenceCase("setAnnouncement")).toBe("Set announcement");
    expect(sentenceCase("testNewGatewayModel")).toBe("Test new gateway model");
    expect(sentenceCase("listUsers")).toBe("List users");
  });
});
