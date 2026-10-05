import type { ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { AgentBrowser, bootProjectId, cezarCli, fixtureServeEnv } from './agent-browser'
import { spawnFixtureServer, stopFixtureServer, waitForFixtureServer } from './fixture-server'
import { waitForSettledSample } from './visual-ready'
import { focusWithKeyboard } from './contrast'

const artifacts = resolve(import.meta.dirname, '../../../.ai/qa/artifacts_e2e/sidebar-limits')
let browser: AgentBrowser
let server: ChildProcess
let root: string
let base: string
let project: string
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'cez-sidebar-limits-'))
  mkdirSync(join(root, '.ai/cezar'), { recursive: true })
  mkdirSync(artifacts, { recursive: true })
  const runs = ['waiting', 'done', 'running'].flatMap((status, section) => Array.from({ length: 4 }, (_, i) => ({
    id: `limit-${section}-${i}`, title: `${['Needs attention', 'Finished task', 'Working task'][section]} ${i + 1}`, task: 'Sidebar fixture',
    workflow: 'quick-task', runner: 'claude', status: status === 'running' ? 'failed' : status, ...(status === 'running' ? { autoResumeAt: new Date(Date.now() + 86_400_000).toISOString() } : {}), createdAt: new Date(Date.now() - i * 60000).toISOString(),
    tokensUsed: 0, archived: false, steps: [],
  })))
  writeFileSync(join(root, '.ai/cezar/runs.json'), JSON.stringify(runs))
  server = spawnFixtureServer([cezarCli, 'serve', '--repo', root, '--port', '0', '--no-open'], {
    env: fixtureServeEnv(root, { CEZ_SKILLS_AUTO_UPDATE: '0' }), stdio: 'ignore',
  })
  base = await waitForFixtureServer(server)
  project = await bootProjectId(base)
  browser = AgentBrowser.open(`sidebar-limits-${process.pid}`)
}, 90_000)
afterAll(async () => {
  browser?.close()
  await stopFixtureServer(server)
  if (root) rmSync(root, { recursive: true, force: true })
})

for (const width of [1440, 360]) for (const theme of ['light', 'dark']) {
  it(`${width}px ${theme}: saves with keyboard, reloads, and caps sidebar with usable targets`, async () => {
    await fetch(`${base}/api/v1/p/${project}/ui-state`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sidebarLimits: {} }) })
    browser.setViewport(width, width === 360 ? 640 : 900)
    browser.goto(`${base}/p/${project}/settings/sidebar`)
    browser.waitForFunction(`document.querySelector('#sidebar-overall')?.value === '10'`)
    browser.evaluate(`localStorage.setItem('cez-theme', '${theme}'); document.documentElement.classList.remove('light', 'dark'); document.documentElement.classList.add('${theme}')`)
    browser.setReducedMotion()
    browser.fill('#sidebar-overall', '0')
    expect(browser.waitForValue(`document.querySelector('#sidebar-overall').getAttribute('aria-invalid')`)).toBe('true')
    browser.fill('#sidebar-overall', '3')
    browser.press('ArrowUp')
    expect(browser.waitForValue(`document.querySelector('#sidebar-overall').value`, value => value === '4')).toBe('4')
    browser.fill('#sidebar-overall', '3')
    for (const [key, label] of [['needsYou', 'Needs You'], ['finished', 'Finished'], ['working', 'Working']]) {
      focusWithKeyboard(browser, `[aria-label="${label} Unlimited"]`)
      browser.press('Space')
      browser.waitForFunction(`!document.querySelector('#sidebar-${key}').disabled`)
      browser.fill(`#sidebar-${key}`, '1')
    }
    focusWithKeyboard(browser, '[data-slot="sidebar-settings"] button[type="submit"]')
    browser.press('Enter')
    browser.waitForFunction(`document.querySelector('[data-slot="sidebar-settings"] [role="status"]')?.textContent === 'Sidebar limits saved.'`)
    browser.goto(`${base}/p/${project}/settings/sidebar`)
    browser.waitForFunction(`document.querySelector('#sidebar-overall')?.value === '3' && document.querySelector('#sidebar-working')?.value === '1'`)
    const facts = waitForSettledSample(browser, `(() => {
      const form = document.querySelector('[data-slot="sidebar-settings"]');
      const targets = [...form.querySelectorAll('input[type="number"], button, label:has(input[type="checkbox"])')];
      return { overflow: document.documentElement.scrollWidth > innerWidth,
        targets: targets.map(el => ({ width: el.getBoundingClientRect().width, height: el.getBoundingClientRect().height })),
        reduced: matchMedia('(prefers-reduced-motion: reduce)').matches,
        moving: form.getAnimations({ subtree: true }).filter(a => a.playState === 'running').length };
    })()`) as { overflow: boolean; targets: Array<{ width: number; height: number }>; reduced: boolean; moving: number }
    expect(facts.overflow).toBe(false); expect(facts.reduced).toBe(true); expect(facts.moving).toBe(0)
    for (const target of facts.targets) { expect(target.height).toBeGreaterThanOrEqual(44); expect(target.width).toBeGreaterThanOrEqual(44) }
    browser.screenshot(join(artifacts, `settings-${width}-${theme}.png`))
    browser.evaluate(`document.querySelector('[data-slot="sidebar-settings"] button[type="submit"]').scrollIntoView({ block: 'center' })`)
    waitForSettledSample(browser, `document.querySelector('[data-slot="sidebar-settings"] button[type="submit"]').getBoundingClientRect().top`)
    browser.screenshot(join(artifacts, `settings-controls-${width}-${theme}.png`), { viewport: true })
    browser.goto(`${base}/p/${project}/`)
    if (width === 360) browser.click('button[aria-label^="Open projects"]')
    const container = width === 360 ? '[data-slot="drawer-tasks"]' : '[data-slot="sidebar"]'
    const rows = browser.waitForValue(`Array.from(document.querySelectorAll('${container} [data-slot="task-row"]')).map(el => el.dataset.runId)`, value => Array.isArray(value) && value.length === 3)
    expect(rows).toEqual(['limit-0-0', 'limit-1-0', 'limit-2-0'])
    waitForSettledSample(browser, `document.querySelector('${container}').getBoundingClientRect().width`)
    browser.screenshot(join(artifacts, `sidebar-${width}-${theme}.png`), { viewport: true })
  }, 120_000)
}
