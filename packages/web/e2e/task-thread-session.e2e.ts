import type { ChildProcess } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { waitForSettledSample } from './visual-ready'
import { spawnFixtureServer, stopFixtureServer, waitForFixtureServer } from './fixture-server'
import { openSessionActivity, openSessionActivityRow, SESSION_ACTIVITY_SUMMARY } from './session-activity'
import { AgentBrowser, bootProjectId, squawkCli, fixtureServeEnv } from './agent-browser'
import {
  applyContrastQaVariant,
  contrastQaVariants,
  contrastSampleExpression,
  focusWithKeyboard,
  restoreContrastQaDefaults,
  type ContrastSample,
} from './contrast'
import { artifactsDir, LONG_RUN, RUN, RUN_ID, seedThreadDataRoot } from './task-thread-fixture'
// fixture-server starts: 1

/**
 * The task thread's session actions in a real browser, against a real cezar: composer focus, the
 * Session activity rows, branch copy, routed tabs, the run actions menu, Notes, rename, pinning
 * and the unknown-run state.
 *
 * The runs and their transcripts come from `task-thread-fixture.ts`. This spec owns its own
 * server, browser session and cleanup, so it passes alone and in any order.
 */

const sessionId = `e2e-thread-session-${process.pid}`

let browser: AgentBrowser
let server: ChildProcess
let dataRoot: string
let baseUrl: string
let bootProject: string

/** A flat route target under this server's own project prefix (multi-project spec, step 3.2):
 *  every cockpit link is scoped, and every legacy flat URL redirects onto its scoped twin. */
const scoped = (path: string) => `/p/${bootProject}${path}`

beforeAll(async () => {
  dataRoot = seedThreadDataRoot('cezar-e2e-thread-session-', [RUN, LONG_RUN])
  server = spawnFixtureServer([squawkCli, 'serve', '--repo', dataRoot, '--port', '0', '--no-open'],
    { env: fixtureServeEnv(dataRoot), stdio: 'ignore' },
  )
  baseUrl = await waitForFixtureServer(server)
  bootProject = await bootProjectId(baseUrl)

  browser = AgentBrowser.open(sessionId)
  browser.setViewport(1440, 900)
  browser.goto(`${baseUrl}${scoped(`/tasks/${RUN_ID}`)}`)
  // The thread is async twice over (lazy route chunk, then the SSE replay) — wait for content.
  browser.waitForFunction(`document.querySelectorAll('[data-slot="user-bubble"]').length >= 2`)
}, 120_000)

afterAll(async () => {
  browser?.close()
  await stopFixtureServer(server)
  if (dataRoot) rmSync(dataRoot, { recursive: true, force: true })
})

describe('task thread', () => {
  it('reply focus highlights the composer shell without an inner rectangle', () => {
    const input = '[data-slot="composer-editor"] > textarea'
    const attach = '[data-slot="composer-editor"] [aria-label="Attach files"]'
    browser.goto(`${baseUrl}${scoped(`/tasks/${RUN_ID}`)}`)
    browser.waitForFunction(`document.querySelector('${input}')?.disabled === false`)
    try {
      for (const theme of ['light', 'dark']) for (const width of [390, 1440]) {
        browser.setViewport(width, 900)
        browser.evaluate(`document.documentElement.classList.toggle('light', ${theme === 'light'})`)
        focusWithKeyboard(browser, input)
        const focus = waitForSettledSample<{ focused: boolean; inputInk: string; outline: string; width: number }>(browser, `(() => {
          const input = document.querySelector('${input}');
          const style = getComputedStyle(input.closest('[data-slot="composer-editor"]'));
          return { focused: input.matches(':focus-visible'), inputInk: getComputedStyle(input).outlineColor,
            outline: style.outlineStyle, width: parseFloat(style.outlineWidth) };
        })()`)
        expect(focus.focused).toBe(true)
        expect(focus.inputInk).toBe('rgba(0, 0, 0, 0)')
        expect(focus.outline).toBe('solid')
        expect(focus.width).toBeGreaterThanOrEqual(2)
        const contrast = waitForSettledSample<ContrastSample>(browser,
          contrastSampleExpression('[data-slot="composer-editor"]', 'outline-color'))
        expect(contrast.ratio, JSON.stringify(contrast)).toBeGreaterThanOrEqual(3)
        browser.screenshot(`${artifactsDir}/reply-focus-${theme}-${width}.png`, { viewport: true })
        focusWithKeyboard(browser, attach)
        const button = waitForSettledSample<{ focused: boolean; outline: string; width: number; shellOutline: string }>(browser, `(() => {
          const el = document.querySelector('${attach}'), style = getComputedStyle(el);
          return { focused: el.matches(':focus-visible'), outline: style.outlineStyle, width: parseFloat(style.outlineWidth),
            shellOutline: getComputedStyle(el.closest('[data-slot="composer-editor"]')).outlineStyle };
        })()`)
        expect(button.focused).toBe(true)
        expect(button.outline).toBe('solid')
        expect(button.width).toBeGreaterThanOrEqual(2)
        expect(button.shellOutline).toBe('none')
      }
    } finally { restoreContrastQaDefaults(browser) }
  })

  it('the step rail opens from the workflow row with the record steps over the progress bar', () => {
    // The rail lives in the Session activity card's workflow section now (#402), whose row is
    // titled by the current step and opens the same checklist. The card starts folded (#1601).
    openSessionActivity(browser)
    expect(browser.text('[data-slot="run-activity-workflow"] > button')).toContain('Verify')
    browser.click('[data-slot="run-activity-workflow"] > button')
    browser.waitForFunction(`document.querySelector('[data-slot="step-progress"] > div') !== null`)
    const rail = browser.evaluate(`(() => ({
      rows: document.querySelectorAll('[data-slot="step-row"]').length,
      bar: document.querySelector('[data-slot="step-progress"] > div').style.width,
    }))()`) as { rows: number; bar: string }
    expect(rail.rows).toBe(2)
    expect(rail.bar).toBe('100%') // both steps terminal — (1 + 1) / 2
  })

  it('the plan section meters the LATEST snapshot (2 of 4) inside the run-activity card', () => {
    openSessionActivity(browser)
    expect(browser.evaluate(`document.querySelector('[data-slot="run-activity-dock"]').dataset.state`)).toBe('open')
    // The turn-2 snapshot won (turn 1 said 0/4 with "Read README and docs" in progress).
    expect(browser.text('[data-slot="run-activity-plan"] [data-slot="run-activity-meta"]')).toBe('2 of 4 complete')

    // It sits in the dock region above the composer area, not in the thread flow.
    expect(browser.evaluate(`document.querySelector('[data-slot="thread-dock"] [data-slot="run-activity-plan"]') !== null`)).toBe(true)
  })

  it('shows the auto-summary title and the done pill in the header', () => {
    expect(browser.evaluate(`document.querySelector('[data-route="task-thread"] h1').textContent`)).toBe(
      'Explain what cezar does',
    )
    expect(browser.evaluate(`document.querySelector('[data-slot="pill"]').textContent`)).toBe('Done')
    // The #381 money shot: tool cards (one expanded) + markdown + image, desktop width.
    browser.screenshot(`${artifactsDir}/thread-desktop.png`)
  })

  it('copies the branch by keyboard with readable light and dark controls at phone and desktop widths', () => {
    const copy = '[data-slot="run-activity-workspace"] [aria-label="Copy branch name"]'
    const variants = contrastQaVariants.filter((variant) => variant.density === 'comfortable')
    const measurements: Array<{ variant: string; branch: string; buttonHeight: number; cardOverflow: number; textRatio: number; focusRatio: number }> = []
    try {
      for (const variant of variants) {
        const runId = variant.viewport.width === 360 ? LONG_RUN.id : RUN_ID
        browser.goto(`${baseUrl}${scoped(`/tasks/${runId}`)}`)
        applyContrastQaVariant(browser, variant)
        // The branch copy lives in the Session activity card's Workspace row (hearsay-tools/cezarion#1333).
        openSessionActivityRow(browser, 'workspace')
        browser.waitForFunction(`document.querySelector(${JSON.stringify(copy)})?.getClientRects().length > 0`)
        const layout = waitForSettledSample<{ height: number; overflow: number }>(browser, `(() => {
          const button = document.querySelector(${JSON.stringify(copy)})
          if (!button?.getClientRects().length) return null
          const card = document.querySelector('[data-slot="run-activity-dock"]')
          return { height: button.getBoundingClientRect().height, overflow: card.scrollWidth - card.clientWidth }
        })()`)
        if (variant.viewport.width === 360) expect(layout.height).toBeGreaterThanOrEqual(44)
        expect(layout.overflow, variant.id).toBeLessThanOrEqual(1)
        const text = browser.evaluate(contrastSampleExpression(`${copy} span`)) as ContrastSample
        expect(text.ratio, `${variant.id} copy text`).toBeGreaterThanOrEqual(4.5)
        focusWithKeyboard(browser, copy)
        const focus = browser.evaluate(contrastSampleExpression(copy, 'outline-color', 'parent')) as ContrastSample
        expect(focus.ratio, `${variant.id} focus ring`).toBeGreaterThanOrEqual(3)
        measurements.push({ variant: variant.id, branch: runId === LONG_RUN.id ? 'long' : 'short',
          buttonHeight: layout.height, cardOverflow: layout.overflow, textRatio: text.ratio, focusRatio: focus.ratio })
        browser.press('Enter')
        browser.waitForFunction(`document.querySelector('[aria-label="Copied branch name"]') !== null`)
        browser.screenshot(`${artifactsDir}/branch-copy-${variant.id}.png`, { viewport: true })
        browser.waitForFunction(`document.querySelector(${JSON.stringify(copy)}) !== null`)
      }
      mkdirSync(artifactsDir, { recursive: true })
      writeFileSync(join(artifactsDir, 'branch-copy-qa.json'), JSON.stringify(measurements, null, 2))
    } finally {
      restoreContrastQaDefaults(browser)
      browser.goto(`${baseUrl}${scoped(`/tasks/${RUN_ID}`)}`)
      browser.waitForFunction(`document.querySelector('[data-slot="run-activity-dock"]') !== null`)
    }
  })

  it('keeps clipboard failure instructions AA readable in light and dark themes', () => {
    const copy = '[data-slot="run-activity-workspace"] [aria-label="Copy branch name"]'
    const cases = contrastQaVariants.filter((variant) => variant.density === 'comfortable')
    const measurements: Array<{ variant: string; failure: string; ratio: number }> = []
    try {
      for (const variant of cases) {
        browser.goto(`${baseUrl}${scoped(`/tasks/${RUN_ID}`)}`)
        applyContrastQaVariant(browser, variant)
        openSessionActivityRow(browser, 'workspace')
        const failure = variant.id.includes('dark') ? 'denied' : 'missing'
        browser.evaluate(`Object.defineProperty(navigator, 'clipboard', {
          configurable: true,
          value: ${failure === 'denied' ? '{ writeText: () => Promise.reject(new Error("denied")) }' : 'undefined'}
        })`)
        focusWithKeyboard(browser, copy)
        browser.press('Enter')
        browser.waitForFunction(`document.querySelector('[data-slot="toast"]')?.textContent.includes('Select and copy: cez/fcd519dd')`)
        const sample = browser.evaluate(contrastSampleExpression('[data-slot="toast"]')) as ContrastSample
        expect(sample.ratio, `${variant.id} ${failure} fallback`).toBeGreaterThanOrEqual(4.5)
        measurements.push({ variant: variant.id, failure, ratio: sample.ratio })
      }
      mkdirSync(artifactsDir, { recursive: true })
      writeFileSync(join(artifactsDir, 'branch-copy-fallback-qa.json'), JSON.stringify(measurements, null, 2))
    } finally {
      restoreContrastQaDefaults(browser)
      browser.goto(`${baseUrl}${scoped(`/tasks/${RUN_ID}`)}`)
      browser.waitForFunction(`document.querySelector('[data-slot="run-activity-dock"]') !== null`)
    }
  })

  it('tabs point at the routed Session/Changes/Files surfaces; Open in… keeps the take-over command', () => {
    const tabs = browser.evaluate(`[...document.querySelectorAll('[data-slot="run-tabs"] a')].map((a) => ({
      text: a.textContent,
      href: a.getAttribute('href'),
      current: a.getAttribute('aria-current'),
    }))`) as Array<{ text: string; href: string; current: string | null }>
    expect(tabs).toEqual([
      { text: 'Session', href: scoped(`/tasks/${RUN_ID}`), current: 'page' },
      // The changed-file count shows at every width (hearsay-tools/cezarion#1333).
      { text: 'Changes1', href: scoped(`/tasks/${RUN_ID}/changes`), current: null },
      { text: 'Commits', href: scoped(`/tasks/${RUN_ID}/commits`), current: null },
      { text: 'Files', href: scoped(`/tasks/${RUN_ID}/files`), current: null },
    ])

    browser.click('[aria-label="Run actions"]')
    browser.waitForFunction(`[...document.querySelectorAll('[data-slot="run-actions-menu"] [role="menuitem"]')].some(el => el.textContent === 'Open in…')`)
    browser.evaluate(`[...document.querySelectorAll('[data-slot="run-actions-menu"] [role="menuitem"]')].find(el => el.textContent === 'Open in…').click()`)
    // The take-over command remains in the worktree chooser.
    const hint = browser.evaluate(
      `document.querySelector('[aria-label="Open task worktree in…"] pre').textContent`,
    ) as string
    expect(hint).toContain('claude --resume 40169e05-629f-4d7c-853c-8a2a197255e4')
    expect(hint).toContain('cd /tmp/cezar-fixture-hg7X')
    browser.waitForFunction(`document.querySelector('[data-slot="run-actions-menu"]') === null`)
    browser.click('[aria-label="Close worktree chooser"]')
  })

  it('opens the Notes panel — an unseeded handoff reads as the honest empty state', () => {
    browser.click('[aria-label="Run actions"]')
    browser.waitForFunction(`[...document.querySelectorAll('[data-slot="run-actions-menu"] [role="menuitem"]')].some(el => el.textContent.trim() === 'Notes / handoff')`)
    browser.evaluate(`[...document.querySelectorAll('[data-slot="run-actions-menu"] [role="menuitem"]')].find(el => el.textContent.trim() === 'Notes / handoff').click()`)
    browser.waitForFunction(`document.querySelector('[data-slot="notes-panel"]') !== null`)
    browser.waitForFunction(
      `document.querySelector('[data-slot="notes-panel"]').textContent.includes('No notes yet')`,
    )
    // The 1.4 money shot: full header (title, meta, tabs+actions, rail, hint) + open notes.
    // Full-page capture scroll-stitches the transcript and changes the live header state.
    // Keep this interaction proof in its viewport, like the other scroll-sensitive shots.
    browser.waitForFunction(`document.querySelector('[data-slot="run-actions-menu"]') === null`)
    browser.screenshot(`${artifactsDir}/thread-header-desktop.png`, { viewport: true })
    browser.click('[aria-label="Run actions"]')
    browser.waitForFunction(`[...document.querySelectorAll('[data-slot="run-actions-menu"] [role="menuitem"]')].some(el => el.textContent.trim() === 'Notes / handoff')`)
    browser.evaluate(`[...document.querySelectorAll('[data-slot="run-actions-menu"] [role="menuitem"]')].find(el => el.textContent.trim() === 'Notes / handoff').click()`)
    browser.waitForFunction(`document.querySelector('[data-slot="notes-panel"]') === null`)
    // The menu's exit animation can finish after Notes closes. Radix then restores focus to
    // its trigger; if rename starts first, that focus move blurs and unmounts the title input.
    browser.waitForFunction(
      `document.querySelector('[data-slot="run-actions-menu"]') === null && document.activeElement?.getAttribute('aria-label') === 'Run actions'`,
    )
  })

  it('renames the task inline and the PATCH persists server-side', async () => {
    browser.click('[aria-label="Rename task"]')
    browser.waitForFunction(`document.querySelector('[data-slot="title-input"]') !== null`)
    expect(
      browser.evaluate(`document.querySelector('[data-slot="title-input"]').value`),
    ).toBe('Explain what cezar does')

    try {
      browser.fill('[data-slot="title-input"]', 'Renamed by the header e2e')
      browser.press('Enter')

      // The header re-reads the invalidated record — the new title lands in the h1…
      browser.waitForFunction(
        `document.querySelector('[data-route="task-thread"] h1')?.textContent === 'Renamed by the header e2e'`,
      )
      // …and the API readback proves it persisted rather than living in component state.
      const record = (await (await fetch(`${baseUrl}/api/v1/runs/${RUN_ID}`)).json()) as {
        title: string
        titleSummary: string
      }
      expect(record.titleSummary).toBe('Renamed by the header e2e')
      expect(record.title).toBe('Renamed by the header e2e')
    } finally {
      const restored = await fetch(`${baseUrl}/api/v1/runs/${RUN_ID}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: RUN.titleSummary }),
      })
      expect(restored.ok).toBe(true)
    }
  })

  it('an unknown run id lands on the 404-style state with a way home', () => {
    browser.goto(`${baseUrl}${scoped('/tasks/no-such-run')}`)
    browser.waitForFunction(`document.querySelector('[data-slot="centered-state"] h1')?.textContent === 'Task not found'`)
    expect(browser.evaluate(`document.querySelector('[data-slot="centered-state"] a[href="${scoped('/')}"]').textContent`)).toBe(
      'Back to tasks',
    )
  })

  it('phone Session activity keeps its open rows while pinning and unpinning with keyboard controls', async () => {
    browser.setViewport(360, 640)
    browser.goto(`${baseUrl}${scoped(`/tasks/${RUN_ID}`)}`)
    openSessionActivityRow(browser, 'workspace')
    const workspaceOpen = () => waitForSettledSample(browser,
      `document.querySelector('[data-slot="run-activity-workspace"] > button')?.getAttribute('aria-expanded') === 'true'`)
    for (const control of [SESSION_ACTIVITY_SUMMARY, '[aria-label="Run actions"]']) {
      expect(waitForSettledSample(browser, `(() => { const r = document.querySelector('${control}').getBoundingClientRect(); return r.width >= 44 && r.height >= 44 })()`)).toBe(true)
    }
    for (const wasPinned of [false, true]) {
      browser.click('[aria-label="Run actions"]')
      browser.waitForFunction(`document.querySelector('[data-slot="run-actions-menu"] [data-slot="pin-run"]') !== null`)
      const pin = '[data-slot="run-actions-menu"] [data-slot="pin-run"]'
      expect(waitForSettledSample(browser, `document.querySelector('${pin}').getBoundingClientRect().height`)).toBeGreaterThanOrEqual(44)
      expect(browser.evaluate(`document.querySelector('${pin}').getAttribute('aria-checked')`)).toBe(String(wasPinned))
      browser.evaluate(`document.querySelector('${pin}').focus()`)
      browser.press('Space')
      browser.waitForFunction(`document.querySelector('[data-slot="run-actions-menu"]') === null`)
      browser.click('[aria-label="Run actions"]')
      browser.waitForFunction(`document.querySelector('${pin}').getAttribute('aria-checked') === '${!wasPinned}'`)
      browser.press('Escape')
      browser.waitForFunction(`document.querySelector('[data-slot="run-actions-menu"]') === null`)
      expect(workspaceOpen()).toBe(true)
      expect(waitForSettledSample(browser, `document.documentElement.scrollWidth <= innerWidth`)).toBe(true)
    }
    const record = await (await fetch(`${baseUrl}/api/v1/runs/${RUN_ID}`)).json()
    expect(record).not.toHaveProperty('pinned')
    expect(record).not.toHaveProperty('pinnedAt')
    browser.setViewport(1440, 900)
  })
})
