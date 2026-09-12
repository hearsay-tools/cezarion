import './task-lists.css'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { CheckCheckIcon, ChevronsLeftIcon, ChevronsRightIcon, Clock3Icon, CoinsIcon, DollarSignIcon, ListChecksIcon, LinkIcon, MemoryStickIcon, MoreHorizontalIcon, PencilIcon, ScaleIcon, SearchXIcon } from 'lucide-react'
import { ArchiveIcon, CpuIcon, FileDiffIcon, GitBranchIcon, PlusIcon, SearchIcon, WorkflowIcon } from '@/components/design-icons'
import * as React from 'react'
import { Link, useNavigate } from '@/lib/project-router'

import { archiveFinished, markAllRunsSeen, patchRun } from '@/api/client'
import { useRunUsage } from '@/api/global-events'
import { queryKeys, useHealth, usePinRun, useProjects, useReferenceProjectId, useRuns } from '@/api/queries'
import type { RunRecord } from '@open-mercato/cezar-api-client'
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
import { isReadDoneItem, isUnread, unreadDoneCount } from '@/lib/read-state'
import {
  isColumnExpanded,
  normalizeExpandedColumns,
  taskColumnsForCapabilities,
  type NormalizedExpandedColumns,
  type TaskColumnDefinition,
  type TaskColumnIcon,
  type TaskColumnId,
} from '@/lib/task-columns'
import { listCounts, queuePositions, runTitle, sortRuns, type ListView } from '@/lib/task-groups'
import {
  compareGroups,
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

/**
 * The Tasks overview — the table that IS the home at `/` (spec, "Task list & table", per PR
 * #392: the Tasks nav always lands here, there is no list/table presentation toggle). The
 * Active/Archived tabs in this header are this table's own, independent of the sidebar.
 *
 * Presentational: sorting, search, queue numbers, usage-cell decisions and the compare strip
 * all come from the pure modules (`lib/task-groups.ts`, `lib/tasks-table.ts`,
 * `lib/attention.ts`). What lives here is markup, the router, and the local search text.
 *
 * Below `md` the table becomes a stacked card list plus a New-task FAB — same rows, same order,
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
}: {
  /** Undefined while `/api/runs` has not answered: the header renders, the body stays empty —
   *  an empty state before we know there are no runs would be a lie. */
  runs: RunRecord[] | undefined
  view: ListView
  onViewChange: (view: ListView) => void
  archivePending?: boolean
  onArchiveFinished: () => void
  /** "Mark all read" (#unread-done-items) — stamps every unread finished run. */
  onMarkAllRead: () => void
  /** Inline rename from the table's Task cell (spec step 15) — the route wires this to
   *  `PATCH /api/runs/:id`, the same flow as the run header's pencil. */
  onRename: (id: string, title: string) => void
  /** Pin/unpin one task (#935). Pinned rows sort to the top of the table — `sortRuns` does that
   *  for every surface at once — so the row's own control is also the only thing on this page
   *  that explains why one is up there. */
  onTogglePin?: (run: RunRecord, pinned: boolean) => void
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
}) {
  const [query, setQuery] = React.useState('')
  const [detailedTable, setDetailedTable] = React.useState(false)
  const headerRef = React.useRef<HTMLElement>(null)
  const archiveSelected = React.useRef(false)
  const [actionsOpen, setActionsOpen] = React.useState(false)
  // A CSS-hidden Radix menu would keep its modal focus trap after a desktop resize.
  React.useEffect(() => {
    const media = window.matchMedia?.('(min-width: 768px)')
    if (!media) return
    const closeOnDesktop = () => { if (media.matches) setActionsOpen(false) }
    closeOnDesktop()
    media.addEventListener('change', closeOnDesktop)
    return () => media.removeEventListener('change', closeOnDesktop)
  }, [])
  const all = runs ?? []
  const counts = listCounts(all)
  const visible = sortRuns(filterRuns(all, query), view)
  // Positions come from the full list, never the filtered one: a search must not renumber the
  // queue the engine is actually going to drain.
  const positions = queuePositions(all)
  const strips = compareGroups(filterRuns(all, query), view)
  const finished = finishedRunCount(all)
  const columns = taskColumnsForCapabilities({ tokens: showTokens, cost: showCost })
  const unread = unreadDoneCount(all)
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
        <div className="flex flex-col gap-2"><h1 className="text-[30px] font-semibold tracking-tight">Project tasks</h1><p className="text-[13px] text-muted-foreground">{projectName ? `${projectName} · ` : ''}{detailedTable ? 'Every resource column shown. Fold columns without losing the saved view.' : 'Review runs, pull requests and resource usage.'}</p></div>
        <div className="flex gap-6 border-b border-border">
          <OverviewTab view="active" current={view} onSelect={onViewChange} count={counts.active}>
            Active
          </OverviewTab>
          <OverviewTab view="archived" current={view} onSelect={onViewChange} count={counts.archived}>
            Archived
          </OverviewTab>
        </div>
        <div data-slot="tasks-toolbar" className="flex flex-wrap items-center gap-2.5">
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
            Mark all read
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
            Archive finished
          </Button>
        ) : null}
        {view === 'active' && (finished > 0 || archivePending) ? (
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
              <DropdownMenuItem
                disabled={archivePending || finished === 0}
                onSelect={() => {
                  archiveSelected.current = true
                  onArchiveFinished()
                }}
              >
                <ArchiveIcon aria-hidden="true" />
                {archivePending ? 'Archiving…' : 'Archive finished'}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
        <div className="relative order-first w-full md:w-auto md:flex-1">
          <SearchIcon
            className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-soft-foreground"
            aria-hidden="true"
          />
          <input
            type="text"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search tasks…"
            aria-label="Search tasks"
            className="h-11 w-full rounded-md border border-input bg-card pr-3 pl-8 text-[13px] text-foreground outline-none placeholder:text-soft-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
          />
        </div>
        <Popover><PopoverTrigger asChild><Button data-slot="task-columns-trigger" variant="outline" className="hidden min-h-11 md:inline-flex">Columns</Button></PopoverTrigger><PopoverContent align="end" className="w-72">
          <h2 className="mb-2 text-base font-medium">Visible columns</h2><p className="mb-4 text-xs text-muted-foreground">Status and Task · Always visible</p>
          <div className="grid grid-cols-2 gap-3">{columns.filter((column) => column.canFold).map((column) => <label key={column.id} className="flex items-center gap-2 text-xs"><input data-column-toggle={column.id} type="checkbox" checked={isColumnExpanded(column.id, expandedColumns)} disabled={columnsPending} onChange={() => onToggleColumn(column.id)} />{column.id === 'diff' ? 'Diff' : column.id === 'reference' ? 'Reference' : column.id === 'memory' ? 'Memory' : column.label}</label>)}</div>
          <p className="mt-4 text-xs text-muted-foreground">Saved automatically. Tokens and cost appear only when supported.</p>
          <Button variant="outline" className="mt-4" onClick={() => setDetailedTable((value) => !value)}>{detailedTable ? 'Summary view' : 'Resource columns'}</Button>
        </PopoverContent></Popover>
        <Button asChild data-slot="new-task-inline" className="min-h-11 inline-flex"><Link to="/new"><PlusIcon aria-hidden="true" />New task</Link></Button>
        </div>
      </header>

      <div className="flex min-w-0 flex-1 flex-col">
        {runs === undefined ? error ? <div role="alert" className="rounded-xl border border-border bg-card p-6"><h2 className="text-lg">Could not load tasks</h2><p className="mt-2 text-sm text-muted-foreground">{error}</p><Button variant="outline" className="mt-4" onClick={onRetry}>Retry</Button></div> : <div role="status" aria-label="Loading tasks" className="rounded-xl border border-border bg-card p-6 text-sm text-muted-foreground">Loading tasks…</div> : visible.length === 0 ? (
          <TasksEmptyState view={view} query={query} />
        ) : (
          <>
            {!detailedTable ? <SummaryTasksTable projectName={projectName} runs={visible} positions={positions} onRename={onRename} onTogglePin={pinToggle} now={now} showTokens={showTokens} showCost={showCost} /> : null}
            {/* The detailed table retains every saved column preference. */}
            <div
              data-slot="tasks-table"
              hidden={!detailedTable}
              className={cn("hidden overflow-x-auto rounded-lg border border-border bg-card", detailedTable && "md:block")}
            >
              <TooltipProvider>
                <table className="w-full table-fixed border-collapse">
                  <colgroup>
                    {columns.map((column) => {
                      const expanded = isColumnExpanded(column.id, expandedColumns)
                      return (
                        <col
                          key={column.id}
                          data-column-id={column.id}
                          data-expanded={expanded}
                          style={{ width: expanded ? column.width : '42px' }}
                        />
                      )
                    })}
                  </colgroup>
                  <thead>
                    <tr>
                      {columns.map((column) => (
                        <TaskColumnHeader
                          key={column.id}
                          column={column}
                          expanded={isColumnExpanded(column.id, expandedColumns)}
                          onToggle={onToggleColumn}
                          disabled={columnsPending}
                        />
                      ))}
                    </tr>
                  </thead>
                  <tbody className="[&>tr:last-child>td]:border-b-0">
                    {visible.map((run) => (
                      <TableRow
                        key={run.id}
                        run={run}
                        queuePosition={run.status === 'queued' ? (positions.get(run.id) ?? null) : null}
                        onRename={onRename}
                        onTogglePin={pinToggle}
                        now={now}
                        columns={columns}
                        expandedColumns={expandedColumns}
                      />
                    ))}
                  </tbody>
                </table>
              </TooltipProvider>
            </div>

            {/* <md: the same runs as stacked cards. */}
            <div data-slot="task-cards" className="flex flex-col rounded-lg border border-border bg-card p-5 md:hidden">
              {visible.map((run) => (
                <TaskCard
                  key={run.id}
                  run={run}
                  projectName={projectName}
                  queuePosition={run.status === 'queued' ? (positions.get(run.id) ?? null) : null}
                  now={now}
                  showTokens={showTokens}
                  showCost={showCost}
                  onTogglePin={pinToggle}
                />
              ))}
            </div>
            <p className="mt-[22px] text-[11px] text-muted-foreground md:hidden">Resource details—including tokens, cost, CPU and peak memory—are available when a task row is expanded.</p>
          </>
        )}

        {strips.map((group) => (
          <div
            key={group.groupId}
            data-slot="compare-strip"
            data-group-id={group.groupId}
            className="mt-3.5 flex flex-wrap items-center gap-2.5 rounded-lg border border-border bg-card px-3.5 py-2.5 text-[12.5px] text-muted-foreground shadow-xs"
          >
            <ScaleIcon className="size-[15px] shrink-0 text-soft-foreground" aria-hidden="true" />
            <span>
              <strong className="font-semibold text-foreground">{group.title}</strong> — {group.count} variants
              finished
            </span>
            <Button asChild variant="outline" size="sm" className="md:ml-auto">
              <Link to={`/compare/${group.groupId}`}>Compare</Link>
            </Button>
          </div>
        ))}
      </div>

      {/* The mobile New-task FAB. The desktop CTA lives in the sidebar. A router Link since
          R4 step 1.3 re-pointed /new at the React composer — no full page load needed. */}
      <Link
        to="/new"
        data-slot="new-task-fab"
        aria-label="New task"
        className="fixed right-4 bottom-[calc(16px+env(safe-area-inset-bottom))] z-20 inline-flex size-14 items-center justify-center rounded-full bg-action text-action-foreground shadow-modal md:hidden"
      >
        <PlusIcon className="size-[22px]" aria-hidden="true" />
      </Link>
    </div>
  )
}

/**
 * What an empty list honestly means, given how it got empty — as a CenteredState, one variant
 * per cause. Only the no-tasks-at-all state is a hero moment and gets the twinkle backdrop
 * (spec: textures on hero/empty surfaces only); a missed search or an unswept archive is just
 * a fact, so those stay flat. `heading="h2"` because the page's h1 is the header's "Tasks".
 */
function TasksEmptyState({ view, query }: { view: ListView; query: string }) {
  const needle = query.trim()
  const kind = needle ? 'search-miss' : view === 'archived' ? 'archive' : 'no-tasks'
  return (
    <div data-slot="tasks-empty" data-empty-kind={kind} className="flex flex-1 flex-col">
      {kind === 'search-miss' ? (
        <CenteredState
          heading="h2"
          icon={<SearchXIcon />}
          tone="neutral"
          title="No matching tasks"
          subtitle={`No tasks match “${needle}”.`}
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
function SummaryTasksTable({ projectName, runs, positions, onRename, onTogglePin, now, showTokens, showCost }: {
  projectName?: string
  runs: RunRecord[]
  positions: Map<string, number>
  onRename: (id: string, title: string) => void
  onTogglePin?: (run: RunRecord, pinned: boolean) => void
  now: number
  showTokens: boolean
  showCost: boolean
}) {
  const [expanded, setExpanded] = React.useState<Set<string>>(() => new Set())
  return <div data-slot="tasks-summary" className="hidden md:block"><div className="rounded-lg border border-border bg-card p-5">
    <table className="w-full table-fixed border-collapse">
      <colgroup><col /><col className="w-[136px]" /><col className="w-[106px]" /><col className="w-[116px]" /><col className="w-[70px]" /></colgroup>
      <thead><tr>{['Task', 'Workflow', 'Changes', 'Pull request', 'Started'].map((label) => <th key={label} className="h-8 border-b border-border text-left text-[10px] font-medium uppercase text-muted-foreground">{label}</th>)}</tr></thead>
      <tbody>{runs.map((run) => {
        const attention = deriveAttention(run)
        const scheduled = scheduledResume(run)
        const reference = taskReference(run)
        const open = expanded.has(run.id)
        const detailId = `task-resources-${run.id}`
        return <React.Fragment key={run.id}>
          <tr data-status={run.status} data-slot="task-summary-row" className="group/row border-b border-border last:border-0">
            <td className="py-5 pr-4 align-top">
              <TitleCell run={run} to={`/tasks/${run.id}`} onRename={onRename} onTogglePin={onTogglePin} />
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <button type="button" aria-label={`${open ? 'Hide' : 'Show'} resources for ${runTitle(run)}`} aria-expanded={open} aria-controls={detailId} aria-describedby={`summary-status-${run.id}`} onClick={() => setExpanded((current) => { const next = new Set(current); if (open) next.delete(run.id); else next.add(run.id); return next })} className="inline-flex min-h-[26px] items-center gap-1 rounded-md p-0 text-[11px] text-muted-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"><Pill id={`summary-status-${run.id}`} dot={attention.tone} pulse={attention.pulse}>{attention.label}{scheduled ? ` ${scheduled.label}` : ''}</Pill></button>
                {projectName ? <span className="text-xs text-muted-foreground">{projectName}</span> : null}
                {run.status === 'queued' ? <span className="text-xs text-muted-foreground">#{positions.get(run.id)} in queue</span> : null}

              </div>
            </td>
            <td className="truncate pr-3 text-xs text-muted-foreground" title={workflowLabel(run)}>{workflowLabel(run)}</td>
            <td className="pr-2 text-xs">{run.diffStat ? <DiffStatLabel stat={run.diffStat} /> : <Dash />}</td>
            <td className="pr-2">{reference ? <TaskReferenceChip run={run} reference={reference} compact /> : <Dash />}</td>
            <td className="text-xs text-muted-foreground">{shortAge(run.startedAt ?? run.createdAt, now)}</td>
          </tr>
          {open ? <tr><td colSpan={5} className="border-b border-border pb-5"><div id={detailId} className="rounded-md bg-muted/50 p-4"><TaskResourceDetails run={run} showTokens={showTokens} showCost={showCost} /></div></td></tr> : null}
        </React.Fragment>
      })}</tbody>
    </table>
    </div><p className="mt-[22px] text-[11px] text-muted-foreground">Resource details—including tokens, cost, CPU and peak memory—are available when a task row is expanded.</p>
  </div>
}

function TaskResourceDetails({ run, showTokens, showCost }: { run: RunRecord; showTokens: boolean; showCost: boolean }) {
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
  count: number
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
        'flex min-h-11 items-center justify-center gap-1.5 border-b-2 border-transparent text-[12.5px] font-medium text-muted-foreground',
        isActive && 'border-accent-strong font-semibold text-accent-text'
      )}
    >
      {children}
      {count > 0 ? <span className="tabular-nums"> · {count}</span> : null}
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
}: {
  run: RunRecord
  queuePosition: number | null
  onRename: (id: string, title: string) => void
  onTogglePin?: (run: RunRecord, pinned: boolean) => void
  now: number
  columns: readonly TaskColumnDefinition[]
  expandedColumns: NormalizedExpandedColumns
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
          return queuePosition !== null ? (
            <td
              key={column.id}
              data-slot="queue-note"
              data-column-id="cpu-memory"
              colSpan={2}
              className={cn(TD_BASE, 'text-right font-mono text-[11.5px] text-supporting-foreground')}
            >
              #{queuePosition} in queue
            </td>
          ) : (
            <UsageTds
              key={column.id}
              run={run}
              cpuExpanded={isColumnExpanded('cpu', expandedColumns)}
              memoryExpanded={isColumnExpanded('memory', expandedColumns)}
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
}: {
  column: TaskColumnDefinition
  expanded: boolean
  run: RunRecord
  attention: ReturnType<typeof deriveAttention>
  scheduled: ReturnType<typeof scheduledResume>
  reference: ReturnType<typeof taskReference>
  cost: string
  to: string
  onRename: (id: string, title: string) => void
  onTogglePin?: (run: RunRecord, pinned: boolean) => void
  now: number
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
        </td>
      )
    case 'workflow':
      return (
        <td data-column-id={column.id} className={cn(TD_BASE, 'max-w-0 truncate text-[12.5px] text-muted-foreground')}>
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
    case 'cpu':
    case 'memory':
      return null
  }
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
  run: RunRecord
  to: string
  onRename: (id: string, title: string) => void
  onTogglePin?: (run: RunRecord, pinned: boolean) => void
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
      {/* The unread marker — same trailing violet dot as the sidebar row. */}
      {unread ? (
        <StatusDot
          tone="accent"
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
  run: RunRecord
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
        cell.kind === 'peak' && 'text-[11.5px] text-supporting-foreground',
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
  projectName,
  queuePosition,
  now,
  showTokens,
  showCost,
  onTogglePin,
}: {
  run: RunRecord
  projectName?: string
  queuePosition: number | null
  now: number
  showTokens: boolean
  showCost: boolean
  onTogglePin?: (run: RunRecord, pinned: boolean) => void
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
        <button data-slot="mobile-resources-toggle" type="button" aria-controls={`mobile-resources-${run.id}`} aria-describedby={`mobile-status-${run.id}`} aria-label={resourcesOpen ? 'Hide resources' : 'Show resources'} title={resourcesOpen ? 'Hide resources' : 'Show resources'} aria-expanded={resourcesOpen} onClick={() => setResourcesOpen((value) => !value)}><Pill id={`mobile-status-${run.id}`} dot={attention.tone} pulse={attention.pulse} className="mt-px shrink-0" title={scheduled?.title}>
          {attention.label}
          {scheduled ? <span className="tabular-nums">{scheduled.label}</span> : null}
        </Pill></button>
        <Link
          to={to}
          className={cn(
            'order-first w-full min-w-0 rounded-sm text-[13.5px] leading-[1.35] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-link-foreground',
            unread ? 'font-semibold text-foreground' : readDone ? 'font-normal text-foreground' : 'font-medium'
          )}
        >
          {run.delegation?.role === 'worker' ? <span className="mr-2 text-xs text-muted-foreground">Worker</span> : null}
          {runTitle(run)}
        </Link>
        {/* The unread marker — trailing violet dot, as on the desktop row. */}
        {unread ? (
          <StatusDot
            tone="accent"
            role="img"
            aria-label="unread"
            title="Unread — not opened since it finished"
            className="mt-1.5 shrink-0"
          />
        ) : null}
        {projectName ? <span className="text-xs text-muted-foreground">{projectName}</span> : null}
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
      {resourcesOpen ? <MobileResources run={run} showTokens={showTokens} showCost={showCost} /> : null}
    </div>
  )
}

/** Subscribe to live resource samples only while this card's details are open. */
function MobileResources({ run, showTokens, showCost }: { run: RunRecord; showTokens: boolean; showCost: boolean }) {
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
      className="block truncate rounded-[6px] bg-muted px-1.5 py-0.5 font-mono text-[11.5px] font-medium text-muted-foreground"
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
  const [view, setView] = React.useState<ListView>('active')
  const queryClient = useQueryClient()
  const archive = useMutation({
    mutationFn: archiveFinished,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.runs.all }),
    onError: (error: Error) => toast(error.message, { tone: 'danger' }),
  })
  // "Mark all read" (#unread-done-items): one call stamps every unread finished run; the
  // invalidate is the authoritative half — each stamped run also rides the `run` SSE.
  const markAllRead = useMutation({
    mutationFn: markAllRunsSeen,
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
  // The scope gate already owns registry loading. Retrying its failed query when this
  // child mounts would make the gate unmount us, then mount/retry forever offline.
  const projects = useProjects({ retryOnMount: false })
  const projectName = projects.data?.projects?.find((project) => project.id === projectId)?.name
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
    <ReferenceStatusProvider projectId={projectId} requests={referenceRequests}>
      <TasksOverview
        runs={runs.data}
        projectName={projectName}
        error={runs.error?.message}
        onRetry={() => void runs.refetch()}
        view={view}
        onViewChange={setView}
        onArchiveFinished={() => { if (!archive.isPending) archive.mutate() }}
        archivePending={archive.isPending}
        onMarkAllRead={() => markAllRead.mutate()}
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
      />
    </ReferenceStatusProvider>
  )
}
