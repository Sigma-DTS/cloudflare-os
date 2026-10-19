import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agentIntegrationGrant } from "../src/agent-integration";
import type { OverseerDurableObject } from "../src/overseer";
import type { TestLifecycleParticipant } from "./test-worker";
import { migrateToAgentIntegrations } from "../src/storage-schema/overseer-migrations";

type Impl = OverseerDurableObject["impl"];
const AGENT = {type: "agent" as const, id: "model", name: "Model"};
const USER = {type: "user" as const, id: "user", name: "User"};
const grants = '{"test":{"lifecycle":true}}';
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
  it.each(["segment", "stop"] as const)("keeps callback re-registration a no-op across %s cleanup", async change => {
    const {visit} = await fixture();
    await visit(async impl => {
      // Drive delivery explicitly; an alarm would also try to recover this synthetic model.
      vi.spyOn(impl.ctx.storage, "setAlarm").mockResolvedValue();
      const origin = seed(impl), receiver = participant(impl, crypto.randomUUID());
      await receiver.setReregister();
      await receiver.hold("started");
      await impl.integrations.context(7, origin)!.participate(receiver);
      const draining = impl.integrations.drain(1);
      // Observe rejection immediately so the deliberately failing pre-fix run cannot leak it.
      const outcome = draining.then(() => null, (error: unknown) => error);
      await receiver.waitUntilHeld();
      try {
        if (change === "segment") impl.integrations.enter(1);
        else impl.storage.activeAgents.delete(1);
        expect((await receiver.release())?.phase).toBe(change === "segment" ? "suspending" : "finishing");
      } finally { await receiver.release(); }
      expect(await outcome).toBeNull();
      expect((await receiver.calls()).map(c => c.event.kind)).toEqual(
        ["started", change === "segment" ? "resumed" : "finished"]);
      impl.storage.activeAgents.delete(1);
      await impl.integrations.drain(1);
      expect([...impl.storage.agentParticipants.list()]).toHaveLength(0);
    });
  });

  it.each(["grant", "connection", "restart"] as const)("downgrades an in-flight delivery after %s revocation", async change => {
    const {visit} = await fixture();
    await visit(async impl => {
      vi.spyOn(impl.ctx.storage, "setAlarm").mockResolvedValue();
      const origin = seed(impl), receiver = participant(impl, crypto.randomUUID());
      await receiver.hold("started");
      await impl.integrations.context(7, origin)!.participate(receiver);
      const draining = impl.integrations.drain(1);
      await receiver.waitUntilHeld();
      try {
        expect((await receiver.calls())[0].turn.phase).toBe("running");
        if (change === "grant") impl.env.AGENT_INTEGRATION_GRANTS = '{"test":{}}';
        else if (change === "connection") impl.storage.gatekeepers.delete(7);
        else vi.spyOn(impl, "gatekeeperUsable").mockReturnValue(false);
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

  it("registers once without waiting for its callback, including callback re-registration", async () => {
    const {visit} = await fixture();
    await visit(async impl => {
      vi.spyOn(impl.ctx.storage, "setAlarm").mockResolvedValue();
      const origin = seed(impl), receiver = participant(impl, crypto.randomUUID());
      await receiver.setReregister();
      const context = impl.integrations.context(7, origin)!;
      await context.participate(receiver);
      await context.participate(receiver);
      await impl.integrations.drain(1);
      expect((await receiver.calls()).map(c => c.event.kind)).toEqual(["started"]);
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
      expect(calls.filter(c => c.event.kind === "started").length).toBeGreaterThanOrEqual(2);
      expect(calls.every(c => ids.includes(c.event.eventId))).toBe(true);
      expect(calls.at(-1)?.event.eventId).toBe(ids[1]);
      expect(calls.at(-1)?.turn.phase).toBe("finishing");
      expect([...impl.storage.agentParticipants.list()]).toHaveLength(0);
    });
  });

  it("expires segment contexts on re-entry", async () => {
    const {visit} = await fixture();
    await visit(async impl => {
      const origin = seed(impl), context = impl.integrations.context(7, origin)!;
      impl.integrations.enter(1);
      await expect(context.getTurn()).rejects.toThrow("expired");
      impl.storage.activeAgents.delete(1);
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

  it("keeps cleanup receipts and the deletion fence across eviction", async () => {
    const {stub, visit} = await fixture();
    const name = crypto.randomUUID();
    await visit(async impl => {
      const origin = seed(impl), receiver = participant(impl, name);
      await impl.integrations.context(7, origin)!.participate(receiver);
      await impl.integrations.drain();
      await receiver.setFailure(true);
      impl.closeAgentsForDeletion();
      await expect(impl.integrations.drain()).rejects.toThrow("Reply lost");
      expect(impl.storage.deleting.get()).toBe(true);
      expect(impl.storage.activeAgents.get(1)).toBeUndefined();
      expect(() => impl.startAgent(1, {} as any, USER, "unused")).toThrow("deletion");
    });
    await evictDurableObject(stub);
    await visit(async impl => {
      expect(impl.storage.deleting.get()).toBe(true);
      await expect(impl.deliverAgentCallback(1, "late", [], "unused", null)).rejects.toThrow("deleted");
      await participant(impl, name).setFailure(false);
      await impl.integrations.drain();
      expect([...impl.storage.agentParticipants.list()]).toHaveLength(0);
    });
  });

  it("migrates existing execution rows without changing authority or inventing callbacks", async () => {
    const {visit} = await fixture();
    await visit(impl => {
      seed(impl);
      const before = impl.storage.activeAgents.get(1);
      impl.storage.version.put(5);
      migrateToAgentIntegrations(impl);
      expect(impl.storage.version.get()).toBe(6);
      expect(impl.storage.activeAgents.get(1)).toEqual(before);
      expect([...impl.storage.agentParticipants.list()]).toHaveLength(0);
      impl.storage.activeAgents.delete(1);
    });
  });
});
