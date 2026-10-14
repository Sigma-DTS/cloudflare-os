import { Select } from '@cloudflare/kumo'
import type { ReasoningLevel } from '@gadgets/workshop-shared/api'
import { REASONING_LEVEL_LABELS } from './modelForm'

// The select's value while no level is set.
const UNSET = 'default'

/**
 * The reasoning level of a model's chat turns: one of the levels it takes, or none, for the level
 * that applies while none is set. For a model that takes no levels it is a note saying so, unless
 * a level is set that can still be cleared.
 */
export const ReasoningLevelSelect = ({
  levels, value, defaultReasoning, defaultLabel, disabled, ariaLabel, onValueChange,
}: {
  /** The levels the model takes, least to most. */
  levels: readonly ReasoningLevel[]
  /** The level set. Absent while none is. */
  value: ReasoningLevel | undefined
  /** The level in effect while none is set, or null while that is the model's built-in behaviour. */
  defaultReasoning: ReasoningLevel | null
  /** The text of the option that sets no level, naming what then applies. */
  defaultLabel: string
  disabled?: boolean
  ariaLabel?: string
  /** Called with the level picked, or undefined for none. */
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

  if (!takesLevels && value === undefined) {
    return <p className="text-sm leading-snug text-kumo-subtle">{levelNote}</p>
  }
  return (
    <Select<ReasoningLevel | typeof UNSET>
      label="Reasoning level"
      aria-label={ariaLabel}
      description={levelNote}
      className="w-full"
      disabled={disabled}
      value={value ?? UNSET}
      onValueChange={(level, { reason }) => {
        // Only a pick is the user's. The select also reports changes of its own: to the value it
        // started with, when its options change under a level that is not one of them, and to an
        // option whose first letter is typed while it is closed.
        if (reason !== 'item-press') return
        if (!level || level === (value ?? UNSET)) return
        onValueChange(level === UNSET ? undefined : level)
      }}
      renderValue={(level) =>
        level === UNSET ? defaultLabel : REASONING_LEVEL_LABELS[level]}
    >
      <Select.Option value={UNSET}>{defaultLabel}</Select.Option>
      {levels.map((level) => (
        <Select.Option key={level} value={level}>
          {REASONING_LEVEL_LABELS[level]}
        </Select.Option>
      ))}
    </Select>
  )
}
