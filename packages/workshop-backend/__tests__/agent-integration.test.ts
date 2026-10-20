import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agentIntegrationGrant } from "../src/agent-integration";
import type { OverseerDurableObject } from "../src/overseer";
import { lifecycleExports } from "./lifecycle-fixtures";
import { openFakeOverseer } from "./fixtures";

type Impl = OverseerDurableObject["impl"];
const AGENT = {type: "agent" as const, id: "model", name: "Model"};
const USER = {type: "user" as const, id: "user", name: "User"};
const grants = '{"test":{"lifecycle":true}}';
const originalGrants = env.AGENT_INTEGRATION_GRANTS;
afterEach(() => { vi.restoreAllMocks(); env.AGENT_INTEGRATION_GRANTS = originalGrants; });

function participant(impl: Impl, name: string) {
  return lifecycleExports(impl).TestLifecycleParticipant({props: {name}});
}

function seed(impl: Impl) {
  impl.env.AGENT_INTEGRATION_GRANTS = grants;
  const timestamp = impl.getChatTimestamp();
  impl.storage.chatMeta.put({id: 1, title: "Lifecycle", started: timestamp, lastActive: timestamp, activeAgent: AGENT});
  impl.storage.activeAgents.put({chatId: 1, initiatorUserId: "unused", modelId: AGENT.id,
    initiator: USER, callbackInitiated: false});
  impl.storage.gatekeepers.put({id: 7, class: lifecycleExports(impl).TestLifecycleGatekeeper({props: {}}),
    creationSpec: {type: "ambient", vendorId: "test", accountId: 1}});
  return impl.integrations.capture(1)!;
}

async function fixture() {
  const stub = env.TEST_OVERSEER.getByName(crypto.randomUUID());
  const visit = <T>(fn: (impl: Impl) => T | Promise<T>) =>
    runInDurableObject(env.TEST_OVERSEER.get(stub.id), ({impl}) => fn(impl));
  return {stub, visit};
}

async function deletionClient(impl: Impl) {
  return openFakeOverseer(impl.storage, {impl: {
    ctx: impl.ctx, logger: impl.logger, integrations: impl.integrations,
    closeAgentsForDeletion: impl.closeAgentsForDeletion.bind(impl),
    users: {idFromString: (id: string) => id,
      get: () => ({deleteGadget: async () => { throw new Error("Owner deletion failed"); }})},
  }});
}

describe("trusted integration grants", () => {
  it("is exact, independent of ambience, and fails closed on malformed/unknown grants", () => {
    expect(agentIntegrationGrant(grants, "test")).toEqual({lifecycle: true});
    expect(agentIntegrationGrant(grants, "TEST")).toEqual({});
    for (const config of [undefined, "invalid", "null", "[]", '{"test":true}',
      '{"test":{"lifecycle":"true"}}', '{"test":{"recoverableActions":true}}']) {
      expect(agentIntegrationGrant(config, "test")).toEqual({});
    }
  });
});

describe("lifecycle outbox", () => {
  it("scopes a real facet/session capability to its original agent segment", async () => {
    const {visit} = await fixture();
    await visit(async impl => {
      vi.spyOn(impl.ctx.storage, "setAlarm").mockResolvedValue();
      const origin = seed(impl);
      const caller = {from: "agent" as const, chatId: 1};
      const captured = impl.captureIntegrationOrigin(caller, 7);
      expect(captured).toEqual(origin);
      using session = await impl.startGatekeeperSession({type: "gatekeeper", id: 7}, caller, captured);
      using context = await session.getAgentContext();
      expect(await context!.getTurn()).toMatchObject({turnId: origin.turnId, phase: "running"});
      using userSession = await impl.openGatekeeperSession(7, await impl.getGatekeeperFacet(7), {from: "user"});
      expect(await userSession.getAgentContext()).toBeNull();
      impl.env.AGENT_INTEGRATION_GRANTS = undefined;
      expect(impl.captureIntegrationOrigin(caller, 7)).toBeUndefined();
      using ungranted = await impl.startGatekeeperSession({type: "gatekeeper", id: 7}, caller);
      expect(await ungranted.getAgentContext()).toBeNull();
      impl.env.AGENT_INTEGRATION_GRANTS = grants;
      const row = impl.storage.activeAgents.get(1)!;
      row.integration!.segmentId = crypto.randomUUID();
      impl.storage.activeAgents.put(row);
      await expect(impl.startGatekeeperSession({type: "gatekeeper", id: 7}, caller, captured)).rejects.toThrow("expired");
      // Capturing a binding must not fail just because a connection is awaiting a restart.
      vi.spyOn(impl, "assertGatekeeperUsable").mockImplementation(() => { throw new Error("Restart pending"); });
      expect(() => impl.captureIntegrationOrigin(caller, 7)).not.toThrow();
      impl.storage.activeAgents.delete(1);
    });
  });

  it.each(["segment", "stop"] as const)("keeps callback re-registration a no-op across %s cleanup", async change => {
    const {visit} = await fixture();
    await visit(async impl => {
      // Drive delivery explicitly; an alarm would also try to recover this synthetic model.
      vi.spyOn(impl.ctx.storage, "setAlarm").mockResolvedValue();
      const origin = seed(impl), receiver = participant(impl, crypto.randomUUID());
      await receiver.setReregister();
      await receiver.hold("resumed");
      await impl.integrations.context(7, origin)!.participate(receiver);
      impl.integrations.emit(impl.storage.activeAgents.get(1)!, "resumed");
      const draining = impl.integrations.drain(1);
      // Observe rejection immediately so the deliberately failing pre-fix run cannot leak it.
      const outcome = draining.then(() => null, (error: unknown) => error);
      await receiver.waitUntilHeld();
      try {
        if (change === "segment") {
          const row = impl.storage.activeAgents.get(1)!;
          row.integration!.segmentId = crypto.randomUUID();
          impl.storage.activeAgents.put(row);
        }
        else impl.storage.activeAgents.delete(1);
        expect((await receiver.release())?.phase).toBe(change === "segment" ? "suspending" : "finishing");
      } finally { await receiver.release(); }
      expect(await outcome).toBeNull();
      expect((await receiver.calls()).map(c => c.event.kind)).toEqual(
        change === "segment" ? ["resumed"] : ["resumed", "finished"]);
      impl.storage.activeAgents.delete(1);
      await impl.integrations.drain(1);
      expect([...impl.storage.agentParticipants.list()]).toHaveLength(0);
    });
  });

  it.each(["grant", "connection"] as const)("downgrades an in-flight delivery after %s revocation", async change => {
    const {visit} = await fixture();
    await visit(async impl => {
      vi.spyOn(impl.ctx.storage, "setAlarm").mockResolvedValue();
      const origin = seed(impl), receiver = participant(impl, crypto.randomUUID());
      await receiver.hold("resumed");
      await impl.integrations.context(7, origin)!.participate(receiver);
      impl.integrations.emit(impl.storage.activeAgents.get(1)!, "resumed");
      const draining = impl.integrations.drain(1);
      await receiver.waitUntilHeld();
      try {
        expect((await receiver.calls())[0].turn.phase).toBe("running");
        if (change === "grant") impl.env.AGENT_INTEGRATION_GRANTS = '{"test":{}}';
        else impl.storage.gatekeepers.delete(7);
        expect((await receiver.release())?.phase).toBe("finishing");
      } finally {
        impl.storage.activeAgents.delete(1);
        await receiver.release();
        await draining;
      }
      expect((await receiver.calls()).at(-1)?.turn.phase).toBe("finishing");
      expect([...impl.storage.agentParticipants.list()]).toHaveLength(0);
    });
  });

  it("registers once without sending a started callback", async () => {
    const {visit} = await fixture();
    await visit(async impl => {
      vi.spyOn(impl.ctx.storage, "setAlarm").mockResolvedValue();
      const origin = seed(impl), receiver = participant(impl, crypto.randomUUID());
      await receiver.setReregister();
      const context = impl.integrations.context(7, origin)!;
      await context.participate(receiver);
      await context.participate(receiver);
      await impl.integrations.drain(1);
      expect(await receiver.calls()).toEqual([]);
      expect([...impl.storage.agentParticipants.list()]).toHaveLength(1);
      impl.storage.activeAgents.delete(1);
      await impl.integrations.drain(1);
      expect((await receiver.calls()).at(-1)?.turn.phase).toBe("finishing");
      expect([...impl.storage.agentParticipants.list()]).toHaveLength(0);
    });
  });

  it("keeps the same event ID across a lost reply, real eviction, deletion and revocation", async () => {
    const {stub, visit} = await fixture();
    const name = crypto.randomUUID();
    const ids = await visit(async impl => {
      const origin = seed(impl), receiver = participant(impl, name);
      await receiver.setFailure(true);
      await impl.integrations.context(7, origin)!.participate(receiver);
      impl.integrations.emit(impl.storage.activeAgents.get(1)!, "resumed");
      await expect(impl.integrations.drain(1)).rejects.toThrow("Reply lost");
      impl.storage.activeAgents.delete(1);
      impl.storage.chatMeta.delete(1);
      impl.storage.gatekeepers.delete(7);
      return [...impl.storage.agentParticipants.list()][0].pending.map(e => e.eventId);
    });
    await evictDurableObject(stub);
    await visit(async impl => {
      const receiver = participant(impl, name);
      await receiver.setFailure(false);
      await impl.integrations.drain(1);
      const calls = await receiver.calls();
      expect(calls.filter(c => c.event.kind === "resumed").length).toBeGreaterThanOrEqual(2);
      expect(calls.every(c => ids.includes(c.event.eventId))).toBe(true);
      expect(calls.at(-1)?.event.eventId).toBe(ids[1]);
      expect(calls.at(-1)?.turn.phase).toBe("finishing");
      expect([...impl.storage.agentParticipants.list()]).toHaveLength(0);
    });
  });

  it("rechecks grants on retained contexts, not only at creation", async () => {
    const {visit} = await fixture();
    await visit(async impl => {
      const origin = seed(impl), context = impl.integrations.context(7, origin)!;
      impl.env.AGENT_INTEGRATION_GRANTS = undefined;
      await expect(context.getTurn()).rejects.toThrow("revoked");
      await expect(context.participate(participant(impl, crypto.randomUUID()))).rejects.toThrow("revoked");
      impl.storage.activeAgents.delete(1);
    });
  });

  it("keeps failed cleanup receipts and the deletion fence after connector removal and eviction", async () => {
    const {stub, visit} = await fixture();
    const name = crypto.randomUUID();
    const pending = await visit(async impl => {
      const origin = seed(impl), receiver = participant(impl, name);
      await impl.integrations.context(7, origin)!.participate(receiver);
      await impl.integrations.drain();
      await receiver.setFailure(true);
      using client = await deletionClient(impl);
      await expect(client.deleteSelf()).rejects.toThrow("Reply lost");
      expect(impl.storage.deleting.get()).toBe(true);
      expect(impl.storage.activeAgents.get(1)).toBeUndefined();
      expect(() => impl.startAgent(1, {} as any, USER, "unused")).toThrow("deletion");
      const pending = [...impl.storage.agentParticipants.list()][0].pending;
      impl.removeGatekeeper(7);
      expect(impl.storage.gatekeepers.get(7)).toBeUndefined();
      await expect(impl.integrations.drain()).rejects.toThrow("Reply lost");
      expect([...impl.storage.agentParticipants.list()][0].pending).toEqual(pending);
      return pending;
    });
    await evictDurableObject(stub);
    await visit(async impl => {
      expect(impl.storage.deleting.get()).toBe(true);
      await expect(impl.deliverAgentCallback(1, "late", [], "unused", null)).rejects.toThrow("deleted");
      const receiver = participant(impl, name);
      await expect(impl.integrations.drain()).rejects.toThrow("Reply lost");
      expect([...impl.storage.agentParticipants.list()][0].pending).toEqual(pending);
      expect((await receiver.calls()).at(-1)?.turn.phase).toBe("finishing");
      await receiver.setFailure(false);
      await impl.integrations.drain();
      expect([...impl.storage.agentParticipants.list()]).toHaveLength(0);
    });
  });

  it("releases the deletion fence after a post-cleanup owner failure resets the DO", async () => {
    const {visit} = await fixture();
    await expect(visit(async impl => {
      seed(impl);
      using client = await deletionClient(impl);
      await client.deleteSelf();
    })).rejects.toThrow();
    await visit(impl => {
      expect(impl.storage.deleting.get()).toBe(false);
      expect(impl.storage.activeAgents.get(1)).toBeUndefined();
      expect(() => impl.assertChatNotActive(1)).not.toThrow();
    });
  });

});
