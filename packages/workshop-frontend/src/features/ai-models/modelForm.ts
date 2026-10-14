import type {
  AiModelProvider,
  BuiltInReasoning,
  ReasoningLevel,
} from '@gadgets/workshop-shared/api'

/** Each provider's name as the model forms and lists show it. */
export const PROVIDER_LABELS: Record<AiModelProvider, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google',
  cloudflare: 'Cloudflare Workers AI',
  ollama: 'Ollama',
}

/** Each reasoning level's name as the Models tab shows it. */
export const REASONING_LEVEL_LABELS: Record<ReasoningLevel, string> = {
  off: 'Off',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
}

/** What a model is asked for while no reasoning level is set for it, as the Models tab words it. */
export const builtInReasoningLabel = (builtIn: BuiltInReasoning): string => {
  if (builtIn === null) return 'no level sent'
  return builtIn === 'adaptive' ? 'Provider default' : REASONING_LEVEL_LABELS[builtIn]
}

/**
 * The reasoning select's option for a gateway model with no level of its own: the deployment's
 * default, or with none, what the model is then asked for.
 */
export const deploymentDefaultReasoningLabel = (
  defaultReasoning: ReasoningLevel | null,
  builtIn: BuiltInReasoning,
): string => `Deployment default (${
  defaultReasoning
    ? REASONING_LEVEL_LABELS[defaultReasoning]
    : `built-in: ${builtInReasoningLabel(builtIn)}`
})`

/** Parse a token-limit field: undefined when blank, null when not a positive whole number. */
export const parseTokenLimit = (text: string): number | undefined | null => {
  const trimmed = text.trim()
  if (!trimmed) return undefined
  if (!/^\d+$/.test(trimmed)) return null
  const value = Number(trimmed)
  return Number.isSafeInteger(value) && value > 0 ? value : null
}

/** A number of tokens, as the model forms and lists word it. */
export const tokenCount = (tokens: number) => `${tokens.toLocaleString()} tokens`
