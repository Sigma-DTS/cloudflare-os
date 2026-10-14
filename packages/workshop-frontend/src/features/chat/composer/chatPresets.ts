import { COMPACTION_TRIGGER_RATIO } from "@gadgets/workshop-shared/api";
import type {
  ChatModelDescription,
  ChatModelSettings,
  ChatPreset,
} from "@gadgets/workshop-shared/api";
import { REASONING_LEVEL_LABELS } from "../../ai-models/modelForm";

/** A preset the composer offers for the user to add, before it is one of theirs. */
export type SuggestedChatPreset = Pick<ChatPreset, "name" | "settings">;

/**
 * The presets offered to a user who has none of the same name. None applies to a chat until the
 * user adds it and picks it. The long-context budget is capped at each model's maximum when a
 * turn runs.
 */
export const SUGGESTED_CHAT_PRESETS: readonly SuggestedChatPreset[] = [
  { name: "Long context", settings: { compactionInputBudget: 1_000_000 } },
  { name: "Deep thinking", settings: { reasoning: "high" } },
  { name: "Quick", settings: { reasoning: "low" } },
];

/** Whether `settings` sets anything. */
export const hasChatSettings = (settings: ChatModelSettings): boolean =>
  settings.reasoning !== undefined || settings.compactionInputBudget !== undefined;

/** `settings` with `change` applied, holding only the fields that leaves set. */
export const withChatSetting = (
  settings: ChatModelSettings,
  change: ChatModelSettings,
): ChatModelSettings => {
  const { reasoning, compactionInputBudget } = { ...settings, ...change };
  return {
    ...(reasoning !== undefined && { reasoning }),
    ...(compactionInputBudget !== undefined && { compactionInputBudget }),
  };
};

/** Whether two settings set the same fields to the same values. */
export const sameChatSettings = (a: ChatModelSettings, b: ChatModelSettings): boolean =>
  a.reasoning === b.reasoning && a.compactionInputBudget === b.compactionInputBudget;

/**
 * The preset whose settings are `settings`: the one with `pickedId` while its settings still are,
 * since several presets may have the same settings, else the first. None while `settings` sets
 * nothing.
 */
export const matchingChatPreset = (
  presets: readonly ChatPreset[],
  settings: ChatModelSettings,
  pickedId?: string,
): ChatPreset | undefined => {
  if (!hasChatSettings(settings)) return undefined;
  const matches = presets.filter((preset) => sameChatSettings(preset.settings, settings));
  return matches.find((preset) => preset.id === pickedId) ?? matches[0];
};

/**
 * The presets in the order the server lists them: by name, case-insensitively, then by id, with
 * the comparison the server makes.
 */
export const sortChatPresets = (presets: readonly ChatPreset[]): ChatPreset[] =>
  presets.toSorted((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "accent" }) || (a.id < b.id ? -1 : 1));

/**
 * The suggestions the user has not added yet: those no preset of theirs is named like or has the
 * settings of.
 */
export const suggestionsToOffer = (presets: readonly ChatPreset[]): SuggestedChatPreset[] => {
  const names = new Set(presets.map((preset) => preset.name.trim().toLowerCase()));
  return SUGGESTED_CHAT_PRESETS.filter((suggestion) =>
    !names.has(suggestion.name.toLowerCase()) &&
    !presets.some((preset) => sameChatSettings(preset.settings, suggestion.settings)));
};

/** A number of tokens in a few characters, for a summary: "~765K", "~1.2M". */
export const approximateTokens = (tokens: number): string => {
  const thousands = Math.round(tokens / 1000);
  if (thousands < 1) return `~${tokens}`;
  if (thousands < 1000) return `~${thousands}K`;
  return `~${Number((tokens / 1_000_000).toFixed(1))}M`;
};

/**
 * When a chat with `budget` compacts: at the trigger share of the budget, capped at the model's
 * maximum where the model is known, as the server caps it when a turn runs.
 */
export const compactsAtLabel = (
  budget: number,
  description: ChatModelDescription | null,
): string => {
  const capped = description ? Math.min(budget, description.maxCompactionInputBudget) : budget;
  return `compacts at ${approximateTokens(Math.round(COMPACTION_TRIGGER_RATIO * capped))}`;
};

/** What `settings` set, on one line: "High reasoning · compacts at ~765K". */
export const chatSettingsSummary = (
  settings: ChatModelSettings,
  description: ChatModelDescription | null,
): string => {
  const parts: string[] = [];
  if (settings.reasoning === "off") parts.push("Reasoning off");
  else if (settings.reasoning !== undefined) {
    parts.push(`${REASONING_LEVEL_LABELS[settings.reasoning]} reasoning`);
  }
  if (settings.compactionInputBudget !== undefined) {
    const compactsAt = compactsAtLabel(settings.compactionInputBudget, description);
    parts.push(parts.length === 0 ? compactsAt[0].toUpperCase() + compactsAt.slice(1) : compactsAt);
  }
  return parts.join(" · ");
};
