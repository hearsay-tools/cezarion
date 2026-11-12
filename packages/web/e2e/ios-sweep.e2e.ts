import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { waitForSettledSample } from './visual-ready'
import { AgentBrowser, bootProjectId, readTestEnv, servedRoot } from './agent-browser'
import { waitForStatus } from './poll'

/**
 * The R7 iOS sweep (spec step 21): every primary view at an iPhone viewport (390×844 CSS px),
 * against the shared dry-run environment. Per view this asserts the three things a phone user
 * cannot live without and a desktop-run suite never notices:
 *
 *   1. no horizontal overflow — `document.documentElement.scrollWidth <= window.innerWidth`
 *      (a page that scrolls sideways on a phone is broken, whatever else works);
 *   2. the mobile chrome is reachable — the top bar's drawer menu button exists and is visible,
 *      because below `md` it is the ONLY way to the nav;
 *   3. a screenshot into the e2e artifacts dir, so a checkpoint reviewer sees what an iPhone sees.
 *
 * The drawer's own behavior (open/close/navigate/overflow-while-open) is smoke.e2e.ts territory
 * and is not re-proven here — this file is about every VIEW fitting the phone, not the chrome.
 *
 * Degradation matrix — only the honestly reachable states run live; the rest are already pinned:
 *   - forge OFF: github.e2e.ts's gating spec asserts whichever branch the LIVE health payload
 *     reports (nav item present iff available), and the structural forge-off branches (hidden
 *     nav item, unavailable explainer) are pinned by the unit suites (nav-items/app-shell/
 *     command-palette tests, github.test.tsx). Here `/github` runs only when the live health
 *     payload reports the forge available — same gate as github.e2e.ts.
 *   - no web/dist: the built-in "run `npm run build:web`" hint page is pinned by the unit tests
 *     on `resolveIndexHtml` (src/server/static-ui.test.ts, R7 Step 1.1). Booting a second,
 *     dist-less environment here would re-prove a pure function — not worth a live spec.
 */

const artifactsDir = resolve(import.meta.dirname, '../../../.ai/qa/artifacts_e2e')
const sessionId = `e2e-ios-${process.pid}`

const IPHONE = { width: 390, height: 844 } // iPhone 14/15 CSS pixels

/** The skills view needs one skill row. This spec seeds it rather than counting on the skills
 *  the host or this checkout happens to have (README.md, "Seed the catalog entries a spec
 *  relies on", hearsay-tools/cezarion#1683). */
const skillsDir = resolve(servedRoot(), '.ai/skills')
const SKILL = 'e2e-ios-sweep-skill'

/** The entry point to the project drawer below `md` on list screens (see app-shell.tsx MobileTopBar). */
const MENU_BUTTON = '[data-slot="mobile-top-bar"] button[aria-label^="Open projects"]'

/** The pushed screen's way out (app-shell.tsx PushedTopBar). */
const BACK_BUTTON = '[data-slot="mobile-top-bar"] [data-slot="mobile-back"]'

let browser: AgentBrowser
let baseUrl: string
let forgeAvailable = false
let createdSkillsDir = false
/** The task-thread view's subject: a dry run this spec starts and settles. */
let threadRunId: string

async function api<T>(path: string): Promise<T> {
  const res = await fetch(`${baseUrl}${path}`)
  if (!res.ok) throw new Error(`cezar e2e: GET ${path} answered ${res.status}`)
  return (await res.json()) as T
}


beforeAll(async () => {
  baseUrl = readTestEnv().baseUrl
  const health = (await api<{ forge: { available: boolean } | null }>('/api/v1/health'))
  forgeAvailable = health.forge?.available === true

  createdSkillsDir = !existsSync(skillsDir)
  mkdirSync(skillsDir, { recursive: true })
  writeFileSync(
    resolve(skillsDir, `${SKILL}.md`),
    `---\nname: ${SKILL}\ndescription: An e2e-seeded project skill\n---\n\nDo the sweep thing.\n`,
    'utf8',
  )

  // The thread view needs a run. The spec starts its own dry run rather than reading whatever an
  // earlier spec left on the shared server, so the swept thread is the same in every order. It
  // settles the run via /finish, so the shared env is never left holding an open session another
  // spec would trip over.
  const created = (await (
    await fetch(`${baseUrl}/api/v1/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ task: 'Say hello to the iOS sweep.', workflow: 'quick-task' }),
    })
  ).json()) as { id: string }
  threadRunId = created.id
  // The dry-run mock makes no cezar_done call, so the run parks at `waiting`.
  const status = await waitForStatus(baseUrl, threadRunId, ['waiting', 'review', 'done', 'failed'])
  if (status === 'waiting') {
    await fetch(`${baseUrl}/api/v1/runs/${threadRunId}/finish`, { method: 'POST' })
    await waitForStatus(baseUrl, threadRunId, ['review', 'done', 'failed'])
  }

  browser = AgentBrowser.open(sessionId)
  browser.setViewport(IPHONE.width, IPHONE.height)
}, 180_000)

afterAll(() => {
  // Never leave test skills in a developer's catalog.
  rmSync(resolve(skillsDir, `${SKILL}.md`), { force: true })
  if (createdSkillsDir) rmSync(skillsDir, { recursive: true, force: true })
  browser?.close()
})

/** One view's sweep: settle it, then assert the three phone invariants and shoot it.
 *  `ready` waits on real view content (not just the route div) because the lazy routes render
 *  a loading skeleton under the same `data-route` — sampling that would measure the wrong page. */
function sweep(slug: string, path: string, ready: string, chrome: 'list' | 'pushed' = 'list'): void {
  browser.goto(baseUrl + path)
  browser.waitForFunction(`document.querySelector(${JSON.stringify(ready)}) !== null`)

  // The mobile chrome is reachable. A list screen has the drawer trigger (the way to the project
  // list) — its absence strands the user on whatever view they deep-linked. A pushed screen (an
  // opened task, #621) swaps it for Back, the way out to the list, and shows no tab bar.
  if (chrome === 'pushed') {
    expect(browser.count(BACK_BUTTON)).toBe(1)
    expect(browser.isVisible(BACK_BUTTON)).toBe(true)
    expect(browser.count(MENU_BUTTON)).toBe(0)
    expect(browser.count('[data-slot="mobile-tab-bar"]')).toBe(0)
  } else {
    expect(browser.count(MENU_BUTTON)).toBe(1)
    expect(browser.isVisible(MENU_BUTTON)).toBe(true)
  }

  // `<=`, not `===`: the document may be narrower than the viewport, never wider.
  const [scrollWidth, innerWidth] = waitForSettledSample(browser,
    `[document.documentElement.scrollWidth, window.innerWidth]`,
  ) as [number, number]
  expect(scrollWidth, `${path} overflows the iPhone viewport horizontally`).toBeLessThanOrEqual(
    innerWidth,
  )

  // Viewport capture, not full-page: the sweep documents what an iPhone frame shows, and
  // full-page stitching is pathological on the virtualized thread (see agent-browser.ts).
  browser.screenshot(`${artifactsDir}/ios-${slug}.png`, { viewport: true })
}

describe('iOS sweep — every primary view at 390×844', () => {
  it('/ (tasks overview)', async () => {
    browser.goto(`${baseUrl}/p/${await bootProjectId(baseUrl)}`)
    browser.waitForFunction(`document.querySelector('[data-route="tasks"]') !== null`)
    browser.evaluate(`localStorage.removeItem('cez-last-location')`)
    // Ready = the overview answered /api/v1/runs: the cards/table for a filled list, the empty
    // state otherwise — both are real content, either settles the view.
    sweep('tasks', '/', '[data-slot="tasks-table"], [data-slot="task-cards"], [data-slot="tasks-empty"]')
  })

  it('/inbox (retained-file export guidance)', () => {
    sweep('inbox', '/inbox', '[data-route="inbox"] h1')
  })

  it('/git (Git screen)', () => {
    // Bare /git is the Git screen below md (issue 06 §3): the checkout block and the sections.
    sweep('git-screen', '/git', '[data-slot="git-screen"] [data-slot="git-sections"]')
  })

  it('/git?view=repo (Recently on main)', () => {
    sweep('git', '/git?view=repo', '[data-slot="repo-header"]')
  })

  it('/github (forge-gated, like github.e2e.ts)', () => {
    // The shared env runs under CEZ_DRY_RUN=1, whose forge driver always reports available.
    expect(forgeAvailable).toBe(true)
    // Bare /github is the filter index at phone width (#622); the sweep wants the list.
    sweep('github', '/github?filter=all', '[data-slot="gh-header"]')
  })

  // Automations are opt-in (#801) and this shared environment runs without the flag, so a sweep
  // here would only measure the "Automations are off" page. The enabled list and editor at 390 px
  // are asserted in automations.e2e.ts, on its own opted-in fixture server.

  it('/workflows (builder)', () => {
    sweep('workflows', '/workflows', '[data-slot="wb-main"]')
  })

  // Global settings live outside `/p/:projectId` (step 3.5) — swept at their real URLs.
  it('/settings/global/appearance', () => {
    sweep('settings-appearance', '/settings/global/appearance', '[data-route="settings-global-appearance"]')
  })

  it('/settings/skills', () => {
    // The route div renders around a "Loading…" list — wait for a real skill row (the seeded
    // SKILL guarantees one), so the overflow check measures actual content.
    sweep('settings-skills', '/settings/skills', '[data-slot="skill-row"]')
  })

  it('/settings/agents', () => {
    sweep('settings-agents', '/settings/agents', '[data-route="settings-agents"]')
  })

  it('/settings/global/notifications', () => {
    sweep(
      'settings-notifications',
      '/settings/global/notifications',
      '[data-route="settings-global-notifications"]',
    )
  })

  it('/new (full-screen composer)', () => {
    sweep('new', '/new', '[data-route="new"]')
  })

  it('/tasks/:id (task thread)', () => {
    // The dock (composer area) renders only in the settled thread view, never in the
    // loading skeleton — so waiting on it means the transcript pipe has answered.
    sweep('task-thread', `/tasks/${threadRunId}`, '[data-slot="thread-dock"]', 'pushed')
  })
})
