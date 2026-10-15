import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { OverseerDurableObject } from "../src/overseer";
import type { UserDurableObject } from "../src/user";

export const CHAT = 1, GATEKEEPER = 31;
export const APPROVER = {type: "user" as const, id: "original-approver", name: "Approver"};
export const RUN = {chatId: CHAT, initiator: APPROVER, initiatorUserId: "unused", modelId: "fixture", callbackInitiated: false};
export const MODEL = {profile: {type: "agent" as const, id: "recovery-model", name: "Recovery"},
  config: {provider: "anthropic" as const, model: "recovery-model", apiToken: "test-key", apiUrl: "https://recovery.test"}};

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
    TEST_USER: DurableObjectNamespace<UserDurableObject>;
  }
}

export async function recoveryScenario() {
  const stub = env.TEST_OVERSEER.getByName(crypto.randomUUID());
  const user = env.TEST_USER.getByName(crypto.randomUUID());
  await runInDurableObject(user, instance => {
    instance["storage"].profile.put(APPROVER);
    instance["storage"].aiModels.put(MODEL);
  });
  await runInDurableObject(stub, ({impl}) => {
    const timestamp = impl.getChatTimestamp();
    impl.storage.chatMeta.put({id: CHAT, title: "Continuation", started: timestamp, lastActive: timestamp});
    impl.addChatMessages(CHAT, APPROVER, [{type: "message", message: "First prompt"}]);
    impl.storage.chatContext.put({chatId: CHAT, bindings: {}, alwaysAvailableCapsuleIds: []});
  });
  return {stub, user,
    visit: <T>(test: (impl: OverseerDurableObject["impl"]) => T | Promise<T>) =>
      runInDurableObject(env.TEST_OVERSEER.get(stub.id), ({impl}) => test(impl)),
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
