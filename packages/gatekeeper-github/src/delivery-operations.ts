import type { GitHubDeliveryCommand, GitHubDeliveryReceipt, GitHubPushContinuity } from "./types";

/** Private index onto the existing native approval action, never a second execution queue. */
export interface DeliveryOperationRecord extends GitHubDeliveryReceipt {
  payload: string;
  expected: GitHubPushContinuity;
  generation?: string;
  effectStarted?: boolean;
}

function ordered(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(ordered);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined).toSorted(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => [k, ordered(v)]));
  return value;
}

/** Canonical semantic arguments, bounded before durable allocation. */
export function deliveryPayload(command: GitHubDeliveryCommand): string {
  let normalized: GitHubDeliveryCommand;
  if (command.kind === "createPullRequest") {
    normalized = { kind: command.kind, options: { title: command.options.title, head: command.options.head, base: command.options.base, bodyMarkdown: command.options.bodyMarkdown ?? "", draft: command.options.draft ?? false } };
  } else {
    if (!/^[1-9]\d*$/.test(command.pullRequestId) || !Number.isSafeInteger(Number(command.pullRequestId))) throw Error("A delivery requires a real pull request number.");
    switch (command.kind) {
      case "postComment": normalized = { kind: command.kind, pullRequestId: command.pullRequestId, bodyMarkdown: command.bodyMarkdown }; break;
      case "postReview": normalized = { kind: command.kind, pullRequestId: command.pullRequestId, review: { ...command.review, bodyMarkdown: command.review.bodyMarkdown ?? "", diffComments: command.review.diffComments ?? [] } }; break;
      case "markReady": normalized = { kind: command.kind, pullRequestId: command.pullRequestId }; break;
    }
  }
  const payload = JSON.stringify(ordered(normalized));
  if (new TextEncoder().encode(payload).length > 64 * 1024) throw Error("GitHub delivery arguments are too large.");
  return payload;
}

/** Whitelist projection excludes durable payloads, internal fences and provider errors. */
export function deliveryReceipt(record: DeliveryOperationRecord): GitHubDeliveryReceipt {
  return { version: 1, id: record.id, requestKey: record.requestKey, digest: record.digest, state: record.state,
    ...(record.actionId === undefined ? {} : { actionId: record.actionId }),
    ...(record.failure ? { failure: record.failure } : {}),
    ...(record.state === "applied" && record.resource ? { resource: record.resource } : {}) };
}
