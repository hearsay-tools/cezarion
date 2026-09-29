import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { AgentBrowser, bootProjectId, readTestEnv } from './agent-browser'
import { readSharedProjects, snapshotSharedHome, writeSharedProjects } from './workspace-registry'

/**
 * The project rail (#618), end to end: a needs-you run in a project you are NOT standing in lights
 * that project's mark, the two pills carry the right segments in the right places and inks, and
 * the rail is a desktop-only column outside the resizable sidebar.
 *
 * The other project is a throwaway git repo registered next to the boot project, with a
 * `.ai/cezar/runs.json` seeded before the server ever opens it. `GET /workspace/runs-index` reads
 * a project the process does not own straight from that file, so no server restart and no agent
 * run is involved. `review` is the terminal state that counts amber (needs your review); the
 * `done` and `failed` rows have no `seenAt`, so they are unread and count green and red.
 */

const artifactsDir = resolve(import.meta.dirname, '../../../.ai/qa/artifacts_e2e')
const sessionId = `e2e-project-rail-${process.pid}`
const repoRoot = resolve(import.meta.dirname, '../../..')
const DESKTOP = { width: 1440, height: 900 }
const MOBILE = { width: 390, height: 844 }

const OTHER = { id: 'e2e-rail-other', name: 'e2e rail other' }
const FILLERS = Array.from({ length: 14 }, (_, i) => ({ id: `e2e-rail-filler-${i}`, name: `Rail filler ${i}` }))

let browser: AgentBrowser
let baseUrl: string
let bootProject: string
let seedDir: string
let restoreHome: () => void

const now = Date.now()
const ago = (ms: number) => new Date(now - ms).toISOString()
const record = (id: string, status: string, extra: Record<string, unknown> = {}) => ({
  id,
  title: `rail ${id}`,
  workflow: 'default',
  task: `rail ${id}`,
  status,
  createdAt: ago(60 * 60_000),
  tokensUsed: 0,
  archived: false,
  steps: [],
  ...extra,
})

beforeAll(async () => {
  baseUrl = readTestEnv().baseUrl
  bootProject = await bootProjectId(baseUrl)
  restoreHome = snapshotSharedHome('config.json', 'ui-state.json')
  seedDir = mkdtempSync(join(tmpdir(), 'cezar-e2e-rail-'))

  const otherRoot = join(seedDir, 'other')
  execFileSync('git', ['init', '-q', '-b', 'main', otherRoot], { stdio: 'ignore' })
  mkdirSync(join(otherRoot, '.ai/cezar'), { recursive: true })
  writeFileSync(
    join(otherRoot, '.ai/cezar/runs.json'),
    JSON.stringify([
      record('rail-review', 'review', { finishedAt: ago(30 * 60_000) }),
      record('rail-failed', 'failed', { finishedAt: ago(20 * 60_000), error: 'boom' }),
      record('rail-done', 'done', { finishedAt: ago(10 * 60_000) }),
    ]),
  )

  const existingBoot = readSharedProjects().find((project) => project.id === bootProject)
  const fillers = FILLERS.map((project) => {
    const root = join(seedDir, project.id)
    execFileSync('git', ['init', '-q', '-b', 'main', root], { stdio: 'ignore' })
    return { ...project, root, addedAt: '2026-07-20T00:00:00Z', lastOpenedAt: '2026-07-20T00:00:00Z', source: 'local' as const }
  })
  writeSharedProjects([
    existingBoot ?? {
      id: bootProject,
      root: repoRoot,
      name: bootProject,
      addedAt: '2026-07-20T00:00:00Z',
      lastOpenedAt: '2026-07-20T12:00:00Z',
      source: 'local',
    },
    ...fillers,
    { ...OTHER, root: otherRoot, addedAt: '2026-07-19T00:00:00Z', lastOpenedAt: '2026-07-19T12:00:00Z', source: 'local' },
  ])

  browser = AgentBrowser.open(sessionId)
  browser.setViewport(DESKTOP.width, DESKTOP.height)
})

afterAll(() => {
  browser?.close()
  restoreHome?.()
  if (seedDir) rmSync(seedDir, { recursive: true, force: true })
})

const mark = (id: string) => `[data-slot="rail-project"][data-project-id="${id}"]`

/** Load the boot project with the given theme and wait for the other project's pill to arrive. */
function gotoRail(theme: 'dark' | 'light' = 'dark'): void {
  browser.goto(baseUrl + `/p/${bootProject}/`)
  browser.evaluate(`localStorage.setItem('cez-theme', ${JSON.stringify(theme)})`)
  browser.goto(baseUrl + `/p/${bootProject}/`)
  browser.waitForFunction(`document.querySelector('${mark(OTHER.id)} [data-slot="rail-pill-top"]') !== null`)
}

const style = (selector: string, prop: string) =>
  String(browser.evaluate(`getComputedStyle(document.querySelector(${JSON.stringify(selector)}))[${JSON.stringify(prop)}]`))

describe('project rail', () => {
  it('lights the top pill of a non-current project with a needs-review run', () => {
    gotoRail()
    const top = `${mark(OTHER.id)} [data-slot="rail-pill-top"]`
    expect(browser.text(`${top} [data-segment="amber"]`)).toBe('1')
    expect(browser.text(`${top} [data-segment="red"]`)).toBe('1')
    expect(browser.text(`${mark(OTHER.id)} [data-slot="rail-pill-bottom"] [data-segment="green"]`)).toBe('1')
    // The current project is quiet, and says so.
    expect(browser.count(`${mark(bootProject)} [data-slot="rail-pill-top"]`)).toBe(0)
    expect(String(browser.evaluate(`document.querySelector('${mark(OTHER.id)} a').getAttribute('aria-label')`))).toBe(
      `${OTHER.name} · 1 needs you · 1 failed · 1 finished`,
    )
    expect(String(browser.evaluate(`document.querySelector('${mark(bootProject)} a').getAttribute('aria-current')`))).toBe('page')
  })

  it('rail activation unfolds only its project and scrolls its header into the sidebar viewport', () => {
    gotoRail()
    const initial = Object.fromEntries([bootProject, ...FILLERS.map(({ id }) => id)].map(id => [id, false]))
    browser.evaluate(`localStorage.setItem('cez-sidebar-collapsed', ${JSON.stringify(JSON.stringify({ ...initial, [OTHER.id]: true }))})`)
    gotoRail()
    const group = `[data-slot="sidebar"] [data-slot="project-group"][data-project="${OTHER.id}"]`
    const scroller = '[data-slot="sidebar"] [data-slot="project-groups"]'
    expect(browser.waitForValue(`(() => {
      const target = document.querySelector('${group}')
      const viewport = document.querySelector('${scroller}')
      return target && viewport && target.getBoundingClientRect().top >= viewport.getBoundingClientRect().bottom
    })()`)).toBe(true)

    const assertAccordion = () => {
      expect(browser.waitForValue(`(() => {
        const viewport = document.querySelector('${scroller}')
        const header = document.querySelector('${group} [data-slot="project-group-header"]')
        if (!viewport || !header) return false
        const rect = header.getBoundingClientRect(), bounds = viewport.getBoundingClientRect()
        const others = [...viewport.querySelectorAll('[data-slot="project-group"]')].filter(el => el.dataset.project !== '${OTHER.id}')
        return header.getAttribute('aria-expanded') === 'true'
          && others.every(el => el.querySelector('[data-slot="project-group-header"]').getAttribute('aria-expanded') === 'false')
          && rect.top >= bounds.top && rect.bottom <= bounds.bottom
      })()`)).toBe(true)
    }
    browser.evaluate(`document.querySelector('${mark(OTHER.id)} a').scrollIntoView({ block: 'nearest' })`)
    browser.click(`${mark(OTHER.id)} a`)
    assertAccordion()
    expect(browser.waitForValue(`location.pathname`, value => value === `/p/${OTHER.id}/`)).toBe(`/p/${OTHER.id}/`)

    // The URL now stays the same: reopening a manually folded current project must still work.
    browser.evaluate(`document.querySelector('${group} [data-slot="project-group-header"]').focus()`)
    browser.press('Space')
    browser.waitForFunction(`document.querySelector('${group} [data-slot="project-group-header"]').getAttribute('aria-expanded') === 'false'`)
    browser.evaluate(`document.querySelector('${scroller}').scrollTop = 0`)
    browser.evaluate(`document.querySelector('${mark(OTHER.id)} a').focus()`)
    browser.press('Enter')
    assertAccordion()
    browser.click(`${mark(OTHER.id)} a`)
    assertAccordion()

    browser.goto(baseUrl + `/p/${OTHER.id}/`)
    expect(browser.waitForValue(`document.querySelector('${group} [data-slot="project-group-header"]')?.getAttribute('aria-expanded')`, value => value === 'true')).toBe('true')
    expect(browser.waitForValue(`document.querySelector('[data-slot="sidebar"] [data-project="${bootProject}"] [data-slot="project-group-header"]')?.getAttribute('aria-expanded')`, value => value === 'false')).toBe('false')
    browser.evaluate(`localStorage.removeItem('cez-sidebar-collapsed')`)
  })

  it('is a 60px column beside the sidebar, and resizing the sidebar leaves it alone', () => {
    gotoRail()
    const width = () => Number(browser.evaluate(`document.querySelector('[data-slot="project-rail"]').getBoundingClientRect().width`))
    const sidebar = () => Number(browser.evaluate(`document.querySelector('[data-slot="sidebar"]').getBoundingClientRect().width`))
    expect(width()).toBe(60)
    expect(Number(browser.evaluate(`document.querySelector('[data-slot="project-rail"]').getBoundingClientRect().left`))).toBe(0)
    const before = sidebar()
    browser.evaluate(`document.querySelector('[data-slot="sidebar-resize-handle"]').focus()`)
    browser.press('ArrowRight')
    browser.waitForFunction(`document.querySelector('[data-slot="sidebar"]').getBoundingClientRect().width > ${before}`)
    expect(width()).toBe(60)
    browser.evaluate(`localStorage.removeItem('cez-sidebar-width')`)
  })

  it('places the pills on the mark corners in the specified form', () => {
    gotoRail()
    const rect = (selector: string) =>
      JSON.parse(
        String(
          browser.evaluate(`JSON.stringify((({left, right, top, bottom, width, height}) => ({left, right, top, bottom, width, height}))(document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect()))`),
        ),
      ) as { left: number; right: number; top: number; bottom: number; width: number; height: number }
    const link = rect(`${mark(OTHER.id)} a`)
    const top = rect(`${mark(OTHER.id)} [data-slot="rail-pill-top"]`)
    const bottom = rect(`${mark(OTHER.id)} [data-slot="rail-pill-bottom"]`)
    expect(link.width).toBe(36)
    expect(link.height).toBe(36)
    for (const pill of [top, bottom]) {
      expect(pill.height).toBe(17)
      expect(pill.right - link.right).toBe(4)
    }
    // Two split segments, 14px each, inside the 2px cut-out border.
    expect(top.width).toBe(14 * 2 + 4)
    expect(bottom.width).toBe(18 + 4)
    expect(top.top - link.top).toBe(-6)
    expect(bottom.top - link.top).toBe(25)
    expect(style(`${mark(OTHER.id)} [data-slot="rail-pill-top"]`, 'borderTopWidth')).toBe('2px')
  })

  it('inks the segments per theme: dark ink on dark, white on light except amber', () => {
    const ink = (tone: string) => style(`${mark(OTHER.id)} [data-segment="${tone}"]`, 'color')
    gotoRail('dark')
    expect(ink('amber')).toBe('rgb(18, 23, 34)')
    expect(ink('red')).toBe('rgb(18, 23, 34)')
    expect(ink('green')).toBe('rgb(18, 23, 34)')
    gotoRail('light')
    expect(ink('amber')).toBe('rgb(18, 23, 34)')
    expect(ink('red')).toBe('rgb(255, 255, 255)')
    expect(ink('green')).toBe('rgb(255, 255, 255)')
    expect(style(`${mark(OTHER.id)} [data-segment="red"]`, 'backgroundColor')).toBe('rgb(220, 38, 38)')
    browser.evaluate(`localStorage.setItem('cez-theme', 'dark')`)
  })

  it('contains no status dots and is hidden on mobile', () => {
    gotoRail()
    expect(browser.count('[data-slot="project-rail"] [data-slot="status-dot"]')).toBe(0)
    mkdirSync(artifactsDir, { recursive: true })
    browser.screenshot(join(artifactsDir, 'project-rail-desktop.png'), { viewport: true })
    browser.setViewport(MOBILE.width, MOBILE.height)
    try {
      browser.waitForFunction(`getComputedStyle(document.querySelector('[data-slot="project-rail"]')).display === 'none'`)
    } finally {
      browser.setViewport(DESKTOP.width, DESKTOP.height)
    }
  })
})
