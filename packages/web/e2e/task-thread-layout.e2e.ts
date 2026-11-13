import type { ChildProcess } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { visibilitySampleExpression, waitForSettledSample } from './visual-ready'
import { expectEditorFitsViewport } from './session-layout'
import { spawnFixtureServer, stopFixtureServer, waitForFixtureServer } from './fixture-server'
import { openSessionActivityRow, SESSION_ACTIVITY_SUMMARY } from './session-activity'
import { AgentBrowser, bootProjectId, squawkCli, fixtureServeEnv } from './agent-browser'
import { contrastSampleExpression, focusWithKeyboard, type ContrastSample } from './contrast'
import { artifactsDir, LONG_RUN, RUN, RUN_ID, seedThreadDataRoot, STEP_RUN, TYPO_RUNS } from './task-thread-fixture'
// fixture-server starts: 1

/**
 * The task thread's responsive layout in a real browser, against a real cezar: phone reflow, the
 * mobile header, drafts across viewport changes, long metadata, the Session activity card at every
 * width, the responsive session composer and the follow-up pills (hearsay-tools/cezarion#522).
 *
 * The runs and their transcripts come from `task-thread-fixture.ts`. This spec owns its own
 * server, browser session and cleanup, so it passes alone and in any order.
 */

const sessionId = `e2e-thread-layout-${process.pid}`

let browser: AgentBrowser
let server: ChildProcess
let dataRoot: string
let baseUrl: string
let bootProject: string

/** A flat route target under this server's own project prefix (multi-project spec, step 3.2):
 *  every cockpit link is scoped, and every legacy flat URL redirects onto its scoped twin. */
const scoped = (path: string) => `/p/${bootProject}${path}`

beforeAll(async () => {
  dataRoot = seedThreadDataRoot('cezar-e2e-thread-layout-', [RUN, LONG_RUN, ...TYPO_RUNS, STEP_RUN])
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

    browser.screenshot(`${artifactsDir}/thread-mobile.png`)
    browser.setViewport(1440, 900)
  })

  it('mobile header: the action bar folds into the kebab in the top bar, beside the title', () => {
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
    // own title row below md, so there is no h1 or pill left in it.
    const bar = waitForSettledSample(browser, `(() => {
      const top = document.querySelector('[data-slot="mobile-top-bar"]')
      const kebab = top?.querySelector('[aria-label="Run actions"]')
      const title = top?.querySelector('[data-slot="mobile-run-title"]')
      if (!kebab || !title) return null
      return { kebab: kebab.offsetParent !== null,
        h1: document.querySelector('[data-route="task-thread"] h1') !== null, pill: document.querySelector('[data-slot="run-header"] [data-slot="pill"]') !== null }
    })()`) as { kebab: boolean; h1: boolean; pill: boolean }
    expect(bar).toEqual({ kebab: true, h1: false, pill: false })

    // #737: the title fits the bar, the 44px rename target is a sibling of the title (so it can
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
      const res = { stackFits: s.t >= t.t && s.b <= t.b, titleVisible: h.w > 0 && h.h > 0 }
      if (rename) { const r = box(rename); res.renameHit = hit(rename); res.renameClearOfStack = apart(r, s) }
      if (input) { const i = box(input); res.input = { h: Math.round(i.h), belowBar: i.t >= t.b, clearOfTitle: apart(i, h), hitsOk: i.h >= 44, topmost: document.elementFromPoint(i.l + i.w / 2, i.t + i.h / 2) === input } }
      return res
    })()`
    type Probe = { stackFits: boolean; titleVisible: boolean
      renameHit?: boolean; renameClearOfStack?: boolean
      input?: { h: number; belowBar: boolean; clearOfTitle: boolean; hitsOk: boolean; topmost: boolean } }
    const resting = browser.waitForValue(probe, (v) => (v as Probe | null)?.renameHit !== undefined) as Probe
    expect(resting).toMatchObject({ stackFits: true, titleVisible: true, renameHit: true, renameClearOfStack: true })
    browser.click('[data-slot="mobile-top-bar"] [aria-label="Rename task"]')
    // The popover animates in (zoom/slide): sample only once the geometry has held still.
    const editing = browser.waitForStable<Probe | null>(probe, { holdMs: 400, matcher: (v) => v?.input !== undefined }) as Probe
    expect(editing).toMatchObject({ stackFits: true, titleVisible: true, input: { belowBar: true, clearOfTitle: true, hitsOk: true, topmost: true } })
    browser.press('Escape')
    browser.waitForFunction(`document.querySelector('[data-slot="title-input"]') === null`)

    browser.screenshot(`${artifactsDir}/thread-header-mobile.png`)
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
    const kept = browser.waitForValue(`document.querySelector('[data-slot="run-actions-menu"]') === null
      ? (() => { const el = document.querySelector('${input}'); return [el === window.__phoneTextarea, el.value, el.selectionStart, el.selectionEnd] })()
      : null`)
    expect(kept).toEqual([true, 'first line\nsecond line\nthird line', 2, 8])
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
    browser.evaluate(`(() => { const main = document.querySelector('[data-slot="main"]'); main.scrollTop = main.scrollHeight })()`)
    const headerInMain = waitForSettledSample(browser, `(() => {
      const header = document.querySelector('[data-slot="run-header"]').getBoundingClientRect();
      const main = document.querySelector('[data-slot="main"]').getBoundingClientRect();
      return { top: header.top >= main.top - 1, bottom: header.bottom <= main.bottom + 1 };
    })()`)
    expect(headerInMain).toEqual({ top: true, bottom: true })
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
  // again on every frame, so main CI's touch-targets 360px cell never settled. Every card width
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
          color: getComputedStyle(name).color, label: summary.getAttribute('aria-label'),
          statusTruncated: (() => { const l = summary.querySelector('[data-slot="run-activity-status-label"]'); return l.scrollWidth > l.clientWidth + 1 })() }
      })()`
      type Folded = { overflow: number; visual: string; glyphWhole: boolean; nameInside: boolean; nameWidth: number; truncated: boolean; ellipsis: string; color: string; label: string; statusTruncated: boolean }
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
    archiveLabel: archive.getAttribute('aria-label'), archiveVisibleText: [...archive.querySelectorAll('span')].filter(span => { const r = span.getBoundingClientRect(); return r.width > 1 && r.height > 1 }).map(span => span.textContent).join('').trim(),
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
    expect(facts.archiveVisibleText).toBe('')
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
      expect(facts.archiveVisibleText).toContain('Archive task')
    } else {
      expect(Math.abs(runner.top - effort.top)).toBeLessThanOrEqual(2)
      expect(model.top).toBeGreaterThanOrEqual(Math.max(runner.bottom, effort.bottom) - 1)
      expect(facts.modelTruncated).toBe(true)
      expect(facts.archiveVisibleText).toBe('')
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

it.each(TYPO_RUNS.flatMap(run => [360, 906, 1280].map(width => ({ run, width }))))(
  'offers $run.model its available follow-up width at $width px (hearsay-tools/cezarion#522)', ({ run, width }) => {
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
