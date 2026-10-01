import { PanelLeftCloseIcon, PanelLeftOpenIcon } from 'lucide-react'
import * as React from 'react'
import { Link as RouterLink, useLocation } from 'react-router'

import type { ProjectListEntry } from '@open-mercato/cezar-api-client'
import { AddProjectMenu, ShellSidebarWidthContext } from '@/components/app-shell'
import { LayersIcon, PlusIcon, Settings2Icon } from '@/components/design-icons'
import { FOOTER_ICON_ACTIVE_CLASS } from '@/components/nav-row-styles'
import { useTheme } from '@/components/theme-provider'
import { ThemeToggle } from '@/components/theme-toggle'
import { pathnameProjectId, scopeTo } from '@/lib/project-router'
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
 */

/** One project's row: 52px tall so a pill above and below the mark never touches its neighbours. */
function ProjectMark({
  project,
  signal,
  known,
  truncated,
  current,
  onSelectProject,
}: {
  project: ProjectListEntry
  signal: ProjectSignal | undefined
  known: boolean
  truncated: boolean
  current: boolean
  onSelectProject?: (projectId: string) => void
}) {
  const label = projectSignalLabel(project.name, signal, { truncated, unknown: !known })
  return (
    <div data-slot="rail-project" data-project-id={project.id} className="relative flex h-[52px] w-full shrink-0 items-center justify-center">
      {current ? (
        // The current project's bar on the rail's left edge, vertically centred on the mark.
        <span aria-hidden="true" data-slot="rail-current-bar" className="absolute top-1/2 left-0 h-5 w-[3px] -translate-y-1/2 rounded-r-[2px] bg-foreground" />
      ) : null}
      <div className="relative size-9">
        <RouterLink
          to={scopeTo(project.id, '/')}
          onClick={(event) => {
            // New-tab/window gestures must not change the sidebar in this window.
            if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
            onSelectProject?.(project.id)
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
  truncated,
  current,
  onSelectProject,
}: {
  project: ProjectListEntry
  signal: ProjectSignal | undefined
  known: boolean
  truncated: boolean
  current: boolean
  onSelectProject?: (projectId: string) => void
}) {
  // The words are on screen, so no tooltip; the accessible name still spells all four counts.
  const label = projectSignalLabel(project.name, signal, { truncated, unknown: !known })
  const { top, bottom } = signalPillSegments(signal)
  // The pills' ring is the surface under them, so the cut-out follows the row's fill.
  const ring = current ? 'border-sidebar-row-selected' : 'border-background group-hover:border-sidebar-row-hover'
  return (
    <div data-slot="rail-project" data-project-id={project.id} className="w-full shrink-0">
      <RouterLink
        to={scopeTo(project.id, '/')}
        onClick={(event) => {
          if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
          onSelectProject?.(project.id)
        }}
        aria-label={label}
        // The state line has no room for "recent runs only" at 232px, so a capped index says so
        // on hover instead; the counts it shows may miss older runs.
        title={known && truncated ? 'Counts cover recent runs only' : undefined}
        aria-current={current ? 'page' : undefined}
        className={cn(
          'group flex h-[52px] w-full items-center gap-[10px] rounded-[8px] px-[6px] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
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
            truncated={false}
            current={current}
            maxParts={2}
            slot="rail-project-state"
            className="h-4 gap-x-[4px] overflow-hidden text-[11px] leading-4 whitespace-nowrap"
          />
        </span>
      </RouterLink>
    </div>
  )
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

export type ProjectRailProps = {
  /** Registry order. */
  projects: readonly ProjectListEntry[]
  /** Null while the runs index has not loaded: every mark then says its activity is unknown
   *  rather than idle. A loaded index with no entry for a project is a project with no runs. */
  signals: ReadonlyMap<string, ProjectSignal> | null
  /** Ids of the projects whose runs index hit its per-project cap. */
  truncated: ReadonlySet<string>
  version: string | null
  /** `capabilities.singleProject` (`CEZ_SINGLE_PROJECT=1`): the server refuses add, edit, browse
   *  and remove, so Add project and All projects go. Never inferred from the project count. */
  singleProject: boolean
  onSelectProject?: (projectId: string) => void
}

export function ProjectRail({ projects, signals, truncated, version, singleProject, onSelectProject }: ProjectRailProps) {
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
        {projects.map((project) => {
          const rowProps = {
            project,
            signal: signals?.get(project.id),
            known: signals !== null,
            truncated: truncated.has(project.id),
            current: project.id === currentProjectId,
            onSelectProject,
          }
          return expanded ? <ExpandedProjectRow key={project.id} {...rowProps} /> : <ProjectMark key={project.id} {...rowProps} />
        })}
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
