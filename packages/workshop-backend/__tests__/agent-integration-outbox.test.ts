import { describe, expect, it, vi } from "vitest";
import { migrateToAgentIntegration } from "../src/storage-schema/overseer-migrations";
import type { AgentContinuation } from "../src/storage-schema/overseer-storage";
import { makeActionStorage } from "./fixtures";
import { CHAT, GATEKEEPER, RUN, finish, flush, inKernel, origin, pause, resume, start } from "./agent-integration-fixture";

describe("lifecycle delivery over persistent native RPC", () => {
  it("commits the state transition and outbox together", () => inKernel(async (impl, participant) => {
    await start(impl);
    await impl.registerIntegrationParticipant(GATEKEEPER, origin(impl), "running", participant);
    const before = impl.continuations.get(CHAT);
    const failure = vi.spyOn(impl.storage.agentIntegrationParticipants, "put").mockImplementationOnce(() => {
      throw new Error("Injected outbox write failure");
    });
    expect(() => impl.continuations.close(CHAT, "canceled")).toThrow(/outbox write failure/);
    failure.mockRestore();
    expect(impl.continuations.get(CHAT)).toEqual(before);
    await finish(impl);
  }));

  it.each([
    {phase: "running"}, {phase: "paused", wait: {kind: "approval", actionIds: [7]}, ready: true},
    {phase: "finishing", reason: "canceled"}, {phase: "finished", reason: "completed"},
  ])("upgrades continuation-only $phase rows without changing their authority", status => {
    const storage = makeActionStorage();
    storage.version.put(6);
    const legacy = {...RUN, continuationId: "original-execution", status};
    storage.agentContinuations.put(legacy as AgentContinuation); // The preceding PR's schema.
    migrateToAgentIntegration({storage});
    const migrated = storage.agentContinuations.get(CHAT)!;
    expect(migrated).toMatchObject(legacy);
    expect(migrated.turnId).toBeTypeOf("string");
    expect(migrated.segmentId).toBeTypeOf("string");
    expect([...storage.agentIntegrationParticipants.list()]).toEqual([]);
    expect(storage.version.get()).toBe(7);
    migrateToAgentIntegration({storage});
    expect(storage.agentContinuations.get(CHAT)).toEqual(migrated);
  });

  it("supplies the real queue context, registers once, pauses, resumes and finishes", () => inKernel(async (impl, participant) => {
    const first = await start(impl);
    const facet = await impl.getGatekeeperFacet(GATEKEEPER);
    using session = await impl.openGatekeeperSession(GATEKEEPER, facet, {from: "agent", chatId: CHAT});
    expect(session.turn).toMatchObject({turnId: first.turnId, segmentId: first.segmentId, phase: "running"});
    await impl.registerIntegrationParticipant(GATEKEEPER, first, "running", participant);
    await impl.registerIntegrationParticipant(GATEKEEPER, first, "running", participant);
    await pause(impl);
    const second = await resume(impl);
    expect(second.turnId).toBe(first.turnId);
    expect(second.segmentId).not.toBe(first.segmentId);
    await finish(impl);
    expect((await participant.calls()).map(call => [call.event.kind, call.turn.phase])).toEqual([
      ["started", "running"], ["suspended", "suspending"], ["resumed", "running"], ["finished", "finishing"],
    ]);
    expect([...impl.storage.agentIntegrationParticipants.list()]).toEqual([]);
  }));

  it("keeps failed delivery's event ID and blocks startup until it can drain", () => inKernel(async (impl, participant) => {
    const first = await start(impl);
    await participant.setFailure(true);
    await expect(impl.registerIntegrationParticipant(GATEKEEPER, first, "running", participant)).rejects.toThrow(/unavailable/);
    const saved = [...impl.storage.agentIntegrationParticipants.list()][0];
    expect(saved.retryAt).toBeTypeOf("number");
    await expect(impl.beginAgentIntegrationTurn(CHAT, impl.continuations.get(CHAT)!.continuationId)).rejects.toThrow(/unavailable/);
    expect(origin(impl).segmentId).toBe(first.segmentId);
    await participant.setFailure(false);
    await flush(impl);
    expect(new Set((await participant.calls()).map(call => call.event.eventId)).size).toBe(1);
    expect([...impl.storage.agentIntegrationParticipants.list()][0].pending).toEqual([]);
    await finish(impl);
  }));

  it("retries an entry after termination with cleanup-only authority", () => inKernel(async (impl, participant) => {
    await start(impl);
    await participant.setFailure(true);
    await expect(impl.registerIntegrationParticipant(GATEKEEPER, origin(impl), "running", participant)).rejects.toThrow();
    impl.continuations.close(CHAT, "failed");
    await participant.setFailure(false);
    await flush(impl);
    expect((await participant.calls()).slice(-2).map(call => [call.event.kind, call.turn.phase])).toEqual([
      ["started", "finishing"], ["finished", "finishing"],
    ]);
    expect([...impl.storage.agentIntegrationParticipants.list()]).toEqual([]);
  }));

  it.each(["revoked", "deleted"] as const)("retains cleanup after binding authority is %s", mode => inKernel(async (impl, participant) => {
    await start(impl);
    const context = impl.getIntegrationContext(GATEKEEPER, origin(impl))!;
    await impl.registerIntegrationParticipant(GATEKEEPER, origin(impl), "running", participant);
    if (mode === "deleted") impl.storage.gatekeepers.delete(GATEKEEPER);
    else impl.env.AGENT_INTEGRATION_GRANTS = '{}';
    await expect(context.getTurn()).rejects.toThrow();
    await participant.setFailure(true);
    impl.continuations.close(CHAT, "canceled");
    await expect(flush(impl)).rejects.toThrow(/unavailable/);
    await participant.setFailure(false);
    await flush(impl);
    const terminal = (await participant.calls()).filter(call => call.event.kind === "finished");
    expect(terminal).toHaveLength(2);
    expect(terminal[0].event.eventId).toBe(terminal[1].event.eventId);
    expect([...impl.storage.agentIntegrationParticipants.list()]).toEqual([]);
  }));

  it("finishes predecessor cleanup before publishing a new prompt's context", () => inKernel(async (impl, participant) => {
    const first = await start(impl);
    const old = impl.getIntegrationContext(GATEKEEPER, first)!;
    await impl.registerIntegrationParticipant(GATEKEEPER, first, "running", participant);
    await pause(impl);
    const second = await start(impl);
    expect(second.turnId).not.toBe(first.turnId);
    expect((await participant.calls()).at(-1)?.event).toMatchObject({kind: "finished", reason: "abandoned"});
    await expect(old.getTurn()).rejects.toThrow(/expired/);
    expect(() => impl.getIntegrationContext(GATEKEEPER, first, "applyingAction")).toThrow(/expired/);
    await expect(impl.submitAction(GATEKEEPER, 42, {title: "Old", description: "Old", implementsRevert: false},
      {from: "agent", chatId: CHAT}, first)).rejects.toThrow(/expired/);
  }));

  it("drains all participants without invalidating storage iteration", () => inKernel(async (impl, participant) => {
    const binding = impl.storage.gatekeepers.get(GATEKEEPER)!;
    impl.storage.gatekeepers.put({...binding, id: GATEKEEPER + 1});
    await start(impl);
    for (const id of [GATEKEEPER, GATEKEEPER + 1]) await impl.registerIntegrationParticipant(id, origin(impl), "running", participant);
    await participant.setFailure(true);
    impl.continuations.close(CHAT, "failed");
    await expect(flush(impl)).rejects.toThrow(/unavailable/);
    expect([...impl.storage.agentIntegrationParticipants.list()]).toHaveLength(2);
    await participant.setFailure(false);
    await flush(impl);
    expect((await participant.calls()).slice(-2).every(call => call.turn.phase === "finishing")).toBe(true);
    expect([...impl.storage.agentIntegrationParticipants.list()]).toEqual([]);
  }));
});
