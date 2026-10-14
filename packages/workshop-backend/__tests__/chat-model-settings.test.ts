// A chat's own model settings (see ChatModelSettings): what the Overseer stores for a chat, the
// config its turns run with, and what describeChatModel() tells the composer about a model. Drives
// the real OverseerImpl and client interface in workerd, with getModel() and runAgent() wrapped so
// a test can read the config a turn hands them.

import { afterEach, describe, expect, it, vi } from "vitest";
import { env, RpcStub as NativeRpcStub, RpcTarget as NativeRpcTarget } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { RpcStub } from "capnweb";
import type {
  AiChatAuthorInfo, AiChatMessage, AiChatMetadata, AiChatSubscriber, AiModelConfig,
  ChatModelSettings, Overseer,
} from "@gadgets/workshop-shared/api";
import { serializeAdminConfig } from "../src/admin-config.js";
import { getGatewayModels } from "../src/ai-gateway.js";
import {
  describeGatewayModel, validateChatModelSettings, withChatSettings,
} from "../src/ai-models.js";
import type { OverseerDurableObject } from "../src/overseer.js";
import { DEFAULT_ADMIN_CONFIG, type AdminConfig }
  from "../src/storage-schema/admin-settings-storage.js";
import type { UserAiModelRecord } from "../src/storage-schema/user-storage.js";
import { openFakeOverseer } from "./fixtures.js";

const { getModelSpy, runAgentSpy } = vi.hoisted(() => ({
  getModelSpy: vi.fn(),
  runAgentSpy: vi.fn(async () => {}),
}));

// The real getModel(), watched; runAgent() does nothing, since only the config it gets matters.
vi.mock("../src/ai-models", async importOriginal => {
  let original = await importOriginal<typeof import("../src/ai-models")>();
  getModelSpy.mockImplementation(original.getModel);
  return { ...original, getModel: getModelSpy };
});
vi.mock("../src/agent", async importOriginal => ({
  ...await importOriginal<typeof import("../src/agent")>(),
  runAgent: runAgentSpy,
}));

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

// The OverseerImpl members these tests drive; the class itself is private to overseer.ts.
interface OverseerInternals {
  env: Cloudflare.Env;
  users: object;
  storage: {
    chatMeta: {
      get(id: number): AiChatMetadata | undefined;
      put(meta: AiChatMetadata): void;
      list(): Iterable<AiChatMetadata>;
    };
    chats: { put(message: AiChatMessage): void };
  };
  nextChatSequence(chatId: number): number;
  startAgent(chatId: number, aiModel: UserAiModelRecord, initiator: AiChatAuthorInfo,
             initiatorUserId: string): void;
  waitForAllAgentsToComplete(): Promise<void>;
  ensureAmbientCapsules(): Promise<void>;
  markOutputsDirty(): void;
  ownerId?: string;
}

const OWNER: AiChatAuthorInfo = { type: "user", id: "owner@example.com", name: "Owner" };
const MODEL: AiChatAuthorInfo = { type: "agent", id: "my-model", name: "My Model" };
const CONFIG: AiModelConfig = {
  provider: "anthropic", model: "claude-opus-5-5", apiToken: "sk-secret",
  apiUrl: "https://anthropic.test", reasoning: "high",
};
const CHAT_ID = 1;
const LAST_ACTIVE = new Date(1000);

// The user object an opened client reaches. As the real one does, getChatContext() resolves no
// model for a null or empty ID and refuses an ID it doesn't know; it knows `aiModel` alone.
function fakeUsers(aiModel?: UserAiModelRecord) {
  return {
    idFromString: (id: string) => id,
    get: (id: string) => ({
      id,
      getChatContext: async (modelId: string | null) => {
        if (modelId === null || modelId === "") return { profile: OWNER };
        if (modelId !== aiModel?.profile.id) throw new Error(`No such model: ${modelId}`);
        return { profile: OWNER, aiModel };
      },
      publishNotification: async () => {},
      setGadgetLastActive: async () => {},
    }),
  };
}

let doCounter = 0;
async function inOverseer(fn: (impl: OverseerInternals, instance: OverseerDurableObject)
    => Promise<void>): Promise<void> {
  let stub = env.TEST_OVERSEER.getByName(`chat-model-settings-${++doCounter}`);
  await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
    await fn((instance as unknown as { impl: OverseerInternals }).impl, instance);
  });
}

// The real client interface, opened over the Overseer as its owner, whose user object is
// fakeUsers(aiModel).
function withClient(fn: (impl: OverseerInternals, client: Overseer) => Promise<void>,
                    aiModel?: UserAiModelRecord): Promise<void> {
  return inOverseer(async (impl, instance) => {
    let ownerId = (impl.users as DurableObjectNamespace).newUniqueId().toString();
    impl.ownerId = ownerId;
    impl.ensureAmbientCapsules = async () => {};
    impl.markOutputsDirty = () => {};
    using notifyClosed = new NativeRpcStub<() => void>(() => {});
    using client = await instance.open(ownerId, "owner-profile", notifyClosed) as
        Overseer & Disposable;
    impl.users = fakeUsers(aiModel);
    await fn(impl, client);
  });
}

function addChat(impl: OverseerInternals, meta: Partial<AiChatMetadata> = {}): void {
  impl.storage.chatMeta.put(
      { id: CHAT_ID, title: "Chat", started: new Date(0), lastActive: LAST_ACTIVE, ...meta });
}

// Lets deliveries through a native stub (which arrive asynchronously) land before asserting.
const settled = () => new Promise(resolve => setTimeout(resolve, 0));

afterEach(() => {
  getModelSpy.mockClear();
  runAgentSpy.mockClear();
});

describe("withChatSettings", () => {
  it("puts the fields the chat sets in place of the model's", () => {
    expect(withChatSettings(CONFIG, { reasoning: "low", compactionInputBudget: 20000 }))
        .toStrictEqual({ ...CONFIG, reasoning: "low", compactionInputBudget: 20000 });
    expect(withChatSettings({ ...CONFIG, compactionInputBudget: 9000 }, { reasoning: "off" }))
        .toStrictEqual({ ...CONFIG, reasoning: "off", compactionInputBudget: 9000 });
  });

  it("keeps the model's own value for a field the chat leaves undefined", () => {
    expect(withChatSettings(CONFIG, { reasoning: undefined, compactionInputBudget: 5000 }))
        .toStrictEqual({ ...CONFIG, compactionInputBudget: 5000 });
  });

  it("returns the model's config itself when the chat sets nothing", () => {
    expect(withChatSettings(CONFIG, undefined)).toBe(CONFIG);
    expect(withChatSettings(CONFIG, {})).toBe(CONFIG);
    expect(withChatSettings(CONFIG, { reasoning: undefined })).toBe(CONFIG);
  });
});

describe("validateChatModelSettings", () => {
  it.each([0, -1, 1.5, NaN, Infinity, 2 ** 53])("refuses a compaction budget of %s", budget => {
    expect(() => validateChatModelSettings({ compactionInputBudget: budget }))
        .toThrow("positive whole number");
  });

  it("returns a copy holding only the fields that are set", () => {
    let settings = { reasoning: "max", compactionInputBudget: undefined, extra: 1 } as
        ChatModelSettings;
    expect(validateChatModelSettings(settings)).toStrictEqual({ reasoning: "max" });
    let full: ChatModelSettings = { reasoning: "low", compactionInputBudget: 1 };
    let copy = validateChatModelSettings(full);
    expect(copy).toStrictEqual(full);
    expect(copy).not.toBe(full);
  });
});

describe("setChatModelSettings", () => {
  it("stores the settings without reordering the chat, and {} clears them",
      () => withClient(async (impl, client) => {
    addChat(impl);
    await client.setChatModelSettings(
        CHAT_ID, { reasoning: "low", compactionInputBudget: 20000 });
    expect(impl.storage.chatMeta.get(CHAT_ID)).toMatchObject({
      lastActive: LAST_ACTIVE, modelSettings: { reasoning: "low", compactionInputBudget: 20000 },
    });
    let [listed] = await client.listChats();
    expect(listed.modelSettings).toStrictEqual({ reasoning: "low", compactionInputBudget: 20000 });

    await client.setChatModelSettings(CHAT_ID, {});
    let meta = impl.storage.chatMeta.get(CHAT_ID)!;
    expect(meta).not.toHaveProperty("modelSettings");
    expect(meta.lastActive).toEqual(LAST_ACTIVE);
  }));

  it("reaches a metadata subscriber", () => withClient(async (impl, client) => {
    addChat(impl);
    let delivered: AiChatMetadata[] = [];
    // A native stub has no onRpcBroken() of its own, so the subscriber takes the client's call.
    class Subscriber extends NativeRpcTarget {
      onRpcBroken() {}
      async streamGeneration() {}
      async metadata(meta: AiChatMetadata) { delivered.push(meta); }
      async deleted() {}
      async message() {}
      async changeApplied() {}
      async stream() {}
    }
    using subscriber = new NativeRpcStub(new Subscriber());
    using _subscription = await client.subscribeToChat(
        subscriber as unknown as RpcStub<AiChatSubscriber>);

    await client.setChatModelSettings(CHAT_ID, { compactionInputBudget: 30000 });
    await settled();
    expect(delivered.at(-1)?.modelSettings).toStrictEqual({ compactionInputBudget: 30000 });

    await client.setChatModelSettings(CHAT_ID, {});
    await settled();
    expect(delivered.at(-1)).not.toHaveProperty("modelSettings");
  }));

  it("refuses a malformed budget, storing nothing", () => withClient(async (impl, client) => {
    addChat(impl, { modelSettings: { reasoning: "low" } });
    for (let budget of [0, 1.5]) {
      await expect(client.setChatModelSettings(
          CHAT_ID, { reasoning: "max", compactionInputBudget: budget }))
          .rejects.toThrow("positive whole number");
    }
    expect(impl.storage.chatMeta.get(CHAT_ID)?.modelSettings).toStrictEqual({ reasoning: "low" });
  }));

  it("refuses an unknown chat", () => withClient(async (_impl, client) => {
    await expect(client.setChatModelSettings(7, { reasoning: "low" }))
        .rejects.toThrow("No such chatId: 7");
  }));

  it("is denied to a collaborator who may only use the gadget", async () => {
    let client = await openFakeOverseer({}, { role: "use" });
    await expect(client.setChatModelSettings(CHAT_ID, {})).rejects.toThrow("Unauthorized");
    await expect(client.describeChatModel(MODEL.id)).rejects.toThrow("Unauthorized");
  });
});

describe("newChat", () => {
  it("starts the chat with the settings it is given", () => withClient(async (impl, client) => {
    let chatId = await client.newChat(
        "Hi", null, undefined, undefined, undefined, { compactionInputBudget: 40000 });
    expect(impl.storage.chatMeta.get(chatId)?.modelSettings)
        .toStrictEqual({ compactionInputBudget: 40000 });

    let plain = await client.newChat("Hi", null, undefined, undefined, undefined, {});
    expect(impl.storage.chatMeta.get(plain)).not.toHaveProperty("modelSettings");
  }));

  it("refuses a malformed budget, creating no chat", () => withClient(async (impl, client) => {
    await expect(client.newChat(
        "Hi", null, undefined, undefined, undefined, { compactionInputBudget: -1 }))
        .rejects.toThrow("positive whole number");
    expect([...impl.storage.chatMeta.list()]).toEqual([]);
  }));
});

// Runs one turn of a chat with `modelSettings` on a model whose config is `config`, returning
// the config getModel() and runAgent() each got.
async function turnConfigs(config: AiModelConfig, modelSettings?: ChatModelSettings) {
  await inOverseer(async impl => {
    impl.users = fakeUsers();
    addChat(impl, { activeAgent: MODEL, ...(modelSettings ? { modelSettings } : {}) });
    impl.storage.chats.put({
      chatId: CHAT_ID, sequence: impl.nextChatSequence(CHAT_ID), timestamp: new Date(0),
      author: OWNER, type: "message", message: "Hi",
    });
    impl.startAgent(CHAT_ID, { profile: MODEL, config }, OWNER, "owner-user");
    await impl.waitForAllAgentsToComplete();
  });
  expect(getModelSpy).toHaveBeenCalledTimes(1);
  expect(runAgentSpy).toHaveBeenCalledTimes(1);
  return {
    getModel: getModelSpy.mock.calls[0][1] as AiModelConfig,
    runAgent: (runAgentSpy.mock.calls[0] as unknown[])[6] as AiModelConfig,
  };
}

describe("an agent turn", () => {
  it("runs with the chat's settings ahead of the model's", async () => {
    let expected = { ...CONFIG, reasoning: "low", compactionInputBudget: 20000 };
    expect(await turnConfigs(
        { ...CONFIG, compactionInputBudget: 90000 },
        { reasoning: "low", compactionInputBudget: 20000 }))
        .toStrictEqual({ getModel: expected, runAgent: expected });
  });

  it("runs with the model's own config when the chat sets nothing", async () => {
    expect(await turnConfigs(CONFIG)).toStrictEqual({ getModel: CONFIG, runAgent: CONFIG });
  });

  it("keeps the model's reasoning level when the chat sets only a budget", async () => {
    let expected = { ...CONFIG, compactionInputBudget: 20000 };
    expect(await turnConfigs(CONFIG, { compactionInputBudget: 20000 }))
        .toStrictEqual({ getModel: expected, runAgent: expected });
  });
});

describe("describeChatModel", () => {
  const GATEWAY_MODEL = "claude-opus-5-5";
  const GATEWAY_ENV = {
    CF_AI_GATEWAY: "platform-gateway",
    CF_AI_GATEWAY_ACCOUNT_ID: "account-id",
    CF_AI_GATEWAY_API_TOKEN: "gateway-token",
    CF_AI_GATEWAY_PROVIDERS: "anthropic",
  };

  // The config a gateway deployment whose admin config is `admin` runs GATEWAY_MODEL with, as the
  // user object resolves it.
  async function gatewayModel(admin: Partial<AdminConfig>): Promise<UserAiModelRecord> {
    let models = await getGatewayModels({
      ...env, ...GATEWAY_ENV,
      BLUEPRINTS: {
        get: async () => serializeAdminConfig({ ...DEFAULT_ADMIN_CONFIG, ...admin }),
      } as unknown as KVNamespace,
    });
    return models!.resolve(GATEWAY_MODEL)!;
  }

  // Describes `aiModel` to the owner of a workspace, through AI Gateway or not.
  async function described(aiModel: UserAiModelRecord, gateway: boolean) {
    let description;
    await withClient(async (impl, client) => {
      if (gateway) impl.env = { ...impl.env, ...GATEWAY_ENV };
      description = await client.describeChatModel(aiModel.profile.id);
    }, aiModel);
    return description;
  }

  it("gives the admin's level and budget for a gateway model", async () => {
    let model = await gatewayModel({
      defaultReasoning: "high",
      modelSettings: { [GATEWAY_MODEL]: { reasoning: "low", compactionInputBudget: 50000 } },
    });
    let base = describeGatewayModel(model.config);
    expect(base.reasoningLevels.length).toBeGreaterThan(0);
    expect(await described(model, true))
        .toStrictEqual({ ...base, reasoning: "low", compactionInputBudget: 50000 });
  });

  it("gives the deployment's default level and the built-in budget", async () => {
    let model = await gatewayModel({ defaultReasoning: "high" });
    let base = describeGatewayModel(model.config);
    expect(await described(model, true)).toStrictEqual({
      ...base, reasoning: "high", compactionInputBudget: base.builtInCompactionInputBudget,
    });
  });

  it("lists no levels off AI Gateway, and null for a model with none set", async () => {
    let { reasoning, ...unset } = CONFIG;
    let model = { profile: MODEL, config: unset };
    let base = describeGatewayModel(unset);
    expect(base.reasoningLevels.length).toBeGreaterThan(0);
    expect(await described(model, false)).toStrictEqual({
      ...base, reasoningLevels: [], reasoning: null,
      compactionInputBudget: base.builtInCompactionInputBudget,
    });
  });

  it("gives no level off AI Gateway even for a model that sets one", async () => {
    let model = { profile: MODEL, config: CONFIG };
    expect(CONFIG.reasoning).toBeDefined();
    expect(await described(model, false)).toMatchObject({ reasoningLevels: [], reasoning: null });
  });

  it("refuses a model the user can't run", () => withClient(async (_impl, client) => {
    await expect(client.describeChatModel("nope")).rejects.toThrow("No such model: nope");
    await expect(client.describeChatModel("")).rejects.toThrow("No such model: ");
  }, { profile: MODEL, config: CONFIG }));
});
