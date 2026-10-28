# Native push publication operations

`push()` queues approval and repository reads may simulate its pending changes. Neither
its void response nor a matching `resolveRef()` result certifies remote publication.
The additive keyed API provides that distinction without another queue or authority.

```ts
// Persist this native witness, key and normalized intent before sending the submission.
const expected = await repo.pushContinuity();
const receipt = await repo.submitPush(persistedKey, {
  branch: "dispatch-claims/example", commitId: preparedCommit, force: false,
}, expected);
const current = await repo.pushOperation(persistedKey);
```

The caller owns durable intent; the producer owns account authority, scope, action ids,
CAS and publication evidence. A key is a lowercase UUID, scoped to the native account
and facet. Reusing it with changed branch, commit, force or continuity is refused. The
payload digest is SHA-256 of the canonical UTF-8 JSON object with fields `version: 1`,
`branch`, `commitId`, and `force` (default false), in that order. It grants no authority.

## Native continuity

The witness contains exactly `version`, opaque `facet` and `grant`, and `repositoryId`.
The facet hash includes the native root id, the binding id returned by the native Git
cache capability, the account id and a persisted nonce. Sibling facets can share a
root `ctx.id`, so a root id plus a copied nonce alone is insufficient. The native cache
binding id is workspace-local, can be zero, and is stable across sessions and native
application. It is not caller identity, delegation, permission or proof of live access.

The producer requires the optional SDK `GitCache.getBindingId()` capability. Missing
support refuses the new API; it never falls back to aliases, UI/model fields or the
root id alone. Session and action capabilities carry the binding supplied by the
existing native kernel factories. The grant hash derives from the credential
coordinator's connection generation: confirmed reconnect changes it, refresh preserves
it. Credentials and raw generation fences never enter the public receipt.

Continuity and operation status authorize operational observations and validate the
account and pinned repository through the producer. Submission validates the expected
witness before staging, and application checks the action-scoped native cache and grant
again. The expected generation also fences credential acquisition before HTTP send.
Keys, repository names, ids and metadata from the caller cannot substitute authority.

## States and recovery

| State | Evidence and continuation |
| --- | --- |
| preparing | Key/payload persisted; no action has been submitted yet. An interrupted preparation fails without inventing a new action. |
| submitting | Native action and receipt staged together, before the queue call. |
| pending | Queue acknowledged; publication is not confirmed. |
| rejected | The existing native action was discarded. Same-key retries do not create another. |
| applying | Original native application fenced before asynchronous I/O. Concurrent apply/discard cannot represent it as unapplied. |
| applied | Native CAS acknowledged, or an authenticated actual-head observation confirms the desired publication. This proves a past state, not the branch's current head forever. |
| failed | A known no-ref-change outcome, including a pre-send refusal or explicit receive-pack rejection. Scope mismatch has only the fixed `scope-changed` reason. |
| uncertain | Submission/effect acknowledgement is missing and the available evidence cannot establish the result. No blind resend. |

An already-published no-op can return applied without a new action. Keyed preparation
reads the real head, not pending simulation; a simulated no-op remains pending approval.
Lost submission acknowledgement retains the original staged action and same key. Its
native approval or rejection can still settle it. An apply that finishes before the
queue acknowledgement is not downgraded by that late acknowledgement.

The effect fence precedes every asynchronous apply boundary. Restart or lost reply does
not replay a possibly sent push. Read-only recovery may confirm a real head matching
the original action after its native apply fence; pending submission alone cannot
acquire approval from a coincidentally matching simulated or externally published ref.
No HTTP mutation is performed by operation status. If current authority cannot observe
the repository, or the real head provides no proof, uncertainty remains. Reconnect
cannot authorize a new effect from the old intent, even when limited status can reconcile
a past effect. A consumer must independently gate its private historical state.

Receipts expose only version, producer operation id, requestKey, state and an optional
fixed failure. They omit branch, payload, digest, native action id, raw diagnostics and
credentials. The native action shows the producer operation id for human correlation.
Existing observer, restriction, force-push and autoapproval rules remain in force.

## Storage and vanilla compatibility

No namespace or Durable Object migration is added. New facet KV keys and the optional
push action reference are described in [the storage schema](storage-schema.md). Old
records are not rewritten into fictional receipts, and old methods keep their behavior.
The SDK metadata method is optional so unrelated consumers retain their contract; the
keyed API requires the supporting kernel version and fails closed without it.

Do not automatically downgrade a provider while keyed actions remain pending, applying
or uncertain. Older provider code ignores the added operation fence and cannot enforce
its at-most-once/reconnect semantics. Before a vanilla downgrade, stop new consumers and
settle or explicitly retire outstanding native actions without deleting history; an
uncertain effect must be reconciled, not blindly discarded. The new consumer must refuse
an older/missing receipt API rather than fall back to simulated publication. A clean
rollback is conditional on that quiescence, not an implicit permission to merge/deploy.

Workerd tests exercise real producer/account/session/native-cache classes over explicit
OAuth, Git objects and remote CAS doubles. They do not qualify GitHub, the whole OS or a
deployed application. Scope/receipt correctness does not by itself complete Dispatch's
state migration, orchestration activation or runtime recovery.

## Deterministic validation record

The scoped Node suite passed 54 tests in 0.306 seconds. The scoped Workerd suite
passed 209 tests in 6.93 seconds, including legacy reads/pushes, credentials and hooks.
Both GitHub TypeScript projects and scoped lint passed; existing lint warnings remain.
Only the typed-storage dependency was built to satisfy the real native-cache import.
No whole-OS build or test, provider call, inference or deployment was performed.

Three behavioral mutations were rejected by assertions in the real producer suite:
removing the final discard fence lets a late dependent-PR rejection retire an applying
push (2.737 seconds); omitting the native binding id aliases copied sibling facet KV
(2.148 seconds); permitting pending status recovery grants approval from another
actor's matching remote head (1.101 seconds). The last case initially survived and
required an additional pending-action regression. Each mutation restored production
source byte-for-byte. A test startup failure was never counted as a killed mutation.

The real `GitCacheImpl` RPC projection is exercised for binding zero, another binding,
and an action-scoped cache. Its existing kernel construction sites were inspected:
both session authorizers supply their native `gatekeeperId`, and apply supplies the
persisted action's `gatekeeperId` and action id. This source inspection is distinct
from the runtime projection test; it is not a full Overseer integration qualification.
