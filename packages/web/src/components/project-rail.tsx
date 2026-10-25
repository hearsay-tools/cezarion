import {
  closestCenter,
  DndContext,
  KeyboardCode,
  KeyboardSensor,
  MeasuringStrategy,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
  type Modifier,
  type ScreenReaderInstructions,
} from '@dnd-kit/core'
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { GripVerticalIcon, PanelLeftCloseIcon, PanelLeftOpenIcon } from 'lucide-react'
import * as React from 'react'
import { Link as RouterLink, useLocation } from 'react-router'

import type { ProjectListEntry } from '@open-mercato/cezar-api-client'
import { AddProjectMenu, ShellSidebarWidthContext } from '@/components/app-shell'
import { LayersIcon, PlusIcon, Settings2Icon } from '@/components/design-icons'
import { FOOTER_ICON_ACTIVE_CLASS } from '@/components/nav-row-styles'
import { useTheme } from '@/components/theme-provider'
import { ThemeToggle } from '@/components/theme-toggle'
import { moveProjectId } from '@/lib/project-order'
import { pathnameProjectId, scopeTo } from '@/lib/project-router'
import type { ProjectSwitchTarget } from '@/lib/project-switch'
import { SignalPill, signalPillSegments } from '@/components/signal-pill'
import { ProjectStateWords } from '@/components/project-state-words'
import { projectInitials, projectSignalLabel, type ProjectSignal } from '@/lib/project-signal'
import {
  PROJECT_RAIL_COLLAPSED_WIDTH,
  PROJECT_RAIL_EXPANDED_WIDTH,
  railCanExpand,
  readStoredRailExpanded,
  writeStoredRailExpanded,
} from '@/lib/project-rail-expanded'
import { cn } from '@/lib/utils'

/**
 * The project rail (#618): a 60px, workspace-level column left of the desktop sidebar. Every
 * registered project gets a mark, and every mark carries two pills — top "for you" (amber needs
 * you, red failed), bottom "in motion and new" (violet working, green finished). The sidebar next
 * to it stays project-level. The whole column is `md`-up; below it the drawer carries the same signal (slice 4).
 *
 * On a wide screen it unfolds (#711) to 232px: the same marks and pills beside each project's full
 * name and its state in words, the mobile drawer's row at desktop scale. One toggle at the top of
 * the bottom group switches; the choice is per browser (`lib/project-rail-expanded.ts`), and a
 * window too narrow to keep the main column at 640px shows the collapsed rail with no toggle.
 *
 * Presentational: it takes the registry rows and the four counts per project. `ProjectRailContainer`
 * wires the live data. The counts come from `lib/project-signal.ts`; nothing here decides what a
 * run means.
 *
 * Projects are sortable in both widths (hearsay-tools/cezarion#438, port of open-mercato/cezar#952):
 * a pointer drags the whole row once it has moved a few pixels, so a plain click stays a click.
 * The keyboard lifts from one control per row — the mark's link when collapsed (Space; Enter still
 * navigates), the grip when expanded — then arrows move and Space drops. The order itself lives in
 * the workspace ui-state (`lib/use-project-order.ts`) and arrives here already applied.
 */

/** What a row needs from the rail's `useSortable` call. Absent when the rail cannot reorder. */
type RailSort = {
  setNodeRef: (element: HTMLElement | null) => void
  setActivatorNodeRef: (element: HTMLElement | null) => void
  style: React.CSSProperties
  /** Pointer and keyboard listeners, on the row wrapper: pointerdown from anywhere in the row
   *  bubbles up to it, and dnd-kit only lifts on a key when the target is the activator. */
  listeners: Record<string, unknown> | undefined
  /** dnd-kit's aria attributes, for the activator. */
  attributes: Record<string, unknown>
  isDragging: boolean
  position: number
  total: number
}

/** The lifted row, faded in place and above its neighbours (no overlay copy: the row moves). */
function dragClass(sort: RailSort | undefined) {
  // No iOS link callout on a sortable row: a long press there lifts the project instead.
  if (sort === undefined) return undefined
  return sort.isDragging ? 'relative z-10 opacity-40 [-webkit-touch-callout:none]' : '[-webkit-touch-callout:none]'
}

/** One project's row: 52px tall so a pill above and below the mark never touches its neighbours. */
function ProjectMark({
  project,
  signal,
  known,
  current,
  target,
  onSwitchProject,
  onSelectProject,
  sort,
}: {
  project: ProjectListEntry
  signal: ProjectSignal | undefined
  known: boolean
  current: boolean
  /** Where the mark goes: the project's remembered page, or its home. */
  target: ProjectSwitchTarget
  onSwitchProject?: ((projectId: string) => void) | undefined
  onSelectProject?: ((projectId: string) => void) | undefined
  sort?: RailSort | undefined
}) {
  const label = projectSignalLabel(project.name, signal, { unknown: !known })
  return (
    <div
      ref={sort?.setNodeRef}
      style={sort?.style}
      {...sort?.listeners}
      data-slot="rail-project"
      data-project-id={project.id}
      data-dragging={sort?.isDragging ? '' : undefined}
      className={cn('relative flex h-[52px] w-full shrink-0 items-center justify-center', dragClass(sort))}
    >
      {current ? (
        // The current project's bar on the rail's left edge, vertically centred on the mark.
        <span aria-hidden="true" data-slot="rail-current-bar" className="absolute top-1/2 left-0 h-5 w-[3px] -translate-y-1/2 rounded-r-[2px] bg-foreground" />
      ) : null}
      <div className="relative size-9">
        <RouterLink
          ref={sort?.setActivatorNodeRef}
          // The link stays a link: only the reorder instructions join it, never dnd-kit's
          // `role="button"`. No room for a grip at 60px, so Space on the mark lifts it.
          aria-describedby={sort?.attributes['aria-describedby'] as string | undefined}
          to={target.href}
          onClick={(event) => {
            // New-tab/window gestures must not change the sidebar in this window.
            if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
            onSelectProject?.(project.id)
            if (target.verify && onSwitchProject) {
              event.preventDefault()
              onSwitchProject(project.id)
            }
          }}
          aria-label={label}
          title={label}
          aria-current={current ? 'page' : undefined}
          className={cn(
            'flex size-full items-center justify-center rounded-[9px] border text-[12px] leading-none font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
            current
              ? 'border-soft-foreground bg-sidebar-row-selected text-foreground'
              : 'border-transparent bg-muted text-muted-foreground hover:text-foreground',
          )}
        >
          {projectInitials(project.name)}
        </RouterLink>
        <SignalPill position="top" segments={signalPillSegments(signal).top} />
        <SignalPill position="bottom" segments={signalPillSegments(signal).bottom} />
      </div>
    </div>
  )
}

/** Names and state words mount with the expanded rail and fade in after its width settles. */
const TEXT_IN = 'motion-safe:rail-text-in'

/** The expanded rail's project row (#711): 52px, the collapsed rail's mark on the left (both pills,
 *  same positions), the full name and at most two state words. The whole row is the link. */
function ExpandedProjectRow({
  project,
  signal,
  known,
  current,
  target,
  onSwitchProject,
  onSelectProject,
  sort,
}: {
  project: ProjectListEntry
  signal: ProjectSignal | undefined
  known: boolean
  current: boolean
  /** Where the mark goes: the project's remembered page, or its home. */
  target: ProjectSwitchTarget
  onSwitchProject?: ((projectId: string) => void) | undefined
  onSelectProject?: ((projectId: string) => void) | undefined
  sort?: RailSort | undefined
}) {
  // The words are on screen, so no tooltip; the accessible name still spells all four counts.
  const label = projectSignalLabel(project.name, signal, { unknown: !known })
  const { top, bottom } = signalPillSegments(signal)
  // The pills' ring is the surface under them, so the cut-out follows the row's fill.
  const ring = current ? 'border-sidebar-row-selected' : 'border-background group-hover:border-sidebar-row-hover'
  return (
    <div
      ref={sort?.setNodeRef}
      style={sort?.style}
      {...sort?.listeners}
      data-slot="rail-project"
      data-project-id={project.id}
      data-dragging={sort?.isDragging ? '' : undefined}
      className={cn('group/row relative w-full shrink-0', dragClass(sort))}
    >
      <RouterLink
        to={target.href}
        onClick={(event) => {
          if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
          onSelectProject?.(project.id)
          if (target.verify && onSwitchProject) {
            event.preventDefault()
            onSwitchProject(project.id)
          }
        }}
        aria-label={label}
        aria-current={current ? 'page' : undefined}
        className={cn(
          // `pr-6` keeps the name clear of the grip, which sits over the row's right edge.
          'group flex h-[52px] w-full items-center gap-[10px] rounded-[8px] px-[6px] pr-6 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
          current ? 'bg-sidebar-row-selected' : 'hover:bg-sidebar-row-hover',
        )}
      >
        <span
          aria-hidden="true"
          data-slot="rail-mark"
          className={cn(
            // Fill `--sidebar` on the current row, as in the drawer: the collapsed rail's selected
            // fill would vanish into the row's.
            'relative flex size-9 shrink-0 items-center justify-center rounded-[9px] border text-[12px] leading-none font-semibold',
            current ? 'border-soft-foreground bg-sidebar text-foreground' : 'border-transparent bg-muted text-muted-foreground',
          )}
        >
          {projectInitials(project.name)}
          <SignalPill position="top" segments={top} className={ring} />
          <SignalPill position="bottom" segments={bottom} className={ring} />
        </span>
        <span className={cn('flex min-w-0 flex-1 flex-col gap-px', TEXT_IN)}>
          <span data-slot="rail-project-name" className={cn('truncate text-[13.5px] leading-[18px] font-semibold', current ? 'text-foreground' : 'text-muted-foreground')}>
            {project.name}
          </span>
          {/* Two parts at most: a third is cut mid-word at 232px. The pills show all four. */}
          <ProjectStateWords
            signal={signal}
            known={known}
            current={current}
            maxParts={2}
            slot="rail-project-state"
            className="h-4 gap-x-[4px] overflow-hidden text-[11px] leading-4 whitespace-nowrap"
          />
        </span>
      </RouterLink>
      {sort ? <RailGrip name={project.name} sort={sort} /> : null}
    </div>
  )
}

/**
 * The expanded row's reorder handle: a real `<button>` carrying dnd-kit's attributes, which is
 * what makes Space-lift / arrows-move / Space-drop work without a pointer. A SIBLING of the row's
 * link, never a child — a button inside a link is invalid. Positioned over the row's right edge
 * so the row's hover fill runs under it.
 *
 * Ink only on hover or focus where hovering exists, so a list of projects does not read as a list
 * of grab handles; always visible under `(hover: none)`, where neither will ever happen.
 */
function RailGrip({ name, sort }: { name: string; sort: RailSort }) {
  return (
    <button
      type="button"
      ref={sort.setActivatorNodeRef}
      data-slot="rail-project-grip"
      {...sort.attributes}
      aria-label={`Reorder ${name}, position ${sort.position} of ${sort.total}`}
      className={cn(
        'absolute top-1/2 right-0.5 flex h-10 w-5 -translate-y-1/2 cursor-grab touch-none items-center justify-center rounded text-soft-foreground opacity-0 outline-none transition-opacity hover:text-foreground motion-reduce:transition-none',
        'focus-visible:opacity-100 focus-visible:ring-[3px] focus-visible:ring-ring/50',
        'group-hover/row:opacity-100 group-focus-within/row:opacity-100 [@media(hover:none)]:opacity-100',
      )}
    >
      <GripVerticalIcon aria-hidden="true" className="size-3.5" />
    </button>
  )
}

/** One rail row, sortable. `useSortable` is a hook, so each row is its own component. */
function SortableRailProject({
  expanded,
  position,
  total,
  sortable,
  ...rowProps
}: React.ComponentProps<typeof ProjectMark> & { expanded: boolean; position: number; total: number; sortable: boolean }) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({
    id: rowProps.project.id,
    disabled: !sortable,
  })
  const sort: RailSort | undefined = sortable
    ? {
        setNodeRef,
        setActivatorNodeRef,
        // `Translate`, not `Transform`: every row is the same 52px, so a scale is never wanted.
        style: { transform: CSS.Translate.toString(transform), transition },
        listeners,
        attributes: attributes as unknown as Record<string, unknown>,
        isDragging,
        position,
        total,
      }
    : undefined
  return expanded ? <ExpandedProjectRow {...rowProps} sort={sort} /> : <ProjectMark {...rowProps} sort={sort} />
}

/** A column, so a row moves up and down only: sideways it would leave a 60px rail. */
const restrictToRailAxis: Modifier = ({ transform }) => ({ ...transform, x: 0 })

/**
 * The pointer sensor for a mouse or a pen only. A finger goes to the touch sensor below: a
 * collapsed mark keeps the browser's default `touch-action` so the rail still scrolls under a
 * swipe, and the browser cancels a pointer-driven drag the moment that swipe becomes a scroll.
 * Both sensors cannot share a press — dnd-kit lets the first activator (`pointerdown`, before
 * `touchstart`) own it — so this one has to step aside for touch.
 */
class RailPointerSensor extends PointerSensor {
  static override activators = [
    {
      eventName: 'onPointerDown' as const,
      handler: ({ nativeEvent }: React.PointerEvent, options: Parameters<(typeof PointerSensor.activators)[number]['handler']>[1]) =>
        nativeEvent.pointerType !== 'touch' && PointerSensor.activators[0]!.handler({ nativeEvent } as React.PointerEvent, options),
    },
  ]
}

/** A finger lifts a project with a long press, so a swipe across the rail stays a scroll. The
 *  tolerance lets a resting finger wobble without cancelling the press. */
const RAIL_TOUCH_CONSTRAINT = { delay: 250, tolerance: 5 }

/** Space lifts, so Enter on a collapsed mark still follows its link. */
const RAIL_KEYBOARD_CODES = {
  start: [KeyboardCode.Space],
  cancel: [KeyboardCode.Esc],
  end: [KeyboardCode.Space, KeyboardCode.Enter, KeyboardCode.Tab],
}

/** Measure the rows all the time, not only once a drag starts. dnd-kit's default measures the
 *  drop targets in an effect AFTER the lift, so an arrow key or a pointer release in that gap
 *  resolves to no target and the drop silently does nothing — seen in a real browser as a lost
 *  keyboard move. A rail holds a few dozen fixed-height rows, so measuring them is cheap. */
const RAIL_MEASURING = { droppable: { strategy: MeasuringStrategy.Always } }

const RAIL_INSTRUCTIONS: ScreenReaderInstructions = {
  draggable:
    'To reorder projects, press Space to pick this project up. Use the up and down arrow keys to move it, Space to drop it, or Escape to cancel.',
}

/**
 * The rail's reorder wiring: sensors, the persisted move, the click guard, the announcements.
 *
 * The click guard exists because the rows are links. dnd-kit stops the click that ends a pointer
 * drag from PROPAGATING, so React Router's handler never runs — but it does not cancel the click,
 * and an anchor's default action is a full page load. A capture listener on `window` (ahead of
 * dnd-kit's on `document`) cancels it for the length of the drag and one tick after.
 */
function useRailSorting(given: readonly ProjectListEntry[], onReorder: ((ids: readonly string[]) => void) | undefined) {
  // The order a drop just chose, shown until the store's order arrives. The store answers a
  // macrotask late (TanStack Query notifies its observers on `setTimeout(0)`), while dnd-kit
  // clears the drag's transform in the drop's own render — so without this the rail paints one
  // frame of the OLD order, the row snaps back towards its old slot, and then animates to its new
  // one (seen in real Chrome, hearsay-tools/cezarion#438). Keyed on the `given` array it was set
  // against: any new array from the store replaces it, including the one a failed write restores.
  const [dropped, setDropped] = React.useState<{ base: readonly ProjectListEntry[]; ids: readonly string[] } | null>(null)
  const projects = React.useMemo(() => {
    if (dropped === null || dropped.base !== given) return given
    const byId = new Map(given.map((project) => [project.id, project]))
    return dropped.ids.flatMap((id) => byId.get(id) ?? [])
  }, [dropped, given])
  const ids = React.useMemo(() => projects.map((project) => project.id), [projects])
  const sensors = useSensors(
    useSensor(RailPointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: RAIL_TOUCH_CONSTRAINT }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates, keyboardCodes: RAIL_KEYBOARD_CODES }),
  )

  const releaseClickGuard = React.useRef<(() => void) | null>(null)
  const armClickGuard = React.useCallback(() => {
    releaseClickGuard.current?.()
    const cancel = (event: MouseEvent) => event.preventDefault()
    window.addEventListener('click', cancel, true)
    releaseClickGuard.current = () => {
      window.removeEventListener('click', cancel, true)
      releaseClickGuard.current = null
    }
  }, [])
  const disarmClickGuard = React.useCallback(() => {
    // After the click that ends the drag has been dispatched, which happens in the same task.
    const release = releaseClickGuard.current
    window.setTimeout(() => release?.(), 0)
  }, [])
  React.useEffect(() => () => releaseClickGuard.current?.(), [])

  const onDragEnd = React.useCallback(
    (event: DragEndEvent) => {
      disarmClickGuard()
      const { active, over } = event
      if (!onReorder || over === null || over.id === active.id) return
      // The WHOLE visible order is persisted, not just the moved id, so nothing re-sorts itself
      // on the next read.
      const next = moveProjectId(ids, ids.indexOf(String(active.id)), ids.indexOf(String(over.id)))
      if (!next.some((id, index) => id !== ids[index])) return
      setDropped({ base: given, ids: next })
      onReorder(next)
    },
    [disarmClickGuard, given, ids, onReorder],
  )

  // dnd-kit's defaults would read out the project SLUG. The name and the position are what a
  // person needs to reorder a list without seeing it.
  const announcements = React.useMemo<Announcements>(() => {
    const describe = (id: string | number) => {
      const index = ids.indexOf(String(id))
      return { name: projects[index]?.name ?? String(id), position: `position ${index + 1} of ${ids.length}` }
    }
    return {
      onDragStart: ({ active }) => `Picked up ${describe(active.id).name}, ${describe(active.id).position}.`,
      onDragOver: ({ active, over }) =>
        over ? `${describe(active.id).name} moved to ${describe(over.id).position}.` : `${describe(active.id).name} is not over a drop position.`,
      onDragEnd: ({ active, over }) =>
        over ? `${describe(active.id).name} dropped at ${describe(over.id).position}.` : `${describe(active.id).name} dropped. The order is unchanged.`,
      onDragCancel: ({ active }) => `Reordering cancelled. ${describe(active.id).name} returned to ${describe(active.id).position}.`,
    }
  }, [ids, projects])

  return { projects, ids, sensors, announcements, onDragStart: armClickGuard, onDragEnd, onDragCancel: disarmClickGuard }
}

/** The bottom group's shared look: a 36px icon square collapsed, a 36px labelled row expanded.
 *  The same element either way, so focus stays put when the toggle switches. */
function bottomItemClass(expanded: boolean) {
  return cn(
    'flex shrink-0 items-center rounded-[8px] text-soft-foreground hover:bg-sidebar-row-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
    expanded ? 'size-auto h-9 w-full justify-start gap-3 px-2.5 text-[13px] font-normal' : 'size-9 justify-center',
  )
}
/** The row label: `--muted-foreground` beside a `--soft-foreground` icon, as on the board. */
const BOTTOM_LABEL = cn('truncate text-muted-foreground group-hover:text-foreground', TEXT_IN)

/** A link in the bottom group. Active is the footer icons' selected fill (#617 01c). */
function RailLink({
  to,
  label,
  slot,
  active,
  expanded,
  children,
}: {
  to: string
  label: string
  slot: string
  active: boolean
  expanded: boolean
  children: React.ReactNode
}) {
  return (
    <RouterLink
      to={to}
      data-slot={slot}
      aria-label={label}
      title={expanded ? undefined : label}
      aria-current={active ? 'page' : undefined}
      className={cn('group', bottomItemClass(expanded), active && FOOTER_ICON_ACTIVE_CLASS)}
    >
      {children}
      {expanded ? <span className={BOTTOM_LABEL}>{label}</span> : null}
    </RouterLink>
  )
}

/** Whether this window has room for the expanded rail beside the sidebar. Live on resize. */
function useRoomToExpand(sidebarWidth: number): boolean {
  const [viewport, setViewport] = React.useState(() => window.innerWidth)
  React.useEffect(() => {
    const onResize = () => setViewport(window.innerWidth)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  return railCanExpand(viewport, sidebarWidth)
}

/** The rail's column, held empty until the registry answers (#1255). The rail mounts on that
 *  answer, and the health-gated sidebar footer can mount first: a rail arriving later pushed the
 *  whole sidebar sideways under a pointer, so a click aimed at the Tools trigger landed on the
 *  rail's theme toggle. Same width rule as the rail, so the swap moves nothing. */
export function ProjectRailPlaceholder() {
  const sidebarWidth = React.useContext(ShellSidebarWidthContext)
  const roomToExpand = useRoomToExpand(sidebarWidth)
  const expanded = readStoredRailExpanded() && roomToExpand
  return (
    <div
      aria-hidden="true"
      data-slot="project-rail-placeholder"
      style={{ width: expanded ? PROJECT_RAIL_EXPANDED_WIDTH : PROJECT_RAIL_COLLAPSED_WIDTH }}
      className="hidden shrink-0 border-r border-border bg-background md:block"
    />
  )
}

export type ProjectRailProps = {
  /** Display order: registry order until the user reorders (`lib/project-order.ts`). */
  projects: readonly ProjectListEntry[]
  /** Null while the runs index has not loaded: every mark then says its activity is unknown
   *  rather than idle. A loaded index with no entry for a project is a project with no runs. */
  signals: ReadonlyMap<string, ProjectSignal> | null
  version: string | null
  /** `capabilities.singleProject` (`CEZ_SINGLE_PROJECT=1`): the server refuses add, edit, browse
   *  and remove, so Add project and All projects go. Never inferred from the project count. */
  singleProject: boolean
  /** Where selecting a project goes. Defaults to each project's home. */
  projectTarget?: (projectId: string) => ProjectSwitchTarget
  /** Called instead of the link's own navigation when `projectTarget(id).verify` is set. */
  onSwitchProject?: ((projectId: string) => void) | undefined
  onSelectProject?: ((projectId: string) => void) | undefined
  /** The workspace ui-state has loaded, so a reorder has something safe to write. */
  canReorder?: boolean
  /** Persist a new order. Absent, the rail is not sortable. */
  onReorder?: (ids: readonly string[]) => void
}

const homeOf = (projectId: string): ProjectSwitchTarget => ({ href: String(scopeTo(projectId, '/')), verify: false })

export function ProjectRail({ projects, signals, version, singleProject, projectTarget = homeOf, onSwitchProject, onSelectProject, canReorder = false, onReorder }: ProjectRailProps) {
  const { pathname } = useLocation()
  const { resolvedTheme } = useTheme()
  const sidebarWidth = React.useContext(ShellSidebarWidthContext)
  // The stored choice survives a window too narrow to honour it: widening restores it.
  const [storedExpanded, setStoredExpanded] = React.useState(readStoredRailExpanded)
  const roomToExpand = useRoomToExpand(sidebarWidth)
  const expanded = storedExpanded && roomToExpand
  const toggle = () => {
    const next = !expanded
    setStoredExpanded(next)
    writeStoredRailExpanded(next)
  }
  // The URL's own scope. Global routes (`/settings/global`, `/tasks`) carry none, so no mark is
  // current there — the bottom group's icon is.
  const currentProjectId = pathnameProjectId(pathname)
  const allProjectsActive = pathname === '/tasks'
  const settingsActive = pathname === '/settings/global' || pathname.startsWith('/settings/global/')
  const appLabel = version ? `Cezarion v${version}` : 'Cezarion'
  const railId = React.useId()
  const sorting = useRailSorting(projects, onReorder)
  const sortable = canReorder && onReorder !== undefined && projects.length > 1

  return (
    <nav
      id={railId}
      aria-label="Projects"
      data-slot="project-rail"
      data-expanded={expanded ? 'true' : 'false'}
      style={{ width: expanded ? PROJECT_RAIL_EXPANDED_WIDTH : PROJECT_RAIL_COLLAPSED_WIDTH }}
      // Outside the resizable sidebar width, and desktop only: below `md` the drawer is the nav.
      // The layout pushes: the column widens and the main area gives the width up.
      className={cn(
        'hidden shrink-0 flex-col overflow-hidden border-r border-border bg-background pt-3 pb-3.5 transition-[width] duration-[160ms] ease-out motion-reduce:transition-none md:flex',
        expanded ? 'items-stretch px-2.5' : 'items-center',
      )}
    >
      {expanded ? (
        <div data-slot="rail-identity" className="flex shrink-0 flex-col gap-0.5">
          <div className="flex h-[34px] items-center gap-[10px] px-0.5">
            <img src={`/cezarion-mark-${resolvedTheme}.svg`} alt="" aria-hidden="true" data-slot="rail-app-mark" className="size-[34px] shrink-0 rounded-[8px]" />
            <span className={cn('flex min-w-0 items-baseline gap-[10px] whitespace-nowrap', TEXT_IN)} aria-label={appLabel}>
              <span className="text-[15px] leading-none font-bold text-foreground">Cezarion</span>
              {version ? <span data-slot="rail-version" title={`v${version}`} className="min-w-0 truncate text-[11px] leading-none text-soft-foreground">v{version}</span> : null}
            </span>
          </div>
          <div aria-hidden="true" className="h-px w-full bg-border" />
          <div className={cn('px-1 pt-2.5 pb-1 text-[11px] font-medium text-soft-foreground', TEXT_IN)}>Projects</div>
        </div>
      ) : (
        <div className="flex shrink-0 flex-col items-center gap-0.5">
          <img
            src={`/cezarion-mark-${resolvedTheme}.svg`}
            alt={appLabel}
            title={appLabel}
            data-slot="rail-app-mark"
            className="size-[34px] rounded-[9px]"
          />
          <div aria-hidden="true" className="mt-0.5 mb-1.5 h-px w-6 bg-border" />
        </div>
      )}

      {/* The only part that scrolls, so the app mark and the bottom group stay pinned. */}
      <div
        data-slot="rail-projects"
        className={cn(
          'flex min-h-0 w-full flex-1 flex-col gap-0.5 overflow-y-auto overscroll-contain [scrollbar-width:none]',
          expanded ? 'items-stretch' : 'items-center',
        )}
      >
        <DndContext
          sensors={sorting.sensors}
          collisionDetection={closestCenter}
          measuring={RAIL_MEASURING}
          modifiers={[restrictToRailAxis]}
          accessibility={{ announcements: sorting.announcements, screenReaderInstructions: RAIL_INSTRUCTIONS }}
          onDragStart={sorting.onDragStart}
          onDragEnd={sorting.onDragEnd}
          onDragCancel={sorting.onDragCancel}
        >
          <SortableContext items={sorting.ids} strategy={verticalListSortingStrategy} disabled={!sortable}>
            {sorting.projects.map((project, index) => (
              <SortableRailProject
                key={project.id}
                expanded={expanded}
                sortable={sortable}
                position={index + 1}
                total={sorting.projects.length}
                project={project}
                signal={signals?.get(project.id)}
                known={signals !== null}
                current={project.id === currentProjectId}
                target={projectTarget(project.id)}
                onSwitchProject={onSwitchProject}
                onSelectProject={onSelectProject}
              />
            ))}
          </SortableContext>
        </DndContext>
        {!singleProject ? (
          expanded ? (
            <AddProjectMenu
              origin="rail"
              icon={PlusIcon}
              iconClassName="size-[15px] text-soft-foreground"
              iconFrameClassName="flex size-9 shrink-0 items-center justify-center rounded-[9px] border border-border"
              label="Add project"
              side="right"
              triggerClassName={cn('h-[44px] w-full shrink-0 justify-start gap-[10px] rounded-[8px] px-[6px] text-[13px] font-normal text-muted-foreground hover:bg-sidebar-row-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring motion-safe:[&>span:last-child]:rail-text-in')}
            />
          ) : (
            <AddProjectMenu
              origin="rail"
              icon={PlusIcon}
              iconClassName="size-[15px]"
              side="right"
              triggerClassName="shrink-0 rounded-[9px] border border-border text-soft-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            />
          )
        ) : null}
      </div>

      <div data-slot="rail-bottom" className={cn('flex shrink-0 flex-col gap-0.5 pt-2', expanded ? 'items-stretch' : 'items-center')}>
        {roomToExpand ? (
          // Hidden, not disabled, while the window cannot fit the expanded rail: a toggle that
          // does nothing would be a lie. The stored choice waits for the window to widen.
          <button
            type="button"
            data-slot="rail-expand-toggle"
            aria-expanded={expanded}
            aria-controls={railId}
            aria-label={expanded ? 'Collapse projects' : 'Expand projects'}
            title={expanded ? undefined : 'Expand projects'}
            onClick={toggle}
            className={cn('group', bottomItemClass(expanded))}
          >
            {expanded ? <PanelLeftCloseIcon className="size-4 shrink-0" aria-hidden="true" /> : <PanelLeftOpenIcon className="size-4 shrink-0" aria-hidden="true" />}
            {expanded ? <span className={BOTTOM_LABEL}>Collapse</span> : null}
          </button>
        ) : null}
        {!singleProject ? (
          <RailLink to="/tasks" label="All projects" slot="rail-all-projects" active={allProjectsActive} expanded={expanded}>
            <LayersIcon className="size-4 shrink-0" aria-hidden="true" />
          </RailLink>
        ) : null}
        <RailLink to="/settings/global/appearance" label="Global settings" slot="rail-global-settings" active={settingsActive} expanded={expanded}>
          <Settings2Icon className="size-4 shrink-0" aria-hidden="true" />
        </RailLink>
        <ThemeToggle
          showLabel={expanded}
          labelClassName={BOTTOM_LABEL}
          className={cn('group', bottomItemClass(expanded), '[&_svg]:size-4')}
        />
      </div>
    </nav>
  )
}
