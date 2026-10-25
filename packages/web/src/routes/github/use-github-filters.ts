import { useEffect, useMemo, useState } from 'react'
import { queryScope } from '@open-mercato/cezar-api-client/utils/project-scope'

import { useGithubSearch, useProjectRuns } from '@/api/queries'
import type { GithubData, GithubItem } from '@open-mercato/cezar-api-client'
import { useSearchParamsWriter } from '@/lib/use-search-params-writer'

import type { GithubView } from './github'
import {
  isSearchBackedFilter, issueNumbersWithTask, parseGithubFilter, rowsFromSearch, searchQueryFor, type GithubFilter,
} from './github-sidebar-model'

/**
 * The GitHub list's filter state, split out of `GithubRoute` (hearsay-tools/cezarion#1661): the
 * URL's `?filter=` (#622), the toolbar's own narrows (#gh-filter), and what the sidebar filters
 * read from the run list and the forge. The route calls these hooks in this order, above its
 * early returns, so every request and effect keeps its place.
 */

/** A filter that cannot be applied yet (loading) or at all (blocked), with its reason. */
export type GithubFilterGate = { kind: 'loading' | 'blocked'; message: string }

export type GithubFilterParam = ReturnType<typeof useGithubFilterParam>
export type GithubListFilters = ReturnType<typeof useGithubListFilters>
export type GithubSidebarFilter = ReturnType<typeof useGithubSidebarFilter>

/** The sidebar list's state (#622) lives in the URL: `?filter=` names one of the view's filters.
 *  Absent = the legacy unfiltered list; present (even `all`) also means "the list, not the phone's
 *  filter screen, and not the remembered-tab redirect". */
export function useGithubFilterParam(view: GithubView) {
  const [searchParams, writeSearchParams] = useSearchParamsWriter()
  const rawFilterParam = searchParams.get('filter')
  const filter: GithubFilter | null = parseGithubFilter(view, rawFilterParam)
  const activeFilter: GithubFilter = filter ?? 'all'
  const setFilterParam = (value: GithubFilter | null) => writeSearchParams((prev) => {
    const next = new URLSearchParams(prev)
    if (value === null) next.delete('filter')
    else next.set('filter', value)
    return next
  })
  return { rawFilterParam, filter, activeFilter, setFilterParam }
}

/** List filtering (#gh-filter): free-text search (by #id or any text), a label narrow and, on
 *  issues, the assignee and board narrows. */
export function useGithubListFilters(
  view: GithubView,
  gh: GithubData | undefined,
  { filter, activeFilter, setFilterParam }: GithubFilterParam,
) {
  const [query, setQuery] = useState('')
  const [labelFilter, setLabelFilter] = useState<readonly string[]>([])
  const [assigneeFilter, setAssigneeFilter] = useState<readonly string[]>([])
  const { setProjectFilter, activeProject } = useGithubBoardFilter(gh)
  // `?filter=assigned` is the sidebar's "Assigned to me": the viewer as the one selected assignee,
  // in the same predicate the Assignees control drives. Without a known login it cannot be applied
  // (the gate below says so) rather than silently showing everything.
  const isAssignedFilter = view === 'issues' && activeFilter === 'assigned'
  const effectiveAssignees = isAssignedFilter ? (gh?.viewerLogin ? [gh.viewerLogin] : []) : assigneeFilter
  const changeAssignees = (next: string[]) => {
    setAssigneeFilter(next)
    // Editing the selection by hand leaves the preset: the URL stops claiming "assigned".
    if (isAssignedFilter) setFilterParam('all')
  }
  const clearFilters = () => {
    setQuery('')
    setLabelFilter([])
    setAssigneeFilter([])
    setProjectFilter('')
    if (filter !== null && filter !== 'all') setFilterParam('all')
  }
  // Any narrow at all, the sidebar's presets included: it enables Clear filters and picks the
  // empty list's wording.
  const filtering = query.trim() !== '' || labelFilter.length > 0 || (view === 'issues' && (effectiveAssignees.length > 0 || activeProject !== '')) || (filter !== null && filter !== 'all')
  // A text, label, assignee or board narrow, presets excluded: under one the next page waits for
  // the user's Load more (`useGithubListPaging`).
  const narrowing = query.trim() !== '' || labelFilter.length > 0
    || (view === 'issues' && ((!isAssignedFilter && assigneeFilter.length > 0) || activeProject !== ''))
  return {
    query, setQuery, labelFilter, setLabelFilter, setProjectFilter, activeProject,
    isAssignedFilter, effectiveAssignees, changeAssignees, clearFilters, filtering, narrowing,
  }
}

/** The board narrow, which only names a board the payload still links. */
function useGithubBoardFilter(gh: GithubData | undefined) {
  const [projectFilter, setProjectFilter] = useState('')
  // A refresh can revoke metadata or unlink a board. Do not leave an invisible active filter.
  const projectsPending = gh?.projectsState === 'refreshing' || gh?.projectsState === 'unavailable'
  const activeProject = projectsPending || gh?.projects?.some(p => p.id === projectFilter) ? projectFilter : ''
  useEffect(() => {
    if (gh && !projectsPending && projectFilter && !activeProject) setProjectFilter('')
  }, [gh, projectFilter, activeProject, projectsPending])
  return { setProjectFilter, activeProject }
}

/** What the sidebar filters (#622) read beyond the open list, and the open rows they leave. */
export function useGithubSidebarFilter(
  view: GithubView,
  gh: GithubData | undefined,
  { filter, activeFilter }: GithubFilterParam,
  isAssignedFilter: boolean,
) {
  // Task join (Has a task / No task yet): this project's live runs, read through `taskReferences`.
  // Fetched only while such a filter is on; the sidebar asks for the same cache entry anyway.
  const projectScope = queryScope()
  const taskFilter = view === 'issues' && (activeFilter === 'no-task' || activeFilter === 'has-task')
  const runsQuery = useProjectRuns(projectScope, taskFilter, projectScope === 'default')
  const taskNumbers = useMemo(
    () => (runsQuery.data ? issueNumbersWithTask(runsQuery.data, gh?.repo, projectScope) : null),
    [runsQuery.data, gh?.repo, projectScope],
  )
  // Review requested / Checks failing: the existing `gh search prs` route with a qualifier. The
  // main rows are the HITS (capped at 50 by the server), never an intersection with the open list.
  const backedQuery = isSearchBackedFilter(view, filter) ? searchQueryFor(filter) : null
  const filterSearch = useGithubSearch('pr', backedQuery ?? '', backedQuery !== null && gh?.available === true)
  const filterHits = backedQuery !== null && filterSearch.data?.available ? filterSearch.data.items : null

  // The open set comes from the payload, not from the post-filter rows: the cross-state search and
  // the checks window read it above the route's early returns.
  const fullList = useMemo(
    () => (gh?.available ? (view === 'issues' ? gh.issues : gh.prs) : []),
    [gh, view],
  )
  const filterRows = useMemo(() => (filterHits ? rowsFromSearch(filterHits, fullList) : null), [filterHits, fullList])
  const filterGate = githubFilterGate({
    view, gh, activeFilter, isAssignedFilter, taskFilter, taskNumbers, runsQuery, backedQuery, filterHits, filterSearch,
  })
  const openItems = useMemo(() => (filterGate ? [] : (filterRows ?? fullList)), [filterGate, filterRows, fullList])
  // Predicates the sidebar filters add on top of the text/label/assignee narrow, shared by the
  // open rows, the local-match probe and the cross-state search hits.
  const narrow = useMemo(() => {
    if (view === 'issues') {
      if (activeFilter === 'no-task' && taskNumbers) return { excludeNumbers: taskNumbers }
      if (activeFilter === 'has-task' && taskNumbers) return { includeNumbers: taskNumbers }
      return {}
    }
    if (activeFilter === 'mine' && gh?.viewerLogin) return { author: gh.viewerLogin }
    if (filterHits) return { includeNumbers: new Set(filterHits.map((hit) => hit.number)) }
    return {}
  }, [view, activeFilter, taskNumbers, gh?.viewerLogin, filterHits])
  return { backedQuery, filterSearch, fullList, filterRows, filterGate, openItems, narrow }
}

/** A filter that cannot be applied yet (loading) or at all (blocked) must show NOTHING plus its
 *  reason, never the unfiltered list under a filter's name and never a fake "no matches". */
function githubFilterGate({
  view, gh, activeFilter, isAssignedFilter, taskFilter, taskNumbers, runsQuery, backedQuery, filterHits, filterSearch,
}: {
  view: GithubView
  gh: GithubData | undefined
  activeFilter: GithubFilter
  isAssignedFilter: boolean
  taskFilter: boolean
  taskNumbers: ReadonlySet<number> | null
  runsQuery: { isError: boolean }
  backedQuery: string | null
  filterHits: readonly GithubItem[] | null
  filterSearch: ReturnType<typeof useGithubSearch>
}): GithubFilterGate | null {
  if (!gh?.available) return null
  if ((isAssignedFilter || (view === 'prs' && activeFilter === 'mine')) && !gh.viewerLogin) {
    return { kind: 'blocked', message: 'GitHub login unavailable, so this filter cannot be applied.' }
  }
  if (taskFilter && !taskNumbers) {
    return runsQuery.isError
      ? { kind: 'blocked', message: 'The task list is unavailable, so this filter cannot be applied.' }
      : { kind: 'loading', message: 'Loading tasks…' }
  }
  if (backedQuery !== null && !filterHits) {
    if (filterSearch.data?.available === false) return { kind: 'blocked', message: `GitHub could not be searched: ${filterSearch.data.reason ?? 'unknown reason'}.` }
    if (filterSearch.isError) return { kind: 'blocked', message: `GitHub could not be searched: ${filterSearch.error instanceof Error ? filterSearch.error.message : 'the search request failed'}.` }
    return { kind: 'loading', message: 'Searching GitHub…' }
  }
  return null
}
