import type {
  ActiveAgentRecord, AgentContinuation, AgentContinuationWait, OverseerStorage,
} from "./storage-schema/overseer-storage";

/** Terminal outcomes; a suspended continuation can still be canceled or superseded. */
export type AgentFinishReason = "completed" | "canceled" | "failed" | "abandoned";

/** Durable transitions only. The overseer drives execution and recoverable cleanup. */
export class AgentContinuations {
  constructor(private storage: Pick<OverseerStorage, "agentContinuations">,
      private id: () => string = () => crypto.randomUUID()) {}

  get(chatId: number): AgentContinuation | undefined {
    return this.storage.agentContinuations.get(chatId);
  }

  owns(chatId: number, continuationId: string): boolean {
    return this.get(chatId)?.continuationId === continuationId;
  }

  start(run: ActiveAgentRecord): AgentContinuation {
    return this.#put({...run, continuationId: this.id(), status: {phase: "starting"}});
  }

  enter(chatId: number, continuationId: string): AgentContinuation | undefined {
    const record = this.get(chatId);
    if (!record || record.continuationId !== continuationId ||
        !["starting", "running"].includes(record.status.phase)) return;
    return this.#put({...record, status: {phase: "running"}});
  }

  suspend(chatId: number, continuationId: string, wait: AgentContinuationWait,
      ready: boolean): AgentContinuation | undefined {
    const record = this.get(chatId);
    if (!record || record.continuationId !== continuationId || record.status.phase !== "running") return;
    return this.#put({...record, status: {phase: "suspending", wait, ready}});
  }

  close(chatId: number, reason: AgentFinishReason): AgentContinuation | undefined {
    const record = this.get(chatId);
    if (!record || record.status.phase === "finished" || record.status.phase === "finishing") return record;
    return this.#put({...record, status: {phase: "finishing", reason}});
  }

  /** A wake-up resolves only its named wait, never a later pause in the same chat. */
  wake(chatId: number, source: number | string): boolean {
    const record = this.get(chatId), status = record?.status;
    if (!record || !status || (status.phase !== "suspending" && status.phase !== "paused") || status.ready) return false;
    const matches = status.wait.kind === "approval"
      ? typeof source === "number" && status.wait.actionIds.includes(source)
      : typeof source === "string" && status.wait.requestIds.includes(source);
    if (!matches) return false;
    this.#put({...record, status: {...status, ready: true}});
    return true;
  }

  /** Cleanup settles exactly the execution that requested it, not its successor. */
  settle(chatId: number, continuationId: string): void {
    const record = this.get(chatId);
    if (!record || record.continuationId !== continuationId) return;
    if (record.status.phase === "suspending") this.#put({...record, status: {...record.status, phase: "paused"}});
    if (record.status.phase === "finishing") this.#put({...record, status: {...record.status, phase: "finished"}});
  }

  resume(chatId: number): AgentContinuation | undefined {
    const record = this.get(chatId);
    if (!record || record.status.phase !== "paused" || !record.status.ready) return;
    return this.#put({...record, continuationId: this.id(), status: {phase: "starting"}});
  }

  #put(record: AgentContinuation): AgentContinuation {
    this.storage.agentContinuations.put(record);
    return record;
  }
}
