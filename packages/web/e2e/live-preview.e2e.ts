import { execFileSync, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { AgentBrowser, bootProjectId, cezarCli, fixtureServeEnv } from './agent-browser'
import { pollFor } from './poll'
import { spawnFixtureServer, stopFixtureServer, waitForFixtureServer } from './fixture-server'

/**
 * Live preview, end to end (#781): the dry-run mock agent registers a dev server through the
 * real `cezar_preview_serve` tool, the owner runs it from the thread card, the task's own
 * Chromium streams it onto the canvas, a click on the canvas changes the page, and Stop ends it.
 *
 * The spec boots its own server because the feature is off by default (`CEZ_PREVIEW=1`). The
 * cezar-side Chromium is whatever `resolveChromium` finds, launched with `CEZ_PREVIEW_NO_SANDBOX=1`
 * because whether its sandbox works depends on the host (see beforeAll).
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

/** The browser's cold launch can take most of a 25 s wait on a loaded CI runner (PR #792); give
 *  this spec's waits room past cezar's 30 s launch deadline, so a launch that fails shows its
 *  5.5 reason in the failure bundle instead of a spinner. Restored in afterAll. */
const priorWaitBudget = process.env.AGENT_BROWSER_DEFAULT_TIMEOUT

beforeAll(async () => {
  process.env.AGENT_BROWSER_DEFAULT_TIMEOUT = '45000'
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
  // The cockpit's own browser is launched with --no-sandbox exactly where this machine needs it.
  // Whether the Chromium cezar resolves can use its sandbox depends on the host: GitHub's Ubuntu
  // runners and this repo's dev boxes restrict unprivileged user namespaces (AppArmor), and the
  // pane then shows 5.4 (failure bundle live-preview/registers-runs-streams-takes-a-click-and-stops-1,
  // PR #792). That state has its own unit coverage; this spec is about streaming, so it always opts
  // out the documented way.
  server = spawnFixtureServer([cezarCli, 'serve', '--repo', dataRoot, '--port', '0', '--no-open'], {
    env: fixtureServeEnv(dataRoot, { CEZ_PREVIEW: '1', CEZ_PREVIEW_NO_SANDBOX: '1' }),
    stdio: 'ignore',
  })
  baseUrl = await waitForFixtureServer(server)
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
  if (priorWaitBudget === undefined) delete process.env.AGENT_BROWSER_DEFAULT_TIMEOUT
  else process.env.AGENT_BROWSER_DEFAULT_TIMEOUT = priorWaitBudget
  browser?.close()
  await stopFixtureServer(server)
  // Local ENOTEMPTY evidence: https://github.com/hearsay-tools/cezarion/pull/841#discussion_r4185080113
  // Retry transient directory-writer races after shutdown; persistent failures still throw.
  if (dataRoot) rmSync(dataRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

describe('live preview', () => {
  it('registers, runs, streams, takes a click and stops', async () => {
    // The agent's tool call lands as a card that has not started anything yet.
    const registered = browser.waitForValue(
      `(() => { const c = document.querySelector('${card}'); return c ? c.textContent : null })()`,
      text => typeof text === 'string' && text.includes('registered · not started'),
    ) as string
    expect(registered).toContain(`:${appPort}`)

    // Open the pane from the header toggle and approve the run there (spec 5.16). The thread card
    // offers the same Run and open, but the thread follows its tail while the agent's reply
    // renders, so on CI (longer reply, deeper fixture paths) the card sat under the sticky
    // breadcrumb and agent-browser refused the covered click (failure bundle
    // live-preview/registers-runs-streams-takes-a-click-and-stops-1, PR #792). The toggle sits in
    // the fixed task header and never moves with the thread.
    browser.click('[data-slot="preview-toggle"]')
    const approval = '[data-slot="preview-pane"] [data-slot="preview-state"][data-state="needs-approval"]'
    // CI evidence: https://github.com/hearsay-tools/cezarion/actions/runs/37986554086/job/114009939596
    // Artifact cockpit-failures-shard-4, live-preview/registers-runs-streams-takes-a-click-and-stops-1:
    // snapshot shows the registered server's Review button; probe has needs-approval=null.
    // Registration can reach the header before its default server selection.
    // The empty pane legitimately lists that server for review in this ordering.
    const landing = browser.waitForValue(
      `(() => { const pane = document.querySelector('[data-slot="preview-pane"]');
        if (pane?.querySelector('[data-state="needs-approval"]')) return 'approval';
        return [...(pane?.querySelectorAll('[data-state="empty"] button') ?? [])]
          .some(button => button.textContent.trim() === 'Review') ? 'review' : null })()`,
      value => value === 'approval' || value === 'review',
    )
    if (landing === 'review') browser.click('[data-slot="preview-pane"] [data-state="empty"] button')
    const pending = browser.waitForValue(
      `(() => { const s = document.querySelector('${approval}'); return s ? s.textContent : null })()`,
      text => typeof text === 'string' && text.includes('Run and open'),
    ) as string
    expect(pending).toContain('registered · not started')
    browser.click(`${approval} button`)

    // First the pane leaves its state screens (server start, then the browser's cold launch, which
    // took over 10 s on a loaded CI runner: failure bundle live-preview/registers-runs-streams-
    // takes-a-click-and-stops-1, PR #792), so the frame check below gets its own wait budget. A
    // launch that fails leaves a state screen up, and the bundle shows its reason.
    browser.waitForFunction(`!document.querySelector('[data-slot="preview-pane"] [data-slot="preview-state"]')`)

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

    // Native tab visibility releases preview transport; restoring an old viewer must not
    // steal the page from the tab that explicitly opened it in the meantime.
    await browser.withCdp(async (request, subscribe) => {
      const targets = await request('Target.getTargets')
      const first = targets.targetInfos.find((target: { url: string; type: string }) => target.type === 'page' && target.url === taskUrl)
      const attached = await request('Target.attachToTarget', { targetId: first.targetId, flatten: true })
      const firstSession = attached.sessionId
      const evaluate = async (session: string, expression: string) => (await request('Runtime.evaluate', { expression, returnByValue: true }, session)).result.value
      let closed = 0
      const observations: Array<Record<string, unknown>> = []
      const off = subscribe(event => { if (event.sessionId === firstSession && event.method === 'Network.webSocketClosed') closed++ })
      await request('Network.enable', {}, firstSession)
      const second = await request('Target.createTarget', { url: 'about:blank' })
      const secondSession = (await request('Target.attachToTarget', { targetId: second.targetId, flatten: true })).sessionId
      try {
        await request('Target.activateTarget', { targetId: second.targetId })
        await pollFor(async () => closed > 0 && await evaluate(firstSession, 'document.visibilityState') === 'hidden' ? true : undefined,
          () => 'hidden preview retained its socket')
        observations.push({ phase: 'hidden', closedSockets: closed, visibility: await evaluate(firstSession, 'document.visibilityState') })
        await request('Page.navigate', { url: taskUrl }, secondSession)
        await pollFor(async () => await evaluate(secondSession, '!!document.querySelector("[data-slot=preview-toggle]")') ? true : undefined,
          () => 'second preview task did not hydrate')
        await evaluate(secondSession, 'if(!document.querySelector("[data-slot=preview-pane]"))document.querySelector("[data-slot=preview-toggle]").click()')
        await pollFor(async () => await evaluate(secondSession, '!!document.querySelector("[data-slot=preview-surface] canvas")?.width && !document.querySelector("[data-slot=preview-state]")') ? true : undefined,
          () => 'second viewer did not claim the live preview', { timeoutMs: 30_000, tries: 120 })
        await request('Target.activateTarget', { targetId: first.targetId })
        await pollFor(async () => await evaluate(firstSession, '!!document.querySelector("[data-state=taken-over]")') ? true : undefined,
          () => 'restored viewer stole another tab preview')
        observations.push({ phase: 'restored', state: await evaluate(firstSession, 'document.querySelector("[data-slot=preview-state]")?.getAttribute("data-state")') })
        // A deliberate user action can claim it back.
        await evaluate(firstSession, '[...document.querySelectorAll("button")].find(button=>button.textContent.includes("Use it here")).click()')
        await pollFor(async () => await evaluate(firstSession, '!document.querySelector("[data-slot=preview-state]") && !!document.querySelector("[data-slot=preview-surface] canvas")?.width') ? true : undefined,
          () => 'explicit preview claim failed', { timeoutMs: 30_000, tries: 120 })
        observations.push({ phase: 'explicit reclaim', canvasWidth: await evaluate(firstSession, 'document.querySelector("[data-slot=preview-surface] canvas")?.width') })
        writeFileSync(resolve(artifactsDir, 'tab-lifecycle.json'), JSON.stringify(observations, null, 2))
      } finally { off(); await request('Target.closeTarget', { targetId: second.targetId }); await request('Target.activateTarget', { targetId: first.targetId }) }
    })

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
