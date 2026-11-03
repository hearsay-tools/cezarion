import type { AgentBrowser } from './agent-browser'

/** Every seam attached and not yet closed, oldest first. */
export const attached: AgentBrowser[] = []

/** The seam most recently attached and not yet closed — how `failure-setup.ts`'s
 *  `onTestFailed` hook reaches the browser a spec holds in its own module scope.
 *
 *  A stack, not a single slot: `github.e2e.ts` keeps its main browser open and attaches a
 *  short-lived one per state, and its `finally` closes that one before `onTestFailed` runs.
 *  Closing it must hand the hook back to the main browser, not to nothing. */
export function lastAttachedBrowser(): AgentBrowser | null {
  return attached.at(-1) ?? null
}


type SetupPage = {
  route: string
  ready?: string | undefined
  viewport?: { width: number; height: number; scale?: number } | undefined
  frozen: boolean
}
const pages = new WeakMap<AgentBrowser, SetupPage>()
function setupPage(browser: AgentBrowser): SetupPage {
  let page = pages.get(browser)
  if (!page) {
    page = { route: 'about:blank', frozen: false }
    pages.set(browser, page)
  }
  return page
}

export function rememberRoute(browser: AgentBrowser, route: string): void {
  const page = setupPage(browser)
  if (page.frozen) return
  page.route = route
  page.ready = undefined
}

export function rememberReadiness(browser: AgentBrowser, ready: string): void {
  const page = setupPage(browser)
  if (!page.frozen && page.ready === undefined) page.ready = ready
}

export function rememberViewport(browser: AgentBrowser, width: number, height: number, scale?: number): void {
  const page = setupPage(browser)
  if (!page.frozen) page.viewport = { width, height, ...(scale === undefined ? {} : { scale }) }
}

/** Freeze beforeAll's page, then discard each case's document and scroll history. */
export function resetBrowserPage(browser: AgentBrowser): void {
  const page = setupPage(browser)
  page.viewport ??= browser.evaluate('({ width: innerWidth, height: innerHeight })') as { width: number; height: number }
  if (!page.frozen && page.route !== 'about:blank') page.route = browser.url()
  page.frozen = true
  browser.goto('about:blank')
  browser.setViewport(page.viewport.width, page.viewport.height, page.viewport.scale)
  if (page.route !== 'about:blank') {
    browser.goto(page.route)
    browser.waitForFunction(page.ready ?? 'window.__cezIdle === true')
  }
  browser.evaluate('window.scrollTo(0, 0)')
}

/** Include every open session, including browsers backed by a spec's own server. */
export function resetBrowserPages(): void {
  for (const browser of attached) resetBrowserPage(browser)
}
