import { useId, useRef, useState, type FormEvent } from "react";
import { Input, SkeletonLine } from "@cloudflare/kumo";
import type { ChatModelDescription, ChatModelSettings } from "@gadgets/workshop-shared/api";
import { CompactionBudgetHelp } from "../../ai-models/CompactionBudgetHelp";
import { parseTokenLimit, tokenCount } from "../../ai-models/modelForm";
import { useFieldErrorAlert } from "../../ai-models/useFieldErrorAlert";
import { withChatSetting } from "./chatPresets";

/**
 * The chat's compaction budget, committed when the field is left or Enter is pressed. A budget
 * over the model's maximum is kept, and capped when a turn runs, since the chat may change model.
 */
export const BudgetField = ({ settings, description, onSettingsChange }: {
  settings: ChatModelSettings;
  description: ChatModelDescription | null;
  onSettingsChange: (settings: ChatModelSettings) => void;
}) => {
  const own = settings.compactionInputBudget;
  // What is typed, with the chat's budget it was typed over, or null while the field shows the
  // chat's budget.
  const [draft, setDraft] = useState<{ text: string; over: number | undefined } | null>(null);
  const fieldRef = useRef<HTMLInputElement>(null);
  const helpId = useId();
  const cappedId = useId();
  const alert = useFieldErrorAlert();

  // A budget set from elsewhere, such as by a preset, replaces what is typed, and its error.
  if (draft !== null && draft.over !== own) {
    setDraft(null);
    alert.clear();
  }

  const text = draft !== null && draft.over === own
    ? draft.text
    : own === undefined ? "" : String(own);
  const budget = parseTokenLimit(text);
  const error = budget === null
    ? "Enter a positive whole number of tokens, or leave this blank for the model’s budget"
    : undefined;
  const max = description?.maxCompactionInputBudget;
  const capped = max !== undefined && typeof budget === "number" && budget > max;

  const commit = (fromEnter: boolean) => {
    if (error !== undefined) {
      if (fromEnter) alert.pointAt(fieldRef.current, error);
      return;
    }
    setDraft(null);
    const value = budget ?? undefined;
    if (value !== own) onSettingsChange(withChatSetting(settings, { compactionInputBudget: value }));
  };

  return (
    <form
      noValidate
      className="grid content-start gap-2"
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        commit(true);
      }}
    >
      <Input
        ref={fieldRef}
        label="Compaction budget"
        inputMode="numeric"
        placeholder={description
          ? `${description.compactionInputBudget.toLocaleString()} (model default)`
          : undefined}
        value={text}
        disabled={!description}
        error={error}
        aria-invalid={error !== undefined}
        // The stand-in help shown while the model is described would be read with its numbers.
        aria-describedby={!description ? undefined : capped ? `${cappedId} ${helpId}` : helpId}
        onChange={(event) => {
          setDraft({ text: event.target.value, over: own });
          alert.clear();
        }}
        onBlur={() => commit(false)}
      />
      {capped && (
        <p id={cappedId} className="text-sm leading-snug text-kumo-subtle">
          Capped at {tokenCount(max)} for this model.
        </p>
      )}
      {description ? (
        <CompactionBudgetHelp
          id={helpId}
          builtIn={description.compactionInputBudget}
          max={description.maxCompactionInputBudget}
          inEffect={Math.min(own ?? description.compactionInputBudget,
                             description.maxCompactionInputBudget)}
          typed={typeof budget === "number" ? budget : undefined}
          forChat
        />
      ) : (
        // The help for a typical model, unseen, holds the height the real help settles at.
        <div aria-hidden="true" className="relative">
          <div className="invisible">
            <CompactionBudgetHelp
              id={`${helpId}-stand-in`}
              builtIn={200_000}
              max={900_000}
              inEffect={200_000}
              typed={undefined}
              forChat
            />
          </div>
          <div className="absolute inset-0 grid content-start gap-[5px] overflow-hidden pt-[3px]">
            <SkeletonLine minWidth={85} maxWidth={95} blockHeight={14} />
            <SkeletonLine minWidth={85} maxWidth={95} blockHeight={14} />
            <SkeletonLine minWidth={40} maxWidth={55} blockHeight={14} />
          </div>
        </div>
      )}
      {alert.alert}
    </form>
  );
};
