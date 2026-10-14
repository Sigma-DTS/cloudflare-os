import { SkeletonLine } from "@cloudflare/kumo";
import { REASONING_LEVELS } from "@gadgets/workshop-shared/api";
import type { ChatModelDescription, ChatModelSettings } from "@gadgets/workshop-shared/api";
import { REASONING_LEVEL_LABELS, builtInReasoningLabel } from "../../ai-models/modelForm";
import { ReasoningLevelSelect } from "../../ai-models/ReasoningLevelSelect";
import { BudgetField } from "./BudgetField";
import { withChatSetting } from "./chatPresets";

/**
 * The chat's reasoning level and compaction budget for the selected model. While the model's
 * description loads, the budget is shown disabled and the reasoning level's place is held by a
 * placeholder, since a model may take no levels; a level the chat sets is shown disabled.
 */
export const ModelFields = ({ settings, description, onSettingsChange }: {
  settings: ChatModelSettings;
  description: ChatModelDescription | null;
  onSettingsChange: (settings: ChatModelSettings) => void;
}) => {
  const levels = description?.reasoningLevels ?? REASONING_LEVELS;
  const reasoningRowSettled = description !== null || settings.reasoning !== undefined;
  const showReasoning = levels.length > 0 || settings.reasoning !== undefined;
  const showBudget = !description || description.maxCompactionInputBudget > 0;
  const modelDefault = !description ? "Model default" : `Model default (${
    description.reasoning
      ? REASONING_LEVEL_LABELS[description.reasoning]
      : builtInReasoningLabel(description.builtInReasoning)
  })`;
  const reasoningSelect = (
    <ReasoningLevelSelect
      levels={levels}
      value={settings.reasoning}
      defaultReasoning={description?.reasoning ?? null}
      defaultLabel={modelDefault}
      disabled={!description}
      onValueChange={(reasoning) => onSettingsChange(withChatSetting(settings, { reasoning }))}
    />
  );

  return (
    <>
      {!reasoningRowSettled ? (
        // The select, unseen, holds the height it settles at for a model that takes levels.
        <div aria-hidden="true" className="relative">
          <div className="invisible">{reasoningSelect}</div>
          <div className="absolute inset-0 grid content-start gap-2 overflow-hidden">
            <SkeletonLine minWidth={30} maxWidth={40} blockHeight={14} />
            <SkeletonLine minWidth={100} maxWidth={100} blockHeight={32} />
          </div>
        </div>
      ) : showReasoning && reasoningSelect}
      {showBudget && (
        <BudgetField settings={settings} description={description} onSettingsChange={onSettingsChange} />
      )}
    </>
  );
};
