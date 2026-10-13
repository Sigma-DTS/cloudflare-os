import { createHash } from "node:crypto";
import type { Collection } from "@gadgets/typed-storage";
import { byteValueLength, validateBytesRef, validateByteChange, type BytesRef, type ByteValue } from "@gadgets/workshop-shared/byte-change";
import type { ByteNodeRecord, ByteChunkRecord, ByteUploadRecord, ByteGrantRecord } from "./storage-schema/overseer-storage";

/** Maximum buffered payload per storage/read operation; unrelated to a file's total size. */
export const BYTE_CHUNK_SIZE = 256 * 1024;

/** Immutable AVL piece tree plus resumable raw-byte staging, shared by local and replica writers. */
export class ByteStore {
  constructor(private nodes: Collection<ByteNodeRecord, string>,
    private chunks: Collection<ByteChunkRecord, string>, private uploads: Collection<ByteUploadRecord, string>,
    private sync: () => Promise<void>, private grants: Collection<ByteGrantRecord, string>) {}

  #node(ref: BytesRef): ByteNodeRecord {
    validateBytesRef(ref);
    const node = this.nodes.get(ref.id);
    if (!node || node.byteLength !== ref.byteLength) throw new Error("Unknown immutable byte reference.");
    return node;
  }
  /** Check identity against durable storage, rather than trusting a wire length. */
  require(ref: BytesRef): void { this.#node(ref); }
  #put(node: Omit<ByteNodeRecord, "id">): BytesRef {
    const id = crypto.randomUUID(); this.nodes.put({...node, id});
    return {id, byteLength: node.byteLength};
  }
  #empty(): BytesRef { return this.#put({byteLength: 0, height: 1, chunk: {id: "", offset: 0}}); }
  #branch(a: BytesRef, b: BytesRef): BytesRef {
    if (!a.byteLength) return b; if (!b.byteLength) return a;
    return this.#put({byteLength: a.byteLength + b.byteLength,
      height: 1 + Math.max(this.#node(a).height, this.#node(b).height), children: [a, b]});
  }
  #join(a: BytesRef, b: BytesRef): BytesRef {
    const x = this.#node(a), y = this.#node(b);
    if (x.height > y.height + 1) {
      const [l, r] = x.children!;
      return this.#balance(l, this.#join(r, b));
    }
    if (y.height > x.height + 1) {
      const [l, r] = y.children!;
      return this.#balance(this.#join(a, l), r);
    }
    return this.#branch(a, b);
  }
  #balance(a: BytesRef, b: BytesRef): BytesRef {
    const x = this.#node(a), y = this.#node(b);
    if (x.height > y.height + 1) {
      const [l, r] = x.children!;
      if (this.#node(l).height >= this.#node(r).height) return this.#branch(l, this.#branch(r, b));
      const [rl, rr] = this.#node(r).children!;
      return this.#branch(this.#branch(l, rl), this.#branch(rr, b));
    }
    if (y.height > x.height + 1) {
      const [l, r] = y.children!;
      if (this.#node(r).height >= this.#node(l).height) return this.#branch(this.#branch(a, l), r);
      const [ll, lr] = this.#node(l).children!;
      return this.#branch(this.#branch(a, ll), this.#branch(lr, r));
    }
    return this.#branch(a, b);
  }
  #slice(ref: BytesRef, offset: number, length: number): BytesRef {
    const node = this.#node(ref);
    if (offset === 0 && length === ref.byteLength) return ref;
    if (!length) return this.#empty();
    if (node.chunk) return this.#put({byteLength: length, height: 1,
      chunk: {id: node.chunk.id, offset: node.chunk.offset + offset}});
    const [a, b] = node.children!;
    if (offset >= a.byteLength) return this.#slice(b, offset - a.byteLength, length);
    const first = Math.min(length, a.byteLength - offset);
    const left = this.#slice(a, offset, first);
    return first === length ? left : this.#join(left, this.#slice(b, 0, length - first));
  }
  /** Materialize only tree metadata for a delta, reusing untouched immutable subtrees. */
  resolve(value: ByteValue): BytesRef {
    this.require(value.base);
    if (!value.edit) return value.base;
    validateByteChange(value.edit);
    if (value.edit.beforeBytes !== value.base.byteLength) throw new Error("Invalid byte postimage base.");
    let position = 0, root = this.#empty();
    for (const section of value.edit.sections) {
      if (typeof section === "number") {
        root = this.#join(root, this.#slice(value.base, position, section)); position += section;
      } else {
        position += section[0];
        for (const slice of section.slice(1) as import("@gadgets/workshop-shared/byte-change").ByteSlice[]) {
          this.require(slice.source);
          root = this.#join(root, this.#slice(slice.source, slice.offset, slice.length));
        }
      }
    }
    if (position !== value.base.byteLength || root.byteLength !== byteValueLength(value)) throw new Error("Invalid byte postimage.");
    return root;
  }
  /** Stage immutable chunks from a raw stream. Every acknowledged offset is durably flushed. */
  async write(scope: string, uploadId: string, offset: number, stream: ReadableStream<Uint8Array>, requireLive: () => void): Promise<number> {
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Invalid upload offset.");
    const key = `${scope}:${uploadId}`;
    const reader = stream.getReader();
    let buffer = new Uint8Array(BYTE_CHUNK_SIZE), used = 0;
    const flush = async () => {
      if (!used) return;
      requireLive();
      const row = this.uploads.get(key);
      if (!row || row.finished || offset + used > row.byteLength) throw new Error("Invalid upload offset or length.");
      const bytes = buffer.subarray(0, used);
      if (offset < row.offset) {
        if (offset + used > row.offset) throw new Error("Retry must end at or before durable offset.");
        const old = await new Response(this.read(row.root, offset, used, requireLive)).bytes();
        if (!bytes.every((byte, i) => byte === old[i])) throw new Error("Upload retry changed durable bytes.");
      } else {
        if (offset !== row.offset) throw new Error("Upload has a gap or concurrent writer.");
        const id = crypto.randomUUID(); this.chunks.put({id, data: bytes.slice()});
        const leaf = this.#put({byteLength: used, height: 1, chunk: {id, offset: 0}});
        this.uploads.put({...row, offset: offset + used, root: this.#join(row.root, leaf)});
        await this.sync();
      }
      offset += used; used = 0;
    };
    try {
      while (true) {
        const {done, value} = await reader.read(); if (done) break;
        for (let i = 0; i < value.byteLength;) {
          const take = Math.min(buffer.length - used, value.byteLength - i);
          buffer.set(value.subarray(i, i + take), used); used += take; i += take;
          if (used === buffer.length) await flush();
        }
      }
      await flush(); requireLive(); return this.uploads.get(key)!.offset;
    } catch (error) { await reader.cancel().catch(() => {}); throw error; }
    finally { reader.releaseLock(); }
  }
  /** Bind upload identity to its original scope, length and digest before any payload is accepted. */
  async begin(scope: string, uploadId: string, byteLength: number, sha256: string): Promise<ByteUploadRecord> {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(uploadId) || !Number.isSafeInteger(byteLength) || byteLength < 0 ||
        !/^[0-9a-f]{64}$/.test(sha256)) throw new Error("Invalid byte upload description.");
    const id = `${scope}:${uploadId}`, old = this.uploads.get(id);
    if (old) {
      if (old.byteLength !== byteLength || old.sha256 !== sha256) throw new Error("Upload ID reused with different content.");
      return old;
    }
    const row = {id, byteLength, sha256, offset: 0, root: this.#empty()};
    this.uploads.put(row); await this.sync(); return row;
  }
  /** Resume from a persisted offset/finished receipt; never infer failure from a lost response. */
  status(scope: string, uploadId: string): ByteUploadRecord {
    const row = this.uploads.get(`${scope}:${uploadId}`);
    if (!row) throw new Error("Unknown byte upload."); return row;
  }
  /** Only a finished upload in the original writer scope can authorize a new source reference. */
  isFinishedFor(scope: string, ref: BytesRef): boolean {
    const grant = this.grants.get(`${scope}:${ref.id}`);
    return grant?.bytes.byteLength === ref.byteLength;
  }
  /** Persist path-authorized read authority before returning a reference to its original scope. */
  async grant(scope: string, bytes: BytesRef): Promise<void> {
    this.require(bytes); this.grants.put({id: `${scope}:${bytes.id}`, scope, bytes}); await this.sync();
  }
  /** Verify frozen payload in bounded memory, then persist the immutable-reference receipt. */
  async finish(scope: string, uploadId: string, requireLive: () => void): Promise<BytesRef> {
    const row = this.status(scope, uploadId);
    if (row.finished) { requireLive(); await this.grant(scope, row.root); return row.root; }
    if (row.offset !== row.byteLength) throw new Error("Byte upload is incomplete.");
    const hash = createHash("sha256");
    for await (const chunk of this.read(row.root, 0, row.byteLength, requireLive)) hash.update(chunk);
    if (hash.digest("hex") !== row.sha256) throw new Error("Byte upload digest mismatch.");
    requireLive(); this.uploads.put({...row, finished: true});
    this.grants.put({id: `${scope}:${row.root.id}`, scope, bytes: row.root});
    await this.sync(); return row.root;
  }
  /** Import a known local payload with the same staging/durability rules. */
  async import(scope: string, bytes: Uint8Array): Promise<BytesRef> {
    const id = crypto.randomUUID(), sha = createHash("sha256").update(bytes).digest("hex");
    await this.begin(scope, id, bytes.byteLength, sha);
    await this.write(scope, id, 0, new ReadableStream({start(c) { c.enqueue(bytes); c.close(); }}), () => {});
    return this.finish(scope, id, () => {});
  }
  /** Stream a validated range, with revocation checks on every chunk and no whole-file buffer. */
  read(ref: BytesRef, offset = 0, length = ref.byteLength - offset, requireLive = () => {}): ReadableStream<Uint8Array> {
    this.require(ref);
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 ||
        offset + length > ref.byteLength) throw new Error("Invalid byte range.");
    const store = this;
    function* pieces(root: BytesRef, start: number, count: number): Generator<Uint8Array> {
      if (!count) return;
      requireLive(); const node = store.#node(root);
      if (node.chunk) {
        const data = store.chunks.get(node.chunk.id)?.data;
        if (!data) throw new Error("Missing immutable byte chunk.");
        yield data.slice(node.chunk.offset + start, node.chunk.offset + start + count); return;
      }
      const [a, b] = node.children!;
      const first = Math.max(0, Math.min(count, a.byteLength - start));
      if (first) yield* pieces(a, start, first);
      if (count > first) yield* pieces(b, Math.max(0, start - a.byteLength), count - first);
    }
    const iterator = pieces(ref, offset, length);
    return new ReadableStream({pull(c) {const item = iterator.next(); if (item.done) c.close(); else c.enqueue(item.value);},
      cancel() {iterator.return(undefined);}}, {highWaterMark: 0});
  }
  /** Compatibility read for explicitly bounded text/legacy APIs, never used by bulk transfer. */
  readSmall(ref: BytesRef, maximum: number): Uint8Array {
    this.require(ref);
    if (ref.byteLength > maximum) throw new Error("Byte-backed blob requires streaming.");
    const bytes = new Uint8Array(ref.byteLength);
    let offset = 0;
    const walk = (root: BytesRef) => {
      const node = this.#node(root);
      if (node.chunk) {
        if (!root.byteLength) return;
        const data = this.chunks.get(node.chunk.id)?.data;
        if (!data) throw new Error("Missing immutable byte chunk.");
        bytes.set(data.subarray(node.chunk.offset, node.chunk.offset + root.byteLength), offset);
        offset += root.byteLength;
      } else { walk(node.children![0]); walk(node.children![1]); }
    };
    walk(ref); return bytes;
  }
}
