import type { ChildProcess } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { seedTranscript } from './seed-transcript'

import { settleVisual, visibilitySampleExpression, waitForSettledSample } from './visual-ready'
import { expectEditorFitsViewport } from './session-layout'
import { spawnFixtureServer, stopFixtureServer, waitForFixtureServer } from './fixture-server'
import { openSessionActivity, openSessionActivityRow, SESSION_ACTIVITY_SUMMARY } from './session-activity'
import { AgentBrowser, bootProjectId, cezarCli, fixtureServeEnv } from './agent-browser'
import {
  applyContrastQaVariant,
  contrastQaVariants,
  contrastSampleExpression,
  focusWithKeyboard,
  normalizeColorSample,
  hoverVisiblePoint,
  restoreContrastQaDefaults,
  type ContrastSample,
} from './contrast'
import record from './fixtures/thread-run.record.json'
// fixture-server starts: 1

/**
 * The task thread (`/tasks/:id`, R3 Steps 1.1 + 1.2) in a real browser, against a real cezar
 * serving a run whose transcript is a REAL NDJSON file — `fixtures/thread-run.ndjson`, the
 * verbatim output of an R2 dry run (see fixtures/README.md), tool items and all. The server
 * replays it over the per-run SSE stream exactly as it would for any finished run, so what
 * this spec sees is the full pipe: store → SSE replay → reducer → grouping → tool cards →
 * Streamdown → the lazy Shiki singleton.
 *
 * Same boot-own-server doctrine as quick-list.e2e.ts: the run store reads `runs.json` once at
 * startup, so the fixture must exist before boot; a terminal (`done`) status keeps `recover()`
 * from touching the run.
 */

const artifactsDir = resolve(import.meta.dirname, '../../../.ai/qa/artifacts_issue-522')
const sessionId = `e2e-thread-${process.pid}`

/** The recorded run (`fixtures/thread-run.record.json`, the store's own zod-checked shape),
 *  with the one legitimate user edit a run can carry: a PATCHed title summary — so the header
 *  assertions cover the edited-title path rather than echoing the raw auto-summary. */
const RUN = { ...record, titleSummary: 'Explain what cezar does' }
const RUN_ID: string = RUN.id
const LONG_RUN = {
  ...RUN, id: 'phone-long-metadata', titleSummary: 'A task with a very long title for the narrow phone header',
  workflow: 'workflow-' + 'unbroken'.repeat(12), branch: 'cez/' + 'long-branch-'.repeat(18),
  model: 'fork-model-' + 'long-model-'.repeat(10), effort: 'high',
  steps: RUN.steps.map((step) => ({ ...step, profileId: 'default' })),
  // Seven-figure counts so the Usage row's tokens and cost cannot both fit on a phone.
  inputTokens: 1_234_567, outputTokens: 345_678, costUsd: 12.34, // shown as `$12`
}
const TYPO_RUNS = [
  { ...LONG_RUN, id: 'typography-long-model', runner: 'opencode', model: 'opencode/muse-spark-1.3-contributor-free', effort: 'auto' },
  { ...LONG_RUN, id: 'typography-short-model', runner: 'opencode', model: 'grok-4.6', effort: 'auto' },
]
// hearsay-tools/cezarion#1478: a run parked at its review gate keeps its last step in flight, so the
// folded Activity header shows the spinner. The step name is long enough to truncate on a phone.
const STEP_RUN = {
  ...LONG_RUN, id: 'folded-step-in-flight', status: 'review',
  steps: [
    { ...LONG_RUN.steps[0]!, status: 'done' },
    { ...LONG_RUN.steps[1]!, name: 'Verify the change against every acceptance criterion in the ticket', status: 'review' },
  ],
}
// #961: the same transcript with two hook items after the Bash card — Squeal's context and a
// failed Stop hook — as the Claude mapper emits them (`__fixtures__/claude/hooks.expected.json`).
const HOOK_RUN = { ...RUN, id: 'hook-entries', titleSummary: 'Hook entries' }
const HOOK_LINES = [
  { type: 'item.completed', ts: '2026-07-14T20:27:40.000Z', stepId: 'task', item: { kind: 'hook', id: 'hook_ctx', event: 'PostToolBatch', status: 'completed',
    entries: [{ kind: 'context', text: 'SQUEAL · revision 4\n✗ thread-items.test.tsx › ToolCard renders hook rows — new failure' }],
    stdout: '{"hookSpecificOutput":{"hookEventName":"PostToolBatch","additionalContext":"SQUEAL · revision 4"}}', exitCode: 0 } },
  { type: 'item.completed', ts: '2026-07-14T20:27:40.000Z', stepId: 'task', item: { kind: 'hook', id: 'hook_fail', event: 'Stop', status: 'failed',
    entries: [{ kind: 'error', text: 'squeal status timed out after 2000 ms' }], stderr: 'squeal status timed out after 2000 ms\n', exitCode: 1,
    source: '/home/agent/.claude/plugins/squeal/hooks/stop.sh' } },
]
const BARE_COMMAND = 'cd /home/agent/projects/very-long-project && npm run test:e2e -- --reporter verbose --runInBand'

let browser: AgentBrowser
let server: ChildProcess
let dataRoot: string
let baseUrl: string
let bootProject: string

/** A flat route target under this server's own project prefix (multi-project spec, step 3.2):
 *  every cockpit link is scoped, and every legacy flat URL redirects onto its scoped twin. */
const scoped = (path: string) => `/p/${bootProject}${path}`

beforeAll(async () => {
  dataRoot = mkdtempSync(join(tmpdir(), 'cezar-e2e-thread-'))
  mkdirSync(join(dataRoot, '.ai/cezar/runs'), { recursive: true })
  writeFileSync(join(dataRoot, '.ai/cezar/runs.json'), JSON.stringify([RUN, LONG_RUN, ...TYPO_RUNS, HOOK_RUN, STEP_RUN], null, 2), 'utf8')
  {
    const lines = readFileSync(resolve(import.meta.dirname, 'fixtures/thread-run.ndjson'), 'utf8').split('\n').filter(Boolean)
    const at = lines.findIndex((entry) => entry.includes('"item.completed"') && entry.includes('toolu_mock_1'))
    const withHooks = [...lines.slice(0, at + 1), ...HOOK_LINES.map((entry) => JSON.stringify(entry)), ...lines.slice(at + 1)]
      .map((entry, index) => JSON.stringify({ ...JSON.parse(entry), seq: index + 1 }))
    seedTranscript(join(dataRoot, '.ai/cezar/runs', `${HOOK_RUN.id}.ndjson`), withHooks.join('\n') + '\n')
  }
  seedTranscript(
    join(dataRoot, '.ai/cezar/runs', `${RUN_ID}.ndjson`),
    readFileSync(resolve(import.meta.dirname, 'fixtures/thread-run.ndjson'), 'utf8'),
  )
  seedTranscript(join(dataRoot, '.ai/cezar/runs', `${LONG_RUN.id}.ndjson`),
    readFileSync(resolve(import.meta.dirname, 'fixtures/thread-run.ndjson'), 'utf8')
      .split('\n').filter((line) => !/plan\.updated|TodoWrite|toolu_mock_todo|\"type\":\"plan\"/.test(line)).join('\n'))
  seedTranscript(join(dataRoot, '.ai/cezar/runs', `${STEP_RUN.id}.ndjson`),
    readFileSync(resolve(import.meta.dirname, 'fixtures/thread-run.ndjson'), 'utf8'))
  for (const run of TYPO_RUNS) {
    seedTranscript(join(dataRoot, '.ai/cezar/runs', `${run.id}.ndjson`),
      readFileSync(resolve(import.meta.dirname, 'fixtures/thread-run.ndjson'), 'utf8')
        .replaceAll('Ran git status --short', BARE_COMMAND)
        .replaceAll('"command":"git status --short"', `"command":${JSON.stringify(BARE_COMMAND)}`))
  }
  // The agent screenshot the transcript's `image` line points at (served by the run itself).
  cpSync(
    resolve(import.meta.dirname, 'fixtures/thread-run-images'),
    join(dataRoot, '.ai/cezar/runs', `${RUN_ID}-images`),
    { recursive: true },
  )

  server = spawnFixtureServer([cezarCli, 'serve', '--repo', dataRoot, '--port', '0', '--no-open'],
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

/** Back out of a pushed task screen to the list. Below md the facet tabs replace their history
 *  entry (#621), so one Back is always enough, however many tabs were visited. */
function backToList(): void {
  browser.click('[data-slot="mobile-top-bar"] [data-slot="mobile-back"]')
  browser.waitForFunction(`document.querySelector('[data-slot="task-card"]') !== null`)
}

// #795 review: React disclosure commit precedes the held visibility measurement.
// False is accepted and asserted, including hidden details on a phone.
const settledVisibility = (selector: string) => waitForSettledSample<boolean>(browser, visibilitySampleExpression(selector))

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

  it('renders the task and follow-up as labeled full-width user messages', () => {
    const bubbles = browser.evaluate(
      `[...document.querySelectorAll('[data-slot="user-bubble"] .thread-markdown')].map((el) => el.textContent)`,
    ) as string[]
    expect(bubbles).toHaveLength(2)
    expect(bubbles[0]).toContain('Summarize what this project does.')
    expect(bubbles[1]).toBe('Thanks — now show the markdown summary. mock:md')

    // The revised document layout fills the reading column; the role label identifies authorship.
    const geometry = waitForSettledSample(browser, `(() => {
      const bubble = document.querySelector('[data-slot="user-bubble"]')
      const message = document.querySelector('[data-slot="assistant-message"]')
      // #795/#758: presence is not rendering for content-visibility thread rows.
      const rendered = [bubble, message].every(el => el.checkVisibility({ contentVisibilityAuto: true }))
      bubble.scrollIntoView({ block: 'center' })
      if (!rendered) return null
      const column = bubble.parentElement
      const b = bubble.getBoundingClientRect(), c = column.getBoundingClientRect(), m = message.getBoundingClientRect()
      return { rightGap: c.right - b.right, bubbleLeft: b.left, mid: c.left + c.width / 2, messageLeft: m.left - c.left }
    })()`) as { rightGap: number; bubbleLeft: number; mid: number; messageLeft: number }
    expect(geometry.rightGap).toBeLessThan(40) // only the column padding separates them
    expect(geometry.bubbleLeft).toBeLessThan(geometry.mid)
    expect(browser.evaluate(`document.querySelector('[data-slot="user-bubble"] > p > span:first-child').textContent`)).toBe('YOUR MESSAGE')
    expect(geometry.messageLeft).toBeLessThan(40)
  })

  it('renders the assistant reply as markdown — heading, table, list, no raw ** anywhere', () => {
    expect(
      browser.evaluate(`document.querySelector('[data-slot="assistant-message"] [data-streamdown="heading-2"]')?.textContent`),
    ).toBe('Markdown fixture')
    expect(browser.count('[data-slot="assistant-message"] [data-streamdown="table"]')).toBe(1)
    expect(browser.count('[data-slot="assistant-message"] [data-streamdown="list-item"]')).toBeGreaterThan(3)
    expect(
      browser.evaluate(`document.querySelector('[data-slot="assistant-message"]').textContent.includes('**')`),
    ).toBe(false)
    // The dedup rule end-to-end: the fixture file carries the v1 `text` twin of this message —
    // exactly one copy renders.
    expect(browser.count('[data-slot="assistant-message"] [data-streamdown="heading-2"]')).toBe(1)
  })

  it('keeps transcript links AA-readable with a permanent affordance and visible focus across the QA matrix', () => {
    const link = '[data-slot="assistant-message"] [data-streamdown="link"]'
    browser.goto(`${baseUrl}${scoped(`/tasks/${RUN_ID}`)}`)
    browser.waitForFunction(`document.querySelector(${JSON.stringify(link)}) !== null`)
    try {
      for (const variant of contrastQaVariants) {
        applyContrastQaVariant(browser, variant)
        browser.evaluate(`(() => {
          const target = document.querySelector(${JSON.stringify(link)})
          target?.scrollIntoView({ block: 'center', inline: 'nearest' })
        })()`)
        const normal = browser.evaluate(contrastSampleExpression(link)) as ContrastSample
        hoverVisiblePoint(browser, link)
        const hovered = browser.evaluate(contrastSampleExpression(link)) as ContrastSample
        expect(normal.ratio, `${variant.id} normal: ${normal.foreground} on ${normal.background}`).toBeGreaterThanOrEqual(4.5)
        expect(hovered.ratio, `${variant.id} hover: ${hovered.foreground} on ${hovered.background}`).toBeGreaterThanOrEqual(4.5)
        focusWithKeyboard(browser, link)
        browser.evaluate(`(() => {
          const target = document.querySelector(${JSON.stringify(link)})
          const scroller = document.querySelector('[data-slot="main"]')
          scroller.scrollTop += target.getBoundingClientRect().top - 180
        })()`)
        const affordance = browser.evaluate(`(() => {
          const link = document.querySelector(${JSON.stringify(link)})
          const style = getComputedStyle(link)
          const probe = document.createElement('span')
          probe.style.color = 'var(--link-foreground)'
          document.body.append(probe)
          const semantic = getComputedStyle(probe).color
          probe.remove()
          return { active: document.activeElement === link, decoration: style.textDecorationLine, outline: style.outlineStyle, width: style.outlineWidth, semantic }
        })()` ) as { active: boolean; decoration: string; outline: string; width: string; semantic: string }
        const focus = browser.evaluate(contrastSampleExpression(link, 'outline-color')) as ContrastSample
        expect(affordance.decoration).toContain('underline')
        expect(affordance.active).toBe(true)
        expect(affordance.outline).not.toBe('none')
        expect(Number.parseFloat(affordance.width)).toBeGreaterThanOrEqual(2)
        expect(focus.foreground).toBe(affordance.semantic)
        expect(focus.ratio, `${variant.id} focus: ${focus.foreground} on ${focus.background}`).toBeGreaterThanOrEqual(3)
        browser.screenshot(`${artifactsDir}/issue-165-thread-${variant.id}.png`, { viewport: true })
      }
    } finally {
      restoreContrastQaDefaults(browser)
      browser.goto(`${baseUrl}${scoped(`/tasks/${RUN_ID}`)}`)
      browser.waitForFunction(`document.querySelectorAll('[data-slot="user-bubble"]').length >= 2`)
    }
  })

  it('highlights the ts fence through the lazy Shiki singleton, themed by the --syn-* tokens', () => {
    // Highlighting is async (shiki core + grammar are lazy chunks) — wait for a colored token.
    browser.waitForFunction(
      `[...document.querySelectorAll('[data-streamdown="code-block-body"] span')].some((s) => s.style.getPropertyValue('--sdm-c') === 'var(--syn-key)')`,
    )
    const block = browser.evaluate(`(() => {
      const block = document.querySelector('[data-streamdown="code-block"]')
      const keyword = [...block.querySelectorAll('span')].find((s) => s.style.getPropertyValue('--sdm-c') === 'var(--syn-key)')
      return {
        language: block.dataset.language,
        chip: block.querySelector('[data-streamdown="code-block-header"]').textContent,
        copy: block.querySelector('[data-streamdown="code-block-copy-button"]') !== null,
        keywordText: keyword.textContent,
        keywordToken: keyword.style.getPropertyValue('--sdm-c'),
        synKey: getComputedStyle(document.documentElement).getPropertyValue('--syn-key').trim(),
      }
    })()`) as { language: string; chip: string; copy: boolean; keywordText: string; keywordToken: string; synKey: string }

    expect(block.language).toBe('ts')
    expect(block.chip).toBe('ts')
    expect(block.copy).toBe(true)
    expect(block.keywordText).toBe('const')
    // Streamdown owns how its custom token variable is painted; our contract is that Shiki
    // maps the keyword to cezar's theme token and that the active palette defines that token.
    expect(block.keywordToken).toBe('var(--syn-key)')
    expect(normalizeColorSample(browser, block.synKey)).toBe('rgb(94, 234, 212)')
  })

  it('keeps Shiki out of the main bundle — its chunks load lazily, after the thread route', () => {
    const chunks = browser.evaluate(`performance.getEntriesByType('resource')
      .map((e) => e.name.split('/').pop())
      .filter((n) => /^(core|engine-javascript|typescript)-/.test(n))`) as string[]
    // They loaded (the fence above is highlighted)…
    expect(chunks.length).toBeGreaterThanOrEqual(3)
    // …as their own files, which is what "not in the main bundle" means at runtime.
    expect(chunks.every((n) => !n.startsWith('index-'))).toBe(true)
  })

  it('dims lifecycle lines and shows the closed-session footer for a done run', () => {
    const notes = browser.evaluate(
      `[...document.querySelectorAll('[data-slot="note-line"]')].map((el) => ({ tone: el.dataset.tone, text: el.textContent }))`,
    ) as Array<{ tone: string; text: string }>
    expect(notes.length).toBeGreaterThanOrEqual(3)
    expect(notes.every((n) => n.tone === 'dim')).toBe(true)
    expect(notes.some((n) => n.text.includes('worktree ready'))).toBe(true)

    const footer = browser.evaluate(`(() => {
      const el = document.querySelector('[data-slot="thread-footer"]')
      const link = el.querySelector('[data-slot="pr-link"]')
      return { state: el.dataset.state, text: el.textContent, prHref: link?.href ?? null }
    })()`) as { state: string; text: string; prHref: string | null }
    expect(footer.state).toBe('closed')
    expect(footer.text).toContain('Session closed')
    // The fixture record carries the agent-opened PR (`pullRequestUrl`) — since R3 Step 2.2
    // the closed footer keeps that link reachable after the review gate is gone.
    expect(footer.prHref).toBe('https://github.com/open-mercato/demo/pull/123')
  })

  it('renders the transcript tool calls as cards — and the TodoWrite cards not at all (#382)', () => {
    const cards = browser.evaluate(`[...document.querySelectorAll('[data-slot="tool-card"]')].map((el) => ({
      status: el.dataset.status,
      kind: el.dataset.kind,
      title: el.querySelector('[data-slot="collapsible-trigger"]').textContent,
    }))`) as Array<{ status: string; kind: string; title: string }>
    // Bash + Screenshot + the check-step card. The transcript ALSO carries two TodoWrite
    // tool items — the plan dock is their surface, so no plan-kind card may render.
    expect(cards).toHaveLength(3)
    expect(cards[0]).toMatchObject({ status: 'completed', kind: 'execute' })
    expect(cards[0]!.title).toContain('Ran')
    expect(cards[0]!.title).toContain('git status --short')
    expect(cards[1]).toMatchObject({ status: 'completed', kind: 'other' })
    expect(cards[1]!.title).toContain('Screenshot')
    expect(cards[2]).toMatchObject({ status: 'completed', kind: 'execute' })
    expect(browser.count('[data-slot="tool-card"][data-kind="plan"]')).toBe(0)
  })

  it('the check step renders as a command card with the pass pill and its output', () => {
    const card = browser.evaluate(`(() => {
      const el = [...document.querySelectorAll('[data-slot="tool-card"]')].at(-1)
      return {
        kind: el.dataset.kind,
        status: el.dataset.status,
        title: el.querySelector('[data-slot="collapsible-trigger"]').textContent,
        exit: el.querySelector('[data-slot="tool-exit"]')?.textContent,
      }
    })()`) as { kind: string; status: string; title: string; exit?: string }
    expect(card.kind).toBe('execute')
    expect(card.status).toBe('completed')
    expect(card.title).toContain('Ran')
    expect(card.title).toContain('npm test')
    expect(card.exit).toBe('0') // exit code 0 → the success-tinted pill

    // Expands to the mono output block, like any execute card.
    browser.evaluate(`[...document.querySelectorAll('[data-slot="tool-card"]')].at(-1)
      .querySelector('[data-slot="collapsible-trigger"]').click()`)
    browser.waitForFunction(
      `[...document.querySelectorAll('[data-slot="tool-card"]')].at(-1).querySelector('[data-slot="tool-output"] pre') !== null`,
    )
    expect(
      browser.evaluate(
        `[...document.querySelectorAll('[data-slot="tool-card"]')].at(-1).querySelector('[data-slot="tool-output"] pre').textContent`,
      ),
    ).toContain('72 passed')

    // Fold it back — the closed-by-default spec below counts open execute outputs.
    browser.evaluate(`[...document.querySelectorAll('[data-slot="tool-card"]')].at(-1)
      .querySelector('[data-slot="collapsible-trigger"]').click()`)
    browser.waitForFunction(
      `[...document.querySelectorAll('[data-slot="tool-card"]')].at(-1).querySelector('[data-slot="tool-output"]') === null`,
    )
  })

  it('the step rail maps the record steps to checklist rows over the progress bar', () => {
    // The rail lives in the Session activity card's workflow section now (#402), whose row is
    // titled by the current step and opens the same checklist. The card starts folded (#1601).
    openSessionActivity(browser)
    expect(browser.text('[data-slot="run-activity-workflow"] > button')).toContain('Verify')
    browser.click('[data-slot="run-activity-workflow"] > button')
    browser.waitForFunction(`document.querySelector('[data-slot="step-progress"] > div') !== null`)
    const rail = browser.evaluate(`(() => {
      const rows = [...document.querySelectorAll('[data-slot="step-row"]')]
      return {
        rows: rows.map((el) => ({ visual: el.dataset.visual, text: el.textContent })),
        bar: document.querySelector('[data-slot="step-progress"] > div').style.width,
      }
    })()`) as { rows: Array<{ visual: string; text: string }>; bar: string }
    expect(rail.rows).toHaveLength(2)
    expect(rail.rows[0]).toMatchObject({ visual: 'done' })
    expect(rail.rows[0]!.text).toContain('Do the task')
    expect(rail.rows[0]!.text).toContain('agent · step 1 of 2')
    expect(rail.rows[1]).toMatchObject({ visual: 'done' })
    expect(rail.rows[1]!.text).toContain('Verify')
    expect(rail.rows[1]!.text).toContain('check · step 2 of 2')
    expect(rail.bar).toBe('100%') // both steps terminal — (1 + 1) / 2
    browser.click('[data-slot="run-activity-workflow"] > button')
  })

  it('the plan section meters the LATEST snapshot (2 of 4) inside the run-activity card', () => {
    expect(browser.evaluate(`document.querySelector('[data-slot="run-activity-dock"]').dataset.state`)).toBe('open')
    expect(browser.text('[data-slot="run-activity-plan"] [data-slot="run-activity-meta"]')).toBe('2 of 4 complete')
    expect(browser.evaluate(`document.querySelector('[data-slot="plan-mirror"]') === null`)).toBe(true)

    browser.click('[data-slot="run-activity-plan"] > button')
    browser.waitForFunction(`document.querySelectorAll('[data-slot="plan-item"]').length === 4`)

    // The turn-2 snapshot won (turn 1 said 0/4 with "Read README and docs" in progress).
    const items = browser.evaluate(`[...document.querySelectorAll('[data-slot="plan-item"]')].map((el) => ({
      status: el.dataset.status,
      text: el.textContent,
    }))`) as Array<{ status: string; text: string }>
    expect(items.map((i) => i.status)).toEqual(['completed', 'completed', 'in_progress', 'pending'])
    expect(items[2]!.text).toContain('Summarize cockpit features')
    expect(items[2]!.text).toContain('in progress')

    // It sits in the dock region above the composer area, not in the thread flow.
    expect(browser.evaluate(`document.querySelector('[data-slot="thread-dock"] [data-slot="run-activity-plan"]') !== null`)).toBe(true)
  })

  it('collapsing the plan section folds the list away and keeps its odometer', () => {
    // Local repro: `npm run test:e2e -- task-thread.e2e.ts` failed here (49/50 passed):
    // the header moved from y=664.53 to y=542.53. This wait gives 50/50; evidence:
    // https://github.com/hearsay-tools/cezarion/pull/853#issuecomment-6006814817
    // Expanding the checklist moves the dock. Let its geometry and animations settle
    // before targeting the plan header again, so the click lands on that header.
    settleVisual(browser, '[data-slot="run-activity-dock"]')
    browser.click('[data-slot="run-activity-plan"] > button')
    browser.waitForFunction(`document.querySelector('[data-slot="run-activity-plan"]').dataset.state === 'collapsed'`)
    expect(browser.count('[data-slot="plan-list"]')).toBe(0)
    expect(browser.text('[data-slot="run-activity-plan"] [data-slot="run-activity-meta"]')).toBe('2 of 4 complete')
    // Re-expand so the desktop screenshot below captures the full checklist.
    browser.click('[data-slot="run-activity-plan"] > button')
    browser.waitForFunction(`document.querySelector('[data-slot="run-activity-plan"]').dataset.state === 'open'`)
  })

  it('a card is closed by default and expands to its mono output (the #381 behavior)', () => {
    const bash = `[...document.querySelectorAll('[data-slot="tool-card"][data-kind="execute"]')]
      .find((card) => card.textContent.includes('git status --short'))`
    expect(browser.evaluate(`${bash}.querySelector('[data-slot="tool-output"]') === null`)).toBe(true)
    browser.evaluate(`${bash}.querySelector('[data-slot="collapsible-trigger"]').click()`)
    browser.waitForFunction(`${bash}.querySelector('[data-slot="tool-output"] pre') !== null`)
    expect(browser.evaluate(`${bash}.querySelector('[data-slot="tool-output"] pre').textContent`)).toBe(' M src/example.ts')
  })

  it('serves and renders the agent screenshot the transcript persisted', () => {
    browser.waitForFunction(`document.querySelector('[data-slot="thread-image"]')?.naturalWidth > 0`)
    expect(
      browser.evaluate(`document.querySelector('[data-slot="thread-image"]').getAttribute('src')`),
    ).toBe(`/api/v1/runs/${RUN_ID}/images/screenshot-1.png`)
  })

  it('shows the auto-summary title and the done pill in the header', () => {
    expect(browser.evaluate(`document.querySelector('[data-route="task-thread"] h1').textContent`)).toBe(
      'Explain what cezar does',
    )
    expect(browser.evaluate(`document.querySelector('[data-slot="pill"]').textContent`)).toBe('Done')
    // The #381 money shot: tool cards (one expanded) + markdown + image, desktop width.
    browser.screenshot(`${artifactsDir}/thread-desktop.png`)
  })

  it('Session activity reads workflow, branch, cost and agent off the record (hearsay-tools/cezarion#1333)', () => {
    expect(browser.count('[data-slot="run-meta"]')).toBe(0)
    openSessionActivityRow(browser, 'usage')
    expect(browser.text('[data-slot="run-activity-workflow"] > button')).toContain('quick-task')
    const usage = browser.text('[data-slot="run-activity-usage"] > button')
    // This historical record has no input/output counters; do not guess from tokensUsed.
    expect(usage).not.toContain('3.6k tokens')
    expect(usage).toContain('$0.04')
    const agent = browser.text('[data-slot="agent-details"]')
    expect(agent).toContain('claude')
    expect(agent).toContain('auto')
    expect(browser.text('[data-slot="run-activity-workspace"] > button')).toContain('cez/fcd519dd')
    openSessionActivityRow(browser, 'workspace')
    // Branch renders as the mono chip, not plain text.
    expect(browser.text('[data-slot="run-activity-workspace"] [data-slot="branch-chip"]')).toBe('cez/fcd519dd')
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

  it('tabs point at the routed Session/Changes/Files surfaces; the done run offers the closed-run actions', () => {
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

    // #281 moved Archive out of this menu and into the composer's own action row, where a phone
    // can reach it without scrolling the header away. No flake was observed here and none is
    // claimed: this is a NEW read of a surface the spec had not touched, so it follows this
    // directory's default — wait and read as one step (README, "Wait, then read") — rather than
    // fixing anything. The expression withholds a sample until the Archive button itself is
    // present. It withholds it until BOTH labels are, because the two arrive from different
    // sources: Archive renders straight from the record, while Continue is the primary's label
    // only once the async provider query has made the run continuable — before that the primary
    // reads `Send`. Waiting on Archive alone would hand back a sample the exact assertion below
    // then fails on, which is the same wait-narrower-than-the-read mistake one step along.
    const composerActions = browser.waitForValue(
      `(() => {
        const row = document.querySelector('[data-slot="composer-actions"]')
        if (!row) return null
        const labels = [...row.querySelectorAll('button')].map((b) => b.getAttribute('aria-label'))
        return labels.includes('Archive task') && labels.includes('Continue') ? JSON.stringify(labels) : null
      })()`,
    ) as string
    // The wait proves both are present; this proves there is nothing else and in that order —
    // where #281's "one control per screen" rule would break first if Stop leaked back in.
    expect(JSON.parse(composerActions)).toEqual(['Archive task', 'Continue'])

    browser.click('[aria-label="Run actions"]')
    const actions = browser.evaluate(
      `[...document.querySelectorAll('[data-slot="run-actions-menu"] [role^="menuitem"]')].map((b) => b.textContent.trim())`,
    ) as string[]
    expect(actions).toEqual(['Notes / handoff', 'Open in…', 'Copy resume command', 'Mark unread', 'Pin task', 'Archive when Done', 'Auto-merge PR', 'Delete task…'])

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
  })

  it('an unknown run id lands on the 404-style state with a way home', () => {
    browser.goto(`${baseUrl}${scoped('/tasks/no-such-run')}`)
    browser.waitForFunction(`document.querySelector('[data-slot="centered-state"] h1')?.textContent === 'Task not found'`)
    expect(browser.evaluate(`document.querySelector('[data-slot="centered-state"] a[href="${scoped('/')}"]').textContent`)).toBe(
      'Back to tasks',
    )
  })

  it('renders hook entries as cards that expand readably in every QA variant (#961)', () => {
    const card = (id: string) => `[...document.querySelectorAll('[data-slot="hook-card"]')].find((el) => el.textContent.includes(${JSON.stringify(id)}))`
    browser.goto(`${baseUrl}${scoped(`/tasks/${HOOK_RUN.id}`)}`)
    browser.waitForFunction(`document.querySelectorAll('[data-slot="hook-card"]').length === 2`)
    // Placed where they ran: after the Bash card, before the Screenshot card.
    expect(browser.evaluate(`[...document.querySelectorAll('[data-slot="tool-card"], [data-slot="hook-card"]')]
      .map((el) => el.dataset.slot === 'hook-card' ? 'hook:' + el.dataset.status : el.dataset.kind).slice(0, 4)`))
      .toEqual(['execute', 'hook:completed', 'hook:failed', 'other'])
    expect(browser.evaluate(`${card('Stop')}.className.includes('border-danger/25')`)).toBe(true)
    for (const id of ['PostToolBatch', 'Stop']) {
      browser.evaluate(`${card(id)}.querySelector(':scope > [data-slot="collapsible-trigger"]').click()`)
    }
    browser.waitForFunction(`document.querySelectorAll('[data-slot="hook-entry"]').length === 2`)
    expect(browser.evaluate(`document.querySelector('[data-slot="hook-entry"][data-kind="context"]').textContent`))
      .toBe('SQUEAL · revision 4\n✗ thread-items.test.tsx › ToolCard renders hook rows — new failure')
    try {
      for (const variant of contrastQaVariants) {
        applyContrastQaVariant(browser, variant)
        for (const selector of [
          '[data-slot="hook-entry"][data-kind="context"]',
          '[data-slot="hook-entry"][data-kind="error"]',
          '[data-slot="hook-source"]',
          '[data-slot="hook-raw-toggle"]',
        ]) {
          const sample = waitForSettledSample<ContrastSample>(browser, contrastSampleExpression(selector, 'color', 'parent'))
          expect(sample.ratio, `${variant.id} ${selector}: ${sample.foreground} on ${sample.background}`).toBeGreaterThanOrEqual(4.5)
        }
        expect(waitForSettledSample(browser, `document.documentElement.scrollWidth <= window.innerWidth`), variant.id).toBe(true)
        // The transcript pins to its end; bring the hooks into the QA screenshot.
        browser.screenshotElement('[data-slot="hook-card"][data-status="completed"]', `${artifactsDir}/issue-961-hooks-${variant.id}.png`)
      }
    } finally {
      restoreContrastQaDefaults(browser)
      browser.setViewport(1440, 900)
    }
  })

  it('reflows at iPhone width with no horizontal overflow', () => {
    browser.setViewport(390, 844)
    browser.goto(`${baseUrl}${scoped(`/tasks/${RUN_ID}`)}`)
    browser.waitForFunction(`document.querySelectorAll('[data-slot="user-bubble"]').length >= 2`)
    browser.waitForFunction(`document.querySelector('[data-streamdown="code-block"]') !== null`)

    expect(waitForSettledSample(browser, `document.documentElement.scrollWidth <= window.innerWidth`)).toBe(true)
    // The wide fixture table/code scroll inside their own boxes, not the page.
    expect(
      waitForSettledSample(browser, `(() => {
        const main = document.querySelector('[data-slot="main"]')
        return main.scrollWidth <= main.clientWidth
      })()`),
    ).toBe(true)

    // Phone default: the Session activity card folds to its one summary row.
    expect(browser.evaluate(`document.querySelector('[data-slot="run-activity-dock"]').dataset.state`)).toBe('collapsed')
    // The fixture run is `done` with two plan entries never ticked off: finished, not complete.
    expect(browser.evaluate(`document.querySelector('[data-slot="run-activity-status"]').textContent`)).toContain('Incomplete')

    browser.screenshot(`${artifactsDir}/thread-mobile.png`)
    browser.setViewport(1440, 900)
  })

  it('mobile header: the action bar folds into the kebab in the top bar, beside the title, with no status', () => {
    browser.setViewport(390, 844)
    browser.goto(`${baseUrl}${scoped(`/tasks/${RUN_ID}`)}`)
    browser.waitForFunction(`document.querySelector('[data-slot="run-header"]') !== null`)

    // The desktop action bar is gone (`md:flex`), the kebab is the mobile surface.
    expect(
      browser.evaluate(
        `document.querySelector('[data-slot="run-actions"]')`,
      ),
    ).toBe(null)
    // The pushed screen's top bar carries the kebab and the title (#621); the run header drops its
    // own title row below md, so there is no h1 or pill left in it, and the bar shows no status
    // (hearsay-tools/cezarion#1333): the Session activity card does.
    const bar = waitForSettledSample(browser, `(() => {
      const top = document.querySelector('[data-slot="mobile-top-bar"]')
      const kebab = top?.querySelector('[aria-label="Run actions"]')
      const title = top?.querySelector('[data-slot="mobile-run-title"]')
      if (!kebab || !title) return null
      return { kebab: kebab.offsetParent !== null, state: top.querySelector('[data-slot="mobile-run-state"]') !== null,
        h1: document.querySelector('[data-route="task-thread"] h1') !== null, pill: document.querySelector('[data-slot="run-header"] [data-slot="pill"]') !== null }
    })()`) as { kebab: boolean; state: boolean; h1: boolean; pill: boolean }
    expect(bar).toEqual({ kebab: true, state: false, h1: false, pill: false })

    // #737: the title fits the 56px bar, the 44px rename target is a sibling of the title (so it can
    // neither grow it nor overlap it), and while renaming the input opens below the bar without
    // covering the title.
    const probe = `(() => {
      const top = document.querySelector('[data-slot="mobile-top-bar"] > div')
      const stack = top?.querySelector('[data-slot="mobile-run-title"]')
      const heading = stack?.querySelector('h1')
      const rename = top?.querySelector('[aria-label="Rename task"]')
      const input = document.querySelector('[data-slot="title-input"]')
      if (!top || !stack || !heading) return null
      const box = (e) => { const r = e.getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom, w: r.width, h: r.height } }
      const t = box(top), s = box(stack), h = box(heading)
      const hit = (e) => { const r = box(e); return Math.min(r.w, r.h) >= 44 && r.t >= t.t && r.b <= t.b }
      const apart = (a, b) => a.r <= b.l || b.r <= a.l || a.b <= b.t || b.b <= a.t
      const res = { bar: Math.round(t.h), stackFits: s.t >= t.t && s.b <= t.b, stackHeight: Math.round(s.h), titleVisible: h.w > 0 && h.h > 0 }
      if (rename) { const r = box(rename); res.renameHit = hit(rename); res.renameClearOfStack = apart(r, s) }
      if (input) { const i = box(input); res.input = { h: Math.round(i.h), belowBar: i.t >= t.b, clearOfTitle: apart(i, h), hitsOk: i.h >= 44, topmost: document.elementFromPoint(i.l + i.w / 2, i.t + i.h / 2) === input } }
      return res
    })()`
    type Probe = { bar: number; stackFits: boolean; stackHeight: number; titleVisible: boolean
      renameHit?: boolean; renameClearOfStack?: boolean
      input?: { h: number; belowBar: boolean; clearOfTitle: boolean; hitsOk: boolean; topmost: boolean } }
    const resting = browser.waitForValue(probe, (v) => (v as Probe | null)?.renameHit !== undefined) as Probe
    expect(resting).toMatchObject({ bar: 56, stackFits: true, titleVisible: true, renameHit: true, renameClearOfStack: true })
    expect(resting.stackHeight).toBeLessThanOrEqual(40)
    browser.click('[data-slot="mobile-top-bar"] [aria-label="Rename task"]')
    // The popover animates in (zoom/slide): sample only once the geometry has held still.
    const editing = browser.waitForStable<Probe | null>(probe, { holdMs: 400, matcher: (v) => v?.input !== undefined }) as Probe
    expect(editing).toMatchObject({ bar: 56, stackFits: true, titleVisible: true, input: { belowBar: true, clearOfTitle: true, hitsOk: true, topmost: true } })
    browser.press('Escape')
    browser.waitForFunction(`document.querySelector('[data-slot="title-input"]') === null`)

    browser.screenshot(`${artifactsDir}/thread-header-mobile.png`)
    browser.setViewport(1440, 900)
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

  it('phone actions preserve a selected draft and documents across viewport changes', () => {
    browser.setViewport(360, 640)
    browser.goto(`${baseUrl}${scoped(`/tasks/${RUN_ID}`)}`)
    browser.waitForFunction(`document.querySelector('[data-slot="session-controls"]') !== null`)
    const input = '[aria-label="Reply to the agent"]'
    browser.fill(input, 'first line\nsecond line\nthird line')
    browser.evaluate(`(() => {
      const el = document.querySelector('${input}'); window.__phoneTextarea = el; el.setSelectionRange(2, 8);
      const files = new DataTransfer();
      for (const [name, type] of [['notes.pdf','application/pdf'], ['notes.txt','text/plain'], ['notes.md','text/markdown']]) files.items.add(new File(['notes'], name, {type}));
      el.dispatchEvent(new ClipboardEvent('paste', {bubbles:true, clipboardData: files}));
    })()`)
    browser.waitForFunction(`document.querySelectorAll('[data-slot="composer-thumbs"] button').length === 3`)
    expect(waitForSettledSample(browser, `document.querySelector('${input}').getBoundingClientRect().height`)).toBeGreaterThan(44)
    expect(settledVisibility('[data-slot="follow-up-engine"]')).toBe(true)
    expect(waitForSettledSample(browser, `[...document.querySelectorAll('[data-slot="follow-up-engine"] button')].every(el => {const r=el.getBoundingClientRect(); return r.width >=44 && r.height >=44})`)).toBe(true)
    browser.evaluate(`document.querySelector('[aria-label="Run actions"]').scrollIntoView({block:'center'})`)
    browser.click('[aria-label="Run actions"]')
    browser.press('Escape')
    expect(browser.evaluate(`(() => { const el = document.querySelector('${input}'); return [el === window.__phoneTextarea, el.value, el.selectionStart, el.selectionEnd] })()`))
      .toEqual([true, 'first line\nsecond line\nthird line', 2, 8])
    expect(browser.count('[data-slot="composer-thumbs"] button')).toBe(3)
    expect(settledVisibility('[aria-label="Attach files"]')).toBe(true)
    expect(settledVisibility('[aria-label="Send"]')).toBe(true)
    expect(waitForSettledSample(browser, `document.documentElement.scrollWidth <= innerWidth`)).toBe(true)
    for (const control of [SESSION_ACTIVITY_SUMMARY, '[aria-label="Run actions"]']) {
      expect(waitForSettledSample(browser, `(() => { const r = document.querySelector('${control}').getBoundingClientRect(); return r.width >= 44 && r.height >= 44 })()`)).toBe(true)
    }
    // At the start of the transcript, the header and bottom dock still leave reading space.
    browser.evaluate(`document.querySelector('[data-slot="main"]').scrollTop = 0`)
    const room = waitForSettledSample(browser, `(() => {
      const main = document.querySelector('[data-slot="main"]');
      const header = document.querySelector('[data-slot="run-header"]').getBoundingClientRect();
      const dock = document.querySelector('[data-slot="thread-dock"]').getBoundingClientRect();
      return { height: dock.top - header.bottom, scrollable: main.scrollHeight > main.clientHeight };
    })()`) as { height: number; scrollable: boolean }
    expect(room.scrollable).toBe(true)
    expect(room.height).toBeGreaterThanOrEqual(120)
    browser.evaluate(`document.documentElement.classList.add('light')`)
    browser.screenshot(`${artifactsDir}/phone-reading-light.png`, { viewport: true })
    browser.setViewport(1440, 900)
    // Desktop gets the one status pill back (hearsay-tools/cezarion#1333).
    expect(settledVisibility('[data-slot="run-header"] [data-slot="pill"]')).toBe(true)
    expect(settledVisibility('[data-slot="follow-up-engine"]')).toBe(true)
    expect(browser.count('[aria-label="Expand composer"]')).toBe(0)
    expect(browser.evaluate(`getComputedStyle(document.querySelector('[data-slot="run-header"]')).position`)).toBe('sticky')
    browser.setViewport(360, 640)
    expect(settledVisibility('[data-slot="follow-up-engine"]')).toBe(true)
    expect(browser.evaluate(`document.querySelector('${input}').value`)).toBe('first line\nsecond line\nthird line')
  })

  it('keeps long metadata inside a phone viewport across task tabs and run switches', () => {
    browser.setViewport(360, 640)
    browser.goto(`${baseUrl}${scoped(`/tasks/${LONG_RUN.id}`)}`)
    browser.waitForFunction(`document.querySelector('${SESSION_ACTIVITY_SUMMARY}') !== null`)
    expect(browser.count('[data-slot="run-activity-plan"]')).toBe(0)
    // The long branch and worktree path live in the Session activity card (hearsay-tools/cezarion#1333).
    openSessionActivityRow(browser, 'workspace')
    openSessionActivityRow(browser, 'usage')
    expect(waitForSettledSample(browser, `document.documentElement.scrollWidth <= innerWidth`)).toBe(true)
    // Measured as painted: a span inside a `truncate` row is wider than the row, and its
    // overflow-clipping ancestor decides where it stops on screen.
    expect(waitForSettledSample(browser, `[...document.querySelectorAll('[data-slot="run-header"] *, [data-slot="run-activity-dock"] *')].filter(el => {
      let right = el.getBoundingClientRect().right
      for (let a = el.parentElement; a; a = a.parentElement) if (getComputedStyle(a).overflowX !== 'visible') right = Math.min(right, a.getBoundingClientRect().right)
      return right > innerWidth
    }).map(el => ({slot:el.dataset.slot, text:el.textContent?.slice(0,60), width:el.getBoundingClientRect().width}))`)).toEqual([])
    // #251: one defined account is not a choice — the lone login never joins the agent lines.
    const agent = browser.text('[data-slot="agent-details"]')
    expect(agent).toContain('high')
    expect(agent).not.toContain('Account')
    for (const tab of ['changes', 'commits', 'files', '']) {
      const tabSelector = `[data-slot="run-tabs"] a[href="${scoped(`/tasks/${LONG_RUN.id}${tab ? '/' + tab : ''}`)}"]`
      browser.evaluate(`document.querySelector('${tabSelector}').scrollIntoView({block: 'start'})`)
      browser.evaluate(`document.querySelector('${tabSelector}').focus()`)
      browser.press('Enter')
      browser.waitForFunction(`document.querySelector('[data-slot="run-tabs"] a[aria-current="page"]')?.getAttribute('href') === '${scoped(`/tasks/${LONG_RUN.id}${tab ? '/' + tab : ''}`)}'`)
      browser.evaluate(`document.querySelector('[data-slot="main"]').scrollTop = 0`)
      expect(settledVisibility('[aria-label="Run actions"]')).toBe(true)
      expect(waitForSettledSample(browser, `document.documentElement.scrollWidth <= innerWidth`)).toBe(true)
    }
    // Back on Session, the card remembers what was open for this run.
    expect(browser.waitForValue(`document.querySelector('[data-slot="run-activity-workspace"] > button')?.getAttribute('aria-expanded') ?? null`)).toBe('true')
    // Navigate through the real phone UI (Back to the list, then the task card); a full browser.goto would reset module memory.
    for (const [id, expanded] of [[RUN_ID, 'false'], [LONG_RUN.id, 'true']]) {
      backToList()
      const link = `[data-slot="task-card"][data-run-id="${id}"] a[href]`
      browser.waitForFunction(`document.querySelector('${link}') !== null`)
      browser.evaluate(`document.querySelector('${link}').scrollIntoView({ block: 'center' })`)
      browser.evaluate(`document.querySelector('${link}').focus()`)
      browser.press('Enter')
      browser.waitForFunction(`document.querySelector('[data-route="task-thread"][data-run-id="${id}"] ${SESSION_ACTIVITY_SUMMARY}') !== null`)
      expect(browser.waitForValue(`document.querySelector('${SESSION_ACTIVITY_SUMMARY}')?.getAttribute('aria-expanded') ?? null`)).toBe(expanded)
      expect(settledVisibility('[data-slot="session-controls"]')).toBe(true)
    }
    expect(waitForSettledSample(browser, `(() => { const el = document.querySelector('[data-slot="follow-up-model-pill"]'); return el.scrollHeight <= el.clientHeight })()`)).toBe(true)
    expect(waitForSettledSample(browser, `(() => { const el = document.querySelector('[data-slot="main"]'); return el.scrollWidth <= el.clientWidth })()`)).toBe(true)
    browser.setReducedMotion()
    expect(browser.evaluate(`matchMedia('(prefers-reduced-motion: reduce)').matches`)).toBe(true)
    expect(browser.evaluate(`getComputedStyle(document.querySelector('${SESSION_ACTIVITY_SUMMARY} > svg:last-child')).transitionProperty`)).toBe('none')
    expect(browser.evaluate(`getComputedStyle(document.querySelector('[data-slot="run-activity-usage"] > button > svg:last-child')).transitionProperty`)).toBe('none')
    browser.evaluate(`document.querySelector('${SESSION_ACTIVITY_SUMMARY}').click()`)
    expect(browser.waitForValue(`document.querySelector('${SESSION_ACTIVITY_SUMMARY}')?.getAttribute('aria-expanded') ?? null`)).toBe('false')
    browser.evaluate(`document.documentElement.classList.remove('light')`)
    browser.screenshot(`${artifactsDir}/phone-long-details-dark.png`, { viewport: true })
    browser.setViewport(1440, 900)
  })

  // hearsay-tools/cezarion#1333: one card, the same at every width. Folded it is one summary row;
  // open, every control in it is a 44px target on a phone (desktop rows keep their compact
  // `md:` sizes, as the rest of the cockpit does). Expanding it never reshapes the composer or the
  // transcript beside it: the composer and transcript are out of this issue's scope.
  it.each([[320, 640], [360, 640], [390, 844], [1280, 900]] as const)('Session activity fits %ipx folded and expanded', (width, height) => {
    browser.setViewport(width, height)
    browser.goto(`${baseUrl}${scoped(`/tasks/${LONG_RUN.id}`)}`)
    browser.waitForFunction(`document.querySelector('${SESSION_ACTIVITY_SUMMARY}') !== null && document.querySelector('[data-slot="composer"]') !== null`)
    const sample = `(() => {
      const card = document.querySelector('[data-slot="run-activity-dock"]')
      const summary = card.querySelector(':scope > button')
      const box = (sel) => { const r = document.querySelector(sel)?.getBoundingClientRect(); return r ? { left: Math.round(r.left), width: Math.round(r.width) } : null }
      const small = [...card.querySelectorAll('button, a')].filter(el => el.getClientRects().length && el.getBoundingClientRect().height < 44)
        .map(el => (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 40))
      // The folded status sits before the summary and never shrinks (hearsay-tools/cezarion#1478).
      const status = card.querySelector(':scope > button [data-slot="run-activity-status"]')
      const statusCut = !status || status.scrollWidth > status.clientWidth + 1 || status.getBoundingClientRect().right > summary.getBoundingClientRect().right + 1
      // The step after it keeps its glyph whole and may only end its name in an ellipsis.
      const stepGlyph = card.querySelector(':scope > button [data-slot="run-activity-step"] [data-slot="workflow-glyph"]')?.getBoundingClientRect()
      const stepName = card.querySelector(':scope > button [data-slot="run-activity-step-name"]')
      const step = stepGlyph && stepName ? { glyphWhole: stepGlyph.width >= 15 && stepGlyph.right <= summary.getBoundingClientRect().right,
        nameInside: stepName.getBoundingClientRect().right <= summary.getBoundingClientRect().right + 1, truncated: stepName.scrollWidth > stepName.clientWidth + 1 } : null
      // A two-part row meta never paints half a word: what it keeps sits whole across its row,
      // what it drops is either whole on its line or wrapped wholly onto the clipped one below.
      // The open card scrolls on a short phone, so the kept part is measured across, not down.
      const inside = (r, c) => r.left >= c.left - 1 && r.right <= c.right + 1 && r.top >= c.top - 1 && r.bottom <= c.bottom + 1
      const metaCut = [...card.querySelectorAll('[data-slot="run-activity-meta-keep"], [data-slot="run-activity-meta-drop"]')].filter(part => {
        const r = part.getBoundingClientRect()
        if (part.dataset.slot === 'run-activity-meta-keep') {
          const row = part.closest('button').getBoundingClientRect()
          return r.left < row.left - 1 || r.right > row.right + 1
        }
        const clip = part.parentElement.getBoundingClientRect()
        return !inside(r, clip) && r.top < clip.bottom
      }).map(part => part.textContent)
      const summaryCut = [...card.querySelectorAll('[data-slot="activity-summary"] > [data-hidden="false"]')]
        .filter(part => !inside(part.getBoundingClientRect(), part.parentElement.getBoundingClientRect())).map(part => part.dataset.summaryItem)
      const usageItems = [...card.querySelectorAll('[data-slot="run-activity-usage"] [data-summary-item]')]
      const removalOrder = ['tokens', 'cost', 'provider', 'effort', 'model'].filter(id => usageItems.some(item => item.dataset.summaryItem === id))
      const removed = removalOrder.filter(id => usageItems.find(item => item.dataset.summaryItem === id).dataset.hidden === 'true')
      const usageOrderValid = removed.every((id, index) => id === removalOrder[index])
      return { state: card.dataset.state, overflow: document.documentElement.scrollWidth - innerWidth, statusCut, step, metaCut, summaryCut, usageOrderValid,
        summaryHeight: Math.round(summary.getBoundingClientRect().height), small,
        composer: box('[data-slot="composer"]'), transcript: box('[data-slot="thread-rows"]') }
    })()`
    type Sample = { state: string; overflow: number; statusCut: boolean; step: { glyphWhole: boolean; nameInside: boolean; truncated: boolean } | null; metaCut: string[]; summaryCut: string[]; usageOrderValid: boolean; summaryHeight: number; small: string[]; composer: { left: number; width: number }; transcript: { left: number; width: number } | null }
    browser.evaluate(`document.querySelector('${SESSION_ACTIVITY_SUMMARY}[aria-expanded="true"]')?.click()`)
    const layoutSelectors = {
      card: '[data-slot="run-activity-dock"]',
      status: '[data-slot="run-activity-status"]',
      keptMeta: '[data-slot="run-activity-meta-keep"]',
      droppedMeta: '[data-slot="run-activity-meta-drop"]',
      rows: '[data-slot="run-activity-dock"] button',
      composer: '[data-slot="composer"]',
      transcript: '[data-slot="thread-rows"]',
    }
    const folded = waitForSettledSample<Sample>(browser, `(${sample}).state === 'collapsed' ? ${sample} : null`)
    browser.recordLayout('folded', layoutSelectors)
    expect(folded.overflow).toBeLessThanOrEqual(0)
    expect(folded.statusCut).toBe(false)
    expect(folded.step).toMatchObject({ glyphWhole: true, nameInside: true })
    // The fixture's last step is "Verify": a desktop header has room for all of it.
    if (width >= 768) expect(folded.step?.truncated).toBe(false)
    expect(folded.summaryCut).toEqual([])
    // One 44px summary; narrower rows remove whole values by priority.
    expect(folded.summaryHeight).toBeGreaterThanOrEqual(44)
    if (width >= 768) expect(folded.summaryHeight).toBeLessThan(60)
    if (width < 768) expect(folded.small).toEqual([])
    openSessionActivityRow(browser, 'workspace')
    openSessionActivityRow(browser, 'usage')
    openSessionActivityRow(browser, 'workflow')
    const expanded = waitForSettledSample<Sample>(browser, sample)
    browser.recordLayout('expanded', layoutSelectors)
    expect(expanded.state).toBe('open')
    expect(expanded.overflow).toBeLessThanOrEqual(0)
    expect(expanded.metaCut).toEqual([])
    expect(expanded.summaryCut).toEqual([])
    expect(expanded.usageOrderValid).toBe(true)
    if (width < 768) expect(expanded.small).toEqual([])
    expect(expanded.composer).toEqual(folded.composer)
    expect(expanded.transcript).toEqual(folded.transcript)
    browser.screenshot(`${artifactsDir}/session-activity-${width}.png`, { viewport: true })
    browser.setViewport(1440, 900)
  })

  // hearsay-tools/cezarion#1478 review: once the step shows its whole name, the summary takes all
  // the room left, so a desktop header still shows agent details beside the step.
  it('folded Activity keeps agent details beside the step on desktop', () => {
    browser.setViewport(1280, 900)
    browser.goto(`${baseUrl}${scoped(`/tasks/${TYPO_RUNS[1]!.id}`)}`)
    browser.waitForFunction(`document.querySelector('${SESSION_ACTIVITY_SUMMARY}') !== null`)
    browser.evaluate(`document.querySelector('${SESSION_ACTIVITY_SUMMARY}[aria-expanded="true"]')?.click()`)
    const folded = waitForSettledSample<{ step: boolean; visible: string[] } | null>(browser, `(() => {
      const summary = document.querySelector('${SESSION_ACTIVITY_SUMMARY}')
      const name = summary.querySelector('[data-slot="run-activity-step-name"]')
      if (summary.getAttribute('aria-expanded') !== 'false' || !name) return null
      return { step: name.scrollWidth <= name.clientWidth + 1,
        visible: [...summary.querySelectorAll('[data-slot="activity-summary"] > [data-hidden="false"]')].map(item => item.dataset.summaryItem) }
    })()`)
    expect(folded?.step).toBe(true)
    expect(folded?.visible).toEqual(expect.arrayContaining(['runner', 'model', 'effort']))
    browser.setViewport(1440, 900)
  })

  // hearsay-tools/cezarion#1537: the summary's 8px gap used to appear only with its first shown
  // value. Where a value fitted only without that gap, it showed, lost the room, hid and showed
  // again on every frame, so main CI's touch-targets 360px cell never settled (failure bundle
  // .ai/qa/failures/touch-targets/comfortable-dark-360-edge-taps-keyboard-drafts-pins-and-pending-controls-1
  // in run 39970537530 attempt 1, artifact cockpit-failures-shard-1). Locally it failed 1 of 4
  // runs: `npm run test:e2e -- touch-targets.e2e.ts -t 'comfortable/dark/360'`. Every card width
  // exercises the boundary, so the sweep finds it without the fixture's exact font widths. The
  // flip period is one or two frames: three settle frames, then three sampled frames per width.
  it('folded Activity settles at every card width', () => {
    browser.setViewport(1280, 900)
    browser.goto(`${baseUrl}${scoped(`/tasks/${TYPO_RUNS[1]!.id}`)}`)
    browser.waitForFunction(`document.querySelector('${SESSION_ACTIVITY_SUMMARY}') !== null`)
    browser.evaluate(`document.querySelector('${SESSION_ACTIVITY_SUMMARY}[aria-expanded="true"]')?.click()`)
    browser.waitForFunction(`document.querySelector('${SESSION_ACTIVITY_SUMMARY}')?.getAttribute('aria-expanded') === 'false'`)
    const flipping = browser.evaluate(`(async () => {
      const card = document.querySelector('[data-slot="run-activity-dock"]')
      const frame = () => new Promise(resolve => requestAnimationFrame(resolve))
      const shown = () => [...card.querySelectorAll(':scope > button [data-slot="activity-summary"] > [data-hidden="false"]')]
        .map(item => item.dataset.summaryItem).join()
      const flipping = []
      for (let width = 200; width <= 640; width += 4) {
        card.style.width = width + 'px'
        for (let i = 0; i < 3; i++) await frame()
        const seen = new Set()
        for (let i = 0; i < 3; i++) { seen.add(shown()); await frame() }
        if (seen.size > 1) flipping.push(width)
      }
      card.style.width = ''
      return flipping
    })()`)
    expect(flipping).toEqual([])
    browser.setViewport(1440, 900)
  })

  // hearsay-tools/cezarion#1478: the folded header names the step in flight. A long name ends in an
  // ellipsis on a phone while its spinner stays whole; the disclosure keeps working from the
  // keyboard and names the step; reduced motion stops the spin but keeps the loader glyph.
  it.each([[320, 640, 'light'], [320, 640, 'dark'], [1280, 900, 'light'], [1280, 900, 'dark']] as const)(
    'folded Activity shows the step in flight at %ipx / %s', async (width, height, theme) => {
      browser.setViewport(width, height)
      browser.goto(`${baseUrl}${scoped(`/tasks/${STEP_RUN.id}`)}`)
      browser.waitForFunction(`document.querySelector('${SESSION_ACTIVITY_SUMMARY}') !== null`)
      browser.evaluate(`document.documentElement.classList.remove('light', 'dark'); document.documentElement.classList.add('${theme}')`)
      browser.evaluate(`document.querySelector('${SESSION_ACTIVITY_SUMMARY}[aria-expanded="true"]')?.click()`)
      const sample = `(() => {
        const summary = document.querySelector('${SESSION_ACTIVITY_SUMMARY}')
        const glyph = summary.querySelector('[data-slot="run-activity-step"] [data-slot="workflow-glyph"]')
        const name = summary.querySelector('[data-slot="run-activity-step-name"]')
        if (summary.getAttribute('aria-expanded') !== 'false' || !glyph || !name) return null
        const box = summary.getBoundingClientRect(), g = glyph.getBoundingClientRect(), n = name.getBoundingClientRect()
        return { overflow: document.documentElement.scrollWidth - innerWidth, visual: glyph.dataset.visual,
          glyphWhole: g.width >= 15 && g.right <= box.right, nameInside: n.right <= box.right + 1, nameWidth: Math.round(n.width),
          truncated: name.scrollWidth > name.clientWidth + 1, ellipsis: getComputedStyle(name).textOverflow,
          color: getComputedStyle(name).color, label: summary.getAttribute('aria-label'), text: summary.textContent,
          statusTruncated: (() => { const l = summary.querySelector('[data-slot="run-activity-status-label"]'); return l.scrollWidth > l.clientWidth + 1 })() }
      })()`
      type Folded = { overflow: number; visual: string; glyphWhole: boolean; nameInside: boolean; nameWidth: number; truncated: boolean; ellipsis: string; color: string; label: string; text: string; statusTruncated: boolean }
      const folded = waitForSettledSample<Folded>(browser, sample)
      expect(folded.overflow).toBeLessThanOrEqual(0)
      expect(folded.visual).toBe('active')
      expect(folded.glyphWhole).toBe(true)
      expect(folded.nameInside).toBe(true)
      // The name keeps a readable character and its ellipsis, never only the glyph.
      expect(folded.nameWidth).toBeGreaterThanOrEqual(12)
      expect(folded.ellipsis).toBe('ellipsis')
      if (width < 768) expect(folded.truncated).toBe(true)
      // A short status stays whole: the step name gives way first.
      expect(folded.statusTruncated).toBe(false)
      expect(folded.text.startsWith('Activity')).toBe(true)
      expect(folded.label).toContain('; step Verify the change against every acceptance criterion in the ticket, running')
      browser.screenshot(`${artifactsDir}/folded-step-${width}-${theme}.png`, { viewport: true })

      // The longest real status labels (packages/contract/src/attention.ts) share the phone row with
      // the step: both shorten, and the status dot, the step glyph and the chevron stay in the card.
      // The fixture cannot park a run on its workers, so a detached clone of the folded header,
      // in a copy of the card at the card's width, carries the label instead.
      const crowded = waitForSettledSample<{ status: boolean; label: boolean; step: boolean; chevron: boolean }>(browser, `(() => {
        const card = document.querySelector('[data-slot="run-activity-dock"]')
        const host = card.cloneNode(false)
        host.style.width = card.getBoundingClientRect().width + 'px'
        const clone = document.querySelector('${SESSION_ACTIVITY_SUMMARY}').cloneNode(true)
        const status = clone.querySelector('[data-slot="run-activity-status"]')
        ;[...status.childNodes].reverse().find((node) => node.textContent.trim()).textContent = 'Waiting on worker replies'
        host.appendChild(clone)
        document.body.appendChild(host)
        const box = host.getBoundingClientRect()
        const inside = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.left >= box.left - 1 && r.right <= box.right + 1 }
        const result = { status: inside(status.firstElementChild), label: inside(status),
          step: inside(clone.querySelector('[data-slot="run-activity-step"] [data-slot="workflow-glyph"]')), chevron: inside(clone.lastElementChild) }
        host.remove()
        return result
      })()`)
      if (width < 768) expect(crowded).toEqual({ status: true, label: true, step: true, chevron: true })

      focusWithKeyboard(browser, SESSION_ACTIVITY_SUMMARY)
      browser.press('Enter')
      browser.waitForFunction(`document.querySelector('${SESSION_ACTIVITY_SUMMARY}')?.getAttribute('aria-expanded') === 'true'`)
      browser.press('Enter')
      browser.waitForFunction(`document.querySelector('${SESSION_ACTIVITY_SUMMARY}')?.getAttribute('aria-expanded') === 'false'`)
      // Folding again brings the step back with the current name.
      browser.waitForFunction(`document.querySelector('${SESSION_ACTIVITY_SUMMARY} [data-slot="run-activity-step-name"]')?.textContent === ${JSON.stringify(STEP_RUN.steps[1]!.name)}`)

      await browser.withCdp(async (request) => {
        const url = browser.url()
        const { targetInfos } = await request('Target.getTargets')
        const target = targetInfos.find((t: { type: string; url: string }) => t.type === 'page' && t.url === url)
        const { sessionId } = await request('Target.attachToTarget', { targetId: target.targetId, flatten: true })
        await request('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] }, sessionId)
        try {
          const still = waitForSettledSample<{ animation: string; visual: string } | null>(browser, `(() => {
            if (!matchMedia('(prefers-reduced-motion: reduce)').matches) return null
            const glyph = document.querySelector('${SESSION_ACTIVITY_SUMMARY} [data-slot="run-activity-step"] [data-slot="workflow-glyph"]')
            return glyph ? { animation: getComputedStyle(glyph).animationName, visual: glyph.dataset.visual } : null
          })()`)
          expect(still).toEqual({ animation: 'none', visual: 'active' })
        } finally {
          await request('Emulation.setEmulatedMedia', { features: [] }, sessionId)
        }
      })
      browser.evaluate(`document.documentElement.classList.remove('dark'); document.documentElement.classList.add('light')`)
      browser.setViewport(1440, 900)
    })


})

type LayoutRect = { left: number; right: number; top: number; bottom: number; width: number; height: number }
type SessionLayout = {
  controls: Record<'runner' | 'model' | 'effort' | 'attach' | 'dictation' | 'archive' | 'continue', LayoutRect & { hit: boolean }>
  modelChrome: Record<'icon' | 'label' | 'chevron', LayoutRect>
  group: LayoutRect
  editor: LayoutRect
  viewportHeight: number
  textarea: LayoutRect
  documentOverflow: boolean
  mainOverflow: boolean
  modelText: string
  modelTruncated: boolean
  archiveLabel: string
  archiveVisibleText: string
  archiveWidth: number
  bottomGap: number
}

const sessionLayoutExpression = `(() => {
  const editor = document.querySelector('[data-slot="composer-editor"]')
  if (!editor || !editor.checkVisibility({ contentVisibilityAuto: true })) return null
  const select = (selector) => {
    const el = document.querySelector(selector)
    if (!el) return null
    const r = el.getBoundingClientRect()
    const under = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height, hit: !!under && el.contains(under) }
  }
  const controls = {
    runner: select('[data-slot="session-controls"] [aria-label^="Runner · "]'),
    model: select('[data-slot="follow-up-model-pill"]'),
    effort: select('[data-slot="follow-up-effort-pill"]'),
    attach: select('[data-slot="composer"] [aria-label="Attach files"]'),
    dictation: select('[data-slot="composer"] [aria-label="Start dictation"]'),
    archive: select('[data-slot="composer-actions"] [aria-label="Archive task"]'),
    continue: select('[data-slot="composer-actions"] [aria-label="Continue"]'),
  }
  if (Object.values(controls).some(value => !value)) return null
  const modelChrome = {
    icon: select('[data-slot="follow-up-model-pill"] > svg:first-child'),
    label: select('[data-slot="follow-up-model-pill"] > span'),
    chevron: select('[data-slot="follow-up-model-pill"] > svg:last-child'),
  }
  if (Object.values(modelChrome).some(value => !value)) return null
  const label = document.querySelector('[data-slot="follow-up-model-pill"] [data-slot="picker-label"]')
  const archive = document.querySelector('[data-slot="composer-actions"] [aria-label="Archive task"]')
  const main = document.querySelector('[data-slot="main"]')
  const group = select('[data-slot="session-controls"]')
  const editorRect = select('[data-slot="composer-editor"]')
  const textarea = select('[data-slot="composer"] textarea')
  return {
    controls, modelChrome, group, editor: editorRect, viewportHeight: innerHeight, textarea,
    documentOverflow: document.documentElement.scrollWidth > innerWidth + 1,
    mainOverflow: main.scrollWidth > main.clientWidth + 1,
    modelText: label?.textContent ?? '',
    modelTruncated: !!label && getComputedStyle(label).textOverflow === 'ellipsis' && label.scrollWidth > label.clientWidth + 1,
    archiveLabel: archive.getAttribute('aria-label'), archiveVisibleText: archive.innerText.trim(), archiveWidth: controls.archive.width,
    bottomGap: editorRect.bottom - Math.max(controls.attach.bottom, controls.dictation.bottom, controls.archive.bottom, controls.continue.bottom),
  }
})()`

function overlaps(a: LayoutRect, b: LayoutRect): boolean {
  return Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1
    && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1
}

function expectUsableSessionControls(facts: SessionLayout, width: number, height: number): void {
  const { runner, model, effort, attach, dictation, archive, continue: submit } = facts.controls
  expect(Math.min(attach.top, dictation.top, archive.top, submit.top)).toBeGreaterThanOrEqual(Math.max(runner.bottom, model.bottom, effort.bottom) - 1)
  for (const [name, rect] of Object.entries(facts.controls)) {
    expect(rect.width, `${name} width`).toBeGreaterThanOrEqual(44)
    expect(rect.height, `${name} height`).toBeGreaterThanOrEqual(44)
    expect(rect.left, `${name} left edge`).toBeGreaterThanOrEqual(-1)
    expect(rect.right, `${name} right edge`).toBeLessThanOrEqual(width + 1)
    expect(rect.top, `${name} top edge`).toBeGreaterThanOrEqual(-1)
    expect(rect.bottom, `${name} bottom edge`).toBeLessThanOrEqual(height + 1)
    expect(rect.hit, `${name} center hit`).toBe(true)
  }
  const entries = Object.entries(facts.controls)
  for (const [i, [firstName, firstRect]] of entries.entries()) {
    for (const [secondName, secondRect] of entries.slice(i + 1)) {
      expect(overlaps(firstRect, secondRect), `${firstName} overlaps ${secondName}`).toBe(false)
    }
  }
  for (const [name, rect] of Object.entries(facts.modelChrome)) {
    expect(rect.left, `Model ${name} left edge`).toBeGreaterThanOrEqual(model.left - 1)
    expect(rect.right, `Model ${name} right edge`).toBeLessThanOrEqual(model.right + 1)
  }
  expect(facts.modelChrome.label.width, 'Model label remains visible').toBeGreaterThan(0)
  expect(overlaps(facts.modelChrome.icon, facts.modelChrome.label), 'Model icon overlaps label').toBe(false)
  expect(overlaps(facts.modelChrome.label, facts.modelChrome.chevron), 'Model label overlaps chevron').toBe(false)
  expect(overlaps(facts.modelChrome.icon, facts.modelChrome.chevron), 'Model icons overlap').toBe(false)
  expect(facts.textarea.left).toBeGreaterThanOrEqual(facts.editor.left - 1)
  expect(facts.textarea.right).toBeLessThanOrEqual(facts.editor.right + 1)
  expect(facts.editor.left).toBeGreaterThanOrEqual(-1)
  expect(facts.editor.right).toBeLessThanOrEqual(width + 1)
  expect(facts.documentOverflow).toBe(false)
  expect(facts.mainOverflow).toBe(false)
}

// #478/#460: real fixture values and real browser geometry, including the narrow action collision.
describe('responsive session composer', () => {
  it('ends after normal padding, without an idle band below the action row', () => {
    browser.setViewport(390, 844)
    browser.goto(`${baseUrl}${scoped(`/tasks/${LONG_RUN.id}`)}`)
    browser.waitForFunction(`document.querySelector('[data-slot="follow-up-model-pill"]')?.textContent?.includes('${LONG_RUN.model}') === true && !!document.querySelector('[data-slot="composer-actions"] [aria-label="Continue"]')`)
    browser.evaluate(`document.querySelector('[data-slot="composer-editor"]').scrollIntoView({block:'end'})`)
    const facts = waitForSettledSample(browser, sessionLayoutExpression) as SessionLayout
    expectEditorFitsViewport(facts)
    expect(facts.bottomGap).toBeGreaterThanOrEqual(0)
    expect(facts.bottomGap).toBeLessThanOrEqual(20)
  }, 90_000)

  it.each(['light', 'dark'])('keeps all four actions separate at 360×640 / %s', (theme) => {
    browser.setViewport(360, 640)
    browser.goto(`${baseUrl}${scoped(`/tasks/${LONG_RUN.id}`)}`)
    browser.waitForFunction(`document.querySelector('[data-slot="follow-up-model-pill"]')?.textContent?.includes('${LONG_RUN.model}') === true && !!document.querySelector('[data-slot="composer-actions"] [aria-label="Continue"]')`)
    browser.evaluate(`document.documentElement.classList.toggle('light', ${theme === 'light'}); document.querySelector('[data-slot="composer-editor"]').scrollIntoView({block:'end'})`)
    const facts = waitForSettledSample(browser, sessionLayoutExpression) as SessionLayout
    expectEditorFitsViewport(facts)
    const actions = [facts.controls.attach, facts.controls.dictation, facts.controls.archive, facts.controls.continue]
    for (const [i, action] of actions.entries()) {
      expect(action.hit, `action ${i} center hit`).toBe(true)
      for (const [offset, other] of actions.slice(i + 1).entries()) {
        expect(overlaps(action, other), `actions ${i} and ${i + offset + 1} overlap`).toBe(false)
      }
    }
    expect(facts.archiveWidth).toBeLessThanOrEqual(56)
    expect(facts.archiveLabel).toBe('Archive task')
  }, 90_000)

  it.each([
    { width: 360, height: 640 }, { width: 390, height: 844 },
    { width: 768, height: 900 }, { width: 800, height: 900 }, { width: 1440, height: 900 },
  ].flatMap(size => ['light', 'dark'].map(theme => ({ ...size, theme }))))('keeps settings and actions usable at $width×$height / $theme', ({ width, height, theme }) => {
    browser.setViewport(width, height)
    browser.goto(`${baseUrl}${scoped(`/tasks/${LONG_RUN.id}`)}`)
    browser.waitForFunction(`document.querySelector('[data-slot="follow-up-model-pill"]')?.textContent?.includes('${LONG_RUN.model}') === true && !!document.querySelector('[data-slot="composer-actions"] [aria-label="Continue"]')`)
    browser.evaluate(`document.documentElement.style.setProperty('--default-transition-duration', '0s'); document.documentElement.classList.toggle('light', ${theme === 'light'}); document.querySelector('[data-slot="composer-editor"]').scrollIntoView({block:'end'})`)
    const facts = waitForSettledSample(browser, sessionLayoutExpression) as SessionLayout
    expectEditorFitsViewport(facts)
    const { runner, model, effort } = facts.controls

    // The fixture must reach the pill, not silently resolve to the automatic model.
    expect(facts.modelText).toContain(LONG_RUN.model)
    expect(facts.group.left).toBeGreaterThanOrEqual(facts.editor.left - 1)
    expect(facts.group.right).toBeLessThanOrEqual(facts.editor.right + 1)
    if (width >= 768) {
      expect(Math.max(runner.top, model.top, effort.top) - Math.min(runner.top, model.top, effort.top)).toBeLessThanOrEqual(2)
      expect(runner.right).toBeLessThan(model.left)
      expect(model.right).toBeLessThan(effort.left)
      if (width >= 1024) {
        expect(model.width).toBeGreaterThan(runner.width)
        expect(model.width).toBeGreaterThan(effort.width)
      } else {
        expect(facts.modelTruncated).toBe(true)
      }
      expect(runner.width).toBeLessThanOrEqual(200)
      expect(effort.width).toBeLessThanOrEqual(200)
      expect(facts.group.right - effort.right).toBeLessThanOrEqual(2)
      expect(facts.archiveWidth).toBeGreaterThan(90)
      expect(facts.archiveVisibleText).toContain('Archive task')
    } else {
      expect(Math.abs(runner.top - effort.top)).toBeLessThanOrEqual(2)
      expect(model.top).toBeGreaterThanOrEqual(Math.max(runner.bottom, effort.bottom) - 1)
      expect(Math.abs(model.width - facts.group.width)).toBeLessThanOrEqual(2)
      expect(facts.modelTruncated).toBe(true)
      expect(facts.archiveWidth).toBeLessThanOrEqual(56)
    }
    expectUsableSessionControls(facts, width, height)
    expect(facts.bottomGap).toBeGreaterThanOrEqual(0)
    expect(facts.bottomGap).toBeLessThanOrEqual(20)
    expect(facts.archiveLabel).toBe('Archive task')

    // WCAG AA: small text 4.5:1; meaningful icons 3:1, sampled over their painted surfaces.
    const textTargets: Array<[string, string]> = [
      ['Runner value', '[data-slot="session-controls"] [aria-label^="Runner · "]'],
      ['Runner label', '[data-slot="session-controls"] [aria-label^="Runner · "] [data-slot="picker-label"] > span'],
      ['Model value', '[data-slot="follow-up-model-pill"]'],
      ['Model label', '[data-slot="follow-up-model-pill"] [data-slot="picker-label"] > span'],
      ['Effort value', '[data-slot="follow-up-effort-pill"]'],
      ['Effort label', '[data-slot="follow-up-effort-pill"] [data-slot="picker-label"] > span'],
      ['Send', '[data-slot="composer-actions"] [aria-label="Continue"]'],
    ]
    if (width >= 768) textTargets.push(['Archive task', '[data-slot="composer-actions"] [aria-label="Archive task"]'])
    const textSamples: Array<{ target: string } & ContrastSample> = []
    for (const [name, selector] of textTargets) {
      if (name.endsWith(' label') && browser.count(selector) === 0) continue
      const sample = browser.evaluate(contrastSampleExpression(selector)) as ContrastSample
      textSamples.push({ target: name, ...sample })
      expect(sample.ratio, `${theme} ${width}px ${name} text contrast`).toBeGreaterThanOrEqual(4.5)
    }
    const iconTargets: Array<[string, string]> = [
      ['Runner', '[data-slot="session-controls"] [aria-label^="Runner · "] svg:first-child'],
      ['Model', '[data-slot="follow-up-model-pill"] svg:first-child'],
      ['Effort', '[data-slot="follow-up-effort-pill"] svg:first-child'],
      ['Attach files', '[data-slot="composer"] [aria-label="Attach files"] svg'],
      ['Start dictation', '[data-slot="composer"] [aria-label="Start dictation"] svg'],
      ['Archive task', '[data-slot="composer-actions"] [aria-label="Archive task"] svg'],
      ['Send', '[data-slot="composer-actions"] [aria-label="Continue"] svg'],
    ]
    const iconSamples: Array<{ target: string } & ContrastSample> = []
    for (const [name, selector] of iconTargets) {
      const sample = browser.evaluate(contrastSampleExpression(selector)) as ContrastSample
      iconSamples.push({ target: name, ...sample })
      expect(sample.ratio, `${theme} ${width}px ${name} icon contrast`).toBeGreaterThanOrEqual(3)
    }
    mkdirSync(artifactsDir, { recursive: true })
    writeFileSync(join(artifactsDir, `responsive-session-contrast-${width}-${theme}.json`), JSON.stringify({
      viewport: { width, height }, theme,
      minimumTextRatio: Math.min(...textSamples.map(({ ratio }) => ratio)),
      minimumIconRatio: Math.min(...iconSamples.map(({ ratio }) => ratio)),
      textSamples, iconSamples,
    }, null, 2))

    browser.fill('[data-slot="composer"] textarea', 'Keep these follow-up instructions')
    const draft = browser.waitForValue(`document.querySelector('[data-slot="composer"] textarea')?.value === 'Keep these follow-up instructions' ? document.querySelector('[data-slot="composer"] textarea').value : null`)
    expect(draft).toBe('Keep these follow-up instructions')
    const sendLabel = browser.waitForValue(`document.querySelector('[data-slot="composer-submit-row"]')?.textContent?.includes('Send') ? document.querySelector('[data-slot="composer-submit-row"]').textContent : null`)
    expect(sendLabel).toContain('Send')
    browser.screenshot(`${artifactsDir}/responsive-session-${width}-${theme}.png`, { viewport: true })
    browser.evaluate(`document.querySelector('[aria-label="Run actions"]').scrollIntoView({block:'center'})`)
    browser.click('[aria-label="Run actions"]')
    browser.waitForFunction(`document.querySelector('[data-slot="run-actions-menu"]')?.textContent?.includes('Notes') === true`)
    browser.press('Escape')
    const preservedDraft = browser.waitForValue(`document.querySelector('[data-slot="run-actions-menu"]') === null ? document.querySelector('[data-slot="composer"] textarea')?.value : null`)
    expect(preservedDraft).toBe('Keep these follow-up instructions')
  }, 90_000)

  it('keeps the composer usable at 800px after widening the sidebar through its resize handle', () => {
    // 800px of session column: the project rail (#618) takes 60px of the viewport from `md` up.
    const viewport = 800 + 60
    browser.setViewport(viewport, 900)
    browser.goto(`${baseUrl}${scoped(`/tasks/${LONG_RUN.id}`)}`)
    browser.waitForFunction(`document.querySelector('[data-slot="follow-up-model-pill"]')?.textContent?.includes('${LONG_RUN.model}') === true && !!document.querySelector('[data-slot="sidebar-resize-handle"]')`)
    const sidebarWidth = () => waitForSettledSample(browser, `document.querySelector('[data-slot="sidebar"]').getBoundingClientRect().width`) as number
    const handlePoint = () => waitForSettledSample(browser, `(() => {
      const r = document.querySelector('[data-slot="sidebar-resize-handle"]')?.getBoundingClientRect()
      return r ? { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } : null
    })()`) as { x: number; y: number }
    expect(sidebarWidth()).toBe(264)
    const start = handlePoint()
    browser.dragTo(start, { x: start.x + 156, y: start.y })
    browser.waitForFunction(`document.querySelector('[data-slot="sidebar"]').getBoundingClientRect().width === 420`)
    try {
      browser.evaluate(`document.querySelector('[data-slot="composer-editor"]').scrollIntoView({block:'end'})`)
      const facts = waitForSettledSample(browser, sessionLayoutExpression) as SessionLayout
      expectEditorFitsViewport(facts)
      const { runner, model, effort } = facts.controls
      expect(facts.modelText).toContain(LONG_RUN.model)
      expect(Math.max(runner.top, model.top, effort.top) - Math.min(runner.top, model.top, effort.top)).toBeLessThanOrEqual(2)
      expect(runner.right).toBeLessThan(model.left)
      expect(model.right).toBeLessThan(effort.left)
      expect(facts.group.left).toBeGreaterThanOrEqual(facts.editor.left - 1)
      expect(facts.group.right).toBeLessThanOrEqual(facts.editor.right + 1)
      expectUsableSessionControls(facts, viewport, 900)
      expect(facts.archiveLabel).toBe('Archive task')
      browser.screenshot(`${artifactsDir}/responsive-session-800-wide-sidebar.png`, { viewport: true })
    } finally {
      const end = handlePoint()
      browser.dragTo(end, { x: end.x - 156, y: end.y })
      browser.waitForFunction(`document.querySelector('[data-slot="sidebar"]').getBoundingClientRect().width === 264`)
    }
  }, 90_000)

  it('keeps Runner, Model and Effort together while dictation is recording', () => {
    browser.setViewport(390, 844)
    browser.goto(`${baseUrl}${scoped(`/tasks/${LONG_RUN.id}`)}`)
    browser.waitForFunction(`document.querySelector('[data-slot="follow-up-model-pill"]')?.textContent?.includes('${LONG_RUN.model}') === true`)
    browser.evaluate(`(() => {
      class FakeRecognition { start() {} stop() {} abort() {} }
      window.SpeechRecognition = FakeRecognition
      window.webkitSpeechRecognition = FakeRecognition
      document.querySelector('[data-slot="composer-editor"]').scrollIntoView({block:'end'})
      return true
    })()`)
    browser.click('[aria-label="Start dictation"]')
    const recording = browser.waitForValue(`(() => {
      const overlay = document.querySelector('[data-slot="dictation-overlay"]')
      const groups = [...document.querySelectorAll('[data-slot="composer"] [data-slot="session-controls"]')]
      if (!overlay || groups.length !== 1) return null
      const group = document.querySelector('[data-slot="composer"] [data-slot="session-controls"]')
      return { runner: !!group?.querySelector('[aria-label^="Runner · "]'), model: group?.querySelector('[data-slot="follow-up-model-pill"]')?.textContent ?? null, effort: !!group?.querySelector('[data-slot="follow-up-effort-pill"]') }
    })()`) as { runner: boolean; model: string | null; effort: boolean }
    expect(recording.runner).toBe(true)
    expect(recording.model, 'Model stays in the recording settings group').not.toBeNull()
    expect(recording.model ?? '').toContain(LONG_RUN.model)
    expect(recording.effort).toBe(true)
    browser.click('[aria-label="Cancel dictation"]')
    browser.waitForFunction(`document.querySelector('[data-slot="dictation-overlay"]') === null && document.querySelector('[data-slot="composer-toolbar"]') !== null`)
  }, 90_000)
})

it.each([375, 1280])('uses the readable agent type scale and preserves full tool commands at %ipx (#522)', (width) => {
  browser.setViewport(width, 800)
  browser.goto(`${baseUrl}${scoped(`/tasks/${RUN_ID}`)}`)
  const facts = waitForSettledSample(browser, `(() => {
    const message = document.querySelector('[data-slot="assistant-message"]');
    const body = message?.querySelector(':scope > div');
    const eyebrow = message?.querySelector(':scope > p');
    const command = document.querySelector('[data-slot="tool-card"][data-kind="execute"] > button code');
    if (!body || !eyebrow || !command) return null;
    const rendered = body.checkVisibility({ contentVisibilityAuto: true });
    message.scrollIntoView({ block: 'center' });
    if (!rendered) return null;
    const style = getComputedStyle(body);
    const cardStyle = getComputedStyle(message);
    return { fontSize: style.fontSize, lineHeight: style.lineHeight,
      width: body.getBoundingClientRect().width, maxWidth: style.maxWidth,
      availableWidth: message.clientWidth - parseFloat(cardStyle.paddingLeft) - parseFloat(cardStyle.paddingRight),
      eyebrowLineHeight: getComputedStyle(eyebrow).lineHeight,
      command: command.textContent, title: command.title,
      overflow: getComputedStyle(command).textOverflow, whiteSpace: getComputedStyle(command).whiteSpace };
  })()`) as { fontSize: string; lineHeight: string; width: number; maxWidth: string; availableWidth: number; eyebrowLineHeight: string; command: string; title: string; overflow: string; whiteSpace: string }
  expect(facts.fontSize).toBe(width < 768 ? '15px' : '14px')
  expect(facts.lineHeight).toBe(width < 768 ? '24px' : '22.4px')
  expect(facts.maxWidth).toBe('none')
  expect(Math.abs(facts.width - facts.availableWidth)).toBeLessThanOrEqual(1)
  expect(facts.eyebrowLineHeight).toBe('13.2px')
  expect(facts.title).toBe(facts.command)
  expect(facts.overflow).toBe('ellipsis')
  expect(facts.whiteSpace).toBe('nowrap')
})

it.each(TYPO_RUNS.flatMap(run => [360, 906, 1280].map(width => ({ run, width }))))(
  'offers $run.model its available follow-up width at $width px (#522)', ({ run, width }) => {
    browser.setViewport(width, 800)
    browser.evaluate(`localStorage.setItem('cez-sidebar-width', '264')`)
    browser.goto(`${baseUrl}${scoped(`/tasks/${run.id}`)}`)
    browser.waitForFunction(`document.querySelector('[data-slot="follow-up-model-pill"]')?.getAttribute('aria-label') === 'Model · ${run.model}'`)
    const facts = waitForSettledSample(browser, `(() => {
      const group = document.querySelector('.session-engine-controls');
      const read = (slot) => {
        const pill = group.querySelector('[data-slot="' + slot + '"]');
        const label = pill.querySelector('[data-slot="picker-label"]');
        const full = pill.getAttribute('aria-label');
        const value = full.slice(full.indexOf(' · ') + 3);
        const fullWidth = label.previousElementSibling.getBoundingClientRect().width;
        const available = label.getBoundingClientRect().width;
        return { full, value, text: label.textContent, fullWidth, available,
          overflow: getComputedStyle(label).textOverflow, scrollWidth: label.scrollWidth, clientWidth: label.clientWidth };
      };
      return { runner: read('runner-pill'), model: read('follow-up-model-pill'), effort: read('follow-up-effort-pill'),
        groupWidth: group.getBoundingClientRect().width, grid: getComputedStyle(group).gridTemplateColumns,
        dockWidth: document.querySelector('[data-slot="thread-dock"]').getBoundingClientRect().width,
        chevronDisplay: getComputedStyle(group.querySelector('[data-slot="runner-pill"] > svg:last-child')).display };
    })()`) as { runner: { full: string; value: string; text: string; fullWidth: number; available: number }; model: { full: string; value: string; text: string; fullWidth: number; available: number; overflow: string; scrollWidth: number; clientWidth: number }; effort: { full: string; value: string; text: string; fullWidth: number; available: number }; groupWidth: number; grid: string; dockWidth: number; chevronDisplay: string }
    // Row-level rule (#541): a prefix shows only when every pill in the row fits with its own.
    const pills = Object.entries({ runner: facts.runner, model: facts.model, effort: facts.effort })
    const allFit = pills.every(([, pill]) => pill.fullWidth <= pill.available + 0.5)
    for (const [field, pill] of pills) {
      expect(pill.text, `${width}px ${run.model}: ${field} prefix follows the whole row`).toBe(allFit ? pill.full : pill.value)
    }
    if (width === 1280 && run.model.startsWith('opencode/')) {
      expect(facts.model.scrollWidth, `${width}px: full model ID visible without an ellipsis`).toBeLessThanOrEqual(facts.model.clientWidth)
      expect(facts.model.text).toBe(run.model)
      expect(facts.runner.text).toBe('opencode')
      expect(facts.effort.text).toBe('auto')
    }
    for (const slot of ['runner-pill', 'follow-up-model-pill', 'follow-up-effort-pill']) {
      const pill = browser.evaluate(`document.querySelector('.session-engine-controls [data-slot="${slot}"]').title`) as string
      expect(pill, `${width}px ${slot}: tooltip keeps the full value`).toContain(' · ')
    }
    if (width === 906 && run.model === 'grok-4.6') {
      expect(facts.groupWidth).toBeGreaterThan(300)
      expect(facts.runner.text).toBe('Runner · opencode')
      expect(facts.effort.text).toBe('Effort · auto')
      expect(facts.model.text, JSON.stringify(facts)).toBe('Model · grok-4.6')
    }
    if (width === 360 && run.model.startsWith('opencode/')) {
      expect(facts.model.scrollWidth).toBeGreaterThan(facts.model.clientWidth)
      expect(facts.model.overflow).toBe('ellipsis')
    }
    browser.evaluate(`document.querySelector('[data-slot="composer-editor"]')?.scrollIntoView({ block: 'end' })`)
    mkdirSync(artifactsDir, { recursive: true })
    browser.screenshot(`${artifactsDir}/522-followup-${run.model === 'grok-4.6' ? 'short' : 'long'}-${width}.png`, { viewport: true })
  },
)

it('ellipsizes a bare OpenCode command and reveals it on expansion (#522)', () => {
  browser.setViewport(906, 800)
  browser.goto(`${baseUrl}${scoped('/tasks/typography-short-model')}`)
  browser.waitForFunction(`document.querySelector('[data-slot="tool-card"][data-kind="execute"]') !== null`)
  const facts = waitForSettledSample(browser, `(() => {
    const card = document.querySelector('[data-slot="tool-card"][data-kind="execute"]');
    const rendered = card.checkVisibility({ contentVisibilityAuto: true });
    card.scrollIntoView({ block: 'center' });
    if (!rendered) return null;
    const button = card.querySelector('button');
    const code = button.querySelector('code');
    return { code: code?.textContent, title: code?.title, overflow: code && getComputedStyle(code).textOverflow,
      width: code?.getBoundingClientRect().width, rowWidth: button.getBoundingClientRect().width };
  })()`) as { code?: string; title?: string; overflow?: string; width?: number; rowWidth: number }
  expect(facts.code).toBe(BARE_COMMAND)
  expect(facts.title).toBe(BARE_COMMAND)
  expect(facts.overflow).toBe('ellipsis')
  expect(facts.width).toBeLessThan(facts.rowWidth)
  browser.evaluate(`document.querySelector('[data-slot="tool-card"][data-kind="execute"]')?.scrollIntoView({ block: 'center' })`)
  browser.screenshot(`${artifactsDir}/522-opencode-command-collapsed.png`, { viewport: true })
  browser.click('[data-slot="tool-card"][data-kind="execute"] > button')
  browser.waitForFunction(`document.querySelector('[data-slot="tool-card"][data-kind="execute"] [data-slot="tool-command"]') !== null`)
  expect(browser.text('[data-slot="tool-card"][data-kind="execute"] [data-slot="tool-command"]')).toBe(BARE_COMMAND)
  browser.screenshot(`${artifactsDir}/522-opencode-command-expanded.png`, { viewport: true })
})
