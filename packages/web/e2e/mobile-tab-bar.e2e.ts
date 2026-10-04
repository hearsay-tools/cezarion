import { execFileSync, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { waitForSettledSample } from './visual-ready'
import { AgentBrowser, bootProjectId, cezarCli, fixtureServeEnv } from './agent-browser'
import { applyContrastQaVariant, contrastQaVariants, contrastSampleExpression, restoreContrastQaDefaults, type ContrastSample } from './contrast'
import { spawnFixtureServer, stopFixtureServer, waitForFixtureServer } from './fixture-server'

/**
 * #621: the phone's tab bar, More sheet, New task button and pushed task screen, against its own
 * fixture server so the two opt-in views (Inbox, Automations) can be switched on without touching
 * the shared env. Asserts what only a browser can: that every view is still reachable from the tab
 * bar or the More sheet once the drawer stopped listing them, real 44px geometry, the pushed
 * screen's chrome and its way back, and AA text contrast in both themes.
 */

const SHOTS = '/tmp/i621/shots'
const PHONE = { width: 360, height: 640 }
const IPHONE = { width: 390, height: 844 }

const TAB_BAR = '[data-slot="mobile-tab-bar"]'
const MORE_TAB = `${TAB_BAR} [data-tab="more"]`
const SHEET = '[data-slot="more-sheet"]'
const FAB = '[data-slot="mobile-new-task"]'
const TOP_BAR = '[data-slot="mobile-top-bar"]'
const BACK = `${TOP_BAR} [data-slot="mobile-back"]`
const DRAWER = '[data-slot="mobile-nav-drawer"]'
const MENU_BUTTON = `${TOP_BAR} button[aria-label^="Open projects"]`

const RUN_ID = 'tab-bar-review'
const RUN_TITLE = 'Ship the phone tab bar'

let root: string
let base: string
let project: string
let server: ChildProcess
let browser: AgentBrowser
let forge = false
let followups = false
let automations = false

const scoped = (path: string) => `/p/${project}${path}`
const ago = (ms: number) => new Date(Date.now() - ms).toISOString()
const record = (id: string, status: string, extra: Record<string, unknown> = {}) => ({
  id, title: id === RUN_ID ? RUN_TITLE : `tab bar ${id}`, workflow: 'default', task: `tab bar ${id}`, status,
  createdAt: ago(60 * 60_000), finishedAt: ago(30 * 60_000), tokensUsed: 0, archived: false, steps: [], ...extra,
})

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'cez-tab-bar-'))
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { stdio: 'ignore' })
  git('init', '-q', '-b', 'main')
  git('-c', 'user.name=E2E', '-c', 'user.email=e2e@example.test', 'commit', '--allow-empty', '-m', 'fixture')
  git('remote', 'add', 'origin', 'https://github.com/example/tab-bar-fixture.git')
  mkdirSync(join(root, '.ai/cezar'), { recursive: true })
  // A run in review (the Tasks tab's amber "needs you" badge) and a finished one; the reviewed run
  // carries a changed-file tally, which is the Changes tab's count.
  writeFileSync(join(root, '.ai/cezar/runs.json'), JSON.stringify([
    record(RUN_ID, 'review', { diffStat: { adds: 12, dels: 3, files: 3 } }),
    record('tab-bar-done', 'done'),
  ]))
  writeFileSync(join(root, '.ai/cezar/todos.json'), JSON.stringify([
    { id: 'follow-up', summary: 'Check the tab bar on a phone.', runnable: false, taskId: RUN_ID },
  ]))
  server = spawnFixtureServer([cezarCli, 'serve', '--repo', root, '--port', '0', '--no-open'], {
    env: fixtureServeEnv(root, { CEZ_FOLLOWUPS: '1', CEZ_AUTOMATIONS: '1' }), stdio: 'ignore',
  })
  base = await waitForFixtureServer(server)
  project = await bootProjectId(base)
  // Which views this server actually offers decides which rows the bar and the sheet must show:
  // Inbox needs the follow-ups flag, Automations the flag alone (a schedule needs no forge), GitHub the forge.
  const health = (await fetch(`${base}/api/v1/health`).then((response) => response.json())) as {
    forge: { available: boolean } | null
    capabilities: { followups: boolean; automations: boolean }
  }
  forge = health.forge?.available === true
  followups = health.capabilities.followups
  automations = health.capabilities.automations
  mkdirSync(SHOTS, { recursive: true })
  browser = AgentBrowser.open(`mobile-tab-bar-${process.pid}`)
}, 60_000)

afterAll(async () => {
  if (browser) {
    restoreContrastQaDefaults(browser)
    browser.close()
  }
  await stopFixtureServer(server)
  if (root) rmSync(root, { recursive: true, force: true })
})

function openList(): void {
  browser.goto(`${base}${scoped('/')}`)
  browser.waitForFunction(`document.querySelector('[data-route="tasks"] [data-slot="task-card"]') !== null`)
}

/** Open the More sheet and wait until it has slid in and stopped. */
function openMore(): void {
  browser.click(MORE_TAB)
  browser.waitForStable(`(() => {
    const sheet = document.querySelector('${SHEET}')
    if (!sheet || sheet.getAnimations().some((animation) => animation.playState === 'running')) return null
    return Math.round(sheet.getBoundingClientRect().bottom)
  })()`, { holdMs: 150, matcher: (bottom: number | null) => bottom !== null })
}

/** Every listed control's rect must clear the 44px touch floor. */
function undersized(selector: string): unknown {
  return waitForSettledSample(browser, `(() => {
    const nodes = [...document.querySelectorAll(${JSON.stringify(selector)})]
    if (nodes.length === 0) return null
    return nodes.map((node) => { const r = node.getBoundingClientRect(); return { label: node.textContent.trim().slice(0, 24) || node.getAttribute('aria-label'), w: Math.round(r.width), h: Math.round(r.height) } })
      .filter((box) => box.w < 44 || box.h < 44)
  })()`)
}

const mobileVariants = contrastQaVariants.filter((variant) => variant.viewport.width === 360 && variant.density === 'comfortable')

describe('mobile tab bar, More sheet and pushed task screen', () => {
  it('walks every view from the tab bar and the More sheet', () => {
    browser.setViewport(PHONE.width, PHONE.height)
    openList()

    const tabs = [
      { to: '/', route: 'tasks' },
      { to: '/git', route: 'repo-git' },
      ...(forge ? [{ to: '/github', route: 'github' }] : []),
    ]
    // The tab bar carries exactly the views it promises (GitHub only with a forge) plus More.
    expect(browser.waitForValue(`[...document.querySelectorAll('${TAB_BAR} [data-tab]')].map((tab) => tab.getAttribute('data-tab'))`))
      .toEqual([...tabs.map((tab) => tab.to), 'more'])
    for (const { to, route } of tabs) {
      browser.click(`${TAB_BAR} a[data-tab="${to}"]`)
      browser.waitForFunction(`location.pathname === ${JSON.stringify(scoped(to === '/' ? '/' : to))} && document.querySelector('[data-route="${route}"]') !== null`)
      expect(browser.waitForValue(`document.querySelector('${TAB_BAR} a[data-tab="${to}"]')?.getAttribute('aria-current')`)).toBe('page')
    }

    // More: Skills, Workflows, Project settings always; Inbox and Automations only with their flag.
    const rows = [
      { to: '/skills', route: 'skills' },
      { to: '/workflows', route: 'workflows' },
      { to: '/settings', route: 'settings' },
      ...(followups ? [{ to: '/inbox', route: 'inbox' }] : []),
      ...(automations ? [{ to: '/automations', route: 'automations' }] : []),
    ]
    openMore()
    expect(browser.waitForValue(`[...document.querySelectorAll('${SHEET} [data-slot="more-row"]')].map((row) => row.getAttribute('data-more-row'))`))
      .toEqual(rows.map((row) => row.to))
    browser.click(`${SHEET} [data-slot="more-row"][data-more-row="${rows[0]!.to}"]`)
    browser.waitForFunction(`document.querySelector('${SHEET}') === null`)
    for (const [index, { to, route }] of rows.entries()) {
      if (index > 0) {
        openMore()
        browser.click(`${SHEET} [data-slot="more-row"][data-more-row="${to}"]`)
        browser.waitForFunction(`document.querySelector('${SHEET}') === null`)
      }
      // The row routed, the sheet is not still covering the view, and More is the lit tab.
      browser.waitForFunction(`location.pathname === ${JSON.stringify(scoped(to))} && document.querySelector('[data-route="${route}"]') !== null`)
      expect(browser.waitForValue(`document.querySelector('${MORE_TAB}')?.getAttribute('data-active')`)).toBe('true')
      expect(browser.waitForValue(`document.querySelector('${TAB_BAR} a[aria-current="page"]') === null`)).toBe(true)
    }
  }, 120_000)

  it('shows the Tasks badge and a New task button that opens /new', () => {
    browser.setViewport(PHONE.width, PHONE.height)
    openList()
    // One run waits on the user, so the Tasks tab carries the current project's top pill.
    const badge = browser.waitForValue(`[...document.querySelectorAll('${TAB_BAR} a[data-tab="/"] [data-slot="rail-pill-top"] [data-segment]')].map((el) => el.getAttribute('data-segment'))`, (tones: string[] | null) => Array.isArray(tones) && tones.length > 0)
    expect(badge).toContain('amber')
    expect(browser.count(`${TAB_BAR} a[data-tab="/git"] [data-slot="rail-pill-top"]`)).toBe(0)
    // The in-motion pill is status, not a reason to tap: never on the bar.
    expect(browser.count(`${TAB_BAR} [data-slot="rail-pill-bottom"]`)).toBe(0)
    // The list's own round FAB is gone: one floating button, the bar's.
    expect(browser.count('[data-slot="new-task-fab"]')).toBe(0)
    browser.click(FAB)
    browser.waitForFunction(`location.pathname === ${JSON.stringify(scoped('/new'))} && document.querySelector('[data-route="new"]') !== null`)
    // It would point at the page it is on, so /new drops it (the bar stays).
    expect(browser.waitForValue(`document.querySelector('${FAB}') === null && document.querySelector('${TAB_BAR}') !== null`)).toBe(true)
  })

  it('keeps every bar, sheet and button target at 44px', () => {
    browser.setViewport(PHONE.width, PHONE.height)
    openList()
    expect(undersized(`${TAB_BAR} a, ${TAB_BAR} button`)).toEqual([])
    const fab = waitForSettledSample(browser, `(() => { const r = document.querySelector('${FAB}')?.getBoundingClientRect(); return r ? { w: Math.round(r.width), h: Math.round(r.height), right: Math.round(innerWidth - r.right) } : null })()`) as { w: number; h: number; right: number }
    expect(fab.h).toBe(48)
    expect(fab.w).toBeGreaterThanOrEqual(44)
    expect(fab.right).toBe(16)
    openMore()
    expect(undersized(`${SHEET} [data-slot="more-row"]`)).toEqual([])
    const bar = waitForSettledSample(browser, `Math.round(document.querySelector('${TAB_BAR}').getBoundingClientRect().height)`)
    expect(bar).toBe(54)
    browser.press('Escape')
    browser.waitForFunction(`document.querySelector('${SHEET}') === null`)

    // The pushed screen's back and run-actions kebab.
    browser.goto(`${base}${scoped(`/tasks/${RUN_ID}`)}`)
    browser.waitForFunction(`document.querySelector('${TOP_BAR} [aria-label="Run actions"]') !== null`)
    expect(undersized(`${BACK}, ${TOP_BAR} [aria-label="Run actions"], [data-slot="run-tabs"] a`)).toEqual([])

    // The drawer: its own rows, and the current project's `…`.
    openList()
    browser.click(MENU_BUTTON)
    browser.waitForFunction(`document.querySelector('${DRAWER}')?.getBoundingClientRect().left === 0`)
    expect(undersized(`${DRAWER} [data-slot="drawer-tools"], ${DRAWER} [data-slot="drawer-project-current"] button`)).toEqual([])
  })

  it('shows a pushed task screen: no tab bar, back / title / state up top, facet tabs, and Back returns to the list', () => {
    browser.setViewport(PHONE.width, PHONE.height)
    openList()
    browser.click(`[data-slot="task-card"][data-run-id="${RUN_ID}"] a[href]`)
    browser.waitForFunction(`location.pathname === ${JSON.stringify(scoped(`/tasks/${RUN_ID}`))} && document.querySelector('${TOP_BAR} [data-slot="mobile-run-title"]') !== null`)

    const screen = waitForSettledSample(browser, `(() => {
      const top = document.querySelector('${TOP_BAR}')
      const state = top.querySelector('[data-slot="mobile-run-state"]')
      return {
        tabBar: document.querySelector('${TAB_BAR}') !== null, fab: document.querySelector('${FAB}') !== null,
        menu: top.querySelector('button[aria-label^="Open projects"]') !== null,
        back: top.querySelector('[data-slot="mobile-back"]')?.getAttribute('aria-label'),
        title: top.querySelector('[data-slot="mobile-run-title"]')?.textContent,
        stateText: state?.textContent, stateDot: state?.querySelector('[data-slot="status-dot"]') !== null,
        kebab: top.querySelector('[aria-label="Run actions"]') !== null,
        facets: [...document.querySelectorAll('[data-slot="run-tabs"] a')].map((a) => a.textContent.trim()),
        ownTitle: document.querySelector('[data-slot="run-header"] h1') !== null,
        composer: document.querySelector('[data-route="task-thread"] [data-slot="composer"], [data-slot="thread-dock"]') !== null,
        overflow: document.documentElement.scrollWidth - innerWidth,
      }
    })()`) as { tabBar: boolean; fab: boolean; menu: boolean; back: string; title: string; stateText: string; stateDot: boolean; kebab: boolean; facets: string[]; ownTitle: boolean; composer: boolean; overflow: number }
    expect(screen).toMatchObject({ tabBar: false, fab: false, menu: false, back: 'Back', title: expect.stringContaining(RUN_TITLE), kebab: true, ownTitle: false, composer: true })
    expect(screen.stateText.length).toBeGreaterThan(0)
    expect(screen.stateDot).toBe(true)
    // Session, Changes (3 changed files), Commits, Files.
    expect(screen.facets).toEqual(['Session', 'Changes3', 'Commits', 'Files'])
    expect(screen.overflow).toBeLessThanOrEqual(0)

    // Facet tabs replace their history entry below md, so hopping them never lengthens the way back.
    browser.click('[data-slot="run-tabs"] a[href$="/files"]')
    browser.waitForFunction(`location.pathname.endsWith('/files')`)

    // In-app history: Back pops to the list the user came from, tab bar and all.
    browser.click(BACK)
    browser.waitForFunction(`location.pathname === ${JSON.stringify(scoped('/'))} && document.querySelector('${TAB_BAR}') !== null`)
    expect(browser.waitForValue(`document.querySelector('[data-route="tasks"]') !== null`)).toBe(true)

    // Cold open (a deep link or reload): nothing to pop, so Back lands on the Tasks list instead of leaving.
    browser.goto(`${base}${scoped(`/tasks/${RUN_ID}/changes`)}`)
    browser.waitForFunction(`document.querySelector('${BACK}') !== null && document.querySelector('${TAB_BAR}') === null`)
    browser.click(BACK)
    browser.waitForFunction(`location.pathname === ${JSON.stringify(scoped('/'))} && document.querySelector('${TAB_BAR}') !== null`)
  })

  it('leaves the drawer projects-only, with Tools and the project menu in their new homes', () => {
    browser.setViewport(PHONE.width, PHONE.height)
    openList()
    browser.click(MENU_BUTTON)
    browser.waitForFunction(`document.querySelector('${DRAWER}')?.getBoundingClientRect().left === 0`)
    const drawer = browser.waitForValue(`(() => {
      const root = document.querySelector('${DRAWER}')
      const tools = root.querySelector('[data-slot="drawer-tools"]')
      if (!tools) return null
      return { nav: root.querySelectorAll('nav').length, content: root.querySelectorAll('[data-slot="sidebar-content"]').length,
        quickList: root.querySelectorAll('[data-slot="quick-list"], [data-slot="view-tab"], [data-slot="view-tabs"]').length,
        newTask: root.querySelectorAll('[data-sidebar-item="new-task"]').length,
        projects: root.querySelectorAll('[data-slot="drawer-project"]').length,
        toolsHref: tools.getAttribute('href'), current: root.querySelectorAll('[data-slot="drawer-project"][aria-current="page"]').length,
        menuInLink: !!root.querySelector('[data-slot="drawer-project-current"] [data-slot="project-menu-trigger"]')?.closest('a') }
    })()`) as { nav: number; content: number; quickList: number; newTask: number; projects: number; toolsHref: string; current: number; menuInLink: boolean }
    expect(drawer).toMatchObject({ nav: 0, content: 0, quickList: 0, newTask: 0, current: 1, menuInLink: false, toolsHref: '/tools' })
    expect(drawer.projects).toBeGreaterThanOrEqual(1)

    // The current project's `…` is the same menu the desktop header opens.
    browser.click(`${DRAWER} [data-slot="drawer-project-current"] [data-slot="project-menu-trigger"]`)
    const menu = browser.waitForValue(`document.querySelector('[role="menu"]')?.textContent`, (text: string | null) => typeof text === 'string' && text.includes('Project settings')) as string
    expect(menu).toContain('Mark all read')
    browser.press('Escape')
    browser.waitForFunction(`document.querySelector('[role="menu"]') === null`)

    // Tools opens the page directly and closes the drawer behind it.
    browser.click(`${DRAWER} [data-slot="drawer-tools"]`)
    browser.waitForFunction(`document.querySelector('${DRAWER}') === null && document.querySelector('[data-route="workspace-tools"]') !== null`)
  })

  for (const variant of mobileVariants) {
    it(`passes text contrast on the tab bar, the More sheet and the New task button, ${variant.theme}`, () => {
      browser.goto(`${base}${scoped('/')}`)
      browser.waitForFunction(`document.querySelector('${FAB}') !== null`)
      applyContrastQaVariant(browser, variant)
      const check = (selector: string, label: string, min = 4.5) => {
        const sample = browser.evaluate(contrastSampleExpression(selector)) as ContrastSample
        expect(sample.ratio, `${variant.id} ${label} ${JSON.stringify(sample)}`).toBeGreaterThanOrEqual(min)
      }
      check(`${TAB_BAR} a[data-tab="/"]`, 'active tab label')
      check(`${TAB_BAR} a[data-tab="/git"]`, 'inactive tab label')
      check(MORE_TAB, 'More tab label')
      check(FAB, 'New task button')
      // The bar's icons are graphics: 3:1.
      check(`${TAB_BAR} a[data-tab="/git"] svg`, 'inactive tab icon', 3)
      openMore()
      for (const to of ['/skills', '/workflows', '/settings', ...(followups ? ['/inbox'] : [])]) {
        check(`${SHEET} [data-more-row="${to}"] span`, `More row ${to}`)
      }
      check(`${SHEET} [data-slot="more-project"]`, 'More project name')
      check(`${SHEET} [data-more-row="/skills"] svg`, 'More row icon', 3)
    })
  }

  for (const theme of ['dark', 'light'] as const) {
    it(`captures the Tasks list, the More sheet and the task screen at ${IPHONE.width}x${IPHONE.height}, ${theme}`, () => {
      browser.setViewport(IPHONE.width, IPHONE.height)
      browser.goto(`${base}${scoped('/')}`)
      browser.waitForFunction(`document.querySelector('${FAB}') !== null && document.querySelector('[data-slot="task-card"]') !== null`)
      browser.evaluate(`document.documentElement.classList.toggle('light', ${theme === 'light'})`)
      browser.waitForFunction(`document.documentElement.classList.contains('light') === ${theme === 'light'} && document.querySelector('${TAB_BAR} [data-slot="rail-pill-top"]') !== null`)
      browser.screenshot(`${SHOTS}/tasks-tab-bar-${theme}.png`, { viewport: true })
      openMore()
      browser.screenshot(`${SHOTS}/more-sheet-${theme}.png`, { viewport: true })
      browser.press('Escape')
      browser.waitForFunction(`document.querySelector('${SHEET}') === null`)
      browser.goto(`${base}${scoped(`/tasks/${RUN_ID}`)}`)
      browser.waitForFunction(`document.querySelector('${TOP_BAR} [data-slot="mobile-run-title"]') !== null && document.querySelector('[data-slot="run-tabs"]') !== null`)
      browser.evaluate(`document.documentElement.classList.toggle('light', ${theme === 'light'})`)
      browser.waitForFunction(`document.documentElement.classList.contains('light') === ${theme === 'light'}`)
      browser.screenshot(`${SHOTS}/task-screen-${theme}.png`, { viewport: true })
    })
  }
})
