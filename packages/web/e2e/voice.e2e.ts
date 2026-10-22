import { execFileSync, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { AgentBrowser, bootProjectId, cezarCli, fixtureServeEnv, readTestEnv } from './agent-browser'
import { spawnFixtureServer, stopFixtureServer, waitForFixtureServer } from './fixture-server'
import { waitForStatus } from './poll'
// fixture-server starts: 1

/**
 * Voice mode (spec 2026-10-21-voice-mode) end to end, typed instead of spoken: the palette's voice
 * rows are the same path a transcript takes. The fixture server runs with `CEZ_VOICE=1` and the
 * dry-run env that `fixtureServeEnv` sets, so the capability is on without a key and the
 * deterministic fake engine answers (see `packages/cezar/src/voice/fake-engine.ts` for the
 * sentences it reads). `mock:multi-ask` parks a run on a two-question card.
 */

const ROW = '[data-slot="voice-row"]'
const INPUT = '[cmdk-input]'
const CARD_OPEN = '[data-slot="ask-card"][data-resolved="false"]'
const FILLED = '[data-voice-filled="true"]'
const PALETTE_SENTENCE_ANSWER = 'answer Vitest to question first and the second answer to question second'

let root: string
let base: string
let project: string
let server: ChildProcess
let browser: AgentBrowser

const sentences = (selector: string) => `document.querySelectorAll('${selector}').length`

async function createTask(task: string): Promise<string> {
  const response = await fetch(`${base}/api/v1/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ task, workflow: 'quick-task' }),
  })
  const { id } = (await response.json()) as { id: string }
  await waitForStatus(base, id, ['waiting'])
  return id
}

/** A task parked on the two-question card, opened in the browser with the card on screen. */
async function openAskTask(): Promise<void> {
  const id = await createTask('mock:multi-ask')
  browser.goto(`${base}/p/${project}/tasks/${id}`)
  browser.waitForFunction(`document.querySelector('${CARD_OPEN}') !== null`)
}

/** ⌘K, then the sentence. Waits for the palette to own focus, and for a voice row to answer. */
function sayInPalette(sentence: string): void {
  browser.press('Control+k')
  browser.waitForFunction(`document.activeElement?.hasAttribute('cmdk-input') === true`)
  browser.fill(INPUT, sentence)
  browser.waitForFunction(`document.querySelector('${ROW}') !== null`)
}

/** Records every request the page makes to a `/voice/` route. `voiceDecide` reaches the network
 *  through `fetchOrThrow` -> the global `fetch`, resolved per call, so wrapping `window.fetch`
 *  sees it. Installed after navigation (a load drops it) and before the sentence is typed. */
const INSTALL_VOICE_RECORDER = `(() => {
  window.__voiceCalls = []
  const original = window.fetch
  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url.includes('/voice/')) window.__voiceCalls.push(url)
    return original.call(window, input, init)
  }
  return true
})()`

/** What the page did about the sentence: voice requests made, voice rows shown, and whether the
 *  palette's own "Nothing matches." answer is on screen. */
const VOICE_ACTIVITY = `({
  calls: window.__voiceCalls.length,
  decides: window.__voiceCalls.filter((url) => url.includes('/voice/decide')).length,
  rows: document.querySelectorAll('${ROW}').length,
  empty: document.body.textContent.includes('Nothing matches.'),
})`

interface VoiceActivity { calls: number; decides: number; rows: number; empty: boolean }

/** Opens the task list of `server`, installs the recorder, opens ⌘K and types `sentence`. */
function typeWithRecorder(server: string, projectId: string, sentence: string): void {
  browser.goto(`${server}/p/${projectId}/`)
  browser.waitForFunction(`document.querySelector('[data-slot="sidebar"]') !== null`)
  browser.evaluate(INSTALL_VOICE_RECORDER)
  browser.press('Control+k')
  browser.waitForFunction(`document.activeElement?.hasAttribute('cmdk-input') === true`)
  browser.fill(INPUT, sentence)
  browser.waitForFunction(`document.querySelector('${INPUT}').value === '${sentence}'`)
}

/** The voice-off guard: after the palette has answered the sentence, no voice request and no voice
 *  row appears for a window longer than the preview debounce. */
function expectNoVoiceActivity(): void {
  browser.waitForFunction(`document.body.textContent.includes('Nothing matches.')`)
  // bound: with voice off nothing observable happens, so there is no completion signal to wait on
  // and absence needs a real-time window. 1500 ms outlasts VOICE_PREVIEW_DEBOUNCE_MS (300 ms, in
  // components/voice/use-voice-command.ts) plus the request start; a slower host can only make
  // this pass falsely, never fail falsely.
  browser.waitForStable<VoiceActivity>(VOICE_ACTIVITY, {
    holdMs: 1500,
    matcher: (activity) => activity.calls === 0 && activity.rows === 0 && activity.empty,
  })
}

/** What a docked palette leaves of the proposal's targets: whether the palette input has focus,
 *  and for each target the part of it really on screen (its box clipped by every scrolling or
 *  clipping ancestor and by the window), whether that is the whole box, and which points sampled
 *  across that part land inside the palette. The docked overlay is transparent and is not the
 *  palette; a point counts as covered when `elementFromPoint` lands inside its dialog content. */
const dockProbe = (selector: string) => `(() => {
  const dialog = document.querySelector('[data-slot="dialog-content"]')
  const box = (r) => ({ top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right) })
  const targets = [...document.querySelectorAll('${selector}')].map((el) => {
    const r = el.getBoundingClientRect()
    let top = Math.max(r.top, 0), bottom = Math.min(r.bottom, innerHeight)
    let left = Math.max(r.left, 0), right = Math.min(r.right, innerWidth)
    for (let p = el.parentElement; p; p = p.parentElement) {
      const style = getComputedStyle(p)
      if (!/auto|scroll|hidden|clip/.test(style.overflowX + style.overflowY)) continue
      const q = p.getBoundingClientRect()
      top = Math.max(top, q.top); bottom = Math.min(bottom, q.bottom); left = Math.max(left, q.left); right = Math.min(right, q.right)
    }
    const shown = bottom > top && right > left
    const whole = shown && top <= r.top + 0.5 && bottom >= r.bottom - 0.5 && left <= r.left + 0.5 && right >= r.right - 0.5
    const covered = []
    if (shown) for (const fx of [0.05, 0.5, 0.95]) for (const fy of [0.05, 0.5, 0.95]) {
      const x = left + (right - left) * fx
      const y = top + (bottom - top) * fy
      if (dialog?.contains(document.elementFromPoint(x, y))) covered.push([Math.round(x), Math.round(y)])
    }
    return { box: box(r), shown, whole, covered }
  })
  return {
    focused: document.activeElement?.hasAttribute('cmdk-input') === true,
    docked: dialog?.getAttribute('data-voice-proposal') === 'true',
    palette: dialog ? box(dialog.getBoundingClientRect()) : null,
    viewport: [innerWidth, innerHeight],
    targets,
  }
})()`

interface DockTarget { box: object; shown: boolean; whole: boolean; covered: number[][] }
interface DockReport { focused: boolean; docked: boolean; palette: object | null; viewport: [number, number]; targets: DockTarget[] }

/** The docked palette keeps its input focused and covers no part of the target that is on screen,
 *  at the default viewport and at a short one (spec "Confirmation": the confirm field has focus
 *  while the highlighted card is visible; ruling R23). `whole` asks for the whole target on screen:
 *  a prompt line fits; a tall card may be partly scrolled out of its thread at any height. */
function expectTargetUncovered(selector: string, { whole }: { whole: boolean }): void {
  const check = (size: string) =>
    // bound: holdMs spans a few polls so the dialog's open animation and the resize have settled;
    // the matcher is the product state itself, polled until it holds.
    browser.waitForStable<DockReport>(dockProbe(selector), {
      holdMs: 300,
      matcher: (report) =>
        report.focused && report.docked && report.targets.length === 1 &&
        report.targets.every((target) => target.shown && (!whole || target.whole) && target.covered.length === 0),
      failure: `the docked palette covers or hides ${selector}, or the input lost focus, at ${size}`,
    })
  check('1440x900')
  browser.setViewport(1280, 640)
  try {
    check('1280x640')
  } finally {
    browser.setViewport(1440, 900)
  }
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'cez-voice-'))
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { stdio: 'ignore' })
  git('init', '-q', '-b', 'main')
  git('-c', 'user.name=E2E', '-c', 'user.email=e2e@example.test', 'commit', '--allow-empty', '-m', 'fixture')
  server = spawnFixtureServer([cezarCli, 'serve', '--repo', root, '--port', '0', '--no-open'], {
    // A plain nudge reply keeps the no-wait nudge from parking a plain reply on its own "Next step"
    // card: the tell test needs a task with no question card (hearsay-tools/cezarion#1463).
    env: fixtureServeEnv(root, { CEZ_VOICE: '1', CEZ_MOCK_NUDGE_REPLY: 'plain' }),
    stdio: 'ignore',
  })
  base = await waitForFixtureServer(server)
  project = await bootProjectId(base)
  browser = AgentBrowser.open(`e2e-voice-${process.pid}`)
  browser.setViewport(1440, 900)
}, 60_000)

afterAll(async () => {
  browser?.close()
  await stopFixtureServer(server)
  if (root) rmSync(root, { recursive: true, force: true })
})

describe('voice mode with the dry-run engine', () => {
  it('opens the first task that needs you', async () => {
    const id = await createTask('mock:multi-ask')
    browser.goto(`${base}/p/${project}/`)
    // The sidebar lists the run once the runs query has answered; the sentence resolves against it.
    browser.waitForFunction(`document.querySelector('[data-run-id="${id}"]') !== null`)

    sayInPalette('open first needs you')
    browser.press('Enter')
    browser.waitForFunction(`location.pathname.includes('${id}')`)
  }, 90_000)

  it('answers both questions, then confirms', async () => {
    await openAskTask()

    sayInPalette(PALETTE_SENTENCE_ANSWER)
    browser.press('Enter')
    browser.waitForFunction(`${sentences(FILLED)} === 2`)
    browser.waitForFunction(`document.querySelector('[data-slot="ask-voice-prompt"]') !== null`)
    expectTargetUncovered('[data-slot="ask-card"][data-voice-proposal="true"]', { whole: false })
    expectTargetUncovered('[data-slot="ask-voice-prompt"]', { whole: true })

    browser.fill(INPUT, 'yes, confirmed')
    browser.waitForFunction(`document.querySelector('${ROW}') !== null`)
    browser.press('Enter')
    const resolved = browser.waitForValue<string>(
      `document.querySelector('[data-slot="ask-card"][data-resolved="true"]')?.textContent ?? null`,
      (text) => typeof text === 'string' && text.includes('Library: Vitest') && text.includes('Build: Webpack'),
    )
    expect(resolved).toContain('Library: Vitest')
    expect(resolved).toContain('Build: Webpack')
  }, 90_000)

  it('refuses to confirm an incomplete card', async () => {
    await openAskTask()

    sayInPalette('answer Vitest to question first')
    browser.press('Enter')
    browser.waitForFunction(`${sentences(FILLED)} === 1`)

    // The input is empty after the commit, so this Return is the confirmation.
    browser.press('Enter')
    browser.waitForFunction(`document.body.textContent.includes('Question 2 (Build) still needs an answer.')`)
  }, 90_000)

  it('answers "answer that …" without the command words (hearsay-tools/cezarion#1463)', async () => {
    await openAskTask()

    sayInPalette('answer that Vitest to question first')
    browser.press('Enter')
    browser.waitForFunction(`${sentences(FILLED)} === 1`)
    // The filled question holds the chosen chip, and no Other text carries the command words.
    const filled = browser.waitForValue<{ pressed: string[]; typed: string[] } | null>(
      `(() => {
        const group = document.querySelector('${FILLED}')
        if (!group) return null
        return {
          pressed: [...group.querySelectorAll('[aria-pressed="true"]')].map((el) => el.textContent.trim()),
          typed: [...group.querySelectorAll('input, textarea')].map((el) => el.value),
        }
      })()`,
      (value) => value !== null && value.pressed.length > 0,
    )
    expect(filled?.pressed).toEqual(['Vitest'])
    expect(filled?.typed.join(' ')).not.toContain('answer that')
  }, 90_000)

  it('cancel restores the card', async () => {
    await openAskTask()

    sayInPalette(PALETTE_SENTENCE_ANSWER)
    browser.press('Enter')
    browser.waitForFunction(`${sentences(FILLED)} === 2`)

    browser.press('Escape')
    browser.waitForFunction(`${sentences('[data-voice-filled]')} === 0`)
    browser.waitForFunction(`document.querySelector('${CARD_OPEN}') !== null`)
  }, 90_000)

  it('tell it fills and sends a message', async () => {
    // A plain reply parks the run `waiting` with the composer open and no question card.
    const id = await createTask('Say hello to the voice e2e.')
    browser.goto(`${base}/p/${project}/tasks/${id}`)
    browser.waitForFunction(`document.querySelector('[data-slot="composer"] textarea') !== null`)

    sayInPalette('tell it: run the tests again')
    browser.press('Enter')
    browser.waitForFunction(`document.querySelector('[data-slot="composer"][data-voice-proposal="true"]') !== null`)
    browser.waitForFunction(`document.querySelector('[data-slot="composer-voice-prompt"]') !== null`)
    expectTargetUncovered('[data-slot="composer-voice-prompt"]', { whole: true })

    browser.fill(INPUT, 'yes, confirmed')
    browser.waitForFunction(`document.querySelector('${ROW}') !== null`)
    browser.press('Enter')
    browser.waitForFunction(
      `[...document.querySelectorAll('[data-role="user"]')].some((message) => message.textContent.includes('run the tests again'))`,
    )
  }, 90_000)

  it('the absence check sees voice work when voice is on', () => {
    // Same steps as the voice-off guard. If its window could not see a voice request or a voice
    // row, the guard would pass on a regression; here both must show.
    typeWithRecorder(base, project, 'open next finished')
    browser.waitForValue<VoiceActivity>(VOICE_ACTIVITY, (activity) => activity.decides >= 1)
    browser.waitForFunction(`document.querySelector('${ROW}') !== null`)
  }, 90_000)
})

describe('voice mode on the shared environment', () => {
  it('voice is absent by default', async () => {
    const shared = readTestEnv().baseUrl
    const health = (await fetch(`${shared}/api/v1/health`).then((response) => response.json())) as {
      capabilities: { voice?: boolean }
    }
    // The precondition is the thing under test. `.ai/scripts/test-env-up.sh` scrubs CEZ_*, so the
    // shared environment has voice off unless voice became default-on, the regression this guards.
    expect(
      health.capabilities.voice,
      'the shared environment must run with voice off (no CEZ_VOICE); voice is on by default, which is the regression this test catches',
    ).toBe(false)
    const sharedProject = await bootProjectId(shared)

    typeWithRecorder(shared, sharedProject, 'open next finished')
    expectNoVoiceActivity()
  }, 60_000)
})
