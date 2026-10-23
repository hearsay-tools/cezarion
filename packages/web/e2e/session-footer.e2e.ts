import type { ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'

import { AgentBrowser, bootProjectId, cezarCli, fixtureServeEnv } from './agent-browser'
import { spawnFixtureServer, stopFixtureServer, waitForFixtureServer } from './fixture-server'
import { largeThreadEvents } from './fixtures/make-large-thread'
import record from './fixtures/thread-run.record.json'
import { seedTranscript } from './seed-transcript'
import { openSessionActivityRow } from './session-activity'
import { waitForSettledSample } from './visual-ready'
// fixture-server starts: 1

const runId = 'aaaaaaaa-1111-4222-8333-bbbbbbbbcccc'
const shortId = 'aaaaaaaa-1111-4222-8333-bbbbbbbbdddd'
const artifacts = resolve(import.meta.dirname, '../../../.ai/qa/artifacts_e2e')
let dataRoot: string
let server: ChildProcess
let browser: AgentBrowser
let baseUrl: string
let project: string

beforeAll(async () => {
  dataRoot = mkdtempSync(join(tmpdir(), 'cezar-session-footer-'))
  mkdirSync(join(dataRoot, '.ai/cezar/runs'), { recursive: true })
  writeFileSync(join(dataRoot, '.ai/cezar/runs.json'), JSON.stringify([runId, shortId].map(id => ({
    ...record, id, steps: [record.steps[0]], pullRequestUrl: undefined,
  }))))
  seedTranscript(join(dataRoot, '.ai/cezar/runs', `${runId}.ndjson`), largeThreadEvents(60).map(event => JSON.stringify(event)).join('\n') + '\n')
  server = spawnFixtureServer([cezarCli, 'serve', '--repo', dataRoot, '--port', '0', '--no-open'], {
    env: fixtureServeEnv(dataRoot), stdio: 'pipe',
  })
  baseUrl = await waitForFixtureServer(server)
  project = await bootProjectId(baseUrl)
  browser = AgentBrowser.open(`session-footer-${process.pid}`)
  mkdirSync(artifacts, { recursive: true })
}, 120_000)

afterAll(async () => {
  browser?.close()
  await stopFixtureServer(server)
  if (dataRoot) rmSync(dataRoot, { recursive: true, force: true })
})

const geometry = `(() => {
  const main = document.querySelector('[data-slot="main"]');
  const rect = slot => document.querySelector('[data-slot="' + slot + '"]').getBoundingClientRect();
  const dock = rect('thread-dock'), activity = rect('run-activity-dock'), composer = rect('composer-editor');
  const header = rect('run-header'), viewport = main.getBoundingClientRect();
  const jump = document.querySelector('[data-slot="jump-to-latest"]');
  const jumpBox = jump?.getBoundingClientRect();
  return {
    footerVisible: activity.top >= header.bottom - 1 && composer.bottom <= viewport.bottom + 1,
    footerAtBottom: Math.abs(dock.bottom - viewport.bottom) < 2,
    jumpClear: !jumpBox || (jumpBox.bottom <= dock.top && jump.contains(document.elementFromPoint(jumpBox.x + jumpBox.width / 2, jumpBox.y + jumpBox.height / 2))),
    overflow: main.scrollWidth > main.clientWidth,
    draft: document.querySelector('textarea').value,
  };
})()`

it.each([
  ['flat', 'light', 1440, 900], ['virtual', 'dark', 1440, 900],
  ['flat', 'dark', 1024, 768], ['virtual', 'light', 1024, 768],
] as const)('%s %s at %s×%s keeps the desktop footer visible while reading history', (mode, theme, width, height) => {
  browser.setViewport(width, height)
  browser.goto(`${baseUrl}/p/${project}/tasks/${runId}?thread=${mode}`)
  browser.waitForFunction(`document.querySelector('[data-slot="thread-rows"]') !== null`)
  browser.evaluate(`document.documentElement.classList.toggle('light', ${theme === 'light'})`)
  browser.fill('textarea', 'Keep this draft while reading history')
  for (const position of ['0', '(main.scrollHeight - main.clientHeight) / 2']) {
    browser.evaluate(`(() => {
      const main = document.querySelector('[data-slot="main"]');
      main.dispatchEvent(new WheelEvent('wheel', { deltaY: -1800, bubbles: true }));
      main.scrollTop = ${position};
    })()`)
    browser.waitForFunction(`document.querySelector('[data-slot="jump-to-latest"]') !== null`)
    expect(waitForSettledSample(browser, geometry)).toEqual({
      footerVisible: true, footerAtBottom: true, jumpClear: true, overflow: false,
      draft: 'Keep this draft while reading history',
    })
  }
  browser.screenshot(join(artifacts, `session-footer-${mode}-${theme}-${width}.png`), { viewport: true })
  browser.click('[data-slot="jump-to-latest"]')
  browser.waitForFunction(`document.querySelector('[data-slot="jump-to-latest"]') === null`)
  // Jump refreshes paged history and can remount the Composer. Draft persistence across
  // remounts is separate work (hearsay-tools/cezarion#1009); scrolling above retains it.
  expect(waitForSettledSample(browser, geometry)).toMatchObject({
    footerVisible: true, footerAtBottom: true, jumpClear: true, overflow: false,
  })
}, 90_000)

it('keeps a short desktop session footer at the bottom', () => {
  browser.setViewport(1440, 900)
  browser.goto(`${baseUrl}/p/${project}/tasks/${shortId}`)
  browser.waitForFunction(`document.querySelector('[data-slot="thread-dock"]') !== null`)
  expect(waitForSettledSample<{ footerVisible: boolean; footerAtBottom: boolean }>(browser, geometry)).toMatchObject({
    footerVisible: true, footerAtBottom: true,
  })
})

it('keeps expanded activity and a long draft accessible on a short desktop viewport', () => {
  browser.setViewport(768, 640)
  browser.goto(`${baseUrl}/p/${project}/tasks/${runId}`)
  openSessionActivityRow(browser, 'usage')
  browser.fill('textarea', Array.from({ length: 20 }, (_, index) => `Draft line ${index}`).join('\n'))
  expect(waitForSettledSample(browser, geometry)).toMatchObject({
    footerVisible: true, footerAtBottom: true, overflow: false,
  })
  const details = waitForSettledSample(browser, `(() => {
    const activity = document.querySelector('[data-slot="run-activity-dock"]');
    activity.scrollTop = activity.scrollHeight;
    return { scrollable: activity.scrollHeight > activity.clientHeight, reachedEnd: activity.scrollTop + activity.clientHeight >= activity.scrollHeight - 1 };
  })()`)
  expect(details).toEqual({ scrollable: true, reachedEnd: true })
})

it('keeps the Composer controls visible with attachments in a 480px-high desktop window', () => {
  browser.setViewport(1440, 900)
  browser.goto(`${baseUrl}/p/${project}/tasks/${runId}`)
  openSessionActivityRow(browser, 'usage')
  browser.setViewport(1024, 480)
  browser.fill('textarea', Array.from({ length: 20 }, (_, index) => `Draft line ${index}`).join('\n'))
  browser.evaluate(`(() => {
    const files = new DataTransfer();
    for (let index = 0; index < 4; index++) files.items.add(new File(['notes'], 'notes-' + index + '.txt', { type: 'text/plain' }));
    document.querySelector('textarea').dispatchEvent(new ClipboardEvent('paste', { bubbles: true, clipboardData: files }));
  })()`)
  browser.waitForFunction(`document.querySelectorAll('[data-slot="composer-thumbs"] button').length === 4`)
  expect(waitForSettledSample(browser, geometry)).toMatchObject({ footerVisible: true, footerAtBottom: true, overflow: false })
  expect(waitForSettledSample(browser, `(() => {
    const input = document.querySelector('textarea');
    const submit = document.querySelector('[data-slot="composer-actions"] button:last-child');
    const box = submit.getBoundingClientRect();
    return { inputVisible: input.clientHeight >= 44, draftScrolls: input.scrollHeight > input.clientHeight,
      submitVisible: submit.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)) };
  })()`)).toEqual({ inputVisible: true, draftScrolls: true, submitVisible: true })
})

it('scrolls a keyboard-focused transcript control above the desktop footer', () => {
  browser.setViewport(1440, 900)
  browser.goto(`${baseUrl}/p/${project}/tasks/${runId}?thread=flat`)
  const target = '[data-slot="tool-card"][data-kind="execute"] > button'
  browser.waitForFunction(`document.querySelector('${target}') !== null`)
  // Finish paging before selecting and covering the keyboard target. Evidence for
  // hearsay-tools/cezarion#1510: CPU15/two-loop old-test diagnosis failed 1/1 with
  // focused:true/clear:false/hit:false: page 2 arrived after Tab and moved the focused
  // button to y=8419.14. Bundle:
  // .ai/qa/failures/before.test.ts/scrolls-a-keyboard-focused-transcript-control-above-the-desktop-footer-1.
  // Repro: LOOPS=2 RUNS=1 LABEL=old-1 timeout --kill-after=5s 120s taskset -c 15
  // bash .ai/qa/1510-proof/run-loaded.sh. Matched scratch proof: old failed 1/1,
  // fixed passed 1/1; final targeted acceptance passed 10/10 with the same CPU/load.
  // This proves the paging/layout variant; the historical focused:false cause is unproved.
  browser.evaluate(`document.querySelector('[data-slot="history-boundary"] button').click()`)
  browser.waitForFunction(`document.querySelector('[data-slot="history-boundary"]')?.dataset.retainedPages === '2' &&
    document.querySelector('[data-slot="history-boundary"]')?.getAttribute('aria-busy') === 'false' && window.__cezIdle === true`)
  browser.waitForValue(`(() => {
    const button = document.querySelector('${target}');
    const rendered = button.checkVisibility({ contentVisibilityAuto: true });
    button.scrollIntoView({ block: 'center' });
    return rendered;
  })()`, rendered => rendered === true)
  browser.evaluate(`(() => {
    const main = document.querySelector('[data-slot="main"]');
    const button = document.querySelector('${target}');
    button.scrollIntoView({ block: 'center' });
    main.scrollTop += button.getBoundingClientRect().top - document.querySelector('[data-slot="thread-dock"]').getBoundingClientRect().top - 20;
    // Set the sequential keyboard start immediately before the target, without scrolling
    // either control into view. The actual Tab must reveal the covered transcript control.
    const start = document.createElement('span');
    start.id = 'footer-focus-start'; start.tabIndex = -1;
    button.before(start); start.focus({ preventScroll: true });
    // Retain the node rather than re-querying after a prepend. The earlier repair in
    // hearsay-tools/cezarion#1495 fixed that separate selector race: 4/4 keyboard-focused
    // runs failed before retention and 2/2 passed after it (PR's session-footer bundle).
    window.__footerFocusTarget = button;
  })()`)
  browser.waitForFunction(`document.activeElement === document.getElementById('footer-focus-start') && window.__footerFocusTarget.isConnected`)
  browser.press('Tab')
  browser.evaluate(`document.getElementById('footer-focus-start').remove()`)
  expect(waitForSettledSample<{ focused: boolean; clear: boolean; hit: boolean }>(browser, `(() => {
    const button = window.__footerFocusTarget, box = button.getBoundingClientRect();
    const header = document.querySelector('[data-slot="run-header"]').getBoundingClientRect();
    const footer = document.querySelector('[data-slot="thread-dock"]').getBoundingClientRect();
    return { focused: document.activeElement === button, clear: box.top >= header.bottom && box.bottom <= footer.top,
      hit: button.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)) };
  })()`, sample => sample.focused && sample.clear && sample.hit)).toEqual({ focused: true, clear: true, hit: true })
})
