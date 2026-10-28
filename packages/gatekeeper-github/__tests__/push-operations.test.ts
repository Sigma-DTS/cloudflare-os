import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  pushHash,
  pushPayload,
  pushReceipt,
  pushRequestKey,
  samePushContinuity,
  type PushOperationRecord,
} from "../src/push-operations";
import type { GitHubPushContinuity } from "../src/types";

const KEY = "123e4567-e89b-12d3-a456-426614174000";
const COMMIT = "a".repeat(40);
const CONTINUITY: GitHubPushContinuity = {
  version: 1,
  facet: "facet-a",
  grant: "grant-a",
  repositoryId: 123,
};

describe("push operation helpers", () => {
  it("accepts lowercase UUID keys and refuses malformed or noncanonical keys", () => {
    expect(pushRequestKey(KEY)).toBe(KEY);
    for (const value of ["", "not-a-uuid", KEY.toUpperCase(), "123e4567e89b12d3a456426614174000"]) {
      expect(() => pushRequestKey(value)).toThrow("lowercase UUID");
    }
  });

  it("requires a valid branch name and a full commit id", () => {
    expect(() => pushPayload({ branch: "main", commitId: COMMIT })).not.toThrow();
    for (const branch of ["", "bad branch", "bad..name", "/leading", "trailing/"]) {
      expect(() => pushPayload({ branch, commitId: COMMIT })).toThrow();
    }
    for (const commitId of ["", "abc", "g".repeat(40), "a".repeat(64)]) {
      expect(() => pushPayload({ branch: "main", commitId })).toThrow("full commit id");
    }
  });

  it("canonicalizes omitted force and object property order", () => {
    const expected = JSON.stringify({ version: 1, branch: "main", commitId: COMMIT, force: false });
    expect(pushPayload({ branch: "main", commitId: COMMIT })).toBe(expected);
    expect(pushPayload({ commitId: COMMIT, force: false, branch: "main" })).toBe(expected);
    expect(pushPayload({ branch: "main", commitId: COMMIT, force: true })).toBe(
      JSON.stringify({ version: 1, branch: "main", commitId: COMMIT, force: true }),
    );
  });

  it("returns a SHA-256 digest matching an independent implementation", async () => {
    const input = "push metadata and canonical payload";
    expect(await pushHash(input)).toBe(createHash("sha256").update(input).digest("hex"));
  });

  it("compares every continuity dimension", () => {
    expect(samePushContinuity(CONTINUITY, { ...CONTINUITY })).toBe(true);
    for (const changed of [
      { ...CONTINUITY, version: 2 as 1 },
      { ...CONTINUITY, facet: "facet-b" },
      { ...CONTINUITY, grant: "grant-b" },
      { ...CONTINUITY, repositoryId: 456 },
    ]) {
      expect(samePushContinuity(CONTINUITY, changed)).toBe(false);
    }
  });

  it("projects only the public receipt fields", () => {
    const privateRecord = {
      version: 1 as const,
      id: "operation-id",
      requestKey: KEY,
      state: "failed" as const,
      failure: "scope-changed" as const,
      payload: `branch=secret-branch token=secret-token`,
      digest: "private-digest",
      expected: CONTINUITY,
      generation: "private-generation",
      actionId: 991,
      effectStarted: true,
      diagnostic: "provider echoed private response",
    } as PushOperationRecord & { diagnostic: string };

    const receipt = pushReceipt(privateRecord);
    expect(receipt).toEqual({
      version: 1,
      id: "operation-id",
      requestKey: KEY,
      state: "failed",
      failure: "scope-changed",
    });
    expect(Object.keys(receipt).toSorted()).toEqual(["failure", "id", "requestKey", "state", "version"]);
    expect(JSON.stringify(receipt)).not.toMatch(/secret|private|provider echoed/);
  });
});
