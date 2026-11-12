import { Home } from '../../cezar/src/home/home.ts';
import { execFileSync, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { makeRunRecord, RUN_STATUS } from '@open-mercato/cezar-api-client/contract/test-factories.testkit'
import { LIVE_PROTOCOL } from '@open-mercato/cezar-api-client/contract/live-coordination'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { seedRuns } from './seed-runs'
import { AgentBrowser, bootProjectId, squawkCli, fixtureServeEnv } from './agent-browser'
import { contrastSampleExpression, focusWithKeyboard, type ContrastSample } from './contrast'
import { spawnFixtureServer, stopFixtureServer, waitForFixtureServer } from './fixture-server'
import { seedTranscript } from './seed-transcript'
import { settleVisual, waitForSettledSample } from './visual-ready'
// fixture-server starts: 1

// Real publication, metadata, content, persisted messages and browser history. Preview is off
// at shipped defaults: report panes must work without enabling the live-preview capability.
const runId = randomUUID()
const otherRunId = randomUUID()
const virtualRunId = randomUUID()
const agentRunId = randomUUID()
const projectId = 'report-cards'
const evidence = resolve(import.meta.dirname, '../../../.ai/qa/artifacts_issue-2401')
const CARD = '[data-slot="report-card"]'
const READ = `${CARD} a`
const FRAME = '[data-slot="html-report-frame"]'
const READER = '[data-route="task-report"][data-variant="pane"]'
const BACK = '[data-slot="report-bar"] button[aria-label="Back"]'
let root: string
let base: string
let server: ChildProcess
let browser: AgentBrowser
let publication: { id: string; markdown: string }
let unreferencedPublication: { id: string; markdown: string }

const thread = () => `/p/${projectId}/tasks/${runId}?thread=flat`
const otherThread = () => `/p/${projectId}/tasks/${otherRunId}`

beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'cez-report-cards-')))
  const project = join(root, 'project')
  execFileSync('git', ['init', '-q', '-b', 'main', project])
  mkdirSync(join(project, '.ai/cezar/runs'), { recursive: true })
  const env = fixtureServeEnv(project)
  mkdirSync(env.CEZ_HOME!, { recursive: true })
  const home = Home.sandbox(env.CEZ_HOME!)
  Home.seedBytes(home, home.workspaceConfig, Buffer.from(JSON.stringify({ projects: [{ id: projectId, root: project }] })))
  const source = join(root, 'published-results.html')
  writeFileSync(source, '<!doctype html><title>Published research results</title><main><h1>Research results</h1><p style="height:3000px">Long report body</p><p>End of report</p></main>')
  publication = JSON.parse(execFileSync(process.execPath, [squawkCli, 'artifact', 'publish', source], {
    cwd: project, env: { ...env, CEZ_PROJECT_ID: projectId, CEZ_TASK_ID: runId, CEZ_ARTIFACTS_DIR: join(project, '.ai/cezar/runs', `${runId}-artifacts`) }, encoding: 'utf8',
  }))
  unreferencedPublication = JSON.parse(execFileSync(process.execPath, [squawkCli, 'artifact', 'publish', source], {
    cwd: project, env: { ...env, CEZ_PROJECT_ID: projectId, CEZ_TASK_ID: otherRunId, CEZ_ARTIFACTS_DIR: join(project, '.ai/cezar/runs', `${otherRunId}-artifacts`) }, encoding: 'utf8',
  }))
  rmSync(source)
  const records = [[runId, 'Report card source'], [otherRunId, 'Other conversation'], [virtualRunId, 'Long report conversation'], [agentRunId, 'Agent report conversation']].map(([id, title]) => makeRunRecord({
    id: id!, title: title!, task: 'Review the published results.', status: RUN_STATUS.done, createdAt: '2026-11-01T08:00:00Z',
  }))
  seedRuns(project, records)
  const text = `The answer stays in the conversation. ${publication.markdown}\n\nRepeated reference: ${publication.markdown}`
  const events = [text, `A second message names the same report: ${publication.markdown}`].map((message, n) => ({
    seq: n + 1, ts: '2026-11-01T08:01:00Z', type: 'item.completed', item: { kind: 'message', id: `report-message-${n}`, role: 'assistant', text: message },
  }))
  // Keep the recorded native agent attribution and replace only its message text.
  const agentEvents = readFileSync(join(import.meta.dirname, 'fixtures/subagents-run.ndjson'), 'utf8').trim().split('\n').map(line => {
    const event = JSON.parse(line)
    if (event.item?.kind === 'message') event.item.text += ` ${publication.markdown}`
    return JSON.stringify(event)
  }).join('\n')
  seedTranscript(join(project, '.ai/cezar/runs', `${agentRunId}.ndjson`), agentEvents + '\n')
  seedTranscript(join(project, '.ai/cezar/runs', `${runId}.ndjson`), events.map(event => JSON.stringify(event)).join('\n') + '\n')
  const longMessages = [
    ...Array.from({ length: 20 }, (_, n) => `Earlier analysis ${n}: ${'The investigation continues. '.repeat(8)}`),
    `Virtual source report: ${publication.markdown}`,
    ...Array.from({ length: 60 }, (_, n) => `Later analysis ${n}: ${'The investigation continues. '.repeat(8)}`),
  ]
  seedTranscript(join(project, '.ai/cezar/runs', `${virtualRunId}.ndjson`), longMessages.map((message, n) => JSON.stringify({
    seq: n + 1, ts: '2026-11-01T08:01:00Z', type: 'item.completed', item: { kind: 'message', id: `long-message-${n}`, role: 'assistant', text: message },
  })).join('\n') + '\n')
  mkdirSync(evidence, { recursive: true })
  server = spawnFixtureServer([squawkCli, 'serve', '--repo', project, '--port', '0', '--no-open'], { env })
  base = await waitForFixtureServer(server)
  expect(await bootProjectId(base)).toBe(projectId)
  browser = AgentBrowser.open(`report-cards-${process.pid}`)
  browser.setViewport(1440, 900)
}, 120_000)

afterAll(async () => {
  browser?.close()
  await stopFixtureServer(server)
  if (root) rmSync(root, { recursive: true, force: true })
})

function openConversation() {
  browser.goto(base + thread())
  browser.waitForFunction(`document.querySelectorAll('${CARD} h3').length === 2 && [...document.querySelectorAll('${CARD} h3')].every(el => el.textContent === 'Published research results')`)
  browser.evaluate(`document.querySelector('${READ}').scrollIntoView({ block: 'center', behavior: 'instant' })`)
  settleVisual(browser, CARD, { idle: true })
}

function openReport(selector = READ) {
  browser.click(selector)
  browser.waitForFunction(`document.querySelector('${FRAME}') !== null && new URLSearchParams(location.search).get('report') === ${JSON.stringify(publication.id)}`)
  settleVisual(browser, READER, { idle: true })
}

function expectReturned(selector = READ) {
  browser.waitForFunction(`!new URLSearchParams(location.search).has('report') && document.querySelector('${FRAME}') === null && document.activeElement === document.querySelector(${JSON.stringify(selector)})`)
}

it('adds one card per report per answer, and fetches only metadata until Read report', () => {
  openConversation()
  const before = waitForSettledSample<{ cards: number; frames: number; answer: boolean; inlineLinks: number }>(browser, `(() => {
    return { cards: document.querySelectorAll('${CARD}').length, frames: document.querySelectorAll('${FRAME}').length,
      answer: document.body.textContent.includes('The answer stays in the conversation.'),
      inlineLinks: document.querySelectorAll('[data-slot="assistant-message"] [data-streamdown="link"]').length };
  })()`)
  expect(before).toEqual({ cards: 2, frames: 0, answer: true, inlineLinks: 3 })
  const endpoints = [`/api/v1/p/${projectId}/runs/${runId}/artifacts/${publication.id}`, `/api/v1/runs/${runId}/artifacts/${publication.id}`]
  const countRequests = (paths: string[]) => browser.waitForValue<number>(`performance.getEntriesByType('resource').filter(entry => ${JSON.stringify(paths)}.includes(new URL(entry.name).pathname)).length`)
  expect(countRequests(endpoints.map(endpoint => endpoint + '/metadata'))).toBe(1)
  expect(countRequests(endpoints)).toBe(0)
  openReport()
  expect(countRequests(endpoints)).toBe(1)
  const split = waitForSettledSample<{ main: DOMRect; pane: DOMRect; visible: boolean }>(browser, `(() => ({ main: document.querySelector('[data-slot="task-main"]').getBoundingClientRect().toJSON(), pane: document.querySelector('${READER}').getBoundingClientRect().toJSON(), visible: document.querySelector('${CARD}').checkVisibility({ visibilityProperty: true }) }))()`)
  expect(split.main.width).toBeGreaterThan(0)
  expect(split.pane.x).toBeGreaterThanOrEqual(split.main.right - 1)
  expect(split.visible).toBe(true)
  browser.screenshot(join(evidence, 'card-reader-1440.png'))
  browser.click(BACK)
  expectReturned()
})

it('opens and closes with the keyboard, returning focus and position to the source card', () => {
  openConversation()
  focusWithKeyboard(browser, READ)
  const before = waitForSettledSample<number>(browser, `document.querySelector('${READ}').getBoundingClientRect().top`, undefined, CARD)
  browser.press('Enter')
  browser.waitForFunction(`document.querySelector('${FRAME}') !== null`)
  focusWithKeyboard(browser, BACK)
  browser.press('Enter')
  expectReturned()
  const after = waitForSettledSample<number>(browser, `document.querySelector('${READ}').getBoundingClientRect().top`, undefined, CARD)
  expect(Math.abs(after - before)).toBeLessThanOrEqual(4)
})

it('takes the main area at medium width and steps back with Conversation', () => {
  browser.setViewport(1000, 800)
  openConversation()
  openReport()
  const control = '[data-slot="report-bar"] button[aria-label="Conversation"]'
  const sample = waitForSettledSample<{ text: string; width: number; paneWidth: number }>(browser, `(() => ({ text: document.querySelector('${control}').textContent, width: document.querySelector('[data-slot="task-split"]').getBoundingClientRect().width, paneWidth: document.querySelector('${READER}').getBoundingClientRect().width }))()`)
  expect(sample.text).toContain('Conversation')
  expect(Math.abs(sample.width - sample.paneWidth)).toBeLessThanOrEqual(1)
  browser.click(control)
  expectReturned()
  browser.setViewport(1440, 900)
})

it('restores the selected report after a task switch, then returns to the second source card', () => {
  openConversation()
  // Select by the second message's stable button id; both messages name the same artifact.
  const buttonId = browser.waitForValue<string>(`[...document.querySelectorAll('[data-slot="assistant-message"]')].find(el => el.textContent.includes('A second message names the same report:'))?.querySelector('${READ}')?.id`)
  const selector = `[id=${JSON.stringify(buttonId)}]`
  browser.evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({ block: 'center', behavior: 'instant' })`)
  openReport(selector)
  const selection = browser.waitForValue<string>(`location.search`)
  const link = `a[href="${otherThread()}"]`
  browser.click(link)
  browser.waitForFunction(`location.pathname === ${JSON.stringify(otherThread())} && document.querySelector('${FRAME}') === null && !new URLSearchParams(location.search).has('report')`)
  browser.evaluate('history.back()')
  browser.waitForFunction(`location.search === ${JSON.stringify(selection)} && document.querySelector('${FRAME}') !== null`)
  browser.click(BACK)
  expectReturned(selector)
  expect(browser.waitForValue<string>(`document.activeElement?.id`)).toBe(buttonId)
})

it('opens a cold selected publication without a transcript reference or mounted source card', async () => {
  const currentUrl = browser.url()
  await browser.withCdp(async request => {
    const { targetInfos } = await request('Target.getTargets')
    const page = targetInfos.find((target: { type: string; url: string }) => target.type === 'page' && target.url === currentUrl)
    const { sessionId } = await request('Target.attachToTarget', { targetId: page.targetId, flatten: true })
    await request('Page.enable', {}, sessionId)
    // Observe the whole cold load, so a transient source-registry error cannot pass on recovery.
    const { identifier } = await request('Page.addScriptToEvaluateOnNewDocument', { source: `
      window.__reportSourceFailures = [];
      new MutationObserver(() => {
        if (document.body?.textContent.includes('Report source unavailable')) window.__reportSourceFailures.push('source unavailable');
      }).observe(document, { childList: true, subtree: true, characterData: true });
    ` }, sessionId)
    try {
      browser.goto(`${base}${otherThread()}?report=${unreferencedPublication.id}&card=not-yet-mounted-message`)
      browser.waitForFunction(`Array.isArray(window.__reportSourceFailures)`)
      const opening = browser.waitForValue<{ frame: boolean; failures: string[] }>(`({ frame: document.querySelector('${FRAME}') !== null, failures: window.__reportSourceFailures ?? [] })`, value => value.frame || value.failures.length > 0)
      expect(opening.failures, 'A published report must resolve without a mounted source card').toEqual([])
      browser.waitForFunction(`document.querySelector('${FRAME}') !== null`)
      settleVisual(browser, READER, { idle: true })
      const state = browser.waitForValue<{ cards: number; failures: string[]; selection: string | null }>(`({ cards: document.querySelectorAll('${CARD}').length, failures: window.__reportSourceFailures, selection: new URLSearchParams(location.search).get('report') })`)
      expect(state).toEqual({ cards: 0, failures: [], selection: unreferencedPublication.id })
      browser.click(BACK)
      browser.waitForFunction(`!new URLSearchParams(location.search).has('report') && document.querySelector('${FRAME}') === null`)
    } finally {
      await request('Page.removeScriptToEvaluateOnNewDocument', { identifier }, sessionId)
      await request('Target.detachFromTarget', { sessionId })
    }
  })
})

it('restores an offscreen source card after a cold virtualized report selection', () => {
  const path = `/p/${projectId}/tasks/${virtualRunId}`
  browser.goto(`${base}${path}?thread=flat`)
  const href = browser.waitForValue<string>(`document.querySelector('${READ}')?.getAttribute('href')`)
  const query = new URL(href, base).searchParams
  const messageKey = query.get('card')!
  const buttonId = browser.waitForValue<string>(`document.querySelector('${READ}')?.id`)
  const selector = `[id=${JSON.stringify(buttonId)}]`
  browser.goto(`${base}${path}?thread=virtual&report=${publication.id}&card=${encodeURIComponent(messageKey)}`)
  browser.waitForFunction(`document.querySelector('[data-slot="thread-rows"]')?.dataset.virtualized === 'true' && document.querySelector('${FRAME}') !== null`)
  // Scroll the retained conversation away from its opener while the pane stays mounted.
  browser.evaluate(`window.__cezThreadScrollTo(100000)`)
  browser.waitForFunction(`document.querySelector(${JSON.stringify(selector)}) === null`)
  browser.click(BACK)
  expectReturned(selector)
  const visible = waitForSettledSample<boolean>(browser, `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el || !el.checkVisibility({ contentVisibilityAuto: true })) return null;
    const rect = el.getBoundingClientRect();
    return rect.top >= 0 && rect.bottom <= innerHeight;
  })()`)
  expect(visible).toBe(true)
})

it('restores the saved virtual viewport and card focus after virtualizer compensation settles', () => {
  const path = `/p/${projectId}/tasks/${virtualRunId}`
  browser.goto(`${base}${path}?thread=flat`)
  const buttonId = browser.waitForValue<string>(`document.querySelector('${READ}')?.id`)
  const selector = `[id=${JSON.stringify(buttonId)}]`
  const href = browser.waitForValue<string>(`document.querySelector(${JSON.stringify(selector)})?.getAttribute('href')`)
  const selection = new URL(href, base).searchParams
  browser.goto(`${base}${path}?thread=virtual&report=${publication.id}&card=${encodeURIComponent(selection.get('card')!)}`)
  browser.waitForFunction(`document.querySelector('[data-slot="thread-rows"]')?.dataset.virtualized === 'true' && document.querySelector('${FRAME}') !== null`)
  // First restore the offscreen row by its stable identity, rather than estimating its height.
  browser.click(BACK)
  expectReturned(selector)
  settleVisual(browser, selector, { idle: true })
  const before = waitForSettledSample<number>(browser, `document.querySelector('[data-slot="main"]').scrollTop`)
  openReport(selector)
  browser.evaluate(`window.__cezThreadScrollTo(100000)`)
  browser.waitForFunction(`document.querySelector(${JSON.stringify(selector)}) === null`)
  browser.click(BACK)
  expectReturned(selector)
  const after = waitForSettledSample<{ top: number; focused: boolean }>(browser, `(() => ({
    top: document.querySelector('[data-slot="main"]').scrollTop,
    focused: document.activeElement?.id === ${JSON.stringify(buttonId)}
  }))()`, () => true, selector)
  expect(after.focused).toBe(true)
  expect(Math.abs(after.top - before)).toBeLessThanOrEqual(1)
}, 120_000)

it.each(['light', 'dark'])('fits a full-screen phone reader with accessible card controls in %s', theme => {
  browser.setViewport(360, 640)
  browser.goto(base + thread())
  browser.evaluate(`localStorage.setItem('cez-theme', ${JSON.stringify(theme)})`)
  openConversation()
  settleVisual(browser, CARD, { theme, idle: true })
  for (const selector of [`${CARD} h3`, `${CARD} p`, READ]) {
    const contrast = browser.waitForValue<ContrastSample>(contrastSampleExpression(selector))
    expect(contrast.ratio, selector).toBeGreaterThanOrEqual(4.5)
  }
  const target = waitForSettledSample<DOMRect>(browser, `document.querySelector('${READ}').getBoundingClientRect().toJSON()`, undefined, CARD)
  expect(Math.min(target.width, target.height)).toBeGreaterThanOrEqual(44)
  openReport()
  const phone = waitForSettledSample<{ rect: DOMRect; controls: number[][]; downloads: number; nestedScroll: boolean; frames: number }>(browser, `(() => {
    const body = document.querySelector('[data-slot="report-body"]');
    return { rect: document.querySelector('${READER}').getBoundingClientRect().toJSON(),
      controls: [...document.querySelectorAll('[data-slot="report-bar"] button')].map(el => { const r = el.getBoundingClientRect(); return [r.width, r.height] }),
      downloads: document.querySelectorAll('[data-slot="report-bar"] a[download], [data-slot="report-bar"] a[href$="/download"]').length,
      nestedScroll: body.scrollHeight > body.clientHeight + 1, frames: document.querySelectorAll('${FRAME}').length };
  })()`)
  expect([phone.rect.x, phone.rect.y, phone.rect.width, phone.rect.height]).toEqual([0, 0, 360, 640])
  expect(phone.downloads).toBe(0)
  expect(phone.nestedScroll).toBe(false)
  expect(phone.frames).toBe(1)
  for (const [width, height] of phone.controls) expect(Math.min(width!, height!)).toBeGreaterThanOrEqual(44)
  browser.screenshot(join(evidence, `card-reader-360-${theme}.png`))
  browser.click(BACK)
  expectReturned()
  browser.setViewport(1440, 900)
})

it.each([360, 1440])('opens and closes a report from the agent sheet at %ipx', width => {
  browser.setViewport(width, 640)
  // Cold history omits agent message children (hearsay-tools/cezarion#2463).
  // Capture the real shared-worker subscription and deliver a native live message,
  // as thread-scroll.e2e.ts does. Keep the normal history requests and transport.
  browser.goto(base + `/p/${projectId}/`)
  browser.waitForFunction(`document.querySelector('[data-route="tasks"]') !== null`)
  browser.evaluate(`(() => {
    const post = MessagePort.prototype.postMessage;
    MessagePort.prototype.postMessage = function(message, ...rest) {
      if (message?.type === 'sync' && message.version === ${LIVE_PROTOCOL}) {
        const entry = message.entries.find(entry => entry.demand.kind === 'run' && entry.demand.runId === '${agentRunId}');
        if (entry) window.__reportLive = { port: this, epoch: message.epoch, entry };
      }
      return post.call(this, message, ...rest);
    };
    history.pushState(null, '', '/p/${projectId}/tasks/${agentRunId}');
    window.dispatchEvent(new PopStateEvent('popstate'));
  })()`)
  browser.waitForFunction(`window.__reportLive !== undefined && document.querySelector('[data-slot="run-activity-dock"]') !== null`)
  browser.evaluate(`(() => {
    const current = window.__reportLive;
    current.port.dispatchEvent(new MessageEvent('message', { data: {
      version: ${LIVE_PROTOCOL}, type: 'frame', epoch: current.epoch, id: current.entry.id,
      frame: { type: 'event', projectId: '${projectId}', runId: '${agentRunId}', name: 'ui-event', event: {
        type: 'item.completed', seq: 1000, ts: '2026-11-01T08:02:00Z', stepId: 'task',
        item: { kind: 'message', id: 'live-agent-report', role: 'assistant', parentItemId: 'toolu_task_a_1', text: ${JSON.stringify(`Live agent report: ${publication.markdown}`)} }
      } }
    } }));
  })()`)
  const activity = '[data-slot="run-activity-dock"]'
  browser.waitForFunction(`document.querySelector('${activity} > button') !== null`)
  browser.evaluate(`document.querySelector('${activity} > button').scrollIntoView({ block: 'center' })`)
  settleVisual(browser, activity, { idle: true })
  browser.click(`${activity} > button`)
  const dock = '[data-slot="run-activity-subagents"]'
  browser.waitForFunction(`document.querySelector('${dock} > button') !== null`)
  browser.evaluate(`document.querySelector('${dock} > button').scrollIntoView({ block: 'center' })`)
  settleVisual(browser, dock, { idle: true })
  browser.click(`${dock} > button`)
  browser.click('[data-slot="agent-item"] button')
  const sheetRead = '[data-slot="subagent-sheet"] [data-slot="report-card"] a'
  browser.waitForFunction(`document.querySelector('${sheetRead}') !== null`)
  settleVisual(browser, '[data-slot="subagent-sheet"]', { idle: true })
  browser.click(sheetRead)
  browser.waitForFunction(`document.querySelector('[data-slot="subagent-sheet"]') === null && document.querySelector('${FRAME}') !== null`)
  settleVisual(browser, READER, { idle: true })
  expect(browser.evaluate(`(() => { const button = document.querySelector('${BACK}'); const r = button.getBoundingClientRect(); return button.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)); })()`)).toBe(true)
  browser.click(BACK)
  browser.waitForFunction(`document.querySelector('${FRAME}') === null && !new URLSearchParams(location.search).has('report') && document.activeElement === document.querySelector('[data-agent-id="toolu_task_a_1"]')`)
}, 120_000)
