# Agent integration on durable execution records

This is the lifecycle-only replacement for #779, based on main after #797. The existing `activeAgents`
row and chat/action logs still drive execution, decision readiness and resumption.
There is no continuation table, saved phase, wait list, ready flag or second driver.

## Scope

This layer provides scoped lifecycle notifications and cleanup coordination. Contextual
application of approved actions is a separate follow-up; it is not part of this API.
Automatic effect replay, nested approval trees, and extending completed model turns are
also out of scope.
No shipping gatekeeper is opted in or modified by this change.

`AGENT_INTEGRATION_GRANTS` is trusted deployment configuration, keyed by vendor ID:

```json
{"container":{"lifecycle":true}}
```

Lifecycle permission defaults to denied. Malformed or unknown grant fields fail closed.
Ambient provisioning does not grant lifecycle participation.

## Lifecycle output, not another workflow

An execution gets an optional opaque turn/segment identity when an eligible binding
is minted. The turn identity survives #797's decision pauses and resets. The segment
expires as soon as a resume is claimed, before asynchronous model lookup or cleanup;
inference entry then rotates it for the new segment. Binding props
capture their origin before async session lookup; opening a retained binding cannot
borrow a later prompt's authority.

`AgentContext.participate()` durably registers one persistent participant per turn
and connection. Registration is idempotent, never replaces the original target, and
acknowledges registration rather than waiting for a callback. This avoids callback
re-registration cycles, including a phase change to cleanup while a callback awaits.
Integrations initialize lazily on first use; they must not
depend on a started callback arriving before the registering method returns.

One indexed outbox stores participants, pending events and retry deadlines. It holds
no copy of execution authority or progress. Execution removal/replacement and terminal
event writes share the storage transaction. #797's retained decision row produces a
suspended event; re-entry produces resumed. Finished means the row ended, whether by
completion, failure, Stop, deletion, denial or replacement.

Delivery is ordered and at-least-once, with stable binding-scoped event IDs. Receivers
must durably deduplicate them. A failed or lost ACK keeps the receipt and a 30-second
retry deadline; each invocation has a one-hour bound. The shared alarm retries without
a browser, including while it holds another long-running turn open. In-memory timers
and single-flight guards are conveniences, never recovery authority.

Predecessor cleanup and entry deliveries drain before inference. Failure leaves the
same runnable execution row for the existing alarm, not a new continuation state.
Stop interrupts that entry wait without waiting for an unresponsive callback; its
durable finished receipt still drains through the outbox before a later entry.
Cleanup contexts remain available after revocation or chat deletion, but authorize no
new commands. Delayed entry callbacks must inspect the context's current phase: they
may already be cleanup-only. Every delivery-context read rechecks the connection and
lifecycle grant, downgrading to cleanup-only after revocation. Delivery contexts expire
when that attempt ends.

Workspace deletion records a durable fence, cancels queued/existing turns, then drains
cleanup before deleting storage. Failed cleanup leaves both the fence and receipts;
the owner can retry deletion, and resets cannot restart inference in the meantime.

Version 6 adds the initially empty outbox and optional metadata without rewriting
existing executions or inventing historical callbacks. This replaces the unmerged
#773/#779 design; it is not a migration from their experimental continuation schema.

The workerd regressions cover real eviction/lost replies, #797's pause/resume/inference
path, registration cycles, revocation, stale capabilities and deletion cleanup.
