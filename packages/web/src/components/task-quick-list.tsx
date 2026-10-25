import { ArchiveIcon, ChevronDownIcon, ChevronRightIcon } from '@/components/design-icons'
import { SendIcon } from 'lucide-react'
import { useQueries } from '@tanstack/react-query'
import * as React from 'react'
import { queryScope } from '@open-mercato/cezar-api-client/utils/project-scope'
import { useSidebarArchive } from '@/components/sidebar-archive'
import { useSidebarNavigate } from '@/components/app-shell'
import { useSwipeToArchive } from '@/components/use-swipe-to-archive'
import { useHealth, usePinRun, useProjectUiState, useProjectRuns, useProjectRepoBase, useProjects, useReferenceProjectId, useRuns } from '@/api/queries'
import { Link, scopeTo, useNavigate, useProjectMatch } from '@/lib/project-router'
import type { ArchiveFinishedScope, RunSummary, SidebarLimits } from '@open-mercato/cezar-api-client'
import { DiffStatLabel } from '@/components/diff-stat'
import { useListView } from '@/components/list-view'
import { ReferenceList } from '@/components/reference-overflow'
import { useReferenceScope, ReferenceStatusProvider } from '@/components/reference-status'
import { RunRowActions, RunRowSwipeFrame } from '@/components/run-row-actions'
import { StatusDot } from '@/components/status-dot'
import { deriveAttention } from '@/lib/attention'
import { ELLIPSIS_HIDDEN_CLASS, useEllipsisHiddenChildren } from '@/lib/ellipsis-hidden'
import { useNoHover } from '@/lib/use-no-hover'
import { useIsDesktop } from '@/lib/use-desktop'
import { isUnread } from '@/lib/read-state'
import { runRowMeta, runRowTitle, type RunRowMeta } from '@/lib/run-row-meta'
import {
  capBuckets,
  groupRuns,
  sidebarCounts,
  sidebarRuns,
  loudestMember,
  sidebarActiveRunId,
  type SidebarView,
  type QuickListBucket,
  type QuickListRow,
} from '@/lib/task-groups'
import { isSweepable, sweepableRunCount, isOwnRepoReference, taskReferences } from '@/lib/tasks-table'
import { useNow } from '@/lib/use-now'
import { useSidebarSections } from '@/lib/use-sidebar-sections'
import { cn } from '@/lib/utils'

/**
 * The sidebar's task quick-list (spec, "App shell & navigation"): Active/Automations tabs, then the
 * runs grouped Needs you / Finished / Working.
 *
 * Presentational — every decision it paints (which bucket, which order, which dot) is made by
 * `lib/task-groups.ts` and `lib/attention.ts`, which are pure and table-tested. What is left here
 * is markup, the router, and the section folding.
 */
export function TaskQuickList({
  runs,
  view,
  onViewChange,
  currentRunId = null,
  now = Date.now(),
  onTogglePin,
  onArchiveRun,
  onSweep,
  sweeping = null,
  showViewControls = true,
  rowLimit,
  sidebarLimits,
  projectId = null,
}: {
  runs: RunSummary[]
  view: SidebarView
  onViewChange: (view: SidebarView) => void
  /** The run open at `/tasks/:id`, so its row can show as active. */
  currentRunId?: string | null
  /** Injected so the ages are not racing the clock in tests. */
  now?: number
  /** Pin/unpin one row (#935). The container owns the mutation, because WHICH project a row
   *  belongs to is a container's question — this list is painted for other projects too. */
  onTogglePin?: (run: RunSummary, pinned: boolean) => void
  /** Archive one finished row (#780). Like the pin, the container owns the mutation. */
  onArchiveRun?: (run: RunSummary) => void | Promise<unknown>
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
  const counts = sidebarCounts(runs)
  // Both tabs list unarchived tasks in status sections (hearsay-tools/cezarion#1332); archived
  // history and Restore live on the Tasks table.
  const inView = sidebarRuns(runs, view)
  const allBuckets = groupRuns(inView, 'active')
  const buckets = capBuckets(allBuckets, sidebarLimits ?? rowLimit ?? { overall: null })
  // From the tab's FULL list, not the capped buckets: "Archive all" sweeps rows the cap hides, so
  // its visibility must not depend on which of them are painted. The container scopes the sweep
  // itself to the same tab.
  const sweepCounts = onSweep ? sweepCountsOf(inView) : undefined

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
          <SidebarViewTabs view={view} onSelect={onViewChange} counts={counts} />
        </div>
      </div> : null}

      {allBuckets.length === 0 ? (
        <p className="px-3 py-3.5 text-xs text-soft-foreground">
          {view === 'automations' ? 'No automation tasks.' : 'No tasks yet — describe one.'}
        </p>
      ) : (
        <QuickListBuckets
          buckets={buckets}
          allBuckets={allBuckets}
          sectionProjectId={projectId}
          currentRunId={sidebarActiveRunId(currentRunId, runs)}
          now={now}
          onTogglePin={onTogglePin}
          onArchiveRun={onArchiveRun}
          onSweep={onSweep}
          sweeping={sweeping}
          sweepCounts={sweepCounts}
        />
      )}
    </div>
  )
}

/** How many runs each group sweep would take: the same predicate the server sweeps with. */
export function sweepCountsOf(runs: readonly RunSummary[]): { unpinned: number; pinned: number } {
  return { unpinned: sweepableRunCount(runs, 'unpinned'), pinned: sweepableRunCount(runs, 'pinned') }
}


/**
 * The bucketed rows alone — the piece the multi-project sidebar reuses per project group
 * (step 3.3), without the Active/Automations tabs that belong to the boot list's framing.
 *
 * `scope` prefixes every row target with an EXPLICIT `/p/<id>` (a non-active project's rows
 * must land in that project); `null` keeps the wrapper-Link default — the active scope.
 */
export function QuickListBuckets({
  buckets,
  currentRunId = null,
  now = Date.now(),
  scope = null,
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
  now?: number
  scope?: string | null
  onTogglePin?: (run: RunSummary, pinned: boolean) => void
  onArchiveRun?: (run: RunSummary) => void | Promise<unknown>
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
  const focusedRow = React.useRef<{ id: string; element: HTMLElement } | null>(null)
  React.useLayoutEffect(() => {
    const previous = focusedRow.current
    if (!previous || previous.element.isConnected) return
    // A disconnected control gets one recovery attempt, never a claim on future focus after
    // removal or navigation. A successful focus below captures the newly mounted control.
    focusedRow.current = null
    if (document.activeElement !== document.body) return
    const destination = allBuckets.find(bucket => bucket.rows.some(row => row.run.id === previous.id))
    // Removal belongs to the archive controller. A status move belongs to this list; if its
    // destination is folded, focus the disclosure rather than silently unfolding the section.
    if (!destination) return
    const bucket = Array.from(listRef.current?.children ?? []).find(el => (el as HTMLElement).dataset.bucket === destination.label)
    const row = Array.from(bucket?.querySelectorAll<HTMLElement>('[data-slot="task-row"]') ?? [])
      .find(el => el.dataset.runId === previous.id)
    const rowTarget = row?.querySelector<HTMLElement>('a')
    const target = rowTarget ?? bucket?.querySelector<HTMLElement>('[data-slot="section-toggle"]')
    target?.focus({ preventScroll: true })
  })
  const renderRow = (row: QuickListRow, inWorkingGroup = false) => <RunRow inWorkingGroup={inWorkingGroup} run={row.run} queuePosition={row.queuePosition} currentRunId={currentRunId} now={now} scope={scope} onTogglePin={onTogglePin} onArchiveRun={onArchiveRun} />

  return (
    <div ref={listRef} className="flex flex-col gap-3" onFocusCapture={event => {
      const row = event.target.closest<HTMLElement>('[data-slot="task-row"]')
      focusedRow.current = row?.dataset.runId ? { id: row.dataset.runId, element: event.target } : null
    }} onBlurCapture={event => {
      // An intentional exit (including blur to body) must not be restored by a later update.
      // Removing a focused row does not emit blur; that is the status-move path above.
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) focusedRow.current = null
    }}>
      {allBuckets.map((bucket) => {
        const archived = bucket.label === 'Archived'
        const collapsed = sections.isCollapsed(bucket.label)
        const rows = buckets.find(({ label }) => label === bucket.label)?.rows ?? []
        const members = bucket.rows.map(row => row.run)
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
            <div key={row.run.id}>
              {renderRow(row, bucket.label === 'Working')}
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
  view: SidebarView
  current: SidebarView
  onSelect: (view: SidebarView) => void
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

/**
 * Whether a list row's references render as inert text (#617 01b): on a device that cannot hover,
 * and in the mobile shell, where the row itself is the tap target. One condition for every task
 * row, so a reference is never a link in one and text in its neighbour.
 */
function useRowReferencesInert(): boolean {
  const noHover = useNoHover()
  const desktop = useIsDesktop()
  return noHover || !desktop
}

/** The width `el`'s content needs, however wide its box is. `scrollWidth` floors at `clientWidth`
 *  when the content fits, so a line measured in a wide box would "need" the whole box and drop its
 *  age on the first small shrink; a Range around the contents reports the real extent. jsdom has no
 *  Range rects: fall back to `scrollWidth`. */
function contentWidth(el: HTMLElement): number {
  const range = document.createRange()
  range.selectNodeContents(el)
  const width = range.getBoundingClientRect?.().width
  // Reference fitting removes inline chips, but age remains lower priority than those chips.
  // Use their preferred width so overflow cannot trick the age policy into restoring too early.
  const referenceList = el.querySelector<HTMLElement>('[data-reference-width]')
  const missingReferences = referenceList
    ? Math.max(0, Number(referenceList.dataset.referenceWidth) - referenceList.getBoundingClientRect().width) : 0
  return Math.ceil((width || el.scrollWidth) + missingReferences)
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
      for (const child of [...el.children, ...el.querySelectorAll('[data-slot="reference-list"] [data-slot="pr-chip"], [data-slot="reference-list"] [data-slot="issue-chip"]')]) {
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
    mutations?.observe(el, { childList: true, subtree: true })
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

function MetaSeparator() {
  return <span aria-hidden="true">{' · '}</span>
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
 */
function RunRow({
  run,
  queuePosition,
  currentRunId,
  now,
  scope,
  inWorkingGroup = false,
  onTogglePin,
  onArchiveRun,
}: {
  run: RunSummary
  queuePosition: number | null
  currentRunId: string | null
  now: number
  /** Explicit `/p/<id>` link scope for a non-active project's row; null = the active scope. */
  scope: string | null
  inWorkingGroup?: boolean
  onTogglePin?: (run: RunSummary, pinned: boolean) => void
  /** Archive this row (#780). Where references are inert (touch, the mobile shell) the swipe
   *  replaces the button, so it only renders on a device that can hover. A promise that
   *  resolves `false` says the archive failed, and a swiped row snaps back. */
  onArchiveRun?: (run: RunSummary) => void | Promise<unknown>
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
  const { title, displayTitle } = runRowTitle(run)
  // Read/unread (#unread-done-items): an unread done item is promoted (bright + semibold) and
  // wears a trailing marker in its OUTCOME colour (#617); a read one stays muted so the history
  // steps back. Both are orthogonal to the leading status dot, which keeps saying done/failed.
  const unread = isUnread(run)
  const meta = runRowMeta({ run, attention, queuePosition, inWorkingGroup, scope, now })
  // The sibling slot below and the meta line's reference list meet through this element.
  const [overflowContainer, setOverflowContainer] = React.useState<HTMLSpanElement | null>(null)

  return (
    <RunRowSwipeFrame
      inertReferences={inertReferences}
      swipeable={swipeable}
      swipe={swipe}
      title={title}
      onArchive={() => void onArchiveRun?.(run)}
    >
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
          <RunRowTitleLink
            run={run}
            to={to}
            title={title}
            displayTitle={displayTitle}
            isActive={isActive}
            unread={unread}
            swipeable={swipeable}
            onNavigate={onNavigate}
          />
          <RunRowMetaLine
            run={run}
            meta={meta}
            title={title}
            scope={scope}
            isActive={isActive}
            inertReferences={inertReferences}
            overflowContainer={overflowContainer}
          />
        </div>
        {meta.references.length ? <span ref={setOverflowContainer} data-slot="protected-reference-overflow"
          className={cn('shrink-0 self-end', inertReferences && '-my-1.5 self-center')} /> : null}
        {run.delegation?.role === 'worker' ? <span className="sr-only">Worker · {attention.label}</span> : null}
        <RunRowActions
          run={run}
          title={title}
          unread={unread}
          inertReferences={inertReferences}
          onTogglePin={onTogglePin}
          onArchiveRun={onArchiveRun}
        />
      </div>
    </RunRowSwipeFrame>
  )
}

/** The row's title line: the title as a true `<Link>`, then the diff numbers. */
function RunRowTitleLink({
  run,
  to,
  title,
  displayTitle,
  isActive,
  unread,
  swipeable,
  onNavigate,
}: {
  run: RunSummary
  to: React.ComponentProps<typeof Link>['to']
  /** The FULL stored title, for the link's tooltip. */
  title: string
  /** The title as painted: without the `NNN: ` prefix the meta line's reference replaces. */
  displayTitle: string
  isActive: boolean
  unread: boolean
  swipeable: boolean
  onNavigate: (() => void) | undefined
}) {
  return (
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
        {displayTitle}
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
  )
}

/**
 * The row's meta line: one line, truncated, never wrapped. References are plain muted links
 * here (#617) — no chip border, no teal — but keep their status panel and their name.
 *
 * It owns the state that follows the line's width — whether the age has been dropped — so that
 * state re-renders this line alone, and nothing else in the row reads it.
 */
function RunRowMetaLine({
  run,
  meta,
  title,
  scope,
  isActive,
  inertReferences,
  overflowContainer,
}: {
  run: RunSummary
  meta: RunRowMeta
  /** The FULL stored title, which a reference's status card names the task by. */
  title: string
  scope: string | null
  isActive: boolean
  inertReferences: boolean
  overflowContainer: HTMLSpanElement | null
}) {
  const { stateWord, references, age, key } = meta
  const referenceScope = useReferenceScope()
  // Width priority on the meta line, every row (#729): the age is the least important item and
  // goes first, whole and with its separator, before anything is ellipsized. The hand-off glyph
  // never goes: it leads the line, and the line truncates at its end.
  const metaRef = React.useRef<HTMLDivElement | null>(null)
  const ageDropped = useAgeDropped(metaRef, Boolean(age), key)
  // A reference the line's ellipsis hid must not take the click meant for the row.
  useEllipsisHiddenChildren(metaRef, !inertReferences && references.length > 0, `${key}|${ageDropped ? 1 : 0}`)

  const parts: React.ReactNode[] = []
  if (stateWord) parts.push(<span key="state" data-slot="task-row-state">{stateWord}</span>)
  if (references.length) parts.push(<ReferenceList key="references" references={references} maxVisible={2}
    taskTitle={title} projectId={scope ?? referenceScope.projectId} repoBase={referenceScope.repoBase} runId={run.id}
    plain compact inertInline={inertReferences} fitContainer overflowContainer={overflowContainer} />)
  if (age && !ageDropped) parts.push(<span key="age" data-slot="task-row-age" className="tabular-nums">{age}</span>)

  return (
    <div
      ref={metaRef}
      data-slot="task-row-meta"
      className={cn(
        'h-[16px] min-w-0 truncate text-[11.5px] leading-[1.4] font-normal text-soft-foreground',
        ELLIPSIS_HIDDEN_CLASS,
        // On the selected fill `--soft-foreground` is 4.45:1 (dark) / 4.25:1 (light), under
        // the 4.5:1 an 11.5px line needs; it steps up one ink, as the title steps to
        // `--foreground`.
        isActive && 'text-muted-foreground',
      )}
    >
      {/* Handed off to the task webhook (#729): first on the line, in the line's own colour
          (`currentColor`: `--soft-foreground`, one step up when selected) — a fact, not a
          status, so no tone. NOT part of `parts`: it must not count as content for the
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
      {parts.length ? parts.flatMap((part, index) => (index ? [<MetaSeparator key={`sep-${index}`} />, part] : [part])) : run.notify === true ? null : ' '}
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
 * stream, Step 3.2), the router for which row is open, and the sidebar Active/Automations context —
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
  const [view, setView] = useListView()
  // Project-prefix-agnostic matches (step 3.2): `/p/<id>/tasks/:id` must light its row too.
  const match = useProjectMatch('/tasks/:id/*')
  const exact = useProjectMatch('/tasks/:id')
  const now = useNow(30_000)
  // The sidebar's chips are the same chips as the tables', so they get their status the same way:
  // one batched request for the whole list, mounted here where the list is.
  const referenceProjectId = useReferenceProjectId()
  const projectId = explicitProjectId ?? referenceProjectId
  const repoBase = useProjectRepoBase(projectId)
  const buckets = capBuckets(groupRuns(sidebarRuns(runs.data ?? [], view), 'active'), sidebarLimits)
  const referenceRequests = projectId === undefined ? [] : buckets.flatMap(bucket =>
    bucket.rows.flatMap(({ run }) =>
      taskReferences(run, repoBase).filter(ref => isOwnRepoReference(ref, repoBase)).map(
        reference => ({ projectId, kind: reference.kind, number: reference.number }),
      ),
    ),
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
        now={now}
        // Bind the mutation to the same explicit project and cache as this list.
        onTogglePin={(run, pinned) =>
          pin.mutate({ id: run.id, pinned })
        }
        onArchiveRun={archive.archiveOne}
        // Each tab sweeps only its own finished tasks: the ones it lists and counts.
        onSweep={(scope) => archive.sweep(scope, view === 'automations')}
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
      queryFn: async () => [] as RunSummary[],
      enabled: false,
    })),
  })
  const seen = new Set<string>()
  const combined: RunSummary[] = []
  const add = (projectId: string, run: RunSummary) => {
    const key = `${projectId}:${run.id}`
    if (seen.has(key)) return
    seen.add(key)
    combined.push(run)
  }
  for (const run of runs.data ?? []) add(runsProjectId, run)
  otherProjects.forEach((project, index) => {
    for (const run of otherLists[index]?.data ?? []) add(project.id, run)
  })
  return (
    <div data-slot="sidebar-session-scope" role="group" aria-label="Session scope" className="flex w-full gap-1 rounded-lg bg-muted p-[3px]">
      <SidebarViewTabs view={view} onSelect={setView} counts={sidebarCounts(combined)} />
    </div>
  )
}

/** Active and Automations (hearsay-tools/cezarion#1332), each with its count and, while another
 *  tab is selected, a dot when its own tasks need you: the one reason to look at a tab you are
 *  not on. */
function SidebarViewTabs({ view, onSelect, counts }: {
  view: SidebarView
  onSelect: (view: SidebarView) => void
  counts: ReturnType<typeof sidebarCounts>
}) {
  const dot = <StatusDot tone="pending" pulse data-slot="waiting-dot" aria-label="needs you" />
  return (
    <>
      <ViewTab view="active" current={view} onSelect={onSelect} count={counts.active}>
        Active
        {counts.activeWaiting > 0 && view !== 'active' ? dot : null}
      </ViewTab>
      <ViewTab view="automations" current={view} onSelect={onSelect} count={counts.automations}>
        Automations
        {counts.automationsWaiting > 0 && view !== 'automations' ? dot : null}
      </ViewTab>
    </>
  )
}
