import { ArchiveIcon, ChevronDownIcon, ChevronRightIcon } from '@/components/design-icons'
import { ScaleIcon, SendIcon } from 'lucide-react'
import { useQueries } from '@tanstack/react-query'
import * as React from 'react'
import { queryScope } from '@open-mercato/cezar-api-client'
import { useSidebarArchive } from '@/components/sidebar-archive'
import { useSidebarNavigate } from '@/components/app-shell'
import { useSwipeToArchive } from '@/components/use-swipe-to-archive'
import { useHealth, usePinRun, useProjectUiState, useProjectRuns, useProjectRepoBase, useProjects, useReferenceProjectId, useRuns } from '@/api/queries'
import { Link, scopeTo, useNavigate, useProjectMatch } from '@/lib/project-router'
import type { ArchiveFinishedScope, RunRecord, SidebarLimits } from '@open-mercato/cezar-api-client'
import { DiffStatLabel } from '@/components/diff-stat'
import { useListView } from '@/components/list-view'
import { PinToggle } from '@/components/pin-toggle'
import { TaskReferenceChip } from '@/components/reference-conflict-action'
import { ReferenceStatusProvider } from '@/components/reference-status'
import { StatusDot } from '@/components/status-dot'
import { deriveAttention, type Attention } from '@/lib/attention'
import { groupMetaParts, referenceKey, resumeLabel, sharedReferenceKeys } from '@/lib/group-summary'
import { useNoHover } from '@/lib/use-no-hover'
import { useIsDesktop } from '@/lib/use-desktop'
import { shortAge } from '@/lib/format'
import { isUnread, unreadMarkerTone } from '@/lib/read-state'
import { directionalUsageText } from '@/components/directional-usage'
import {
  capBuckets,
  groupRuns,
  listCounts,
  loudestMember,
  refPrefixMatches,
  runTitle,
  sidebarActiveRunId,
  splitRefPrefix,
  type ListView,
  type QuickListBucket,
  type QuickListRow,
} from '@/lib/task-groups'
import { formatCost, isSweepable, sweepableRunCount, taskReference, taskReferences } from '@/lib/tasks-table'
import { usageMetricVisibility } from '@/lib/token-metrics'
import { useNow } from '@/lib/use-now'
import { useSidebarSections } from '@/lib/use-sidebar-sections'
import { cn } from '@/lib/utils'

/**
 * The sidebar's task quick-list (spec, "App shell & navigation"): Active/Archived tabs, then the
 * runs grouped Needs you / Finished / Working, with variant groups collapsed into one tile.
 *
 * Presentational — every decision it paints (which bucket, which order, which dot, whether a
 * group collapses) is made by `lib/task-groups.ts` and `lib/attention.ts`, which are pure and
 * table-tested. What is left here is markup, the router, and the expand/collapse toggle.
 */
export function TaskQuickList({
  runs,
  view,
  onViewChange,
  currentRunId = null,
  currentGroupId = null,
  now = Date.now(),
  showTokens = true,
  showCost = true,
  onTogglePin,
  onArchiveRun,
  onSweep,
  sweeping = null,
  showViewControls = true,
  rowLimit,
  sidebarLimits,
  projectId = null,
}: {
  runs: RunRecord[]
  view: ListView
  onViewChange: (view: ListView) => void
  /** The run open at `/tasks/:id`, so its row can show as active. */
  currentRunId?: string | null
  /** The variant group open at `/compare/:groupId`, so its group row can show as active. */
  currentGroupId?: string | null
  /** Injected so the ages are not racing the clock in tests. */
  now?: number
  /** Presentation capability; defaults visible for older health responses and direct renders. */
  showTokens?: boolean
  showCost?: boolean
  /** Pin/unpin one row (#935). The container owns the mutation, because WHICH project a row
   *  belongs to is a container's question — this list is painted for other projects too. */
  onTogglePin?: (run: RunRecord, pinned: boolean) => void
  /** Archive one finished row (#780). Like the pin, the container owns the mutation. */
  onArchiveRun?: (run: RunRecord) => void | Promise<unknown>
  /** Sweep unpinned finished rows across the full project list. */
  onSweep?: (scope: ArchiveFinishedScope) => void
  /** The sweep in flight, so its button reads busy. */
  sweeping?: ArchiveFinishedScope | null
  showViewControls?: boolean
  rowLimit?: number
  sidebarLimits?: SidebarLimits
  /** Canonical project id for browser-local section folding; null while discovery is pending. */
  projectId?: string | null
}) {
  const onNavigate = useSidebarNavigate()
  const counts = listCounts(runs)
  const allBuckets = groupRuns(runs, view)
  const buckets = capBuckets(allBuckets, sidebarLimits ?? rowLimit ?? { overall: null })
  // Withheld in the archived view, where `groupRuns` answers one `Archived` bucket and never
  // reads `run.pinned` — the same call the thread header makes on an archived run.
  const pinToggle = view === 'archived' ? undefined : onTogglePin
  // Archiving is withheld there too: the Archived view has nothing left to file away, and
  // restoring stays in the thread and the Tasks table.
  const archiveRow = view === 'archived' ? undefined : onArchiveRun
  const sweep = view === 'archived' ? undefined : onSweep
  // From the FULL list, not the capped buckets: "Archive all" sweeps rows the cap hides, so its
  // visibility must not depend on which of them are painted.
  const sweepCounts = sweep ? sweepCountsOf(runs) : undefined

  return (
    <div data-slot="quick-list">
      <div data-slot="quick-list-header" className="flex min-h-11 items-center gap-1.5 pr-[6px] pl-[10px] md:min-h-[26px]">
        <h2 className="text-[13px] font-semibold text-foreground">Tasks</h2>
        <span className="text-[11.5px] text-soft-foreground">{counts[view]}</span>
        <Link to="/" onClick={onNavigate} className="ml-auto flex min-h-11 items-center gap-0.5 text-[12px] text-soft-foreground hover:text-foreground md:min-h-[26px]">
          All<ChevronRightIcon className="size-[13px]" aria-hidden="true" />
        </Link>
      </div>
      {/* Sticky, not scrolled away: the tabs say what you are looking at, and a long Finished list
          must not be able to hide that the view is filtered. */}
      {showViewControls ? <div className="sticky top-0 z-10 bg-sidebar pt-2 pb-1">
        <div className="inline-flex w-full gap-0.5 rounded-md bg-muted p-[2px]">
          <ViewTab view="active" current={view} onSelect={onViewChange} count={counts.active}>
            Active
            {/* The one reason to look at a tab you are not on. */}
            {counts.waiting > 0 && view !== 'active' ? (
              <StatusDot tone="pending" pulse data-slot="waiting-dot" aria-label="needs you" />
            ) : null}
          </ViewTab>
          <ViewTab view="archived" current={view} onSelect={onViewChange} count={counts.archived}>
            Archived
          </ViewTab>
        </div>
      </div> : null}

      {allBuckets.length === 0 ? (
        <p className="px-3 py-3.5 text-xs text-soft-foreground">
          {view === 'archived' ? 'Nothing archived yet.' : 'No tasks yet — describe one.'}
        </p>
      ) : (
        <QuickListBuckets
          buckets={buckets}
          allBuckets={view === 'active' ? allBuckets : buckets}
          sectionProjectId={projectId}
          currentRunId={sidebarActiveRunId(currentRunId, runs)}
          currentGroupId={currentGroupId}
          now={now}
          showTokens={showTokens}
          showCost={showCost}
          onTogglePin={pinToggle}
          onArchiveRun={archiveRow}
          onSweep={sweep}
          sweeping={sweeping}
          sweepCounts={sweepCounts}
        />
      )}
    </div>
  )
}

/** How many runs each group sweep would take: the same predicate the server sweeps with. */
export function sweepCountsOf(runs: readonly RunRecord[]): { unpinned: number; pinned: number } {
  return { unpinned: sweepableRunCount(runs, 'unpinned'), pinned: sweepableRunCount(runs, 'pinned') }
}


/**
 * The bucketed rows alone — the piece the multi-project sidebar reuses per project group
 * (step 3.3), without the Active/Archived tabs that belong to the boot list's framing.
 *
 * `scope` prefixes every row target with an EXPLICIT `/p/<id>` (a non-active project's rows
 * must land in that project); `null` keeps the wrapper-Link default — the active scope.
 */
export function QuickListBuckets({
  buckets,
  currentRunId = null,
  currentGroupId = null,
  now = Date.now(),
  scope = null,
  showTokens = true,
  showCost = true,
  onTogglePin,
  onArchiveRun,
  onSweep,
  sweeping = null,
  sweepCounts,
  projectName,
  allBuckets = buckets,
  sectionProjectId = scope,
}: {
  buckets: QuickListBucket[]
  /** Full sections retain honest task counts/attention even when the row budget is exhausted. */
  allBuckets?: QuickListBucket[]
  sectionProjectId?: string | null
  currentRunId?: string | null
  currentGroupId?: string | null
  now?: number
  scope?: string | null
  showTokens?: boolean
  showCost?: boolean
  onTogglePin?: (run: RunRecord, pinned: boolean) => void
  onArchiveRun?: (run: RunRecord) => void | Promise<unknown>
  onSweep?: (scope: ArchiveFinishedScope) => void
  sweeping?: ArchiveFinishedScope | null
  /** What each group sweep would take, from the whole list. Absent = no group buttons. */
  sweepCounts?: { unpinned: number; pinned: number }
  /** Names the project in a group button's accessible name, where several lists share a page. */
  projectName?: string
}) {
  const headingId = React.useId()
  const sections = useSidebarSections(sectionProjectId)
  const listRef = React.useRef<HTMLDivElement>(null)
  const focusedRow = React.useRef<{ kind: 'run' | 'group'; id: string; element: HTMLElement } | null>(null)
  React.useLayoutEffect(() => {
    const previous = focusedRow.current
    if (!previous || previous.element.isConnected) return
    // A disconnected control gets one recovery attempt, never a claim on future focus after
    // removal or navigation. A successful focus below captures the newly mounted control.
    focusedRow.current = null
    if (document.activeElement !== document.body) return
    const destination = allBuckets.find(bucket => bucket.rows.some(row =>
      previous.kind === 'group'
        ? row.kind === 'group' && row.groupId === previous.id
        : row.kind === 'run' ? row.run.id === previous.id : row.members.some(member => member.id === previous.id),
    ))
    // Removal belongs to the archive controller. A status move belongs to this list; if its
    // destination is folded, focus the disclosure rather than silently unfolding the section.
    if (!destination) return
    const bucket = Array.from(listRef.current?.children ?? []).find(el => (el as HTMLElement).dataset.bucket === destination.label)
    const row = Array.from(bucket?.querySelectorAll<HTMLElement>('[data-slot="task-row"], [data-slot="group-row"]') ?? [])
      .find(el => (previous.kind === 'group' ? el.dataset.groupId : el.dataset.runId) === previous.id)
    // Group links include compare AND shared references. Keep the same link when it survives;
    // otherwise return to the group's disclosure. Member rows keep their own run-link target.
    const rowTarget = previous.kind === 'group'
      ? Array.from(row?.querySelectorAll<HTMLElement>('a') ?? []).find(el =>
          previous.element.tagName === 'A' && el.getAttribute('href') === previous.element.getAttribute('href'))
        ?? row?.querySelector<HTMLElement>('[data-slot="group-tile"]')
      : row?.querySelector<HTMLElement>('a')
    const target = rowTarget ?? bucket?.querySelector<HTMLElement>('[data-slot="section-toggle"]')
    target?.focus({ preventScroll: true })
  })
  // Which variant groups are open. Local: it is view state about this list, nothing else reads it.
  const [expanded, setExpanded] = React.useState<ReadonlySet<string>>(() => new Set())
  const toggleGroup = (groupId: string) =>
    setExpanded((current) => {
      const next = new Set(current)
      if (!next.delete(groupId)) next.add(groupId)
      return next
    })

  const renderRow = (row: QuickListRow) => <Row row={row} currentRunId={currentRunId} currentGroupId={currentGroupId} now={now} scope={scope} showTokens={showTokens} showCost={showCost} expanded={row.kind === 'group' && expanded.has(row.groupId)} onToggle={toggleGroup} onTogglePin={onTogglePin} onArchiveRun={onArchiveRun} />

  return (
    <div ref={listRef} className="flex flex-col gap-3" onFocusCapture={event => {
      const row = event.target.closest<HTMLElement>('[data-slot="task-row"], [data-slot="group-row"]')
      focusedRow.current = row?.dataset.runId
        ? { kind: 'run', id: row.dataset.runId, element: event.target }
        : row?.dataset.groupId ? { kind: 'group', id: row.dataset.groupId, element: event.target } : null
    }} onBlurCapture={event => {
      // An intentional exit (including blur to body) must not be restored by a later update.
      // Removing a focused row does not emit blur; that is the status-move path above.
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) focusedRow.current = null
    }}>
      {allBuckets.map((bucket) => {
        const archived = bucket.label === 'Archived'
        const collapsed = sections.isCollapsed(bucket.label)
        const rows = buckets.find(({ label }) => label === bucket.label)?.rows ?? []
        const members = bucket.rows.flatMap(row => row.kind === 'run' ? [row.run] : row.members)
        const count = archived ? bucket.rows.length : members.length
        const attention = members.length ? deriveAttention(loudestMember(members)) : null
        const unread = members.some(isUnread)
        const id = `${headingId}-${bucket.label.replaceAll(' ', '-')}`
        const Disclosure = collapsed ? ChevronRightIcon : ChevronDownIcon
        return (
        <div key={bucket.label} data-slot="quick-list-bucket" data-bucket={bucket.label}>
          <div className="flex items-center justify-between gap-2 pr-[6px]">
            <h2 id={id} className="min-w-0 flex-1 text-[11px] font-medium text-soft-foreground">
              {archived ? <span className="px-[10px] pt-[2px] pb-[4px]">{bucket.label} {count}</span> : (
                <button type="button" data-slot="section-toggle" aria-expanded={!collapsed} aria-controls={`${id}-rows`}
                  aria-label={`${bucket.label} ${count}`} onClick={() => sections.toggle(bucket.label as Exclude<QuickListBucket['label'], 'Archived'>)}
                  className="flex min-h-[44px] w-full items-center gap-1.5 rounded-[4px] px-[10px] text-left hover:bg-sidebar-row-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-link-foreground md:min-h-[26px] no-hover:min-h-[44px]">
                  <Disclosure className="size-[12px] shrink-0" aria-hidden="true" />
                  <span>{bucket.label}</span>{' '}<span className="font-normal tabular-nums">{count}</span>
                  {attention && (bucket.label === 'Needs you' || collapsed) ? <StatusDot tone={attention.tone} shape={attention.shape} pulse={attention.pulse} role="img" aria-label={attention.label} title={attention.label} /> : null}
                  {collapsed && unread ? <span role="img" aria-label="unread" title="Unread tasks" className="size-[5px] shrink-0 rounded-full bg-foreground" /> : null}
                </button>
              )}
            </h2>
            {/* A sibling of the heading, so its accessible name stays `Finished 3`. */}
            {onSweep && sweepCounts ? <GroupSweepButton label={bucket.label} headingId={id} projectName={projectName} counts={sweepCounts} onSweep={onSweep} sweeping={sweeping} /> : null}
          </div>
          <div id={`${id}-rows`} hidden={collapsed}>
          {!collapsed && rows.map((row) => (
            <div key={row.kind === 'group' ? row.groupId : row.run.id}>
              {renderRow(row)}
            </div>
          ))}
          </div>
        </div>
      )})}
    </div>
  )
}

function ViewTab({
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
      data-slot="view-tab"
      data-view={view}
      // Toggle buttons rather than a real tablist: these filter one list in place, they do not
      // switch between panels — `aria-pressed` is what that actually is.
      aria-pressed={isActive}
      onClick={() => onSelect(view)}
      className={cn(
        'flex min-h-11 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-[7px] text-[11px] font-medium text-muted-foreground md:min-h-[22px]',
        isActive && 'bg-card font-semibold text-foreground shadow-xs'
      )}
    >
      {children}
      {/* No "0": an empty bucket says so by being empty. */}
      {count > 0 ? <span className="font-mono text-[11px] tabular-nums">{count}</span> : null}
    </button>
  )
}

function Row({
  row,
  currentRunId,
  currentGroupId,
  now,
  scope,
  expanded,
  onToggle,
  showTokens,
  showCost,
  onTogglePin,
  onArchiveRun,
}: {
  row: QuickListRow
  currentRunId: string | null
  currentGroupId: string | null
  now: number
  scope: string | null
  expanded: boolean
  onToggle: (groupId: string) => void
  showTokens: boolean
  showCost: boolean
  onTogglePin?: (run: RunRecord, pinned: boolean) => void
  onArchiveRun?: (run: RunRecord) => void | Promise<unknown>
}) {
  if (row.kind === 'run') {
    return (
      <RunRow
        run={row.run}
        queuePosition={row.queuePosition}
        currentRunId={currentRunId}
        now={now}
        scope={scope}
        showTokens={showTokens}
        showCost={showCost}
        onTogglePin={onTogglePin}
        onArchiveRun={onArchiveRun}
      />
    )
  }
  return (
    <>
      <GroupRow
        row={row}
        now={now}
        scope={scope}
        expanded={expanded}
        onToggle={onToggle}
        // One highlighted row (#617): the group while its compare page is open, or while a
        // member's thread is open and the group is collapsed (the member row is not painted
        // then, so the group says where you are). Expanded, the member row takes it instead.
        active={currentGroupId === row.groupId || (!expanded && row.members.some((member) => member.id === currentRunId))}
      />
      {/* No pin on the group (#935): a pin is per task, and the group row stands in for two or
           three of them. Expanding it pins the variant you mean, and the group rises within its
           status section with it. */}
      {expanded ? (
        <ExpandedVariantMembers
          members={row.members}
          currentRunId={currentRunId}
          now={now}
          scope={scope}
          showTokens={showTokens}
          showCost={showCost}
          onTogglePin={onTogglePin}
          onArchiveRun={onArchiveRun}
        />
      ) : null}
    </>
  )
}

/**
 * Whether a list row's references render as inert text (#617 01b): on a device that cannot hover,
 * and in the mobile shell, where the row itself is the tap target. One condition for task,
 * variant and group rows alike, so a reference is never a link in one and text in its neighbour.
 */
function useRowReferencesInert(): boolean {
  const noHover = useNoHover()
  const desktop = useIsDesktop()
  return noHover || !desktop
}

/**
 * The variant group's row (#617 addendum 01a): the task row's skeleton — a 12px status slot, two
 * fixed lines, a reserved trailing slot — so a group and a task read as the same kind of thing.
 *
 *   [lead dot] [title ×N                     ] [compare ›]
 *              [1 needs you · 1 working · #425 · 12m]
 *
 * The toggle is a real `<button>` (keyboard and screen readers get `aria-expanded`), and a click
 * anywhere else on the row but a link toggles too. Two structures: with a hover pointer on the
 * desktop shell the button covers line 1 only, and line 2's shared references are real links
 * BESIDE it (a link inside a button is invalid); on touch or in the mobile shell the references
 * are inert text and the button covers both lines at full row height, which is what keeps the
 * mobile 44px button floor (#166) from growing the row. The compare link is always a sibling.
 * The trailing slot is a constant 36px (60px on touch), and both lines are fixed boxes,
 * so expanding or collapsing changes nothing about this row's height.
 */
function GroupRow({
  row,
  now,
  scope,
  expanded,
  onToggle,
  active,
}: {
  row: Extract<QuickListRow, { kind: 'group' }>
  now: number
  scope: string | null
  expanded: boolean
  onToggle: (groupId: string) => void
  active: boolean
}) {
  const onNavigate = useSidebarNavigate()
  const lead = deriveAttention(row.lead)
  const projectId = scope ?? undefined
  const { families, shared, age } = groupMetaParts(row.members, now, projectId)
  // Touch, or the mobile shell (#617 01b): references are inert text, and the toggle spans both
  // lines — the mobile stylesheet floors every button at 44px (#166), so a line-1-only button
  // would push this row from 47px to ~72px. The whole-row button meets that floor by itself.
  const touch = useRowReferencesInert()
  const first = row.members[0]!
  const sharedReferences = taskReferences(first, undefined, projectId).filter((reference) => shared.has(referenceKey(reference)))
  // Line 2 in the task row's own grammar: words, then the shared references as the same plain
  // links (with the status panel) a task row uses — inert text on touch (#617 01b) — then the age.
  const meta: React.ReactNode[] = [
    ...families.map((family) => <span key={`family-${family}`}>{family}</span>),
    ...sharedReferences.map((reference) => (
      <TaskReferenceChip
        key={`${reference.kind}-${reference.number}-${reference.url}`}
        run={first}
        reference={reference}
        plain
        inert={touch}
      />
    )),
    ...(age ? [<span key="age" className="tabular-nums">{age}</span>] : []),
  ]
  const Disclosure = expanded ? ChevronDownIcon : ChevronRightIcon
  const lineOne = (
    <>
      <span
        data-slot="group-title"
        className={cn('min-w-0 truncate text-[13px] leading-[1.45] font-medium text-muted-foreground', active && 'text-foreground')}
      >
        {row.title}
      </span>
      {/* Never truncates: the count is the one thing that says this row is several tasks. */}
      <span data-slot="group-count" className="shrink-0 rounded-[9px] bg-muted px-1.5 py-px font-mono text-[11px] leading-[1.3] font-semibold tabular-nums text-muted-foreground">
        ×{row.members.length}
      </span>
    </>
  )
  const lineTwoClass = cn(
    'block h-[16px] w-full min-w-0 truncate text-[11.5px] leading-[1.4] font-normal text-soft-foreground',
    active && 'text-muted-foreground',
  )
  const lineTwo = meta.length ? meta.flatMap((part, index) => (index ? [<MetaSeparator key={`sep-${index}`} />, part] : [part])) : '\u00a0'
  const toggleClass = 'w-full min-w-0 rounded-[2px] text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-link-foreground'
  return (
    <div
      data-slot="group-row"
      data-group-id={row.groupId}
      data-active={active ? 'true' : undefined}
      data-structure={touch ? 'touch' : 'pointer'}
      onClick={(event) => {
        if (!event.currentTarget.contains(event.target as Node)) return
        if ((event.target as Element).closest('a, button')) return
        onToggle(row.groupId)
      }}
      className={cn(
        'selection-row flex cursor-pointer items-start gap-2.5 rounded-[6px] py-1.5 pr-2 pl-2.5 hover:bg-sidebar-row-hover',
        // On touch the row's vertical padding moves INTO the button, so the button's box is the
        // row's full height (47px, ≥ the 44px floor) and the row does not grow around it.
        touch && 'py-0',
        active && 'bg-sidebar-row-selected hover:bg-sidebar-row-selected',
      )}
    >
      <span data-slot="task-row-dot" className={cn('flex h-[19px] w-[12px] shrink-0 items-center justify-center', touch && 'mt-1.5')}>
        <StatusDot tone={lead.tone} shape={lead.shape} pulse={lead.pulse} aria-label={lead.label} title={lead.label} role="img" />
      </span>
      {touch ? (
        // Touch: one button over both lines. Line 2's references are inert spans here, so
        // nothing interactive is nested, and the button's name reads the aggregate too.
        <button
          type="button"
          data-slot="group-tile"
          data-group-id={row.groupId}
          aria-expanded={expanded}
          onClick={() => onToggle(row.groupId)}
          className={cn('flex flex-1 flex-col py-1.5', toggleClass)}
        >
          <span className="flex h-[19px] w-full min-w-0 items-center gap-1.5">{lineOne}</span>
          <span data-slot="group-meta" className={lineTwoClass}>{lineTwo}</span>
        </button>
      ) : (
        /* Pointer: the toggle `<button>` is line 1 only (its accessible name is the title and
           count, and it carries `aria-expanded`); line 2 sits beside it, not inside, because it
           holds reference LINKS and a link inside a button is invalid. A click on line 2 outside
           a link still toggles through the row handler above. */
        <div className="flex min-w-0 flex-1 flex-col">
          <button
            type="button"
            data-slot="group-tile"
            data-group-id={row.groupId}
            aria-expanded={expanded}
            onClick={() => onToggle(row.groupId)}
            className={cn('flex h-[19px] items-center gap-1.5', toggleClass)}
          >
            {lineOne}
          </button>
          <div data-slot="group-meta" className={lineTwoClass}>{lineTwo}</div>
        </div>
      )}
      {/* 36px on a pointer device; on touch the compare link is a 44px target of its own, beside
          (never over) the disclosure, and the slot reserves that room permanently — px, not
          spacing units, so density cannot shrink it. */}
      <span
        data-slot="group-trailing"
        className={cn(
          'flex h-[19px] w-[36px] shrink-0 items-center justify-end gap-0.5 no-hover:h-auto no-hover:w-[60px] no-hover:self-stretch',
          // Level with the title line once the row's padding has moved into the button; on a
          // no-hover device the slot stretches over the full row for the 44px compare target.
          touch && 'mt-1.5 no-hover:mt-0',
        )}
      >
        <Link
          to={scopeTo(scope, `/compare/${row.groupId}`)}
          onClick={onNavigate}
          data-slot="group-compare"
          title="Compare the variants"
          aria-label={`Compare the variants of ${row.title}`}
          className="inline-flex size-[18px] shrink-0 items-center justify-center rounded-sm text-soft-foreground hover:bg-sidebar-row-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-link-foreground no-hover:size-[44px] no-hover:min-h-[44px] no-hover:min-w-[44px]"
        >
          <ScaleIcon className="size-[14px]" aria-hidden="true" />
        </Link>
        {/* Decorative: the button carries `aria-expanded`; a click here is a row click. */}
        <span data-slot="group-disclosure" data-expanded={expanded ? 'true' : 'false'} aria-hidden="true" className="inline-flex size-[14px] shrink-0 items-center justify-center text-soft-foreground">
          <Disclosure className="size-[14px]" />
        </span>
      </span>
    </div>
  )
}

/**
 * Member rows under an open variant tile. The parent surface asks only about the painted first
 * member (the cheaper collapsed path); expanding is what makes the later chips visible, so this
 * is the moment to register their references.
 */
function ExpandedVariantMembers({
  members,
  currentRunId,
  now,
  scope,
  showTokens,
  showCost,
  onTogglePin,
  onArchiveRun,
}: {
  members: RunRecord[]
  currentRunId: string | null
  now: number
  scope: string | null
  showTokens: boolean
  showCost: boolean
  onTogglePin?: (run: RunRecord, pinned: boolean) => void
  onArchiveRun?: (run: RunRecord) => void | Promise<unknown>
}) {
  const shared = sharedReferenceKeys(members, scope ?? undefined)
  // 15.5px in, a 1px guide line, then 6px: with the row's own 10px padding that puts each
  // member's dot directly under the group's title (#617 01a).
  const rows = (
    <div data-slot="variant-list" className="ml-[15.5px] border-l border-border pl-[6px]">
      {members.map((member) => (
        <RunRow
          key={member.id}
          run={member}
          queuePosition={null}
          currentRunId={currentRunId}
          now={now}
          scope={scope}
          variant
          groupReferences={shared}
          showTokens={showTokens}
          showCost={showCost}
          onTogglePin={onTogglePin}
          onArchiveRun={onArchiveRun}
        />
      ))}
    </div>
  )
  if (!scope) return rows
  return (
    <ReferenceStatusProvider
      projectId={scope}
      requests={members.flatMap((member) =>
        taskReferences(member).map((reference) => ({
          projectId: scope,
          kind: reference.kind,
          number: reference.number,
        })),
      )}
    >
      {rows}
    </ReferenceStatusProvider>
  )
}

/**
 * One run — two fixed lines (#617), so every row is the same height whatever its title length
 * or reference count:
 *
 *   [dot slot] [title ........................ diff] [trailing slot]
 *              [state word · references · age      ]
 *
 * The whole row opens `/tasks/:id` — empty space and the status dot included — but a click that
 * lands on any nested anchor or button (a reference, the title's real `<Link>`, the pin) belongs
 * to that control. The title stays a true `<Link>` so keyboards and middle-clicks work. The
 * references and the pin are SIBLINGS of that link, never its children: an anchor inside an
 * anchor is invalid.
 *
 * WIDTH-PRIORITY RULE (#788, option C) — read this before adding anything to this row.
 * The column is 264px by default (`DEFAULT_SIDEBAR_WIDTH`, `lib/sidebar-width.ts`) and the title is
 * the ONLY thing here a person scans for, so:
 *
 *  1. The title is the only element on its line allowed to GROW (`flex-1`) and it has a floor
 *     (`min-w-[7rem]`) that no other element may push it below.
 *  2. Every other element is metadata and must be DROPPABLE beneath that floor. The mechanism is
 *     the `@container/sidebar` the app shell declares: metadata that does not fit a narrow column
 *     is hidden by a container query and comes back when the user drags the column wider. The
 *     meta line itself truncates rather than wrapping — that is what keeps the row two lines.
 *  3. Anything a dropped element was the only carrier of has to survive somewhere reachable —
 *     the diff numbers keep their `title` tooltip, and the full title is the link's `title`.
 *
 * THE TRAILING SLOT (#617) is 16px and ALWAYS reserved. The pin used to appear on hover by
 * taking width from the title, which rewrapped it and made the row jump under the cursor; now
 * the pin and the unread marker share one fixed slot and only swap opacity, so hovering changes
 * no geometry at all. On a device that cannot hover (and on a narrow viewport, where the pin is a
 * 44px target) the slot is 44px wide instead — permanently, so nothing reflows there either.
 */
const ROW_PIN_CLASS =
  'opacity-0 group-hover/task-row:opacity-100 focus-visible:opacity-100' +
  // Keyboard focus anywhere in the row (the title link, a reference) reveals it too; `:focus`
  // alone would keep it up on the current task after a click, whose link stays focused.
  ' group-has-[:focus-visible]/task-row:opacity-100' +
  // A device that CANNOT hover, where none of the above ever fires: always visible, 44px.
  ' no-hover:opacity-100'

/** The archive button's reveal (#780): the pin's, minus the always-visible touch rule — a device
 *  that cannot hover swipes instead and never renders the button. */
const ROW_ARCHIVE_CLASS =
  'opacity-0 group-hover/task-row:opacity-100 focus-visible:opacity-100 group-has-[:focus-visible]/task-row:opacity-100'

/** The unread marker hides wherever the pin shows — the two share the slot. On a no-hover device
 *  (or a narrow viewport) the pin never hides, so the marker steps to the slot's leading edge and
 *  both stay readable. Only applied to a row that HAS a pin; otherwise the marker simply sits there. */
const ROW_UNREAD_WITH_PIN_CLASS =
  'transition-opacity motion-reduce:transition-none' +
  ' group-hover/task-row:opacity-0 group-has-[:focus-visible]/task-row:opacity-0' +
  ' max-md:absolute max-md:top-1/2 max-md:left-0 max-md:-translate-y-1/2 max-md:opacity-100' +
  ' no-hover:absolute no-hover:top-1/2 no-hover:left-0 no-hover:-translate-y-1/2 no-hover:opacity-100'

/** Whether `ref`'s content is wider than its box, kept live by a ResizeObserver (and a re-check
 *  once web fonts land, which change widths without resizing anything). Off when `enabled` is
 *  false; `key` re-checks when the text changes. No ResizeObserver (jsdom): never overflows. */
function useOverflow(ref: React.RefObject<HTMLElement | null>, enabled: boolean, key: string): boolean {
  const [overflows, setOverflows] = React.useState(false)
  React.useLayoutEffect(() => {
    const el = ref.current
    if (!enabled || !el || typeof ResizeObserver === 'undefined') return
    const check = () => setOverflows(el.scrollWidth > el.clientWidth)
    check()
    const observer = new ResizeObserver(check)
    observer.observe(el)
    void document.fonts?.ready.then(check)
    return () => observer.disconnect()
  }, [ref, enabled, key])
  return overflows
}

/** The width `el`'s content needs, however wide its box is. `scrollWidth` floors at `clientWidth`
 *  when the content fits, so a line measured in a wide box would "need" the whole box and drop its
 *  age on the first small shrink; a Range around the contents reports the real extent. jsdom has no
 *  Range rects: fall back to `scrollWidth`. */
function contentWidth(el: HTMLElement): number {
  const range = document.createRange()
  range.selectNodeContents(el)
  const width = range.getBoundingClientRect?.().width
  return width ? Math.ceil(width) : el.scrollWidth
}

/** Whether the meta line should drop its age (#729): true while the line, WITH the age in place,
 *  is wider than its box. Deciding on "does it overflow right now" would flip every frame —
 *  dropping the age removes the overflow, which brings the age back — so the width the line needs
 *  is measured once per content `key`, with the age rendered, and every resize compares the box
 *  to that stored width. A key change (or the web fonts landing) while the age is off puts it back
 *  for one layout pass to re-measure; a layout effect runs before paint, so nothing shows. The
 *  effect depends on `key` and a re-measure tick only — never on the decision itself — so a flip
 *  cannot re-subscribe and re-trigger it. No ResizeObserver (jsdom): never drops. */
function useAgeDropped(ref: React.RefObject<HTMLElement | null>, enabled: boolean, key: string): boolean {
  const [dropped, setDropped] = React.useState(false)
  const [tick, setTick] = React.useState(0)
  const droppedRef = React.useRef(false)
  const fontsHandled = React.useRef(false)
  const needed = React.useRef<{ key: string; width: number } | null>(null)
  const decide = React.useCallback((next: boolean) => {
    droppedRef.current = next
    setDropped(next)
  }, [])
  React.useLayoutEffect(() => {
    const el = ref.current
    if (!enabled || !el || typeof ResizeObserver === 'undefined') {
      needed.current = null
      decide(false)
      return
    }
    let live = true
    const check = () => {
      if (!live) return
      if (needed.current?.key !== key) {
        // Stale or never measured, and the age is off: render it again; `tick` re-runs this effect.
        if (droppedRef.current) {
          decide(false)
          setTick((n) => n + 1)
          return
        }
        needed.current = { key, width: contentWidth(el) }
      }
      decide(needed.current.width > el.clientWidth)
    }
    check()
    const observer = new ResizeObserver(check)
    observer.observe(el)
    // A reference chip can change width with the same identity — its status glyph lands after
    // `useReferenceStatus` hydrates, a conflict turns it semibold — and neither moves the box
    // or the key. Watch every child but the age; a width that differs from the last one seen
    // (seeded when the child is bound) invalidates the stored measurement. The age is never
    // watched, so taking it off cannot re-trigger this.
    const seen = new WeakMap<Element, number>()
    const children = new ResizeObserver((entries) => {
      let changed = false
      for (const entry of entries ?? []) {
        // The border box, the same convention `bind` seeds with.
        const width = entry.borderBoxSize?.[0]?.inlineSize ?? entry.contentRect.width
        const previous = seen.get(entry.target)
        seen.set(entry.target, width)
        if (previous !== undefined && previous !== width) changed = true
      }
      if (!changed || !live) return
      needed.current = null
      check()
    })
    // The age and the separators are ours to toggle; everything else is content. A chip can be
    // REPLACED, not just resized — `ReferenceChip` returns a bare anchor while idle and a hover-card
    // subtree once its status request starts, after this effect ran — so the children are bound
    // again whenever the line's own children change, and a node we have not seen is a change.
    const bound = new Set<Element>()
    const bind = (): boolean => {
      let fresh = false
      for (const child of Array.from(el.children)) {
        const { slot } = (child as HTMLElement).dataset
        if (slot === 'task-row-age' || child.getAttribute('aria-hidden') === 'true') continue
        if (bound.has(child)) continue
        bound.add(child)
        // Seeded now, so the first report is compared against what the measure saw: a status that
        // hydrates between the measure and the observer's first delivery is a change, not a baseline.
        seen.set(child, child.getBoundingClientRect().width)
        children.observe(child)
        fresh = true
      }
      return fresh
    }
    bind()
    const mutations = typeof MutationObserver === 'undefined'
      ? null
      : new MutationObserver(() => {
          if (!bind() || !live) return
          needed.current = null
          check()
        })
    mutations?.observe(el, { childList: true })
    // Web fonts change widths without resizing anything. Once per row, and only if they have not
    // landed: a resolved `ready` would otherwise re-fire on every effect run and re-measure
    // forever. A callback from a torn-down run does nothing (`live`); the current run's takes over.
    if (document.fonts && document.fonts.status !== 'loaded' && !fontsHandled.current) {
      void document.fonts.ready.then(() => {
        fontsHandled.current = true
        if (!live) return
        needed.current = null
        check()
      })
    }
    return () => {
      live = false
      observer.disconnect()
      children.disconnect()
      mutations?.disconnect()
    }
  }, [ref, enabled, key, tick, decide])
  return enabled && dropped
}

/** The meta line's state word (#617): the attention label only for the states the issue lists,
 *  where the dot alone cannot say it — monitoring, the dependency waits (waiting on N workers,
 *  on worker replies, on a parent reply), needs review, needs permission, failed, scheduled,
 *  queued (with its position, `queued #2`) and running. `needs you`, `done` and `cancelled` get
 *  none: the amber, green and grey filled dots already are the whole story. */
function metaStateWord(attention: Attention, queuePosition: number | null, run: RunRecord, now: number): string | undefined {
  const { label } = attention
  if (label === 'queued') return queuePosition !== null ? `queued #${queuePosition}` : label
  if (label === 'needs you' || label === 'done' || label === 'cancelled') return undefined
  // When, not just that (#617 01b): `resumes in 12m` / `resumes 14:05`, else `scheduled`.
  if (label === 'scheduled') return resumeLabel(run.autoResumeAt, now)
  return label
}

function MetaSeparator() {
  return <span aria-hidden="true">{' · '}</span>
}

function RunRow({
  run,
  queuePosition,
  currentRunId,
  now,
  scope,
  variant = false,
  groupReferences,
  showTokens,
  showCost,
  onTogglePin,
  onArchiveRun,
}: {
  run: RunRecord
  queuePosition: number | null
  currentRunId: string | null
  now: number
  /** Explicit `/p/<id>` link scope for a non-active project's row; null = the active scope. */
  scope: string | null
  /** A member row under an expanded group tile: indented, letter-chipped, and labelled with what
   *  actually distinguishes the variants (runner and spend) rather than the shared title. */
  variant?: boolean
  /** A member row's group-wide references: the group row shows them, so the member shows only
   *  references of its own (#617 01a — each variant that opened its own PR shows it). */
  groupReferences?: ReadonlySet<string>
  showTokens: boolean
  showCost: boolean
  onTogglePin?: (run: RunRecord, pinned: boolean) => void
  /** Archive this row (#780). Where references are inert (touch, the mobile shell) the swipe
   *  replaces the button, so it only renders on a device that can hover. A promise that
   *  resolves `false` says the archive failed, and a swiped row snaps back. */
  onArchiveRun?: (run: RunRecord) => void | Promise<unknown>
}) {
  const navigate = useNavigate()
  const onNavigate = useSidebarNavigate()
  // On a device that cannot hover, or in the mobile shell, the references are plain text and the
  // whole row is the tap target (#617 01b); the task header keeps them as 44px links.
  const inertReferences = useRowReferencesInert()
  // Touch and the mobile shell swipe instead (#780 §7): the same rows the button serves elsewhere.
  const swipeable = Boolean(onArchiveRun) && inertReferences && isSweepable(run)
  const swipe = useSwipeToArchive({ id: run.id, enabled: swipeable, onArchive: () => onArchiveRun?.(run) })
  const to = scopeTo(scope, `/tasks/${run.id}`)
  const attention = deriveAttention(run)
  const isActive = run.id === currentRunId
  // The strongest tracker reference the run knows about — the PR once one exists, else the issue
  // it was opened on. It is the reason the title may drop its `NNN: ` prefix (#788, option C):
  // the number is painted once, as a link on the meta line, instead of twice.
  const reference = taskReference(run)
  const references = taskReferences(run, undefined, scope ?? undefined).filter((ref) => !groupReferences?.has(referenceKey(ref)))
  const title = runTitle(run)
  // Only when the two numbers are the same number — see `refPrefixMatches`. A run opened on issue
  // #788 that shipped as PR #790 keeps its prefix, because the reference is not saying it.
  const displayTitle = refPrefixMatches(title, reference?.number) ? splitRefPrefix(title).rest : title
  // Read/unread (#unread-done-items): an unread done item is promoted (bright + semibold) and
  // wears a trailing marker in its OUTCOME colour (#617); a read one stays muted so the history
  // steps back. Both are orthogonal to the leading status dot, which keeps saying done/failed.
  const unread = isUnread(run)
  // A variant row spends its meta line on state and references only — the variants started
  // together, so an age says nothing that tells them apart. A queued row's position rides in
  // its state word instead of an age.
  const age = variant || queuePosition !== null ? '' : shortAge(run.finishedAt ?? run.createdAt, now)
  const stateWord = metaStateWord(attention, queuePosition, run, now)
  // A variant's tokens live on line 2, last, so they are the first thing a narrow column cuts
  // (#617 01a: tokens drop first, then cost; the letter and the runner never drop).
  const tokens = variant && showTokens && (run.inputTokens !== undefined || run.outputTokens !== undefined)
    ? directionalUsageText(run.inputTokens, run.outputTokens)
    : ''
  const cost = variant && showCost ? formatCost(run.costUsd) : ''
  // Width priority on a member row (#617 01a): tokens drop first, then cost. The two sit on
  // different lines, so truncation alone cannot order them; measure line 1 instead, and while
  // it overflows (the cost is being cut) take the tokens off line 2.
  const titleRef = React.useRef<HTMLSpanElement | null>(null)
  const lineOneOverflows = useOverflow(titleRef, variant, `${run.runner}|${cost}`)

  // Width priority on the meta line, every row (#729): the age is the least important item and
  // goes first, whole and with its separator, before anything is ellipsized. The hand-off glyph
  // never goes: it leads the line, and the line truncates at its end.
  const metaRef = React.useRef<HTMLDivElement | null>(null)
  const ageDropped = useAgeDropped(metaRef, Boolean(age), `${age}|${stateWord ?? ''}|${references.map((ref) => `${ref.kind}-${ref.number}-${ref.url}`).join(',')}|${run.notify ? 1 : 0}`)

  const meta: React.ReactNode[] = []
  if (stateWord) meta.push(<span key="state" data-slot="task-row-state">{stateWord}</span>)
  for (const ref of references) {
    meta.push(
      <TaskReferenceChip
        key={`${ref.kind}-${ref.number}-${ref.url}`}
        run={run}
        reference={ref}
        plain
        inert={inertReferences}
      />,
    )
  }
  if (age && !ageDropped) meta.push(<span key="age" data-slot="task-row-age" className="tabular-nums">{age}</span>)
  if (tokens && !lineOneOverflows) meta.push(<span key="tokens" data-slot="task-row-tokens" className="tabular-nums">{tokens}</span>)
  // A needs-you variant says no state word — its amber dot and the Needs you group say it —
  // unless its line 2 would otherwise be empty; the row keeps its two lines either way.
  if (variant && !meta.length && attention.label === 'needs you') {
    meta.push(<span key="state" data-slot="task-row-state">{attention.label}</span>)
  }

  const rowElement = (
    <div
      data-slot="task-row"
      data-run-id={run.id}
      // The row's highlight is a wrapper concern (the dot and the references sit outside the
      // Link), so the active state has to be readable here rather than only from the Link's
      // `aria-current`.
      data-active={isActive ? 'true' : undefined}
      onClick={(event) => {
        // The reference-status card is a Radix portal on document.body. React still bubbles
        // that click through this row; ignore targets that are not DOM descendants.
        if (!event.currentTarget.contains(event.target as Node)) return
        if ((event.target as Element).closest('a, button, input')) return
        navigate(to)
        onNavigate?.()
      }}
      {...(swipeable ? swipe.bind : {})}
      style={swipe.offset ? { transform: `translateX(${swipe.offset}px)` } : undefined}
      className={cn(
        'selection-row group/task-row flex cursor-pointer items-start gap-2.5 rounded-[6px] py-1.5 pr-2 pl-2.5 hover:bg-sidebar-row-hover',
        // No native text selection mid-swipe (a mouse in the narrow shell would select instead).
        swipeable && 'select-none',
        // The finger moves the row 1:1; only the snap back or out animates, and only for users who
        // have not asked for reduced motion (then it is an instant snap).
        swipeable && swipe.phase !== 'dragging' && 'motion-safe:transition-transform motion-safe:duration-200 motion-safe:ease-out',
        // Neutral, not teal (#617): the selected fill is a surface step, and it holds under the
        // pointer so hovering the open task does not make it look unselected.
        isActive && 'bg-sidebar-row-selected hover:bg-sidebar-row-selected',
        // A member row's indent is its list's (`variant-list`: 15.5px, the guide line, 6px), so
        // the row itself keeps the ordinary padding and its dot lands under the group title.
      )}
    >
      {/* Line boxes and slots are fixed px, not spacing units: `ultra` density shrinks
          `--spacing`, which would clip the 16px meta line and squeeze the 12px robot.
          The dot slot: 12px wide so the 12px robot fits, 19px tall so a 7px dot and the robot
          both centre on the title line and every title starts at the same x. Not a control — a
          click on it is a row click. */}
      <span data-slot="task-row-dot" className="flex h-[19px] w-[12px] shrink-0 items-center justify-center">
        <StatusDot tone={attention.tone} shape={attention.shape} pulse={attention.pulse} aria-label={attention.label} title={attention.label} role="img" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col">
        <Link
          to={to}
          onClick={onNavigate}
          // `title` carries the FULL stored title — including a `NNN: ` prefix the reference let
          // the visible text drop — so hover always gives back everything the column could not show.
          title={title}
          aria-current={isActive ? 'page' : undefined}
          // A mouse drag on a swipeable row is the swipe, not a native link drag.
          draggable={swipeable ? false : undefined}
          className="flex h-[19px] min-w-0 items-center gap-2 rounded-[2px] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-link-foreground"
        >
          {variant ? (
            // The variant's name in the compare view and the thread header, so the sidebar says
            // it too — neutral, not teal (#617 01a); one step up on the selected fill.
            <span
              data-slot="task-row-variant-letter"
              className={cn(
                'inline-flex size-[16px] shrink-0 items-center justify-center rounded-full bg-muted font-mono text-[10.5px] font-semibold text-muted-foreground',
                isActive && 'bg-sidebar text-foreground',
              )}
            >
              {run.variant ?? '?'}
            </span>
          ) : null}
          <span
            ref={variant ? titleRef : undefined}
            data-slot="task-row-title"
            className={cn(
              // `min-w-[7rem]`: the floor of the width-priority rule above. The title never gives
              // way past ~17 characters; the diff pair drops instead.
              'min-w-[7rem] flex-1 truncate text-[13px] leading-[1.45] font-medium text-muted-foreground',
              // A member row's line 1 is `runner · $cost` as INLINE text: a flex row would drop the
              // separator's leading space ("claude· $0.40"), and inline text ellipsizes from the
              // end, so the cost gives way before the runner does.
              variant && 'min-w-0',
              unread && 'font-semibold text-foreground',
              // A read finished row keeps the muted base colour — the history stays stepped back.
              isActive && 'text-foreground',
            )}
          >
            {variant ? (
              <>
                {run.runner ?? 'claude'}
                {cost ? <>{' · '}<span data-slot="variant-cost">{cost}</span></> : null}
              </>
            ) : displayTitle}
          </span>
          {/* The diff numbers, once a turn has produced any (R2 #389). Nothing before that — a
              sidebar row has no column to hold an em dash open for.

              Droppable metadata, per the width-priority rule: `+59514 −12160` is ~82px, which the
              default 264px column cannot spend and still name the task, and its exact numbers stay
              in the `title` tooltip and in the Tasks table's ± column either way.

              23rem is not the width at which the pair merely *fits* — it is the width at which it
              fits AND the name keeps the length it has in the default column. It was derived when
              that default was 232px (#788) and has not been re-derived for 264px. */}
          {run.diffStat ? (
            <DiffStatLabel
              stat={run.diffStat}
              className="hidden shrink-0 text-[12px] @min-[23rem]/sidebar:inline"
            />
          ) : null}
        </Link>
        {/* The meta line: one line, truncated, never wrapped. References are plain muted links
            here (#617) — no chip border, no teal — but keep their status panel and their name. */}
        <div
          ref={metaRef}
          data-slot="task-row-meta"
          className={cn(
            'h-[16px] min-w-0 truncate text-[11.5px] leading-[1.4] font-normal text-soft-foreground',
            // On the selected fill `--soft-foreground` is 4.45:1 (dark) / 4.25:1 (light), under
            // the 4.5:1 an 11.5px line needs; it steps up one ink, as the title steps to
            // `--foreground`.
            isActive && 'text-muted-foreground',
          )}
        >
          {/* Handed off to the task webhook (#729): first on the line, in the line's own colour
              (`currentColor`: `--soft-foreground`, one step up when selected) — a fact, not a
              status, so no tone. NOT part of `meta`: it must not count as content for the
              needs-you fallback above, and it takes no separator. */}
          {run.notify === true ? (
            // A wrapper, not the bare svg: an HTML `title` is the tooltip, where an svg needs a
            // `<title>` child that would leak into the line's text.
            <span
              data-slot="task-row-notify"
              role="img"
              aria-label="Notifying the task webhook"
              title="Notifying the task webhook"
              className="mr-[4px] inline-block shrink-0 align-[-1px]"
            >
              <SendIcon aria-hidden="true" className="size-[10px]" />
            </span>
          ) : null}
          {meta.length ? meta.flatMap((part, index) => (index ? [<MetaSeparator key={`sep-${index}`} />, part] : [part])) : run.notify === true ? null : ' '}
        </div>
      </div>
      {run.delegation?.role === 'worker' ? <span className="sr-only">Worker · {attention.label}</span> : null}
      {/* The trailing slot — reserved on every row, whether or not anything is in it (#617). */}
      <span
        data-slot="task-row-trailing"
        className="relative flex h-[19px] w-[16px] shrink-0 items-center justify-center max-md:h-auto max-md:w-11 max-md:self-stretch no-hover:h-auto no-hover:w-11 no-hover:self-stretch"
      >
        {unread ? (
          <StatusDot
            tone={unreadMarkerTone(run)}
            role="img"
            aria-label="unread"
            title="Unread — not opened since it finished"
            data-slot="unread-marker"
            className={onTogglePin ? ROW_UNREAD_WITH_PIN_CLASS : undefined}
          />
        ) : null}
        {/* The pin (#935), a SIBLING of the Link: a button inside an anchor is invalid, and this
            one has its own target. Centred over the slot rather than sized by it, so its 20px
            target never widens the slot; where it is a 44px target the slot is 44px wide and
            stretches to the row's height, so the target stays inside its own row. */}
        {onTogglePin ? (
          <PinToggle
            pinned={Boolean(run.pinned)}
            onToggle={(pinned) => onTogglePin(run, pinned)}
            className={cn('absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2', ROW_PIN_CLASS)}
          />
        ) : null}
        {/* The archive button (#780): line 2 of the same 16px column, under the pin. 20px target
            hung from the slot's line-1 bottom edge, so it never overlaps the pin's own, and the
            glyph is nudged up to sit on line 2's centre. Absolute, so the slot, the title and the
            row height are the same at rest and under the pointer. */}
        {onArchiveRun && !inertReferences && isSweepable(run) ? (
          <button
            type="button"
            data-action="archive-run"
            aria-label={`Archive ${title}`}
            title="Archive task"
            onClick={(event) => {
              event.stopPropagation()
              onArchiveRun(run)
            }}
            className={cn(
              'absolute top-[19.5px] left-1/2 inline-flex size-5 -translate-x-1/2 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none motion-reduce:transition-none',
              ROW_ARCHIVE_CLASS,
            )}
          >
            <ArchiveIcon className="size-[12px] -translate-y-[2.5px]" aria-hidden="true" />
          </button>
        ) : null}
      </span>
    </div>
  )

  // A pointer that can hover gets the row button and no wrapper. Where references are inert the
  // wrapper is ALWAYS there, swipeable or not: a row that starts swiping (its run just finished)
  // must keep its element tree, or React remounts it and the focused link goes with it.
  if (!inertReferences) return rowElement
  return (
    <div
      ref={swipe.surfaceRef}
      data-slot="task-row-swipe"
      data-swipe={swipeable ? 'on' : undefined}
      // `pan-y pinch-zoom`: the browser keeps vertical scrolling and pinch zoom; the gesture only
      // ever reads horizontal moves.
      className={cn('relative rounded-[6px]', swipeable && 'touch-pan-y touch-pinch-zoom overflow-hidden')}
    >
      {/* Tapping the parked action leaves the row parked until the list drops it. */}
      {swipe.offset < 0 ? <SwipeArchiveAction width={-swipe.offset} past={swipe.past} title={title} onArchive={() => void onArchiveRun?.(run)} /> : null}
      {rowElement}
    </div>
  )
}

/**
 * What a swipe uncovers behind a finished row (#780 §7): an 88px `Archive` action while short,
 * the whole uncovered width in `--info` with `Release to archive` once past the commit point.
 * Hidden from assistive tech: the row stays ONE link, and the thread's own Archive is the path
 * that does not need a gesture.
 */
function SwipeArchiveAction({ width, past, title, onArchive }: { width: number; past: boolean; title: string; onArchive: () => void }) {
  return (
    <div
      data-slot="task-row-swipe-action"
      data-past={past ? 'true' : undefined}
      aria-hidden="true"
      style={{ width }}
      className={cn(
        'absolute inset-y-0 right-0 flex items-stretch justify-end overflow-hidden rounded-[6px]',
        // Ink on --info is the violet pill's pair (`--signal-ink`): #121722 dark, #FFFFFF light.
        past ? 'bg-info text-signal-ink' : 'bg-muted text-foreground',
      )}
    >
      {past ? (
        <span className="flex w-full items-center justify-center gap-2 text-[12px] font-semibold whitespace-nowrap">
          <ArchiveIcon className="size-[16px] shrink-0" aria-hidden="true" />
          Release to archive
        </span>
      ) : (
        <button
          type="button"
          tabIndex={-1}
          aria-label={`Archive ${title}`}
          onClick={(event) => {
            event.stopPropagation()
            onArchive()
          }}
          className="flex w-[88px] shrink-0 flex-col items-center justify-center gap-1 text-[12px] font-semibold"
        >
          <ArchiveIcon className="size-[16px]" aria-hidden="true" />
          Archive
        </button>
      )}
    </div>
  )
}

/** The section sweep: Finished only, always protecting pins (#811). */
function GroupSweepButton({
  label,
  headingId,
  projectName,
  counts,
  onSweep,
  sweeping,
}: {
  label: QuickListBucket['label']
  headingId: string
  projectName?: string
  counts: { unpinned: number; pinned: number }
  onSweep: (scope: ArchiveFinishedScope) => void
  sweeping: ArchiveFinishedScope | null
}) {
  const scope = label === 'Finished' ? 'unpinned' : null
  if (!scope || counts[scope] === 0) return null
  const busy = sweeping === scope
  const text = 'Archive all'
  return (
    <button
      type="button"
      data-action="archive-group"
      data-scope={scope}
      disabled={busy}
      aria-busy={busy ? 'true' : undefined}
      // The name starts with the visible words; the project (or, failing that, the group's
      // heading) says WHICH list, since a sidebar can show several of these buttons at once.
      aria-label={projectName ? `${text}, ${projectName}` : undefined}
      aria-describedby={headingId}
      onClick={() => onSweep(scope)}
      className="relative inline-flex shrink-0 items-center gap-1 rounded-[4px] px-1.5 py-0.5 font-sans text-[11px] leading-[1.4] text-muted-foreground hover:bg-sidebar-row-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-link-foreground disabled:opacity-60 max-md:before:absolute max-md:before:top-1/2 max-md:before:left-0 max-md:before:h-11 max-md:before:w-full max-md:before:-translate-y-1/2 max-md:before:content-[''] no-hover:before:absolute no-hover:before:top-1/2 no-hover:before:left-0 no-hover:before:h-11 no-hover:before:w-full no-hover:before:-translate-y-1/2 no-hover:before:content-['']"
    >
      <ArchiveIcon className="size-[11px]" aria-hidden="true" />
      {text}
    </button>
  )
}

/**
 * The quick-list wired to live data: `useRuns()` for the list (kept fresh by the global SSE
 * stream, Step 3.2), the router for which row is open, and the sidebar Active/Archived context —
 * independent of the Tasks table's own tabs.
 */
export function TaskQuickListContainer({ showViewControls = true, projectId: explicitProjectId, boot = false }: { showViewControls?: boolean; projectId?: string; boot?: boolean }) {
  const onNavigate = useSidebarNavigate()
  const scope = explicitProjectId ?? queryScope()
  const runs = useProjectRuns(scope, true, boot)
  const uiState = useProjectUiState(scope, true, boot)
  const sidebarLimits = uiState.data?.sidebarLimits ?? {}
  const pin = usePinRun(scope, boot ? 'default' : scope)
  const archive = useSidebarArchive(scope, boot ? 'default' : scope, onNavigate)
  const health = useHealth()
  const visibility = usageMetricVisibility(health.data)
  const [view, setView] = useListView()
  // Project-prefix-agnostic matches (step 3.2): `/p/<id>/tasks/:id` must light its row too.
  const match = useProjectMatch('/tasks/:id/*')
  const exact = useProjectMatch('/tasks/:id')
  // The open compare page lights its group row (#617 01a).
  const compare = useProjectMatch('/compare/:groupId')
  const now = useNow(30_000)
  // The sidebar's chips are the same chips as the tables', so they get their status the same way:
  // one batched request for the whole list, mounted here where the list is.
  const referenceProjectId = useReferenceProjectId()
  const projectId = explicitProjectId ?? referenceProjectId
  const repoBase = useProjectRepoBase(projectId)
  const buckets = capBuckets(groupRuns(runs.data ?? [], view), sidebarLimits)
  const referenceRequests = projectId === undefined ? [] : buckets.flatMap(bucket =>
    bucket.rows.flatMap(row => taskReferences(row.kind === 'run' ? row.run : row.members[0]!).map(
      reference => ({ projectId, kind: reference.kind, number: reference.number }),
    )),
  )

  // Nothing at all until the list has answered: a skeleton here would be inventing rows, and an
  // empty state would claim "No tasks yet" before we know whether there are any.
  if (!runs.data) return null

  return (
    <ReferenceStatusProvider projectId={projectId} repoBase={repoBase} requests={referenceRequests}>
      <TaskQuickList
        showViewControls={showViewControls}
        sidebarLimits={sidebarLimits}
        projectId={projectId === 'default' ? health.data?.bootProject ?? null : projectId ?? null}
        runs={runs.data}
        view={view}
        onViewChange={setView}
        // Both matches: `/tasks/:id` and its `/changes` and `/files` children all keep the row lit.
        currentRunId={match?.params.id ?? exact?.params.id ?? null}
        currentGroupId={compare?.params.groupId ?? null}
        now={now}
        showTokens={visibility.tokens}
        showCost={visibility.cost}
        // Bind the mutation to the same explicit project and cache as this list.
        onTogglePin={(run, pinned) =>
          pin.mutate({ id: run.id, pinned })
        }
        onArchiveRun={archive.archiveOne}
        onSweep={archive.sweep}
        sweeping={archive.sweeping}
      />
    </ReferenceStatusProvider>
  )
}

/** One scope switcher above the project tree, shared by every sidebar run list. */
export function SidebarSessionScope() {
  const [view, setView] = useListView()
  const runs = useRuns()
  const registry = useProjects().data
  const runsProjectId = queryScope()
  const otherProjects = (registry?.projects ?? []).filter((project) => project.id !== registry?.bootProject)
  const otherLists = useQueries({
    queries: otherProjects.map((project) => ({
      queryKey: [project.id, 'runs', 'list'] as const,
      queryFn: async () => [] as RunRecord[],
      enabled: false,
    })),
  })
  const seen = new Set<string>()
  const combined: RunRecord[] = []
  const add = (projectId: string, run: RunRecord) => {
    const key = `${projectId}:${run.id}`
    if (seen.has(key)) return
    seen.add(key)
    combined.push(run)
  }
  for (const run of runs.data ?? []) add(runsProjectId, run)
  otherProjects.forEach((project, index) => {
    for (const run of otherLists[index]?.data ?? []) add(project.id, run)
  })
  const counts = listCounts(combined)
  return (
    <div data-slot="sidebar-session-scope" role="group" aria-label="Session scope" className="flex w-full gap-1 rounded-lg bg-muted p-[3px]">
      <ViewTab view="active" current={view} onSelect={setView} count={counts.active}>
        Active
        {counts.waiting > 0 && view !== 'active' ? <StatusDot tone="pending" pulse data-slot="waiting-dot" aria-label="needs you" /> : null}
      </ViewTab>
      <ViewTab view="archived" current={view} onSelect={setView} count={counts.archived}>Archived</ViewTab>
    </div>
  )
}
