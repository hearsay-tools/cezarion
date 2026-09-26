import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { AgentBrowser, bootProjectId, fixtureServeEnv } from './agent-browser'
import { largeThreadEvents } from './fixtures/make-large-thread'
import record from './fixtures/thread-run.record.json'
import { waitForHealth } from './poll'

const repoRoot = resolve(import.meta.dirname, '../../..')
const artifactsDir = resolve(repoRoot, '.ai/qa/artifacts_e2e')
const sessionId = `e2e-progressive-history-${process.pid}`
const RUN_ID = 'cccccccc-1111-4222-8333-dddddddddddd'
const RUN_B_ID = 'eeeeeeee-1111-4222-8333-ffffffffffff'
const RUN = {
  ...record,
  id: RUN_ID,
  title: 'Progressively page a very long session',
  titleSummary: 'Progressively page a long session',
  task: 'Inspect a long session without downloading the archive.',
  status: 'running',
  finishedAt: undefined,
  // Same local day as the rewritten event `ts` below. The record fixture's createdAt is
  // 2026-07-14; events are restamped to 2026-07-30. After #435 that 16-day gap inserted a
  // day-separator as the first non-task row, and `preserves a virtual history anchor
  // behind the task prefix` timed out waiting on `turn-seq-2768:day-separator`
  // (local bundle `.ai/qa/failures/progressive-history/preserves-a-virtual-history-anchor-behind-the-task-prefix-at-360px-1`).
  createdAt: '2026-07-30T00:00:00.000Z',
  steps: [record.steps[0]],
  pullRequestUrl: undefined,
}
const RUN_B = {
  ...RUN,
  id: RUN_B_ID,
  title: 'Restore a second long session without jumping',
  titleSummary: 'Restore a second long session',
  task: 'Keep a second long session at its cached reading position.',
}

const contextPrefix = [
  {
    type: 'turn.started',
    turnId: 'context-turn',
    stepId: 'task',
  },
  {
    type: 'plan.updated',
    stepId: 'task',
    entries: [{ content: 'Keep the current plan visible', status: 'in_progress' }],
  },
  {
    type: 'item.started',
    stepId: 'task',
    item: {
      kind: 'tool',
      id: 'history-agent',
      name: 'Task',
      toolKind: 'task',
      title: 'Task: watch current history work',
      status: 'running',
    },
  },
]

const events = [...contextPrefix, ...largeThreadEvents(300)].map((event, index) => ({
  ...event,
  seq: index + 1,
  ts: new Date(Date.parse('2026-07-30T00:00:00.000Z') + index * 10).toISOString(),
}))

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port = typeof address === 'object' && address ? address.port : 0
      probe.close(() => resolvePort(port))
    })
  })
}


let browser: AgentBrowser
let server: ChildProcess
let dataRoot: string
let baseUrl: string
let bootProject: string

const cursorRequestCount = `performance.getEntriesByType('resource').filter((entry) => {
  const url = new URL(entry.name)
  return url.pathname.endsWith('/runs/${RUN_ID}/history') && url.searchParams.has('cursor')
}).length`

function activateHistoryBoundary(): void {
  browser.evaluate(`document.querySelector('[data-slot="history-boundary"] button').focus()`)
  browser.press('Enter')
}

type HistoryAnchor = {
  key: string
  top: number
  scrollTop: number
  maxTop: number
  virtualized: string | null
  mountedRows: number
}

const MAIN = `document.querySelector('[data-slot="main"]')`

function historyAnchorSample(rowExpr: string): string {
  return `(() => {
    const main = ${MAIN}
    const rows = document.querySelector('[data-slot="thread-rows"]')
    const row = ${rowExpr}
    if (!main || !row) return null
    return {
      key: row.dataset.rowKey,
      top: row.getBoundingClientRect().top,
      scrollTop: main.scrollTop,
      maxTop: main.scrollHeight - main.clientHeight,
      virtualized: rows?.dataset.virtualized ?? null,
      mountedRows: main.querySelectorAll('[data-slot="thread-row"]').length,
    }
  })()`
}

function historyAnchorDiagnostics(): string {
  return JSON.stringify(
    browser.evaluate(`(() => {
      const main = ${MAIN}
      return {
        idle: window.__cezIdle,
        mountedKeys: [...document.querySelectorAll('[data-slot="thread-row"][data-row-key]')].map(
          (row) => row.dataset.rowKey,
        ),
        scrollTop: main?.scrollTop ?? null,
        scrollHeight: main?.scrollHeight ?? null,
        clientHeight: main?.clientHeight ?? null,
        retainedPages: document.querySelector('[data-slot="history-boundary"]')?.dataset.retainedPages ?? null,
        virtualized: document.querySelector('[data-slot="thread-rows"]')?.dataset.virtualized ?? null,
      }
    })()`),
  )
}

function waitUntilCockpitIdle(): void {
  try {
    browser.waitForStable(`window.__cezIdle !== false`, { holdMs: 50 })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`${message}\n${historyAnchorDiagnostics()}`)
  }
}

function settleHistoryAnchor(rowExpr: string): HistoryAnchor {
  try {
    return browser.waitForStable(
      `(() => {
        const main = ${MAIN}
        if (!main) return null
        return ${historyAnchorSample(rowExpr)}
      })()`,
      { holdMs: 200 },
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`${message}\n${historyAnchorDiagnostics()}`)
  }
}

function parkAndSettleHistoryStart(): HistoryAnchor {
  browser.evaluate(`(() => {
    const main = ${MAIN}
    // Unpin while still at the live tail so a later wheel at the boundary cannot load a page.
    main.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true }))
    // Virtua ignores a raw scrollTop write; the e2e seam goes through the scroll owner.
    window.__cezThreadScrollTo?.(0)
  })()`)
  browser.waitForValue(
    `document.querySelector('[data-slot="main"]')?.scrollTop ?? null`,
    (top): top is number => typeof top === 'number' && top <= 2,
  )
  return settleHistoryAnchor(`main.querySelector('[data-slot="thread-row"][data-row-key]')`)
}

function settleNamedHistoryAnchor(key: string): HistoryAnchor {
  return settleHistoryAnchor(
    `main.querySelector(${JSON.stringify(`[data-slot="thread-row"][data-row-key="${key}"]`)})`,
  )
}

type ArrivalSample = { top: number; maxTop: number }

/** Capture every destination-transcript animation frame around a client-side task switch. */
function navigateAndSampleArrival(runId: string): ArrivalSample[] {
  const href = `/p/${bootProject}/tasks/${runId}`
  browser.evaluate(`(() => {
    const link = document.querySelector(${JSON.stringify(`a[href="${href}"]`)})
    if (!link) throw new Error('missing task navigation link: ${href}')
    const samples = []
    let attempts = 0
    const sample = () => {
      attempts += 1
      const main = document.querySelector('[data-slot="main"]')
      const destination = document.querySelector(
        ${JSON.stringify(`[data-route="task-thread"][data-run-id="${runId}"]`)},
      )
      const ready = destination?.querySelector('[data-slot="thread-rows"]')
      if (main && ready) {
        samples.push({
          top: main.scrollTop,
          maxTop: main.scrollHeight - main.clientHeight,
        })
      }
      if (samples.length < 6 && attempts < 120) requestAnimationFrame(sample)
      else document.documentElement.dataset.e2eArrival = JSON.stringify(samples)
    }
    delete document.documentElement.dataset.e2eArrival
    requestAnimationFrame(sample)
    link.click()
  })()`)
  const packed = browser.waitForValue(
    `document.documentElement.dataset.e2eArrival || null`,
    (value): value is string => typeof value === 'string' && value.length > 2,
  )
  browser.evaluate(`delete document.documentElement.dataset.e2eArrival`)
  return JSON.parse(packed) as ArrivalSample[]
}

function parkCurrentThread(): number {
  return Number(browser.evaluate(`(() => {
    const main = document.querySelector('[data-slot="main"]')
    main.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true }))
    main.scrollTop = Math.max(160, Math.round((main.scrollHeight - main.clientHeight) / 2))
    main.dispatchEvent(new Event('scroll', { bubbles: true }))
    return main.scrollTop
  })()`))
}

beforeAll(async () => {
  dataRoot = mkdtempSync(join(tmpdir(), 'cezar-e2e-progressive-history-'))
  mkdirSync(join(dataRoot, '.ai/cezar/runs'), { recursive: true })
  writeFileSync(join(dataRoot, '.ai/cezar/runs.json'), JSON.stringify([RUN, RUN_B], null, 2), 'utf8')
  for (const runId of [RUN_ID, RUN_B_ID]) {
    writeFileSync(
      join(dataRoot, '.ai/cezar/runs', `${runId}.ndjson`),
      events.map((event) => JSON.stringify(event)).join('\n') + '\n',
      'utf8',
    )
  }
  const port = await freePort()
  baseUrl = `http://localhost:${port}`
  server = spawn(
    process.execPath,
    [join(repoRoot, 'packages/cezar/dist/index.js'), 'serve', '--repo', dataRoot, '--port', String(port), '--no-open'],
    { env: fixtureServeEnv(dataRoot), stdio: 'ignore' },
  )
  await waitForHealth(baseUrl)
  bootProject = await bootProjectId(baseUrl)
  browser = AgentBrowser.open(sessionId)
  browser.setViewport(1440, 900)
  browser.goto(`${baseUrl}/p/${bootProject}/tasks/${RUN_ID}`)
  browser.waitForFunction(
    `document.querySelector('[data-route="task-thread"]') !== null &&
     document.querySelector('[data-slot="thread-rows"]') !== null`,
  )
  browser.waitForFunction(
    `document.querySelector('[data-slot="history-boundary"]')?.dataset.retainedPages === '1' &&
     document.querySelector('[data-slot="history-boundary"] button:not([disabled])') !== null`,
  )
  waitUntilCockpitIdle()
}, 120_000)

afterAll(() => {
  browser?.close()
  server?.kill()
  try {
    if (dataRoot) rmSync(dataRoot, { recursive: true, force: true })
  } catch {
    // The killed fixture may still be releasing its transcript file; the OS reaps the temp dir.
  }
})

describe('progressive long-session history', () => {
  it('paints the current tail and docks without requesting an earlier page', () => {
    expect(Number(browser.evaluate(cursorRequestCount))).toBe(0)
    // Both live in the one Run activity card now (#402): the section heads carry the meters,
    // and the plan's own entries appear once its row is opened.
    expect(browser.text('[data-slot="run-activity-subagents"] [data-slot="run-activity-meta"]')).toBe('0 of 1 complete')
    // A programmatic toggle: this spec's thread is still settling into follow-tail, so a
    // coordinate click can land on whatever scrolled under the pointer.
    browser.evaluate(`document.querySelector('[data-slot="run-activity-plan"] > button').click()`)
    browser.waitForFunction(`document.querySelector('[data-slot="plan-list"]') !== null`)
    expect(browser.text('[data-slot="run-activity-plan"]')).toContain('Keep the current plan visible')
    expect(browser.count('[data-slot="thread-row"]')).toBeLessThan(300)
    browser.screenshot(join(artifactsDir, 'progressive-history-tail.png'), { viewport: true })
  })

  it('loads exactly one page, preserves the visible anchor, and bounds retained pages', async () => {
    const before = parkAndSettleHistoryStart()
    expect(before.key).toBeTruthy()
    expect(before.scrollTop).toBeLessThanOrEqual(2)

    activateHistoryBoundary()
    browser.waitForFunction(`${cursorRequestCount} === 1`)
    browser.waitForFunction(
      `document.querySelector('[data-slot="history-boundary"]')?.dataset.retainedPages === '2'`,
    )
    expect(Number(browser.evaluate(cursorRequestCount))).toBe(1)

    const after = settleNamedHistoryAnchor(before.key)
    expect(
      Math.abs(after.top - before.top),
      `anchor jumped ${Math.abs(after.top - before.top)}px ${JSON.stringify({ before, after })}`,
    ).toBeLessThan(2)

    browser.screenshot(join(artifactsDir, 'progressive-history-earlier-page.png'), { viewport: true })
    // Let the prepend anchor's requestAnimationFrame settle before the next test supplies
    // a genuinely fresh upward gesture.
    await new Promise((resolveWait) => setTimeout(resolveWait, 50))
  })

  it('consumes one upward intent without cascading while the boundary remains near', async () => {
    browser.evaluate(`(() => {
      const main = document.querySelector('[data-slot="main"]')
      main.scrollTop = 0
      main.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true }))
    })()`)
    browser.waitForFunction(`${cursorRequestCount} === 2`)
    await new Promise((resolveWait) => setTimeout(resolveWait, 500))
    expect(Number(browser.evaluate(cursorRequestCount))).toBe(2)
  })

  it('caps retained pages at five and jumps directly back to a fresh tail', () => {
    let page = Number(browser.evaluate(
      `document.querySelector('[data-slot="history-boundary"]')?.dataset.retainedPages`,
    ))
    while (page < 5) {
      page += 1
      activateHistoryBoundary()
      browser.waitForFunction(
        `document.querySelector('[data-slot="history-boundary"]')?.dataset.retainedPages === '${page}'`,
      )
    }
    expect(Number(browser.evaluate(
      `document.querySelector('[data-slot="history-boundary"]')?.dataset.retainedPages`,
    ))).toBe(5)
    browser.evaluate(`document.querySelector('[data-slot="main"]').scrollTop = 0`)
    browser.click('[data-slot="jump-to-latest"]')
    browser.waitForFunction(
      `document.querySelector('[data-slot="history-boundary"]')?.dataset.retainedPages === '1'`,
    )
    browser.waitForFunction(
      `(() => { const m = document.querySelector('[data-slot="main"]'); return Math.abs(m.scrollHeight - m.clientHeight - m.scrollTop) < 2 })()`,
    )
    browser.waitForFunction(`document.querySelector('[data-slot="jump-to-latest"]') === null`)
    expect(browser.evaluate(`document.body.textContent.includes('goal achieved — session closed')`)).toBe(true)
  })

  it('switches between cached and live-tail threads without a near-zero destination frame', () => {
    // The preceding paging case deliberately visited the archive boundary. Establish the first
    // run's departure state as an explicit live-tail cache entry before warming the second run.
    browser.evaluate(`(() => {
      const main = document.querySelector('[data-slot="main"]')
      main.dispatchEvent(new WheelEvent('wheel', { deltaY: 120, bubbles: true }))
      main.scrollTop = main.scrollHeight - main.clientHeight
      main.dispatchEvent(new Event('scroll', { bubbles: true }))
    })()`)
    browser.waitForFunction(
      `(() => { const main = document.querySelector('[data-slot="main"]'); return main.scrollHeight - main.scrollTop - main.clientHeight < 80 })()`,
    )

    // Warm both query caches first. The destination transcript, not a loading placeholder, is
    // the surface whose paint ordering this regression measures.
    const firstTailArrival = navigateAndSampleArrival(RUN_B_ID)
    expect(firstTailArrival.at(-1)!.maxTop - firstTailArrival.at(-1)!.top).toBeLessThan(80)
    const parked = parkCurrentThread()
    expect(parked).toBeGreaterThan(100)

    const liveTailArrival = navigateAndSampleArrival(RUN_ID)
    expect(Math.min(...liveTailArrival.map(({ top }) => top))).toBeGreaterThan(40)
    expect(liveTailArrival.at(-1)!.maxTop - liveTailArrival.at(-1)!.top).toBeLessThan(80)

    const cachedArrival = navigateAndSampleArrival(RUN_B_ID)
    expect(Math.min(...cachedArrival.map(({ top }) => top))).toBeGreaterThan(40)
    expect(Math.abs(cachedArrival[0]!.top - parked)).toBeLessThan(200)
    expect(Math.abs(cachedArrival.at(-1)!.top - parked)).toBeLessThan(200)
    browser.screenshot(join(artifactsDir, 'progressive-history-thread-switch.png'), { viewport: true })

    browser.setViewport(390, 844)
    const mobileTailArrival = navigateAndSampleArrival(RUN_ID)
    expect(Math.min(...mobileTailArrival.map(({ top }) => top))).toBeGreaterThan(40)
    expect(mobileTailArrival.at(-1)!.maxTop - mobileTailArrival.at(-1)!.top).toBeLessThan(80)
    browser.screenshot(join(artifactsDir, 'progressive-history-thread-switch-mobile.png'), {
      viewport: true,
    })
    browser.setViewport(1440, 900)
  }, 90_000)

  it.each([360, 1440])('preserves a virtual history anchor behind the task prefix at %ipx', (width) => {
    browser.setViewport(width, width === 360 ? 640 : 900)
    browser.goto(`${baseUrl}/p/${bootProject}/tasks/${RUN_ID}?thread=virtual`)
    browser.waitForFunction(
      `document.querySelector('[data-slot="history-boundary"]')?.dataset.retainedPages === '1' &&
       document.querySelector('[data-slot="thread-rows"]')?.dataset.virtualized === 'true'`,
    )
    waitUntilCockpitIdle()
    parkAndSettleHistoryStart()
    browser.evaluate(`(() => {
      const main = ${MAIN}
      const row = main.querySelector('[data-slot="thread-row"][data-row-key]:not([data-row-key="task"])')
      main.scrollTop += row.getBoundingClientRect().top - main.getBoundingClientRect().top + 1
      main.dispatchEvent(new Event('scroll', { bubbles: true }))
    })()`)
    const before = settleHistoryAnchor(`main.querySelector('[data-slot="thread-row"][data-row-key]:not([data-row-key="task"])')`)
    // Invoke without moving focus: HTMLElement.click() focuses, and at 360px the wrapped
    // task prefix has already scrolled the boundary out of view, so that focus jumps the
    // scroller to the top and loadOlder captures the wrong anchor.
    const invoked = browser.evaluate(`(() => {
      const main = ${MAIN}
      const button = document.querySelector('[data-slot="history-boundary"] button')
      const scrollTop = main.scrollTop
      button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      return {
        before: scrollTop,
        after: main.scrollTop,
        focused: document.activeElement === button,
      }
    })()`) as { before: number; after: number; focused: boolean }
    expect(invoked.focused, JSON.stringify(invoked)).toBe(false)
    expect(Math.abs(invoked.after - invoked.before), JSON.stringify(invoked)).toBeLessThan(2)
    browser.waitForFunction(
      `document.querySelector('[data-slot="history-boundary"]')?.dataset.retainedPages === '2'`,
    )
    const after = settleNamedHistoryAnchor(before.key)
    expect(Math.abs(after.top - before.top), JSON.stringify({ before, after })).toBeLessThan(2)
    parkAndSettleHistoryStart()
    expect(browser.evaluate(`(() => {
      const task = document.querySelector('[data-row-key="task"]')
      return task && getComputedStyle(task).visibility === 'visible' && task.getBoundingClientRect().height > 0
    })()`)).toBe(true)
    expect(browser.evaluate(`(() => {
      const rows = [...document.querySelectorAll('[data-slot="thread-row"]')]
        .filter(row => getComputedStyle(row).visibility === 'visible')
        .map(row => row.getBoundingClientRect())
      return rows.every((row, index) => index === 0 || row.top >= rows[index - 1].bottom - 1)
    })()`)).toBe(true)
  }, 90_000)
})
