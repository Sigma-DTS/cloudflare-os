// The instance admin Gatekeeper's paid calls: an AI Gateway test, which the deployment's provider
// bills, sends nothing until the owner approves that one call, and then sends exactly one request.
// Its own harness, in AI Gateway mode, so SCRIPTED_MODEL_ID is one of the gateway's built-in models
// (as in ai-gateway-cost.test.ts) and the agent's turns and the gateway tests reach one endpoint.

import type { RpcStub } from "capnweb";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { ActionLogEntry, AdminApi, AiChatMessage } from "@gadgets/workshop-shared/api";
import { INSTANCE_ADMIN_VENDOR_ID } from "@gadgets/workshop-shared/instance-admin";
import { openAgentSession, type WorkshopAgentSession } from "../src/agent-session.js";
import {
  ADMIN_USERNAME, INSTANCE_ADMIN_GATEKEEPER, startHarness, type Harness,
} from "../src/harness.js";
import {
  SCRIPTED_MODEL_ID, scriptedChatCompletions, type ChatCompletionStep,
} from "../src/mock-model.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import { connect, logIn, signUp } from "../src/rpc-client.js";

const GATEWAY_ADMIN = "gatewayadmin";
const TEST_PROMPT = "Reply with OK.";
const TEST_TITLE = "Test gateway model (deployment admin, billed)";

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
const testModel = (label: string) =>
  `await attempt(${JSON.stringify(label)}, () => env.INSTANCE_ADMIN.testGatewayModel(${
    JSON.stringify(SCRIPTED_MODEL_ID)}));`;

// The session's steps, in the order the cases below run them.
const ASK_ACTIVATION = readSettings();
const ACTIVATED = readSettings();
const ASK_TEST = run(testModel("test"));
const APPROVED_TEST = run(`${testModel("test")}\n${testModel("third")}`);
const AFTER_REJECTION = run(testModel("rejected"));
const agentModel = scriptedChatCompletions([
  ASK_ACTIVATION, ACTIVATED, { text: "Access is on." },
  ASK_TEST, APPROVED_TEST, AFTER_REJECTION,
]);
// The gateway tests' replies: more than the suite should ever send, so an extra request shows as
// a count rather than as a failed fetch.
const gatewayTests = scriptedChatCompletions(Array.from({ length: 4 }, () => ({ text: "OK" })));

/** Whether `body` is a gateway test's request: its one message is the test's prompt. */
function isGatewayTest(body: unknown): boolean {
  const messages = (body as { messages?: { role?: unknown; content?: unknown }[] }).messages;
  if (messages?.length !== 1 || messages[0]!.role !== "user") return false;
  const content = messages[0]!.content;
  const text = typeof content === "string" ? content
    : Array.isArray(content) ? content.map(part => (part as { text?: unknown }).text).join("")
    : undefined;
  return text === TEST_PROMPT;
}

const network = new NetworkInterceptor({
  handlers: [async (url, method, headers, request) => {
    if (method !== "POST") return null;
    const body: unknown = await request.clone().json().catch(() => undefined);
    return (isGatewayTest(body) ? gatewayTests : agentModel).handler(url, method, headers, request);
  }],
});
const fileScope = new DisposableStack();
let harness: Harness;
let admin: RpcStub<AdminApi>;
let agent: WorkshopAgentSession;

beforeAll(async () => {
  network.install();
  harness = await startHarness({
    gatekeepers: [INSTANCE_ADMIN_GATEKEEPER],
    enableGadgetExecution: true,
    patchWorkshop: config => {
      config.vars = {
        ...config.vars,
        ADMINS: [ADMIN_USERNAME, GATEWAY_ADMIN],
        CF_AI_GATEWAY: "platform-gateway",
        CF_AI_GATEWAY_ACCOUNT_ID: "gateway-account-id",
        CF_AI_GATEWAY_API_TOKEN: "read-run-token",
        CF_AI_GATEWAY_USE_BINDING: "false",
        CF_AI_GATEWAY_PROVIDERS: "cloudflare",
      };
    },
  });
  const adminUser = fileScope.use(
      await signUp(fileScope.use(connect(harness.url)), ADMIN_USERNAME));
  const stub = await adminUser.getAdminApi();
  if (stub === null) throw new Error("The admin API was unavailable to the suite's admin");
  admin = fileScope.use(stub);
  expect((await admin.getSettings()).gatewayModels?.models.map(model => model.id))
      .toContain(SCRIPTED_MODEL_ID);
  await admin.setGatekeeperMode(INSTANCE_ADMIN_VENDOR_ID, "optional");
  agent = await openAgentSession(harness.url, {
    username: GATEWAY_ADMIN, modelId: SCRIPTED_MODEL_ID,
    ambientVendorIds: [INSTANCE_ADMIN_VENDOR_ID],
  });
});

afterAll(async () => {
  try {
    await agent?.close();
    fileScope.dispose();
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

/** The action id an approval message names ("... (action N) ..."). */
function actionIdIn(message: string | undefined): number {
  const match = /\(action (\d+)\)/.exec(message ?? "");
  if (match === null) throw new Error(`No action named in: ${message}`);
  return Number(match[1]);
}

async function actionLog(): Promise<ActionLogEntry[]> {
  const entries: ActionLogEntry[] = [];
  let beforeId: number | undefined;
  do {
    const page = await agent.listActions({ beforeId });
    entries.push(...page.entries);
    beforeId = page.nextBeforeId;
  } while (beforeId !== undefined);
  return entries.toSorted((a, b) => a.id - b.id);
}

const pendingIds = async () => (await actionLog())
    .flatMap(entry => entry.type === "action" && entry.state === "pending" ? [entry.id] : []);

async function reject(id: number): Promise<void> {
  using publicApi = connect(harness.url);
  using api = await logIn(publicApi, agent.username);
  using ws = await api.openGadget(agent.workspaceId);
  await ws.rejectAction(id);
}

it("turns access on in the agent's workspace", async () => {
  const asked = await agent.runTurn("Read the deployment's settings.");
  const activation = actionIdIn(outputsOf(asked.history, ASK_ACTIVATION).settings?.error);
  const resumed = await agent.approveActionsAndWait([activation]);
  expect(outputsOf(resumed.history, ACTIVATED).settings).toEqual({ value: "object" });
});

it("sends a gateway test only once its one call is approved, and only once", async () => {
  const asked = await agent.runTurn("Test the scripted model through the gateway.");
  const actionId = actionIdIn(outputsOf(asked.history, ASK_TEST).test?.error);
  expect(gatewayTests.requests).toHaveLength(0);
  const card = (await actionLog()).find(entry => entry.id === actionId);
  expect(card).toMatchObject({ type: "action", state: "pending", description: {
    title: TEST_TITLE,
    fields: [
      { label: "Method", kind: "inline", value: "AdminApi.testGatewayModel" },
      { label: "Argument 1", kind: "inline", value: SCRIPTED_MODEL_ID },
    ],
  } });

  const resumed = await agent.approveActionsAndWait([actionId]);
  const outputs = outputsOf(resumed.history, APPROVED_TEST);
  expect(outputs.test).toEqual({ value: { model: SCRIPTED_MODEL_ID, ok: true } });
  expect(gatewayTests.requests).toHaveLength(1);
  const observed = (await actionLog()).flatMap(entry => entry.type === "observation" &&
      entry.description.title === "Test gateway model (deployment admin)" ? [entry] : []);
  expect(observed).toHaveLength(1);
  expect(observed[0]?.description.fields)
      .toContainEqual({ label: "Approved as", kind: "inline", value: `action ${actionId}` });

  // The approval allowed that one call: the next identical call asks again.
  const third = actionIdIn(outputs.third?.error);
  expect(third).not.toBe(actionId);
  expect(await pendingIds()).toEqual([third]);
  expect(gatewayTests.requests).toHaveLength(1);
});

it("never sends a rejected gateway test", async () => {
  const [third] = await pendingIds();
  if (third === undefined) throw new Error("No pending gateway test");
  await reject(third);
  const asked = await agent.runTurn("Test the scripted model again.");
  const again = actionIdIn(outputsOf(asked.history, AFTER_REJECTION).rejected?.error);
  expect(again).not.toBe(third);
  expect(await pendingIds()).toEqual([again]);
  expect(gatewayTests.requests).toHaveLength(1);
  expect(agentModel.remainingSteps()).toBe(0);
});
