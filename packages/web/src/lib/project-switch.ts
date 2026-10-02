import {
  ApiError,
  getGithubItem,
  getGroup,
  getAutomations,
  getProjectRun,
  getRunCommit,
  getRepoCommit,
  getWorkflows,
} from '@/api/client'
import type { NavigateFunction } from 'react-router'
import type { Capabilities, ProjectsResponse } from '@open-mercato/cezar-api-client'
import { rememberedProjectPage } from '@/lib/last-location'
import { taskItemTabs } from '@/lib/tasks-table'
import { scopeTo } from '@/lib/project-router'
import { matchProjectRoute } from '@/routes'

/** How long a switch waits for an existence answer before restoring the page anyway. */
const CHECK_TIMEOUT_MS = 2_500

export type ProjectSwitchContext = {
  registry: ProjectsResponse | undefined
  capabilities: Capabilities | undefined
  /** The target project's repository base (`useProjectRepoBase`'s answer for it), which decides
   *  which task references are its own. Absent when unknown. */
  repoBaseOf?: (projectId: string) => string | undefined
}

export type ProjectSwitchTarget = {
  /** Where a plain link goes: the remembered page when the router serves it, else the home. */
  href: string
  /** Set when the page names an entity (task, commit, issue …) that may be gone. A click must
   *  `resolveProjectSwitch` first; a new-tab gesture just uses `href`. */
  verify: boolean
}

const homeOf = (projectId: string) => String(scopeTo(projectId, '/'))

/** Synchronous half: storage, ownership and the REAL route table — no network. */
export function projectSwitchTarget(
  projectId: string,
  stored: unknown,
  context: ProjectSwitchContext,
): ProjectSwitchTarget {
  const home = { href: homeOf(projectId), verify: false }
  const page = rememberedProjectPage(projectId, stored, context.registry)
  if (page === null) return home
  try {
    const pathname = page.replace(/[?#].*$/, '')
    decodeURI(pathname) // a malformed percent escape is no page; the router would only warn
    const route = matchProjectRoute(pathname, context.capabilities)
    if (route === null) return home
    return { href: page, verify: Object.keys(route.params).some((name) => name !== 'projectId') }
  } catch {
    // A saved path the router cannot decode (`%`, `%E0%A4%A`). This runs in the rail's render,
    // so a throw here would take the whole shell down on an otherwise valid URL.
    return home
  }
}

/**
 * Does the page's entity exist? `true`/`false` only on an authoritative answer (a 200, a 404, or a
 * list that loaded and lacks the name); `null` for anything else — offline, a forge that is not
 * available, a server error. Absence from the runs INDEX is deliberately not evidence: the index
 * is capped per project and may not have loaded.
 */
async function entityExists(
  projectId: string,
  pathname: string,
  capabilities: Capabilities | undefined,
  signal: AbortSignal,
  repoBase: string | undefined,
): Promise<boolean | null> {
  const opts = { projectId, signal }
  let pattern = ''
  try {
    const route = matchProjectRoute(pathname, capabilities)
    if (route === null) return false
    const { params } = route
    pattern = route.pattern
    if (pattern.startsWith('/tasks/:id')) {
      const run = await getProjectRun(projectId, params.id ?? '', { signal })
      // The run is there; its child entity may not be (a rebased or amended commit, a
      // detached issue/PR number).
      if (pattern === '/tasks/:id/commits/:sha') {
        await getRunCommit(params.id ?? '', params.sha ?? '', opts)
      } else if (pattern === '/tasks/:id/issue/:n' || pattern === '/tasks/:id/pr/:n') {
        const number = Number(params.n)
        if (!Number.isSafeInteger(number) || number < 1) return false
        const kind = pattern.endsWith('/issue/:n') ? 'issue' : 'pr'
        // The route only opens items the TASK references (`taskItemTabs`), judged against the
        // project's repository. Without that identity a detached link cannot be proven.
        const linked = taskItemTabs(run, repoBase).some((tab) => tab.kind === kind && tab.number === number)
        if (!linked) return repoBase === undefined ? null : false
        const item = await getGithubItem(pattern.endsWith('/issue/:n') ? 'issue' : 'pr', number, {}, opts)
        return item.available ? item.item !== null : null
      }
    } else if (pattern === '/compare/:groupId') {
      await getGroup(params.groupId ?? '', opts)
    } else if (pattern === '/git/commits/:sha') {
      await getRepoCommit(params.sha ?? '', opts)
    } else if (pattern === '/github/issues/:n' || pattern.startsWith('/github/prs/:n')) {
      const number = Number(params.n)
      if (!Number.isSafeInteger(number) || number < 1) return false
      const item = await getGithubItem(pattern.startsWith('/github/issues') ? 'issue' : 'pr', number, {}, opts)
      return item.available ? item.item !== null : null
    } else if (pattern === '/workflows/:name') {
      const { workflows, issues } = await getWorkflows(opts)
      if (workflows.some((workflow) => workflow.name === params.name)) return true
      // A file that failed to load (unreadable, unparseable) may be the very workflow in the
      // URL, so an absent name proves nothing while the catalog reports problems.
      return issues.length > 0 ? null : false
    } else if (pattern.startsWith('/automations/:automationId')) {
      const list = await getAutomations(opts)
      return list.available ? list.automations.some((entry) => entry.id === params.automationId) : null
    } else {
      return null
    }
    return true
  } catch (error) {
    return isMissing(error, pattern) ? false : null
  }
}

/** git's one-line reasons for a sha the repo does not have (`collectCommitChanges`). */
const MISSING_COMMIT = /unknown revision|bad object|bad revision|unknown commit|not a commit hash|needed a single revision/i

/** A 404 is "gone" everywhere; the commit route answers a missing sha with 409 + git's reason, so
 *  for that route (only) a 409 counts when the reason says the object is absent. Any other 409
 *  ("not a git repository") or a dead connection proves nothing. */
function isMissing(error: unknown, pattern: string): boolean {
  if (!(error instanceof ApiError)) return false
  if (error.status === 404) return true
  return (pattern === '/git/commits/:sha' || pattern === '/tasks/:id/commits/:sha') && error.status === 409 && MISSING_COMMIT.test(error.message)
}

/** The path a click on `projectId` should navigate to: the remembered page unless its entity is
 *  CONFIRMED gone, in which case the project home. Never throws. */
export async function resolveProjectSwitch(
  projectId: string,
  stored: unknown,
  context: ProjectSwitchContext,
): Promise<string> {
  const target = projectSwitchTarget(projectId, stored, context)
  if (!target.verify) return target.href
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS)
  try {
    const exists = await entityExists(projectId, target.href.replace(/[?#].*$/, ''), context.capabilities, controller.signal, context.repoBaseOf?.(projectId))
    return exists === false ? homeOf(projectId) : target.href
  } finally {
    clearTimeout(timer)
  }
}


/**
 * The newest-intent switch, app-lifetime. The rail, the palette and any future control all go
 * through `switchToProject`, so "latest click wins" holds across them, and a check that was in
 * flight when the user navigated by any other means (a link, back, a query/hash change) lands
 * nowhere. State is module-level because the palette's hook instance unmounts on selection while
 * its answer is still pending; the host is whichever mounted hook last reported the router.
 */
const host: { key: string; navigate: NavigateFunction | null; ticket: number } = {
  key: '',
  navigate: null,
  ticket: 0,
}

/** Called by every mounted switch hook and the always-mounted location controller. */
export function reportSwitchHost(key: string, navigate: NavigateFunction): void {
  // Every CHANGED location supersedes a pending switch, so going away and back (history -1
  // restores the same router key) cannot let the old answer land. Several hosts reporting the
  // same location are one change.
  if (key !== host.key) host.ticket++
  host.key = key
  host.navigate = navigate
}

/** A click on a control that navigates by itself (the current project, a plain link) still
 *  supersedes whatever check is pending. */
export function supersedeProjectSwitch(): void {
  host.ticket++
}

export async function switchToProject(
  projectId: string,
  stored: unknown,
  context: ProjectSwitchContext,
): Promise<void> {
  const ticket = ++host.ticket
  const from = host.key
  const to = await resolveProjectSwitch(projectId, stored, context)
  if (ticket === host.ticket && from === host.key) host.navigate?.(to)
}
