// Overseer.connectToUiBlockGadget(): the gadget a `<gadget-ui>` block in an agent answer can reach.
// The kernel reads the block from the stored answer, never from the caller, and resolves the
// gadget it names in the chat's binding scope, as the agent's `env` does.

import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { AiChatAuthorInfo, Overseer } from "@gadgets/workshop-shared/api";
import { diffFiles } from "@gadgets/workshop-shared/code-change";
import type { OverseerDurableObject } from "../src/overseer.js";
import { openFakeOverseer } from "./fixtures.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

const CHAT_ID = 1;
const AGENT: AiChatAuthorInfo = { type: "agent", id: "some-model", name: "Agent" };
const USER: AiChatAuthorInfo = { type: "user", id: "owner-profile", name: "Owner" };
const EXPENSES_ID = 100;
const LATER_ID = 101;

// Blocks 0-3: bound to a seed binding, unbound, bound to a name the chat binds later, and invalid.
const ANSWER = [
  "Here is the chart.",
  '<gadget-ui gadget="EXPENSES">',
  "<title>Spending</title>",
  "</gadget-ui>",
  "<gadget-ui>",
  "<p>A one-off view.</p>",
  "</gadget-ui>",
  "<gadget-ui gadget='LATER'>",
  "</gadget-ui>",
  '<gadget-ui gadget="not a name">',
  "</gadget-ui>",
].join("\n");

// An agent message whose createGadget call binds LATER.
const createdLater = { type: "message", message: "Made it.", toolCalls: [{
  toolCallId: "t1", toolName: "createGadget",
  input: { title: "Later", bindingName: "LATER" },
  output: { gadgetId: LATER_ID, changeId: 1 },
}] };

let doCounter = 0;

type Fixture = {
  impl: any;
  answer: number;
  // Opens a client interface: the owner's, or a "build" collaborator's.
  open: (as: "owner" | "collaborator") => Promise<Overseer>;
  facets: unknown[][];
  // The files each facet would load, as the gadget worker reads them.
  loaded: Record<string, string>[];
};

async function withBlocks(fn: (fixture: Fixture) => Promise<void>): Promise<void> {
  let stub = env.TEST_OVERSEER.getByName(`ui-blocks-${++doCounter}`);
  await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
    let impl = (instance as unknown as { impl: any }).impl;
    let timestamp = impl.getChatTimestamp();
    impl.ownerId = "owner-user-do";
    impl.storage.chatMeta.put({ id: CHAT_ID, title: "Blocks", started: timestamp, lastActive: timestamp });
    impl.storage.chatContext.put({ chatId: CHAT_ID, bindings: { EXPENSES: EXPENSES_ID } });
    for (let [id, bindingName] of [[EXPENSES_ID, "EXPENSES"], [LATER_ID, "LATER"]] as const) {
      impl.storage.gadgets.put(
          { type: "gadget", id, title: "G", created: new Date(0), bindingName, bindings: {} });
    }
    impl.addChatMessages(CHAT_ID, USER, [{ type: "message", message: "Chart my spending" }]);
    impl.addChatMessages(CHAT_ID, AGENT, [{ type: "message", message: ANSWER }]);
    let answer = [...impl.storage.chats.list()].find(msg => msg.author.type === "agent").sequence;

    let facets: unknown[][] = [];
    let loaded: Record<string, string>[] = [];
    let open = (as: "owner" | "collaborator") => openFakeOverseer({}, { impl: {
      // The fixture opens as "owner-id"; naming another owner makes that a collaborator.
      ...(as === "collaborator" && { ownerId: "someone-else" }),
      uiBlockGadget: impl.uiBlockGadget.bind(impl),
      checkChatExistsAndMaterializeChanges: impl.checkChatExistsAndMaterializeChanges.bind(impl),
      getGadgetFacet: async (...args: unknown[]) => {
        facets.push(args);
        loaded.push(Object.fromEntries(await impl.readGadgetFiles(args[0], args[1])));
        return {};
      },
    } });
    await fn({ impl, answer, open, facets, loaded });
  });
}

describe("connectToUiBlockGadget", () => {
  it("refuses anything but a valid block of a stored agent answer that names a gadget",
      () => withBlocks(async ({ answer, open, facets }) => {
    let client = await open("owner");
    let connect = (sequence: number, index: number) =>
      client.connectToUiBlockGadget(CHAT_ID, sequence, index);
    await expect(connect(answer - 1, 0)).rejects.toThrow(/not an agent answer/);
    await expect(connect(answer + 1, 0)).rejects.toThrow(/not an agent answer/);
    await expect(connect(answer, 4)).rejects.toThrow(/has no block 4/);
    await expect(connect(answer, 3)).rejects.toThrow(/not a name/);
    await expect(connect(answer, 1)).rejects.toThrow(/names no gadget/);
    expect(facets).toEqual([]);
  }));

  it("opens the facet the chat's agent reaches through the named binding",
      () => withBlocks(async ({ answer, open, facets }) => {
    await (await open("owner")).connectToUiBlockGadget(CHAT_ID, answer, 0);
    await (await open("collaborator")).connectToUiBlockGadget(CHAT_ID, answer, 0);

    // At the chat's version, and counted toward a collaborator's session while the stub lives.
    expect(facets).toEqual([[EXPENSES_ID, CHAT_ID, undefined], [EXPENSES_ID, CHAT_ID, "build"]]);
  }));

  it("a name the chat binds after the block resolves once it is bound",
      () => withBlocks(async ({ impl, answer, open, facets }) => {
    let client = await open("owner");
    await expect(client.connectToUiBlockGadget(CHAT_ID, answer, 2))
        .rejects.toThrow(/"LATER" is not a gadget in this chat/);

    impl.addChatMessages(CHAT_ID, AGENT, [createdLater]);
    await client.connectToUiBlockGadget(CHAT_ID, answer, 2);
    expect(facets).toEqual([[LATER_ID, CHAT_ID, undefined]]);
  }));

  it("a name bound to anything but a gadget does not resolve",
      () => withBlocks(async ({ impl, answer, open }) => {
    // A worktree is a record in the same table, with no server to connect to.
    impl.storage.gadgets.put({ type: "worktree", id: 7, title: "Repo", created: new Date(0),
        chatId: CHAT_ID, baseCommit: "c", headCommit: "c", pinBase: "c" });
    impl.storage.chatContext.put({ chatId: CHAT_ID, bindings: { EXPENSES: 7 } });
    await expect((await open("owner")).connectToUiBlockGadget(CHAT_ID, answer, 0))
        .rejects.toThrow(/not a gadget in this chat/);
  }));

  it("after a compaction, resolves from its checkpoint and the messages after it",
      () => withBlocks(async ({ impl, answer, open, facets }) => {
    impl.addChatMessages(CHAT_ID, AGENT, [createdLater]);
    // The checkpoint holds the bindings as of its boundary, so nothing before it is read again.
    let compactedTo = answer + 2;
    impl.storage.chatCompactions.put({ chatId: CHAT_ID, compactedTo, summary: "", nextChangeId: 0,
        chatBindings: [["EXPENSES", { type: "workpiece", id: LATER_ID }]] });
    impl.storage.chatMeta.put({ ...impl.storage.chatMeta.get(CHAT_ID), compactedTo });

    let client = await open("owner");
    await client.connectToUiBlockGadget(CHAT_ID, answer, 0);
    await expect(client.connectToUiBlockGadget(CHAT_ID, answer, 2))
        .rejects.toThrow(/"LATER" is not a gadget in this chat/);
    impl.addChatMessages(CHAT_ID, AGENT, [createdLater]);
    await client.connectToUiBlockGadget(CHAT_ID, answer, 2);
    expect(facets).toEqual([[LATER_ID, CHAT_ID, undefined], [LATER_ID, CHAT_ID, undefined]]);
  }));

  it("connects to the chat's code with its live edits folded in",
      () => withBlocks(async ({ impl, answer, open, loaded }) => {
    let files = (text: string) => new Map([["server.js", text]]);
    let base = await impl.gitStore.writeFilesAsCommit(files("v1"), {
      parents: [], author: { name: "Owner", email: "owner@example.com" }, message: "v1",
      timestamp: new Date(0),
    });
    impl.storage.gadgets.put({ ...impl.storage.gadgets.get(EXPENSES_ID), commitId: base });
    // An edit made in the code editor stays a live row until something materializes it.
    await impl.submitCodeChange(CHAT_ID, {
      generation: 0, revision: 0, clientId: "editor", seq: 1,
      pins: [{ gadgetId: EXPENSES_ID, baseCommit: base }],
      change: diffFiles(new Map([[EXPENSES_ID, files("v1")]]), new Map([[EXPENSES_ID, files("v2")]])),
    }, USER, "owner-user-do");

    await (await open("owner")).connectToUiBlockGadget(CHAT_ID, answer, 0);
    expect(loaded).toEqual([{ "server.js": "v2" }]);
  }));
});
