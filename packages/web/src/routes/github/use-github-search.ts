import { useEffect, useMemo, useState } from 'react'

import { useGithubSearch } from '@/api/queries'
import type { GithubData, GithubSearchData } from '@open-mercato/cezar-api-client'

import type { GithubView } from './github'
import { filterGithubItems, shouldSearchForge } from './github-filter'
import type { GithubListFilters, GithubSidebarFilter } from './use-github-filters'

/** How long the search box must be idle before the cross-state fallback (#730) fires. Every
 *  search is a `gh` subprocess against GitHub's rate-limited search API, so this is a cost
 *  control, not a polish detail. */
const SEARCH_DEBOUNCE_MS = 350

/** `value`, but only after it has stopped changing for `delay` ms. Local to this route — the
 *  search fallback is the one place in the cockpit that pays a subprocess per keystroke. */
function useDebouncedValue<T>(value: T, delay: number): T {
  const [settled, setSettled] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delay)
    return () => clearTimeout(timer)
  }, [value, delay])
  return settled
}

export type GithubCrossStateSearch = ReturnType<typeof useGithubCrossStateSearch>

/**
 * The rows the list shows, and the cross-state search fallback (#730) past them.
 *
 * The list tier only ever holds OPEN items, so a closed or merged issue/PR is not "past the
 * fetched window" — it was never fetched, and no amount of in-memory filtering reaches it. When
 * the local narrow comes up empty for a non-empty query we ask the forge instead.
 */
export function useGithubCrossStateSearch(
  view: GithubView,
  gh: GithubData | undefined,
  { query, labelFilter, effectiveAssignees, activeProject }: GithubListFilters,
  { openItems, narrow, filterGate }: GithubSidebarFilter,
) {
  const debouncedQuery = useDebouncedValue(query, SEARCH_DEBOUNCE_MS)
  // Evaluated against the DEBOUNCED query, not the live one: the fallback must be decided by the
  // same text the request will carry, or a fast typist fires a `gh` subprocess per keystroke.
  // Memoized because this walks every loaded row and only its three
  // inputs can change the answer; unmemoized it re-filtered that set on every unrelated render,
  // doubling the filtering `items` below already does for the live query (#838).
  const localMatches = useMemo(
    () => filterGithubItems(openItems, { query: debouncedQuery, labels: labelFilter, ...narrow,
      ...(view === 'issues' ? { assignees: effectiveAssignees, projectId: activeProject } : {}),
    }),
    [openItems, debouncedQuery, labelFilter, view, effectiveAssignees, activeProject, narrow],
  )
  const querySettled = query.trim() === debouncedQuery.trim()
  // A blocked/loading sidebar filter cannot be applied, so the cross-state fallback is off with it:
  // its hits would be filtered by an empty `narrow` and appear as rows under a filter that is not on.
  const searchWanted = gh?.available === true && !filterGate && querySettled && shouldSearchForge(debouncedQuery, localMatches)
  const forgeSearch = useGithubSearch(view === 'issues' ? 'issue' : 'pr', debouncedQuery, searchWanted)

  const items = filterGithubItems(openItems, { query, labels: labelFilter, ...narrow, ...(view === 'issues' ? { assignees: effectiveAssignees, projectId: activeProject } : {}) })
  // Only the settled query may contribute rows, filter metadata or error states. Disabling the
  // query does not evict its cached data, so never render data solely because it is available.
  const searchPayload = searchWanted && forgeSearch.data?.available ? forgeSearch.data : null
  // Hits are narrowed by the label filter too — it reads as "narrow whatever is on screen". They
  // also drop anything the list above already shows: `gh search` returns OPEN matches alongside
  // closed and merged ones, and during the debounce window the payload belongs to the previous
  // query text, so without this an open item could occupy both lists at once (#856). "Found on
  // GitHub" only ever means "past the open list", so an overlap is never information.
  const listedNumbers = new Set(items.map((item) => item.number))
  const metadataFailure = searchMetadataFailure(view, searchPayload, activeProject, effectiveAssignees)
  const searchHits = searchPayload && !metadataFailure
    ? filterGithubItems(searchPayload.items, { labels: labelFilter, ...narrow,
        ...(view === 'issues' ? { assignees: effectiveAssignees, projectId: activeProject } : {}),
      }).filter(
        (item) => !listedNumbers.has(item.number),
      )
    : []
  return {
    debouncedQuery, searchWanted, forgeSearch, items, searchPayload, metadataFailure, searchHits,
    ...forgeSearchStatus(query, querySettled, searchWanted, forgeSearch),
  }
}

/** Why the search hits cannot be narrowed by the issue filters: the hits lack the board or the
 *  assignee data that the active narrow reads. */
function searchMetadataFailure(
  view: GithubView,
  searchPayload: GithubSearchData | null,
  activeProject: string,
  effectiveAssignees: readonly string[],
): string | null {
  return view === 'issues' && searchPayload
    ? activeProject && searchPayload.items.some(item => item.projectIds === undefined)
      ? searchPayload.projectsReason ?? 'Project board data is incomplete. Refresh to try again.'
      : effectiveAssignees.length && searchPayload.items.some(item => item.assignees === undefined)
        ? 'Assignee data is incomplete. Refresh to try again.'
        : null
    : null
}

/** What the forge search is doing now, for the empty list's verdict. */
function forgeSearchStatus(
  query: string,
  querySettled: boolean,
  searchWanted: boolean,
  forgeSearch: ReturnType<typeof useGithubSearch>,
) {
  // "A search is coming or running" — the debounce window counts. Without it, the moment between
  // the last keystroke and the request firing would render the definitive "nothing anywhere",
  // which is the same lie #730 set out to remove, just half a second long.
  const searching =
    (query.trim() !== '' && !querySettled) ||
    (searchWanted && forgeSearch.isPending)
  // The forge was asked and could not answer. Two ways that happens, and only the first used to
  // be handled: the driver degraded in-payload (`available: false` + a reason), or the request
  // never landed at all — a 400 on an over-long `q`, a 5xx, a dropped connection. Without the
  // `isError` half a failed request fell through to the definitive "nothing in any state", which
  // is precisely the claim #730 exists to stop the tab from making.
  const searchFailed = searchWanted && (forgeSearch.data?.available === false || forgeSearch.isError)
  const searchFailureReason =
    forgeSearch.data?.available === false
      ? (forgeSearch.data.reason ?? 'unknown reason')
      : forgeSearch.error instanceof Error
        ? forgeSearch.error.message
        : 'the search request failed'
  return { searching, searchFailed, searchFailureReason }
}
