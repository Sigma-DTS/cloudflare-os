import type { RpcStub, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
/** Ephemeral turn capability; only the participant, not this context, may be persisted. */
export interface AgentContext extends RpcTarget {
  /** Read opaque identity and current authority without exposing the user's identity. */
  getTurn(): Promise<AgentTurnInfo>;
  /**
   * Durably register one participant per connection and turn. Repeated registration is a no-op;
   * it does not replace the original participant or await its callback. The receiver must
   * initialize lazily when first used, not depend on a started notification arriving first.
   */
  participate(participant: Fetcher<AgentTurnParticipant>): Promise<void>;
}

/** Identity of an existing durable execution, not a second workflow state machine. */
export interface AgentTurnInfo {
  /** Stable through decision pauses and Durable Object resets. */
  turnId: string;
  /** Opaque workspace-local chat identity, not a user or account ID. */
  chatId: string;
  /** Changes on resumption/reset; capabilities from earlier segments expire. */
  segmentId: string;
  /** Closing contexts authorize cleanup only, never new commands. */
  phase: "running" | "suspending" | "finishing";
}

/** Ordered, at-least-once notification; receivers must durably deduplicate eventId. */
export interface AgentTurnEvent {
  /** Retries retain the same persisted ID, including after a lost acknowledgement. */
  eventId: string;
  /** Original logical turn. */
  turnId: string;
  /** Segment which produced the event. */
  segmentId: string;
  /** Finished means the execution row was removed, regardless of its outcome. */
  kind: "started" | "resumed" | "suspended" | "finished";
}

/** Persistent, account/workspace-bound Worker entrypoint supplied by a trusted integration. */
export interface AgentTurnParticipant extends WorkerEntrypoint {
  /**
   * Bounded delivery with a fresh context. Read its phase before acting: delayed entry events
   * may already have cleanup-only authority. A lost reply does not mean cleanup never ran.
   */
  onAgentTurnEvent(event: AgentTurnEvent, context: RpcStub<AgentContext>): Promise<void>;
}
