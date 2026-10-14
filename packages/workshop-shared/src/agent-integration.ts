import type { RpcStub, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import type { ActionDescription, GitCache } from "./gatekeeper";

/** Fresh capabilities supplied when applying an action after an arbitrary approval delay. */
export interface GatekeeperActionContext extends RpcTarget {
  /** The same provenance- and action-scoped Git cache that legacy applyAction receives. */
  getGitCache(): Promise<GitCache>;
  /** Originating logical turn, or null for non-agent actions; never a later unrelated turn. */
  getAgentContext(): Promise<AgentContext | null>;
  /**
   * Queue a further approval needed by this already-authorized action, using its original binding
   * and logical turn. Only awaited, recoverable contextual agent actions support this. Submission is
   * durably deduplicated by the gatekeeper's action ID and description; it grants no permission.
   * The context is ephemeral: after a reset, recovery redelivers the parent with a fresh context.
   */
  submitAction(action: number, description: ActionDescription): Promise<void>;
}

/** Ephemeral invocation context; only participant capabilities may be persisted. */
export interface AgentContext extends RpcTarget {
  /** Read turn identity and execution phase without exposing user identity. */
  getTurn(): Promise<AgentTurnInfo>;
  /**
   * Register a persistent, binding-scoped callback. Registration and event retries are idempotent.
   * Lifecycle access must be granted independently by trusted deployment configuration.
   */
  participate(participant: Fetcher<AgentTurnParticipant>): Promise<void>;
}

/** One logical turn can suspend for approval and resume in a new invocation segment. */
export interface AgentTurnInfo {
  /** Stable opaque ID across resumptions; a new user request starts a different turn. */
  turnId: string;
  /** Opaque chat identity, not an account or cross-workspace lookup key. */
  chatId: string;
  /** Changes on each execution segment. */
  segmentId: string;
  /** Finishing/suspending contexts permit cleanup, not new user commands. */
  phase: "running" | "applyingAction" | "suspending" | "finishing";
}

/** Retry-safe, at-least-once lifecycle notification. */
export type AgentTurnEvent = {
  /** Persisted idempotency key; retries retain this ID. */
  eventId: string;
  /** Logical turn this event belongs to. */
  turnId: string;
  /** Segment this event belongs to. */
  segmentId: string;
} & (
  | { /** Entry or continuation, including late participant registration. */ kind: "started" | "resumed" }
  | { /** Temporary pause. */ kind: "suspended";
      /** Condition that must be resolved before the next segment. */ reason: "approval" | "connection" }
  | { /** Terminal turn disposition. */ kind: "finished";
      /** Completion or recovery outcome. */ reason: "completed" | "canceled" | "failed" | "abandoned" }
);

/** Persistent Worker entrypoint, reinstantiated with account/workspace-bound props. */
export interface AgentTurnParticipant extends WorkerEntrypoint {
  /** Awaited bounded notification with fresh context; cleanup must tolerate repeated event IDs. */
  onAgentTurnEvent(event: AgentTurnEvent, context: RpcStub<AgentContext>): Promise<void>;
}
