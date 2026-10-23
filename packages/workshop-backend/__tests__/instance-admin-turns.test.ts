// Which agent turns the instance admin Gatekeeper's binding serves: only those that answer a message
// the workspace's owner wrote themselves, in a chat that is neither spawned nor a blueprint update's
// review, and only until the turn is stopped. A callback's task, or the text a connection's slash
// command expanded to, is not the owner's, and nothing that merely continues such a task (a retry,
// a resume, a steer, the owner's /compact) makes it theirs.
//
// Runs against a real OverseerDurableObject (the TEST_OVERSEER binding) with the deployment config,
// the owner's user DO, the facet and the owner's Admin API faked on the impl, and executeCode run
// through a fake LOADER whose run() the test settles (see instance-admin-grants.test.ts).

import { describe, expect, it } from "vitest";
import { RpcTarget, env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { AiChatAuthorInfo, AiChatMessageBody } from "@gadgets/workshop-shared/api";
import type { InstanceAdminGrant } from "@gadgets/workshop-shared/instance-admin";
import type { OverseerDurableObject } from "../src/overseer.js";
import { ADMIN_CONFIG_KEY } from "../src/storage-schema/blueprints-kv.js";
import { chatKeyPrefix } from "../src/storage-schema/overseer-storage.js";
// Load the whole backend (the pool's `main`) up front, so its slow load does not count against the
// first test's timeout.
import "./test-worker.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

// The pool's ADMINS.
const OWNER: AiChatAuthorInfo = { type: "user", id: "deployment-admin@example.test", name: "Owner" };
const OWNER_USER_ID = "owner-user-do";
// The author of a callback's or a spawned agent's turn: the owner, as the workspace's gadgets.
const GADGET: AiChatAuthorInfo = { type: "gadget", id: OWNER.id, name: "Admin workspace" };
const CAPSULE = 5;
const CHAT = 1;

const R3 = "The instance admin binding works only in a turn that answers a message this " +
    "workspace's owner wrote in this chat, not in one a callback, a gadget or a connection's " +
    "slash command started.";
const R15 = "The instance admin binding doesn't work in a chat an agent spawner started or in one " +
    "that reviews a blueprint update, only in the workspace's other chats.";
const R16 = "This turn was stopped, so its instance admin binding no longer works.";

const PROMPT: AiChatMessageBody = { type: "message", message: "list the users" };
const CALLBACK: AiChatMessageBody = { type: "agentCallback", methodName: "ping", argsSummary: "" };
const RETRY: AiChatMessageBody = { type: "agentNudge", text: "Retry the previous request." };
const APPROVED: AiChatMessageBody = {
  type: "agentNudge", text: "The changes you submitted have been approved and applied.",
};
const COMPACT: AiChatMessageBody = {
  type: "slashCommand", request: { id: { builtin: true, commandId: "compact" }, args: "" },
};
const CONNECTION_COMMAND: AiChatMessageBody = {
  type: "slashCommand", request: { id: { gatekeeperId: 8, commandId: "summarize" }, args: "" },
};

type Deferred = { promise: Promise<void>; resolve: () => void };

type Workspace = {
  impl: any;
  grants: InstanceAdminGrant[];
  lastRun?: Deferred;
  disposedViews: number;
};

class FakeView extends RpcTarget {
  constructor(private ws: Workspace) { super(); }
  listChats() { return []; }
  [Symbol.dispose]() { this.ws.disposedViews++; }
}

async function withWorkspace(fn: (ws: Workspace) => Promise<void>): Promise<void> {
  let stub = env.TEST_OVERSEER.getByName(`instance-admin-turns-${crypto.randomUUID()}`);
  await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
    let impl = (instance as unknown as { impl: any }).impl;
    let ws: Workspace = { impl, grants: [], disposedViews: 0 };
    impl.env = {
      ...env,
      BLUEPRINTS: {
        get: async (key: string) => key === ADMIN_CONFIG_KEY
          ? JSON.stringify({ ambientGatekeeperModes: { instanceadmin: "optional" } }) : null,
      },
      LOADER: {
        load: () => {
          let resolve!: () => void;
          let promise = new Promise<void>(r => { resolve = r; });
          ws.lastRun = { promise, resolve };
          return { getEntrypoint: () => ({ verify: async () => {}, run: () => promise }) };
        },
      },
    };
    let owner = {
      whoami: async () => OWNER,
      assertInstanceAdminAccount: async () => {},
      setGadgetLastActive: async () => {},
    getGadget: async () => null,
    };
    impl.users = {
      idFromString: (id: string) => id, idFromName: (name: string) => name, get: () => owner,
    };
    impl.directories = {
      getByName: () => ({ syncWorkspace: async () => {}, workspaceTitle: async () => null }),
    };
    impl.ownerId = OWNER_USER_ID;
    impl.ownerProfileId = OWNER.id;
    impl.storage.ownerId.put(OWNER_USER_ID);
    impl.storage.title.put("Admin workspace");
    impl.storage.nextGatekeeperId.put(10);
    impl.storage.gatekeepers.put({
      id: CAPSULE, class: {} as any, resourceTitle: "Instance admin",
      creationSpec: { type: "ambient", vendorId: "instanceadmin", accountId: 7 },
    });
    impl.storage.instanceAdminLatched.put(true);
    impl.storage.instanceAdminActive.put(true);
    impl.getGatekeeperFacet = async () => ({
      startAdminSession: async (grant: InstanceAdminGrant) => { ws.grants.push(grant); return {}; },
    });
    impl.adminApiForAgent = () => new Proxy({}, {
      get: (_target, method: string) => () =>
        method === "inspectWorkspace" ? new FakeView(ws) : { users: [] },
    });
    impl.storage.chatMeta.put(
        { id: CHAT, title: "Admin", started: new Date(0), lastActive: new Date(0) });
    await fn(ws);
  });
}

// Logs `records`, each with its author, in order.
function log(ws: Workspace, ...records: [AiChatAuthorInfo, AiChatMessageBody][]): void {
  for (let [author, body] of records) ws.impl.addChatMessages(CHAT, author, [body]);
}

// The expansion of the connection command logged just before it, as the Workshop logs it.
function expansion(ws: Workspace): AiChatMessageBody {
  let [command] = ws.impl.storage.chats.list(
      { prefix: chatKeyPrefix(CHAT), reverse: true, limit: 1 });
  return { type: "message", message: "Summarize this.",
           generatedBySlashCommandSequence: command.sequence };
}

type Run = { executionId: string; end: () => Promise<void> };

function startRun(ws: Workspace, initiator: AiChatAuthorInfo): Run {
  let impl = ws.impl;
  let executionId!: string;
  let getEnvForAgent = impl.getEnvForAgent;
  impl.getEnvForAgent = (chatId: number, bindings: unknown, id: string) => {
    executionId = id;
    return getEnvForAgent.call(impl, chatId, bindings, id);
  };
  let done = impl.executeCodeMode(CHAT, "export default async () => {}", initiator, "model",
      { INSTANCE_ADMIN: { type: "workpiece", id: CAPSULE } });
  impl.getEnvForAgent = getEnvForAgent;
  let run = ws.lastRun!;
  return {
    executionId,
    end: async () => {
      run.resolve();
      await impl.deliverCodeModeTrace(executionId, { logs: [] });
      await done;
    },
  };
}

function mint(ws: Workspace, run: Run): Promise<unknown> {
  return ws.impl.startGatekeeperSession(
      { type: "gatekeeper", id: CAPSULE, executionId: run.executionId },
      { from: "agent", chatId: CHAT });
}

// Mints in a run of `initiator`'s on the chat as logged, resolving to the refusal, if any.
async function mintAs(ws: Workspace, initiator: AiChatAuthorInfo = OWNER)
    : Promise<string | undefined> {
  let run = startRun(ws, initiator);
  try {
    await mint(ws, run);
    return undefined;
  } catch (error) {
    return (error as Error).message;
  } finally {
    await run.end();
  }
}

describe("the owner's own turns", () => {
  it("are served, resumed after an approval and retried", () => withWorkspace(async ws => {
    log(ws, [OWNER, PROMPT]);
    expect(await mintAs(ws)).toBeUndefined();
    log(ws, [OWNER, APPROVED]);
    expect(await mintAs(ws)).toBeUndefined();
    log(ws, [OWNER, RETRY]);
    expect(await mintAs(ws)).toBeUndefined();
    expect(ws.grants).toHaveLength(3);
  }));

  it("include the owner's next prompt after a connection's slash command",
      () => withWorkspace(async ws => {
    log(ws, [OWNER, CONNECTION_COMMAND]);
    log(ws, [OWNER, expansion(ws)], [GADGET, { type: "message", message: "Done." }]);
    log(ws, [OWNER, PROMPT]);
    expect(await mintAs(ws)).toBeUndefined();
  }));

  it("stay the owner's across a /compact and a retry", () => withWorkspace(async ws => {
    log(ws, [OWNER, PROMPT], [OWNER, COMPACT], [OWNER, RETRY]);
    expect(await mintAs(ws)).toBeUndefined();
  }));
});

describe("turns that are not the owner's own", () => {
  it("refuse a callback's turn, and its legacy adoption by the owner",
      () => withWorkspace(async ws => {
    log(ws, [OWNER, PROMPT], [GADGET, CALLBACK]);
    expect(await mintAs(ws, GADGET)).toBe(R3);
    // rememberDecisionInitiator gives an old paused callback turn the approver as initiator.
    expect(await mintAs(ws, OWNER)).toBe(R3);
  }));

  it("refuse a retry or a steer after a callback", () => withWorkspace(async ws => {
    log(ws, [OWNER, PROMPT], [GADGET, CALLBACK], [OWNER, RETRY]);
    expect(await mintAs(ws, OWNER)).toBe(R3);
  }));

  it("refuse the follow-up turn a steer after a callback prompts", () => withWorkspace(async ws => {
    // The steer is logged as the owner's prompt, but the turn keeps the callback's initiator.
    log(ws, [GADGET, CALLBACK], [OWNER, PROMPT]);
    expect(await mintAs(ws, GADGET)).toBe(R3);
  }));

  it("refuse a connection's slash command, and its retry", () => withWorkspace(async ws => {
    log(ws, [OWNER, PROMPT], [OWNER, CONNECTION_COMMAND]);
    log(ws, [OWNER, expansion(ws)]);
    expect(await mintAs(ws)).toBe(R3);
    log(ws, [OWNER, RETRY]);
    expect(await mintAs(ws)).toBe(R3);
    expect(ws.grants).toStrictEqual([]);
  }));

  it("refuse a retry after compacting a callback's or a slash command's task",
      () => withWorkspace(async ws => {
    log(ws, [OWNER, PROMPT], [GADGET, CALLBACK], [OWNER, COMPACT], [OWNER, RETRY]);
    expect(await mintAs(ws)).toBe(R3);
    log(ws, [OWNER, CONNECTION_COMMAND]);
    log(ws, [OWNER, expansion(ws)], [OWNER, COMPACT], [OWNER, RETRY]);
    expect(await mintAs(ws)).toBe(R3);
  }));
});

describe("chats the binding never serves", () => {
  it("refuse a spawned chat", () => withWorkspace(async ws => {
    ws.impl.storage.chatContext.put({
      chatId: CHAT, spawnerConfig: { displayName: "Spawner", modelId: null, env: {} },
    });
    log(ws, [OWNER, PROMPT]);
    expect(await mintAs(ws)).toBe(R15);
  }));

  it("refuse a blueprint update's review, even after the owner's prompt",
      () => withWorkspace(async ws => {
    log(ws, [OWNER, {
      type: "changes",
      blueprintMerges: [{ gadgetId: 3, blueprintId: "bp-1", commitId: "c".repeat(40) }],
    } as AiChatMessageBody]);
    log(ws, [OWNER, PROMPT]);
    expect(await mintAs(ws)).toBe(R15);
  }));
});

describe("a stopped turn", () => {
  for (let [name, stop] of [
    ["Stop", (ws: Workspace) => ws.impl.cancelAgent(CHAT)],
    ["the chat's teardown", (ws: Workspace) => ws.impl.destroyLiveChat(CHAT)],
  ] as const) {
    it(`refuses its grant and its views after ${name}`, () => withWorkspace(async ws => {
      log(ws, [OWNER, PROMPT]);
      let run = startRun(ws, OWNER);
      await mint(ws, run);
      let [grant] = ws.grants;
      let opened = await grant!.callAdminApi("inspectWorkspace", ["w-9", "Ticket 7"]);
      if (opened.outcome !== "answered") throw new Error("Expected a view.");
      let view = opened.value as { listChats(): Promise<unknown> };
      stop(ws);
      await expect(grant!.callAdminApi("listUsers", [])).rejects.toThrow(R16);
      await expect(view.listChats()).rejects.toThrow(R16);
      await expect(mint(ws, run)).rejects.toThrow(R16);
      await run.end();
    }));
  }
});
