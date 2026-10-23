# Admin access: operating and investigating a deployment

A deployment's admins (the canonical user ids its backend Worker's `ADMINS` variable lists) need to
operate, debug and investigate the instance: find a user or a workspace, look inside a workspace
that misbehaves, and know afterwards who looked at what and who changed which setting. An admin
can also let their own agent do some of this as them, through the instance admin Gatekeeper (see
[Through an agent](#through-an-agent)). This document is the design record for that surface. The
API itself is documented on `AdminApi` and `AdminWorkspaceView` in
`packages/workshop-shared/src/api.ts`; the pieces are:

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
| The instance admin Gatekeeper, which serves an admin's agent the Admin API and decides nothing | `packages/gatekeeper-instanceadmin` (its README is its design record) |
| Its contract with the Workshop (`InstanceAdminGrant`, `InstanceAdminGatekeeper`, the approval window and the run limit) | `packages/workshop-shared/src/instance-admin.ts` |
| What the agent may do with each `AdminApi` method (`ADMIN_AGENT_ACCESS`) | `packages/workshop-shared/src/api.ts` |
| The grant, the deployment admin actions the Workshop holds, activation and turning off, and where the capsule may live | `packages/workshop-backend/src/overseer.ts` |
| The rules and texts: canonical calls, approval cards, observations, which turns qualify | `packages/workshop-backend/src/instance-admin.ts` |
| Offering it to admins only, disabled by default | `packages/workshop-backend/src/user.ts`, `packages/workshop-backend/src/provisioning-policy.ts` |
| The agent's types and the schema the Gatekeeper bundles (`admin-api.agent.d.ts`, `admin-api.schema.json`, `admin-api.fragments.json`) | `packages/api-schema/generated/` |

## Entry points

A client gets the `AdminApi` capability from `AuthenticatedApi.getAdminApi({ via })`, which returns
null unless the caller is an admin. The admin check runs once, when the capability is minted, for
every `AdminApi` method except workspace inspection, which checks again (see
[Inspection](#inspection)). An admin's own agent reaches the same methods only through the
instance admin Gatekeeper, whose calls the Workshop makes itself and which re-checks admin status on
every call (see [Through an agent](#through-an-agent)).

- **Settings**: the setters (signups, user search, site name and logo, instructions,
  resource and gatekeeper availability, models, update checks, ...), plus
  `setAdminWorkspaceAccess()` and `setAdminAuditRetentionDays()`. Every setter is audited.
- **The directory**: `listUsers()` and `listWorkspaces()`.
- **Inspection**: `inspectWorkspace(workspaceId, reason, { lifetimeSeconds, access })`, which
  returns an `AdminWorkspaceView` at the lower of the level asked for (`"metadata"` by default) and
  the deployment's.
- **The audit log**: `listAdminAudit()` and `getAdminAuditStats()`.

`via` says how an admin's calls reached the deployment (`AdminVia`). A client states `"api"` (the
default, the Workshop's admin panel included) or `"cli"` for a command-line client; that is
unverified, and labels records without granting anything. The third value, `"gatekeeper"`, no
client can state (`AdminApiOptions.via` takes only `AdminClientVia`): the Workshop alone records it,
for a call the admin's agent made through the instance admin Gatekeeper, and always with an
`origin` (`AdminGatekeeperOrigin`: the admin's workspace, the chat whose agent made the call, and
for an approved call the approving action's id). Each capability mints a random `sessionId`, so
every record made through one `getAdminApi()` call, settings and inspections alike, shares its
`via` and `sessionId` and can be read as one session. For `"gatekeeper"` the session is one agent
code run: every record its calls make shares a `sessionId`, the changes it queued included, which
are recorded when the admin approves them.

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

`AdminApi.inspectWorkspace()` validates the reason, the lifetime and the level asked for,
re-checks that the caller is an admin, reads the access policy from the authoritative
`AdminSettings` config (not the KV mirror: a mirror still saying `"full"` after an admin lowered the
level must not mint a view at the old one), and then calls
`OverseerDurableObject.openForAdmin(adminId, reason, sessionId, terms)`. The terms carry the level
asked for (`requested`) and the view's own `access`, the lower of that and the authoritative policy.

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
- rejects malformed terms with a `TypeError`, unrecorded: a blank or over-long reason, a `via` that
  is not `"api"` or `"cli"`, an `access` or a `requested` that is not `"metadata"` or `"full"`, an
  `access` above `requested`, and an expiry that is not a valid time or lies beyond the longest
  lifetime. An expiry already past when the workspace answers is not malformed: the open is refused
  as any call on an expired view is (`viewExpired`, unrecorded), so a slow hop never surfaces as a
  validation error.

The view (`AdminWorkspaceViewImpl`) is not an `Overseer`. It joins no presence, session count or
outputs fan-out, and starts no agent, ambient capsule or gatekeeper facet; waking the Durable Object
still resumes turns a previous instance left running, as any wake does. It offers `describe`,
`listChats`, `getChat`, `listActions`, `listFiles`, `readFile`, `listGatekeepers` and
`getDiagnostics`, shaped as the matching `Overseer` reads are.

An admin read never reaches a connection. File reads are limited to a permanent gadget's committed
head, and read only the objects the workspace stores (`readLocalCommitTree`,
`readLocalFileAtCommit`, built on `readLocalObject`). The ordinary reads pull a missing object
through the workspace's connections; these never do. A missing object is an error, not a fetch.
Beyond the workspace's own storage, a view reads only its owner's profile, from their account
(`describe()`).

### The level an inspection asks for

An inspection asks for `"metadata"` (the default) or `"full"` (`AdminInspectOptions.access`), and
its view gets the lower of that and the deployment's effective level.
Asking for `"full"` where the deployment allows only `"metadata"` is not an error: the view opens at
`"metadata"`, and its `describe()` reports the level granted. While the effective level is `"off"`,
every open is refused, whatever it asks for. Any other level is refused with a `TypeError` before
the open runs, by `AdminApiImpl`'s RPC validation.

Every record the view makes keeps the level asked for (`requested`) beside the level the call ran
at (`access`). Reading content is therefore a separate step: an investigation starts at
`"metadata"`, and moves to `"full"` deliberately, in a new `inspectWorkspace()` call with a reason
of its own, and the log shows when it did.

A view never rises. Its level is fixed when it is minted, and later calls only lower it (see
[Each call](#each-call)): raising the setting leaves a view that asked for `"full"` but got
`"metadata"` at `"metadata"`, and the admin inspects again to read content. `openForAdmin()` rejects
terms whose `access` is above `requested`, so no caller can mint a view above what it asked for.

### Each call

Every view method, the open included, runs through `#call()`:

1. The view's checks: it has not expired (`viewExpired`), its admin is still an admin (`notAdmin`),
   and the workspace still exists (`workspaceNotFound`). A call these stop is not recorded.
2. The deployment's setting is read (`readAdminConfig`, the KV mirror).
3. The checks again, since that read may have spanned the expiry, a demotion or the workspace's
   deletion.
4. The level the call runs at: the view's own (the lower of `requested` and the deployment's level
   when it was minted), lowered to the current setting and the environment's cap. Lowering the
   setting reaches live views within about a minute (the KV mirror's propagation); raising it never
   raises a view.
5. A call that level refuses is recorded, exposing `"metadata"` and with `refused` set, and then
   refused without reading anything: `accessOff` once the level is `"off"`, `contentWithheld` for
   `getChat()` or `readFile()` below `"full"`. Its local write is synchronous with step 3's check.
6. The read, on the server and never through a connection. A read that throws (a missing object, a
   gadget whose code is pending, an invalid path) is recorded as an attempt exposing `"metadata"`,
   once the checks pass again, and the call fails with the read's error.
7. The checks again, synchronously with the local write that follows, since the read may have
   awaited. A call that expiry, a demotion or the workspace's deletion overtakes while it reads
   writes nothing, appends nothing for the workspace and returns nothing.
8. What the call exposed (`exposed`), computed from the answer it read (see
   [What a call exposed](#what-a-call-exposed)).
9. The record, in the workspace's admin access table (synchronously) and then in the
   deployment-wide log.
10. The answer.

The record follows the read because it says what the call returned, which only the answer can
tell; it is why the records `getDiagnostics()` lists never include its own. The point a record
must precede is the answer leaving the server, since that is what an admin sees. Holding the answer
until both records exist means that nothing reaches an admin unrecorded and that a call whose record
cannot be written returns nothing, and a call its level refuses is still recorded without reading
anything. An answer that never left the server, because its record failed or the view stopped
meanwhile, exposed nothing. No check follows the deployment-wide append: the answer was read while
the view was live, and both of its records exist.

A view lasts `DEFAULT_ADMIN_VIEW_LIFETIME_SECONDS` (15 minutes) unless the open asks for up to
`MAX_ADMIN_VIEW_LIFETIME_SECONDS` (an hour). A workspace restart (a revocation, a deletion, a
redeploy) ends every view along with every other session on it; inspect again.

## Access levels and their bounds

### The levels

`adminWorkspaceAccess` is `"off"`, `"metadata"` (the default) or `"full"`, the most an inspection
gets (see [The level an inspection asks for](#the-level-an-inspection-asks-for)):

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
  method. It holds `at` (when the record was written), `admin`, `sessionId`, `via`, `workspaceId`,
  the workspace's title at the time, `method`, the call's arguments by name, the `reason` given at
  the open, the level the open asked for (`requested`), the `access` level the call ran at (never
  above `requested`), what its answer exposed (`exposed`), and `refused` when the level refused
  it.
- **`AdminSettingRecord`** (`kind: "setting"`): one `AdminApi` setter's change. It holds `at`,
  `admin`, `sessionId`, `via`, `method`, and `changes`, each naming a setting, an entry `key` for a
  map or list setting, and its value `before` and `after`.

Both carry `origin` exactly when `via` is `"gatekeeper"`: where the admin's agent made the call
(see [Entry points](#entry-points)). An access record's `origin.workspaceId` is the admin's own
workspace, not the inspected one its `workspaceId` names.

`listAdminAudit()` filters by kind, admin, workspace, `via`, what a call exposed (`exposed`) and
time; `getAdminAuditStats()` by kind.

### What a call exposed

`exposed` is `"content"` when a call's answer held something the `"metadata"` level withholds, and
`"metadata"` otherwise. Only a call at `"full"` can record `"content"`:

| Call | Records `"content"` when its answer holds |
| --- | --- |
| The open (`inspectWorkspace`) | never |
| `describe()` | a gadget that names the blueprint it follows |
| `listChats()` | a queued steer |
| `getChat()` | a message or a compaction summary |
| `listActions()` | an action, observation or hook entry with a description, or an action or observation with a field |
| `listFiles()` | never |
| `readFile()` | any file at the path, an `unreadable` one included |
| `listGatekeepers()` | a hook with a description |
| `getDiagnostics()` | never: nothing it returns depends on the level |

A refused call, or one whose read failed, records `"metadata"`. Present but empty is not content:
no queued steers, an empty description or field list, an `upstream` naming no blueprint (a gadget
built from scratch), and an empty chat page all record `"metadata"`. `readFile()` counts any file
it finds, because an unreadable file's message can quote it (a symlink's quotes its target), and
overstating is the safe direction. The predicates (`chatHoldsContent()` and its siblings in
`admin-access.ts`) mirror the withholding helpers beside them, so each is false for anything a
metadata view returns.

`exposed` is set from the answer, never from the level, so the content-read counts (see
[Statistics](#statistics)) count reads that returned content, not calls made at `"full"`.

### Recorded before anything leaves, in two stores

An access record is written first in the workspace's own `adminAccess` collection
(`OverseerImpl.recordAdminAccess()`, synchronous, so it is durable before the call's answer can
leave), then in the deployment-wide `AdminAuditDurableObject`, and only then is the answer
returned. The workspace copy is a collection of its own, not part of the action log, so
`listActions()`, `subscribeToActions()` and everything else a member reads can never show it. If
the deployment-wide write fails, the call fails and returns nothing, and the local row stands as
the record of the attempt, with what its answer would have exposed.

A setting record is written to the deployment-wide log before the change is stored: a change whose
record cannot be written is refused.

### Which refusals are recorded

| Refusal | Recorded | Why |
| --- | --- | --- |
| A live view's call refused by its level (`accessOff`, `contentWithheld`) | Yes, in both stores, with `refused` | The admin reached the workspace and asked for something. |
| A live view's call whose read throws (a missing object, a pending gadget, an invalid path) | Yes, in both stores, exposing `"metadata"` | The admin reached the workspace and asked for something; the call returned only its error. |
| An open refused because the authoritative setting or the cap is `"off"` | Yes, deployment-wide only, titled from the directory (cut) or `""` | No workspace is reached, so there is no local store to write. |
| An open refused because only the workspace's KV mirror still says `"off"` | Yes, in both stores | The workspace's own check refused it. |
| A dead capability (no longer an admin), an expired view, a deleted workspace, a malformed or unknown id, including a call that expiry, a demotion or a deletion overtakes while it reads | No | Nothing was reachable, or nothing the call read left the server, and recording a gone workspace would write into storage that must stay empty. |

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
bundled formats, which no admin made. When an admin's agent makes those reads or gateway tests, the
admin's own workspace records them instead (see [Through an agent](#the-audit-of-an-agents-calls)).

### Text bounds

Arguments, workspace titles and setting keys are cut to `MAX_ADMIN_AUDIT_ARG_LENGTH` (256)
characters by `cutAdminAuditText()`, the last character replaced with `…` and never splitting a
surrogate pair: a record marks its cuts, never passing a fragment off as the whole. Reasons are
capped at `MAX_ADMIN_ACCESS_REASON_LENGTH` (500), values at 10,000 with excerpts, and a setter's diff
has a bounded number of changes, so every record, and every page of them, is bounded.

The deployment-wide store keeps each field once (kind, time, admin, workspace id and title, and
`exposed` in columns, the rest as JSON) and cuts the title itself, whatever its caller sent. The
title is the one field of a record that a workspace member writes, and it has no length limit of
its own: kept whole, an over-long title would overflow the row (the platform caps one at 8 MiB), failing every
audit write and so refusing every investigation of that workspace, or push a listing past the RPC
size limit.

### Retention and pruning

Both stores keep a record for the effective retention (`adminAuditRetentionDays`, default 90 days,
never below the floor). The deployment-wide log deletes up to 1000 expired rows at the start of each
call and never lists or counts one, and it holds the floor itself whatever retention a caller
passes. A workspace's copy prunes up to 64 expired records each time it writes one, so it goes when
the workspace is next inspected. `getDiagnostics()` shows a workspace's most recent records within
the retention, never its own record, which it writes after reading them.

### Statistics

`getAdminAuditStats({ days, kind })` counts the last `days` UTC days, today included (7 by default,
at most 366): the total, one count per day (empty days included), the ten admins and the ten
workspaces with the most records, the content reads (`contentReads`, the records whose `exposed` is
`"content"`), and the ten admins and the ten workspaces with the most content reads
(`topAdminsByContentReads`, `topWorkspacesByContentReads`). These are lists of their own, so an
admin or workspace that ranks low overall still shows when it reads content most. A top workspace,
in either list, takes the newest non-empty title among its records in the window. Only access
records name a workspace or read content, so for the `"setting"` kind the content reads are 0 and
the workspace and content-read lists are empty. A window reaching past the retention counts nothing there.

The Audit tab shows the week's content reads, marks each content read in its recent activity, shows
the level an inspection asked for where its view got less, and can list content reads alone.

## Through an agent

The instance admin Gatekeeper (`packages/gatekeeper-instanceadmin`, vendor id `instanceadmin`) lets
a deployment admin's own agent use the Admin API as them, in a workspace they turn it on in. Its
README is the Gatekeeper's design record; this section is the deployment's side.

The Gatekeeper holds no power of its own. For each session the Workshop lends it an
`InstanceAdminGrant` through the facet's `startAdminSession()`, and the session forwards every
`AdminApi` call to the grant's `callAdminApi(method, args)`, which the Overseer answers
(`callInstanceAdmin`). The Workshop decides everything about a call: whether it runs, waits for
the admin's approval or is refused, what its approval card says, and what is recorded. It never
calls `startSession()`, `applyAction()` or `rejectAction()` on this facet, which has no
`ApprovalQueue` and submits no actions. The only via-`"gatekeeper"` `AdminApiImpl` is built in
`OverseerImpl.adminApiForAgent()`, for one run's calls or one approved change, and never leaves the
Overseer.

### Availability

- **Disabled by default.** `defaultAmbientGatekeeperMode()` gives it mode **Disabled** until an
  admin chooses one in the admin Gatekeepers panel; every other auto-provisioning gatekeeper starts
  **Optional**. The panel shows, beside its mode, what it lends, the prompt-injection risk and the
  advice to use a dedicated workspace (see [Risks](#risks)).
- **Admins only.** The user DO offers, provisions, lists and lends the account only to a user who
  is a deployment admin now, in every mode, **Enabled** included. Admin status comes from
  `ADMINS`, so it is checked on every use rather than stored.
- **Dormant after demotion or disabling.** Once the user is no longer an admin, or the deployment
  disables the vendor, the account is hidden and `getSingletonGatekeeperClass()` refuses it, and
  `ensureAmbientCapsules()` removes the capsule from each of their workspaces at its next open. The
  account and the workspaces stay, so promoting the admin again restores them (see
  [Risks](#risks)).
- **No resources.** The vendor offers no URL-addressed resources, so an agent is never offered it
  through `createExternalResource`, and no non-ambient record of it can be minted.

### The workspace

- **The capsule lives only where nobody else can get in.** The capsule (the ambient record that
  binds the Gatekeeper into the workspace) exists only in a workspace that is latched (below), or
  that nobody but its owner can open: no collaborator with a role, every share link revoked, and no
  collaborator session live. `ensureAmbientCapsules()` checks before adding it, `addGatekeeper()`
  checks again right before publishing it, and sharing drops it: the sharing manager's `onShared`
  hook removes it synchronously with the first grant or link written to a workspace that is not
  latched.
- **Turning access on is an approval.** Access starts off in every workspace. The agent's first
  call queues an activation card the Workshop words itself, saying what the agent may then do, what
  becomes permanent, and the prompt-injection warning (see [Risks](#risks)). Only the owner, while
  a deployment admin, can approve it, and only by hand, with the vendor enabled. Asking and
  approving are both refused (R9) unless nobody else can open the workspace (no collaborators, no
  links, and nobody else with it open), and refused (A5) while a reply to an external message is
  still to be delivered.
- **The latch is permanent.** Approving sets `instanceAdminLatched`, `instanceAdminActive` and
  `containsRestrictedData` in one transaction, and nothing clears the latch. From then on:
  - only the owner can open the workspace: nobody else has a role, and every grant, link and
    redemption is refused (S1; see [sharing.md](sharing.md#deployment-admin-access-owner-only-for-good));
  - it takes no external messages (X2), including one already on its way when access was turned
    on: `registerExternalMessageResponseTarget()` refuses inside the prompt's transaction, which
    rolls back;
  - it is restricted: no public web fetches or git pushes, and no auto-approval.

  `GadgetMetadata.deploymentAdminAccess` reads `"on"` or `"off"` from then on, and the Activity
  panel and the Share modal say why the workspace stays its owner's alone. The latch keeps out
  collaborators and links, not admins: other deployment admins can still inspect the workspace, as
  they can any workspace, and their inspections are recorded in the admin audit log.
- **Turning access off is immediate.** The owner turns it off from the Activity panel
  (`Overseer.turnOffDeploymentAdminAccess()`). Only the owner can (T1), and they can whether or not
  they are still an admin and whatever the vendor's mode. Synchronously, it clears
  `instanceAdminActive`, drops every approved one-call allowance, rejects every pending deployment
  admin action (requests to turn access on included), and restarts the capsule's facet, ending its
  sessions. From then on a grant's call asks to turn access back on, and a view's is refused (A3).
  An approved change already being made when it is turned off completes, and is recorded
  approved. In a workspace where access was never on, it only rejects pending requests to turn it
  on.
- **Turning it back on takes approval again.** After a turn-off the agent's next call asks to turn
  access back on, with the reactivation card, approved as the first one was.

### Who it serves

- **The owner's own turns.** A grant serves a turn only when its initiator is the owner and it
  answers a message the owner wrote themselves (`turnAnswersOwner()`), in a chat that is neither
  spawned (R15) nor a blueprint update's review (R15). Any other turn, a gadget's callback among
  them, is refused (R3).
- **Not a connection's slash command.** A connection's slash command (a Context Library skill, the
  only kind today) expands to text its provider wrote, which the chat logs as the owner's message
  (it carries `generatedBySlashCommandSequence`). The turn it starts therefore can't use the
  binding: it fails closed, and the owner sends a message of their own to go on. The expansion stays
  in the chat's history, where, like anything else the agent read, it can still steer that later
  turn.
- **The owner's `/compact` is theirs.** The built-in `/compact` is the owner's command, not a
  connection's, and never fails a turn closed. It holds no task text and its turn runs no tools, so a
  retry after it continues the task before it: compacting a callback's or a slash command's task
  doesn't make it the owner's.
- **Retries and resumptions keep their origin.** A retry, an approval's resumption, a steer or a
  legacy adoption continues the task before it and qualifies exactly when that task did, so a
  callback's, a slash command's or a blueprint's task never qualifies.
- **The live part of one executeCode call.** A grant works only during the executeCode call the
  binding was handed to: until its code settles (R2), until the owner stops the turn (R16; Stop
  doesn't stop running code, so the Workshop marks the run stopped), and for at most its first
  `INSTANCE_ADMIN_RUN_LIMIT_SECONDS`, 10 minutes (R17). Only the capsule's loopbacks carry the
  run's `executionId`, so a loopback kept from an earlier call resolves against nothing.
- **Forwarding.** A loopback or view the agent hands to a gadget, a callback or another binding
  during a live call acts as the owner until the call ends: the Workshop can't tell those callers
  apart. The capsule itself can't be bound into a gadget or an agent spawner (X1), and never
  reaches a spawned chat.
- **While the owner is an admin and the vendor enabled.** Every mint, grant call and view call
  re-checks admin status (R4), and every approval checks it of the approver (A2). Each of them, the
  approval included, also reads the deployment config, and refuses once the vendor is disabled
  (R7).

### What each call does

`ADMIN_AGENT_ACCESS` gives every `AdminApi` method a kind, and the grant dispatches on it alone. It
is typed to cover `AdminApi` exactly, so a method added without a kind does not compile.

| Kind | Methods | What a call does |
| --- | --- | --- |
| `read` | `getSettings`, `isBlueprintFeatured`, `getUpdateStatus`, `checkForUpdates`, `listUsers`, `listWorkspaces`, `listAdminAudit`, `getAdminAuditStats` | Runs at once, and is recorded in the admin's workspace before it answers. |
| `change` | the setters (`ADMIN_SETTING_METHODS`, tagged `@mutates`) but the three withheld | Changes nothing yet: it is queued as an action with a card showing the method and every argument exactly. On approval the Workshop makes exactly the stored call, once. |
| `confirm` | the three gateway tests, tagged `@confirmation`: they change no setting, but send requests the providers bill | The first call asks for approval of that one call. Once approved, the agent's next identical call in the same chat within `INSTANCE_ADMIN_APPROVAL_LIFETIME_SECONDS` (15 minutes) runs once. |
| `inspect` | `inspectWorkspace` | A `read` at `"metadata"` (the default); a `confirm` at `"full"`. The view opens at the level the Workshop classified, and gets no more than the deployment's level allows. |
| `withheld` | `setSiteLogo`, `setAdminWorkspaceAccess`, `setAdminAuditRetentionDays` | Left out of the agent's types (`ADMIN_OMIT`) and refused (R10). The admin sets them in the admin panel. |

- **A request already made is reused.** An identical request the same turn already made
  (`existing`) names that action instead of making a new card, so the turn waits on it; the same
  request from a later turn, or another chat, makes a new card. Each approval allows one call: the
  allowance is consumed before the call, even if the call then fails.
- **An approval that ran nothing resumes the agent with a nudge.** Approving the activation or a
  one-call approval runs nothing, so the resumed agent is told to make the call again
  (`instanceAdminApprovedNudge()`). An approved change keeps the ordinary "approved and applied"
  sentence.
- **Arguments are JSON, and bounded.** A queued call's arguments are kept as canonical JSON (keys
  sorted), which the card shows and the apply passes. Anything else (a function, a stub, a date, a
  cycle...) is refused (R12), and so is a call whose JSON and card together pass
  `MAX_INSTANCE_ADMIN_ACTION_CHARS` (R13), since its record would not fit a Durable Object value.
  Ordinary text of the longest length a setter keeps (8,000 characters) fits.
- **Only an inspection returns a capability.** Every other answer, and every view call's, must be
  plain data (R14). An inspection's view reaches the agent only wrapped (`InstanceAdminViewImpl`):
  every call on it goes through `callInstanceAdminView`, re-checks the run, and is recorded, and the
  view stops working with the executeCode call that opened it.
- **While access is off,** every call naming an available method with well-formed arguments asks to
  turn it on instead, and nothing runs.
- **The binding** is `INSTANCE_ADMIN`, or `INSTANCE_ADMIN_2` in an older chat that had the binding
  before the capsule was dropped and added again. The agent's preamble and the refusals don't rely
  on the name.

### The audit of an agent's calls

- **In the admin's workspace.** Every read, every view call and every call that ran on a one-call
  approval is an observation in the workspace whose agent made it, restricted
  (`containsRestrictedData`), with its arguments; every change and every approval request is an
  action there. Reads are recorded only once their answer has passed the plain-data check, and
  before it is returned.
- **Deployment-wide, for inspections and changes only.** Inspections (the open and every view call)
  and setting changes are recorded in the deployment's admin audit log with `via` `"gatekeeper"`,
  an `origin` and the run's `sessionId`. As for any admin, an inspection's record follows its read
  and precedes the answer, and a setting's record precedes the change. Directory, settings,
  audit-log and update reads, and the gateway tests, add nothing deployment-wide: the admin's
  workspace records them.
- **A one-call approval is recorded however it ends.** A call approved one at a time (a gateway
  test, a full inspection) is recorded in the admin's workspace as soon as it has run, with what it
  returned or threw and the approving action, before the checks that decide whether to answer. So a
  call whose answer a Stop, a turn-off or a demotion withholds still leaves its record, and the AI
  Gateway's own logs are the other trace of a gateway test.
- **Logs name ids.** The kernel's logs on these paths carry the event name and the action and chat
  ids, and the method, as `operation`, only once `ADMIN_AGENT_ACCESS` has classified it. They never
  carry arguments, results, reasons, titles, or an Admin API error's message, which can quote an
  argument.

### Refusals

The kernel's messages on these paths (`overseer.ts`, `instance-admin.ts`, `user.ts`,
`sharing.ts`), by the labels the code's comments use for them; "..." marks a message cut here.

| | Message | When |
| --- | --- | --- |
| R1 | The instance admin binding works only in its owner's own agent turns, from executeCode. | A session not opened from the agent's executeCode (a user's own `openSession`, for one). |
| R2 | This instance admin binding belongs to an executeCode call that has ended. ... | The grant's run has settled, or another run took its place. |
| R3 | The instance admin binding works only in a turn that answers a message this workspace's owner wrote in this chat, ... | The turn is not the owner's own (see [Who it serves](#who-it-serves)). |
| R4 | The instance admin binding works only while this workspace's owner is a deployment admin. | The owner is not in `ADMINS`. |
| R5 | The instance admin connection has been removed from this workspace. | The capsule is gone or replaced. At approval: the capsule the action was queued through is gone; a capsule dropped and added again has a new id, so the old one's cards can't be approved, and stay until rejected or turned off. |
| R6 | The instance admin binding doesn't work in a turn whose reply goes out through an external message. | The chat has a reply to an external message still to deliver. |
| R7 | The instance admin gatekeeper is turned off on this deployment. | The deployment disabled the vendor (read at every mint, grant call, view call and apply). |
| R8 | This instance admin account is no longer available to you. | The user DO, in `getSingletonGatekeeperClass()` and in the account check each run makes: the user is not an admin now, or the account is not their auto-provisioned instance admin account. |
| R8g | The "&lt;vendor&gt;" gatekeeper is disabled on this deployment by an administrator. | `getSingletonGatekeeperClass()` or the account check, for a vendor the deployment disabled. |
| R9 | Deployment admin access works only in a workspace nobody else can open: ... | Asking for or approving activation while anyone else can open the workspace. |
| R10 | AdminApi.&lt;m&gt; isn't available through the instance admin binding. | A withheld method. At approval: a held change, confirm or inspect action whose method `ADMIN_AGENT_ACCESS` no longer gives that kind, after a deploy withheld or reclassified it; the action stays pending. |
| R11 | AdminApi has no method &lt;m&gt;. (`TypeError`) | A name that is not an `AdminApi` method. |
| R12 | &lt;path&gt;: &lt;what&gt; can't be queued for approval; only JSON values can. (`TypeError`) | A queued call's argument that is not a JSON value. |
| R13 | This call's arguments are too large for an approval card: ... at most 40,000 characters. | The call and its card pass `MAX_INSTANCE_ADMIN_ACTION_CHARS`. |
| R14 | &lt;label&gt; returned a capability, which the instance admin binding passes on only from AdminApi.inspectWorkspace(). | A read's, a confirm's or a view call's answer holds a capability. An answer nested deeper than 64 levels is refused too, with a `TypeError` naming it. |
| R15 | The instance admin binding doesn't work in a chat an agent spawner started or in one that reviews a blueprint update, ... | A spawned chat, or a blueprint update's review. |
| R16 | This turn was stopped, so its instance admin binding no longer works. | The owner stopped the turn. |
| R17 | This executeCode call started more than 10 minutes ago, ... | The run passed `INSTANCE_ADMIN_RUN_LIMIT_SECONDS`. |
| A1 | Deployment admin actions are approved only by hand. | An auto-approval. |
| A2 | Only this workspace's owner, while a deployment admin, can approve deployment admin actions. | Anyone else approving. |
| A3 | Deployment admin access is off in this workspace. | Approving a change or a one-call approval, a view call, or a call's answer, while access is off. |
| A4 | This action is already being applied. | Approving or rejecting an action whose call is being made. |
| A5 | Deployment admin access can't be turned on while a reply to an external message is still to be delivered. | Asking for or approving activation with such a reply pending. |
| T1 | Only this workspace's owner can turn off deployment admin access. | Anyone else turning it off. |
| X1 | The instance admin binding can't be bound into a gadget or an agent spawner: ... | `setGadgetBinding`, or an agent spawner's env naming the capsule. |
| X2 | This workspace takes no external messages. | The owner messaging a latched workspace from outside. |
| S1 | Deployment admin access has been on in this workspace, so only its owner can ever open it: it can't be shared. | Adding a collaborator or making a share link in a latched workspace; a redemption there is refused with the `shareLinksDisabled` open error. |

X2 reaches only the owner, and is neutral on purpose: it doesn't say why. Every other sender to a
latched workspace gets the refusal any workspace they can't use gives (the sign-up prompt without
an account, the access refusal with one, since nobody else has a role there), so an external sender
learns nothing about the owner's admin status, which only admins can see. The owner's own texts
(the activation card, the Share modal and the Activity panel) say why.

### Risks

These are accepted. The activation card, the admin panel and the Gatekeeper's README also state the
prompt-injection risk and the advice to use a dedicated workspace, and the activation card says that
other admins can still inspect the workspace; the rest are stated here.

- **Prompt injection can leak what the agent reads.** Restricted mode stops public web fetches and
  git pushes and suspends auto-approval; it doesn't keep data in. What the agent reads goes into the
  chat, to the chat's AI model provider, and into the deployment's AI Gateway logs, which keep
  prompts and responses on the deployment's Cloudflare account for whoever can read them. Steered,
  the agent can send it out through web search queries, MCP servers and other gatekeepers' reads,
  actions on other connections the owner approves, gadgets and exports, blueprints published from
  the workspace, hook or callback turns in the same chat, and push-notification chat titles.
- **The injection can come from anywhere the agent reads:** a user's name, a workspace title, a
  chat, a file, an audit reason, a web page, MCP output, and the inputs every agent's system prompt
  carries: the deployment's instance instructions (any admin sets them, and this agent can queue a
  change to them) and the standard formats' names and hints (blueprint authors and admins write
  them).
- **So use a dedicated workspace, and connect nothing else to it.** That advice has a limit:
  connections every workspace of the owner gets, such as Web Search, are in the dedicated one too,
  unless the owner removes an optional one from Connectors (which removes it from all their
  workspaces) or an admin disables it; and a search query can carry data out without any approval.
- **Approval fatigue.** A change's card is complete, but only as safe as the owner's reading of it.
- **Forwarded bindings** act as the owner until the call ends (see
  [Who it serves](#who-it-serves)).
- **A compromised instance admin Worker** can, during a live owner run with the vendor enabled,
  read what the admin can read (recorded), open metadata views and queue cards. It can't change a
  setting, spend, or read a workspace's content without the owner approving that exact call.
- **Propagation.** Disabling the vendor reaches every grant within the KV mirror's propagation,
  about a minute. Demotion needs a redeploy, as `ADMINS` is an environment variable.
- **Data left behind.** Admin data stays in a latched workspace after turn-off or demotion, until
  the workspace is deleted, and may include content read from other workspaces. Other admins can
  inspect it there (recorded).
- **Re-application after a crash.** A crash between an approved change and its record can let a
  retry make it again. The setters are idempotent, and the audit log shows both.
- **Outbound update checks.** `getUpdateStatus` and `checkForUpdates` run as reads, without
  approval.
- **Re-promotion** restores a latched workspace's last on or off state without asking again.

### The binding's name confers admin power

The Workshop derives the vendor id from the `GATEKEEPER_INSTANCEADMIN` binding, and lends deployment
admin power to whatever Worker answers to it, so the binding is trusted as the backend's own
configuration is. The release build reserves the slug: `releaseShortName()` in
`scripts/release/manifest-lib.ts` refuses any other package whose install slug folds to
`instanceadmin`. The package name has no inner hyphen because the dev server and a release fold one
differently, and the vendor id must be the same in both.

### Tests of the agent path

Unit suites, in `packages/workshop-backend/__tests__/`:

- `admin-agent-access.test.ts`: `ADMIN_AGENT_ACCESS` covers exactly `AdminApiImpl`'s methods,
  matches the `@mutates` and `@confirmation` tags and the Gatekeeper's generated surface, and only
  `inspectWorkspace()` returns a capability (walking the generated schema).
- `instance-admin.test.ts`: the pure rules: canonical calls and their bounds, cards, string fields,
  observations, the nudge, the plain-result walk, which turns answer the owner, blueprint reviews
  and the run limit.
- `instance-admin-grants.test.ts`: against a real Overseer, which sessions get a grant, how long it
  works, each kind of call, a call's one await, applying, rejecting and turning off (and the races
  between them), one-call approvals, views, activation, the latch's effect on sharing and external
  messages, and every refusal.
- `instance-admin-turns.test.ts`: which turns qualify: callbacks, slash commands, retries, steers,
  `/compact`, spawned chats, blueprint reviews and Stop.
- `instance-admin-provisioning.test.ts` and `provisioning-policy.test.ts`: offered to admins only,
  dormant after demotion or disabling, and disabled by default.
- `admin-access.test.ts`, `admin-api-impl.test.ts`, `admin-audit.test.ts`,
  `admin-settings-audit.test.ts` and `admin-workspace-view.test.ts`: `via` `"gatekeeper"` only with
  a well-formed origin, and the origin and session on both kinds of record.
- `sharing.test.ts`: the `ownerOnly` and `onShared` hooks, and `isPrivate()`.

Integration suites, in `packages/integration-tests/__tests__/` (see
[integration-testing.md](integration-testing.md#the-real-instance-admin-gatekeeper)):

- `instance-admin-gatekeeper.test.ts`: who is offered it, turning access on, where the capsule may
  live, changes and their approval, inspections, the turns it serves, the withheld methods, turning
  access off, and the deployment disabling it.
- `instance-admin-gateway.test.ts`: a gateway test sends nothing until its one call is approved,
  then exactly one request; a rejected one never sends.
- `instance-admin-demotion.test.ts`: a redeploy that drops the owner from `ADMINS`.

The Gatekeeper's own suites are listed in its README.

## Error codes

Expected refusals carry a code from `ADMIN_ACCESS_ERROR_CODES` (read with
`getAdminAccessErrorCode()`), which survives Durable Object RPC and Cap'n Web:

| Code | When |
| --- | --- |
| `ADMIN_NOT_ADMIN` | The caller, or a view's admin, is no longer named in `ADMINS`. |
| `ADMIN_WORKSPACE_NOT_FOUND` | A malformed id, or one naming no workspace (never initialised or since deleted). |
| `ADMIN_WORKSPACE_ACCESS_OFF` | The level is `"off"`, by the setting or the cap. |
| `ADMIN_CONTENT_WITHHELD` | `getChat()` or `readFile()` on a view below `"full"`, whether its inspection asked for `"metadata"` (the default) or the deployment held it there. |
| `ADMIN_VIEW_EXPIRED` | The view's lifetime has run out. |

## Tests

The instance admin Gatekeeper's suites are listed under
[Tests of the agent path](#tests-of-the-agent-path).

Unit suites, in `packages/workshop-backend/__tests__/`:

- `admin-access.test.ts`: admin status, the bounds' parsing (failing closed), the policy, validation,
  the per-call level, the cuts, setting values and excerpts, withholding, and whether an answer
  holds content (each predicate, empty values included).
- `admin-config.test.ts` (`diffAdminConfig`) and `admin-settings-audit.test.ts`: what each setter
  records, before which write, and the setters' bounds.
- `admin-audit.test.ts`: the deployment-wide log's listing, filters (`exposed` and `via`, each
  alone and with the others), cursors, schema (the `exposed` column and the CHECK tying it to access records),
  retention, stats (content reads, their rankings and titles, by kind), and multi-MiB titles.
- `admin-api-impl.test.ts`: `AdminApiImpl`'s inspection path, the level asked for (the lower of it
  and the deployment's, and the validator's `TypeError` for any other level), refused opens,
  listings and forwarding.
- `admin-workspace-view.test.ts`: the view, from an uninitialised id that stays uninitialised to the
  per-call checks; `requested` and `exposed` on each method's record; a view that asked for
  `"full"` held at `"metadata"` and never raised; a failed read recorded; a failed record returning
  nothing; the races with deletion and expiry, at the setting read and while a call reads its
  answer, writing nothing; withholding; a 2,000,000-character title; and file reads that never
  pull.
- `user-directory.test.ts`, `user-directory-feed.test.ts` and `workspace-directory-feed.test.ts`: the
  directory and both feeds. The last includes the deletion regression test, which parks a sync on a
  real call to another Durable Object (a plain-JavaScript fake cannot reproduce workerd's hold-back)
  and checks that the deletion still completes.

Integration suites, in `packages/integration-tests/__tests__/`:

- `workshop-admin-inspection.test.ts`: every admin method this surface adds refused to a non-admin;
  the directory; an inspection recorded apart from the workspace and absent from the owner's
  `listActions()` and `subscribeToActions()`; metadata and off; the level asked for, and raising
  the setting not raising a view; what each call returned and the `exposed` filter; a deleted id
  refused without being written; an audit write failure, where a content read returns nothing while
  the workspace keeps the attempt; expiry; and long text end to end.
- `workshop-admin-audit.test.ts`: every setting change recorded before it takes effect, `via`,
  filters, stats and content reads across two admins, and a refused change when its record cannot
  be written.
- `workshop-admin-bounds.test.ts`: the bounds' defaults, and a redeploy that tightens them (an
  invalid cap failing closed) and demotes an admin. The redeploy ends every session, the demoted
  admin's view among them, so the per-call re-check that stops a live view once its admin is demoted
  is covered by `admin-workspace-view.test.ts`.

The integration suite reaches Durable Object storage directly (see
[integration-testing.md](integration-testing.md#reaching-a-durable-objects-storage-from-a-test)): it
faults the deployment-wide log with a trigger on `admin_audit`, and shows that an inspected deleted
id stays unwritten by listing its `sqlite_master`.
