// A user's chat presets (see AuthenticatedApi.listChatPresets()), as the user object stores them.

import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import {
  MAX_CHAT_PRESET_NAME_LENGTH, MAX_CHAT_PRESETS, type ChatPreset,
} from "@gadgets/workshop-shared/api";
import type { UserDurableObject } from "../src/user.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_USER: DurableObjectNamespace<UserDurableObject>;
  }
}

type PresetMethods = Pick<UserDurableObject, "listChatPresets" | "saveChatPreset" | "deleteChatPreset">;

let userCounter = 0;
function newUser(): PresetMethods {
  const stub = env.TEST_USER.getByName(`chat-presets-${++userCounter}`);
  // Calls go through runInDurableObject rather than the stub's RPC, whose rejections workerd
  // reports as uncaught exceptions even once the test has handled them.
  const inDo = <T>(f: (user: UserDurableObject) => Promise<T>) => runInDurableObject(stub, f);
  return {
    listChatPresets: () => inDo(u => u.listChatPresets()),
    saveChatPreset: preset => inDo(u => u.saveChatPreset(preset)),
    deleteChatPreset: id => inDo(u => u.deleteChatPreset(id)),
  };
}

const DEEP: ChatPreset = { id: "deep", name: "Deep thinking", settings: { reasoning: "high" } };
const LONG: ChatPreset =
    { id: "long", name: "long context", settings: { compactionInputBudget: 1_000_000 } };

describe("chat presets", () => {
  it("has none until the user adds one", async () => {
    expect(await newUser().listChatPresets()).toEqual([]);
  });

  it("adds, replaces by ID and deletes presets, listing them by name", async () => {
    const user = newUser();
    await user.saveChatPreset(LONG);
    await user.saveChatPreset(DEEP);
    // Names compare case-insensitively, then IDs break the tie.
    const quick: ChatPreset = { id: "a-quick", name: "Deep Thinking", settings: { reasoning: "low" } };
    await user.saveChatPreset(quick);
    expect(await user.listChatPresets()).toStrictEqual([quick, DEEP, LONG]);

    const renamed: ChatPreset = { ...DEEP, name: "Thorough", settings: { reasoning: "max" } };
    await user.saveChatPreset(renamed);
    expect(await user.listChatPresets()).toStrictEqual([quick, LONG, renamed]);

    await user.deleteChatPreset(LONG.id);
    expect(await user.listChatPresets()).toStrictEqual([quick, renamed]);
  });

  it("stores the trimmed name and only the settings that are set", async () => {
    const user = newUser();
    await user.saveChatPreset({
      id: "p", name: "  Quick \n", settings: { reasoning: "low", compactionInputBudget: undefined },
    });
    expect(await user.listChatPresets())
        .toStrictEqual([{ id: "p", name: "Quick", settings: { reasoning: "low" } }]);
  });

  it("refuses a malformed ID, name or budget, storing nothing", async () => {
    const user = newUser();
    const refused: [ChatPreset, string][] = [
      [{ ...DEEP, id: "" }, "ID"],
      [{ ...DEEP, id: "x".repeat(101) }, "ID"],
      [{ ...DEEP, name: "" }, "name"],
      [{ ...DEEP, name: " \t " }, "name"],
      [{ ...DEEP, name: "x".repeat(MAX_CHAT_PRESET_NAME_LENGTH + 1) }, "name"],
      [{ ...DEEP, settings: { compactionInputBudget: 0 } }, "positive whole number"],
      [{ ...DEEP, settings: { compactionInputBudget: 2.5 } }, "positive whole number"],
    ];
    for (const [preset, message] of refused) {
      await expect(user.saveChatPreset(preset)).rejects.toThrow(message);
    }
    expect(await user.listChatPresets()).toEqual([]);

    // The longest ID and name are fine.
    const longest = { ...DEEP, id: "x".repeat(100), name: "y".repeat(MAX_CHAT_PRESET_NAME_LENGTH) };
    await user.saveChatPreset(longest);
    expect(await user.listChatPresets()).toStrictEqual([longest]);
  });

  it("refuses a new preset beyond the limit, but still updates one", async () => {
    const user = newUser();
    for (let i = 0; i < MAX_CHAT_PRESETS; i++) {
      await user.saveChatPreset({ id: `p${i}`, name: `Preset ${i}`, settings: {} });
    }
    await expect(user.saveChatPreset({ id: "extra", name: "Extra", settings: {} }))
        .rejects.toThrow(`at most ${MAX_CHAT_PRESETS}`);

    await user.saveChatPreset({ id: "p0", name: "Updated", settings: { reasoning: "low" } });
    const presets = await user.listChatPresets();
    expect(presets).toHaveLength(MAX_CHAT_PRESETS);
    expect(presets.find(preset => preset.id === "p0"))
        .toStrictEqual({ id: "p0", name: "Updated", settings: { reasoning: "low" } });
    expect(presets.some(preset => preset.id === "extra")).toBe(false);
  });

  it("does nothing when deleting an unknown preset", async () => {
    const user = newUser();
    await user.saveChatPreset(DEEP);
    await user.deleteChatPreset("nope");
    expect(await user.listChatPresets()).toStrictEqual([DEEP]);
  });

  it("keeps each user's presets to that user", async () => {
    const alice = newUser();
    const bob = newUser();
    await alice.saveChatPreset(DEEP);
    expect(await bob.listChatPresets()).toEqual([]);
    expect(await alice.listChatPresets()).toStrictEqual([DEEP]);
  });
});
