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

Active and paused continuations persist their request and execution identity. Authorized
approval/connection wake-ups are journalled before yielding, including during suspension
cleanup. Recovery consumes that marker without re-arming it from duplicate decisions.
Cancellation and terminal cleanup are fenced against newer continuations. Callback
failure retains its outbox and retry deadline; callbacks have a one-hour delivery bound.

Tests exercise real Durable Object eviction, lost acknowledgements, concurrent decisions,
revocation, callback retries, cancellation, and approval arriving during cleanup. This
change exposes no filesystem, replica, container, image, or network-policy API.
