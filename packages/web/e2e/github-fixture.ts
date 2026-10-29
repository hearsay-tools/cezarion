import { resolve } from 'node:path'

import {
  formatGitHubNavFailure,
  GITHUB_TAB_MARKUP_JS,
  githubSurfaceReadyJs,
} from './github-nav-contract'
import { AgentBrowser, bootProjectId, readTestEnv } from './agent-browser'

const artifactsDir = resolve(import.meta.dirname, '../../../.ai/qa/artifacts_e2e')
const DESKTOP = { width: 1440, height: 900 }
export interface GithubPayload {
  available: boolean
  repo?: string | undefined
  issues: Array<{ number: number; title: string; labels: string[] }>
  prs: Array<{ number: number; title: string; checks?: string | null }>
}

export { artifactsDir, DESKTOP }

/** A fresh closure per spec file; no shared browser or server-state cache. */
export async function createGitHubFixture(sessionId: string) {
  const baseUrl = readTestEnv().baseUrl
  const bootProject = await bootProjectId(baseUrl)
  const forgeAvailable = (await api<{ forge: { available: boolean } | null }>('/api/v1/health')).forge?.available === true
  const browser = AgentBrowser.open(sessionId)
  browser.setViewport(DESKTOP.width, DESKTOP.height)

  async function api<T>(path: string): Promise<T> {
    const res = await fetch(`${baseUrl}${path}`)
    if (!res.ok) throw new Error(`cezar e2e: GET ${path} answered ${res.status}`)
    return (await res.json()) as T
  }

  /** A flat route target under this server's own project prefix (multi-project spec, step 3.2):
   *  every cockpit link is scoped, and every legacy flat URL redirects onto its scoped twin. */
  const scoped = (path: string) => `/p/${bootProject}${path}`

  async function rememberGithubView(githubView: 'issues' | 'prs'): Promise<void> {
    const response = await fetch(`${baseUrl}/api/v1/ui-state`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ githubView }),
    })
    if (!response.ok) throw new Error(`cezar e2e: PUT /api/v1/ui-state answered ${response.status}`)
  }

  function githubNavFailure(target: AgentBrowser, cause: unknown): Error {
    let url = '(url unavailable)'
    let tabMarkup = ''
    try {
      url = target.url()
    } catch {
      /* session may be dead */
    }
    try {
      tabMarkup = String(target.evaluate(GITHUB_TAB_MARKUP_JS) ?? '')
    } catch {
      /* no document */
    }
    return new Error(
      formatGitHubNavFailure({
        url,
        tabMarkup,
        message: cause instanceof Error ? cause.message : String(cause),
      }),
      { cause },
    )
  }

  function waitForGitHubSurface(pathname: string, target: AgentBrowser = browser): void {
    try {
      // Below md the Issues tab links `?filter=all` (#622: a bare /github is the filter index
      // there), so the strip is ready with either spelling of that link.
      const issuesHref = scoped('/github')
      target.waitForFunction(
        githubSurfaceReadyJs({ pathname, issuesHref, prsHref: scoped('/github/prs') })
          .replace(
            `tabs.querySelector(${JSON.stringify(`a[href="${issuesHref}"]`)})`,
            `tabs.querySelector(${JSON.stringify(`a[href="${issuesHref}"], a[href="${issuesHref}?filter=all"]`)})`,
          ),
      )
    } catch (cause) {
      throw githubNavFailure(target, cause)
    }
  }

  /** `path` may carry a query (`/github?filter=all`): the surface wait reads the pathname only.
   *  Below md a BARE `/github` is the filter index, so phone specs that want the list ask for an
   *  explicit filter (#622). */
  async function openGitHub(path: string, target: AgentBrowser = browser): Promise<void> {
    const pathname = path.split('?')[0]!
    if (pathname === '/github') await rememberGithubView('issues')
    target.goto(`${baseUrl}${scoped(path)}`)
    waitForGitHubSurface(scoped(pathname), target)
  }

  /** Click a sub-tab, then wait until the server stores the choice that click persists.
   *
   *  The tab click PUTs `githubView` from the page (`saveGithubView`, routes/github/github.tsx)
   *  and nobody awaits it. A later `rememberGithubView` from the spec could then land BEFORE
   *  that write, and the stale view wins: the next cold load of `/github` restores `prs` and
   *  redirects to `/github/prs` (hearsay-tools/cezarion#985). Read from the page so the seam stays synchronous; the unscoped
   *  path is the boot project's, which `rememberGithubView` writes. agent-browser's `eval`
   *  awaits a returned promise and reports its settled value (a 1.5 s `setTimeout` promise
   *  returns `42` after 1508 ms), so each sample is the server's stored view, not a wrapper. */
  function clickGitHubTab(path: '/github' | '/github/prs', target: AgentBrowser = browser): void {
    const href = scoped(path)
    try {
      // See waitForGitHubSurface: the phone's Issues tab carries `?filter=all`.
      target.click(`[data-slot="gh-tabs"] a[href="${href}"], [data-slot="gh-tabs"] a[href="${href}?filter=all"]`)
    } catch (cause) {
      throw githubNavFailure(target, cause)
    }
    waitForGitHubSurface(href, target)
    const view = path === '/github' ? 'issues' : 'prs'
    target.waitForValue(
      `fetch('/api/v1/ui-state', { cache: 'no-store' }).then(r => r.json()).then(s => s.githubView === ${JSON.stringify(view)} || null)`,
    )
  }

  return { browser, baseUrl, forgeAvailable, api, scoped, rememberGithubView, waitForGitHubSurface, openGitHub, clickGitHubTab }
}

export type GitHubFixture = Awaited<ReturnType<typeof createGitHubFixture>>
