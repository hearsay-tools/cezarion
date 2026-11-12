import { productName } from '@/lib/product-name'
import { projectAddress } from '@/api/run-address'
import { useRef, type ReactNode } from 'react'
import { useLocation } from 'react-router'

import { useHealth, useProjectRuns, useProjects } from '@/api/queries'
import type { HealthResponse, ProjectListEntry, ProjectsResponse, RunSummary } from '@open-mercato/cezar-api-client'
import { AppShell } from '@/components/app-shell'
import { CommandPalette } from '@/components/command-palette'
import { ListViewProvider } from '@/components/list-view'
import { ProviderBannerContainer } from '@/components/provider-banner-container'
import { HomeRecoveryBanner } from '@/components/home-recovery-banner'
import { SidebarProjectHeader } from '@/components/sidebar-project-header'
import { ProjectRail, ProjectRailPlaceholder } from '@/components/project-rail'
import { useProjectSwitch } from '@/components/use-project-switch'
import { useWorkspaceSignals } from '@/components/use-workspace-signals'
import { TaskQuickListContainer } from '@/components/task-quick-list'
import { ToolsMenu, forgeNote, toolsBlocker } from '@/components/tools-menu'
import { useDocumentTitle } from '@/lib/use-document-title'
import { GitSidebar } from '@/routes/repo-git/git-sidebar'
import { GithubSidebar } from '@/routes/github/github-sidebar'
import { SettingsSidebar } from '@/routes/settings/settings-sidebar'
import { useActiveProjectId, stripProjectPrefix } from '@/lib/project-router'
import { listCounts, runTitle } from '@/lib/task-groups'
import { pageTitleContext, type PageTitleContext } from '@/lib/page-title'
import { repoChipOf, type RepoChip } from '@/lib/repo-chip'

// Moved to `lib/repo-chip`; kept importable from here.
export { repoChipOf } from '@/lib/repo-chip'

/** Boot project, sidebar scope and the URL's registry row — the identity the rest of the shell
 *  reads, including the `default` alias when neither the URL nor health/registry has named a
 *  project yet. */
function shellProjectScope(
  projectId: string | null,
  registry: ProjectsResponse | undefined,
  health: HealthResponse | undefined,
) {
  const bootProjectId = registry?.bootProject ?? health?.bootProject ?? null
  const sidebarProjectId = projectId ?? bootProjectId ?? 'default'
  const sidebarBoot = sidebarProjectId === bootProjectId
  const isBootProject = projectId !== null && projectId === bootProjectId
  const activeProject = registry?.projects.find((project) => project.id === projectId)
  return { bootProjectId, sidebarProjectId, sidebarBoot, isBootProject, activeProject }
}

/** Global settings intentionally has no selected project. Everywhere else the URL id selects
 *  the authoritative registry entry; health may name only the CONFIRMED boot project while
 *  the registry is unavailable, never a non-boot project whose root health does not describe. */
function shellTitleParts(
  pathname: string,
  activeProject: ProjectListEntry | undefined,
  isBootProject: boolean,
  health: HealthResponse | undefined,
  titleContext: PageTitleContext,
  titleRuns: RunSummary[] | undefined,
) {
  const globalSettings = pathname === '/tools' || pathname === '/settings/global' || pathname.startsWith('/settings/global/')
  const projectName = globalSettings
    ? null
    : (activeProject?.name ??
      (isBootProject ? (repoChipOf(health)?.name ?? null) : null))
  const titleRun = titleContext.taskId
    ? titleRuns?.find((run) => run.id === titleContext.taskId)
    : undefined
  const pageLabel = titleRun ? runTitle(titleRun) : titleContext.pageLabel
  return { globalSettings, projectName, titleRun, pageLabel }
}

function shellForgeAvailable(
  activeProject: ProjectListEntry | undefined,
  health: HealthResponse | undefined,
): boolean {
  return activeProject ? activeProject.forge === 'github' : health?.forge?.available === true
}

/** Views that have their own sidebar list; everything else keeps the task list. */
function shellViewSidebar(
  flatPathname: string,
  forgeAvailable: boolean,
  sidebarProjectId: string,
  sidebarBoot: boolean,
  registry: ProjectsResponse | undefined,
  health: HealthResponse | undefined,
): ReactNode {
  return /^\/settings(?:\/|$)/.test(flatPathname) ? (
    <SettingsSidebar
      projectId={sidebarProjectId}
      projectName={registry?.projects.find((project) => project.id === sidebarProjectId)?.name ?? (sidebarBoot ? repoChipOf(health)?.name ?? null : null)}
      capabilities={health?.capabilities}
    />
  ) : /^\/github(?:\/|$)/.test(flatPathname) && forgeAvailable ? (
    // Explicit scope, not `queryScope()`: this subtree sits above the ProjectScopeProvider.
    <GithubSidebar scope={projectAddress({ projectId: sidebarProjectId, boot: sidebarBoot }).cacheScope} />
  ) : /^\/git(?:\/|$)/.test(flatPathname) ? (
    <GitSidebar scope={projectAddress({ projectId: sidebarProjectId, boot: sidebarBoot }).cacheScope} />
  ) : undefined
}

function shellRepoChip(
  pathname: string,
  globalSettings: boolean,
  activeProject: ProjectListEntry | undefined,
  bootProjectId: string | null,
  health: HealthResponse | undefined,
): RepoChip | null {
  return pathname === '/tools' ? repoChipOf(health) : globalSettings ? null : activeProject ? { name: activeProject.name, branch: activeProject.id === bootProjectId ? health?.repo?.branch ?? '' : '' } : repoChipOf(health)
}

function shellBreadcrumb(
  pathname: string,
  projectName: string | null,
  titleRun: RunSummary | undefined,
  pageLabel: string | null,
) {
  return { project: pathname === '/tools' ? 'Workspace' : projectName, page: titleRun ? `Tasks / ${pageLabel}` : pageLabel ?? productName('Cezarion'), branch: titleRun?.worktreePath ? 'Isolated worktree' : undefined }
}

function shellProjectRail(
  workspace: ReturnType<typeof useWorkspaceSignals>,
  projectSwitch: ReturnType<typeof useProjectSwitch>,
  projectsPending: boolean,
  version: string | null,
) {
  return workspace ? <ProjectRail {...workspace} projectTarget={projectSwitch.target} onSwitchProject={(id) => void projectSwitch.go(id)} version={version} /> : projectsPending ? <ProjectRailPlaceholder /> : null
}

/**
 * The app shell, wired to live data.
 *
 * AppShell stays presentational. This container reads health for repo/version/update state,
 * and owns the mutation hook.
 *
 * The last good health payload protects the shell through a failed reconciliation; the root
 * health subscription remains the live source, with reconnect/visibility HTTP reconciliation.
 */
export function AppShellContainer({ children }: { children: ReactNode }) {
  const { pathname } = useLocation()
  const projectId = useActiveProjectId()
  const health = useHealth()
  const lastKnownHealth = useRef<HealthResponse | undefined>(undefined)
  if (health.data) lastKnownHealth.current = health.data
  const shellHealth = health.data ?? lastKnownHealth.current
  // GitHub automations are opt-in too (#801) — same honesty rule: without the server's word for
  // it the nav must not offer a tab whose every request would 409.
  const automationsAvailable = shellHealth?.capabilities.automations === true
  // Unread done items (#unread-done-items) for the Tasks badge. Reads the same active-scope run
  // list the sidebar quick-list and Tasks table already hold — one cache entry, no extra fetch.
  const projectsQuery = useProjects()
  const registry = projectsQuery.data
  // The registry and every project's counts, read once: the rail (md+) and the phone's menu button
  // and drawer paint from this one result.
  const workspace = useWorkspaceSignals()
  const projectSwitch = useProjectSwitch()
  const titleContext = pageTitleContext(pathname)
  const { bootProjectId, sidebarProjectId, sidebarBoot, isBootProject, activeProject } =
    shellProjectScope(projectId, registry, health.data)
  const runs = useProjectRuns(sidebarProjectId, true, sidebarBoot)
  const titleRuns = useProjectRuns(
    projectId ?? '',
    // Wait for the registry to identify the project before choosing the boot/non-boot cache
    // key. Health can arrive first; fetching then would briefly populate a project-scoped key
    // for the boot project before switching to the authoritative `default` key.
    activeProject !== undefined && titleContext.taskId !== null,
    registry?.bootProject === projectId,
  ).data

  const { globalSettings, projectName, titleRun, pageLabel } = shellTitleParts(
    pathname,
    activeProject,
    isBootProject,
    health.data,
    titleContext,
    titleRuns,
  )

  useDocumentTitle({ projectName, pageLabel })

  const forgeAvailable = shellForgeAvailable(activeProject, health.data)
  const flatPathname = stripProjectPrefix(pathname)
  const viewSidebar = shellViewSidebar(
    flatPathname,
    forgeAvailable,
    sidebarProjectId,
    sidebarBoot,
    registry,
    health.data,
  )
  const version = shellHealth?.version ?? null

  return (
    // The sidebar's Active/Automations filter. The Tasks table owns a separate copy and is not a
    // consumer.
    <ListViewProvider>
      <AppShell
        repo={shellRepoChip(pathname, globalSettings, activeProject, bootProjectId, health.data)}
        breadcrumb={shellBreadcrumb(pathname, projectName, titleRun, pageLabel)}
        version={version}
        latestVersion={shellHealth?.latestVersion ?? null}
        // Hidden until health confirms the forge driver (R6 Step 1.1) — same honesty rule as
        // the chips: the nav must not claim a GitHub tab it cannot back. The Tools menu's
        // forge note says why it is absent.
        forgeAvailable={forgeAvailable}
        // Hidden unless health reports the opt-in automations capability (#801).
        automationsAvailable={automationsAvailable}
        banner={<><HomeRecoveryBanner /><ProviderBannerContainer /></>}
        sidebarList={viewSidebar}
        taskQuickList={<TaskQuickListContainer projectId={sidebarProjectId} boot={sidebarBoot} />}
        sidebarProjectId={sidebarProjectId}
        projectHeader={<SidebarProjectHeader />}
        mobileProjects={workspace}
        needsYou={listCounts(runs.data ?? []).waiting > 0}
        toolsMenu={<ToolsMenu health={health.data} />}
        toolsStatus={health.data ? { blocked: toolsBlocker(health.data) !== null, note: forgeNote(health.data) } : null}
        projectRail={shellProjectRail(workspace, projectSwitch, projectsQuery.isPending, version)}
      >
        {children}
      </AppShell>
      {/* Global chrome, not a route: ⌘K must work on every URL. Mounted here (not in AppShell)
          because it needs the query client and router this container already assumes. */}
      <CommandPalette />
    </ListViewProvider>
  )
}
