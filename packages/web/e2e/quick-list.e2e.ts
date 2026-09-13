import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { AgentBrowser, bootProjectId, cezarCli, fixtureServeEnv } from './agent-browser'
import {
  applyContrastQaVariant,
  contrastQaVariants,
  contrastSampleExpression,
  focusWithKeyboard,
  restoreContrastQaDefaults,
  type ContrastSample,
} from './contrast'

/**
 * The task quick-list, in a real browser, against a real cezar serving real runs.
 *
 * Why this spec boots its own server instead of using the shared test env: the run store reads
 * `.ai/cezar/runs.json` **once, at startup** (`RunStore.open`) and is in-memory from then on, so
 * writing that file under the already-running instance would change nothing — the way the inbox
 * spec can, because todos are file-watched and re-broadcast. The list would just render the empty
 * state. And "whatever runs happen to be in the dev checkout" is not a fixture: it is whatever the
 * last person did.
 *
 * So: a throwaway data dir, a fixture `runs.json`, one `node dist/index.js serve --repo <tmp>`.
 * The fixture is not invented data — `runs.json` is cezar's documented state contract (a
 * `RunRecord[]`, the exact shape `GET /api/v1/runs` answers with and `src/runs/store.ts` parses with
 * zod). If a record here were wrong, the store would drop it and these assertions would fail.
 *
 * Deliberate limitation: the statuses below are all terminal (`review`/`done`/`failed`). A serve
 * boot *recovers* live runs — `manager.recover()` re-queues `queued`, settles `waiting`, resumes
 * `running` — so a fixture cannot hold those still, and the "Working" bucket is therefore not
 * covered here. It is covered by the jsdom tests, which drive the component directly.
 */

const artifactsDir = resolve(import.meta.dirname, '../../../.ai/qa/artifacts_e2e')
const runId = `e2e-quick-list-${process.pid}`

const now = Date.now()
const ago = (ms: number) => new Date(now - ms).toISOString()

/** A `RunRecord[]` — cezar's on-disk run index. */
const FIXTURE = [
  {
    id: 'fix-review-pr',
    // The raw title is the user's prompt-ish phrasing; `titleSummary` is what the server derived
    // on turn-end (#389). Every surface must show the summary — the raw title appearing anywhere
    // is a regression these specs now catch.
    title: 'add a structured changes endpoint plz',
    titleSummary: 'Structured changes endpoint for the git view',
    workflow: 'default',
    task: 'add a structured changes endpoint',
    status: 'review',
    createdAt: ago(40 * 60_000),
    finishedAt: ago(26 * 60_000),
    tokensUsed: 128_400,
    inputTokens: 999_900,
    outputTokens: 888_800,
    costUsd: 123.45,
    diffStat: { adds: 128, dels: 14, files: 6 },
    peakRssBytes: 1023 * 1024 ** 2,
    pullRequestUrl: 'https://github.com/open-mercato/cezar/pull/396',
    archived: false,
    steps: [],
  },
  {
    id: 'fix-var-a',
    title: 'Add skills autocomplete to composer (A)',
    workflow: 'default',
    task: 'add skills autocomplete',
    status: 'review',
    createdAt: ago(30 * 60_000),
    finishedAt: ago(12 * 60_000),
    tokensUsed: 96_249,
    runner: 'claude',
    groupId: 'fix-group-1',
    variant: 'A',
    archived: false,
    steps: [],
  },
  {
    id: 'fix-var-b',
    title: 'Add skills autocomplete to composer (B)',
    workflow: 'default',
    task: 'add skills autocomplete',
    status: 'review',
    createdAt: ago(30 * 60_000),
    finishedAt: ago(11 * 60_000),
    tokensUsed: 41_800,
    runner: 'codex',
    groupId: 'fix-group-1',
    variant: 'B',
    archived: false,
    steps: [],
  },
  {
    id: 'fix-done',
    title: 'README parallel-agents tagline',
    workflow: 'default',
    task: 'update the readme',
    status: 'done',
    createdAt: ago(3 * 3_600_000),
    finishedAt: ago(2 * 3_600_000),
    tokensUsed: 12_000,
    diffStat: { adds: 9, dels: 2, files: 1 },
    archived: false,
    steps: [],
  },
  {
    id: 'fix-failed',
    title: 'Bump zod to v4',
    workflow: 'default',
    task: 'bump zod',
    status: 'failed',
    createdAt: ago(4 * 3_600_000),
    finishedAt: ago(3 * 3_600_000),
    tokensUsed: 4_100,
    error: 'checks failed',
    archived: false,
    steps: [],
  },
  {
    id: 'fix-archived',
    title: 'Sync merged PR issues',
    workflow: 'default',
    task: 'sync issues',
    status: 'done',
    createdAt: ago(30 * 3_600_000),
    finishedAt: ago(29 * 3_600_000),
    tokensUsed: 8_000,
    archived: true,
    archivedAt: ago(28 * 3_600_000),
    steps: [],
  },
]

function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const probe = createServer()
    probe.once('error', fail)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port = typeof address === 'object' && address ? address.port : 0
      probe.close(() => done(port))
    })
  })
}

async function waitForHealth(url: string): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      if ((await fetch(`${url}/api/v1/health`)).ok) return
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(`cezar e2e: the fixture server never answered at ${url}`)
}

let browser: AgentBrowser
let server: ChildProcess
let dataRoot: string
let baseUrl: string
let bootProject: string

const ROW = '[data-slot="task-row"]'
const TILE = '[data-slot="group-tile"]'

/** A flat route target under this server's own project prefix (multi-project spec, step 3.2).
 *  Every in-app link the cockpit renders is scoped, so every href assertion below is too. */
const scoped = (path: string) => `/p/${bootProject}${path}`

/** An element's `textContent`, not the provider's `get text` — that returns *rendered* text, so a
 *  flex row comes back newline-separated and every assertion here would be about whitespace. */
const textOf = (selector: string) =>
  browser.evaluate(`document.querySelector(${JSON.stringify(selector)}).textContent`) as string

/** The rendered rows/tiles under one bucket header, in DOM order. */
const rowsIn = (label: string) =>
  browser.evaluate(`(() => {
    const bucket = document.querySelector('[data-bucket=${JSON.stringify(label)}]')
    if (!bucket) return null
    return [...bucket.querySelectorAll('${ROW}, ${TILE}')].map((el) => el.textContent.trim())
  })()`) as string[] | null

beforeAll(async () => {
  dataRoot = mkdtempSync(join(tmpdir(), 'cezar-e2e-'))
  mkdirSync(join(dataRoot, '.ai/cezar'), { recursive: true })
  writeFileSync(join(dataRoot, '.ai/cezar/runs.json'), JSON.stringify(FIXTURE, null, 2), 'utf8')

  const port = await freePort()
  baseUrl = `http://localhost:${port}`
  server = spawn(process.execPath, [cezarCli, 'serve', '--repo', dataRoot, '--port', String(port), '--no-open'], {
    // Dry-run + a pinned CEZ_HOME, exactly as the shared test env does — see `fixtureServeEnv`.
    // Nothing in this spec starts a run, but the boot probes the backends.
    env: fixtureServeEnv(dataRoot),
    stdio: 'ignore',
  })
  await waitForHealth(baseUrl)
  bootProject = await bootProjectId(baseUrl)

  browser = AgentBrowser.open(runId)
  browser.setViewport(1440, 900)
}, 90_000)

afterAll(() => {
  browser?.close()
  server?.kill()
  if (dataRoot) rmSync(dataRoot, { recursive: true, force: true })
})

describe('task quick-list', () => {
  beforeAll(() => {
    browser.goto(`${baseUrl}${scoped('/')}`)
    // The list is async — it renders once `/api/v1/runs` answers.
    browser.waitForFunction(`document.querySelector('[data-slot="quick-list-bucket"]') !== null`)
  })

  it('serves the fixture through the real API', async () => {
    // The store parsed and kept every record: if the shape were wrong, zod would have dropped the
    // index and the sidebar below would be asserting against an empty list that "passes" nothing.
    const runs = (await fetch(`${baseUrl}/api/v1/runs`).then((r) => r.json())) as Array<{ id: string }>
    expect(runs.map((r) => r.id).sort()).toEqual(
      ['fix-archived', 'fix-done', 'fix-failed', 'fix-review-pr', 'fix-var-a', 'fix-var-b'].sort()
    )
  })

  it('groups unpinned runs in Recent while retaining independent status rows', () => {
    expect(browser.evaluate(`[...document.querySelectorAll('[data-slot="quick-list-bucket"] h2')].map(h => h.textContent)`)).toEqual(['Recent'])
    expect(browser.evaluate(`[...document.querySelectorAll('[data-slot="quick-list-bucket"] [data-slot="task-row"]')].map(row => row.dataset.runId)`)).toEqual(['fix-review-pr', 'fix-done', 'fix-failed'])
    expect(browser.count('[data-slot="quick-list-bucket"] [data-slot="group-tile"]')).toBe(1)
    expect(browser.text('[data-slot="quick-list-bucket"]')).toContain('Structured changes endpoint for the git view')
  })

  it('keeps selected and hovered sidebar task metadata AA-readable', () => {
    const selectedRow = '[data-slot="task-row"][data-run-id="fix-done"]'
    const hoveredRow = '[data-slot="task-row"][data-run-id="fix-failed"]'
    const age = (row: string) => `${row} span.tabular-nums`

    browser.goto(`${baseUrl}${scoped('/tasks/fix-done')}`)
    browser.waitForFunction(`document.querySelector('${selectedRow}[data-active="true"]') !== null`)
    try {
      for (const variant of contrastQaVariants.filter(({ viewport }) => viewport.width === 1440)) {
        applyContrastQaVariant(browser, variant)
        const selected = browser.evaluate(contrastSampleExpression(age(selectedRow))) as ContrastSample
        expect(
          selected.ratio,
          `${variant.id} selected: ${selected.foreground} on ${selected.background}`,
        ).toBeGreaterThanOrEqual(4.5)

        browser.hover(hoveredRow)
        const hovered = browser.evaluate(contrastSampleExpression(age(hoveredRow))) as ContrastSample
        expect(
          hovered.ratio,
          `${variant.id} hover: ${hovered.foreground} on ${hovered.background}`,
        ).toBeGreaterThanOrEqual(4.5)
        browser.screenshot(`${artifactsDir}/issue-165-task-sidebar-${variant.id}.png`, { viewport: true })
      }
    } finally {
      restoreContrastQaDefaults(browser)
      browser.goto(`${baseUrl}${scoped('/')}`)
      browser.waitForFunction(`document.querySelector('[data-slot="quick-list-bucket"]') !== null`)
    }
  })

  it('renders the diff pair through the success/danger tokens, not as plain text', () => {
    const pair = browser.evaluate(`(() => {
      const el = document.querySelector('[data-slot="task-row"][data-run-id="fix-review-pr"] [data-slot="diff-stat"]')
      if (!el) return null
      const [adds, dels] = el.querySelectorAll('span')
      return {
        adds: adds.textContent, dels: dels.textContent,
        // Resolved by the real CSS: green ≠ red proves the two tokens actually applied.
        addsColor: getComputedStyle(adds).color, delsColor: getComputedStyle(dels).color,
      }
    })()`) as { adds: string; dels: string; addsColor: string; delsColor: string } | null

    expect(pair?.adds).toBe('+128')
    expect(pair?.dels).toBe('−14')
    expect(pair?.addsColor).not.toBe(pair?.delsColor)
  })

  it('paints one dot per row, in the tone deriveAttention picked', () => {
    const tones = browser.evaluate(`(() => {
      const of = (id) => {
        const dot = document.querySelector('[data-run-id="' + id + '"] [data-slot="status-dot"]')
        return dot && { tone: dot.dataset.tone, pulses: getComputedStyle(dot).animationName !== 'none' }
      }
      return { review: of('fix-review-pr'), done: of('fix-done'), failed: of('fix-failed') }
    })()`) as Record<string, { tone: string; pulses: boolean }>

    expect(tones.review).toEqual({ tone: 'accent', pulses: true })
    // Terminal rows are still — the pulse means "transitioning", and these are not.
    expect(tones.done).toEqual({ tone: 'success', pulses: false })
    expect(tones.failed).toEqual({ tone: 'danger', pulses: false })

    // The design system's size rule, resolved by the real CSS rather than asserted from a class.
    expect(
      browser.evaluate(
        `getComputedStyle(document.querySelector('[data-run-id="fix-done"] [data-slot="status-dot"]')).width`
      )
    ).toBe('10px')
  })

  it('links a row to its task, and the PR chip to the PR', () => {
    expect(browser.evaluate(`document.querySelector('[data-run-id="fix-done"] a').getAttribute('href')`)).toBe(
      scoped('/tasks/fix-done')
    )

    const chip = browser.evaluate(`(() => {
      const el = document.querySelector('[data-run-id="fix-review-pr"] [data-slot="pr-chip"]')
      return { href: el.href, target: el.target }
    })()`) as { href: string; target: string }
    expect(chip.href).toBe('https://github.com/open-mercato/cezar/pull/396')
    expect(chip.target).toBe('_blank')

    // Only the run that has one.
    expect(browser.count('[data-run-id="fix-done"] [data-slot="pr-chip"]')).toBe(0)
  })

  it('expands the variant group into per-variant rows, and collapses it again', () => {
    // Scoped to the quick-list's rows: the Tasks table (Step 3.4) legitimately lists each
    // variant as its own row, so a bare data-run-id would match the table too.
    expect(browser.count(`${ROW}[data-run-id="fix-var-a"]`)).toBe(0)

    browser.click(TILE)
    browser.waitForFunction(`document.querySelector('${ROW}[data-run-id="fix-var-a"]') !== null`)
    // Historical fixtures have no directional counters: show each backend, never invent usage.
    expect(textOf(`${ROW}[data-run-id="fix-var-a"]`)).toBe('Aclaude')
    expect(textOf(`${ROW}[data-run-id="fix-var-b"]`)).toBe('Bcodex')
    // Each variant is still its own deep link.
    expect(
      browser.evaluate(`document.querySelector('${ROW}[data-run-id="fix-var-b"] a').getAttribute('href')`)
    ).toBe(scoped('/tasks/fix-var-b'))

    browser.screenshot(`${artifactsDir}/quick-list-expanded.png`)

    browser.click(TILE)
    browser.waitForFunction(`document.querySelector('${ROW}[data-run-id="fix-var-a"]') === null`)
  })

  it('lights the row for the task the route has open', () => {
    // A LEGACY flat deep link, on purpose: pre-multi-project bookmarks must still land, and the
    // cockpit rewrites them onto the boot project's scoped twin (BACKWARD_COMPATIBILITY.md).
    browser.goto(`${baseUrl}/tasks/fix-done`)
    browser.waitForFunction(`location.pathname === '${scoped('/tasks/fix-done')}'`)
    browser.waitForFunction(`document.querySelector('${ROW}[data-active]') !== null`)

    expect(browser.evaluate(`[...document.querySelectorAll('${ROW}[data-active]')].map((r) => r.dataset.runId)`)).toEqual(
      ['fix-done']
    )
    browser.screenshot(`${artifactsDir}/quick-list-active-row.png`)
  })

  it('switches to the archived view, and back', () => {
    browser.goto(`${baseUrl}${scoped('/')}`)
    browser.waitForFunction(`document.querySelector('[data-slot="quick-list-bucket"]') !== null`)
    browser.click('[data-slot="sidebar"] [aria-label="Tools"]')
    browser.waitForFunction(`document.querySelector('[data-slot="sidebar-session-scope"]') !== null`)
    expect(textOf('[data-slot="view-tab"][data-view="active"]')).toBe('Active5')
    expect(textOf('[data-slot="view-tab"][data-view="archived"]')).toBe('Archived1')

    browser.click('[data-slot="view-tab"][data-view="archived"]')
    browser.waitForFunction(`document.querySelector('[data-bucket="Archived"]') !== null`)
    expect(browser.text('[data-slot="quick-list-bucket"][data-bucket="Archived"]')).toContain('Sync merged PR issues')
    // The active runs are gone, not merely restyled.
    expect(browser.count(`${ROW}[data-run-id="fix-review-pr"]`)).toBe(0)

    browser.screenshot(`${artifactsDir}/quick-list-archived.png`)

    browser.click('[data-slot="view-tab"][data-view="active"]')
    browser.waitForFunction(`document.querySelector('[data-run-id="fix-review-pr"]') !== null`)
    browser.press('Escape')
  })
})

/**
 * The Tasks table overview (Step 3.4) — the same fixture server, through the real `/` home.
 *
 * Same deliberate limitation as above: every fixture status is terminal, so the live/queued
 * columns cannot be exercised here (a serve boot recovers non-terminal runs). Those are covered
 * by the jsdom suite (`src/routes/tasks-overview.test.tsx`), which drives the components with
 * queued/running records and a stubbed usage stream directly.
 */
describe('tasks table overview', () => {
  const TABLE_ROW = '[data-slot="task-table-row"]'
  function showResourceTable() {
    if (!browser.count('[data-slot="tasks-table"]')) return
    const visible = browser.evaluate(`document.querySelector('[data-slot="tasks-table"]').checkVisibility()`)
    if (visible) return
    browser.click('[data-slot="task-columns-trigger"]')
    browser.waitForFunction(`document.querySelector('[data-slot="popover-content"]')?.textContent.includes('Resource columns') === true`)
    browser.click('[data-slot="popover-content"] button:last-child')
    browser.press('Escape')
    browser.waitForFunction(`document.querySelector('[data-slot="tasks-table"]').getBoundingClientRect().width > 0`)
  }
  beforeEach(() => {
    if (browser.evaluate('innerWidth >= 768') && browser.count('[data-slot="task-columns-trigger"]')) showResourceTable()
  })


  beforeAll(() => {
    browser.setViewport(1440, 900)
    browser.goto(`${baseUrl}${scoped('/')}`)
    browser.waitForFunction(`document.querySelectorAll('${TABLE_ROW}').length > 0`)
  })

  it('is the home: the table renders every active fixture run with its status', () => {
    const rows = browser.evaluate(`[...document.querySelectorAll('${TABLE_ROW}')].map((tr) => ({
      id: tr.dataset.runId,
      status: tr.querySelector('[data-slot="pill"]').textContent,
    }))`) as Array<{ id: string; status: string }>

    expect(Object.fromEntries(rows.map((r) => [r.id, r.status]))).toEqual({
      'fix-review-pr': 'needs review',
      'fix-var-a': 'needs review',
      'fix-var-b': 'needs review',
      'fix-done': 'done',
      'fix-failed': 'failed',
    })
    // Needs-you first, history after — the sidebar's order, because it is the sidebar's sort.
    expect(rows.slice(0, 3).map((r) => r.id).sort()).toEqual(['fix-review-pr', 'fix-var-a', 'fix-var-b'])
    expect(rows.slice(3).map((r) => r.id)).toEqual(['fix-done', 'fix-failed'])

    // A spot check across the columns: tokens formatted, the PR chip numbered and pointed out —
    // and the Task cell shows the auto-summary, never the raw fixture title behind it.
    const reviewRow = browser.evaluate(`(() => {
      const tr = document.querySelector('${TABLE_ROW}[data-run-id="fix-review-pr"]')
      const pr = tr.querySelector('[data-slot="pr-chip"]')
      return { text: tr.textContent, prHref: pr.href, prTarget: pr.target }
    })()`) as { text: string; prHref: string; prTarget: string }
    expect(browser.evaluate(`document.querySelector('[data-run-id="fix-review-pr"] [aria-label="Input tokens: 999,900; output tokens: 888,800"]') !== null`)).toBe(true)
    expect(reviewRow.text).toContain('Structured changes endpoint for the git view')
    expect(reviewRow.text).not.toContain('add a structured changes endpoint plz')
    expect(reviewRow.prHref).toBe('https://github.com/open-mercato/cezar/pull/396')
    expect(reviewRow.prTarget).toBe('_blank')

    browser.screenshot(`${artifactsDir}/tasks-table.png`)
  })

  it('allocates two contained title lines without crowding desktop metadata or actions', () => {
    const title = 'Review shared task title prefix — documentation outcome'
    const unbroken = `Review-shared-task-title-prefix-${'distinguishing'.repeat(18)}`

    try {
      for (const theme of ['light', 'dark'] as const) {
        for (const density of ['comfortable', 'ultra'] as const) {
          browser.setViewport(1440, 900)
          browser.evaluate(`(() => {
            document.documentElement.classList.toggle('light', ${theme === 'light'})
            ${density === 'ultra'
              ? "document.documentElement.dataset.density = 'ultra'"
              : "delete document.documentElement.dataset.density"}
            const links = [...document.querySelectorAll('${TABLE_ROW} td[data-column-id="task"] a[href*="/tasks/"]')]
            links[0].textContent = ${JSON.stringify(title)}
            links[0].setAttribute('title', ${JSON.stringify(title)})
            links[1].textContent = ${JSON.stringify(unbroken)}
            links[1].setAttribute('title', ${JSON.stringify(unbroken)})
          })()`)

          const facts = browser.evaluate(`(() => {
            const rows = [...document.querySelectorAll('${TABLE_ROW}')]
            const firstCell = rows[0].querySelector('td[data-column-id="task"]')
            const firstLink = firstCell.querySelector('a[href*="/tasks/"]')
            const secondCell = rows[1].querySelector('td[data-column-id="task"]')
            const secondLink = secondCell.querySelector('a[href*="/tasks/"]')
            const suffix = 'documentation outcome'
            const textNode = firstLink.firstChild
            const range = document.createRange()
            range.setStart(textNode, textNode.textContent.indexOf(suffix))
            range.setEnd(textNode, textNode.textContent.length)
            const suffixRect = range.getBoundingClientRect()
            const firstRect = firstLink.getBoundingClientRect()
            const secondRect = secondLink.getBoundingClientRect()
            const secondCellRect = secondCell.getBoundingClientRect()
            const lineHeight = Number.parseFloat(getComputedStyle(firstLink).lineHeight)
            const workflow = rows[0].querySelector('td[data-column-id="workflow"]')
            workflow.textContent = 'workflow-name-that-is-deliberately-too-long-for-its-column'
            const status = rows[0].querySelector('td[data-column-id="status"]')
            const statusPill = status.querySelector('[data-slot="pill"]')
            statusPill.textContent = 'waiting on workers'
            const reference = document.querySelector('${TABLE_ROW}[data-run-id="fix-review-pr"] td[data-column-id="reference"]')
            const referenceChip = reference.querySelector('[data-slot="pr-chip"]')
            const referenceLabel = [...referenceChip.childNodes].find((node) => node.nodeType === Node.TEXT_NODE)
            referenceLabel.textContent = '#1234'
            const diff = document.querySelector('${TABLE_ROW}[data-run-id="fix-review-pr"] td[data-column-id="diff"]')
            const [adds, dels] = diff.querySelectorAll('[data-slot="diff-stat"] > span')
            adds.textContent = '+12k'
            dels.textContent = '−1k'
            diff.querySelector('[data-slot="diff-stat"]').setAttribute('title', '+12345 −1234 across 37 files')
            diff.querySelector('[data-slot="diff-stat"]').setAttribute('aria-label', '+12345 −1234 across 37 files')
            const workflowHeader = document.querySelector('th[data-column-id="workflow"]')
            const workflowHeaderButton = workflowHeader.querySelector('button')
            const metricsRow = document.querySelector('${TABLE_ROW}[data-run-id="fix-review-pr"]')
            const cpuCell = metricsRow.querySelector('td[data-column-id="cpu"]')
            const cpuMetric = cpuCell.firstElementChild
            cpuMetric.textContent = '100%'
            cpuMetric.setAttribute('title', '100%')
            cpuMetric.setAttribute('aria-label', '100%')
            const secondaryIds = ['tokens', 'cost', 'cpu', 'memory', 'started']
            const secondary = secondaryIds.map((id) => {
              const cell = metricsRow.querySelector('td[data-column-id="' + id + '"]')
              const style = getComputedStyle(cell)
              const rect = cell.getBoundingClientRect()
              const target = cell.firstElementChild || cell
              const targetRect = target.getBoundingClientRect()
              const targetStyle = getComputedStyle(target)
              const range = document.createRange()
              range.selectNodeContents(target)
              const content = range.getBoundingClientRect()
              const textFits = content.left >= rect.left + Number.parseFloat(style.paddingLeft) - 1 && content.right <= rect.right - Number.parseFloat(style.paddingRight) + 1
              const clipsOverflow = targetStyle.overflowX === 'hidden' && target.scrollWidth > target.clientWidth
              return {
                id,
                width: rect.width,
                contained: targetRect.left >= rect.left + Number.parseFloat(style.paddingLeft) - 1 && targetRect.right <= rect.right - Number.parseFloat(style.paddingRight) + 1 && (textFits || clipsOverflow),
                right: targetRect.right,
                clipsOverflow,
                label: cell.textContent,
                accessible: cell.firstElementChild?.getAttribute('aria-label') || cell.getAttribute('aria-label'),
                title: cell.firstElementChild?.getAttribute('title') || cell.getAttribute('title'),
              }
            })
            const memoryCell = metricsRow.querySelector('td[data-column-id="memory"]')
            const workflowStyle = getComputedStyle(workflow)
            const diffStyle = getComputedStyle(diff)
            const diffRect = diff.getBoundingClientRect()
            const diffRange = document.createRange()
            diffRange.selectNodeContents(diff.querySelector('[data-slot="diff-stat"]'))
            const diffTextRect = diffRange.getBoundingClientRect()
            const referenceContentRect = referenceChip.getBoundingClientRect()
            const workflowHeaderStyle = getComputedStyle(workflowHeader)
            const workflowHeaderRect = workflowHeader.getBoundingClientRect()
            const workflowHeaderContentRight = workflowHeaderRect.right - Number.parseFloat(workflowHeaderStyle.paddingRight)
            const workflowHeaderChildren = [...workflowHeaderButton.children].map((child) => child.getBoundingClientRect())
            return {
              taskWidth: firstCell.getBoundingClientRect().width,
              titleWidth: firstRect.width,
              workflowWidth: workflow.getBoundingClientRect().width,
              lineCount: Math.round(firstRect.height / lineHeight),
              suffixRect: { left: suffixRect.left, right: suffixRect.right, bottom: suffixRect.bottom },
              titleRect: { left: firstRect.left, right: firstRect.right, bottom: firstRect.bottom },
              suffixVisible: suffixRect.left >= firstRect.left - 1 && suffixRect.right <= firstRect.right + 1 && suffixRect.bottom <= firstRect.bottom + 1,
              unbrokenContained: getComputedStyle(secondLink).overflow === 'hidden' && secondLink.scrollWidth > secondLink.clientWidth && secondRect.right <= secondCellRect.right + 1,
              workflowContained: workflowStyle.overflow === 'hidden' && workflow.scrollWidth > workflow.clientWidth,
              statusContained: status.scrollWidth <= status.clientWidth + 1 && statusPill.getBoundingClientRect().right <= status.getBoundingClientRect().right + 1,
              referenceContained: reference.scrollWidth <= reference.clientWidth + 1 && referenceChip.getBoundingClientRect().right <= reference.getBoundingClientRect().right + 1 && [...referenceChip.querySelectorAll('svg')].every((glyph) => glyph.getBoundingClientRect().right <= reference.getBoundingClientRect().right + 1),
              referenceLabel: referenceChip.textContent,
              diffContained: diffTextRect.left >= diffRect.left + Number.parseFloat(diffStyle.paddingLeft) - 1 && diffTextRect.right <= diffRect.right - Number.parseFloat(diffStyle.paddingRight) + 1 && diffTextRect.right < referenceContentRect.left,
              workflowHeaderContained: workflowHeaderChildren.every((rect) => rect.left >= workflowHeaderRect.left + Number.parseFloat(workflowHeaderStyle.paddingLeft) - 1 && rect.right <= workflowHeaderContentRight + 1),
              memoryLabel: memoryCell.textContent,
              metricsBeforeNeighbors: secondary.slice(0, -1).every((metric, index) => {
                const nextCell = metricsRow.querySelector('td[data-column-id="' + secondaryIds[index + 1] + '"]')
                const nextStyle = getComputedStyle(nextCell)
                return metric.right < nextCell.getBoundingClientRect().left + Number.parseFloat(nextStyle.paddingLeft)
              }),
              secondary,
              pageContained: document.documentElement.scrollWidth <= window.innerWidth,
            }
          })()`) as {
            taskWidth: number
            titleWidth: number
            workflowWidth: number
            lineCount: number
            suffixRect: { left: number; right: number; bottom: number }
            titleRect: { left: number; right: number; bottom: number }
            suffixVisible: boolean
            unbrokenContained: boolean
            workflowContained: boolean
            statusContained: boolean
            referenceContained: boolean
            referenceLabel: string
            diffContained: boolean
            workflowHeaderContained: boolean
            memoryLabel: string
            metricsBeforeNeighbors: boolean
            secondary: Array<{ id: string; width: number; contained: boolean; right: number; clipsOverflow: boolean; label: string; accessible: string | null; title: string | null }>
            pageContained: boolean
          }

          expect(facts.taskWidth, `${theme}/${density}: task width`).toBeGreaterThanOrEqual(315)
          expect(facts.taskWidth, `${theme}/${density}: task vs workflow`).toBeGreaterThan(facts.workflowWidth * 2.5)
          expect(facts.lineCount, `${theme}/${density}: title lines`).toBe(2)
          expect(facts.suffixVisible, `${theme}/${density}: distinguishing suffix; ${JSON.stringify(facts)}`).toBe(true)
          expect(facts.unbrokenContained, `${theme}/${density}: unbroken title`).toBe(true)
          expect(facts.workflowContained, `${theme}/${density}: workflow ellipsis`).toBe(true)
          expect.soft(facts.statusContained, `${theme}/${density}: status pill`).toBe(true)
          expect.soft(facts.referenceContained, `${theme}/${density}: reference chip`).toBe(true)
          expect(facts.referenceLabel, `${theme}/${density}: compact reference label`).toBe('#1234')
          expect.soft(facts.diffContained, `${theme}/${density}: diff stat`).toBe(true)
          expect.soft(facts.workflowHeaderContained, `${theme}/${density}: workflow header`).toBe(true)
          expect(facts.memoryLabel, `${theme}/${density}: persisted memory metric`).toBe('peak 1023 MB')
          expect.soft(facts.metricsBeforeNeighbors, `${theme}/${density}: metrics before neighboring content`).toBe(true)
          expect(facts.secondary.slice(0, -1).every(({ width, contained }) => width > 0 && contained), `${theme}/${density}: ${JSON.stringify(facts.secondary)}`).toBe(true)
          expect(facts.secondary.filter(({ clipsOverflow }) => clipsOverflow).map(({ id }) => id)).toEqual(['tokens'])
          expect(facts.secondary.slice(0, -1).map(({ id, label, accessible, title }) => ({ id, label, accessible, title }))).toEqual([
            { id: 'tokens', label: '999.9k / 888.8k', accessible: 'Input tokens: 999,900; output tokens: 888,800', title: 'Input tokens: 999,900; output tokens: 888,800' },
            { id: 'cost', label: '$123', accessible: '$123.45', title: '$123.45' },
            { id: 'cpu', label: '100%', accessible: '100%', title: '100%' },
            { id: 'memory', label: 'peak 1023 MB', accessible: 'peak 1023 MB; peak — run finished', title: 'peak 1023 MB; peak — run finished' },
          ])
          expect(facts.pageContained, `${theme}/${density}: page overflow`).toBe(true)

          const row = `${TABLE_ROW}[data-run-id="fix-review-pr"]`
          focusWithKeyboard(browser, `${row} [data-slot="row-rename"]`)
          browser.waitForFunction(
            `getComputedStyle(document.querySelector('${row} [data-slot="row-rename"]')).opacity === '1'`,
          )
          const actions = browser.evaluate(`(() => {
            const cell = document.querySelector('${row} td[data-column-id="task"]')
            const bounds = cell.getBoundingClientRect()
            return [...cell.querySelectorAll('button')].map((button) => {
              const rect = button.getBoundingClientRect()
              return {
                label: button.getAttribute('aria-label'),
                active: document.activeElement === button,
                focusVisible: button.matches(':focus-visible'),
                opacity: getComputedStyle(button).opacity,
                contained: rect.left >= bounds.left && rect.right <= bounds.right,
              }
            })
          })()`) as Array<{ label: string; active: boolean; focusVisible: boolean; opacity: string; contained: boolean }>
          expect(actions.map(({ label }) => label)).toEqual(['Rename task', 'Pin task'])
          expect(actions.every(({ opacity, contained }) => opacity === '1' && contained), JSON.stringify(actions)).toBe(true)

          browser.screenshot(`${artifactsDir}/issue-167-tasks-1440-${theme}-${density}.png`, { viewport: true })
        }
      }

      const widthBeforeFold = Number(browser.evaluate(
        `document.querySelector('${TABLE_ROW} td[data-column-id="task"]').getBoundingClientRect().width`,
      ))
      browser.click('button[aria-label="Fold Workflow column"]')
      browser.waitForFunction(`document.querySelector('button[aria-label="Expand Workflow column"]') !== null`)
      const widthAfterFold = Number(browser.evaluate(
        `document.querySelector('${TABLE_ROW} td[data-column-id="task"]').getBoundingClientRect().width`,
      ))
      expect(widthAfterFold).toBeGreaterThanOrEqual(widthBeforeFold)
      browser.click('button[aria-label="Expand Workflow column"]')
      browser.waitForFunction(`document.querySelector('button[aria-label="Fold Workflow column"]') !== null`)

      browser.evaluate(`localStorage.setItem('cez-sidebar-width', '360')`)
      browser.goto(`${baseUrl}${scoped('/')}`)
      browser.waitForFunction(`document.querySelectorAll('${TABLE_ROW}').length > 0`)
      showResourceTable()
      const resized = browser.evaluate(`({
        preference: localStorage.getItem('cez-sidebar-width'),
        sidebarWidth: document.querySelector('[data-slot="sidebar"]').getBoundingClientRect().width,
        taskWidth: document.querySelector('${TABLE_ROW} td[data-column-id="task"]').getBoundingClientRect().width,
      })`) as { preference: string; sidebarWidth: number; taskWidth: number }
      expect(resized.preference).toBe('360')
      expect(resized.sidebarWidth).toBe(360)
      // The fixed table can distribute spare width beyond the task column's 320px minimum.
      expect(resized.taskWidth).toBeGreaterThanOrEqual(320)
    } finally {
      browser.evaluate(`(() => {
        localStorage.removeItem('cez-sidebar-width')
        document.documentElement.classList.remove('light')
        delete document.documentElement.dataset.density
      })()`)
      browser.setViewport(1440, 900)
      browser.goto(`${baseUrl}${scoped('/')}`)
      browser.waitForFunction(`document.querySelectorAll('${TABLE_ROW}').length > 0`)
    }
  })

  it('fills the ± column where a run recorded a diff, and keeps the honest dash where none exists', () => {
    // Column 5 is ± (Status | Task | Workflow | Branch | ±) — read it for every row at once.
    const diffs = browser.evaluate(`Object.fromEntries(
      [...document.querySelectorAll('${TABLE_ROW}')].map((tr) => [
        tr.dataset.runId,
        tr.querySelector('td:nth-child(5)').textContent,
      ])
    )`) as Record<string, string>

    expect(diffs).toEqual({
      'fix-review-pr': '+128 −14',
      'fix-var-a': '—', // no diffStat on these fixture records — nothing is fabricated
      'fix-var-b': '—',
      'fix-done': '+9 −2',
      'fix-failed': '—',
    })
  })

  it('offers the compare strip for the finished variant group', () => {
    expect(browser.text('[data-slot="compare-strip"]')).toContain('Add skills autocomplete to composer')
    expect(
      browser.evaluate(
        `document.querySelector('[data-slot="compare-strip"] a[href$="/compare/fix-group-1"]').getAttribute('href')`
      )
    ).toBe(scoped('/compare/fix-group-1'))
  })

  it('keeps the table and sidebar archive filters independent', () => {
    browser.click('[data-slot="overview-tab"][data-view="archived"]')
    browser.waitForFunction(`document.querySelector('${TABLE_ROW}[data-run-id="fix-archived"]') !== null`)
    expect(browser.count(TABLE_ROW)).toBe(1)
    // The sidebar keeps showing live runs while the table browses archived history (#211).
    browser.click('[data-slot="sidebar"] [aria-label="Tools"]')
    browser.waitForFunction(`document.querySelector('[data-slot="sidebar-session-scope"]') !== null`)
    expect(
      browser.evaluate(
        `document.querySelector('[data-slot="view-tab"][data-view="active"]').getAttribute('aria-pressed')`
      )
    ).toBe('true')
    expect(browser.count('[data-slot="task-row"][data-run-id="fix-review-pr"]')).toBe(1)

    browser.click('[data-slot="view-tab"][data-view="archived"]')
    expect(
      browser.evaluate(
        `document.querySelector('[data-slot="overview-tab"][data-view="archived"]').getAttribute('aria-pressed')`
      )
    ).toBe('true')
    expect(browser.count(`${TABLE_ROW}[data-run-id="fix-archived"]`)).toBe(1)

    // Restore both independent controls so the following row-navigation case starts active.
    browser.click('[data-slot="view-tab"][data-view="active"]')
    browser.press('Escape')
    browser.click('[data-slot="overview-tab"][data-view="active"]')
    browser.waitForFunction(`document.querySelector('${TABLE_ROW}[data-run-id="fix-review-pr"]') !== null`)
  })

  it('opens the task from a row click', () => {
    browser.click(`${TABLE_ROW}[data-run-id="fix-done"] a[href*='/tasks/']`)
    browser.waitForFunction(`location.pathname === '${scoped('/tasks/fix-done')}'`)
    expect(browser.url()).toContain(scoped('/tasks/fix-done'))
    browser.goto(`${baseUrl}${scoped('/')}`)
    browser.waitForFunction(`document.querySelectorAll('${TABLE_ROW}').length > 0`)
  })

  it('keeps task metadata AA-readable on normal and hovered rows with visible title focus', () => {
    browser.goto(`${baseUrl}${scoped('/')}`)
    browser.waitForFunction(`document.querySelectorAll('${TABLE_ROW}').length > 0`)
    showResourceTable()
    try {
      for (const variant of contrastQaVariants) {
        applyContrastQaVariant(browser, variant)
        const mobile = variant.viewport.width === 360
        const row = mobile
          ? `[data-slot="task-card"][data-run-id="fix-review-pr"]`
          : `${TABLE_ROW}[data-run-id="fix-review-pr"]`
        const metadata = mobile
          ? `${row} [data-slot="mobile-task-meta"] > span:last-child`
          : `${row} [data-column-id="started"]`
        const normal = browser.evaluate(contrastSampleExpression(metadata)) as ContrastSample
        expect(normal.ratio, `${variant.id} normal: ${normal.foreground} on ${normal.background}`).toBeGreaterThanOrEqual(4.5)
        browser.hover(row)
        const hovered = browser.evaluate(contrastSampleExpression(metadata)) as ContrastSample
        expect(hovered.ratio, `${variant.id} hover: ${hovered.foreground} on ${hovered.background}`).toBeGreaterThanOrEqual(4.5)
        focusWithKeyboard(browser, `${row} a[href]`)
        const focusStyle = browser.evaluate(`(() => {
          const link = document.querySelector(${JSON.stringify(`${row} a[href]`)})
          const probe = document.createElement('span')
          probe.style.color = 'var(--link-foreground)'
          document.body.append(probe)
          const color = getComputedStyle(probe).color
          probe.remove()
          const style = getComputedStyle(link)
          return { active: document.activeElement === link, color, outline: style.outlineStyle, width: style.outlineWidth }
        })()` ) as { active: boolean; color: string; outline: string; width: string }
        const focus = browser.evaluate(contrastSampleExpression(`${row} a[href]`, 'outline-color')) as ContrastSample
        expect(focusStyle.active).toBe(true)
        expect(focusStyle.outline).not.toBe('none')
        expect(Number.parseFloat(focusStyle.width)).toBeGreaterThanOrEqual(2)
        expect(focus.foreground).toBe(focusStyle.color)
        expect(focus.ratio, `${variant.id} focus: ${focus.foreground} on ${focus.background}`).toBeGreaterThanOrEqual(3)
        browser.screenshot(`${artifactsDir}/issue-165-tasks-${variant.id}.png`, { viewport: true })
      }
    } finally {
      restoreContrastQaDefaults(browser)
    }
  })

  it('renames a task inline from its row — the hover pencil, committed by Enter, stored for real', async () => {
    const row = `${TABLE_ROW}[data-run-id="fix-failed"]`
    // The pencil is a hover affordance (mockup `.task-title .pencil`): produce a real pointer.
    browser.hover(row)
    browser.click(`${row} [data-slot="row-rename"]`)
    browser.waitForFunction(`document.querySelector('${row} [data-slot="title-input"]') !== null`)
    // Viewport mode: a full-page capture scrolls the document, and this shot exists to show the
    // open editor exactly as the user sees it.
    browser.screenshot(`${artifactsDir}/tasks-table-row-edit.png`, { viewport: true })

    browser.fill(`${row} [data-slot="title-input"]`, 'Bump zod to v4 — second attempt')
    browser.press('Enter')

    // The readback, twice over. First the UI: the PATCH invalidates `runs`, the refetched list
    // re-renders the row under its new name and the editor is gone.
    browser.waitForFunction(
      `document.querySelector('${row}').textContent.includes('Bump zod to v4 — second attempt')`
    )
    expect(browser.count(`${row} [data-slot="title-input"]`)).toBe(0)

    // Then the record: the server stored the edit as BOTH title and the displayed summary
    // (an edit must beat any past or future auto-summary).
    const runs = (await fetch(`${baseUrl}/api/v1/runs`).then((r) => r.json())) as Array<{
      id: string
      title: string
      titleSummary?: string
    }>
    const renamed = runs.find((r) => r.id === 'fix-failed')
    expect(renamed?.title).toBe('Bump zod to v4 — second attempt')
    expect(renamed?.titleSummary).toBe('Bump zod to v4 — second attempt')
  })

  it('reflows to cards plus a New-task FAB at 360×640, with no horizontal overflow', () => {
    browser.setViewport(360, 640)
    browser.goto(`${baseUrl}${scoped('/')}`)
    browser.waitForFunction(`document.querySelectorAll('[data-slot="task-card"]').length > 0`)

    expect(browser.count('[data-slot="task-card"]')).toBe(5)
    expect(browser.isVisible('[data-slot="new-task-fab"]')).toBe(true)
    expect(
      browser.evaluate(`document.querySelector('[data-slot="new-task-fab"]').getAttribute('href')`)
    ).toBe(scoped('/new'))
    // The table is the desktop framing — at phone width the cards replace it, not join it.
    expect(
      browser.evaluate(`getComputedStyle(document.querySelector('[data-slot="tasks-table"]')).display`)
    ).toBe('none')
    // Nothing forces the page wider than the phone.
    expect(browser.evaluate(`document.documentElement.scrollWidth <= window.innerWidth`)).toBe(true)
    expect(
      browser.evaluate(`(() => {
        const main = document.querySelector('[data-slot="main"]')
        return main.scrollWidth <= main.clientWidth
      })()`)
    ).toBe(true)

    browser.screenshot(`${artifactsDir}/tasks-cards-mobile.png`)
    browser.setViewport(1440, 900)
  })
})

/**
 * A row under width contention, and the column the user can widen (#788, option C).
 *
 * Its own fixture server, like the empty case below: this is one deliberately worst-case record —
 * a long `NNN: `-prefixed title competing with a five-digit diff pair, a PR chip and the unread
 * marker, all at once — and dropping it into the shared fixture above would rewrite every
 * ordering, count and screenshot assertion in this file for one row's sake.
 *
 * jsdom cannot answer any of this: the whole question is what the REAL CSS does with 264px, so
 * every assertion below reads a resolved computed style or a measured rectangle.
 */
describe('a row under width contention, in a column the user can widen', () => {
  let wideServer: ChildProcess
  let wideRoot: string
  let wideUrl: string
  let wideProject: string

  const ROW_ID = '[data-slot="task-row"][data-run-id="wide-load"]'
  const HANDLE = '[data-slot="sidebar-resize-handle"]'
  const FULL_TITLE = '775: implementing comment threads across the whole thread view'

  /** The `<aside>`'s resolved width in px — the number the drag is actually moving. */
  const sidebarWidth = () =>
    Number(
      browser.evaluate(
        `document.querySelector('[data-slot="sidebar"]').getBoundingClientRect().width`
      )
    )

  /** The row title's measured width — how much of the column the NAME actually got. */
  const titleWidth = () =>
    Number(
      browser.evaluate(
        `document.querySelector('${ROW_ID} [data-slot="task-row-title"]').getBoundingClientRect().width`
      )
    )

  /** The diff pair's RESOLVED display — the container query's answer, not a class. */
  const diffDisplay = () =>
    String(browser.evaluate(`getComputedStyle(document.querySelector('${ROW_ID} [data-slot="diff-stat"]')).display`))

  /** Set the width through the stored preference and reload — the non-pointer path to a width,
   *  used where the assertion is about the LAYOUT at that width rather than about dragging. */
  const setStoredWidth = (width: number) => {
    browser.evaluate(`localStorage.setItem('cez-sidebar-width', '${width}')`)
    browser.goto(`${wideUrl}/p/${wideProject}/`)
    browser.waitForFunction(`document.querySelector('${ROW_ID}') !== null`)
  }

  /** Grab the handle at its middle and pull it `dx` px horizontally. */
  const dragHandle = (dx: number) => {
    const box = browser.evaluate(`(() => {
      const r = document.querySelector('${HANDLE}').getBoundingClientRect()
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
    })()`) as { x: number; y: number }
    browser.dragTo(box, { x: box.x + dx, y: box.y })
  }

  beforeAll(async () => {
    wideRoot = mkdtempSync(join(tmpdir(), 'cezar-e2e-wide-'))
    mkdirSync(join(wideRoot, '.ai/cezar'), { recursive: true })
    writeFileSync(
      join(wideRoot, '.ai/cezar/runs.json'),
      JSON.stringify(
        [
          {
            id: 'wide-load',
            title: FULL_TITLE,
            workflow: 'default',
            task: 'implement comment threads',
            status: 'done',
            createdAt: ago(4 * 3_600_000),
            // Finished and never opened, so the row also wears the unread marker — the fourth
            // element that used to compete with the name.
            finishedAt: ago(3_600_000),
            tokensUsed: 512_000,
            diffStat: { adds: 59_514, dels: 12_160, files: 208 },
            pullRequestUrl: 'https://github.com/open-mercato/cezar/pull/775',
            archived: false,
            steps: [],
          },
        ],
        null,
        2
      ),
      'utf8'
    )

    const port = await freePort()
    wideUrl = `http://localhost:${port}`
    wideServer = spawn(
      process.execPath,
      [cezarCli, 'serve', '--repo', wideRoot, '--port', String(port), '--no-open'],
      { env: fixtureServeEnv(wideRoot), stdio: 'ignore' }
    )
    await waitForHealth(wideUrl)
    wideProject = await bootProjectId(wideUrl)
  }, 90_000)

  afterAll(() => {
    wideServer?.kill()
    if (wideRoot) rmSync(wideRoot, { recursive: true, force: true })
  })

  beforeEach(() => {
    browser.setViewport(1440, 900)
    browser.goto(`${wideUrl}/p/${wideProject}/`)
    // A width the last test dragged must not leak into the next one — the preference is real.
    browser.evaluate(`localStorage.removeItem('cez-sidebar-width')`)
    browser.goto(`${wideUrl}/p/${wideProject}/`)
    browser.waitForFunction(`document.querySelector('${ROW_ID}') !== null`)
  })

  it('names the task instead of its number: the prefix is gone and the chip carries it', () => {
    const painted = browser.evaluate(`(() => {
      const row = document.querySelector('${ROW_ID}')
      const chip = row.querySelector('[data-slot="pr-chip"]')
      return {
        title: row.querySelector('[data-slot="task-row-title"]').textContent,
        chip: chip.textContent,
        chipHref: chip.href,
        tooltip: row.querySelector('a[href$="/tasks/wide-load"]').getAttribute('title'),
      }
    })()`) as { title: string; chip: string; chipHref: string; tooltip: string }

    expect(painted.title).toBe('implementing comment threads across the whole thread view')
    expect(painted.chip).toBe('#775')
    expect(painted.chipHref).toBe('https://github.com/open-mercato/cezar/pull/775')
    // The number was moved, not deleted — the stored title is still one hover away.
    expect(painted.tooltip).toBe(FULL_TITLE)
  })

  it('gives the name real width at the default 264px, and drops the diff pair to do it', () => {
    expect(sidebarWidth()).toBe(264)

    const measured = browser.evaluate(`(() => {
      const row = document.querySelector('${ROW_ID}')
      const title = row.querySelector('[data-slot="task-row-title"]')
      const diff = row.querySelector('[data-slot="diff-stat"]')
      const scroller = row.closest('[data-slot="sidebar-content"]')
      return {
        titleWidth: title.getBoundingClientRect().width,
        // The real CSS, not the class: this is the container query resolving at 264px.
        diffDisplay: getComputedStyle(diff).display,
        diffTooltip: diff.getAttribute('title'),
        overflows: scroller.scrollWidth > scroller.clientWidth,
      }
    })()`) as { titleWidth: number; diffDisplay: string; diffTooltip: string; overflows: boolean }

    // The floor from the width-priority rule, honored by the real layout — before this change the
    // same row gave its title ~68px.
    expect(measured.titleWidth).toBeGreaterThanOrEqual(112)
    expect(measured.diffDisplay).toBe('none')
    // Dropped from view, not from reach.
    expect(measured.diffTooltip).toBe('+59514 −12160 across 208 files')
    // A floor must not buy readability with a horizontal scrollbar.
    expect(measured.overflows).toBe(false)

    browser.screenshot(`${artifactsDir}/quick-list-width-contention-264.png`, { viewport: true })
  })

  it('grows the name as the column grows, without ever shrinking it', () => {
    // The cliff this guards against: a threshold placed where the diff pair merely *fits* makes
    // dragging the column WIDER produce a SHORTER name, which is the exact bargain #788 exists
    // to stop making. At every width the name is at least as long as it was at the default.
    const baseline = titleWidth()
    let previousBelowThreshold = baseline
    for (const width of [280, 320, 360, 368, 400, 420]) {
      setStoredWidth(width)
      expect(sidebarWidth()).toBe(width)
      expect(titleWidth()).toBeGreaterThanOrEqual(baseline)
      if (diffDisplay() === 'none') {
        // Below the threshold the name grows monotonically — every px goes to it.
        expect(titleWidth()).toBeGreaterThanOrEqual(previousBelowThreshold)
        previousBelowThreshold = titleWidth()
      }
    }
  })

  it('drags wider, brings the diff pair back, and remembers the width across a reload', () => {
    dragHandle(100)
    expect(sidebarWidth()).toBe(364)
    expect(browser.evaluate(`document.querySelector('${HANDLE}').getAttribute('aria-valuenow')`)).toBe('364')
    // Still below 23rem: the column is wider, and all of it went to the name.
    expect(diffDisplay()).toBe('none')

    dragHandle(56)
    expect(sidebarWidth()).toBe(420)
    // Past 23rem the row can afford its diff numbers again — the whole point of making the
    // metadata droppable rather than deleting it. `block`, not `inline`: the utility says
    // `inline`, and CSS blockifies the display of a flex item, which this span is.
    expect(diffDisplay()).not.toBe('none')

    browser.screenshot(`${artifactsDir}/quick-list-width-contention-420.png`, { viewport: true })

    expect(browser.evaluate(`localStorage.getItem('cez-sidebar-width')`)).toBe('420')
    browser.goto(`${wideUrl}/p/${wideProject}/`)
    browser.waitForFunction(`document.querySelector('${ROW_ID}') !== null`)
    expect(sidebarWidth()).toBe(420)
  })

  it('clamps at both ends — the column can never collapse or swallow the view', () => {
    dragHandle(4000)
    expect(sidebarWidth()).toBe(420)
    dragHandle(-4000)
    expect(sidebarWidth()).toBe(264)
  })

  it('resizes from the keyboard and resets on double-click', () => {
    browser.evaluate(`document.querySelector('${HANDLE}').focus()`)
    browser.press('End')
    expect(sidebarWidth()).toBe(420)
    browser.press('ArrowLeft')
    expect(sidebarWidth()).toBe(404)
    browser.press('Home')
    expect(sidebarWidth()).toBe(264)

    browser.press('ArrowRight')
    expect(sidebarWidth()).toBe(280)
    browser.evaluate(`(() => {
      const el = document.querySelector('${HANDLE}')
      el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    })()`)
    browser.waitForFunction(`document.querySelector('[data-slot="sidebar"]').getBoundingClientRect().width === 264`)
  })

  it('is a desktop affordance only: below md there is no handle to reach', () => {
    browser.setViewport(390, 844)
    browser.goto(`${wideUrl}/p/${wideProject}/`)
    browser.waitForFunction(`document.querySelector('[data-slot="mobile-top-bar"]') !== null`)

    // The aside is still in the DOM (display:none), so the handle inside it is unreachable
    // rather than absent — and the drawer that replaces it brings no handle of its own.
    expect(browser.isVisible(HANDLE)).toBe(false)
    browser.click('[data-slot="mobile-top-bar"] button[aria-label="Open menu"]')
    browser.waitForFunction(`document.querySelector('[data-slot="mobile-nav-drawer"]') !== null`)
    expect(
      browser.evaluate(`document.querySelectorAll('[data-slot="mobile-nav-drawer"] ${HANDLE}').length`)
    ).toBe(0)
    expect(
      browser.evaluate(
        `Math.round(document.querySelector('[data-slot="mobile-nav-drawer"]').getBoundingClientRect().width)`
      )
    ).toBe(322)
  })
})

/** The other half of the truth: with no runs, the sidebar says so rather than inventing any. */
describe('empty quick-list', () => {
  let emptyServer: ChildProcess
  let emptyRoot: string
  let emptyUrl: string
  let emptyProject: string

  beforeAll(async () => {
    emptyRoot = mkdtempSync(join(tmpdir(), 'cezar-e2e-empty-'))
    const port = await freePort()
    emptyUrl = `http://localhost:${port}`
    emptyServer = spawn(
      process.execPath,
      [cezarCli, 'serve', '--repo', emptyRoot, '--port', String(port), '--no-open'],
      { env: fixtureServeEnv(emptyRoot), stdio: 'ignore' }
    )
    await waitForHealth(emptyUrl)
    emptyProject = await bootProjectId(emptyUrl)
  }, 60_000)

  afterAll(() => {
    emptyServer?.kill()
    if (emptyRoot) rmSync(emptyRoot, { recursive: true, force: true })
  })

  it('shows the honest empty state — a fresh cezar has nothing to list', () => {
    browser.goto(`${emptyUrl}/p/${emptyProject}/`)
    browser.waitForFunction(`document.querySelector('[data-slot="project-group-list"]') !== null`)

    expect(browser.text('[data-slot="main"]')).toContain('No tasks')
    expect(browser.count(ROW)).toBe(0)
    expect(browser.count('[data-slot="quick-list-bucket"]')).toBe(0)

    browser.screenshot(`${artifactsDir}/quick-list-empty.png`)
  })
})


describe('persistent task pins (#93)', () => {
  it('pins a visible variant group once from a 44px phone control and preserves siblings on reload', async () => {
    browser.setViewport(360, 640)
    browser.goto(`${baseUrl}${scoped('/')}`)
    browser.waitForFunction(`document.querySelector('[data-slot="task-card"][data-run-id="fix-var-b"]') !== null`)
    const pin = '[data-slot="task-card"][data-run-id="fix-var-b"] [data-slot="pin-toggle"]'
    const target = browser.evaluate(`(() => { const x = document.querySelector('${pin}'); const r = x.getBoundingClientRect(); return { width: r.width, height: r.height, pressed: x.getAttribute('aria-pressed') } })()`) as { width: number; height: number; pressed: string }
    expect(target.width).toBeGreaterThanOrEqual(44)
    expect(target.height).toBeGreaterThanOrEqual(44)
    expect(target.pressed).toBe('false')
    browser.click(pin)
    browser.waitForFunction(`document.querySelector('${pin}').getAttribute('aria-pressed') === 'true'`)
    expect(browser.url()).toContain(scoped('/'))
    browser.setViewport(1280, 800)
    browser.goto(`${baseUrl}${scoped('/')}`)
    browser.waitForFunction(`document.querySelector('[data-bucket="Pinned"] [data-slot="group-tile"]') !== null`)
    expect(browser.count('[data-slot="group-tile"][data-group-id="fix-group-1"]')).toBe(1)
    browser.click('[data-bucket="Pinned"] [data-slot="group-tile"]')
    browser.waitForFunction(`document.querySelector('[data-bucket="Pinned"] [data-run-id="fix-var-a"]') !== null`)
    expect(browser.evaluate(`[...document.querySelectorAll('[data-bucket="Pinned"] [data-slot="task-row"]')].map(x => x.dataset.runId)`)).toEqual(['fix-var-a', 'fix-var-b'])
    const runs = await (await fetch(`${baseUrl}/api/v1/runs`)).json() as Array<{ id: string; pinned?: boolean; pinnedAt?: string }>
    expect(runs.find(r => r.id === 'fix-var-a')).not.toHaveProperty('pinned')
    expect(runs.find(r => r.id === 'fix-var-b')).toMatchObject({ pinned: true, pinnedAt: expect.any(String) })
    browser.click('[data-bucket="Pinned"] [data-run-id="fix-var-b"] [data-slot="pin-toggle"]')
    browser.waitForFunction(`document.querySelector('[data-bucket="Pinned"]') === null`)
    const unpinned = await (await fetch(`${baseUrl}/api/v1/runs/fix-var-b`)).json()
    expect(unpinned).not.toHaveProperty('pinned')
    expect(unpinned).not.toHaveProperty('pinnedAt')
  })
})
