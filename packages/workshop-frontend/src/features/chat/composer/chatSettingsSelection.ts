import { isReasoningLevel } from "@gadgets/workshop-shared/api";
import type { ChatModelSettings } from "@gadgets/workshop-shared/api";
import { hasChatSettings } from "./chatPresets";

const LAST_CHAT_SETTINGS_KEY = "lastChatModelSettings";

/**
 * The chat settings last chosen in a composer, for a new chat to start with. Anything stored that
 * is not a setting is dropped, field by field.
 */
export function getStoredChatSettings(): ChatModelSettings {
  let stored: unknown;
  try {
    stored = JSON.parse(localStorage.getItem(LAST_CHAT_SETTINGS_KEY) ?? "null");
  } catch {
    return {};
  }
  if (typeof stored !== "object" || stored === null) return {};
  const { reasoning, compactionInputBudget } = stored as Record<string, unknown>;
  return {
    ...(isReasoningLevel(reasoning) && { reasoning }),
    ...(typeof compactionInputBudget === "number" && Number.isSafeInteger(compactionInputBudget) &&
      compactionInputBudget > 0 && { compactionInputBudget }),
  };
}

/** Remembers `settings` as the ones last chosen. */
export function persistChatSettings(settings: ChatModelSettings): void {
  try {
    if (hasChatSettings(settings)) {
      localStorage.setItem(LAST_CHAT_SETTINGS_KEY, JSON.stringify(settings));
    } else {
      localStorage.removeItem(LAST_CHAT_SETTINGS_KEY);
    }
  } catch {
    // Storage that refuses a write (full, or disabled) only costs the next chat its head start.
  }
}
