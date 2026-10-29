import { RpcStub, RpcTarget } from "cloudflare:workers";
import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, it, vi } from "vitest";
import { stageCredentials } from "@gadgets/gatekeeper-kit/credential-stage";
import type { ActionDescription } from "@gadgets/workshop-shared/gatekeeper";
import type { GitHubDeliveryCommand, GitHubPushContinuity } from "../../src/types";
import type { GatekeeperProps, Outcome, UserAccount as FixtureUserAccount } from "./worker";

class Cache extends RpcTarget {
  constructor(readonly binding = 1) { super(); }
  async getBindingId() { return this.binding; }
}
class Queue extends RpcTarget {
  submitted: { id: number; description: ActionDescription }[] = [];
  loseAck = false;
  denyObservation = false;
  onSubmit?: (id: number) => Promise<void>;
  constructor(readonly cache = new Cache()) { super(); }
  async getGitCache() { return this.cache; }
  async authorizeObservation() { if (this.denyObservation) throw Error("Fixture observation denied"); }
  async submitAction(id: number, description: ActionDescription) { this.submitted.push({ id, description }); await this.onSubmit?.(id); if (this.loseAck) throw Error("Fixture queue acknowledgement lost"); }
}
function stub(target: RpcTarget): never { return new RpcStub(target) as never; }
async function unwrap<T>(pending: Promise<Outcome<T>>): Promise<T> { const result = await pending; if ("error" in result) throw Error(result.error); return result.ok; }

async function fixture() {
  const name = crypto.randomUUID(), account = env.USER_ACCOUNT.newUniqueId();
  await runInDurableObject(env.USER_ACCOUNT.get(account), (_instance, state) => { state.storage.kv.put("accessToken", "fixture-token"); });
  const props: GatekeeperProps = { userObjectId: account.toString(), resourceKind: "repo", owner: "acme", repo: "widgets" };
  const hooks = env.TEST_HOOKS.getByName(name), queue = new Queue();
  return {
    account, queue,
    copy: () => unwrap(hooks.copyPublicationFacet(name, `${name}-clone`, props)),
    copiedStatus: (key: string, q = queue) => unwrap(hooks.deliveryStatus(`${name}-clone`, props, stub(q), key)),
    copiedApply: (id: number, cache = queue.cache) => unwrap(hooks.applyAction(`${name}-clone`, props, id, stub(cache))),
    continuity: (q = queue) => unwrap(hooks.publicationContinuity(name, props, stub(q))),
    submit: (key: string, command: GitHubDeliveryCommand, expected: GitHubPushContinuity, q = queue) => unwrap(hooks.deliverySubmit(name, props, stub(q), key, command, expected)),
    status: (key: string, q = queue) => unwrap(hooks.deliveryStatus(name, props, stub(q), key)),
    apply: (id: number, cache = queue.cache) => unwrap(hooks.applyAction(name, props, id, stub(cache))),
    reject: (id: number) => unwrap(hooks.rejectAction(name, props, id)),
    restart: () => hooks.restartGatekeeper(name),
  };
}

const key = "00000000-0000-0000-0000-000000000001";
function provider() {
  const mutations: string[] = [];
  let loseReply = false, denyIdentity = false, repoUnavailable = false, repositoryId = 123;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const path = url.pathname.replace(/^\/repositories\/123(?=\/|$)/, "/repos/acme/widgets");
    if (path === "/repos/acme/widgets" && repoUnavailable) return Response.json({ message: "Private fixture provider diagnostic" }, { status: 503 });
    if (path === "/repos/acme/widgets") return Response.json({ id: repositoryId, name: "widgets", full_name: "acme/widgets", owner: { login: "acme" }, default_branch: "main" });
    if (path.startsWith("/repos/acme/widgets/git/ref/heads/")) return Response.json({ object: { sha: "a".repeat(40) } });
    if (init?.method === "POST") {
      mutations.push(url.pathname);
      if (loseReply) throw Error("Fixture lost provider acknowledgement with private body");
      if (path.endsWith("/comments")) return Response.json({ id: 456 });
      if (path.endsWith("/reviews")) return Response.json({ id: 789 });
      if (path === "/graphql") return Response.json({ data: { markPullRequestReadyForReview: { pullRequest: { id: "PR_native", number: 42, isDraft: false } } } });
      if (path.endsWith("/pulls")) return Response.json({ number: 42 });
    }
    if (path === "/repos/acme/widgets/pulls/42" && denyIdentity) return Response.json({ message: "Private fixture provider diagnostic" }, { status: 503 });
    if (path === "/repos/acme/widgets/pulls/42") return Response.json({ number: 42, node_id: "PR_native" });
    return Response.json({ message: "Fixture unexpected request" }, { status: 599 });
  });
  return { mutations, failRepositoryRead() { repoUnavailable = true; }, denyIdentity() { denyIdentity = true; }, replaceRepository() { repositoryId = 999; }, loseReply() { loseReply = true; } };
}
afterEach(() => vi.unstubAllGlobals());

it.each([
  [{ kind: "createPullRequest", options: { title: "Title", head: "feature", base: "main", draft: true } }, { repositoryId: 123, pullRequestId: "42" }],
  [{ kind: "postComment", pullRequestId: "42", bodyMarkdown: "Private comment" }, { repositoryId: 123, pullRequestId: "42", commentId: "456" }],
  [{ kind: "postReview", pullRequestId: "42", review: { revision: { baseSha: "a".repeat(40), headSha: "b".repeat(40) }, decision: "approve", bodyMarkdown: "Private review" } }, { repositoryId: 123, pullRequestId: "42", reviewId: "789" }],
  [{ kind: "markReady", pullRequestId: "42" }, { repositoryId: 123, pullRequestId: "42", readyNodeId: "PR_native" }],
] as const)("reconciles one original %s action and records its real provider identity", async (command, resource) => {
  const remote = provider(), f = await fixture(), expected = await f.continuity();
  const receipt = await f.submit(key, command as GitHubDeliveryCommand, expected);
  expect(receipt.state).toBe("pending"); expect(remote.mutations).toEqual([]);
  const same = await f.submit(key, command as GitHubDeliveryCommand, expected);
  expect(same.id).toBe(receipt.id); expect(f.queue.submitted).toHaveLength(1);
  if (command.kind === "markReady" || command.kind === "postReview") expect(f.queue.submitted[0]!.description.autoApprovable).toBe(false);
  await f.apply(receipt.actionId!); await f.apply(receipt.actionId!);
  expect(remote.mutations).toHaveLength(1);
  if (command.kind !== "markReady") expect(remote.mutations[0]).toMatch(/^\/repositories\/123\//);
  expect(await f.status(key)).toMatchObject({ state: "applied", resource });
  expect(JSON.stringify(await f.status(key))).not.toMatch(/Private|fixture-token/);
});

it.each(["postComment", "createPullRequest"] as const)("keeps a lost original %s submission reconcilable after restart without another queue action", async kind => {
  const remote = provider(), f = await fixture(), expected = await f.continuity(); f.queue.loseAck = true;
  const command: GitHubDeliveryCommand = kind === "postComment" ? { kind, pullRequestId: "42", bodyMarkdown: "Comment" } : { kind, options: { title: "Title", head: "feature", base: "main", draft: true } };
  const receipt = await f.submit(key, command, expected);
  expect(receipt.state).toBe("uncertain");
  await f.restart();
  expect((await f.submit(key, command, expected)).id).toBe(receipt.id);
  expect(f.queue.submitted).toHaveLength(1); expect(remote.mutations).toEqual([]);
  await f.apply(receipt.actionId!);
  expect((await f.status(key))?.state).toBe("applied");
});

it("does not replay an unknown provider effect or discard it as unapplied", async () => {
  const remote = provider(), f = await fixture(), expected = await f.continuity();
  const receipt = await f.submit(key, { kind: "postComment", pullRequestId: "42", bodyMarkdown: "Comment" }, expected);
  remote.loseReply();
  await expect(f.apply(receipt.actionId!)).rejects.toThrow("uncertain");
  await f.restart();
  expect((await f.status(key))?.state).toBe("uncertain");
  await expect(f.apply(receipt.actionId!)).rejects.toThrow();
  await expect(f.reject(receipt.actionId!)).rejects.toThrow();
  expect(remote.mutations).toHaveLength(1);
});


it("binds concurrent and changed submissions to one canonical argument digest", async () => {
  const remote = provider(), f = await fixture(), expected = await f.continuity();
  const command = { kind: "createPullRequest", options: { title: "Title", head: "feature", base: "main" } } as const;
  const receipts = await Promise.all([f.submit(key, command, expected), f.submit(key, { kind: "createPullRequest", options: { base: "main", head: "feature", title: "Title", draft: false, bodyMarkdown: "" } }, expected)]);
  expect(receipts[0].id).toBe(receipts[1].id);
  expect(receipts.every(receipt => /^[a-f0-9]{64}$/.test(receipt.digest))).toBe(true);
  expect(f.queue.submitted).toHaveLength(1); expect(remote.mutations).toEqual([]);
  await expect(f.submit(key, { ...command, options: { ...command.options, title: "Changed" } }, expected)).rejects.toThrow("reused");
  await expect(f.submit(key, command, { ...expected, grant: "another" })).rejects.toThrow("reused");
});

it("refuses copied storage, sibling bindings and a replaced repository before any effect", async () => {
  const remote = provider(), f = await fixture(), expected = await f.continuity();
  const receipt = await f.submit(key, { kind: "postComment", pullRequestId: "42", bodyMarkdown: "Comment" }, expected);
  await f.copy();
  const sibling = new Queue(new Cache(2));
  await expect(f.copiedStatus(key, sibling)).rejects.toThrow("unavailable for this continuity");
  await expect(f.copiedApply(receipt.actionId!, sibling.cache)).rejects.toThrow("authorization changed");
  await expect(f.status(key, sibling)).rejects.toThrow("unavailable for this continuity");
  await expect(f.apply(receipt.actionId!, sibling.cache)).rejects.toThrow("authorization changed");
  expect(remote.mutations).toEqual([]);
  const another = await fixture(), anotherExpected = await another.continuity();
  const otherReceipt = await another.submit(key, { kind: "markReady", pullRequestId: "42" }, anotherExpected);
  remote.replaceRepository();
  await expect(another.apply(otherReceipt.actionId!)).rejects.toThrow("unavailable before application");
  expect(remote.mutations).toEqual([]);
});

it("does not overwrite an original approval that applies before queue acknowledgement", async () => {
  const remote = provider(), f = await fixture(), expected = await f.continuity();
  f.queue.onSubmit = id => f.apply(id);
  const receipt = await f.submit(key, { kind: "postComment", pullRequestId: "42", bodyMarkdown: "Comment" }, expected);
  expect(receipt.state).toBe("applied"); expect(receipt.resource?.commentId).toBe("456");
  expect(remote.mutations).toHaveLength(1);
  await f.restart();
  expect((await f.status(key))?.state).toBe("applied");
});

it("requires native observation authorization for receipt reads and preserves rejection", async () => {
  provider(); const f = await fixture(), expected = await f.continuity();
  const receipt = await f.submit(key, { kind: "markReady", pullRequestId: "42" }, expected);
  await f.reject(receipt.actionId!);
  expect((await f.status(key))?.state).toBe("rejected");
  await expect(f.apply(receipt.actionId!)).rejects.toThrow("discarded");
  f.queue.denyObservation = true;
  await expect(f.status(key)).rejects.toThrow("observation denied");
});


it("fences the original pending authorization after native confirmed reconnect", async () => {
  const remote = provider(), f = await fixture(), expected = await f.continuity();
  const receipt = await f.submit(key, { kind: "postComment", pullRequestId: "42", bodyMarkdown: "Comment" }, expected);
  const account = env.USER_ACCOUNT.get(f.account);
  const stage = await runInDurableObject(account, (_instance, state) => stageCredentials(state.storage.kv, { accessToken: "fixture-new-token", scopes: ["repo"] }, Date.now()));
  await account.commitReconnect(stage);
  const current = await f.continuity();
  expect(current.facet).toBe(expected.facet); expect(current.grant).not.toBe(expected.grant);
  await expect(f.apply(receipt.actionId!)).rejects.toThrow("authorization changed");
  await expect(f.status(key)).rejects.toThrow("unavailable for this continuity");
  expect(remote.mutations).toEqual([]);
});

it("serializes the original in-flight mutation and refuses rejection while its result is outstanding", async () => {
  const remote = provider(), f = await fixture(), expected = await f.continuity();
  const receipt = await f.submit(key, { kind: "postComment", pullRequestId: "42", bodyMarkdown: "Comment" }, expected);
  const account = env.USER_ACCOUNT.get(f.account) as DurableObjectStub<FixtureUserAccount>;
  await account.holdNextAccessToken();
  const applying = f.apply(receipt.actionId!); await account.waitForHeldAccessToken();
  try {
    expect((await f.status(key))?.state).toBe("applying");
    await expect(f.apply(receipt.actionId!)).rejects.toThrow("not replayable");
    await expect(f.reject(receipt.actionId!)).rejects.toThrow("in-flight");
  } finally { await account.releaseAccessToken(); await applying; }
  expect((await f.status(key))?.state).toBe("applied"); expect(remote.mutations).toHaveLength(1);
});


it("records a pre-send identity-read failure without an uncertain provider effect", async () => {
  const remote = provider(), f = await fixture(), expected = await f.continuity();
  const receipt = await f.submit(key, { kind: "markReady", pullRequestId: "42" }, expected);
  remote.denyIdentity();
  await expect(f.apply(receipt.actionId!)).rejects.toThrow("failed before sending");
  expect(await f.status(key)).toMatchObject({ state: "failed" });
  expect(JSON.stringify(await f.status(key))).not.toMatch(/Private|diagnostic/);
  expect(remote.mutations).toEqual([]);
});

it("refuses provisional identifiers and oversized arguments before durable action allocation", async () => {
  const remote = provider(), f = await fixture(), expected = await f.continuity();
  await expect(f.submit(key, { kind: "postComment", pullRequestId: "~1", bodyMarkdown: "Comment" }, expected)).rejects.toThrow("real pull request number");
  await expect(f.submit(key, { kind: "postComment", pullRequestId: "42", bodyMarkdown: "x".repeat(65536) }, expected)).rejects.toThrow("too large");
  expect(await f.status(key)).toBeNull(); expect(f.queue.submitted).toEqual([]); expect(remote.mutations).toEqual([]);
});


it("cannot admit another native account using the first account's persisted witness", async () => {
  const remote = provider(), first = await fixture(), second = await fixture();
  const receipt = await second.submit(key, { kind: "markReady", pullRequestId: "42" }, await first.continuity());
  expect(receipt).toMatchObject({ state: "failed", failure: "scope-changed" });
  expect(receipt.actionId).toBeUndefined(); expect(second.queue.submitted).toEqual([]); expect(remote.mutations).toEqual([]);
});

it("recovers a durable application claim interrupted before send through only its original action", async () => {
  const remote = provider(), f = await fixture(), expected = await f.continuity();
  const receipt = await f.submit(key, { kind: "postComment", pullRequestId: "42", bodyMarkdown: "Comment" }, expected);
  const account = env.USER_ACCOUNT.get(f.account) as DurableObjectStub<FixtureUserAccount>;
  await account.holdNextAccessToken();
  const applying = f.apply(receipt.actionId!).then(() => "applied", () => "interrupted");
  await account.waitForHeldAccessToken();
  await f.restart(); await account.releaseAccessToken();
  expect(await applying).toBe("interrupted");
  expect((await f.status(key))?.state).toBe("uncertain");
  expect(remote.mutations).toEqual([]);
  await f.apply(receipt.actionId!);
  expect((await f.status(key))?.state).toBe("applied");
  expect(remote.mutations).toHaveLength(1); expect(f.queue.submitted).toHaveLength(1);
});


it("does not expose provider diagnostics while reconciling an existing key", async () => {
  const remote = provider(), f = await fixture(), expected = await f.continuity();
  const command = { kind: "postComment", pullRequestId: "42", bodyMarkdown: "Comment" } as const;
  await f.submit(key, command, expected);
  remote.failRepositoryRead();
  await expect(f.submit(key, command, expected)).rejects.toThrow("GitHub delivery operation is unavailable for this continuity.");
  await expect(f.status(key)).rejects.toThrow("GitHub delivery operation is unavailable for this continuity.");
  expect(remote.mutations).toEqual([]); expect(f.queue.submitted).toHaveLength(1);
});
