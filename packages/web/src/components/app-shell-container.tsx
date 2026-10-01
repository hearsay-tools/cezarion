import { useRef, type ReactNode } from 'react'
import { useLocation } from 'react-router'

import { useHealth, useProjectRuns, useProjects, useSkillsUpdate, useTodos } from '@/api/queries'
import type { HealthResponse, SkillsUpdateState } from '@open-mercato/cezar-api-client'
import { AppShell, type RepoChip } from '@/components/app-shell'
import { useApplicationUpdate } from '@/components/use-application-update'
import { CommandPalette } from '@/components/command-palette'
import { ListViewProvider } from '@/components/list-view'
import { ProviderBannerContainer } from '@/components/provider-banner-container'
import { SidebarProjectHeader } from '@/components/sidebar-project-header'
import { ProjectRail } from '@/components/project-rail'
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
import { pageTitleContext } from '@/routes'

/**
 * Derive the sidebar's repo chip from `/api/health`.
 *
 * Null — the chip renders nothing — whenever there is nothing true to say: health hasn't
 * answered yet, or cezar is running outside a git repository (`repo: null`), which is a
 * supported way to run it. An empty chip is honest; "loading…" or a guessed folder name is not.
 *
 * The name is the repo root's basename: `/home/me/Projects/cezar` → `cezar`. Both separators,
 * because the server sends whatever path git gave it, and a trailing one is stripped first so
 * `/repo/` doesn't chip as an empty string.
 */
export function repoChipOf(health: HealthResponse | undefined): RepoChip | null {
  const repo = health?.repo
  if (!repo) return null
  const name = repo.root.replace(/[\\/]+$/, '').split(/[\\/]/).pop()
  if (!name) return null
  return { name, branch: repo.branch }
}

/** Only a checked, still-actionable result earns chrome. An update failure may retain a proven
 * available scope, so keep that signal; all unknown/transient/degraded states stay quiet. */
export function skillsUpdateMarkerOf(state: SkillsUpdateState | undefined): boolean {
  return state?.available === true && (state.status === 'available' || state.status === 'error')
}

/**
 * The app shell, wired to live data.
 *
 * AppShell stays presentational. This container reads health for repo/version/update state,
 * owns the mutation hook, and reads todos for the inbox badge.
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
  const applicationUpdate = useApplicationUpdate(shellHealth)
  // The global inbox is opt-in (#471). With the capability off there is no Inbox nav item to
  // badge and the endpoint can only answer [], so the query parks rather than polls.
  const inboxAvailable = health.data?.capabilities.followups === true
  // GitHub automations are opt-in too (#801) — same honesty rule: without the server's word for
  // it the nav must not offer a tab whose every request would 409.
  const automationsAvailable = health.data?.capabilities.automations === true
  const todos = useTodos(inboxAvailable)
  // One query in the shell feeds every rendering of the active project's navigation (desktop,
  // mobile drawer, and grouped sidebar). Routes reuse this TanStack Query cache entry.
  const skillsUpdate = useSkillsUpdate(projectId ?? '', projectId !== null)
  const skillsUpdateAvailable = skillsUpdateMarkerOf(skillsUpdate.data)
  // Unread done items (#unread-done-items) for the Tasks badge. Reads the same active-scope run
  // list the sidebar quick-list and Tasks table already hold — one cache entry, no extra fetch.
  const registry = useProjects().data
  // The registry and every project's counts, read once: the rail (md+) and the phone's menu button
  // and drawer paint from this one result.
  const workspace = useWorkspaceSignals()
  const projectSwitch = useProjectSwitch()
  const titleContext = pageTitleContext(pathname)
  const bootProjectId = registry?.bootProject ?? health.data?.bootProject ?? null
  const sidebarProjectId = projectId ?? bootProjectId ?? 'default'
  const sidebarBoot = sidebarProjectId === bootProjectId
  const runs = useProjectRuns(sidebarProjectId, true, sidebarBoot)
  const isBootProject = projectId !== null && projectId === bootProjectId
  const activeProject = registry?.projects.find((project) => project.id === projectId)
  const titleRuns = useProjectRuns(
    projectId ?? '',
    // Wait for the registry to identify the project before choosing the boot/non-boot cache
    // key. Health can arrive first; fetching then would briefly populate a project-scoped key
    // for the boot project before switching to the authoritative `default` key.
    activeProject !== undefined && titleContext.taskId !== null,
    registry?.bootProject === projectId,
  ).data

  // Global settings intentionally has no selected project. Everywhere else the URL id selects
  // the authoritative registry entry; health may name only the CONFIRMED boot project while
  // the registry is unavailable, never a non-boot project whose root health does not describe.
  const globalSettings = pathname === '/tools' || pathname === '/settings/global' || pathname.startsWith('/settings/global/')
  const projectName = globalSettings
    ? null
    : (activeProject?.name ??
      (isBootProject ? (repoChipOf(health.data)?.name ?? null) : null))
  const titleRun = titleContext.taskId
    ? titleRuns?.find((run) => run.id === titleContext.taskId)
    : undefined
  const pageLabel = titleRun ? runTitle(titleRun) : titleContext.pageLabel

  useDocumentTitle({ projectName, pageLabel })

  const forgeAvailable = activeProject ? activeProject.forge === 'github' : health.data?.forge?.available === true
  const flatPathname = stripProjectPrefix(pathname)
  // Views that have their own sidebar list; everything else keeps the task list.
  const viewSidebar = /^\/settings(?:\/|$)/.test(flatPathname) ? (
    <SettingsSidebar
      projectId={sidebarProjectId}
      projectName={registry?.projects.find((project) => project.id === sidebarProjectId)?.name ?? (sidebarBoot ? repoChipOf(health.data)?.name ?? null : null)}
      capabilities={health.data?.capabilities}
    />
  ) : /^\/github(?:\/|$)/.test(flatPathname) && forgeAvailable ? (
    // Explicit scope, not `queryScope()`: this subtree sits above the ProjectScopeProvider.
    <GithubSidebar scope={sidebarBoot ? 'default' : sidebarProjectId} />
  ) : /^\/git(?:\/|$)/.test(flatPathname) ? (
    <GitSidebar scope={sidebarBoot ? 'default' : sidebarProjectId} />
  ) : undefined

  return (
    // The sidebar's Active/Archived filter. The Tasks table owns a separate copy and is not a
    // consumer.
    <ListViewProvider>
      <AppShell
        repo={pathname === '/tools' ? repoChipOf(health.data) : globalSettings ? null : activeProject ? { name: activeProject.name, branch: activeProject.id === bootProjectId ? health.data?.repo?.branch ?? '' : '' } : repoChipOf(health.data)}
        breadcrumb={{ project: pathname === '/tools' ? 'Workspace' : projectName, page: titleRun ? `Tasks / ${pageLabel}` : pageLabel ?? 'Cezarion', branch: titleRun?.worktreePath ? 'Isolated worktree' : undefined }}
        version={shellHealth?.version ?? null}
        latestVersion={shellHealth?.latestVersion ?? null}
        applicationUpdate={shellHealth?.applicationUpdate}
        onApplyUpdate={applicationUpdate.apply}
        onRestart={applicationUpdate.restart}
        applicationUpdateError={applicationUpdate.error}
        applicationUpdateBusy={applicationUpdate.busy}
        applicationUpdateOffline={applicationUpdate.offline || health.isError}
        // `?? null` rather than `?? 0`: no badge while the inbox is unknown, and no badge when it
        // is known to be empty — AppShell renders neither for a falsy count.
        inboxCount={todos.data?.length ?? null}
        skillsUpdateAvailable={skillsUpdateAvailable}
        // Hidden until health confirms the forge driver (R6 Step 1.1) — same honesty rule as
        // the chips: the nav must not claim a GitHub tab it cannot back. The Tools menu's
        // forge note says why it is absent.
        forgeAvailable={forgeAvailable}
        // Hidden unless health reports the opt-in inbox (#471) — same honesty rule as above:
        // the nav must not offer an Inbox this server will never fill.
        inboxAvailable={inboxAvailable}
        // Hidden unless health reports the opt-in automations capability (#801).
        automationsAvailable={automationsAvailable}
        banner={<ProviderBannerContainer />}
        sidebarList={viewSidebar}
        taskQuickList={<TaskQuickListContainer projectId={sidebarProjectId} boot={sidebarBoot} />}
        sidebarProjectId={sidebarProjectId}
        projectHeader={<SidebarProjectHeader />}
        mobileProjects={workspace}
        needsYou={listCounts(runs.data ?? []).waiting > 0}
        toolsMenu={<ToolsMenu health={health.data} />}
        toolsStatus={health.data ? { blocked: toolsBlocker(health.data) !== null, note: forgeNote(health.data) } : null}
        projectRail={workspace ? <ProjectRail {...workspace} projectTarget={projectSwitch.target} onSwitchProject={(id) => void projectSwitch.go(id)} version={shellHealth?.version ?? null} /> : null}
      >
        {children}
      </AppShell>
      {/* Global chrome, not a route: ⌘K must work on every URL. Mounted here (not in AppShell)
          because it needs the query client and router this container already assumes. */}
      <CommandPalette />
    </ListViewProvider>
  )
}
