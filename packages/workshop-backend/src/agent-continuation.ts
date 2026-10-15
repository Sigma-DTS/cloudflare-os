import type { AgentTurnEvent } from "@gadgets/workshop-shared/agent-integration";
import type {
  ActiveAgentRecord, AgentContinuation, AgentContinuationWait, OverseerStorage,
} from "./storage-schema/overseer-storage";

/** Terminal outcomes; a suspended continuation can still be canceled or superseded. */
export type AgentFinishReason = Extract<AgentTurnEvent, { kind: "finished" }>["reason"];

/** Durable transitions only: model execution and callback RPCs belong to their respective drivers. */
export class AgentContinuations {
  constructor(private storage: Pick<OverseerStorage,
      "agentContinuations" | "agentIntegrationParticipants" | "transaction">,
      private id: () => string = () => crypto.randomUUID()) {}

  get(chatId: number): AgentContinuation | undefined {
    return this.storage.agentContinuations.get(chatId);
  }

  owns(chatId: number, continuationId: string): boolean {
    return this.get(chatId)?.continuationId === continuationId;
  }

  start(run: ActiveAgentRecord, startSequence = 0): AgentContinuation {
    return this.storage.transaction(() => {
      this.close(run.chatId, "abandoned");
      const turnId = this.id(), segmentId = this.id();
      const record: AgentContinuation = { ...run, startSequence, continuationId: this.id(), turnId, segmentId,
        entry: { eventId: this.id(), turnId, segmentId, kind: "started" }, status: { phase: "starting" } };
      this.storage.agentContinuations.put(record);
      return record;
    });
  }

  /** A reset rotates the segment, not the logical turn or the authorized execution. */
  enter(chatId: number, continuationId: string): AgentContinuation | undefined {
    const record = this.get(chatId);
    if (!record || record.continuationId !== continuationId ||
        !["starting", "running"].includes(record.status.phase)) return;
    const segmentId = record.status.phase === "starting" ? record.segmentId : this.id();
    const entry = record.status.phase === "starting" ? record.entry : {
      eventId: this.id(), turnId: record.turnId, segmentId, kind: "resumed" as const,
    };
    return this.#put({ ...record, segmentId, entry, status: { phase: "running" } }, entry);
  }

  suspend(chatId: number, continuationId: string, wait: AgentContinuationWait,
      ready: boolean): AgentContinuation | undefined {
    const record = this.get(chatId);
    if (!record || record.continuationId !== continuationId || record.status.phase !== "running") return;
    const event = { eventId: this.id(), turnId: record.turnId, segmentId: record.segmentId,
      kind: "suspended" as const, reason: wait.kind };
    return this.#put({ ...record, status: { phase: "suspending", wait, ready, event } }, event);
  }

  close(chatId: number, reason: AgentFinishReason): AgentContinuation | undefined {
    const record = this.get(chatId);
    if (!record || record.status.phase === "finished" || record.status.phase === "finishing") return record;
    const event = { eventId: this.id(), turnId: record.turnId, segmentId: record.segmentId,
      kind: "finished" as const, reason };
    return this.#put({ ...record, status: { phase: "finishing", reason, event } }, event);
  }

  /** A wake-up can resolve only its named wait, never a later pause in the same turn. */
  wake(chatId: number, source: number | string): boolean {
    const record = this.get(chatId), status = record?.status;
    if (!record || !status || (status.phase !== "suspending" && status.phase !== "paused") || status.ready) return false;
    const matches = status.wait.kind === "approval"
      ? typeof source === "number" && status.wait.actionIds.includes(source)
      : typeof source === "string" && status.wait.requestIds.includes(source);
    if (!matches) return false;
    this.#put({ ...record, status: { ...status, ready: true } });
    return true;
  }

  /** A nested approval extends its parent's wait before the child can complete. */
  addFollowup(chatId: number, parent: number, child: number): void {
    const record = this.get(chatId), status = record?.status;
    if (!record || !status || (status.phase !== "paused" && status.phase !== "suspending") ||
        status.wait.kind !== "approval" || !status.wait.actionIds.includes(parent)) return;
    this.#put({...record, status: {...status, ready: false,
      wait: {kind: "approval", actionIds: [...status.wait.actionIds, child]}}});
  }

  /** Cleanup's ACK settles exactly the execution that requested it. */
  settle(chatId: number, continuationId: string): void {
    const record = this.get(chatId);
    if (!record || record.continuationId !== continuationId) return;
    if (record.status.phase === "suspending") this.#put({ ...record, status: { ...record.status, phase: "paused" } });
    if (record.status.phase === "finishing") this.#put({ ...record, status: { ...record.status, phase: "finished" } });
  }

  resume(chatId: number): AgentContinuation | undefined {
    const record = this.get(chatId);
    if (!record || record.status.phase !== "paused" || !record.status.ready) return;
    const segmentId = this.id();
    return this.#put({ ...record, continuationId: this.id(), segmentId,
      entry: { eventId: this.id(), turnId: record.turnId, segmentId, kind: "resumed" }, status: { phase: "starting" } });
  }

  #put(record: AgentContinuation, event?: AgentTurnEvent): AgentContinuation {
    this.storage.transaction(() => {
      this.storage.agentContinuations.put(record);
      if (!event) return;
      // Materialize before updating an indexed collection: updates invalidate its iterator.
      const participants = [...this.storage.agentIntegrationParticipants.byTurn.get(record.turnId)];
      for (const participant of participants) {
        participant.pending.push(event);
        participant.retryAt = Date.now() + 30_000;
        this.storage.agentIntegrationParticipants.put(participant);
      }
    });
    return record;
  }
}
