import { evictDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UserDurableObject } from "../src/user";
import { openFakeOverseer } from "./fixtures";
import { APPROVER, CHAT, GATEKEEPER, MODEL, RUN, providerReply, recoveryScenario } from "./agent-continuation-fixture";

const reset = () => Object.assign(new Error("Injected lost response"), {durableObjectReset: true});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function inference(onRequest: () => void | Promise<void> = () => {}) {
  let requests = 0;
  const fetch = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.origin !== MODEL.config.apiUrl) return fetch(input, init);
    ++requests;
    await onRequest();
    return providerReply();
  });
  return () => requests;
}

describe("continuation driver across real DO eviction", () => {
  it.each([false, true])("recovers an auto-eligible action with an earlier manual gate=%s", async manualGate => {
    const s = await recoveryScenario(), requests = inference();
    await s.visit(async impl => {
      const record = impl.continuations.start({...RUN, initiatorUserId: s.user.id.toString(), modelId: MODEL.profile.id});
      impl.continuations.enter(CHAT, record.continuationId);
      impl.storage.autoApproveTags.put({gatekeeperId: GATEKEEPER,
        actionKind: {tag: "run", label: "Run"}, enabledBy: APPROVER});
      const action = {id: 7, gatekeeperId: GATEKEEPER, type: "action" as const, action: 42, createdAt: new Date(),
        state: "pending" as const, caller: {from: "agent" as const, chatId: CHAT},
        description: {title: "Run", description: "Command", implementsRevert: false, awaitDecision: true,
          autoApprovable: true, actionKind: {tag: "run", label: "Run"}}};
      if (manualGate) impl.storage.actions.put({...action, id: 6,
        description: {...action.description, autoApprovable: false}});
      impl.storage.actions.put(action);
      impl.addChatMessages(CHAT, MODEL.profile, [{type: "action", actionId: action.id}]);
      await impl.ctx.storage.sync();
    });
    await evictDurableObject(s.stub);
    await s.visit(async impl => {
      await impl.waitForAllAgentsToComplete();
      expect(requests()).toBe(manualGate ? 0 : 1);
      expect(impl.continuations.get(CHAT)?.status).toMatchObject(manualGate
        ? {phase: "paused", ready: false} : {phase: "finished"});
    });
  });

  it("waits for a message reserved during resumed model lookup before claiming the chat", async () => {
    const s = await recoveryScenario(), requests = inference();
    let release!: () => void, entered = false;
    const lookup = new Promise<void>(resolve => { release = resolve; });
    const get = UserDurableObject.prototype.getChatContext;
    vi.spyOn(UserDurableObject.prototype, "getChatContext").mockImplementation(async function(id) {
      entered = true; await lookup; return get.call(this, id);
    });
    await s.visit(async impl => {
      impl.continuations.start({...RUN, initiatorUserId: s.user.id.toString(), modelId: MODEL.profile.id});
      await impl.ctx.storage.sync();
    });
    await evictDurableObject(s.stub);
    await s.visit(async impl => {
      await vi.waitFor(() => expect(entered).toBe(true));
      const reservation = impl.reserveChatMessagePreparation(CHAT);
      const wait = vi.spyOn(impl, "waitForChatMessagePreparation");
      try {
        release();
        await vi.waitFor(() => expect(wait).toHaveBeenCalled());
        expect(requests()).toBe(0);
        impl.assertChatNotActive(CHAT, true);
        impl.addChatMessages(CHAT, APPROVER, [{type: "message", message: "Prepared message"}]);
      } finally { reservation[Symbol.dispose](); }
      await impl.waitForAllAgentsToComplete();
      expect(requests()).toBe(1);
      expect([...impl.storage.chats.list()]).toContainEqual(expect.objectContaining({message: "Prepared message"}));
    });
  });

  it("does not resume an old decision after a newer human-only prompt, including after eviction", async () => {
    const s = await recoveryScenario(), requests = inference();
    await s.visit(async impl => {
      const record = impl.continuations.start({...RUN, initiatorUserId: s.user.id.toString(), modelId: MODEL.profile.id});
      impl.continuations.enter(CHAT, record.continuationId);
      impl.continuations.suspend(CHAT, record.continuationId, {kind: "approval", actionIds: [7]}, false);
      impl.continuations.settle(CHAT, record.continuationId);
      impl.storage.actions.put({id: 7, gatekeeperId: GATEKEEPER, type: "action", action: 42, createdAt: new Date(),
        state: "pending", caller: {from: "agent", chatId: CHAT},
        description: {title: "Run", description: "Command", implementsRevert: false, awaitDecision: true}});
      impl.addChatMessages(CHAT, MODEL.profile, [{type: "action", actionId: 7}]);
      await impl.sendChatMessage(s.user, {profile: APPROVER}, CHAT, "No AI on this prompt");
      const action = impl.storage.actions.get(7)!;
      impl.storage.actions.put({...action, state: "approved"});
      impl.wakeAgentContinuation(CHAT, 7, APPROVER);
      await impl.resumeAfterActionDecision(CHAT, 7, APPROVER);
      expect(impl.continuations.get(CHAT)?.status).toMatchObject({phase: "finishing", reason: "abandoned"});
      expect(requests()).toBe(0);
      expect([...impl.storage.chats.list()].filter(message => message.type === "agentNudge")).toHaveLength(0);
      await impl.ctx.storage.sync();
    });
    await evictDurableObject(s.stub);
    await s.visit(async impl => {
      await impl.waitForAllAgentsToComplete();
      expect(impl.continuations.get(CHAT)?.status).toMatchObject({phase: "finished", reason: "abandoned"});
      expect(requests()).toBe(0);
    });
  });

  it.each([null, "removed-model"])("retires an old wait when a callback with model %s is consumed", async initiatorModelId => {
    const s = await recoveryScenario(), requests = inference();
    await expect(s.visit(async impl => {
      const record = impl.continuations.start({...RUN, initiatorUserId: s.user.id.toString(), modelId: MODEL.profile.id});
      impl.continuations.enter(CHAT, record.continuationId);
      impl.continuations.suspend(CHAT, record.continuationId, {kind: "approval", actionIds: [7]}, false);
      impl.continuations.settle(CHAT, record.continuationId);
      impl.storage.actions.put({id: 7, gatekeeperId: GATEKEEPER, type: "action", action: 42, createdAt: new Date(),
        state: "pending", caller: {from: "agent", chatId: CHAT},
        description: {title: "Run", description: "Command", implementsRevert: false, awaitDecision: true}});
      impl.addChatMessages(CHAT, MODEL.profile, [{type: "action", actionId: 7}]);
      impl.storage.pendingAgentCalls.put({chatId: CHAT, callId: 0, methodName: "notify", args: [], argsSummary: "",
        initiatorUserId: s.user.id.toString(), initiatorModelId});
      await impl.drainPendingAgentCalls(CHAT);
      expect([...impl.storage.chats.list()].filter(message => message.type === "agentCallback")).toHaveLength(1);
      impl.storage.actions.put({...impl.storage.actions.get(7)!, state: "approved"});
      await impl.resumeAfterActionDecision(CHAT, 7, APPROVER);
      expect(impl.continuations.get(CHAT)?.status).toMatchObject({phase: "finishing", reason: "abandoned"});
      expect(requests()).toBe(0);
      expect([...impl.storage.chats.list()].filter(message => message.type === "agentNudge")).toHaveLength(0);
      await impl.ctx.storage.sync();
      impl.ctx.abort("Injected reset after callback delivery");
    })).rejects.toThrow(/Injected reset/);
    await s.visit(async impl => {
      await impl.waitForAllAgentsToComplete();
      expect(impl.continuations.get(CHAT)?.status).toMatchObject({phase: "finished", reason: "abandoned"});
      expect(requests()).toBe(0);
    });
  });

  it("records the action receipt and wake-up together before the approving client can resume", async () => {
    const s = await recoveryScenario(), requests = inference();
    await s.visit(async impl => {
      const record = impl.continuations.start({...RUN, initiatorUserId: s.user.id.toString(), modelId: MODEL.profile.id});
      impl.continuations.enter(CHAT, record.continuationId);
      impl.continuations.suspend(CHAT, record.continuationId, {kind: "approval", actionIds: [7]}, false);
      impl.continuations.settle(CHAT, record.continuationId);
      const action = {id: 7, gatekeeperId: GATEKEEPER, type: "action" as const, action: 42, createdAt: new Date(),
        state: "pending" as const, caller: {from: "agent" as const, chatId: CHAT},
        description: {title: "Run", description: "Command", implementsRevert: false, awaitDecision: true}};
      impl.storage.actions.put(action);
      vi.spyOn(impl, "getGatekeeperFacet").mockResolvedValue({applyAction: async () => {}} as
        Awaited<ReturnType<typeof impl.getGatekeeperFacet>>);
      await impl.applyPendingAction(action, APPROVER, false);
      expect(impl.storage.actions.get(7)?.state).toBe("approved");
      expect(impl.continuations.get(CHAT)?.status).toMatchObject({phase: "paused", ready: true});
      await impl.ctx.storage.sync();
    });
    await evictDurableObject(s.stub);
    await s.visit(async impl => {
      await impl.waitForAllAgentsToComplete();
      expect(requests()).toBe(1);
      expect(impl.continuations.get(CHAT)?.status.phase).toBe("finished");
    });
  });

  it.each([
    ["approval", "running"], ["connection", "running"],
    ["approval", "suspending"], ["approval", "paused"],
    ["connection", "suspending"], ["connection", "paused"],
  ] as const)("retains a %s wait interrupted while %s, then resumes once", async (kind, boundary) => {
    const s = await recoveryScenario(), requests = inference();
    let source: number | string;
    await s.visit(async impl => {
      const record = impl.continuations.start({...RUN, initiatorUserId: s.user.id.toString(), modelId: MODEL.profile.id});
      impl.continuations.enter(CHAT, record.continuationId);
      if (kind === "approval") {
        source = 7;
        impl.storage.actions.put({id: source, gatekeeperId: GATEKEEPER, type: "action", action: 42, createdAt: new Date(),
          state: "pending", caller: {from: "agent", chatId: CHAT},
          description: {title: "Run", description: "Command", implementsRevert: false, awaitDecision: true}});
        impl.addChatMessages(CHAT, MODEL.profile, [{type: "action", actionId: source}]);
      } else {
        source = "1:connection";
        impl.addChatMessages(CHAT, MODEL.profile, [{type: "connectionRequest", requestId: source,
          vendorId: "github", vendorName: "GitHub", reason: "Repo", state: "pending"}]);
      }
      if (boundary !== "running") impl.continuations.suspend(CHAT, record.continuationId,
        kind === "approval" ? {kind, actionIds: [source as number]} : {kind, requestIds: [source as string]}, false);
      if (boundary === "paused") impl.continuations.settle(CHAT, record.continuationId);
      await impl.ctx.storage.sync();
    });
    await evictDurableObject(s.stub);
    await s.visit(async impl => {
      await impl.waitForAllAgentsToComplete();
      expect(requests()).toBe(0);
      expect(impl.continuations.get(CHAT)?.status).toMatchObject({phase: "paused", ready: false});
      if (kind === "approval") {
        const action = impl.storage.actions.get(source as number)!;
        if (action.type !== "action") throw new Error("Missing action");
        impl.storage.actions.put({...action, state: "approved"});
        await impl.resumeAfterActionDecision(CHAT, action.id, APPROVER);
      } else {
        using client = await openFakeOverseer(impl.storage, {impl: {
          resumePausedAgent: impl.resumePausedAgent.bind(impl), wakeAgentContinuation: impl.wakeAgentContinuation.bind(impl),
          getChatTimestamp: impl.getChatTimestamp.bind(impl),
        }});
        await client.acceptConnectionRequest(source as string, {gatekeeperId: GATEKEEPER});
      }
      await vi.waitFor(() => expect(impl.continuations.get(CHAT)?.status.phase).toBe("finished"));
      expect(requests()).toBe(1);
      expect(impl.storage.chatMeta.get(CHAT)?.activeAgent).toBeUndefined();
    });
  });

  it.each(["suspending", "paused"] as const)("journals an approved wake-up while %s before message-preparation I/O", async boundary => {
    const s = await recoveryScenario(), requests = inference();
    await s.visit(async impl => {
      const record = impl.continuations.start({...RUN, initiatorUserId: s.user.id.toString(), modelId: MODEL.profile.id});
      impl.continuations.enter(CHAT, record.continuationId);
      const wait = {kind: "approval" as const, actionIds: [7]};
      impl.storage.actions.put({id: 7, gatekeeperId: GATEKEEPER, type: "action", action: 42, createdAt: new Date(),
        state: "approved", caller: {from: "agent", chatId: CHAT},
        description: {title: "Run", description: "Command", implementsRevert: false, awaitDecision: true}});
      impl.continuations.suspend(CHAT, record.continuationId, wait, false);
      if (boundary === "paused") impl.continuations.settle(CHAT, record.continuationId);
      impl.waitForChatMessagePreparation = () => { throw reset(); };
      await expect(impl.resumeAfterActionDecision(CHAT, 7, APPROVER)).rejects.toThrow(/lost response/);
      expect(impl.continuations.get(CHAT)?.status).toMatchObject({ready: true});
      expect(await impl.ctx.storage.getAlarm()).not.toBeNull();
      expect(requests()).toBe(0);
      await impl.ctx.storage.sync();
    });
    await evictDurableObject(s.stub);
    await s.visit(async impl => {
      await vi.waitFor(() => expect(impl.continuations.get(CHAT)?.status.phase).toBe("finished"));
      expect(requests()).toBe(1);
      expect([...impl.storage.chats.list()].filter(message => message.type === "agentNudge")).toHaveLength(1);
      await impl.resumeAfterActionDecision(CHAT, 7, APPROVER);
      expect(requests()).toBe(1);
    });
  });

  it("adopts a pre-migration approved pause once without a parallel resume path", async () => {
    const s = await recoveryScenario(), requests = inference();
    await s.visit(async impl => {
      impl.storage.actions.put({id: 7, gatekeeperId: GATEKEEPER, type: "action", action: 42, createdAt: new Date(),
        state: "approved", caller: {from: "agent", chatId: CHAT},
        description: {title: "Legacy", description: "Command", implementsRevert: false, awaitDecision: true}});
      impl.addChatMessages(CHAT, MODEL.profile, [{type: "action", actionId: 7}]);
      await impl.resumeAfterActionDecision(CHAT, 7, APPROVER, s.user.id.toString());
      await impl.waitForAllAgentsToComplete();
      await impl.resumeAfterActionDecision(CHAT, 7, APPROVER, s.user.id.toString());
      expect(requests()).toBe(1);
      expect(impl.continuations.get(CHAT)?.status.phase).toBe("finished");
      expect([...impl.storage.chats.list()].filter(message => message.type === "agentNudge")).toHaveLength(1);
    });
  });

  it.each([false, true])("cancels recovery during model lookup with a replacement run=%s", async replacement => {
    const s = await recoveryScenario(), requests = inference();
    let release!: () => void;
    const lookup = new Promise<void>(resolve => {release = resolve;});
    let entered = false;
    const get = UserDurableObject.prototype.getChatContext;
    vi.spyOn(UserDurableObject.prototype, "getChatContext").mockImplementation(async function(id) {
      entered = true; await lookup; return get.call(this, id);
    });
    await s.visit(async impl => {
      impl.continuations.start({...RUN, initiatorUserId: s.user.id.toString(), modelId: MODEL.profile.id});
      await impl.ctx.storage.sync();
    });
    await evictDurableObject(s.stub);
    await s.visit(async impl => {
      await vi.waitFor(() => expect(entered).toBe(true));
      impl.cancelAgent(CHAT);
      if (replacement) impl.startAgent(CHAT, MODEL, APPROVER, s.user.id.toString());
      release();
      await impl.waitForAllAgentsToComplete();
      expect(impl.continuations.get(CHAT)?.status).toMatchObject({phase: "finished",
        reason: replacement ? "completed" : "canceled"});
      expect(impl.storage.chatMeta.get(CHAT)?.activeAgent).toBeUndefined();
      expect(requests()).toBe(replacement ? 1 : 0);
    });
  });

  it.each(["completed", "removed-model"] as const)("recovers %s cleanup without rerunning inference", async outcome => {
    const s = await recoveryScenario(), requests = inference();
    await s.visit(async impl => {
      const record = impl.continuations.start({...RUN, initiatorUserId: s.user.id.toString(), modelId: "missing"});
      impl.continuations.enter(CHAT, record.continuationId);
      if (outcome === "completed") impl.continuations.close(CHAT, "completed");
      await impl.ctx.storage.sync();
    });
    await evictDurableObject(s.stub);
    await s.visit(async impl => {
      await impl.waitForAllAgentsToComplete();
      expect(requests()).toBe(0);
      expect(impl.continuations.get(CHAT)?.status).toMatchObject({phase: "finished",
        reason: outcome === "completed" ? "completed" : "failed"});
    });
  });
});
