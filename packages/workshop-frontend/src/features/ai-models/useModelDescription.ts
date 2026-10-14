import { useEffect, useState } from 'react'
import type {
  AuthenticatedApi,
  ModelDescription,
  RedactedAiModelConfig,
} from '@gadgets/workshop-shared/api'
import type { RpcStub } from 'capnweb'

// How long the described model must stay the same before it is asked about, so that typing its ID
// asks once rather than at every keystroke.
const SETTLE_MS = 300

/**
 * What the server says of the model `config` describes (see AuthenticatedApi.describeModel), or
 * null while there is no model to describe, while the answer is pending, and when the server
 * refuses to describe it. An answer is shown only for the model it is of.
 */
export const useModelDescription = (
  authenticatedApi: RpcStub<AuthenticatedApi>,
  config: RedactedAiModelConfig | null,
): ModelDescription | null => {
  const key = config && JSON.stringify(config)
  const [answer, setAnswer] =
    useState<{ key: string, description: ModelDescription | null } | null>(null)

  useEffect(() => {
    if (key === null) return
    let current = true
    const timer = setTimeout(() => {
      authenticatedApi.describeModel(JSON.parse(key) as RedactedAiModelConfig).then(
        (description) => { if (current) setAnswer({ key, description }) },
        (err) => {
          if (!current) return
          console.error('Failed to describe the model:', err)
          setAnswer({ key, description: null })
        },
      )
    }, SETTLE_MS)
    return () => {
      current = false
      clearTimeout(timer)
    }
  }, [authenticatedApi, key])

  return answer !== null && answer.key === key ? answer.description : null
}
