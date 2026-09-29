import { ChevronDownIcon, ChevronRightIcon } from '@/components/design-icons'
import { ScaleIcon } from 'lucide-react'
import { useQueries } from '@tanstack/react-query'
import * as React from 'react'
import { queryScope } from '@open-mercato/cezar-api-client'
import { useHealth, usePinRun, useProjects, useReferenceProjectId, useRuns } from '@/api/queries'
import { Link, scopeTo, useNavigate, useProjectMatch } from '@/lib/project-router'
import type { RunRecord } from '@open-mercato/cezar-api-client'
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
  groupRuns,
  listCounts,
  refPrefixMatches,
  runTitle,
  sidebarActiveRunId,
  splitRefPrefix,
  type ListView,
  type QuickListBucket,
  type QuickListRow,
} from '@/lib/task-groups'
import { formatCost, taskReference, taskReferences } from '@/lib/tasks-table'
import { usageMetricVisibility } from '@/lib/token-metrics'
import { useNow } from '@/lib/use-now'
import { cn } from '@/lib/utils'

/**
 * The sidebar's task quick-list (spec, "App shell & navigation"): Active/Archived tabs, then the
 * runs grouped Needs you / Working / Recent, with variant groups collapsed into one tile.
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
  showViewControls = true,
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
  showViewControls?: boolean
}) {
  const counts = listCounts(runs)
  const buckets = groupRuns(runs, view)
  // Withheld in the archived view, where `groupRuns` answers one `Archived` bucket and never
  // reads `run.pinned` — the same call the thread header makes on an archived run.
  const pinToggle = view === 'archived' ? undefined : onTogglePin

  return (
    <div data-slot="quick-list">
      <div data-slot="quick-list-header" className="flex min-h-11 items-center gap-1.5 pr-[6px] pl-[10px] md:min-h-[26px]">
        <h2 className="text-[13px] font-semibold text-foreground">Tasks</h2>
        <span className="text-[11.5px] text-soft-foreground">{counts[view]}</span>
        <Link to="/" className="ml-auto flex min-h-11 items-center gap-0.5 text-[12px] text-soft-foreground hover:text-foreground md:min-h-[26px]">
          All<ChevronRightIcon className="size-[13px]" aria-hidden="true" />
        </Link>
      </div>
      {/* Sticky, not scrolled away: the tabs say what you are looking at, and a long Recent list
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

      {buckets.length === 0 ? (
        <p className="px-3 py-3.5 text-xs text-soft-foreground">
          {view === 'archived' ? 'Nothing archived yet.' : 'No tasks yet — describe one.'}
        </p>
      ) : (
        <QuickListBuckets
          buckets={buckets}
          currentRunId={sidebarActiveRunId(currentRunId, runs)}
          currentGroupId={currentGroupId}
          now={now}
          showTokens={showTokens}
          showCost={showCost}
          onTogglePin={pinToggle}
        />
      )}
    </div>
  )
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
}: {
  buckets: QuickListBucket[]
  currentRunId?: string | null
  currentGroupId?: string | null
  now?: number
  scope?: string | null
  showTokens?: boolean
  showCost?: boolean
  onTogglePin?: (run: RunRecord, pinned: boolean) => void
}) {
  // Which variant groups are open. Local: it is view state about this list, nothing else reads it.
  const [expanded, setExpanded] = React.useState<ReadonlySet<string>>(() => new Set())
  const toggleGroup = (groupId: string) =>
    setExpanded((current) => {
      const next = new Set(current)
      if (!next.delete(groupId)) next.add(groupId)
      return next
    })

  const renderRow = (row: QuickListRow) => <Row row={row} currentRunId={currentRunId} currentGroupId={currentGroupId} now={now} scope={scope} showTokens={showTokens} showCost={showCost} expanded={row.kind === 'group' && expanded.has(row.groupId)} onToggle={toggleGroup} onTogglePin={onTogglePin} />

  return (
    <div className="flex flex-col gap-3">
      {buckets.map((bucket) => (
        <div key={bucket.label} data-slot="quick-list-bucket" data-bucket={bucket.label}>
          <h2 className="px-[10px] pt-[2px] pb-[4px] text-[11px] font-medium text-soft-foreground">
            {bucket.label}{' '}<span className="text-[11px] font-normal tabular-nums">{bucket.rows.length}</span>
          </h2>
          {bucket.rows.map((row) => (
            <div key={row.kind === 'group' ? row.groupId : row.run.id}>
              {renderRow(row)}
            </div>
          ))}
        </div>
      ))}
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
          three of them. Expanding it pins the variant you mean, and the group rises to `Pinned`
          with it — the same best-ranked-member rule that already moves it between buckets. */}
      {expanded ? (
        <ExpandedVariantMembers
          members={row.members}
          currentRunId={currentRunId}
          now={now}
          scope={scope}
          showTokens={showTokens}
          showCost={showCost}
          onTogglePin={onTogglePin}
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
}: {
  members: RunRecord[]
  currentRunId: string | null
  now: number
  scope: string | null
  showTokens: boolean
  showCost: boolean
  onTogglePin?: (run: RunRecord, pinned: boolean) => void
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
}) {
  const navigate = useNavigate()
  // On a device that cannot hover, or in the mobile shell, the references are plain text and the
  // whole row is the tap target (#617 01b); the task header keeps them as 44px links.
  const inertReferences = useRowReferencesInert()
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
  if (age) meta.push(<span key="age" data-slot="task-row-age" className="tabular-nums">{age}</span>)
  if (tokens && !lineOneOverflows) meta.push(<span key="tokens" data-slot="task-row-tokens" className="tabular-nums">{tokens}</span>)
  // A needs-you variant says no state word — its amber dot and the Needs you group say it —
  // unless its line 2 would otherwise be empty; the row keeps its two lines either way.
  if (variant && !meta.length && attention.label === 'needs you') {
    meta.push(<span key="state" data-slot="task-row-state">{attention.label}</span>)
  }

  return (
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
      }}
      className={cn(
        'selection-row group/task-row flex cursor-pointer items-start gap-2.5 rounded-[6px] py-1.5 pr-2 pl-2.5 hover:bg-sidebar-row-hover',
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
          // `title` carries the FULL stored title — including a `NNN: ` prefix the reference let
          // the visible text drop — so hover always gives back everything the column could not show.
          title={title}
          aria-current={isActive ? 'page' : undefined}
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
          data-slot="task-row-meta"
          className={cn(
            'h-[16px] min-w-0 truncate text-[11.5px] leading-[1.4] font-normal text-soft-foreground',
            // On the selected fill `--soft-foreground` is 4.45:1 (dark) / 4.25:1 (light), under
            // the 4.5:1 an 11.5px line needs; it steps up one ink, as the title steps to
            // `--foreground`.
            isActive && 'text-muted-foreground',
          )}
        >
          {meta.length ? meta.flatMap((part, index) => (index ? [<MetaSeparator key={`sep-${index}`} />, part] : [part])) : ' '}
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
      </span>
    </div>
  )
}

/**
 * The quick-list wired to live data: `useRuns()` for the list (kept fresh by the global SSE
 * stream, Step 3.2), the router for which row is open, and the sidebar Active/Archived context —
 * independent of the Tasks table's own tabs.
 */
export function TaskQuickListContainer({ showViewControls = true }: { showViewControls?: boolean }) {
  const runs = useRuns()
  const pin = usePinRun()
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
  const projectId = useReferenceProjectId()
  const referenceRequests = React.useMemo(
    () =>
      projectId === undefined
        ? []
        : (runs.data ?? []).flatMap((run) => {
            return taskReferences(run).map(reference => ({ projectId, kind: reference.kind, number: reference.number }))
          }),
    [runs.data, projectId],
  )

  // Nothing at all until the list has answered: a skeleton here would be inventing rows, and an
  // empty state would claim "No tasks yet" before we know whether there are any.
  if (!runs.data) return null

  return (
    <ReferenceStatusProvider projectId={projectId} requests={referenceRequests}>
      <TaskQuickList
        showViewControls={showViewControls}
        runs={runs.data}
        view={view}
        onViewChange={setView}
        // Both matches: `/tasks/:id` and its `/changes` and `/files` children all keep the row lit.
        currentRunId={match?.params.id ?? exact?.params.id ?? null}
        currentGroupId={compare?.params.groupId ?? null}
        now={now}
        showTokens={visibility.tokens}
        showCost={visibility.cost}
        // This list is the ACTIVE project's, so the mutation needs no explicit project: the
        // scoped client already addresses the one the URL names.
        onTogglePin={(run, pinned) =>
          pin.mutate({ id: run.id, pinned })
        }
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
