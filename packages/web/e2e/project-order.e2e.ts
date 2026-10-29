import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { AgentBrowser, bootProjectId, readTestEnv, servedRoot } from './agent-browser'
import { focusWithKeyboard } from './contrast'
import { pollFor, pollJson } from './poll'
import { readSharedProjects, snapshotSharedHome, writeSharedProjects } from './workspace-registry'

/**
 * The hand-picked project order (hearsay-tools/cezarion#438, port of open-mercato/cezar#952), end
 * to end on the project rail: a pointer drag on a collapsed mark, a keyboard reorder on the
 * expanded rail's grip and on a collapsed mark, each persisted to `~/.cezar/ui-state.json`, kept
 * across a reload and seen by a second, separate browser.
 *
 * The extra projects are throwaway git repos registered next to the boot project; the rail
 * reads the registry per request, so no restart is involved. `config.json` and `ui-state.json`
 * are snapshotted and restored, and every test starts from a cleared order through the API.
 */

const sessionId = `e2e-project-order-${process.pid}`
const secondSessionId = `e2e-project-order-second-${process.pid}`
const repoRoot = servedRoot()
const DESKTOP = { width: 1600, height: 900 }
const [A, B, C] = ['e2e-order-a', 'e2e-order-b', 'e2e-order-c'] as const
const EXTRA = [A, B, C]

let browser: AgentBrowser
let second: AgentBrowser | undefined
let baseUrl: string
let bootProject: string
let seedDir: string
let restoreHome: () => void

beforeAll(async () => {
  baseUrl = readTestEnv().baseUrl
  bootProject = await bootProjectId(baseUrl)
  restoreHome = snapshotSharedHome('config.json', 'ui-state.json')
  seedDir = mkdtempSync(join(tmpdir(), 'cezar-e2e-order-'))

  const existingBoot = readSharedProjects().find((project) => project.id === bootProject)
  writeSharedProjects([
    existingBoot ?? {
      id: bootProject,
      root: repoRoot,
      name: bootProject,
      addedAt: '2026-07-20T00:00:00Z',
      lastOpenedAt: '2026-07-20T12:00:00Z',
      source: 'local',
    },
    ...EXTRA.map((id) => {
      const root = join(seedDir, id)
      execFileSync('git', ['init', '-q', '-b', 'main', root], { stdio: 'ignore' })
      return { id, name: id, root, addedAt: '2026-07-20T00:00:00Z', lastOpenedAt: '2026-07-20T00:00:00Z', source: 'local' as const }
    }),
  ])

  browser = AgentBrowser.open(sessionId)
  browser.setViewport(DESKTOP.width, DESKTOP.height)
})

afterAll(() => {
  browser?.close()
  second?.close()
  restoreHome?.()
  if (seedDir) rmSync(seedDir, { recursive: true, force: true })
})

/** Clear the stored order through the route (the whole `sidebar` object, as the cockpit sends it). */
beforeEach(async () => {
  const current = await pollJson<{ sidebar?: Record<string, unknown> }>(`${baseUrl}/api/v1/workspace/ui-state`, AbortSignal.timeout(2_000))
  const { projectOrder: _dropped, ...sidebar } = current.sidebar ?? {}
  const res = await fetch(`${baseUrl}/api/v1/workspace/ui-state`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', origin: baseUrl },
    body: JSON.stringify({ sidebar }),
  })
  expect(res.status).toBe(200)
})

const REGISTRY_ORDER = () => [bootProject, ...EXTRA]
const mark = (id: string) => `[data-slot="rail-project"][data-project-id="${id}"]`
const ORDER_JS = `[...document.querySelectorAll('[data-slot="rail-project"]')].map((el) => el.getAttribute('data-project-id')).join(',')`

/** The rail's order, once it equals `expected`. */
function waitForRailOrder(on: AgentBrowser, expected: string[]): string {
  return on.waitForValue<string>(ORDER_JS, (value: string) => value === expected.join(','))
}

/** The stored order, once the server holds `expected`. */
function waitForStoredOrder(expected: string[]): Promise<string[]> {
  return pollFor(
    async (signal) => {
      const state = await pollJson<{ sidebar?: { projectOrder?: string[] } }>(`${baseUrl}/api/v1/workspace/ui-state`, signal)
      const stored = state.sidebar?.projectOrder
      return stored?.join(',') === expected.join(',') ? stored : undefined
    },
    () => `ui-state never stored projectOrder ${expected.join(',')}`,
  )
}

/** Lift with Space and wait until the lift has HELD across consecutive polls. dnd-kit marks the
 *  row lifted at once but adds its keydown listener in a `setTimeout` after the lift
 *  (`@dnd-kit/core` 6.3.1 `KeyboardSensor.attach`), and an arrow that lands in that gap is
 *  dropped. A held sample spans a poll interval, which that zero-delay timer has always run
 *  inside. */
function liftWithSpace(on: AgentBrowser, id: string): void {
  on.press('Space')
  on.waitForStable(`document.querySelector('${mark(id)}')?.hasAttribute('data-dragging') === true`, { holdMs: 150 })
}

/** Press a key during a keyboard drag, then wait for dnd-kit's live region to say it took. Keys
 *  sent back to back land before the sortable has processed the previous move, which a hand on a
 *  keyboard never does — so each step waits for its own announcement. */
function pressAndHear(on: AgentBrowser, key: string, announcement: string): void {
  on.press(key)
  on.waitForFunction(
    `[...document.querySelectorAll('[id^="DndLiveRegion"]')].some((el) => el.textContent.includes(${JSON.stringify(announcement)}))`,
  )
}

/** Open the boot project with the rail collapsed or expanded, and wait until it is sortable. */
function openRail(on: AgentBrowser, expanded: boolean): void {
  on.goto(baseUrl + `/p/${bootProject}/`)
  on.evaluate(`localStorage.setItem('cez-project-rail-expanded', ${JSON.stringify(expanded ? '1' : '0')})`)
  on.goto(baseUrl + `/p/${bootProject}/`)
  on.waitForFunction(
    `document.querySelector('[data-slot="project-rail"]')?.getAttribute('data-expanded') === ${JSON.stringify(String(expanded))}`
    // Sortable once the ui-state has loaded: dnd-kit attaches its instructions to the activator.
    + ` && document.querySelectorAll('[data-slot="rail-project"] [aria-describedby^="DndDescribedBy"]').length === ${REGISTRY_ORDER().length}`,
  )
}

describe('project order', () => {
  it('drags a collapsed mark with the pointer, without following its link, and keeps the order after a reload', async () => {
    openRail(browser, false)
    waitForRailOrder(browser, REGISTRY_ORDER())

    // Measured in the same poll that confirms both marks are laid out.
    const points = browser.waitForValue<{ from: { x: number; y: number }; to: { x: number; y: number } } | null>(`(() => {
      const box = (id) => document.querySelector('${mark('ID')}'.replace('ID', id))?.getBoundingClientRect()
      const from = box(${JSON.stringify(A)}), to = box(${JSON.stringify(C)})
      if (!from || !to || from.height === 0 || to.height === 0) return null
      return { from: { x: Math.round(from.x + from.width / 2), y: Math.round(from.y + from.height / 2) },
               to: { x: Math.round(to.x + to.width / 2), y: Math.round(to.y + to.height / 2) + 4 } }
    })()`)
    browser.dragHeld(points!.from, points!.to, {
      lifted: `document.querySelector('${mark(A)}')?.hasAttribute('data-dragging')`,
      // dnd-kit's live region says where the drop would land once it has measured the targets.
      over: `[...document.querySelectorAll('[id^="DndLiveRegion"]')].some((el) => el.textContent.includes('${A} moved to position 4 of 4'))`,
    })

    const expected = [bootProject, B, C, A]
    expect(waitForRailOrder(browser, expected)).toBe(expected.join(','))
    // The click that ended the drag landed on a link; it must not have navigated anywhere.
    expect(browser.waitForValue('location.pathname')).toBe(`/p/${bootProject}/`)
    expect(await waitForStoredOrder(expected)).toEqual(expected)

    browser.goto(baseUrl + `/p/${bootProject}/`)
    expect(waitForRailOrder(browser, expected)).toBe(expected.join(','))
  })

  it('reorders from the keyboard on the expanded grip, and a second browser sees the same order', async () => {
    openRail(browser, true)
    waitForRailOrder(browser, REGISTRY_ORDER())

    const grip = `${mark(C)} [data-slot="rail-project-grip"]`
    focusWithKeyboard(browser, grip)
    liftWithSpace(browser, C)
    pressAndHear(browser, 'ArrowUp', `${C} moved to position 3 of 4.`)
    pressAndHear(browser, 'ArrowUp', `${C} moved to position 2 of 4.`)
    pressAndHear(browser, 'Space', `${C} dropped at position 2 of 4.`)

    const expected = [bootProject, C, A, B]
    expect(waitForRailOrder(browser, expected)).toBe(expected.join(','))
    expect(await waitForStoredOrder(expected)).toEqual(expected)
    // Focus returns to the grip it lifted from, so the next move is one keypress away.
    expect(browser.waitForValue(`document.activeElement?.getAttribute('data-slot')`, (value) => value === 'rail-project-grip')).toBe('rail-project-grip')

    // A separate browser session: its own storage, nothing shared but the server.
    second = AgentBrowser.open(secondSessionId)
    second.setViewport(DESKTOP.width, DESKTOP.height)
    second.goto(baseUrl + `/p/${bootProject}/`)
    expect(waitForRailOrder(second, expected)).toBe(expected.join(','))
  })

  it('reorders a collapsed mark from the keyboard with Space, leaving Enter to the link', async () => {
    openRail(browser, false)
    waitForRailOrder(browser, REGISTRY_ORDER())

    // The boot mark is the page's first focusable control, so start one mark down: Tab has a
    // predecessor to come from.
    focusWithKeyboard(browser, `${mark(A)} a`)
    liftWithSpace(browser, A)
    pressAndHear(browser, 'ArrowDown', `${A} moved to position 3 of 4.`)
    pressAndHear(browser, 'Space', `${A} dropped at position 3 of 4.`)

    const expected = [bootProject, B, A, C]
    expect(waitForRailOrder(browser, expected)).toBe(expected.join(','))
    expect(await waitForStoredOrder(expected)).toEqual(expected)
    expect(browser.waitForValue('location.pathname')).toBe(`/p/${bootProject}/`)
  })
})
