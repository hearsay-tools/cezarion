import type { ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { AgentBrowser, bootProjectId, cezarCli, fixtureServeEnv } from './agent-browser'
import { contrastSampleExpression, type ContrastSample } from './contrast'
import { captureFixtureServer, spawnFixtureServer, stopFixtureServer, waitForFixtureServer } from './fixture-server'
import { seedTranscript } from './seed-transcript'
// fixture-server starts: 1

/**
 * The pinned pending question (hearsay-tools/cezarion#1495): a waiting task whose open
 * question sits far above the newest history page, behind an earlier answered question.
 */
const RUN_ID = 'abababab-1495-4222-8333-cdcdcdcdcdcd'
const OTHER_ID = 'abababab-1495-4222-8333-efefefefefef'
const now = '2026-10-23T10:00:00.000Z'
const LATER_MESSAGES = 260

const lines: Array<Record<string, unknown>> = [
  { type: 'step-start', stepId: 'task', name: 'Do the task', kind: 'agent', iteration: 1 },
  { type: 'session.started', sessionId: 'a0000000-0000-4000-8000-000000001495', backend: 'claude', stepId: 'task' },
  { type: 'turn.started', turnId: 'turn_1', stepId: 'task' },
  { type: 'ask.requested', stepId: 'task', requestId: 'answered-question', questions: [{ header: 'Earlier', question: 'Which branch is the base?', options: [{ label: 'main' }, { label: 'develop' }] }] },
]
const answeredSeq = lines.length
lines.push(
  { type: 'human-input-delivered', stepId: 'task', askSeq: answeredSeq },
  { type: 'user-message', stepId: 'task', text: 'main', imageCount: 0 },
  { type: 'turn.started', turnId: 'turn_2', stepId: 'task' },
  { type: 'ask.requested', stepId: 'task', requestId: 'pending-question', questions: [{ header: 'Approach', question: 'Which approach should I take?', options: [{ label: 'Minimal', description: 'Small change' }, { label: 'Expanded', description: 'Wider change' }] }] },
)
const pendingSeq = lines.length
for (let index = 1; index <= LATER_MESSAGES; index += 1) {
  lines.push({ type: 'item.completed', stepId: 'task', item: { kind: 'message', id: `later_${index}`, role: 'assistant', text: `Worker update ${index}: still monitoring.` } })
}
const events = lines.map((line, index) => ({ ...line, seq: index + 1, ts: new Date(Date.parse(now) + index * 10).toISOString(), runId: RUN_ID }))

const record = (id: string, title: string, extra: Record<string, unknown> = {}) => ({
  id, title, titleSummary: title, task: title, workflow: 'quick-task', runner: 'claude', status: 'done', createdAt: now,
  tokensUsed: 0, archived: false, steps: [{ id: 'task', name: 'Do the task', kind: 'agent', status: 'done', iterations: 1, tokensUsed: 0 }], ...extra,
})
const RUNS = [
  record(RUN_ID, 'Answer a question far above the tail', {
    status: 'waiting',
    steps: [{ id: 'task', name: 'Do the task', kind: 'agent', status: 'running', iterations: 1, tokensUsed: 0, sessionId: 'a0000000-0000-4000-8000-000000001495' }],
    waits: [{ id: randomUUID(), kind: 'human', source: 'agent', via: 'ask-line', registeredAt: now, phase: 'open', turnId: 'turn_2', askSeq: pendingSeq }],
  }),
  record(OTHER_ID, 'Another finished task'),
]

const MAIN = `document.querySelector('[data-slot="main"]')`
const PILL = '[data-slot="jump-to-latest"]'
const PINNED = '[data-slot="ask-card"][data-pinned="true"]'
const FIRST_CHIP = `${PINNED} [data-slot="ask-question"] button`
const cursorRequests = `performance.getEntriesByType('resource').filter((entry) => {
  const url = new URL(entry.name)
  return url.pathname.endsWith('/runs/${RUN_ID}/history') && url.searchParams.has('cursor')
}).length`

let browser: AgentBrowser
let server: ChildProcess
let dataRoot: string
let baseUrl: string
let project: string
let diagnostics: ReturnType<typeof captureFixtureServer> | undefined

beforeAll(async () => {
  dataRoot = mkdtempSync(join(tmpdir(), 'cezar-e2e-pending-question-'))
  mkdirSync(join(dataRoot, '.ai/cezar/runs'), { recursive: true })
  writeFileSync(join(dataRoot, '.ai/cezar/runs.json'), JSON.stringify(RUNS, null, 2), 'utf8')
  seedTranscript(join(dataRoot, '.ai/cezar/runs', `${RUN_ID}.ndjson`), events.map(event => JSON.stringify(event)).join('\n') + '\n')
  server = spawnFixtureServer([cezarCli, 'serve', '--repo', dataRoot, '--port', '0', '--no-open'], {
    env: fixtureServeEnv(dataRoot, { CEZ_AUTONAME: '0' }),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  diagnostics = captureFixtureServer(server)
  try {
    baseUrl = await waitForFixtureServer(server)
  } catch (error) {
    throw new Error(`${String(error)}\nFixture startup: ${JSON.stringify(diagnostics())}`, { cause: error })
  }
  project = await bootProjectId(baseUrl)
  browser = AgentBrowser.open(`e2e-pending-question-${process.pid}`)
}, 120_000)

afterAll(async () => {
  browser?.close()
  await stopFixtureServer(server)
  if (dataRoot) rmSync(dataRoot, { recursive: true, force: true })
})

function openTask(width: number, height: number, query = ''): void {
  browser.setViewport(width, height)
  browser.goto(`${baseUrl}/p/${project}/tasks/${RUN_ID}${query}`)
  browser.waitForFunction(`document.querySelector(${JSON.stringify(PINNED)}) !== null`)
  browser.waitForStable(`window.__cezIdle !== false`, { holdMs: 50 })
}

/** Leave the tail through the scroll owner, as a reader scrolling up would. */
function scrollAwayFromTail(): void {
  browser.evaluate(`(() => {
    ${MAIN}.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true }))
    window.__cezThreadScrollTo(Math.max(0, Math.round((${MAIN}.scrollHeight - ${MAIN}.clientHeight) / 3)))
  })()`)
  browser.waitForValue(`document.querySelector(${JSON.stringify(PILL)})?.textContent ?? null`,
    (text): text is string => text === 'Jump to latest (1 question pending)',
    { failure: 'the pill did not name the pending question' })
}

function inViewport(selector: string): string {
  return `(() => {
    const element = document.querySelector(${JSON.stringify(selector)})
    if (!element) return false
    const box = element.getBoundingClientRect()
    return box.bottom > 0 && box.top < innerHeight
  })()`
}

// `?thread=virtual` forces virtua's rows: the newest page alone stays under its threshold.
describe.each([
  { name: 'desktop', width: 1440, height: 900, query: '' },
  { name: '360×640', width: 360, height: 640, query: '' },
  { name: 'desktop, virtualized rows', width: 1440, height: 900, query: '?thread=virtual' },
])('the pinned pending question at $name', ({ width, height, query }) => {
  it('pins the pending question at the tail and never answers the earlier one', () => {
    openTask(width, height, query)
    expect(browser.evaluate(`document.querySelector('[data-slot="thread-rows"]')?.dataset.virtualized ?? null`)).toBe(query ? 'true' : 'false')
    expect(browser.count('[data-slot="ask-card"][data-resolved="false"]')).toBe(1)
    expect(browser.text(PINNED)).toContain('Which approach should I take?')
    // The origin is far above the newest page, so only the pinned copy is loaded.
    expect(browser.count('[data-slot="ask-origin"]')).toBe(0)
    expect(Number(browser.evaluate(cursorRequests))).toBe(0)
  })

  it('keyboard activation of the pill focuses the first answer chip', () => {
    openTask(width, height, query)
    scrollAwayFromTail()
    browser.evaluate(`document.querySelector(${JSON.stringify(PILL)}).focus()`)
    browser.press('Enter')
    browser.waitForValue(`(() => {
      const chip = document.querySelector(${JSON.stringify(FIRST_CHIP)})
      return chip !== null && document.activeElement === chip && ${inViewport(FIRST_CHIP)}
    })()`, (value): value is true => value === true, { failure: 'the first chip of the pinned question did not take focus in view' })
    browser.waitForFunction(`document.querySelector(${JSON.stringify(PILL)}) === null`)
  })

  it('"Show where it was asked" loads older history and focuses the marker', () => {
    openTask(width, height, query)
    browser.evaluate(`document.querySelector('[data-slot="ask-show-origin"]').focus()`)
    browser.press('Enter')
    browser.waitForValue(`(() => {
      const marker = document.querySelector('[data-slot="ask-origin"]')
      return marker !== null && document.activeElement === marker && ${inViewport('[data-slot="ask-origin"]')}
    })()`, (value): value is true => value === true, { failure: 'the marker did not take focus in view', timeoutMs: 30_000 })
    expect(Number(browser.evaluate(cursorRequests))).toBeGreaterThan(0)
    // The answered question stays a summary and is never focused.
    expect(browser.evaluate(`document.activeElement?.closest('[data-resolved="true"]') === null`)).toBe(true)
    expect(browser.count('[data-slot="ask-card"][data-resolved="false"]')).toBe(1)

    const marker = '[data-slot="ask-go-to-question"]'
    const box = browser.evaluate(`(() => { const r = document.querySelector(${JSON.stringify(marker)}).getBoundingClientRect(); return { w: r.width, h: r.height } })()`) as { w: number; h: number }
    expect(box.w).toBeGreaterThanOrEqual(44)
    expect(box.h).toBeGreaterThanOrEqual(44)
    for (const theme of ['dark', 'light'] as const) {
      browser.evaluate(`document.documentElement.classList.toggle('light', ${theme === 'light'})`)
      const sample = browser.waitForValue<ContrastSample>(contrastSampleExpression(marker), (value) => value !== null)
      expect(sample.ratio, `marker link in ${theme}`).toBeGreaterThanOrEqual(4.5)
    }
    browser.evaluate(`document.documentElement.classList.remove('light')`)
    browser.evaluate(`document.querySelector(${JSON.stringify(marker)}).focus()`)
    browser.press('Enter')
    browser.waitForValue(`document.activeElement === document.querySelector(${JSON.stringify(FIRST_CHIP)})`,
      (value): value is true => value === true, { failure: 'Go to the question did not focus the first chip' })
  })

  it('keeps 44×44 targets and readable contrast in light and dark themes', () => {
    openTask(width, height, query)
    scrollAwayFromTail()
    for (const selector of [PILL, '[data-slot="ask-show-origin"]']) {
      const box = browser.evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { w: r.width, h: r.height } })()`) as { w: number; h: number }
      expect(box.w, selector).toBeGreaterThanOrEqual(44)
      expect(box.h, selector).toBeGreaterThanOrEqual(44)
    }
    for (const theme of ['dark', 'light'] as const) {
      browser.evaluate(`document.documentElement.classList.toggle('light', ${theme === 'light'})`)
      for (const selector of [PILL, '[data-slot="ask-show-origin"]']) {
        const sample = browser.waitForValue<ContrastSample>(contrastSampleExpression(selector), (value) => value !== null)
        expect(sample.ratio, `${selector} in ${theme}`).toBeGreaterThanOrEqual(4.5)
      }
    }
    browser.evaluate(`document.documentElement.classList.remove('light')`)
  })
})

describe('reopening and reduced motion', () => {
  it('reopening the task keeps the pinned question and its labelled pill', () => {
    openTask(1440, 900)
    browser.goto(`${baseUrl}/p/${project}/tasks/${OTHER_ID}`)
    browser.waitForFunction(`document.querySelector('[data-route="task-thread"][data-run-id="${OTHER_ID}"]') !== null`)
    openTask(1440, 900)
    expect(browser.count(PINNED)).toBe(1)
    scrollAwayFromTail()
  })

  it('jumps instantly under reduced motion', () => {
    browser.setReducedMotion()
    openTask(1440, 900)
    scrollAwayFromTail()
    browser.click(PILL)
    browser.waitForValue(`document.activeElement === document.querySelector(${JSON.stringify(FIRST_CHIP)}) && ${inViewport(FIRST_CHIP)}`,
      (value): value is true => value === true, { failure: 'the reduced-motion jump did not land on the first chip' })
  })
})
