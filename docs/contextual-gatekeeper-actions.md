# Contextual application of approved gatekeeper actions

This layer builds on [agent lifecycle subscriptions](agent-integration.md). It does not
add another turn driver or change lifecycle event delivery.

## User story and permission

An agent can queue a container command, pause for approval, and have that command
applied with fresh capabilities for the original logical turn. A later prompt never
supplies authority for an older action. If the original turn ended, action application
receives no agent context.

Trusted deployment configuration opts a vendor in independently of lifecycle access:

```json
{"container":{"lifecycle":true,"contextualActions":true}}
```

Both permissions default to denied. Ambient provisioning grants neither. Contextual
action application alone does not permit registering lifecycle participants. No
shipping gatekeeper is opted in by this change.

## Dispatch and recovery

The dispatch choice and original turn are pinned when an action is queued. Opted-in
actions call `applyActionInContext()` with a fresh, action-scoped Git cache and the
original agent context. A paused original turn is allowed; an ended/replaced turn
returns null, never the approver's current turn. Action contexts expire with dispatch.
Non-awaited actions do not extend the model turn's lifetime.

There is no fallback to legacy application after contextual dispatch, and revocation
fails closed. Existing/ungranted actions keep legacy behavior even if a grant is later
added. Before contextual dispatch, the action row records that an attempt has begun.
An attempted action left pending blocks automatic drains, including coalesced drains
and drains after reset. An awaited action behind that fence suspends the agent; this
decision is checked when the tool finishes, not only when the action is submitted.
This conservative fence also covers a reset just before the
remote effect; it cannot distinguish that from a lost reply after success. Explicit
retry remains possible after checking the outcome; receiver idempotency is still
required. This layer does not claim exactly-once execution across an unjournalled
remote-effect boundary.

The workerd regressions cover real eviction/lost replies, #797's pause/resume/inference
path, registration cycles, revocation, stale capabilities, deletion cleanup, and
contextual dispatch without fallback or automatic replay.
