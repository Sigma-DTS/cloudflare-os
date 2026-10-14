import { useState, type RefObject } from 'react'
import { Autocomplete } from '@cloudflare/kumo'
import type { AiModelProvider } from '@gadgets/workshop-shared/api'
import type { ModelSuggestion } from './modelsDev'

/**
 * The models a model ID field suggests. Picking one only fills a form in: what is added is what the
 * form holds when it is submitted.
 */
export type ModelSuggestions = {
  /** The models to suggest, each under the provider it belongs to. */
  models: readonly ModelSuggestion[]
  /** Whether the suggestions could not be loaded. */
  unavailable: boolean
  /** Called whenever the field is turned to, which is when suggestions are wanted. */
  onEngage: () => void
}

/**
 * A model ID field that suggests the models of `provider` whose ID holds what is typed. Typing
 * reports the text through `onValueChange`; a pick reports it there too, then the model itself
 * through `onPick`.
 */
export const ModelSuggestionInput = ({
  label, description, provider, value, error, disabled, suggestions, inputRef, onValueChange,
  onPick,
}: {
  label: string
  description: string
  provider: AiModelProvider
  value: string
  error: string | undefined
  disabled?: boolean
  suggestions: ModelSuggestions
  /** Set to the field's input, for a form to point at it. */
  inputRef?: RefObject<HTMLInputElement | null>
  onValueChange: (value: string) => void
  onPick: (suggestion: ModelSuggestion) => void
}) => {
  const [listOpen, setListOpen] = useState(false)
  // Matched here rather than by the field, which would report itself expanded over a list with
  // nothing in it.
  const typed = value.trim().toLowerCase()
  const offered = suggestions.models.filter((suggestion) =>
    suggestion.provider === provider && suggestion.id.toLowerCase().includes(typed))

  return (
    // Kumo's Autocomplete hands out no ref to its input, and takes neither a focus handler nor
    // aria-invalid for it, so all three go through this wrapper.
    <div
      ref={(wrapper) => {
        const field = wrapper?.querySelector<HTMLInputElement>('[role="combobox"]') ?? null
        if (inputRef) inputRef.current = field
        field?.setAttribute('aria-invalid', String(error !== undefined))
      }}
      className="grid gap-2"
      onFocus={suggestions.onEngage}
    >
      <Autocomplete<ModelSuggestion>
        label={label}
        description={description}
        error={error}
        items={offered}
        filter={null}
        open={listOpen && offered.length > 0}
        onOpenChange={(open) => setListOpen(open)}
        itemToStringValue={(suggestion) => suggestion.id}
        value={value}
        disabled={disabled}
        onValueChange={(next, { reason }) => {
          suggestions.onEngage()
          // With the list closed, Escape asks to empty the field. What was typed stays.
          if (reason === 'escape-key') return
          onValueChange(next)
          const picked =
            reason === 'item-press' && offered.find((suggestion) => suggestion.id === next)
          if (picked) onPick(picked)
        }}
      >
        <Autocomplete.InputGroup />
        <Autocomplete.Content>
          <Autocomplete.List>
            {(suggestion: ModelSuggestion) => (
              <Autocomplete.Item key={suggestion.id} value={suggestion}>
                <span className="block break-all font-mono text-sm">{suggestion.id}</span>
                <span className="block text-xs text-kumo-subtle">{suggestion.name}</span>
              </Autocomplete.Item>
            )}
          </Autocomplete.List>
        </Autocomplete.Content>
      </Autocomplete>
      {suggestions.unavailable && (
        <p role="status" className="text-sm leading-snug text-kumo-subtle">
          Suggestions from models.dev couldn’t be loaded. Enter the model’s details by hand.
        </p>
      )}
    </div>
  )
}
