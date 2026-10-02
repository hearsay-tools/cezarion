import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { stopFixtureServer } from './fixture-server'
import { expectGroupRowHeightMatchesTaskRow } from './row-height'
import { AgentBrowser, HOVER_POINTER_ARGS, bootProjectId, cezarCli, fixtureServeEnv } from './agent-browser'
import {
  applyContrastQaVariant,
  contrastQaVariants,
  contrastSampleExpression,
  dismissWithEscape,
  focusWithKeyboard,
  restoreContrastQaDefaults,
  type ContrastSample,
} from './contrast'
import { waitForHealth } from './poll'

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
    // One minute behind its sibling, not the same instant (#416): `sortRuns` breaks an equal
    // status weight on `createdAt` alone, so two runs sharing a timestamp leave the row order
    // resting on V8's stable sort of whatever order the store happened to read them in. Every
    // `createdAt` in this fixture is distinct for that reason, and the order they produce is
    // asserted below rather than sorted away.
    createdAt: ago(31 * 60_000),
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

afterAll(async () => {
  browser?.close()
  await stopFixtureServer(server)
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

  it('groups attention before finished outcomes while retaining independent status rows', () => {
    expect(browser.evaluate(`[...document.querySelectorAll('[data-slot="quick-list-bucket"]')].map(h => h.dataset.bucket)`)).toEqual(['Needs you', 'Finished'])
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
    // Wait, then read as one step. The setup waits for a quick-list bucket, which does not
    // guarantee this particular diff pair exists at measurement time. PR #712 CI shard 4
    // read before the `fix-review-pr` row's diff pair existed (`pair` was null, so
    // `adds` read `undefined`; the failure bundle's snapshot, taken moments later, shows the
    // row painted with `+128 −14`). The content and colour assertions below are unchanged.
    const pair = browser.waitForValue<{ adds: string; dels: string; addsColor: string; delsColor: string }>(`(() => {
      const el = document.querySelector('[data-slot="task-row"][data-run-id="fix-review-pr"] [data-slot="diff-stat"]')
      const [adds, dels] = el?.querySelectorAll('span') ?? []
      if (!adds || !dels) return null
      return {
        adds: adds.textContent, dels: dels.textContent,
        // Resolved by the real CSS: green ≠ red proves the two tokens actually applied.
        addsColor: getComputedStyle(adds).color, delsColor: getComputedStyle(dels).color,
      }
    })()`)

    expect(pair.adds).toBe('+128')
    expect(pair.dels).toBe('−14')
    expect(pair.addsColor).not.toBe(pair.delsColor)
  })

  it('paints one dot per row, in the tone deriveAttention picked', () => {
    const tones = browser.evaluate(`(() => {
      const of = (id) => {
        const dot = document.querySelector('[data-run-id="' + id + '"] [data-slot="status-dot"]')
        return dot && { tone: dot.dataset.tone, pulses: getComputedStyle(dot).animationName !== 'none' }
      }
      return { review: of('fix-review-pr'), done: of('fix-done'), failed: of('fix-failed') }
    })()`) as Record<string, { tone: string; pulses: boolean }>

    // Review is info blue since the #617 status key (it used to be brand teal, which read as done).
    expect(tones.review).toEqual({ tone: 'info', pulses: true })
    // Terminal rows are still — the pulse means "transitioning", and these are not.
    expect(tones.done).toEqual({ tone: 'success', pulses: false })
    expect(tones.failed).toEqual({ tone: 'danger', pulses: false })

    // The design system's size rule, resolved by the real CSS rather than asserted from a class.
    expect(
      browser.evaluate(
        `getComputedStyle(document.querySelector('[data-run-id="fix-done"] [data-slot="status-dot"]')).width`
      )
    ).toBe('7px')
  })

  it('links a row to its task, and the PR chip to the PR', () => {
    expect(browser.evaluate(`document.querySelector('[data-run-id="fix-done"] a').getAttribute('href')`)).toBe(
      scoped('/tasks/fix-done')
    )

    // This spec's headless Chrome reports `hover: none`, which is the touch path (#617 01b): the
    // sidebar reference is plain text there, and the whole row is the tap target. The pointer
    // path (a real link with the status panel) is pinned in selection-states, which forces a
    // hover-capable pointer, and in the unit suite.
    const chip = browser.evaluate(`(() => {
      const el = document.querySelector('[data-run-id="fix-review-pr"] [data-slot="pr-chip"]')
      return { noHover: matchMedia('(hover: none)').matches, tag: el.tagName, inert: el.dataset.inert ?? null, text: el.textContent }
    })()`) as { noHover: boolean; tag: string; inert: string | null; text: string }
    expect(chip).toEqual({ noHover: true, tag: 'SPAN', inert: 'true', text: 'PR #396' })

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
    // Line two is the meta line — the state word, no age (#617).
    expect(textOf(`${ROW}[data-run-id="fix-var-a"]`)).toBe('Aclaudeneeds review')
    expect(textOf(`${ROW}[data-run-id="fix-var-b"]`)).toBe('Bcodexneeds review')
    // Each variant is still its own deep link.
    expect(
      browser.evaluate(`document.querySelector('${ROW}[data-run-id="fix-var-b"] a').getAttribute('href')`)
    ).toBe(scoped('/tasks/fix-var-b'))

    browser.screenshot(`${artifactsDir}/quick-list-expanded.png`)

    browser.click(TILE)
    browser.waitForFunction(`document.querySelector('${ROW}[data-run-id="fix-var-a"]') === null`)
  })

  it('keeps the group row two fixed lines through expand and collapse, each member dot under its title (#617)', () => {
    const group = '[data-slot="group-row"][data-group-id="fix-group-1"]'
    type Geometry = { expanded: string | null; height: number; titleLeft: number; meta: string }
    const geometry = `(() => {
      const row = document.querySelector('${group}')
      if (!row) return null
      return { expanded: row.querySelector('${TILE}').getAttribute('aria-expanded'),
        height: Math.round(row.getBoundingClientRect().height),
        titleLeft: row.querySelector('[data-slot="group-title"]').getBoundingClientRect().left,
        meta: row.querySelector('[data-slot="group-meta"]').textContent }
    })()`
    const collapsed = browser.waitForValue(geometry, (g: Geometry | null) => g?.expanded === 'false') as Geometry
    // Two review members, no shared reference: the aggregate in words, then the latest age.
    expect(collapsed.meta).toBe('2 needs review · 11m')
    browser.click(TILE)
    const open = browser.waitForValue(geometry, (g: Geometry | null) => g?.expanded === 'true') as Geometry
    expect(open.height).toBe(collapsed.height)
    const dots = browser.waitForValue(`(() => {
      const slots = ['fix-var-a', 'fix-var-b'].map((id) => document.querySelector('${ROW}[data-run-id="' + id + '"] [data-slot="task-row-dot"]'))
      return slots.every(Boolean) ? slots.map((slot) => slot.getBoundingClientRect().left) : null
    })()`) as number[]
    for (const left of dots) expect(Math.abs(left - collapsed.titleLeft), `dot at ${left}, title at ${collapsed.titleLeft}`).toBeLessThanOrEqual(1)
    browser.click(TILE)
    const closed = browser.waitForValue(geometry, (g: Geometry | null) => g?.expanded === 'false') as Geometry
    expect(closed.height).toBe(collapsed.height)
  })

  // This spec's headless browser reports `hover: none`: the touch structure (one toggle over
  // both lines) must hold the task row's height at desktop and phone widths alike.
  it("keeps the group row a task row's height at 1440 and 768px on hover:none (#617)", () => {
    // 520 and 390 are gone: the phone drawer no longer holds the quick list (#621), so the group
    // row has no surface below md. 768 is the narrowest width that still renders the sidebar.
    expectGroupRowHeightMatchesTaskRow(browser, { url: `${baseUrl}${scoped('/')}`, groupId: 'fix-group-1', widths: [1440, 768] })
  })

  it('keeps the group and member rows readable, at rest and selected, in both themes (#617)', () => {
    const group = '[data-slot="group-row"][data-group-id="fix-group-1"]'
    const member = `${ROW}[data-run-id="fix-var-a"]`
    const read = (selector: string, state: string) => {
      const sample = browser.evaluate(contrastSampleExpression(selector)) as ContrastSample
      expect(sample.ratio, `${state} ${selector}: ${sample.foreground} on ${sample.background}`).toBeGreaterThanOrEqual(4.5)
    }
    const mark = (selector: string, state: string) => {
      const sample = browser.evaluate(contrastSampleExpression(selector, 'background-color', 'parent')) as ContrastSample
      expect(sample.ratio, `${state} ${selector}: ${sample.foreground} on ${sample.background}`).toBeGreaterThanOrEqual(3)
    }
    try {
      for (const variant of contrastQaVariants.filter(({ viewport }) => viewport.width === 1440)) {
        // The compare page selects the group; a member's thread (expanded) selects the member.
        for (const [path, groupSelected] of [[scoped('/compare/fix-group-1'), true], [scoped('/tasks/fix-var-a'), false]] as const) {
          browser.goto(`${baseUrl}${path}`)
          browser.waitForFunction(`document.querySelector('${group} ${TILE}')?.getAttribute('aria-expanded') === 'false'`)
          applyContrastQaVariant(browser, variant)
          browser.click(TILE)
          browser.waitForFunction(`document.querySelector('${member}') !== null && (document.querySelector('${group}').dataset.active === 'true') === ${groupSelected} && (document.querySelector('${member}').dataset.active === 'true') === ${!groupSelected}`)
          const state = `${variant.id} ${groupSelected ? 'group selected' : 'member selected'}`
          for (const part of ['group-title', 'group-meta', 'group-count']) read(`${group} [data-slot="${part}"]`, state)
          for (const part of ['task-row-title', 'task-row-meta', 'task-row-variant-letter']) read(`${member} [data-slot="${part}"]`, state)
          // The letter chip as resolved: a 16px circle saying `A`. The compare view's sheet
          // styles its own `variant-letter` slot globally (`Variant ` prefix, 18px), which is
          // why this one has a slot of its own.
          expect(browser.evaluate(`(() => {
            const chip = document.querySelector('${member} [data-slot="task-row-variant-letter"]'), s = getComputedStyle(chip)
            return { size: s.width + ' ' + s.height, before: getComputedStyle(chip, '::before').content, text: chip.textContent }
          })()`), state).toEqual({ size: '16px 16px', before: 'none', text: 'A' })
          mark(`${group} [data-slot="status-dot"]`, state)
          mark(`${member} [data-slot="status-dot"]`, state)
          browser.screenshot(`${artifactsDir}/quick-list-group-${variant.id}-${groupSelected ? 'group' : 'member'}.png`, { viewport: true })
        }
      }
    } finally {
      restoreContrastQaDefaults(browser)
      browser.goto(`${baseUrl}${scoped('/')}`)
      browser.waitForFunction(`document.querySelector('[data-slot="quick-list-bucket"]') !== null`)
    }
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
    browser.waitForFunction(`document.querySelector('[data-slot="quick-list"] [data-slot="view-tab"]') !== null`)
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
    // Escape hands focus back to the trigger one task after the popover unmounts (#410); wait for
    // that, or the next keyboard step starts from the row and ends in the header.
    dismissWithEscape(browser, { content: '[data-slot="popover-content"]', focus: '[data-slot="task-columns-trigger"]' })
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

  it('paints a done pill with the status key — a visible green dot, no teal chip — on every task list (#617)', () => {
    type PillFacts = { dotShown: boolean; dotGreen: boolean; teal: boolean; background: string; mutedBackground: string; label: string }
    // Resolved by the real stylesheet: a sheet once turned a done pill into a teal "Done" chip
    // and hid its dot on the table, the mobile card and the global rows (and every dot on the
    // grouped global cards).
    const facts = (selector: string) => `(() => {
      const pill = document.querySelector(${JSON.stringify(selector)})
      const dot = pill?.querySelector('[data-slot="status-dot"]')
      if (!pill || !dot) return null
      const resolve = (prop, value) => { const probe = document.createElement('span'); probe.style[prop] = value
        document.body.append(probe); const out = getComputedStyle(probe)[prop]; probe.remove(); return out }
      const d = getComputedStyle(dot), p = getComputedStyle(pill)
      return { dotShown: d.display !== 'none' && dot.getBoundingClientRect().width > 0,
        dotGreen: d.backgroundColor === resolve('color', 'var(--success)'),
        teal: p.color === resolve('color', 'var(--accent-text)'),
        background: p.backgroundColor, mutedBackground: resolve('backgroundColor', 'var(--muted)'), label: pill.textContent }
    })()`
    const check = (surface: string, selector: string, background: 'muted' | 'none') => {
      const f = browser.waitForValue(facts(selector)) as PillFacts
      expect(f.dotShown, `${surface}: dot shown`).toBe(true)
      expect(f.dotGreen, `${surface}: dot green`).toBe(true)
      expect(f.teal, `${surface}: teal ink`).toBe(false)
      expect(f.label, `${surface}: label`).toBe('done')
      expect(f.background, `${surface}: pill fill`).toBe(background === 'muted' ? f.mutedBackground : 'rgba(0, 0, 0, 0)')
    }
    try {
      check('table', `${TABLE_ROW}[data-run-id="fix-done"] [data-slot="pill"]`, 'muted')
      browser.setViewport(360, 640)
      check('mobile card', '[data-slot="task-card"][data-run-id="fix-done"] [data-slot="pill"]', 'muted')
      browser.setViewport(1440, 900)
      browser.goto(`${baseUrl}/tasks`)
      check('global row', '[data-route="global-tasks"][data-presentation="summary"] [data-slot="global-task-row"][data-run-id="fix-done"] [data-slot="pill"]', 'muted')
      // Grouped cards keep their text-only pill (no fill), and still show the dot.
      browser.goto(`${baseUrl}/tasks?group=project`)
      check('grouped card', '[data-route="global-tasks"][data-presentation="cards"] [data-slot="global-task-row"][data-run-id="fix-done"] [data-slot="pill"]', 'none')
    } finally {
      browser.setViewport(1440, 900)
      browser.goto(`${baseUrl}${scoped('/')}`)
      browser.waitForFunction(`document.querySelectorAll('${TABLE_ROW}').length > 0`)
    }
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
    // The whole order, in one assertion and with nothing sorted first (#416): the sidebar's sort
    // is `statusWeight` then `createdAt` descending, so review (weight 1) precedes done (5) and
    // failed (6), and inside the review band the newest `createdAt` leads. A read like `rows[0]`
    // means something only because this line pins what row 0 is.
    expect(rows.map((r) => r.id)).toEqual(['fix-var-a', 'fix-var-b', 'fix-review-pr', 'fix-done', 'fix-failed'])

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
    browser.waitForFunction(`document.querySelector('[data-slot="quick-list"] [data-slot="view-tab"]') !== null`)
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
    browser.waitForFunction(`document.querySelector('[data-slot="view-tab"][data-view="active"]').getAttribute('aria-pressed') === 'true'`)
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

  it('reflows to cards plus the shell New-task FAB at 360×640, with no horizontal overflow', () => {
    browser.setViewport(360, 640)
    browser.goto(`${baseUrl}${scoped('/')}`)
    browser.waitForFunction(`document.querySelectorAll('[data-slot="task-card"]').length > 0`)

    expect(browser.count('[data-slot="task-card"]')).toBe(5)
    // One floating button, and it is the tab bar's (#621): the list's own round FAB is gone.
    expect(browser.isVisible('[data-slot="mobile-new-task"]')).toBe(true)
    expect(browser.count('[data-slot="new-task-fab"]')).toBe(0)
    expect(
      browser.evaluate(`document.querySelector('[data-slot="mobile-new-task"]').getAttribute('href')`)
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
 * The tasks table under worst-case content (#167), from a fixture rather than from writes.
 *
 * Its own fixture server, for the reason the width-contention suite below gives: these are
 * deliberately extreme records — a wrapping title, an unbroken one, an overlong workflow name,
 * a four-digit PR, a five-digit diff pair and a run parked on its workers — and dropping them
 * into the shared fixture would rewrite every ordering, count and screenshot assertion above.
 *
 * This test used to build those states by writing into nodes React owns: `links[0].textContent`,
 * the workflow cell, the status pill's text, the PR chip's label text node, both halves of the
 * diff pair and the CPU metric (#416). `use-now.ts` re-renders these rows every 30 s, so those
 * writes were racing a re-render that would restore the real values under the measurement —
 * which is reason enough on its own to stop making them. No failure bundle shows one of these
 * writes taking the page down, and none is claimed: the rows measured below simply now hold
 * what they are measured for, from `runs.json`, which the real store parses and the real API
 * serves.
 *
 * One state does NOT: a live CPU reading. `usageCells` believes a sample only while the run's
 * process tree can exist, the sample arrives on the usage SSE stream from the server's own
 * sampler, and a recovered fixture run owns no process — so the CPU cell is honestly empty here
 * and its content is pinned in the jsdom suite instead. Faking `100%` into the cell was the one
 * write that bought coverage nothing else does, and inventing a server-side injection seam for
 * it would put a test-only route in the product.
 */
describe('the tasks table under worst-case row content', () => {
  const TABLE_ROW = '[data-slot="task-table-row"]'
  const WRAPPING = 'Review shared task title prefix — documentation outcome'
  const UNBROKEN = `Review-shared-task-title-prefix-${'distinguishing'.repeat(18)}`
  const wrappingRow = `${TABLE_ROW}[data-run-id="worst-wrapping"]`
  const unbrokenRow = `${TABLE_ROW}[data-run-id="worst-unbroken"]`

  let worstServer: ChildProcess
  let worstRoot: string
  let worstUrl: string
  let worstProject: string

  /**
   * One record carrying every column's worst case at once, because the question is whether they
   * fit BESIDE each other. `status: 'waiting'` plus a root delegation parked on a worker is the
   * longest status label the cockpit can print (`delegationWaitLabel` → "waiting on workers"),
   * and a serve boot keeps it: `RunManager.recover()` re-parks a run that owns a worker wait
   * rather than settling it, which is what makes a non-terminal status reachable from a fixture
   * at all.
   */
  const WORST = [
    {
      id: 'worst-wrapping',
      title: WRAPPING,
      workflow: 'workflow-name-that-is-deliberately-too-long-for-its-column',
      task: 'review the shared prefix',
      status: 'waiting',
      createdAt: ago(50 * 60_000),
      inputTokens: 999_900,
      outputTokens: 888_800,
      tokensUsed: 1_888_700,
      costUsd: 123.45,
      diffStat: { adds: 12_345, dels: 1_234, files: 37 },
      peakRssBytes: 1023 * 1024 ** 2,
      pullRequestUrl: 'https://github.com/open-mercato/cezar/pull/1234',
      delegation: {
        role: 'root',
        permissions: [],
        receipts: [],
        wait: {
          id: '11111111-1111-4111-8111-111111111111',
          workerIds: ['22222222-2222-4222-8222-222222222222'],
          deadline: new Date(now + 3_600_000).toISOString(),
          mode: 'all',
          phase: 'parked',
          outcomes: [],
        },
      },
      archived: false,
      steps: [],
    },
    {
      id: 'worst-unbroken',
      title: UNBROKEN,
      workflow: 'default',
      task: 'review the shared prefix',
      status: 'review',
      createdAt: ago(45 * 60_000),
      finishedAt: ago(40 * 60_000),
      tokensUsed: 4_000,
      archived: false,
      steps: [],
    },
  ]

  function showResourceTable() {
    if (!browser.count('[data-slot="tasks-table"]')) return
    if (browser.evaluate(`document.querySelector('[data-slot="tasks-table"]').checkVisibility()`)) return
    browser.click('[data-slot="task-columns-trigger"]')
    browser.waitForFunction(`document.querySelector('[data-slot="popover-content"]')?.textContent.includes('Resource columns') === true`)
    browser.click('[data-slot="popover-content"] button:last-child')
    // Escape hands focus back to the trigger one task after the popover unmounts (#410); wait for
    // that, or the next keyboard step starts from the row and ends in the header.
    dismissWithEscape(browser, { content: '[data-slot="popover-content"]', focus: '[data-slot="task-columns-trigger"]' })
    browser.waitForFunction(`document.querySelector('[data-slot="tasks-table"]').getBoundingClientRect().width > 0`)
  }

  beforeAll(async () => {
    worstRoot = mkdtempSync(join(tmpdir(), 'cezar-e2e-worst-'))
    mkdirSync(join(worstRoot, '.ai/cezar'), { recursive: true })
    writeFileSync(join(worstRoot, '.ai/cezar/runs.json'), JSON.stringify(WORST, null, 2), 'utf8')

    const port = await freePort()
    worstUrl = `http://localhost:${port}`
    worstServer = spawn(
      process.execPath,
      [cezarCli, 'serve', '--repo', worstRoot, '--port', String(port), '--no-open'],
      { env: fixtureServeEnv(worstRoot), stdio: 'ignore' }
    )
    await waitForHealth(worstUrl, 'the worst-case fixture server')
    worstProject = await bootProjectId(worstUrl)

    browser.setViewport(1440, 900)
    browser.goto(`${worstUrl}/p/${worstProject}/`)
    browser.waitForFunction(`document.querySelector('${wrappingRow}') !== null`)
    showResourceTable()
  }, 90_000)

  afterAll(async () => {
    browser.evaluate(`(() => {
      localStorage.removeItem('cez-sidebar-width')
      document.documentElement.classList.remove('light')
      delete document.documentElement.dataset.density
    })()`)
    await stopFixtureServer(worstServer)
    if (worstRoot) rmSync(worstRoot, { recursive: true, force: true })
    browser.setViewport(1440, 900)
    browser.goto(`${baseUrl}${scoped('/')}`)
    browser.waitForFunction(`document.querySelector('[data-slot="quick-list-bucket"]') !== null`)
  })

  it('keeps the waiting-on-workers robot and the pin at 12px under every density (#617)', () => {
    const sidebarRow = '[data-slot="task-row"][data-run-id="worst-wrapping"]'
    type Glyphs = { lucide: boolean; label: string | null; box: string; bot: string; pin: string }
    try {
      for (const density of ['comfortable', 'compact', 'ultra'] as const) {
        browser.evaluate(`(() => {
          if (${JSON.stringify(density)} === 'comfortable') delete document.documentElement.dataset.density
          else document.documentElement.dataset.density = ${JSON.stringify(density)}
        })()`)
        const glyphs = browser.waitForValue(`(() => {
          const dataset = document.documentElement.dataset.density ?? 'comfortable'
          if (dataset !== ${JSON.stringify(density)}) return null
          const dot = document.querySelector('${sidebarRow} [data-slot="status-dot"][data-shape="workers"]')
          const bot = dot?.querySelector('svg'), pin = document.querySelector('${sidebarRow} [data-slot="pin-icon"]')
          if (!dot || !bot || !pin) return null
          const size = (el) => { const r = el.getBoundingClientRect(); return Math.round(r.width) + 'x' + Math.round(r.height) }
          return { lucide: bot.classList.contains('lucide-bot'), label: dot.getAttribute('aria-label'), box: size(dot), bot: size(bot), pin: size(pin) }
        })()`) as Glyphs
        expect(glyphs, density).toEqual({ lucide: true, label: 'waiting on 1 worker', box: '12x12', bot: '12x12', pin: '12x12' })
      }
    } finally {
      browser.evaluate(`delete document.documentElement.dataset.density`)
    }
  })

  it('serves the worst case as data the real store parsed', async () => {
    // If a record here were wrong, zod would have dropped the index and every measurement below
    // would be measuring an empty table that "passes" nothing. The parked delegation is the one
    // worth reading back: it is the only field a serve boot could have rewritten.
    const runs = (await fetch(`${worstUrl}/api/v1/runs`).then((r) => r.json())) as Array<{
      id: string
      status: string
      workflow: string
      delegation?: { role: string; wait?: { phase: string } }
    }>
    expect(runs.map((r) => r.id).sort()).toEqual(['worst-unbroken', 'worst-wrapping'])
    const parked = runs.find((r) => r.id === 'worst-wrapping')
    expect(parked?.status).toBe('waiting')
    expect(parked?.delegation?.role).toBe('root')
    expect(parked?.delegation?.wait?.phase).toBe('parked')
    expect(parked?.workflow).toBe('workflow-name-that-is-deliberately-too-long-for-its-column')
  })

  it('allocates two contained title lines without crowding desktop metadata or actions', () => {
    for (const theme of ['light', 'dark'] as const) {
      for (const density of ['comfortable', 'ultra'] as const) {
        browser.setViewport(1440, 900)
        browser.evaluate(`(() => {
          document.documentElement.classList.toggle('light', ${theme === 'light'})
          ${density === 'ultra'
            ? "document.documentElement.dataset.density = 'ultra'"
            : "delete document.documentElement.dataset.density"}
        })()`)
        // The density switch relays out the whole table; measure the settled layout, not the
        // frame between the class change and it.
        browser.waitForFunction(
          `document.documentElement.dataset.density === ${density === 'ultra' ? "'ultra'" : 'undefined'}
             && document.querySelector('${wrappingRow} td[data-column-id="cpu"]') !== null`,
        )

        const facts = browser.evaluate(`(() => {
          const metricsRow = document.querySelector('${wrappingRow}')
          const firstCell = metricsRow.querySelector('td[data-column-id="task"]')
          const firstLink = firstCell.querySelector('a[href*="/tasks/"]')
          const secondCell = document.querySelector('${unbrokenRow} td[data-column-id="task"]')
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
          const workflow = metricsRow.querySelector('td[data-column-id="workflow"]')
          const status = metricsRow.querySelector('td[data-column-id="status"]')
          const statusPill = status.querySelector('[data-slot="pill"]')
          const reference = metricsRow.querySelector('td[data-column-id="reference"]')
          const referenceChip = reference.querySelector('[data-slot="pr-chip"]')
          const diff = metricsRow.querySelector('td[data-column-id="diff"]')
          const workflowHeader = document.querySelector('th[data-column-id="workflow"]')
          const workflowHeaderButton = workflowHeader.querySelector('button')
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
          const [adds, dels] = diff.querySelectorAll('[data-slot="diff-stat"] > span')
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
            statusLabel: statusPill.textContent,
            statusContained: status.scrollWidth <= status.clientWidth + 1 && statusPill.getBoundingClientRect().right <= status.getBoundingClientRect().right + 1,
            referenceContained: reference.scrollWidth <= reference.clientWidth + 1 && referenceChip.getBoundingClientRect().right <= reference.getBoundingClientRect().right + 1 && [...referenceChip.querySelectorAll('svg')].every((glyph) => glyph.getBoundingClientRect().right <= reference.getBoundingClientRect().right + 1),
            referenceLabel: referenceChip.textContent,
            diffPair: { adds: adds.textContent, dels: dels.textContent, title: diff.querySelector('[data-slot="diff-stat"]').getAttribute('title') },
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
          statusLabel: string
          statusContained: boolean
          referenceContained: boolean
          referenceLabel: string
          diffPair: { adds: string; dels: string; title: string | null }
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
        // The longest label the status column can be asked to print, and it comes from the
        // record's own parked delegation rather than from a rewritten pill. A full record
        // carries its worker ids, so the count is said (#617).
        expect(facts.statusLabel, `${theme}/${density}: parked status label`).toBe('waiting on 1 worker')
        expect.soft(facts.statusContained, `${theme}/${density}: status pill`).toBe(true)
        expect.soft(facts.referenceContained, `${theme}/${density}: reference chip`).toBe(true)
        expect(facts.referenceLabel, `${theme}/${density}: compact reference label`).toBe('#1234')
        expect(facts.diffPair, `${theme}/${density}: compacted diff pair`).toEqual({
          adds: '+12k',
          dels: '−1k',
          title: '+12345 −1234 across 37 files',
        })
        expect.soft(facts.diffContained, `${theme}/${density}: diff stat`).toBe(true)
        expect.soft(facts.workflowHeaderContained, `${theme}/${density}: workflow header`).toBe(true)
        expect(facts.memoryLabel, `${theme}/${density}: persisted memory metric`).toBe('peak 1023 MB')
        expect.soft(facts.metricsBeforeNeighbors, `${theme}/${density}: metrics before neighboring content`).toBe(true)
        expect(facts.secondary.slice(0, -1).every(({ width, contained }) => width > 0 && contained), `${theme}/${density}: ${JSON.stringify(facts.secondary)}`).toBe(true)
        expect(facts.secondary.filter(({ clipsOverflow }) => clipsOverflow).map(({ id }) => id)).toEqual(['tokens'])
        expect(facts.secondary.slice(0, -1).map(({ id, label, accessible, title }) => ({ id, label, accessible, title }))).toEqual([
          { id: 'tokens', label: '999.9k / 888.8k', accessible: 'Input tokens: 999,900; output tokens: 888,800', title: 'Input tokens: 999,900; output tokens: 888,800' },
          { id: 'cost', label: '$123', accessible: '$123.45', title: '$123.45' },
          // Honestly empty: no process, so no usage sample, so no live CPU. See this suite's note.
          { id: 'cpu', label: '—', accessible: null, title: null },
          { id: 'memory', label: 'peak 1023 MB', accessible: 'peak 1023 MB; peak — run finished', title: 'peak 1023 MB; peak — run finished' },
        ])
        expect(facts.pageContained, `${theme}/${density}: page overflow`).toBe(true)

        focusWithKeyboard(browser, `${wrappingRow} [data-slot="row-rename"]`)
        // The pencil is `opacity-0 transition-opacity focus-visible:opacity-100`. Tab is not
        // the same tick as :focus-visible, and that class — not a computed-style poll alone —
        // is what starts the fade. Wait on both so we do not sample mid-transition.
        browser.waitForFunction(
          `(() => {
            const button = document.querySelector('${wrappingRow} [data-slot="row-rename"]')
            return !!button && button === document.activeElement && button.matches(':focus-visible') && getComputedStyle(button).opacity === '1'
          })()`,
        )
        const actions = browser.evaluate(`(() => {
          const cell = document.querySelector('${wrappingRow} td[data-column-id="task"]')
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
  })

  it('gives the task column the width the Workflow fold releases, and remembers a resized sidebar', () => {
    const taskWidth = () =>
      Number(browser.evaluate(
        `document.querySelector('${wrappingRow} td[data-column-id="task"]').getBoundingClientRect().width`,
      ))

    const widthBeforeFold = taskWidth()
    browser.click('button[aria-label="Fold Workflow column"]')
    browser.waitForFunction(`document.querySelector('button[aria-label="Expand Workflow column"]') !== null`)
    expect(taskWidth()).toBeGreaterThanOrEqual(widthBeforeFold)
    browser.click('button[aria-label="Expand Workflow column"]')
    browser.waitForFunction(`document.querySelector('button[aria-label="Fold Workflow column"]') !== null`)

    browser.evaluate(`localStorage.setItem('cez-sidebar-width', '360')`)
    browser.goto(`${worstUrl}/p/${worstProject}/`)
    browser.waitForFunction(`document.querySelector('${wrappingRow}') !== null`)
    showResourceTable()
    const resized = browser.evaluate(`({
      preference: localStorage.getItem('cez-sidebar-width'),
      sidebarWidth: document.querySelector('[data-slot="sidebar"]').getBoundingClientRect().width,
      taskWidth: document.querySelector('${wrappingRow} td[data-column-id="task"]').getBoundingClientRect().width,
    })`) as { preference: string; sidebarWidth: number; taskWidth: number }
    expect(resized.preference).toBe('360')
    expect(resized.sidebarWidth).toBe(360)
    // The fixed table can distribute spare width beyond the task column's 320px minimum.
    expect(resized.taskWidth).toBeGreaterThanOrEqual(320)
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

  /** The row title's measured width — how much of the column the NAME actually got.
   *  Wait, then read as one step: the row existed at the `beforeEach` wait, was absent at the
   *  measurement, and was present again in the failure snapshot. The trigger was not reproduced
   *  in four targeted reruns. Evidence: .ai/qa/local-runs/1790767992591-919007/lane-4-failures/
   *  quick-list/grows-the-name-as-the-column-grows-without-ever-shrinking-it-1/{probe.json,snapshot.txt}.
   *  Read only while the measured node exists; keep the width assertions unchanged. */
  const titleWidth = () =>
    Number(
      browser.waitForValue(
        `document.querySelector('${ROW_ID} [data-slot="task-row-title"]')?.getBoundingClientRect().width ?? null`
      )
    )

  /** The diff pair's RESOLVED display — the container query's answer, not a class. */
  const diffDisplay = () =>
    String(browser.waitForValue(`(() => { const diff = document.querySelector('${ROW_ID} [data-slot="diff-stat"]'); return diff ? getComputedStyle(diff).display : null })()`))

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
          // #729: a handed-off row whose meta line (glyph, state, two references, age) is wider
          // than the default column, so the age has to drop and come back with the width.
          {
            id: 'meta-load',
            title: 'Webhook hand-off',
            workflow: 'default',
            task: 'hand off',
            status: 'review',
            createdAt: ago(2 * 3_600_000),
            finishedAt: ago(3_600_000),
            tokensUsed: 0,
            notify: true,
            pullRequestUrl: 'https://github.com/open-mercato/cezar/pull/12345',
            referencedIssueUrl: 'https://github.com/open-mercato/cezar/issues/67890',
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

  afterAll(async () => {
    await stopFixtureServer(wideServer)
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
        chipInert: chip.dataset.inert ?? null,
        tooltip: row.querySelector('a[href$="/tasks/wide-load"]').getAttribute('title'),
      }
    })()`) as { title: string; chip: string; chipInert: string | null; tooltip: string }

    expect(painted.title).toBe('implementing comment threads across the whole thread view')
    // Plain text on the meta line since #617, spelled as the kind and the number.
    expect(painted.chip).toBe('PR #775')
    // Plain text on this spec's `hover: none` browser (#617 01b); the task header has the link.
    expect(painted.chipInert).toBe('true')
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

  it('drops the age whole before anything else, keeps the glyph, and restores the age wider, without flicker (#729)', () => {
    const META_ROW = '[data-slot="task-row"][data-run-id="meta-load"]'
    type Meta = { age: string | null; text: string; glyphInside: boolean; ageInside: boolean; glyphFirst: boolean }
    const read = () =>
      browser.evaluate(`(() => {
        const meta = document.querySelector('${META_ROW} [data-slot="task-row-meta"]')
        const box = meta.getBoundingClientRect()
        const glyph = meta.querySelector('[data-slot="task-row-notify"]').getBoundingClientRect()
        const age = meta.querySelector('[data-slot="task-row-age"]')
        const ageBox = age?.getBoundingClientRect()
        return { age: age?.textContent ?? null, text: meta.textContent,
          glyphInside: glyph.width > 0 && glyph.left >= box.left && glyph.right <= box.right,
          ageInside: ageBox ? ageBox.right <= box.right + 0.5 : true,
          glyphFirst: meta.firstElementChild.dataset.slot === 'task-row-notify' }
      })()`) as Meta

    expect(sidebarWidth()).toBe(264)
    // Narrowest column: the age is gone whole (no "· 1…"), the glyph and the references are there.
    const narrow = read()
    expect(narrow.age).toBeNull()
    expect(narrow.text).not.toMatch(/ · \d+[smhd]?…?$/)
    expect(narrow.text).toContain('PR #12345')
    expect(narrow.glyphInside && narrow.glyphFirst).toBe(true)
    // Stable: the decision does not flip across repeated frames at the same width.
    for (let i = 0; i < 8; i += 1) expect(read().age).toBeNull()
    browser.screenshot(`${artifactsDir}/quick-list-notify-age-dropped-264.png`, { viewport: true })

    dragHandle(156)
    expect(sidebarWidth()).toBe(420)
    const wide = browser.waitForValue(`document.querySelector('${META_ROW} [data-slot="task-row-age"]')?.textContent ?? null`)
    expect(String(wide)).toMatch(/^\d+[smhd]$/)
    const restored = read()
    expect(restored.ageInside && restored.glyphInside && restored.glyphFirst).toBe(true)
    for (let i = 0; i < 8; i += 1) expect(read().age).not.toBeNull()
    browser.screenshot(`${artifactsDir}/quick-list-notify-age-restored-420.png`, { viewport: true })

    // And back: the same stored width decides, so the age leaves again.
    dragHandle(-156)
    expect(sidebarWidth()).toBe(264)
    browser.waitForValue(`document.querySelector('${META_ROW} [data-slot="task-row-age"]') === null`)
    expect(read().glyphInside).toBe(true)
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
    browser.click('[data-slot="mobile-top-bar"] button[aria-label^="Open projects"]')
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
/**
 * Variant rows and the group row at the default 264px column (#617 fix round). Its own fixture:
 * a short-token opencode variant is the case where line 1 (`opencode · $0.40`) runs out of room
 * while line 2's tokens would still fit, and only a real layout can say which gives way.
 */
describe('variant rows and the group row under width pressure', () => {
  let varServer: ChildProcess
  let varRoot: string
  let varUrl: string
  let varProject: string
  const GROUP = '[data-slot="group-row"][data-group-id="g-wide"]'
  const member = (id: string) => `[data-slot="task-row"][data-run-id="${id}"]`
  const VARIANTS = ['wa', 'wb'].map((id, index) => ({
    id, title: `Ledger scan (${index ? 'B' : 'A'})`, workflow: 'default', task: 'scan the ledger', status: 'review',
    createdAt: ago((20 - index) * 60_000), finishedAt: ago((10 - index) * 60_000), tokensUsed: 2,
    runner: 'opencode', costUsd: 0.4, inputTokens: 1, outputTokens: 1,
    // Shared by both, so it belongs to the group row's line 2 (#617 01a).
    referencedIssueUrl: 'https://github.com/open-mercato/cezar/issues/425',
    groupId: 'g-wide', variant: index ? 'B' : 'A', archived: false, steps: [],
  }))

  beforeAll(async () => {
    varRoot = mkdtempSync(join(tmpdir(), 'cezar-e2e-variants-'))
    mkdirSync(join(varRoot, '.ai/cezar'), { recursive: true })
    writeFileSync(join(varRoot, '.ai/cezar/runs.json'), JSON.stringify(VARIANTS, null, 2), 'utf8')
    const port = await freePort()
    varUrl = `http://localhost:${port}`
    varServer = spawn(process.execPath, [cezarCli, 'serve', '--repo', varRoot, '--port', String(port), '--no-open'], {
      env: fixtureServeEnv(varRoot), stdio: 'ignore',
    })
    await waitForHealth(varUrl, 'the variant-width fixture server')
    varProject = await bootProjectId(varUrl)
  }, 90_000)

  afterAll(async () => {
    browser.evaluate(`localStorage.removeItem('cez-sidebar-width')`)
    await stopFixtureServer(varServer)
    if (varRoot) rmSync(varRoot, { recursive: true, force: true })
    browser.setViewport(1440, 900)
    browser.goto(`${baseUrl}${scoped('/')}`)
    browser.waitForFunction(`document.querySelector('[data-slot="quick-list-bucket"]') !== null`)
  })

  const open = (width: number) => {
    browser.setViewport(1440, 900)
    browser.goto(`${varUrl}/p/${varProject}/`)
    browser.evaluate(`localStorage.setItem('cez-sidebar-width', '${width}')`)
    browser.goto(`${varUrl}/p/${varProject}/`)
    browser.waitForFunction(`document.querySelector('${GROUP} [data-slot="group-tile"]')?.getAttribute('aria-expanded') === 'false'`)
    browser.click(`${GROUP} [data-slot="group-tile"]`)
  }

  type Line = { text: string; rendered: string; overflows: boolean; tokens: boolean; costShown: boolean }
  const lineOf = (id: string) => `(() => {
    const row = document.querySelector(${JSON.stringify(member(id))})
    const title = row?.querySelector('[data-slot="task-row-title"]')
    if (!title) return null
    const cost = title.querySelector('[data-slot="variant-cost"]')
    return { text: title.textContent, rendered: title.innerText, overflows: title.scrollWidth > title.clientWidth,
      tokens: row.querySelector('[data-slot="task-row-tokens"]') !== null,
      costShown: cost !== null && cost.getBoundingClientRect().right <= title.getBoundingClientRect().right + 0.5 }
  })()`

  it('at 264px, never shows the tokens while the cost is cut, and reads "opencode · $0.40"', () => {
    open(264)
    for (const id of ['wa', 'wb']) {
      // The layout settles after the ResizeObserver's first pass: wait for a stable answer.
      const line = browser.waitForStable(lineOf(id), { holdMs: 300, matcher: (l: Line | null) => l !== null && !(l.overflows && l.tokens) }) as Line
      expect(line.text, id).toBe('opencode · $0.40')
      // Rendered text keeps the separator's spaces (a flex item dropped the leading one).
      expect(line.rendered, id).toBe('opencode · $0.40')
      // Tokens drop first: either the whole cost is visible, or the tokens are gone.
      expect(line.costShown || !line.tokens, JSON.stringify(line)).toBe(true)
    }
    browser.screenshot(`${artifactsDir}/quick-list-variants-264.png`, { viewport: true })
  })

  it('at 420px, has room for both: the full cost and the tokens', () => {
    open(420)
    for (const id of ['wa', 'wb']) {
      const line = browser.waitForStable(lineOf(id), { holdMs: 300, matcher: (l: Line | null) => l !== null && l.tokens && !l.overflows }) as Line
      expect(line.costShown, JSON.stringify(line)).toBe(true)
    }
  })

  it("puts the shared reference on the group row's line 2, and keeps the row's height through expand", () => {
    browser.setViewport(1440, 900)
    browser.goto(`${varUrl}/p/${varProject}/`)
    type Group = { expanded: string | null; height: number; meta: string; inert: string | null; links: number; inToggle: boolean }
    const group = `(() => {
      const row = document.querySelector('${GROUP}')
      const meta = row?.querySelector('[data-slot="group-meta"]')
      if (!meta) return null
      const chip = meta.querySelector('[data-slot="issue-chip"]')
      return { expanded: row.querySelector('[data-slot="group-tile"]').getAttribute('aria-expanded'),
        height: Math.round(row.getBoundingClientRect().height), meta: meta.textContent,
        inert: chip?.dataset.inert ?? null, links: meta.querySelectorAll('a').length, inToggle: chip?.closest('button') != null }
    })()`
    const collapsed = browser.waitForValue(group, (g: Group | null) => g?.expanded === 'false') as Group
    // The fixture's newest member finished 9m before `now`, a module-load constant, while the row
    // ages against the live clock: a slow shard start legitimately shows 10m, 11m... So pin the
    // age to 9m plus the minutes elapsed since the fixture was built (one minute of rounding slack)
    // instead of the bare 9m, which was wall-clock dependent, or any digits, which would pass a wrong age.
    // Reproduction (red with the bare 9m, green with this bound): quick-list-age-reproduction.md.
    const shown = /^2 needs review · #425 · (\d+)m$/.exec(collapsed.meta)
    const elapsedMin = Math.floor((Date.now() - now) / 60_000)
    expect(shown, collapsed.meta).not.toBeNull()
    expect(Number(shown?.[1]), collapsed.meta).toBeGreaterThanOrEqual(9 + elapsedMin - 1)
    expect(Number(shown?.[1]), collapsed.meta).toBeLessThanOrEqual(9 + elapsedMin + 1)
    // This spec's browser reports `hover: none`, so the reference is inert text here; the
    // pointer path (a link with the status panel) is pinned in selection-states.
    // …and inside the one toggle that spans both lines (#617 mobile regression): inert text is
    // not interactive, so nothing is nested in the button.
    expect(collapsed).toMatchObject({ inert: 'true', links: 0, inToggle: true })
    browser.click(`${GROUP} [data-slot="group-tile"]`)
    const expanded = browser.waitForValue(group, (g: Group | null) => g?.expanded === 'true') as Group
    expect(expanded.height).toBe(collapsed.height)
    // The members no longer repeat the reference their group row carries.
    const memberMeta = browser.waitForValue(`document.querySelector('${member('wa')} [data-slot="task-row-meta"]')?.textContent ?? null`) as string
    expect(memberMeta).toMatch(/^needs review/)
    expect(memberMeta).not.toContain('#425')
  })

  it('gives the compare link a real 44px touch target beside the disclosure, and a tap opens compare', () => {
    open(264)
    type Target = { noHover: boolean; w: number; h: number; clearOfDisclosure: boolean; hits: boolean[]; x: number; y: number }
    const target = browser.waitForValue(`(() => {
      const link = document.querySelector('${GROUP} [data-slot="group-compare"]')
      const chevron = document.querySelector('${GROUP} [data-slot="group-disclosure"]')
      if (!link || !chevron) return null
      const r = link.getBoundingClientRect(), c = chevron.getBoundingClientRect()
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2
      const points = [[r.left + 1, cy], [r.right - 1, cy], [cx, r.top + 1], [cx, r.bottom - 1], [cx, cy]]
      return { noHover: matchMedia('(hover: none)').matches, w: r.width, h: r.height, clearOfDisclosure: r.right <= c.left + 0.5,
        hits: points.map(([x, y]) => link.contains(document.elementFromPoint(x, y))), x: Math.round(cx), y: Math.round(cy) }
    })()`) as Target
    // This spec's browser reports `hover: none` — the touch path this target exists for.
    expect(target.noHover).toBe(true)
    expect([target.w, target.h]).toEqual([44, 44])
    expect(target.clearOfDisclosure).toBe(true)
    expect(target.hits).toEqual([true, true, true, true, true])
    browser.tapAt(target.x, target.y)
    browser.waitForFunction(`location.pathname.endsWith('/compare/g-wide')`)
  })
})

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

  afterAll(async () => {
    await stopFixtureServer(emptyServer)
    if (emptyRoot) rmSync(emptyRoot, { recursive: true, force: true })
  })

  it('shows the honest empty state — a fresh cezar has nothing to list', () => {
    browser.goto(`${emptyUrl}/p/${emptyProject}/`)
    browser.waitForFunction(`document.querySelector('[data-slot="project-task-navigation"]') !== null && document.querySelector('[data-slot="main"]')?.textContent.includes('No tasks')`)

    expect(browser.text('[data-slot="main"]')).toContain('No tasks')
    expect(browser.count(ROW)).toBe(0)
    expect(browser.count('[data-slot="quick-list-bucket"]')).toBe(0)

    browser.screenshot(`${artifactsDir}/quick-list-empty.png`)
  })
})


describe('persistent task pins (#93)', () => {
  it('pins a needs-you variant from a 44px phone control without moving it out of attention on reload', async () => {
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
    browser.waitForFunction(`document.querySelector('[data-bucket="Needs you"] [data-slot="group-tile"]') !== null`)
    expect(browser.count('[data-slot="group-tile"][data-group-id="fix-group-1"]')).toBe(1)
    browser.click('[data-bucket="Needs you"] [data-slot="group-tile"]')
    browser.waitForFunction(`document.querySelector('[data-bucket="Needs you"] [data-run-id="fix-var-a"]') !== null`)
    expect(browser.evaluate(`[...document.querySelectorAll('[data-bucket="Needs you"] [data-slot="task-row"]')].map(x => x.dataset.runId)`)).toEqual(['fix-var-a', 'fix-var-b', 'fix-review-pr'])
    const runs = await (await fetch(`${baseUrl}/api/v1/runs`)).json() as Array<{ id: string; pinned?: boolean; pinnedAt?: string }>
    expect(runs.find(r => r.id === 'fix-var-a')).not.toHaveProperty('pinned')
    expect(runs.find(r => r.id === 'fix-var-b')).toMatchObject({ pinned: true, pinnedAt: expect.any(String) })
    browser.click('[data-bucket="Needs you"] [data-run-id="fix-var-b"] [data-slot="pin-toggle"]')
    browser.waitForFunction(`document.querySelector('[data-bucket="Needs you"] [data-run-id="fix-var-b"] [data-slot="pin-toggle"]')?.getAttribute('aria-pressed') === 'false'`)
    expect(browser.count('[data-bucket="Pinned"]')).toBe(0)
    const unpinned = await (await fetch(`${baseUrl}/api/v1/runs/fix-var-b`)).json()
    expect(unpinned).not.toHaveProperty('pinned')
    expect(unpinned).not.toHaveProperty('pinnedAt')
  })
})

describe('archive from the sidebar (#780)', () => {
  // Its own browser: the row button only exists where the primary pointer can hover, and headless
  // Chrome reports `(hover: none)` unless it is launched with the flag (see selection-states).
  const originalArgs = process.env.AGENT_BROWSER_ARGS
  let browser: AgentBrowser
  let archiveServer: ChildProcess
  let archiveRoot: string
  let archiveUrl: string
  let archiveProject: string
  const archiveScoped = (path: string) => `/p/${archiveProject}${path}`
  const finishedRun = (id: string, title: string, minutesAgo: number, extra: Record<string, unknown> = {}) => ({
    id,
    title,
    workflow: 'default',
    task: title,
    status: 'done',
    createdAt: ago((minutesAgo + 5) * 60_000),
    finishedAt: ago(minutesAgo * 60_000),
    tokensUsed: 1_000,
    archived: false,
    steps: [],
    ...extra,
  })
  const ARCHIVE_FIXTURE = [
    finishedRun('arc-a', 'Tidy the release notes', 10),
    finishedRun('arc-b', 'Rename the config loader', 20),
    finishedRun('arc-pinned', 'Pinned and finished', 30, { pinned: true, pinnedAt: ago(5 * 60_000) }),
    finishedRun('arc-scheduled', 'Waiting out a usage limit', 40, { status: 'failed', autoResumeAt: new Date(Date.now() + 86_400_000).toISOString() }),
  ]
  const rowSel = (id: string) => `${ROW}[data-run-id="${id}"]`
  const archiveBtn = (id: string) => `${rowSel(id)} [data-action="archive-run"]`
  const toastText = () => browser.evaluate(`document.querySelector('[data-slot="toast"]')?.textContent ?? null`)
  const ids = (bucket: string) =>
    browser.evaluate(`[...document.querySelectorAll('[data-bucket="${bucket}"] ${ROW}')].map((row) => row.dataset.runId)`) as string[]
  const stored = async (id: string) =>
    ((await (await fetch(`${archiveUrl}/api/v1/runs/${id}`)).json()) as { archived?: boolean; pinned?: boolean; autoResumeAt?: string })

  beforeAll(async () => {
    process.env.AGENT_BROWSER_ARGS = [originalArgs, ...HOVER_POINTER_ARGS].filter(Boolean).join(',')
    browser = AgentBrowser.open(`${runId}-archive`)
    archiveRoot = mkdtempSync(join(tmpdir(), 'cezar-e2e-archive-'))
    mkdirSync(join(archiveRoot, '.ai/cezar'), { recursive: true })
    writeFileSync(join(archiveRoot, '.ai/cezar/runs.json'), JSON.stringify(ARCHIVE_FIXTURE, null, 2), 'utf8')
    const port = await freePort()
    archiveUrl = `http://localhost:${port}`
    archiveServer = spawn(process.execPath, [cezarCli, 'serve', '--repo', archiveRoot, '--port', String(port), '--no-open'], {
      env: fixtureServeEnv(archiveRoot),
      stdio: 'ignore',
    })
    await waitForHealth(archiveUrl)
    archiveProject = await bootProjectId(archiveUrl)
  }, 60_000)

  afterAll(async () => {
    browser?.close()
    if (originalArgs === undefined) delete process.env.AGENT_BROWSER_ARGS
    else process.env.AGENT_BROWSER_ARGS = originalArgs
    await stopFixtureServer(archiveServer)
    if (archiveRoot) rmSync(archiveRoot, { recursive: true, force: true })
  })

  beforeEach(() => {
    browser.setViewport(1440, 900)
    browser.goto(`${archiveUrl}${archiveScoped('/')}`)
    browser.waitForFunction(`document.querySelector('${rowSel('arc-a')}') !== null`)
  })

  it('reveals the row button without moving the title or the row, and leaves Working rows without one', () => {
    const measure = `(() => {
      const row = document.querySelector('${rowSel('arc-a')}')
      const button = row.querySelector('[data-action="archive-run"]')
      return {
        opacity: button ? getComputedStyle(button).opacity : null,
        title: row.querySelector('[data-slot="task-row-title"]').getBoundingClientRect().width,
        height: row.getBoundingClientRect().height,
      }
    })()`
    const rest = browser.waitForValue<{ opacity: string; title: number; height: number }>(measure, (s) => s.opacity === '0')
    browser.hover(rowSel('arc-a'))
    const hovered = browser.waitForValue<{ opacity: string; title: number; height: number }>(measure, (s) => s.opacity === '1')
    expect(hovered.title).toBe(rest.title)
    expect(hovered.height).toBe(rest.height)
    // A scheduled run is archivable from its thread only.
    expect(browser.count(archiveBtn('arc-scheduled'))).toBe(0)
    expect(browser.count(archiveBtn('arc-a'))).toBe(1)
  })

  it('archives on click with no dialog, offers Undo, and Undo puts the row back', async () => {
    browser.hover(rowSel('arc-b'))
    browser.click(archiveBtn('arc-b'))
    browser.waitForFunction(`document.querySelector('${rowSel('arc-b')}') === null`)
    expect(browser.count('[role="alertdialog"]')).toBe(0)
    expect(browser.waitForValue(`document.querySelector('[data-slot="toast"]')?.textContent ?? null`)).toContain('Archived "Rename the config loader"')
    expect((await stored('arc-b')).archived).toBe(true)
    browser.click('[data-slot="toast-action"]')
    browser.waitForFunction(`document.querySelector('[data-bucket="Finished"] ${rowSel('arc-b')}') !== null`)
    expect((await stored('arc-b')).archived).toBeFalsy()
  })

  it('brings a pinned row back pinned, under Pinned', async () => {
    expect(ids('Pinned')).toEqual(['arc-pinned'])
    browser.hover(rowSel('arc-pinned'))
    browser.click(archiveBtn('arc-pinned'))
    browser.waitForFunction(`document.querySelector('${rowSel('arc-pinned')}') === null`)
    browser.click('[data-slot="toast-action"]')
    browser.waitForFunction(`document.querySelector('[data-bucket="Pinned"] ${rowSel('arc-pinned')}') !== null`)
    const back = await stored('arc-pinned')
    expect(back.archived).toBeFalsy()
    expect(back.pinned).toBe(true)
  })

  it('"Archive all" takes the Finished rows only, and Undo restores them', async () => {
    browser.click('[data-action="archive-group"][data-scope="unpinned"]')
    browser.waitForFunction(`document.querySelector('[data-bucket="Finished"]') === null`)
    expect(browser.waitForValue(`document.querySelector('[data-slot="toast"]')?.textContent ?? null`)).toContain('Archived 2 tasks')
    // Pinned is untouched, and so is the scheduled run (it sits in Working and keeps its resume).
    expect(ids('Pinned')).toEqual(['arc-pinned'])
    expect((await stored('arc-scheduled')).archived).toBeFalsy()
    expect((await stored('arc-scheduled')).autoResumeAt).toBeTruthy()
    browser.click('[data-slot="toast-action"]')
    browser.waitForFunction(`document.querySelectorAll('[data-bucket="Finished"] ${ROW}').length === 2`)
  })

  it('"Archive finished" on Pinned takes the pinned finished row and comes back pinned on Undo', async () => {
    browser.click('[data-action="archive-group"][data-scope="pinned"]')
    browser.waitForFunction(`document.querySelector('[data-bucket="Pinned"]') === null`)
    expect(browser.waitForValue(`document.querySelector('[data-slot="toast"]')?.textContent ?? null`)).toContain('Archived 1 task')
    browser.click('[data-slot="toast-action"]')
    browser.waitForFunction(`document.querySelector('[data-bucket="Pinned"] ${rowSel('arc-pinned')}') !== null`)
    expect((await stored('arc-pinned')).pinned).toBe(true)
  })

  it('keeps the row button and both group buttons readable, at rest and hovered, in both themes', () => {
    try {
      for (const variant of contrastQaVariants.filter(({ viewport }) => viewport.width === 1440)) {
        applyContrastQaVariant(browser, variant)
        browser.hover(rowSel('arc-a'))
        browser.waitForValue(`getComputedStyle(document.querySelector('${archiveBtn('arc-a')}')).opacity`, (v) => v === '1')
        const icon = browser.evaluate(contrastSampleExpression(`${archiveBtn('arc-a')} svg`, 'color', 'parent')) as ContrastSample
        expect(icon.ratio, `${variant.id} row button: ${icon.foreground} on ${icon.background}`).toBeGreaterThanOrEqual(3)
        for (const scope of ['unpinned', 'pinned']) {
          const group = `[data-action="archive-group"][data-scope="${scope}"]`
          browser.moveTo(0, 0)
          const rest = browser.evaluate(contrastSampleExpression(group, 'color', 'parent')) as ContrastSample
          expect(rest.ratio, `${variant.id} ${scope} rest: ${rest.foreground} on ${rest.background}`).toBeGreaterThanOrEqual(4.5)
          browser.hover(group)
          const hovered = browser.waitForValue<ContrastSample>(
            contrastSampleExpression(group),
            (sample) => sample.background !== rest.background,
          )
          expect(hovered.ratio, `${variant.id} ${scope} hover: ${hovered.foreground} on ${hovered.background}`).toBeGreaterThanOrEqual(4.5)
        }
      }
    } finally {
      restoreContrastQaDefaults(browser)
    }
  })
})

describe('swipe to archive on touch (#780 §7)', () => {
  // The default browser: headless Chrome reports `(hover: none)`, which at desktop width is the
  // touch path (`useRowReferencesInert`) where the swipe replaces the row button. Input is real
  // CDP touch (`touchDrag`), so `touch-action: pan-y` and the browser's own panning apply.
  let browser: AgentBrowser
  let swipeServer: ChildProcess
  let swipeRoot: string
  let swipeUrl: string
  let swipeProject: string
  const swipeRun = (id: string, title: string, minutesAgo: number, extra: Record<string, unknown> = {}) => ({
    id,
    title,
    workflow: 'default',
    task: title,
    status: 'done',
    createdAt: ago((minutesAgo + 5) * 60_000),
    finishedAt: ago(minutesAgo * 60_000),
    tokensUsed: 1_000,
    archived: false,
    steps: [],
    ...extra,
  })
  // Enough finished rows that the sidebar scrolls at 500px tall.
  const SWIPE_FIXTURE = [
    // Not finished as far as the sidebar is concerned: it sits in Working, waiting out a usage
    // limit. (A `running` record would not survive the store's boot-time reconcile.)
    swipeRun('sw-live', 'Waiting out a usage limit', 1, { status: 'failed', autoResumeAt: new Date(Date.now() + 86_400_000).toISOString() }),
    ...Array.from({ length: 10 }, (_, i) => swipeRun(`sw-${i}`, `Finished task ${i}`, 10 + i)),
  ]
  const rowSel = (id: string) => `${ROW}[data-run-id="${id}"]`
  const actionSel = (id: string) => `[data-slot="task-row-swipe"]:has(> ${rowSel(id)}) [data-slot="task-row-swipe-action"]`
  const stored = async (id: string) => ((await (await fetch(`${swipeUrl}/api/v1/runs/${id}`)).json()) as { archived?: boolean })
  /** The row's box, scrolled into view and settled (no running finite animation: a running
   *  row's status dot pulses forever), read in one step. */
  const box = (id: string) =>
    browser.waitForValue<{ left: number; right: number; top: number; bottom: number; cy: number; width: number }>(`(() => {
      const row = document.querySelector('${rowSel(id)}')
      if (!row || row.getAnimations({ subtree: true }).some((a) => a.playState === 'running' && a.effect?.getComputedTiming().iterations !== Infinity)) return null
      row.scrollIntoView({ block: 'nearest' })
      const r = row.getBoundingClientRect()
      return r.bottom <= innerHeight && r.top >= 0 ? { left: r.left, right: r.right, top: r.top, bottom: r.bottom, cy: r.top + r.height / 2, width: r.width } : null
    })()`)
  /** A left swipe from near the row's right edge by `dx` px, in `steps` moves `stepMs` apart. */
  const leftSwipe = (r: { right: number; cy: number }, dx: number, opts: { steps?: number; stepMs?: number; whileDown?: string } = {}) => {
    const steps = opts.steps ?? 6
    const start = { x: r.right - 12, y: r.cy }
    return browser.touchDrag(
      [start, ...Array.from({ length: steps }, (_, i) => ({ x: start.x - (dx * (i + 1)) / steps, y: r.cy }))],
      { stepMs: opts.stepMs ?? 150, whileDown: opts.whileDown },
    )
  }

  beforeAll(async () => {
    browser = AgentBrowser.open(`${runId}-swipe`)
    swipeRoot = mkdtempSync(join(tmpdir(), 'cezar-e2e-swipe-'))
    mkdirSync(join(swipeRoot, '.ai/cezar'), { recursive: true })
    writeFileSync(join(swipeRoot, '.ai/cezar/runs.json'), JSON.stringify(SWIPE_FIXTURE, null, 2), 'utf8')
    const port = await freePort()
    swipeUrl = `http://localhost:${port}`
    swipeServer = spawn(process.execPath, [cezarCli, 'serve', '--repo', swipeRoot, '--port', String(port), '--no-open'], {
      env: fixtureServeEnv(swipeRoot),
      stdio: 'ignore',
    })
    await waitForHealth(swipeUrl)
    swipeProject = await bootProjectId(swipeUrl)
  }, 60_000)

  afterAll(async () => {
    browser?.close()
    await stopFixtureServer(swipeServer)
    if (swipeRoot) rmSync(swipeRoot, { recursive: true, force: true })
  })

  beforeEach(() => {
    browser.setViewport(1440, 900)
    browser.goto(`${swipeUrl}/p/${swipeProject}/`)
    browser.waitForFunction(`document.querySelector('[data-slot="task-row-swipe"] > ${rowSel('sw-0')}') !== null`)
  })

  it('renders the swipe, not the row button, on a device that cannot hover', () => {
    expect(browser.evaluate(`matchMedia('(hover: none)').matches`)).toBe(true)
    expect(browser.count('[data-action="archive-run"]')).toBe(0)
    expect(browser.evaluate(`getComputedStyle(document.querySelector('[data-slot="task-row-swipe"]')).touchAction`)).toBe('pan-y')
  })

  it('parks a short swipe on Archive, and tapping it archives with an Undo toast', async () => {
    const r = box('sw-1')
    await leftSwipe(r, 60)
    // Released past 40px and slowly: the row parks on the 88px action, it does not archive.
    const parked = browser.waitForValue<{ transform: string; label: string }>(`(() => {
      const row = document.querySelector('${rowSel('sw-1')}')
      const action = document.querySelector('${actionSel('sw-1')}')
      return row && action && row.style.transform === 'translateX(-88px)' ? { transform: row.style.transform, label: action.textContent } : null
    })()`)
    expect(parked.label).toBe('Archive')
    expect((await stored('sw-1')).archived).toBeFalsy()
    browser.click(`${actionSel('sw-1')} button`)
    browser.waitForFunction(`document.querySelector('${rowSel('sw-1')}') === null`)
    expect(browser.waitForValue(`document.querySelector('[data-slot="toast"]')?.textContent ?? null`)).toContain('Archived "Finished task 1"')
    expect((await stored('sw-1')).archived).toBe(true)
    browser.click('[data-slot="toast-action"]')
    browser.waitForFunction(`document.querySelector('[data-bucket="Finished"] ${rowSel('sw-1')}') !== null`)
  })

  it('a long swipe shows "Release to archive" and archives on release', async () => {
    const r = box('sw-2')
    const held = (await leftSwipe(r, r.width * 0.8, {
      whileDown: `(() => { const a = document.querySelector('${actionSel('sw-2')}'); return a?.dataset.past === 'true' ? a.textContent : null })()`,
    })) as string | null
    expect(held).toBe('Release to archive')
    browser.waitForFunction(`document.querySelector('${rowSel('sw-2')}') === null`)
    expect(browser.waitForValue(`document.querySelector('[data-slot="toast"]')?.textContent ?? null`)).toContain('Archived "Finished task 2"')
    expect((await stored('sw-2')).archived).toBe(true)
    browser.click('[data-slot="toast-action"]')
    browser.waitForFunction(`document.querySelector('[data-bucket="Finished"] ${rowSel('sw-2')}') !== null`)
  })

  it('a vertical drag over a finished row scrolls the list and never moves the row', async () => {
    browser.setViewport(1440, 500)
    const scroller = `(() => {
      for (let el = document.querySelector('${rowSel('sw-3')}'); el; el = el.parentElement) {
        const style = getComputedStyle(el)
        if (/(auto|scroll)/.test(style.overflowY) && el.scrollHeight > el.clientHeight) return el
      }
      return null
    })()`
    const before = browser.waitForValue<number>(`(() => { const s = ${scroller}; return s ? s.scrollTop : null })()`)
    const r = box('sw-3')
    // Mostly vertical, a little horizontal drift: the gesture locks vertical and the browser pans.
    const during = (await browser.touchDrag(
      [{ x: r.right - 40, y: r.cy }, ...[1, 2, 3, 4, 5, 6].map((i) => ({ x: r.right - 40 - i * 1.5, y: r.cy - i * 20 }))],
      { stepMs: 30, whileDown: `getComputedStyle(document.querySelector('${rowSel('sw-3')}')).transform` },
    )) as string
    expect(during).toBe('none')
    const after = browser.waitForValue<{ top: number; transform: string }>(`(() => {
      const s = ${scroller}
      const row = document.querySelector('${rowSel('sw-3')}')
      return s && row && s.scrollTop !== ${before} ? { top: s.scrollTop, transform: getComputedStyle(row).transform } : null
    })()`)
    expect(after.top).toBeGreaterThan(before)
    expect(after.transform).toBe('none')
    expect(browser.count('[data-slot="task-row-swipe-action"]')).toBe(0)
  })

  it('leaves a scheduled row where it is', async () => {
    expect(browser.count(`[data-slot="task-row-swipe"] > ${rowSel('sw-live')}`)).toBe(0)
    const r = box('sw-live')
    const during = (await leftSwipe(r, r.width * 0.8, {
      whileDown: `getComputedStyle(document.querySelector('${rowSel('sw-live')}')).transform`,
    })) as string
    expect(during).toBe('none')
    expect((await stored('sw-live')).archived).toBeFalsy()
  })

  it('keeps "Archive" on --muted and "Release to archive" on --info readable, dark and light', async () => {
    try {
      for (const variant of contrastQaVariants.filter(({ viewport, density }) => viewport.width === 1440 && density === 'comfortable')) {
        applyContrastQaVariant(browser, variant)
        const r = box('sw-4')
        const release = (await leftSwipe(r, r.width * 0.8, {
          stepMs: 60,
          // Sampled under the held finger: the state exists only until it lifts.
          whileDown: `(() => { const a = document.querySelector('${actionSel('sw-4')}'); return a?.dataset.past === 'true' ? ${contrastSampleExpression(`${actionSel('sw-4')} span`)} : null })()`,
        })) as ContrastSample
        expect(release.ratio, `${variant.id} release: ${release.foreground} on ${release.background}`).toBeGreaterThanOrEqual(4.5)
        browser.waitForFunction(`document.querySelector('${rowSel('sw-4')}') === null`)
        browser.click('[data-slot="toast-action"]')
        browser.waitForFunction(`document.querySelector('${rowSel('sw-4')}') !== null`)
        const r2 = box('sw-4')
        await leftSwipe(r2, 60)
        const parked = browser.waitForValue<ContrastSample>(`(() => {
          if (document.querySelector('${rowSel('sw-4')}')?.style.transform !== 'translateX(-88px)') return null
          return ${contrastSampleExpression(`${actionSel('sw-4')} button`)}
        })()`)
        expect(parked.ratio, `${variant.id} parked: ${parked.foreground} on ${parked.background}`).toBeGreaterThanOrEqual(4.5)
        const icon = browser.evaluate(contrastSampleExpression(`${actionSel('sw-4')} svg`, 'color', 'parent')) as ContrastSample
        expect(icon.ratio, `${variant.id} parked icon`).toBeGreaterThanOrEqual(3)
        browser.goto(`${swipeUrl}/p/${swipeProject}/`)
        browser.waitForFunction(`document.querySelector('[data-slot="task-row-swipe"] > ${rowSel('sw-4')}') !== null`)
      }
    } finally {
      restoreContrastQaDefaults(browser)
    }
  })

  // Last: the emulated preference stays on this browser for the rest of the describe.
  it('snaps over 200ms, and not at all under prefers-reduced-motion', () => {
    const duration = `getComputedStyle(document.querySelector('${rowSel('sw-5')}')).transitionDuration`
    expect(browser.waitForValue(duration)).toBe('0.2s')
    browser.setReducedMotion()
    expect(browser.waitForValue(duration, (value) => value !== '0.2s')).toBe('0s')
  })
})
