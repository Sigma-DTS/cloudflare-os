import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { OverseerDurableObject } from "../src/overseer";
import type { UserDurableObject } from "../src/user";
import type { AgentContinuationWait } from "../src/storage-schema/overseer-storage";
import type { IntegrationTestActionGatekeeper, IntegrationTestParticipant } from "./test-worker";

export type Impl = OverseerDurableObject["impl"];
export type Participant = Fetcher<IntegrationTestParticipant>;
export type TestExports = Cloudflare.Exports & {
  IntegrationTestParticipant(options: { props: { name: string } }): Participant;
  IntegrationTestActionGatekeeper(options: { props: Record<string, never> }): DurableObjectClass<IntegrationTestActionGatekeeper>;
};
export const CHAT = 1, GATEKEEPER = 31;
export const APPROVER = { type: "user" as const, id: "original-approver", name: "Approver" };
export const GRANT = '{"container":{"lifecycle":true,"contextualActions":true,"recoverableActions":true}}';
export const RUN = { chatId: CHAT, initiator: APPROVER, initiatorUserId: "unused", modelId: "fixture", callbackInitiated: false };
export const MODEL = {profile: {type: "agent" as const, id: "recovery-model", name: "Recovery"},
  config: {provider: "anthropic" as const, model: "recovery-model", apiToken: "test-key", apiUrl: "https://recovery.test"}};

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
    TEST_USER: DurableObjectNamespace<UserDurableObject>;
  }
}

export async function recoveryScenario() {
  const name = crypto.randomUUID(), stub = env.TEST_OVERSEER.getByName(name);
  const user = env.TEST_USER.getByName(crypto.randomUUID());
  await runInDurableObject(user, instance => {
    instance["storage"].profile.put(APPROVER);
    instance["storage"].aiModels.put(MODEL);
  });
  await runInDurableObject(stub, instance => {
    seedContinuation(instance.impl, name);
    instance.impl.addChatMessages(CHAT, APPROVER, [{type: "message", message: "First prompt"}]);
    instance.impl.storage.chatContext.put({chatId: CHAT, bindings: {}, alwaysAvailableCapsuleIds: []});
  });
  return {stub, user, name,
    visit: <T>(test: (impl: Impl, participant: Participant) => T | Promise<T>) => runInDurableObject(env.TEST_OVERSEER.get(stub.id), async instance => {
      const impl = instance.impl;
      impl.env.AGENT_INTEGRATION_GRANTS = GRANT;
      const participant = (impl.ctx.exports as TestExports).IntegrationTestParticipant({props: {name}});
      return test(impl, participant);
    }),
  };
}

export function providerReply(): Response {
  const events = [
    {type: "message_start", message: {id: "msg_recovery", type: "message", role: "assistant", model: MODEL.profile.id,
      content: [], stop_reason: null, stop_sequence: null, usage: {input_tokens: 1, output_tokens: 1}}},
    {type: "content_block_start", index: 0, content_block: {type: "text", text: ""}},
    {type: "content_block_delta", index: 0, delta: {type: "text_delta", text: "Recovered."}},
    {type: "content_block_stop", index: 0},
    {type: "message_delta", delta: {stop_reason: "end_turn", stop_sequence: null}, usage: {output_tokens: 1}},
    {type: "message_stop"},
  ];
  return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
    {headers: {"content-type": "text/event-stream"}});
}

export function seedContinuation(impl: Impl, name: string) {
  impl.env.AGENT_INTEGRATION_GRANTS = GRANT;
  const timestamp = impl.getChatTimestamp();
  impl.storage.chatMeta.put({ id: CHAT, title: "Continuation", started: timestamp, lastActive: timestamp });
  impl.storage.gatekeepers.put({ id: GATEKEEPER,
    class: (impl.ctx.exports as TestExports).IntegrationTestActionGatekeeper({ props: {} }),
    creationSpec: { type: "ambient", vendorId: "container" } });
  return (impl.ctx.exports as TestExports).IntegrationTestParticipant({ props: { name } });
}

export async function inKernel(test: (impl: Impl, participant: Participant) => Promise<void>) {
  const name = crypto.randomUUID();
  await runInDurableObject(env.TEST_OVERSEER.getByName(name), async instance => {
    const impl = instance.impl;
    try { await test(impl, seedContinuation(impl, name)); }
    finally { delete impl.env.AGENT_INTEGRATION_GRANTS; }
  });
}

export function origin(impl: Impl) {
  const captured = impl.captureIntegrationOrigin({ from: "agent", chatId: CHAT });
  if (!captured) throw new Error("Fixture did not enter a running segment");
  return captured;
}

export async function start(impl: Impl) {
  const record = impl.continuations.start(RUN);
  await impl.beginAgentIntegrationTurn(CHAT, record.continuationId);
  return origin(impl);
}

export async function flush(impl: Impl) {
  for (const record of Array.from(impl.storage.agentIntegrationParticipants.list())) {
    impl.storage.agentIntegrationParticipants.put({ ...record, retryAt: Date.now() });
  }
  await impl.retryAgentIntegrationEvents();
}

export async function pause(impl: Impl, wait: AgentContinuationWait = {kind: "approval", actionIds: [1]}) {
  const record = impl.continuations.get(CHAT)!;
  impl.continuations.suspend(CHAT, record.continuationId, wait, false);
  await flush(impl);
  impl.continuations.settle(CHAT, record.continuationId);
}

export async function resume(impl: Impl, source: number | string = 1) {
  impl.continuations.wake(CHAT, source);
  const record = impl.continuations.resume(CHAT)!;
  await impl.beginAgentIntegrationTurn(CHAT, record.continuationId);
  return origin(impl);
}

export async function finish(impl: Impl) {
  const record = impl.continuations.close(CHAT, "completed")!;
  await flush(impl);
  impl.continuations.settle(CHAT, record.continuationId);
}
