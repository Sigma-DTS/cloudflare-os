# Keyed native delivery

Repository sessions expose additive `submitDelivery(requestKey, command, expected)` and
`deliveryOperation(requestKey)` methods. Persist a lowercase UUID and the normalized intent
before submission. `expected` is the current business repository's native `pushContinuity()`
witness, not identity fields supplied by a gadget, endpoint label, model, or UI.

The command is one of:

- `{ kind: "createPullRequest", options }`
- `{ kind: "postComment", pullRequestId, bodyMarkdown }`
- `{ kind: "postReview", pullRequestId, review }`
- `{ kind: "markReady", pullRequestId }`

Existing-PR operations require a real positive PR number as a string. A provisional create
handle, matching discussion text, and an unchanged parent URL are not application evidence.
The create receipt yields the real number only after its original provider mutation succeeds.
Promotion uses GitHub's supported `markPullRequestReadyForReview` GraphQL mutation with a node
ID resolved through the native pinned repository. It always requires manual approval, as an
approving review does. No merge, administration, OAuth scope, or existing approval rule changes.

Canonicalization recursively sorts object keys by JavaScript string order, preserves array order,
and omits undefined fields. An omitted create body becomes `""`, an omitted draft flag becomes
`false`, and an omitted review body/diff-comments list becomes `""`/`[]`. The digest is lowercase
hex SHA-256 of the UTF-8 JSON serialization of that normalized command, limited to 65536 bytes.

One durable key binds canonical arguments, SHA-256 digest, original native action ID, native
binding/account/repository witness, and the original application generation. Same key and
arguments reconcile that action. A changed payload or precondition refuses reuse. The existing
native action store and `ApprovalQueue` remain the only execution path. At most 4096 retained
key bindings may be allocated in a facet; reaching the bound refuses new keys rather than
forgetting a tombstone and permitting duplicates.

The bounded receipt contains `version`, operation `id`, `requestKey`, `digest`, optional original
`actionId`, and one of `preparing`, `submitting`, `pending`, `applying`, `applied`, `rejected`,
`failed`, or `uncertain`. A fixed pre-effect scope refusal may include `failure: "scope-changed"`.
Only an applied receipt may carry `resource: { repositoryId, pullRequestId, commentId?, reviewId?,
readyNodeId? }`. IDs come from the original provider response. No command body, credential,
provider diagnostic, or simulated resource URL is included. Receipt reads are native operational
observations and recheck the current witness, including its grant.

A durable application claim precedes asynchronous scope checks. The original mutation is sent
through the current native account generation and pinned numeric repository route. A producer
send-phase marker is written after credential preparation and immediately before provider fetch;
the Durable Object output gate commits it before external I/O. Known pre-send failures are
`failed`; failure or interruption after this marker is `uncertain`. Uncertain effects cannot be
replayed or discarded as unapplied. A lost queue acknowledgement before any application may
still be applied once by its original native approval action; resubmission never creates a new
queue action. Automatic native application during queue submission cannot be overwritten by a
later pending acknowledgement.

The facet witness uses the kernel-minted binding ID from the current native Git cache, the native
parent context, account object ID, and a durable nonce. Same-parent sibling facets must present
their distinct native binding IDs: a stored nonce or a display name alone cannot establish
identity. Tests do not claim to distinguish two fabricated contexts presenting the very same
native identity witness. Confirmed reconnect changes the grant; ordinary refresh does not.
Already admitted sends cannot be retroactively canceled by a later reconnect.

Legacy create/comment/review methods retain their existing return shapes and queue behavior.
Tests run the public session and original native facet/application methods in workerd, with
credential boundary state and provider/queue/Git I/O fakes. They do not qualify a real provider,
deployment, installation, pin transition, or permission change.
