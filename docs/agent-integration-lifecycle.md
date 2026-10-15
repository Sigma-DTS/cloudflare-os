# Scoped agent lifecycle and action recovery

`AGENT_INTEGRATION_GRANTS` is trusted deployment configuration keyed by vendor ID.
The independent `lifecycle`, `contextualActions`, and `recoverableActions` flags
default to denied. Ambient account provisioning does not grant any of them.

Eligible approval queues expose an ephemeral `AgentContext`. Its persistent participant
receives started/resumed/suspended/finished events through a durable, at-least-once
outbox. Participants must deduplicate event IDs. One logical turn can span several
execution segments; stale contexts never acquire a later prompt's authority.

Contextual action application receives fresh capabilities after approval. Opting into
recoverable application requires durable effect deduplication in the receiver; legacy
actions are not automatically repeated. Nested approvals remain explicit queued actions,
not new permission. Contextual dispatch never falls back to legacy application after a
failure whose effects may already have happened.

## One continuation machine

This layer extends the [continuation core](agent-continuation.md); it does not introduce another
recovery machine. `agentContinuations`, keyed by chat, retains the original initiator and model
reference, logical turn, execution ID, and segment.
Model secrets are re-resolved from the original user's DO, never stored in the record.
`chatMeta.activeAgent` and the in-memory running registry are projections for UI and liveness,
not independent recovery journals. The legacy `activeAgents` collection is migration-only.

The normal path is `starting → running → finishing → finished`. A decision wait instead takes
`running → suspending → paused → starting`. Cleanup settles the suspending/finishing states;
it never re-runs inference. A resumed pause gets a new execution and segment but keeps its
logical turn. A running execution interrupted by eviction keeps its execution identity and
rotates its segment, expiring old capabilities.

Each pause names exactly the action IDs or connection requests it awaits. A matching decision
sets `ready` durably **before** message-preparation I/O, even if suspension cleanup is still
running. Cleanup or recovery consumes that ready pause once. A decision arriving before the
pause needs no wake-up flag: the transition reads its persisted result. Duplicate decisions
cannot authorize a later wait. Nested approvals extend the parent's wait in the same transaction
that publishes the child. Cancellation, chat deletion, and superseding prompts terminate the
old continuation; stale cleanup is fenced by execution identity.

Lifecycle notifications are an output of these transitions, not another turn state machine.
The transition and its participant outbox writes commit together. Delivery is at-least-once:
a failed callback keeps its event ID and retry deadline, and recipients must durably deduplicate.
Entry callbacks drain before model execution; terminal callbacks can retry with cleanup-only
authority after a chat is deleted or its next turn starts. Ordinary contexts expire with their
segment, and delivery contexts expire with their outbox event. Callbacks have a one-hour delivery
bound; neither a timeout nor a lost response proves the receiver did nothing.

Durable alarms recover runnable continuations, pending callback deliveries and authorized action
receipts without an open browser. Effects are retried only under the receiver's explicit durable
deduplication contract. This does not make arbitrary shell commands or other unjournalled
effects exactly-once.

Tests separate synchronous transition rules, native persistent-RPC delivery, receiver-deduplicated
action application, and a small real-eviction matrix covering suspension, durable wake-up and
cleanup boundaries. This change exposes no filesystem, replica, container, image, or
network-policy API.

The version-7 migration adds lifecycle identities to version-6 continuation-only rows while
preserving their execution IDs, waits, ready bits and terminal outcomes. No participant existed
before that API was installed, so it does not invent historical callback deliveries.
