// The Overseer's side of the instance admin Gatekeeper (docs/admin-access.md): which sessions get
// a grant, how long a grant works, how each AdminApi call is dispatched (read, change, one-call
// approval, inspection), how the actions the Workshop holds are applied, rejected and turned off,
// and what deployment admin access does to sharing, external messages, capsule placement and the
// agent's resume nudge.
//
// Runs against a real OverseerDurableObject (the TEST_OVERSEER binding). The deployment config,
// the owner's user DO, the directory, the facets and the owner's Admin API are fakes planted on
// the impl, and executeCode runs through a fake LOADER whose run() the test settles, so a run stays
// live exactly as long as a test needs it.

import { describe, expect, it, vi } from "vitest";
import { RpcTarget, RpcStub as NativeRpcStub, env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { ADMIN_AGENT_ACCESS, type AiChatAuthorInfo } from "@gadgets/workshop-shared/api";
import {
  INSTANCE_ADMIN_APPROVAL_LIFETIME_SECONDS, INSTANCE_ADMIN_RUN_LIMIT_SECONDS,
  type InstanceAdminCallResult, type InstanceAdminGrant,
} from "@gadgets/workshop-shared/instance-admin";
import type { OverseerDurableObject } from "../src/overseer.js";
import { ADMIN_CONFIG_KEY } from "../src/storage-schema/blueprints-kv.js";
// Load the whole backend (the pool's `main`) up front, so its slow load does not count against the
// first test's timeout.
import "./test-worker.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

// The pool's ADMINS.
const OWNER: AiChatAuthorInfo = { type: "user", id: "deployment-admin@example.test", name: "Owner" };
const OWNER_USER_ID = "owner-user-do";
const OTHER_USER: AiChatAuthorInfo = { type: "user", id: "carol@example.test", name: "Carol" };
const CAPSULE = 5;
const OTHER_GATEKEEPER = 6;
const ACCOUNT = 7;
const CHAT = 1;
const CHAT_2 = 2;

const R1 = "The instance admin binding works only in its owner's own agent turns, from executeCode.";
const R2 = "This instance admin binding belongs to an executeCode call that has ended.";
const R4 = "The instance admin binding works only while this workspace's owner is a deployment admin.";
const R5 = "The instance admin connection has been removed from this workspace.";
const R6 = "The instance admin binding doesn't work in a turn whose reply goes out through an " +
    "external message.";
const R7 = "The instance admin gatekeeper is turned off on this deployment.";
const R9 = "Deployment admin access works only in a workspace nobody else can open";
const R10 = (method: string) =>
  `AdminApi.${method} isn't available through the instance admin binding.`;
const R12 = "can't be queued for approval; only JSON values can.";
const R13 = "This call's arguments are too large for an approval card";
const R14 = "returned a capability, which the instance admin binding passes on only from " +
    "AdminApi.inspectWorkspace().";
const R16 = "This turn was stopped, so its instance admin binding no longer works.";
const R17 = "This executeCode call started more than 10 minutes ago";
const A1 = "Deployment admin actions are approved only by hand.";
const A2 = "Only this workspace's owner, while a deployment admin, can approve deployment admin " +
    "actions.";
const A3 = "Deployment admin access is off in this workspace.";
const A4 = "This action is already being applied.";
const A5 = "Deployment admin access can't be turned on while a reply to an external message is " +
    "still to be delivered.";
const T1 = "Only this workspace's owner can turn off deployment admin access.";
const X1 = "The instance admin binding can't be bound into a gadget or an agent spawner";
const X2 = "This workspace takes no external messages.";

const ACTIVATION_TITLE = "Turn on deployment admin access in this workspace";
const REACTIVATION_TITLE = "Turn deployment admin access back on in this workspace";

type AdminCall = { origin: unknown; sessionId: string; method: string; args: unknown[] };
type Deferred<T = void> = { promise: Promise<T>; resolve: (value: T) => void };

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

type Workspace = {
  impl: any;
  instance: OverseerDurableObject;
  // The deployment's ambient modes and admins, read through impl.env.
  modes: Record<string, string>;
  admins: string[];
  // Replaces the config's KV read when set, so a test can hold a call at it.
  kvGet?: (key: string) => Promise<string | null>;
  // What the fake Admin API was asked, and per-method overrides of its answers.
  calls: AdminCall[];
  api: Record<string, (...args: any[]) => unknown>;
  // What the fake facets were given.
  grants: InstanceAdminGrant[];
  sessions: unknown[];
  aborted: string[];
  // The fake directory's title lookups, and their answer.
  titleLookups: unknown[];
  title: (id: unknown) => Promise<string | null>;
  accountChecks: number;
  disposedViews: number;
  // The run fake LOADER's latest load() will run.
  lastRun?: Deferred;
  logs: { message: string; details: unknown }[];
};

// A view an inspection returns, as the fake Admin API mints it.
class FakeView extends RpcTarget {
  constructor(private ws: Workspace, private getChatAnswer?: () => unknown) { super(); }
  describe() { return { id: "w-9", title: "Other workspace" }; }
  listChats() { return [{ id: 1, title: "A chat" }]; }
  getChat() { return this.getChatAnswer?.() ?? { messages: [] }; }
  listActions() { return { entries: [] }; }
  listFiles() { return []; }
  readFile() { return { kind: "absent" }; }
  listGatekeepers() { return []; }
  getDiagnostics() { return { chats: 1 }; }
  [Symbol.dispose]() { this.ws.disposedViews++; }
}

class Capability extends RpcTarget {}

function setEnv(ws: Workspace): void {
  ws.impl.env = {
    ...env,
    get ADMINS() { return ws.admins; },
    BLUEPRINTS: {
      get: (key: string) => ws.kvGet ? ws.kvGet(key)
          : Promise.resolve(key === ADMIN_CONFIG_KEY
              ? JSON.stringify({ ambientGatekeeperModes: ws.modes }) : null),
    },
    // executeCode's worker: run() settles when the test says (see startRun).
    LOADER: {
      load: () => {
        let run = deferred();
        ws.lastRun = run;
        return { getEntrypoint: () => ({ verify: async () => {}, run: () => run.promise }) };
      },
    },
  };
}

async function withWorkspace(fn: (ws: Workspace) => Promise<void>): Promise<void> {
  let stub = env.TEST_OVERSEER.getByName(`instance-admin-${crypto.randomUUID()}`);
  await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
    let impl = (instance as unknown as { impl: any }).impl;
    let ws: Workspace = {
      impl, instance, modes: { instanceadmin: "optional" }, admins: [OWNER.id], calls: [], api: {},
      grants: [], sessions: [], aborted: [], titleLookups: [],
      title: async () => "Other workspace", accountChecks: 0, disposedViews: 0, logs: [],
    };
    setEnv(ws);
    seed(ws);
    await fn(ws);
  });
}

function seed(ws: Workspace): void {
  let impl = ws.impl;
  let owner = {
    whoami: async () => OWNER,
    assertInstanceAdminAccount: async () => { ws.accountChecks++; },
    getChatContext: async () => ({ profile: OWNER }),
    listProvidedAccounts: async () => [{
      accountId: ACCOUNT, vendorId: "instanceadmin",
      description: { displayName: "Instance admin", singleton: { tsType: "AdminApi" } },
    }],
    getSingletonGatekeeperClass: async () => ({ marker: "instance admin class" }),
    setGadgetLastActive: async () => {},
    getGadget: async () => null,
  };
  impl.users = {
    idFromString: (id: string) => id,
    idFromName: (name: string) => name,
    get: () => owner,
    getByName: () => owner,
  };
  impl.directories = {
    getByName: () => ({
      workspaceTitle: (id: unknown) => { ws.titleLookups.push(id); return ws.title(id); },
      syncWorkspace: async () => {},
      removeWorkspace: async () => {},
    }),
  };
  impl.ownerId = OWNER_USER_ID;
  impl.ownerProfileId = OWNER.id;
  impl.storage.ownerId.put(OWNER_USER_ID);
  impl.storage.title.put("Admin workspace");
  impl.storage.nextGatekeeperId.put(10);
  putCapsule(ws, CAPSULE);
  impl.storage.gatekeepers.put({
    id: OTHER_GATEKEEPER, class: {} as any, resourceTitle: "Web Search",
    creationSpec: { type: "ambient", vendorId: "websearch", accountId: 8 },
  });

  let capsuleFacet = {
    describe: async () => ({ url: "instanceadmin://deployment", title: "Instance admin" }),
    startAdminSession: async (grant: InstanceAdminGrant) => {
      ws.grants.push(grant);
      return { session: ws.grants.length };
    },
    startSession: () => { throw new Error("startSession reached the instance admin facet"); },
  };
  let otherFacet = {
    describe: async () => ({ url: "https://search.example", title: "Web Search" }),
    startSession: async (queue: unknown) => { ws.sessions.push(queue); return {}; },
    startAdminSession: () => { throw new Error("startAdminSession reached another facet"); },
  };
  impl.getGatekeeperFacet = async (id: number) =>
    id === OTHER_GATEKEEPER ? otherFacet : capsuleFacet;
  impl.ctx.facets.abort = (name: string) => { ws.aborted.push(name); };
  impl.adminApiForAgent = (agent: { origin: unknown; sessionId: string }) => new Proxy({}, {
    get: (_target, method: string) => (...args: unknown[]) => {
      ws.calls.push({ origin: agent.origin, sessionId: agent.sessionId, method, args });
      let override = ws.api[method];
      if (override) return override(...args);
      if (method === "inspectWorkspace") return new FakeView(ws);
      return { users: [{ id: "u1" }, { id: "u2" }], ok: true };
    },
  });

  seedChat(ws, CHAT);
}

function putCapsule(ws: Workspace, id: number, accountId = ACCOUNT): void {
  ws.impl.storage.gatekeepers.put({
    id, class: {} as any, resourceTitle: "Instance admin", resourceUrl: "instanceadmin://deployment",
    creationSpec: { type: "ambient", vendorId: "instanceadmin", accountId },
  });
}

function seedChat(ws: Workspace, chatId: number): void {
  ws.impl.storage.chatMeta.put({
    id: chatId, title: "Admin", started: new Date(0), lastActive: new Date(0),
  });
  ws.impl.addChatMessages(chatId, OWNER, [{ type: "message", message: "list the users" }]);
}

function setOn(ws: Workspace, active = true): void {
  ws.impl.storage.instanceAdminLatched.put(true);
  ws.impl.storage.instanceAdminActive.put(active);
}

type Run = { executionId: string; done: Promise<string>; end: () => Promise<void> };

// Starts an executeCode run in `chatId` and holds it open until its end(). Registration and
// getEnvForAgent run before executeCodeMode's first await, so the executionId is known at once.
function startRun(ws: Workspace, chatId = CHAT, initiator: AiChatAuthorInfo = OWNER,
                  capsule = CAPSULE): Run {
  let impl = ws.impl;
  let executionId!: string;
  let getEnvForAgent = impl.getEnvForAgent;
  impl.getEnvForAgent = (c: number, bindings: unknown, id: string) => {
    executionId = id;
    return getEnvForAgent.call(impl, c, bindings, id);
  };
  let done: Promise<string> = impl.executeCodeMode(chatId, "export default async () => {}",
      initiator, "model", { INSTANCE_ADMIN: { type: "workpiece", id: capsule } });
  impl.getEnvForAgent = getEnvForAgent;
  let run = ws.lastRun!;
  return {
    executionId, done,
    end: async () => {
      run.resolve();
      await impl.deliverCodeModeTrace(executionId, { logs: [] });
      await done;
    },
  };
}

async function mint(ws: Workspace, run: Run, chatId = CHAT, capsule = CAPSULE)
    : Promise<InstanceAdminGrant> {
  let before = ws.grants.length;
  await ws.impl.startGatekeeperSession(
      { type: "gatekeeper", id: capsule, executionId: run.executionId }, { from: "agent", chatId });
  expect(ws.grants.length).toBe(before + 1);
  return ws.grants.at(-1)!;
}

function call(grant: InstanceAdminGrant, method: string, ...args: unknown[])
    : Promise<InstanceAdminCallResult> {
  return grant.callAdminApi(method, args);
}

function observations(ws: Workspace): any[] {
  return [...ws.impl.storage.actions.list()].filter((r: any) => r.type === "observation");
}

function adminActions(ws: Workspace): any[] {
  return [...ws.impl.storage.actions.list()].filter((r: any) => r.instanceAdmin !== undefined);
}

function action(ws: Workspace, id: number): any {
  return ws.impl.storage.actions.get(id);
}

function approve(ws: Workspace, id: number, by: AiChatAuthorInfo = OWNER, auto = false)
    : Promise<void> {
  return ws.impl.applyPendingAction(action(ws, id), by, auto);
}

function field(record: any, label: string): any {
  return record.description.fields.find((f: any) => f.label === label);
}

// Waits until `condition` holds, a macrotask at a time.
async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !condition(); i++) await scheduler.wait(1);
  expect(condition()).toBe(true);
}

function undelivered(ws: Workspace, chatId: number): void {
  ws.impl.storage.gadgetResponseDeliveries.put({
    idempotencyKey: `reply-${chatId}`, chatId, promptSequence: 0, chatGatewayRpcTarget: {} as any,
    createdAt: Date.now(), status: "waiting",
  });
}

async function queued(promise: Promise<InstanceAdminCallResult>): Promise<number> {
  let result = await promise;
  if (result.outcome !== "queued") throw new Error(`Expected a queued change: ${result.outcome}`);
  return result.actionId;
}

async function needsApproval(promise: Promise<InstanceAdminCallResult>)
    : Promise<{ actionId: number; existing: boolean; reason: string }> {
  let result = await promise;
  if (result.outcome !== "needsApproval") {
    throw new Error(`Expected an approval request: ${result.outcome}`);
  }
  return result;
}

describe("minting a grant", () => {
  it("serves only the agent's run, through the loopback minted for it",
      () => withWorkspace(async ws => {
    let run = startRun(ws);
    let loopback = { type: "gatekeeper", id: CAPSULE, executionId: run.executionId };
    await expect(ws.impl.startGatekeeperSession(loopback, { from: "user" })).rejects.toThrow(R1);
    await expect(ws.impl.startGatekeeperSession(loopback, { from: "gadget", gadgetId: 1 }))
        .rejects.toThrow(R1);
    await expect(ws.impl.startGatekeeperSession(
        { type: "gatekeeper", id: CAPSULE }, { from: "agent", chatId: CHAT })).rejects.toThrow(R1);
    await expect(ws.impl.startGatekeeperSession(
        { ...loopback, executionId: "another" }, { from: "agent", chatId: CHAT }))
        .rejects.toThrow(R2);
    await expect(ws.impl.startGatekeeperSession(loopback, { from: "agent", chatId: CHAT_2 }))
        .rejects.toThrow(R2);
    await mint(ws, run);
    await run.end();
    await expect(ws.impl.startGatekeeperSession(loopback, { from: "agent", chatId: CHAT }))
        .rejects.toThrow(R2);
  }));

  it("refuses a demoted owner, a removed or replaced capsule and an undelivered reply",
      () => withWorkspace(async ws => {
    let run = startRun(ws);
    ws.admins = [];
    await expect(mint(ws, run)).rejects.toThrow(R4);
    ws.admins = [OWNER.id];

    ws.impl.storage.gatekeepers.delete(CAPSULE);
    await expect(mint(ws, run)).rejects.toThrow(R5);
    ws.impl.storage.gatekeepers.put({
      id: CAPSULE, class: {} as any,
      creationSpec: { type: "ambient", vendorId: "websearch", accountId: ACCOUNT },
    });
    await expect(mint(ws, run)).rejects.toThrow(R5);
    putCapsule(ws, CAPSULE);

    undelivered(ws, CHAT);
    await expect(mint(ws, run)).rejects.toThrow(R6);
    expect(ws.grants).toStrictEqual([]);
    await run.end();
  }));

  it("refuses a disabled vendor before checking the account", () => withWorkspace(async ws => {
    let run = startRun(ws);
    ws.modes.instanceadmin = "disabled";
    await expect(mint(ws, run)).rejects.toThrow(R7);
    expect(ws.accountChecks).toBe(0);
    ws.modes.instanceadmin = "optional";
    await mint(ws, run);
    await mint(ws, run);
    // Once per run.
    expect(ws.accountChecks).toBe(1);
    await run.end();
  }));

  it("leaves every other gatekeeper's sessions as they were", () => withWorkspace(async ws => {
    let run = startRun(ws);
    await ws.impl.startGatekeeperSession(
        { type: "gatekeeper", id: OTHER_GATEKEEPER }, { from: "agent", chatId: CHAT });
    expect(ws.sessions).toHaveLength(1);
    expect(ws.grants).toStrictEqual([]);
    await run.end();
  }));

  it("refuses a user's direct session, and a record that isn't ambient",
      () => withWorkspace(async ws => {
    let capsule = await ws.impl.addGatekeeper({} as any,
        { type: "ambient", vendorId: "instanceadmin", accountId: ACCOUNT }, OWNER_USER_ID);
    await expect(capsule.openSession()).rejects.toThrow(R1);
    let client = await ws.impl.addGatekeeper({} as any,
        { type: "gatekeeper", vendorId: "instanceadmin", resourceUrl: "x", typeUrlPattern: "x" },
        OWNER_USER_ID);
    await expect(client.openSession()).rejects.toThrow(R1);
    let id = await client.getId();
    let run = startRun(ws);
    await expect(ws.impl.startGatekeeperSession(
        { type: "gatekeeper", id, executionId: run.executionId }, { from: "agent", chatId: CHAT }))
        .rejects.toThrow(R5);
    await run.end();
  }));

  it("mints an executionId into the capsule's loopback alone", () => withWorkspace(async ws => {
    let minted: unknown[] = [];
    ws.impl.makeBindingLoopback = (target: unknown) => { minted.push(target); return {}; };
    ws.impl.getEnvForAgent(CHAT, {
      INSTANCE_ADMIN: { type: "workpiece", id: CAPSULE },
      SEARCH: { type: "workpiece", id: OTHER_GATEKEEPER },
    }, "run-1");
    expect(minted).toStrictEqual([
      { type: "git" },
      { type: "gatekeeper", id: CAPSULE, executionId: "run-1" },
      { type: "gatekeeper", id: OTHER_GATEKEEPER },
    ]);
  }));
});

describe("a grant's lifetime", () => {
  it("ends when its run settles, and a later run's grant is its own",
      () => withWorkspace(async ws => {
    setOn(ws);
    let first = startRun(ws);
    let grant = await mint(ws, first);
    await call(grant, "listUsers");
    await first.end();
    await expect(call(grant, "listUsers")).rejects.toThrow(R2);
    let second = startRun(ws);
    await expect(call(grant, "listUsers")).rejects.toThrow(R2);
    await call(await mint(ws, second), "listUsers");
    await second.end();
  }));

  it("ends on demotion, turn-off, capsule removal and Stop", () => withWorkspace(async ws => {
    setOn(ws);
    let run = startRun(ws);
    let grant = await mint(ws, run);
    ws.admins = [];
    await expect(call(grant, "listUsers")).rejects.toThrow(R4);
    ws.admins = [OWNER.id];

    ws.impl.turnOffInstanceAdmin(OWNER);
    expect((await needsApproval(call(grant, "listUsers"))).reason).toBe("activate");
    setOn(ws);

    ws.impl.storage.gatekeepers.delete(CAPSULE);
    await expect(call(grant, "listUsers")).rejects.toThrow(R5);
    // Replaced by a capsule on another account.
    putCapsule(ws, CAPSULE, ACCOUNT + 1);
    await expect(call(grant, "listUsers")).rejects.toThrow(R5);
    putCapsule(ws, CAPSULE);

    ws.impl.cancelAgent(CHAT);
    await expect(call(grant, "listUsers")).rejects.toThrow(R16);
    await run.end();
  }));

  it("ends past the run's time limit", () => withWorkspace(async ws => {
    setOn(ws);
    let run = startRun(ws);
    let grant = await mint(ws, run);
    let now = Date.now();
    let clock = vi.spyOn(Date, "now")
        .mockReturnValue(now + INSTANCE_ADMIN_RUN_LIMIT_SECONDS * 1000 + 1);
    try {
      await expect(call(grant, "listUsers")).rejects.toThrow(R17);
    } finally {
      clock.mockRestore();
    }
    await run.end();
  }));

  it("kept across two sessions, ends when the vendor is disabled", () => withWorkspace(async ws => {
    setOn(ws);
    let run = startRun(ws);
    let kept = await mint(ws, run);
    await mint(ws, run);
    ws.modes.instanceadmin = "disabled";
    await expect(call(kept, "listUsers")).rejects.toThrow(R7);
    await run.end();
  }));

  it("works for its own chat's run during another chat's activity, and not after",
      () => withWorkspace(async ws => {
    setOn(ws);
    seedChat(ws, CHAT_2);
    let run = startRun(ws);
    let grant = await mint(ws, run);
    let other = startRun(ws, CHAT_2);
    expect((await call(grant, "listUsers")).outcome).toBe("answered");
    await run.end();
    await expect(call(grant, "listUsers")).rejects.toThrow(R2);
    await other.end();
  }));
});

describe("calls while access is off", () => {
  it("ask to turn it on, once per step", () => withWorkspace(async ws => {
    let run = startRun(ws);
    let grant = await mint(ws, run);
    let available = Object.entries(ADMIN_AGENT_ACCESS)
        .filter(([, kind]) => kind !== "withheld").map(([method]) => method);
    let first = await needsApproval(call(grant, available[0]!));
    expect(first).toStrictEqual(
        { outcome: "needsApproval", actionId: first.actionId, existing: false, reason: "activate" });
    for (let method of available.slice(1)) {
      expect(await needsApproval(call(grant, method))).toStrictEqual(
          { outcome: "needsApproval", actionId: first.actionId, existing: true, reason: "activate" });
    }
    expect(adminActions(ws).map(r => [r.instanceAdmin, r.description.title]))
        .toStrictEqual([[{ kind: "activate" }, ACTIVATION_TITLE]]);
    expect(ws.calls).toStrictEqual([]);

    // A new step makes a new request, and so does another chat.
    ws.impl.consumeCapturedActions(CHAT);
    expect((await needsApproval(call(grant, "listUsers"))).existing).toBe(false);
    seedChat(ws, CHAT_2);
    let other = startRun(ws, CHAT_2);
    expect((await needsApproval(call(await mint(ws, other, CHAT_2), "listUsers"))).existing)
        .toBe(false);
    expect(adminActions(ws)).toHaveLength(3);
    await other.end();
    await run.end();
  }));

  it("refuse when the workspace is shared or a reply is undelivered",
      () => withWorkspace(async ws => {
    let run = startRun(ws);
    let grant = await mint(ws, run);
    ws.impl.storage.collaborators.put({
      profile: { id: OTHER_USER.id, name: "Carol" },
      addedBy: [{ type: "user", sharer: OWNER.id, created: new Date(), role: "build" }],
    });
    await expect(call(grant, "listUsers")).rejects.toThrow(R9);
    ws.impl.storage.collaborators.delete(OTHER_USER.id);
    undelivered(ws, CHAT_2);
    await expect(call(grant, "listUsers")).rejects.toThrow(A5);
    expect(adminActions(ws)).toStrictEqual([]);
    await run.end();
  }));
});

describe("calls while access is on", () => {
  it("run every read and observe it before answering", () => withWorkspace(async ws => {
    setOn(ws);
    let run = startRun(ws);
    let grant = await mint(ws, run);
    let reads = Object.entries(ADMIN_AGENT_ACCESS)
        .filter(([, kind]) => kind === "read").map(([method]) => method);
    for (let method of reads) {
      let before = observations(ws).length;
      expect(await call(grant, method, "argument")).toStrictEqual({
        outcome: "answered", value: { users: [{ id: "u1" }, { id: "u2" }], ok: true },
      });
      let added = observations(ws).slice(before);
      expect(added).toHaveLength(1);
      expect(added[0]).toMatchObject({
        gatekeeperId: CAPSULE, caller: { from: "agent", chatId: CHAT },
        description: { containsRestrictedData: true },
      });
      expect(field(added[0], "Method").value).toBe(`AdminApi.${method}`);
      expect(field(added[0], "Result").value).toBe("users: 2, ok: true");
    }
    expect(ws.calls.map(c => [c.method, c.args])).toStrictEqual(
        reads.map(method => [method, ["argument"]]));
    expect(new Set(ws.calls.map(c => JSON.stringify(c.origin)))).toStrictEqual(
        new Set([JSON.stringify({ workspaceId: ws.impl.ctx.id.toString(), chatId: CHAT })]));
    expect(ws.impl.storage.containsRestrictedData.get()).toBe(true);
    await run.end();
  }));

  it("queue every change, calling nothing", () => withWorkspace(async ws => {
    setOn(ws);
    let run = startRun(ws);
    let grant = await mint(ws, run);
    let changes = Object.entries(ADMIN_AGENT_ACCESS)
        .filter(([, kind]) => kind === "change").map(([method]) => method);
    for (let method of changes) {
      let actionId = await queued(call(grant, method, "value"));
      expect(action(ws, actionId)).toMatchObject({
        state: "pending", action: actionId, gatekeeperId: CAPSULE,
        instanceAdmin: { kind: "change", method, args: "[\"value\"]" },
      });
    }
    expect(ws.calls).toStrictEqual([]);
    await run.end();
  }));

  it("refuse withheld, unknown, non-JSON, oversized and capability-returning calls",
      () => withWorkspace(async ws => {
    setOn(ws);
    let run = startRun(ws);
    let grant = await mint(ws, run);
    for (let [method, kind] of Object.entries(ADMIN_AGENT_ACCESS)) {
      if (kind === "withheld") await expect(call(grant, method)).rejects.toThrow(R10(method));
    }
    await expect(call(grant, "constructor")).rejects.toThrow(
        new TypeError("AdminApi has no method constructor."));
    await expect(call(grant, "setSiteName", new Date())).rejects.toThrow(R12);
    let actionsBefore = [...ws.impl.storage.actions.list()].length;
    await expect(call(grant, "setInstanceInstructions", "\u0001".repeat(8000)))
        .rejects.toThrow(R13);
    expect([...ws.impl.storage.actions.list()]).toHaveLength(actionsBefore);

    ws.api.listUsers = () => new Capability();
    await expect(call(grant, "listUsers")).rejects.toThrow(`AdminApi.listUsers ${R14}`);
    expect(observations(ws)).toStrictEqual([]);
    await run.end();
  }));

  it("open an inspection at the level the Workshop classified", () => withWorkspace(async ws => {
    setOn(ws);
    let run = startRun(ws);
    let grant = await mint(ws, run);
    let result = await call(grant, "inspectWorkspace", "w-9", "Ticket 7");
    expect(result.outcome).toBe("answered");
    expect(ws.calls.map(c => [c.method, c.args])).toStrictEqual(
        [["inspectWorkspace", ["w-9", "Ticket 7", { access: "metadata" }]]]);
    expect(observations(ws).map(o => field(o, "Method").value))
        .toStrictEqual(["AdminApi.inspectWorkspace"]);
    for (let options of ["full", ["full"], null]) {
      await expect(call(grant, "inspectWorkspace", "w-9", "Ticket 7", options))
          .rejects.toThrow(TypeError);
    }
    await expect(call(grant, "inspectWorkspace", "w-9", "Ticket 7", { access: "everything" }))
        .rejects.toThrow(TypeError);
    expect(ws.calls).toHaveLength(1);
    await run.end();
  }));

  it("queue the longest instance instructions, invisible characters included",
      () => withWorkspace(async ws => {
    setOn(ws);
    let run = startRun(ws);
    let grant = await mint(ws, run);
    let text = "‮" + "a".repeat(7999);
    let actionId = await queued(call(grant, "setInstanceInstructions", text));
    let record = action(ws, actionId);
    expect(JSON.parse(record.instanceAdmin.args)).toStrictEqual([text]);
    expect(field(record, "Argument 1").kind).toBe("json");
    await run.end();
  }));
});

describe("a call's one await", () => {
  it("sees a turn-off during a full inspection's title lookup", () => withWorkspace(async ws => {
    setOn(ws);
    let run = startRun(ws);
    let grant = await mint(ws, run);
    let title = deferred<string | null>();
    ws.title = () => title.promise;
    let pending = call(grant, "inspectWorkspace", "w-9", "Ticket 7", { access: "full" });
    await until(() => ws.titleLookups.length === 1);
    ws.impl.turnOffInstanceAdmin(OWNER);
    title.resolve("Other workspace");
    let result = await needsApproval(pending);
    expect(result.reason).toBe("activate");
    expect(adminActions(ws).map(r => [r.instanceAdmin.kind, r.description.title]))
        .toStrictEqual([["activate", REACTIVATION_TITLE]]);
    await run.end();
  }));

  it("sees a Stop during a full inspection's title lookup", () => withWorkspace(async ws => {
    setOn(ws);
    let run = startRun(ws);
    let grant = await mint(ws, run);
    let title = deferred<string | null>();
    ws.title = () => title.promise;
    let pending = call(grant, "inspectWorkspace", "w-9", "Ticket 7", { access: "full" });
    await until(() => ws.titleLookups.length === 1);
    ws.impl.cancelAgent(CHAT);
    title.resolve("Other workspace");
    await expect(pending).rejects.toThrow(R16);
    expect(adminActions(ws)).toStrictEqual([]);
    await run.end();
  }));

  it("queues one card for two identical calls, and looks up titles only for inspections",
      () => withWorkspace(async ws => {
    setOn(ws);
    let run = startRun(ws);
    let grant = await mint(ws, run);
    let [first, second] = await Promise.all([
      needsApproval(call(grant, "inspectWorkspace", "w-9", "Ticket 7", { access: "full" })),
      needsApproval(call(grant, "inspectWorkspace", "w-9", "Ticket 7", { access: "full" })),
    ]);
    expect(first).toStrictEqual(
        { outcome: "needsApproval", actionId: first.actionId, existing: false, reason: "inspect" });
    expect(second).toStrictEqual(
        { outcome: "needsApproval", actionId: first.actionId, existing: true, reason: "inspect" });
    expect(adminActions(ws)).toHaveLength(1);
    expect(field(action(ws, first.actionId), "Title in the directory").value)
        .toBe("Other workspace");
    expect(ws.titleLookups).toStrictEqual(["w-9", "w-9"]);

    await call(grant, "listUsers");
    await call(grant, "setSiteName", "Site");
    expect(ws.titleLookups).toHaveLength(2);
    await run.end();
  }));
});

describe("applying a change", () => {
  it("makes exactly the stored call, with its origin and the run's session",
      () => withWorkspace(async ws => {
    setOn(ws);
    let run = startRun(ws);
    let grant = await mint(ws, run);
    await call(grant, "listUsers");
    let actionId = await queued(call(grant, "setAnnouncement", { text: "Hi", b: 1 }));
    await approve(ws, actionId);
    let [read, change] = ws.calls;
    expect(change).toStrictEqual({
      origin: { workspaceId: ws.impl.ctx.id.toString(), chatId: CHAT, actionId },
      sessionId: read!.sessionId, method: "setAnnouncement", args: [{ b: 1, text: "Hi" }],
    });
    expect(action(ws, actionId)).toMatchObject(
        { state: "approved", resolvedBy: OWNER, autoApproved: false });
    await run.end();
  }));

  it("leaves the action pending when its approval is refused", () => withWorkspace(async ws => {
    setOn(ws);
    let run = startRun(ws);
    let grant = await mint(ws, run);
    let actionId = await queued(call(grant, "setSiteName", "Site"));
    await expect(approve(ws, actionId, OWNER, true)).rejects.toThrow(A1);
    await expect(approve(ws, actionId, OTHER_USER)).rejects.toThrow(A2);
    ws.admins = [];
    await expect(approve(ws, actionId)).rejects.toThrow(A2);
    ws.admins = [OWNER.id];
    ws.impl.storage.instanceAdminActive.put(false);
    await expect(approve(ws, actionId)).rejects.toThrow(A3);
    ws.impl.storage.instanceAdminActive.put(true);
    ws.modes.instanceadmin = "disabled";
    await expect(approve(ws, actionId)).rejects.toThrow(R7);
    ws.modes.instanceadmin = "optional";
    ws.impl.storage.gatekeepers.delete(CAPSULE);
    await expect(approve(ws, actionId)).rejects.toThrow(R5);
    expect(action(ws, actionId).state).toBe("pending");
    expect(ws.calls).toStrictEqual([]);
    await run.end();
  }));

  it("refuses a second approval while the first is applied, and keeps ids apart",
      () => withWorkspace(async ws => {
    setOn(ws);
    let run = startRun(ws);
    let grant = await mint(ws, run);
    let first = await queued(call(grant, "setAnnouncement", "a"));
    let second = await queued(call(grant, "setAnnouncement", "a"));
    let parked = deferred();
    ws.api.setAnnouncement = () => parked.promise;
    let applying = approve(ws, first);
    await until(() => ws.calls.length === 1);
    await expect(approve(ws, first)).rejects.toThrow(A4);
    parked.resolve();
    await applying;
    delete ws.api.setAnnouncement;
    await approve(ws, second);
    expect(ws.calls.map(c => (c.origin as { actionId: number }).actionId))
        .toStrictEqual([first, second]);
    await run.end();
  }));

  it("refuses a held action whose method the table no longer gives its kind",
      () => withWorkspace(async ws => {
    setOn(ws);
    for (let [id, method] of [[50, "setSiteLogo"], [51, "listUsers"]] as const) {
      ws.impl.storage.actions.put({
        id, gatekeeperId: CAPSULE, caller: { from: "agent", chatId: CHAT }, createdAt: new Date(),
        state: "pending", type: "action", action: id,
        description: { title: "Planted", description: "", awaitDecision: true },
        instanceAdmin: { kind: "change", method, args: "[]", sessionId: "s" },
      });
      await expect(approve(ws, id)).rejects.toThrow(R10(method));
      expect(action(ws, id).state).toBe("pending");
    }
    expect(ws.calls).toStrictEqual([]);
  }));

  it("refuses a change queued through a capsule since replaced", () => withWorkspace(async ws => {
    setOn(ws);
    let run = startRun(ws);
    let stale = await queued(call(await mint(ws, run), "setSiteName", "Old"));
    ws.impl.storage.gatekeepers.delete(CAPSULE);
    putCapsule(ws, 9);
    await expect(approve(ws, stale)).rejects.toThrow(R5);
    expect(action(ws, stale).state).toBe("pending");
    expect(ws.calls).toStrictEqual([]);
    await run.end();

    let next = startRun(ws, CHAT, OWNER, 9);
    let fresh = await queued(call(await mint(ws, next, CHAT, 9), "setSiteName", "New"));
    await approve(ws, fresh);
    expect(ws.calls.map(c => c.args)).toStrictEqual([["New"]]);
    await next.end();
  }));
});

describe("resolving an action while it applies", () => {
  it("lets a parked change complete across a turn-off, which rejects the others",
      () => withWorkspace(async ws => {
    setOn(ws);
    let run = startRun(ws);
    let grant = await mint(ws, run);
    let parkedId = await queued(call(grant, "setAnnouncement", "a"));
    let otherId = await queued(call(grant, "setSiteName", "b"));
    let parked = deferred();
    ws.api.setAnnouncement = () => parked.promise;
    let applying = approve(ws, parkedId);
    await until(() => ws.calls.length === 1);
    ws.impl.turnOffInstanceAdmin(OWNER);
    expect(action(ws, parkedId).state).toBe("pending");
    expect(action(ws, otherId).state).toBe("rejected");
    expect(() => ws.impl.rejectInstanceAdminAction(parkedId, OWNER)).toThrow(A4);
    parked.resolve();
    await applying;
    expect(action(ws, parkedId).state).toBe("approved");
    expect(ws.calls).toHaveLength(1);
    await run.end();
  }));

  it("lets a reject or turn-off win while the apply reads the config",
      () => withWorkspace(async ws => {
    let run = startRun(ws);
    let grant = await mint(ws, run);
    for (let resolve of [
      (id: number) => ws.impl.rejectInstanceAdminAction(id, OWNER),
      () => ws.impl.turnOffInstanceAdmin(OWNER),
    ]) {
      setOn(ws);
      let rejected = await queued(call(grant, "setSiteName", "Site"));
      let reached = deferred();
      let release = deferred();
      ws.kvGet = async key => {
        reached.resolve();
        await release.promise;
        return key === ADMIN_CONFIG_KEY ? JSON.stringify({ ambientGatekeeperModes: ws.modes }) : null;
      };
      let applying = approve(ws, rejected);
      await reached.promise;
      resolve(rejected);
      ws.kvGet = undefined;
      release.resolve();
      await expect(applying).rejects.toThrow(`Action is not pending: ${rejected}`);
      expect(action(ws, rejected).state).toBe("rejected");
    }
    expect(ws.calls).toStrictEqual([]);
    await run.end();
  }));
});

async function approved(ws: Workspace, grant: InstanceAdminGrant, method: string,
                        ...args: unknown[]): Promise<number> {
  let calls = ws.calls.length;
  let { actionId, reason } = await needsApproval(call(grant, method, ...args));
  expect(reason).toBe(method === "inspectWorkspace" ? "inspect" : "confirm");
  await approve(ws, actionId);
  // Nothing ran, before the approval or because of it.
  expect(ws.calls).toHaveLength(calls);
  return actionId;
}

describe("calls approved one at a time", () => {
  it("run once, as the identical call, after approval", () => withWorkspace(async ws => {
    setOn(ws);
    let run = startRun(ws);
    let grant = await mint(ws, run);
    let actionId = await approved(ws, grant, "testGatewayModel", "model-a");
    expect([...ws.impl.storage.instanceAdminAllowances.list()]).toStrictEqual([{
      actionId, chatId: CHAT, method: "testGatewayModel", args: "[\"model-a\"]",
      expiresAt: expect.any(Date),
    }]);
    expect(await call(grant, "testGatewayModel", "model-a")).toMatchObject({ outcome: "answered" });
    expect(ws.calls.map(c => [c.method, (c.origin as { actionId?: number }).actionId]))
        .toStrictEqual([["testGatewayModel", actionId]]);
    expect([...ws.impl.storage.instanceAdminAllowances.list()]).toStrictEqual([]);
    // Used up: the next identical call asks again.
    ws.impl.consumeCapturedActions(CHAT);
    expect((await needsApproval(call(grant, "testGatewayModel", "model-a"))).existing).toBe(false);
    await run.end();
  }));

  it("ask again for other arguments, after expiry and in another chat",
      () => withWorkspace(async ws => {
    setOn(ws);
    seedChat(ws, CHAT_2);
    let run = startRun(ws);
    let grant = await mint(ws, run);
    await approved(ws, grant, "testGatewayProvider", "openai");
    ws.impl.consumeCapturedActions(CHAT);
    expect((await call(grant, "testGatewayProvider", "anthropic")).outcome).toBe("needsApproval");
    await run.end();

    let other = startRun(ws, CHAT_2);
    expect((await call(await mint(ws, other, CHAT_2), "testGatewayProvider", "openai")).outcome)
        .toBe("needsApproval");
    await other.end();

    // The approval's lifetime, from the approval, ran out.
    let [allowance] = [...ws.impl.storage.instanceAdminAllowances.list()];
    expect(allowance.expiresAt.getTime()).toBeGreaterThan(
        Date.now() + INSTANCE_ADMIN_APPROVAL_LIFETIME_SECONDS * 1000 - 60_000);
    ws.impl.storage.instanceAdminAllowances.put(
        { ...allowance, expiresAt: new Date(Date.now() - 1) });
    let later = startRun(ws);
    expect((await call(await mint(ws, later), "testGatewayProvider", "openai")).outcome)
        .toBe("needsApproval");
    expect(ws.calls).toStrictEqual([]);
    // The expired allowance was pruned.
    expect([...ws.impl.storage.instanceAdminAllowances.list()]).toStrictEqual([]);
    await later.end();
  }));

  it("consume the approval even when the call fails, and record it",
      () => withWorkspace(async ws => {
    setOn(ws);
    let run = startRun(ws);
    let grant = await mint(ws, run);
    let actionId = await approved(ws, grant, "testNewGatewayModel", { id: "m" });
    ws.api.testNewGatewayModel = async () => { throw new Error("No such model: m"); };
    await expect(call(grant, "testNewGatewayModel", { id: "m" })).rejects.toThrow("No such model");
    expect([...ws.impl.storage.instanceAdminAllowances.list()]).toStrictEqual([]);
    let [observed, ...rest] = observations(ws);
    expect(rest).toStrictEqual([]);
    expect(field(observed, "Error").value).toBe("No such model: m");
    expect(field(observed, "Approved as").value).toBe(`action ${actionId}`);
    await run.end();
  }));

  it("record a paid call whose answer a turn-off withholds", () => withWorkspace(async ws => {
    setOn(ws);
    let run = startRun(ws);
    let grant = await mint(ws, run);
    let actionId = await approved(ws, grant, "testGatewayModel", "model-a");
    let parked = deferred<unknown>();
    ws.api.testGatewayModel = () => parked.promise;
    let pending = call(grant, "testGatewayModel", "model-a");
    await until(() => ws.calls.length === 1);
    ws.impl.turnOffInstanceAdmin(OWNER);
    parked.resolve({ ok: true });
    await expect(pending).rejects.toThrow(A3);
    let [observed, ...rest] = observations(ws);
    expect(rest).toStrictEqual([]);
    expect(field(observed, "Result").value).toBe("ok: true");
    expect(field(observed, "Approved as").value).toBe(`action ${actionId}`);
    await run.end();
  }));

  it("open a full inspection once, observed, and dispose it on turn-off",
      () => withWorkspace(async ws => {
    setOn(ws);
    let run = startRun(ws);
    let grant = await mint(ws, run);
    let args = ["w-9", "Ticket 7", { access: "full" }];
    let actionId = await approved(ws, grant, "inspectWorkspace", ...args);
    let result = await call(grant, "inspectWorkspace", ...args);
    expect(result.outcome).toBe("answered");
    expect(ws.calls.map(c => c.args)).toStrictEqual([args]);
    let [observed] = observations(ws);
    expect(field(observed, "Approved as").value).toBe(`action ${actionId}`);
    expect(observations(ws)).toHaveLength(1);

    ws.impl.consumeCapturedActions(CHAT);
    let second = await approved(ws, grant, "inspectWorkspace", ...args);
    let parked = deferred<unknown>();
    ws.api.inspectWorkspace = () => parked.promise;
    let pending = call(grant, "inspectWorkspace", ...args);
    await until(() => ws.calls.length === 2);
    ws.impl.turnOffInstanceAdmin(OWNER);
    parked.resolve(new FakeView(ws));
    await expect(pending).rejects.toThrow(A3);
    expect(ws.disposedViews).toBe(1);
    expect(field(observations(ws)[1], "Approved as").value).toBe(`action ${second}`);
    await run.end();
  }));
});

async function openView(ws: Workspace, getChatAnswer?: () => unknown) {
  setOn(ws);
  if (getChatAnswer) ws.api.inspectWorkspace = () => new FakeView(ws, getChatAnswer);
  let run = startRun(ws);
  let grant = await mint(ws, run);
  let result = await call(grant, "inspectWorkspace", "w-9", "Ticket 7");
  if (result.outcome !== "answered") throw new Error("Expected a view.");
  return { run, view: result.value as any };
}

describe("an inspection's view", () => {
  it("observes every call", () => withWorkspace(async ws => {
    let { run, view } = await openView(ws);
    expect(await view.listChats()).toStrictEqual([{ id: 1, title: "A chat" }]);
    await view.getChat(3);
    let [, listChats, getChat] = observations(ws);
    expect(listChats.description.title).toBe("Inspect workspace: listChats (deployment admin)");
    expect(field(getChat, "Method").value).toBe("AdminWorkspaceView.getChat");
    expect(JSON.parse(field(getChat, "Arguments").value)).toStrictEqual([3]);
    expect(field(getChat, "Workspace").value).toBe("w-9");
    expect(field(getChat, "Reason").value).toBe("Ticket 7");
    view[Symbol.dispose]();
    expect(ws.disposedViews).toBe(1);
    await run.end();
  }));

  it("stops working with its run's grant", () => withWorkspace(async ws => {
    let cases: [(run: Run) => Promise<void> | void, string][] = [
      [run => run.end(), R2],
      [() => ws.impl.cancelAgent(CHAT), R16],
      [() => ws.impl.turnOffInstanceAdmin(OWNER), A3],
      [() => { ws.admins = []; }, R4],
      [() => { ws.modes.instanceadmin = "disabled"; }, R7],
    ];
    for (let [stop, refusal] of cases) {
      let { run, view } = await openView(ws);
      await stop(run);
      let observed = observations(ws).length;
      await expect(view.listChats()).rejects.toThrow(refusal);
      expect(observations(ws)).toHaveLength(observed);
      ws.admins = [OWNER.id];
      ws.modes.instanceadmin = "optional";
      if (refusal !== R2) await run.end();
    }
  }));

  it("refuses an answer holding a capability, observing nothing", () => withWorkspace(async ws => {
    let { run, view } = await openView(ws, () => ({ chat: new Capability() }));
    let observed = observations(ws).length;
    await expect(view.getChat(1)).rejects.toThrow(`AdminWorkspaceView.getChat ${R14}`);
    expect(observations(ws)).toHaveLength(observed);
    await run.end();
  }));
});

async function requestActivation(ws: Workspace): Promise<{ run: Run; actionId: number }> {
  let run = startRun(ws);
  let { actionId } = await needsApproval(call(await mint(ws, run), "listUsers"));
  return { run, actionId };
}

describe("turning access on", () => {
  it("sets the latch, access and restricted mode in one step", () => withWorkspace(async ws => {
    let { run, actionId } = await requestActivation(ws);
    let writes: string[] = [];
    for (let name of ["instanceAdminLatched", "instanceAdminActive", "containsRestrictedData"]) {
      ws.impl.storage[name].subscribe({ update: () => writes.push(name) });
    }
    await approve(ws, actionId);
    expect(writes.toSorted()).toStrictEqual(
        ["containsRestrictedData", "instanceAdminActive", "instanceAdminLatched"]);
    expect(ws.impl.storage.instanceAdminLatched.get()).toBe(true);
    expect(ws.impl.storage.instanceAdminActive.get()).toBe(true);
    expect(ws.impl.storage.containsRestrictedData.get()).toBe(true);
    expect(ws.impl.deploymentAdminAccess()).toBe("on");
    await run.end();
  }));

  it("is refused unless nobody else can open the workspace", () => withWorkspace(async ws => {
    let { run, actionId } = await requestActivation(ws);
    let leave = ws.impl.joinSession("use");
    await expect(approve(ws, actionId)).rejects.toThrow(R9);
    ws.impl.consumeCapturedActions(CHAT);
    await expect(call(ws.grants[0]!, "listUsers")).rejects.toThrow(R9);
    leave();
    undelivered(ws, CHAT_2);
    await expect(approve(ws, actionId)).rejects.toThrow(A5);
    expect(action(ws, actionId).state).toBe("pending");
    await run.end();
  }));

  it("asks with the reactivation card once latched", () => withWorkspace(async ws => {
    setOn(ws, false);
    let { run, actionId } = await requestActivation(ws);
    expect(action(ws, actionId).description.title).toBe(REACTIVATION_TITLE);
    await approve(ws, actionId);
    expect(ws.impl.deploymentAdminAccess()).toBe("on");
    await run.end();
  }));

  it("refuses an external message parked across it", () => withWorkspace(async ws => {
    let { run, actionId } = await requestActivation(ws);
    let reached = deferred();
    let release = deferred<unknown>();
    let owner = ws.impl.users.get();
    ws.impl.users = {
      ...ws.impl.users,
      getByName: () => ({
        id: { toString: () => OWNER_USER_ID },
        whoamiIfExists: async () => OWNER,
        getExternalMessageChatContext: () => { reached.resolve(); return release.promise; },
      }),
      get: () => owner,
    };
    let chats = [...ws.impl.storage.chatMeta.list()].length;
    let pending = ws.instance.receiveExternalMessage({
      callerEmail: OWNER.id, externalChatKey: "thread", idempotencyKey: "message-1",
      prompt: "hello", chatGatewayRpcTarget: {} as any, title: "Admin workspace",
    } as any);
    await reached.promise;
    await approve(ws, actionId);
    release.resolve({
      profile: OWNER,
      aiModel: { profile: { type: "agent", id: "model", name: "Model" }, config: {} },
    });
    expect(await pending).toStrictEqual({ accepted: false, message: X2 });
    expect([...ws.impl.storage.chatMeta.list()]).toHaveLength(chats);
    expect([...ws.impl.storage.gadgetResponseDeliveries.list()]).toStrictEqual([]);
    expect([...ws.impl.storage.externalChats.list()]).toStrictEqual([]);
    await run.end();
  }));

  it("makes a response target's registration roll its transaction back",
      () => withWorkspace(async ws => {
    setOn(ws);
    expect(() => ws.impl.ctx.storage.transactionSync(() => {
      ws.impl.storage.chatMeta.put(
          { id: 40, title: "External", started: new Date(0), lastActive: new Date(0) });
      ws.impl.registerExternalMessageResponseTarget("message-2", 40, 0, {} as any);
    })).toThrow(X2);
    expect(ws.impl.storage.chatMeta.get(40)).toBeUndefined();
    expect([...ws.impl.storage.gadgetResponseDeliveries.list()]).toStrictEqual([]);
  }));
});

describe("turning access off", () => {
  it("works for a demoted owner and a disabled vendor, restarting the capsule",
      () => withWorkspace(async ws => {
    setOn(ws);
    ws.impl.storage.instanceAdminAllowances.put({
      actionId: 70, chatId: CHAT, method: "testGatewayModel", args: "[]", expiresAt: new Date(),
    });
    ws.admins = [];
    ws.modes.instanceadmin = "disabled";
    ws.impl.turnOffInstanceAdmin(OWNER);
    expect(ws.impl.deploymentAdminAccess()).toBe("off");
    expect([...ws.impl.storage.instanceAdminAllowances.list()]).toStrictEqual([]);
    expect(ws.aborted).toStrictEqual([`gatekeeper${CAPSULE}`]);
  }));

  it("only rejects the pending activation where access was never on",
      () => withWorkspace(async ws => {
    let run = startRun(ws);
    let { actionId } = await needsApproval(call(await mint(ws, run), "listUsers"));
    ws.impl.turnOffInstanceAdmin(OWNER);
    expect(action(ws, actionId)).toMatchObject({ state: "rejected", resolvedBy: OWNER });
    expect(ws.impl.storage.instanceAdminLatched.get()).toBe(false);
    expect(ws.impl.deploymentAdminAccess()).toBeUndefined();
    await run.end();
  }));

  it("rejects every pending action and drops every allowance, then asks again",
      () => withWorkspace(async ws => {
    setOn(ws);
    seedChat(ws, CHAT_2);
    let run = startRun(ws);
    let grant = await mint(ws, run);
    let allowed = await needsApproval(call(grant, "testGatewayModel", "a"));
    await approve(ws, allowed.actionId);
    ws.impl.consumeCapturedActions(CHAT);
    let allowedToo = await needsApproval(call(grant, "testGatewayModel", "b"));
    await approve(ws, allowedToo.actionId);
    let ids = [
      await queued(call(grant, "setSiteName", "a")),
      (await needsApproval(call(grant, "testGatewayProvider", "p"))).actionId,
    ];
    await run.end();
    let other = startRun(ws, CHAT_2);
    ids.push(await queued(call(await mint(ws, other, CHAT_2), "setBanner", null)));
    await other.end();
    // An activation request from before access was on.
    ws.impl.storage.actions.put({
      id: 80, gatekeeperId: CAPSULE, caller: { from: "agent", chatId: CHAT_2 },
      createdAt: new Date(), state: "pending", type: "action", action: 80,
      description: { title: ACTIVATION_TITLE, description: "", awaitDecision: true },
      instanceAdmin: { kind: "activate" },
    });
    ids.push(80);
    expect([...ws.impl.storage.instanceAdminAllowances.list()]).toHaveLength(2);

    ws.impl.turnOffInstanceAdmin(OWNER);
    expect(ids.map(id => action(ws, id).state)).toStrictEqual(ids.map(() => "rejected"));
    expect([...ws.impl.storage.instanceAdminAllowances.list()]).toStrictEqual([]);
    expect(ws.impl.deploymentAdminAccess()).toBe("off");

    let next = startRun(ws);
    let { actionId, reason } = await needsApproval(call(await mint(ws, next), "listUsers"));
    expect(reason).toBe("activate");
    expect(action(ws, actionId).description.title).toBe(REACTIVATION_TITLE);
    await next.end();
  }));

  it("is the owner's alone", () => withWorkspace(async ws => {
    let collaborator = { ...OTHER_USER, id: "collaborator@example.test" };
    ws.impl.storage.gatekeepers.delete(CAPSULE);
    ws.impl.storage.gatekeepers.delete(OTHER_GATEKEEPER);
    ws.impl.storage.collaborators.put({
      profile: { id: collaborator.id, name: collaborator.name },
      addedBy: [{ type: "user", sharer: OWNER.id, created: new Date(), role: "build" }],
    });
    let owner = ws.impl.users.get();
    ws.impl.users.get = (id: string) => id === "collaborator-do"
      ? { ...owner, whoami: async () => collaborator, recordSharedGadgetOpen: async () => {} }
      : owner;
    ws.impl.ensureAmbientCapsules = async () => {};
    ws.impl.markOutputsDirty = () => {};
    using notifyClosed = new NativeRpcStub<() => void>(() => {});
    using client = await ws.instance.open("collaborator-do", collaborator.id, notifyClosed);
    let keys = [...(ws.impl.ctx.storage as DurableObjectStorage).kv.list()];
    let turnOff = client.turnOffDeploymentAdminAccess();
    await expect(turnOff).rejects.toThrow(T1);
    expect([...(ws.impl.ctx.storage as DurableObjectStorage).kv.list()]).toStrictEqual(keys);
  }));
});

describe("a latched workspace", () => {
  it("can't be shared, and nobody but its owner has a role", () => withWorkspace(async ws => {
    ws.impl.storage.collaborators.put({
      profile: { id: OTHER_USER.id, name: "Carol" },
      addedBy: [{ type: "user", sharer: OWNER.id, created: new Date(), role: "build" }],
    });
    setOn(ws);
    let sharing = await ws.impl.getSharingManager();
    let caller = { profileId: OWNER.id, isOwner: true };
    expect(sharing.computeEffectiveRoles().size).toBe(0);
    await expect(sharing.createShareLink({ caller, role: "use" })).rejects.toThrow(
        "it can't be shared");
    expect(() => sharing.addCollaborator({
      caller, profile: { type: "user", id: "dave@example.test", name: "Dave" }, role: "use",
    })).toThrow("it can't be shared");

    // A link and a copy of it from before the latch.
    ws.impl.storage.instanceAdminLatched.put(false);
    let { key, linkId } = await sharing.createShareLink({ caller, role: "use" });
    ws.impl.storage.instanceAdminLatched.put(true);
    await expect(sharing.newShareLinkKey({ caller, linkId })).rejects.toThrow("it can't be shared");
    await expect(sharing.redeemShareKey({
      rawKey: key, profileId: "dave@example.test",
      fetchProfile: async () => ({ type: "user", id: "dave@example.test", name: "Dave" }),
    })).rejects.toThrow();
    expect(ws.impl.storage.collaborators.get("dave@example.test")).toBeUndefined();
  }));

  it("refuses its owner's external messages, and others as any workspace would",
      () => withWorkspace(async ws => {
    setOn(ws);
    let senders: Record<string, unknown> = {
      [OWNER.id]: { id: { toString: () => OWNER_USER_ID }, whoamiIfExists: async () => OWNER },
      [OTHER_USER.id]: {
        id: { toString: () => "carol-do" }, whoamiIfExists: async () => OTHER_USER,
      },
      "nobody@example.test": {
        id: { toString: () => "nobody-do" }, whoamiIfExists: async () => null,
      },
    };
    ws.impl.users.getByName = (email: string) => senders[email];
    let send = (callerEmail: string) => ws.instance.receiveExternalMessage({
      callerEmail, externalChatKey: "thread", idempotencyKey: crypto.randomUUID(),
      prompt: "hello", chatGatewayRpcTarget: {} as any, title: "Admin workspace",
    } as any);
    expect(await send(OWNER.id)).toStrictEqual({ accepted: false, message: X2 });
    expect(await send(OTHER_USER.id)).toStrictEqual({
      accepted: false,
      message: "You do not have access to interact with this workspace through its agent.",
    });
    let unknown = await send("nobody@example.test");
    expect(unknown.accepted).toBe(false);
    expect((unknown as { message: string }).message).toMatch(/^Please create a .* account/);
    expect(X2).not.toMatch(/admin/i);
  }));
});

function capsules(ws: Workspace): number[] {
  return [...ws.impl.storage.gatekeepers.list()]
      .filter((r: any) => r.creationSpec?.vendorId === "instanceadmin").map((r: any) => r.id);
}

describe("the capsule's placement", () => {
  it("keeps the capsule out of a shared workspace", () => withWorkspace(async ws => {
    ws.impl.storage.collaborators.put({
      profile: { id: OTHER_USER.id, name: "Carol" },
      addedBy: [{ type: "user", sharer: OWNER.id, created: new Date(), role: "build" }],
    });
    await ws.impl.ensureAmbientCapsules();
    expect(capsules(ws)).toStrictEqual([]);
    ws.impl.storage.collaborators.delete(OTHER_USER.id);
    await ws.impl.ensureAmbientCapsules();
    expect(capsules(ws)).toHaveLength(1);
  }));

  it("drops the capsule as the workspace is shared, unless latched",
      () => withWorkspace(async ws => {
    let sharing = await ws.impl.getSharingManager();
    let caller = { profileId: OWNER.id, isOwner: true };
    sharing.addCollaborator(
        { caller, profile: { type: "user", id: OTHER_USER.id, name: "Carol" }, role: "use" });
    expect(capsules(ws)).toStrictEqual([]);

    putCapsule(ws, CAPSULE);
    sharing.removeCollaborator(caller, OTHER_USER.id);
    await sharing.createShareLink({ caller, role: "use" });
    expect(capsules(ws)).toStrictEqual([]);

    putCapsule(ws, CAPSULE);
    ws.impl.storage.instanceAdminLatched.put(true);
    // Latched: the sharing manager refuses, and nothing is dropped.
    await expect(sharing.createShareLink({ caller, role: "use" })).rejects.toThrow();
    await ws.impl.ensureAmbientCapsules();
    expect(capsules(ws)).toStrictEqual([CAPSULE]);
  }));

  it("refuses to publish a capsule the workspace was shared while it was provisioned",
      () => withWorkspace(async ws => {
    ws.impl.storage.gatekeepers.delete(CAPSULE);
    ws.impl.storage.gatekeepers.delete(OTHER_GATEKEEPER);
    let described = deferred();
    let release = deferred();
    let getGatekeeperFacet = ws.impl.getGatekeeperFacet;
    ws.impl.getGatekeeperFacet = async (id: number) => id === OTHER_GATEKEEPER
      ? getGatekeeperFacet(id)
      : {
        describe: async () => { described.resolve(); await release.promise; return { title: "x" }; },
      };
    let deleted: string[] = [];
    ws.impl.ctx.facets.delete = (name: string) => { deleted.push(name); };
    let ensuring = ws.impl.ensureAmbientCapsules();
    await described.promise;
    ws.impl.storage.collaborators.put({
      profile: { id: OTHER_USER.id, name: "Carol" },
      addedBy: [{ type: "user", sharer: OWNER.id, created: new Date(), role: "build" }],
    });
    release.resolve();
    await ensuring;
    expect(capsules(ws)).toStrictEqual([]);
    expect(deleted).toHaveLength(1);
  }));

  it("is never bound into a gadget or a spawner, nor asked of observers",
      () => withWorkspace(async ws => {
    let commitId = await ws.impl.gitStore.writeFilesAsCommit(new Map([["a.txt", "a\n"]]), {
      parents: [], author: { name: "Owner", email: "owner@example.test" }, message: "notes",
      timestamp: new Date(1700000000_000),
    });
    let gadget = ws.impl.createGadget("Notes", "NOTES", undefined, undefined, commitId);
    expect(() => ws.impl.bindWorkpiece(gadget.id, "ADMIN", CAPSULE)).toThrow(X1);
    ws.impl.ensureAmbientCapsules = async () => {};
    ws.impl.markOutputsDirty = () => {};
    using notifyClosed = new NativeRpcStub<() => void>(() => {});
    using client = await ws.instance.open(OWNER_USER_ID, OWNER.id, notifyClosed);
    await expect(client.newAgentSpawnerGatekeeper(
        { displayName: "Spawner", modelId: null, env: { ADMIN: CAPSULE } })).rejects.toThrow(X1);
    let needs = ws.impl.listObserverRequirements("build");
    expect(needs.map((need: { gatekeeperId: number }) => need.gatekeeperId))
        .not.toContain(CAPSULE);
  }));
});

async function decide(ws: Workspace, queue: (grant: InstanceAdminGrant) => Promise<number[]>)
    : Promise<string> {
  let run = startRun(ws);
  let grant = await mint(ws, run);
  let ids = await queue(grant);
  // As the agent loop logs a step's actions, then pauses on them.
  let captured = ws.impl.consumeCapturedActions(CHAT);
  ws.impl.addChatMessages(CHAT, { type: "agent", id: "model", name: "Model" }, [
    { type: "message", message: "", toolCalls: [{ toolCallId: "t", toolName: "executeCode",
                                                   input: { code: "" } }] },
    ...captured.actions.map((actionId: number) => ({ type: "action", actionId })),
  ]);
  ws.impl.storage.activeAgents.put({
    chatId: CHAT, modelId: "model", initiatorUserId: OWNER_USER_ID, initiator: OWNER,
    callbackInitiated: false,
  });
  await run.end();
  let resumed = deferred<string>();
  ws.impl.addChatMessages = new Proxy(ws.impl.addChatMessages, {
    apply: (target, self, args) => {
      let nudge = args[2].find((m: { type: string }) => m.type === "agentNudge");
      if (nudge) resumed.resolve(nudge.text);
      return Reflect.apply(target, self, args);
    },
  });
  for (let id of ids) await approve(ws, id);
  return resumed.promise;
}

describe("the resume nudge", () => {
  it("says that a one-call approval ran nothing", () => withWorkspace(async ws => {
    setOn(ws);
    let text = await decide(ws, async grant =>
      [(await needsApproval(call(grant, "testGatewayModel", "m"))).actionId]);
    expect(text).toBe("Your user approved \"Test gateway model (deployment admin, billed)\". " +
        "Nothing ran when you asked: make those calls again now, with the same arguments. An " +
        "approved single call runs once, as the identical call, within 15 minutes.");
  }));

  it("keeps the applied sentence for a change, and joins both", () => withWorkspace(async ws => {
    setOn(ws);
    let text = await decide(ws, async grant => [await queued(call(grant, "setSiteName", "S"))]);
    expect(text).toBe("The changes you submitted have been approved and applied: " +
        "\"Set site name (deployment admin)\". Reads now reflect them.");
  }));

  it("joins both for a mixed wait", () => withWorkspace(async ws => {
    setOn(ws);
    let text = await decide(ws, async grant => [
      await queued(call(grant, "setSiteName", "S")),
      (await needsApproval(call(grant, "testGatewayModel", "m"))).actionId,
    ]);
    expect(text).toBe("The changes you submitted have been approved and applied: " +
        "\"Set site name (deployment admin)\". Reads now reflect them. Your user approved " +
        "\"Test gateway model (deployment admin, billed)\". Nothing ran when you asked: make " +
        "those calls again now, with the same arguments. An approved single call runs once, as " +
        "the identical call, within 15 minutes.");
  }));
});

describe("logs", () => {
  it("never carry arguments or a method the facet made up", () => withWorkspace(async ws => {
    let logged: { message: string; details: unknown }[] = [];
    let record = (message: string, details: unknown) => { logged.push({ message, details }); };
    let spy: any = { debug: record, info: record, warn: record, error: record };
    spy.with = () => spy;
    ws.impl.logger = spy;
    setOn(ws);
    let run = startRun(ws);
    let grant = await mint(ws, run);
    let actionId = await queued(call(grant, "setAnnouncement", "secret-text"));
    ws.api.setAnnouncement = async () => { throw new Error("rejected secret-text"); };
    await expect(approve(ws, actionId)).rejects.toThrow("secret-text");
    delete ws.api.setAnnouncement;
    await approve(ws, actionId);
    await expect(call(grant, "secret-name")).rejects.toThrow(TypeError);
    await run.end();

    let text = JSON.stringify(logged);
    expect(text).not.toContain("secret-text");
    expect(text).not.toContain("secret-name");
    let failed = logged.find(entry =>
        (entry.details as { event?: string }).event === "instance.admin.apply.failed");
    expect(failed?.details).toStrictEqual({
      event: "instance.admin.apply.failed", actionId, chatId: CHAT, operation: "setAnnouncement",
    });
    for (let entry of logged) expect(entry.details).not.toHaveProperty("method");
  }));
});
