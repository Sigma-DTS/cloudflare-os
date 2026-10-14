import { createHash } from "node:crypto";
import type { Collection } from "@gadgets/typed-storage";
import { validateBytesRef, type BytesRef, type ByteValue } from "@gadgets/workshop-shared/byte-change";
import type { ByteObjectRecord, ByteChunkRecord, ByteUploadRecord, ByteGrantRecord } from "./storage-schema/overseer-storage";

/** Maximum buffered payload per storage/read operation; unrelated to a file's total size. */
export const BYTE_CHUNK_SIZE = 256 * 1024;

/** Chunk-backed whole-file payloads with durable, scoped, resumable raw-byte staging. */
export class ByteStore {
  constructor(private objects: Collection<ByteObjectRecord, string>,
    private chunks: Collection<ByteChunkRecord, string>, private uploads: Collection<ByteUploadRecord, string>,
    private sync: () => Promise<void>, private grants: Collection<ByteGrantRecord, string>) {}

  /** Check finished identity against durable storage, rather than trusting a wire length. */
  require(ref: BytesRef): void {
    validateBytesRef(ref);
    const object = this.objects.get(ref.id);
    if (!object || object.byteLength !== ref.byteLength) throw new Error("Unknown immutable byte reference.");
  }
  /** Resolve a whole-file value; binary deltas are deliberately unsupported. */
  resolve(value: ByteValue): BytesRef {
    if (Object.keys(value).length !== 1 || !("base" in value)) throw new Error("Binary content must name a whole-file payload.");
    this.require(value.base); return value.base;
  }
  #chunk(ref: BytesRef, index: number): Uint8Array {
    const data = this.chunks.get(`${ref.id}:${index}`)?.data;
    if (!data) throw new Error("Missing byte chunk.");
    return data;
  }
  // Private staging reads may inspect acknowledged bytes before the immutable object exists.
  *#pieces(ref: BytesRef, offset: number, length: number, requireLive: () => void): Generator<Uint8Array> {
    while (length > 0) {
      requireLive();
      const index = Math.floor(offset / BYTE_CHUNK_SIZE), start = offset % BYTE_CHUNK_SIZE;
      const take = Math.min(length, BYTE_CHUNK_SIZE - start), data = this.#chunk(ref, index);
      if (start + take > data.length) throw new Error("Truncated byte chunk.");
      yield data.slice(start, start + take);
      offset += take; length -= take;
    }
  }
  #stream(ref: BytesRef, offset: number, length: number, requireLive: () => void): ReadableStream<Uint8Array> {
    const iterator = this.#pieces(ref, offset, length, requireLive);
    return new ReadableStream({pull(c) {const item = iterator.next(); if (item.done) c.close(); else c.enqueue(item.value);},
      cancel() {iterator.return(undefined);}}, {highWaterMark: 0});
  }
  /** Append/replay bounded chunks. Acknowledged offsets and partial blocks survive DO resets. */
  async write(scope: string, uploadId: string, offset: number, stream: ReadableStream<Uint8Array>, requireLive: () => void): Promise<number> {
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Invalid upload offset.");
    const key = `${scope}:${uploadId}`;
    const reader = stream.getReader();
    const buffer = new Uint8Array(BYTE_CHUNK_SIZE); let used = 0;
    const flush = async () => {
      if (!used) return;
      requireLive();
      const row = this.uploads.get(key);
      if (!row || row.finished || offset + used > row.byteLength) throw new Error("Invalid upload offset or length.");
      const bytes = buffer.subarray(0, used);
      const index = Math.floor(offset / BYTE_CHUNK_SIZE), start = offset % BYTE_CHUNK_SIZE;
      if (offset < row.offset) {
        if (offset + used > row.offset) throw new Error("Retry must end at or before durable offset.");
        const old = this.#chunk(row.root, index);
        if (!bytes.every((byte, i) => byte === old[start + i])) throw new Error("Upload retry changed durable bytes.");
      } else {
        if (offset !== row.offset) throw new Error("Upload has a gap or concurrent writer.");
        const data = new Uint8Array(start + used);
        if (start) data.set(this.#chunk(row.root, index).subarray(0, start));
        data.set(bytes, start);
        this.chunks.put({id: `${row.root.id}:${index}`, data});
        this.uploads.put({...row, offset: offset + used});
        await this.sync();
      }
      offset += used; used = 0;
    };
    try {
      while (true) {
        const {done, value} = await reader.read(); if (done) break;
        for (let i = 0; i < value.byteLength;) {
          const capacity = BYTE_CHUNK_SIZE - offset % BYTE_CHUNK_SIZE;
          const take = Math.min(capacity - used, value.byteLength - i);
          buffer.set(value.subarray(i, i + take), used); used += take; i += take;
          if (used === capacity) await flush();
        }
      }
      await flush(); requireLive(); return this.uploads.get(key)!.offset;
    } catch (error) { await reader.cancel().catch(() => {}); throw error; }
    finally { reader.releaseLock(); }
  }
  /** Bind upload identity to its original scope, length and digest before accepting payload. */
  async begin(scope: string, uploadId: string, byteLength: number, sha256: string): Promise<ByteUploadRecord> {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(uploadId) || !Number.isSafeInteger(byteLength) || byteLength < 0 ||
        !/^[0-9a-f]{64}$/.test(sha256)) throw new Error("Invalid byte upload description.");
    const id = `${scope}:${uploadId}`, old = this.uploads.get(id);
    if (old) {
      if (old.byteLength !== byteLength || old.sha256 !== sha256) throw new Error("Upload ID reused with different content.");
      return old;
    }
    const row = {id, byteLength, sha256, offset: 0, root: {id: crypto.randomUUID(), byteLength}};
    this.uploads.put(row); await this.sync(); return row;
  }
  /** Resume from a persisted offset/finished receipt; never infer failure from a lost response. */
  status(scope: string, uploadId: string): ByteUploadRecord {
    const row = this.uploads.get(`${scope}:${uploadId}`);
    if (!row) throw new Error("Unknown byte upload."); return row;
  }
  /** Only a finished upload in the original writer scope authorizes a new payload reference. */
  isFinishedFor(scope: string, ref: BytesRef): boolean {
    const grant = this.grants.get(`${scope}:${ref.id}`);
    return grant?.bytes.byteLength === ref.byteLength;
  }
  /** Persist path-authorized read authority before returning a reference to its original scope. */
  async grant(scope: string, bytes: BytesRef): Promise<void> {
    this.require(bytes); this.grants.put({id: `${scope}:${bytes.id}`, scope, bytes}); await this.sync();
  }
  /** Verify the complete payload, then atomically publish its immutable object and scoped receipt. */
  async finish(scope: string, uploadId: string, requireLive: () => void): Promise<BytesRef> {
    const row = this.status(scope, uploadId);
    if (row.finished) { requireLive(); await this.grant(scope, row.root); return row.root; }
    if (row.offset !== row.byteLength) throw new Error("Byte upload is incomplete.");
    const hash = createHash("sha256");
    for await (const chunk of this.#stream(row.root, 0, row.byteLength, requireLive)) hash.update(chunk);
    if (hash.digest("hex") !== row.sha256) throw new Error("Byte upload digest mismatch.");
    requireLive(); this.objects.put(row.root);
    this.uploads.put({...row, finished: true});
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
  /** Stream a validated range, checking revocation on every chunk without a whole-file buffer. */
  read(ref: BytesRef, offset = 0, length = ref.byteLength - offset, requireLive = () => {}): ReadableStream<Uint8Array> {
    this.require(ref);
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 ||
        offset > ref.byteLength || length > ref.byteLength - offset) throw new Error("Invalid byte range.");
    return this.#stream(ref, offset, length, requireLive);
  }
  /** Compatibility read for explicitly bounded text/legacy APIs, never used by bulk transfer. */
  readSmall(ref: BytesRef, maximum: number): Uint8Array {
    this.require(ref);
    if (ref.byteLength > maximum) throw new Error("Byte-backed blob requires streaming.");
    const bytes = new Uint8Array(ref.byteLength); let offset = 0;
    for (const chunk of this.#pieces(ref, 0, ref.byteLength, () => {})) {
      bytes.set(chunk, offset); offset += chunk.length;
    }
    return bytes;
  }
}
