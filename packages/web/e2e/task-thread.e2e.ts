import { spawn, type ChildProcess } from 'node:child_process'
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { AgentBrowser, bootProjectId, cezarCli, fixtureServeEnv } from './agent-browser'
import {
  applyContrastQaVariant,
  contrastQaVariants,
  contrastSampleExpression,
  focusWithKeyboard,
  hoverVisiblePoint,
  restoreContrastQaDefaults,
  type ContrastSample,
} from './contrast'
import record from './fixtures/thread-run.record.json'

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

const artifactsDir = resolve(import.meta.dirname, '../../../.ai/qa/artifacts_e2e')
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
}

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

/** A flat route target under this server's own project prefix (multi-project spec, step 3.2):
 *  every cockpit link is scoped, and every legacy flat URL redirects onto its scoped twin. */
const scoped = (path: string) => `/p/${bootProject}${path}`

beforeAll(async () => {
  dataRoot = mkdtempSync(join(tmpdir(), 'cezar-e2e-thread-'))
  mkdirSync(join(dataRoot, '.ai/cezar/runs'), { recursive: true })
  writeFileSync(join(dataRoot, '.ai/cezar/runs.json'), JSON.stringify([RUN, LONG_RUN], null, 2), 'utf8')
  copyFileSync(
    resolve(import.meta.dirname, 'fixtures/thread-run.ndjson'),
    join(dataRoot, '.ai/cezar/runs', `${RUN_ID}.ndjson`),
  )
  writeFileSync(join(dataRoot, '.ai/cezar/runs', `${LONG_RUN.id}.ndjson`),
    readFileSync(resolve(import.meta.dirname, 'fixtures/thread-run.ndjson'), 'utf8')
      .split('\n').filter((line) => !/plan\.updated|TodoWrite|toolu_mock_todo|\"type\":\"plan\"/.test(line)).join('\n'))
  // The agent screenshot the transcript's `image` line points at (served by the run itself).
  cpSync(
    resolve(import.meta.dirname, 'fixtures/thread-run-images'),
    join(dataRoot, '.ai/cezar/runs', `${RUN_ID}-images`),
    { recursive: true },
  )

  const port = await freePort()
  baseUrl = `http://localhost:${port}`
  server = spawn(
    process.execPath,
    [cezarCli, 'serve', '--repo', dataRoot, '--port', String(port), '--no-open'],
    { env: fixtureServeEnv(dataRoot), stdio: 'ignore' },
  )
  await waitForHealth(baseUrl)
  bootProject = await bootProjectId(baseUrl)

  browser = AgentBrowser.open(sessionId)
  browser.setViewport(1440, 900)
  browser.goto(`${baseUrl}${scoped(`/tasks/${RUN_ID}`)}`)
  // The thread is async twice over (lazy route chunk, then the SSE replay) — wait for content.
  browser.waitForFunction(`document.querySelectorAll('[data-slot="user-bubble"]').length >= 2`)
}, 120_000)

afterAll(() => {
  browser?.close()
  server?.kill()
  if (dataRoot) rmSync(dataRoot, { recursive: true, force: true })
})

describe('task thread', () => {
  it('renders the task and follow-up as labeled full-width user messages', () => {
    const bubbles = browser.evaluate(
      `[...document.querySelectorAll('[data-slot="user-bubble"] .thread-markdown')].map((el) => el.textContent)`,
    ) as string[]
    expect(bubbles).toHaveLength(2)
    expect(bubbles[0]).toContain('Summarize what this project does.')
    expect(bubbles[1]).toBe('Thanks — now show the markdown summary. mock:md')

    // The revised document layout fills the reading column; the YOU label identifies authorship.
    const geometry = browser.evaluate(`(() => {
      const bubble = document.querySelector('[data-slot="user-bubble"]')
      const message = document.querySelector('[data-slot="assistant-message"]')
      const column = bubble.parentElement
      const b = bubble.getBoundingClientRect(), c = column.getBoundingClientRect(), m = message.getBoundingClientRect()
      return { rightGap: c.right - b.right, bubbleLeft: b.left, mid: c.left + c.width / 2, messageLeft: m.left - c.left }
    })()`) as { rightGap: number; bubbleLeft: number; mid: number; messageLeft: number }
    expect(geometry.rightGap).toBeLessThan(40) // only the column padding separates them
    expect(geometry.bubbleLeft).toBeLessThan(geometry.mid)
    expect(browser.evaluate(`document.querySelector('[data-slot="user-bubble"] > p').textContent`)).toBe('YOU')
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
        const normal = browser.evaluate(contrastSampleExpression(link)) as ContrastSample
        browser.evaluate(`(() => {
          const target = document.querySelector(${JSON.stringify(link)})
          const scroller = document.querySelector('[data-slot="main"]')
          scroller.scrollTop += target.getBoundingClientRect().top - 180
        })()`)
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
    expect(block.synKey).toMatch(/^#[0-9a-f]{6}$/i)
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
    browser.click('[data-slot="workflow-steps"] [data-slot="collapsible-trigger"]')
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
    browser.click('[data-slot="workflow-steps"] [data-slot="collapsible-trigger"]')
  })

  it('the plan dock shows the LATEST snapshot (2/4), expanded on desktop, mirrored in the header', () => {
    expect(browser.evaluate(`document.querySelector('[data-slot="plan-dock"]').dataset.state`)).toBe('open')
    expect(browser.evaluate(`document.querySelector('[data-slot="plan-count"]').textContent`)).toBe('· 2/4')
    expect(browser.evaluate(`document.querySelector('[data-slot="plan-mirror"]').textContent`)).toBe('Plan 2/4')

    // The turn-2 snapshot won (turn 1 said 0/4 with "Read README and docs" in progress).
    const items = browser.evaluate(`[...document.querySelectorAll('[data-slot="plan-item"]')].map((el) => ({
      status: el.dataset.status,
      text: el.textContent,
    }))`) as Array<{ status: string; text: string }>
    expect(items.map((i) => i.status)).toEqual(['completed', 'completed', 'in_progress', 'pending'])
    expect(items[2]!.text).toContain('Summarize cockpit features')
    expect(items[2]!.text).toContain('in progress')

    // It sits in the dock region above the composer area, not in the thread flow.
    expect(browser.evaluate(`document.querySelector('[data-slot="thread-dock"] [data-slot="plan-dock"]') !== null`)).toBe(true)
  })

  it('collapsing the dock folds it to the odometer + the activeForm of the current item', () => {
    browser.click('[data-slot="plan-dock"] button')
    browser.waitForFunction(`document.querySelector('[data-slot="plan-dock"]').dataset.state === 'collapsed'`)
    expect(browser.count('[data-slot="plan-list"]')).toBe(0)
    expect(browser.evaluate(`document.querySelector('[data-slot="plan-current"]').textContent`)).toBe(
      '— Summarizing cockpit features',
    )
    // Re-expand so the desktop screenshot below captures the full checklist.
    browser.click('[data-slot="plan-dock"] button')
    browser.waitForFunction(`document.querySelector('[data-slot="plan-dock"]').dataset.state === 'open'`)
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
    expect(browser.evaluate(`document.querySelector('[data-slot="pill"]').textContent`)).toBe('done')
    // The #381 money shot: tool cards (one expanded) + markdown + image, desktop width.
    browser.screenshot(`${artifactsDir}/thread-desktop.png`)
  })

  it('the header meta line reads workflow · branch chip · ± · tokens · cost off the record', () => {
    const meta = browser.evaluate(
      `document.querySelector('[data-slot="run-meta"]').textContent`,
    ) as string
    expect(meta).toContain('quick-task')
    expect(meta).toContain('cez/fcd519dd')
    expect(meta).toContain('+1 −0')
    // This historical record has no input/output counters; do not guess from tokensUsed.
    expect(meta).not.toContain('3.6k tokens')
    expect(meta).toContain('$0.04')
    // The fork keeps the backend/model badge in the header.
    expect(meta).toContain('claude · auto')
    // Branch renders as the mono chip, not plain text.
    expect(
      browser.evaluate(`document.querySelector('[data-slot="branch-chip"]').textContent`),
    ).toBe('cez/fcd519dd')
  })

  it('tabs point at the routed Session/Changes/Files surfaces; the done run offers the closed-run actions', () => {
    const tabs = browser.evaluate(`[...document.querySelectorAll('[data-slot="run-tabs"] a')].map((a) => ({
      text: a.textContent,
      href: a.getAttribute('href'),
      current: a.getAttribute('aria-current'),
    }))`) as Array<{ text: string; href: string; current: string | null }>
    expect(tabs).toEqual([
      { text: 'Session', href: scoped(`/tasks/${RUN_ID}`), current: 'page' },
      { text: 'Changes', href: scoped(`/tasks/${RUN_ID}/changes`), current: null },
      { text: 'Commits', href: scoped(`/tasks/${RUN_ID}/commits`), current: null },
      { text: 'Files', href: scoped(`/tasks/${RUN_ID}/files`), current: null },
    ])

    browser.click('[aria-label="Run actions"]')
    const actions = browser.evaluate(
      `[...document.querySelectorAll('[data-slot="run-actions-menu"] [role^="menuitem"]')].map((b) => b.textContent.trim())`,
    ) as string[]
    expect(actions).toEqual(['Notes / handoff', 'Open in…', 'Copy resume command', 'Mark unread', 'Pin task', 'Archive task', 'Delete task…'])

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

  it('reflows at iPhone width with no horizontal overflow', () => {
    browser.setViewport(390, 844)
    browser.goto(`${baseUrl}${scoped(`/tasks/${RUN_ID}`)}`)
    browser.waitForFunction(`document.querySelectorAll('[data-slot="user-bubble"]').length >= 2`)
    browser.waitForFunction(`document.querySelector('[data-streamdown="code-block"]') !== null`)

    expect(browser.evaluate(`document.documentElement.scrollWidth <= window.innerWidth`)).toBe(true)
    // The wide fixture table/code scroll inside their own boxes, not the page.
    expect(
      browser.evaluate(`(() => {
        const main = document.querySelector('[data-slot="main"]')
        return main.scrollWidth <= main.clientWidth
      })()`),
    ).toBe(true)

    // Phone default: the dock collapses to the odometer (the mockup's mobile reflow).
    expect(browser.evaluate(`document.querySelector('[data-slot="plan-dock"]').dataset.state`)).toBe('collapsed')
    expect(browser.evaluate(`document.querySelector('[data-slot="plan-count"]').textContent`)).toBe('· 2/4')

    browser.screenshot(`${artifactsDir}/thread-mobile.png`)
    browser.setViewport(1440, 900)
  })

  it('mobile header: the action bar folds into the kebab next to the pill', () => {
    browser.setViewport(390, 844)
    browser.goto(`${baseUrl}${scoped(`/tasks/${RUN_ID}`)}`)
    browser.waitForFunction(`document.querySelector('[data-slot="run-header"]') !== null`)

    // The desktop action bar is gone (`md:flex`), the kebab is the mobile surface.
    expect(
      browser.evaluate(
        `document.querySelector('[data-slot="run-actions"]')`,
      ),
    ).toBe(null)
    expect(
      browser.evaluate(
        `(() => { const el = document.querySelector('[aria-label="Run actions"]'); return el !== null && el.offsetParent !== null })()`,
      ),
    ).toBe(true)
    // Title + pill still read in one compact row.
    expect(browser.isVisible('[data-route="task-thread"] h1')).toBe(true)
    expect(browser.evaluate(`document.querySelector('[data-slot="pill"]').textContent`)).toBe('done')

    browser.screenshot(`${artifactsDir}/thread-header-mobile.png`)
    browser.setViewport(1440, 900)
  })

  it('phone header keeps disclosure state while pinning and unpinning with keyboard controls', async () => {
    browser.setViewport(360, 640)
    browser.goto(`${baseUrl}${scoped(`/tasks/${RUN_ID}`)}`)
    browser.waitForFunction(`document.querySelector('[aria-label="Show run details"]') !== null`)
    expect(browser.isVisible('[data-slot="run-details"]')).toBe(false)
    browser.evaluate(`document.querySelector('[aria-label="Show run details"]').focus()`)
    browser.press('Enter')
    expect(browser.isVisible('[data-slot="run-details"]')).toBe(true)
    for (const label of ['Hide run details', 'Run actions']) {
      expect(browser.evaluate(`(() => { const r = document.querySelector('[aria-label="${label}"]').getBoundingClientRect(); return r.width >= 44 && r.height >= 44 })()`)).toBe(true)
    }
    for (const wasPinned of [false, true]) {
      browser.click('[aria-label="Run actions"]')
      browser.waitForFunction(`document.querySelector('[data-slot="run-actions-menu"] [data-slot="pin-run"]') !== null`)
      const pin = '[data-slot="run-actions-menu"] [data-slot="pin-run"]'
      browser.waitForFunction(`document.querySelector('${pin}').getBoundingClientRect().height >= 44`)
      expect(browser.evaluate(`document.querySelector('${pin}').getAttribute('aria-checked')`)).toBe(String(wasPinned))
      browser.evaluate(`document.querySelector('${pin}').focus()`)
      browser.press('Space')
      browser.waitForFunction(`document.querySelector('[data-slot="run-actions-menu"]') === null`)
      browser.click('[aria-label="Run actions"]')
      browser.waitForFunction(`document.querySelector('${pin}').getAttribute('aria-checked') === '${!wasPinned}'`)
      browser.press('Escape')
      browser.waitForFunction(`document.querySelector('[data-slot="run-actions-menu"]') === null`)
      expect(browser.isVisible('[data-slot="run-details"]')).toBe(true)
      expect(browser.evaluate(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true)
    }
    const record = await (await fetch(`${baseUrl}/api/v1/runs/${RUN_ID}`)).json()
    expect(record).not.toHaveProperty('pinned')
    expect(record).not.toHaveProperty('pinnedAt')
    browser.click('[aria-label="Hide run details"]')
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
    expect(browser.evaluate(`document.querySelector('${input}').getBoundingClientRect().height`)).toBeGreaterThan(44)
    expect(browser.isVisible('[data-slot="follow-up-engine"]')).toBe(true)
    expect(browser.evaluate(`[...document.querySelectorAll('[data-slot="follow-up-engine"] button')].every(el => {const r=el.getBoundingClientRect(); return r.width >=44 && r.height >=44})`)).toBe(true)
    browser.evaluate(`document.querySelector('[aria-label="Run actions"]').scrollIntoView({block:'center'})`)
    browser.click('[aria-label="Run actions"]')
    browser.press('Escape')
    expect(browser.evaluate(`(() => { const el = document.querySelector('${input}'); return [el === window.__phoneTextarea, el.value, el.selectionStart, el.selectionEnd] })()`))
      .toEqual([true, 'first line\nsecond line\nthird line', 2, 8])
    expect(browser.count('[data-slot="composer-thumbs"] button')).toBe(3)
    expect(browser.isVisible('[aria-label="Attach files"]')).toBe(true)
    expect(browser.isVisible('[aria-label="Send"]')).toBe(true)
    expect(browser.evaluate(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true)
    for (const label of ['Show run details', 'Run actions']) {
      expect(browser.evaluate(`(() => { const r = document.querySelector('[aria-label="${label}"]').getBoundingClientRect(); return r.width >= 44 && r.height >= 44 })()`)).toBe(true)
    }
    // At the start of the transcript, the header and bottom dock still leave reading space.
    browser.evaluate(`document.querySelector('[data-slot="main"]').scrollTop = 0`)
    const room = browser.evaluate(`(() => {
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
    expect(browser.isVisible('[data-slot="run-details"]')).toBe(true)
    expect(browser.isVisible('[data-slot="follow-up-engine"]')).toBe(true)
    expect(browser.count('[aria-label="Expand composer"]')).toBe(0)
    expect(browser.evaluate(`getComputedStyle(document.querySelector('[data-slot="run-header"]')).position`)).toBe('relative')
    browser.setViewport(360, 640)
    expect(browser.isVisible('[data-slot="follow-up-engine"]')).toBe(true)
    expect(browser.evaluate(`document.querySelector('${input}').value`)).toBe('first line\nsecond line\nthird line')
  })

  it('keeps long metadata inside a phone viewport across task tabs and run switches', () => {
    browser.setViewport(360, 640)
    browser.goto(`${baseUrl}${scoped(`/tasks/${LONG_RUN.id}`)}`)
    browser.waitForFunction(`document.querySelector('[aria-label="Show run details"]') !== null`)
    expect(browser.count('[data-slot="plan-dock"]')).toBe(0)
    browser.evaluate(`document.querySelector('[aria-label="Show run details"]').focus()`)
    browser.press('Space')
    expect(browser.evaluate(`document.querySelector('[aria-label="Hide run details"]').getAttribute('aria-expanded')`)).toBe('true')
    expect(browser.evaluate(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true)
    expect(browser.evaluate(`[...document.querySelectorAll('[data-slot="run-header"] *')].filter(el => el.getBoundingClientRect().right > innerWidth).map(el => ({slot:el.dataset.slot, text:el.textContent?.slice(0,60), width:el.getBoundingClientRect().width}))`)).toEqual([])
    for (const tab of ['changes', 'commits', 'files', '']) {
      const tabSelector = `[data-slot="run-tabs"] a[href="${scoped(`/tasks/${LONG_RUN.id}${tab ? '/' + tab : ''}`)}"]`
      browser.evaluate(`document.querySelector('${tabSelector}').scrollIntoView({block: 'start'})`)
      browser.evaluate(`document.querySelector('${tabSelector}').focus()`)
      browser.press('Enter')
      browser.waitForFunction(`document.querySelector('[data-slot="run-tabs"] a[aria-current="page"]')?.getAttribute('href') === '${scoped(`/tasks/${LONG_RUN.id}${tab ? '/' + tab : ''}`)}'`)
      browser.evaluate(`document.querySelector('[data-slot="main"]').scrollTop = 0`)
      expect(browser.isVisible('[data-slot="run-details"]')).toBe(true)
      expect(browser.isVisible('[aria-label="Run actions"]')).toBe(true)
      expect(browser.evaluate(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true)
    }
    // Navigate through the real phone drawer; a full browser.goto would reset module memory.
    for (const [id, label] of [[RUN_ID, 'Show run details'], [LONG_RUN.id, 'Hide run details']]) {
      browser.click('[aria-label="Open menu"]')
      browser.waitForFunction(`document.querySelector('[data-slot="mobile-nav-drawer"]')?.getBoundingClientRect().left >= 0`)
      browser.evaluate(`document.querySelector('[data-slot="mobile-nav-drawer"] a[href="${scoped(`/tasks/${id}`)}"]').scrollIntoView({ block: 'center' })`)
      browser.evaluate(`document.querySelector('[data-slot="mobile-nav-drawer"] a[href="${scoped(`/tasks/${id}`)}"]').focus()`)
      browser.press('Enter')
      browser.waitForFunction(`document.querySelector('[data-slot="mobile-nav-drawer"]') === null`)
      browser.waitForFunction(`document.querySelector('[data-run-id="${id}"] [aria-label="${label}"]') !== null`)
      expect(browser.isVisible('[data-slot="run-details"]')).toBe(id === LONG_RUN.id)
      expect(browser.isVisible('[data-slot="session-controls"]')).toBe(true)
    }
    expect(browser.evaluate(`(() => { const el = document.querySelector('[data-slot="follow-up-model-pill"]'); return el.scrollHeight <= el.clientHeight })()`)).toBe(true)
    expect(browser.evaluate(`(() => { const el = document.querySelector('[data-slot="main"]'); return el.scrollWidth <= el.clientWidth })()`)).toBe(true)
    browser.evaluate(`document.querySelector('[data-slot="main"]').scrollTop = 0`)
    browser.click('[data-slot="agent-badge"]')
    expect(browser.evaluate(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true)
    expect(browser.evaluate(`(() => { const r = document.querySelector('[data-slot="dropdown-menu-content"]').getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth })()`)).toBe(true)
    expect(browser.text('[data-slot="dropdown-menu-content"]')).toContain('effort: high')
    expect(browser.text('[data-slot="dropdown-menu-content"]')).toContain('account: default')
    browser.press('Escape')
    browser.waitForFunction(`document.querySelector('[data-slot="dropdown-menu-content"]') === null`)
    browser.setReducedMotion()
    expect(browser.evaluate(`matchMedia('(prefers-reduced-motion: reduce)').matches`)).toBe(true)
    expect(browser.evaluate(`getComputedStyle(document.querySelector('[aria-label="Hide run details"] svg')).transitionProperty`)).toBe('none')
    browser.click('[aria-label="Hide run details"]')
    expect(browser.evaluate(`document.querySelector('[aria-label="Show run details"]').getAttribute('aria-expanded')`)).toBe('false')
    browser.evaluate(`document.documentElement.classList.remove('light')`)
    browser.screenshot(`${artifactsDir}/phone-long-details-dark.png`, { viewport: true })
    browser.setViewport(1440, 900)
  })

})

// Revised session frames 2/3/28: settings stay visible in document flow at every width.
describe('revised session layout', () => {
  it.each([1440, 402, 360].flatMap(width => ['light', 'dark'].map(theme => ({ width, theme }))))('preserves labeled controls and draft at $width / $theme', ({ width, theme }) => {
    browser.setViewport(width, 1000)
    browser.goto(`${baseUrl}${scoped(`/tasks/${RUN_ID}`)}`)
    browser.waitForFunction(`document.querySelector('[data-slot="session-controls"]') !== null`)
    browser.evaluate(`document.documentElement.classList.toggle('light', ${theme === 'light'}); document.documentElement.dataset.width = 'wide'; delete document.documentElement.dataset.density; document.querySelector('[data-slot="composer"]').scrollIntoView({block:'end'})`)
    const facts = browser.evaluate(`(() => {
      const box = selector => document.querySelector(selector).getBoundingClientRect();
      const settings = box('[data-slot="session-controls"]'), model = box('[data-slot="session-model"]');
      return { stacked: innerWidth >= 768 ? settings.bottom <= model.top + 1 : model.bottom <= settings.top + 1, fits: model.left >= 0 && model.right <= innerWidth, overflow: document.documentElement.scrollWidth > innerWidth, position: getComputedStyle(document.querySelector('[data-slot="thread-dock"]')).position };
    })()`) as { stacked: boolean; fits: boolean; overflow: boolean; position: string }
    expect(facts).toEqual({ stacked: true, fits: true, overflow: false, position: 'relative' })
    expect(browser.evaluate(`document.querySelector('[data-slot="follow-up-model-pill"]').getBoundingClientRect().height`)).toBeGreaterThanOrEqual(44)
    browser.fill('[data-slot="composer"] textarea', 'Keep these follow-up instructions')
    expect(browser.text('[data-slot="composer-submit-row"]')).toContain('Send')
    browser.evaluate('new Promise(resolve => setTimeout(resolve, 250))')
    browser.screenshot(`${artifactsDir}/revised-session-${width}-${theme}.png`, { viewport: true })
    browser.evaluate(`document.querySelector('[data-slot="main"]').scrollTop = 0`)
    browser.click('[aria-label="Run actions"]')
    browser.waitForFunction(`document.querySelector('[data-slot="run-actions-menu"]') !== null`)
    expect(browser.text('[data-slot="run-actions-menu"]')).toContain('Notes')
    browser.screenshot(`${artifactsDir}/revised-session-actions-${width}-${theme}.png`, { viewport: true })
    browser.press('Escape')
    expect(browser.evaluate(`document.querySelector('[data-slot="composer"] textarea').value`)).toBe('Keep these follow-up instructions')
  }, 90_000)
})
