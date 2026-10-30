import { runAddress } from '@/api/run-address'
import {
  ApiError,
  getGithubItem,
  getAutomations,
  getRun,
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

/** What one existence check reads: the matched route, and the request options for the target project. */
type EntityCheck = {
  projectId: string
  pattern: string
  params: Record<string, string | undefined>
  /** The project's repository base, which decides which task references are its own. */
  repoBase: string | undefined
  opts: { projectId: string; signal: AbortSignal }
}

/** `true`/`false` on an authoritative answer, `null` when nothing proves it either way. A request
 *  that fails throws instead; `entityExists` maps the error through `isMissing`. */
type EntityChecker = (check: EntityCheck) => Promise<boolean | null>

/** The task's run record. Every task page needs the run before anything it holds. */
const taskRun = (check: EntityCheck) =>
  getRun(runAddress(check.params.id ?? '', { projectId: check.opts.projectId }), { signal: check.opts.signal })

/** An issue/PR number from a route segment; null unless it is a positive safe integer. */
function itemNumber(segment: string | undefined): number | null {
  const number = Number(segment)
  return Number.isSafeInteger(number) && number >= 1 ? number : null
}

/** A forge item answers `true` when it exists, `false` when the forge has no such number, and
 *  `null` when the forge is not available. */
async function forgeItemExists(kind: 'issue' | 'pr', number: number, check: EntityCheck): Promise<boolean | null> {
  const item = await getGithubItem(kind, number, {}, check.opts)
  return item.available ? item.item !== null : null
}

const checkTask: EntityChecker = async (check) => {
  await taskRun(check)
  return true
}

/** The run is there; its commit may not be (a rebased or amended commit). */
const checkTaskCommit: EntityChecker = async (check) => {
  await taskRun(check)
  await getRunCommit(check.params.id ?? '', check.params.sha ?? '', check.opts)
  return true
}

/** The run is there; its issue/PR number may not be (a detached number). */
async function checkTaskItem(check: EntityCheck, kind: 'issue' | 'pr'): Promise<boolean | null> {
  const run = await taskRun(check)
  const number = itemNumber(check.params.n)
  if (number === null) return false
  // The route only opens items the TASK references (`taskItemTabs`), judged against the
  // project's repository. Without that identity a detached link cannot be proven.
  const linked = taskItemTabs(run, check.repoBase).some((tab) => tab.kind === kind && tab.number === number)
  if (!linked) return check.repoBase === undefined ? null : false
  return forgeItemExists(kind, number, check)
}

const checkRepoCommit: EntityChecker = async (check) => {
  await getRepoCommit(check.params.sha ?? '', check.opts)
  return true
}

async function checkForgeItem(check: EntityCheck, kind: 'issue' | 'pr'): Promise<boolean | null> {
  const number = itemNumber(check.params.n)
  return number === null ? false : forgeItemExists(kind, number, check)
}

const checkWorkflow: EntityChecker = async (check) => {
  const { workflows, issues } = await getWorkflows(check.opts)
  if (workflows.some((workflow) => workflow.name === check.params.name)) return true
  // A file that failed to load (unreadable, unparseable) may be the very workflow in the
  // URL, so an absent name proves nothing while the catalog reports problems.
  return issues.length > 0 ? null : false
}

const checkAutomation: EntityChecker = async (check) => {
  const list = await getAutomations(check.opts)
  return list.available ? list.automations.some((entry) => entry.id === check.params.automationId) : null
}

/**
 * The checker for each routed entity page, tried in this order; the first whose pattern matches
 * answers. The task children come before `/tasks/:id`, which is a prefix of every task pattern. A
 * routed page with no entry (`/compare/:groupId`, the retired page's redirect) has nothing to
 * verify.
 */
const ENTITY_CHECKERS: readonly { matches: (pattern: string) => boolean; check: EntityChecker }[] = [
  { matches: (pattern) => pattern === '/tasks/:id/commits/:sha', check: checkTaskCommit },
  { matches: (pattern) => pattern === '/tasks/:id/issue/:n', check: (check) => checkTaskItem(check, 'issue') },
  { matches: (pattern) => pattern === '/tasks/:id/pr/:n', check: (check) => checkTaskItem(check, 'pr') },
  { matches: (pattern) => pattern.startsWith('/tasks/:id'), check: checkTask },
  { matches: (pattern) => pattern === '/git/commits/:sha', check: checkRepoCommit },
  { matches: (pattern) => pattern === '/github/issues/:n', check: (check) => checkForgeItem(check, 'issue') },
  { matches: (pattern) => pattern.startsWith('/github/prs/:n'), check: (check) => checkForgeItem(check, 'pr') },
  { matches: (pattern) => pattern === '/workflows/:name', check: checkWorkflow },
  { matches: (pattern) => pattern.startsWith('/automations/:automationId'), check: checkAutomation },
]

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
  let pattern = ''
  try {
    const route = matchProjectRoute(pathname, capabilities)
    if (route === null) return false
    pattern = route.pattern
    const entry = ENTITY_CHECKERS.find((candidate) => candidate.matches(route.pattern))
    if (entry === undefined) return null
    // Awaited here, inside the try, so a failing request reaches the catch below.
    return await entry.check({ projectId, pattern, params: route.params, repoBase, opts: { projectId, signal } })
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
