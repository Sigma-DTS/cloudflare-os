import { COMPACTION_TRIGGER_RATIO } from '@gadgets/workshop-shared/api'
import { tokenCount } from './modelForm'

// A compaction budget under this many tokens is pointed out, since nothing refuses it.
const SMALL_BUDGET = 100_000

/**
 * What a compaction budget field means for a model: its built-in budget and maximum, when a chat
 * compacts with the budget in effect, and a warning for a budget so small that chats compact very
 * often. It is the field's description, and not a live region that would speak while the budget
 * is being typed.
 */
export const CompactionBudgetHelp = ({ id, builtIn, max, inEffect, typed }: {
  /** The ID the field is described by. */
  id: string
  /** The budget the model has while none is set for it. */
  builtIn: number
  /** The largest budget the model may be given. */
  max: number
  /** The budget a chat on the model compacts against. */
  inEffect: number
  /** The budget typed into the field, while it is a valid one. */
  typed: number | undefined
}) => (
  <div id={id} className="grid gap-2 text-sm leading-snug text-kumo-subtle">
    <p>
      Leave blank for the built-in budget of {tokenCount(builtIn)}. The maximum is{' '}
      {tokenCount(max)}. A chat on this model compacts at about{' '}
      {tokenCount(Math.round(COMPACTION_TRIGGER_RATIO * inEffect))}.
    </p>
    {typed !== undefined && typed < SMALL_BUDGET && (
      <p className="text-kumo-warning">
        A budget under {tokenCount(SMALL_BUDGET)} makes a chat compact very often.
      </p>
    )}
  </div>
)
