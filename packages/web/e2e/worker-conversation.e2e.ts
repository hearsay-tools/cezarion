import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { AgentBrowser, bootProjectId, cezarCli, fixtureServeEnv } from './agent-browser'
import { applyContrastQaVariant, contrastQaVariants, contrastSampleExpression, focusWithKeyboard, type ContrastSample } from './contrast'
import record from './fixtures/thread-run.record.json'
import { waitForHealth } from './poll'

// Real store/history/reducer/rendering, not live provider execution. Deliberately
// interleave work between non-blocking sends and replies, unlike the old QA fixture.
const parent = '11111111-1111-4111-8111-111111111111'
const alpha = '22222222-2222-4222-8222-222222222222'
const bravo = '33333333-3333-4333-8333-333333333333'
const large = '44444444-4444-4444-8444-444444444444'
const reqA = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', senderRunId: parent, recipientRunId: alpha, kind: 'request', text: 'Inspect the parser and report findings.', createdAt: '2026-09-20T12:00:00Z', state: 'accepted', requestHash: 'a'.repeat(64) }
const reqB = { ...reqA, id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', recipientRunId: bravo }
const reply = { ...reqA, id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', senderRunId: alpha, recipientRunId: parent, kind: 'reply', requestId: reqA.id, text: 'Alpha found one parser edge case.', createdAt: '2026-09-20T12:05:00Z' }
const follow = { ...reqA, id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', kind: 'follow-up', requestId: reqA.id, text: 'Also check empty input.' }
const projection = (message: object) => ({ type: 'conversation-message', message, delivery: 'delivered' })
const events = (padding = 0) => [
  projection(reqA), projection(reqB),
  { type: 'item.completed', item: { kind: 'reasoning', id: 'thinking', text: 'Requests are non-blocking; continue independent work.' } },
  { type: 'item.completed', item: { kind: 'tool', id: 'check', name: 'Bash', title: 'Ran npm test', toolKind: 'execute', status: 'completed', output: 'Tests passed', exitCode: 0 } },
  { type: 'item.completed', item: { kind: 'message', id: 'independent', role: 'assistant', text: 'Independent work completed before the reply arrived.' } },
  ...Array.from({ length: padding }, (_, n) => ({ type: 'note', message: `Independent checkpoint ${n}: still working while the request is outstanding.` })),
  projection(follow),
  { type: 'request-outcome', outcome: { requestId: reqA.id, status: 'replied', replyId: reply.id, observedAt: reply.createdAt } },
  projection(reply), projection(reply), // replay is still one visible reply
]

let browser: AgentBrowser
let server: ChildProcess
let root: string
let base: string
let project: string
const card = '[data-slot="worker-conversation-card"]'
const request = `${card}[data-kind="request"]`
const replyCard = `${card}[data-kind="reply"]`
const connector = '[data-slot="conversation-connector"]'
const artifacts = resolve(import.meta.dirname, '../../../.ai/qa/artifacts_e2e/worker-conversation')

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'cezar-worker-cards-'))
  mkdirSync(join(root, '.ai/cezar/runs'), { recursive: true })
  mkdirSync(artifacts, { recursive: true })
  writeFileSync(join(root, '.ai/cezar/runs.json'), JSON.stringify([
    [parent, 'Parent coordinator'], [alpha, 'Alpha'], [bravo, 'Bravo'], [large, 'Long conversation'],
  ].map(([id, title]) => ({ ...record, id, title, titleSummary: title, task: 'Coordinate the workers.', pullRequestUrl: undefined }))))
  for (const [id, padding] of [[parent, 0], [large, 70]] as const) {
    const lines = events(padding).map((event, n) => ({ seq: n + 1, ts: '2026-09-20T12:05:00Z', ...event }))
    // The long transcript has its own sender identity, keeping direction truthful.
    writeFileSync(join(root, '.ai/cezar/runs', `${id}.ndjson`), lines.map(line => JSON.stringify(line).replaceAll(parent, id)).join('\n') + '\n')
  }
  const port = await new Promise<number>((done, fail) => {
    const probe = createServer()
    probe.once('error', fail)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port = typeof address === 'object' && address ? address.port : 0
      probe.close(() => done(port))
    })
  })
  base = `http://localhost:${port}`
  server = spawn(process.execPath, [cezarCli, 'serve', '--repo', root, '--port', String(port), '--no-open'], { env: fixtureServeEnv(root), stdio: 'ignore' })
  await waitForHealth(base)
  project = await bootProjectId(base)
  browser = AgentBrowser.open(`e2e-worker-cards-${process.pid}`)
}, 120_000)

afterAll(() => {
  browser?.close()
  server?.kill()
  try { if (root) rmSync(root, { recursive: true, force: true }) } catch { /* server may still be flushing */ }
})

function waitForFocusedCard(selector: string) {
  browser.waitForFunction(`(() => {
    const card = document.activeElement?.querySelector(${JSON.stringify(selector)});
    const main = document.querySelector('[data-slot="main"]');
    const header = document.querySelector('[data-slot="run-header"]');
    if (!card || !main) return false;
    const top = header && getComputedStyle(header).position === 'sticky'
      ? header.getBoundingClientRect().bottom : main.getBoundingClientRect().top;
    return card.getBoundingClientRect().top >= top - 1 && card.getBoundingClientRect().top < innerHeight;
  })()`)
}

describe('chronological worker conversation', () => {
  for (const variant of contrastQaVariants.filter(v => v.density === 'comfortable')) {
    it(`keeps direction and interleaved work visible: ${variant.id}`, () => {
      browser.goto(`${base}/p/${project}/tasks/${parent}?thread=flat`)
      browser.waitForFunction(`document.querySelector('${replyCard}') !== null`)
      applyContrastQaVariant(browser, variant)
      const kinds = browser.waitForValue<string[]>(`[...document.querySelectorAll('[data-slot="thread-row"]')].map(row => {
        const card = row.querySelector('${card}');
        return card ? card.dataset.kind : row.querySelector('[data-slot="reasoning"]') ? 'thinking' : row.querySelector('[data-slot="tool-card"]') ? 'tool' : row.querySelector('[data-slot="assistant-message"]') ? 'assistant' : 'user';
      })`, value => value.length === 7)
      expect(kinds).toEqual(['user', 'request', 'thinking', 'tool', 'assistant', 'follow-up', 'reply'])
      const colors = browser.waitForValue<string[]>(`['[data-slot="user-bubble"]', '${request}', '${replyCard}'].map(s => getComputedStyle(document.querySelector(s)).backgroundColor)`)
      expect(new Set(colors).size).toBe(3)
      for (const selector of [`${request} > div > p`, `${replyCard} > div > p`]) {
        const contrast = browser.waitForValue<ContrastSample>(contrastSampleExpression(selector))
        expect(contrast.ratio).toBeGreaterThanOrEqual(4.5)
      }
      const bounds = browser.waitForValue<{ overflow: boolean; targets: number[] }>(`(() => ({
        overflow: document.documentElement.scrollWidth > innerWidth || [...document.querySelectorAll('${card}')].some(el => el.scrollWidth > el.clientWidth),
        targets: [...document.querySelectorAll('${card} button, ${card} a')].map(el => el.getBoundingClientRect().height)
      }))()`)
      expect(bounds.overflow).toBe(false)
      expect(bounds.targets.every(height => height >= 44)).toBe(true)
      focusWithKeyboard(browser, `${replyCard} ${connector}`)
      browser.press('Enter')
      waitForFocusedCard(request)
      browser.screenshot(join(artifacts, `${variant.id}-request.png`), { viewport: true })
      focusWithKeyboard(browser, `${request} ${connector}`)
      browser.press('Enter')
      waitForFocusedCard(replyCard)
      browser.screenshot(join(artifacts, `${variant.id}-reply.png`), { viewport: true })
      browser.click(`${replyCard} [data-slot="collapsible-trigger"]`)
      browser.waitForFunction(`document.querySelector('${replyCard}').textContent.includes('${reply.id}')`)
    })
  }

  it('navigates to an unmounted request and back through the virtualizer', () => {
    browser.setViewport(1440, 900)
    browser.goto(`${base}/p/${project}/tasks/${large}?thread=virtual`)
    browser.waitForFunction(`document.querySelector('${replyCard}') !== null && document.querySelector('[data-virtualized="true"]') !== null`)
    expect(browser.count(request)).toBe(0)
    focusWithKeyboard(browser, `${replyCard} ${connector}`)
    browser.press('Enter')
    waitForFocusedCard(request)
    const top = browser.waitForValue<number>(`document.querySelector('${request}').getBoundingClientRect().top`, value => value >= 0 && value < 500)
    expect(top).toBeLessThan(500)
    focusWithKeyboard(browser, `${request} ${connector}`)
    browser.press('Enter')
    waitForFocusedCard(replyCard)
  })
})
