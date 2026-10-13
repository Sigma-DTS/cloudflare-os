import { expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { createHash } from "node:crypto";
import type { OverseerDurableObject } from "../src/overseer";
import type { IntegrationTestActionGatekeeper } from "./test-worker";
import type { ByteValue } from "@gadgets/workshop-shared/byte-change";
import { replicaContentHash } from "../src/workspace-replica";

declare module "cloudflare:workers" { interface ProvidedEnv {TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;} }
it("streams binary publication over native RPC, deduplicates ACK loss and races a DO splice with deletion", async () => {
  await runInDurableObject(env.TEST_OVERSEER.getByName(crypto.randomUUID()), async instance => {
    const impl = instance["impl"];
    impl.env.AGENT_INTEGRATION_GRANTS = '{"container":{"worktreeReplica":true}}';
    try {
      impl.storage.chatMeta.put({id: 1, title: "Binary", started: Date.now(), lastActive: Date.now()});
      const commit = await impl.gitStore.writeFilesAsCommit(new Map(), {parents: [], author: {name: "Test", email: "test@example.com"}, message: "Base", timestamp: new Date(0)});
      const exports = impl.ctx.exports as typeof impl.ctx.exports & {
        IntegrationTestActionGatekeeper(options: {props: Record<string, never>}): DurableObjectClass<IntegrationTestActionGatekeeper>;
      };
      const cls = exports.IntegrationTestActionGatekeeper({props: {}});
      impl.storage.gatekeepers.put({id: 31, class: cls, creationSpec: {type: "ambient", vendorId: "container"}});
      const tree = await impl.createWorktree("Repo", 1, commit);
      impl.storage.chatContext.put({chatId: 1, bindings: {REPO: tree.id}});
      await impl.beginAgentIntegrationTurn(1);
      const origin = impl.captureIntegrationOrigin({from: "agent", chatId: 1})!;
      const replica = await impl.getIntegrationContext(31, origin)!.openWorktreeReplica();
      const checkpoint = await replica.checkpoint();
      const data = new Uint8Array(2 * 1024 * 1024 + 7).map((_, i) => i % 251);
      await replica.beginUpload("binary", {byteLength: data.length, sha256: createHash("sha256").update(data).digest("hex")});
      await replica.writeUpload("binary", 0, new ReadableStream({start(c) {c.enqueue(data); c.close();}}));
      const ref = await replica.finishUpload("binary");
      const batch = {batchId: "binary-create", baseCursor: checkpoint.cursor,
        files: [{checkoutId: tree.id, path: "image.bin", baseHash: null, change: {setBytes: {base: ref}}}]};
      const receipt = await replica.submitBatch(batch);
      expect(await replica.submitBatch(batch)).toEqual(receipt);
      expect(new Uint8Array(await new Response(await replica.readBytes(ref)).arrayBuffer())).toEqual(data);
      await expect((async () => {await replica.readBytes({id: "not-granted", byteLength: 1});})()).rejects.toThrow(/outside/);
      const canonical = (await impl.getCurrentChatContent(1, impl.storage.chatMeta.get(1)!)).get(tree.id)!.get("image.bin") as ByteValue;
      const insert = await impl.byteStore.import("kernel", Uint8Array.of(0, 255));
      const change = {editBytes: {beforeBytes: data.length, sections: [1, [1, {source: insert, offset: 0, length: 2}], data.length - 2] as [number, [number, {source: typeof insert; offset: number; length: number}], number]}};
      await impl.commitAgentStep(1, {type: "agent", id: "test", name: "Test"}, [], {
        changes: [{change: {[tree.id]: [["image.bin", change]]}}], createdGadgets: [], createdWorktrees: [], addedBindings: [], worktreeCommits: [], blueprintMerges: [],
      });
      // Container deletion races the canonical splice: assignment/removal supersedes edits.
      const removed = await replica.submitBatch({batchId: "binary-remove", baseCursor: receipt.committedAt,
        files: [{checkoutId: tree.id, path: "image.bin", baseHash: await replicaContentHash(canonical), change: {remove: true}}]});
      expect(removed.accepted[0].hash).toBeNull();
      expect((await impl.getCurrentChatContent(1, impl.storage.chatMeta.get(1)!)).get(tree.id)!.has("image.bin")).toBe(false);
      await replica.release();
      await expect((async () => {await replica.readBytes(ref);})()).rejects.toThrow(/revoked/);
    } finally {delete impl.env.AGENT_INTEGRATION_GRANTS;}
  });
});
