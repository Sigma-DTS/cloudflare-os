// A binding's narrowing as a Graph message listing: the path and `$filter` that fetch what the
// binding covers, newest first. Only an optimization. Every result still passes through the scope
// guard, so a filter Exchange can't express (a sender domain, a folder's subfolders) is simply left
// to the guard.
//
// Exchange refuses `$orderby` unless the sorted property leads the `$filter` ("The restriction or
// sort order is too complex for this operation", verified live). So every filtered listing leads
// with a `receivedDateTime ge` clause, a real cutoff or the start of time, and sorts on it.

import { idPath } from "./outlook-graph";
import type { OutlookScope } from "./outlook-scope";

/** What a listing asks for beyond the binding's own narrowing. */
export type ListingFilters = {
  folderId?: string;
  unread?: boolean;
  flagged?: boolean;
  /** An address or "@domain". */
  from?: string;
  category?: string;
  since?: string;
  focused?: boolean;
};

const BEGINNING = "1900-01-01T00:00:00Z";

/** An OData string literal. */
export function odataString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * The path (relative to the mailbox) and query listing what the binding covers, newest first.
 * `now` is for tests.
 */
export function listingRequest(scope: OutlookScope, filters: ListingFilters, now = Date.now()): { path: string; query: Record<string, string> } {
  const folderId = filters.folderId ?? scope.folder?.id;
  // A conversation, sender or category binding without a folder spans the mailbox; anything else
  // lists one folder, Inbox by default.
  const spansMailbox = folderId === undefined && (scope.conversation !== undefined || (scope.senders?.length ?? 0) > 0 || (scope.categories?.length ?? 0) > 0);
  const path = folderId !== undefined ? `/mailFolders/${idPath(folderId)}/messages` : spansMailbox ? "/messages" : "/mailFolders/inbox/messages";

  const cutoffs = [
    scope.recentDays !== undefined ? new Date(now - scope.recentDays * 24 * 60 * 60 * 1000).toISOString() : undefined,
    filters.since !== undefined ? new Date(filters.since).toISOString() : undefined,
  ].filter((value): value is string => value !== undefined).toSorted();
  const clauses = [`receivedDateTime ge ${cutoffs.at(-1) ?? BEGINNING}`];
  if (scope.conversation) clauses.push(`conversationId eq ${odataString(scope.conversation.id)}`);
  // One exact address narrows on the server; domains and several senders are left to the guard.
  const exact = [filters.from, ...(scope.senders?.length === 1 ? scope.senders : [])].filter(
    (sender): sender is string => sender !== undefined && !sender.startsWith("@"));
  if (exact.length === 1) clauses.push(`from/emailAddress/address eq ${odataString(exact[0]!)}`);
  const categories = filters.category !== undefined ? [filters.category] : scope.categories?.length === 1 ? scope.categories : [];
  if (categories.length === 1) clauses.push(`categories/any(c:c eq ${odataString(categories[0]!)})`);
  if (filters.unread !== undefined) clauses.push(`isRead eq ${!filters.unread}`);
  if (filters.flagged !== undefined) clauses.push(filters.flagged ? "flag/flagStatus eq 'flagged'" : "flag/flagStatus ne 'flagged'");
  if (filters.focused !== undefined) clauses.push(`inferenceClassification eq '${filters.focused ? "focused" : "other"}'`);
  return { path, query: { $filter: clauses.join(" and "), $orderby: "receivedDateTime desc" } };
}

/** Whether a listing filter that the server couldn't apply excludes a message. */
export function passesFilters(filters: ListingFilters, message: { from?: string; categories: readonly string[]; isRead: boolean; flagStatus: string; receivedAt: string }): boolean {
  if (filters.from !== undefined) {
    const from = message.from ?? "";
    const wanted = filters.from.toLowerCase();
    if (wanted.startsWith("@") ? !from.endsWith(wanted) : from !== wanted) return false;
  }
  if (filters.category !== undefined && !message.categories.some(name => name.toLowerCase() === filters.category!.toLowerCase())) return false;
  if (filters.unread !== undefined && message.isRead === filters.unread) return false;
  if (filters.flagged !== undefined && (message.flagStatus === "flagged") !== filters.flagged) return false;
  if (filters.since !== undefined && Date.parse(message.receivedAt) < Date.parse(filters.since)) return false;
  return true;
}
