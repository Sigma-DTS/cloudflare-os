import { describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { AiModelConfig, RedactedAiModelConfig } from "@gadgets/workshop-shared/api";
import { serializeAdminConfig } from "../src/admin-config.js";
import { AiGatewayConfig, GatewayModels } from "../src/ai-gateway.js";
import { DEFAULT_ADMIN_CONFIG, type AdminConfig } from "../src/storage-schema/admin-settings-storage.js";
import type { UserAiModelRecord } from "../src/storage-schema/user-storage.js";
import type { UserDurableObject } from "../src/user.js";
import { describeUserModel, testUserModel } from "../src/user-models.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_USER: DurableObjectNamespace<UserDurableObject>;
  }
}

const PROFILE = { type: "agent" as const, id: "my-model", name: "My Model" };
const CONFIG: AiModelConfig = {
  provider: "openai",
  model: "my-model",
  apiToken: "sk-secret",
  apiUrl: "https://proxy.example/v1",
  extraHeaders: { "X-Proxy-Key": "proxy-secret", "X-Empty": "" },
};

type ModelMethods = Pick<UserDurableObject, "addModel" | "getModelConfig" | "updateModel">;

let userCounter = 0;
async function userWithModel() {
  const stub = env.TEST_USER.getByName(`user-models-${++userCounter}`);
  // Calls go through runInDurableObject rather than the stub's RPC, whose rejections workerd
  // reports as uncaught exceptions even once the test has handled them.
  const inDo = <T>(f: (user: UserDurableObject) => Promise<T>) => runInDurableObject(stub, f);
  const user: ModelMethods = {
    addModel: (...args) => inDo(u => u.addModel(...args)),
    getModelConfig: (...args) => inDo(u => u.getModelConfig(...args)),
    updateModel: (...args) => inDo(u => u.updateModel(...args)),
  };
  const stored = (id: string) => inDo(async u =>
      (u as unknown as { storage: { aiModels: { get(id: string): unknown } } }).storage.aiModels.get(id));
  await user.addModel(PROFILE, CONFIG);
  return { user, stored, inDo };
}

describe("UserDurableObject model editing", () => {
  it("replaces secrets that are supplied, and drops headers that are omitted", async () => {
    const { user, stored } = await userWithModel();
    await user.updateModel(PROFILE, {
      ...CONFIG, apiToken: "sk-new", extraHeaders: { "X-Proxy-Key": null, "X-New": "v" },
    });
    expect(await stored(PROFILE.id)).toEqual({
      profile: PROFILE,
      config: { ...CONFIG, apiToken: "sk-new", extraHeaders: { "X-Proxy-Key": "proxy-secret", "X-New": "v" } },
    });
  });

  it("refuses to keep a secret for a header that isn't stored", async () => {
    const { user } = await userWithModel();
    await expect(user.updateModel(PROFILE, { ...CONFIG, extraHeaders: { "x-proxy-key": null } }))
        .rejects.toThrow("no stored");
  });

  it("refuses to keep secrets when the API URL changes", async () => {
    const { user, stored } = await userWithModel();
    const { config } = await user.getModelConfig(PROFILE.id);
    await expect(user.updateModel(PROFILE, { ...config, apiUrl: "https://attacker.example" }))
        .rejects.toThrow("re-enter");
    await expect(user.updateModel(PROFILE, { ...config, apiUrl: undefined }))
        .rejects.toThrow("re-enter");
    expect(await stored(PROFILE.id)).toEqual({ profile: PROFILE, config: CONFIG });

    // Supplying every secret afresh is fine.
    const moved = { ...CONFIG, apiUrl: "https://other.example", apiToken: "sk-2", extraHeaders: {} };
    await user.updateModel(PROFILE, moved);
    expect(await stored(PROFILE.id)).toEqual({ profile: PROFILE, config: moved });
  });

  it("refuses to change the provider or model", async () => {
    const { user } = await userWithModel();
    const { config } = await user.getModelConfig(PROFILE.id);
    await expect(user.updateModel(PROFILE, { ...config, model: "other" })).rejects.toThrow("can't be changed");
    await expect(user.updateModel(PROFILE, { ...CONFIG, provider: "anthropic" })).rejects.toThrow("can't be changed");
  });

  it("refuses to edit a model that doesn't exist", async () => {
    const { user } = await userWithModel();
    await expect(user.getModelConfig("nope")).rejects.toThrow("No such");
    await expect(user.updateModel({ ...PROFILE, id: "nope" }, CONFIG)).rejects.toThrow("No such");
  });

  it("copies withheld secrets when cloning to the same endpoint", async () => {
    const { user, stored } = await userWithModel();
    const { config } = await user.getModelConfig(PROFILE.id);
    const clone = { type: "agent" as const, id: "clone", name: "Clone" };
    await user.addModel(clone, { ...config, model: "clone" }, PROFILE.id);
    expect(await stored("clone")).toEqual({ profile: clone, config: { ...CONFIG, model: "clone" } });
  });

  it("refuses to clone secrets to another endpoint or over an existing model", async () => {
    const { user } = await userWithModel();
    const { config } = await user.getModelConfig(PROFILE.id);
    const clone = { type: "agent" as const, id: "clone", name: "Clone" };
    await expect(user.addModel(clone, { ...config, provider: "anthropic" }, PROFILE.id))
        .rejects.toThrow("re-enter");
    await expect(user.addModel(PROFILE, config, PROFILE.id)).rejects.toThrow("already exists");
    await expect(user.addModel(clone, config, "nope")).rejects.toThrow("No such");
  });

  it("refuses to add over an existing model", async () => {
    const { user, stored } = await userWithModel();
    await expect(user.addModel({ ...PROFILE, name: "Other" }, { ...CONFIG, apiToken: "sk-other" }))
        .rejects.toThrow("already exists");
    expect(await stored(PROFILE.id)).toEqual({ profile: PROFILE, config: CONFIG });
  });

  // The validated RPC boundary lets through properties the argument's type omits, and checks
  // the shape of the ones it has only there.
  it("keeps a model's own settings, and stores no model for it to behave like", async () => {
    const { user, stored } = await userWithModel();
    const settings = { reasoning: "max" as const, compactionInputBudget: 5 };
    const sent = {
      ...settings, behavesLike: "gpt-6-sol",
      capabilities: { imageInput: "yes", reasoningLevels: ["high", "low", "high"] },
    };
    const kept = { ...settings, capabilities: { reasoningLevels: ["low", "high"] } };
    const other = { type: "agent" as const, id: "other", name: "Other" };
    await user.addModel(other, { ...CONFIG, model: "other", ...sent } as typeof CONFIG);
    expect(await stored("other")).toStrictEqual(
        { profile: other, config: { ...CONFIG, model: "other", ...kept } });

    await user.updateModel(PROFILE, { ...CONFIG, contextWindow: 200000, ...sent } as
        typeof CONFIG);
    expect(await stored(PROFILE.id)).toStrictEqual(
        { profile: PROFILE, config: { ...CONFIG, contextWindow: 200000, ...kept } });
    expect((await user.getModelConfig(PROFILE.id)).config).toMatchObject(kept);
  });

  it("refuses a compaction budget beyond the room the window leaves, or not a whole number",
      async () => {
    const { user, stored } = await userWithModel();
    // 800 tokens are left for a prompt.
    const limits = { ...CONFIG, contextWindow: 1000, outputLimit: 200 };
    const refused = "The compaction budget must be a whole number of tokens from 1 to 800.";
    for (let compactionInputBudget of [801, 1.5, 0, -1]) {
      await expect(user.updateModel(PROFILE, { ...limits, compactionInputBudget }))
          .rejects.toThrow(new Error(refused));
    }
    expect(await stored(PROFILE.id)).toEqual({ profile: PROFILE, config: CONFIG });
    await expect(user.addModel({ ...PROFILE, id: "full" },
        { ...limits, outputLimit: 1000, compactionInputBudget: 1 }))
        .rejects.toThrow("leaves no room");

    await user.updateModel(PROFILE, { ...limits, compactionInputBudget: 800 });
    expect(await stored(PROFILE.id))
        .toEqual({ profile: PROFILE, config: { ...limits, compactionInputBudget: 800 } });
  });

  it("requires every secret when adding without a source", async () => {
    const { user } = await userWithModel();
    const clone = { type: "agent" as const, id: "clone", name: "Clone" };
    await expect(user.addModel(clone, { ...CONFIG, apiToken: null })).rejects.toThrow("required");
  });

  // Only AI Gateway mode consults the admin config for models. This pool binds no BLUEPRINTS
  // namespace, so a read of it here would throw.
  it("lists and resolves models without the admin config outside AI Gateway mode", async () => {
    const { inDo } = await userWithModel();
    await inDo(async user => {
      expect(await user.listModels()).toEqual([PROFILE]);
      await user.setPreferredModel(PROFILE.id);
      expect((await user.getChatContext(PROFILE.id)).aiModel?.config).toEqual(CONFIG);
      expect((await user.getExternalMessageChatContext(null)).aiModel?.profile).toEqual(PROFILE);
      await user.deleteModel(PROFILE.id);
      expect(await user.listModels()).toEqual([]);
    });
  });
});

const listedIds = async (user: UserDurableObject) =>
    (await user.listModels()).map(model => model.id);
const providerUnavailable = (provider: string) =>
    new Error(`Provider "${provider}" is not available in AI Gateway mode.`);
const storedModel = (user: UserDurableObject, id: string) =>
    (user as unknown as { storage: { aiModels: { get(id: string): unknown } } })
        .storage.aiModels.get(id);

describe("UserDurableObject gateway model modes", () => {
  const ENABLED_ID = "claude-opus-5-5";
  const HIDDEN_ID = "claude-opus-5";
  const DISABLED_MESSAGE =
      'The "Claude Opus 5.5" model is disabled on this deployment by an administrator.';
  const DISABLED: Partial<AdminConfig> = { modelModes: { [ENABLED_ID]: "disabled" } };

  // Every call runs in one invocation, since the gateway env is only overridden on this instance.
  // `config` is the deployment's admin config, which gateway models are read through.
  function inGatewayUser<T>(f: (user: UserDurableObject) => Promise<T>,
                            config: Partial<AdminConfig> = {}) {
    const stub = env.TEST_USER.getByName(`user-models-${++userCounter}`);
    return runInDurableObject(stub, async user => {
      const impl = user as unknown as { env: Cloudflare.Env };
      const original = impl.env;
      impl.env = {
        ...original,
        CF_AI_GATEWAY: "platform-gateway",
        CF_AI_GATEWAY_ACCOUNT_ID: "account-id",
        CF_AI_GATEWAY_API_TOKEN: "gateway-token",
        CF_AI_GATEWAY_PROVIDERS: "anthropic",
        BLUEPRINTS: {
          get: async () => serializeAdminConfig({ ...DEFAULT_ADMIN_CONFIG, ...config }),
        } as unknown as KVNamespace,
      };
      try {
        return await f(user);
      } finally {
        impl.env = original;
      }
    });
  }

  // A model stored under a gateway model's ID, as one added before the deployment provided that
  // model would be.
  function storeModel(user: UserDurableObject, id: string) {
    const record: UserAiModelRecord = {
      profile: { ...PROFILE, id, name: "Stale" },
      config: { ...CONFIG, provider: "anthropic", model: id },
    };
    (user as unknown as { storage: { aiModels: { put(record: UserAiModelRecord): void } } })
        .storage.aiModels.put(record);
  }

  it("refuses to add a model that a hidden gateway model would shadow", () => inGatewayUser(async user => {
    await expect(user.addModel({ ...PROFILE, id: HIDDEN_ID }, { ...CONFIG, model: HIDDEN_ID }))
        .rejects.toThrow("already exists");
  }));

  it("keeps an existing chat on a hidden model", () => inGatewayUser(async user => {
    const context = await user.getExternalMessageChatContext(HIDDEN_ID);
    expect(context.aiModel?.profile.id).toBe(HIDDEN_ID);
  }));

  it("starts a new conversation on the first offered model when the preference is hidden",
      () => inGatewayUser(async user => {
    await user.setPreferredModel(HIDDEN_ID);
    const [first] = await user.listModels();
    expect(first.id).not.toBe(HIDDEN_ID);
    const context = await user.getExternalMessageChatContext(null);
    expect(context.aiModel?.profile.id).toBe(first.id);
  }));

  it("refuses a built-in model's ID, suggesting another", () => inGatewayUser(async user => {
    await expect(user.addModel({ ...PROFILE, id: ENABLED_ID },
        { ...CONFIG, provider: "anthropic", model: ENABLED_ID }))
        .rejects.toThrow(new Error(`A model with ID "${ENABLED_ID}" already exists: choose ` +
            "another ID for your own version."));
  }));

  it("keeps the user's own version of a built-in model under its own ID",
      () => inGatewayUser(async user => {
    const variant = { type: "agent" as const, id: "opus-1m", name: "Opus 1M" };
    const config: AiModelConfig = {
      provider: "anthropic", model: ENABLED_ID, apiToken: "",
      reasoning: "high", compactionInputBudget: 900000,
    };
    await user.addModel(variant, config);
    const listed = await listedIds(user);
    expect(listed).toContain(ENABLED_ID);
    expect(listed.at(-1)).toBe(variant.id);

    expect((await user.getChatContext(variant.id)).aiModel)
        .toStrictEqual({ profile: variant, config });
    const builtIn = (await user.getChatContext(ENABLED_ID)).aiModel!;
    expect(builtIn.profile.name).toBe("Claude Opus 5.5");
    expect(builtIn.config.compactionInputBudget).toBeUndefined();
    expect(builtIn.config.reasoning).toBeUndefined();
  }));

  it("gives a model the user added the deployment's default reasoning level unless it sets its own",
      () => inGatewayUser(async user => {
    expect((await user.getChatContext(ENABLED_ID)).aiModel?.config.reasoning).toBe("high");
    const own = { ...CONFIG, provider: "anthropic" as const, model: "claude-mine" };
    await user.addModel(PROFILE, own);
    expect((await user.getChatContext(PROFILE.id)).aiModel?.config)
        .toStrictEqual({ ...own, reasoning: "high" });
    // The default is applied as the model runs, not stored with it.
    expect(storedModel(user, PROFILE.id)).toStrictEqual({ profile: PROFILE, config: own });
    expect((await user.getModelConfig(PROFILE.id)).config.reasoning).toBeUndefined();

    const low = { ...PROFILE, id: "low" };
    await user.addModel(low, { ...own, reasoning: "low" });
    expect((await user.getChatContext(low.id)).aiModel?.config.reasoning).toBe("low");
  }, { defaultReasoning: "high" }));

  describe("providers", () => {
    // An OpenAI model, on a deployment whose environment enables anthropic alone.
    const OTHER = { ...PROFILE, id: "other" };
    const OTHER_CONFIG = { ...CONFIG, model: "other" };

    it("accepts a model under a provider an admin turned on", () => inGatewayUser(async user => {
      await user.addModel(PROFILE, CONFIG);
      expect(storedModel(user, PROFILE.id)).toEqual({ profile: PROFILE, config: CONFIG });
      await user.updateModel({ ...PROFILE, name: "Renamed" }, CONFIG);
      expect(storedModel(user, PROFILE.id)).toMatchObject({ profile: { name: "Renamed" } });
      expect((await user.getChatContext(PROFILE.id)).aiModel?.config).toEqual(CONFIG);
    }, { addedProviders: ["openai"] }));

    it("refuses a model under a provider that neither the environment nor an admin enables",
        () => inGatewayUser(async user => {
      await expect(user.addModel(PROFILE, CONFIG)).rejects.toThrow(providerUnavailable("openai"));
      expect(storedModel(user, PROFILE.id)).toBeUndefined();
      // An admin's listing of a provider AI Gateway does not serve enables nothing.
      const ollama = { provider: "ollama" as const, model: "llama", apiToken: "" };
      await expect(user.addModel(PROFILE, ollama)).rejects.toThrow(providerUnavailable("ollama"));
    }, { addedProviders: ["google", "ollama"] }));

    // As when a provider leaves CF_AI_GATEWAY_PROVIDERS: the model stays and runs, uneditable.
    it("keeps a model whose provider an admin turned off again", () => {
      const admin: Partial<AdminConfig> = { addedProviders: ["openai"] };
      return inGatewayUser(async user => {
        await user.addModel(PROFILE, CONFIG);
        admin.addedProviders = [];
        expect(await listedIds(user)).toContain(PROFILE.id);
        expect((await user.getChatContext(PROFILE.id)).aiModel?.config).toEqual(CONFIG);
        await expect(user.updateModel({ ...PROFILE, name: "Renamed" }, CONFIG))
            .rejects.toThrow(providerUnavailable("openai"));
        await expect(user.addModel(OTHER, OTHER_CONFIG))
            .rejects.toThrow(providerUnavailable("openai"));
      }, admin);
    });
  });

  it("stops listing a model the admin hid, which still resolves", () => inGatewayUser(async user => {
    expect(await listedIds(user)).not.toContain(ENABLED_ID);
    expect((await user.getChatContext(ENABLED_ID)).aiModel?.profile.id).toBe(ENABLED_ID);
    await user.setPreferredModel(ENABLED_ID);
    expect(await user.getPreferredModel()).toBe(ENABLED_ID);
  }, { modelModes: { [ENABLED_ID]: "hidden" } }));

  it("lists a superseded model the admin enabled", () => inGatewayUser(async user => {
    expect(await listedIds(user)).toContain(HIDDEN_ID);
    await user.setPreferredModel(HIDDEN_ID);
    const context = await user.getExternalMessageChatContext(null);
    expect(context.aiModel?.profile.id).toBe(HIDDEN_ID);
  }, { modelModes: { [HIDDEN_ID]: "enabled" } }));

  it("refuses a disabled model with the administrator's message", () => inGatewayUser(async user => {
    expect(await listedIds(user)).not.toContain(ENABLED_ID);
    await expect(user.getChatContext(ENABLED_ID)).rejects.toThrow(new Error(DISABLED_MESSAGE));
    await expect(user.setPreferredModel(ENABLED_ID)).rejects.toThrow(`No such model: ${ENABLED_ID}`);
    expect(await user.getPreferredModel()).toBeNull();
    await expect(user.addModel({ ...PROFILE, id: ENABLED_ID }, { ...CONFIG, model: ENABLED_ID }))
        .rejects.toThrow("already exists");
    // A model that is merely unknown is still reported as such.
    await expect(user.getChatContext("nope")).rejects.toThrow(new Error("No such model: nope"));
  }, DISABLED));

  // The ID stays reserved, or the stored model would take the disabled one's place in every
  // chat, spawner and preference that names it.
  it("keeps a stored model sharing a disabled model's ID out of reach", () => inGatewayUser(async user => {
    storeModel(user, ENABLED_ID);
    expect(await listedIds(user)).not.toContain(ENABLED_ID);
    await expect(user.getChatContext(ENABLED_ID)).rejects.toThrow(new Error(DISABLED_MESSAGE));
    await expect(user.setPreferredModel(ENABLED_ID)).rejects.toThrow("No such model");
    await expect(user.getModelConfig(ENABLED_ID)).rejects.toThrow("No such hand-added model");
    await expect(user.updateModel({ ...PROFILE, id: ENABLED_ID },
        { ...CONFIG, provider: "anthropic", model: ENABLED_ID }))
        .rejects.toThrow("No such hand-added model");
    await expect(user.addModel({ ...PROFILE, id: "clone" }, { ...CONFIG, apiToken: null }, ENABLED_ID))
        .rejects.toThrow("No such hand-added model");
  }, DISABLED));

  it("refuses to delete a gateway model in any mode, naming it", () => inGatewayUser(async user => {
    storeModel(user, "claude-test");
    await expect(user.deleteModel("claude-test"))
        .rejects.toThrow(new Error('Cannot delete built-in model "Claude Test".'));
    await expect(user.deleteModel(ENABLED_ID))
        .rejects.toThrow(new Error('Cannot delete built-in model "Claude Opus 5.5".'));
    const stored = (user as unknown as { storage: { aiModels: { get(id: string): unknown } } })
        .storage.aiModels.get("claude-test");
    expect(stored).toMatchObject({ profile: { name: "Stale" } });
  }, {
    addedModels: [
      { provider: "anthropic", id: "claude-test", name: "Claude Test", contextWindow: 500000 },
    ],
    modelModes: { [ENABLED_ID]: "disabled", "claude-test": "hidden" },
  }));

  it("moves an existing chat off a disabled model", () => inGatewayUser(async user => {
    const [first] = await user.listModels();
    expect(first.id).not.toBe(ENABLED_ID);
    expect((await user.getExternalMessageChatContext(ENABLED_ID)).aiModel?.profile.id)
        .toBe(first.id);

    await user.setPreferredModel("claude-haiku-4-5");
    expect((await user.getExternalMessageChatContext(ENABLED_ID)).aiModel?.profile.id)
        .toBe("claude-haiku-4-5");
  }, DISABLED));

  describe("once users may not add their own models", () => {
    const MINE = { ...PROFILE, id: "mine", name: "Mine" };
    const MINE_CONFIG: AiModelConfig = { ...CONFIG, provider: "anthropic", model: "mine" };
    const ADDING_REFUSED =
        "Adding your own models is disabled on this deployment by an administrator.";
    const MINE_REFUSED = 'The "Mine" model can\'t be used: adding your own models is disabled ' +
        "on this deployment by an administrator.";

    // Runs `f` for a user who added MINE and made it their preference while users still could.
    // `admin` is the deployment's admin config, which `f` may change as an admin would.
    function withStoredModel(
        f: (user: UserDurableObject, admin: Partial<AdminConfig>, offered: string[]) =>
            Promise<void>,
        config: Partial<AdminConfig> = {}) {
      const admin: Partial<AdminConfig> = { ...config };
      return inGatewayUser(async user => {
        const offered = await listedIds(user);
        await user.addModel(MINE, MINE_CONFIG);
        await user.setPreferredModel(MINE.id);
        expect(await listedIds(user)).toEqual([...offered, MINE.id]);
        admin.userModelsEnabled = false;
        await f(user, admin, offered);
      }, admin);
    }

    it("neither lists nor resolves a stored model",
        () => withStoredModel(async (user, _, offered) => {
      expect(await listedIds(user)).toEqual(offered);
      await expect(user.getChatContext(MINE.id)).rejects.toThrow(new Error(MINE_REFUSED));
      await expect(user.setPreferredModel(MINE.id)).rejects.toThrow(`No such model: ${MINE.id}`);
      // An ID that names nothing is still reported as such.
      await expect(user.getChatContext("nope")).rejects.toThrow(new Error("No such model: nope"));
    }));

    it("refuses to add or edit a model, whatever else is wrong with the request",
        () => withStoredModel(async user => {
      const refused = new Error(ADDING_REFUSED);
      const other = { ...MINE, id: "other" };
      const otherConfig = { ...MINE_CONFIG, model: "other" };
      await expect(user.addModel(other, otherConfig)).rejects.toThrow(refused);
      await expect(user.addModel(other, otherConfig, "nope")).rejects.toThrow(refused);
      await expect(user.addModel(MINE, MINE_CONFIG)).rejects.toThrow(refused);
      await expect(user.addModel({ ...MINE, id: ENABLED_ID }, MINE_CONFIG))
          .rejects.toThrow(refused);
      expect(storedModel(user, "other")).toBeUndefined();

      await expect(user.updateModel({ ...MINE, name: "Renamed" }, MINE_CONFIG))
          .rejects.toThrow(refused);
      await expect(user.updateModel(MINE, { ...MINE_CONFIG, model: "changed" }))
          .rejects.toThrow(refused);
      await expect(user.updateModel(other, MINE_CONFIG)).rejects.toThrow(refused);
      expect(storedModel(user, MINE.id)).toEqual({ profile: MINE, config: MINE_CONFIG });
    }));

    it("moves a conversation off a stored model",
        () => withStoredModel(async (user, _, offered) => {
      // The preference is the stored model too, so neither an existing chat nor a new one keeps it.
      expect(await user.getPreferredModel()).toBe(MINE.id);
      for (let chatModel of [MINE.id, null]) {
        expect((await user.getExternalMessageChatContext(chatModel)).aiModel?.profile.id)
            .toBe(offered[0]);
      }
    }));

    it("keeps a stored model, which still reads, until its user deletes it",
        () => withStoredModel(async user => {
      expect(storedModel(user, MINE.id)).toEqual({ profile: MINE, config: MINE_CONFIG });
      expect((await user.getModelConfig(MINE.id)).profile).toEqual(MINE);
      await expect(user.deleteModel(ENABLED_ID))
          .rejects.toThrow(new Error('Cannot delete built-in model "Claude Opus 5.5".'));

      await user.deleteModel(MINE.id);
      expect(storedModel(user, MINE.id)).toBeUndefined();
      await expect(user.getChatContext(MINE.id))
          .rejects.toThrow(new Error(`No such model: ${MINE.id}`));
    }));

    it("restores a stored model as it was once users may again",
        () => withStoredModel(async (user, admin, offered) => {
      await expect(user.getChatContext(MINE.id)).rejects.toThrow(new Error(MINE_REFUSED));
      admin.userModelsEnabled = true;
      expect(await listedIds(user)).toEqual([...offered, MINE.id]);
      expect((await user.getChatContext(MINE.id)).aiModel)
          .toEqual({ profile: MINE, config: MINE_CONFIG });
      expect(await user.getPreferredModel()).toBe(MINE.id);
      expect((await user.getExternalMessageChatContext(null)).aiModel?.profile).toEqual(MINE);
      await user.updateModel({ ...MINE, name: "Renamed" }, MINE_CONFIG);
      expect(storedModel(user, MINE.id)).toMatchObject({ profile: { name: "Renamed" } });
    }));

    it("leaves the gateway's models as they are",
        () => withStoredModel(async (user, _, offered) => {
      expect(await listedIds(user)).toEqual(offered);
      expect(offered).not.toContain(HIDDEN_ID);
      expect((await user.getChatContext(HIDDEN_ID)).aiModel?.profile.id).toBe(HIDDEN_ID);
      await user.setPreferredModel(HIDDEN_ID);
      expect((await user.getExternalMessageChatContext(HIDDEN_ID)).aiModel?.profile.id)
          .toBe(HIDDEN_ID);

      // A stored model that a gateway model shadows gets that model's answer, not its own.
      storeModel(user, ENABLED_ID);
      storeModel(user, "claude-haiku-4-5");
      await expect(user.getChatContext(ENABLED_ID)).rejects.toThrow(new Error(DISABLED_MESSAGE));
      expect((await user.getChatContext("claude-haiku-4-5")).aiModel?.profile.name)
          .toBe("Claude Haiku 4.5");
    }, DISABLED));
  });

  // Chats, spawners and the external-message default all take the language models, which no
  // decision model can serve.
  it("lists decision models apart from language models", () => inGatewayUser(async user => {
    await user.addModel({ ...PROFILE, id: "my-clef" },
        { provider: "cloudflare", model: "@cf/cloudflare/clef", apiToken: "" });

    const decisionIds = ["@cf/cloudflare/clef", "@cf/cloudflare/clef-flash", "my-clef"];
    expect((await user.listModels("decision")).map(model => model.id)).toEqual(decisionIds);
    const languageIds = await listedIds(user);
    expect(languageIds).toContain("@cf/zai-org/glm-5.2");
    expect(languageIds.filter(id => decisionIds.includes(id))).toEqual([]);
  }, { addedProviders: ["cloudflare"] }));
});

describe("describing and testing a model a user describes", () => {
  const OPUS = "claude-opus-5-5";
  const GATEWAY_VARS = {
    CF_AI_GATEWAY: "platform-gateway",
    CF_AI_GATEWAY_ACCOUNT_ID: "account-id",
    CF_AI_GATEWAY_API_TOKEN: "gateway-token",
    CF_AI_GATEWAY_PROVIDERS: "anthropic",
  };
  const NOT_GATEWAY = "This deployment does not provide models through AI Gateway.";
  const VARIANT: RedactedAiModelConfig = {
    provider: "anthropic", model: OPUS, apiToken: null, compactionInputBudget: 900000,
  };

  // "OK", as Anthropic's API streams it.
  const answered = () => new Response([
    { type: "message_start", message: {
      id: "message", type: "message", role: "assistant", model: "claude", content: [],
      stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 },
    } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "OK" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 1 } },
    { type: "message_stop" },
  ].map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
      { headers: { "content-type": "text/event-stream" } });

  /**
   * A gateway deployment with the admin config `config`, whose Workers AI binding answers each
   * request with `respond` and records the effort it asked for. `vars` adds to its environment.
   */
  function deployment(config: Partial<AdminConfig> = {}, vars: object = {},
                      respond: (request: Request) => Response = answered) {
    // What each request asked for, as JSON: the kind of thinking and the effort.
    const efforts: string[] = [];
    const fetch = vi.fn(async (input: Request | string | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const body = await request.clone().json() as {
        messages?: { output_config?: { effort: string } }[], output_config?: { effort: string },
        thinking?: { type: string },
      };
      efforts.push(JSON.stringify({
        thinking: body.thinking?.type,
        effort: body.messages?.at(-1)?.output_config?.effort ?? body.output_config?.effort,
      }));
      return respond(request);
    });
    const gatewayEnv =
        { ...env, ...GATEWAY_VARS, WORKERS_AI: { fetch }, ...vars } as unknown as Cloudflare.Env;
    const models = new GatewayModels(
        new AiGatewayConfig(gatewayEnv), { ...DEFAULT_ADMIN_CONFIG, ...config });
    const user = env.TEST_USER.getByName(`user-models-${++userCounter}`);
    const test = async (described: RedactedAiModelConfig) => {
      const logged = vi.spyOn(console, "info").mockImplementation(() => {});
      try {
        const result = await testUserModel(gatewayEnv, models, described, "user@example.com", user);
        const entries = logged.mock.calls.map(([entry]) => entry as Record<string, unknown>)
            .filter(entry => entry?.event === "user.model.test");
        return { result, entries };
      } finally {
        logged.mockRestore();
      }
    };
    return { models, fetch, efforts, test };
  }

  it("describes a model by its upstream ID, whatever budget and level it sets", () => {
    const { models } = deployment();
    const described = describeUserModel(models, { ...VARIANT, reasoning: "low" });
    expect(described).toStrictEqual(describeUserModel(models,
        { provider: "anthropic", model: OPUS, apiToken: "" }));
    expect(described).toMatchObject({
      builtInCompactionInputBudget: expect.any(Number), maxCompactionInputBudget: 1000000,
      runtimeKnown: true,
    });
    expect(described.reasoningLevels).toContain("high");
    // A model the runtime does not know takes the levels stated for it.
    expect(describeUserModel(models, {
      provider: "anthropic", model: "claude-unknown", apiToken: "",
      capabilities: { reasoningLevels: ["off", "high"] },
    })).toMatchObject({ runtimeKnown: false, reasoningLevels: ["off", "high"] });
  });

  it("refuses to describe or test outside AI Gateway mode, or a model adding would refuse",
      async () => {
    const { models, test, fetch } = deployment();
    const user = env.TEST_USER.getByName(`user-models-${++userCounter}`);
    expect(() => describeUserModel(null, VARIANT)).toThrow(new Error(NOT_GATEWAY));
    await expect(testUserModel(env, null, VARIANT, "user@example.com", user))
        .rejects.toThrow(new Error(NOT_GATEWAY));

    const tooLarge = { ...VARIANT, compactionInputBudget: 1000001 };
    expect(() => describeUserModel(models, tooLarge)).toThrow("from 1 to 1000000");
    await expect(test(tooLarge)).rejects.toThrow("from 1 to 1000000");
    const openai = { ...VARIANT, provider: "openai" as const, model: "gpt-6-sol" };
    expect(() => describeUserModel(models, openai)).toThrow(providerUnavailable("openai"));
    await expect(test(openai)).rejects.toThrow(providerUnavailable("openai"));
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses to test once users may not add their own models", async () => {
    const { test, fetch } = deployment({ userModelsEnabled: false });
    await expect(test(VARIANT)).rejects.toThrow(
        "Adding your own models is disabled on this deployment by an administrator.");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("tests a model as its chats would ask it, then at each of its levels, as the user",
      async () => {
    const { test, models, fetch, efforts } = deployment({ defaultReasoning: "low" });
    const { reasoningLevels } = describeUserModel(models, VARIANT);
    const { result, entries } = await test(VARIANT);
    expect(result).toStrictEqual([null, ...reasoningLevels].map(
        reasoning => ({ model: OPUS, ok: true, reasoning })));
    expect(fetch).toHaveBeenCalledTimes(reasoningLevels.length + 1);
    // With no level of its own, the model is asked for the deployment's default, as it would be
    // had it set that level itself.
    const own = deployment();
    await own.test({ ...VARIANT, reasoning: "low" });
    expect(efforts.toSorted()).toEqual(own.efforts.toSorted());
    const builtIn = deployment();
    await builtIn.test(VARIANT);
    expect(efforts.toSorted()).not.toEqual(builtIn.efforts.toSorted());
    const [input, init] = fetch.mock.calls[0]!;
    expect(JSON.parse(new Request(input, init).headers.get("cf-aig-metadata")!))
        .toStrictEqual({ user: "user@example.com" });
    expect(entries).toHaveLength(reasoningLevels.length + 1);
    expect(entries[0]).toEqual({
      component: "workshop.user.models", event: "user.model.test",
      message: "tested a model a user described", modelId: OPUS, outcome: "ok",
      durationMs: expect.any(Number),
    });
  });

  it("counts a test against the user's usage, and refuses one the usage does not allow",
      async () => {
    const { test, fetch } = deployment({}, {
      ENABLE_CLOUDFLARE_LIMITS: "true", DAILY_LLM_CALL_LIMIT: "1",
    });
    await test(VARIANT);
    const sent = fetch.mock.calls.length;
    await expect(test(VARIANT)).rejects.toThrow(
        "Free usage limit reached. Connect your Cloudflare account to continue.");
    expect(fetch).toHaveBeenCalledTimes(sent);
  });

  it("reports a request that fails as the result of its level", async () => {
    const { test } = deployment({}, {}, () => new Response("Overloaded", { status: 529 }));
    const { result } = await test({ ...VARIANT, capabilities: { reasoningLevels: ["high"] } });
    expect(result[0]).toMatchObject({ model: OPUS, ok: false, reasoning: null });
  });
});
