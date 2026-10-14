import { useEffect, useRef, useState } from 'react'
import type { AiModelProvider } from '@gadgets/workshop-shared/api'
import type { ModelSuggestions } from './ModelSuggestionInput'
import { fetchModelsDev, suggestModels } from './modelsDev'

/**
 * The models.dev models to suggest under `providers`, leaving out `takenIds`, or undefined while
 * suggestions are off. The list is requested when a field first engages, and at most once for as
 * long as the caller is mounted: it is several megabytes, and a failure only costs the suggestions.
 */
export const useModelsDevSuggestions = (
  enabled: boolean,
  providers: readonly AiModelProvider[],
  takenIds: readonly string[],
): ModelSuggestions | undefined => {
  // What the one request settled with: the list, or undefined when it failed. Null until then.
  const [modelsDev, setModelsDev] = useState<{ list: unknown } | null>(null)
  const request = useRef<AbortController | null>(null)
  useEffect(() => () => request.current?.abort(), [])

  const load = () => {
    if (request.current) return
    const controller = new AbortController()
    request.current = controller
    fetchModelsDev(controller.signal).then(
      (list) => setModelsDev({ list }),
      (err) => {
        if (controller.signal.aborted) return
        console.error('Failed to load the models.dev list:', err)
        setModelsDev({ list: undefined })
      },
    )
  }

  if (!enabled) return undefined
  return {
    models: suggestModels(modelsDev?.list, providers, takenIds),
    // Nothing to suggest even counting the models already taken: the request failed, or what it
    // returned is not the list.
    unavailable: modelsDev !== null && suggestModels(modelsDev.list, providers, []).length === 0,
    onEngage: load,
  }
}
