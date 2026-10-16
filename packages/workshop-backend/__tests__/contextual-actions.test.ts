import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agentIntegrationGrant } from "../src/agent-integration";
import { GatekeeperActionContextImpl } from "../src/gatekeeper-action-context";
import type { OverseerDurableObject } from "../src/overseer";
import type { TestLifecycleParticipant } from "./test-worker";
import type { ActionRecord } from "../src/storage-schema/overseer-storage";
import type { ApprovalQueue, Gatekeeper } from "@gadgets/workshop-shared/gatekeeper";

type Impl = OverseerDurableObject["impl"];
const AGENT = {type: "agent" as const, id: "model", name: "Model"};
const USER = {type: "user" as const, id: "user", name: "User"};
const grants = '{"test":{"lifecycle":true,"contextualActions":true}}';
const description = {title: "Edit", description: "Edit", implementsRevert: false};
afterEach(() => { vi.restoreAllMocks(); });

function participant(impl: Impl, name: string) {
  const exports = impl.ctx.exports as typeof impl.ctx.exports & {
    TestLifecycleParticipant(options: {props: {name: string}}): Fetcher<TestLifecycleParticipant>;
  };
  return exports.TestLifecycleParticipant({props: {name}});
}

function seed(impl: Impl) {
  impl.env.AGENT_INTEGRATION_GRANTS = grants;
  const timestamp = impl.getChatTimestamp();
  impl.storage.chatMeta.put({id: 1, title: "Lifecycle", started: timestamp, lastActive: timestamp, activeAgent: AGENT});
  impl.storage.activeAgents.put({chatId: 1, initiatorUserId: "unused", modelId: AGENT.id,
    initiator: USER, callbackInitiated: false});
  impl.storage.gatekeepers.put({id: 7, class: {} as any,
    creationSpec: {type: "ambient", vendorId: "test", accountId: 1}});
  return impl.integrations.capture(1)!;
}

async function fixture() {
  const stub = env.TEST_OVERSEER.getByName(crypto.randomUUID());
  const visit = <T>(fn: (impl: Impl) => T | Promise<T>) =>
    runInDurableObject(stub, ({impl}) => fn(impl));
  return {stub, visit};
}

async function queue(impl: Impl) {
  let approvalQueue!: ApprovalQueue;
  const facet = {startSession: async (q: ApprovalQueue) => { approvalQueue = q; return {}; }};
  await impl.openGatekeeperSession(7, facet as any, {from: "agent", chatId: 1});
  return approvalQueue;
}

describe("contextual action grants and authority", () => {
  it("grants lifecycle and contextual application independently", () => {
    expect(agentIntegrationGrant('{"test":{"lifecycle":true}}', "test"))
      .toEqual({lifecycle: true, contextualActions: false});
    expect(agentIntegrationGrant('{"test":{"contextualActions":true}}', "test"))
      .toEqual({lifecycle: false, contextualActions: true});
    expect(agentIntegrationGrant(grants, "test"))
      .toEqual({lifecycle: true, contextualActions: true});
  });

  it("expires segment contexts and never transfers action authority to another turn", async () => {
    const {visit} = await fixture();
    await visit(async impl => {
      const origin = seed(impl);
      const context = impl.integrations.context(7, origin)!;
      impl.integrations.enter(1);
      await expect(context.getTurn()).rejects.toThrow("expired");
      const action = {id: 1, gatekeeperId: 7, caller: {from: "agent", chatId: 1},
        type: "action", action: 42, state: "pending", createdAt: new Date(), description,
        integrationOrigin: origin, contextualApply: true} satisfies ActionRecord;
      const applying = new GatekeeperActionContextImpl(impl, action);
      const fresh = (await applying.getAgentContext())!;
      expect((await fresh.getTurn()).turnId).toBe(origin.turnId);
      expect((await fresh.getTurn()).segmentId).not.toBe(origin.segmentId);
      const expected = await fresh.getTurn();
      expect(await participant(impl, crypto.randomUUID()).actionTurn(applying)).toEqual(expected);
      applying[Symbol.dispose]();
      await expect(fresh.getTurn()).rejects.toThrow("expired");
      const late = new GatekeeperActionContextImpl(impl, action);
      seed(impl);
      expect(await late.getAgentContext()).toBeNull();
      impl.storage.activeAgents.delete(1);
      await impl.integrations.drain();
    });
  });

});

describe("contextual application", () => {
  it("gives real creation its original turn and waits for readiness before approval", async () => {
    const {visit} = await fixture();
    await visit(async impl => {
      const origin = seed(impl);
      impl.storage.gatekeepers.put({id: 7, class: {} as any,
        creationSpec: {type: "gatekeeper", vendorId: "test", typeUrlPattern: "container://instance/*"}});
      await impl.submitAction(7, "create", {...description, awaitDecision: true},
        {from: "agent", chatId: 1}, origin);
      const action = [...impl.storage.actions.list()][0];
      if (action.type !== "action") throw new Error("Missing creation");
      expect(action.contextualApply).toBe(true);
      expect(action.integrationOrigin).toEqual(origin);
      const receiver = participant(impl, crypto.randomUUID());
      const resume = vi.spyOn(impl, "resumeAgentAfterDecision").mockImplementation(() => {});
      const creation = vi.fn<NonNullable<Gatekeeper<any>["applyCreation"]>>(async (_creator, configuration, context) => {
        expect(configuration).toBeNull();
        expect(context).toBeDefined();
        const agent = (await context!.getAgentContext())!;
        expect(await agent.getTurn()).toMatchObject({turnId: origin.turnId, phase: "applyingAction"});
        await agent.participate(receiver);
        expect([...impl.storage.agentParticipants.list()]).toHaveLength(1);
        expect(impl.storage.actions.get(action.id)?.state).toBe("pending");
        expect(resume).not.toHaveBeenCalled();
        // Removing the pending facet models a disconnected card; its approval receipt still
        // records the created URL, without asking workerd to instantiate this test's fake class.
        impl.storage.gatekeepers.delete(7);
        return {class: {} as any, resourceUrl: "container://instance/test"};
      });
      vi.spyOn(impl, "getGatekeeperFacet").mockResolvedValue({applyCreation: creation} as any);
      await impl.applyPendingAction(action, USER, false, {creator: {} as any, configuration: null});
      expect(creation).toHaveBeenCalledTimes(1);
      expect(impl.storage.actions.get(action.id)).toMatchObject({state: "approved", resourceUrl: "container://instance/test"});
      expect(resume).toHaveBeenCalledExactlyOnceWith(1, action.id);
      impl.storage.activeAgents.delete(1);
      await impl.integrations.drain();
    });
  });

  it("fails closed when contextual creation is revoked", async () => {
    const {visit} = await fixture();
    await visit(async impl => {
      const origin = seed(impl);
      await impl.submitAction(7, "create", description, {from: "agent", chatId: 1}, origin);
      const action = [...impl.storage.actions.list()][0];
      if (action.type !== "action") throw new Error("Missing creation");
      const creation = vi.fn();
      vi.spyOn(impl, "getGatekeeperFacet").mockResolvedValue({applyCreation: creation} as any);
      impl.env.AGENT_INTEGRATION_GRANTS = undefined;
      await expect(impl.applyPendingAction(action, USER, false, {creator: {} as any, configuration: null}))
        .rejects.toThrow("revoked");
      expect(creation).not.toHaveBeenCalled();
      impl.storage.activeAgents.delete(1);
    });
  });

  it("keeps legacy creation on its two-argument protocol even when a grant is added later", async () => {
    const {visit} = await fixture();
    await visit(async impl => {
      seed(impl);
      impl.env.AGENT_INTEGRATION_GRANTS = undefined;
      await impl.submitAction(7, "create", description, {from: "agent", chatId: 1});
      const action = [...impl.storage.actions.list()][0];
      if (action.type !== "action") throw new Error("Missing creation");
      impl.env.AGENT_INTEGRATION_GRANTS = grants;
      const creator = {} as any;
      const creation = vi.fn(async () => {
        impl.storage.gatekeepers.delete(7);
        return {class: {} as any, resourceUrl: "https://example.com/created"};
      });
      vi.spyOn(impl, "getGatekeeperFacet").mockResolvedValue({applyCreation: creation} as any);
      await impl.applyPendingAction(action, USER, false, {creator, configuration: "choice"});
      expect(creation).toHaveBeenCalledExactlyOnceWith(creator, "choice");
      impl.storage.activeAgents.delete(1);
    });
  });

  it.each(["approved", "rejected", "unawaited", "later gate"] as const)("checks the current decision boundary for an %s action", async state => {
    const {visit} = await fixture();
    await visit(async impl => {
      seed(impl);
      const q = await queue(impl);
      const automatic = state === "later gate";
      if (automatic) {
        vi.spyOn(impl, "getGatekeeperFacet").mockResolvedValue({applyActionInContext: async () => {}} as any);
        impl.storage.autoApproveTags.put({gatekeeperId: 7,
          actionKind: {tag: "edit", label: "Edits"}, enabledBy: USER});
      }
      await q.submitAction(42, {...description, awaitDecision: state !== "unawaited",
        autoApprovable: automatic, actionKind: {tag: "edit", label: "Edits"}});
      const action = [...impl.storage.actions.list()][0];
      if (state === "approved" || state === "rejected") {
        impl.storage.actions.put({...action, state});
      } else if (automatic) {
        // A later manual action must not gate an earlier automatic action.
        await q.submitAction(43, description);
        await impl.drainAutoApprovals(7);
      }
      expect(impl.consumeCapturedActions(1)?.awaitDecision).toBe(state === "rejected");
      impl.storage.activeAgents.delete(1);
    });
  });

  it.each(["submission", "consumption"] as const)("suspends an awaited action when an uncertain predecessor is fenced before %s", async boundary => {
    const {visit} = await fixture();
    await visit(async impl => {
      seed(impl);
      const lookup = Promise.withResolvers<void>();
      const contextual = vi.fn(async (_action: number) => { throw new Error("ACK lost after effect"); });
      vi.spyOn(impl, "getGatekeeperFacet").mockImplementation(async () => {
        await lookup.promise;
        return {applyActionInContext: contextual} as any;
      });
      impl.storage.autoApproveTags.put({gatekeeperId: 7,
        actionKind: {tag: "edit", label: "Edits"}, enabledBy: USER});
      const automatic = {...description, autoApprovable: true, actionKind: {tag: "edit", label: "Edits"}};
      const q = await queue(impl);
      await q.submitAction(42, automatic);
      if (boundary === "submission") {
        lookup.resolve();
        await impl.drainAutoApprovals(7);
      }
      await q.submitAction(43, {...automatic, awaitDecision: true});
      lookup.resolve();
      await impl.drainAutoApprovals(7);
      expect(contextual.mock.calls.map(([action]) => action)).toEqual([42]);
      expect([...impl.storage.actions.list()].every(record => record.state === "pending")).toBe(true);
      expect(impl.consumeCapturedActions(1)?.awaitDecision).toBe(true);
      impl.storage.activeAgents.delete(1);
    });
  });

  it("fences a lost ACK against coalesced and later automatic drains, but permits explicit retry", async () => {
    const {visit} = await fixture();
    await visit(async impl => {
      seed(impl);
      const entered = Promise.withResolvers<void>(), reply = Promise.withResolvers<void>();
      const contextual = vi.fn(async (_action: number) => {
        entered.resolve();
        await reply.promise;
      });
      const legacy = vi.fn();
      vi.spyOn(impl, "getGatekeeperFacet").mockResolvedValue({applyActionInContext: contextual, applyAction: legacy} as any);
      impl.storage.autoApproveTags.put({gatekeeperId: 7,
        actionKind: {tag: "edit", label: "Edits"}, enabledBy: USER});
      const automatic = {...description, autoApprovable: true, actionKind: {tag: "edit", label: "Edits"}};
      const q = await queue(impl);
      await q.submitAction(42, automatic);
      await entered.promise;
      await q.submitAction(43, automatic);
      const drain = impl.drainAutoApprovals(7);
      reply.reject(new Error("ACK lost after effect"));
      await drain;
      await impl.drainAutoApprovals(7);
      expect(contextual.mock.calls.map(([action]) => action)).toEqual([42]);
      expect(legacy).not.toHaveBeenCalled();

      const action = [...impl.storage.actions.list()][0];
      if (action.type !== "action") throw new Error("Missing action");
      expect(action).toMatchObject({state: "pending", contextualAttempted: true});
      await expect(impl.applyPendingAction(action, USER, true)).rejects.toThrow("retry it explicitly");
      expect(contextual.mock.calls.map(([action]) => action)).toEqual([42]);
      contextual.mockResolvedValue(undefined);
      await impl.applyPendingAction(action, USER, false);
      await impl.drainAutoApprovals(7);
      expect(contextual.mock.calls.map(([action]) => action)).toEqual([42, 42, 43]);
      expect([...impl.storage.actions.list()].every(record => record.state === "approved")).toBe(true);
      impl.storage.activeAgents.delete(1);
    });
  });

  it("retains the no-automatic-retry fence across real eviction", async () => {
    const {stub, visit} = await fixture();
    const id = await visit(async impl => {
      seed(impl);
      const q = await queue(impl);
      await q.submitAction(42, {...description, autoApprovable: true,
        actionKind: {tag: "edit", label: "Edits"}});
      const action = [...impl.storage.actions.list()][0];
      if (action.type !== "action") throw new Error("Missing action");
      vi.spyOn(impl, "getGatekeeperFacet").mockResolvedValue({
        applyActionInContext: async () => { throw new Error("ACK lost after effect"); },
      } as any);
      await expect(impl.applyPendingAction(action, USER, false)).rejects.toThrow("ACK lost");
      impl.storage.activeAgents.delete(1);
      const meta = impl.storage.chatMeta.get(1)!;
      delete meta.activeAgent;
      impl.storage.chatMeta.put(meta);
      await impl.ctx.storage.sync();
      return action.id;
    });
    await evictDurableObject(stub);
    await visit(async impl => {
      impl.env.AGENT_INTEGRATION_GRANTS = grants;
      impl.storage.autoApproveTags.put({gatekeeperId: 7,
        actionKind: {tag: "edit", label: "Edits"}, enabledBy: USER});
      const contextual = vi.fn();
      vi.spyOn(impl, "getGatekeeperFacet").mockResolvedValue({applyActionInContext: contextual} as any);
      await impl.drainAutoApprovals(7);
      expect(contextual).not.toHaveBeenCalled();
      expect(impl.storage.actions.get(id)).toMatchObject({state: "pending", contextualAttempted: true});
    });
  });

  it("pins dispatch at submission and does not adopt the approver's later turn", async () => {
    const {visit} = await fixture();
    await visit(async impl => {
      const origin = seed(impl), q = await queue(impl);
      await q.submitAction(42, description);
      const action = [...impl.storage.actions.list()][0];
      if (action.type !== "action") throw new Error("Missing action");
      expect(action.contextualApply).toBe(true);
      expect(action.integrationOrigin).toEqual(origin);
      seed(impl);
      await expect(async () => q.submitAction(43, description)).rejects.toThrow("expired");
      const contextual = vi.fn<Gatekeeper<any>["applyActionInContext"]>(async (_action, context) => {
        expect(await context.getAgentContext()).toBeNull();
        expect(await context.getGitCache()).toBeDefined();
      });
      const legacy = vi.fn();
      vi.spyOn(impl, "getGatekeeperFacet").mockResolvedValue({applyActionInContext: contextual, applyAction: legacy} as any);
      await impl.applyPendingAction(action, USER, false);
      expect(contextual).toHaveBeenCalledTimes(1);
      expect(legacy).not.toHaveBeenCalled();
      expect(impl.storage.actions.get(action.id)?.state).toBe("approved");
      impl.storage.activeAgents.delete(1);
      await impl.integrations.drain();
    });
  });

  it("never falls back or auto-repeats after an uncertain effect, and fails closed on revocation", async () => {
    const {visit} = await fixture();
    await visit(async impl => {
      seed(impl);
      const q = await queue(impl);
      await q.submitAction(42, description);
      const action = [...impl.storage.actions.list()][0];
      if (action.type !== "action") throw new Error("Missing action");
      const contextual = vi.fn(async () => { throw new Error("ACK lost after effect"); }), legacy = vi.fn();
      vi.spyOn(impl, "getGatekeeperFacet").mockResolvedValue({applyActionInContext: contextual, applyAction: legacy} as any);
      await expect(impl.applyPendingAction(action, USER, false)).rejects.toThrow("ACK lost");
      await impl.integrations.deliverDue();
      expect(contextual).toHaveBeenCalledTimes(1);
      expect(legacy).not.toHaveBeenCalled();
      expect(impl.storage.actions.get(action.id)?.state).toBe("pending");
      impl.env.AGENT_INTEGRATION_GRANTS = undefined;
      await expect(impl.applyPendingAction(action, USER, false)).rejects.toThrow("revoked");
      expect(contextual).toHaveBeenCalledTimes(1);
      expect(legacy).not.toHaveBeenCalled();
      impl.storage.activeAgents.delete(1);
    });
  });

  it("leaves existing/legacy actions on legacy apply even if a grant is added later", async () => {
    const {visit} = await fixture();
    await visit(async impl => {
      seed(impl);
      impl.env.AGENT_INTEGRATION_GRANTS = undefined;
      const q = await queue(impl);
      expect(await q.getAgentContext()).toBeNull();
      await q.submitAction(42, description);
      const action = [...impl.storage.actions.list()][0];
      if (action.type !== "action") throw new Error("Missing action");
      impl.env.AGENT_INTEGRATION_GRANTS = grants;
      const contextual = vi.fn(), legacy = vi.fn();
      vi.spyOn(impl, "getGatekeeperFacet").mockResolvedValue({applyActionInContext: contextual, applyAction: legacy} as any);
      await impl.applyPendingAction(action, USER, true);
      expect(contextual).not.toHaveBeenCalled();
      expect(legacy).toHaveBeenCalledTimes(1);
      impl.storage.activeAgents.delete(1);
    });
  });
});
