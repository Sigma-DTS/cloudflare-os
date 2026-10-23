// The instance admin Gatekeeper after its owner stops being a deployment admin: a redeploy that
// drops them from ADMINS ends their agent's admin power, hides their account and removes the
// capsule, and they can still turn access off in a workspace that stays theirs alone. Its own
// harness, because it redeploys the Workshop.

import type { RpcStub } from "capnweb";
import { afterAll, beforeAll, expect, it } from "vitest";
import type {
  ActionLogEntry, AdminApi, AdminAuditRecord, AiChatMessage, Overseer,
} from "@gadgets/workshop-shared/api";
import { INSTANCE_ADMIN_VENDOR_ID } from "@gadgets/workshop-shared/instance-admin";
import { openAgentSession, type WorkshopAgentSession } from "../src/agent-session.js";
import {
  ADMIN_USERNAME, INSTANCE_ADMIN_GATEKEEPER, startHarness, type Harness,
} from "../src/harness.js";
import {
  SCRIPTED_MODEL_ID, scriptedModelRouter, type ChatCompletionStep,
} from "../src/mock-model.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import { connect, listConnectedAccounts, logIn, signUp, waitFor } from "../src/rpc-client.js";

const DEMOTED_ADMIN = "demotedadmin";
// What the agent's code gets from `env.INSTANCE_ADMIN.getSettings()` once the capsule is gone.
const BINDING_GONE = "Cannot read properties of undefined (reading 'getSettings')";
const NOT_SHAREABLE = "Deployment admin access has been on in this workspace, so only its owner " +
    "can ever open it: it can't be shared.";

let toolCallSeq = 0;

/** A model step that logs each `attempt(label, ...)` of `body`, run with executeCode. */
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

const readSettings = () =>
  run(`await attempt("settings", async () => typeof (await env.INSTANCE_ADMIN.getSettings()));`);
const ASK = readSettings();
const ACTIVATED = readSettings();
const DEMOTED = readSettings();

const models = scriptedModelRouter();
const model = models.script([
  ASK, ACTIVATED, { text: "Access is on." }, DEMOTED, { text: "That failed." },
]);
const network = new NetworkInterceptor({ handlers: [models.handler] });
let harness: Harness;
let agent: WorkshopAgentSession;

beforeAll(async () => {
  network.install();
  harness = await startHarness({
    gatekeepers: [INSTANCE_ADMIN_GATEKEEPER],
    enableGadgetExecution: true,
    patchWorkshop: config => {
      config.vars = { ...config.vars, ADMINS: [ADMIN_USERNAME, DEMOTED_ADMIN] };
    },
  });
  using publicApi = connect(harness.url);
  using adminUser = await signUp(publicApi, ADMIN_USERNAME);
  using admin = await adminUser.getAdminApi();
  if (admin === null) throw new Error("The admin API was unavailable to the suite's admin");
  await admin.setGatekeeperMode(INSTANCE_ADMIN_VENDOR_ID, "optional");
  agent = await openAgentSession(harness.url, {
    username: DEMOTED_ADMIN, modelId: SCRIPTED_MODEL_ID, userModel: model.userModel,
    ambientVendorIds: [INSTANCE_ADMIN_VENDOR_ID],
  });
});

afterAll(async () => {
  try {
    await agent?.close();
    await harness?.server.close();
    expect(network.getUnmockedCalls()).toEqual([]);
  } finally {
    network.uninstall();
  }
});

type Attempt = { value?: unknown; error?: string };

/** What each `attempt(label, ...)` of executeCode step `step` logged, by label. */
function outputsOf(history: AiChatMessage[], step: { toolCall: { id: string } })
    : Record<string, Attempt> {
  let output: string | undefined;
  for (const message of history) {
    if (message.type !== "message") continue;
    const call = message.toolCalls?.find(candidate => candidate.toolCallId === step.toolCall.id);
    if (call?.toolName === "executeCode") output = call.output;
  }
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

async function actionLog(): Promise<ActionLogEntry[]> {
  const entries: ActionLogEntry[] = [];
  let beforeId: number | undefined;
  do {
    const page = await agent.listActions({ beforeId });
    entries.push(...page.entries);
    beforeId = page.nextBeforeId;
  } while (beforeId !== undefined);
  return entries;
}

/** Runs `fn` with the suite's admin's Admin API, over a connection of its own. */
async function asAdmin<T>(fn: (admin: RpcStub<AdminApi>) => Promise<T>): Promise<T> {
  using publicApi = connect(harness.url);
  using adminUser = await logIn(publicApi, ADMIN_USERNAME);
  using admin = await adminUser.getAdminApi();
  if (admin === null) throw new Error("The admin API was unavailable to the suite's admin");
  return await fn(admin);
}

const gatekeeperRecords = () => asAdmin(async admin =>
  (await admin.listAdminAudit({ via: "gatekeeper", limit: 200 })).records as AdminAuditRecord[]);

/** Runs `fn` on the agent's workspace, opened by its owner over a connection of their own. */
async function asOwner<T>(fn: (ws: RpcStub<Overseer>, api: Awaited<ReturnType<typeof logIn>>)
    => Promise<T>): Promise<T> {
  using publicApi = connect(harness.url);
  using api = await logIn(publicApi, agent.username);
  using ws = await api.openGadget(agent.workspaceId);
  return await fn(ws, api);
}

it("ends a demoted owner's admin power, and still lets them turn access off", async () => {
  const asked = await agent.runTurn("Read the deployment's settings.");
  const refusal = outputsOf(asked.history, ASK).settings?.error;
  const activation = Number(/\(action (\d+)\)/.exec(refusal ?? "")?.[1]);
  const request = (await actionLog()).find(entry => entry.id === activation);
  if (request?.type !== "action") throw new Error(`No activation request in: ${refusal}`);
  const capsuleId = request.gatekeeperId!;
  const activated = await agent.approveActionsAndWait([activation]);
  expect(outputsOf(activated.history, ACTIVATED).settings).toEqual({ value: "object" });
  const observed = (await actionLog()).filter(entry => entry.type === "observation").length;
  const records = (await gatekeeperRecords()).length;

  // Redeployed without the suite's patch, ADMINS falls back to the harness's [ADMIN_USERNAME],
  // which drops DEMOTED_ADMIN. Not [], because the suite's admin still reads the audit log.
  await harness.redeployWorkshop();
  await waitFor("the agent's session to reconnect", async () => agent.connectionDrops > 0 || null);
  // The reopen removes the demoted owner's capsule, which drops the agent's session again and
  // loses a message sent meanwhile, so the turn waits until the capsule is gone. Only the kernel's
  // unknown-id error means gone; a connection that fails, before or during the call, is retried.
  await waitFor("the reopened workspace to drop the capsule", async () => {
    try {
      return await asOwner(async ws => {
        try {
          using _capsule = await ws.getGatekeeperById(capsuleId);
          return null;
        } catch (e) {
          return String(e).includes("No such gatekeeper id") || null;
        }
      });
    } catch {
      return null;
    }
  });

  const demoted = await agent.runTurn("Read the settings again.");
  // The reopen has already removed the capsule, so the agent has no binding at all.
  expect(outputsOf(demoted.history, DEMOTED).settings?.error).toBe(BINDING_GONE);
  expect(model.remainingSteps()).toBe(0);
  expect((await actionLog()).filter(entry => entry.type === "observation")).toHaveLength(observed);
  expect(await gatekeeperRecords()).toHaveLength(records);

  await asOwner(async (ws, api) => {
    expect((await listConnectedAccounts(api, { includeForcedAutoProvisionedAccounts: true }))
        .filter(account => account.vendorId === INSTANCE_ADMIN_VENDOR_ID)).toEqual([]);
    await expect(ws.getGatekeeperById(capsuleId)).rejects.toThrow();

    await ws.turnOffDeploymentAdminAccess();
    expect(await ws.getMetadata()).toMatchObject({ deploymentAdminAccess: "off" });
    await expect(ws.createShareLink("build")).rejects.toThrow(NOT_SHAREABLE);
  });
});
