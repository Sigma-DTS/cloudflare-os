import {describe, expect, it, vi} from "vitest";
import {env} from "cloudflare:workers";
import {abortAllDurableObjects, runInDurableObject} from "cloudflare:test";
import type {OverseerDurableObject} from "../src/overseer";
import type {UserDurableObject} from "../src/user";
import {applyCodeChange, codeChangeSerializedSize, MAX_FILE_TEXT_LENGTH, type CodeChange} from "@gadgets/workshop-shared/code-change";
import {replicaTextHash} from "../src/workspace-replica";
import {decodePackStream} from "../src/git-codec";
import {runAgent, type WorktreeTurnAccess} from "../src/agent";
import type {WorktreeReplicaCommit} from "../src/worktree-replica";
import {createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall} from "@earendil-works/pi-ai";
import type {IntegrationTestParticipant} from "./test-worker";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
    TEST_USER: DurableObjectNamespace<UserDurableObject>;
  }
}
type Impl = OverseerDurableObject["impl"];
const AUTHOR = {type: "agent" as const, id: "test", name: "Test"};
const USER = {type: "user" as const, id: "test-user", name: "Test"};
async function inKernel<T>(name: string, test: (impl: Impl) => Promise<T>): Promise<T> {
  return runInDurableObject(env.TEST_OVERSEER.getByName(name), async instance => {
    const impl = instance["impl"];
    impl.env.AGENT_INTEGRATION_GRANTS = '{"container":{"worktreeReplica":true}}';
    for (const id of [31, 32]) if (!impl.storage.gatekeepers.get(id)) {
      impl.storage.gatekeepers.put({id, class: impl.ctx.exports.AgentSpawnerGatekeeper({props: {
        overseerId: impl.ctx.id.toString(), config: {displayName: "Replica fixture", modelId: null, env: {}},
      }}), creationSpec: {type: "ambient", vendorId: "container"}});
    }
    try { return await test(impl); }
    finally { delete impl.env.AGENT_INTEGRATION_GRANTS; }
  });
}
async function step(impl: Impl, chatId: number, change: CodeChange) {
  await impl.commitAgentStep(chatId, AUTHOR, [], {changes: [{change}], createdGadgets: [],
    createdWorktrees: [], addedBindings: [], worktreeCommits: [], blueprintMerges: []});
}
async function worktree(impl: Impl, chatId = 1, files = new Map([["a.txt", "aaa"]])) {
  const timestamp = impl.getChatTimestamp();
  impl.storage.chatMeta.put({id: chatId, title: "Replica", started: timestamp, lastActive: timestamp});
  const commit = await impl.gitStore.writeFilesAsCommit(files, {parents: [],
    author: {name: "Test", email: "test@example.com"}, message: "Base", timestamp: new Date(0)});
  const tree = await impl.createWorktree("Repo", chatId, commit);
  impl.storage.chatContext.put({chatId, bindings: {REPO: tree.id}});
  await impl.commitAgentStep(chatId, AUTHOR, [], {changes: [], createdGadgets: [],
    createdWorktrees: [{worktreeId: tree.id, title: tree.title, bindingName: "REPO"}],
    addedBindings: [], worktreeCommits: [], blueprintMerges: []});
  return tree;
}
async function open(impl: Impl, chatId = 1, gatekeeperId = 31) {
  const origin = impl.captureIntegrationOrigin({from: "agent", chatId})!;
  return impl.getIntegrationContext(gatekeeperId, origin)!.openWorktreeReplica();
}

describe("replica review regressions over durable kernel storage", () => {
  it("pages a large non-Latin-1 canonical backlog within a byte budget, without losing revisions", () => inKernel(crypto.randomUUID(), async impl => {
    const tree = await worktree(impl);
    await impl.beginAgentIntegrationTurn(1);
    const replica = await open(impl), checkpoint = await replica.checkpoint();
    for (let i = 0; i < 80; ++i) {
      await step(impl, 1, {[tree.id]: [["a.txt", {set: "\u0100".repeat(220_000) + i}]]});
    }
    let cursor = checkpoint.cursor, revisions: number[] = [], pages = 0;
    for (;;) {
      const page = await replica.changesSince(cursor, 128);
      const bytes = page.events.reduce((sum, event) => sum + codeChangeSerializedSize({[tree.id]:
        event.changes.map(change => [change.path, change.change])}) + 256, 0);
      expect(bytes).toBeLessThanOrEqual(8 * 1024 * 1024);
      expect(page.cursor).toBe(page.events.at(-1)?.cursor ?? cursor);
      revisions.push(...page.events.map(event => Number(event.cursor.split(":").at(-1))));
      ++pages;
      cursor = page.cursor;
      if (!page.hasMore) break;
      expect(page.events.length).toBeGreaterThan(0);
    }
    expect(pages).toBeGreaterThan(1);
    expect(revisions).toEqual(Array.from({length: 80}, (_, i) => i + 1));
    expect(await replica.changesSince(cursor, 128)).toEqual({events: [], cursor, hasMore: false});
  }));

  it.each(["file", "directory"] as const)("rejects an upload whose allocated root becomes a replica %s before the message commits", mode => inKernel(crypto.randomUUID(), async impl => {
    const user = env.TEST_USER.getByName(crypto.randomUUID());
    const stage = (text: string, name: string) => {
      const id = crypto.randomUUID();
      impl.storage.chatAttachmentContent.put({fileId: id, data: new TextEncoder().encode(text), state: {
        type: "staged", uploadedAt: Date.now(), mimeType: "text/csv", name,
      }});
      return {id};
    };
    const chatId = await impl.newChat(user, {profile: USER}, "Initial", undefined, [stage("input", "input.csv")]);
    const treeId = impl.getChatAgentContext(chatId).attachments!.worktreeId;
    impl.storage.chatContext.put({...impl.getChatAgentContext(chatId), bindings: {ATTACHMENTS: treeId}});
    await impl.beginAgentIntegrationTurn(chatId);
    const replica = await open(impl, chatId), checkpoint = await replica.checkpoint();
    await impl.closeAgentIntegrationTurn(chatId, "approval");
    const upload = stage("uploaded", "report.csv");
    let arrived!: () => void, release!: () => void;
    const entered = new Promise<void>(resolve => { arrived = resolve; });
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const write = impl.gitStore.writeFilesAsCommit.bind(impl.gitStore);
    impl.gitStore.writeFilesAsCommit = async (...args) => {
      const commit = await write(...args);
      arrived();
      await barrier;
      return commit;
    };
    const sending = impl.sendChatMessage(user, {profile: USER}, chatId, "Read this", undefined, [upload]);
    const path = mode === "file" ? "report.csv" : "report.csv/part.txt";
    try {
      await entered;
      await replica.submitBatch({batchId: "concurrent-upload", baseCursor: checkpoint.cursor, files: [
        {checkoutId: treeId, path, baseHash: null, change: {set: "replica-created"}},
      ]});
    } finally { release(); impl.gitStore.writeFilesAsCommit = write; }
    await expect(sending).rejects.toThrow(/Attachment workspace changed.*retry/);
    expect(impl.storage.chatAttachmentContent.get(upload.id)?.state.type).toBe("staged");
    expect([...impl.storage.chats.list()].some(message => message.type === "message" &&
      message.attachments?.some(attachment => attachment.id === upload.id))).toBe(false);
    expect((await impl.getCurrentChatContent(chatId, impl.storage.chatMeta.get(chatId)!)).get(treeId)?.get(path))
      .toBe("replica-created");
    expect([...impl.storage.worktreeReplicaCommits.list()]).toHaveLength(1);
    await impl.sendChatMessage(user, {profile: USER}, chatId, "Read this", undefined, [upload]);
    expect(impl.storage.chatAttachmentContent.get(upload.id)?.state).toMatchObject({workspacePath: "report-2.csv"});
    const content = await impl.getCurrentChatContent(chatId, impl.storage.chatMeta.get(chatId)!);
    expect(content.get(treeId)?.get(path)).toBe("replica-created");
    expect(content.get(treeId)?.get("report-2.csv")).toBe("uploaded");
  }));

  it.each(["set", "edit"] as const)("rejects NUL-bearing %s before ACK without wedging the path or consuming its batch ID", mode => inKernel(crypto.randomUUID(), async impl => {
    const tree = await worktree(impl);
    await impl.beginAgentIntegrationTurn(1);
    const replica = await open(impl), checkpoint = await replica.checkpoint();
    const path = mode === "set" ? "new.txt" : "a.txt";
    const baseHash = await replicaTextHash(mode === "set" ? null : "aaa");
    await expect((async () => replica.submitBatch({batchId: "nul", baseCursor: checkpoint.cursor, files: [
      {checkoutId: tree.id, path, baseHash, change: mode === "set" ? {set: "first\0last"} : {edit: [3, [0, "\0"]]}},
    ]}))()).rejects.toThrow(/Invalid replica text/);
    expect([...impl.storage.worktreeReplicaCommits.list()]).toEqual([]);
    expect([...impl.storage.chatChanges.list()]).toEqual([]);
    const accepted = await replica.submitBatch({batchId: "nul", baseCursor: checkpoint.cursor, files: [
      {checkoutId: tree.id, path, baseHash, change: mode === "set" ? {set: "valid"} : {edit: [3, [0, "valid"]]}},
    ]});
    await replica.submitBatch({batchId: "remove", baseCursor: (await replica.changesSince(checkpoint.cursor, 128)).cursor, files: [
      {checkoutId: tree.id, path, baseHash: accepted.accepted[0]!.hash, change: {remove: true}},
    ]});
    expect([...impl.storage.worktreeReplicaCommits.list()]).toHaveLength(2);
  }));

  it.each(["set", "remove"] as const)("rejects a base-directory %s before ACK and permits a valid retry", mode => inKernel(crypto.randomUUID(), async impl => {
    const tree = await worktree(impl, 1, new Map([["src/a.txt", "aaa"]]));
    await impl.beginAgentIntegrationTurn(1);
    const replica = await open(impl), checkpoint = await replica.checkpoint();
    await expect((async () => replica.submitBatch({batchId: "directory", baseCursor: checkpoint.cursor, files: [
      {checkoutId: tree.id, path: "src", baseHash: null, change: mode === "set" ? {set: "replacement"} : {remove: true}},
    ]}))()).rejects.toThrow(/directory/);
    expect([...impl.storage.worktreeReplicaCommits.list()]).toEqual([]);
    expect([...impl.storage.chatChanges.list()]).toEqual([]);
    await replica.submitBatch({batchId: "directory", baseCursor: checkpoint.cursor, files: [
      {checkoutId: tree.id, path: "src/a.txt", baseHash: await replicaTextHash("aaa"), change: {set: "valid"}},
    ]});
    expect(await impl.mergeChanges(1, {profile: USER}, USER.id)).toEqual({outcome: "merged"});
  }));

  it("persists replica edits and echo provenance before ACK when turn_end queues concurrently", () => inKernel(crypto.randomUUID(), async impl => {
    const tree = await worktree(impl);
    impl.addChatMessages(1, USER, [{type: "message", message: "Finish while the replica writes."}]);
    await impl.beginAgentIntegrationTurn(1);
    let access!: WorktreeTurnAccess;
    const register = impl.registerWorktreeReplicaTurn.bind(impl);
    impl.registerWorktreeReplicaTurn = (...args) => { access = args[1]; register(...args); };
    const endpoint = await open(impl), checkpoint = await endpoint.checkpoint();
    const leaseId = checkpoint.cursor.split(":")[0];
    const receipt: WorktreeReplicaCommit = {id: `${leaseId}:concurrent-step`, leaseId, digest: "fixture",
      receipt: {batchId: "concurrent-step", committedAt: "pending", corrections: [], accepted: []}};
    let ack: Promise<boolean> | undefined;
    const consume = impl.consumeCapturedActions.bind(impl);
    impl.consumeCapturedActions = chatId => {
      // finishTurn starts the replica barrier. Its synchronous append then yields at await,
      // exactly when pi dispatches turn_end and queues the ordinary persistence barrier.
      ack = access.flushReplica!({[tree.id]: [["a.txt", {set: "replica edit"}]]}, access.getRevision!(), receipt);
      return consume(chatId);
    };
    let release!: () => void;
    const ordinary = new Promise<void>(resolve => { release = resolve; });
    const commit = impl.commitAgentStep.bind(impl);
    impl.commitAgentStep = async (...args) => {
      if (args[2].length) await ordinary;
      return commit(...args);
    };
    const faux = createFauxCore({models: [{id: "faux-model"}]});
    faux.setResponses([fauxAssistantMessage(fauxText("Done."))]);
    const running = runAgent(impl, {model: faux.getModel(), stream: faux.stream}, 1, AUTHOR,
      new AbortController().signal, USER, {provider: "cloudflare", model: "faux-model", apiToken: ""});
    try {
      await vi.waitFor(() => expect(ack).toBeDefined());
      expect(await ack).toBe(true);
      expect(impl.storage.worktreeReplicaCommits.get(receipt.id)).toBeDefined();
      expect((await impl.getCurrentChatContent(1, impl.storage.chatMeta.get(1)!)).get(tree.id)?.get("a.txt"))
        .toBe("replica edit");
      const page = await endpoint.changesSince(checkpoint.cursor, 128);
      expect(page.events.find(event => event.changes.length)).toMatchObject({sourceBatchId: "concurrent-step", changes: [
        {checkoutId: tree.id, path: "a.txt", change: {set: "replica edit"}},
      ]});
      expect(page.events.every(event => event.sourceBatchId === "concurrent-step")).toBe(true);
    } finally { release(); }
    await running;
  }));
  it.each(["completed", "canceled", "failed"] as const)("revokes an unregistered replica after the turn is %s", reason => inKernel(crypto.randomUUID(), async impl => {
    const tree = await worktree(impl);
    await impl.beginAgentIntegrationTurn(1);
    const replica = await open(impl), checkpoint = await replica.checkpoint();
    await impl.closeAgentIntegrationTurn(1, reason);
    await expect((async () => { await replica.renew(); })()).rejects.toThrow(/expired or revoked/);
    await expect((async () => { await replica.submitBatch({batchId: "after-stop", baseCursor: checkpoint.cursor, files: [
      {checkoutId: tree.id, path: "a.txt", baseHash: await replicaTextHash("aaa"), change: {set: "unauthorized"}},
    ]}); })()).rejects.toThrow(/expired or revoked/);
    expect([...impl.storage.worktreeReplicaCommits.list()]).toEqual([]);
  }));

  it("bounds registered final-sync authority across reset, renewal, callback ACK and expiry", async () => {
    const name = crypto.randomUUID();
    const saved = await inKernel(name, async impl => {
      impl.env.AGENT_INTEGRATION_GRANTS = '{"container":{"worktreeReplica":true,"lifecycle":true}}';
      const tree = await worktree(impl);
      await impl.beginAgentIntegrationTurn(1);
      const exports = impl.ctx.exports as Cloudflare.Exports & {
        IntegrationTestParticipant(options: {props: {name: string}}): Fetcher<IntegrationTestParticipant>;
      };
      const participant = exports.IntegrationTestParticipant({props: {name}});
      await impl.registerIntegrationParticipant(31, impl.captureIntegrationOrigin({from: "agent", chatId: 1})!, "running", participant);
      const replica = await open(impl), checkpoint = await replica.checkpoint();
      await participant.setFailure(true);
      await expect(impl.closeAgentIntegrationTurn(1, "completed")).rejects.toThrow(/unavailable/);
      const leaseId = checkpoint.cursor.split(":")[0];
      const lease = impl.storage.worktreeReplicaLeases.get(leaseId)!;
      expect(lease.cleanupDeadline! - Date.now()).toBeLessThanOrEqual(60 * 60 * 1000);
      await impl.ctx.storage.sync();
      return {treeId: tree.id, leaseId, cursor: checkpoint.cursor, deadline: lease.cleanupDeadline!};
    });
    await abortAllDurableObjects();
    await inKernel(name, async impl => {
      impl.env.AGENT_INTEGRATION_GRANTS = '{"container":{"worktreeReplica":true,"lifecycle":true}}';
      const replica = impl.getWorkspaceReplicaSession(saved.leaseId);
      await expect(impl.closeAgentIntegrationTurn(1, "completed")).rejects.toThrow(/unavailable/);
      expect(impl.storage.worktreeReplicaLeases.get(saved.leaseId)?.cleanupDeadline).toBe(saved.deadline);
      await replica.submitBatch({batchId: "final-sync", baseCursor: saved.cursor, files: [
        {checkoutId: saved.treeId, path: "a.txt", baseHash: await replicaTextHash("aaa"), change: {set: "saved before snapshot"}},
      ]});
      const lease = impl.storage.worktreeReplicaLeases.get(saved.leaseId)!;
      impl.storage.worktreeReplicaLeases.put({...lease, cleanupDeadline: Date.now() + 1000});
      await replica.renew();
      const renewed = impl.storage.worktreeReplicaLeases.get(saved.leaseId)!;
      expect(renewed.expiresAt).toBe(renewed.cleanupDeadline);
      impl.storage.worktreeReplicaLeases.put({...renewed, cleanupDeadline: Date.now() - 1, expiresAt: Date.now() + 60_000});
      await expect(replica.renew()).rejects.toThrow(/termination/);
      impl.storage.worktreeReplicaLeases.put({...lease, expiresAt: Date.now() + 60_000});
      const exports = impl.ctx.exports as Cloudflare.Exports & {
        IntegrationTestParticipant(options: {props: {name: string}}): Fetcher<IntegrationTestParticipant>;
      };
      await exports.IntegrationTestParticipant({props: {name}}).setFailure(false);
      await impl.closeAgentIntegrationTurn(1, "completed");
      await expect(replica.renew()).rejects.toThrow(/termination/);
      await expect(replica.submitBatch({batchId: "after-ack", baseCursor: saved.cursor, files: []})).rejects.toThrow(/termination/);
    });
  });

  it("does not poison the live barrier when concurrent identical no-op batches retry", () => inKernel(crypto.randomUUID(), async impl => {
    const tree = await worktree(impl);
    impl.addChatMessages(1, USER, [{type: "message", message: "Use the replica, then edit a file."}]);
    await impl.beginAgentIntegrationTurn(1);
    const faux = createFauxCore({models: [{id: "faux-model"}]});
    faux.setResponses([async () => {
      const endpoint = await open(impl), checkpoint = await endpoint.checkpoint();
      const session = impl.getWorkspaceReplicaSession(checkpoint.cursor.split(":")[0]);
      const host = session["host"], commit = host.commit;
      let arrivals = 0, release!: () => void;
      const barrier = new Promise<void>(resolve => { release = resolve; });
      host.commit = async (...args) => {
        if (++arrivals === 2) release();
        await barrier;
        return commit(...args);
      };
      const input = {batchId: "concurrent-noop", baseCursor: checkpoint.cursor, files: []};
      const [one, two] = await Promise.all([session.submitBatch(input), session.submitBatch(input)]);
      expect(one).toEqual(two);
      expect([...impl.storage.worktreeReplicaCommits.list()]).toHaveLength(1);
      return fauxAssistantMessage(fauxToolCall("writeFile", {workpiece: "REPO", filename: "a.txt", content: "later tool edit"}),
        {stopReason: "toolUse"});
    }, fauxAssistantMessage(fauxText("Done."))]);
    await runAgent(impl, {model: faux.getModel(), stream: faux.stream}, 1, AUTHOR,
      new AbortController().signal, USER, {provider: "cloudflare", model: "faux-model", apiToken: ""});
    expect((await impl.getCurrentChatContent(1, impl.storage.chatMeta.get(1)!)).get(tree.id)?.get("a.txt"))
      .toBe("later tool edit");
    expect([...impl.storage.chats.list()].some(message => message.type === "message" && message.message === "Done.")).toBe(true);
  }));

  it("does not project an upload when message validation fails, including after retry and reset", async () => {
    const name = crypto.randomUUID();
    const saved = await inKernel(name, async impl => {
      const user = env.TEST_USER.getByName(crypto.randomUUID());
      const stage = (text: string, filename: string) => {
        const id = crypto.randomUUID();
        impl.storage.chatAttachmentContent.put({fileId: id, data: new TextEncoder().encode(text), state: {
          type: "staged", uploadedAt: Date.now(), mimeType: "text/plain", name: filename,
        }});
        return {id};
      };
      const chatId = await impl.newChat(user, {profile: USER}, "Initial", undefined, [stage("initial", "initial.txt")]);
      const treeId = impl.getChatAgentContext(chatId).attachments!.worktreeId;
      const upload = stage("new content", "upload.txt");
      const before = [...impl.storage.chats.list()];
      for (let i = 0; i < 2; ++i) {
        await expect(impl.sendChatMessage(user, {profile: USER}, chatId, "Read [0]", [{position: 5, length: 3,
          gatekeeperId: 9999, description: {url: "test://missing", title: "Deleted", suggestedBindingName: "MISSING", tsType: "object"}}], [upload]))
          .rejects.toThrow(/does not exist/);
        expect(impl.storage.chatAttachmentContent.get(upload.id)?.state.type).toBe("staged");
        expect([...impl.storage.chats.list()]).toEqual(before);
        expect((await impl.getCurrentChatContent(chatId, impl.storage.chatMeta.get(chatId)!)).get(treeId)?.has("upload.txt")).toBeFalsy();
        expect([...impl.storage.chatChanges.list()]).toEqual([]);
      }
      await impl.ctx.storage.sync();
      return {chatId, treeId, upload};
    });
    await abortAllDurableObjects();
    await inKernel(name, async impl => {
      await impl.sendChatMessage(env.TEST_USER.getByName(crypto.randomUUID()), {profile: USER}, saved.chatId, "Read upload", undefined, [saved.upload]);
      expect(impl.storage.chatAttachmentContent.get(saved.upload.id)?.state).toMatchObject({workspacePath: "upload.txt"});
      expect((await impl.getCurrentChatContent(saved.chatId, impl.storage.chatMeta.get(saved.chatId)!)).get(saved.treeId)?.get("upload.txt"))
        .toBe("new content");
    });
  });

  it.each(["edit", "set"])("pins a previously untouched gadget for a stored replica %s after suspension and reset", async mode => {
    const name = crypto.randomUUID();
    const saved = await inKernel(name, async impl => {
      await worktree(impl);
      const commit = await impl.gitStore.writeFilesAsCommit(new Map([["a.txt", "safe"]]), {
        parents: [], author: {name: "Test", email: "test@example.com"}, message: "Gadget", timestamp: new Date(0),
      });
      const gadgetId = 100;
      impl.storage.gadgets.put({type: "gadget", id: gadgetId, title: "Board", bindingName: "BOARD",
        bindings: {}, created: new Date(0), commitId: commit});
      impl.storage.chatContext.put({chatId: 1, bindings: {BOARD: gadgetId}, alwaysAvailableCapsuleIds: []});
      impl.addChatMessages(1, USER, [{type: "message", message: "Edit the board in the container."}]);
      await impl.beginAgentIntegrationTurn(1);
      const replica = await open(impl), checkpoint = await replica.checkpoint();
      await impl.closeAgentIntegrationTurn(1, "approval");
      await impl.ctx.storage.sync();
      return {gadgetId, commit, cursor: checkpoint.cursor};
    });
    await abortAllDurableObjects();
    await inKernel(name, async impl => {
      const {gadgetId, commit, cursor} = saved;
      const replica = impl.getWorkspaceReplicaSession(cursor.split(":")[0]);
      await replica.submitBatch({batchId: "stored-gadget", baseCursor: cursor, files: [
        {checkoutId: gadgetId, path: "a.txt", baseHash: await replicaTextHash("safe"),
          change: mode === "edit" ? {edit: [4, [0, "!"]]} : {set: "safe!"}},
      ]});
      const meta = impl.storage.chatMeta.get(1)!;
      expect(impl.chatCodeBase(meta).pins).toContainEqual({gadgetId, baseCommit: commit, mergedCommit: commit});
      expect((await impl.getCurrentChatContent(1, meta)).get(gadgetId)?.get("a.txt")).toBe("safe!");
      expect(await impl.mergeChanges(1, {profile: USER}, USER.id)).toEqual({outcome: "merged"});
      expect(await impl.readFileAtCommit(impl.getGadgetHead(gadgetId)!, "a.txt")).toBe("safe!");
    });
  });

  it.each(["set", "delete/recreate"])("preserves canonical %s replacement semantics against a concurrent edit", mode => inKernel(crypto.randomUUID(), async impl => {
    const tree = await worktree(impl, 1, new Map([["a.txt", "one\ntwo\n"]]));
    await impl.beginAgentIntegrationTurn(1);
    const replica = await open(impl), checkpoint = await replica.checkpoint();
    if (mode === "delete/recreate") await step(impl, 1, {[tree.id]: [["a.txt", {remove: true}]]});
    await step(impl, 1, {[tree.id]: [["a.txt", {set: "ONE\ntwo\n"}]]});
    const receipt = await replica.submitBatch({batchId: "replacement", baseCursor: checkpoint.cursor, files: [
      {checkoutId: tree.id, path: "a.txt", baseHash: await replicaTextHash("one\ntwo\n"),
        change: {edit: [4, [3, "TWO"], 1]}},
    ]});
    const content = await impl.getCurrentChatContent(1, impl.storage.chatMeta.get(1)!);
    expect(content.get(tree.id)?.get("a.txt")).toBe("ONE\ntwo\n");
    expect(receipt.accepted[0].hash).toBe(await replicaTextHash("ONE\ntwo\n"));
  }));

  it.each(["live", "stored"])("preserves spawned-chat write restrictions on the %s replica path", mode => inKernel(crypto.randomUUID(), async impl => {
    const tree = await worktree(impl);
    const commit = await impl.gitStore.writeFilesAsCommit(new Map([["a.txt", "safe"]]), {
      parents: [], author: {name: "Test", email: "test@example.com"}, message: "Gadget", timestamp: new Date(0),
    });
    const gadgetId = 100;
    impl.storage.gadgets.put({type: "gadget", id: gadgetId, title: "Read-only gadget",
      bindingName: "SHARED", bindings: {}, created: new Date(0), commitId: commit});
    impl.storage.chatContext.put({chatId: 1, bindings: {REPO: tree.id, SHARED: gadgetId},
      alwaysAvailableCapsuleIds: [], spawnerConfig: {displayName: "Spawned", modelId: null, env: {}}});
    impl.addChatMessages(1, USER, [{type: "message", message: "Work on the repo; the gadget is read-only."}]);
    await impl.beginAgentIntegrationTurn(1);
    const checkReplica = async () => {
      const replica = await open(impl), checkpoint = await replica.checkpoint();
      expect(checkpoint.worktrees.some(item => item.checkoutId === gadgetId)).toBe(true);
      await expect((async () => { await replica.submitBatch({batchId: "forbidden", baseCursor: checkpoint.cursor, files: [
        {checkoutId: gadgetId, path: "a.txt", baseHash: await replicaTextHash("safe"), change: {set: "hacked"}},
      ]}); })()).rejects.toThrow(/permission to edit/);
      expect([...impl.storage.worktreeReplicaCommits.list()]).toEqual([]);
      await replica.submitBatch({batchId: "allowed", baseCursor: checkpoint.cursor, files: [
        {checkoutId: tree.id, path: "a.txt", baseHash: await replicaTextHash("aaa"), change: {edit: [3, [0, "!"]]}},
      ]});
      const content = await impl.getCurrentChatContent(1, impl.storage.chatMeta.get(1)!);
      expect(content.get(gadgetId)?.get("a.txt") ?? await impl.readFileAtCommit(commit, "a.txt")).toBe("safe");
      expect(content.get(tree.id)?.get("a.txt")).toBe("aaa!");
    };
    if (mode === "stored") await checkReplica();
    else {
      const faux = createFauxCore({models: [{id: "faux-model"}]});
      faux.setResponses([async () => {
        await checkReplica();
        return fauxAssistantMessage(fauxToolCall("writeFile", {workpiece: "SHARED", filename: "a.txt", content: "hacked"}),
          {stopReason: "toolUse"});
      }, fauxAssistantMessage(fauxText("Done."))]);
      await runAgent(impl, {model: faux.getModel(), stream: faux.stream}, 1, AUTHOR,
        new AbortController().signal, USER, {provider: "cloudflare", model: "faux-model", apiToken: ""});
      const calls = [...impl.storage.chats.list()].flatMap(message => message.type === "message" ? message.toolCalls ?? [] : []);
      expect(calls.find(call => call.toolName === "writeFile")?.error).toMatch(/permission to edit/);
    }
  }));

  it("keeps tiny accepted and pending edits as deltas across eviction", async () => {
    const name = crypto.randomUUID(), text = "a".repeat(400_000);
    const id = await inKernel(name, async impl => {
      const tree = await worktree(impl, 1, new Map(["a", "b", "c"].map(path => [path, text])));
      await step(impl, 1, {[tree.id]: ["a", "b", "c"].map(path => [path, {edit: [[1, "z"], 399_999]}])});
      expect(await impl.mergeChanges(1, {profile: USER}, USER.id)).toEqual({outcome: "merged"});
      await step(impl, 1, {[tree.id]: [["a", {edit: [399_999, [1, "x"]]}]]});
      return tree.id;
    });
    await abortAllDurableObjects();
    await inKernel(name, async impl => {
      await impl.beginAgentIntegrationTurn(1);
      // Bootstrap must export operations without asking for flattened workspace contents.
      impl.getCurrentChatContent = async () => { throw new Error("Checkpoint flattened file contents"); };
      const replica = await open(impl), checkpoint = await replica.checkpoint();
      const cursor = await replica.readOverlay(checkpoint.checkpointId), overlay = await cursor.next();
      expect(overlay).toHaveLength(1);
      expect(overlay!.every(item => "edit" in item.change)).toBe(true);
      expect(JSON.stringify(overlay).length).toBeLessThan(1000);
      const change: CodeChange = {[id]: overlay!.map(item => [item.path, item.change])};
      const accepted = checkpoint.worktrees[0].acceptedCommit!;
      const content = applyCodeChange(new Map([[id, new Map(await Promise.all(["a", "b", "c"].map(async path =>
        [path, (await impl.gitCache.readFileAtCommitIfExists(accepted, path))!] as const)))]]), change);
      expect(content.get(id)?.get("a")).toBe("z" + text.slice(1, -1) + "x");
      expect(content.get(id)?.get("b")).toBe("z" + text.slice(1));
      // The complete original operations still anchor reconciliation, never a flattened re-diff.
      const prefix = impl.storage.worktreeReplicaLeases.get(checkpoint.cursor.split(":")[0])!.checkpoint!.overlay;
      expect(prefix).toHaveLength(3);
      expect(prefix.every(item => "edit" in item.change)).toBe(true);
      expect(JSON.stringify(prefix).length).toBeLessThan(1000);
      expect(await cursor.next()).toBeNull();
      expect(impl.storage.gadgets.get(id)?.type).toBe("worktree");
    });
  });

  it("keeps captured Git heads across eviction and moving HEAD, and fences an in-flight export on revocation", async () => {
    const name = crypto.randomUUID();
    const saved = await inKernel(name, async impl => {
      const tree = await worktree(impl);
      await step(impl, 1, {[tree.id]: [["a.txt", {edit: [3, [0, "accepted"]]}]]});
      expect(await impl.mergeChanges(1, {profile: USER}, USER.id)).toEqual({outcome: "merged"});
      await impl.beginAgentIntegrationTurn(1);
      const replica = await open(impl), checkpoint = await replica.checkpoint();
      const record = impl.storage.gadgets.get(tree.id)!;
      if (record.type !== "worktree") throw new Error("Expected worktree");
      const laterHead = await impl.gitStore.writeCommitForTree(await impl.gitStore.commitTree(record.pinBase), {
        parents: [record.headCommit], author: {name: "Test", email: "test@example.com"},
        message: "Explicit commit after capture", timestamp: new Date(1),
      });
      impl.storage.gadgets.put({...record, headCommit: laterHead});
      await impl.ctx.storage.sync();
      return {id: tree.id, leaseId: checkpoint.cursor.split(":")[0], checkpoint, laterHead};
    });
    await abortAllDurableObjects();
    await inKernel(name, async impl => {
      const replica = impl.getWorkspaceReplicaSession(saved.leaseId);
      expect(await replica.checkpoint()).toEqual(saved.checkpoint);
      const imported = [];
      for await (const object of decodePackStream(await replica.readCommitPack(saved.checkpoint.checkpointId, saved.id), {
        maxPackSize: 1024 * 1024, maxObjectSize: 1024 * 1024, resolveBase: oid => impl.gitCache.readLocalObject(oid),
      })) imported.push(object.oid);
      expect(imported).toContain(saved.checkpoint.worktrees[0].acceptedCommit);
      expect(imported).not.toContain(saved.laterHead);
      const reader = (await replica.readCommitPack(saved.checkpoint.checkpointId, saved.id)).getReader();
      expect(new TextDecoder().decode((await reader.read()).value!.subarray(0, 4))).toBe("PACK");
      impl.env.AGENT_INTEGRATION_GRANTS = '{}';
      await expect(reader.read()).rejects.toThrow(/revoked/);
      reader.releaseLock();
    });
  });

  it("retains live-lease anchor history past the ordinary TTL, including after eviction", async () => {
    const name = crypto.randomUUID();
    const saved = await inKernel(name, async impl => {
      const tree = await worktree(impl);
      await impl.beginAgentIntegrationTurn(1);
      const replica = await open(impl), checkpoint = await replica.checkpoint();
      await replica.submitBatch({batchId: "first", baseCursor: checkpoint.cursor, files: [
        {checkoutId: tree.id, path: "a.txt", baseHash: await replicaTextHash("aaa"), change: {edit: [1, [0, "X"], 2]}},
      ]});
      const rows = [...impl.storage.chatChanges.list()];
      for (const row of rows) {
        impl.storage.chatChanges.put({...row, timestamp: new Date(Date.now() - 61_000)});
      }
      return {id: tree.id, leaseId: checkpoint.cursor.split(":")[0]};
    });
    await abortAllDurableObjects();
    await inKernel(name, async impl => {
      const replica = impl.getWorkspaceReplicaSession(saved.leaseId);
      await replica.renew();
      await step(impl, 1, {[saved.id]: [["a.txt", {edit: [4, [0, "D"]]}]]});
      const checkpoint = await replica.checkpoint();
      const page = await replica.changesSince(checkpoint.cursor, 128);
      expect(page.events).toHaveLength(3);
      await replica.submitBatch({batchId: "second", baseCursor: page.cursor, files: [
        {checkoutId: saved.id, path: "a.txt", baseHash: await replicaTextHash("aXaaD"), change: {edit: [5, [0, "!"]]}},
      ]});
      expect((await impl.getCurrentChatContent(1, impl.storage.chatMeta.get(1)!)).get(saved.id)?.get("a.txt"))
        .toBe("aXaaD!");
      await replica.release();
      await step(impl, 1, {[saved.id]: [["a.txt", {edit: [6, [0, "end"]]}]]});
      expect([...impl.storage.chatChanges.list()].some(row => row.timestamp.getTime() < Date.now() - 60_000)).toBe(false);
    });
  });

  it("allows disjoint chats and independent replicas, with lease-local echo provenance", () => inKernel(crypto.randomUUID(), async impl => {
    const a = await worktree(impl, 1), b = await worktree(impl, 2);
    await impl.beginAgentIntegrationTurn(1); await impl.beginAgentIntegrationTurn(2);
    const first = await open(impl, 1), second = await open(impl, 1, 32), disjoint = await open(impl, 2);
    const one = await first.checkpoint(), two = await second.checkpoint();
    expect((await disjoint.checkpoint()).worktrees.map(tree => tree.checkoutId)).toEqual([b.id]);
    await step(impl, 1, {[a.id]: [["a.txt", {edit: [[0, "a"], 3]}]]});
    await first.submitBatch({batchId: "collision", baseCursor: one.cursor, files: [
      {checkoutId: a.id, path: "a.txt", baseHash: await replicaTextHash("aaa"), change: {edit: [[0, "X"], 3]}},
    ]});
    const own = await first.changesSince(one.cursor, 128), other = await second.changesSince(two.cursor, 128);
    expect(own.events.map(event => event.sourceBatchId)).toEqual([undefined, "collision", "collision"]);
    expect(own.events[1].changes).toHaveLength(1);
    expect(other.events.every(event => event.sourceBatchId === undefined)).toBe(true);
    await second.submitBatch({batchId: "collision", baseCursor: two.cursor, files: [
      {checkoutId: a.id, path: "a.txt", baseHash: await replicaTextHash("aaa"), change: {edit: [3, [0, "Y"]]}},
    ]});
    expect((await impl.getCurrentChatContent(1, impl.storage.chatMeta.get(1)!)).get(a.id)?.get("a.txt")).toBe("aXaaaY");
    expect([...impl.storage.worktreeReplicaCommits.list()]).toHaveLength(2);
  }));

  it("tags only replica writes when one step also flushes ordinary DO edits", () => inKernel(crypto.randomUUID(), async impl => {
    const tree = await worktree(impl);
    await impl.beginAgentIntegrationTurn(1);
    const replica = await open(impl), checkpoint = await replica.checkpoint();
    const leaseId = checkpoint.cursor.split(":")[0];
    await impl.commitAgentStep(1, AUTHOR, [], {
      changes: [
        {change: {[tree.id]: [["a.txt", {edit: [3, [0, "D"]]}]]}},
        {change: {[tree.id]: [["a.txt", {edit: [4, [0, "R"]]}]]}, replica: true},
      ], createdGadgets: [], createdWorktrees: [], addedBindings: [], worktreeCommits: [], blueprintMerges: [],
      replicaCommit: {id: `${leaseId}:mixed`, leaseId, digest: "fixture",
        receipt: {batchId: "mixed", committedAt: "", accepted: [], corrections: []}},
    });
    const page = await replica.changesSince(checkpoint.cursor, 128);
    expect(page.events.map(event => event.sourceBatchId)).toEqual([undefined, "mixed", "mixed"]);
    expect(page.events.map(event => event.changes.length)).toEqual([1, 1, 0]);
  }));

  it("gives no-op acceptances their own marker without claiming the preceding DO edit", () => inKernel(crypto.randomUUID(), async impl => {
    const tree = await worktree(impl);
    await impl.beginAgentIntegrationTurn(1);
    const replica = await open(impl), checkpoint = await replica.checkpoint();
    await step(impl, 1, {[tree.id]: [["a.txt", {edit: [3, [0, "D"]]}]]});
    const receipt = await replica.submitBatch({batchId: "noop", baseCursor: checkpoint.cursor, files: []});
    const page = await replica.changesSince(checkpoint.cursor, 128);
    expect(page.events.map(event => event.sourceBatchId)).toEqual([undefined, "noop"]);
    expect(page.events[1].changes).toEqual([]);
    expect(page.cursor).toBe(receipt.committedAt);
  }));

  it("fences a closed code epoch and reacquires a genuinely new checkpoint", () => inKernel(crypto.randomUUID(), async impl => {
    const tree = await worktree(impl);
    await impl.beginAgentIntegrationTurn(1);
    const origin = impl.captureIntegrationOrigin({from: "agent", chatId: 1})!;
    const replica = await open(impl), checkpoint = await replica.checkpoint();
    await step(impl, 1, {[tree.id]: [["a.txt", {edit: [[0, "a"], 3]}]]});
    await impl.closeAgentIntegrationTurn(1, "approval");
    expect(await impl.mergeChanges(1, {profile: USER}, USER.id)).toEqual({outcome: "merged"});
    await expect((async () => { await replica.renew(); })()).rejects.toThrow(/epoch changed/);
    const next = await impl.getIntegrationContext(31, origin, "applyingAction")!.openWorktreeReplica();
    const fresh = await next.checkpoint();
    expect(fresh.checkpointId).not.toBe(checkpoint.checkpointId);
    expect(fresh.worktrees[0].baseCommit).toBe(checkpoint.worktrees[0].baseCommit);
    expect(fresh.worktrees[0].acceptedCommit).not.toBe(fresh.worktrees[0].baseCommit);
    expect(await impl.gitCache.readFileAtCommitIfExists(fresh.worktrees[0].acceptedCommit!, "a.txt")).toBe("aaaa");
    const cursor = await next.readOverlay(fresh.checkpointId);
    expect(await cursor.next()).toBeNull();
  }));

  it.each([Uint8Array.of(239, 187, 191, 65), Uint8Array.of(255, 65)])(
    "preserves attachment bytes without lossy UTF-8 projection (%j)", bytes => inKernel(crypto.randomUUID(), async impl => {
      const id = crypto.randomUUID();
      impl.storage.chatAttachmentContent.put({fileId: id, data: bytes, state: {
        type: "staged", uploadedAt: Date.now(), mimeType: "text/csv", name: "input.csv",
      }});
      const chatId = await impl.newChat(env.TEST_USER.getByName(crypto.randomUUID()),
        {profile: USER}, "Read this CSV", undefined, [{id}]);
      expect(await impl.getChatAttachmentData(chatId, id)).toEqual(bytes);
      const attachment = impl.storage.chatAttachmentContent.get(id)!;
      const context = impl.getChatAgentContext(chatId);
      if (bytes[0] === 255) {
        expect(context.attachments).toBeUndefined();
        expect(attachment.data).toEqual(bytes);
      } else {
        expect(context.attachments).toBeDefined();
        expect(attachment.data).toBeUndefined();
        const tree = impl.storage.gadgets.get(context.attachments!.worktreeId)!;
        expect(tree.type === "worktree" && await impl.readFileAtCommit(tree.baseCommit, "input.csv")).toBe("\ufeffA");
      }
    }),
  );

  it.each([false, true])("keeps an oversized text upload byte-backed (existing worktree: %s)", existing => inKernel(crypto.randomUUID(), async impl => {
    const user = env.TEST_USER.getByName(crypto.randomUUID());
    const stage = (data: Uint8Array, name: string) => {
      const id = crypto.randomUUID();
      impl.storage.chatAttachmentContent.put({fileId: id, data, state: {
        type: "staged", uploadedAt: Date.now(), mimeType: "text/plain", name,
      }});
      return {id};
    };
    const bytes = new TextEncoder().encode("x".repeat(MAX_FILE_TEXT_LENGTH + 1));
    const upload = stage(bytes, "large.txt");
    const chatId = existing
      ? await impl.newChat(user, {profile: USER}, "Initial", undefined, [stage(new TextEncoder().encode("small"), "small.txt")])
      : await impl.newChat(user, {profile: USER}, "Read this", undefined, [upload]);
    if (existing) await impl.sendChatMessage(user, {profile: USER}, chatId, "Read this", undefined, [upload]);
    const returned = await impl.getChatAttachmentData(chatId, upload.id);
    expect(returned.byteLength).toBe(bytes.byteLength);
    // A half-megabyte element-by-element matcher dominates this regression on CI. Verify
    // byte identity in native crypto instead, without weakening the byte-backed round trip.
    expect(await crypto.subtle.digest("SHA-256", returned)).toEqual(await crypto.subtle.digest("SHA-256", bytes));
    expect(impl.storage.chatAttachmentContent.get(upload.id)?.state).toMatchObject({type: "committed", chatId});
    expect(impl.storage.chatAttachmentContent.get(upload.id)?.state).not.toHaveProperty("workspacePath");
    if (!existing) expect(impl.getChatAgentContext(chatId).attachments).toBeUndefined();
    expect([...impl.storage.chats.list()].some(message => message.type === "message" &&
      message.attachments?.some(attachment => attachment.id === upload.id))).toBe(true);
  }));

  it.each(["pending", "accepted", "directory"])("does not overwrite %s agent-created attachment-worktree paths", mode => inKernel(crypto.randomUUID(), async impl => {
    const user = env.TEST_USER.getByName(crypto.randomUUID());
    const stage = (text: string, name: string) => {
      const id = crypto.randomUUID();
      impl.storage.chatAttachmentContent.put({fileId: id, data: new TextEncoder().encode(text), state: {
        type: "staged", uploadedAt: Date.now(), mimeType: "text/csv", name,
      }});
      return {id};
    };
    const chatId = await impl.newChat(user, {profile: USER}, "Initial", undefined, [stage("input", "input.csv")]);
    const worktreeId = impl.getChatAgentContext(chatId).attachments!.worktreeId;
    const generatedPath = mode === "directory" ? "report.csv/part.txt" : "report.csv";
    await step(impl, chatId, {[worktreeId]: [[generatedPath, {set: "agent-created"}]]});
    if (mode === "accepted") expect(await impl.mergeChanges(chatId, {profile: USER}, USER.id)).toEqual({outcome: "merged"});
    const upload = stage("uploaded", "report.csv");
    await impl.sendChatMessage(user, {profile: USER}, chatId, "Another attachment", undefined, [upload]);
    expect(impl.storage.chatAttachmentContent.get(upload.id)?.state).toMatchObject({workspacePath: "report-2.csv"});
    const content = await impl.getCurrentChatContent(chatId, impl.storage.chatMeta.get(chatId)!);
    expect(content.get(worktreeId)?.get(generatedPath) ?? await impl.readFileAtCommit(impl.getWorktreePinBase(worktreeId)!, generatedPath)).toBe("agent-created");
    expect(content.get(worktreeId)?.get("report-2.csv")).toBe("uploaded");
  }));
});
