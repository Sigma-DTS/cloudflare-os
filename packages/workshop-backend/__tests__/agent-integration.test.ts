import { describe, expect, it, vi } from "vitest";
import { agentIntegrationGrant, deliverIntegrationEvent } from "../src/agent-integration";

describe("trusted integration grants", () => {
  it("requires exact per-vendor opt-in, separate from ambience", () => {
    const config = '{"container":{"lifecycle":true},"other":{"contextualActions":true}}';
    expect(agentIntegrationGrant(config, "container")).toEqual({ lifecycle: true, contextualActions: false, recoverableActions: false });
    expect(agentIntegrationGrant(config, "other")).toEqual({ lifecycle: false, contextualActions: true, recoverableActions: false });
    expect(agentIntegrationGrant(config, "Container")).toEqual({});
    expect(agentIntegrationGrant(undefined, "container")).toEqual({});
  });
  it.each(["broken", "null", "[]", '{"container":true}',
    '{"container":{"lifecycle":"true"}}', '{"container":{"worktreeReplica":"true"}}',
    '{"container":{"contextualActions":1}}'])("fails closed on %s", config => {
    expect(agentIntegrationGrant(config, "container")).toEqual({});
  });
  it("requires explicit administrator opt-in for idempotent approval recovery", () => {
    expect(agentIntegrationGrant('{"container":{"recoverableActions":true}}', "container"))
      .toEqual({ lifecycle: false, contextualActions: false, recoverableActions: true });
    expect(agentIntegrationGrant('{"container":{"recoverableActions":"true"}}', "container")).toEqual({});
  });
});

describe("lifecycle callback deadlines", () => {
  it("does not acknowledge callback rejection or timeout as delivery", async () => {
    await expect(deliverIntegrationEvent(async () => { throw new Error("retry me"); })).rejects.toThrow("retry me");
    await expect(deliverIntegrationEvent(() => new Promise(() => {}), 10)).rejects.toThrow("timed out");
    await expect(deliverIntegrationEvent(async () => {})).resolves.toBeUndefined();
  });
  it("waits for long snapshot cleanup instead of failing the turn after five seconds", async () => {
    vi.useFakeTimers();
    try {
      let finish!: () => void;
      let delivered = false;
      const cleanup = new Promise<void>(resolve => { finish = resolve; });
      const delivery = deliverIntegrationEvent(() => cleanup);
      const result = expect(delivery.then(() => { delivered = true; })).resolves.toBeUndefined();
      await vi.advanceTimersByTimeAsync(30 * 60 * 1_000);
      expect(delivered).toBe(false);
      finish();
      await result;
      expect(delivered).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
  it("still rejects a wedged lifecycle callback at the hour-long default deadline", async () => {
    vi.useFakeTimers();
    try {
      const delivery = deliverIntegrationEvent(() => new Promise(() => {}));
      const result = expect(delivery).rejects.toThrow("timed out");
      await vi.advanceTimersByTimeAsync(60 * 60 * 1_000 - 1);
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      await result;
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
