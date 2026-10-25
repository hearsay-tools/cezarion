import './task-lists.css'
import { useMutation, useQueryClient, type InfiniteData } from '@tanstack/react-query'
import { CheckCheckIcon, ChevronsLeftIcon, ChevronsRightIcon, Clock3Icon, CoinsIcon, DollarSignIcon, ListChecksIcon, LinkIcon, MemoryStickIcon, MoreHorizontalIcon, PencilIcon, SearchXIcon } from 'lucide-react'
import { ArchiveIcon, CpuIcon, FileDiffIcon, GitBranchIcon, PlusIcon, SearchIcon, WorkflowIcon } from '@/components/design-icons'
import * as React from 'react'
import { Link, useNavigate } from '@/lib/project-router'

import { archiveFinished, markAllRunsSeen, patchRun } from '@/api/client'
import { useRunUsage } from '@/api/global-events'
import { queryKeys, useArchivedRuns, useAutomationNames, useHealth, usePinRun, useProjects, useProjectRepoBase, useReferenceProjectId, useRuns } from '@/api/queries'
import type { ArchivedRunsResponse, RunSummary } from '@open-mercato/cezar-api-client'
import { CenteredState } from '@/components/centered-state'
import { DiffStatLabel } from '@/components/diff-stat'
import { DirectionalUsage, directionalUsageLabel } from '@/components/directional-usage'
import { TitleEditInput, useTitleEditor } from '@/components/editable-title'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Pill } from '@/components/pill'
import { PinToggle } from '@/components/pin-toggle'
import { TaskReferenceChip } from '@/components/reference-conflict-action'
import { ReferenceStatusProvider } from '@/components/reference-status'
import { StatusDot } from '@/components/status-dot'
import { StatusGroupSection, TaskOriginLine, TaskOriginRow, TaskPreview } from '@/components/task-status-groups'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { toast } from '@/components/ui/toaster'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { deriveAttention } from '@/lib/attention'
import { shortAge } from '@/lib/format'
import { isReadDoneItem, isUnread, unreadDoneCount, unreadMarkerTone } from '@/lib/read-state'
import {
  isColumnExpanded,
  normalizeExpandedColumns,
  taskColumnsForCapabilities,
  type NormalizedExpandedColumns,
  type TaskColumnDefinition,
  type TaskColumnIcon,
  type TaskColumnId,
} from '@/lib/task-columns'
import { ARCHIVED_WINDOW, listCounts, runTitle, withArchivedPages, type BucketLabel, type ListView } from '@/lib/task-groups'
import {
  groupMembers,
  groupProjectRuns,
  groupTone,
  matchesOrigin,
  originAutomationFlag,
  originCounts,
  parseOrigin,
  rowTasks,
  type TaskOrigin,
  type TaskStatusGroup,
} from '@/lib/task-origin'
import { useSearchParamsWriter, type SearchParamsUpdate } from '@/lib/use-search-params-writer'
import { useTaskListFolds } from '@/lib/use-task-list-folds'
import {
  filterRuns,
  finishedRunCount,
  formatCost,
  scheduledResume,
  taskReference,
  usageCells,
  workflowLabel,
  type UsageCell,
} from '@/lib/tasks-table'
import { usageMetricVisibility } from '@/lib/token-metrics'
import { useTaskTableColumns } from '@/lib/use-task-table-columns'
import { useNow } from '@/lib/use-now'
import { cn } from '@/lib/utils'

/** Archived runs older than the run list's window, a page at a time (#864). */
export type ArchivedPages = {
  runs: readonly RunSummary[]
  /** The search text these pages answer (`''` for the plain pages), or null while they are a
   *  previous text's pages kept on screen until the next ones load. */
  query: string | null
  /** Whether the server has an older page. */
  hasMore: boolean
  loading: boolean
  onLoadMore: () => void
  /** The last page request failed: the tab still shows what it has and offers a retry. */
  failed?: boolean
  /** Whether the unfiltered archive has an older page, whatever text these pages answer; absent
   *  while no unfiltered page has loaded. */
  plainHasMore?: boolean
}

/**
 * The Tasks overview — the table that IS the home at `/` (spec, "Task list & table", per PR
 * #392: the Tasks nav always lands here, there is no list/table presentation toggle). The
 * Active/Archived tabs in this header are this table's own, independent of the sidebar.
 *
 * Presentational: sorting, search, queue numbers, usage-cell decisions and the compare strip
 * all come from the pure modules (`lib/task-groups.ts`, `lib/tasks-table.ts`,
 * `lib/attention.ts`). What lives here is markup, the router, and the local search text.
 *
 * Below `md` the table becomes a stacked card list (the New task FAB is the shell's, #621) — same rows, same order,
 * same data, only the framing changes (mockup `tasks-home.html`, mobile section).
 */
export function TasksOverview({
  runs,
  view,
  onViewChange,
  onArchiveFinished,
  archivePending = false,
  onMarkAllRead,
  onRename,
  onTogglePin,
  now = Date.now(),
  showTokens = true,
  showCost = true,
  expandedColumns = normalizeExpandedColumns(undefined),
  onToggleColumn = () => undefined,
  columnsPending = false,
  projectName,
  error,
  onRetry,
  archivedPages,
  archivedTotal,
  onArchivedSearch,
  origin: originProp,
  onOriginChange,
  urlQuery = '',
  onQueryChange,
  foldScope = 'project',
  automationName = () => undefined,
}: {
  /** Undefined while `/api/runs` has not answered: the header renders, the body stays empty —
   *  an empty state before we know there are no runs would be a lie. */
  runs: RunSummary[] | undefined
  view: ListView
  onViewChange: (view: ListView) => void
  archivePending?: boolean
  /** `automation` is the origin's flag (`originAutomationFlag`): the sweep takes only that origin. */
  onArchiveFinished: (automation?: boolean) => void
  /** "Mark all read" (#unread-done-items) — stamps every unread finished run of the origin. */
  onMarkAllRead: (automation?: boolean) => void
  /** Inline rename from the table's Task cell (spec step 15) — the route wires this to
   *  `PATCH /api/runs/:id`, the same flow as the run header's pencil. */
  onRename: (id: string, title: string) => void
  /** Pin/unpin one task (#935). Pinned rows sort to the top of the table — `sortRuns` does that
   *  for every surface at once — so the row's own control is also the only thing on this page
   *  that explains why one is up there. */
  onTogglePin?: (run: RunSummary, pinned: boolean) => void
  /** Injected so the ages are not racing the clock in tests. */
  now?: number
  /** Presentation capability; defaults visible for older health responses and direct renders. */
  showTokens?: boolean
  showCost?: boolean
  /** The current registered project; omitted until the registry is available. */
  projectName?: string
  /** Workspace-global desktop column choices; absent ids use registry defaults. */
  expandedColumns?: NormalizedExpandedColumns
  onToggleColumn?: (id: TaskColumnId) => void
  /** Prevent a shallow write before the authoritative workspace state can preserve siblings. */
  columnsPending?: boolean
  error?: string
  onRetry?: () => void
  /** Archived runs older than the list's window (#864), from `GET /run-summaries/archived`: for
   *  the search text when there is one, otherwise the newest pages. */
  archivedPages?: ArchivedPages
  /** Every archived task, when the server has counted them; until then a full window reads `200+`. */
  archivedTotal?: number
  /** The search text as typed, so the route can ask the server for archived matches too. */
  onArchivedSearch?: (needle: string) => void
  /** All / Direct tasks / Automations (hearsay-tools/cezarion#1616), held by the route in the URL.
   *  Absent, the page keeps its own, starting at All. */
  origin?: TaskOrigin
  onOriginChange?: (origin: TaskOrigin) => void
  /** The search text in the URL, and the setter that writes the typed text back. */
  urlQuery?: string
  onQueryChange?: TasksQueryWriter
  /** Which saved fold preferences this list reads: `project:<id>`. */
  foldScope?: string
  /** An automation's display name, or undefined when it is unknown here. */
  automationName?: (automationId: string) => string | undefined
}) {
  const [query, setQuery] = useUrlQuery(urlQuery, onQueryChange)
  React.useEffect(() => { onArchivedSearch?.(query.trim()) }, [onArchivedSearch, query])
  const [origin, setOrigin] = useOriginOrOwn(originProp, onOriginChange)
  const [detailedTable, setDetailedTable] = React.useState(false)
  const headerRef = React.useRef<HTMLElement>(null)
  const archiveSelected = React.useRef(false)
  const all = runs ?? []
  const derived = useProjectTaskGroups({ all, view, query, origin, archivedPages, archivedTotal, automationName })
  const { groups, needle } = derived
  const columns = taskColumnsForCapabilities({ tokens: showTokens, cost: showCost })
  // A search shows every group holding a match, folded or not, without saving that choice.
  const revealed = new Set<BucketLabel>(needle ? groups.map((group) => group.label) : [])
  const folds = useTaskListFolds(foldScope, view, revealed)
  // The archived view withholds the pin, the same call `runActionFlags` makes for the thread
  // header (`pin: !run.archived`): `sortRuns` skips the pin comparator there and `bucketOf`
  // answers `Archived` before it ever reads `run.pinned`, so the button would be an action with
  // nowhere to show its result — and one that outlives the view, since un-archiving would then
  // drop the task at the top of the active list by a click that looked like it did nothing.
  const pinToggle = view === 'archived' ? undefined : onTogglePin

  return (
    <div data-route="tasks" data-presentation={detailedTable ? 'resources' : 'summary'} className="flex min-h-full flex-col gap-[22px] px-[18px] pt-6 pb-[calc(90px+env(safe-area-inset-bottom))] md:p-9">
      {/* One set of search/view controls across breakpoints keeps query and selection intact.
          Mobile places search above the list filters; the shell already supplies its title. */}
      <header ref={headerRef} className="flex shrink-0 flex-col gap-[22px]">
        <TasksHeading projectName={projectName} detailedTable={detailedTable} />
        <div className="flex gap-6 border-b border-border">
          <OverviewTab view="active" current={view} onSelect={onViewChange} count={derived.activeCount}>
            Active
          </OverviewTab>
          <OverviewTab view="archived" current={view} onSelect={onViewChange} count={derived.archivedCount}>
            Archived
          </OverviewTab>
        </div>
        <div data-slot="tasks-toolbar" className="flex flex-wrap items-center gap-2.5">
        <BulkActions
          view={view}
          unread={derived.unread}
          finished={derived.finished}
          archivePending={archivePending}
          headerRef={headerRef}
          onMarkAllRead={() => onMarkAllRead(originAutomationFlag(origin))}
          onArchiveFinished={() => onArchiveFinished(originAutomationFlag(origin))}
        />
        <div className="relative order-first w-full md:w-auto md:flex-1">
          <SearchIcon
            className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-soft-foreground"
            aria-hidden="true"
          />
          <input
            type="text"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search tasks or automations…"
            aria-label="Search tasks"
            className="h-11 w-full rounded-md border border-input bg-card pr-3 pl-8 text-[13px] text-foreground outline-none placeholder:text-soft-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
          />
        </div>
        <ColumnsPopover
          columns={columns}
          expandedColumns={expandedColumns}
          columnsPending={columnsPending}
          onToggleColumn={onToggleColumn}
          detailedTable={detailedTable}
          onToggleDetailed={() => setDetailedTable((value) => !value)}
        />
        <Button asChild data-slot="new-task-inline" className="min-h-11 inline-flex max-md:hidden"><Link to="/new"><PlusIcon aria-hidden="true" />New task</Link></Button>
        </div>
        <TaskOriginRow origin={origin} counts={derived.originTotals} onChange={setOrigin} labels={groups.map((group) => group.label)} onSetAll={folds.setAll} />
      </header>

      <div className="flex min-w-0 flex-1 flex-col">
        {runs === undefined ? (
          <TasksLoading error={error} onRetry={onRetry} />
        ) : (
          <ProjectTaskResults
            view={view}
            query={query}
            origin={origin}
            onShowAll={() => { setQuery(''); setOrigin('all') }}
            caption={resultCaption(derived.visibleCount, derived.incomplete, needle)}
            captionOnPhones={needle !== '' || derived.incomplete}
            groups={groups}
            folds={folds}
            grouped={{
              detailedTable,
              columns,
              expandedColumns,
              onToggleColumn,
              columnsPending,
              onRename,
              onTogglePin: pinToggle,
              now,
              showTokens,
              showCost,
              automationName,
            }}
          />
        )}

        {view === 'archived' && archivedPages ? <ArchivedOlder pages={archivedPages} /> : null}
      </div>
    </div>
  )
}

/** Hands the search text to the page; the page calls `written` with each trimmed text its
 *  debounced write puts in the URL. */
type TasksQueryWriter = (query: string, written: (query: string) => void) => void

/**
 * The search box's text. It starts from the URL's, follows the URL when something else changes
 * it (a link, Back), and keeps what is being typed while the page's own debounced, trimmed write
 * catches up.
 *
 * `sent` holds the trimmed texts the page wrote to the URL since it last changed, oldest first;
 * the page reports each one through `written` when its debounced write changes the URL. The
 * router renders each write later, in a transition, so the URL can show an older one after the
 * box has moved on, even after it was cleared: that is the box's own echo, never a change from
 * outside (hearsay-tools/cezarion#1710). A text typed and erased inside one debounce is never
 * written, so a link to it is still followed.
 */
function useUrlQuery(urlQuery: string, onQueryChange: TasksQueryWriter | undefined) {
  const [query, setQuery] = React.useState(urlQuery)
  const shown = React.useRef(urlQuery)
  const typed = React.useRef(urlQuery)
  const sent = React.useRef<string[]>([])
  React.useEffect(() => {
    if (urlQuery === shown.current) return
    shown.current = urlQuery
    const own = sent.current.indexOf(urlQuery)
    sent.current = own === -1 ? [] : sent.current.slice(own + 1)
    if (own === -1 && urlQuery !== typed.current) setQuery(urlQuery)
  }, [urlQuery])
  React.useEffect(() => {
    typed.current = query.trim()
    onQueryChange?.(query, (written) => { sent.current.push(written) })
  }, [onQueryChange, query])
  return [query, setQuery] as const
}

function TasksHeading({ projectName, detailedTable }: { projectName?: string; detailedTable: boolean }) {
  return (
    <div className="flex flex-col gap-2"><h1 className="text-[30px] font-semibold tracking-tight">Project tasks</h1><p className="text-[13px] text-muted-foreground">{projectName ? `${projectName} · ` : ''}{detailedTable ? 'Every resource column shown. Fold columns without losing the saved view.' : 'Review runs, pull requests and resource usage.'}</p></div>
  )
}

/** The caller's origin when it holds one (the route keeps it in the URL); otherwise the page's
 *  own, starting at All. */
function useOriginOrOwn(origin: TaskOrigin | undefined, onChange: ((origin: TaskOrigin) => void) | undefined) {
  const [own, setOwn] = React.useState<TaskOrigin>('all')
  return [origin ?? own, onChange ?? setOwn] as const
}

/**
 * The list's derived state: what the filters leave in each status group, and the counts the
 * tabs, chips, caption and bulk actions show. Pure arithmetic over the props, kept out of the
 * markup.
 */
function useProjectTaskGroups({ all, view, query, origin, archivedPages, archivedTotal, automationName }: {
  all: readonly RunSummary[]
  view: ListView
  query: string
  origin: TaskOrigin
  archivedPages: ArchivedPages | undefined
  archivedTotal: number | undefined
  automationName: (automationId: string) => string | undefined
}) {
  const needle = query.trim()
  const nameOf = (run: RunSummary) => (run.automationId === undefined ? '' : automationName(run.automationId) ?? run.automationId)
  // Pages that answer this search already matched the server's rule, which also reads ids, URLs
  // and PR/issue numbers, so the local filter (titles, branches, workflows) must not drop them
  // again — neither an older paged row nor a list row the server matched. Pages answering other
  // text (the plain pages, or a search still debouncing) widen nothing.
  const answered = archivedPages?.query === needle
  const matched = new Set(answered ? archivedPages.runs.map((run) => run.id) : [])
  const paged = withArchivedPages(all, answered || needle === '' ? archivedPages?.runs ?? [] : []).slice(all.length)
  const listed = filterRuns(all, query, nameOf)
  const listedIds = new Set(listed.map((run) => run.id))
  const serverMatched = filterRuns(all.filter((run) => matched.has(run.id) && !listedIds.has(run.id)), '')
  // Origin narrows the list, its older archived pages and the server's archived matches alike.
  const inOrigin = (run: RunSummary) => matchesOrigin(run, origin)
  // Queue positions come from the full list inside `groupProjectRuns`, never the filtered one: a
  // search must not renumber the queue the engine is actually going to drain.
  const groups = groupProjectRuns([...listed, ...serverMatched, ...filterRuns(paged, '')].filter(inOrigin), view, all)
  const withPages = withArchivedPages(all, archivedPages?.query === '' ? archivedPages.runs : [])
  const archivedFull = listCounts(all).archived >= ARCHIVED_WINDOW
  // Bulk actions follow the origin, never the search or the folds: what they would touch is
  // every finished (or unread) task the origin names.
  const scoped = all.filter(inOrigin)
  return {
    groups,
    needle,
    visibleCount: groups.reduce((total, group) => total + groupMembers(group).length, 0),
    originTotals: originCounts(withPages, view),
    activeCount: originCounts(all, 'active')[origin],
    archivedCount: archivedTabCount(all, withPages, origin, archivedPages, archivedTotal),
    // Older archived history the list has not loaded yet: the caption says "loaded", not a total.
    incomplete: view === 'archived' && archivedFull && archivedPages?.hasMore !== false,
    finished: finishedRunCount(scoped),
    unread: unreadDoneCount(scoped),
  }
}

/**
 * The Archived tab's count. For All it is the server's total, or the window with a `+` while
 * none is known; for one origin it is what has loaded, with a `+` while the plain archive has
 * older pages, or while that is unknown.
 */
function archivedTabCount(
  all: readonly RunSummary[],
  withPages: readonly RunSummary[],
  origin: TaskOrigin,
  archivedPages: ArchivedPages | undefined,
  archivedTotal: number | undefined,
): number | string {
  const archived = listCounts(all).archived
  const full = archived >= ARCHIVED_WINDOW
  if (origin === 'all') return archivedTotal ?? (full ? `${ARCHIVED_WINDOW}+` : archived)
  const loaded = originCounts(withPages, 'archived')[origin]
  // Whether the plain archive has older pages; a search's own paging says nothing about that.
  return full && archivedPages?.plainHasMore !== false ? `${loaded}+` : loaded
}

function resultCaption(count: number, incomplete: boolean, needle: string): string {
  return `${count} ${count === 1 ? 'task' : 'tasks'}${incomplete ? ' loaded' : ''}${needle ? ` matching “${needle}”` : ''}`
}

/**
 * Mark all read and Archive finished, both scoped to the origin by the caller. Below `md` Mark
 * all read moves into the actions menu, after Archive finished.
 */
function BulkActions({ view, unread, finished, archivePending, headerRef, onMarkAllRead, onArchiveFinished }: {
  view: ListView
  unread: number
  finished: number
  archivePending: boolean
  /** Where focus returns once the menu's sweep removes its own trigger. */
  headerRef: React.RefObject<HTMLElement | null>
  onMarkAllRead: () => void
  onArchiveFinished: () => void
}) {
  const archiveSelected = React.useRef(false)
  const [actionsOpen, setActionsOpen] = React.useState(false)
  const sweepable = finished > 0 || archivePending
  // A CSS-hidden Radix menu would keep its modal focus trap after a desktop resize.
  React.useEffect(() => {
    const media = window.matchMedia?.('(min-width: 768px)')
    if (!media) return
    const closeOnDesktop = () => { if (media.matches) setActionsOpen(false) }
    closeOnDesktop()
    media.addEventListener('change', closeOnDesktop)
    return () => media.removeEventListener('change', closeOnDesktop)
  }, [])
  return (
    <>
      {/* Count-gated, like the broom beside it: offered only while there is unread history to
          clear (#unread-done-items). Archived runs are never unread, so this only ever lights
          on the Active tab in practice — no need to also gate on `view`. */}
      {unread > 0 ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          data-slot="mark-all-read"
          className="hidden md:inline-flex"
          onClick={onMarkAllRead}
        >
          <CheckCheckIcon className="size-3.5" aria-hidden="true" />
          Mark all read{' '}
          <span className="tabular-nums text-muted-foreground">{unread}</span>
        </Button>
      ) : null}
      {/* Only when there is something to sweep, like the legacy header's count-gated broom. */}
      {view === 'active' && finished > 0 ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          data-slot="archive-finished"
          className="inline-flex"
          disabled={archivePending}
          aria-busy={archivePending}
          onClick={onArchiveFinished}
        >
          <ArchiveIcon className="size-3.5" aria-hidden="true" />
          Archive finished{' '}
          <span className="tabular-nums text-muted-foreground">{finished}</span>
        </Button>
      ) : null}
      {/* Below `md` both sweeps live here, so the first task stays above the fold
          (hearsay-tools/cezarion#1616). */}
      {view === 'active' && (sweepable || unread > 0) ? (
        <DropdownMenu open={actionsOpen} onOpenChange={setActionsOpen}>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="md:hidden"
              aria-label="Task actions"
              aria-busy={archivePending}
            >
              <MoreHorizontalIcon aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            className="md:hidden"
            onCloseAutoFocus={(event) => {
              // The successful mutation removes its trigger. Return to the stable filter,
              // without focusing search and summoning the phone keyboard.
              if (archiveSelected.current || window.matchMedia?.('(min-width: 768px)').matches) {
                event.preventDefault()
                archiveSelected.current = false
                headerRef.current?.querySelector<HTMLButtonElement>('[data-view="active"]')?.focus()
              }
            }}
          >
            {sweepable ? (
              <DropdownMenuItem
                disabled={archivePending || finished === 0}
                onSelect={() => {
                  archiveSelected.current = true
                  onArchiveFinished()
                }}
              >
                <ArchiveIcon aria-hidden="true" />
                {archivePending ? 'Archiving…' : `Archive finished (${finished})`}
              </DropdownMenuItem>
            ) : null}
            {unread > 0 ? (
              <DropdownMenuItem onSelect={onMarkAllRead}>
                <CheckCheckIcon aria-hidden="true" />
                {`Mark all read (${unread})`}
              </DropdownMenuItem>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </>
  )
}

function ColumnsPopover({ columns, expandedColumns, columnsPending, onToggleColumn, detailedTable, onToggleDetailed }: {
  columns: ReturnType<typeof taskColumnsForCapabilities>
  expandedColumns: NormalizedExpandedColumns
  columnsPending: boolean
  onToggleColumn: (id: TaskColumnId) => void
  detailedTable: boolean
  onToggleDetailed: () => void
}) {
  return (
  <Popover><PopoverTrigger asChild><Button data-slot="task-columns-trigger" variant="outline" className="hidden min-h-11 md:inline-flex">Columns</Button></PopoverTrigger><PopoverContent align="end" className="w-72">
    <h2 className="mb-2 text-base font-medium">Visible columns</h2><p className="mb-4 text-xs text-muted-foreground">Status and Task · Always visible</p>
    <div className="grid grid-cols-2 gap-3">{columns.filter((column) => column.canFold).map((column) => <label key={column.id} className="flex items-center gap-2 text-xs"><input data-column-toggle={column.id} type="checkbox" checked={isColumnExpanded(column.id, expandedColumns)} disabled={columnsPending} onChange={() => onToggleColumn(column.id)} />{column.id === 'diff' ? 'Diff' : column.id === 'reference' ? 'Reference' : column.id === 'memory' ? 'Memory' : column.label}</label>)}</div>
    <p className="mt-4 text-xs text-muted-foreground">Saved automatically. Tokens and cost appear only when supported.</p>
    <Button variant="outline" className="mt-4" onClick={onToggleDetailed}>{detailedTable ? 'Summary view' : 'Resource columns'}</Button>
  </PopoverContent></Popover>
  )
}

/**
 * What the loaded list leaves on screen: the empty state for how it got empty, or the result
 * caption and each status group with its rows.
 */
function ProjectTaskResults({ view, query, origin, onShowAll, caption, captionOnPhones, groups, folds, grouped }: {
  view: ListView
  query: string
  origin: TaskOrigin
  onShowAll: () => void
  caption: string
  /** Below `md` a plain count repeats the group headings, so the caption shows only when it says
   *  more: a search's matches, or a list not fully loaded. */
  captionOnPhones: boolean
  groups: TaskStatusGroup<RunSummary>[]
  folds: ReturnType<typeof useTaskListFolds>
  /** Everything each group's rows take besides the group itself. */
  grouped: Omit<React.ComponentProps<typeof GroupedTasks>, 'group'>
}) {
  if (groups.length === 0) return <TasksEmptyState view={view} query={query} origin={origin} onShowAll={onShowAll} />
  return (
    <>
      <p data-slot="tasks-result-count" className={cn('mb-3 text-[12px] text-muted-foreground tabular-nums', !captionOnPhones && 'max-md:hidden')}>{caption}</p>
      <div className="flex flex-col gap-[22px]">
        {groups.map((group) => {
          const members = groupMembers(group)
          return (
            <StatusGroupSection
              key={group.label}
              id={`tasks-group-${view}-${group.label.replaceAll(' ', '-')}`}
              label={group.label}
              count={members.length}
              tone={groupTone(group.label, members)}
              folded={folds.isFolded(group.label)}
              collapsed={folds.isCollapsed(group.label)}
              onToggle={() => folds.toggle(group.label)}
            >
              <GroupedTasks group={group} {...grouped} />
            </StatusGroupSection>
          )
        })}
      </div>
      <p className="mt-[22px] text-[11px] text-muted-foreground">Resource details—including tokens, cost, CPU and peak memory—are available when a task row is expanded.</p>
    </>
  )
}

function TasksLoading({ error, onRetry }: { error?: string; onRetry?: () => void }) {
  return error ? (
    <div role="alert" className="rounded-xl border border-border bg-card p-6"><h2 className="text-lg">Could not load tasks</h2><p className="mt-2 text-sm text-muted-foreground">{error}</p><Button variant="outline" className="mt-4" onClick={onRetry}>Retry</Button></div>
  ) : (
    <div role="status" aria-label="Loading tasks" className="rounded-xl border border-border bg-card p-6 text-sm text-muted-foreground">Loading tasks…</div>
  )
}

/** Older archived history below the list: a retry after a failed page, or the next page. */
function ArchivedOlder({ pages }: { pages: ArchivedPages }) {
  if (pages.failed) {
    return (
      <p role="alert" data-slot="archived-older-error" className="mt-3.5 flex items-center justify-center gap-2.5 text-[13px] text-muted-foreground">
        Could not load older archived tasks.
        <Button variant="outline" className="min-h-11" onClick={pages.onLoadMore}>Retry</Button>
      </p>
    )
  }
  if (!pages.hasMore) return null
  return (
    <Button
      data-slot="archived-older"
      variant="outline"
      className="mt-3.5 min-h-11 self-center"
      disabled={pages.loading}
      onClick={pages.onLoadMore}
    >
      {pages.loading ? 'Loading older archived…' : 'Show older archived'}
    </Button>
  )
}

/**
 * What an empty list honestly means, given how it got empty — as a CenteredState, one variant
 * per cause. Only the no-tasks-at-all state is a hero moment and gets the twinkle backdrop
 * (spec: textures on hero/empty surfaces only); a missed search or an unswept archive is just
 * a fact, so those stay flat. `heading="h2"` because the page's h1 is the header's "Tasks".
 */
function TasksEmptyState({ view, query, origin = 'all', onShowAll }: { view: ListView; query: string; origin?: TaskOrigin; onShowAll?: () => void }) {
  const needle = query.trim()
  const kind = needle || origin !== 'all' ? 'search-miss' : view === 'archived' ? 'archive' : 'no-tasks'
  return (
    <div data-slot="tasks-empty" data-empty-kind={kind} className="flex flex-1 flex-col">
      {kind === 'search-miss' ? (
        <CenteredState
          heading="h2"
          icon={<SearchXIcon />}
          tone="neutral"
          title="No matching tasks"
          subtitle={needle ? `No tasks match “${needle}”.` : origin === 'automations' ? 'No automation started a task here.' : 'No task here was started directly.'}
          actions={onShowAll ? <Button variant="outline" className="min-h-11" data-action="clear-task-filters" onClick={onShowAll}>Show all tasks</Button> : undefined}
        />
      ) : kind === 'archive' ? (
        <CenteredState
          heading="h2"
          icon={<ArchiveIcon />}
          tone="neutral"
          title="Nothing archived yet"
          subtitle="Finished tasks you archive land here."
        />
      ) : (
        <CenteredState
          heading="h2"
          icon={<ListChecksIcon />}
          tone="primary"
          backdrop
          title="No tasks yet"
          subtitle="Describe a task to get started."
          actions={
            <Button asChild>
              <Link to="/new">
                <PlusIcon aria-hidden="true" />
                New task
              </Link>
            </Button>
          }
        />
      )}
    </div>
  )
}

/** Frame 4: five scan columns, with resources disclosed per task. The optional detailed table
 * above still owns workspace column preferences, so switching presentation never rewrites them. */
function SummaryTasksTable({ rows, onRename, onTogglePin, now, showTokens, showCost, automationName }: {
  rows: readonly GroupedTask[]
  onRename: (id: string, title: string) => void
  onTogglePin?: (run: RunSummary, pinned: boolean) => void
  now: number
  showTokens: boolean
  showCost: boolean
  automationName: (automationId: string) => string | undefined
}) {
  const [expanded, setExpanded] = React.useState<Set<string>>(() => new Set())
  return <div data-slot="tasks-summary" className="hidden md:block"><div className="rounded-lg border border-border bg-card p-5">
    <table className="w-full table-fixed border-collapse">
      <colgroup><col /><col className="w-[136px]" /><col className="w-[106px]" /><col className="w-[116px]" /><col className="w-[70px]" /></colgroup>
      <thead><tr>{['Task', 'Workflow', 'Changes', 'Pull request', 'Started'].map((label) => <th key={label} className="h-8 border-b border-border text-left text-[12px] font-medium uppercase text-muted-foreground">{label}</th>)}</tr></thead>
      <tbody>{rows.map(({ run, queuePosition }) => {
        const attention = deriveAttention(run)
        const scheduled = scheduledResume(run)
        const reference = taskReference(run)
        const open = expanded.has(run.id)
        const detailId = `task-resources-${run.id}`
        return <React.Fragment key={run.id}>
          <tr data-status={run.status} data-slot="task-summary-row" className="group/row border-b border-border last:border-0">
            <td className="py-5 pr-4 align-top">
              <TitleCell run={run} to={`/tasks/${run.id}`} onRename={onRename} onTogglePin={onTogglePin} />
              <div className="mt-1"><RunOriginLine run={run} automationName={automationName} /></div>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <button type="button" aria-label={`${open ? 'Hide' : 'Show'} resources for ${runTitle(run)}`} aria-expanded={open} aria-controls={detailId} aria-describedby={`summary-status-${run.id}`} onClick={() => setExpanded((current) => { const next = new Set(current); if (open) next.delete(run.id); else next.add(run.id); return next })} className="inline-flex min-h-[26px] items-center gap-1 rounded-md p-0 text-[11px] text-muted-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"><Pill id={`summary-status-${run.id}`} dot={attention.tone} shape={attention.shape} pulse={attention.pulse}>{attention.label}{scheduled ? ` ${scheduled.label}` : ''}</Pill></button>
                {run.status === 'queued' && queuePosition !== null ? <span className="text-xs text-muted-foreground">#{queuePosition} in queue</span> : null}

              </div>
            </td>
            <td className="truncate pr-3 text-xs text-muted-foreground" title={workflowLabel(run)}>{workflowLabel(run)}</td>
            <td className="pr-2 text-xs">{run.diffStat ? <DiffStatLabel stat={run.diffStat} /> : <Dash />}</td>
            <td className="pr-2">{reference ? <TaskReferenceChip run={run} reference={reference} compact /> : <Dash />}</td>
            <td className="text-xs text-muted-foreground">{shortAge(run.startedAt ?? run.createdAt, now)}</td>
          </tr>
          {open ? <tr><td colSpan={5} className="border-b border-border pb-5"><div id={detailId} className="flex flex-col gap-3">
            <TaskPreview runId={run.id} status={attention.label} error={run.error} open={<Button asChild variant="outline" className="min-h-11"><Link to={`/tasks/${run.id}`}>Open task<span className="sr-only">: {runTitle(run)}</span></Link></Button>} />
            <div className="rounded-md bg-muted/50 p-4"><TaskResourceDetails run={run} showTokens={showTokens} showCost={showCost} /></div>
          </div></td></tr> : null}
        </React.Fragment>
      })}</tbody>
    </table>
    </div>
  </div>
}

/** One row of a status group's tables: a run, or one member of a variant group in order. */
type GroupedTask = { run: RunSummary; queuePosition: number | null }

/**
 * One status group's tasks in every presentation the page has: the summary table, the detailed
 * table with the saved column choices, and the phone cards. Variant groups keep their place and
 * list their members in variant order.
 */
function GroupedTasks({
  group,
  detailedTable,
  columns,
  expandedColumns,
  onToggleColumn,
  columnsPending,
  onRename,
  onTogglePin,
  now,
  showTokens,
  showCost,
  automationName,
}: {
  group: TaskStatusGroup<RunSummary>
  detailedTable: boolean
  columns: readonly TaskColumnDefinition[]
  expandedColumns: NormalizedExpandedColumns
  onToggleColumn: (id: TaskColumnId) => void
  columnsPending: boolean
  onRename: (id: string, title: string) => void
  onTogglePin?: (run: RunSummary, pinned: boolean) => void
  now: number
  showTokens: boolean
  showCost: boolean
  automationName: (automationId: string) => string | undefined
}) {
  const rows: GroupedTask[] = group.rows.flatMap((row) =>
    rowTasks(row).map((run) => ({ run, queuePosition: row.kind === 'run' && run.status === 'queued' ? row.queuePosition : null })),
  )
  return (
    <>
      {!detailedTable ? <SummaryTasksTable rows={rows} onRename={onRename} onTogglePin={onTogglePin} now={now} showTokens={showTokens} showCost={showCost} automationName={automationName} /> : null}
      {/* The detailed table retains every saved column preference. */}
      <div
        data-slot="tasks-table"
        hidden={!detailedTable}
        className={cn('hidden overflow-x-auto rounded-lg border border-border bg-card', detailedTable && 'md:block')}
      >
        <TooltipProvider>
          <table className="w-full table-fixed border-collapse">
            <colgroup>
              {columns.map((column) => {
                const expanded = isColumnExpanded(column.id, expandedColumns)
                return <col key={column.id} data-column-id={column.id} data-expanded={expanded} style={{ width: expanded ? column.width : '42px' }} />
              })}
            </colgroup>
            <thead>
              <tr>
                {columns.map((column) => (
                  <TaskColumnHeader key={column.id} column={column} expanded={isColumnExpanded(column.id, expandedColumns)} onToggle={onToggleColumn} disabled={columnsPending} />
                ))}
              </tr>
            </thead>
            <tbody className="[&>tr:last-child>td]:border-b-0">
              {rows.map(({ run, queuePosition }) => (
                <TableRow key={run.id} run={run} queuePosition={queuePosition} onRename={onRename} onTogglePin={onTogglePin} now={now} columns={columns} expandedColumns={expandedColumns} automationName={automationName} />
              ))}
            </tbody>
          </table>
        </TooltipProvider>
      </div>
      {/* <md: the same runs as stacked cards. */}
      <div data-slot="task-cards" className="flex flex-col rounded-lg border border-border bg-card p-5 md:hidden">
        {rows.map(({ run, queuePosition }) => (
          <TaskCard key={run.id} run={run} queuePosition={queuePosition} now={now} showTokens={showTokens} showCost={showCost} onTogglePin={onTogglePin} automationName={automationName} />
        ))}
      </div>
    </>
  )
}

function TaskResourceDetails({ run, showTokens, showCost }: { run: RunSummary; showTokens: boolean; showCost: boolean }) {
  const sample = useRunUsage(run.id)
  const usage = usageCells(run, sample)
  return <dl className="grid grid-cols-2 gap-4 text-xs md:grid-cols-4">
    {showTokens ? <div><dt className="text-muted-foreground">Tokens in / out</dt><dd className="mt-1"><DirectionalUsage inputTokens={run.inputTokens} outputTokens={run.outputTokens} omitWhenUnknown={false} /></dd></div> : null}
    {showCost ? <div><dt className="text-muted-foreground">Cost</dt><dd className="mt-1">{formatCost(run.costUsd) || '—'}</dd></div> : null}
    <div><dt className="text-muted-foreground">CPU</dt><dd className="mt-1" title={usage.cpu.title}>{usage.cpu.text || '—'}</dd></div>
    <div><dt className="text-muted-foreground">Memory</dt><dd className="mt-1" title={usage.mem.title}>{usage.mem.text || '—'}</dd></div>
    {run.branch ? <div className="col-span-2"><dt className="text-muted-foreground">Branch</dt><dd className="mt-1 break-all">{run.branch}</dd></div> : null}
  </dl>
}

function OverviewTab({
  view,
  current,
  onSelect,
  count,
  children,
}: {
  view: ListView
  current: ListView
  onSelect: (view: ListView) => void
  /** A number, or `200+` while the list holds a full window and the total is unknown. */
  count: number | string
  children: React.ReactNode
}) {
  const isActive = view === current
  return (
    <button
      type="button"
      data-slot="overview-tab"
      data-view={view}
      // Same rationale as the sidebar's tabs: these filter one list in place, they do not switch
      // panels — `aria-pressed` is what that actually is.
      aria-pressed={isActive}
      onClick={() => onSelect(view)}
      className={cn(
        'flex min-h-11 items-center justify-center gap-1.5 border-b-2 border-transparent text-[13px] font-medium text-muted-foreground',
        isActive && 'border-accent-strong font-semibold text-accent-text'
      )}
    >
      {children}
      {count !== 0 ? <span className="tabular-nums"> · {count}</span> : null}
    </button>
  )
}

function Th({
  children,
  right = false,
  columnId,
  folded = false,
}: {
  children: React.ReactNode
  right?: boolean
  columnId: TaskColumnId
  folded?: boolean
}) {
  return (
    <th
      scope="col"
      data-column-id={columnId}
      data-folded={folded || undefined}
      className={cn(
        'h-[38px] border-b border-border px-2.5 text-left text-[11px] font-semibold tracking-[0.05em] whitespace-nowrap text-supporting-foreground uppercase first:pl-4 last:pr-4',
        right && 'text-right',
        folded && 'px-0 first:pl-0 last:pr-0',
      )}
    >
      {children}
    </th>
  )
}

function TaskColumnHeader({
  column,
  expanded,
  onToggle,
  disabled,
}: {
  column: TaskColumnDefinition
  expanded: boolean
  onToggle: (id: TaskColumnId) => void
  disabled: boolean
}) {
  if (!column.canFold) {
    return (
      <Th columnId={column.id} right={column.align === 'right'}>
        {column.label}
      </Th>
    )
  }

  const action = expanded ? 'Fold' : 'Expand'
  return (
    <Th columnId={column.id} right={column.align === 'right'} folded={!expanded}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={`${action} ${column.label} column`}
            aria-pressed={expanded}
            disabled={disabled}
            onClick={() => onToggle(column.id)}
            className={cn(
              'inline-flex h-8 w-full items-center gap-1 rounded-sm px-0.5 text-inherit outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-wait disabled:opacity-60',
              column.align === 'right' ? 'justify-end' : 'justify-start',
              !expanded && 'justify-center px-0',
            )}
          >
            {expanded ? (
              <>
                <span>{column.label}</span>
                <ChevronsLeftIcon className="size-3 opacity-55" aria-hidden="true" />
              </>
            ) : (
              <>
                <TaskColumnIconView icon={column.icon} />
                <ChevronsRightIcon className="size-3 opacity-70" aria-hidden="true" />
              </>
            )}
          </button>
        </TooltipTrigger>
        <TooltipContent side="top">{column.label} · {action} column</TooltipContent>
      </Tooltip>
    </Th>
  )
}

function TaskColumnIconView({ icon }: { icon?: TaskColumnIcon }) {
  const className = 'size-3.5'
  switch (icon) {
    case 'workflow':
      return <WorkflowIcon className={className} aria-hidden="true" />
    case 'branch':
      return <GitBranchIcon className={className} aria-hidden="true" />
    case 'diff':
      return <FileDiffIcon className={className} aria-hidden="true" />
    case 'reference':
      return <LinkIcon className={className} aria-hidden="true" />
    case 'tokens':
      return <CoinsIcon className={className} aria-hidden="true" />
    case 'cost':
      return <DollarSignIcon className={className} aria-hidden="true" />
    case 'cpu':
      return <CpuIcon className={className} aria-hidden="true" />
    case 'memory':
      return <MemoryStickIcon className={className} aria-hidden="true" />
    case 'started':
      return <Clock3Icon className={className} aria-hidden="true" />
    default:
      return null
  }
}

const TD_BASE = 'h-[88px] border-b border-border px-2.5 whitespace-nowrap first:pl-4 last:pr-4'

/**
 * One run, one row.
 *
 * The whole row is a click target for `/tasks/:id` — but a click that lands on any anchor,
 * button or input inside it (the PR chip, the title's real link, the rename pencil and its
 * input) belongs to that control and is not hijacked. The title is a true `<Link>` so the
 * row's destination exists for keyboards and middle-clicks too.
 */
function TableRow({
  run,
  queuePosition,
  onRename,
  onTogglePin,
  now,
  columns,
  expandedColumns,
  automationName,
}: {
  run: RunSummary
  queuePosition: number | null
  onRename: (id: string, title: string) => void
  onTogglePin?: (run: RunSummary, pinned: boolean) => void
  now: number
  columns: readonly TaskColumnDefinition[]
  expandedColumns: NormalizedExpandedColumns
  automationName: (automationId: string) => string | undefined
}) {
  const navigate = useNavigate()
  const attention = deriveAttention(run)
  const scheduled = scheduledResume(run)
  const to = `/tasks/${run.id}`
  const cost = formatCost(run.costUsd)
  const reference = taskReference(run)

  return (
    <tr
      data-slot="task-table-row"
      data-run-id={run.id}
      onClick={(event) => {
        if ((event.target as Element).closest('a, button, input')) return
        navigate(to)
      }}
      className="group/row cursor-pointer hover:bg-muted"
    >
      {columns.map((column) => {
        if (column.id === 'memory') return null
        if (column.id === 'cpu') {
          const cpuExpanded = isColumnExpanded('cpu', expandedColumns)
          const memoryExpanded = isColumnExpanded('memory', expandedColumns)
          return queuePosition !== null && (cpuExpanded || memoryExpanded) ? (
            <td
              key={column.id}
              data-slot="queue-note"
              data-column-id="cpu-memory"
              colSpan={2}
              className={cn(TD_BASE, 'text-right font-mono text-[11px] text-supporting-foreground')}
            >
              #{queuePosition} in queue
            </td>
          ) : (
            <UsageTds
              key={column.id}
              run={run}
              cpuExpanded={cpuExpanded}
              memoryExpanded={memoryExpanded}
            />
          )
        }
        return (
          <TaskTableCell
            key={column.id}
            column={column}
            expanded={isColumnExpanded(column.id, expandedColumns)}
            run={run}
            attention={attention}
            scheduled={scheduled}
            reference={reference}
            cost={cost}
            to={to}
            onRename={onRename}
            onTogglePin={onTogglePin}
            now={now}
            automationName={automationName}
          />
        )
      })}
    </tr>
  )
}

function TaskTableCell({
  column,
  expanded,
  run,
  attention,
  scheduled,
  reference,
  cost,
  to,
  onRename,
  onTogglePin,
  now,
  automationName,
}: {
  column: TaskColumnDefinition
  expanded: boolean
  run: RunSummary
  attention: ReturnType<typeof deriveAttention>
  scheduled: ReturnType<typeof scheduledResume>
  reference: ReturnType<typeof taskReference>
  cost: string
  to: string
  onRename: (id: string, title: string) => void
  onTogglePin?: (run: RunSummary, pinned: boolean) => void
  now: number
  automationName: (automationId: string) => string | undefined
}) {
  if (!expanded) return <FoldedTd column={column.id} />

  switch (column.id) {
    case 'status':
      return (
        <td data-column-id={column.id} className={cn(TD_BASE, 'overflow-hidden')}>
          {/* A scheduled run wears its appointment in the pill, the way a queued one wears its
              queue position — the row's whole answer to "what is this waiting for?". */}
          <Pill
            dot={attention.tone}
            shape={attention.shape}
            pulse={attention.pulse}
            title={scheduled?.title ?? attention.label}
            className="w-full max-w-full overflow-hidden"
          >
            <span className="min-w-0 truncate">
              {attention.label}
              {scheduled ? (
                <>
                  {' '}
                  <span className="tabular-nums">{scheduled.label}</span>
                </>
              ) : null}
            </span>
          </Pill>
        </td>
      )
    case 'task':
      return (
        <td data-column-id={column.id} className={cn(TD_BASE, 'min-w-[320px] max-w-0 whitespace-normal')}>
          <TitleCell run={run} to={to} onRename={onRename} onTogglePin={onTogglePin} />
          <div className="mt-1"><RunOriginLine run={run} automationName={automationName} /></div>
        </td>
      )
    case 'workflow':
      return (
        <td data-column-id={column.id} className={cn(TD_BASE, 'max-w-0 truncate text-[13px] text-muted-foreground')}>
          {workflowLabel(run)}
        </td>
      )
    case 'branch':
      return (
        <td data-column-id={column.id} className={cn(TD_BASE, 'max-w-0 overflow-hidden')}>
          {run.branch ? <BranchChip branch={run.branch} /> : <Dash />}
        </td>
      )
    case 'diff':
      return (
        <td data-column-id={column.id} className={cn(TD_BASE, 'overflow-hidden')}>
          {run.diffStat ? <DiffStatLabel stat={run.diffStat} compact className="block max-w-full" /> : <Dash />}
        </td>
      )
    case 'reference':
      return (
        <td data-column-id={column.id} className={cn(TD_BASE, 'overflow-hidden')}>
          {reference ? (
            <TaskReferenceChip run={run} reference={reference} compact className="max-w-full overflow-hidden" />
          ) : <Dash />}
        </td>
      )
    case 'tokens':
      const tokensLabel = directionalUsageLabel(run.inputTokens, run.outputTokens)
      return (
        <td data-column-id={column.id} className={cn(TD_BASE, 'text-right text-xs text-muted-foreground')}>
          <DirectionalUsage
            inputTokens={run.inputTokens}
            outputTokens={run.outputTokens}
            variant="table"
            omitWhenUnknown={false}
            title={tokensLabel}
            className="block max-w-full overflow-hidden text-ellipsis"
          />
        </td>
      )
    case 'cost':
      return (
        <td
          data-column-id={column.id}
          className={cn(TD_BASE, 'text-right font-mono text-xs text-muted-foreground tabular-nums')}
        >
          {cost ? <BoundedMetric text={cost} accessibleText={`$${run.costUsd}`} /> : <Dash />}
        </td>
      )
    case 'started':
      return (
        <td data-column-id={column.id} className={cn(TD_BASE, 'text-right text-xs text-supporting-foreground tabular-nums')}>
          {shortAge(run.startedAt ?? run.createdAt, now)}
        </td>
      )
    default:
      // CPU and Memory render as one pair (`UsageTds`), never as a cell of their own.
      return null
  }
}

/** A project row's origin line: Direct task, or the automation's name or recorded id. */
function RunOriginLine({ run, automationName }: { run: RunSummary; automationName: (automationId: string) => string | undefined }) {
  return <TaskOriginLine automationId={run.automationId} automationName={run.automationId === undefined ? undefined : automationName(run.automationId)} />
}

function FoldedTd({ column }: { column: TaskColumnId }) {
  return (
    <td
      role="presentation"
      aria-hidden="true"
      data-column-id={column}
      data-folded="true"
      className={cn(TD_BASE, 'px-0 first:pl-0 last:pr-0')}
    />
  )
}

/**
 * The Task cell: the title as a real link, with the mockup's hover pencil (`tasks-home.html`
 * `.task-title .pencil`) flipping it into the shared inline-rename input. Same machine as the
 * run header's title — one edit, one PATCH. The quick-list's rows stay read-only on purpose:
 * at 13px-in-a-260px-sidebar there is no room for an input worth typing into.
 */
function TitleCell({
  run,
  to,
  onRename,
  onTogglePin,
}: {
  run: RunSummary
  to: string
  onRename: (id: string, title: string) => void
  onTogglePin?: (run: RunSummary, pinned: boolean) => void
}) {
  const title = runTitle(run)
  const editor = useTitleEditor(title, (next) => onRename(run.id, next))
  // Read/unread (#unread-done-items, "Option B"): promote an unread done item (bright + semibold)
  // and dim a read one, matching the sidebar row exactly so the two surfaces read as one grammar.
  const unread = isUnread(run)
  const readDone = isReadDoneItem(run)

  if (editor.editing) {
    return <div className="flex flex-wrap items-center gap-2" data-slot="table-title-editor">
      <TitleEditInput editor={editor} className="basis-full text-[13px] font-medium" />
      <Button size="sm" aria-label="Save title" onMouseDown={(event) => event.preventDefault()} onClick={editor.commit}>Save</Button>
      <Button size="sm" variant="outline" aria-label="Cancel rename" onMouseDown={(event) => event.preventDefault()} onClick={editor.cancel}>Cancel</Button>
    </div>
  }

  return (
    <span className="flex min-w-0 items-center gap-1.5">
      {run.delegation?.role === 'worker' ? <span className="shrink-0 text-xs text-muted-foreground">Worker</span> : null}
      <Link
        to={to}
        title={title}
        className={cn(
          'line-clamp-2 min-w-0 flex-1 whitespace-normal rounded-sm text-[13px] leading-[18px] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-link-foreground',
          unread ? 'font-semibold text-foreground' : readDone ? 'font-normal text-foreground' : 'font-medium'
        )}
      >
        {title}
      </Link>
      {/* The unread marker — the sidebar row's trailing dot, in the run's outcome colour (#617). */}
      {unread ? (
        <StatusDot
          tone={unreadMarkerTone(run)}
          role="img"
          aria-label="unread"
          title="Unread — not opened since it finished"
          className="shrink-0"
        />
      ) : null}
      <button
        type="button"
        data-slot="row-rename"
        aria-label="Rename task"
        onClick={editor.begin}
        className="shrink-0 rounded-sm p-0.5 text-soft-foreground opacity-0 transition-opacity group-hover/row:opacity-100 hover:text-foreground focus-visible:opacity-100 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
      >
        <PencilIcon className="size-3" aria-hidden="true" />
      </button>
      {/* The pin (#935), beside the pencil and revealed the same way — except when the row IS
          pinned, where it stays lit: this table has no `Pinned` header, so the filled pin is the
          whole explanation for why the row sorted to the top.

          `no-hover:` covers the device this table still reaches without a pointer: it is hidden
          below `md`, where the cards take over, but a tablet in landscape is ≥md and cannot
          hover, so without it the pin would be invisible AND unreachable there. */}
      {onTogglePin ? (
        <PinToggle
          pinned={Boolean(run.pinned)}
          onToggle={(pinned) => onTogglePin(run, pinned)}
          className="size-[19px] opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100 no-hover:opacity-100 data-[pinned=true]:opacity-100"
        />
      ) : null}
    </span>
  )
}

/**
 * The live CPU/Mem pair, read from the global usage stream (`useRunUsage`, never `run.usage` —
 * the REST snapshot goes stale between refetches; the stream ticks every ~2s). Selected per run,
 * so a tick that says nothing about this run re-renders nothing.
 */
function UsageTds({
  run,
  cpuExpanded,
  memoryExpanded,
}: {
  run: RunSummary
  cpuExpanded: boolean
  memoryExpanded: boolean
}) {
  const sample = useRunUsage(run.id)
  const cells = usageCells(run, sample)
  return (
    <>
      {cpuExpanded ? <UsageTd column="cpu" cell={cells.cpu} /> : <FoldedTd column="cpu" />}
      {memoryExpanded ? <UsageTd column="memory" cell={cells.mem} /> : <FoldedTd column="memory" />}
    </>
  )
}

function UsageTd({ column, cell }: { column: 'cpu' | 'memory'; cell: UsageCell }) {
  const accessibleText = cell.text && cell.title ? `${cell.text}; ${cell.title}` : cell.text
  return (
    <td
      data-usage={column === 'memory' ? 'mem' : column}
      data-column-id={column}
      data-usage-kind={cell.kind}
      className={cn(
        TD_BASE,
        'overflow-hidden',
        'text-right font-mono tabular-nums',
        cell.kind === 'live' && 'bg-accent-strong/5 text-xs font-medium text-foreground',
        cell.kind === 'peak' && 'text-[11px] text-supporting-foreground',
        cell.kind === 'none' && 'text-xs text-soft-foreground'
      )}
    >
      <BoundedMetric text={cell.text || '—'} accessibleText={accessibleText || undefined} />
    </td>
  )
}

function BoundedMetric({ text, accessibleText }: { text: string; accessibleText?: string }) {
  return (
    <span
      data-slot="bounded-metric"
      {...(accessibleText ? { 'aria-label': accessibleText, title: accessibleText } : {})}
      className="block max-w-full overflow-hidden text-ellipsis"
    >
      {text}
    </span>
  )
}

/** One run, one card — the `<md` framing of the same row. */
function TaskCard({
  run,
  queuePosition,
  now,
  showTokens,
  showCost,
  onTogglePin,
  automationName,
}: {
  run: RunSummary
  queuePosition: number | null
  now: number
  showTokens: boolean
  showCost: boolean
  onTogglePin?: (run: RunSummary, pinned: boolean) => void
  automationName: (automationId: string) => string | undefined
}) {
  const navigate = useNavigate()
  const [resourcesOpen, setResourcesOpen] = React.useState(false)
  const attention = deriveAttention(run)
  const scheduled = scheduledResume(run)
  const to = `/tasks/${run.id}`
  const reference = taskReference(run)
  // Read/unread (#unread-done-items) — the same promote-unread / dim-read treatment as the row.
  const unread = isUnread(run)
  const readDone = isReadDoneItem(run)

  return (
    <div
      data-slot="task-card"
      data-status={run.status}
      data-run-id={run.id}
      onClick={(event) => {
        // `button` as well as `a` since the card grew the pin (#935): a control inside the card
        // owns its own click, exactly as the desktop row has always had it.
        if ((event.target as Element).closest('a, button')) return
        navigate(to)
      }}
      className="cursor-pointer border-b border-border py-5 first:pt-0 last:border-0 last:pb-0"
    >
      <div className="flex flex-wrap items-start gap-2.5">
        <button data-slot="mobile-resources-toggle" type="button" aria-controls={`mobile-resources-${run.id}`} aria-describedby={`mobile-status-${run.id}`} aria-label={resourcesOpen ? 'Hide resources' : 'Show resources'} title={resourcesOpen ? 'Hide resources' : 'Show resources'} aria-expanded={resourcesOpen} onClick={() => setResourcesOpen((value) => !value)}><Pill id={`mobile-status-${run.id}`} dot={attention.tone} shape={attention.shape} pulse={attention.pulse} className="mt-px shrink-0" title={scheduled?.title}>
          {attention.label}
          {scheduled ? <span className="tabular-nums">{scheduled.label}</span> : null}
        </Pill></button>
        <Link
          to={to}
          className={cn(
            'order-first w-full min-w-0 rounded-sm text-[14px] leading-[1.35] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-link-foreground',
            unread ? 'font-semibold text-foreground' : readDone ? 'font-normal text-foreground' : 'font-medium'
          )}
        >
          {run.delegation?.role === 'worker' ? <span className="mr-2 text-xs text-muted-foreground">Worker</span> : null}
          {runTitle(run)}
        </Link>
        {/* The unread marker — trailing dot in the outcome colour, as on the desktop row (#617). */}
        {unread ? (
          <StatusDot
            tone={unreadMarkerTone(run)}
            role="img"
            aria-label="unread"
            title="Unread — not opened since it finished"
            className="mt-1.5 shrink-0"
          />
        ) : null}
        <div className="order-first w-full"><RunOriginLine run={run} automationName={automationName} /></div>
        {/* Always visible here, not hover-revealed: a card has no hover to speak of on the
            device it exists for, and it is the only place a pin can be set or seen on mobile. */}
        {onTogglePin ? (
          <PinToggle
            pinned={Boolean(run.pinned)}
            onToggle={(pinned) => onTogglePin(run, pinned)}
            className="-mr-1 mt-px"
          />
        ) : null}
      </div>
      <div data-slot="mobile-task-meta" className="mt-4 grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-3 text-xs text-muted-foreground">
        <span>{workflowLabel(run)}</span>
        {queuePosition !== null ? <span data-slot="queue-note">#{queuePosition} in queue</span> : run.diffStat ? <DiffStatLabel stat={run.diffStat} /> : <Dash />}
        <span>{shortAge(run.startedAt ?? run.createdAt, now)}</span>
      </div>
      {reference ? <div className="mt-3"><TaskReferenceChip run={run} reference={reference} /></div> : null}
      {resourcesOpen ? <>
        <div className="mt-3"><TaskPreview runId={run.id} status={attention.label} error={run.error} open={<Button asChild variant="outline" className="min-h-11"><Link to={to}>Open task<span className="sr-only">: {runTitle(run)}</span></Link></Button>} /></div>
        <MobileResources run={run} showTokens={showTokens} showCost={showCost} />
      </> : null}
    </div>
  )
}

/** Subscribe to live resource samples only while this card's details are open. */
function MobileResources({ run, showTokens, showCost }: { run: RunSummary; showTokens: boolean; showCost: boolean }) {
  const sample = useRunUsage(run.id)
  const resources = usageCells(run, sample)
  return <dl id={`mobile-resources-${run.id}`} className="mt-3 grid grid-cols-2 gap-3 rounded-md bg-muted p-3 text-xs">
    {run.branch ? <div><dt>Branch</dt><dd>{run.branch}</dd></div> : null}
    <div><dt>CPU</dt><dd>{resources.cpu.text || '—'}</dd></div><div><dt>Memory</dt><dd>{resources.mem.text || '—'}</dd></div>
    {showTokens ? <div><dt>IN / OUT</dt><dd><DirectionalUsage inputTokens={run.inputTokens} outputTokens={run.outputTokens} /></dd></div> : null}
    {showCost ? <div><dt>Cost</dt><dd>{formatCost(run.costUsd) || '—'}</dd></div> : null}
  </dl>
}

/** An honest em dash: this cell has nothing true to show. */
function Dash() {
  return <span className="text-xs text-soft-foreground">—</span>
}

function Sep() {
  return (
    <span className="text-soft-foreground" aria-hidden="true">
      ·
    </span>
  )
}

function BranchChip({ branch }: { branch: string }) {
  return (
    <span
      title={branch}
      className="block truncate rounded-[6px] bg-muted px-1.5 py-0.5 font-mono text-[11px] font-medium text-muted-foreground"
    >
      {branch}
    </span>
  )
}

/**
 * The overview wired to live data: `useRuns()` (kept fresh by the global SSE stream), a local
 * Active/Archived filter (independent of the sidebar quick-list), and the archive-finished
 * mutation. The invalidate on success is the authoritative half of the doctrine — the stream will
 * likely have patched each archived run already, but the endpoint's answer is the truth.
 */
export function TasksOverviewRoute() {
  const runs = useRuns()
  const health = useHealth()
  const metricVisibility = usageMetricVisibility(health.data)
  const { view, setView, origin, setOrigin, urlQuery, writeQuery } = useTasksUrlState()
  const queryClient = useQueryClient()
  const archived = useArchivedPages(runs.data, view)
  const archive = useMutation({
    mutationFn: (automation?: boolean) => archiveFinished(undefined, automation),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.runs.all }),
    onError: (error: Error) => toast(error.message, { tone: 'danger' }),
  })
  // "Mark all read" (#unread-done-items): one call stamps every unread finished run; the
  // invalidate is the authoritative half — each stamped run also rides the `run` SSE.
  const markAllRead = useMutation({
    mutationFn: (automation?: boolean) => markAllRunsSeen(automation),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.runs.all }),
    onError: (error: Error) => toast(error.message, { tone: 'danger' }),
  })
  // The table's inline rename — `usePatchRun` is per-run, so the any-row variant carries the id
  // in its variables. Same endpoint, same invalidation, same danger toast as the run header.
  const rename = useMutation({
    mutationFn: ({ id, title }: { id: string; title: string }) => patchRun(id, { title }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.runs.all }),
    onError: (error: Error) => toast(error.message, { tone: 'danger' }),
  })
  // Pinning (#935) — this page is the scoped project's own table, so no explicit project id.
  const pin = usePinRun()
  const now = useNow(30_000)
  const taskTableColumns = useTaskTableColumns()
  // Chip statuses are hydrated HERE rather than inside `TasksOverview`, which is a pure
  // presentational component rendered directly (and without a query client) by its tests. The
  // provider wraps it instead, so the chips deep in the table and the cards read their status
  // from context and nothing in between has to relay it.
  const projectId = useReferenceProjectId()
  // Same `retryOnMount: false` as the registry read below, for the same reason.
  const repoBase = useProjectRepoBase(undefined, { retryOnMount: false })
  // The scope gate already owns registry loading. Retrying its failed query when this
  // child mounts would make the gate unmount us, then mount/retry forever offline.
  const projects = useProjects({ retryOnMount: false })
  const projectName = projects.data?.projects?.find((project) => project.id === projectId)?.name
  // Older archived pages count too: a task found only there still needs its automation's name.
  const hasAutomationTasks = [...(runs.data ?? []), ...(archived.pages?.runs ?? [])].some((run) => run.automationId !== undefined)
  const automationNameIn = useAutomationNames([undefined], health.data?.capabilities?.automations === true && hasAutomationTasks)
  const automationName = React.useCallback((automationId: string) => automationNameIn(undefined, automationId), [automationNameIn])
  const referenceRequests = React.useMemo(
    () =>
      // `taskReference`, singular: this table paints exactly one chip per row (the strongest
      // reference), so asking about the others would be a request for something never shown.
      projectId === undefined
        ? []
        : (runs.data ?? []).flatMap((run) => {
            const reference = taskReference(run)
            return reference ? [{ projectId, kind: reference.kind, number: reference.number }] : []
          }),
    [runs.data, projectId],
  )

  return (
    <ReferenceStatusProvider projectId={projectId} repoBase={repoBase} requests={referenceRequests}>
      <TasksOverview
        runs={runs.data}
        projectName={projectName}
        error={runs.error?.message}
        onRetry={() => void runs.refetch()}
        view={view}
        onViewChange={setView}
        origin={origin}
        onOriginChange={setOrigin}
        urlQuery={urlQuery}
        onQueryChange={writeQuery}
        foldScope={`project:${projectId ?? 'default'}`}
        automationName={automationName}
        onArchiveFinished={(automation) => { if (!archive.isPending) archive.mutate(automation) }}
        archivePending={archive.isPending}
        onMarkAllRead={(automation) => markAllRead.mutate(automation)}
        onRename={(id, title) => rename.mutate({ id, title })}
        onTogglePin={(run, pinned) =>
          pin.mutate({ id: run.id, pinned })
        }
        now={now}
        showTokens={metricVisibility.tokens}
        showCost={metricVisibility.cost}
        expandedColumns={taskTableColumns.expandedColumns}
        onToggleColumn={taskTableColumns.toggleColumn}
        columnsPending={taskTableColumns.isPending}
        archivedPages={archived.pages}
        archivedTotal={archived.total}
        onArchivedSearch={archived.search}
      />
    </ReferenceStatusProvider>
  )
}

/** How long the search box waits before writing `q` to the URL: one history write per word. */
function setParam(key: string, value: string | null): SearchParamsUpdate {
  return (current) => {
    if (value === null) current.delete(key)
    else current.set(key, value)
    return current
  }
}

/**
 * View, origin and search, kept in the URL (hearsay-tools/cezarion#1616) so a reload or a pasted
 * link restores the list. View and origin are also state: the router renders each navigation in
 * a transition, and a tab must switch on the click, not when that transition lands. The search
 * reaches the URL after a short pause in typing.
 */
function useTasksUrlState() {
  const [searchParams, write] = useSearchParamsWriter()
  const urlView: ListView = searchParams.get('archived') === '1' ? 'archived' : 'active'
  const urlOrigin = parseOrigin(searchParams.get('origin'))
  const [view, setViewState] = React.useState(urlView)
  const [origin, setOriginState] = React.useState(urlOrigin)
  // A URL changed from outside the page (a pasted link, a sidebar link) wins.
  React.useEffect(() => setViewState(urlView), [urlView])
  React.useEffect(() => setOriginState(urlOrigin), [urlOrigin])
  const urlQuery = searchParams.get('q') ?? ''
  const timer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  React.useEffect(() => {
    const pending = timer
    return () => clearTimeout(pending.current)
  }, [])
  const writeQuery = React.useCallback<TasksQueryWriter>((query, written) => {
    clearTimeout(timer.current)
    const trimmed = query.trim()
    timer.current = setTimeout(() => write((current) => {
      const next = setParam('q', trimmed === '' ? null : trimmed)(current)
      // The writer navigates exactly when the params change, so this is a write the URL will show.
      if (next.get('q') !== current.get('q')) written(trimmed)
      return next
    }), QUERY_DEBOUNCE_MS)
  }, [write])
  return {
    view,
    setView: (next: ListView) => {
      setViewState(next)
      write(setParam('archived', next === 'archived' ? '1' : null))
    },
    origin,
    setOrigin: (next: TaskOrigin) => {
      setOriginState(next)
      write(setParam('origin', next === 'all' ? null : next))
    },
    urlQuery,
    writeQuery,
  }
}

const QUERY_DEBOUNCE_MS = 250

/** How long the Archived tab waits after a keystroke before it asks the server to search. */
const ARCHIVED_SEARCH_DEBOUNCE_MS = 150

/**
 * The Archived tab's reach past the run list's window (#864). The list carries the newest
 * `ARCHIVED_WINDOW` archived tasks; when it holds that many there may be older ones, so the tab
 * reads the server's pages (the first one overlaps the window, which is what lets the next one
 * add rows rather than repeat them). A search on that tab asks the server too, debounced, since
 * the matches can be anywhere in the history.
 */
function useArchivedPages(runs: readonly RunSummary[] | undefined, view: ListView): {
  pages: ArchivedPages | undefined
  total: number | undefined
  search: (needle: string) => void
} {
  const queryClient = useQueryClient()
  const [typed, setTyped] = React.useState('')
  const [needle, setNeedle] = React.useState('')
  React.useEffect(() => {
    const timer = setTimeout(() => setNeedle(typed), ARCHIVED_SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [typed])
  const windowFull = runs !== undefined && listCounts(runs).archived >= ARCHIVED_WINDOW
  const query = useArchivedRuns(needle, view === 'archived' && (needle !== '' || windowFull))
  const loaded = query.data?.pages
  const pages = React.useMemo<ArchivedPages | undefined>(() => (loaded || query.isError ? {
    runs: (loaded ?? []).flatMap((page) => page.runs),
    // `placeholderData` keeps the previous text's pages on screen while the next ones load.
    query: query.isPlaceholderData ? null : needle,
    hasMore: query.hasNextPage,
    loading: query.isFetchingNextPage,
    // A failed first page has nothing to continue from, so retrying it is a refetch.
    onLoadMore: () => void (loaded ? query.fetchNextPage() : query.refetch()),
    failed: query.isError,
  } : undefined), [loaded, query])
  // The tab counts every archived task, so only the unfiltered answer's total is the count; a
  // search's total is its matches.
  const unfiltered = needle === ''
    ? loaded
    : queryClient.getQueryData<InfiniteData<ArchivedRunsResponse>>(queryKeys.runs.archived(''))?.pages
  const plainHasMore = unfiltered === undefined ? undefined : unfiltered.at(-1)?.nextCursor != null
  return { pages: pages && { ...pages, plainHasMore }, total: unfiltered?.[0]?.total, search: setTyped }
}
