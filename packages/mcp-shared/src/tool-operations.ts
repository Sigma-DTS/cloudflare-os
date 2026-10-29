import type { McpToolContinuity, McpToolReceipt } from "./types.js";

function ordered(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(ordered);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, child]) => [key, ordered(child)]),
    );
  return value;
}

/** Durable argument binding independent of JSON property insertion order. */
export function toolPayload(name: string, args: Record<string, unknown>): string {
  const serialized = JSON.stringify({ name, args });
  if (new TextEncoder().encode(serialized).length > 64 * 1024)
    throw Error("MCP tool arguments are too large.");
  return JSON.stringify(ordered(JSON.parse(serialized)));
}

/** Rejects semantic key misuse before allocating an original native action. */
export function toolRequestKey(key: string): string {
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(key))
    throw Error("A tool request key must be a lowercase UUID.");
  return key;
}

/** Compares producer witnesses; the fields themselves never grant authority. */
export function sameToolContinuity(a: McpToolContinuity, b: McpToolContinuity): boolean {
  return (
    a.version === b.version &&
    a.facet === b.facet &&
    a.grant === b.grant &&
    a.resource === b.resource
  );
}

/** Hashes native scope metadata and canonical payloads without exposing credentials. */
export async function toolHash(value: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Private original-action index; the approval queue remains the only executor. */
export interface ToolOperation extends McpToolReceipt {
  payload: string;
  expected: McpToolContinuity;
  generation: number;
  resultRetained?: boolean;
  resultDigest?: string;
  effectStarted?: boolean;
}

/** Whitelist projection excludes command arguments, results and provider diagnostics. */
export function toolReceipt(record: ToolOperation): McpToolReceipt {
  return {
    version: 1,
    id: record.id,
    requestKey: record.requestKey,
    digest: record.digest,
    actionId: record.actionId,
    state: record.state,
    ...(record.state === "applied" ? { resultAvailable: record.resultRetained === true } : {}),
  };
}
