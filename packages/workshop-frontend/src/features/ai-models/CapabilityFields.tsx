import { Select } from '@cloudflare/kumo'
import { REASONING_LEVELS } from '@gadgets/workshop-shared/api'
import type { GatewayModelCapabilities, ReasoningLevel } from '@gadgets/workshop-shared/api'
import { REASONING_LEVEL_LABELS } from './modelForm'

// What a capability field shows while nothing is stated in it.
const NOT_STATED = 'Not stated'
const REASONING_LEVELS_HELP =
  'The levels the model can be asked for. Pick only Off for a model that does no reasoning.'

/**
 * The fields that state what a model the runtime does not know can do: whether it takes images,
 * and its reasoning levels. Rendered as two sibling fields, for the caller's grid to lay out.
 */
export const CapabilityFields = ({ capabilities, disabled, onCapabilitiesChange }: {
  /** What is stated. A field with nothing stated in it is left out. */
  capabilities: GatewayModelCapabilities
  disabled?: boolean
  onCapabilitiesChange: (capabilities: GatewayModelCapabilities) => void
}) => {
  const { imageInput, reasoningLevels = [] } = capabilities
  const change = (stated: GatewayModelCapabilities) => {
    const next = { ...capabilities, ...stated }
    if (next.imageInput === undefined) delete next.imageInput
    if (next.reasoningLevels?.length === 0) delete next.reasoningLevels
    onCapabilitiesChange(next)
  }

  return (
    <>
      <Select<boolean | null>
        label="Image input"
        description="Whether the model takes images beside text."
        required={false}
        className="w-full"
        placeholder={NOT_STATED}
        disabled={disabled}
        value={imageInput ?? null}
        onValueChange={(value) => change({ imageInput: value ?? undefined })}
        renderValue={(value) => (value ? 'Yes' : 'No')}
      >
        <Select.Option value={null}>{NOT_STATED}</Select.Option>
        <Select.Option value={true}>Yes</Select.Option>
        <Select.Option value={false}>No</Select.Option>
      </Select>
      <Select<ReasoningLevel, true>
        multiple
        label="Reasoning levels"
        description={REASONING_LEVELS_HELP}
        required={false}
        className="w-full"
        placeholder={NOT_STATED}
        disabled={disabled}
        value={reasoningLevels}
        onValueChange={(levels) =>
          // In the order of the levels, whichever order they were picked in.
          change({ reasoningLevels: REASONING_LEVELS.filter((level) => levels.includes(level)) })}
        // The placeholder shows for a value rendered as nothing, which an empty list is not.
        renderValue={(levels) =>
          levels.map((level) => REASONING_LEVEL_LABELS[level]).join(', ') || undefined}
      >
        {REASONING_LEVELS.map((level) => (
          <Select.Option key={level} value={level}>{REASONING_LEVEL_LABELS[level]}</Select.Option>
        ))}
      </Select>
    </>
  )
}
