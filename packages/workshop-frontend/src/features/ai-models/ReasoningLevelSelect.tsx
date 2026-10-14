import { Select } from '@cloudflare/kumo'
import type { BuiltInReasoning, ReasoningLevel } from '@gadgets/workshop-shared/api'
import { REASONING_LEVEL_LABELS, builtInReasoningLabel } from './modelForm'

// The select's value for a model with no level of its own.
const DEPLOYMENT_DEFAULT = 'default'

/**
 * The reasoning level of a model's chat turns: one of the levels it takes, or none of its own, for
 * the deployment's default. For a model that takes no levels it is a note saying so, unless the
 * model has a level of its own that can still be cleared.
 */
export const ReasoningLevelSelect = ({
  levels, value, defaultReasoning, builtInReasoning, disabled, ariaLabel, onValueChange,
}: {
  /** The levels the model takes, least to most. */
  levels: readonly ReasoningLevel[]
  /** The model's own level. Absent while it has none. */
  value: ReasoningLevel | undefined
  /** The deployment's default level, or null while it sets none. */
  defaultReasoning: ReasoningLevel | null
  /** What the model is asked for while neither it nor the deployment sets a level. */
  builtInReasoning: BuiltInReasoning
  disabled?: boolean
  ariaLabel?: string
  /** Called with the level picked, or undefined for none of the model's own. */
  onValueChange: (level: ReasoningLevel | undefined) => void
}) => {
  const levelInEffect = value ?? defaultReasoning
  const takesLevels = levels.length > 0
  const levelNote = !takesLevels
    ? 'This model takes no reasoning levels, so none is sent to it.'
    : levelInEffect !== null && !levels.includes(levelInEffect)
      ? `This model has no “${REASONING_LEVEL_LABELS[levelInEffect]}” level. A request asks for ` +
        'the nearest level it has, which is decided when the request is made.'
      : undefined
  // With no deployment default, the option names what the model is then asked for.
  const deploymentDefault = `Deployment default (${
    defaultReasoning
      ? REASONING_LEVEL_LABELS[defaultReasoning]
      : `built-in: ${builtInReasoningLabel(builtInReasoning)}`
  })`

  if (!takesLevels && value === undefined) {
    return <p className="text-sm leading-snug text-kumo-subtle">{levelNote}</p>
  }
  return (
    <Select<ReasoningLevel | typeof DEPLOYMENT_DEFAULT>
      label="Reasoning level"
      aria-label={ariaLabel}
      description={levelNote}
      className="w-full"
      disabled={disabled}
      value={value ?? DEPLOYMENT_DEFAULT}
      onValueChange={(level, { reason }) => {
        // Only a pick is the user's. The select also reports changes of its own: to the value it
        // started with, when its options change under a level that is not one of them, and to an
        // option whose first letter is typed while it is closed.
        if (reason !== 'item-press') return
        if (!level || level === (value ?? DEPLOYMENT_DEFAULT)) return
        onValueChange(level === DEPLOYMENT_DEFAULT ? undefined : level)
      }}
      renderValue={(level) =>
        level === DEPLOYMENT_DEFAULT ? deploymentDefault : REASONING_LEVEL_LABELS[level]}
    >
      <Select.Option value={DEPLOYMENT_DEFAULT}>{deploymentDefault}</Select.Option>
      {levels.map((level) => (
        <Select.Option key={level} value={level}>
          {REASONING_LEVEL_LABELS[level]}
        </Select.Option>
      ))}
    </Select>
  )
}
