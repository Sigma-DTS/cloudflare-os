import { describe, expect, it } from "vitest";
import type { ChatModelDescription, ChatPreset } from "@gadgets/workshop-shared/api";
import {
  approximateTokens,
  chatSettingsSummary,
  compactsAtLabel,
  matchingChatPreset,
  sameChatSettings,
  sortChatPresets,
  suggestionsToOffer,
  withChatSetting,
} from "./chatPresets";

const MODEL: ChatModelDescription = {
  reasoningLevels: ["low", "medium", "high"],
  builtInReasoning: "medium",
  builtInCompactionInputBudget: 200_000,
  maxCompactionInputBudget: 900_000,
  runtimeKnown: true,
  reasoning: null,
  compactionInputBudget: 200_000,
};

const preset = (id: string, name: string, settings: ChatPreset["settings"]): ChatPreset =>
  ({ id, name, settings });

describe("chat settings", () => {
  it("are the same when they set the same fields to the same values", () => {
    expect(sameChatSettings({ reasoning: "high" }, { reasoning: "high" })).toBe(true);
    expect(sameChatSettings({}, { reasoning: undefined })).toBe(true);
    expect(sameChatSettings({ reasoning: "high" }, { reasoning: "high", compactionInputBudget: 5 }))
      .toBe(false);
    expect(sameChatSettings({ compactionInputBudget: 5 }, { compactionInputBudget: 6 })).toBe(false);
  });

  it("keep only the fields a change leaves set", () => {
    const settings = { reasoning: "high" as const, compactionInputBudget: 50_000 };
    expect(withChatSetting(settings, { reasoning: undefined })).toStrictEqual(
      { compactionInputBudget: 50_000 });
    expect(withChatSetting(settings, { compactionInputBudget: 60_000 })).toStrictEqual(
      { reasoning: "high", compactionInputBudget: 60_000 });
    expect(withChatSetting({ reasoning: "low" }, { reasoning: undefined })).toStrictEqual({});
  });
});

describe("matchingChatPreset", () => {
  const presets = [
    preset("a", "Deep", { reasoning: "high" }),
    preset("b", "Long", { compactionInputBudget: 1_000_000 }),
  ];

  it("finds the preset whose settings are the chat's", () => {
    expect(matchingChatPreset(presets, { compactionInputBudget: 1_000_000 })?.id).toBe("b");
  });

  it("finds the preset picked among several with the settings, else the first", () => {
    const twins = [...presets, preset("c", "Thorough", { reasoning: "high" })];
    expect(matchingChatPreset(twins, { reasoning: "high" })?.id).toBe("a");
    expect(matchingChatPreset(twins, { reasoning: "high" }, "c")?.id).toBe("c");
    expect(matchingChatPreset(twins, { reasoning: "high" }, "b")?.id).toBe("a");
  });

  it("finds none for settings no preset has, or for no settings at all", () => {
    expect(matchingChatPreset(presets, { reasoning: "high", compactionInputBudget: 1 })).toBeUndefined();
    expect(matchingChatPreset([...presets, preset("c", "Empty", {})], {})).toBeUndefined();
  });
});

describe("sortChatPresets", () => {
  it("orders by name case-insensitively, then by id", () => {
    const sorted = sortChatPresets([
      preset("2", "beta", {}), preset("3", "Alpha", {}), preset("1", "beta", {}),
    ]);
    expect(sorted.map(({ id }) => id)).toEqual(["3", "1", "2"]);
  });

  it("orders accented names as the server does, by letter rather than by code point", () => {
    const sorted = sortChatPresets([preset("z", "Zeta", {}), preset("e", "Émile", {})]);
    expect(sorted.map(({ id }) => id)).toEqual(["e", "z"]);
  });
});

describe("suggestionsToOffer", () => {
  it("leaves out a suggestion the user has a preset named like", () => {
    const offered = suggestionsToOffer([preset("x", " deep THINKING ", { reasoning: "max" })]);
    expect(offered.map(({ name }) => name)).toEqual(["Long context", "Quick"]);
  });

  it("leaves out a suggestion whose settings a preset of the user's has", () => {
    const offered = suggestionsToOffer([preset("x", "Skim", { reasoning: "low" })]);
    expect(offered.map(({ name }) => name)).toEqual(["Long context", "Deep thinking"]);
  });

  it("offers every suggestion to a user with no presets", () => {
    expect(suggestionsToOffer([]).map(({ name }) => name))
      .toEqual(["Long context", "Deep thinking", "Quick"]);
  });
});

describe("approximateTokens", () => {
  it("rounds to thousands and to tenths of millions", () => {
    expect(approximateTokens(765_000)).toBe("~765K");
    expect(approximateTokens(1_234_567)).toBe("~1.2M");
    expect(approximateTokens(1_000_000)).toBe("~1M");
    expect(approximateTokens(999_700)).toBe("~1M");
    expect(approximateTokens(300)).toBe("~300");
  });
});

describe("chatSettingsSummary", () => {
  it("names the level and when the chat compacts, the budget capped at the model's maximum", () => {
    expect(chatSettingsSummary({ reasoning: "high", compactionInputBudget: 1_000_000 }, MODEL))
      .toBe("High reasoning · compacts at ~765K");
  });

  it("leaves the budget uncapped while the model is not known", () => {
    expect(chatSettingsSummary({ compactionInputBudget: 1_000_000 }, null))
      .toBe("Compacts at ~850K");
  });

  it("words a level that turns reasoning off", () => {
    expect(chatSettingsSummary({ reasoning: "off" }, MODEL)).toBe("Reasoning off");
    expect(chatSettingsSummary({ reasoning: "xhigh" }, MODEL)).toBe("Extra high reasoning");
  });

  it("is the same wording as the composer's context line", () => {
    expect(compactsAtLabel(100_000, MODEL)).toBe("compacts at ~85K");
  });
});
