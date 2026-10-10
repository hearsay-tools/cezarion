import { normalizeColorSample } from './contrast'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { waitForSettledSample } from './visual-ready'
import { expandedRailSampleExpression } from './project-rail-ready'
import { AgentBrowser, HOVER_POINTER_ARGS, bootProjectId, readTestEnv } from './agent-browser'
import { contrastSampleExpression, hoverVisiblePoint, type ContrastSample } from './contrast'
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

  browser = AgentBrowser.open(sessionId, { launchArgs: HOVER_POINTER_ARGS })
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
  String(normalizeColorSample(browser, browser.evaluate(`getComputedStyle(document.querySelector(${JSON.stringify(selector)}))[${JSON.stringify(prop)}]`)))

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

  it('rail activation replaces the current project header and task list, including repeated activation', () => {
    gotoRail()
    const header = '[data-slot="sidebar"] [data-slot="project-header-name"]'
    const assertProject = () => {
      expect(browser.waitForValue(`location.pathname`, value => value === `/p/${OTHER.id}/`)).toBe(`/p/${OTHER.id}/`)
      expect(browser.waitForValue(`document.querySelector('${header}')?.textContent`, value => value === OTHER.name)).toBe(OTHER.name)
      expect(browser.waitForValue(`document.querySelector('[data-slot="project-task-navigation"] [data-run-id="rail-review"]') !== null`)).toBe(true)
      expect(browser.count('[data-slot="project-groups"]')).toBe(0)
      expect(browser.count('[data-slot="sidebar"] [data-slot="task-quick-list"]')).toBe(1)
    }
    browser.evaluate(`document.querySelector('${mark(OTHER.id)} a').scrollIntoView({ block: 'nearest' })`)
    browser.click(`${mark(OTHER.id)} a`)
    assertProject()
    browser.evaluate(`document.querySelector('${mark(OTHER.id)} a').focus()`)
    browser.press('Enter')
    assertProject()
    browser.click(`${mark(OTHER.id)} a`)
    assertProject()
    browser.goto(baseUrl + `/p/${OTHER.id}/`)
    assertProject()
  })

  it('returns to each project\'s last page when switching, and keeps it across a reload (#728)', () => {
    browser.goto(baseUrl + `/p/${bootProject}/`)
    browser.evaluate(`localStorage.removeItem('cez-project-locations')`)
    const pathIs = (path: string) => browser.waitForValue(`location.pathname + location.search`, value => value === path)
    // The controller files a page once the registry has validated its project, so a test that
    // navigates away at once would be racing the write it is about to depend on.
    const remembered = (id: string, path: string) =>
      browser.waitForValue(`JSON.parse(localStorage.getItem('cez-project-locations') ?? '{}')[${JSON.stringify(id)}]?.pathname`, value => value === path)
    const switchTo = (id: string) => {
      browser.evaluate(`document.querySelector('${mark(id)} a').scrollIntoView({ block: 'nearest' })`)
      browser.click(`${mark(id)} a`)
    }
    gotoRail()
    browser.goto(baseUrl + `/p/${bootProject}/skills`)
    pathIs(`/p/${bootProject}/skills`)
    remembered(bootProject, `/p/${bootProject}/skills`)
    // No memory for the other project yet: its home.
    switchTo(OTHER.id)
    pathIs(`/p/${OTHER.id}/`)
    browser.goto(baseUrl + `/p/${OTHER.id}/workflows`)
    pathIs(`/p/${OTHER.id}/workflows`)
    remembered(OTHER.id, `/p/${OTHER.id}/workflows`)
    // Global pages must not overwrite either memory.
    browser.goto(baseUrl + '/settings/global/appearance')
    browser.waitForValue(`location.pathname`, value => value === '/settings/global/appearance')
    browser.waitForFunction(`document.querySelector('${mark(bootProject)} a') !== null`)
    switchTo(bootProject)
    pathIs(`/p/${bootProject}/skills`)
    switchTo(OTHER.id)
    pathIs(`/p/${OTHER.id}/workflows`)
    // Persisted: a reload lands the keyboard on the same remembered page.
    browser.goto(baseUrl + `/p/${bootProject}/skills`)
    pathIs(`/p/${bootProject}/skills`)
    browser.waitForFunction(`document.querySelector('${mark(OTHER.id)} a') !== null`)
    browser.evaluate(`document.querySelector('${mark(OTHER.id)} a').focus()`)
    browser.press('Enter')
    pathIs(`/p/${OTHER.id}/workflows`)
    // A task page that still exists comes back whole, query and hash included.
    browser.goto(baseUrl + `/p/${OTHER.id}/tasks/rail-review?x=1#frag`)
    remembered(OTHER.id, `/p/${OTHER.id}/tasks/rail-review`)
    switchTo(bootProject)
    pathIs(`/p/${bootProject}/skills`)
    switchTo(OTHER.id)
    pathIs(`/p/${OTHER.id}/tasks/rail-review?x=1`)
    // A page the server confirms is gone degrades to the project home.
    browser.goto(baseUrl + `/p/${bootProject}/`)
    browser.waitForFunction(`document.querySelector('${mark(OTHER.id)} [data-slot="rail-pill-top"]') !== null`)
    remembered(bootProject, `/p/${bootProject}/`)
    browser.evaluate(`localStorage.setItem('cez-project-locations', JSON.stringify({ ${JSON.stringify(OTHER.id)}: { projectId: ${JSON.stringify(OTHER.id)}, pathname: '/p/${OTHER.id}/tasks/deleted-run' } }))`)
    // The rail's links are resolved on render, so the seeded memory is picked up by a fresh load.
    browser.goto(baseUrl + `/p/${bootProject}/`)
    browser.waitForFunction(`document.querySelector('${mark(OTHER.id)} [data-slot="rail-pill-top"]') !== null`)
    switchTo(OTHER.id)
    pathIs(`/p/${OTHER.id}/`)
    browser.evaluate(`localStorage.removeItem('cez-project-locations')`)
  })

  it('is a 60px column beside the sidebar, and resizing the sidebar leaves it alone', () => {
    gotoRail()
    const width = () => Number(waitForSettledSample(browser, `document.querySelector('[data-slot="project-rail"]').getBoundingClientRect().width`))
    const sidebar = () => Number(waitForSettledSample(browser, `document.querySelector('[data-slot="sidebar"]').getBoundingClientRect().width`))
    expect(width()).toBe(60)
    expect(Number(waitForSettledSample(browser, `document.querySelector('[data-slot="project-rail"]').getBoundingClientRect().left`))).toBe(0)
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
          waitForSettledSample(browser, `JSON.stringify((({left, right, top, bottom, width, height}) => ({left, right, top, bottom, width, height}))(document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect()))`),
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

describe('expandable project rail (#711)', () => {
  const RAIL = '[data-slot="project-rail"]'
  const TOGGLE = '[data-slot="rail-expand-toggle"]'
  const box = (selector: string) =>
    waitForSettledSample(browser, `(() => { const r = document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect(); return r ? { left: r.left, width: r.width } : null })()`) as { left: number; width: number } | null
  // #795 loaded trace: body stability can hold before a reloaded rail mounts.
  // Observe the expanded commit/native rendering, then hold actual width/opacity.
  // Existing finite-animation readiness waits out #711's 160ms width transition
  // and 120ms text fade after a 160ms delay; geometry/ink limits remain assertions.
  const settledExpanded = () => {
    const facts = waitForSettledSample<{ width: number; opacity: string }>(browser, expandedRailSampleExpression())
    expect(facts.width).toBe(232)
    expect(facts.opacity).toBe('1')
  }
  const collapse = () => browser.evaluate(`localStorage.removeItem('cez-project-rail-expanded')`)

  it('expands to 232px from the bottom group, pushes main, keeps the sidebar, and survives a reload', () => {
    gotoRail()
    collapse()
    browser.goto(baseUrl + `/p/${bootProject}/`)
    browser.waitForFunction(`document.querySelector('${TOGGLE}') !== null`)
    expect(String(browser.evaluate(`document.querySelector('${TOGGLE}').getAttribute('aria-expanded')`))).toBe('false')
    expect(String(browser.evaluate(`document.querySelector('[data-slot="rail-bottom"]').firstElementChild.getAttribute('data-slot')`))).toBe('rail-expand-toggle')
    const sidebarBefore = box('[data-slot="sidebar"]')!
    const mainBefore = box('main')!
    browser.click(TOGGLE)
    settledExpanded()
    expect(String(browser.evaluate(`document.querySelector('${TOGGLE}').getAttribute('aria-expanded')`))).toBe('true')
    expect(box('[data-slot="sidebar"]')!.width).toBe(sidebarBefore.width)
    expect(box('[data-slot="sidebar"]')!.left).toBe(sidebarBefore.left + 172)
    expect(box('main')!.width).toBe(mainBefore.width - 172)
    const other = `${mark(OTHER.id)} a`
    expect(browser.text(`${other} [data-slot="rail-project-name"]`)).toBe(OTHER.name)
    // Two words at most; the third (finished) stays on the pill and in the accessible name.
    expect(String(browser.evaluate(`document.querySelector('${other} [data-slot="rail-project-state"]').textContent`))).toBe('1 needs you·1 failed')
    expect(String(browser.evaluate(`document.querySelector('${other}').getAttribute('aria-label')`))).toBe(`${OTHER.name} · 1 needs you · 1 failed · 1 finished`)
    const row = box(other)!
    // 232px less the 1px right border and 10px padding each side.
    expect(row.width).toBe(211)
    mkdirSync(artifactsDir, { recursive: true })
    browser.screenshot(join(artifactsDir, 'project-rail-expanded-dark.png'), { viewport: true })

    browser.goto(baseUrl + `/p/${bootProject}/`)
    settledExpanded()
    browser.click(TOGGLE)
    browser.waitForFunction(`document.querySelector('${RAIL}').getBoundingClientRect().width === 60`)
    expect(String(browser.evaluate(`localStorage.getItem('cez-project-rail-expanded')`))).toBe('0')
  })

  it('collapses and hides the toggle when main would drop under 640px, and restores on widening', () => {
    gotoRail()
    browser.evaluate(`localStorage.setItem('cez-project-rail-expanded', '1')`)
    browser.goto(baseUrl + `/p/${bootProject}/`)
    settledExpanded()
    // 1100 - 232 - 264 = 604px for main: under the floor.
    browser.setViewport(1100, DESKTOP.height)
    try {
      browser.waitForFunction(`document.querySelector('${RAIL}').getBoundingClientRect().width === 60 && document.querySelector('${TOGGLE}') === null`)
      expect(String(browser.evaluate(`localStorage.getItem('cez-project-rail-expanded')`))).toBe('1')
    } finally {
      browser.setViewport(DESKTOP.width, DESKTOP.height)
    }
    settledExpanded()
    collapse()
  })

  for (const theme of ['dark', 'light'] as const) {
    it(`keeps names and state words at 4.5:1 on default, hover and selected rows, ${theme}`, () => {
      gotoRail(theme)
      browser.evaluate(`localStorage.setItem('cez-project-rail-expanded', '1')`)
      const other = `${mark(OTHER.id)} a`
      const targets = [
        `${other} [data-slot="rail-project-name"]`,
        `${other} [data-tone="amber"]`,
        `${other} [data-tone="red"]`,
      ]
      const check = (state: string) => {
        for (const target of targets) {
          const sample = browser.evaluate(contrastSampleExpression(target)) as ContrastSample
          expect(sample.ratio, `${theme} ${state} ${target} ${JSON.stringify(sample)}`).toBeGreaterThanOrEqual(4.5)
        }
      }
      // Default and hover: the other project's row while standing in the boot project.
      browser.goto(baseUrl + `/p/${bootProject}/`)
      settledExpanded()
      browser.evaluate(`document.querySelector('${other}').scrollIntoView({ block: 'nearest' })`)
      check('default')
      // A real pointer hover. The session launches with HOVER_POINTER_ARGS, so `(hover: hover)`
      // matches and Tailwind's `hover:` fill really paints; wait for it before sampling.
      hoverVisiblePoint(browser, other)
      browser.waitForFunction(`getComputedStyle(document.querySelector('${other}')).backgroundColor !== 'rgba(0, 0, 0, 0)'`)
      check('hover')
      // Selected: the same row once it is the current project.
      browser.goto(baseUrl + `/p/${OTHER.id}/`)
      settledExpanded()
      browser.waitForFunction(`document.querySelector('${other}')?.getAttribute('aria-current') === 'page'`)
      browser.evaluate(`document.querySelector('${other}').scrollIntoView({ block: 'nearest' })`)
      check('selected')
      browser.screenshot(join(artifactsDir, `project-rail-expanded-selected-${theme}.png`), { viewport: true })
      collapse()
      browser.evaluate(`localStorage.setItem('cez-theme', 'dark')`)
    })
  }

  // Last: reduced motion cannot be switched back off in this session.
  it('does not animate the width under reduced motion', () => {
    browser.setReducedMotion()
    gotoRail()
    collapse()
    browser.goto(baseUrl + `/p/${bootProject}/`)
    browser.waitForFunction(`matchMedia('(prefers-reduced-motion: reduce)').matches && document.querySelector('${TOGGLE}') !== null`)
    expect(style(RAIL, 'transitionProperty')).toBe('none')
    browser.click(TOGGLE)
    // No transition: the width is final on the next frame, with no wait for a settle.
    expect(waitForSettledSample(browser, `document.querySelector('${RAIL}').getBoundingClientRect().width`)).toBe(232)
    collapse()
  })
})
