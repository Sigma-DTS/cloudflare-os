// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { getStoredChatSettings, persistChatSettings } from "./chatSettingsSelection";

const KEY = "lastChatModelSettings";

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("the last-used chat settings", () => {
  it("come back as they were written", () => {
    persistChatSettings({ reasoning: "high", compactionInputBudget: 300_000 });
    expect(getStoredChatSettings()).toStrictEqual({ reasoning: "high", compactionInputBudget: 300_000 });
  });

  it("are none until some are written, and none again once they are cleared", () => {
    expect(getStoredChatSettings()).toStrictEqual({});
    persistChatSettings({ reasoning: "low" });
    persistChatSettings({});
    expect(localStorage.getItem(KEY)).toBeNull();
    expect(getStoredChatSettings()).toStrictEqual({});
  });

  it("drop what is stored that is not JSON, or not an object", () => {
    localStorage.setItem(KEY, "{not json");
    expect(getStoredChatSettings()).toStrictEqual({});
    localStorage.setItem(KEY, '"high"');
    expect(getStoredChatSettings()).toStrictEqual({});
  });

  it("drop each malformed field and keep the rest", () => {
    localStorage.setItem(KEY, JSON.stringify({ reasoning: "loud", compactionInputBudget: 50_000 }));
    expect(getStoredChatSettings()).toStrictEqual({ compactionInputBudget: 50_000 });
    for (const budget of [0, -5, 1.5, "50000"]) {
      localStorage.setItem(KEY, JSON.stringify({ reasoning: "max", compactionInputBudget: budget }));
      expect(getStoredChatSettings()).toStrictEqual({ reasoning: "max" });
    }
  });

  it("are not written by storage that refuses, without throwing", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("full", "QuotaExceededError");
    });
    expect(() => persistChatSettings({ reasoning: "low" })).not.toThrow();
    expect(getStoredChatSettings()).toStrictEqual({});
  });
});
