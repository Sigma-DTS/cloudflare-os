import { useEffect, useState } from 'react'
import type { RpcStub } from 'capnweb'
import type { AuthenticatedApi, UserDirectoryRecord } from '@gadgets/workshop-shared/api'

type Search = {
  status: 'loading' | 'failed' | 'ready'
  query: string
  results: UserDirectoryRecord[]
}

const NO_SEARCH: Search = { status: 'ready', query: '', results: [] }

type Options = {
  api: RpcStub<AuthenticatedApi>
  query: string
  enabled: boolean
  excludeIds: string[]
}

/** Debounced directory search for `query`; stale responses are dropped. */
export const useUserDirectorySearch = ({ api, query, enabled, excludeIds }: Options) => {
  const [search, setSearch] = useState<Search>(NO_SEARCH)

  useEffect(() => {
    if (!enabled) {
      setSearch(NO_SEARCH)
      return
    }
    let cancelled = false
    // The previous results stay up until the new ones arrive, so the list doesn't collapse and
    // reopen on every keystroke.
    setSearch(previous => ({ status: 'loading', query, results: previous.results }))
    // Debounced: every keystroke from every user would otherwise hit the one directory DO.
    const timer = window.setTimeout(() => {
      api.searchUsers(query, excludeIds).then(
        results => {
          if (!cancelled) setSearch({ status: 'ready', query, results })
        },
        error => {
          if (cancelled) return
          console.error('Failed to search user directory:', error)
          setSearch({ status: 'failed', query, results: [] })
        })
    }, 200)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [api, excludeIds, enabled, query])

  // `search` lags the query by a render, so `settled` and `noMatches` only hold once the results
  // answer the current query. Until then `results` may belong to an earlier query.
  const current = search.query === query
  return {
    results: search.results,
    loading: !current || search.status === 'loading',
    failed: current && search.status === 'failed',
    settled: current && search.status !== 'loading',
    noMatches: current && search.status === 'ready' && search.results.length === 0,
  }
}
