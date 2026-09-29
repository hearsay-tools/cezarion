import * as React from 'react'
import { Link as RouterLink, useLocation } from 'react-router'

import { useQueryClient } from '@tanstack/react-query'

import { useHealth, useProjects, useRunsIndex, workspaceQueryKeys } from '@/api/queries'
import type { ProjectListEntry } from '@open-mercato/cezar-api-client'
import { AddProjectMenu } from '@/components/app-shell'
import { LayersIcon, PlusIcon, Settings2Icon } from '@/components/design-icons'
import { FOOTER_ICON_ACTIVE_CLASS } from '@/components/nav-row-styles'
import { useTheme } from '@/components/theme-provider'
import { ThemeToggle } from '@/components/theme-toggle'
import { pathnameProjectId, scopeTo } from '@/lib/project-router'
import { useIsDesktop } from '@/lib/use-desktop'
import { projectInitials, projectSignalLabel, signalsByProject, type ProjectSignal } from '@/lib/project-signal'
import { cn } from '@/lib/utils'

/**
 * The project rail (#618): a 60px, workspace-level column left of the desktop sidebar. Every
 * registered project gets a mark, and every mark carries two pills — top "for you" (amber needs
 * you, red failed), bottom "in motion and new" (violet working, green finished). The sidebar next
 * to it stays project-level. Mobile is untouched here (slice 4), so the whole column is `md`-up.
 *
 * Presentational: it takes the registry rows and the four counts per project. `ProjectRailContainer`
 * wires the live data. The counts come from `lib/project-signal.ts`; nothing here decides what a
 * run means.
 */

type SegmentTone = 'amber' | 'red' | 'violet' | 'green'

/** Fill and ink per segment. The inks are tokens (`--signal-ink*`) because the light theme flips
 *  them: dark ink on amber only, white on the darker red, violet and green. */
const SEGMENT_CLASS: Record<SegmentTone, string> = {
  amber: 'bg-pending text-signal-ink-amber',
  red: 'bg-danger text-signal-ink',
  violet: 'bg-status-running text-signal-ink',
  green: 'bg-success text-signal-ink',
}

/** Segment width in fixed px: 18 alone, 14 each when split, and `9+` widens to 22. */
function segmentWidth(count: number, segments: number): number {
  if (count > 9) return 22
  return segments === 1 ? 18 : 14
}

/**
 * One pill. Same form top and bottom; only the position and the segment order differ. A 2px
 * border in the rail's own colour reads as a cut-out where it overhangs the mark. Decorative:
 * the mark's accessible name already spells the counts out in words.
 */
function SignalPill({
  position,
  segments,
}: {
  position: 'top' | 'bottom'
  segments: readonly { tone: SegmentTone; count: number }[]
}) {
  const shown = segments.filter((segment) => segment.count > 0)
  if (shown.length === 0) return null
  return (
    <span
      aria-hidden="true"
      data-slot={`rail-pill-${position}`}
      // `right: -4px` puts the pill's right edge 4px past the mark's; `y = -6px` at the top and
      // `markHeight - 11px` (25px) at the bottom. `pointer-events-none`: the pill sits over the
      // mark's link and must not eat its click.
      className={cn(
        'pointer-events-none absolute -right-[4px] box-border flex h-[17px] overflow-hidden rounded-[9px] border-2 border-background',
        position === 'top' ? '-top-[6px]' : 'top-[25px]',
      )}
    >
      {shown.map(({ tone, count }) => (
        <span
          key={tone}
          data-segment={tone}
          data-count={count}
          style={{ width: segmentWidth(count, shown.length) }}
          className={cn('flex items-center justify-center text-[10px] leading-[13px] font-bold tabular-nums', SEGMENT_CLASS[tone])}
        >
          {count > 9 ? '9+' : count}
        </span>
      ))}
    </span>
  )
}

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
        <SignalPill
          position="top"
          segments={[
            { tone: 'amber', count: signal?.needsYou ?? 0 },
            { tone: 'red', count: signal?.failedUnread ?? 0 },
          ]}
        />
        <SignalPill
          position="bottom"
          segments={[
            { tone: 'violet', count: signal?.inMotion ?? 0 },
            { tone: 'green', count: signal?.finishedUnread ?? 0 },
          ]}
        />
      </div>
    </div>
  )
}

/** A 36px icon target in the bottom group. Active is the footer icons' selected fill (#617 01c). */
function RailIconLink({
  to,
  label,
  slot,
  active,
  children,
}: {
  to: string
  label: string
  slot: string
  active: boolean
  children: React.ReactNode
}) {
  return (
    <RouterLink
      to={to}
      data-slot={slot}
      aria-label={label}
      title={label}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'flex size-9 shrink-0 items-center justify-center rounded-[9px] text-soft-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
        active && FOOTER_ICON_ACTIVE_CLASS,
      )}
    >
      {children}
    </RouterLink>
  )
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
  // The URL's own scope. Global routes (`/settings/global`, `/tasks`) carry none, so no mark is
  // current there — the bottom group's icon is.
  const currentProjectId = pathnameProjectId(pathname)
  const allProjectsActive = pathname === '/tasks'
  const settingsActive = pathname === '/settings/global' || pathname.startsWith('/settings/global/')
  const appLabel = version ? `Cezarion v${version}` : 'Cezarion'

  return (
    <nav
      aria-label="Projects"
      data-slot="project-rail"
      // Outside the resizable sidebar width, and desktop only: below `md` the drawer is the nav.
      className="hidden w-[60px] shrink-0 flex-col items-center border-r border-border bg-background pt-3 pb-3.5 md:flex"
    >
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

      {/* The only part that scrolls, so the app mark and the bottom group stay pinned. */}
      <div
        data-slot="rail-projects"
        className="flex min-h-0 w-full flex-1 flex-col items-center gap-0.5 overflow-y-auto overscroll-contain [scrollbar-width:none]"
      >
        {projects.map((project) => (
          <ProjectMark
            key={project.id}
            project={project}
            signal={signals?.get(project.id)}
            known={signals !== null}
            truncated={truncated.has(project.id)}
            current={project.id === currentProjectId}
            onSelectProject={onSelectProject}
          />
        ))}
        {!singleProject ? (
          <AddProjectMenu
            origin="rail"
            icon={PlusIcon}
            iconClassName="size-[15px]"
            side="right"
            triggerClassName="shrink-0 rounded-[9px] border border-border text-soft-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          />
        ) : null}
      </div>

      <div data-slot="rail-bottom" className="flex shrink-0 flex-col items-center gap-0.5 pt-2">
        {!singleProject ? (
          <RailIconLink to="/tasks" label="All projects" slot="rail-all-projects" active={allProjectsActive}>
            <LayersIcon className="size-4" aria-hidden="true" />
          </RailIconLink>
        ) : null}
        <RailIconLink to="/settings/global" label="Global settings" slot="rail-global-settings" active={settingsActive}>
          <Settings2Icon className="size-4" aria-hidden="true" />
        </RailIconLink>
        <ThemeToggle className="size-9 rounded-[9px] text-soft-foreground hover:bg-muted hover:text-foreground" />
      </div>
    </nav>
  )
}

/**
 * The rail, wired to live data. Every mark reads the SSE-patched workspace runs index — the
 * current project's too — so they all read one source. No WebSocket topic: remote mode opens no
 * browser WebSocket, and a WS-driven rail would go stale in hosted cockpits.
 */
export function ProjectRailContainer({ version, onSelectProject }: {
  version: string | null
  onSelectProject?: (projectId: string) => void
}) {
  const queryClient = useQueryClient()
  const projects = useProjects().data?.projects
  // The rail exists from `md` up, so below it nothing should keep the index observed: run events
  // invalidate it, and a phone would re-read up to 200 runs per project for a column it never
  // paints. Disabled, it fetches nothing; widening the window enables it and fetches then.
  const desktop = useIsDesktop()
  const index = useRunsIndex(desktop).data
  const singleProject = useHealth().data?.capabilities.singleProject === true
  const signals = React.useMemo(() => (index ? signalsByProject(index.runs) : null), [index])
  const truncated = React.useMemo(() => new Set(index?.truncated ?? []), [index?.truncated])

  // The index is refreshed by run events and reconnects, and none of those fire when the registry
  // changes. A project registered (or cloned, or removed) with runs already on disk would show no
  // signal until the next run event, so a change in WHICH projects exist asks for a fresh index.
  // Keyed on the id set so a rename or a `lastOpenedAt` bump does not refetch.
  const registry = projects?.map((project) => project.id).join('\n')
  const seenRegistry = React.useRef<string | undefined>(undefined)
  React.useEffect(() => {
    if (registry === undefined) return
    // The first sighting is the index's own initial fetch; only a later change needs a refresh.
    if (seenRegistry.current !== undefined && seenRegistry.current !== registry) {
      void queryClient.invalidateQueries({ queryKey: workspaceQueryKeys.runsIndex })
    }
    seenRegistry.current = registry
  }, [queryClient, registry])

  if (!projects) return null
  return <ProjectRail projects={projects} signals={signals} truncated={truncated} version={version} singleProject={singleProject} onSelectProject={onSelectProject} />
}
