# Byte worktree mutations

Text keeps the existing UTF-16 OT algebra. Worktrees (including attachments), not gadget
source, additionally accept opaque bytes. A byte reference is a workspace-local immutable
identity, **not** read authority. Bulk payloads never travel inside a `CodeChange` or its logs.

## Data and operations

`BytesRef = {id, byteLength}` names immutable storage. `ByteSlice = {source, offset, length}`
names a positive-length range of a reference. `ByteValue = {base, edit?}` represents a
postimage without fetching it. The optional `ByteChange` uses byte coordinates:

```ts
{beforeBytes: 10, sections: [4, [2, {source: inserted, offset: 0, length: 3}], 4]}
```

This retains four bytes, deletes two, inserts three immutable bytes, then retains four.
Every transform tiles its exact before-length. Range arithmetic, source bounds, section
counts and the existing serialized OT budget are checked before publication.

The file operations are:

- `setBytes`: create/replace a file with a `ByteValue`, including an empty byte file.
- `editBytes`: splice an existing byte postimage; absence or representation/length mismatch
  fails. Inserts are references, not embedded bytes.
- `remove`: the existing deletion operation, equally applicable to text and bytes.

Sequential edits compose over the original base. Concurrent byte edits transform without
reading or hashing payloads; earlier canonical inserts win insertion-order ties. The existing
assignment/remove policy supersedes edits; later assignments supersede earlier assignments.
Concurrent text edits and byte edits reject representation disagreement. These are mechanical
byte merges, **not** format-aware merges of PNG, ZIP, SQLite, etc. Use replacement by default;
only issue explicit byte splices when the writer knows the ranges and format can tolerate it.

## Staging and authority

`Worktree` and `WorkspaceReplica` use the same resumable staging primitive:

1. `beginUpload(id, {byteLength, sha256})` durably binds the frozen payload identity.
2. `writeUpload(id, offset, ReadableStream<Uint8Array>)` appends raw bytes, with a durable
   offset after each bounded chunk. Matching retransmissions are permitted; changed retries,
   gaps, inconsistent IDs or simultaneous conflicting writers are refused.
3. `getUploadStatus(id)` recovers the durable offset/receipt after a lost response or DO reset.
4. `finishUpload(id)` verifies exact length and SHA-256 and persists an immutable reference.
5. Publish `writeBytes`/`editBytes` or a replica batch only after staging finishes.

Upload IDs are scoped to a worktree or the original replica lease. Ephemeral `env.GIT`
worktrees have separate random staging scopes. Staging does not change a visible file.
Replica reads/inserts additionally require references granted to that lease or present in its
selected checkpoint/journal. Every streamed chunk rechecks lease revocation. A reset resumes
the original authorized upload/batch; it never borrows a new turn's authority.

`Worktree.readBytes(path, range?)` streams the current postimage. The replica equivalent reads
a scoped immutable reference; `readByteAnchor` supplies a byte postimage and opaque version
at a consumed cursor. Guest-supplied immutable Git base bytes may be cached via
`adoptByteBase` only after streaming verification against the selected path's Git blob OID.

## Persistence and Git

The DO stores payload chunks of at most 256 KiB separately from a persistent balanced piece
tree. Splices share untouched chunks/subtrees. OT application and composition handle only
metadata; streaming reads walk the tree with bounded buffers and backpressure. This is not
a whole-file cache or base64 encoding.

Binary Git blobs are stored as OID-to-byte-reference mappings. Commit writes stream SHA-1
over Git's `blob <length>\0` header and payload; tree and commit identities remain real Git
identities. Pack export streams compression and the pack trailer. Existing small loose
objects remain readable. Text-only tools/editor views explicitly reject or skip opaque bytes;
the code browser still lists their changed paths, without showing stale base text.

All uploaded attachments enter the attachments worktree. Valid text retains text OTs;
explicit binary MIME types, NUL-containing data and invalid UTF-8 use byte references.
The existing attachment upload/model-delivery size limits are unchanged.

## Recovery and limits

Length/digest verification precedes publication. The existing payload-bound batch receipt
remains the only replica mutation commit boundary. A lost ACK reuses that receipt, never
re-diffs a mutable file or repeats a command. Unacknowledged guest changes can still be lost
if the guest is destroyed before uploading, as with existing text synchronization.

Unreferenced uploads, immutable chunks and piece-tree metadata currently have no collection
or quota policy (the Git store also retains objects). Production rollout needs a shared
retention/quota decision; do not delete references by age without tracing commits, checkpoints,
pending batches and grants. Legacy remote object pulls still have their existing bounded
decoder; a git-hydrated replica can seed a large binary base through verified staging instead.
No arbitrary total-file cap is introduced for new streamed byte mutations.

Coverage includes randomized OT laws, resumable/digest-verified storage, bounded reads,
tiny metadata-only splices, real Git blob/pack identities, real DO/native RPC publication,
DO worktree commits/deletion, binary attachments, scope/revocation checks and deletion races.
