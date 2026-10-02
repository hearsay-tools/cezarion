import './github-layout.css'
import { hashKey, useMutation, useQueryClient } from '@tanstack/react-query'
import { LoaderCircleIcon } from 'lucide-react'
import { ArrowLeftIcon, CheckIcon, CircleDotIcon, ChevronDownIcon, GitPullRequestIcon, RefreshCwIcon, SearchIcon, TriangleAlertIcon } from '@/components/design-icons'
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type KeyboardEvent,
  type PointerEvent,
} from 'react'
import { useParams, useSearchParams } from 'react-router'
import { queryScope } from '@open-mercato/cezar-api-client'

import { Link, Navigate } from '@/lib/project-router'

import { getGithub, getGithubComments, getGithubItem, putUiState } from '@/api/client'
import { queryKeys, useGithub, useGithubChecks, useGithubItem, useProjectRuns, useGithubSearch, useHealth, useUiState } from '@/api/queries'
import type {
  GithubItem,
  UiState,
} from '@open-mercato/cezar-api-client'
import { CenteredState } from '@/components/centered-state'
import { GithubIcon } from '@/components/icons'
import { ChecksGlyph, CommentCount, GithubItemDetail, LabelChip } from '@/components/github-item-detail'
import { TabLink } from '@/components/tab-link'
import { Button } from '@/components/ui/button'
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { toast } from '@/components/ui/toaster'
import { shortAge } from '@/lib/format'
import {
  DEFAULT_GITHUB_LIST_WIDTH,
  GITHUB_LIST_WIDTH_STEP,
  MAX_GITHUB_LIST_WIDTH,
  MIN_GITHUB_LIST_WIDTH,
  clampGithubListWidth,
  readStoredGithubListWidth,
  writeStoredGithubListWidth,
} from '@/lib/github-list-width'
import { githubTaskPrompt } from '@/lib/github-task'
import { cn } from '@/lib/utils'

import { IssueFilters } from './issue-filters'
import { allLabels, filterGithubItems, labelChipStyle, shouldSearchForge } from './github-filter'
import { GithubFilterScreen } from './github-filter-screen'
import { GithubLoading } from './github-loading'
import {
  FAILING_QUERY, REVIEW_QUERY, githubFilterPath, isSearchBackedFilter, issueNumbersWithTask, parseGithubFilter,
  rowsFromSearch, searchQueryFor, GITHUB_LIST_LIMIT, ISSUE_ROWS, PR_ROWS, ACTIVE_FILTER_LABEL, type GithubFilter,
} from './github-sidebar-model'
import { useIsDesktop } from '@/lib/use-desktop'
import { HandToAgent } from './hand-to-agent'
import { useHandToAgentState } from './use-hand-to-agent-state'

// Moved to the shared detail (#692); re-exported so existing imports keep resolving.
export { groupCommitRuns, type GroupedRow, type ThreadRow } from '@/components/github-item-detail'

/**
 * `/github` — the forge tab rebuilt in React (R6 Step 1.1, spec §"GitHub tab (forge tab)"):
 * functionally the legacy tab — issues/PRs lists, a detail pane with markdown body + label
 * chips + checks badge, drag-to-composer, hand-to-agent — with the chip walls replaced by
 * searchable cmdk dropdowns (#385) and every surface a URL: `/github` (issues),
 * `/github/prs`, `/github/issues/:n`, `/github/prs/:n`. PR rows also carry a compact checks
 * glyph (#400) — the same tones as the detail pane's `ChecksBadge`, just the symbol.
 *
 * Data loads in ONE fast shot (#664): the list call no longer fetches `statusCheckRollup` — the
 * CI rollup for every open PR was the dominant cost and forced the old two-shot `30 → 1000`
 * pattern — so a single `limit`-capped fetch paints the whole open set quickly and search works
 * across it immediately. Each PR row's checks glyph is then hydrated lazily, for the on-screen
 * rows only, via `useGithubChecks` (`GET /api/github/checks`), the same way comment counts fill
 * in a beat later. A cheap React-Query prefetch on row hover/focus warms the thread so an opened
 * item is usually instant. (Cursor pagination + "Load more"/infinite scroll + row virtualization
 * are the Phase 2 follow-up.)
 *
 * Gating: the nav item is hidden by the shell when health reports no forge — but the URL
 * stays reachable (pasted links), so an unavailable payload renders the honest explainer
 * with the server's own reason, never an error.
 */

/** The single fast list fetch (`/api/github` limit). No longer split into a fast batch + a slow
 *  everything-open shot — dropping `statusCheckRollup` from the list made one fetch of the whole
 *  open set cheap. A count AT this cap still reads `N+`, since the open set may exceed it. */
const LIST_LIMIT = GITHUB_LIST_LIMIT

/** How many on-screen PR rows one checks request covers (matches the server's `GH_CHECKS_MAX`).
 *  The visible window is hydrated first; without virtualization (Phase 2) rows past this stay
 *  glyph-less, exactly as a PR with no CI would. */
const CHECKS_WINDOW = 100

/** How long the search box must be idle before the cross-state fallback (#730) fires. Every
 *  search is a `gh` subprocess against GitHub's rate-limited search API, so this is a cost
 *  control, not a polish detail. */
const SEARCH_DEBOUNCE_MS = 350

type GithubListResize = {
  width: number
  onWidthChange: (width: number) => void
}

function GithubListResizeHandle({ width, onWidthChange }: GithubListResize) {
  const origin = useRef<{ x: number; width: number } | null>(null)

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    origin.current = { x: event.clientX, width }
    event.currentTarget.setPointerCapture(event.pointerId)
    event.preventDefault()
    event.currentTarget.focus()
  }

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const start = origin.current
    if (!start) return
    onWidthChange(clampGithubListWidth(start.width + (event.clientX - start.x)))
  }

  const endDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (!origin.current) return
    origin.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const next =
      event.key === 'ArrowLeft'
        ? width - GITHUB_LIST_WIDTH_STEP
        : event.key === 'ArrowRight'
          ? width + GITHUB_LIST_WIDTH_STEP
          : event.key === 'Home'
            ? MIN_GITHUB_LIST_WIDTH
            : event.key === 'End'
              ? MAX_GITHUB_LIST_WIDTH
              : null
    if (next === null) return
    event.preventDefault()
    onWidthChange(clampGithubListWidth(next))
  }

  return (
    <div
      data-slot="gh-list-resize-handle"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the GitHub list"
      aria-valuenow={width}
      aria-valuemin={MIN_GITHUB_LIST_WIDTH}
      aria-valuemax={MAX_GITHUB_LIST_WIDTH}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onKeyDown={onKeyDown}
      onDoubleClick={() => onWidthChange(DEFAULT_GITHUB_LIST_WIDTH)}
      title="Drag to resize the GitHub list — double-click to reset"
      className="absolute inset-y-0 -right-[2px] z-20 hidden w-[5px] cursor-col-resize touch-none bg-transparent transition-colors hover:bg-accent-strong/40 focus-visible:bg-accent-strong/60 focus-visible:outline-none md:block"
    />
  )
}

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

export type GithubView = 'issues' | 'prs'

/**
 * The GitHub tab itself, and — under `index` — the bare `/github` entry point.
 *
 * **`index` (#417)** restores the last-selected sub-tab instead of always defaulting to Issues.
 * Only the bare path redirects — `/github/prs` and the `:n` deep links always
 * render exactly what their URL says, memory or not, so a pasted link never surprises.
 *
 * A one-way check, not a live sync: it reads `ui-state.json` once per mount and either renders
 * Issues or hands off to `/github/prs`. It never redirects back to Issues from `/github/prs` —
 * that URL is authoritative on its own.
 *
 * It is an `index` FLAG on this component rather than a wrapper component of its own, and that
 * matters: React reconciles by element TYPE at a position, so a `/github` route rendering some
 * other component unmounts `GithubRoute` on the hop to `/github/issues/:n` and takes its state
 * with it — including the search text, which is the only thing that can resolve a cross-state
 * hit (#730). See the `index` early return below.
 */
export function GithubRoute({
  view,
  changes = false,
  index = false,
}: {
  view: GithubView
  changes?: boolean
  /** This is the bare `/github` index (#417): restore the remembered sub-tab before rendering. */
  index?: boolean
}) {
  const { n } = useParams()
  // The sidebar list's state (#622) lives in the URL: `?filter=` names one of the view's filters.
  // Absent = the legacy unfiltered list; present (even `all`) also means "the list, not the phone's
  // filter screen, and not the remembered-tab redirect".
  const [searchParams, setSearchParams] = useSearchParams()
  const isDesktop = useIsDesktop()
  const rawFilterParam = searchParams.get('filter')
  const filter: GithubFilter | null = parseGithubFilter(view, rawFilterParam)
  const activeFilter: GithubFilter = filter ?? 'all'
  const setFilterParam = (value: GithubFilter | null) => setSearchParams((prev) => {
    const next = new URLSearchParams(prev)
    if (value === null) next.delete('filter')
    else next.set('filter', value)
    return next
  }, { replace: true })
  // One fast shot now that the list dropped `statusCheckRollup` (#664) — no more fast/full swap.
  const list = useGithub({ limit: LIST_LIMIT })
  // #801: automations are opt-in, so the cross-link into them exists exactly while the server
  // says the feature does — otherwise this tab would advertise a page that only says "off".
  // `capabilities?.` because this tab renders against minimal health payloads too; absent is
  // fail-closed, which is the honest answer while the server has not spoken.
  const automationsAvailable = useHealth().data?.capabilities?.automations === true
  const gh = list.data

  const queryClient = useQueryClient()

  // Persist the tab choice (#417), mirroring the appearance provider's read-then-write
  // pattern. The cache is patched BEFORE the PUT resolves — not just for optimism, but so
  // `GithubIndexRoute`'s check (which reads the same cache) sees the new choice immediately
  // if the click just navigated `/github/prs` → `/github`: without the eager patch it would
  // still read the stale "prs" and bounce the Issues tab straight back.
  const saveGithubView = (next: GithubView) => {
    queryClient.setQueryData<UiState>(queryKeys.uiState, (prev) => ({ ...prev, githubView: next }))
    putUiState({ githubView: next })
      .then((merged) => queryClient.setQueryData(queryKeys.uiState, merged))
      .catch((error: unknown) => {
        toast(error instanceof Error ? error.message : String(error), { tone: 'danger' })
        // The write failed — fall back to the server's truth rather than keep the tab
        // claiming a persistence it never got.
        void queryClient.invalidateQueries({ queryKey: queryKeys.uiState })
      })
  }

  // The thread actually ON SCREEN, so a manual refresh can bust its SERVER cache.
  //
  // Deliberately a ref fed from the rendered `selected`, NOT derived from the `:n` route param.
  // With no `:n` the tab still renders a thread — `selected` falls back to `items[0]` (see below,
  // legacy behavior) — so keying off the URL would leave the bare `/github` and `/github/prs`
  // routes, i.e. the default landing pages, refreshing nothing. A ref because this mutation is
  // defined before `selected` exists and reads it at click time, not render time.
  const openThreadRef = useRef<{ kind: 'issue' | 'pr'; number: number } | null>(null)
  // The deep-linked item the open list does not hold (#692), with the key its query lives under —
  // read when Refresh is PRESSED, so a refresh that lands after the reader moved on still writes
  // to the project it was pressed in.
  type ExactTarget = { kind: 'issue' | 'pr'; number: number; key: ReturnType<typeof queryKeys.githubItem> }
  const exactTargetRef = useRef<ExactTarget | null>(null)
  /** Ask gh for the exact item again, past the server's item cache, and file the answer under the
   *  key captured with it. Resolves `false` when the request did not land. */
  const refetchExact = (target: ExactTarget | null): Promise<boolean> =>
    target
      ? getGithubItem(target.kind, target.number, { refresh: true })
          .then((data) => {
            queryClient.setQueryData(target.key, data)
            return true
          })
          .catch(() => false)
      : Promise.resolve(true)

  const refresh = useMutation({
    mutationFn: (exact: ExactTarget | null) => {
      // Started beside the list, not after it: the item has its own cache and its own failure, and
      // a list refresh that fails must still be able to recover a failed exact fetch.
      void refetchExact(exact)
      return getGithub({ refresh: true, limit: LIST_LIMIT })
    },
    onSuccess: (data) => {
      // One list query now (#664) — patch it directly, then re-hydrate the visible checks window
      // so glyphs track the fresh rows (they carry their own ≤60 s cache server-side).
      queryClient.setQueryData(queryKeys.github({ limit: LIST_LIMIT }), data)
      void queryClient.invalidateQueries({ queryKey: queryKeys.githubChecks(checkPrNumbers) })
      // Search has no server cache; refresh the active narrow as well as the open list.
      void queryClient.invalidateQueries({ queryKey: queryKeys.githubSearch(view === 'issues' ? 'issue' : 'pr', debouncedQuery) })
      // The sidebar's qualifier searches (Review requested / Checks failing) have no server cache
      // either; a refresh that left them stale would show yesterday's hits in a fresh list.
      void queryClient.invalidateQueries({ queryKey: queryKeys.githubSearch('pr', REVIEW_QUERY) })
      void queryClient.invalidateQueries({ queryKey: queryKeys.githubSearch('pr', FAILING_QUERY) })

      // The open thread must be re-fetched with `refresh: true` (#525). Invalidating its key is
      // NOT enough, and was the bug in the first attempt: an invalidate re-requests
      // `/api/github/comments/…` WITHOUT `refresh=1`, and the route only busts `commentsCache`
      // when that param is present — so the client dutifully refetched and was handed the same
      // ≤60 s-old object. Pressing refresh has to reach `gh`, or it is theatre.
      const open = openThreadRef.current
      if (!open) {
        // No thread on screen (the unavailable branch) — nothing mounted, so clearing is free.
        void queryClient.removeQueries({ queryKey: ['github', 'comments'] })
        return
      }
      const openKey = queryKeys.githubComments(open.kind, open.number)
      // Fire-and-forget rather than awaited in `mutationFn`: a thread fetch that fails must not
      // discard an already-successful list refresh.
      void getGithubComments(open.kind, open.number, { refresh: true })
        .then((thread) => queryClient.setQueryData(openKey, thread))
        .catch(() => {
          /* the list refresh still landed; leave the thread showing what it has */
        })
      // Every OTHER cached thread is now suspect but not on screen — drop it so it refetches when
      // next opened. The open one MUST be excluded: removing a mounted query resets it to pending
      // and flashes the loading skeleton under the user.
      void queryClient.removeQueries({
        queryKey: ['github', 'comments'],
        predicate: (q) => q.queryHash !== hashKey(openKey),
      })
    },
    onError: (error) => toast(error.message, { tone: 'danger' }),
  })

  const { workflows, skillList, workflow, setWorkflow, selectedSkills, setSelectedSkills,
    engine, setEngine, queued, onQueued } = useHandToAgentState()
  const uiState = useUiState()
  const [githubListWidth, setGithubListWidth] = useState(readStoredGithubListWidth)
  const [mobileListExpanded, setMobileListExpanded] = useState(false)
  const routeRef = useRef<HTMLDivElement>(null)
  const workspaceRef = useRef<HTMLDivElement>(null)
  const changeGithubListWidth = (next: number) => {
    const width = clampGithubListWidth(next)
    setGithubListWidth(width)
    writeStoredGithubListWidth(width)
  }
  // The phone's bare `/github` is the filter screen (#622), which renders none of the workspace.
  // The geometry/wheel effect must follow the workspace's real mount lifetime: keyed on availability
  // alone it ran once against null refs there and never again after a filter pushed the list.
  const filterScreen = index && !isDesktop && rawFilterParam === null && n === undefined
  const workspaceAvailable = list.data?.available === true && !filterScreen
  useEffect(() => {
    if (!workspaceAvailable) return
    const route = routeRef.current
    const workspace = workspaceRef.current
    const main = route?.closest<HTMLElement>('[data-slot="main"]')
    if (!route || !workspace || !main) return
    const desktop = window.matchMedia('(min-width: 768px)')
    const sync = () => {
      if (!desktop.matches || main.clientHeight < 1) {
        route.style.removeProperty('--gh-workspace-height')
        return
      }
      route.style.setProperty('--gh-workspace-height', `${Math.round(main.clientHeight)}px`)
    }
    sync()
    const observer = new ResizeObserver(sync)
    observer.observe(main)
    // Keep geometry stable while docking: route wheel input, not layout/overflow.
    // Once the workspace reaches main's top, native pane scrolling takes over.
    const wheel = (event: WheelEvent) => {
      if (!desktop.matches || event.ctrlKey || !event.deltaY ||
        Math.abs(event.deltaX) > Math.abs(event.deltaY) ||
        workspace.getBoundingClientRect().top <= main.getBoundingClientRect().top + 1 ||
        !(event.target instanceof Element) || !event.target.closest('[data-slot="gh-panes"]')) return
      event.preventDefault()
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? main.clientHeight : 1
      main.scrollTop += event.deltaY * unit
    }
    workspace.addEventListener('wheel', wheel, { passive: false })
    desktop.addEventListener('change', sync)
    return () => {
      workspace.removeEventListener('wheel', wheel)
      observer.disconnect()
      desktop.removeEventListener('change', sync)
    }
  }, [workspaceAvailable])
  // List filtering (#gh-filter): free-text search (by #id or any text) + a label narrow.
  const [query, setQuery] = useState('')
  const [labelFilter, setLabelFilter] = useState<readonly string[]>([])
  const [assigneeFilter, setAssigneeFilter] = useState<readonly string[]>([])
  const [projectFilter, setProjectFilter] = useState('')
  // A refresh can revoke metadata or unlink a board. Do not leave an invisible active filter.
  const projectsPending = gh?.projectsState === 'refreshing' || gh?.projectsState === 'unavailable'
  const activeProject = projectsPending || gh?.projects?.some(p => p.id === projectFilter) ? projectFilter : ''
  useEffect(() => {
    if (gh && !projectsPending && projectFilter && !activeProject) setProjectFilter('')
  }, [gh, projectFilter, activeProject, projectsPending])
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

  // Cross-state search fallback (#730). The list tier only ever holds OPEN items, so a closed or
  // merged issue/PR is not "past the fetched window" — it was never fetched, and no amount of
  // in-memory filtering reaches it. When the local narrow comes up empty for a non-empty query we
  // ask the forge instead. Like the checks window below, these hooks must sit ABOVE the early
  // returns, so the open set is derived from the payload rather than from the post-filter `items`.
  const debouncedQuery = useDebouncedValue(query, SEARCH_DEBOUNCE_MS)
  const fullList = useMemo(
    () => (gh?.available ? (view === 'issues' ? gh.issues : gh.prs) : []),
    [gh, view],
  )
  const filterRows = useMemo(() => (filterHits ? rowsFromSearch(filterHits, fullList) : null), [filterHits, fullList])
  // A filter that cannot be applied yet (loading) or at all (blocked) must show NOTHING plus its
  // reason, never the unfiltered list under a filter's name and never a fake "no matches".
  const filterGate: { kind: 'loading' | 'blocked'; message: string } | null = (() => {
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
  })()
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
  // Evaluated against the DEBOUNCED query, not the live one: the fallback must be decided by the
  // same text the request will carry, or a fast typist fires a `gh` subprocess per keystroke.
  // Memoized because this walks the whole open set — up to `LIST_LIMIT` rows — and only its three
  // inputs can change the answer; unmemoized it re-filtered that set on every unrelated render,
  // doubling the filtering the render body below already does for the live query (#838).
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

  const allItems = openItems
  const items = filterGithubItems(allItems, { query, labels: labelFilter, ...narrow, ...(view === 'issues' ? { assignees: effectiveAssignees, projectId: activeProject } : {}) })
  const compactPreview = view === 'issues' && n !== undefined && !mobileListExpanded
  const filtering = query.trim() !== '' || labelFilter.length > 0 || (view === 'issues' && (effectiveAssignees.length > 0 || activeProject !== '')) || (filter !== null && filter !== 'all')
  // Only the settled query may contribute rows, filter metadata or error states. Disabling the
  // query does not evict its cached data, so never render data solely because it is available.
  const searchPayload = searchWanted && forgeSearch.data?.available ? forgeSearch.data : null
  // Hits are narrowed by the label filter too — it reads as "narrow whatever is on screen". They
  // also drop anything the list above already shows: `gh search` returns OPEN matches alongside
  // closed and merged ones, and during the debounce window the payload belongs to the previous
  // query text, so without this an open item could occupy both lists at once (#856). "Found on
  // GitHub" only ever means "past the open list", so an overlap is never information.
  const listedNumbers = new Set(items.map((item) => item.number))
  const metadataFailure = view === 'issues' && searchPayload
    ? activeProject && searchPayload.items.some(item => item.projectIds === undefined)
      ? searchPayload.projectsReason ?? 'Project board data is incomplete. Refresh to try again.'
      : effectiveAssignees.length && searchPayload.items.some(item => item.assignees === undefined)
        ? 'Assignee data is incomplete. Refresh to try again.'
        : null
    : null
  const searchHits = searchPayload && !metadataFailure
    ? filterGithubItems(searchPayload.items, { labels: labelFilter, ...narrow,
        ...(view === 'issues' ? { assignees: effectiveAssignees, projectId: activeProject } : {}),
      }).filter(
        (item) => !listedNumbers.has(item.number),
      )
    : []

  // Retain one explicitly selected search result independently of visible search rows. Query
  // edits and filters can hide those rows; the URL still identifies the detail being read.
  // Scope/kind/number checks prevent a retained item leaking across projects or tabs.
  const scope = queryKeys.github()[0]
  const selectedNumber = n === undefined ? null : Number.parseInt(n, 10)
  const selectedSearchItem = !filterGate && forgeSearch.data?.available
    ? forgeSearch.data.items.find(item => item.number === selectedNumber)
    : undefined
  // A qualifier-selected PR (Review requested / Checks failing) that the open list does not hold is
  // retained exactly like a text-search hit: clearing the filter or a refresh that drops it from
  // the results must not take the detail pane away from a URL that still names it.
  const selectedFilterItem = filterRows && selectedNumber !== null && !fullList.some(item => item.number === selectedNumber)
    ? filterRows.find(item => item.number === selectedNumber)
    : undefined
  const retainCandidate = selectedSearchItem ?? selectedFilterItem
  const [retainedDetail, setRetainedDetail] = useState<{ scope: string; view: GithubView; item: GithubItem } | null>(null)
  useEffect(() => {
    if (retainCandidate) setRetainedDetail({ scope, view, item: retainCandidate })
  }, [scope, view, retainCandidate])
  const remoteDetail = retainCandidate ?? (
    retainedDetail?.scope === scope && retainedDetail.view === view && retainedDetail.item.number === selectedNumber
      ? retainedDetail.item : null
  )
  // A URL can name an item none of those hold — a closed or merged one, opened from a task tab's
  // "Files changed" or a pasted link (#692). Once the list has answered, ask GitHub for that
  // number alone, rather than calling a real item "Not found". Never for an item already held.
  const itemKind = view === 'issues' ? 'issue' : 'pr'
  const exactWanted =
    gh?.available === true &&
    selectedNumber !== null &&
    Number.isSafeInteger(selectedNumber) &&
    selectedNumber > 0 &&
    !fullList.some((item) => item.number === selectedNumber) &&
    !filterRows?.some((item) => item.number === selectedNumber) &&
    remoteDetail === null
  const exactItem = useGithubItem(itemKind, selectedNumber ?? 0, exactWanted)
  const exactDetail =
    exactWanted && exactItem.data?.available && exactItem.data.item?.kind === itemKind ? exactItem.data.item : null
  exactTargetRef.current =
    exactWanted && selectedNumber !== null
      ? { kind: itemKind, number: selectedNumber, key: queryKeys.githubItem(itemKind, selectedNumber) }
      : null
  const [retryingExact, setRetryingExact] = useState(false)
  const retryExact = () => {
    setRetryingExact(true)
    void refetchExact(exactTargetRef.current).then((landed) => {
      setRetryingExact(false)
      if (!landed) toast(`Could not reach GitHub for #${selectedNumber}`, { tone: 'danger' })
    })
  }

  // Pin the selected detail and visible search hits before filling from the open list. The
  // shared hook retains its project scope, cache and view lifetime; every request stays bounded.
  const checkPrNumbers = (() => {
    if (!gh?.available || view !== 'prs') return []
    const nums = new Set<number>()
    if (selectedNumber !== null && Number.isInteger(selectedNumber)) nums.add(selectedNumber)
    for (const pr of [...searchHits, ...openItems, ...gh.prs]) {
      if (nums.size >= CHECKS_WINDOW) break
      nums.add(pr.number)
    }
    return [...nums]
  })()
  const checksQuery = useGithubChecks(checkPrNumbers, view === 'prs')
  const checksMap = checksQuery.data?.available ? checksQuery.data.checks : undefined

  // The bare `/github` restores the remembered sub-tab (#417). It lives HERE rather than in a
  // wrapper component so `/github` and `/github/issues/:n` render the same element type: React
  // reconciles by type, so a wrapper made the hop between them a full remount, resetting `query`
  // to '' — and with the query gone, `searchHits` is empty and the cross-state item the user just
  // clicked resolves to "not among the open issues". `/github/prs` and `/github/prs/:n` never had
  // the bug precisely because they already shared one element type. Below the hooks, like every
  // other early return in this component.
  if (index && isDesktop && rawFilterParam === null && uiState.data?.githubView === 'prs') {
    return <Navigate to="/github/prs" replace />
  }

  if (!gh) {
    if (list.isError) {
      return (
        <div data-route="github" className="flex min-h-full flex-col">
          <CenteredState
            icon={<TriangleAlertIcon size={16} />}
            tone="danger"
            title="Could not load GitHub"
            subtitle={list.error.message}
          />
        </div>
      )
    }
    return <GithubLoading />
  }

  // No thread is mounted on the unavailable path — keep the ref honest rather than stale.
  openThreadRef.current = null

  // On a phone the bare `/github` is the filter screen (#622): the sidebar's list as its own
  // screen. Picking a row pushes the list with an explicit `?filter=`, which this skips.
  if (filterScreen && gh.available) {
    return <GithubFilterScreen onRefresh={() => refresh.mutate(exactTargetRef.current)} refreshing={refresh.isPending} />
  }

  if (!gh.available) {
    return (
      <div data-route="github" className="flex min-h-full flex-col">
        <CenteredState
          icon={<GithubIcon />}
          tone="neutral"
          title="GitHub is unavailable here"
          subtitle={gh.reason ?? 'unknown reason'}
          actions={
            <Button
              variant="outline"
              data-action="gh-retry"
              disabled={refresh.isPending}
              onClick={() => refresh.mutate(exactTargetRef.current)}
            >
              Try again
            </Button>
          }
        >
          <p className="text-xs leading-relaxed text-soft-foreground">
            The tab needs the <span className="font-mono">gh</span> CLI, logged in (
            <span className="font-mono">gh auth login</span>), and a repo with a GitHub remote.
            Everything else in cezar works without it.
          </p>
        </CenteredState>
      </div>
    )
  }

  // "A search is coming or running" — the debounce window counts. Without it, the moment between
  // the last keystroke and the request firing would render the definitive "nothing anywhere",
  // which is the same lie #730 set out to remove, just half a second long.
  const searching =
    (query.trim() !== '' && !querySettled) ||
    (searchWanted && forgeSearch.isPending)
  // A closed item often wears labels no open one does; its own colors win nothing over the repo
  // map, they only fill the gaps.
  const labelColors = { ...(searchPayload?.labelColors ?? {}), ...(gh.labelColors ?? {}) }
  const labelOptions = allLabels([...allItems, ...fullList, ...(searchPayload?.items ?? [])])
  const number = n === undefined ? null : Number.parseInt(n, 10)
  // No URL selection → the first item, like the legacy tab (rendered, not navigated-to). The
  // selection may point at an item outside the current filter — keep resolving it from the full
  // list so a deep link to #N still opens even while a filter is active. Search hits are the last
  // resort so a found-on-GitHub row is openable in the detail pane like any other.
  const selected =
    number === null
      ? (items[0] ?? searchHits[0] ?? null)
      : (fullList.find((item) => item.number === number) ??
        filterRows?.find((item) => item.number === number) ??
        remoteDetail ??
        exactDetail ??
        null)
  // Feed the refresh mutation the thread that is genuinely rendered — including the no-`:n`
  // fallback to items[0], which is what the bare /github and /github/prs routes show.
  openThreadRef.current = selected ? { kind: selected.kind, number: selected.number } : null

  // Every link out of a list keeps its filter, so Back and the detail tabs return to the same list.
  const linkFilter = rawFilterParam === null ? null : activeFilter
  // On a phone an unfiltered issue detail must still go Back to a LIST: the bare `/github` there is
  // the filter screen, so it names `all` explicitly.
  const listPath = githubFilterPath(view, linkFilter ?? (view === 'issues' && !isDesktop ? 'all' : null))

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
  // What the empty list has to say for itself, or `null` when the "Found on GitHub" section below
  // already says it. Resolved BEFORE the wrapper rather than inside it (#838): as the contents of
  // a padded `<div>`, a null verdict still rendered the padding, leaving an empty ~2rem gap above
  // that heading. The search-hits case stays below `searching` in the chain on purpose — while a
  // new query is in flight over stale hits, the spinner is the honest thing to show.
  const emptyState = filterGate ? (
    <p role="status" className="flex items-center gap-1.5" data-slot="gh-filter-gate" data-kind={filterGate.kind}>
      {filterGate.kind === 'loading' ? <LoaderCircleIcon aria-hidden="true" className="size-3.5 motion-safe:animate-spin" /> : null}
      {filterGate.message}
    </p>
  ) : !filtering ? (
    <p>No open {view === 'issues' ? 'issues' : 'pull requests'}.</p>
  ) : searching ? (
    <p className="flex items-center gap-1.5">
      <LoaderCircleIcon aria-hidden="true" className="size-3.5 motion-safe:animate-spin" />
      Searching GitHub for “{query.trim()}”…
    </p>
  ) : searchFailed ? (searchHits.length > 0 ? (
    <p role="status">Showing previous results. GitHub could not be refreshed: {searchFailureReason}. Use Refresh to try again.</p>
  ) : items.length > 0 ? (
    <p>GitHub could not be searched: {searchFailureReason}.</p>
  ) : (
    <p>
      No open {view === 'issues' ? 'issues' : 'pull requests'} match your filter, and GitHub could
      not be searched: {searchFailureReason}.
    </p>
  )) : metadataFailure ? (
    <p role="status">Cannot apply the selected filters to GitHub results: {metadataFailure}</p>
  ) : searchHits.length > 0 ? null : searchPayload?.truncated ? (
    <p>No matches within GitHub’s first matches. Narrow your search to check more specific results.</p>
  ) : searchPayload && items.length > 0 ? (
    <p>No additional {view === 'issues' ? 'issues' : 'pull requests'} match your filter on GitHub.</p>
  ) : searchPayload ? (
    // Earned, not assumed: only a search that actually answered for THIS narrow licenses the
    // cross-state verdict. A label-only filter never asks the forge at all (`shouldSearchForge`
    // requires a non-empty query), so claiming "closed or merged" there would be the same
    // unfounded certainty in a different costume.
    <p>
      No {view === 'issues' ? 'issues' : 'pull requests'} match your filter — open, closed or
      merged.
    </p>
  ) : (
    <p>No open {view === 'issues' ? 'issues' : 'pull requests'} match your filter.</p>
  )

  return (
    // Desktop: the title/repo line stays in document flow so `main` can scroll it away.
    // The route ends with one scrollport-height workspace, with no bottom padding:
    // at maximum page scroll its tabs align with main's top without sticky overlap.
    // Phone stays stacked document-flow. (#523)
    <div ref={routeRef} data-route="github" className="flex min-h-full flex-col gap-3 px-[18px] pt-[18px] pb-[calc(90px+env(safe-area-inset-bottom))] md:gap-[22px] md:px-7 md:pt-4 md:pb-4">
        <div data-slot="gh-masthead" className="flex min-w-0 shrink-0 flex-col gap-1 md:flex-row md:items-baseline md:gap-3">
          {/* The board's desktop title is the list on screen ("Issues · No task yet"), 15px; a phone keeps "GitHub". */}
          <h1 className="text-2xl font-semibold tracking-tight md:text-[15px] md:tracking-normal">
            {isDesktop ? `${view === 'issues' ? 'Issues' : 'Pull requests'} · ${ACTIVE_FILTER_LABEL[activeFilter]}` : 'GitHub'}
          </h1>
          {rawFilterParam !== null && n === undefined ? (
            <div data-slot="gh-filter-context" className="flex min-w-0 items-center gap-3 md:hidden">
              <Link to="/github" data-slot="gh-back-filters" className="inline-flex min-h-11 items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground">
                <ArrowLeftIcon size={16} aria-hidden="true" className="size-3.5" />
                Back to filters
              </Link>
              {activeFilter !== 'all' ? (
                <span data-slot="gh-active-filter" className="truncate text-xs text-soft-foreground">
                  {[...ISSUE_ROWS, ...PR_ROWS].find((row) => row.id === activeFilter)?.label}
                </span>
              ) : null}
            </div>
          ) : null}
          {gh.repo ? (
            <span className="min-w-0 truncate text-[13px] text-muted-foreground md:text-[11px] md:text-soft-foreground">
              <span data-slot="gh-repo">{gh.repo}</span>
              <span data-slot="gh-synced"> · {gh.syncedAt ? `Synced ${shortAge(gh.syncedAt)} ago` : 'Not synced yet'}</span>
            </span>
          ) : null}
        </div>
        <div ref={workspaceRef} data-slot="gh-workspace" className="flex min-h-0 min-w-0 flex-1 flex-col gap-3 md:h-[calc(var(--gh-workspace-height,calc(100dvh-4rem))-1rem)] md:flex-none md:gap-[22px]">
        <header
          data-slot="gh-header"
          className="flex shrink-0 flex-col gap-3 bg-background md:gap-[22px]"
        >
          <div data-slot="gh-tabs" className="flex min-h-11 flex-wrap items-center gap-3">
            {/* On a phone the bare `/github` is the filter screen, so the Issues tab names `all`. */}
            <TabLink to={isDesktop ? '/github' : '/github?filter=all'} active={view === 'issues'} onClick={() => saveGithubView('issues')}>
              Issues · {countLabel(gh.issues.length)}
            </TabLink>
            <TabLink to="/github/prs" active={view === 'prs'} onClick={() => saveGithubView('prs')}>
              Pull requests · {countLabel(gh.prs.length)}
            </TabLink>
            {automationsAvailable ? (
              <Link
                to="/automations/new"
                className="gh-utility"
              >
                Set up automations
              </Link>
            ) : null}
            <button
              type="button"
              data-slot="gh-refresh"
              title="Refresh from GitHub"
              disabled={refresh.isPending}
              onClick={() => refresh.mutate(exactTargetRef.current)}
              className="gh-utility"
            >
              <RefreshCwIcon size={16}
                aria-hidden="true"
                className={cn('size-3.5', refresh.isPending && 'motion-safe:animate-spin')}
              />
              Refresh
            </button>
          </div>
          <div data-slot="gh-filter-toolbar" className="flex flex-wrap items-center gap-2.5">
            <div className="relative min-w-0 basis-full md:flex-1 md:basis-auto">
              <SearchIcon size={16}
                aria-hidden="true"
                className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-soft-foreground"
              />
              <input
                type="search"
                data-slot="gh-search"
                aria-label={`Search ${view}`}
                placeholder={view === 'issues' ? 'Filter issues…' : 'Filter pull requests…'}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                className="min-h-11 w-full rounded-md border border-input bg-card py-1 pr-2 pl-7 text-[13px] outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
              />
            </div>
            <LabelFilter
              options={labelOptions}
              colors={labelColors}
              selected={labelFilter}
              onChange={setLabelFilter}
            />
          {view === 'issues' ? <IssueFilters data={{ ...gh, issues: [...gh.issues, ...(searchPayload?.items ?? [])] }} assignees={effectiveAssignees} projectId={activeProject}
            onAssigneesChange={changeAssignees} onProjectChange={setProjectFilter} /> : null}
            <button type="button" disabled={!filtering} className="min-h-11 min-w-11 rounded-md border border-border bg-card px-4 text-xs disabled:opacity-50" onClick={clearFilters}>Clear filters</button>
          </div>
        </header>
      <div
        data-slot="gh-panes"
        className="flex min-h-0 min-w-0 flex-1 flex-col items-start gap-[22px] md:flex-row md:items-stretch md:overflow-hidden"
      >
      {/* Issue list and detail stack on mobile. A selected PR has a full-width review surface. */}
      <section
        data-slot="gh-list"
        data-mobile-preview={compactPreview || undefined}
        style={{ '--github-list-width': `${githubListWidth}px` } as CSSProperties}
        className="relative flex w-full min-h-0 min-w-0 flex-col rounded-lg border border-border bg-card p-3 md:w-[var(--github-list-width)] md:shrink-0 md:overflow-x-hidden md:overflow-y-auto"
      >


        {items.length === 0 ? (
          // Nothing in the OPEN list matched. Rather than the old flat "no match" — which was a
          // lie whenever the item existed but was closed or merged (#730) — report what the forge
          // search found, is finding, or could not do. No verdict to report (the hits below are
          // the answer) means no wrapper at all, so its padding cannot leave a gap.
          emptyState && (
            <div data-slot="gh-empty" className="px-4 py-4 text-sm text-soft-foreground">
              {emptyState}
            </div>
          )
        ) : (
          <ul data-slot="gh-rows" className="flex flex-col gap-1">
            {items.map((item, index) => (
              <GithubRow
                key={item.url}
                item={item}
                view={view}
                filter={linkFilter}
                colors={labelColors}
                active={selected?.url === item.url}
                compactHidden={compactPreview && index >= 2 && selected?.url !== item.url}
                queued={queued.has(item.url)}
                checks={item.kind === 'pr' ? checksMap?.[item.number] ?? item.checks : item.checks}
              />
            ))}
          </ul>
        )}

        {backedQuery !== null && filterSearch.data?.available && filterSearch.data.truncated ? (
          <div data-slot="gh-filter-note" role="status" className="px-4 py-3 text-xs text-soft-foreground">
            Showing the first {filterSearch.data.items.length} matches from GitHub search; more may exist.
          </div>
        ) : null}

        {view === 'issues' && n !== undefined && items.length > 2 ? (
          <Button
            variant="outline"
            className="mt-2 self-start md:hidden"
            data-slot="gh-expand-list"
            aria-expanded={mobileListExpanded}
            onClick={() => setMobileListExpanded(expanded => !expanded)}
          >
            {mobileListExpanded ? 'Show fewer issues' : `View all ${items.length} issues`}
          </Button>
        ) : null}

        {items.length > 0 && searchWanted && emptyState ? (
          <div data-slot="gh-search-status" role="status" className="px-4 py-4 text-sm text-soft-foreground">
            {emptyState}
          </div>
        ) : null}

        {/* Cross-state hits (#730) — rendered under their own heading so it is never ambiguous
            whether a row came from the open list or from a search that reached past it. */}
        {searchHits.length > 0 ? (
          <div data-slot="gh-search-hits">
            <p className="px-4 pt-2 pb-1 text-[11px] font-medium tracking-wide text-soft-foreground uppercase">
              Found on GitHub{searchPayload?.truncated ? ' (first matches)' : ''}
            </p>
            <ul className="flex flex-col gap-0.5 px-2 pb-2">
              {searchHits.map((item) => (
                <GithubRow
                  key={item.url}
                  item={item}
                  view={view}
                  filter={linkFilter}
                  colors={labelColors}
                  active={selected?.url === item.url}
                  queued={queued.has(item.url)}
                  checks={item.kind === 'pr' ? checksMap?.[item.number] ?? item.checks : item.checks}
                />
              ))}
            </ul>
          </div>
        ) : null}
        <GithubListResizeHandle width={githubListWidth} onWidthChange={changeGithubListWidth} />
      </section>

      {/* Detail pane. Hidden below md until an item is in the URL. */}
      <section
        data-slot="gh-detail"
        className={cn(
          'w-full min-w-0 min-h-0 flex-1 flex-col rounded-lg border border-border bg-card md:overflow-y-auto',
          n === undefined ? 'hidden md:flex' : 'flex',
        )}
      >
        {selected ? (
          <GithubItemDetail
            item={selected}
            backLink={{ to: listPath }}
            subNav={{ filter: linkFilter, changes }}
            onRunAgent={focusHandToAgentPrompt}
            colors={labelColors}
            checks={selected.kind === 'pr' ? checksMap?.[selected.number] ?? selected.checks : selected.checks}
          >
            <HandToAgent
              key={selected.url}
              item={selected}
              workflows={workflows.data?.workflows ?? []}
              skills={skillList}
              workflow={workflow}
              onWorkflowChange={setWorkflow}
              selectedSkills={selectedSkills}
              onSkillsChange={setSelectedSkills}
              engine={engine}
              onEngineChange={setEngine}
              queuedRunId={queued.get(selected.url) ?? null}
              onQueued={onQueued}
            />
          </GithubItemDetail>
        ) : exactWanted && exactItem.isPending ? (
          <div data-slot="gh-detail-loading" className="flex min-h-full flex-1 flex-col">
            <CenteredState
              icon={<LoaderCircleIcon className="motion-safe:animate-spin" />}
              tone="neutral"
              heading="h2"
              title={`Loading #${selectedNumber}…`}
              subtitle="It is not among the open items, so the tab is asking GitHub for it."
            />
          </div>
        ) : exactWanted && (exactItem.isError || exactItem.data?.available === false) ? (
          <CenteredState
            icon={<TriangleAlertIcon size={16} />}
            tone={exactItem.isError ? 'danger' : 'neutral'}
            heading="h2"
            title={`Could not load #${selectedNumber}`}
            subtitle={
              exactItem.data?.available === false
                ? exactItem.data.reason
                : exactItem.error instanceof Error
                  ? exactItem.error.message
                  : 'The request failed.'
            }
            actions={
              <Button variant="outline" disabled={retryingExact} onClick={retryExact}>
                Retry
              </Button>
            }
          />
        ) : (
          <CenteredState
            icon={view === 'issues' ? <CircleDotIcon size={16} /> : <GitPullRequestIcon size={16} />}
            tone="neutral"
            heading="h2"
            title={number === null ? 'Nothing selected' : 'Not found'}
            subtitle={
              number === null
                ? `No open ${view === 'issues' ? 'issues' : 'pull requests'} to show.`
                : // Since #730 a closed or merged item IS reachable — type its number into the
                  // search box and the tab asks GitHub directly — so the honest advice is to
                  // search, not the old "it may be closed" shrug.
                  `#${number} is not among the open ${view === 'issues' ? 'issues' : 'pull requests'}. Search for ${number} above to look it up on GitHub, closed and merged included.`
            }
          />
        )}
      </section>
      </div>
      </div>
    </div>
  )
}

/** The merge box's conflict action: bring the hand-to-agent prompt below it into view. */
function focusHandToAgentPrompt() {
  const prompt = document.querySelector<HTMLTextAreaElement>('[data-slot="gh-detail-inner"] [data-slot="gh-custom-prompt"]')
  prompt?.scrollIntoView({ block: 'center' })
  prompt?.focus({ preventScroll: true })
}

/** The exact open count from the single fast fetch — with a `+` only when it hit the list cap, so
 *  a repo with more than `LIST_LIMIT` open items reads honestly as "at least this many". */
function countLabel(count: number): string {
  return `${count}${count >= LIST_LIMIT ? '+' : ''}`
}

function GithubRow({
  item,
  view,
  filter,
  colors,
  active,
  compactHidden,
  queued,
  checks,
}: {
  item: GithubItem
  view: GithubView
  /** The list's `?filter=`, carried into the detail URL so Back returns to the same list. */
  filter: GithubFilter | null
  colors: Record<string, string>
  active: boolean
  compactHidden?: boolean
  queued: boolean
  /** Resolved checks glyph — the lazily-hydrated value overrides the list's `null` (#664). */
  checks?: GithubItem['checks']
}) {
  const Icon = item.kind === 'issue' ? CircleDotIcon : GitPullRequestIcon
  const queryClient = useQueryClient()

  // Warm the thread on hover/focus (#664) so opening the row is usually instant — best-effort,
  // deduped by React Query, and it re-uses the mounted detail's exact query key/staleTime.
  const prefetchThread = () => {
    void queryClient.prefetchQuery({
      queryKey: queryKeys.githubComments(item.kind, item.number),
      queryFn: ({ signal }) => getGithubComments(item.kind, item.number, {}, { signal }),
      staleTime: 60_000,
    })
  }

  // Drag an issue/PR row into the composer — it prefills the same prompt "Run agent on this
  // issue" uses (legacy parity); a textarea accepts the text/plain payload natively.
  const onDragStart = (event: DragEvent) => {
    try {
      event.dataTransfer.setData('text/plain', githubTaskPrompt(item))
      event.dataTransfer.effectAllowed = 'copy'
    } catch {
      // older engines — the drag just won't carry the prompt
    }
  }

  return (
    <li data-compact-hidden={compactHidden || undefined}>
      <Link
        to={githubFilterPath(view, filter, item.number)}
        draggable
        onDragStart={onDragStart}
        onMouseEnter={prefetchThread}
        onFocus={prefetchThread}
        data-slot="gh-row"
        data-number={item.number}
        data-kind={item.kind}
        aria-current={active ? 'page' : undefined}
        title="Drag into the composer to prefill a task"
        className={cn(
          'flex flex-col gap-2 rounded-md px-3 py-4 transition-colors hover:bg-muted',
          active && 'bg-accent-strong/10 text-accent-text',
        )}
      >
        <span className="flex min-w-0 items-start gap-2 md:items-center">
          <Icon
            aria-hidden="true"
            className={cn('mt-0.5 size-3.5 shrink-0 md:mt-0', item.kind === 'issue' ? 'text-success' : 'text-accent-icon')}
          />
          <span className={cn('line-clamp-2 min-w-0 text-[13px] font-medium md:block md:truncate', active && 'font-semibold')}>
            {item.title}
          </span>
        </span>
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1 pl-[22px] font-mono text-[11px] text-muted-foreground md:flex-nowrap md:gap-y-0">
          <span>#{item.number}</span>
          <span className="max-w-full shrink-0 truncate md:min-w-0 md:shrink">{item.author}</span>
          <span>{shortAge(item.createdAt)}</span>
          <CommentCount count={item.comments} />
          {checks ? <ChecksGlyph checks={checks} /> : null}
          {queued ? (
            <span data-slot="gh-queued-flag" className="font-sans font-medium text-accent-text">
              ↗ run queued
            </span>
          ) : null}
        </span>
        {item.labels.length > 0 ? (
          <span data-slot="gh-row-labels" className="flex flex-wrap gap-1 pl-[22px]">
            {item.labels.map((label) => (
              <LabelChip key={label} label={label} color={colors[label]} plain />
            ))}
          </span>
        ) : null}
      </Link>
    </li>
  )
}

/** The label narrow: a searchable multi-select of the labels present in the current list. Selected
 *  labels AND together (GitHub semantics), handled by `filterGithubItems`. */
function LabelFilter({
  options,
  colors,
  selected,
  onChange,
}: {
  options: readonly string[]
  colors: Record<string, string>
  selected: readonly string[]
  onChange: (labels: string[]) => void
}) {
  const [open, setOpen] = useState(false)
  const toggle = (label: string) =>
    onChange(selected.includes(label) ? selected.filter((l) => l !== label) : [...selected, label])
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-slot="gh-label-filter"
          disabled={options.length === 0}
          className={cn(
            'flex min-h-11 min-w-11 shrink-0 items-center gap-1 rounded-md border border-input bg-card px-2 py-1 text-[12px] font-medium text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50',
            selected.length > 0 && 'border-accent-strong/60 text-foreground',
          )}
        >
          {selected.length > 0 ? `Labels · ${selected.length}` : 'Labels'}
          <ChevronDownIcon size={12} aria-hidden="true" className="size-3 shrink-0 text-soft-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={6} className="w-60 p-0">
        <Command>
          <CommandInput placeholder="Filter labels…" />
          <CommandList className="max-h-[min(16rem,calc(var(--radix-popover-content-available-height)-3rem))]">
            <CommandEmpty>No labels.</CommandEmpty>
            {selected.length > 0 ? (
              <CommandItem value="__clear__" onSelect={() => onChange([])} className="min-h-11 text-soft-foreground">
                Clear {selected.length} filter{selected.length > 1 ? 's' : ''}
              </CommandItem>
            ) : null}
            {options.map((label) => {
              const on = selected.includes(label)
              return (
                <CommandItem key={label} value={label} onSelect={() => toggle(label)} className="min-h-11">
                  <span
                    aria-hidden="true"
                    className="size-2.5 shrink-0 rounded-full border"
                    style={labelChipStyle(colors[label])}
                  />
                  <span className="min-w-0 flex-1 truncate">{label}</span>
                  {on ? <CheckIcon size={16} aria-hidden="true" className="size-3.5 shrink-0 text-link-foreground" /> : null}
                </CommandItem>
              )
            })}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
