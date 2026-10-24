# Review Guidelines

Guidance for AI reviewers reading pull requests in this repository. For how to build, test and
work in the repo, see [AGENTS.md](./AGENTS.md); for what changes are accepted at all, see
[CONTRIBUTING.md](./CONTRIBUTING.md).

Review priority, highest first: the kernel bar, capability-security invariants, secret leakage
through logs and errors, then everything else.

## High-scrutiny areas

`packages/workshop-backend/` and the public API in `packages/workshop-shared/src/api.ts` are the
**kernel**. Maintainers read every line, so hold them to a higher bar than UI or gatekeeper code:

- Every exported member of the `workshop-shared` public API needs a doc comment — types, consts and
  functions, not just interfaces.
- Reject a hand-written interface that mirrors an RPC interface plus an `as unknown as` cast. Derive
  from the real type instead, or rethink the design.
- Prefer reusing an existing mechanism over adding a parallel one; say which existing mechanism the
  change should have used.
- A large kernel change should be split by concern into separate PRs, and at minimum grouped into
  commits that let `workshop-backend`/`workshop-shared` be reviewed apart from UI. Flag PRs that
  bundle both.
- Inside a Durable Object's `blockConcurrencyWhile()` callback, never await a promise whose I/O
  started outside it. workerd delivers that completion only after the callback returns, so the
  callback never finishes and the object is reset part-way; `deleteSelf()` leaves the workspace
  directory before its critical section for this reason.

## Capability-based security

- A resource becomes "ambient" (auto-injected) only through user or admin configuration. A
  gatekeeper must never assert its own ambience.
- `#assertResourceEnabled()` in `packages/workshop-backend/src/user.ts` is the single chokepoint
  where disabled gatekeepers and resources are enforced before a capability is minted, called by
  both of that file's mints: `getGatekeeperClassFor()` (not the same-named vendor method each
  gatekeeper implements) and `createResourceGatekeeper()`. Flag any new path that mints a
  gatekeeper capability without going through it. Ambient singletons skip it: their chokepoint is
  `getSingletonGatekeeperClass()`, which refuses, before it reaches the account, a vendor the
  deployment disabled and an instance admin account the user is not offered (not an admin now).
- Authentication and authorization config (`AUTH_GATEKEEPERS`, `DISABLE_PASSWORD_AUTH`) is
  deliberately env-var driven in `auth/config.ts` and must **not** move into `AdminConfig`, so a
  compromised admin session cannot change it. Reject changes that relocate it.
- `AdminSettings` is the only writer of the authoritative `AdminConfig`. Other code reads through
  `readAdminConfig(env)`, except `AdminApiImpl`, which deliberately reads the authoritative config
  in two places: `inspectWorkspace()`, so that a KV mirror still holding a higher access level never
  mints a view at it, and the audit log's retention in `listAdminAudit()` and
  `getAdminAuditStats()`.
- `OverseerDurableObject.openForAdmin()` stays reachable only over the Durable Object binding, never
  through a capability a user holds, and refuses an uninitialised workspace without writing. Every
  `AdminWorkspaceView` method runs through `#call()`, which checks the view again once it has read
  the deployment's setting and once it has read its answer, synchronously with its first write;
  never reaches a connection (admin file reads never pull); and records the call, with what its
  answer exposed, in the workspace and then deployment-wide before anything it read leaves the
  server, so that a call whose record cannot be written returns nothing. The record follows the
  read because `exposed` must describe the answer actually returned. Flag a path that returns
  workspace data to an admin without these, or that sets `exposed` from anything but that
  answer.
- `ADMIN_WORKSPACE_ACCESS_MAX` and `ADMIN_AUDIT_RETENTION_MIN_DAYS` are env-driven, like auth
  config, and the cap fails closed. Flag a read of `adminWorkspaceAccess` or
  `adminAuditRetentionDays` that bypasses `adminAccessPolicy()`.
- A new `AdminSettings` mutator takes an `AdminSettingActor` and records through
  `#mutateAdminConfig()`, or records explicitly before any other write.
- Text a user or workspace member controls (display names, titles) enters the directory or the
  audit log only bounded: clamped to `MAX_DIRECTORY_TEXT_LENGTH`, or cut by `cutAdminAuditText()`.
  Flag a new copy of such text into either store without a bound.
- The instance admin Gatekeeper (`packages/gatekeeper-instanceadmin`, see
  [docs/admin-access.md](docs/admin-access.md#through-an-agent)) serves an admin's agent the Admin
  API, and only the kernel exercises that power:
  - A via-`"gatekeeper"` `AdminApiImpl` is constructed only in `OverseerImpl.adminApiForAgent()`,
    never returned or stored, and its only callers are `callInstanceAdmin` (reads, approved
    one-call runs and inspections, reached only through the `InstanceAdminGrantImpl` that
    `#openInstanceAdminSession` mints for the ambient instanceadmin capsule) and
    `#applyInstanceAdminAction`, the one place an approved change runs. Views it opens reach the
    agent only inside `InstanceAdminViewImpl`, whose calls go through `callInstanceAdminView`. Flag
    any other construction, any path that hands a Gatekeeper an `AdminApi`, and any call the
    action record does not hold.
  - Every `AdminApi` method has an `ADMIN_AGENT_ACCESS` entry, and the grant dispatches on it alone;
    the apply checks it again for a held action (refusing one whose method no longer has that
    kind). `read` is only for a method that neither changes nor spends; setters are `change`,
    tagged `@mutates`; paid or committing calls are `confirm`, tagged `@confirmation`; only
    `inspect` returns a capability, which the kernel wraps. Every read, confirm and view answer
    goes through `assertPlainAdminResult`.
  - Grants and views re-check before each call and before each answer: the agent's own code run
    is running, not stopped, and within `INSTANCE_ADMIN_RUN_LIMIT_SECONDS` (`#activeCodeRuns`, by
    `executionId`); its turn is the owner's own (the initiator, and `turnAnswersOwner`, for which a
    slash command's expansion counts as its connection's, not the owner's, and the built-in
    `/compact` continues the task before it, as a nudge does; flag any record without task text
    that `turnAnswersOwner` treats as starting one), in a chat neither spawned nor a blueprint
    review; the owner is an admin; the capsule is intact; no external reply is pending; access is
    latched and active; and the vendor is enabled (read at each mint, grant call, view call and
    apply).
  - A grant call reads what it decides on in one await before its last check, and nothing is
    awaited between that check and the `AdminApi` call or the queued action. Flag an await placed
    in between.
  - A consumed allowance's call is observed as soon as it settles, before its re-check. Flag a
    re-check or an await placed ahead of that record.
  - An approved call's id enters `#instanceAdminApplying` synchronously with the apply's last
    check. Reject refuses it and turn-off skips it, so the action log never contradicts the
    deployment log.
  - Once a workspace is latched (deployment admin access was ever on), nobody but its owner may
    ever open it. Flag anything that adds a collaborator, link, redemption or external message
    there (`registerExternalMessageResponseTarget` refuses too), or that clears the latch.
  - The capsule exists only in latched or private workspaces. Flag any path that adds it otherwise,
    or that shares a workspace without dropping it.
  - Only `packages/gatekeeper-instanceadmin` may be bound as `GATEKEEPER_INSTANCEADMIN`:
    `releaseShortName` refuses any other package whose slug folds to `instanceadmin`.
- `cf-os api` sends `User-Agent: cf-os-api/<version>`, and except on a local dev instance
  (`LOCAL_DEV_INSTANCE`, set only by `pnpm dev-server` and the integration harness) the Workshop
  lets such a session act only as a deployment admin. That is a speed bump against casual use: a
  client can send any User-Agent, so never rely on it for authorization; the API's own checks are
  the boundary. Flag code that grants anything by User-Agent, and any deployment config that sets
  `LOCAL_DEV_INSTANCE`.
- In `packages/mcp-shared/`, `tools.ts` is the trust boundary: nothing outside it may read a tool's
  annotations, a tool is an observation only when the server declares `readOnlyHint: true`, and
  auto-applying a write additionally requires a `vetted` endpoint. Every SDK OAuth operation must be
  given `sdkFetch(...)` so endpoint and SSRF checks survive redirects.
- `packages/bundled-blueprints/blueprints/`: a `blueprintId` is never edited after deploy — installs and promotion are
  keyed on it, so a rename orphans the old entry.

## Gatekeepers

Correctness is not enough. Pressure-test the agent-facing API
(`packages/gatekeeper-*/src/*types.d.ts`): does the shape make sense, does it cover the most common
user stories, what would you do differently? Check that the seams (resource granularities, bindings,
sessions) partition authority along the lines users actually grant. The checklist is "Reviewing a
gatekeeper" in `.agents/skills/write-gatekeeper/SKILL.md`.

The instance admin Gatekeeper differs:

- Review `packages/api-schema/generated/admin-api.agent.d.ts` as its `types.d.ts`. Its session has
  no per-method code, so what a method may do belongs in `ADMIN_AGENT_ACCESS`.
- Its types talk about approvals and its queued changes aren't simulated: a deliberate departure
  from the write-gatekeeper skill, because the Workshop holds the queue.
- `InstanceAdminSession` is the one RPC class without `@validateRpc()`. Its methods come from the
  generated schema, `checkArguments` checks their arguments, and the Workshop's `AdminApiImpl`
  validates them again. The facet's `startAdminSession()` is `@skipRpcValidation()` for the same
  reason: capnweb-validate builds a return validator from the declared type, which declares none of
  the session's methods, so a validated return would refuse every one of them. Flag any other RPC
  class without `@validateRpc()`, and any per-method code added to this one.

## Logging, errors and secrets

- Server code logs through `@gadgets/observability/logger` with a module-scoped logger and a stable
  dot-separated `component` (plus `vendorId` for gatekeepers). Caught values are passed as `error`.
- Never log or report secrets, prompts, headers, tokens, or request/response bodies. Exception
  messages and stacks reach the external Reporter, so the same rule applies to anything thrown or
  attached as report metadata.
- Logs on the instance admin paths name the event and ids, and the method only as `operation`,
  once `ADMIN_AGENT_ACCESS` has classified it. Flag one that logs arguments, results, reasons,
  titles, an Admin API error's message, or a method name nothing classified.
- Gatekeeper UIs must not report errors directly from their own Worker origin; they `postMessage`
  to the Workshop host, which validates the known frame window with origin `null`. Frontend reports
  never convey authority.
- A report's `reportedUserId` is client-supplied and unverified; reject any change that reads it as
  identity or authority. `pageLocation` is origin and pathname only, rebuilt at the boundary rather
  than trimmed: a share link's fragment is a bearer capability and an `href` retains credentials.
- Automatic error capture belongs only in trusted first-party surfaces, never in gadget or
  user-authored code.

## Cap'n Web RPC

- Promise pipelining is intentional: an RPC promise may be passed as an argument or used in place of
  a stub without being awaited. **Do not report unawaited RPC promises as floating promises.**
- A `useState` value that holds an `RpcStub` must be wrapped in an object — the setter would
  otherwise call the stub, since every stub is callable at runtime.
- Stubs must be disposed: `stub[Symbol.dispose]()`, a `using` declaration, or a `useEffect` cleanup
  that disposes the stub a component obtained. A stub acquired and never disposed is a server-side
  leak worth flagging.

## Build system (Vite+ tasks)

These break silently rather than loudly, so they are worth flagging even when the diff looks fine:

- A cached `vp` task sees only a built-in environment. A build that reads an env var must *be* a
  task declaring `env`, since `env`/`untrackedEnv` do not exist on a package.json script — and a
  sibling script duplicating a task's command gains nothing from that task's declaration.
- `env` fingerprints the variable's value, not what it points at. A var naming a path outside the
  workspace needs `cache: false` instead (see `workshop-backend`'s `build`).
- A task that reads a path it also writes never caches. New tasks must exclude their own outputs and
  vitest/wrangler scratch paths from `input`; exclusions for the gatekeeper SPA builds have to be
  workspace-wide or the gatekeepers invalidate each other.
- Do not add `incremental` to a tsconfig, do not reintroduce a root script calling
  `pnpm run --recursive`, and do not remove `scripts/assert-workerd.ts` from a package's
  `setupFiles` to make a suite green.
- `pnpm test`'s `--filter=!cloudflare-os` hardcodes the root package name; renaming the root
  silently doubles the scripts suite. Keep it spelled with `=` and unquoted: `cmd.exe` keeps single
  quotes literal, so a quoted filter matches nothing on Windows and the script exits 0 having run
  nothing.
- After an intentional release-manifest change, the golden file must be regenerated
  (`UPDATE_GOLDEN=1 node --test scripts/release/manifest-lib.test.ts`) and its diff reviewed.
- A new installable gatekeeper that takes no third-party OAuth credentials belongs in
  `NO_DEFAULT_CRED_INPUTS`; a spurious default secret input makes it uninstallable in the deploy
  wizard.

## Outside contributions

Contributions from outside the team are limited to small changes that are obviously correct and
trivially verifiable by reading the patch. Judge such a PR against that bar — do not ask an outside
contributor to broaden scope, add refactors, or take on adjacent cleanup.

## Do not flag

- Unawaited RPC promises (see above).
- Preview deployments skipped on fork PRs — GitHub withholds secrets from those runs by design.
- `test:run` as a script name; a Vite+ task may not share a name with a package.json script, which
  is also why `pnpm --filter <pkg> build`/`test` do not work here.
- oxlint warnings such as `no-shadow`, which are kept for incremental cleanup and do not block CI,
  and the absence of type-aware lint rules.
- `"singleThreaded": true` in tsconfig — measured as both the fastest and smallest configuration.
- The lack of `baseUrl` in any tsconfig; TypeScript 7 removed the option.

## Ignore during review

- Generated files, which are gitignored and rebuilt: `packages/*/src/generated/**` (`app.txt`,
  `*-configurator-ui.*`, `bundled-blueprints.ts`, `browser-export-runtime.txt`) and any `dist/`.
- `pnpm-lock.yaml`, unless the change is itself a dependency change — then check it against the
  `minimumReleaseAge` supply-chain policy in `pnpm-workspace.yaml`.
- Committed `*.gadget` archives in a blueprint directory, which are opaque data.
- `packages/api-cli/generated/`, `pnpm cf-os api`'s command table and its copy of the agent
  declarations: `pnpm api-schema:generate` writes them and `pnpm api-schema:check` keeps them in
  step with `api.ts`, so review `packages/api-cli/generator/emit.ts` instead.
