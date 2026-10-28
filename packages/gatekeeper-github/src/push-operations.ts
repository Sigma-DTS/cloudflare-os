import type { GitHubPushCommand, GitHubPushContinuity, GitHubPushReceipt } from "./types";
import { validateBranchName } from "@gadgets/gatekeeper-kit/git-transport";
import { isCommitOid } from "@gadgets/gatekeeper-kit/git-objects";

/** Fixed internal refusal; never includes a provider response or credential. */
export const PUSH_SCOPE_CHANGED = "GitHub push authorization changed.";

/** Local phase evidence: credential/pack failure occurred before receive-pack was sent. */
export class PushNotSentError extends Error {
  constructor(readonly failure?: "scope-changed", options?: ErrorOptions) {
    super("GitHub push was not sent.", options);
  }
}

/** Private producer record; the public projection deliberately omits payload and native fences. */
export interface PushOperationRecord extends GitHubPushReceipt {
  payload: string;
  digest?: string;
  expected: GitHubPushContinuity;
  generation?: string;
  actionId?: number;
  effectStarted?: boolean;
}

/** Validates a semantic deduplication key, beyond the RPC string type. */
export function pushRequestKey(value: string): string {
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value)) throw new Error("A push request key must be a lowercase UUID.");
  return value;
}

/** Canonical arguments, independent of optional-default spelling or property order. */
export function pushPayload(command: GitHubPushCommand): string {
  validateBranchName(command.branch);
  if (!isCommitOid(command.commitId)) throw new Error("A push requires a full commit id.");
  return JSON.stringify({ version: 1, branch: command.branch, commitId: command.commitId, force: command.force ?? false });
}

/** Compares metadata without treating an identifier as a capability. */
export function samePushContinuity(a: GitHubPushContinuity, b: GitHubPushContinuity): boolean {
  return a.version === b.version && a.facet === b.facet && a.grant === b.grant && a.repositoryId === b.repositoryId;
}

/** Hashes producer metadata/payload without revealing internal credential-generation fences. */
export async function pushHash(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return [...bytes].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

/** Whitelist projection: provider diagnostics and payloads never reach operational status. */
export function pushReceipt(record: PushOperationRecord): GitHubPushReceipt {
  return { version: 1, id: record.id, requestKey: record.requestKey, state: record.state,
    ...(record.failure ? { failure: record.failure } : {}) };
}
