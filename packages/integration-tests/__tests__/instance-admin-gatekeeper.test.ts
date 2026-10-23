// The instance admin Gatekeeper end to end: the real Workshop and the real
// packages/gatekeeper-instanceadmin, driven as an admin's agent would drive them. The kernel's unit
// suites (workshop-backend's instance-admin-*.test.ts) cover each refusal one by one; this suite
// checks that the pieces meet: provisioning, the binding in a chat's env, approval cards and the
// resumed turns, the deployment-wide audit log, sharing, and turning access off.
//
// Admin settings and the audit log are deployment-wide, and the cases build on one another (the
// agent's workspace is turned on once, by the second case), so this file owns its harness and runs
// serially.

import type { RpcStub } from "capnweb";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  ADMIN_ACCESS_ERROR_CODES, createAdminAccessError,
  type ActionLogEntry, type AdminApi, type AdminAuditRecord, type AiChatMessage,
  type AuthenticatedApi, type Overseer,
} from "@gadgets/workshop-shared/api";
import { INSTANCE_ADMIN_VENDOR_ID } from "@gadgets/workshop-shared/instance-admin";
import { openAgentSession, type WorkshopAgentSession } from "../src/agent-session.js";
import {
  ADMIN_USERNAME, INSTANCE_ADMIN_GATEKEEPER, startHarness, type Harness,
} from "../src/harness.js";
import {
  SCRIPTED_MODEL_CONFIG, SCRIPTED_MODEL_ID, SCRIPTED_MODEL_PROFILE, scriptedChatCompletions,
  type ChatCompletionStep, type ScriptedChatCompletions,
} from "../src/mock-model.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import {
  connect, listConnectedAccounts, logIn, nextUsernames, signUp, waitFor, waitForIdleChat,
} from "../src/rpc-client.js";

// The two agent sessions' accounts, each a deployment admin of its own: an account can add only one
// model under SCRIPTED_MODEL_PROFILE's id, and a session's turns reach its script by that model's
// Workers AI account id (see SessionModel).
const AGENT_ADMIN = "agentadmin";
const SECOND_ADMIN = "secondadmin";

const ACTIVATION_TITLE = "Turn on deployment admin access in this workspace";
const REACTIVATION_TITLE = "Turn deployment admin access back on in this workspace";
const NOT_SHAREABLE = "Deployment admin access has been on in this workspace, so only its owner " +
    "can ever open it: it can't be shared.";
const NOT_AGENT =
    "The instance admin binding works only in its owner's own agent turns, from executeCode.";
const NOT_OWNER_TURN = "The instance admin binding works only in a turn that answers a message " +
    "this workspace's owner wrote in this chat, not in one a callback, a gadget or a connection's " +
    "slash command started.";
const RUN_ENDED = "This instance admin binding belongs to an executeCode call that has ended.";
const STOPPED = "This turn was stopped, so its instance admin binding no longer works.";
const DISABLED = "The instance admin gatekeeper is turned off on this deployment.";
// What the agent's code gets from `env.INSTANCE_ADMIN.getSettings()` once the capsule is gone.
const BINDING_GONE = "Cannot read properties of undefined (reading 'getSettings')";
const REMOVED = "The instance admin connection has been removed from this workspace.";
const NOT_BINDABLE = "The instance admin binding can't be bound into a gadget or an agent " +
    "spawner: it works only in its owner's own agent turns.";

/**
 * One agent session's model: its own Workers AI account id, so its requests reach only the script
 * the case running now gave it. scriptedModelRouter() fixes a script when the session's model is
 * added, and these sessions run turns for every case, each with steps of its own (the workspace ids
 * they inspect, the actions they name), so each case swaps in a fresh script instead.
 */
class SessionModel {
  readonly userModel;
  readonly #path: string;
  #script: ScriptedChatCompletions = scriptedChatCompletions([]);

  constructor(accountId: string) {
    this.userModel = {
      profile: SCRIPTED_MODEL_PROFILE, config: { ...SCRIPTED_MODEL_CONFIG, accountId },
    };
    this.#path = `/accounts/${accountId}/ai/v1/chat/completions`;
  }

  readonly handler: ScriptedChatCompletions["handler"] = (url, ...rest) =>
    url.pathname.endsWith(this.#path) ? this.#script.handler(url, ...rest) : null;

  /** Answers this session's next model requests with `steps`, in order. */
  script(steps: readonly ChatCompletionStep[]): ScriptedChatCompletions {
    this.#script = scriptedChatCompletions(steps);
    return this.#script;
  }
}

const agentModel = new SessionModel("instance-admin-agent");
const secondModel = new SessionModel("instance-admin-second");
const network = new NetworkInterceptor({ handlers: [agentModel.handler, secondModel.handler] });
const fileScope = new DisposableStack();
let harness: Harness;
let adminUser: RpcStub<AuthenticatedApi>;
let admin: RpcStub<AdminApi>;
// Opened by the second and third cases, and used by the cases after them.
let agent: WorkshopAgentSession | undefined;
let second: WorkshopAgentSession | undefined;
// The agent workspace's capsule, as its activation request names it.
let capsuleId: number;

beforeAll(async () => {
  network.install();
  harness = await startHarness({
    gatekeepers: [INSTANCE_ADMIN_GATEKEEPER],
    enableGadgetExecution: true,
    patchWorkshop: config => {
      config.vars = {
        ...config.vars,
        ADMINS: [ADMIN_USERNAME, AGENT_ADMIN, SECOND_ADMIN],
        ADMIN_WORKSPACE_ACCESS_MAX: "full",
      };
    },
  });
  adminUser = fileScope.use(await signUp(fileScope.use(connect(harness.url)), ADMIN_USERNAME));
  const stub = await adminUser.getAdminApi();
  if (stub === null) throw new Error("The admin API was unavailable to the suite's admin");
  admin = fileScope.use(stub);
});

afterAll(async () => {
  try {
    await agent?.close();
    await second?.close();
    fileScope.dispose();
    await harness?.server.close();
    expect(network.getUnmockedCalls()).toEqual([]);
  } finally {
    network.uninstall();
  }
});

let toolCallSeq = 0;

/** A model step that runs `body` with executeCode, `attempt` in scope (see outputsOf). */
function run(body: string): ChatCompletionStep & { toolCall: { id: string } } {
  return {
    toolCall: {
      id: `run-${++toolCallSeq}`,
      name: "executeCode",
      arguments: {
        code: `const attempt = async (label, call) => {
  try { console.log(label, JSON.stringify({ value: (await call()) ?? null })); }
  catch (error) { console.log(label, JSON.stringify({ error: String(error?.message ?? error) })); }
};
export default async function(self, env) {
${body}
}`,
      },
    },
  };
}

/** A model step that calls tool `name` with `args`. */
function tool(name: string, args: Record<string, unknown>)
    : ChatCompletionStep & { toolCall: { id: string } } {
  return { toolCall: { id: `${name}-${++toolCallSeq}`, name, arguments: args } };
}

type Attempt = { value?: unknown; error?: string };

/** What each `attempt(label, ...)` of executeCode step `step` logged, by label. */
function outputsOf(history: AiChatMessage[], step: { toolCall: { id: string } })
    : Record<string, Attempt> {
  const output = toolCallOf(history, step.toolCall.id)?.output;
  if (output === undefined) throw new Error(`No output for ${step.toolCall.id}`);
  const attempts: Record<string, Attempt> = {};
  for (const line of output.split("\n")) {
    const space = line.indexOf(" ");
    if (space > 0 && line[space + 1] === "{") {
      attempts[line.slice(0, space)] = JSON.parse(line.slice(space + 1)) as Attempt;
    }
  }
  return attempts;
}

/** The record of tool call `id`, with its output or error. */
function toolCallOf(history: AiChatMessage[], id: string)
    : { output?: string; error?: string } | undefined {
  for (const message of history) {
    if (message.type !== "message") continue;
    const call = message.toolCalls?.find(candidate => candidate.toolCallId === id);
    if (call !== undefined) return call as { output?: string; error?: string };
  }
  return undefined;
}

/** The action id an approval message names ("... (action N) ..."). */
function actionIdIn(message: string | undefined): number {
  const match = /\(action (\d+)\)/.exec(message ?? "");
  if (match === null) throw new Error(`No action named in: ${message}`);
  return Number(match[1]);
}

/** Runs `fn` on `session`'s workspace, opened over a connection of its own. */
async function withWorkspace<T>(session: WorkshopAgentSession,
    fn: (ws: RpcStub<Overseer>) => Promise<T>): Promise<T> {
  using publicApi = connect(harness.url);
  using api = await logIn(publicApi, session.username);
  using ws = await api.openGadget(session.workspaceId);
  return await fn(ws);
}

/** The workspace's action log, oldest first. */
async function actionLog(session: WorkshopAgentSession): Promise<ActionLogEntry[]> {
  const entries: ActionLogEntry[] = [];
  let beforeId: number | undefined;
  do {
    const page = await session.listActions({ beforeId });
    entries.push(...page.entries);
    beforeId = page.nextBeforeId;
  } while (beforeId !== undefined);
  return entries.toSorted((a, b) => a.id - b.id);
}

async function pending(session: WorkshopAgentSession): Promise<ActionLogEntry[]> {
  return (await actionLog(session)).filter(entry => entry.type === "action" &&
      entry.state === "pending");
}

async function observations(session: WorkshopAgentSession): Promise<ActionLogEntry[]> {
  return (await actionLog(session)).filter(entry => entry.type === "observation");
}

async function actionState(session: WorkshopAgentSession, id: number) {
  const entry = (await actionLog(session)).find(candidate => candidate.id === id);
  if (entry?.type !== "action") throw new Error(`No action record ${id}`);
  return entry.state;
}

/** Every deployment-wide audit record the agent's calls made, newest first. */
async function gatekeeperRecords(): Promise<AdminAuditRecord[]> {
  return (await admin.listAdminAudit({ via: "gatekeeper", limit: 200 })).records;
}

/** Waits until `session`'s chat is idle with `model`'s steps all consumed. */
async function settled(session: WorkshopAgentSession, model: ScriptedChatCompletions) {
  await withWorkspace(session, async ws => {
    await waitFor("the resumed turn to finish", async () => model.remainingSteps() === 0 &&
        (await ws.listChats()).every(chat => chat.activeAgent === undefined) || null);
  });
}

/** Opens an agent session for `username`, an admin with an instance admin account. */
function openAdminSession(username: string, model: SessionModel) {
  return openAgentSession(harness.url, {
    username, modelId: SCRIPTED_MODEL_ID, userModel: model.userModel,
    ambientVendorIds: [INSTANCE_ADMIN_VENDOR_ID],
  });
}

/** Which of workpieces `ids` are instance admin capsules of `ws`. */
async function capsulesAmong(ws: RpcStub<Overseer>, ids: number[]): Promise<number[]> {
  const found: number[] = [];
  for (const id of ids) {
    try {
      using gatekeeper = await ws.getGatekeeperById(id);
      if ((await gatekeeper.describe()).url === "instanceadmin://deployment") found.push(id);
    } catch {
      // Not a gatekeeper of this workspace.
    }
  }
  return found;
}

/** The vendor ids `api`'s user may add. */
async function addable(api: RpcStub<AuthenticatedApi>): Promise<string[]> {
  return (await api.listAddableGatekeepers()).map(candidate => candidate.id);
}

/** `api`'s user's instance admin accounts, forced ones included. */
async function instanceAdminAccounts(api: RpcStub<AuthenticatedApi>) {
  return (await listConnectedAccounts(api, { includeForcedAutoProvisionedAccounts: true }))
      .filter(account => account.vendorId === INSTANCE_ADMIN_VENDOR_ID);
}

it("is offered, disabled by default, to deployment admins only", async () => {
  const vendor = () => admin.getSettings().then(settings => settings.resourceVendors
      .find(candidate => candidate.vendorId === INSTANCE_ADMIN_VENDOR_ID));
  expect(await vendor()).toMatchObject({ autoProvisions: true, ambientMode: "disabled" });
  await expect(adminUser.provisionAmbientAccount(INSTANCE_ADMIN_VENDOR_ID))
      .rejects.toThrow(
          `The "${INSTANCE_ADMIN_VENDOR_ID}" gatekeeper is disabled on this deployment.`);

  using stack = new DisposableStack();
  const nonAdmin = stack.use(await signUp(stack.use(connect(harness.url)),
      nextUsernames("nonadmin")[0]!));
  await admin.setGatekeeperMode(INSTANCE_ADMIN_VENDOR_ID, "optional");
  expect(await vendor()).toMatchObject({ ambientMode: "optional" });
  expect(await addable(adminUser)).toContain(INSTANCE_ADMIN_VENDOR_ID);
  expect(await addable(nonAdmin)).not.toContain(INSTANCE_ADMIN_VENDOR_ID);
  await expect(nonAdmin.provisionAmbientAccount(INSTANCE_ADMIN_VENDOR_ID))
      .rejects.toThrow("Only deployment admins can add the instance admin gatekeeper.");

  try {
    await admin.setGatekeeperMode(INSTANCE_ADMIN_VENDOR_ID, "enabled");
    expect(await instanceAdminAccounts(nonAdmin)).toEqual([]);
    expect(await waitFor("the admin's forced account", async () => {
      const accounts = await instanceAdminAccounts(adminUser);
      return accounts.length > 0 ? accounts : null;
    })).toHaveLength(1);
  } finally {
    await admin.setGatekeeperMode(INSTANCE_ADMIN_VENDOR_ID, "optional");
  }
});

it("asks the owner to turn access on, then reads as them once they approve", async () => {
  agent = await openAdminSession(AGENT_ADMIN, agentModel);
  const ask = run(`await attempt("users", async () =>
      (await env.INSTANCE_ADMIN.listUsers()).users.map(user => user.id));`);
  const retry = run(`await attempt("users", async () =>
      (await env.INSTANCE_ADMIN.listUsers()).users.map(user => user.id));`);
  const model = agentModel.script([ask, retry, { text: "Listed the users." }]);

  const first = await agent.runTurn("List this deployment's users.");
  expect(first.outcome).toEqual({ status: "completed" });
  const refusal = outputsOf(first.history, ask).users?.error;
  expect(refusal).toMatch(/^Deployment admin access is off in this workspace, so nothing ran\./);
  const requests = await pending(agent);
  expect(requests).toHaveLength(1);
  const [request] = requests;
  if (request?.type !== "action") throw new Error("No activation request");
  expect(request.id).toBe(actionIdIn(refusal));
  expect(request.description.title).toBe(ACTIVATION_TITLE);
  expect(request.description.description).toContain(
      "in turns that answer a message you wrote yourself here");
  expect(request.description.description).toContain("AI Gateway logs");
  expect(request.description.description).toContain("instance instructions");
  expect(request.gatekeeperId).toEqual(expect.any(Number));
  capsuleId = request.gatekeeperId!;
  expect(await observations(agent)).toEqual([]);
  expect(model.requests).toHaveLength(1);

  const resumed = await agent.approveActionsAndWait([request.id]);
  expect(resumed.outcome).toEqual({ status: "completed" });
  const nudge = resumed.history.findLast(message => message.type === "agentNudge");
  expect(nudge).toMatchObject({ text: expect.stringContaining(
      "Nothing ran when you asked: make those calls again now, with the same arguments.") });
  expect(outputsOf(resumed.history, retry).users?.value).toContain(AGENT_ADMIN);
  expect(model.remainingSteps()).toBe(0);
  expect(await observations(agent)).toEqual([expect.objectContaining({
    description: expect.objectContaining({
      title: "List users (deployment admin)", containsRestrictedData: true,
    }),
  })]);

  await withWorkspace(agent, async ws => {
    expect(await ws.getMetadata())
        .toMatchObject({ deploymentAdminAccess: "on", containsRestrictedData: true });
    await expect(ws.createShareLink("build")).rejects.toThrow(NOT_SHAREABLE);
    using stack = new DisposableStack();
    const [collaborator] = nextUsernames("wouldbecollaborator");
    stack.use(await signUp(stack.use(connect(harness.url)), collaborator!));
    await expect(ws.addCollaborator(collaborator!, "build")).rejects.toThrow(NOT_SHAREABLE);
  });
});

it("keeps the capsule only in a workspace nobody else can open", async () => {
  second = await openAdminSession(SECOND_ADMIN, secondModel);
  const ask = run(`await attempt("settings", () => env.INSTANCE_ADMIN.getSettings());`);
  secondModel.script([ask]);
  const turn = await second.runTurn("Read the deployment's settings.");
  const [request] = await pending(second);
  if (request?.type !== "action") throw new Error("No activation request");
  expect(request.id).toBe(actionIdIn(outputsOf(turn.history, ask).settings?.error));
  const firstCapsule = request.gatekeeperId!;

  await withWorkspace(second, async ws => {
    const { linkId } = await ws.createShareLink("use");
    // Sharing drops the capsule at once, and a pending activation can't be approved after it.
    await expect(ws.getGatekeeperById(firstCapsule)).rejects.toThrow();
    await expect(ws.approveAction(request.id)).rejects.toThrow(REMOVED);
    expect(await actionState(second!, request.id)).toBe("pending");
    await ws.rejectAction(request.id);
    expect(await actionState(second!, request.id)).toBe("rejected");
    await ws.revokeShareLink(linkId, []);
  });

  // Reopening places a new capsule once nobody else can open the workspace again.
  const later = Array.from({ length: 8 }, (_, i) => firstCapsule + 1 + i);
  const [secondCapsule] = await waitFor("a new capsule", () => withWorkspace(second!, async ws => {
    const found = await capsulesAmong(ws, later);
    return found.length > 0 ? found : null;
  }));

  // The chat keeps the first capsule's name taken, so it binds the new one as INSTANCE_ADMIN_2.
  const again = run(`await attempt("settings", () => env.INSTANCE_ADMIN_2.getSettings());`);
  secondModel.script([again]);
  const next = await second.runTurn("Read the deployment's settings again.");
  const [renewed] = await pending(second);
  if (renewed?.type !== "action") throw new Error("No new activation request");
  expect(renewed.id).toBe(actionIdIn(outputsOf(next.history, again).settings?.error));
  expect(renewed).toMatchObject({
    gatekeeperId: secondCapsule, description: expect.objectContaining({ title: ACTIVATION_TITLE }),
  });
});

it("queues each change for approval and makes exactly the approved calls", async () => {
  const session = agent!;
  const { announcement } = await admin.getSettings();
  const change = run(`await attempt("one", () => env.INSTANCE_ADMIN.setAnnouncement("one"));
await attempt("two", () => env.INSTANCE_ADMIN.setAnnouncement("two"));`);
  const model = agentModel.script([change, { text: "Both changes are made." }]);
  const turn = await session.runTurn("Set the announcement to one, then two.");
  expect(outputsOf(turn.history, change)).toEqual({ one: { value: null }, two: { value: null } });
  const cards = await pending(session);
  expect(cards).toHaveLength(2);
  for (const [i, card] of cards.entries()) {
    expect(card).toMatchObject({ type: "action", description: {
      title: "Set announcement (deployment admin)",
      fields: [
        { label: "Method", kind: "inline", value: "AdminApi.setAnnouncement" },
        { label: "Argument 1", kind: "inline", value: ["one", "two"][i] },
      ],
    } });
  }
  expect((await admin.getSettings()).announcement).toBe(announcement);

  const before = (await gatekeeperRecords()).length;
  try {
    await withWorkspace(session, ws => Promise.all(cards.map(card => ws.approveAction(card.id))));
    await settled(session, model);
    expect(["one", "two"]).toContain((await admin.getSettings()).announcement);
    const all = await gatekeeperRecords();
    const records = all.slice(0, all.length - before);
    expect(records).toHaveLength(2);
    expect(records.map(record => record.kind === "setting" ? record.origin?.actionId ?? -1 : -1)
        .toSorted((a, b) => a - b)).toEqual(cards.map(card => card.id));
    for (const record of records) {
      expect(record).toMatchObject({
        kind: "setting", method: "setAnnouncement", admin: AGENT_ADMIN, via: "gatekeeper",
        origin: { workspaceId: session.workspaceId, chatId: session.chatId },
      });
    }
    expect(new Set(records.map(record => record.sessionId)).size).toBe(1);

    const third = run(`await attempt("three", () => env.INSTANCE_ADMIN.setAnnouncement("three"));`);
    agentModel.script([third]);
    await session.runTurn("Set the announcement to three.");
    const [rejected] = await pending(session);
    if (rejected === undefined) throw new Error("No third change");
    const set = (await admin.getSettings()).announcement;
    await withWorkspace(session, ws => ws.rejectAction(rejected.id));
    expect(await actionState(session, rejected.id)).toBe("rejected");
    expect((await admin.getSettings()).announcement).toBe(set);
    expect(await gatekeeperRecords()).toHaveLength(before + 2);
  } finally {
    await admin.setAnnouncement(announcement);
  }
});

it("inspects at the metadata level at once, and opens content only once approved", async () => {
  const session = agent!;
  using stack = new DisposableStack();
  const owner = stack.use(await signUp(stack.use(connect(harness.url)),
      nextUsernames("inspected")[0]!));
  const ws = stack.use(await owner.newGadget());
  const title = "Inspected by the instance admin suite";
  await ws.setTitle(title);
  const chatId = await ws.newChat("hello", null);
  const { id } = await ws.getMetadata();
  const target = JSON.stringify(id);

  const metadata = run(`const view = env.INSTANCE_ADMIN.inspectWorkspace(${target}, "support");
await attempt("title", async () => (await view.describe()).title);
await attempt("chat", () => view.getChat(${chatId}));`);
  const full = run(`await attempt("full", async () => {
  await env.INSTANCE_ADMIN.inspectWorkspace(${target}, "support", { access: "full" });
});`);
  const approved = run(`const view = await env.INSTANCE_ADMIN.inspectWorkspace(${target}, "support",
    { access: "full" });
await attempt("messages", async () => (await view.getChat(${chatId})).messages
    .flatMap(message => message.type === "message" ? [message.message] : []));
await attempt("again", async () => {
  await env.INSTANCE_ADMIN.inspectWorkspace(${target}, "support", { access: "full" });
});
await attempt("otherReason", async () => {
  await env.INSTANCE_ADMIN.inspectWorkspace(${target}, "audit", { access: "full" });
});`);
  const model = agentModel.script([
    metadata, { text: "It is the inspected workspace." }, full, approved, { text: "Inspected." },
  ]);

  const before = (await gatekeeperRecords()).length;
  const read = await session.runTurn("Look at that workspace.");
  expect(outputsOf(read.history, metadata)).toEqual({
    title: { value: title },
    chat: { error: createAdminAccessError(ADMIN_ACCESS_ERROR_CODES.contentWithheld).message },
  });
  const records = (await admin.listAdminAudit({ workspace: id, via: "gatekeeper" })).records;
  expect(records.length).toBeGreaterThan(0);
  for (const record of records) {
    expect(record).toMatchObject({
      kind: "workspace", admin: AGENT_ADMIN, via: "gatekeeper", reason: "support",
      origin: { workspaceId: session.workspaceId, chatId: session.chatId },
    });
    expect(record).not.toHaveProperty("origin.actionId");
  }
  expect((await ws.listActions()).entries).toEqual([]);

  await admin.setAdminWorkspaceAccess("full");
  try {
    const asked = await session.runTurn("Now read its chat.");
    const actionId = actionIdIn(outputsOf(asked.history, full).full?.error);
    const [card] = await pending(session);
    expect(card).toMatchObject({
      id: actionId,
      description: { title: "Inspect a workspace with full access (deployment admin)" },
    });

    const resumed = await session.approveActionsAndWait([actionId]);
    const outputs = outputsOf(resumed.history, approved);
    expect(outputs.messages).toEqual({ value: ["hello"] });
    const contentRead = (await admin.listAdminAudit({ workspace: id, exposed: "content" }))
        .records[0];
    expect(contentRead).toMatchObject({
      method: "getChat", requested: "full", access: "full", exposed: "content", via: "gatekeeper",
      origin: { workspaceId: session.workspaceId, chatId: session.chatId, actionId },
    });
    // The approval allowed one call: the same call again, and one with another reason, ask again.
    const again = actionIdIn(outputs.again?.error);
    const otherReason = actionIdIn(outputs.otherReason?.error);
    expect(new Set([actionId, again, otherReason]).size).toBe(3);
    expect((await pending(session)).map(entry => entry.id)).toEqual([again, otherReason]);
    await withWorkspace(session, async agentWs => {
      await agentWs.rejectAction(again);
      await agentWs.rejectAction(otherReason);
    });
    expect(model.remainingSteps()).toBe(1);
    expect((await gatekeeperRecords()).length).toBeGreaterThan(before);
  } finally {
    await admin.setAdminWorkspaceAccess("metadata");
  }
});

it("serves only the owner's own agent turns, while the code runs", async () => {
  const session = agent!;
  const chatId = session.chatId!;

  // (a) A callback turn is not the owner's, and a binding kept past its code run is dead.
  const schedule = run(`await attempt("later", () => self.later(env.INSTANCE_ADMIN));`);
  const callback = run(`await attempt("settings", () => env.INSTANCE_ADMIN.getSettings());`);
  const kept = run(`await attempt("kept", () => env.later_ARGS[0].getSettings());`);
  const model = agentModel.script([
    schedule, { text: "Scheduled." }, callback, { text: "Called back." }, kept, { text: "Done." },
  ]);
  const scheduled = await session.runTurn("Schedule a callback with the binding.");
  expect(outputsOf(scheduled.history, schedule).later).toEqual({ value: null });
  await withWorkspace(session, ws => waitFor("the callback turn", async () =>
    model.remainingSteps() === 2 && await waitForIdleChat(ws, chatId) || null));
  const keptTurn = await session.runTurn("Read the settings through the binding you kept.");
  expect(outputsOf(keptTurn.history, callback).settings).toEqual({ error: NOT_OWNER_TURN });
  expect(outputsOf(keptTurn.history, kept).kept?.error).toContain(RUN_ENDED);

  await withWorkspace(session, async ws => {
    // (b) A session opened directly, not from an agent's executeCode, is refused.
    using gatekeeper = await ws.getGatekeeperById(capsuleId);
    await expect((async () => {
      using direct = await gatekeeper.openSession() as RpcStub<AdminApi>;
      return await direct.getSettings();
    })()).rejects.toThrow(NOT_AGENT);
  });

  // (c) The binding can't be wired into a gadget.
  const bind = tool("setGadgetBinding", { gadget: "PANEL", source: "INSTANCE_ADMIN" });
  const binding = agentModel.script([
    tool("createGadget", { title: "Panel", bindingName: "PANEL" }), bind, { text: "Done." },
  ]);
  const bound = await session.runTurn("Give a gadget the instance admin binding.");
  expect(toolCallOf(bound.history, bind.toolCall.id)?.error).toContain(NOT_BINDABLE);
  expect(binding.remainingSteps()).toBe(0);

  // (d) Stopping the turn stops a run still using the binding.
  const loop = run(`for (let i = 0; i < 100; i++) {
  try {
    await env.INSTANCE_ADMIN.getSettings();
  } catch (error) {
    console.log("stopped", JSON.stringify({ error: String(error?.message ?? error) }));
    return;
  }
  await scheduler.wait(100);
}`);
  agentModel.script([loop, { text: "Looped." }]);
  const seen = (await observations(session)).length;
  const looping = session.runTurn("Read the settings again and again.");
  await waitFor("the loop's first read", async () =>
    (await observations(session)).length > seen || null);
  await withWorkspace(session, async ws => {
    await ws.stopAgent(chatId);
    await waitForIdleChat(ws, chatId);
  });
  await looping;
  const stoppedAt = await waitFor("the run to see the stop", async () => {
    const history = await withWorkspace(session, async ws =>
      (await ws.getChatHistory(chatId)).messages);
    return toolCallOf(history, loop.toolCall.id)?.output === undefined ? null : history;
  });
  expect(outputsOf(stoppedAt, loop).stopped).toEqual({ error: STOPPED });
  const count = (await observations(session)).length;
  await new Promise(resolve => setTimeout(resolve, 500));
  expect((await observations(session)).length).toBe(count);
  expect(count).toBeLessThan(seen + 100);
});

it("leaves the withheld methods out of the agent's types, and refuses them", async () => {
  const session = agent!;
  const describe = tool("describeBinding", { name: "INSTANCE_ADMIN" });
  const call = run(
      `await attempt("withheld", () => env.INSTANCE_ADMIN.setAdminWorkspaceAccess("full"));`);
  const model = agentModel.script([describe, call, { text: "Done." }]);
  const { adminWorkspaceAccess } = await admin.getSettings();
  const turn = await session.runTurn("Describe the instance admin binding, then raise the level.");
  expect(model.remainingSteps()).toBe(0);

  const described = toolCallOf(turn.history, describe.toolCall.id) as { output?: string };
  expect(described.output).toContain("interface AdminApi");
  expect(described.output).toContain("listUsers(");
  expect(described.output).not.toContain("setAdminWorkspaceAccess(");
  // Still named, in the preamble and in the union of AdminSettingRecord.method.
  expect(described.output).toContain("setAdminWorkspaceAccess");
  expect(outputsOf(turn.history, call).withheld).toEqual({
    error: 'The RPC receiver does not implement the method "setAdminWorkspaceAccess".',
  });
  expect((await admin.getSettings()).adminWorkspaceAccess).toEqual(adminWorkspaceAccess);
});

it("turns off at once, asks again to turn back on, and stays unshareable", async () => {
  const session = agent!;
  const queue = run(`await attempt("change", () => env.INSTANCE_ADMIN.setAnnouncement("queued"));`);
  agentModel.script([queue]);
  await session.runTurn("Set the announcement to queued.");
  const [queued] = await pending(session);
  if (queued === undefined) throw new Error("No queued change");

  await withWorkspace(session, async ws => {
    await ws.turnOffDeploymentAdminAccess();
    expect(await ws.getMetadata()).toMatchObject({ deploymentAdminAccess: "off" });
  });
  expect(await actionState(session, queued.id)).toBe("rejected");

  const ask = run(`await attempt("settings", async () =>
      typeof (await env.INSTANCE_ADMIN.getSettings()).announcement);`);
  const retry = run(`await attempt("settings", async () =>
      typeof (await env.INSTANCE_ADMIN.getSettings()).announcement);`);
  const model = agentModel.script([ask, retry, { text: "Read the settings." }]);
  const asked = await session.runTurn("Read the settings.");
  const actionId = actionIdIn(outputsOf(asked.history, ask).settings?.error);
  const [request] = await pending(session);
  expect(request).toMatchObject({ id: actionId, description: { title: REACTIVATION_TITLE } });
  await withWorkspace(session, ws =>
    expect(ws.createShareLink("build")).rejects.toThrow(NOT_SHAREABLE));

  const resumed = await session.approveActionsAndWait([actionId]);
  expect(outputsOf(resumed.history, retry).settings).toEqual({ value: "string" });
  expect(model.remainingSteps()).toBe(0);
  await withWorkspace(session, async ws =>
    expect(await ws.getMetadata()).toMatchObject({ deploymentAdminAccess: "on" }));

  // In a workspace never turned on, turning off only rejects the requests to turn it on.
  const [secondRequest] = await pending(second!);
  if (secondRequest === undefined) throw new Error("No pending activation in the second workspace");
  await withWorkspace(second!, async ws => {
    await ws.turnOffDeploymentAdminAccess();
    expect(await ws.getMetadata()).not.toHaveProperty("deploymentAdminAccess");
  });
  expect(await actionState(second!, secondRequest.id)).toBe("rejected");
});

it("stops serving once the deployment disables it", async () => {
  const session = agent!;
  const call = run(`await attempt("settings", () => env.INSTANCE_ADMIN.getSettings());`);
  agentModel.script([call, { text: "Done." }]);
  const seen = (await observations(session)).length;
  const records = (await gatekeeperRecords()).length;

  await admin.setGatekeeperMode(INSTANCE_ADMIN_VENDOR_ID, "disabled");
  try {
    const turn = await session.runTurn("Read the settings once more.");
    const { error } = outputsOf(turn.history, call).settings ?? {};
    // R7, or no binding at all once a reopen of the workspace has removed the capsule.
    expect([DISABLED, BINDING_GONE]).toContain(error);
    expect((await observations(session)).length).toBe(seen);
    expect(await gatekeeperRecords()).toHaveLength(records);
  } finally {
    await admin.setGatekeeperMode(INSTANCE_ADMIN_VENDOR_ID, "optional");
  }
});
