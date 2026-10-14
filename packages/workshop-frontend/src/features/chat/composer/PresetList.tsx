import { useId, type KeyboardEvent } from "react";
import { DropdownMenu } from "@cloudflare/kumo";
import { Check, DotsThree } from "@phosphor-icons/react";
import type {
  ChatModelDescription,
  ChatModelSettings,
  ChatPreset,
} from "@gadgets/workshop-shared/api";
import { chatSettingsSummary, hasChatSettings, sameChatSettings } from "./chatPresets";
import { InlineNameField } from "./InlineNameField";

const MENU_ITEM_CLASS =
  "!h-auto rounded-xl !px-2 !py-1.5 text-[12px] leading-4 font-normal tracking-[-0.15px] text-kumo-subtle transition-colors data-highlighted:bg-kumo-tint/70 data-highlighted:text-kumo-default";

/** The radio of the preset with `id` among those within `container`. */
export const presetRadio = (container: Element | null, id: string) =>
  Array.from(container?.querySelectorAll<HTMLElement>("[data-preset-id]") ?? [])
    .find((element) => element.dataset.presetId === id);

/**
 * The user's presets as a group of radios, the one the settings match checked, each with a menu
 * of what can be done to it. The arrow keys, Home and End move through the radios, picking each.
 */
export const PresetList = ({
  presets, checked, settings, description, renaming, onPick, onUpdate, onRenameStart, onRename,
  onRenameCancel, onDelete,
}: {
  presets: ChatPreset[];
  checked: ChatPreset | undefined;
  settings: ChatModelSettings;
  description: ChatModelDescription | null;
  /** The ID of the preset being renamed. */
  renaming: string | null;
  onPick: (preset: ChatPreset) => void;
  onUpdate: (preset: ChatPreset) => void;
  onRenameStart: (preset: ChatPreset) => void;
  /** `refocus` is whether focus goes back to the preset, rather than staying where it went. */
  onRename: (preset: ChatPreset, name: string, refocus: boolean) => void;
  onRenameCancel: (preset: ChatPreset, refocus: boolean) => void;
  onDelete: (preset: ChatPreset) => void;
}) => {
  const tabStop = checked?.id ?? presets[0]?.id;
  const idPrefix = useId();

  const move = (from: number, event: KeyboardEvent<HTMLElement>) => {
    const step = event.key === "ArrowDown" || event.key === "ArrowRight" ? 1
      : event.key === "ArrowUp" || event.key === "ArrowLeft" ? -1 : 0;
    const to = event.key === "Home" ? 0
      : event.key === "End" ? presets.length - 1
        : step === 0 ? undefined : (from + step + presets.length) % presets.length;
    if (to === undefined) return false;
    const next = presets[to];
    presetRadio(event.currentTarget.closest('[role="radiogroup"]'), next.id)?.focus();
    onPick(next);
    return true;
  };

  return (
    <div role="radiogroup" aria-label="Presets" className="grid gap-0.5">
      {presets.map((preset, index) => {
        const isChecked = preset.id === checked?.id;
        const nameId = `${idPrefix}-${index}-name`;
        const summaryId = `${idPrefix}-${index}-summary`;
        const summary = chatSettingsSummary(preset.settings, description);
        return (
          <div
            key={preset.id}
            className={`flex items-center gap-0.5 rounded-xl transition-colors ${
              isChecked ? "bg-kumo-tint/70" : "hover:bg-kumo-tint/50"
            }`}
          >
            {renaming === preset.id ? (
              <div className="min-w-0 flex-1 px-1 py-1">
                <InlineNameField
                  label={`Name of ${preset.name}`}
                  initial={preset.name}
                  onSave={(name, refocus) => onRename(preset, name, refocus)}
                  onCancel={(refocus) => onRenameCancel(preset, refocus)}
                  saveOnBlur
                />
              </div>
            ) : (
              <div
                data-preset-id={preset.id}
                role="radio"
                aria-checked={isChecked}
                aria-labelledby={nameId}
                aria-describedby={summaryId}
                tabIndex={preset.id === tabStop ? 0 : -1}
                className="flex min-w-0 flex-1 cursor-pointer items-start gap-2 rounded-xl px-2 py-2 outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring sm:py-1.5"
                onClick={() => onPick(preset)}
                onKeyDown={(event) => {
                  if (event.key === " " || event.key === "Enter") {
                    event.preventDefault();
                    onPick(preset);
                  } else if (move(index, event)) {
                    event.preventDefault();
                  }
                }}
              >
                <span className="mt-[3px] flex h-3 w-3 flex-shrink-0 items-center justify-center text-kumo-default">
                  {isChecked && <Check size={12} weight="bold" />}
                </span>
                <span className="min-w-0 flex-1">
                  <span id={nameId} className="block truncate text-[13px] leading-[18px] text-kumo-default">
                    {preset.name}
                  </span>
                  <span id={summaryId} className="block truncate text-[12px] leading-4 text-kumo-subtle">
                    {summary}
                  </span>
                </span>
              </div>
            )}
            <DropdownMenu>
              <DropdownMenu.Trigger
                render={
                  <button
                    type="button"
                    aria-label={`Options for ${preset.name}`}
                    className="flex h-10 w-10 flex-shrink-0 cursor-pointer items-center justify-center rounded-lg text-kumo-inactive transition-colors hover:bg-kumo-tint hover:text-kumo-subtle focus-visible:bg-kumo-tint focus-visible:text-kumo-subtle focus-visible:outline-none data-[popup-open]:bg-kumo-tint data-[popup-open]:text-kumo-subtle sm:h-8 sm:w-8"
                  >
                    <DotsThree size={16} weight="bold" />
                  </button>
                }
              />
              <DropdownMenu.Content
                align="end"
                collisionPadding={16}
                className="themed-floating-shadow-lg !min-w-[200px] rounded-2xl border border-kumo-line/70 bg-kumo-base p-1"
              >
                {hasChatSettings(settings) && !sameChatSettings(preset.settings, settings) && (
                  <DropdownMenu.Item className={MENU_ITEM_CLASS} onClick={() => onUpdate(preset)}>
                    Update with current settings
                  </DropdownMenu.Item>
                )}
                <DropdownMenu.Item className={MENU_ITEM_CLASS} onClick={() => onRenameStart(preset)}>
                  Rename
                </DropdownMenu.Item>
                <DropdownMenu.Item
                  variant="danger"
                  className={`${MENU_ITEM_CLASS} !text-kumo-danger`}
                  onClick={() => onDelete(preset)}
                >
                  Delete
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu>
          </div>
        );
      })}
    </div>
  );
};
