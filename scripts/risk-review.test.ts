import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  askClef,
  authorizeRiskReview,
  buildClefState,
  classifyChangeset,
  evaluateGate,
  isHighRiskPath,
  runRiskReview,
  tallyReviews,
  type ActionsContext,
  type ActionsCore,
  type ChangedFile,
  type ClefVerdict,
  type GitHubClient,
  type Review,
  type RiskPullRequest,
} from "./risk-review.ts";

const workflow = readFileSync(new URL("../.github/workflows/risk-review.yml", import.meta.url), "utf8");
const triggerWorkflow = readFileSync(
  new URL("../.github/workflows/risk-review-trigger.yml", import.meta.url),
  "utf8",
);

const HEAD = "a".repeat(40);
const OLD = "b".repeat(40);
const lowVerdict: ClefVerdict = { high: 0.05, steering: 0 };

function file(filename: string, overrides: Partial<ChangedFile> = {}): ChangedFile {
  return {
    filename,
    status: "modified",
    additions: 1,
    deletions: 1,
    changes: 2,
    patch: "@@ -1 +1 @@\n-a\n+b",
    ...overrides,
  };
}

function review(login: string, state: string, commit = HEAD, type = "User"): Review {
  return { user: { login, type }, state, commit_id: commit };
}

describe("isHighRiskPath", () => {
  it("covers all of workshop-backend, the gate itself, and the delivery pipeline", () => {
    for (const path of [
      "packages/workshop-backend/src/overseer.ts",
      "packages/workshop-backend/__tests__/user.test.ts",
      "packages/workshop-backend/README.md",
      ".github/workflows/risk-review.yml",
      "scripts/risk-review.ts",
      "scripts/release/manifest-lib.ts",
      "packages/workshop-shared/src/api.ts",
      "packages/gatekeeper-github/src/index.ts",
      "packages/workshop-frontend/package.json",
      "pnpm-lock.yaml",
    ]) {
      assert.equal(isHighRiskPath(path), true, path);
    }
  });

  it("leaves docs, other tests and the frontend to the classifier", () => {
    for (const path of [
      "docs/testing.md",
      "README.md",
      "packages/gatekeeper-github/__tests__/index.test.ts",
      "packages/workshop-frontend/src/App.tsx",
    ]) {
      assert.equal(isHighRiskPath(path), false, path);
    }
  });
});

describe("buildClefState", () => {
  it("puts high-risk files first", () => {
    const { state, complete } = buildClefState([file("docs/a.md"), file("packages/workshop-shared/src/api.ts")]);
    assert.ok(state.indexOf("api.ts") < state.indexOf("docs/a.md"));
    assert.equal(complete, true);
  });

  it("treats a text diff the API did not inline as unseen, but not a binary file", () => {
    assert.equal(buildClefState([file("icon.png", { patch: undefined, changes: 0 })]).complete, true);
    assert.equal(buildClefState([file("big.ts", { patch: undefined, changes: 9000 })]).complete, false);
  });

  it("stops at the size limit and reports the rest unseen", () => {
    const huge = file("docs/huge.md", { patch: "x".repeat(200_000) });
    const { state, complete } = buildClefState([file("docs/a.md"), huge]);
    assert.ok(!state.includes("huge.md"));
    assert.equal(complete, false);
  });
});

function classify(overrides: Partial<Parameters<typeof classifyChangeset>[0]>) {
  return classifyChangeset({ files: [file("docs/a.md")], complete: true, clef: lowVerdict, ...overrides });
}

describe("classifyChangeset", () => {
  it("rates a confidently low change low", () => {
    assert.deepEqual(classify({}), { tier: "low", reasons: [] });
  });

  it("lets Clef raise the tier but never lower a high-risk path", () => {
    assert.equal(classify({ files: [file("packages/workshop-backend/src/user.ts")] }).tier, "high");
    assert.equal(classify({ clef: { high: 0.7, steering: 0 } }).tier, "high");
  });

  it("rates a change high when Clef is unsure", () => {
    assert.equal(classify({ clef: { high: 0.3, steering: 0 } }).tier, "high");
    assert.equal(classify({ clef: { high: 0.29, steering: 0 } }).tier, "low");
  });

  it("needs a human when the classifier did not see the whole change", () => {
    assert.equal(classify({ complete: false }).tier, "high");
    assert.equal(classify({ clef: { error: "HTTP 500" } }).tier, "high");
  });

  it("rates a diff that addresses the classifier high", () => {
    assert.equal(classify({ clef: { high: 0, steering: 0.8 } }).tier, "high");
  });

  it("names the files behind a high-risk path", () => {
    const { reasons } = classify({ files: [file("packages/workshop-shared/src/api.ts")] });
    assert.match(reasons[0], /packages\/workshop-shared\/src\/api\.ts/);
  });
});

describe("tallyReviews", () => {
  const maintainers = new Set(["alice", "bob", "carol", "author"]);
  const tally = (reviews: Review[]) => tallyReviews(reviews, { headSha: HEAD, author: "author", maintainers });

  it("counts only approvals of the head commit", () => {
    assert.deepEqual(tally([review("alice", "APPROVED"), review("bob", "APPROVED", OLD)]).approvers, ["alice"]);
  });

  it("ignores bots, the author, and reviewers without write access", () => {
    const { approvers } = tally([
      review("bonk[bot]", "APPROVED", HEAD, "Bot"),
      review("author", "APPROVED"),
      review("outsider", "APPROVED"),
    ]);
    assert.deepEqual(approvers, []);
  });

  it("uses each reviewer's latest decisive review", () => {
    assert.deepEqual(tally([review("alice", "CHANGES_REQUESTED", OLD), review("alice", "APPROVED")]), {
      approvers: ["alice"],
      blockers: [],
    });
    assert.deepEqual(
      tally([review("alice", "APPROVED"), review("alice", "COMMENTED"), review("alice", "DISMISSED")]),
      { approvers: [], blockers: [] },
    );
    assert.deepEqual(tally([review("bob", "CHANGES_REQUESTED", OLD)]).blockers, ["bob"]);
  });
});

function gate(overrides: Partial<Parameters<typeof evaluateGate>[0]>) {
  return evaluateGate({ tier: "low", approvers: [], blockers: [], directors: undefined, headSha: HEAD, ...overrides });
}

describe("evaluateGate", () => {
  it("passes low risk with no approvals", () => {
    assert.deepEqual(gate({}), { state: "success", description: "low risk: automated review only" });
  });

  it("requires one approval for high risk", () => {
    assert.deepEqual(gate({ tier: "high" }), {
      state: "failure",
      description: "high risk: needs a maintainer's approval of aaaaaaa",
    });
    assert.deepEqual(gate({ tier: "high", approvers: ["alice"] }), {
      state: "success",
      description: "high risk: approved by @alice",
    });
  });

  it("blocks on an outstanding change request", () => {
    assert.equal(gate({ approvers: ["alice"], blockers: ["bob"] }).description, "Changes requested by @bob");
  });

  it("requires the director of an agent's pull request to approve it, even at low risk", () => {
    assert.match(gate({ approvers: ["alice"], directors: [] }).description, /Assign/);
    assert.equal(gate({ directors: ["dave"] }).state, "failure");
    assert.equal(gate({ approvers: ["alice"], directors: ["dave"] }).state, "failure");
    assert.equal(gate({ approvers: ["dave"], directors: ["dave"] }).state, "success");
  });
});

describe("askClef", () => {
  const config = { accountId: "acct", apiToken: "token", gatewayId: "gw" };

  it("reads the verdict out of the REST API's result wrapper", async () => {
    let request: { url: string; init?: RequestInit } | undefined;
    const verdict = await askClef("diff", config, async (url, init) => {
      request = { url: String(url), init };
      return Response.json({
        result: {
          answers: {
            tier: { type: "choice", choice: "low", probabilities: { low: 0.9, high: 0.1 } },
            steering: { type: "noul", noul: 0.01 },
          },
        },
      });
    });

    assert.deepEqual(verdict, { high: 0.1, steering: 0.01 });
    assert.ok(request);
    assert.equal(request.url, "https://api.cloudflare.com/client/v4/accounts/acct/ai/run/@cf/cloudflare/clef");
    const headers = request.init?.headers as Record<string, string> | undefined;
    assert.equal(headers?.["cf-aig-gateway-id"], "gw");
    assert.equal(JSON.parse(String(request.init?.body)).model, "clef");
  });

  it("turns every failure into an error verdict", async () => {
    assert.deepEqual(await askClef("diff", {}), { error: "Workers AI credentials are not configured" });
    assert.deepEqual(await askClef("diff", config, async () => new Response("", { status: 403 })), {
      error: "HTTP 403",
    });
    assert.deepEqual(await askClef("diff", config, async () => Response.json({ result: {} })), {
      error: "unexpected response shape",
    });
    assert.deepEqual(
      await askClef("diff", config, async () => {
        throw new TypeError("fetch failed");
      }),
      { error: "TypeError" },
    );
  });
});

async function clefAnswers() {
  return Response.json({
    result: { answers: { tier: { probabilities: { low: 0.95, high: 0.05 } }, steering: { noul: 0 } } },
  });
}

function harness({ pullRequest = {}, files = [file("docs/a.md")], reviews = [], permissions = {} }: {
  pullRequest?: Partial<RiskPullRequest> | null;
  files?: ChangedFile[];
  reviews?: Review[];
  permissions?: Record<string, string>;
}) {
  const statuses: { sha: string; state: string; description: string }[] = [];
  const outputs: Record<string, string> = {};
  const routes = { list: Symbol("list"), listFiles: Symbol("listFiles"), listReviews: Symbol("listReviews") };
  const github: GitHubClient = {
    rest: {
      pulls: {
        get: async () => ({
          data: {
            number: 7,
            state: pullRequest === null ? "closed" : "open",
            user: { login: "author", type: "User" },
            assignees: [],
            head: { sha: HEAD },
            changed_files: files.length,
            ...pullRequest,
          },
        }),
        ...routes,
      },
      repos: {
        getCollaboratorPermissionLevel: async ({ username }) => ({
          data: { permission: permissions[username] ?? "read" },
        }),
        createCommitStatus: async (status) => {
          statuses.push(status);
        },
      },
    },
    paginate: async <T>(route: unknown) =>
      (route === routes.listFiles ? files : route === routes.listReviews ? reviews : []) as T[],
  };
  const summary: ActionsCore["summary"] = {
    addHeading: () => summary,
    addList: () => summary,
    write: async () => undefined,
  };
  const core: ActionsCore = {
    notice: () => {},
    setOutput: (name, value) => {
      outputs[name] = value;
    },
    summary,
  };
  const context: ActionsContext = {
    repo: { owner: "cloudflare", repo: "cloudflare-os" },
    serverUrl: "https://github.com",
    runId: 1,
    payload: { pull_request: { number: 7 } },
  };
  return {
    statuses,
    outputs,
    authorize: () => authorizeRiskReview({ github, context, core }),
    run: () =>
      runRiskReview({ github, context, core, clef: { accountId: "a", apiToken: "t" }, fetchImpl: clefAnswers }),
  };
}

describe("authorizeRiskReview", () => {
  for (const permission of ["admin", "maintain", "write"]) {
    it(`runs straight away for an author with ${permission} permission`, async () => {
      const { outputs, authorize } = harness({ permissions: { author: permission } });
      await authorize();
      assert.deepEqual(outputs, { author: "maintainer" });
    });
  }

  it("holds anyone else's pull request for approval, bots included", async () => {
    const outsider = harness({ permissions: { author: "triage" } });
    await outsider.authorize();
    assert.deepEqual(outsider.outputs, { author: "other" });

    const bot = harness({ pullRequest: { user: { login: "bonk[bot]", type: "Bot" } } });
    await bot.authorize();
    assert.deepEqual(bot.outputs, { author: "other" });
  });

  it("routes nowhere when the pull request is closed", async () => {
    const { outputs, authorize } = harness({ pullRequest: null });
    await authorize();
    assert.deepEqual(outputs, { author: "" });
  });
});

describe("runRiskReview", () => {
  it("passes a low-risk change with no human review", async () => {
    const { statuses, run } = harness({});
    await run();
    assert.deepEqual(statuses.map(({ sha, state }) => ({ sha, state })), [{ sha: HEAD, state: "success" }]);
  });

  it("holds a workshop-backend change for a maintainer's approval of the head commit", async () => {
    const { statuses, run } = harness({
      files: [file("packages/workshop-backend/src/overseer.ts")],
      reviews: [review("alice", "APPROVED", OLD)],
      permissions: { alice: "maintain" },
    });
    await run();
    assert.equal(statuses[0].description, "high risk: needs a maintainer's approval of aaaaaaa");
  });

  it("asks an agent's pull request for its director's approval", async () => {
    const { statuses, run } = harness({
      pullRequest: {
        user: { login: "bonk[bot]", type: "Bot" },
        assignees: [{ login: "dave", type: "User" }],
      },
      reviews: [review("alice", "APPROVED")],
      permissions: { alice: "write", dave: "write" },
    });
    await run();
    assert.equal(statuses[0].state, "failure");
    assert.match(statuses[0].description, /@dave/);
  });
});

describe("risk-review workflows", () => {
  it("runs the classifier from the base branch only", () => {
    assert.doesNotMatch(workflow, /^\s+pull_request:/m);
    assert.doesNotMatch(workflow, /^\s+pull_request_review:/m);
    assert.match(workflow, /ref: \$\{\{ github\.workflow_sha \}\}/);
    assert.doesNotMatch(workflow, /github\.event\.pull_request\.head\.(ref|repo)/);
  });

  it("holds every author but a maintainer behind the approval environment", () => {
    assert.match(workflow, /if: needs\.authorize\.outputs\.author == 'maintainer'/);
    assert.match(
      workflow,
      /if: needs\.authorize\.outputs\.author == 'other'\n(?:.*\n)*?\s+environment: risk-review-external/,
    );
    // Only the two classify jobs may see the Clef credentials.
    const authorizeJob = /\n {2}authorize:\n([\s\S]*?)\n {2}\w+:\n/.exec(workflow)?.[1];
    assert.ok(authorizeJob);
    assert.doesNotMatch(authorizeJob, /secrets\./);
  });

  it("relays reviews from a workflow with no permissions", () => {
    const name = /^name: (.+)$/m.exec(triggerWorkflow)?.[1];
    assert.ok(name);
    assert.match(workflow, new RegExp(`workflows: \\[${name}\\]`));
    assert.match(triggerWorkflow, /^permissions: \{\}$/m);
    assert.doesNotMatch(triggerWorkflow, /secrets\./);
  });
});
