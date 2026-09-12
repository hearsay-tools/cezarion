import { ChevronDownIcon, FolderIcon, FolderOpenIcon } from '@/components/design-icons'

import * as React from 'react'
import { useLocation } from 'react-router'

import { useHealth, usePinRun, useProjectRuns } from '@/api/queries'
import type { ProjectListEntry } from '@open-mercato/cezar-api-client'
import { useSidebarNavigate } from '@/components/app-shell'
import { useListView } from '@/components/list-view'
import { activeNavPath, visibleNavItems } from '@/components/nav-items'
import { ReferenceStatusProvider } from '@/components/reference-status'
import { QuickListBuckets } from '@/components/task-quick-list'
import { Link, pathnameProjectId, scopeTo, stripProjectPrefix, useProjectMatch } from '@/lib/project-router'
import { isProjectCollapsed, readStoredCollapsed, writeStoredCollapsed } from '@/lib/sidebar-collapse'
import { capBuckets, groupRuns, listCounts, type ListView } from '@/lib/task-groups'
import { taskReferences } from '@/lib/tasks-table'
import { usageMetricVisibility } from '@/lib/token-metrics'
import { useNow } from '@/lib/use-now'
import { cn } from '@/lib/utils'

/**
 * The multi-project sidebar (multi-project spec, "Sidebar"): one collapsible group per
 * registered project, each carrying its own nav and its own task quick-list.
 *
 * Mounted by `AppShellContainer` only when the registry holds MORE THAN ONE project — the
 * degenerate single-project workspace keeps the flat sidebar it has always had (`AppShell`
 * falls back to it whenever the `projectGroups` slot is absent). That is not a special case
 * bolted on: with one project the group header would only repeat the repo chip, and every nav
 * row would gain a level of indentation to distinguish it from nothing.
 */

/** The spec's "10 most recent tasks", counted ACROSS buckets — a collapsed variant tile is one
 *  row, because it occupies one row of sidebar. */
const RECENT_LIMIT = 10

/**
 * Read + write of the per-project collapse map (`lib/sidebar-collapse.ts`), which lives in
 * localStorage rather than `~/.cezar/ui-state.json`.
 *
 * Seeded once from storage at mount, so the first paint already carries the user's answer — no
 * request to wait for, and no flash of the active-project default. React state is the live copy
 * and every toggle mirrors the new map straight to storage, which is synchronous, so a reload
 * immediately after a click still finds it. There is no debounce, no optimistic-then-reconcile
 * dance and no failure toast left, because there is no server round trip left to fail.
 */
function useSidebarCollapse(activeProjectId: string | null) {
  const [collapsed, setCollapsed] = React.useState(readStoredCollapsed)
  // The map as of the last toggle, updated synchronously: two clicks inside one render pass must
  // compose, and the second must see the first one's entry rather than the batched-away state.
  const latest = React.useRef(collapsed)

  const toggle = React.useCallback(
    (projectId: string) => {
      const next = {
        ...latest.current,
        [projectId]: !isProjectCollapsed(latest.current, projectId, activeProjectId),
      }
      latest.current = next
      writeStoredCollapsed(next)
      setCollapsed(next)
    },
    [activeProjectId],
  )

  return { collapsed, toggle }
}

export function ProjectGroups({
  projects,
  bootProjectId,
  inboxAvailable = false,
  automationsAvailable = false,
  inboxCount = null,
  skillsUpdateAvailable = false,
}: {
  projects: ProjectListEntry[]
  /** The project a flat, unprefixed URL resolves to — so the boot project is the one that
   *  auto-expands before the user has navigated into any `/p/<id>` scope. */
  bootProjectId: string
  inboxAvailable?: boolean
  /** `capabilities.automations` (#801) — workspace-wide, unlike the per-project forge gate:
   *  the opt-in is one env var on the one server that serves every group. */
  automationsAvailable?: boolean
  inboxCount?: number | null
  skillsUpdateAvailable?: boolean
}) {
  const { pathname } = useLocation()
  // The shell renders outside the routes, so there is no `ProjectScopeProvider` above it — the
  // URL's own prefix is the scope, exactly as `project-router` resolves it for links.
  //
  // `scopedProjectId` is null on the pages that belong to NO project — the global Tasks page and
  // global settings. Nothing may be highlighted there: a `/p/` prefix is the only thing that
  // makes a project the one you are standing in, and painting the boot project as selected while
  // the user reads an all-projects table says the page is about that project when it is not.
  const scopedProjectId = pathnameProjectId(pathname)
  // Collapse defaults are a different question ("which group opens when you have never touched
  // one?") and still want a project, so they keep the boot fallback: landing on a global page
  // must not fold the whole sidebar shut.
  const collapseAnchorId = scopedProjectId ?? bootProjectId
  const { collapsed, toggle } = useSidebarCollapse(collapseAnchorId)

  // One filter for every sidebar group (`ListViewProvider`). Independent of the Tasks table:
  // switching that table to Archived must not hide the live runs these groups still navigate.
  const [view] = useListView()
  const activeTo = activeNavPath(stripProjectPrefix(pathname))
  const runMatch = useProjectMatch('/tasks/:id/*')
  const runExact = useProjectMatch('/tasks/:id')
  const currentRunId = runMatch?.params.id ?? runExact?.params.id ?? null
  const now = useNow(30_000)
  const health = useHealth()
  const metricVisibility = usageMetricVisibility(health.data)

  // Most-recently-opened first, per the spec. Sorted here rather than trusted from the wire so
  // the order is a property of the sidebar, not of whichever route last touched the registry.
  const ordered = React.useMemo(
    () => [...projects].sort((a, b) => b.lastOpenedAt.localeCompare(a.lastOpenedAt)),
    [projects],
  )

  return (
    <div data-slot="project-group-list">
      {ordered.map((project) => (
        <ProjectGroup
          key={project.id}
          project={project}
          boot={project.id === bootProjectId}
          active={project.id === scopedProjectId}
          collapsed={isProjectCollapsed(collapsed, project.id, collapseAnchorId)}
          onToggle={toggle}
          view={view}
          activeTo={activeTo}
          currentRunId={currentRunId}
          now={now}
          inboxAvailable={inboxAvailable}
          automationsAvailable={automationsAvailable}
          inboxCount={inboxCount}
          skillsUpdateAvailable={skillsUpdateAvailable}
          showTokens={metricVisibility.tokens}
          showCost={metricVisibility.cost}
        />
      ))}
    </div>
  )
}

function ProjectGroup({
  project,
  boot,
  active,
  collapsed,
  onToggle,
  view,
  activeTo,
  currentRunId,
  now,
  inboxAvailable,
  automationsAvailable,
  inboxCount,
  skillsUpdateAvailable,
  showTokens,
  showCost,
}: {
  project: ProjectListEntry
  /** The boot project's runs cache lives under the `'default'` scope key (it mounts
   *  unscoped) — see `useProjectRuns`' `boot` parameter. */
  boot: boolean
  active: boolean
  collapsed: boolean
  onToggle: (projectId: string) => void
  view: ListView
  /** The `to` of the nav item that owns the current URL — applied to the ACTIVE group only. */
  activeTo: string | null
  currentRunId: string | null
  now: number
  inboxAvailable: boolean
  automationsAvailable: boolean
  inboxCount: number | null
  skillsUpdateAvailable: boolean
  showTokens: boolean
  showCost: boolean
}) {
  const missing = project.status === 'missing'
  // Collapsed (or missing) groups never fetch — a 40-project workspace costs one registry
  // request, not 40 run lists. A collapsed group still READS whatever is cached, which is what
  // keeps its attention badge alive after the user shuts it.
  const runs = useProjectRuns(project.id, !collapsed && !missing, boot)
  const onNavigate = useSidebarNavigate()
  // Pinning (#935) from a group that may not be the scoped project: the request is addressed to
  // THIS project, and the cache invalidated is the one `useProjectRuns` above writes — which is
  // `'default'` for the boot project, whose list mounts unscoped.
  const pin = usePinRun(project.id, boot ? 'default' : project.id)

  const waiting = runs.data ? listCounts(runs.data).waiting : 0
  const buckets = runs.data ? capBuckets(groupRuns(runs.data, view), RECENT_LIMIT) : []
  // Only the rows this group actually paints: `buckets` is the capped list, so a project with
  // four hundred runs asks about the handful on screen rather than all of them.
  //
  // Deliberately NOT memoized: `buckets` is rebuilt with a fresh identity on every render, so a
  // `useMemo` keyed on it would recompute every time anyway while claiming otherwise. Nothing
  // downstream needs a stable identity — `ReferenceStatusProvider` and `useReferenceStatuses` both
  // key off the CONTENT of this list.
  const referenceRequests = buckets.flatMap((bucket) =>
    bucket.rows.flatMap((row) => {
      // A collapsed variant group paints its FIRST member's chip, so that is the one to ask
      // about — the others only become visible once the tile is expanded.
      return taskReferences(row.kind === 'run' ? row.run : row.members[0]!).map(reference => ({ projectId: project.id, kind: reference.kind, number: reference.number }))
    }),
  )

  // A missing project's panes all 409 (spec, "Registered project folder deleted/moved"), so
  // there is nothing behind the chevron — the row renders greyed and inert rather than
  // pretending to expand into a nav whose every link is a dead end. Unregistering lives in
  // Global settings → Projects; the row says so instead of growing its own destructive button.
  if (missing) {
    return (
      <div data-slot="project-group" data-project={project.id} data-status="missing" className="mb-3">
        <div
          data-slot="project-group-header"
          title={`${project.root} is gone — remove it in Global settings → Projects`}
          className="flex h-11 w-full items-center gap-[7px] rounded-lg px-2 text-[13px] font-semibold opacity-55 md:h-[34px]"
        >
          <span className="w-3 shrink-0" aria-hidden="true" />
          <span className="truncate">{project.name}</span>
          <span
            data-slot="project-missing"
            className="ml-auto shrink-0 rounded-full bg-danger/15 px-[7px] py-px text-[10px] font-medium text-danger"
          >
            folder not found
          </span>
        </div>
      </div>
    )
  }

  const bodyId = `project-group-${project.id}`

  return (
    <div
      data-slot="project-group"
      data-project={project.id}
      data-status={project.status}
      data-collapsed={collapsed ? '' : undefined}
      // "This is the project the URL names." Absent on the global pages, which name none — see
      // `scopedProjectId` above. An attribute rather than only a class because the highlight is
      // a fact about the group, and a `hover:bg-muted` in the class list makes the class an
      // unreliable way to ask.
      data-active={active ? '' : undefined}
      className="mb-3"
    >
      <div className="relative flex min-h-10 w-full items-center gap-2 rounded-md bg-muted px-2 py-2 text-left text-[13px] font-semibold">
        <button type="button" onClick={() => onToggle(project.id)} aria-expanded={!collapsed} aria-controls={bodyId}
          aria-label={`Toggle ${project.name}`} data-slot="project-group-header" className="absolute inset-0 rounded-md hover:bg-muted/80" />
        {collapsed ? <FolderIcon className="pointer-events-none relative size-[18px] shrink-0 text-muted-foreground" aria-hidden="true" /> : <FolderOpenIcon className="pointer-events-none relative size-[18px] shrink-0 text-muted-foreground" aria-hidden="true" />}
        <Link to={scopeTo(project.id, '/')} onClick={() => { onNavigate?.(); if (collapsed) onToggle(project.id) }} className="pointer-events-auto relative min-w-0 flex-1 truncate" aria-label={`Open ${project.name}`}>{project.name}</Link>
        {project.branch ? <span data-slot="project-branch" className="pointer-events-none relative max-w-[40%] shrink-0 truncate font-['IBM_Plex_Mono'] text-[10px] leading-[14px] font-normal text-soft-foreground">{project.branch}</span> : null}
        {waiting ? (
          <span
            data-slot="project-attention"
            title={`${waiting} task${waiting === 1 ? '' : 's'} need${waiting === 1 ? 's' : ''} you`}
            className="pointer-events-none relative shrink-0 rounded-full bg-pending/15 px-1.5 py-0.5 text-[10px] font-medium text-pending-strong"
          >
            {waiting}
          </span>
        ) : null}
        <ChevronDownIcon className={cn('pointer-events-none relative size-4 shrink-0 text-muted-foreground transition-transform', collapsed && '-rotate-90')} aria-hidden="true" />
      </div>

      {collapsed ? null : (
        <div
          id={bodyId}
          data-slot="project-group-body"
          // The project navigation aligns with the group heading; only owned workers get an
          // indented relationship rail, inside QuickListBuckets (design.pen frames 17).
          className="mt-1"
        >
          <nav aria-label={`${project.name} navigation`} className="flex flex-col gap-0.5">
            {/* Forge-gated per PROJECT (#698): the entry's own remote decides whether THIS
                group offers a GitHub tab — the boot folder's health-level forge answer says
                nothing about the other projects in the workspace. Whether `gh` itself works
                still surfaces inside the tab as its availability hint. */}
            {visibleNavItems({
              forge: project.forge === 'github',
              inbox: inboxAvailable,
              automations: automationsAvailable,
            }).map((item) => {
              // Only the active group can own the current URL: the flat route map is
              // project-agnostic, so `/git` lights Git in exactly one project — the scoped one.
              const isActive = active && item.to === activeTo
              const Icon = item.icon
              // Explicitly scoped (`/p/<id>/…`) rather than left to the wrapper's active-project
              // prefix: a group's whole point is linking into a project that is NOT active.
              return (
                <Link
                  key={item.to}
                  to={scopeTo(project.id, item.to)}
                  onClick={onNavigate}
                  aria-current={isActive ? 'page' : undefined}
                  className={cn(
                    'selection-row focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-link-foreground flex h-11 w-full items-center gap-2.5 rounded-md px-2.5 text-xs md:text-[11px] font-normal text-muted-foreground transition-colors hover:bg-muted hover:text-foreground md:h-[30px]',
                    isActive && 'bg-[var(--task-brand-selected)] text-accent-text',
                  )}
                >
                  <Icon className="size-[15px] shrink-0 text-soft-foreground" aria-hidden="true" />
                  {item.label}
                  {/* `/api/todos` is fetched for the active scope only, so only the active
                      group has a real count to show — a badge on the others would be the active
                      project's number wearing someone else's name. */}
                  {item.badge === 'inbox-count' && active && inboxCount ? (
                    <span
                      data-slot="nav-badge"
                      className="ml-auto rounded-full bg-accent-strong px-1.5 py-px text-[10.5px] font-semibold text-accent-strong-foreground"
                    >
                      {inboxCount}
                    </span>
                  ) : null}
                  {item.badge === 'skills-update' && active && skillsUpdateAvailable ? (
                    <span data-slot="nav-update-marker" className="ml-auto flex items-center">
                      <span className="size-1.5 rounded-full bg-accent-strong" aria-hidden="true" />
                      <span className="sr-only">Skills update available</span>
                    </span>
                  ) : null}
                </Link>
              )
            })}
          </nav>

          {/* This group's own project, explicitly: a collapsed sidebar can show six projects at
              once, and #42 means a different pull request in each of them. */}
          <ReferenceStatusProvider projectId={project.id} requests={referenceRequests}>
            <QuickListBuckets
              buckets={buckets}
              currentRunId={active ? currentRunId : null}
              now={now}
              scope={project.id}
              showTokens={showTokens}
              showCost={showCost}
              onTogglePin={
                // Withheld in the archived view, where the pin has nowhere to show its result —
                // the same call `TaskQuickList` and the thread header make.
                view === 'archived'
                  ? undefined
                  : (run, pinned) =>
                      pin.mutate({ id: run.id, pinned })
              }
            />
          </ReferenceStatusProvider>

          {/* Always present, not only past the cap: it is this group's door into the project's
              tasks pane (`/p/<id>/`), which is worth an affordance even with two tasks listed. */}
          <Link
            to={scopeTo(project.id, '/')}
            onClick={onNavigate}
            data-slot="project-group-more"
            className="flex min-h-9 items-center rounded-md px-3 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
          >
            More…
          </Link>
        </div>
      )}
    </div>
  )
}
