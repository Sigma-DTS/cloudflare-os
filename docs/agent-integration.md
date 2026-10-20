# Agent lifecycle notifications and turn finalization

Gatekeepers can follow a logical agent turn across approval pauses and Durable Object
resets. Most lifecycle events are notifications, not barriers. The one blocking boundary
is the end of the logical turn: required cleanup must finish before that workspace's chat
can accept another turn. For a container, this is where the gatekeeper drains workspace
edits and completes its required shutdown/checkpoint work.

## Contract

`AGENT_INTEGRATION_GRANTS` is trusted deployment configuration, keyed by vendor ID:

```json
{"container":{"lifecycle":true}}
```

Only the literal `lifecycle: true` grants access. Ambience alone grants nothing.
No shipping gatekeeper is opted in by this change. Contextual action application,
automatic effect replay and extending completed turns are out of scope.

`ApprovalQueue.getAgentContext()` returns a capability for the agent segment that
opened the session, or null for non-agent/ungranted sessions. A retained binding cannot
borrow a later prompt's authority. `participate()` durably registers one persistent
receiver per connection and logical turn. It is idempotent and does not call the receiver.
The gatekeeper initializes lazily when first used; there is no `started` event.

| Event | Meaning of the callback returning | Blocks inference? |
| --- | --- | --- |
| `suspended` | Durably received responsibility for the notification | No |
| `resumed` | Durably received responsibility for the notification | No |
| `finished` | Required end-of-turn cleanup is complete | Ends the turn before later work |

Gatekeepers own the durable work behind notifications, synchronization, snapshots,
watchdogs and their own retry journals. An ACK is not a claim of completed work except
for `finished`. Container initialization/restore may still await its own initial catch-up
before its launch method returns; that is not a kernel lifecycle barrier.

## One end-of-turn boundary

Completion, errors, Stop, denied decisions, deletion and replacement of a paused turn all
end the old logical turn. The kernel persists `finishing` on the existing execution row
before awaiting finalization. It queues `finished` for the integrations that actually
participated, calls them in parallel, and releases the chat only after all acknowledge.
Queued steers and agent callbacks cannot start another turn before this boundary.
Stop aborts inference immediately, but does not abandon required cleanup.

Approval waits are not terminal. The existing execution row keeps its original model and
caller, the chat becomes idle for the decision, and `suspended` is sent asynchronously.
Approval claims a fresh segment and sends `resumed` without waiting for notification
delivery. A new prompt replacing that paused turn ends it instead: it cannot overtake
the predecessor's finalization. There are no general pre-inference notification drains,
entry-ready/deferred states, or cancellation-raced lifecycle waits.

## Delivery and recovery

The indexed participant outbox stores ordered pending events, stable event IDs and retry
deadlines. Receivers durably deduplicate IDs, including when cleanup succeeded but its
reply was lost. A failed delivery retains its receipt with a 30-second retry deadline;
the existing shared alarm and immediate best-effort delivery drive retries. There is no
second polling interval. End-of-turn finalization also drains outstanding notifications
in order, so receivers must ACK advisory events promptly rather than doing long work in
those callbacks.

An individual callback has a one-hour invocation bound, not an abandonment deadline.
Unacknowledged cleanup has no age/attempt cutoff. A failed receiver can keep a turn
finishing until repaired; correctness takes precedence over admitting more work.

After a DO reset, a `finishing` execution retries finalization, never inference. A lost
final ACK reuses the same event ID; an already-acknowledged receiver is not called again.
The execution row and chat log remain the canonical driver: no second continuation
table or replay engine is introduced. Optional identities/outbox records need no backfill.
Live completion and reset recovery use the same finalization and queued-turn handoff.
A queued successor keeps the original caller/model ID and uses normal model lookup;
there is no separate in-memory continuation carrying credentials across cleanup.

Contexts expire at segment boundaries. Delayed callbacks must read their fresh context's
phase; it may now authorize cleanup only. Revocation and connector/chat removal retain
cleanup receipts and their cleanup-only delivery capability, not permission to run new
commands. Removing a connector is not an escape hatch for abandoning cleanup.

Workspace deletion durably fences new work, stops turns and drains finalization before
erasing storage. Failed finalization retains the fence across resets. Once finalization
has succeeded, an unrelated hook/owner deletion failure releases that fence so the owner
can work or retry deletion.

Workerd tests exercise real capability routing, nonblocking notifications, all-participant
finalization, queued-turn ordering, Stop, removal, lost ACKs and real DO eviction.
