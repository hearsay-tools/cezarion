import {
  ApiError,
  getGithubItem,
  getGroup,
  getAutomations,
  getProjectRun,
  getRepoCommit,
  getWorkflows,
} from '@/api/client'
import type { Capabilities, ProjectsResponse } from '@open-mercato/cezar-api-client'
import { rememberedProjectPage } from '@/lib/last-location'
import { scopeTo } from '@/lib/project-router'
import { matchProjectRoute } from '@/routes'

/** How long a switch waits for an existence answer before restoring the page anyway. */
const CHECK_TIMEOUT_MS = 2_500

export type ProjectSwitchContext = {
  registry: ProjectsResponse | undefined
  capabilities: Capabilities | undefined
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
): Promise<boolean | null> {
  const opts = { projectId, signal }
  try {
    const route = matchProjectRoute(pathname, capabilities)
    if (route === null) return false
    const { pattern, params } = route
    if (pattern.startsWith('/tasks/:id')) {
      await getProjectRun(projectId, params.id ?? '', { signal })
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
      const { workflows } = await getWorkflows(opts)
      return workflows.some((workflow) => workflow.name === params.name)
    } else if (pattern.startsWith('/automations/:automationId')) {
      const list = await getAutomations(opts)
      return list.available ? list.automations.some((entry) => entry.id === params.automationId) : null
    } else {
      return null
    }
    return true
  } catch (error) {
    return error instanceof ApiError && error.status === 404 ? false : null
  }
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
    const exists = await entityExists(projectId, target.href.replace(/[?#].*$/, ''), context.capabilities, controller.signal)
    return exists === false ? homeOf(projectId) : target.href
  } finally {
    clearTimeout(timer)
  }
}

