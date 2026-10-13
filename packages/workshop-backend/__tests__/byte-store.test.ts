import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { ByteStore, BYTE_CHUNK_SIZE } from "../src/byte-store";
import { makeMockStorage } from "./mock-storage";
import { makeOverseerStorage } from "../src/storage-schema/overseer-storage";
import { GitStore } from "../src/git-store";
import { WorkspaceGitCache } from "../src/git-cache";
import { buildPackStream, parseGitCommitRefs, parseGitTree, decodeLooseObject } from "../src/git-codec";
import type { ByteValue } from "@gadgets/workshop-shared/byte-change";

function fixture() {
  const storage = makeOverseerStorage(makeMockStorage());
  let flushes = 0;
  const store = new ByteStore(storage.byteNodes, storage.byteChunks, storage.byteUploads, async () => { ++flushes; }, storage.byteGrants);
  return {storage, store, flushes: () => flushes};
}
function stream(bytes: Uint8Array, fail = false) {
  let sent = false;
  return new ReadableStream<Uint8Array>({pull(c) { if (!sent) { sent = true; c.enqueue(bytes); } else if (fail) c.error(new Error("disconnect")); else c.close(); }});
}
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const read = (body: ReadableStream<Uint8Array>) => new Response(body).bytes();

it("resumes persisted offsets after a disconnect, verifies retries and returns a stable finished receipt", async () => {
  const {store, storage} = fixture(), data = new Uint8Array(BYTE_CHUNK_SIZE * 2 + 31).map((_, i) => i % 251);
  await store.begin("lease-a", "upload", data.length, hash(data));
  await expect(store.write("lease-a", "upload", 0, stream(data.subarray(0, BYTE_CHUNK_SIZE), true), () => {})).rejects.toThrow("disconnect");
  expect(store.status("lease-a", "upload").offset).toBe(BYTE_CHUNK_SIZE);
  const resumed = new ByteStore(storage.byteNodes, storage.byteChunks, storage.byteUploads, async () => {}, storage.byteGrants);
  await resumed.write("lease-a", "upload", 0, stream(data.subarray(0, BYTE_CHUNK_SIZE)), () => {});
  await expect(resumed.write("lease-a", "upload", 0, stream(new Uint8Array(BYTE_CHUNK_SIZE)), () => {})).rejects.toThrow("changed durable");
  await resumed.write("lease-a", "upload", BYTE_CHUNK_SIZE, stream(data.subarray(BYTE_CHUNK_SIZE)), () => {});
  const ref = await resumed.finish("lease-a", "upload", () => {});
  expect(await resumed.finish("lease-a", "upload", () => {})).toEqual(ref);
  expect(await read(resumed.read(ref))).toEqual(data);
  expect(resumed.isFinishedFor("lease-b", ref)).toBe(false);
  expect(() => resumed.status("lease-b", "upload")).toThrow();
  await expect(read(resumed.read(ref, 0, ref.byteLength, () => { throw new Error("revoked"); }))).rejects.toThrow("revoked");
});

it("keeps a tiny splice to a large file metadata-only and streams bounded chunks", async () => {
  const {store, storage} = fixture(), data = new Uint8Array(16 * 1024 * 1024).fill(17);
  const base = await store.import("kernel", data), inserted = await store.import("kernel", new Uint8Array([0, 255]));
  const count = [...storage.byteChunks.list()].length;
  const value: ByteValue = {base, edit: {beforeBytes: data.length, sections: [7, [1, {source: inserted, offset: 0, length: 2}], data.length - 8]}};
  const ref = store.resolve(value);
  expect([...storage.byteChunks.list()].length).toBe(count);
  expect(JSON.stringify(value).length).toBeLessThan(500);
  let total = 0;
  for await (const chunk of store.read(ref)) { expect(chunk.length).toBeLessThanOrEqual(BYTE_CHUNK_SIZE); total += chunk.length; }
  expect(total).toBe(data.length + 1);
  expect(await read(store.read(ref, 5, 6))).toEqual(new Uint8Array([17, 17, 0, 255, 17, 17]));
});

it("distinguishes empty bytes from deletion and rejects a wrong digest", async () => {
  const {store} = fixture();
  const empty = await store.import("a", new Uint8Array());
  expect(empty.byteLength).toBe(0);
  expect(await read(store.read(empty))).toEqual(new Uint8Array());
  await store.begin("a", "bad", 1, hash(new Uint8Array([1])));
  await store.write("a", "bad", 0, stream(new Uint8Array([2])), () => {});
  await expect(store.finish("a", "bad", () => {})).rejects.toThrow("digest mismatch");
});

it("commits byte-backed blobs with real Git identities and streams a pack", async () => {
  const {store, storage} = fixture();
  const bytes = new Uint8Array([0, 255, 42]), ref = await store.import("a", bytes);
  const git = new GitStore(storage.gitObjects, store, storage.gitByteBlobs);
  const empty = await git.writeFilesAsCommit(new Map(), {parents: [], author: {name: "Test", email: "test@example.com"}, message: "empty", timestamp: new Date()});
  const commit = await git.writeChangedFilesAsCommit(new Map([["image.bin", {base: ref}]]), {treeBase: empty, parents: [empty], author: {name: "Test", email: "test@example.com"}, message: "bytes", timestamp: new Date()});
  const root = parseGitCommitRefs(decodeLooseObject(storage.gitObjects.get(commit)!.data).payload).tree;
  const blob = parseGitTree(decodeLooseObject(storage.gitObjects.get(root)!.data).payload)[0].oid;
  expect(blob).toBe(createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex"));
  const cache = new WorkspaceGitCache(storage, {async pull() {throw new Error("unexpected pull");}}, store);
  const object = await cache.packObject(blob);
  const chunks = [];
  for await (const chunk of buildPackStream(1, (async function* () {yield object;})())) chunks.push(chunk);
  expect(chunks.reduce((n, chunk) => n + chunk.length, 0)).toBeGreaterThan(bytes.length);
  expect(storage.gitObjects.get(blob)).toBeUndefined();
});
