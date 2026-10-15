import { env } from "cloudflare:workers";
import { evictDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openFakeOverseer } from "./fixtures";
import type { IntegrationTestActionGatekeeper } from "./test-worker";
import { APPROVER, CHAT, GATEKEEPER, MODEL, RUN, flush, origin, providerReply, recoveryScenario } from "./agent-integration-fixture";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); delete env.AGENT_INTEGRATION_GRANTS; });

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
  it.each(["contextualActions", "recoverableActions"] as const)(
    "defers interrupted action replay while %s is revoked without closing the originating turn", async revoked => {
      const s = await recoveryScenario(), requests = inference();
      let grant: ReturnType<typeof vi.spyOn> | undefined, apply: ReturnType<typeof vi.spyOn> | undefined;
      let turnId: string;
      try {
        await s.visit(async impl => {
          const record = impl.continuations.start({...RUN, initiatorUserId: s.user.id.toString(), modelId: MODEL.profile.id});
          turnId = record.turnId;
          await impl.beginAgentIntegrationTurn(CHAT, record.continuationId);
          const handler = await impl.getGatekeeperFacet(GATEKEEPER) as Fetcher<IntegrationTestActionGatekeeper>;
          await handler.setRecoverable();
          impl.storage.autoApproveTags.put({gatekeeperId: GATEKEEPER,
            actionKind: {tag: "run", label: "Run"}, enabledBy: APPROVER});
          impl.storage.actions.put({id: 7, gatekeeperId: GATEKEEPER, type: "action", action: 42, createdAt: new Date(),
            state: "pending", caller: {from: "agent", chatId: CHAT}, contextualApply: true, integrationOrigin: origin(impl),
            description: {title: "Run", description: "Command", implementsRevert: false,
              awaitDecision: true, autoApprovable: true, actionKind: {tag: "run", label: "Run"}}});
          impl.addChatMessages(CHAT, MODEL.profile, [{type: "action", actionId: 7}]);
          // The resume driver must reconcile this even before the alarm's retry deadline.
          impl.storage.actionApplications.put({id: 7, resolvedBy: APPROVER, autoApproved: true,
            phase: "apply", retryAt: Date.now() + 60_000});
          grant = vi.spyOn(Object.getPrototypeOf(impl), "integrationGrant").mockReturnValue({
            lifecycle: true, contextualActions: true, recoverableActions: true, [revoked]: false,
          });
          apply = vi.spyOn(Object.getPrototypeOf(impl), "applyPendingAction");
          await impl.ctx.storage.sync();
        });
        await evictDurableObject(s.stub);
        await expect(s.visit(async impl => {
          await vi.waitFor(() => expect(apply).toHaveBeenCalled());
          await expect(apply!.mock.results[0].value).rejects.toThrow(/revoked/);
          expect(impl.continuations.get(CHAT)).toMatchObject({turnId, status: {phase: "running"}});
          expect(impl.storage.actionApplications.get(7)).toMatchObject({phase: "apply", autoApproved: true});
          expect(requests()).toBe(0);
          grant!.mockRestore();
          await impl.ctx.storage.sync();
          impl.ctx.abort("Injected reset during deferred action replay");
        })).rejects.toThrow(/Injected reset/);
        await s.visit(async impl => {
          await impl.waitForAllAgentsToComplete();
          expect(impl.continuations.get(CHAT)).toMatchObject({turnId, status: {phase: "finished", reason: "completed"}});
          expect(impl.storage.actions.get(7)?.state).toBe("approved");
          expect(impl.storage.actionApplications.get(7)).toBeUndefined();
          const handler = await impl.getGatekeeperFacet(GATEKEEPER) as Fetcher<IntegrationTestActionGatekeeper>;
          expect(await handler.calls()).toMatchObject([{action: 42, turn: {turnId}}]);
          expect(requests()).toBe(1);
        });
      } finally { grant?.mockRestore(); apply?.mockRestore(); }
    });

  it("recovers other step approvals committed after a late child started suspension", async () => {
    const s = await recoveryScenario(), requests = inference();
    await s.visit(async impl => {
      const record = impl.continuations.start({...RUN, initiatorUserId: s.user.id.toString(), modelId: MODEL.profile.id});
      await impl.beginAgentIntegrationTurn(CHAT, record.continuationId);
      for (const id of [7, 8, 9]) impl.storage.actions.put({
        id, gatekeeperId: GATEKEEPER, type: "action", action: id, createdAt: new Date(),
        state: id === 7 ? "approved" : "pending", caller: {from: "agent", chatId: CHAT},
        description: {title: "Run", description: "Command", implementsRevert: false, awaitDecision: true},
      });
      impl.addChatMessages(CHAT, MODEL.profile, [{type: "action", actionId: 7}, {type: "action", actionId: 8}]);
      impl.continuations.suspend(CHAT, record.continuationId, {kind: "approval", actionIds: [7, 8]}, false);
      // Another awaited tool result committed at the step barrier; its finalizer has not run.
      impl.addChatMessages(CHAT, MODEL.profile, [{type: "action", actionId: 9}]);
      await impl.ctx.storage.sync();
    });
    await evictDurableObject(s.stub);
    await s.visit(async impl => {
      await impl.waitForAllAgentsToComplete();
      expect(impl.continuations.get(CHAT)?.status).toMatchObject({
        phase: "paused", ready: false, wait: {kind: "approval", actionIds: [7, 8, 9]},
      });
      const child = impl.storage.actions.get(8)!;
      impl.storage.actions.put({...child, state: "approved"});
      await impl.resumeAfterActionDecision(CHAT, 8, APPROVER);
      expect(impl.continuations.get(CHAT)?.status).toMatchObject({phase: "paused", ready: false});
      expect(requests()).toBe(0);
    });
  });

  it.each([false, true])("pauses a running parent's late manual follow-up with another awaited action=%s", async anotherWait => {
    const s = await recoveryScenario();
    await s.visit(async impl => {
      const handler = await impl.getGatekeeperFacet(GATEKEEPER) as Fetcher<IntegrationTestActionGatekeeper>;
      await handler.setRecoverable();
      await handler.setFollowup({title: "Network", description: "Exact destination", implementsRevert: false,
        awaitDecision: true, autoApprovable: false});
      impl.storage.autoApproveTags.put({gatekeeperId: GATEKEEPER,
        actionKind: {tag: "run", label: "Run"}, enabledBy: APPROVER});
      let release!: () => void, entered = false;
      const dispatch = new Promise<void>(resolve => { release = resolve; });
      impl.getGatekeeperFacet = async () => new Proxy(handler, {get(target, key) {
        if (key === "applyActionInContext") return async (...args: Parameters<typeof target.applyActionInContext>) => {
          if (args[0] === 42) { entered = true; await dispatch; }
          return target.applyActionInContext(...args);
        };
        return Reflect.get(target, key);
      }});
      const requests = inference(async () => {
        if (requests() !== 1) return;
        await impl.submitAction(GATEKEEPER, 42, {title: "Run", description: "Command", implementsRevert: false,
          awaitDecision: true, autoApprovable: true, actionKind: {tag: "run", label: "Run"}},
          {from: "agent", chatId: CHAT}, origin(impl));
        await vi.waitFor(() => expect(entered).toBe(true));
        // The tool step already continued without pausing and committed the parent's card.
        const captured = impl.consumeCapturedActions(CHAT)!;
        expect(captured.awaitDecision).toBe(false);
        impl.addChatMessages(CHAT, MODEL.profile, captured.actions.map(actionId => ({type: "action", actionId})));
        if (anotherWait) await impl.submitAction(GATEKEEPER, 44,
          {title: "Other", description: "Another manual action", implementsRevert: false, awaitDecision: true},
          {from: "agent", chatId: CHAT}, origin(impl));
        release();
        await impl.drainAutoApprovals(GATEKEEPER);
      });
      try {
        impl.startAgent(CHAT, MODEL, APPROVER, s.user.id.toString());
        const turnId = impl.continuations.get(CHAT)!.turnId;
        await impl.waitForAllAgentsToComplete();
        const records = [...impl.storage.actions.list()].filter(record => record.type === "action");
        expect(records).toHaveLength(anotherWait ? 3 : 2);
        expect(impl.continuations.get(CHAT)).toMatchObject({turnId,
          status: {phase: "paused", ready: false,
            wait: {kind: "approval", actionIds: expect.arrayContaining(records.map(record => record.id))}}});
        expect(requests()).toBe(1);
        expect([...impl.storage.chats.list()].filter(message => message.type === "action")).toHaveLength(records.length);
        await impl.applyPendingAction(records.find(record => record.action === 43)!, APPROVER, false);
        if (anotherWait) {
          expect(impl.continuations.get(CHAT)?.status).toMatchObject({phase: "paused", ready: false});
          expect(requests()).toBe(1);
          await impl.applyPendingAction(records.find(record => record.action === 44)!, APPROVER, false);
        }
        await impl.waitForAllAgentsToComplete();
        await vi.waitFor(() => expect(impl.continuations.get(CHAT)?.status.phase).toBe("finished"));
        expect(requests()).toBe(2);
        expect(impl.continuations.get(CHAT)?.turnId).toBe(turnId);
        expect((await handler.calls()).map(call => ({action: call.action, turnId: call.turn?.turnId})))
          .toEqual([42, 43, ...(anotherWait ? [44] : [])].map(action => ({action, turnId})));
      } finally { release(); }
    });
  });

  it("retains approval during actual suspension cleanup and never wakes the next undecided segment", async () => {
    const s = await recoveryScenario();
    await s.visit(async (impl, participant) => {
      let issued = 0;
      const requests = inference(async () => {
        if (++issued === 1) await impl.registerIntegrationParticipant(GATEKEEPER, origin(impl), "running", participant);
        if (issued <= 2) await impl.submitAction(GATEKEEPER, 41 + issued,
          {title: "Run", description: "Command", implementsRevert: false, awaitDecision: true},
          {from: "agent", chatId: CHAT}, origin(impl));
      });
      await participant.block("suspended");
      impl.startAgent(CHAT, MODEL, APPROVER, s.user.id.toString());
      try {
        await vi.waitFor(() => expect(impl.continuations.get(CHAT)?.status.phase).toBe("suspending"));
        const action = [...impl.storage.actions.list()][0];
        if (action.type !== "action") throw new Error("Missing action");
        await impl.applyPendingAction(action, APPROVER, false);
        await impl.resumeAfterActionDecision(CHAT, action.id, APPROVER);
        expect(impl.continuations.get(CHAT)?.status).toMatchObject({ready: true});
        await participant.releaseBlock();
        await vi.waitFor(() => {
          expect(requests()).toBe(2);
          expect(impl.continuations.get(CHAT)?.status).toMatchObject({phase: "paused", ready: false});
        });
        await impl.resumeAfterActionDecision(CHAT, action.id, APPROVER);
        expect(requests()).toBe(2);
        impl.cancelAgent(CHAT);
        await impl.waitForAllAgentsToComplete();
      } finally { await participant.releaseBlock(); }
    });
  });

  it("does not carry an auto-approved running action's completion into a later manual pause", async () => {
    const s = await recoveryScenario();
    await s.visit(async impl => {
      const record = impl.continuations.start(RUN);
      await impl.beginAgentIntegrationTurn(CHAT, record.continuationId);
      impl.storage.chatMeta.put({...impl.storage.chatMeta.get(CHAT)!, activeAgent: MODEL.profile});
      impl.storage.autoApproveTags.put({gatekeeperId: GATEKEEPER, actionKind: {tag: "run", label: "Run"}, enabledBy: APPROVER});
      await impl.submitAction(GATEKEEPER, 42, {title: "Auto", description: "Automatic", implementsRevert: false,
        awaitDecision: true, autoApprovable: true, actionKind: {tag: "run", label: "Run"}},
        {from: "agent", chatId: CHAT}, origin(impl));
      const first = [...impl.storage.actions.list()][0];
      impl.addChatMessages(CHAT, MODEL.profile, [{type: "action", actionId: first.id}]);
      await impl.drainAutoApprovals(GATEKEEPER);
      expect(impl.storage.actions.get(first.id)?.state).toBe("approved");
      await impl.submitAction(GATEKEEPER, 43, {title: "Manual", description: "Manual", implementsRevert: false, awaitDecision: true},
        {from: "agent", chatId: CHAT}, origin(impl));
      const second = [...impl.storage.actions.list()][1];
      impl.addChatMessages(CHAT, MODEL.profile, [{type: "action", actionId: second.id}]);
      await impl.closeAgentIntegrationTurn(CHAT, "approval");
      impl.continuations.settle(CHAT, record.continuationId);
      await impl.resumeAfterActionDecision(CHAT, first.id, APPROVER);
      expect(impl.continuations.get(CHAT)?.status).toMatchObject({phase: "paused", ready: false});
      expect([...impl.storage.chats.list()].filter(message => message.type === "agentNudge")).toEqual([]);
    });
  });

  it("terminates a deleted paused chat even when cleanup outlives its live context", async () => {
    const s = await recoveryScenario(), requests = inference();
    await s.visit(async (impl, participant) => {
      const record = impl.continuations.start(RUN);
      await impl.beginAgentIntegrationTurn(CHAT, record.continuationId);
      await impl.registerIntegrationParticipant(GATEKEEPER, origin(impl), "running", participant);
      impl.continuations.suspend(CHAT, record.continuationId, {kind: "approval", actionIds: [7]}, false);
      await flush(impl);
      impl.continuations.settle(CHAT, record.continuationId);
      await participant.block("finished");
      using client = await openFakeOverseer(impl.storage, {impl: {
        cancelAgent: impl.cancelAgent.bind(impl), destroyLiveChat: impl.destroyLiveChat.bind(impl),
        removeChatWorkpieces: impl.removeChatWorkpieces.bind(impl), deleteAllChatChanges: impl.deleteAllChatChanges.bind(impl),
        logger: impl.logger, ctx: impl.ctx,
      }});
      try {
        await client.deleteChat(CHAT);
        expect(impl.storage.chatMeta.get(CHAT)).toBeUndefined();
        await participant.releaseBlock();
        await impl.waitForAllAgentsToComplete();
        expect(impl.continuations.get(CHAT)?.status).toMatchObject({phase: "finished", event: {reason: "canceled"}});
        expect([...impl.storage.agentIntegrationParticipants.list()]).toEqual([]);
        await impl.resumeAfterActionDecision(CHAT, 7, APPROVER);
        expect(requests()).toBe(0);
      } finally { await participant.releaseBlock(); }
    });
  });

  it("retries predecessor cleanup after a reset before a new prompt can run", async () => {
    const s = await recoveryScenario(), requests = inference();
    await expect(s.visit(async (impl, participant) => {
      const first = impl.continuations.start(RUN);
      await impl.beginAgentIntegrationTurn(CHAT, first.continuationId);
      await impl.registerIntegrationParticipant(GATEKEEPER, origin(impl), "running", participant);
      await participant.setFailure(true);
      impl.startAgent(CHAT, MODEL, APPROVER, s.user.id.toString());
      await vi.waitFor(async () => expect((await participant.calls()).at(-1)?.event.kind).toBe("finished"));
      expect(impl.continuations.get(CHAT)?.status.phase).toBe("starting");
      expect(requests()).toBe(0);
      await participant.setFailure(false);
      await impl.ctx.storage.sync();
      // Graceful eviction waits for the live retry timer. Reset while that timer is outstanding.
      impl.ctx.abort("Injected reset during startup backpressure");
    })).rejects.toThrow(/Injected reset/);
    await s.visit(async (impl, participant) => {
      await participant.setFailure(false);
      await flush(impl);
      await impl.waitForAllAgentsToComplete();
      expect(requests()).toBe(1);
      expect(impl.continuations.get(CHAT)?.status.phase).toBe("finished");
      const retries = (await participant.calls()).filter(call => call.event.kind === "finished");
      expect(new Set(retries.map(call => call.event.eventId)).size).toBe(1);
      expect(retries.every(call => call.turn.phase === "finishing")).toBe(true);
    });
  });

  it.each(["completed", "removed-model"] as const)("recovers %s cleanup without rerunning inference", async outcome => {
    const s = await recoveryScenario(), requests = inference();
    await s.visit(async (impl, participant) => {
      const record = impl.continuations.start({...RUN, initiatorUserId: s.user.id.toString(), modelId: "missing"});
      await impl.beginAgentIntegrationTurn(CHAT, record.continuationId);
      await impl.registerIntegrationParticipant(GATEKEEPER, origin(impl), "running", participant);
      if (outcome === "completed") impl.continuations.close(CHAT, "completed");
      else await participant.setFailure(true);
      await impl.ctx.storage.sync();
    });
    await evictDurableObject(s.stub);
    await s.visit(async (impl, participant) => {
      await impl.waitForAllAgentsToComplete();
      expect(requests()).toBe(0);
      expect(impl.continuations.get(CHAT)?.status).toMatchObject({phase: "finished",
        event: {reason: outcome === "completed" ? "completed" : "failed"}});
      if (outcome === "removed-model") {
        const pending = [...impl.storage.agentIntegrationParticipants.list()][0];
        expect(pending.retryAt).toBeTypeOf("number");
        await participant.setFailure(false);
        await flush(impl);
      }
      expect([...impl.storage.agentIntegrationParticipants.list()]).toEqual([]);
    });
  });
});
