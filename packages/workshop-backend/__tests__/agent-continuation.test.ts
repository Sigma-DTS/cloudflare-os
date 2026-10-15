import { describe, expect, it } from "vitest";
import { AgentContinuations } from "../src/agent-continuation";
import { migrateToAgentContinuations } from "../src/storage-schema/overseer-migrations";
import { makeActionStorage } from "./fixtures";
import { RUN } from "./agent-continuation-fixture";

function setup() {
  const storage = makeActionStorage();
  let id = 0;
  const machine = new AgentContinuations(storage, () => `id-${++id}`);
  const first = machine.start(RUN, 7);
  machine.enter(1, first.continuationId);
  return { machine, storage, first };
}

describe("one durable agent continuation", () => {
  it.each(["approval", "connection"] as const)("resumes a named %s wait exactly once", kind => {
    const {machine: m, first} = setup();
    const wait = kind === "approval" ? {kind, actionIds: [7]} : {kind, requestIds: ["request"]};
    const source = kind === "approval" ? 7 : "request";
    m.suspend(1, first.continuationId, wait, false);
    expect(m.wake(1, "unrelated")).toBe(false);
    expect(m.resume(1)).toBeUndefined(); // Cleanup still owns the execution.
    expect(m.wake(1, source)).toBe(true);
    expect(m.wake(1, source)).toBe(false);
    m.settle(1, first.continuationId);
    const resumed = m.resume(1)!;
    expect(resumed.continuationId).not.toBe(first.continuationId);
    expect(resumed.startSequence).toBe(7);
    expect(m.resume(1)).toBeUndefined();
    m.enter(1, resumed.continuationId);
    m.suspend(1, resumed.continuationId, {kind: "approval", actionIds: [8]}, false);
    expect(m.wake(1, source)).toBe(false); // Old completion cannot wake the next pause.
    expect(m.get(1)?.status).toMatchObject({ready: false});
  });

  it.each(["completed", "canceled", "failed", "abandoned"] as const)("keeps %s terminal across retries", reason => {
    const {machine: m, first} = setup();
    m.suspend(1, first.continuationId, {kind: "approval", actionIds: [7]}, false);
    const closed = m.close(1, reason)!;
    expect(m.close(1, "failed")).toEqual(closed);
    expect(m.wake(1, 7)).toBe(false);
    expect(m.enter(1, first.continuationId)).toBeUndefined();
    m.settle(1, first.continuationId);
    expect(m.get(1)?.status).toMatchObject({phase: "finished", reason});
    expect(m.start(RUN).continuationId).not.toBe(first.turnId);
  });

  it("re-enters after a reset without changing execution or caller authority", () => {
    const {machine: m, first} = setup();
    expect(m.enter(1, first.continuationId)).toEqual({...first, status: {phase: "running"}});
  });

  it.each(["same prompt", "different prompt"])("fences old cleanup against a new execution of %s", request => {
    const {machine: m, first} = setup();
    m.close(1, "completed");
    const next = m.start({...RUN, initiatorUserId: request});
    m.settle(1, first.continuationId);
    expect(m.get(1)).toEqual(next);
    expect(m.enter(1, first.continuationId)).toBeUndefined();
  });

  it("migrates legacy active executions once, retaining caller and model authority", () => {
    const storage = makeActionStorage();
    storage.version.put(5);
    storage.activeAgents.put(RUN);
    storage.chats.put({chatId: 1, sequence: 7, timestamp: new Date(), author: RUN.initiator,
      type: "message", message: "Original request"});
    migrateToAgentContinuations({storage});
    const migrated = storage.agentContinuations.get(1);
    expect(migrated).toMatchObject({...RUN, status: {phase: "starting"}});
    expect([...storage.activeAgents.list()]).toEqual([]);
    expect(storage.version.get()).toBe(6);
    migrateToAgentContinuations({storage});
    expect(storage.agentContinuations.get(1)).toEqual(migrated);
  });
});
