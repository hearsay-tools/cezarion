import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { RunRecord } from '@open-mercato/cezar-api-client'
import { AgentBrowser, bootProjectId, cezarCli, fixtureServeEnv, getJson } from './agent-browser'
import { focusWithKeyboard } from './contrast'

let browser: AgentBrowser
let server: ChildProcess
let root: string
let baseUrl: string
let project: string
const artifacts = resolve(import.meta.dirname, '../../../.ai/qa/artifacts_e2e/mobile-task-controls')
const search = '[aria-label="Search tasks"]'
const tab = (view: string) => `[data-slot="overview-tab"][data-view="${view}"]`
const actions = '[aria-label="Task actions"]'
const drawer = '[data-slot="mobile-nav-drawer"]'
const fixture = (id: string, status: RunRecord['status'], archived = false): RunRecord => ({
  id, title: `Needle ${id}`, task: `Needle ${id}`, workflow: 'quick-task', status,
  archived, createdAt: '2026-09-09T10:00:00Z', tokensUsed: 0, steps: [],
})

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'cez-controls-'))
  mkdirSync(join(root, '.ai/cezar'), { recursive: true })
  writeFileSync(join(root, '.ai/cezar/runs.json'), JSON.stringify([
    fixture('done', 'done'), fixture('failed', 'failed'), fixture('cancelled', 'cancelled'),
    fixture('review', 'review'), fixture('old', 'done', true),
  ]))
  const probe = createServer()
  probe.listen(0, '127.0.0.1')
  await once(probe, 'listening')
  const port = (probe.address() as { port: number }).port
  await new Promise<void>(done => probe.close(() => done()))
  baseUrl = `http://127.0.0.1:${port}`
  server = spawn(process.execPath, [cezarCli, 'serve', '--repo', root, '--port', String(port), '--no-open'], {
    env: fixtureServeEnv(root), stdio: 'ignore',
  })
  let healthy = false
  for (let attempt = 0; attempt < 60; attempt++) {
    try { healthy = (await fetch(`${baseUrl}/api/v1/health`)).ok } catch { /* booting */ }
    if (healthy) break
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  if (!healthy) throw new Error('Controls fixture did not start')
  project = await bootProjectId(baseUrl)
  browser = AgentBrowser.open(`controls-${process.pid}`)
})

afterAll(async () => {
  browser?.close()
  if (server && server.exitCode === null) {
    server.kill()
    await once(server, 'exit')
  }
  if (root) rmSync(root, { recursive: true, force: true })
})

function settle(selector: string) {
  browser.waitForFunction(`(() => {
    const target = document.querySelector(${JSON.stringify(selector)});
    if (!target) return false;
    for (let el = target; el; el = el.parentElement)
      if (el.getAnimations().some(a => a.playState === 'running' && a.effect?.getComputedTiming().iterations !== Infinity)) return false;
    return true;
  })()`)
}

beforeEach(() => {
  browser.setViewport(360, 640)
  browser.goto(`${baseUrl}/p/${project}/`)
  browser.waitForFunction(`document.querySelector('[data-slot="task-card"]') !== null`)
})

describe('mobile Tasks controls', () => {
  it('exposes search and view selection without opening the drawer', () => {
    expect(browser.isVisible(search)).toBe(true)
    expect(browser.isVisible(tab('active'))).toBe(true)
    expect(browser.isVisible(tab('archived'))).toBe(true)
    expect(browser.count(drawer)).toBe(0)
    browser.fill(search, 'failed')
    expect(browser.count('[data-slot="task-card"]')).toBe(1)
    expect(browser.text('[data-slot="task-card"]')).toContain('Needle failed')
    browser.fill(search, 'no matching task')
    expect(browser.text('[data-slot="tasks-empty"]')).toContain('No matching tasks')
    expect(browser.isVisible(search)).toBe(true)
  })

  it('retains the query while page and drawer selection stay independent across resize', () => {
    browser.fill(search, 'Needle')
    browser.click(tab('archived'))
    browser.click('[aria-label="Open menu"]')
    settle(drawer)
    browser.click(`${drawer} [aria-label="Tools"]`)
    settle('[data-slot="sidebar-session-scope"]')
    const drawerTab = '[data-slot="sidebar-session-scope"] [data-slot="view-tab"]'
    expect(browser.evaluate(`document.querySelector('${drawerTab}[data-view="active"]').getAttribute('aria-pressed')`)).toBe('true')
    browser.click(`${drawerTab}[data-view="archived"]`)
    expect(browser.evaluate(`document.querySelector('${tab('archived')}').getAttribute('aria-pressed')`)).toBe('true')
    browser.click(`${drawerTab}[data-view="active"]`)
    browser.press('Escape')
    browser.waitForFunction(`document.querySelector('[data-slot="tools-menu-content"]') === null`)
    browser.click('[aria-label="Close menu"]')
    browser.waitForFunction(`document.querySelector('${drawer}') === null`)
    expect(browser.evaluate(`document.querySelector('${tab('archived')}').getAttribute('aria-pressed')`)).toBe('true')
    browser.setViewport(1440, 900)
    expect(browser.evaluate(`document.querySelector('${search}').value`)).toBe('Needle')
    expect(browser.count('[data-slot="archive-finished"]')).toBe(0)
    browser.setViewport(360, 640)
    expect(browser.evaluate(`document.querySelector('${search}').value`)).toBe('Needle')
    expect(browser.evaluate(`document.querySelector('${tab('archived')}').getAttribute('aria-pressed')`)).toBe('true')
    expect(browser.count(actions)).toBe(0)
    expect(browser.count('[data-slot="task-card"]')).toBe(1)
  })

  it('closes a mobile actions menu on desktop resize without leaving a focus trap', () => {
    browser.click(actions)
    settle('[role="menuitem"]')
    browser.setViewport(1440, 900)
    browser.waitForFunction(`document.querySelector('[role="menuitem"]') === null`)
    browser.click(tab('archived'))
    expect(browser.evaluate(`document.querySelector('${tab('archived')}').getAttribute('aria-pressed')`)).toBe('true')
  })

  for (const reduced of [false, true]) for (const density of ['comfortable', 'compact', 'ultra']) for (const theme of ['light', 'dark']) {
    it(`fits both viewports with keyboard focus and 44px mobile targets: ${theme}/${density}/${reduced ? 'reduced' : 'normal'}`, () => {
      if (reduced) browser.setReducedMotion()
      browser.evaluate(`document.documentElement.dataset.density = '${density}'; document.documentElement.classList.toggle('light', ${theme === 'light'})`)
      for (const width of [360, 1440]) {
        browser.setViewport(width, width === 360 ? 640 : 900)
        const bounds = browser.evaluate(`(() => {
          const header = document.querySelector('[data-route="tasks"] header');
          const nodes = [...header.querySelectorAll('input, button')].filter(el => el.checkVisibility());
          return {
            overflow: document.documentElement.scrollWidth > innerWidth,
            controls: nodes.map(el => { const r = el.getBoundingClientRect(); return {width:r.width,height:r.height,left:r.left,right:r.right}; }),
            firstCard: document.querySelector('[data-slot="task-card"]')?.getBoundingClientRect().top
          };
        })()`) as { overflow: boolean; controls: { width: number; height: number; left: number; right: number }[]; firstCard: number }
        expect(bounds.overflow).toBe(false)
        for (const box of bounds.controls) {
          expect(box.left).toBeGreaterThanOrEqual(0)
          expect(box.right).toBeLessThanOrEqual(width)
          if (width === 360) {
            expect(box.width).toBeGreaterThanOrEqual(44)
            expect(box.height).toBeGreaterThanOrEqual(44)
          }
        }
        if (width === 360) expect(bounds.firstCard).toBeLessThan(640 - 44)
        focusWithKeyboard(browser, search)
        expect(browser.evaluate(`document.querySelector('${search}').matches(':focus-visible')`)).toBe(true)
        browser.screenshot(join(artifacts, `${width}-${theme}-${density}-${reduced ? 'reduced' : 'normal'}.png`), { viewport: true })
        if (width === 360) {
          focusWithKeyboard(browser, actions)
          browser.press('Enter')
          const item = '[role="menuitem"]'
          browser.waitForFunction(`document.querySelector('${item}') !== null`)
          settle(item)
          expect(browser.evaluate(`document.activeElement.textContent`)).toContain('Archive finished')
          expect(browser.evaluate(`document.querySelector('${item}').getBoundingClientRect().height`)).toBeGreaterThanOrEqual(44)
          browser.press('Escape')
          browser.waitForFunction(`document.querySelector('${item}') === null`)
          expect(browser.evaluate(`document.activeElement.getAttribute('aria-label')`)).toBe('Task actions')
        }
      }
    })
  }

  it('archives only finished fixture tasks through the real endpoint, with reduced motion', async () => {
    browser.setReducedMotion()
    browser.fill(search, 'done')
    focusWithKeyboard(browser, actions)
    browser.press('Enter')
    browser.press('Enter')
    browser.waitForFunction(`document.querySelector('${actions}') === null`)
    expect(browser.evaluate(`document.activeElement?.getAttribute('data-view')`)).toBe('active')
    const runs = await getJson<RunRecord[]>(`${baseUrl}/api/v1/runs`)
    expect(runs.filter(run => run.archived).map(run => run.id).sort()).toEqual(['cancelled', 'done', 'failed', 'old'])
    expect(runs.find(run => run.id === 'review')?.archived).toBe(false)
    expect(browser.evaluate(`document.querySelector('${search}').value`)).toBe('done')
    browser.click(tab('archived'))
    expect(browser.text('[data-slot="task-card"]')).toContain('Needle done')
    browser.click(search)
    browser.press('Control+a')
    browser.press('Backspace')
    expect(browser.evaluate(`document.querySelector('${search}').value`)).toBe('')
    browser.waitForFunction(`document.querySelectorAll('[data-slot="task-card"]').length === 4`)
    expect(browser.count('[data-slot="task-card"]')).toBe(4)
    browser.screenshot(join(artifacts, 'archived-reduced-motion.png'), { viewport: true })
  })
})
