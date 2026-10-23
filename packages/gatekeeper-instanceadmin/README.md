# Instance admin

Instance admin is an ambient gatekeeper that lets a deployment admin's agent use the deployment's
[Admin API](../../docs/admin-access.md) as them: read the settings, the user and workspace
directory, the admin audit log and update status, inspect workspaces, and change settings, each
change approved by the admin. It has no connect flow, no settings and no management UI. This file is
its design record; [`docs/admin-access.md`](../../docs/admin-access.md#through-an-agent) describes
the same feature from the deployment's side.

## Who can use it

- **The deployment chooses.** The admin Gatekeepers panel sets its mode, like every
  auto-provisioned gatekeeper's, but it starts **Disabled**, not Optional: its accounts lend an
  agent deployment admin power, so a deployment offers it only once an admin decides to.
- **Only admins get it.** The Workshop offers, provisions and lists the account only for a user who
  is a deployment admin (in `ADMINS`) now. A demoted admin's account is hidden, and its binding
  leaves their workspaces when each next opens.
- **Only where the admin turns it on.** Each workspace starts with deployment admin access off.
  The agent's first call asks the owner to turn it on, through an approval card in that workspace.

A user who has it gets an `INSTANCE_ADMIN` binding in the agent's `executeCode`. It can't be bound
into a gadget or an agent spawner, and it never reaches a spawned chat.

## Why it holds no power

The Worker has no binding, no credential and no Admin API of its own. For each session the Workshop
lends it an `InstanceAdminGrant` (`packages/workshop-shared/src/instance-admin.ts`), through the
facet's `startAdminSession()`, the one entry point the Workshop calls on it. The session forwards
every call to the grant, and the Workshop decides everything about it:

- **What each method may do.** `ADMIN_AGENT_ACCESS` in `packages/workshop-shared/src/api.ts` gives
  every AdminApi method a kind: `read`, `change`, `confirm`, `inspect` or `withheld`. It is typed
  to cover AdminApi exactly, so a new method doesn't compile until someone decides its kind.
- **What the owner approves.** A change, a gateway test or a full inspection becomes an action the
  Workshop queues itself, with a card it words itself, and on approval it makes exactly the stored
  call. The facet has no ApprovalQueue and submits no actions: `startSession()`, `applyAction()`
  and `addObserver()` refuse.
- **Whether the call may run at all.** The grant works only for the agent's executeCode call it
  was minted for, and re-checks before every call and every answer (see
  [Which turns qualify](#which-turns-qualify) and [Limits](#limits)).

So a compromised instance admin Worker could, during a live owner turn, read what the admin can
read (recorded), open metadata views and queue cards. It could not change a setting, spend, or read
a workspace's content without the owner approving that exact call.

## The generated surface

The agent's types are generated, not written. `packages/api-schema` extracts the Workshop API's
schema from `api.ts`, and `scripts/generate.ts` writes `generated/admin-api.schema.json`: AdminApi
and what it reaches, less the withheld methods. This Worker bundles that schema and builds
everything from it ([`src/surface.ts`](src/surface.ts)):

- the session's methods, one per AdminApi method;
- the declarations `getTypeScriptTypes()` returns, `emitDeclarations()` of the schema under a
  preamble that tells the agent how the binding behaves;
- the argument check each call passes before it is forwarded (`checkArguments()`).

At load the Worker checks that the schema is what the session relies on: rooted at AdminApi, every
service the Workshop's, no properties, a capability only in `inspectWorkspace()`'s result (a view),
plain data in every parameter, and no method named `then`, `dup`, `onRpcBroken`, `constructor` or
after an `Object.prototype` member. It refuses to load otherwise.

A new AdminApi method needs no code here:

1. Classify it in `ADMIN_AGENT_ACCESS`. A setter also goes in `ADMIN_SETTING_METHODS` and is tagged
   `@mutates`; a call the deployment pays for is tagged `@confirmation`; a withheld method also goes
   in `ADMIN_OMIT` in `packages/api-schema/scripts/generate.ts`.
2. Run `pnpm api-schema:generate`.
3. Rebuild and deploy this Worker, which bundles the new schema.

There is no progressive disclosure: the contract has no per-type query, so the agent gets the whole
declarations, about 48 KB.

## What each kind does

From the agent's side:

| Kind | Methods | What a call does |
|---|---|---|
| `read` | settings, `listUsers`, `listWorkspaces`, the audit log and its statistics, update status and `checkForUpdates`, `isBlueprintFeatured` | Runs at once and returns its result. |
| `inspect` | `inspectWorkspace` | At `"metadata"` (the default), a read; the view it returns works until the executeCode call ends, and every call on it is a read. At `"full"`, a `confirm`. |
| `change` | the setters, tagged `@mutates` | Changes nothing yet: queues exactly that call for approval and resolves to `undefined`. Reads don't show the change until the Workshop makes it. The agent's turn ends after the executeCode call; if the owner approves, the Workshop makes the call and the agent is resumed. |
| `confirm` | the three gateway tests, tagged `@confirmation` | The first call asks for approval of that one call and throws. Once resumed, the agent makes the identical call in the same chat within 15 minutes, and it runs once. |
| `withheld` | `setSiteLogo`, `setAdminWorkspaceAccess`, `setAdminAuditRetentionDays` | Not in the agent's types; refused. The admin sets them in the admin panel. |

While access is off in the workspace, every call asks the owner to turn it on and throws. Each
message the session throws names the action the owner is asked to approve and says what to do once
resumed ([`approvalMessage()`](src/surface.ts)).

The gateway tests send requests the providers bill through the deployment's AI Gateway, which is
why they need approval although they change no setting. `checkForUpdates` makes an outbound
request too, but costs nothing, so it is a read.

## Turning access on and off

- **On.** The agent's first call queues the activation card. The owner approves it by hand, while
  a deployment admin, with the vendor enabled. It is refused while anyone else can open the
  workspace (a collaborator, a share link, a collaborator's session still open) or while a reply
  to an external message is still to be delivered.
- **Off.** The owner turns it off at any time from the Activity panel, whether or not they are
  still an admin. Every pending deployment admin action is rejected, approved calls not yet made
  are dropped, and every grant stops working. A change already being made completes. The next call
  asks to turn access back on, with the reactivation card.
- **The latch.** Once access was ever on, the workspace is its owner's alone for good: it can't be
  shared, takes no external messages, and is restricted (no public web fetches; every action waits
  for approval). Turning access off doesn't undo that, because the workspace still holds what its
  agent read. The latch keeps out collaborators and links, not admins: other deployment admins can
  still inspect the workspace, as they can any workspace, and their inspections are recorded in the
  admin audit log.

## Which turns qualify

The binding works only in turns that answer a message the owner wrote themselves, in a chat that is
neither spawned nor a blueprint update's review:

- A turn a gadget's callback started doesn't qualify, nor does one a connection's slash command
  started: its prompt is the text the command's provider wrote, although the chat logs it as the
  owner's. Retries and resumptions of such a turn don't qualify either. The owner's own next
  message does.
- Retries, approval resumptions and steers continue the task before them, and qualify exactly when
  it did.
- The owner's built-in `/compact` counts as theirs: it is the owner's command, not a connection's,
  and never fails a turn closed. It holds no task text and its turn runs no tools, so a retry after
  it continues whatever task came before it.

## What is recorded where

- **In the workspace's activity** (restricted data, visible to its owner alone): every read, every
  view call, and every call that ran on a one-call approval, whether it returned or threw, with its
  arguments; and every change and approval request, as an action.
- **In the deployment's admin audit log** (`via` `"gatekeeper"`, with the workspace, chat and
  approving action as its origin): inspections (the open and every view call) and setting changes.
  Directory, settings, audit-log and update reads are not recorded there.
- **In this Worker's logs:** event names only. Arguments, results and the Admin API's errors, which
  can quote an argument, stay in the workspace.

## Limits

- **One executeCode call.** A grant, and every view opened through it, works only while the
  executeCode call it was handed to runs: until its code settles, the owner stops the turn, or 10
  minutes pass since the call started, whichever comes first. The agent makes further calls from a
  new executeCode call.
- **Forwarding.** Anything the agent hands the binding or a view to during a live call (a gadget, a
  callback, another binding) acts as the owner until the call ends. The Workshop can't tell those
  callers apart, so the preamble tells the agent never to do it.
- **The binding's name.** It is `INSTANCE_ADMIN`, or `INSTANCE_ADMIN_2` in a chat that had the
  binding before the capsule was dropped and re-added. The preamble and the messages don't rely on
  the name.
- **Cards from a dropped capsule.** Pending cards queued through a capsule that was later dropped
  can't be approved, and stay until the owner rejects them or turns access off.

## Prompt injection can leak what the agent reads

Everything the agent reads goes into the chat, to the chat's AI model provider, and into the
deployment's AI Gateway logs. Text it reads can steer it: a user's name, a workspace title, a chat,
an audit reason, a web page, and also text every agent's instructions carry, such as the
deployment's instance instructions (any admin sets them) and the names and hints of its standard
formats (blueprint authors and admins write them). Steered, it can send admin data out through the
workspace's other connections (web search, MCP servers, other gatekeepers), through its gadgets, or
through blueprints published from the workspace. Restricted mode stops public web fetches and git
pushes, not these.

So use a dedicated workspace for deployment admin access, and connect nothing else to it. That
advice has a limit: connections every workspace of the owner gets, such as Web Search, are in the
dedicated workspace too, unless the owner removes an optional one from Connectors (which removes it
from all their workspaces) or an admin disables it, and a search query can carry data out without
any approval. The activation card, the admin panel and [`docs/admin-access.md`](../../docs/admin-access.md#through-an-agent)
say the same.

## Departures from the usual gatekeeper

- **The agent's types talk about approvals, and queued changes are not simulated.** The
  write-gatekeeper skill keeps approvals invisible to the agent by simulating pending actions. Here
  the Workshop holds the queue, not this Worker, and a one-call approval only works if the agent
  repeats the call, so the preamble says how approvals work and reads show the deployment as it is.
- **One RPC class without `@validateRpc()`, and one method with `@skipRpcValidation()`.**
  `InstanceAdminSession` defines its methods from the schema at load, in a static block, so its
  TypeScript type declares none of them and a validator built from it would refuse them all. For
  the same reason the facet's `startAdminSession()` is `@skipRpcValidation()`: capnweb-validate
  builds a method's return validator from its declared type, and would return the session wrapped
  in a proxy refusing every AdminApi method. Calls are still checked: by `checkArguments()` in the
  session, then by the Workshop's validated grant, then by its validated Admin API. The skip also
  leaves the grant argument unchecked, which only the Workshop passes.
- **Private state.** The session keeps its grant in a real private field, because RPC exposes an
  RpcTarget's properties as well as its methods.

## Tests

- `__tests__/surface.test.ts` (Node): the bundled methods are AdminApi's less the withheld three;
  the declarations match `admin-api.agent.d.ts`; the preamble; the load-time checks refuse doctored
  schemas; each approval message.
- `__tests__/workerd/session.test.ts` (workerd, the validated build): the facet's description,
  types and refused entry points; the account's lack of resources; and, through sessions opened
  with the facet's `startAdminSession()` over a fake grant, reads, a view that outlives its call,
  queued changes, approval messages, refused arguments, nothing but AdminApi's methods exposed,
  disposal, and errors passed on.
- The Workshop's side, which makes every decision, is tested in `packages/workshop-backend`
  (`instance-admin*.test.ts`, `admin-agent-access.test.ts`), and end to end in
  `packages/integration-tests` (`instance-admin-*.test.ts`).

Run `pnpm exec vp run -F @gadgets/gatekeeper-instanceadmin test`.
