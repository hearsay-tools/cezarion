import { ChevronDownIcon } from '@/components/design-icons'
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
import { deriveAttention } from '@/lib/attention'
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
      {/* Sticky, not scrolled away: the tabs say what you are looking at, and a long Recent list
          must not be able to hide that the view is filtered. */}
      {showViewControls ? <div className="sticky top-0 z-10 bg-sidebar pt-2 pb-1">
        <div className="inline-flex w-full gap-0.5 rounded-md bg-muted p-[3px]">
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
  now = Date.now(),
  scope = null,
  showTokens = true,
  showCost = true,
  onTogglePin,
}: {
  buckets: QuickListBucket[]
  currentRunId?: string | null
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

  // Sidebar organization is pin-based; the state remains on each row's independent dot.
  const sidebarBuckets: QuickListBucket[] = []
  for (const label of ['Pinned', 'Recent', 'Archived'] as const) {
    const rows = buckets.filter(bucket => label === 'Recent' ? bucket.label !== 'Pinned' && bucket.label !== 'Archived' : bucket.label === label).flatMap(bucket => bucket.rows)
    if (rows.length) sidebarBuckets.push({ label, rows })
  }
  const renderRow = (row: QuickListRow) => <Row row={row} currentRunId={currentRunId} now={now} scope={scope} showTokens={showTokens} showCost={showCost} expanded={row.kind === 'group' && expanded.has(row.groupId)} onToggle={toggleGroup} onTogglePin={onTogglePin} />

  return (
    <>
      {sidebarBuckets.map((bucket) => (
        <div key={bucket.label} data-slot="quick-list-bucket" data-bucket={bucket.label}>
          <h2 className="pl-9 pt-3 pb-2 text-[11px] font-medium tracking-[0.14em] text-soft-foreground uppercase">
            {bucket.label}
          </h2>
          {bucket.rows.map((row) => (
            <div key={row.kind === 'group' ? row.groupId : row.run.id}>
              {renderRow(row)}
            </div>
          ))}
        </div>
      ))}
    </>
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
        'flex min-h-11 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-[7px] text-[11px] font-medium text-muted-foreground md:min-h-[30px]',
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
      {/* Like RunRow: the compare link is the toggle button's flex SIBLING, not its child —
          a link inside a button is invalid, and both targets are real. */}
      <div className="flex items-center rounded-[6px] hover:bg-sidebar-row-hover">
        <button
          type="button"
          data-slot="group-tile"
          data-group-id={row.groupId}
          aria-expanded={expanded}
          onClick={() => onToggle(row.groupId)}
          className="flex min-w-0 flex-1 items-center gap-2 px-2.5 py-[7px] text-left"
        >
          <ChevronDownIcon
            className={cn('size-3 shrink-0 text-soft-foreground transition-transform', !expanded && '-rotate-90')}
            aria-hidden="true"
          />
          {/* Same width-priority rule as `RunRow`: the shared title has a floor, and the `×N`
              badge and the compare link give way before it does. */}
          <span className="min-w-[7rem] flex-1 truncate text-[13px] font-medium">{row.title}</span>
          <span className="shrink-0 rounded-full bg-muted px-1.5 py-px font-mono text-[11px] font-semibold tabular-nums text-muted-foreground">
            ×{row.members.length}
          </span>
        </button>
        <Link
          to={scopeTo(scope, `/compare/${row.groupId}`)}
          data-slot="group-compare"
          title="Compare the variants"
          aria-label={`Compare the variants of ${row.title}`}
          className="mr-1.5 inline-flex size-6 shrink-0 items-center justify-center rounded-sm text-soft-foreground hover:bg-accent-strong/10 hover:text-accent-icon"
        >
          <ScaleIcon className="size-3.5" aria-hidden="true" />
        </Link>
      </div>
      {/* No pin on the TILE (#935): a pin is per task, and the tile is a stand-in for two or
          three of them. Expanding it pins the variant you mean, and the tile rises to `Pinned`
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
  const rows = members.map((member) => (
    <RunRow
      key={member.id}
      run={member}
      queuePosition={null}
      currentRunId={currentRunId}
      now={now}
      scope={scope}
      variant
      showTokens={showTokens}
      showCost={showCost}
      onTogglePin={onTogglePin}
    />
  ))
  if (!scope) return <>{rows}</>
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
 * The column is 232px by default and the title is the ONLY thing here a person scans for, so:
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

/** The meta line's state word: the attention label wherever the dot alone cannot say it — which
 *  is every state but `done`, whose green dot already is the whole story. A queued row folds its
 *  position in (`queued #2`), because the position is the one thing a queued row is scanned for. */
function metaStateWord(label: string, queuePosition: number | null): string | undefined {
  if (label === 'done') return undefined
  if (label === 'queued' && queuePosition !== null) return `queued #${queuePosition}`
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
  showTokens: boolean
  showCost: boolean
  onTogglePin?: (run: RunRecord, pinned: boolean) => void
}) {
  const navigate = useNavigate()
  const to = scopeTo(scope, `/tasks/${run.id}`)
  const attention = deriveAttention(run)
  const isActive = run.id === currentRunId
  // The strongest tracker reference the run knows about — the PR once one exists, else the issue
  // it was opened on. It is the reason the title may drop its `NNN: ` prefix (#788, option C):
  // the number is painted once, as a link on the meta line, instead of twice.
  const reference = taskReference(run)
  const references = taskReferences(run)
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
  const stateWord = metaStateWord(attention.label, queuePosition)

  const meta: React.ReactNode[] = []
  if (stateWord) meta.push(<span key="state" data-slot="task-row-state">{stateWord}</span>)
  for (const ref of references) {
    meta.push(
      <TaskReferenceChip
        key={`${ref.kind}-${ref.number}-${ref.url}`}
        run={run}
        reference={ref}
        plain
      />,
    )
  }
  if (age) meta.push(<span key="age" data-slot="task-row-age" className="tabular-nums">{age}</span>)

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
        // The indent a member row wears under an expanded group tile. One padding declaration,
        // not two: `cn` is tailwind-merge, so this REPLACES the `pl-2.5` above rather than losing
        // to it — 26px = the row's own 10px plus the 16px indent.
        variant && 'pl-[26px]'
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
            <span className="inline-flex size-[15px] shrink-0 items-center justify-center rounded-full bg-accent-strong/15 font-mono text-[11px] font-semibold text-accent-text">
              {run.variant ?? '?'}
            </span>
          ) : null}
          <span
            data-slot="task-row-title"
            className={cn(
              // `min-w-[7rem]`: the floor of the width-priority rule above. The title never gives
              // way past ~17 characters; the diff pair drops instead.
              'min-w-[7rem] flex-1 truncate text-[13px] leading-[1.45] font-medium text-muted-foreground',
              unread && 'font-semibold text-foreground',
              // A read finished row keeps the muted base colour — the history stays stepped back.
              isActive && 'text-foreground',
            )}
          >
            {variant ? variantLabel(run, showTokens, showCost) : displayTitle}
          </span>
          {/* The diff numbers, once a turn has produced any (R2 #389). Nothing before that — a
              sidebar row has no column to hold an em dash open for.

              Droppable metadata, per the width-priority rule: `+59514 −12160` is ~82px, which a
              232px column cannot spend and still name the task, and its exact numbers stay in the
              `title` tooltip and in the Tasks table's ± column either way.

              23rem is not the width at which the pair merely *fits* — it is the width at which it
              fits AND the name is still at least as long as it was in the default 232px column. */}
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

/** A variant row's subtitle: what differs between A and B — the backend and what it has spent.
 *  `runner` is absent on records predating the choice; those are Claude by definition. */
function variantLabel(run: RunRecord, showTokens: boolean, showCost: boolean): string {
  const parts: string[] = [run.runner ?? 'claude']
  if (showTokens && (run.inputTokens !== undefined || run.outputTokens !== undefined)) {
    parts.push(directionalUsageText(run.inputTokens, run.outputTokens))
  }
  const cost = formatCost(run.costUsd)
  if (showCost && cost) parts.push(cost)
  return parts.join(' · ')
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
