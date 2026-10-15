import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import type { OverseerDurableObject } from "../src/overseer";
import type { ActionRecord } from "../src/storage-schema/overseer-storage";
import type { IntegrationTestActionGatekeeper } from "./test-worker";
import { openFakeOverseer } from "./fixtures";

declare module "cloudflare:workers" {
  interface ProvidedEnv { TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>; }
}
import { APPROVER, GRANT, RUN, inKernel, origin, pause, resume, seedContinuation, start, type Impl, type TestExports } from "./agent-integration-fixture";
function facet(impl: Impl) {
  const handler = impl.ctx.facets.get<IntegrationTestActionGatekeeper>("gatekeeper31", () => ({
    class: (impl.ctx.exports as TestExports).IntegrationTestActionGatekeeper({ props: {} }),
  }));
  impl.getGatekeeperFacet = async () => handler;
  return handler;
}
function action(impl: Impl): ActionRecord & { type: "action" } {
  const record = [...impl.storage.actions.list()][0];
  if (record?.type !== "action") throw new Error("Missing fixture action");
  return record;
}
async function prepare(impl: Impl, recoverable = true, awaited = false) {
  seedContinuation(impl, crypto.randomUUID());
  impl.env.AGENT_INTEGRATION_GRANTS = recoverable ? GRANT : '{"container":{"contextualActions":true}}';
  const handler = facet(impl);
  await handler.setRecoverable();
  await start(impl);
  await impl.submitAction(31, 42, { title: "Run", description: "Run command", implementsRevert: false, awaitDecision: awaited },
    { from: "agent", chatId: 1 }, impl.captureIntegrationOrigin({ from: "agent", chatId: 1 }));
  impl.addChatMessages(1, {type: "agent", id: "fixture", name: "Fixture"}, [{type: "action", actionId: action(impl).id}]);
  await impl.closeAgentIntegrationTurn(1, "approval");
  impl.continuations.settle(1, impl.continuations.get(1)!.continuationId);
  return handler;
}
const reset = () => Object.assign(new Error("Injected lost reply"), { durableObjectReset: true });

describe("durable approved-action recovery", () => {
  it.each(["contextualActions", "recoverableActions"] as const)(
    "preserves a lost effect receipt while %s is revoked, then reconciles without repeating the effect", revoked => inKernel(async impl => {
      const handler = await prepare(impl);
      impl.getGatekeeperFacet = async () => new Proxy(handler, {get(target, key) {
        if (key === "applyActionInContext") return async (...args: Parameters<typeof target.applyActionInContext>) => {
          await target.applyActionInContext(...args);
          throw reset();
        };
        return Reflect.get(target, key);
      }});
      await expect(impl.applyPendingAction(action(impl), APPROVER, false)).rejects.toThrow("lost reply");
      expect(await handler.calls()).toHaveLength(1);
      facet(impl);
      impl.env.AGENT_INTEGRATION_GRANTS = JSON.stringify({container: {
        lifecycle: true, contextualActions: true, recoverableActions: true, [revoked]: false,
      }});
      const application = impl.storage.actionApplications.get(action(impl).id)!;
      impl.storage.actionApplications.put({...application, retryAt: Date.now()});
      await impl.recoverActionApplications();
      expect(impl.storage.actionApplications.get(application.id)).toMatchObject({
        phase: "apply", resolvedBy: APPROVER, autoApproved: false,
      });
      expect(impl.storage.actionApplications.get(application.id)!.retryAt).toBeGreaterThan(Date.now() + 25_000);
      expect(action(impl).state).toBe("pending");
      expect(await handler.calls()).toHaveLength(1);
      using client = await openFakeOverseer(impl.storage, {impl: {
        getGatekeeperFacet: impl.getGatekeeperFacet.bind(impl),
      }});
      await expect(client.rejectAction(application.id)).rejects.toThrow(/execution receipt/);
      impl.env.AGENT_INTEGRATION_GRANTS = GRANT;
      // Another failed reconciliation is still not evidence that the original effect failed.
      impl.getGatekeeperFacet = async () => { throw new Error("Receiver unavailable"); };
      impl.storage.actionApplications.put({...application, retryAt: Date.now()});
      await impl.recoverActionApplications();
      expect(impl.storage.actionApplications.get(application.id)).toMatchObject({phase: "apply"});
      facet(impl);
      impl.storage.actionApplications.put({...application, retryAt: Date.now()});
      await impl.recoverActionApplications();
      expect(action(impl)).toMatchObject({state: "approved", resolvedBy: APPROVER, autoApproved: false});
      expect(await handler.calls()).toHaveLength(1);
      expect(impl.storage.actionApplications.get(application.id)).toBeUndefined();
    }));

  it("refreshes a delayed action's context within its original turn, not its old segment", () => inKernel(async impl => {
    const first = await start(impl);
    await impl.submitAction(31, 42, {title: "Run", description: "Command", implementsRevert: false},
      {from: "agent", chatId: 1}, first);
    const old = impl.getIntegrationContext(31, first)!;
    await pause(impl);
    const next = await resume(impl);
    await expect(old.getTurn()).rejects.toThrow(/expired/);
    await impl.applyPendingAction(action(impl), APPROVER, false);
    const handler = await impl.getGatekeeperFacet(31) as Fetcher<IntegrationTestActionGatekeeper>;
    expect((await handler.calls())[0].turn).toMatchObject({turnId: first.turnId, segmentId: next.segmentId, phase: "applyingAction"});
    expect(action(impl).integrationOrigin).toEqual(first);
  }));

  it("never falls back to legacy dispatch after a contextual failure", () => inKernel(async impl => {
    await start(impl);
    await impl.submitAction(31, 42, {title: "Run", description: "Command", implementsRevert: false},
      {from: "agent", chatId: 1}, origin(impl));
    const handler = await impl.getGatekeeperFacet(31) as Fetcher<IntegrationTestActionGatekeeper>;
    await handler.setFailure(true);
    await expect(impl.applyPendingAction(action(impl), APPROVER, false)).rejects.toThrow(/handler failed/);
    expect((await handler.calls()).map(call => call.handler)).toEqual(["contextual"]);
    expect(action(impl).state).toBe("pending");
  }));

  it("retains legacy queue-time dispatch when permissions are granted later", () => inKernel(async impl => {
    impl.env.AGENT_INTEGRATION_GRANTS = '{}';
    await impl.submitAction(31, 42, {title: "Run", description: "Command", implementsRevert: false}, {from: "agent", chatId: 1});
    impl.env.AGENT_INTEGRATION_GRANTS = GRANT;
    await impl.applyPendingAction(action(impl), APPROVER, true);
    const handler = await impl.getGatekeeperFacet(31) as Fetcher<IntegrationTestActionGatekeeper>;
    expect(await handler.calls()).toEqual([{action: 42, handler: "legacy"}]);
  }));

  it.each([false, true])("auto-approves an awaited follow-up while its auto-approved=%s parent is still applying", async autoParent => {
    await runInDurableObject(env.TEST_OVERSEER.getByName(crypto.randomUUID()), async instance => {
      const impl = instance.impl, handler = await prepare(impl, true, true);
      let release!: () => void;
      const childApplied = new Promise<void>(resolve => { release = resolve; });
      let childStarted = false;
      try {
        // This test owns the approval/effect barrier, not model inference after the decision.
        impl.resumePausedAgent = async () => {};
        impl.storage.autoApproveTags.put({gatekeeperId: 31, actionKind: {tag: "network", label: "Network"}, enabledBy: APPROVER});
        await handler.setFollowup({title: "Allow network", description: "Exact destination", implementsRevert: false,
          autoApprovable: true, actionKind: {tag: "network", label: "Network"}, awaitDecision: true});
        impl.getGatekeeperFacet = async () => new Proxy(handler, {get(target, key) {
          if (key === "applyActionInContext") return async (...args: Parameters<typeof target.applyActionInContext>) => {
            await target.applyActionInContext(...args);
            if (args[0] === 42) await childApplied;
            else {
              expect(action(impl).state).toBe("pending");
              childStarted = true;
              release();
            }
          };
          return Reflect.get(target, key);
        }});
        const parent = action(impl);
        if (autoParent) {
          impl.storage.autoApproveTags.put({gatekeeperId: 31, actionKind: {tag: "run", label: "Run"}, enabledBy: APPROVER});
          impl.storage.actions.put({...parent, description: {...parent.description, autoApprovable: true,
            actionKind: {tag: "run", label: "Run"}}});
        }
        const applying = autoParent ? impl.drainAutoApprovals(31) : impl.applyPendingAction(parent, APPROVER, false);
        try { await vi.waitFor(() => expect(childStarted).toBe(true), {timeout: 500}); }
        finally { release(); await applying; }
        expect((await handler.calls()).map(call => call.action)).toEqual([42, 43]);
        expect([...impl.storage.actions.list()].filter(record => record.type === "action").map(record => record.state))
          .toEqual(["approved", "approved"]);
      } finally { release(); delete impl.env.AGENT_INTEGRATION_GRANTS; }
    });
  });

  it("rechecks recovery permission during active-agent restoration even before retryAt", async () => {
    const stub = env.TEST_OVERSEER.getByName(crypto.randomUUID());
    let grantSpy: ReturnType<typeof vi.spyOn> | undefined;
    try {
      await runInDurableObject(stub, async instance => {
        const impl = instance.impl;
        await prepare(impl);
        const parent = action(impl);
        impl.storage.gatekeepers.put({...impl.storage.gatekeepers.get(31)!,
          class: (impl.ctx.exports as TestExports).IntegrationTestActionGatekeeper({props: {}})});
        impl.storage.actionApplications.put({id: parent.id, resolvedBy: APPROVER, autoApproved: false,
          phase: "apply", retryAt: Date.now() + 60_000});
        const continuation = impl.continuations.get(1)!;
        impl.storage.agentContinuations.put({...continuation, initiatorUserId: "invalid-do-id", modelId: "missing",
          status: {phase: "running"}});
        grantSpy = vi.spyOn(Object.getPrototypeOf(impl), "integrationGrant").mockReturnValue({
          lifecycle: true, contextualActions: true, recoverableActions: false,
        });
        await impl.ctx.storage.sync();
      });
      await evictDurableObject(stub);
      await runInDurableObject(stub, async instance => {
        const impl = instance.impl;
        await impl.waitForAllAgentsToComplete();
        const handler = await impl.getGatekeeperFacet(31) as Fetcher<IntegrationTestActionGatekeeper>;
        expect(await handler.calls()).toEqual([]);
        expect(action(impl).state).toBe("pending");
        expect([...impl.storage.actionApplications.list()]).toMatchObject([{phase: "apply"}]);
      });
    } finally { grantSpy?.mockRestore(); delete env.AGENT_INTEGRATION_GRANTS; }
  });

  it("publishes an in-flight follow-up through the real context, with durable deduplication and original scope", async () => {
    await runInDurableObject(env.TEST_OVERSEER.getByName(crypto.randomUUID()), async instance => {
      const impl = instance.impl, handler = await prepare(impl, true, true);
      try {
        await handler.setFollowup({title: "Allow network", description: "Exact destination", implementsRevert: false,
          autoApprovable: false, awaitDecision: true});
        await impl.applyPendingAction(action(impl), APPROVER, false);
        const records = [...impl.storage.actions.list()].filter(record => record.type === "action");
        expect(records).toHaveLength(2);
        expect(records[0]).toMatchObject({state: "approved", followupActionIds: [records[1]!.id]});
        expect(records[1]).toMatchObject({state: "pending", gatekeeperId: 31, action: 43,
          caller: {from: "agent", chatId: 1}, integrationOrigin: records[0]!.integrationOrigin,
          description: {autoApprovable: false, awaitDecision: true}});
        expect([...impl.storage.chats.list()].filter(message => message.type === "action" &&
          message.actionId === records[1]!.id)).toHaveLength(1);
        await expect(impl.submitAction(31, 44, {title: "Late", description: "Late", implementsRevert: false},
          {from: "agent", chatId: 1}, records[0]!.integrationOrigin, records[0]!.id)).rejects.toThrow(/originating action/);
      } finally { delete impl.env.AGENT_INTEGRATION_GRANTS; }
    });
  });

  it.each(["different-description", "revoked", "new-turn", "closed-turn", "no-approved-intent"])(
    "refuses follow-up submission with %s", async edge => {
      await runInDurableObject(env.TEST_OVERSEER.getByName(crypto.randomUUID()), async instance => {
        const impl = instance.impl;
        await prepare(impl, true, true);
        try {
          const parent = action(impl);
          impl.storage.actionApplications.put({id: parent.id, phase: "apply", resolvedBy: APPROVER,
            autoApproved: false, retryAt: Date.now() + 60_000});
          const description = {title: "Network", description: "Public HTTPS", implementsRevert: false,
            autoApprovable: false, awaitDecision: true};
          const submit = (desc = description) => impl.submitAction(31, 43, desc,
            {from: "agent", chatId: 1}, parent.integrationOrigin, parent.id);
          await submit();
          if (edge === "revoked") impl.env.AGENT_INTEGRATION_GRANTS = '{}';
          else if (edge === "new-turn") impl.continuations.start(RUN);
          else if (edge === "closed-turn") impl.continuations.close(1, "completed");
          else if (edge === "no-approved-intent") impl.storage.actionApplications.delete(parent.id);
          await expect(submit(edge === "different-description" ? {...description, description: "Changed"} : description))
            .rejects.toThrow();
          expect([...impl.storage.actions.list()]).toHaveLength(2);
        } finally { delete impl.env.AGENT_INTEGRATION_GRANTS; }
      });
    });

  it("deduplicates a committed follow-up after real kernel eviction, even if the child was approved", async () => {
    const stub = env.TEST_OVERSEER.getByName(crypto.randomUUID());
    const description = {title: "Network", description: "Public HTTPS", implementsRevert: false,
      autoApprovable: false, awaitDecision: true};
    await runInDurableObject(stub, async instance => {
      const impl = instance.impl;
      await prepare(impl, true, true);
      const parent = action(impl);
      impl.storage.actionApplications.put({id: parent.id, phase: "apply", resolvedBy: APPROVER,
        autoApproved: false, retryAt: Date.now() + 60_000});
      await impl.submitAction(31, 43, description, parent.caller, parent.integrationOrigin, parent.id);
      const child = impl.storage.actions.get(action(impl).followupActionIds![0]!);
      if (child?.type !== "action") throw new Error("Missing follow-up");
      impl.storage.actions.put({...child, state: "approved"});
      await impl.ctx.storage.sync();
    });
    await evictDurableObject(stub);
    await runInDurableObject(stub, async instance => {
      const impl = instance.impl;
      impl.env.AGENT_INTEGRATION_GRANTS = GRANT;
      try {
        const parent = action(impl);
        await impl.submitAction(31, 43, description, parent.caller, parent.integrationOrigin, parent.id);
        expect([...impl.storage.actions.list()]).toHaveLength(2);
        expect([...impl.storage.chats.list()].filter(message => message.type === "action")).toHaveLength(2);
        let resumed = 0;
        impl.resumePausedAgent = async () => { ++resumed; };
        await impl.resumeAfterActionDecision(1, parent.followupActionIds![0]!, APPROVER);
        // The shell's pending parent still blocks inference; a destination grant isn't completion.
        expect(resumed).toBe(0);
      } finally { delete impl.env.AGENT_INTEGRATION_GRANTS; }
    });
  });

  it("survives real Overseer eviction after the effect but before its acknowledgement", async () => {
    const stub = env.TEST_OVERSEER.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async instance => {
      const impl = instance.impl, handler = await prepare(impl);
      impl.getGatekeeperFacet = async () => new Proxy(handler, { get(target, key) {
        if (key === "applyActionInContext") return async (...args: Parameters<typeof target.applyActionInContext>) => {
          // Intent was persisted before crossing into a real, persistent native facet.
          expect([...impl.storage.actionApplications.list()]).toHaveLength(1);
          await target.applyActionInContext(...args);
          throw reset();
        };
        return Reflect.get(target, key);
      }});
      await expect(impl.applyPendingAction(action(impl), APPROVER, true)).rejects.toThrow("lost reply");
      expect(await handler.calls()).toHaveLength(1);
      const application = [...impl.storage.actionApplications.list()][0];
      expect(application).toMatchObject({ phase: "apply", resolvedBy: APPROVER, autoApproved: true });
      // Keep constructor recovery out of the fixture's grant/facet installation window.
      impl.storage.actionApplications.put({ ...application, retryAt: Date.now() + 60_000 });
      await impl.ctx.storage.sync();
    });
    await evictDurableObject(stub);
    await runInDurableObject(stub, async instance => {
      const impl = instance.impl;
      impl.env.AGENT_INTEGRATION_GRANTS = GRANT;
      const handler = facet(impl);
      const applications = [...impl.storage.actionApplications.list()];
      for (const application of applications)
        impl.storage.actionApplications.put({ ...application, retryAt: Date.now() });
      await impl.recoverActionApplications();
      expect(action(impl)).toMatchObject({ state: "approved", resolvedBy: APPROVER, autoApproved: true });
      expect(await handler.calls()).toHaveLength(1); // Receipt, not a second effect.
      expect([...impl.storage.actionApplications.list()]).toEqual([]);
      delete impl.env.AGENT_INTEGRATION_GRANTS;
    });
  });

  it("deduplicates concurrent manual and auto approval in the same incarnation", async () => {
    await runInDurableObject(env.TEST_OVERSEER.getByName(crypto.randomUUID()), async instance => {
      const impl = instance.impl, handler = await prepare(impl);
      try {
        await Promise.all([impl.applyPendingAction(action(impl), APPROVER, false),
          impl.applyPendingAction(action(impl), { ...APPROVER, id: "other" }, true)]);
        expect(await handler.calls()).toHaveLength(1);
        expect(action(impl)).toMatchObject({ resolvedBy: APPROVER, autoApproved: false });
      } finally { delete impl.env.AGENT_INTEGRATION_GRANTS; }
    });
  });


  it.each(["revoked", "legacy"])("never redelivers an effect with %s authority", async mode => {
    await runInDurableObject(env.TEST_OVERSEER.getByName(crypto.randomUUID()), async instance => {
      const impl = instance.impl, handler = await prepare(impl, mode !== "legacy");
      try {
        impl.getGatekeeperFacet = async () => new Proxy(handler, { get(target, key) {
          if (key === "applyActionInContext") return async () => { throw reset(); };
          return Reflect.get(target, key);
        }});
        await expect(impl.applyPendingAction(action(impl), APPROVER, false)).rejects.toThrow("lost reply");
        facet(impl);
        impl.env.AGENT_INTEGRATION_GRANTS = '{}';
        const applications = [...impl.storage.actionApplications.list()];
        for (const application of applications)
          impl.storage.actionApplications.put({ ...application, retryAt: Date.now() });
        await impl.recoverActionApplications();
        expect(action(impl).state).toBe("pending");
        expect(await handler.calls()).toEqual([]);
        expect([...impl.storage.actionApplications.list()]).toEqual(mode === "legacy" ? [] :
          [expect.objectContaining({phase: "apply"})]);
      } finally { delete impl.env.AGENT_INTEGRATION_GRANTS; }
    });
  });

});
