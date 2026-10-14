// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as Kumo from "@cloudflare/kumo";
import type {
  ChatModelDescription,
  ChatModelSettings,
  ChatPreset,
} from "@gadgets/workshop-shared/api";
import type { ChatModelDescriptionState } from "./useChatModelDescription";
import type { ChatPresetsState } from "./useChatPresets";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type ToastOptions = {
  title?: string;
  description?: string;
  actions?: { children: string; onClick: () => void }[];
};

const toasts = vi.hoisted(() => ({
  add: vi.fn<(options: ToastOptions) => string>(() => "toast"),
  close: vi.fn<(id?: string) => void>(),
}));

vi.mock("@cloudflare/kumo", async (importOriginal) => ({
  ...await importOriginal<typeof Kumo>(),
  useKumoToastManager: () => toasts,
}));

import { ComposerChatSettings } from "./ComposerChatSettings";

// A gateway model with three levels, whose window has room for a budget of 900K.
const MODEL: ChatModelDescription = {
  reasoningLevels: ["low", "medium", "high"],
  builtInReasoning: "adaptive",
  builtInCompactionInputBudget: 200_000,
  maxCompactionInputBudget: 900_000,
  runtimeKnown: true,
  reasoning: "medium",
  compactionInputBudget: 200_000,
};

const DEEP: ChatPreset = { id: "deep", name: "Deep work", settings: { reasoning: "high" } };
const LONG: ChatPreset = { id: "long", name: "Long reads", settings: { compactionInputBudget: 800_000 } };

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  document.body.innerHTML = "";
  toasts.add.mockClear();
  toasts.close.mockClear();
});

type Options = {
  settings?: ChatModelSettings;
  presets?: ChatPreset[] | null;
  presetsFailed?: boolean;
  description?: Omit<ChatModelDescriptionState, "retry">;
  save?: ChatPresetsState["save"];
};

// The composer's settings as a parent holds them: the settings it is given are what it last
// reported, and the presets are what the user last saved.
function renderSettings({
  settings: initialSettings = {},
  presets: initialPresets = [],
  presetsFailed = false,
  description = { description: MODEL, failed: false },
  save: saveOverride,
}: Options = {}) {
  const onSettingsChange = vi.fn<(settings: ChatModelSettings) => void>();
  const save = vi.fn<ChatPresetsState["save"]>();
  const remove = vi.fn<ChatPresetsState["remove"]>();
  const onIntent = vi.fn<() => void>();
  const retryPresets = vi.fn<() => void>();
  const retryDescription = vi.fn<() => void>();
  const Harness = () => {
    const [settings, setSettings] = useState(initialSettings);
    const [list, setList] = useState(initialPresets);
    save.mockImplementation(async (preset) => {
      setList((presets) => [...(presets ?? []).filter(({ id }) => id !== preset.id), preset]
        .toSorted((a, b) => a.name.localeCompare(b.name)));
      return saveOverride?.(preset);
    });
    remove.mockImplementation(async (id) => {
      setList((presets) => (presets ?? []).filter((preset) => preset.id !== id));
    });
    return (
      <ComposerChatSettings
        settings={settings}
        onSettingsChange={(next) => {
          onSettingsChange(next);
          setSettings(next);
        }}
        description={{ ...description, retry: retryDescription }}
        presets={{ list, failed: presetsFailed, save, remove, retry: retryPresets }}
        onIntent={onIntent}
      />
    );
  };
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root!.render(<Harness />));
  return { onSettingsChange, save, remove, onIntent, retryPresets, retryDescription };
}

const trigger = () => {
  const element = document.querySelector<HTMLButtonElement>('button[aria-label^="Model settings"]');
  if (!element) throw new Error("No settings trigger");
  return element;
};

const open = async () => {
  await act(async () => { trigger().click(); });
  if (!document.querySelector('[role="dialog"]')) throw new Error("The settings did not open");
};

const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');

const findButton = (name: string) =>
  Array.from(document.body.querySelectorAll<HTMLElement>('button, [role="menuitem"]'))
    .find((b) => (b.getAttribute("aria-label") ?? b.textContent?.trim()) === name);

const button = (name: string) => {
  const element = findButton(name);
  if (!element) throw new Error(`No button ${name}`);
  return element;
};

const radios = () => Array.from(document.querySelectorAll<HTMLElement>('[role="radio"]'));
const radio = (name: string) => {
  const element = radios().find((r) => r.querySelector("span span")?.textContent === name);
  if (!element) throw new Error(`No preset ${name}`);
  return element;
};
const checkedName = () =>
  radios().find((r) => r.getAttribute("aria-checked") === "true")?.querySelector("span span")?.textContent;

const click = (element: HTMLElement) => act(async () => { element.click(); });

const key = (element: HTMLElement, name: string) => act(async () => {
  element.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }));
});

// As typing reports itself.
const type = (element: HTMLInputElement, value: string) => act(() => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(element, value);
  element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
});

const field = (label: string) => {
  const byLabel = Array.from(document.body.querySelectorAll("label"))
    .find((element) => element.textContent === label);
  const element = byLabel
    ? document.getElementById(byLabel.htmlFor)
    : document.querySelector(`input[aria-label="${label}"]`);
  if (!(element instanceof HTMLInputElement)) throw new Error(`No field ${label}`);
  return element;
};

const describedBy = (element: HTMLElement) =>
  (element.getAttribute("aria-describedby") ?? "").split(" ")
    .map((id) => document.getElementById(id)?.textContent ?? "").join(" ");

// Opens a preset's menu and picks `item` from it, by keyboard: the item turns Enter into a click
// it builds as a PointerEvent, which jsdom lacks, so the window has a stand-in meanwhile.
const chooseFromMenu = async (presetName: string, item: string) => {
  await click(button(`Options for ${presetName}`));
  const element = button(item);
  const view: { PointerEvent?: typeof MouseEvent } = window;
  view.PointerEvent = MouseEvent;
  try {
    await act(async () => { element.focus(); });
    await key(element, "Enter");
  } finally {
    delete view.PointerEvent;
  }
};

describe("ComposerChatSettings", () => {
  describe("the trigger", () => {
    it("is only an icon, named for what it opens, while nothing is set", () => {
      renderSettings({ presets: [DEEP] });
      expect(trigger().getAttribute("aria-label")).toBe("Model settings");
      expect(trigger().textContent).toBe("");
    });

    it("names the preset the settings match", () => {
      renderSettings({ settings: { reasoning: "high" }, presets: [DEEP, LONG] });
      expect(trigger().getAttribute("aria-label")).toBe("Model settings: Deep work");
      expect(trigger().textContent).toBe("Deep work");
    });

    it("says Custom for settings no preset has", () => {
      renderSettings({ settings: { reasoning: "low" }, presets: [DEEP] });
      expect(trigger().getAttribute("aria-label")).toBe("Model settings: Custom");
    });

    // Until then it can't tell a preset's settings from Custom ones, but still shows they are set.
    it("names no preset, but says settings are set, while the presets load", () => {
      renderSettings({ settings: { reasoning: "high" }, presets: null });
      expect(trigger().getAttribute("aria-label")).toBe("Model settings (set)");
      expect(trigger().textContent).toBe("");
    });

    it("names nothing while nothing is set and the presets load", () => {
      renderSettings({ presets: null });
      expect(trigger().getAttribute("aria-label")).toBe("Model settings");
    });

    it("asks again, once opened, for presets and a description that failed to load", async () => {
      const { retryPresets, retryDescription } = renderSettings({
        presets: null,
        presetsFailed: true,
        description: { description: null, failed: true },
      });
      expect(retryPresets).not.toHaveBeenCalled();
      await open();
      expect(retryPresets).toHaveBeenCalledOnce();
      expect(retryDescription).toHaveBeenCalledOnce();
    });

    it("asks for what the settings show once focused, before they open", async () => {
      const { onIntent } = renderSettings();
      await act(async () => { trigger().focus(); });
      expect(onIntent).toHaveBeenCalled();
      expect(dialog()).toBeNull();
    });
  });

  describe("with no presets", () => {
    it("offers only the suggestions, introduced, and applies nothing", async () => {
      const { onSettingsChange } = renderSettings();
      await open();
      expect(dialog()!.textContent).toContain(
        "Presets apply a reasoning level and compaction budget to a conversation in one click.");
      expect(radios()).toHaveLength(0);
      const adds = Array.from(dialog()!.querySelectorAll("button"))
        .map((b) => b.getAttribute("aria-label")).filter((name) => name?.startsWith("Add "));
      expect(adds).toEqual(["Add Long context", "Add Deep thinking", "Add Quick"]);
      expect(dialog()!.textContent).toContain("Compacts at ~765K");
      expect(onSettingsChange).not.toHaveBeenCalled();
    });

    it("adds a suggestion without applying it", async () => {
      const { onSettingsChange, save } = renderSettings();
      await open();
      await click(button("Add Deep thinking"));
      expect(save).toHaveBeenCalledWith(
        { id: expect.any(String), name: "Deep thinking", settings: { reasoning: "high" } });
      expect(radios().map((r) => r.getAttribute("aria-checked"))).toEqual(["false"]);
      expect(document.activeElement).toBe(radio("Deep thinking"));
      expect(findButton("Add Deep thinking")).toBeUndefined();
      expect(onSettingsChange).not.toHaveBeenCalled();
    });
  });

  describe("the presets", () => {
    it("apply exactly their settings when picked", async () => {
      const { onSettingsChange } = renderSettings({
        settings: { reasoning: "low", compactionInputBudget: 5000 },
        presets: [DEEP, LONG],
      });
      await open();
      expect(checkedName()).toBeUndefined();
      await click(radio("Long reads"));
      expect(onSettingsChange).toHaveBeenCalledExactlyOnceWith({ compactionInputBudget: 800_000 });
      expect(checkedName()).toBe("Long reads");
      expect(trigger().getAttribute("aria-label")).toBe("Model settings: Long reads");
    });

    it("check the one picked among several with the same settings, which the trigger names", async () => {
      const twin: ChatPreset = { id: "twin", name: "Thorough", settings: DEEP.settings };
      const { onSettingsChange } = renderSettings({ settings: { reasoning: "high" }, presets: [DEEP, twin] });
      await open();
      expect(checkedName()).toBe("Deep work");
      await click(radio("Thorough"));
      expect(checkedName()).toBe("Thorough");
      expect(trigger().getAttribute("aria-label")).toBe("Model settings: Thorough");
      await click(radio("Deep work"));
      expect(checkedName()).toBe("Deep work");
      expect(onSettingsChange).not.toHaveBeenCalled();
    });

    it("are summarized for the model, with the budget capped at its maximum", async () => {
      renderSettings({
        presets: [{ id: "x", name: "Huge", settings: { reasoning: "high", compactionInputBudget: 2_000_000 } }],
      });
      await open();
      expect(describedBy(radio("Huge"))).toBe("High reasoning · compacts at ~765K");
    });

    it("are a radio group the arrow keys move through, checking as they go", async () => {
      const third: ChatPreset = { id: "quick", name: "Quick look", settings: { reasoning: "low" } };
      const { onSettingsChange } = renderSettings({ settings: { reasoning: "high" }, presets: [DEEP, LONG, third] });
      await open();
      expect(radios().map((r) => r.tabIndex)).toEqual([0, -1, -1]);
      await key(radio("Deep work"), "ArrowDown");
      expect(checkedName()).toBe("Long reads");
      expect(document.activeElement).toBe(radio("Long reads"));
      await key(radio("Long reads"), "ArrowUp");
      await key(radio("Deep work"), "ArrowUp");
      expect(checkedName()).toBe("Quick look");
      expect(radios().map((r) => r.tabIndex)).toEqual([-1, -1, 0]);
      expect(onSettingsChange.mock.calls).toEqual([
        [{ compactionInputBudget: 800_000 }], [{ reasoning: "high" }], [{ reasoning: "low" }],
      ]);
    });

    it("are renamed in place, Enter saving the trimmed name", async () => {
      const { save } = renderSettings({ presets: [DEEP] });
      await open();
      await chooseFromMenu("Deep work", "Rename");
      const name = field("Name of Deep work");
      expect(document.activeElement).toBe(name);
      await type(name, "  Thorough  ");
      await key(name, "Enter");
      expect(save).toHaveBeenCalledExactlyOnceWith({ ...DEEP, name: "Thorough" });
      expect(document.activeElement).toBe(radio("Thorough"));
    });

    it("keep their name when a rename is cancelled with Escape, the settings staying open", async () => {
      const { save } = renderSettings({ presets: [DEEP] });
      await open();
      await chooseFromMenu("Deep work", "Rename");
      const name = field("Name of Deep work");
      await type(name, "Other");
      await key(name, "Escape");
      expect(save).not.toHaveBeenCalled();
      expect(dialog()).not.toBeNull();
      expect(document.activeElement).toBe(radio("Deep work"));
    });

    it("are updated with the chat's settings only when those differ", async () => {
      const { save } = renderSettings({ settings: { reasoning: "low" }, presets: [DEEP] });
      await open();
      await chooseFromMenu("Deep work", "Update with current settings");
      expect(save).toHaveBeenCalledExactlyOnceWith({ ...DEEP, settings: { reasoning: "low" } });
      await click(button("Options for Deep work"));
      expect(findButton("Update with current settings")).toBeUndefined();
    });

    it("are deleted at once, and Undo saves the preset back", async () => {
      const { remove, save } = renderSettings({ presets: [DEEP, LONG] });
      await open();
      await chooseFromMenu("Deep work", "Delete");
      expect(remove).toHaveBeenCalledExactlyOnceWith("deep");
      expect(radios().map((r) => r.querySelector("span span")?.textContent)).toEqual(["Long reads"]);
      expect(document.activeElement).toBe(radio("Long reads"));
      const toast = toasts.add.mock.calls.at(-1)![0];
      expect(toast.title).toBe("Deleted “Deep work”");
      const undo = toast.actions?.find((action) => action.children === "Undo");
      await act(async () => undo!.onClick());
      expect(save).toHaveBeenCalledExactlyOnceWith(DEEP);
      expect(radios().map((r) => r.querySelector("span span")?.textContent))
        .toEqual(["Deep work", "Long reads"]);
    });

    it("show a stable placeholder while they load", async () => {
      renderSettings({ presets: null });
      await open();
      expect(dialog()!.querySelector('[aria-label="Loading presets"]')).not.toBeNull();
      expect(radios()).toHaveLength(0);
      expect(dialog()!.textContent).not.toContain("Suggested presets");
    });
  });

  describe("saving as a preset", () => {
    it("saves the chat's settings under the typed name on Enter", async () => {
      const { save } = renderSettings({ settings: { reasoning: "low", compactionInputBudget: 300_000 }, presets: [DEEP] });
      await open();
      await click(button("Save as preset…"));
      const name = field("Preset name");
      expect(document.activeElement).toBe(name);
      await type(name, "  Skim  ");
      await key(name, "Enter");
      expect(save).toHaveBeenCalledExactlyOnceWith({
        id: expect.any(String),
        name: "Skim",
        settings: { reasoning: "low", compactionInputBudget: 300_000 },
      });
      expect(checkedName()).toBe("Skim");
      expect(document.activeElement).toBe(radio("Skim"));
    });

    it("saves nothing on Escape, and stays open", async () => {
      const { save } = renderSettings({ settings: { reasoning: "low" }, presets: [DEEP] });
      await open();
      await click(button("Save as preset…"));
      const name = field("Preset name");
      await type(name, "Skim");
      await key(name, "Escape");
      expect(save).not.toHaveBeenCalled();
      expect(dialog()).not.toBeNull();
      expect(document.activeElement).toBe(button("Save as preset…"));
    });

    it("is not offered while nothing is set, or while a preset has the settings", async () => {
      renderSettings({ settings: {}, presets: [DEEP] });
      await open();
      expect(findButton("Save as preset…")).toBeUndefined();
      act(() => root!.unmount());
      renderSettings({ settings: { reasoning: "high" }, presets: [DEEP] });
      await open();
      expect(findButton("Save as preset…")).toBeUndefined();
    });

    it("is refused with a note once the user has the most presets", async () => {
      const presets = Array.from({ length: 50 }, (_, index): ChatPreset =>
        ({ id: `p${index}`, name: `Preset ${String(index).padStart(2, "0")}`, settings: { compactionInputBudget: 1000 + index } }));
      renderSettings({ settings: { reasoning: "low" }, presets });
      await open();
      expect(findButton("Save as preset…")).toBeUndefined();
      expect(dialog()!.textContent).toContain("You have 50 presets, the most you can keep.");
    });
  });

  describe("the reasoning level", () => {
    it("names what applies while the chat sets none: the model's level, else its built-in", async () => {
      renderSettings();
      await open();
      expect(button("Reasoning level").textContent).toBe("Model default (Medium)");
      act(() => root!.unmount());
      renderSettings({ description: { description: { ...MODEL, reasoning: null }, failed: false } });
      await open();
      expect(button("Reasoning level").textContent).toBe("Model default (Provider default)");
    });

    it("is set to the level picked, the settings staying open", async () => {
      const { onSettingsChange } = renderSettings({ settings: { compactionInputBudget: 300_000 } });
      await open();
      await click(button("Reasoning level"));
      const options = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]'));
      expect(options.map((option) => option.textContent))
        .toEqual(["Model default (Medium)", "Low", "Medium", "High"]);
      const view: { PointerEvent?: typeof MouseEvent } = window;
      view.PointerEvent = MouseEvent;
      try {
        const high = options.find((option) => option.textContent === "High")!;
        await act(async () => { high.focus(); });
        await key(high, "Enter");
      } finally {
        delete view.PointerEvent;
      }
      expect(onSettingsChange).toHaveBeenCalledExactlyOnceWith(
        { reasoning: "high", compactionInputBudget: 300_000 });
      expect(dialog()).not.toBeNull();
    });

    it("is not offered for a model that takes no levels while the chat sets none", async () => {
      renderSettings({ description: { description: { ...MODEL, reasoningLevels: [] }, failed: false } });
      await open();
      expect(dialog()!.textContent).not.toContain("Reasoning level");
      expect(field("Compaction budget").disabled).toBe(false);
    });
  });

  describe("the compaction budget", () => {
    it("is set on Enter", async () => {
      const { onSettingsChange } = renderSettings({ settings: { reasoning: "high" } });
      await open();
      await type(field("Compaction budget"), "400000");
      await act(async () => { field("Compaction budget").form!.requestSubmit(); });
      expect(onSettingsChange).toHaveBeenCalledExactlyOnceWith(
        { reasoning: "high", compactionInputBudget: 400_000 });
    });

    it("is cleared by an empty field", async () => {
      const { onSettingsChange } = renderSettings({ settings: { compactionInputBudget: 400_000 } });
      await open();
      await type(field("Compaction budget"), "");
      await act(async () => { field("Compaction budget").dispatchEvent(new FocusEvent("focusout", { bubbles: true })); });
      expect(onSettingsChange).toHaveBeenCalledExactlyOnceWith({});
    });

    it("is kept over the model's maximum, and said to be capped", async () => {
      const { onSettingsChange } = renderSettings();
      await open();
      await type(field("Compaction budget"), "2000000");
      expect(describedBy(field("Compaction budget"))).toContain(
        `Capped at ${(900_000).toLocaleString()} tokens for this model.`);
      await act(async () => { field("Compaction budget").form!.requestSubmit(); });
      expect(onSettingsChange).toHaveBeenCalledExactlyOnceWith({ compactionInputBudget: 2_000_000 });
    });

    it("drops a malformed value, and its error, when a preset sets another budget", async () => {
      renderSettings({ presets: [LONG] });
      await open();
      await type(field("Compaction budget"), "1.5");
      expect(field("Compaction budget").getAttribute("aria-invalid")).toBe("true");
      await click(radio("Long reads"));
      expect(field("Compaction budget").value).toBe("800000");
      expect(field("Compaction budget").getAttribute("aria-invalid")).toBe("false");
      expect(dialog()!.textContent).not.toContain("Enter a positive whole number of tokens");
    });

    it("is not set from a malformed value, which shows an error", async () => {
      const { onSettingsChange } = renderSettings();
      await open();
      await type(field("Compaction budget"), "1.5");
      await act(async () => { field("Compaction budget").form!.requestSubmit(); });
      expect(onSettingsChange).not.toHaveBeenCalled();
      expect(field("Compaction budget").getAttribute("aria-invalid")).toBe("true");
      expect(dialog()!.textContent).toContain("Enter a positive whole number of tokens");
    });
  });

  describe("while the model is described", () => {
    it("shows its fields disabled", async () => {
      renderSettings({ settings: { reasoning: "high" }, description: { description: null, failed: false } });
      await open();
      expect(field("Compaction budget").disabled).toBe(true);
      expect(button("Reasoning level").hasAttribute("disabled") ||
        button("Reasoning level").getAttribute("aria-disabled") === "true").toBe(true);
    });

    // The model may take no levels, so a level the chat doesn't set is not offered until then.
    it("holds the reasoning level's place, unseen, while the chat sets no level", async () => {
      renderSettings({ description: { description: null, failed: false } });
      await open();
      const reasoning = Array.from(document.querySelectorAll<HTMLButtonElement>("button"))
        .filter((element) => element.textContent === "Model default");
      expect(reasoning).toHaveLength(1);
      expect(reasoning[0].closest(".invisible")?.closest("[aria-hidden='true']")).toBeInstanceOf(HTMLElement);
    });

    // The settings open upward, so help that grew once described would move their top edge.
    it("holds the budget help's place with the help itself, unseen", async () => {
      renderSettings({ description: { description: null, failed: false } });
      await open();
      const help = field("Compaction budget").closest("form")!
        .querySelector<HTMLElement>("[aria-hidden='true']");
      expect(help?.querySelector(".invisible")?.textContent).toContain("This chat compacts at about");
      // Its numbers are not the model's, so the field is not described by it.
      expect(field("Compaction budget").hasAttribute("aria-describedby")).toBe(false);
    });

    it("says so when the model can't be described, and keeps the presets", async () => {
      const { onSettingsChange } = renderSettings({
        description: { description: null, failed: true },
        presets: [DEEP],
      });
      await open();
      expect(dialog()!.textContent).toContain("Settings aren’t available for this model.");
      expect(dialog()!.textContent).not.toContain("Compaction budget");
      await click(radio("Deep work"));
      expect(onSettingsChange).toHaveBeenCalledWith({ reasoning: "high" });
    });
  });

  it("closes a preset's menu on Escape, and not the settings", async () => {
    renderSettings({ presets: [DEEP] });
    await open();
    await click(button("Options for Deep work"));
    const rename = button("Rename");
    await act(async () => { rename.focus(); });
    await key(rename, "Escape");
    expect(findButton("Rename")).toBeUndefined();
    expect(dialog()).not.toBeNull();
  });

  it("returns focus to the trigger when it closes", async () => {
    renderSettings({ presets: [DEEP] });
    await open();
    await key(radio("Deep work"), "Escape");
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });
});
