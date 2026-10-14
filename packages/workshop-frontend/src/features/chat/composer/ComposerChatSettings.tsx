import { useId, useLayoutEffect, useRef, useState } from "react";
import {
  Button,
  KumoPortalProvider,
  SkeletonLine,
  useKumoToastManager,
} from "@cloudflare/kumo";
import { Popover } from "@cloudflare/kumo/primitives/popover";
import { Sliders } from "@phosphor-icons/react";
import { MAX_CHAT_PRESETS } from "@gadgets/workshop-shared/api";
import type { ChatModelSettings, ChatPreset } from "@gadgets/workshop-shared/api";
import { rpcFailureDescription } from "../../../rpcErrors";
import { useDialogSelectPortalContainer } from "../../../useDialogSelectPortalContainer";
import {
  chatSettingsSummary,
  hasChatSettings,
  matchingChatPreset,
  sameChatSettings,
  suggestionsToOffer,
  type SuggestedChatPreset,
} from "./chatPresets";
import { INLINE_NAME_FIELD, InlineNameField } from "./InlineNameField";
import { ModelFields } from "./ModelFields";
import { PresetList, presetRadio } from "./PresetList";
import type { ChatModelDescriptionState } from "./useChatModelDescription";
import type { ChatPresetsState } from "./useChatPresets";

/** A composer's chat settings: what they are, how they change, and what offers them. */
export type ChatSettingsControl = {
  /** What the chat sets for its model's turns, or for a chat yet to start what it starts with. */
  settings: ChatModelSettings;
  /** Called with the whole of the settings, as a change leaves them. */
  onSettingsChange: (settings: ChatModelSettings) => void;
  /** The selected model's description. */
  description: ChatModelDescriptionState;
  /** The user's presets. */
  presets: ChatPresetsState;
  /**
   * Called when the user may be about to open the settings, by pointing at or focusing their
   * trigger, and when they open, so that the model's description can be fetched before it shows.
   */
  onIntent?: () => void;
};

const SECTION_TITLE_CLASS =
  "px-2 pb-1 text-[11px] font-medium uppercase leading-4 tracking-[0.06em] text-kumo-inactive";
const NOTE_CLASS = "px-2 text-[12px] leading-4 tracking-[-0.15px] text-kumo-subtle";

// Where focus goes once the render that a change causes has committed.
type FocusTarget = { preset: string } | "save-as" | "panel";

/**
 * The composer's model settings: a reasoning level and compaction budget for the conversation,
 * and the user's presets that apply them in one step. Its trigger names the preset the settings
 * match, or "Custom" for settings no preset has.
 */
export const ComposerChatSettings = (control: ChatSettingsControl) => {
  const { settings, description, presets, onIntent } = control;
  const [open, setOpen] = useState(false);
  // The preset last picked, which is the one checked while several have the settings.
  const [pickedId, setPickedId] = useState<string | undefined>();
  const checked = presets.list ? matchingChatPreset(presets.list, settings, pickedId) : undefined;
  const set = hasChatSettings(settings);
  // Until the presets are known, settings can't be told apart from a preset's, so they are only
  // marked as set.
  const label = set && presets.list ? checked?.name ?? "Custom" : undefined;

  return (
    <Popover.Root
      open={open}
      onOpenChange={(next, { reason, event }) => {
        if (!next && reason === "escape-key" && event.target instanceof Element &&
            event.target.closest(`[${INLINE_NAME_FIELD}]`)) return;
        setOpen(next);
        if (next) {
          onIntent?.();
          presets.retry();
          description.retry();
        }
      }}
    >
      <Popover.Trigger
        render={
          <button
            type="button"
            aria-label={label !== undefined ? `Model settings: ${label}`
                : set ? "Model settings (set)" : "Model settings"}
            onPointerEnter={onIntent}
            onFocus={onIntent}
            className="group relative inline-flex h-10 min-w-0 flex-shrink-0 cursor-pointer items-center gap-1.5 rounded-lg px-2 text-[14px] leading-5 text-kumo-subtle transition-[background-color,color,transform] duration-150 ease-out hover:bg-kumo-tint hover:text-kumo-default focus-visible:bg-kumo-tint focus-visible:text-kumo-default focus-visible:outline-none active:scale-[0.97] data-[popup-open]:bg-kumo-tint data-[popup-open]:text-kumo-default max-w-[150px] sm:h-8 sm:text-[13px] @md:flex-shrink"
          >
            <Sliders size={16} className="flex-shrink-0" />
            {/* The name shows only in a composer wide enough to hold it beside the model's, which
                a phone's, or a narrow workspace pane's, is not. There, and while there is no name
                yet, a dot only marks that something is set. */}
            {label !== undefined && (
              <span className="hidden min-w-0 truncate @md:inline">{label}</span>
            )}
            {set && (
              <span
                aria-hidden="true"
                className={`absolute right-1 top-2 h-1.5 w-1.5 rounded-full bg-kumo-brand sm:top-1.5 ${
                  label !== undefined ? "@md:hidden" : ""}`}
              />
            )}
          </button>
        }
      />
      {/* Kumo's Popover.Content takes no collision padding, which keeps the popup 16px from the
          viewport's edges as the composer's menus are kept, so its parts are composed here. */}
      <Popover.Portal>
        <Popover.Positioner
          side="top"
          align="end"
          sideOffset={8}
          collisionPadding={16}
          positionMethod="fixed"
        >
          <Popover.Popup className="kumo-popover-popup themed-floating-shadow-lg flex w-[min(320px,calc(100vw-32px))] origin-(--transform-origin) flex-col overflow-hidden rounded-2xl border border-kumo-line/70 bg-kumo-base text-kumo-default outline-none transition-[transform,scale,opacity] duration-150 data-ending-style:scale-90 data-ending-style:opacity-0 data-instant:duration-0 data-starting-style:scale-90 data-starting-style:opacity-0">
            <Popover.Title className="sr-only">Model settings</Popover.Title>
            <ChatSettingsPanel {...control} checked={checked} onPresetPicked={setPickedId} />
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
};

// The popover's body, mounted only while it is open.
const ChatSettingsPanel = ({
  settings,
  onSettingsChange,
  description: { description, failed: describeFailed },
  presets,
  checked,
  onPresetPicked,
}: ChatSettingsControl & {
  /** The preset the settings match, which the trigger names. */
  checked: ChatPreset | undefined;
  /** Called with the ID of the preset the user picks. */
  onPresetPicked: (id: string) => void;
}) => {
  const toasts = useKumoToastManager();
  // The menus and selects inside open above the popover, which is itself above the page.
  const layer = useDialogSelectPortalContainer();
  const [renaming, setRenaming] = useState<string | null>(null);
  const [naming, setNaming] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const saveAsRef = useRef<HTMLButtonElement>(null);
  const focusAfterRender = useRef<FocusTarget | null>(null);
  const introId = useId();

  const list = presets.list;
  const settingsSet = hasChatSettings(settings);
  const full = (list?.length ?? 0) >= MAX_CHAT_PRESETS;
  const suggestions = list ? suggestionsToOffer(list) : [];

  useLayoutEffect(() => {
    const target = focusAfterRender.current;
    if (target === null) return;
    const element = target === "panel"
      ? panelRef.current
      : target === "save-as" ? saveAsRef.current : presetRadio(panelRef.current, target.preset);
    if (!element) return;
    focusAfterRender.current = null;
    element.focus();
  });

  const failure = (title: string) => (err: unknown) =>
    toasts.add({ title, description: rpcFailureDescription(err), variant: "error" });

  const pick = (preset: ChatPreset) => {
    onPresetPicked(preset.id);
    if (!sameChatSettings(preset.settings, settings)) onSettingsChange(preset.settings);
  };

  const add = ({ name, settings: presetSettings }: SuggestedChatPreset) => {
    const id = crypto.randomUUID();
    focusAfterRender.current = { preset: id };
    presets.save({ id, name, settings: presetSettings }).catch(failure("Couldn’t save the preset"));
  };

  const rename = (preset: ChatPreset, name: string) => {
    setRenaming(null);
    if (name !== preset.name) {
      presets.save({ ...preset, name }).catch(failure("Couldn’t rename the preset"));
    }
  };

  const remove = (preset: ChatPreset) => {
    const others = list?.filter((other) => other.id !== preset.id) ?? [];
    const index = list?.findIndex((other) => other.id === preset.id) ?? 0;
    const neighbor = others[Math.min(index, others.length - 1)];
    focusAfterRender.current = neighbor ? { preset: neighbor.id } : "panel";
    const toastId = toasts.add({
      title: `Deleted “${preset.name}”`,
      actions: [{
        children: "Undo",
        onClick: () => {
          toasts.close(toastId);
          presets.save(preset).catch(failure("Couldn’t restore the preset"));
        },
      }],
    });
    presets.remove(preset.id).catch((err: unknown) => {
      toasts.close(toastId);
      failure("Couldn’t delete the preset")(err);
    });
  };

  const presetList = list && list.length > 0 && (
    <PresetList
      presets={list}
      checked={checked}
      settings={settings}
      description={description}
      renaming={renaming}
      onPick={pick}
      onUpdate={(preset) =>
        presets.save({ ...preset, settings }).catch(failure("Couldn’t update the preset"))}
      onRenameStart={(preset) => setRenaming(preset.id)}
      onRename={(preset, name, refocus) => {
        if (refocus) focusAfterRender.current = { preset: preset.id };
        rename(preset, name);
      }}
      onRenameCancel={(preset, refocus) => {
        if (refocus) focusAfterRender.current = { preset: preset.id };
        setRenaming(null);
      }}
      onDelete={remove}
    />
  );

  const suggestionList = suggestions.length > 0 && (
    <ul className="grid gap-0.5">
      {suggestions.map((suggestion) => (
        <li key={suggestion.name} className="flex items-center gap-2 rounded-xl px-2 py-1.5">
          <div className="min-w-0 flex-1">
            <p className="truncate text-[13px] leading-[18px] text-kumo-default">{suggestion.name}</p>
            <p className="truncate text-[12px] leading-4 text-kumo-subtle">
              {chatSettingsSummary(suggestion.settings, description)}
            </p>
          </div>
          <Button
            variant="secondary"
            size="sm"
            disabled={full}
            aria-label={`Add ${suggestion.name}`}
            onClick={() => add(suggestion)}
          >
            Add
          </Button>
        </li>
      ))}
    </ul>
  );

  const fullNote = (
    <p className={NOTE_CLASS}>
      You have {MAX_CHAT_PRESETS} presets, the most you can keep. Delete one to save another.
    </p>
  );

  return (
    <KumoPortalProvider container={layer}>
      <div
        ref={panelRef}
        tabIndex={-1}
        className="flex max-h-[min(640px,var(--available-height))] flex-col divide-y divide-kumo-line/70 overflow-y-auto outline-none"
      >
        <section aria-labelledby={`${introId}-presets`} className="p-1.5">
          <h3 id={`${introId}-presets`} className={`${SECTION_TITLE_CLASS} pt-1`}>Presets</h3>
          {presets.failed ? (
            <p className={`${NOTE_CLASS} py-1.5`}>Presets aren’t available right now.</p>
          ) : list === null ? (
            <div aria-busy="true" aria-label="Loading presets" className="grid gap-2 px-2 py-2">
              <SkeletonLine minWidth={40} maxWidth={60} blockHeight={14} />
              <SkeletonLine minWidth={65} maxWidth={85} blockHeight={14} />
            </div>
          ) : list.length === 0 ? (
            <>
              <p id={introId} className={`${NOTE_CLASS} pb-1`}>
                Presets apply a reasoning level and compaction budget to a conversation in one
                click.
              </p>
              {suggestionList}
            </>
          ) : (
            presetList
          )}
        </section>

        <section className="grid gap-4 px-3.5 py-3">
          {describeFailed ? (
            <p className="text-[12px] leading-4 tracking-[-0.15px] text-kumo-subtle">
              Settings aren’t available for this model.
            </p>
          ) : (
            <ModelFields
              settings={settings}
              description={description}
              onSettingsChange={onSettingsChange}
            />
          )}
        </section>

        {settingsSet && checked === undefined && list !== null && (
          <section className="p-1.5">
            {full ? (
              <div className="py-1.5">{fullNote}</div>
            ) : naming ? (
              <div className="px-2 py-1">
                <InlineNameField
                  label="Preset name"
                  initial=""
                  onSave={(name) => {
                    const id = crypto.randomUUID();
                    focusAfterRender.current = { preset: id };
                    setNaming(false);
                    presets.save({ id, name, settings }).catch(failure("Couldn’t save the preset"));
                  }}
                  onCancel={(refocus) => {
                    if (refocus) focusAfterRender.current = "save-as";
                    setNaming(false);
                  }}
                />
              </div>
            ) : (
              <button
                ref={saveAsRef}
                type="button"
                className="flex w-full cursor-pointer items-center rounded-xl px-2 py-1.5 text-left text-[13px] leading-[18px] text-kumo-default transition-colors hover:bg-kumo-tint/70 focus-visible:bg-kumo-tint focus-visible:outline-none"
                onClick={() => setNaming(true)}
              >
                Save as preset…
              </button>
            )}
          </section>
        )}

        {list !== null && list.length > 0 && suggestions.length > 0 && (
          <section aria-labelledby={`${introId}-suggested`} className="p-1.5">
            <h3 id={`${introId}-suggested`} className={`${SECTION_TITLE_CLASS} pt-1`}>
              Suggested presets
            </h3>
            {full && !(settingsSet && checked === undefined) && <div className="pb-1">{fullNote}</div>}
            {suggestionList}
          </section>
        )}
      </div>
    </KumoPortalProvider>
  );
};
