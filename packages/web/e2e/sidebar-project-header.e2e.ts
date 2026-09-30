import { spawn, type ChildProcess } from 'node:child_process'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AgentBrowser, bootProjectId, cezarCli, fixtureServeEnv } from './agent-browser'
import { stopFixtureServer } from './fixture-server'
import { waitForHealth } from './poll'
import { focusWithKeyboard } from './contrast'

const artifacts = resolve(import.meta.dirname, '../../../.ai/qa/artifacts_e2e')
const fixtures: Array<{ root: string; server: ChildProcess; url: string; project: string; remote: boolean }> = []
let browser: AgentBrowser
beforeAll(async () => {
  for (const remote of [false, true]) {
    const root = mkdtempSync(join(tmpdir(), 'cez-header-'))
    execFileSync('git', ['init', '-b', 'main', root], { stdio: 'ignore' })
    execFileSync('git', ['-C', root, '-c', 'user.name=E2E', '-c', 'user.email=e2e@example.test', 'commit', '--allow-empty', '-m', 'fixture'], { stdio: 'ignore' })
    execFileSync('git', ['-C', root, 'remote', 'add', 'origin', 'https://github.com/example/header-fixture.git'], { stdio: 'ignore' })
    mkdirSync(join(root, '.ai/cezar'), { recursive: true })
    writeFileSync(join(root, '.ai/cezar/runs.json'), JSON.stringify(['done', 'failed'].map(status => ({
      id: status, title: `${status} task`, task: 'Header test', workflow: 'default', status,
      createdAt: '2026-09-01T00:00:00Z', finishedAt: '2026-09-01T01:00:00Z', tokensUsed: 0, archived: false, steps: [],
    }))))
    const probe = createServer()
    const port = await new Promise<number>(done => probe.listen(0, '127.0.0.1', () => {
      const port = (probe.address() as { port: number }).port
      probe.close(() => done(port))
    }))
    const url = `http://127.0.0.1:${port}`
    const server = spawn(process.execPath, [cezarCli, 'serve', '--repo', root, '--port', String(port), '--no-open'], {
      env: fixtureServeEnv(root, { CEZ_REMOTE: remote ? '1' : '0', CEZ_FOLLOWUPS: '1', CEZ_AUTOMATIONS: '1' }), stdio: 'ignore',
    })
    fixtures.push({ root, server, url, project: '', remote })
    await waitForHealth(url)
    fixtures[fixtures.length - 1]!.project = await bootProjectId(url)
  }
  mkdirSync(artifacts, { recursive: true })
  browser = AgentBrowser.open(`header-${process.pid}`)
})
afterAll(async () => {
  browser?.close()
  for (const fixture of fixtures) {
    await stopFixtureServer(fixture.server)
    rmSync(fixture.root, { recursive: true, force: true })
  }
})

function settleMenu() {
  browser.moveTo(0, 0)
  browser.waitForFunction(`(() => {
    const menu = document.querySelector('[role="menu"]')
    return menu && getComputedStyle(menu).opacity === '1' &&
      menu.getAnimations().every(animation => animation.playState !== 'running') &&
      document.querySelector('[data-slot="tooltip-content"]') === null
  })()`)
}

describe('project header actions', () => {
  it('clears both finished signal segments through Mark all read without a reload', async () => {
    const fixture = fixtures[0]!
    browser.setViewport(1440, 900)
    browser.goto(`${fixture.url}/p/${fixture.project}/`)
    const rail = `[data-slot="rail-project"][data-project-id="${fixture.project}"]`
    browser.waitForFunction(`document.querySelector('${rail} [data-slot="rail-pill-bottom"]') !== null`)
    browser.click('[data-slot="sidebar"] [data-slot="project-menu-trigger"]')
    browser.waitForFunction(`document.querySelector('[role="menu"]')?.textContent.includes('2 unread')`)
    browser.click('[role="menu"] [role="menuitem"]:first-child')
    browser.waitForFunction(`document.querySelector('${rail} [data-slot="rail-pill-bottom"]') === null`)
    const records = await fetch(`${fixture.url}/api/v1/runs`).then(response => response.json()) as Array<{ seenAt?: string }>
    expect(records).toHaveLength(2)
    expect(records.every(run => typeof run.seenAt === 'string')).toBe(true)
    browser.waitForFunction(`document.querySelector('[role="menu"]') === null && document.activeElement === document.querySelector('[data-slot="sidebar"] [data-slot="project-menu-trigger"]')`)
    focusWithKeyboard(browser, '[data-slot="sidebar"] [data-slot="project-menu-trigger"]')
    browser.press('Enter')
    expect(browser.waitForValue(`Array.from(document.querySelectorAll('[role="menuitem"]')).find(el => el.textContent.includes('Mark all read'))?.getAttribute('aria-disabled')`)).toBe('true')
  })

  it.each(['dark', 'light'])('keeps remote header and menu free of host actions in %s theme', theme => {
    const fixture = fixtures[1]!
    browser.setViewport(1440, 900)
    browser.goto(`${fixture.url}/p/${fixture.project}/`)
    browser.evaluate(`document.documentElement.classList.toggle('light', ${theme === 'light'})`)
    expect(browser.waitForValue(`document.querySelector('[data-slot="sidebar"] [data-slot="project-header-detail"]')?.textContent`, value => value === 'main')).toBe('main')
    focusWithKeyboard(browser, '[data-slot="sidebar"] [data-slot="project-menu-trigger"]')
    browser.press('Enter')
    const menu = browser.waitForValue(`document.querySelector('[role="menu"]')?.textContent`, value => typeof value === 'string' && value.includes('Project settings')) as string
    expect(menu).toContain('Mark all read')
    expect(menu).not.toMatch(/Copy path|Open in/)
    settleMenu()
    browser.screenshot(`${artifacts}/sidebar-remote-${theme}.png`)
  })

  it.each(['dark', 'light'])('keeps all view controls reachable at 360px in %s theme', theme => {
    const fixture = fixtures[0]!
    browser.setViewport(360, 640)
    browser.goto(`${fixture.url}/p/${fixture.project}/`)
    browser.evaluate(`document.documentElement.classList.toggle('light', ${theme === 'light'})`)
    // The view tabs moved out of the drawer (#621): the tab bar holds Tasks/Git/GitHub and its
    // More sheet the rest, so "every view is reachable at 360px" is asserted there, at 44px.
    const tabs = browser.waitForValue(`Array.from(document.querySelectorAll('[data-slot="mobile-tab-bar"] a, [data-slot="mobile-tab-bar"] button')).map(el => ({ width: el.getBoundingClientRect().width, height: el.getBoundingClientRect().height }))`, value => Array.isArray(value) && value.length > 0) as Array<{ width: number; height: number }>
    expect(tabs.length).toBeGreaterThanOrEqual(3)
    expect(tabs.every(size => size.width >= 44 && size.height >= 44)).toBe(true)
    browser.click('[data-slot="mobile-tab-bar"] [data-tab="more"]')
    const rows = browser.waitForValue(`Array.from(document.querySelectorAll('[data-slot="more-sheet"] [data-slot="more-row"]')).map(el => el.getAttribute('data-more-row'))`, value => Array.isArray(value) && value.length > 0) as string[]
    expect(rows).toEqual(['/skills', '/workflows', '/settings', '/inbox', '/automations'])
    browser.press('Escape')
    browser.waitForFunction(`document.querySelector('[data-slot="more-sheet"]') === null`)
    // The drawer keeps the project menu, on the current project's row.
    browser.click('[aria-label^="Open projects"]')
    const drawer = '[data-slot="mobile-nav-drawer"]'
    browser.waitForStable(`(() => { const el = document.querySelector('${drawer}'); return el ? el.getBoundingClientRect().left : null })()`, { holdMs: 150, matcher: value => value === 0 })
    const trigger = `${drawer} [data-slot="drawer-project-current"] [data-slot="project-menu-trigger"]`
    const size = browser.waitForValue(`(() => { const el = document.querySelector('${trigger}'); if (!el) return null; const box = el.getBoundingClientRect(); return { width: box.width, height: box.height, inLink: !!el.closest('a') } })()`) as { width: number; height: number; inLink: boolean }
    expect(size.width).toBeGreaterThanOrEqual(44)
    expect(size.height).toBeGreaterThanOrEqual(44)
    expect(size.inLink).toBe(false)
    browser.click(trigger)
    const menu = browser.waitForValue(`document.querySelector('[role="menu"]')?.textContent`, value => typeof value === 'string' && value.includes('Copy path')) as string
    expect(menu).toContain('Mark all read')
    expect(menu).toContain('Open in')
    settleMenu()
    browser.screenshot(`${artifacts}/sidebar-mobile-${theme}.png`)
  })
})
