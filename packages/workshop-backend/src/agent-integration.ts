import type { AgentTurnInfo } from "@gadgets/workshop-shared/agent-integration";
import type { AgentContinuation, AgentIntegrationOrigin } from "./storage-schema/overseer-storage";
export type { AgentIntegrationOrigin } from "./storage-schema/overseer-storage";

/** Trusted deployment grants; none can be asserted by a gatekeeper's description. */
export type AgentIntegrationGrant = {
  lifecycle?: boolean;
  contextualActions?: boolean;
  /** Opt-in to durable approval redelivery; the integration must durably deduplicate effects. */
  recoverableActions?: boolean;
};

/** Parse the deliberately small phase-one grant surface, failing closed on malformed config. */
export function agentIntegrationGrant(config: string | undefined, vendorId: string): AgentIntegrationGrant {
  if (!config) return {};
  try {
    const parsed: unknown = JSON.parse(config);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const grant: unknown = Object.getOwnPropertyDescriptor(parsed, vendorId)?.value;
    if (!grant || typeof grant !== "object" || Array.isArray(grant)) return {};
    if (Object.keys(grant).some(key => !["lifecycle", "contextualActions", "recoverableActions"].includes(key))) return {};
    const lifecycle: unknown = Object.getOwnPropertyDescriptor(grant, "lifecycle")?.value;
    const contextualActions: unknown = Object.getOwnPropertyDescriptor(grant, "contextualActions")?.value;
    const recoverableActions: unknown = Object.getOwnPropertyDescriptor(grant, "recoverableActions")?.value;
    if ((lifecycle !== undefined && typeof lifecycle !== "boolean") ||
        (contextualActions !== undefined && typeof contextualActions !== "boolean") ||
        (recoverableActions !== undefined && typeof recoverableActions !== "boolean")) return {};
    return { lifecycle: lifecycle === true, contextualActions: contextualActions === true,
      recoverableActions: recoverableActions === true };
  } catch {
    return {};
  }
}

/** Reject stale session/action capabilities instead of silently widening them to the latest turn. */
export function requireIntegrationTurn(turn: AgentContinuation | undefined,
    origin: AgentIntegrationOrigin, phase: AgentTurnInfo["phase"]): AgentTurnInfo {
  if (!turn || turn.turnId !== origin.turnId || turn.segmentId !== origin.segmentId ||
      (["finishing", "finished"].includes(turn.status.phase) && phase !== "finishing") ||
      (phase === "running" && turn.status.phase !== "running")) {
    throw new Error("Agent integration context expired; this request belongs to a different or closed turn.");
  }
  return { turnId: turn.turnId, chatId: String(turn.chatId), segmentId: turn.segmentId, phase };
}

/**
 * Bound callback work without treating timeout as successful delivery. Cleanup can snapshot a large
 * filesystem, and even an entry callback may await prior cleanup; allow an hour before retrying.
 */
export async function deliverIntegrationEvent(deliver: () => Promise<void>, timeoutMs = 60 * 60 * 1_000): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([Promise.resolve().then(deliver), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Agent lifecycle callback timed out.")), timeoutMs);
    })]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
