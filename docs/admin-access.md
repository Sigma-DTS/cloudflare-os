# Admin access: operating and investigating a deployment

A deployment's admins (the canonical user ids its backend Worker's `ADMINS` variable lists) need to
operate, debug and investigate the instance: find a user or a workspace, look inside a workspace
that misbehaves, and know afterwards who looked at what and who changed which setting. This
document is the design record for that surface. The API itself is documented on `AdminApi` and
`AdminWorkspaceView` in `packages/workshop-shared/src/api.ts`; the pieces are:

| Concern | Location |
| --- | --- |
| Admin status, the environment's bounds, validation, the audit's text bounds | `packages/workshop-backend/src/admin-access.ts` |
| The `AdminApi` capability (`AdminApiImpl`) and the settings audit (`AdminSettings`) | `packages/workshop-backend/src/admin-settings.ts` |
| Diffing a settings change (`diffAdminConfig`) | `packages/workshop-backend/src/admin-config.ts` |
| The deployment-wide audit log (`AdminAuditDurableObject`) | `packages/workshop-backend/src/admin-audit.ts` |
| The user and workspace directory (`UserDirectoryDurableObject`) | `packages/workshop-backend/src/user-directory.ts` |
| Inspection (`openForAdmin`, `AdminWorkspaceViewImpl`) and the workspace's directory feed | `packages/workshop-backend/src/overseer.ts` |
| Reads that never pull (`readLocalCommitTree`, `readLocalFileAtCommit`) | `packages/workshop-backend/src/git-cache.ts` |
| The admin panel's Audit tab | `packages/workshop-frontend/src/features/admin-audit/` |

## Entry points

Everything goes through `AuthenticatedApi.getAdminApi({ via })`, which returns null unless the
caller is an admin. The admin check runs once, when the capability is minted, for every `AdminApi`
method except workspace inspection, which checks again (see [Inspection](#inspection)).

- **Settings**: the setters (signups, user search, site name and logo, instructions,
  resource and gatekeeper availability, models, update checks, ...), plus
  `setAdminWorkspaceAccess()` and `setAdminAuditRetentionDays()`. Every setter is audited.
- **The directory**: `listUsers()` and `listWorkspaces()`.
- **Inspection**: `inspectWorkspace(workspaceId, reason, { lifetimeSeconds })`, which returns an
  `AdminWorkspaceView`.
- **The audit log**: `listAdminAudit()` and `getAdminAuditStats()`.

`via` is `"api"` (the default, the Workshop's admin panel included) or `"cli"` for a command-line
client. It is stated by the client and unverified: it labels records and grants nothing. Each
capability mints a random `sessionId`, so every record made through one `getAdminApi()` call,
settings and inspections alike, shares its `via` and `sessionId` and can be read as one session.

## The directory

### One directory, for search and for admins

`listUsers()` and `listWorkspaces()` read `UserDirectoryDurableObject`, the directory behind user
search (`AuthenticatedApi.searchUsers()`). The admin listings keep what search does not need in
tables of their own, `user_activity` and `workspaces`, beside search's `users` table, rather than in
a second store, because this directory is everything an admin directory needs: the deployment-wide
singleton (always `getByName("")`), fed by every user DO through a revision protocol that backfills
lazily, migrated, and bound in the unit test pool. A parallel store would duplicate the users
table, the sync protocol and the per-session writes.

User search keeps its own matching and its `userSearchEnabled` gate; the admin listings ignore that
setting. Directory listings are unrecorded reads, visible whatever the access level, workspace
titles included: they are what an admin uses to find a workspace before inspecting it.

### Feeds

Durable Objects cannot be enumerated, so the directory learns of accounts and workspaces from the
objects themselves:

- **The user DO** reports its profile, by revision, when a session starts (a session token
  is authenticated, or a Cloudflare Access sign-in), and when the user renames themselves. A session
  start also reports the session's time as `lastLogin`, at most once per
  `DIRECTORY_ACTIVITY_INTERVAL_MS` (an hour, the precision `lastLogin` promises), and every report
  carries the account's creation time once it is recorded. An account records it when it is
  created, so it is listed with it from its first session.
- **The Overseer** reports its workspace's title, owner and creation time:
  - on every `open()`, a no-op once the directory has acknowledged the title's revision;
  - when the title changes, whoever changes it (a rename, an agent-chosen title, initialisation
    from a blueprint or an external message): the `title` singleton is the one chokepoint, and its
    subscriber bumps the revision inside the write's transaction and defers the sync;
  - with `lastActive` when the workspace is active, at most hourly, alongside its
    last-active report to the owner's user DO.

  Syncs run one at a time, are best-effort, and never restart the workspace. A workspace
  initialised before it recorded its creation time reads it once from its owner's record of it
  (`GadgetRecord.created`) and stores it.
- **The revision is time-based.** `#initializeNewWorkspace()` sets it to at least the current time.
  An external message names its workspace by key, so a deleted workspace can be initialised again
  under the same id; its new life then outranks whatever its earlier one left in the directory.

### Deletion

`deleteSelf()` takes the workspace out of the directory (`removeFromDirectory()`) after disabling
its hooks and **before** its critical section, never inside it. `removeFromDirectory()` waits for any
sync in flight, and workerd delivers the completion of I/O started outside a
`blockConcurrencyWhile()` callback only after the callback returns: waited for inside the critical
section, the sync would never finish, and the object would be reset between `deleteGadget` and
`deleteAll`.

`removeFromDirectory()` first marks the instance removed (so no queued sync sends or acknowledges
anything) and resets the acknowledged revision. A deletion that then fails therefore re-arms the
feed: an instance that survives the failure syncs again at once, and the next instance of a reset one
syncs at its first open, and either way the workspace returns to the directory.

### What the lazy backfill misses

- An account is listed once it has started a session since the directory began recording
  accounts for user search, whatever `userSearchEnabled` says. Most accounts are therefore listed
  as soon as the admin listings ship, but without `lastLogin` until their next session. Only an account with no session since then waits for its next one, and is never listed
  if it never starts another.
- A workspace never opened again is never listed.
- An account created before the deployment recorded creation times is listed without `created`.
- A workspace's `lastActive` is absent until it is next active.
- A workspace whose removal from the directory failed stays listed until an admin inspects it:
  inspection finds it gone (`workspaceNotFound`) and removes the entry. There is no tombstone.

### Text bounds

Nothing upstream bounds a display name or a workspace title, so the directory keeps the first
`MAX_DIRECTORY_TEXT_LENGTH` (1000) characters of each, both where it stores them and where it reads
them (a row stored before it clamped may hold more). The clamp has no marker: the directory is a
finding aid, not a record, and clamps as `boundAgentCatalog()` clamps a catalog. Search text is built
from the clamped name or title and the first 1000 characters of each id.

Ids are identities and filter keys, so they are kept whole, and a username has no length limit
either. A page therefore stops at a million characters of text as well as at its `limit` (and is
never empty while rows remain), and cursors and owner filters take any length.

## Inspection

`AdminApi.inspectWorkspace()` validates the reason and lifetime, re-checks that the caller is an
admin, reads the access policy from the authoritative `AdminSettings` config (not the KV mirror: a
mirror still saying `"full"` after an admin lowered the level must not mint a view at the old one),
and then calls `OverseerDurableObject.openForAdmin(adminId, reason, sessionId, terms)`.

`openForAdmin()`:

- **is reachable only over the Workshop's Durable Object binding**, never through a capability a
  user holds;
- **refuses a workspace never initialised or since deleted** (`workspaceNotFound`) before anything
  else, writing nothing. Unlike `open()`'s first-open path it never asks a user DO whether the
  workspace is theirs, so it never claims ownership;
- **skips `authorizeCollaborator()` and observer verification by explicit policy**: the admin is not
  a collaborator and is never registered with the workspace's gatekeepers. This is a deliberate
  exception to the observer invariant, compensated by the audit (see
  [observers.md](observers.md#admin-access-a-deliberate-exception));
- reads its environment only through the `OverseerImpl` (`impl.env`), never through the Durable
  Object's own `env`;
- rejects malformed terms with a `TypeError`. An expiry already past when the workspace answers is
  not malformed: the open is refused as any call on an expired view is (`viewExpired`, unrecorded),
  so a slow hop never surfaces as a validation error.

The view (`AdminWorkspaceViewImpl`) is not an `Overseer`. It joins no presence, session count or
outputs fan-out, and starts no agent, ambient capsule or gatekeeper facet; waking the Durable Object
still resumes turns a previous instance left running, as any wake does. It offers `describe`,
`listChats`, `getChat`, `listActions`, `listFiles`, `readFile`, `listGatekeepers` and
`getDiagnostics`, shaped as the matching `Overseer` reads are.

File reads are limited to a permanent gadget's committed head, and read only the objects the
workspace stores (`readLocalCommitTree`, `readLocalFileAtCommit`, built on `readLocalObject`). The
ordinary reads pull a missing object through the workspace's connections; these never do, so an
inspection never reaches a connection. A missing object is an error, not a fetch.

### Each call

Every view method, the open included, runs `#audit()` before it reads anything:

1. The view's checks: it has not expired (`viewExpired`), its admin is still an admin (`notAdmin`),
   and the workspace still exists (`workspaceNotFound`). A call these stop is not recorded.
2. The deployment's setting is read (`readAdminConfig`, the KV mirror), the call's one await before
   it writes.
3. The checks again, synchronously with the write that follows, so a call that expiry, a demotion
   or the workspace's deletion overtakes while it reads the setting writes nothing into the
   workspace and appends nothing for it.
4. The level the call runs at: the view's own, fixed when it was minted, lowered to the current
   setting and the environment's cap. Lowering the setting reaches live views within about a minute
   (the KV mirror's propagation); raising it never raises a view.
5. The record, in the workspace's admin access table and then in the deployment-wide log.
6. The level's refusal, if any: `accessOff` once the level is `"off"`, `contentWithheld` for
   `getChat()` or `readFile()` below `"full"`.
7. The read.

A view lasts `DEFAULT_ADMIN_VIEW_LIFETIME_SECONDS` (15 minutes) unless the open asks for up to
`MAX_ADMIN_VIEW_LIFETIME_SECONDS` (an hour). A workspace restart (a revocation, a deletion, a
redeploy) ends every view along with every other session on it; inspect again.

## Access levels and their bounds

### The levels

`adminWorkspaceAccess` is `"off"`, `"metadata"` (the default) or `"full"`:

- **off**: `inspectWorkspace()` is refused.
- **metadata**: the workspace's structure. Withheld: chat messages and queued steers, file contents,
  which blueprint a gadget follows (`upstream`, a share link to code the view would otherwise
  withhold), and the descriptions and fields of actions, observations and hooks. Kept: titles (of
  the workspace, chats, gadgets, actions and resources), collaborators with the notes on their
  grants, connections with their resource URLs, file names, and diagnostics. Titles and notes are
  written by members and agents and can echo content, restricted data included.
- **full**: everything, restricted data included.

### The environment's bounds

Two backend variables bound what admins may choose. They are environment variables for the reason
authentication config is (`auth/config.ts`): a compromised admin session must not be able to widen
them.

| Variable | Values | Default | Effect |
| --- | --- | --- | --- |
| `ADMIN_WORKSPACE_ACCESS_MAX` | `off`, `metadata`, `full` (any case, trimmed) | `metadata` (unset or blank) | The highest level admins may choose. Any other value is `off`, logged as an error: it bounds a security setting, so `none`, `false` or a typo of `off` must fail closed, never grant the default. |
| `ADMIN_AUDIT_RETENTION_MIN_DAYS` | a positive whole number of days, at most 3650 (`MAX_ADMIN_AUDIT_RETENTION_DAYS`); a larger value counts as 3650 | 90 (unset, blank or invalid; an invalid value is logged) | The fewest days the audit log keeps a record, whatever admins choose. |

The admins' choice is kept in `AdminConfig` as they set it, and `adminAccessPolicy()` holds it within
the bounds wherever it is enforced: `inspectWorkspace()`, every view call, the settings audit, the
audit log's own floor, and the workspace's pruning. `getSettings()` reports `chosen`, the bound
(`max` or `min`), and `effective`, which is what is enforced. The setters refuse a value outside the
bounds, naming the variable; a choice stored before a bound tightened is kept but not enforced.
`"full"` therefore takes a deployment config change.

### Setting the bounds

Both are variables of the backend Worker (`workshop-backend`):

- **Locally** (`pnpm run-local`, `pnpm dev-server`): set them in the shell or in the root
  `.dev.vars`; `scripts/run-dev-server.ts` passes both through to the backend, for example
  `ADMIN_WORKSPACE_ACCESS_MAX=full pnpm dev-server`.
- **Your own `wrangler deploy` or workerd config**: the backend Worker's `vars`.
- **Deploy tools that write the backend's variables themselves** (the online deploy flow and the
  deployment starter's `cf-os deploy`, both linked from the [README](../README.md#get-started)):
  they replace the Worker's variables on every deploy, so a value set in the Cloudflare dashboard
  lasts only until the next deploy, and until such a tool carries these two variables its
  deployments run with the defaults. Any redeploy that writes its own variables must carry both.

### When a variable is dropped

- The cap fails safe: a deployment set to `full` drops back to `metadata`.
- The floor falls back to 90 days, and with it the retention actually kept wherever the admins
  chose less, which prunes the older records.

So set the retention you want in the admin panel too: the admins' choice persists in the
deployment's settings across deploys, while the floor only stops an admin session from choosing
less. The Audit tab says when the floor is what holds retention up; it saves only a value that is
typed, so type the number of days you want kept, even the minimum.

## The audit

### Two kinds of record

- **`AdminAccessRecord`** (`kind: "workspace"`): one admin call into a workspace, the open or a view
  method. It holds `at`, `admin`, `sessionId`, `via`, `workspaceId`, the workspace's title at the
  time, `method`, the call's arguments by name, the `reason` given at the open, the `access` level
  the call ran at, and `refused` when the level refused it.
- **`AdminSettingRecord`** (`kind: "setting"`): one `AdminApi` setter's change. It holds `at`,
  `admin`, `sessionId`, `via`, `method`, and `changes`, each naming a setting, an entry `key` for a
  map or list setting, and its value `before` and `after`.

`listAdminAudit()` filters by kind, admin, workspace and time; `getAdminAuditStats()` by kind.

### Write before read, in two stores

An access record is written first in the workspace's own `adminAccess` collection
(`OverseerImpl.recordAdminAccess()`, synchronous, so it is durable before anything the call reads
can leave), and then in the deployment-wide `AdminAuditDurableObject`. The workspace copy is a
collection of its own, not part of the action log, so `listActions()`, `subscribeToActions()` and
everything else a member reads can never show it. If the deployment-wide write fails, the call
fails having read nothing, and the local row stands as the record of the attempt.

A setting record is written to the deployment-wide log before the change is stored: a change whose
record cannot be written is refused.

### Which refusals are recorded

| Refusal | Recorded | Why |
| --- | --- | --- |
| A live view's call refused by its level (`accessOff`, `contentWithheld`) | Yes, in both stores, with `refused` | The admin reached the workspace and asked for something. |
| An open refused because the authoritative setting or the cap is `"off"` | Yes, deployment-wide only, titled from the directory (cut) or `""` | No workspace is reached, so there is no local store to write. |
| An open refused because only the workspace's KV mirror still says `"off"` | Yes, in both stores | The workspace's own check refused it. |
| A dead capability (no longer an admin), an expired view, a deleted workspace, a malformed or unknown id | No | Nothing was read or reachable, and recording a gone workspace would write into storage that must stay empty. |

### Setting records

Every setter is recorded before its change takes effect. `AdminSettings.#mutateAdminConfig()`, which
serializes every `AdminConfig` write, is the chokepoint: each admin-facing mutator takes a
trailing `AdminSettingActor` (who, which session, `via`, and the `AdminApi` method), and the
chokepoint records `diffAdminConfig(current, next)` before `storage.adminConfig.put(next)`.

- Strings are recorded as themselves, and other values as JSON with object keys sorted. Own
  properties only: model maps legitimately hold `__proto__` and `constructor` keys.
- Maps (`banner`, `disabledResources`, `ambientGatekeeperModes`, `modelModes`, `modelSettings`) are
  recorded per key. Formats (by blueprint id) and added models (by model id) are recorded per entry,
  and a change to their order as one more change, without `key`, holding both lists of ids.
- A value is kept whole up to `MAX_ADMIN_AUDIT_VALUE_LENGTH` (10,000) characters, more than any
  bounded setting holds (the agent instructions are at most 8000). Only unbounded inputs pass it;
  then both values become excerpts starting a little before their first difference, with the offset
  and both whole lengths, so a change hidden behind a long prefix still shows. A cut from the end
  would hide exactly the edits an audit exists to show.
- There is no per-value hash: the diff runs inside the synchronous mutate callback, and
  `crypto.subtle.digest()` is asynchronous.
- Two writes the diff cannot see are recorded explicitly before they happen: the site logo, as
  `"default"` or `"custom"` before and `"default"` or the new logo's size and SHA-256 after (never
  its bytes), and featuring a blueprint, whose bit lives in its owner's user DO.
- A call that changes nothing records nothing (it is still written, since it may be a retry
  repairing the KV mirror). A record is kept if the change then fails, for example when the KV
  mirror write fails and the config is rolled back: it records the attempt.

Not recorded: reads (`getSettings`, `isBlueprintFeatured`, `getUpdateStatus`, the listings and the
audit log itself), the gateway tests, `checkForUpdates`, and the deployment's own promotion of its
bundled formats, which no admin made.

### Text bounds

Arguments, workspace titles and setting keys are cut to `MAX_ADMIN_AUDIT_ARG_LENGTH` (256)
characters by `cutAdminAuditText()`, the last character replaced with `…` and never splitting a
surrogate pair: a record marks its cuts, never passing a fragment off as the whole. Reasons are
capped at `MAX_ADMIN_ACCESS_REASON_LENGTH` (500), values at 10,000 with excerpts, and a setter's diff
has a bounded number of changes, so every record, and every page of them, is bounded.

The deployment-wide store keeps each field once (kind, time, admin, workspace id and title in
columns, the rest as JSON) and cuts the title itself, whatever its caller sent. The title is the one
field of a record that a workspace member writes, and it has no length limit of its own: kept
whole, an over-long title would overflow the row (the platform caps one at 8 MiB), failing every
audit write and so refusing every investigation of that workspace, or push a listing past the RPC
size limit.

### Retention and pruning

Both stores keep a record for the effective retention (`adminAuditRetentionDays`, default 90 days,
never below the floor). The deployment-wide log deletes up to 1000 expired rows at the start of each
call and never lists or counts one, and it holds the floor itself whatever retention a caller
passes. A workspace's copy prunes up to 64 expired records each time it writes one, so it goes when
the workspace is next inspected. `getDiagnostics()` shows a workspace's most recent records within
the retention.

### Statistics

`getAdminAuditStats({ days, kind })` counts the last `days` UTC days, today included (7 by default,
at most 366): the total, one count per day (empty days included), the ten admins and the ten
workspaces with the most records. A top workspace takes the newest non-empty title among its records
in the window. A window reaching past the retention counts nothing there.

## Error codes

Expected refusals carry a code from `ADMIN_ACCESS_ERROR_CODES` (read with
`getAdminAccessErrorCode()`), which survives Durable Object RPC and Cap'n Web:

| Code | When |
| --- | --- |
| `ADMIN_NOT_ADMIN` | The caller, or a view's admin, is no longer named in `ADMINS`. |
| `ADMIN_WORKSPACE_NOT_FOUND` | A malformed id, or one naming no workspace (never initialised or since deleted). |
| `ADMIN_WORKSPACE_ACCESS_OFF` | The level is `"off"`, by the setting or the cap. |
| `ADMIN_CONTENT_WITHHELD` | `getChat()` or `readFile()` below `"full"`. |
| `ADMIN_VIEW_EXPIRED` | The view's lifetime has run out. |

## Tests

Unit suites, in `packages/workshop-backend/__tests__/`:

- `admin-access.test.ts`: admin status, the bounds' parsing (failing closed), the policy, validation,
  the per-call level, the cuts, and setting values and excerpts.
- `admin-config.test.ts` (`diffAdminConfig`) and `admin-settings-audit.test.ts`: what each setter
  records, before which write, and the setters' bounds.
- `admin-audit.test.ts`: the deployment-wide log's listing, filters, cursors, schema, retention,
  stats, and multi-MiB titles.
- `admin-api-impl.test.ts`: `AdminApiImpl`'s inspection path, refused opens, listings and forwarding.
- `admin-workspace-view.test.ts`: the view, from an uninitialised id that stays uninitialised to the
  per-call checks, the races with deletion and expiry, withholding, a 2,000,000-character title, and
  file reads that never pull.
- `user-directory.test.ts`, `user-directory-feed.test.ts` and `workspace-directory-feed.test.ts`: the
  directory and both feeds. The last includes the deletion regression test, which parks a sync on a
  real call to another Durable Object (a plain-JavaScript fake cannot reproduce workerd's hold-back)
  and checks that the deletion still completes.

Integration suites, in `packages/integration-tests/__tests__/`:

- `workshop-admin-inspection.test.ts`: every admin method this surface adds refused to a non-admin; the directory; an
  inspection recorded apart from the workspace and absent from the owner's `listActions()` and
  `subscribeToActions()`; metadata and off; a deleted id refused without being written; an audit
  write failure; expiry; and long text end to end.
- `workshop-admin-audit.test.ts`: every setting change recorded before it takes effect, `via`,
  filters, stats across two admins, and a refused change when its record cannot be written.
- `workshop-admin-bounds.test.ts`: the bounds' defaults, and a redeploy that tightens them (an
  invalid cap failing closed) and demotes an admin. The redeploy ends every session, the demoted
  admin's view among them, so the per-call re-check that stops a live view once its admin is demoted
  is covered by `admin-workspace-view.test.ts`.

The integration suite reaches Durable Object storage directly (see
[integration-testing.md](integration-testing.md#reaching-a-durable-objects-storage-from-a-test)): it
faults the deployment-wide log with a trigger on `admin_audit`, and shows that an inspected deleted
id stays unwritten by listing its `sqlite_master`.
