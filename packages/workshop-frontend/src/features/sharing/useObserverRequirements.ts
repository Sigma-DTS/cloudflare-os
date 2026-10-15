import { useEffect, useState } from 'react'
import type { RpcStub } from 'capnweb'
import type { CollaboratorRole, ObserverBindingNeed, Overseer } from '@gadgets/workshop-shared/api'

/**
 * The connected systems a viewer must have their own access to, for each access level. Refreshed
 * on focus as well as on open: bindings cannot change in the share dialog, but they can change in
 * another tab while it remains open. A failed refresh is informational and never blocks sharing.
 */
export const useObserverRequirements = (overseer: RpcStub<Overseer>, open: boolean) => {
  const [requirements, setRequirements] =
    useState<Record<CollaboratorRole, ObserverBindingNeed[]> | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    let requestId = 0
    setRequirements(null)
    const refresh = () => {
      const thisRequest = ++requestId
      setFailed(false)
      Promise.all([
        overseer.listObserverRequirements('use'),
        overseer.listObserverRequirements('build'),
      ])
        .then(([use, build]) => {
          if (!cancelled && thisRequest === requestId) setRequirements({ use, build })
        })
        .catch(err => {
          console.error('Failed to load observer requirements:', err)
          if (!cancelled && thisRequest === requestId) setFailed(true)
        })
    }
    refresh()
    window.addEventListener('focus', refresh)
    return () => {
      cancelled = true
      window.removeEventListener('focus', refresh)
    }
  }, [open, overseer])

  return { requirements, failed }
}
