import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { AgentBrowser, bootProjectId, readTestEnv } from './agent-browser'
import { readSharedProjects, snapshotSharedHome, writeSharedProjects } from './workspace-registry'
import { applyContrastQaVariant, contrastQaVariants, contrastSampleExpression, restoreContrastQaDefaults, type ContrastSample } from './contrast'

/**
 * #620: the phone's top bar and project drawer, against the shared dry-run environment plus one
 * seeded second project (the way `project-rail.e2e.ts` seeds its own): a run in review, a failed
 * one and a finished one, all unread. Asserts what only a browser can: real geometry, the pills on
 * the menu button and the rows, the drawer's order and reach, and text contrast in both themes.
 */

const artifactsDir = resolve(import.meta.dirname, '../../../.ai/qa/artifacts_e2e')
const sessionId = `e2e-mobile-projects-${process.pid}`
const BAR = '[data-slot="mobile-top-bar"]'
const MENU = `${BAR} button[aria-label^="Open projects"]`
const DRAWER = '[data-slot="mobile-nav-drawer"]'

let browser: AgentBrowser
let baseUrl: string
let projectId: string
let seedDir: string
let restoreHome: () => void

const OTHER = { id: 'e2e-mobile-other', name: 'e2e mobile other' }
const ago = (ms: number) => new Date(Date.now() - ms).toISOString()
const record = (id: string, status: string, extra: Record<string, unknown> = {}) => ({
  id,
  title: `mobile ${id}`,
  workflow: 'default',
  task: `mobile ${id}`,
  status,
  createdAt: ago(60 * 60_000),
  tokensUsed: 0,
  archived: false,
  steps: [],
  ...extra,
})

beforeAll(async () => {
  baseUrl = readTestEnv().baseUrl
  projectId = await bootProjectId(baseUrl)
  restoreHome = snapshotSharedHome('config.json', 'ui-state.json')
  seedDir = mkdtempSync(join(tmpdir(), 'cezar-e2e-mobile-'))
  const otherRoot = join(seedDir, 'other')
  execFileSync('git', ['init', '-q', '-b', 'main', otherRoot], { stdio: 'ignore' })
  mkdirSync(join(otherRoot, '.ai/cezar'), { recursive: true })
  writeFileSync(
    join(otherRoot, '.ai/cezar/runs.json'),
    JSON.stringify([
      record('mobile-review', 'review', { finishedAt: ago(30 * 60_000) }),
      record('mobile-failed', 'failed', { finishedAt: ago(20 * 60_000), error: 'boom' }),
      record('mobile-done', 'done', { finishedAt: ago(10 * 60_000) }),
    ]),
  )
  const existingBoot = readSharedProjects().find((project) => project.id === projectId)
  writeSharedProjects([
    existingBoot ?? {
      id: projectId,
      root: resolve(import.meta.dirname, '../../..'),
      name: projectId,
      addedAt: '2026-07-20T00:00:00Z',
      lastOpenedAt: '2026-07-20T12:00:00Z',
      source: 'local',
    },
    { ...OTHER, root: otherRoot, addedAt: '2026-07-19T00:00:00Z', lastOpenedAt: '2026-07-19T12:00:00Z', source: 'local' },
  ])
  browser = AgentBrowser.open(sessionId)
})

afterAll(() => {
  if (browser) {
    restoreContrastQaDefaults(browser)
    browser.close()
  }
  restoreHome?.()
  if (seedDir) rmSync(seedDir, { recursive: true, force: true })
})

const phoneVariants = contrastQaVariants.filter((variant) => variant.viewport.width === 360)

describe('mobile top bar and project drawer', () => {
  for (const variant of phoneVariants) {
    it(`lays out the bar and the drawer at 360x640, ${variant.theme}, ${variant.density}`, () => {
      browser.goto(`${baseUrl}/p/${projectId}/`)
      applyContrastQaVariant(browser, variant)
      // The other project's three runs arrive with the workspace runs index.
      browser.waitForFunction(`document.querySelector(${JSON.stringify(MENU)})?.getAttribute('aria-label') === 'Open projects. Elsewhere: 1 needs you, 1 failed, 1 finished'`)

      const bar = browser.evaluate(`(() => {
        const top = document.querySelector(${JSON.stringify(BAR)})
        const row = top.firstElementChild.getBoundingClientRect()
        const menu = document.querySelector(${JSON.stringify(MENU)}).getBoundingClientRect()
        const picker = top.querySelector('[data-slot="mobile-project-picker"]')?.getBoundingClientRect()
        const search = top.querySelector('[data-slot="mobile-search"]').getBoundingClientRect()
        return {
          barHeight: row.height, menu: [menu.width, menu.height], picker: picker ? [picker.width, picker.height] : null,
          search: [search.width, search.height],
          wordmark: [...top.querySelectorAll('span')].some((node) => node.textContent.trim() === 'Cezarion'),
          overflow: document.documentElement.scrollWidth - innerWidth,
        }
      })()`) as { barHeight: number; menu: number[]; picker: number[] | null; search: number[]; wordmark: boolean; overflow: number }
      expect(bar.barHeight).toBe(56)
      expect(bar.menu).toEqual([64, 44])
      expect(bar.search[0]).toBeGreaterThanOrEqual(44)
      expect(bar.search[1]).toBeGreaterThanOrEqual(44)
      expect(bar.picker?.[1]).toBeGreaterThanOrEqual(44)
      expect(bar.wordmark).toBe(false)
      expect(bar.overflow).toBeLessThanOrEqual(0)

      // The pills are the rail's, right-aligned in the 64px button and clear of the 20px icon.
      const pills = browser.evaluate(`(() => {
        const menu = document.querySelector(${JSON.stringify(MENU)})
        const box = menu.getBoundingClientRect()
        const rect = (slot) => menu.querySelector('[data-slot="rail-pill-' + slot + '"]')?.getBoundingClientRect()
        const top = rect('top'), bottom = rect('bottom')
        return { top: [top.top - box.top, box.right - top.right, top.left - box.left], bottom: [bottom.top - box.top, box.right - bottom.right],
          topSegments: [...menu.querySelectorAll('[data-slot="rail-pill-top"] [data-segment]')].map((el) => el.getAttribute('data-segment') + ':' + el.textContent),
          bottomSegments: [...menu.querySelectorAll('[data-slot="rail-pill-bottom"] [data-segment]')].map((el) => el.getAttribute('data-segment') + ':' + el.textContent),
          picker: !!document.querySelector('[data-slot="mobile-project-picker"] [data-segment]') }
      })()`) as { top: number[]; bottom: number[]; topSegments: string[]; bottomSegments: string[]; picker: boolean }
      expect(pills.topSegments).toEqual(['amber:1', 'red:1'])
      expect(pills.bottomSegments).toEqual(['green:1'])
      expect(pills.top[0]).toBe(3)
      expect(pills.top[1]).toBe(2)
      expect(pills.top[2]).toBeGreaterThanOrEqual(30)
      expect(pills.bottom[0]).toBe(24)
      expect(pills.bottom[1]).toBe(2)
      // No count on the project button, ever.
      expect(pills.picker).toBe(false)

      browser.click(MENU)
      browser.waitForFunction(`document.querySelector(${JSON.stringify(DRAWER)})?.getBoundingClientRect().x === 0`)
      const drawer = browser.evaluate(`(() => {
        const root = document.querySelector(${JSON.stringify(DRAWER)})
        const rect = (selector) => root.querySelector(selector)?.getBoundingClientRect()
        const order = [...root.querySelectorAll('[data-slot="drawer-identity"], [data-slot="drawer-projects"], [data-slot="sidebar-content"], [data-slot="drawer-global"]')]
          .map((node) => node.getAttribute('data-slot'))
        const rows = [...root.querySelectorAll('[data-slot="drawer-project"]')].map((row) => row.getBoundingClientRect().height)
        const global = rect('[data-slot="drawer-global"]')
        const close = rect('button[aria-label="Close menu"]')
        return {
          order, rows, current: root.querySelectorAll('[data-slot="drawer-project"][aria-current="page"]').length,
          width: root.getBoundingClientRect().width, globalBottom: global.bottom, viewport: innerHeight,
          close: [close.width, close.height, close.right <= root.getBoundingClientRect().right],
          globalRows: [...root.querySelectorAll('[data-slot="drawer-global"] a, [data-slot="drawer-global"] button')].map((row) => row.getBoundingClientRect().height),
        }
      })()`) as { order: string[]; rows: number[]; current: number; width: number; globalBottom: number; viewport: number; close: [number, number, boolean]; globalRows: number[] }
      expect(drawer.order).toEqual(['drawer-identity', 'drawer-projects', 'sidebar-content', 'drawer-global'])
      expect(drawer.rows.length).toBe(2)
      for (const height of drawer.rows) expect(height).toBe(64)
      expect(drawer.current).toBe(1)
      expect(drawer.width).toBe(292)
      expect(drawer.globalBottom).toBeLessThanOrEqual(drawer.viewport)
      expect(drawer.close[0]).toBeGreaterThanOrEqual(44)
      expect(drawer.close[1]).toBeGreaterThanOrEqual(44)
      expect(drawer.close[2]).toBe(true)
      for (const height of drawer.globalRows) expect(height).toBe(48)

      const other = browser.evaluate(`(() => {
        const row = document.querySelector('${DRAWER} [data-slot="drawer-project"][data-project-id="${OTHER.id}"]')
        return { state: row.querySelector('[data-slot="drawer-project-state"]').textContent, pills: row.querySelectorAll('[data-segment]').length,
          words: [...row.querySelectorAll('[data-tone]')].map((el) => el.getAttribute('data-tone') + ':' + getComputedStyle(el).color) }
      })()`) as { state: string; pills: number; words: string[] }
      expect(other.state).toBe('1 needs you·1 failed·1 finished')
      expect(other.pills).toBe(3)
      expect(new Set(other.words.map((word) => word.split(':')[1])).size).toBe(3)

      // Text on the drawer's own surfaces: the section label and the current row's name.
      for (const [target, state] of [
        ['#drawer-projects-label', 'section label'],
        ['[data-slot="drawer-project"][aria-current="page"] span.font-semibold', 'current project name'],
      ] as const) {
        const sample = browser.evaluate(contrastSampleExpression(target)) as ContrastSample
        expect(sample.ratio, `${variant.id} ${state} ${JSON.stringify(sample)}`).toBeGreaterThanOrEqual(4.5)
      }
      browser.screenshot(`${artifactsDir}/mobile-projects-drawer-${variant.theme}.png`)

      browser.click(`${DRAWER} button[aria-label="Close menu"]`)
      browser.waitForFunction(`document.querySelector(${JSON.stringify(DRAWER)}) === null`)
    })
  }
})
