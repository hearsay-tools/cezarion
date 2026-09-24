import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'

import { AgentBrowser, cezarCli, fixtureServeEnv } from './agent-browser'
import { waitForHealth } from './poll'

let browser: AgentBrowser
let server: ChildProcess
let root: string
let baseUrl: string

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'cez-picker-layout-'))
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args])
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'e2e@cezar.test')
  git('config', 'user.name', 'cezar e2e')
  writeFileSync(join(root, 'README.md'), '# Picker layout fixture\n')
  const opencode = join(root, 'opencode-fixture')
  writeFileSync(opencode, '#!/bin/sh\necho 1.0.0\n')
  chmodSync(opencode, 0o755)
  git('add', '.')
  git('commit', '-qm', 'init')

  const probe = createServer()
  const port = await new Promise<number>((resolve, reject) => {
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port = typeof address === 'object' && address ? address.port : 0
      probe.close(() => resolve(port))
    })
  })
  baseUrl = `http://127.0.0.1:${port}`
  server = spawn(process.execPath, [cezarCli, 'serve', '--repo', root, '--port', String(port), '--no-open'], {
    env: fixtureServeEnv(root, { CEZ_OPENCODE_BIN: opencode }), stdio: 'ignore',
  })
  await waitForHealth(baseUrl)
  browser = AgentBrowser.open(`picker-layout-${process.pid}`)
  browser.setViewport(1440, 900)
  browser.goto(`${baseUrl}/new`)
  browser.waitForFunction(`document.querySelector('[data-slot="effort-pill"]')?.checkVisibility() === true && document.querySelector('[data-slot="version-chip"]') !== null`)
}, 180_000)

afterAll(async () => {
  browser?.close()
  if (server?.pid && server.exitCode === null && server.signalCode === null) {
    const exit = once(server, 'exit')
    server.kill()
    await exit
  }
  if (root) rmSync(root, { recursive: true, force: true })
})

type Box = { left: number; right: number; top: number; bottom: number; width: number; height: number }
type Layout = { runner: Box; model: Box; effort: Box; group: Box; sidebarWidth: number; viewportOverflow: boolean; clipped: string[]; truncated: string[]; hiddenFieldNames: string[] }

function layout(): Layout {
  return browser.evaluate(`(() => {
    const group = document.querySelector('[data-slot="agent-options"]');
    const get = (slot) => { const r = group.querySelector('[data-slot="' + slot + '"]').getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; };
    const r = group.getBoundingClientRect();
    return {
      runner: get('runner-pill'), model: get('model-pill'), effort: get('effort-pill'),
      group: { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height },
      sidebarWidth: document.querySelector('[data-slot="sidebar"]')?.getBoundingClientRect().width ?? 0,
      viewportOverflow: document.documentElement.scrollWidth > innerWidth,
      clipped: [...group.querySelectorAll('[data-slot$="pill"]')].filter(el => {
        const box = el.getBoundingClientRect();
        return box.left < r.left - 1 || box.right > r.right + 1;
      }).map(el => el.getAttribute('data-slot')),
      truncated: [...group.querySelectorAll('[data-slot$="pill"]')].filter(el => {
        const label = el.querySelector('span.min-w-0');
        return label && label.scrollWidth > label.clientWidth + 1;
      }).map(el => el.getAttribute('data-slot')),
      hiddenFieldNames: ['runner-pill', 'effort-pill'].filter(slot => {
        const prefix = group.querySelector('[data-slot="' + slot + '"] > span > span');
        return getComputedStyle(prefix).display === 'none';
      }),
    };
  })()`) as Layout
}

it('lays out New Task pickers in reading order without clipping at desktop, narrow desktop, and mobile widths', () => {
  for (const theme of ['dark', 'light']) {
    const sizes: Array<[number, number]> = [[1440, 264], [1440, 420], [1280, 264], [768, 420], [767, 0], [360, 0], [500, 0]]
    for (const [width, sidebar] of sizes) {
      browser.setViewport(width, 900)
      browser.evaluate(`localStorage.setItem('cez-sidebar-width', '${sidebar}')`)
      browser.goto(`${baseUrl}/new`)
      browser.waitForFunction(`document.querySelector('[data-slot="runner-pill"]')?.checkVisibility() === true`)
      browser.evaluate(`document.documentElement.classList.toggle('light', ${theme === 'light'})`)
      // Exercise the long selected values at every layout size, not just on desktop.
      browser.click('[data-slot="runner-pill"]')
      browser.waitForFunction(`document.querySelector('[data-testid="runner-pill-menu"] [role="menuitemradio"]') !== null`)
      const runnerIndex = browser.evaluate(`[...document.querySelectorAll('[data-testid="runner-pill-menu"] [role="menuitemradio"]')].findIndex(el => el.textContent.includes('opencode')) + 1`) as number
      expect(runnerIndex).toBeGreaterThan(0)
      browser.click(`[data-testid="runner-pill-menu"] [role="menuitemradio"]:nth-child(${runnerIndex})`)
      browser.waitForFunction(`document.querySelector('[data-slot="runner-pill"]')?.textContent?.includes('opencode') === true`)
      browser.click('[data-slot="effort-pill"]')
      browser.waitForFunction(`document.querySelector('[data-testid="effort-pill-menu"] [role="menuitemradio"]') !== null`)
      const effortIndex = browser.evaluate(`[...document.querySelectorAll('[data-testid="effort-pill-menu"] [role="menuitemradio"]')].findIndex(el => el.textContent.includes('medium')) + 1`) as number
      expect(effortIndex).toBeGreaterThan(0)
      browser.click(`[data-testid="effort-pill-menu"] [role="menuitemradio"]:nth-child(${effortIndex})`)
      browser.waitForFunction(`document.querySelector('[data-slot="effort-pill"]')?.textContent?.includes('medium') === true`)
      expect(browser.text('[data-slot="runner-pill"]')).toContain('opencode')
      expect(browser.text('[data-slot="effort-pill"]')).toContain('medium')
      const boxes = layout()
      if (sidebar === 420) expect(boxes.sidebarWidth).toBe(420)
      if ((width === 1280 && sidebar === 264) || (width === 1440 && sidebar === 420)) {
        expect(boxes.group.width).toBeGreaterThanOrEqual(550)
        expect(boxes.group.width).toBeLessThan(600)
      }
      if (width === 360 || width === 500) expect(boxes.hiddenFieldNames, `${width}px: field names hidden`).toEqual([])
      expect(boxes.viewportOverflow, `${width}px ${theme}: page overflow`).toBe(false)
      expect(boxes.clipped, `${width}px ${theme}: clipped picker labels or boxes`).toEqual([])
      const truncatedValues = boxes.truncated.filter((slot) => slot !== 'model-pill')
      expect(truncatedValues, `${width}px ${theme}: selected values truncated`).toEqual([])
      if (width === 1440 && sidebar === 264) expect(boxes.truncated, `${theme}: desktop labels truncated`).toEqual([])
      for (const pill of [boxes.runner, boxes.model, boxes.effort]) expect(pill.height).toBeGreaterThanOrEqual(44)
      if (width >= 1280) {
        expect(boxes.runner.top).toBe(boxes.model.top)
        expect(boxes.model.top).toBe(boxes.effort.top)
        expect(boxes.runner.right).toBeLessThan(boxes.model.left)
        expect(boxes.model.right).toBeLessThan(boxes.effort.left)
        expect(boxes.runner.width).toBeLessThanOrEqual(230)
        expect(boxes.effort.width).toBeLessThanOrEqual(210)
        expect(boxes.runner.width).toBe(210)
        expect(boxes.effort.width).toBe(180)
        if (width === 1440 && sidebar === 264) {
          expect(boxes.model.width).toBeGreaterThan(boxes.runner.width)
          expect(boxes.model.width).toBeGreaterThan(boxes.effort.width)
        }
      } else {
        expect(boxes.runner.top).toBe(boxes.effort.top)
        expect(boxes.runner.right).toBeLessThan(boxes.effort.left)
        expect(boxes.model.top).toBeGreaterThanOrEqual(boxes.runner.bottom)
        expect(boxes.model.left).toBeCloseTo(boxes.group.left, 0)
        expect(boxes.model.right).toBeCloseTo(boxes.group.right, 0)
      }
    }
  }
})

it('Tabs through picker controls in their visual reading order across compact and wide layouts', () => {
  for (const [width, sidebar, order] of [
    [360, 0, ['runner-pill', 'effort-pill', 'model-pill']],
    [768, 420, ['runner-pill', 'effort-pill', 'model-pill']],
    [1280, 264, ['runner-pill', 'model-pill', 'effort-pill']],
    [1440, 420, ['runner-pill', 'model-pill', 'effort-pill']],
    [1440, 264, ['runner-pill', 'model-pill', 'effort-pill']],
  ] as const) {
    browser.setViewport(width, 900)
    browser.evaluate(`localStorage.setItem('cez-sidebar-width', '${sidebar}')`)
    browser.goto(`${baseUrl}/new`)
    browser.waitForFunction(`document.querySelector('[data-slot="runner-pill"]')?.checkVisibility() === true`)
    const boxes = layout()
    if (order[1] === 'model-pill') expect(boxes.runner.top, `${width}px/${sidebar}px sidebar`).toBe(boxes.model.top)
    else expect(boxes.runner.top, `${width}px/${sidebar}px sidebar`).toBe(boxes.effort.top)
    browser.evaluate(`document.querySelector('[data-slot="runner-pill"]').focus()`)
    for (const slot of order) {
      expect(browser.evaluate(`document.activeElement?.getAttribute('data-slot')`), `${width}px/${sidebar}px sidebar: Tab focus`).toBe(slot)
      browser.press('Tab')
    }
  }
})

it('lets Model occupy the freed desktop track when Runner is unavailable', () => {
  browser.setViewport(1440, 900)
  browser.goto(`${baseUrl}/new`)
  browser.waitForFunction(`document.querySelector('[data-slot="runner-pill"]')?.checkVisibility() === true`)
  // The real app renders no Runner pill with a single provider. Clone the rendered controls
  // into a test-owned container so Chrome applies the route CSS without mutating React's tree.
  const boxes = browser.evaluate(`(() => {
    const wrapper = document.createElement('div');
    wrapper.dataset.route = 'new';
    const container = document.createElement('div');
    container.dataset.slot = 'composer-agent-options';
    container.style.width = '734px';
    const group = document.querySelector('[data-slot="agent-options"]').cloneNode(true);
    group.querySelector('[data-slot="runner-pill"]').remove();
    container.append(group); wrapper.append(container); document.body.append(wrapper);
    const bounds = (el) => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, width: r.width }; };
    const result = {
      group: bounds(group), model: bounds(group.querySelector('[data-slot="model-pill"]')),
      effort: bounds(group.querySelector('[data-slot="effort-pill"]')),
    };
    wrapper.remove();
    return result;
  })()`) as { group: Box; model: Box; effort: Box }
  expect(boxes.model.left).toBeCloseTo(boxes.group.left, 0)
  expect(boxes.model.right).toBeLessThan(boxes.effort.left)
  expect(boxes.effort.right).toBeCloseTo(boxes.group.right, 0)
  expect(boxes.model.width).toBeGreaterThan(boxes.effort.width)
})
