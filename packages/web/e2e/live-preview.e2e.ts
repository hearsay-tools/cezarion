import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { AgentBrowser, bootProjectId, cezarCli, fixtureServeEnv, readTestEnv } from './agent-browser'
import { stopFixtureServer } from './fixture-server'
import { waitForHealth } from './poll'

/**
 * Live preview, end to end (#781): the dry-run mock agent registers a dev server through the
 * real `cezar_preview_serve` tool, the owner runs it from the thread card, the task's own
 * Chromium streams it onto the canvas, a click on the canvas changes the page, and Stop ends it.
 *
 * The spec boots its own server because the feature is off by default (`CEZ_PREVIEW=1`). The
 * cezar-side Chromium is whatever `resolveChromium` finds; `CEZ_PREVIEW_NO_SANDBOX=1` is added
 * only when the cockpit's own browser needed `--no-sandbox` (a container), the one case the
 * spec shares a cause with.
 */

const sessionId = `e2e-live-preview-${process.pid}`
const artifactsDir = resolve(import.meta.dirname, '../../../.ai/qa/artifacts_e2e/live-preview')
const fixtureApp = resolve(import.meta.dirname, 'fixtures/preview-app.mjs')
/** The fixture button in page pixels (see fixtures/preview-app.mjs): its centre is where the spec
 *  clicks, a point in its plain padding (no label glyphs) is where it reads colour. */
const BUTTON = { x: 140, y: 140 }
const BUTTON_FILL = { x: 60, y: 110 }

const card = '[data-slot="preview-server-card"]'
const address = 'input[aria-label="Page address"]'
const canvas = '[data-slot="preview-surface"] canvas'

function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const probe = createServer()
    probe.once('error', fail)
    probe.listen(0, '127.0.0.1', () => {
      const bound = probe.address()
      const port = typeof bound === 'object' && bound ? bound.port : 0
      probe.close(() => done(port))
    })
  })
}

let browser: AgentBrowser
let server: ChildProcess
let dataRoot: string
let baseUrl: string
let appPort: number
let runId: string
let taskUrl: string

beforeAll(async () => {
  dataRoot = mkdtempSync(join(tmpdir(), 'cezar-e2e-preview-'))
  mkdirSync(artifactsDir, { recursive: true })
  const git = (...args: string[]) => execFileSync('git', ['-C', dataRoot, ...args])
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'e2e@cezar.test')
  git('config', 'user.name', 'cezar e2e')
  writeFileSync(join(dataRoot, 'README.md'), '# live preview e2e fixture repo\n', 'utf8')
  git('add', '.')
  git('commit', '-qm', 'init')

  appPort = await freePort()
  const port = await freePort()
  baseUrl = `http://localhost:${port}`
  // The cockpit's own browser is launched with --no-sandbox exactly where this machine needs it.
  const noSandbox = readTestEnv().browser.launchArgs?.includes('--no-sandbox')
  server = spawn(process.execPath, [cezarCli, 'serve', '--repo', dataRoot, '--port', String(port), '--no-open'], {
    env: fixtureServeEnv(dataRoot, { CEZ_PREVIEW: '1', ...(noSandbox ? { CEZ_PREVIEW_NO_SANDBOX: '1' } : {}) }),
    stdio: 'ignore',
  })
  await waitForHealth(baseUrl)
  const bootProject = await bootProjectId(baseUrl)

  const created = await fetch(`${baseUrl}/api/v1/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ task: `mock:preview-serve ${appPort}`, workflow: 'quick-task' }),
  })
  runId = ((await created.json()) as { id: string }).id
  taskUrl = `${baseUrl}/p/${bootProject}/tasks/${runId}`

  browser = AgentBrowser.open(sessionId)
  browser.setViewport(1440, 900)
  browser.goto(taskUrl)
}, 120_000)

afterAll(async () => {
  browser?.close()
  await stopFixtureServer(server)
  if (dataRoot) rmSync(dataRoot, { recursive: true, force: true })
})

describe('live preview', () => {
  it('registers, runs, streams, takes a click and stops', () => {
    // The agent's tool call lands as a card that has not started anything yet.
    const registered = browser.waitForValue(
      `(() => { const c = document.querySelector('${card}'); return c ? c.textContent : null })()`,
      text => typeof text === 'string' && text.includes('registered · not started'),
    ) as string
    expect(registered).toContain(`:${appPort}`)

    // The card lands while the agent's reply is still rendering below it and the thread scrolls
    // with it; a click on a card that is still moving misses. Click it once its box has held still.
    // On CI the agent's reply is longer (deeper fixture paths), so following the thread's tail left
    // the card under the sticky breadcrumb, and agent-browser refused the covered click (failure
    // bundle live-preview/registers-runs-streams-takes-a-click-and-stops-1, PR #792). Centre the
    // button first, then wait for it to hold still below the breadcrumb.
    browser.waitForFunction(`!!document.querySelector('${card} button')`)
    browser.evaluate(`document.querySelector('${card} button').scrollIntoView({ block: 'center', behavior: 'instant' })`)
    browser.waitForStable(
      `(() => {
        const b = document.querySelector('${card} button'); if (!b) return null;
        const r = b.getBoundingClientRect();
        const crumb = document.querySelector('[data-slot="desktop-breadcrumb"]');
        const below = crumb ? crumb.getBoundingClientRect().bottom : 0;
        return r.width > 0 && r.top >= below && r.bottom <= innerHeight ? [r.left, r.top, r.width, r.height] : null;
      })()`,
      { holdMs: 800 },
    )
    browser.click(`${card} button`)

    // The canvas holds the page: the fixture button's fill is green, not white or empty. The frame
    // must also be the size of the pane (Chromium's viewport follows the pane through a burst of
    // resizes while it opens), because a pointer position maps to a page pixel only at that size.
    // The reading is held steady before the click uses it.
    const ready = browser.waitForStable(
      `(() => {
        const c = document.querySelector('${canvas}');
        const surface = c && c.closest('[data-slot="preview-surface"]');
        if (!c || !surface || !c.width) return null;
        const rect = surface.getBoundingClientRect();
        if (Math.abs(c.width - rect.width) > 1 || Math.abs(c.height - rect.height) > 1) return null;
        const px = c.getContext('2d').getImageData(${BUTTON_FILL.x}, ${BUTTON_FILL.y}, 1, 1).data;
        const scale = Number(surface.getAttribute('data-scale') || 1);
        return { r: px[0], g: px[1], b: px[2], a: px[3], x: Math.round(rect.left + ${BUTTON.x} * scale), y: Math.round(rect.top + ${BUTTON.y} * scale) };
      })()`,
      {
        holdMs: 500,
        matcher: value => !!value && (value as { a: number }).a > 0 && (value as { g: number }).g > 150 && (value as { r: number }).r < 100,
      },
    ) as { g: number; x: number; y: number }
    expect(ready.g).toBeGreaterThan(150)
    browser.screenshot(resolve(artifactsDir, 'streaming.png'), { viewport: true })

    // Docked, both halves keep their room (#781 visual QA): the task title holds one line instead of
    // wrapping letter by letter beside the chips, and the address field is wide enough to read the
    // page's URL whatever else the toolbar carries.
    const room = browser.waitForValue(
      `(() => {
        const field = document.querySelector('${address}');
        const title = document.querySelector('[data-slot="run-title-row"] h1');
        if (!field || !title) return null;
        return { address: field.getBoundingClientRect().width, titleHeight: title.getBoundingClientRect().height, titleSize: parseFloat(getComputedStyle(title).fontSize) };
      })()`,
      value => !!value,
    ) as { address: number; titleHeight: number; titleSize: number }
    expect(room.address).toBeGreaterThan(150)
    expect(room.titleHeight).toBeLessThan(room.titleSize * 1.6)

    // Run and open shows the page's address, in a field nobody focused (#781 final review,
    // Important 5: the pane used to focus the field before the URL landed, freezing an empty
    // draft). Read before the tap, because tapAt blurs the field and would hide the bug.
    const before = browser.waitForValue(
      `(() => { const input = document.querySelector('${address}'); return input ? { value: input.value, focused: document.activeElement === input } : null })()`,
      value => !!value && (value as { value: string }).value.includes(`localhost:${appPort}`),
    ) as { value: string; focused: boolean }
    expect(before.focused).toBe(false)

    // A real pointer stream at the button's screen position changes the page.
    browser.tapAt(ready.x, ready.y)
    const shown = browser.waitForValue(
      `(() => { const input = document.querySelector('${address}'); return input ? input.value : null })()`,
      value => typeof value === 'string' && value.endsWith('#clicked'),
    ) as string
    expect(shown).toContain(`localhost:${appPort}`)

    // More → Stop server; the card reads stopped.
    browser.click('button[aria-label="More"]')
    browser.click('[role="menuitem"][data-variant="destructive"]')
    const stopped = browser.waitForValue(
      `(() => { const c = document.querySelector('${card}'); return c ? c.textContent : null })()`,
      text => typeof text === 'string' && text.includes('stopped'),
    ) as string
    expect(stopped).toContain(`:${appPort}`)
  }, 120_000)
})
