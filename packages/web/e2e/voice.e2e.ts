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

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'cez-voice-'))
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { stdio: 'ignore' })
  git('init', '-q', '-b', 'main')
  git('-c', 'user.name=E2E', '-c', 'user.email=e2e@example.test', 'commit', '--allow-empty', '-m', 'fixture')
  server = spawnFixtureServer([cezarCli, 'serve', '--repo', root, '--port', '0', '--no-open'], {
    env: fixtureServeEnv(root, { CEZ_VOICE: '1' }),
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
