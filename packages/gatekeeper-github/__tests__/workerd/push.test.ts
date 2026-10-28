// The push action's queue/simulate/apply/revert flow, driven against the real
// `GitHubGatekeeperImpl` Durable Object (instantiated with props through the TestHooks facet, the
// way the overseer does) with GitHub itself faked at the `fetch` boundary and the workspace git
// cache faked at the `GitCache` stub boundary. What this file guards, per plans/worktrees.md §3:
//
// - Queue time binds the expected remote ref state (simulated head, so stacked pushes compose),
//   short-circuits a push whose desired state already holds, and fails a non-force
//   non-fast-forward *before anything is queued*.
// - Simulation: `listBranches`/`getCommit` read the pending push as if it had already landed.
// - Apply is a send-pack whose old-sha is the queue-time expectation (CAS for force and non-force
//   alike), with desired-state idempotency: the branch already being at `newSha` is success.
// - Revert rolls the ref back (or deletes a created branch), CAS'd from the pushed commit.

import { RpcStub, RpcTarget } from "cloudflare:workers";
import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActionDescription, GitObjectType, GitOid }
  from "@gadgets/workshop-shared/gatekeeper";
import { stageCredentials } from "@gadgets/gatekeeper-kit/credential-stage";
import { FLUSH_PKT, ZERO_OID, encodePktLine, pktText } from "@gadgets/gatekeeper-kit/git-transport";
import type { GitHubCreatePullRequestOptions, GitHubPushCommand, GitHubPushContinuity } from "../../src/types";
import type { CreatePullRequestActionData, GatekeeperProps, Outcome, PushActionData, UserAccount } from "./worker";

const OWNER = "acme";
const REPO = "widgets";
const API_BASE = `https://api.github.com/repos/${OWNER}/${REPO}`;
const RECEIVE_PACK_URL = `https://github.com/${OWNER}/${REPO}.git/git-receive-pack`;

/** Deterministic fake full commit ids. */
const BASE = "a".repeat(40);   // the branch head the work was based on
const HEAD1 = "b".repeat(40);  // first agent-authored commit
const HEAD2 = "c".repeat(40);  // second agent-authored commit, child of HEAD1
const OTHER = "d".repeat(40);  // an unrelated head the remote may move to
const TREE = "e".repeat(40);

const PACK_BYTES = new TextEncoder().encode("PACK-STAND-IN");

function commitPayload(parents: string[], message: string): Uint8Array {
  return new TextEncoder().encode([
    `tree ${TREE}`,
    ...parents.map(parent => `parent ${parent}`),
    "author Ada Lovelace <ada@example.com> 1700000000 +0000",
    "committer Ada Lovelace <ada@example.com> 1700000100 +0000",
    "",
    `${message}\n`,
  ].join("\n"));
}

/**
 * Stands in for the workspace git cache. Ancestry is declared per test as (ancestor, descendant)
 * pairs over *cached* history, commit bytes are served for simulation reads, and `buildPack()`
 * returns stand-in bytes the receive-pack capture can assert on.
 */
class TestGitCache extends RpcTarget {
  constructor(readonly bindingId = 0) { super(); }
  async getBindingId(): Promise<number> { return this.bindingId; }
  onBuildPack: (() => Promise<void>) | undefined;
  readonly commits = new Map<GitOid, Uint8Array>();
  readonly ancestries = new Set<string>();

  withCommit(oid: GitOid, payload: Uint8Array): this {
    this.commits.set(oid, payload);
    return this;
  }

  /** Declare that `ancestor` is an ancestor of `descendant` (and that `descendant` is cached). */
  withAncestry(ancestor: GitOid, descendant: GitOid): this {
    this.ancestries.add(`${ancestor}:${descendant}`);
    this.commits.set(descendant, this.commits.get(descendant) ?? commitPayload([ancestor], "x"));
    return this;
  }

  async isAncestor(ancestor: GitOid, descendant: GitOid): Promise<boolean> {
    if (!this.commits.has(descendant)) {
      throw new Error(
        `Cannot check ancestry: ${descendant} is not a commit in the workspace's git cache.`);
    }
    return ancestor === descendant || this.ancestries.has(`${ancestor}:${descendant}`);
  }

  async get(id: GitOid): Promise<{ type: GitObjectType, content: Uint8Array } | null> {
    const payload = this.commits.get(id);
    return payload === undefined ? null : { type: "commit", content: payload };
  }

  async buildPack(): Promise<ReadableStream<Uint8Array>> {
    await this.onBuildPack?.();
    return new ReadableStream({
      start(controller) {
        controller.enqueue(PACK_BYTES);
        controller.close();
      },
    });
  }
}

/** One captured `fetch` exchange with the fake GitHub. */
type ReceivePackExchange = { body: Uint8Array };

/**
 * Fakes GitHub at the fetch boundary: the REST endpoints the push flow reads (branch head, branch
 * list, commit lookup) and the git-receive-pack endpoint (captured; responses are enqueued by the
 * test). Installed with `vi.stubGlobal`, which reaches the gatekeeper because the whole workerd
 * suite -- runner, hook DO, and facets -- shares one isolate.
 */
class FakeGitHub {
  readonly branches = new Map<string, string>();  // branch name → head commit id
  readonly restCommits = new Map<string, { sha: string, message: string }>();  // ref → commit
  readonly receivePackExchanges: ReceivePackExchange[] = [];
  readonly receivePackResponses: Uint8Array[] = [];
  defaultBranch = "main";
  repositoryId = 12345;
  applyRefUpdates = false;
  refReadUnavailable = false;
  mutations = 0;
  onMutation: (() => Promise<void>) | undefined;
  oauthResponse: Record<string, unknown> = { access_token: "test-token-refreshed", refresh_token: "test-refresh-next", expires_in: 28_800, refresh_token_expires_in: 15_897_600, scope: "repo", token_type: "bearer" };

  install(): void {
    vi.stubGlobal("fetch", this.#handle.bind(this));
  }

  respondToPush(...lines: string[]): void {
    const pieces = [...lines.map(encodePktLine), FLUSH_PKT];
    const out = new Uint8Array(pieces.reduce((total, piece) => total + piece.byteLength, 0));
    let offset = 0;
    for (const piece of pieces) {
      out.set(piece, offset);
      offset += piece.byteLength;
    }
    this.receivePackResponses.push(out);
  }

  async #handle(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = new URL(typeof input === "string" ? input : (input as Request).url ?? String(input));
    const path = url.origin + url.pathname;

    if (path === "https://github.com/login/oauth/access_token") return Response.json(this.oauthResponse);
    if (path === "https://api.github.com/user") return Response.json({ id: 1, login: "fixture-user" });
    if (path === RECEIVE_PACK_URL) {
      const body = new Uint8Array(await new Response(init?.body as BodyInit).arrayBuffer());
      this.receivePackExchanges.push({ body });
      if (this.applyRefUpdates) {
        const command = splitPushRequest(body).commands[0].split("\0")[0];
        const [oldSha, newSha, ref] = command.split(" "); const branch = ref.slice("refs/heads/".length);
        const accepted = (this.branches.get(branch) ?? ZERO_OID) === oldSha;
        if (accepted) { this.branches.set(branch, newSha); this.mutations++; await this.onMutation?.(); }
        return new Response(new Uint8Array([...encodePktLine("unpack ok"), ...encodePktLine(accepted ? `ok ${ref}` : `ng ${ref} old sha mismatch`), ...FLUSH_PKT]));
      }
      const response = this.receivePackResponses.shift();
      if (!response) throw new Error("test: unexpected receive-pack request");
      return new Response(response, {
        headers: { "Content-Type": "application/x-git-receive-pack-result" },
      });
    }

    if (path.startsWith(`${API_BASE}/git/ref/heads/`)) {
      if (this.refReadUnavailable) return Response.json({ message: "fixture unavailable" }, { status: 503 });
      const name = decodeURIComponent(path.slice(`${API_BASE}/git/ref/heads/`.length));
      const head = this.branches.get(name);
      if (head === undefined) {
        return Response.json({ message: "Not Found" }, { status: 404 });
      }
      return Response.json({ ref: `refs/heads/${name}`, object: { sha: head, type: "commit" } });
    }

    if (path === `${API_BASE}/branches`) {
      const data = [...this.branches.entries()].map(([name, sha]) =>
        ({ name, commit: { sha }, protected: false }));
      return Response.json(data);
    }

    if (path.startsWith(`${API_BASE}/commits/`)) {
      const ref = decodeURIComponent(path.slice(`${API_BASE}/commits/`.length));
      const fromBranch = this.branches.get(ref);
      const commit = this.restCommits.get(ref)
        ?? (fromBranch !== undefined ? { sha: fromBranch, message: `rest ${ref}` } : undefined);
      if (commit === undefined) {
        // Like GitHub: an unknown full commit id answers 422 ("No commit found for SHA"); only
        // an unknown branch/tag name answers 404.
        if (/^[0-9a-f]{40}$/.test(ref)) {
          return Response.json({ message: `No commit found for SHA: ${ref}` }, { status: 422 });
        }
        return Response.json({ message: "Not Found" }, { status: 404 });
      }
      // The `sha` media type answers with the bare commit id as text, like GitHub does.
      if (new Headers(init?.headers).get("Accept") === "application/vnd.github.sha") {
        return new Response(commit.sha, {
          headers: { "Content-Type": "application/vnd.github.sha" },
        });
      }
      return Response.json({
        sha: commit.sha,
        html_url: `https://github.com/${OWNER}/${REPO}/commit/${commit.sha}`,
        commit: { message: commit.message, author: null, committer: null },
        author: null,
        parents: [],
      });
    }

    if (path === API_BASE) {
      return Response.json({
        id: this.repositoryId,
        name: REPO,
        full_name: `${OWNER}/${REPO}`,
        html_url: `https://github.com/${OWNER}/${REPO}`,
        description: null,
        visibility: "public",
        default_branch: this.defaultBranch,
        owner: { login: OWNER, html_url: `https://github.com/${OWNER}` },
      });
    }

    throw new Error(`test: unexpected fetch to ${url}`);
  }
}

/** Records what the gatekeeper submits, standing in for the overseer's approval queue. */
class TestApprovalQueue extends RpcTarget {
  constructor(readonly cache: RpcTarget = new TestGitCache()) { super(); }
  async getGitCache(): Promise<RpcTarget> { return this.cache; }
  readonly observations: string[] = [];
  denyObservation = false;
  loseAcknowledgement = false;
  onSubmit: ((action: number) => Promise<void>) | undefined;
  readonly submitted: { action: number, description: ActionDescription }[] = [];

  async authorizeObservation(description: { title: string }): Promise<void> {
    if (this.denyObservation) throw new Error("Fixture observation denied");
    this.observations.push(description.title);
  }

  async submitAction(action: number, description: ActionDescription): Promise<void> {
    this.submitted.push({ action, description });
    await this.onSubmit?.(action);
    if (this.loseAcknowledgement) throw new Error("Fixture native queue acknowledgement lost");
  }
}

let nextScenario = 0;

// Fresh stubs per call: a stub passed as an RPC argument is disposed when the call returns.
function stubOf(target: TestGitCache | TestApprovalQueue): never {
  return new RpcStub(target) as never;
}

/** Rethrows a forwarded failure locally (see `Outcome` in worker.ts). */
async function unwrap<T>(pending: Promise<Outcome<T>>): Promise<T> {
  const result = await pending;
  if ("error" in result) throw new Error(result.error);
  return result.ok;
}

/**
 * A fresh gatekeeper facet (repo-scoped) backed by a token-bearing user account, driven through
 * TestHooks (a facet stub cannot ride back to the test, so every call forwards through the hook
 * DO). Methods mirror the gatekeeper's, with the test's fakes wrapped into stubs per call.
 */
async function repoGatekeeper(existingAccount?: DurableObjectId) {
  const scenario = `push-${nextScenario++}`;
  const accountId = existingAccount ?? env.USER_ACCOUNT.newUniqueId();
  if (!existingAccount) await runInDurableObject(env.USER_ACCOUNT.get(accountId), async (_instance, state) => {
    state.storage.kv.put("accessToken", "test-token");
  });
  const props: GatekeeperProps = {
    userObjectId: accountId.toString(),
    resourceKind: "repo",
    owner: OWNER,
    repo: REPO,
  };
  const hooks = env.TEST_HOOKS.getByName(scenario);
  return {
    accountId,
    copyFacet: () => unwrap(hooks.copyPublicationFacet(scenario, `${scenario}-clone`, props)),
    copiedContinuity: (queue: TestApprovalQueue) => unwrap(hooks.publicationContinuity(`${scenario}-clone`, props, stubOf(queue))),
    copiedOperation: (queue: TestApprovalQueue, key: string) => unwrap(hooks.publicationStatus(`${scenario}-clone`, props, stubOf(queue), key)),
    copiedApply: (action: number, cache: TestGitCache) => unwrap(hooks.applyAction(`${scenario}-clone`, props, action, stubOf(cache))),
    restart: () => hooks.restartGatekeeper(scenario),
    continuity: (queue: TestApprovalQueue) => unwrap(hooks.publicationContinuity(scenario, props, stubOf(queue))),
    submit: (queue: TestApprovalQueue, key: string, command: GitHubPushCommand, expected: GitHubPushContinuity) => unwrap(hooks.publicationSubmit(scenario, props, stubOf(queue), key, command, expected)),
    operation: (queue: TestApprovalQueue, key: string) => unwrap(hooks.publicationStatus(scenario, props, stubOf(queue), key)),
    preparePush: (branch: string, commitId: string, force: boolean, cache: TestGitCache) =>
      unwrap(hooks.preparePush(scenario, props, branch, commitId, force, stubOf(cache))),
    submitPush: (queue: TestApprovalQueue, action: PushActionData, description: ActionDescription) =>
      unwrap(hooks.submitPush(scenario, props, stubOf(queue), action, description)),
    prepareCreatePullRequest: (options: GitHubCreatePullRequestOptions) =>
      unwrap(hooks.prepareCreatePullRequest(scenario, props, options)),
    submitCreatePullRequest: (queue: TestApprovalQueue, action: CreatePullRequestActionData) =>
      unwrap(hooks.submitCreatePullRequest(scenario, props, stubOf(queue), action, { title: "Create dependent pull request", description: "Test dependent action", implementsRevert: false })),
    applyAction: (actionId: number, cache: TestGitCache) =>
      unwrap(hooks.applyAction(scenario, props, actionId, stubOf(cache))),
    rejectAction: (actionId: number) => unwrap(hooks.rejectAction(scenario, props, actionId)),
    revertAction: (actionId: number) => unwrap(hooks.revertAction(scenario, props, actionId)),
    listBranchesFirstPage: (pageSize: number) =>
      unwrap(hooks.listBranchesFirstPage(scenario, props, pageSize)),
    listBranchesFirstPageAfterReject: (pageSize: number, actionId: number) =>
      unwrap(hooks.listBranchesFirstPageAfterReject(scenario, props, pageSize, actionId)),
    listBranchesPagedRejectBetween: (actionId: number) =>
      unwrap(hooks.listBranchesPagedRejectBetween(scenario, props, actionId)),
    isSimulatedCommitId: (commitId: string) =>
      unwrap(hooks.isSimulatedCommitId(scenario, props, commitId)),
    getCommit: (ref: string | undefined, cache?: TestGitCache) =>
      unwrap(hooks.getCommit(scenario, props, ref, cache === undefined ? undefined : stubOf(cache))),
    resolveRef: (ref: string | undefined, cache?: TestGitCache) =>
      unwrap(hooks.resolveRef(scenario, props, ref, cache === undefined ? undefined : stubOf(cache))),
    repoMetadata: () => unwrap(hooks.repoMetadata(scenario, props)),
  };
}

type GatekeeperHandle = Awaited<ReturnType<typeof repoGatekeeper>>;

/** preparePush + submitActionForApproval, the way the session's push() drives them. */
async function queuePush(
  gk: GatekeeperHandle, cache: TestGitCache, queue: TestApprovalQueue,
  branch: string, commitId: string, force = false,
) {
  const action = await gk.preparePush(branch, commitId, force, cache);
  if (action === null) return null;
  await gk.submitPush(queue, action, {
    title: `Push ${commitId.slice(0, 12)} to ${branch}`,
    description: "test push",
    pushedCommits: [commitId],
    implementsRevert: true,
  });
  return action;
}

/** The textual pkt-lines of a captured receive-pack request, plus the raw bytes after the flush. */
function splitPushRequest(body: Uint8Array): { commands: string[], pack: Uint8Array } {
  // The command block is pkt-lines up to the first flush; everything after is the raw pack.
  const commands: string[] = [];
  let offset = 0;
  while (offset < body.byteLength) {
    const length = parseInt(new TextDecoder().decode(body.subarray(offset, offset + 4)), 16);
    if (length === 0) {
      offset += 4;
      break;
    }
    commands.push(pktText(body.subarray(offset + 4, offset + length)));
    offset += length;
  }
  return { commands, pack: body.subarray(offset) };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("queue time", () => {
  it("binds the expected old head from the live branch and composes stacked pushes", async () => {
    const github = new FakeGitHub();
    github.branches.set("main", BASE);
    github.install();
    const gk = await repoGatekeeper();
    const queue = new TestApprovalQueue();
    const cache = new TestGitCache().withAncestry(BASE, HEAD1).withAncestry(HEAD1, HEAD2)
      .withAncestry(BASE, HEAD2);

    const first = await queuePush(gk, cache, queue, "main", HEAD1);
    expect(first).toMatchObject({ type: "push", expectedOldSha: BASE, newSha: HEAD1, force: false });

    // The second push binds to the first's newSha (the simulated head), not the live head, so
    // approving both in order applies cleanly.
    const second = await queuePush(gk, cache, queue, "main", HEAD2);
    expect(second).toMatchObject({ expectedOldSha: HEAD1, newSha: HEAD2 });
    expect(queue.submitted.map(s => s.description.pushedCommits)).toEqual([[HEAD1], [HEAD2]]);
  });

  it("returns null (queuing nothing) when the branch is already at the commit", async () => {
    const github = new FakeGitHub();
    github.branches.set("main", HEAD1);
    github.install();
    const gk = await repoGatekeeper();
    const queue = new TestApprovalQueue();
    const cache = new TestGitCache().withCommit(HEAD1, commitPayload([BASE], "x"));

    expect(await queuePush(gk, cache, queue, "main", HEAD1)).toBeNull();
    expect(queue.submitted).toEqual([]);
  });

  it("fails a non-force non-fast-forward before anything is queued", async () => {
    const github = new FakeGitHub();
    github.branches.set("main", OTHER);  // the branch moved past the head the work was based on
    github.install();
    const gk = await repoGatekeeper();
    const queue = new TestApprovalQueue();
    const cache = new TestGitCache().withAncestry(BASE, HEAD1);  // OTHER is not an ancestor

    await expect(queuePush(gk, cache, queue, "main", HEAD1))
      .rejects.toThrow(/not a fast-forward/);
    expect(queue.submitted).toEqual([]);

    // force skips only the fast-forward policy check; the CAS at apply still binds OTHER.
    const forced = await queuePush(gk, cache, queue, "main", HEAD1, true);
    expect(forced).toMatchObject({ expectedOldSha: OTHER, newSha: HEAD1, force: true });
  });

  it("exempts branch creation from the fast-forward check", async () => {
    const github = new FakeGitHub();
    github.install();  // no branches: "feature" does not exist
    const gk = await repoGatekeeper();
    const queue = new TestApprovalQueue();
    const cache = new TestGitCache().withCommit(HEAD1, commitPayload([BASE], "x"));

    const action = await queuePush(gk, cache, queue, "feature", HEAD1);
    expect(action).toMatchObject({ expectedOldSha: ZERO_OID, newSha: HEAD1, force: false });
  });
});

describe("simulation", () => {
  it("reads a branch with a queued push at the pushed head", async () => {
    const github = new FakeGitHub();
    github.branches.set("main", BASE);
    github.branches.set("other", OTHER);
    github.install();
    const gk = await repoGatekeeper();
    const cache = new TestGitCache().withAncestry(BASE, HEAD1)
      .withCommit(HEAD1, commitPayload([BASE], "feat: simulate me"));
    await queuePush(gk, cache, new TestApprovalQueue(), "main", HEAD1);

    const page = await gk.listBranchesFirstPage(50);
    expect(page).toContainEqual({ name: "main", headCommit: HEAD1, protected: false });
    expect(page).toContainEqual({ name: "other", headCommit: OTHER, protected: false });

    // getCommit on the branch resolves to the simulated head, synthesized from the cached bytes
    // -- and reports it as cache-served, so the session withholds advertisement.
    const { details, fromCache } = await gk.getCommit("main", cache);
    expect(fromCache).toBe(true);
    expect(details.id).toBe(HEAD1);
    expect(details.message).toBe("feat: simulate me");
    expect(details.author.name).toBe("Ada Lovelace");
    expect(details.parents).toEqual([BASE]);

    // A real remote read is not cache-served.
    expect((await gk.getCommit("other", cache)).fromCache).toBe(false);
  });

  it("injects a branch a queued push creates, standing in for its name", async () => {
    const github = new FakeGitHub();
    github.branches.set("main", BASE);
    github.install();
    const gk = await repoGatekeeper();
    const cache = new TestGitCache().withCommit(HEAD1, commitPayload([BASE], "x"));
    await queuePush(gk, cache, new TestApprovalQueue(), "feature", HEAD1);

    const page = await gk.listBranchesFirstPage(50);
    expect(page).toContainEqual({ name: "feature", headCommit: HEAD1, protected: false });
    expect(page?.filter(branch => branch.name === "feature")).toHaveLength(1);
  });

  it("drops an injected branch whose push was rejected before the page was drained, still withholding its head", async () => {
    const github = new FakeGitHub();
    github.branches.set("main", BASE);
    github.install();
    const gk = await repoGatekeeper();
    const cache = new TestGitCache().withCommit(HEAD1, commitPayload([BASE], "x"));
    const action = (await queuePush(gk, cache, new TestApprovalQueue(), "feature", HEAD1))!;

    // The cursor snapshots the injected branch at build time; the rejection lands before the
    // page is drained, so serving the snapshot would list a branch that will never exist.
    const page = await gk.listBranchesFirstPageAfterReject(50, action.approvalId);
    expect(page?.some(branch => branch.name === "feature")).toBe(false);

    // The head never reached GitHub, and it is no longer a pending push -- but advertising
    // callbacks must keep withholding it, or the rejected push's commit would be durably
    // recorded as pullable from this remote (misrouting pulls and shrinking later push packs).
    expect(await gk.isSimulatedCommitId(HEAD1)).toBe(true);
  });

  it("revalidates injected branches when served, not when buffered behind a small page", async () => {
    const github = new FakeGitHub();
    github.branches.set("main", BASE);
    github.install();
    const gk = await repoGatekeeper();
    const queue = new TestApprovalQueue();
    const cache = new TestGitCache()
      .withCommit(HEAD1, commitPayload([BASE], "x"))
      .withCommit(HEAD2, commitPayload([BASE], "y"));
    await queuePush(gk, cache, queue, "feat-a", HEAD1);
    const second = (await queuePush(gk, cache, queue, "feat-b", HEAD2))!;

    // Page size 1: the first page serves feat-a while feat-b sits buffered behind it; the
    // rejection lands between the pages, so the second page must drop the already-buffered
    // feat-b snapshot rather than serve a branch that will never exist.
    const pages = await gk.listBranchesPagedRejectBetween(second.approvalId);
    expect(pages.first).toEqual([{ name: "feat-a", headCommit: HEAD1, protected: false }]);
    expect(pages.second).toEqual([{ name: "main", headCommit: BASE, protected: false }]);
  });

  it("stops injecting a queued creation once the branch appears remotely", async () => {
    const github = new FakeGitHub();
    github.install();  // "feature" does not exist at queue time
    const gk = await repoGatekeeper();
    const cache = new TestGitCache().withCommit(HEAD1, commitPayload([BASE], "x"));
    await queuePush(gk, cache, new TestApprovalQueue(), "feature", HEAD1);

    // A third party creates the branch before approval: the queued creation's expectation is
    // invalidated (its zero-id CAS would fail at apply), so the listing must show the real
    // branch rather than hiding it behind the simulated one.
    github.branches.set("feature", OTHER);
    const page = await gk.listBranchesFirstPage(50);
    expect(page).toContainEqual({ name: "feature", headCommit: OTHER, protected: false });
    expect(page?.filter(branch => branch.name === "feature")).toHaveLength(1);
  });

  it("serves getCommit for a queued commit id GitHub does not know yet", async () => {
    const github = new FakeGitHub();
    github.branches.set("main", BASE);
    github.install();
    const gk = await repoGatekeeper();
    const cache = new TestGitCache().withAncestry(BASE, HEAD1)
      .withCommit(HEAD1, commitPayload([BASE], "pending"));
    await queuePush(gk, cache, new TestApprovalQueue(), "main", HEAD1);

    const { details, fromCache } = await gk.getCommit(HEAD1, cache);
    expect(fromCache).toBe(true);
    expect(details.id).toBe(HEAD1);
    expect(details.message).toBe("pending");
  });

  it("resolveRef maps a branch with a queued push to its simulated head", async () => {
    const github = new FakeGitHub();
    github.branches.set("main", BASE);
    github.branches.set("other", OTHER);
    github.install();
    const gk = await repoGatekeeper();
    const cache = new TestGitCache().withAncestry(BASE, HEAD1)
      .withCommit(HEAD1, commitPayload([BASE], "feat: simulate me"));
    await queuePush(gk, cache, new TestApprovalQueue(), "main", HEAD1);

    // Cache-served, so the session withholds advertisement (the commit is not on GitHub yet).
    expect(await gk.resolveRef("main", cache)).toEqual({ id: HEAD1, fromCache: true });
    // A real remote resolution is not cache-served.
    expect(await gk.resolveRef("other", cache)).toEqual({ id: OTHER, fromCache: false });
  });

  it("resolveRef confirms a queued commit id GitHub does not know yet", async () => {
    const github = new FakeGitHub();
    github.branches.set("main", BASE);
    github.install();
    const gk = await repoGatekeeper();
    const cache = new TestGitCache().withAncestry(BASE, HEAD1)
      .withCommit(HEAD1, commitPayload([BASE], "pending"));
    await queuePush(gk, cache, new TestApprovalQueue(), "main", HEAD1);

    expect(await gk.resolveRef(HEAD1, cache)).toEqual({ id: HEAD1, fromCache: true });
    // A commit neither GitHub nor the workspace git cache knows still fails (GitHub's unknown-id
    // answer is a 422, which must not be swallowed when the cache cannot serve the id either).
    await expect(gk.resolveRef(OTHER, cache)).rejects.toThrow(/No commit found for SHA/);
  });
});

describe("default branch", () => {
  it("reports the default branch in repo metadata and defaults getCommit/resolveRef to it", async () => {
    const github = new FakeGitHub();
    github.defaultBranch = "trunk";
    github.branches.set("trunk", BASE);
    github.restCommits.set("trunk", { sha: BASE, message: "tip of trunk" });
    github.install();
    const gk = await repoGatekeeper();

    expect((await gk.repoMetadata()).defaultBranch).toBe("trunk");
    expect(await gk.resolveRef(undefined)).toEqual({ id: BASE, fromCache: false });
    const { details } = await gk.getCommit(undefined);
    expect(details.id).toBe(BASE);
    expect(details.message).toBe("tip of trunk");
  });

  it("simulates a queued push to the default branch through an omitted ref", async () => {
    const github = new FakeGitHub();
    github.branches.set("main", BASE);
    github.install();
    const gk = await repoGatekeeper();
    const cache = new TestGitCache().withAncestry(BASE, HEAD1)
      .withCommit(HEAD1, commitPayload([BASE], "feat: simulate me"));
    await queuePush(gk, cache, new TestApprovalQueue(), "main", HEAD1);

    expect(await gk.resolveRef(undefined, cache)).toEqual({ id: HEAD1, fromCache: true });
    const { details, fromCache } = await gk.getCommit(undefined, cache);
    expect(fromCache).toBe(true);
    expect(details.id).toBe(HEAD1);
  });
});

describe("apply", () => {
  it("send-packs the built pack with the queue-time CAS and marks the action applied", async () => {
    const github = new FakeGitHub();
    github.branches.set("main", BASE);
    github.install();
    const gk = await repoGatekeeper();
    const cache = new TestGitCache().withAncestry(BASE, HEAD1);
    const action = (await queuePush(gk, cache, new TestApprovalQueue(), "main", HEAD1))!;

    github.respondToPush("unpack ok", "ok refs/heads/main");
    await gk.applyAction(action.approvalId, cache);

    expect(github.receivePackExchanges).toHaveLength(1);
    const { commands, pack } = splitPushRequest(github.receivePackExchanges[0].body);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatch(
      new RegExp(`^${BASE} ${HEAD1} refs/heads/main\0report-status agent=`));
    expect(pack).toEqual(PACK_BYTES);

    // A re-delivered apply (the overseer crashed before persisting its completion record) is
    // idempotent success: nothing is pushed again...
    await gk.applyAction(action.approvalId, cache);
    expect(github.receivePackExchanges).toHaveLength(1);
    // ...and the simulation overlay is gone (the branch reads at whatever GitHub reports).
    const page = await gk.listBranchesFirstPage(50);
    expect(page).toContainEqual({ name: "main", headCommit: BASE, protected: false });
  });

  it("fails with branch-moved guidance when the CAS is rejected", async () => {
    const github = new FakeGitHub();
    github.branches.set("main", BASE);
    github.install();
    const gk = await repoGatekeeper();
    const cache = new TestGitCache().withAncestry(BASE, HEAD1);
    const action = (await queuePush(gk, cache, new TestApprovalQueue(), "main", HEAD1))!;

    github.branches.set("main", OTHER);  // moved between approval and apply
    github.respondToPush("unpack ok", "ng refs/heads/main fetch first");
    await expect(gk.applyAction(action.approvalId, cache))
      .rejects.toThrow(/has moved from/);
  });

  it("fails the same way for a force push -- the CAS is not loosened", async () => {
    const github = new FakeGitHub();
    github.branches.set("main", OTHER);
    github.install();
    const gk = await repoGatekeeper();
    const cache = new TestGitCache().withAncestry(BASE, HEAD1);
    const action = (await queuePush(gk, cache, new TestApprovalQueue(), "main", HEAD1, true))!;
    expect(action.expectedOldSha).toBe(OTHER);

    github.branches.set("main", BASE);  // moved again after approval
    github.respondToPush("unpack ok", "ng refs/heads/main fetch first");
    await expect(gk.applyAction(action.approvalId, cache))
      .rejects.toThrow(/has moved from/);
  });

  it("fails a creation push whose branch appeared in the interim", async () => {
    const github = new FakeGitHub();
    github.install();
    const gk = await repoGatekeeper();
    const cache = new TestGitCache().withCommit(HEAD1, commitPayload([BASE], "x"));
    const action = (await queuePush(gk, cache, new TestApprovalQueue(), "feature", HEAD1))!;

    github.branches.set("feature", OTHER);  // created in the interim
    github.respondToPush("unpack ok", "ng refs/heads/feature reference already exists");
    await expect(gk.applyAction(action.approvalId, cache))
      .rejects.toThrow(/was created after this push was queued/);
  });

  it("passes GitHub's reason through when it refuses an update whose CAS held", async () => {
    const github = new FakeGitHub();
    github.branches.set("main", BASE);
    github.install();
    const gk = await repoGatekeeper();
    const cache = new TestGitCache().withAncestry(BASE, HEAD1);
    const action = (await queuePush(gk, cache, new TestApprovalQueue(), "main", HEAD1))!;

    github.respondToPush("unpack ok", "ng refs/heads/main protected branch hook declined");
    await expect(gk.applyAction(action.approvalId, cache))
      .rejects.toThrow("GitHub refused the push: protected branch hook declined");
  });

  it("names a discarded push as the reason a push stacked on it cannot apply", async () => {
    const github = new FakeGitHub();
    github.branches.set("main", BASE);
    github.install();
    const gk = await repoGatekeeper();
    const cache = new TestGitCache().withAncestry(BASE, HEAD1).withAncestry(HEAD1, HEAD2);
    const first = (await queuePush(gk, cache, new TestApprovalQueue(), "main", HEAD1))!;
    const stacked = (await queuePush(gk, cache, new TestApprovalQueue(), "main", HEAD2))!;
    expect(stacked.expectedOldSha).toBe(HEAD1);

    await gk.rejectAction(first.approvalId);
    github.respondToPush("unpack ok", "ng refs/heads/main fetch first");
    await expect(gk.applyAction(stacked.approvalId, cache))
      .rejects.toThrow(`it builds on ${HEAD1}, the head of a discarded push to "main"`);
  });

  it("treats the branch already being at newSha as success (desired state)", async () => {
    const github = new FakeGitHub();
    github.branches.set("main", BASE);
    github.install();
    const gk = await repoGatekeeper();
    const cache = new TestGitCache().withAncestry(BASE, HEAD1);
    const action = (await queuePush(gk, cache, new TestApprovalQueue(), "main", HEAD1))!;

    // Whether an earlier attempt landed it (crash between push and completion record) or a third
    // party pushed the identical commit: the approved end state holds, so apply succeeds.
    github.branches.set("main", HEAD1);
    github.respondToPush("unpack ok", "ng refs/heads/main fetch first");
    await gk.applyAction(action.approvalId, cache);

    // A re-delivered apply of the now-approved push succeeds without touching the remote, even
    // if the branch has moved on since (the fake would throw on an unexpected receive-pack).
    github.branches.set("main", OTHER);
    await gk.applyAction(action.approvalId, cache);
    expect(github.receivePackExchanges).toHaveLength(1);
  });
});

describe("revert", () => {
  it("rolls the branch back to the approved old head with an empty pack", async () => {
    const github = new FakeGitHub();
    github.branches.set("main", BASE);
    github.install();
    const gk = await repoGatekeeper();
    const cache = new TestGitCache().withAncestry(BASE, HEAD1);
    const action = (await queuePush(gk, cache, new TestApprovalQueue(), "main", HEAD1))!;
    github.respondToPush("unpack ok", "ok refs/heads/main");
    await gk.applyAction(action.approvalId, cache);

    github.respondToPush("unpack ok", "ok refs/heads/main");
    expect(await gk.revertAction(action.approvalId)).toBeUndefined();

    const { commands, pack } = splitPushRequest(github.receivePackExchanges[1].body);
    expect(commands[0]).toMatch(new RegExp(`^${HEAD1} ${BASE} refs/heads/main\0`));
    // An empty pack: header ("PACK", version 2, zero objects) + SHA-1 trailer.
    expect(pack).toHaveLength(32);
    expect([...pack.subarray(0, 12)])
      .toEqual([0x50, 0x41, 0x43, 0x4b, 0, 0, 0, 2, 0, 0, 0, 0]);
  });

  it("deletes a branch the push created, sending no pack", async () => {
    const github = new FakeGitHub();
    github.install();
    const gk = await repoGatekeeper();
    const cache = new TestGitCache().withCommit(HEAD1, commitPayload([BASE], "x"));
    const action = (await queuePush(gk, cache, new TestApprovalQueue(), "feature", HEAD1))!;
    github.respondToPush("unpack ok", "ok refs/heads/feature");
    await gk.applyAction(action.approvalId, cache);

    github.respondToPush("unpack ok", "ok refs/heads/feature");
    expect(await gk.revertAction(action.approvalId)).toBeUndefined();

    const { commands, pack } = splitPushRequest(github.receivePackExchanges[1].body);
    expect(commands[0]).toMatch(new RegExp(`^${HEAD1} ${ZERO_OID} refs/heads/feature\0`));
    expect(pack).toHaveLength(0);
  });

  it("reports (not throws) when the branch has moved on, and stomps nothing", async () => {
    const github = new FakeGitHub();
    github.branches.set("main", BASE);
    github.install();
    const gk = await repoGatekeeper();
    const cache = new TestGitCache().withAncestry(BASE, HEAD1);
    const action = (await queuePush(gk, cache, new TestApprovalQueue(), "main", HEAD1))!;
    github.respondToPush("unpack ok", "ok refs/heads/main");
    await gk.applyAction(action.approvalId, cache);

    github.respondToPush("unpack ok", "ng refs/heads/main fetch first");
    const result = await gk.revertAction(action.approvalId);
    expect(result).toMatchObject({ canRetry: false });
    expect((result as { message: string }).message).toMatch(/no longer at the pushed commit/);
  });
});


describe("keyed native push publication", () => {
  it("keeps publication pending while legacy reads simulate it, then confirms the real native apply", async () => {
    const github = new FakeGitHub(); github.applyRefUpdates = true; github.branches.set("main", BASE); github.install();
    const cache = new TestGitCache().withAncestry(BASE, HEAD1);
    const queue = new TestApprovalQueue(cache), gk = await repoGatekeeper();
    const continuity = await gk.continuity(queue), key = crypto.randomUUID();
    expect(continuity).toMatchObject({ version: 1, repositoryId: 12345, facet: expect.stringMatching(/^[a-f0-9]{64}$/), grant: expect.stringMatching(/^[a-f0-9]{64}$/) });
    const command = { branch: "main", commitId: HEAD1 };
    const pending = await gk.submit(queue, key, command, continuity);
    expect(pending).toMatchObject({ state: "pending", requestKey: key });
    expect(github.receivePackExchanges).toHaveLength(0);
    expect(await gk.resolveRef("main", cache)).toEqual({ id: HEAD1, fromCache: true });
    expect(await gk.operation(queue, key)).toEqual(pending);
    expect(await gk.submit(queue, key, { ...command, force: false }, continuity)).toEqual(pending);
    expect(queue.submitted).toHaveLength(1);
    await gk.applyAction(queue.submitted[0].action, cache);
    expect(await gk.operation(queue, key)).toMatchObject({ state: "applied", id: pending.id });
    await gk.applyAction(queue.submitted[0].action, cache);
    expect(github.receivePackExchanges).toHaveLength(1); expect(github.mutations).toBe(1);
  });
});


async function publicationFixture() {
  const github = new FakeGitHub(); github.applyRefUpdates = true; github.branches.set("main", BASE); github.install();
  const cache = new TestGitCache().withAncestry(BASE, HEAD1).withAncestry(HEAD1, HEAD2);
  const queue = new TestApprovalQueue(cache), gk = await repoGatekeeper(), expected = await gk.continuity(queue);
  return { github, cache, queue, gk, expected, command: { branch: "main", commitId: HEAD1 } };
}

/** OAuth completion is an explicit fixture boundary; stage consumption and reconnect are native. */
async function replaceGrant(accountId: DurableObjectId, expiresAt?: number) {
  const account = env.USER_ACCOUNT.get(accountId);
  const stage = await runInDurableObject(account, (_instance, state) => stageCredentials(state.storage.kv,
    { accessToken: "test-token-reconnected", scopes: ["repo"], ...(expiresAt === undefined ? {} : { expiresAt, refreshToken: "test-refresh" }) }, Date.now()));
  await account.commitReconnect(stage);
  return { account, stage };
}

describe("native publication recovery and scope", () => {
  it("keeps an unapproved keyed action pending when another actor publishes its desired commit", async () => {
    const f = await publicationFixture(), key = crypto.randomUUID();
    const pending = await f.gk.submit(f.queue, key, f.command, f.expected);
    // Matching external state cannot supply the native approval this action has not received.
    f.github.branches.set("main", HEAD1);
    expect(await f.gk.operation(f.queue, key)).toEqual(pending);
    expect(await f.gk.submit(f.queue, key, f.command, f.expected)).toEqual(pending);
    expect(f.queue.submitted).toHaveLength(1);
    expect(f.github.receivePackExchanges).toHaveLength(0); expect(f.github.mutations).toBe(0);
    // A native action already marked approved refuses discard, independently of the receipt.
    await f.gk.rejectAction(f.queue.submitted[0].action);
    expect(await f.gk.operation(f.queue, key)).toMatchObject({ state: "rejected" });
    expect(f.github.branches.get("main")).toBe(HEAD1);
    expect(f.github.receivePackExchanges).toHaveLength(0); expect(f.github.mutations).toBe(0);
  });

  it("rechecks the in-flight fence after a dependent-PR rejection read", async () => {
    const f = await publicationFixture(), key = crypto.randomUUID();
    await f.gk.submit(f.queue, key, f.command, f.expected);
    const pull = await f.gk.prepareCreatePullRequest({ title: "Dependent pull request", head: "main", base: "main" });
    await f.gk.submitCreatePullRequest(f.queue, pull);
    const account = env.USER_ACCOUNT.get(f.gk.accountId) as DurableObjectStub<UserAccount>;
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const acknowledgement = new Promise<void>(resolve => { release = resolve; });
    f.cache.onBuildPack = async () => { enter(); await acknowledgement; };
    await account.holdNextAccessToken();
    const rejecting = f.gk.rejectAction(f.queue.submitted[0].action).then(
      () => ({ error: undefined }), error => ({ error: error instanceof Error ? error.message : String(error) }));
    await account.waitForHeldAccessToken();
    const applying = f.gk.applyAction(f.queue.submitted[0].action, f.cache);
    try {
      await entered;
      await account.releaseAccessToken();
      expect.soft((await rejecting).error).toEqual(expect.stringContaining("in-flight"));
      expect.soft(await f.gk.operation(f.queue, key)).toMatchObject({ state: "applying" });
    } finally {
      await account.releaseAccessToken();
      release(); await applying; await rejecting;
    }
    expect(await f.gk.operation(f.queue, key)).toMatchObject({ state: "applied" });
    expect(f.github.mutations).toBe(1);
  });

  it("reports a reconnect during pack construction as a known pre-send scope failure", async () => {
    const f = await publicationFixture(), key = crypto.randomUUID();
    await f.gk.submit(f.queue, key, f.command, f.expected);
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const acknowledgement = new Promise<void>(resolve => { release = resolve; });
    f.cache.onBuildPack = async () => { enter(); await acknowledgement; };
    const applying = f.gk.applyAction(f.queue.submitted[0].action, f.cache).then(
      () => ({ error: undefined }), error => ({ error: error instanceof Error ? error.message : String(error) }));
    try { await entered; await replaceGrant(f.gk.accountId); }
    finally { release(); }
    expect((await applying).error).toBeDefined();
    expect(f.github.receivePackExchanges).toHaveLength(0); expect(f.github.mutations).toBe(0);
    expect(await f.gk.operation(f.queue, key)).toMatchObject({ state: "failed", failure: "scope-changed" });
    await f.gk.rejectAction(f.queue.submitted[0].action);
    expect(await f.gk.operation(f.queue, key)).toMatchObject({ state: "rejected" });
  });

  it("keeps an explicit CAS rejection discardable instead of permanently uncertain", async () => {
    const f = await publicationFixture(), key = crypto.randomUUID();
    await f.gk.submit(f.queue, key, f.command, f.expected);
    f.github.branches.set("main", OTHER);
    const result = await f.gk.applyAction(f.queue.submitted[0].action, f.cache).then(
      () => ({ error: undefined }), error => ({ error: error instanceof Error ? error.message : String(error) }));
    expect(result.error).toBeDefined();
    expect(f.github.receivePackExchanges).toHaveLength(1); expect(f.github.mutations).toBe(0);
    expect(f.github.branches.get("main")).toBe(OTHER);
    expect(await f.gk.operation(f.queue, key)).toMatchObject({ state: "failed" });
    await f.gk.rejectAction(f.queue.submitted[0].action);
    expect(await f.gk.operation(f.queue, key)).toMatchObject({ state: "rejected" });
  });

  it("preserves a pending keyed rejection across reconciliation without publishing", async () => {
    const f = await publicationFixture(), key = crypto.randomUUID();
    await f.gk.submit(f.queue, key, f.command, f.expected);
    await f.gk.rejectAction(f.queue.submitted[0].action);
    const rejected = await f.gk.operation(f.queue, key);
    expect(rejected).toMatchObject({ state: "rejected" });
    await f.gk.restart();
    expect(await f.gk.submit(f.queue, key, f.command, f.expected)).toEqual(rejected);
    expect(f.queue.submitted).toHaveLength(1);
    expect(f.github.receivePackExchanges).toHaveLength(0); expect(f.github.mutations).toBe(0);
  });

  it("deduplicates concurrent submissions and reconstructs the same facet without accepting changed payload", async () => {
    const f = await publicationFixture(), key = crypto.randomUUID();
    const receipts = await Promise.all([f.gk.submit(f.queue, key, f.command, f.expected), f.gk.submit(f.queue, key, f.command, f.expected)]);
    expect(receipts[0].id).toBe(receipts[1].id); expect(f.queue.submitted).toHaveLength(1);
    await expect(f.gk.submit(f.queue, key, { ...f.command, commitId: HEAD2 }, f.expected)).rejects.toThrow("key reused");
    await f.gk.restart(); expect(await f.gk.continuity(f.queue)).toEqual(f.expected);
    expect(await f.gk.operation(f.queue, key)).toMatchObject({ state: "pending", id: receipts[0].id });
    expect(f.github.mutations).toBe(0);
  });

  it("refuses another native facet, account, revision or repository without queueing", async () => {
    const f = await publicationFixture(), other = await repoGatekeeper(f.gk.accountId), foreign = await repoGatekeeper();
    expect((await other.continuity(f.queue)).facet).not.toBe(f.expected.facet);
    for (const target of [other, foreign]) expect(await target.submit(f.queue, crypto.randomUUID(), f.command, f.expected)).toMatchObject({ state: "failed", failure: "scope-changed" });
    for (const expected of [{ ...f.expected, grant: "f".repeat(64) }, { ...f.expected, repositoryId: 98765 }]) {
      expect(await f.gk.submit(f.queue, crypto.randomUUID(), f.command, expected)).toMatchObject({ state: "failed", failure: "scope-changed" });
    }
    f.github.repositoryId = 98765;
    expect(await f.gk.submit(f.queue, crypto.randomUUID(), f.command, f.expected)).toMatchObject({ state: "failed", failure: "scope-changed" });
    expect(f.queue.submitted).toHaveLength(0); expect(f.github.mutations).toBe(0);
  });

  it("authorizes operational reads and does not disclose a receipt when observation is denied", async () => {
    const f = await publicationFixture(), key = crypto.randomUUID(); await f.gk.submit(f.queue, key, f.command, f.expected);
    f.queue.denyObservation = true;
    await expect(f.gk.continuity(f.queue)).rejects.toThrow("observation denied");
    await expect(f.gk.operation(f.queue, key)).rejects.toThrow("observation denied");
    expect(f.github.mutations).toBe(0);
  });

  it("never mistakes a legacy simulated no-op for a published keyed push", async () => {
    const f = await publicationFixture();
    const legacy = await queuePush(f.gk, f.cache, f.queue, "main", HEAD1);
    expect(legacy).not.toBeNull(); expect(await f.gk.resolveRef("main", f.cache)).toEqual({ id: HEAD1, fromCache: true });
    expect(await f.gk.submit(f.queue, crypto.randomUUID(), f.command, f.expected)).toMatchObject({ state: "pending" });
    expect(f.queue.submitted).toHaveLength(2); expect(f.github.mutations).toBe(0);
  });

  it("confirms an already-published no-op without inventing another action or mutation", async () => {
    const f = await publicationFixture(); f.github.branches.set("main", HEAD1);
    expect(await f.gk.submit(f.queue, crypto.randomUUID(), f.command, f.expected)).toMatchObject({ state: "applied" });
    expect(f.queue.submitted).toHaveLength(0); expect(f.github.mutations).toBe(0);
  });

  it("keeps a lost submission acknowledgement and resumes its original native action after restart", async () => {
    const f = await publicationFixture(), key = crypto.randomUUID(); f.queue.loseAcknowledgement = true;
    const receipt = await f.gk.submit(f.queue, key, f.command, f.expected);
    expect(receipt.state).toBe("uncertain"); await f.gk.restart();
    expect(await f.gk.submit(f.queue, key, f.command, f.expected)).toEqual(receipt);
    expect(f.queue.submitted).toHaveLength(1); expect(f.github.mutations).toBe(0);
    await f.gk.applyAction(f.queue.submitted[0].action, f.cache);
    expect(await f.gk.operation(f.queue, key)).toMatchObject({ state: "applied", id: receipt.id });
    expect(f.github.mutations).toBe(1);
  });

  it("does not overwrite an apply that completes before the native queue acknowledgement is lost", async () => {
    const f = await publicationFixture(), key = crypto.randomUUID();
    f.queue.onSubmit = action => f.gk.applyAction(action, f.cache); f.queue.loseAcknowledgement = true;
    expect(await f.gk.submit(f.queue, key, f.command, f.expected)).toMatchObject({ state: "applied" });
    expect(f.queue.submitted).toHaveLength(1); expect(f.github.mutations).toBe(1);
  });

  it("reconciles a lost effect acknowledgement by an actual remote read without replaying the push", async () => {
    const f = await publicationFixture(), key = crypto.randomUUID();
    await f.gk.submit(f.queue, key, f.command, f.expected);
    f.github.onMutation = async () => { throw new Error("Fixture reply lost after ref update"); };
    await expect(f.gk.applyAction(f.queue.submitted[0].action, f.cache)).rejects.toThrow("uncertain");
    expect(f.github.mutations).toBe(1); f.github.refReadUnavailable = true; await f.gk.restart();
    expect(await f.gk.operation(f.queue, key)).toMatchObject({ state: "uncertain" });
    await expect(f.gk.applyAction(f.queue.submitted[0].action, f.cache)).rejects.toThrow("not replayable");
    f.github.refReadUnavailable = false;
    expect(await f.gk.operation(f.queue, key)).toMatchObject({ state: "applied" });
    await f.gk.applyAction(f.queue.submitted[0].action, f.cache);
    expect(f.github.receivePackExchanges).toHaveLength(1); expect(f.github.mutations).toBe(1);
  });

  it("serializes original native application and refuses to discard an in-flight effect as unapplied", async () => {
    const f = await publicationFixture(), key = crypto.randomUUID(); await f.gk.submit(f.queue, key, f.command, f.expected);
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; }), acknowledgement = new Promise<void>(resolve => { release = resolve; });
    f.cache.onBuildPack = async () => { enter(); await acknowledgement; };
    const applying = f.gk.applyAction(f.queue.submitted[0].action, f.cache); await entered;
    try {
      expect(await f.gk.operation(f.queue, key)).toMatchObject({ state: "applying" });
      await expect(f.gk.applyAction(f.queue.submitted[0].action, f.cache)).rejects.toThrow("not replayable");
      await expect(f.gk.rejectAction(f.queue.submitted[0].action)).rejects.toThrow("in-flight");
    } finally { release(); await applying; }
    expect(await f.gk.operation(f.queue, key)).toMatchObject({ state: "applied" }); expect(f.github.mutations).toBe(1);
  });

  it("keeps confirmed reconnect distinct from refresh and refuses the previous pending authorization", async () => {
    const f = await publicationFixture(), key = crypto.randomUUID(); await f.gk.submit(f.queue, key, f.command, f.expected);
    const replacement = await replaceGrant(f.gk.accountId);
    const current = await f.gk.continuity(f.queue);
    expect(current.facet).toBe(f.expected.facet); expect(current.grant).not.toBe(f.expected.grant);
    await expect(f.gk.applyAction(f.queue.submitted[0].action, f.cache)).rejects.toThrow("authorization changed");
    expect(await f.gk.operation(f.queue, key)).toMatchObject({ state: "failed", failure: "scope-changed" });
    expect(await runInDurableObject(replacement.account, async instance => {
      try { await instance.commitReconnect(replacement.stage); return "unexpected commit"; }
      catch (error) { return error instanceof Error ? error.message : String(error); }
    })).toContain("No reconnect");
    expect(await f.gk.continuity(f.queue)).toEqual(current); expect(f.github.mutations).toBe(0);
    await expect(f.gk.submit(f.queue, key, f.command, current)).rejects.toThrow("key reused");
  });

  it("preserves the connection witness across the real credential coordinator's refresh", async () => {
    const f = await publicationFixture(); const now = Date.now();
    await replaceGrant(f.gk.accountId, now + 300_000); const before = await f.gk.continuity(f.queue);
    vi.spyOn(Date, "now").mockReturnValue(now + 240_001);
    expect(await env.USER_ACCOUNT.get(f.gk.accountId).getAccessToken()).toBe("test-token-refreshed");
    expect(await f.gk.continuity(f.queue)).toEqual(before);
  });
});


it("cannot apply copied operation storage under a different native facet or retire its origin", async () => {
  const f = await publicationFixture(), key = crypto.randomUUID();
  const pending = await f.gk.submit(f.queue, key, f.command, f.expected);
  const copiedCache = new TestGitCache(1).withAncestry(BASE, HEAD1), copiedQueue = new TestApprovalQueue(copiedCache);
  await f.gk.copyFacet(); expect((await f.gk.copiedContinuity(copiedQueue)).facet).not.toBe(f.expected.facet);
  await expect(f.gk.copiedOperation(copiedQueue, key)).rejects.toThrow("unavailable");
  await expect(f.gk.copiedApply(f.queue.submitted[0].action, copiedCache)).rejects.toThrow("authorization changed");
  expect(f.github.mutations).toBe(0);
  expect(await f.gk.operation(f.queue, key)).toEqual(pending);
  await f.gk.applyAction(f.queue.submitted[0].action, f.cache);
  expect(await f.gk.operation(f.queue, key)).toMatchObject({ state: "applied" }); expect(f.github.mutations).toBe(1);
});


it("refuses missing native binding metadata without falling back to nonce or caller fields", async () => {
  class LegacyCache extends RpcTarget {}
  const f = await publicationFixture(), legacyQueue = new TestApprovalQueue(new LegacyCache());
  await expect(f.gk.continuity(legacyQueue)).rejects.toThrow("unavailable");
  expect(await f.gk.submit(legacyQueue, crypto.randomUUID(), f.command, f.expected)).toMatchObject({ state: "failed" });
  expect(legacyQueue.submitted).toHaveLength(0); expect(f.github.mutations).toBe(0);
});
