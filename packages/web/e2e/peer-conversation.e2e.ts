import type { ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { AgentBrowser, bootProjectId, cezarCli, fixtureServeEnv } from './agent-browser'
import { applyContrastQaVariant, contrastQaVariants, contrastSampleExpression, type ContrastSample } from './contrast'
import { spawnFixtureServer, stopFixtureServer, waitForFixtureServer } from './fixture-server'
import record from './fixtures/thread-run.record.json'
import { seedTranscript } from './seed-transcript'
import { waitForSettledSample } from './visual-ready'
// fixture-server starts: 1

// Peer messages in a coordinator's thread (hearsay-tools/cezarion#1992): a request to a peer the
// run list names, its reply, a progress message beside an open question, and a request to a peer
// whose record is gone. Real store, history, reducer and rendering; no provider.
const self = '11111111-1111-4111-8111-111111111111'
const schemaPeer = '22222222-2222-4222-8222-222222222222'
const deletedPeer = '33333333-3333-4333-8333-333333333333'
const envelope = { state: 'accepted', requestHash: 'a'.repeat(64), relationship: 'peer' }
const request = { ...envelope, id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', senderRunId: self, recipientRunId: schemaPeer, kind: 'request', text: 'Is the schema frozen?', createdAt: '2026-10-28T12:00:00Z' }
const reply = { ...envelope, id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', senderRunId: schemaPeer, recipientRunId: self, kind: 'reply', requestId: request.id, text: 'Frozen since Monday.', createdAt: '2026-10-28T12:02:00Z' }
const toDeleted = { ...request, id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', recipientRunId: deletedPeer, text: 'Are you still there?', createdAt: '2026-10-28T12:04:00Z' }
const projection = (message: object) => ({ type: 'conversation-message', message, delivery: 'delivered' })
const events = [
  projection(request),
  { type: 'item.completed', item: { kind: 'message', id: 'independent', role: 'assistant', text: 'Working on the migration while the peer answers.' } },
  projection(reply),
  { type: 'request-outcome', outcome: { requestId: request.id, status: 'replied', replyId: reply.id, observedAt: reply.createdAt } },
  { type: 'ask.requested', requestId: 'ask_1', questions: [{ header: 'Proceed?', question: 'Proceed with the migration?', options: [] }] },
  { type: 'agent-input', input: { id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', text: 'Wave 2 is merged.', source: 'agent', parentRunId: schemaPeer, createdAt: '2026-10-28T12:03:00Z',
    conversation: { senderRunId: schemaPeer, recipientRunId: self, kind: 'progress', relationship: 'peer' } } },
  projection(toDeleted),
  { type: 'request-outcome', outcome: { requestId: toDeleted.id, status: 'deleted', observedAt: '2026-10-28T12:05:00Z' } },
]

let browser: AgentBrowser
let server: ChildProcess
let root: string
let base: string
let project: string
const card = '[data-slot="worker-conversation-card"]'
const peerCard = `${card}[data-relationship="peer"]`
const artifacts = resolve(import.meta.dirname, '../../../.ai/qa/artifacts_e2e/peer-conversation')

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'cezar-peer-cards-'))
  mkdirSync(join(root, '.ai/cezar/runs'), { recursive: true })
  mkdirSync(artifacts, { recursive: true })
  // `deletedPeer` has no record: the run list does not name it and a direct read answers 404.
  writeFileSync(join(root, '.ai/cezar/runs.json'), JSON.stringify([[self, 'Coordinator'], [schemaPeer, 'Schema task']]
    .map(([id, title]) => ({ ...record, id, title, titleSummary: title, task: 'Coordinate the peers.', pullRequestUrl: undefined }))))
  seedTranscript(join(root, '.ai/cezar/runs', `${self}.ndjson`),
    events.map((event, n) => JSON.stringify({ seq: n + 1, ts: '2026-10-28T12:05:00Z', ...event })).join('\n') + '\n')
  server = spawnFixtureServer([cezarCli, 'serve', '--repo', root, '--port', '0', '--no-open'], { env: fixtureServeEnv(root), stdio: 'ignore' })
  base = await waitForFixtureServer(server)
  project = await bootProjectId(base)
  browser = AgentBrowser.open(`e2e-peer-cards-${process.pid}`)
}, 120_000)

afterAll(async () => {
  browser?.close()
  await stopFixtureServer(server)
  if (root) rmSync(root, { recursive: true, force: true })
})

describe('peer messages in the thread', () => {
  for (const variant of contrastQaVariants.filter(v => v.density === 'comfortable')) {
    it(`names, links and separates peer cards from the open question: ${variant.id}`, () => {
      browser.goto(`${base}/p/${project}/tasks/${self}?thread=flat`)
      // The deleted peer's card names it only after the 404, so wait for that text, not the count.
      browser.waitForFunction(`document.querySelectorAll('${peerCard}').length === 4 && document.body.textContent.includes('Deleted task')`)
      applyContrastQaVariant(browser, variant)
      const facts = waitForSettledSample<{ rows: string[]; links: string[]; peerAsUser: boolean; ask: boolean }>(browser, `(() => ({
        rows: [...document.querySelectorAll('${peerCard}')].map(el => el.dataset.kind + ':' + el.dataset.direction),
        links: [...document.querySelectorAll('${peerCard} a')].map(el => el.getAttribute('href')),
        // The one user bubble is the task prompt; no peer text may appear in a user bubble.
        peerAsUser: [...document.querySelectorAll('[data-slot="user-bubble"]')].some(el => /Wave 2|Frozen|schema frozen/.test(el.textContent)),
        ask: document.body.textContent.includes('Proceed with the migration?'),
      }))()`)
      expect(facts.rows).toEqual(['request:outbound', 'reply:inbound', 'progress:inbound', 'request:outbound'])
      // The named peer links to its thread; the deleted one has no link at all.
      expect(new Set(facts.links)).toEqual(new Set([`/p/${project}/tasks/${schemaPeer}`]))
      expect(facts.peerAsUser).toBe(false)
      expect(facts.ask).toBe(true)
      expect(browser.waitForValue<string>(`[...document.querySelectorAll('${peerCard}')].at(-1)?.textContent ?? ''`)).toContain('Recipient deleted')
      for (const selector of [`${peerCard} > div > div > p`, `${peerCard} [data-slot="conversation-relationship"]`, `${peerCard} [data-slot="conversation-outcome"]`]) {
        const contrast = browser.waitForValue<ContrastSample>(contrastSampleExpression(selector))
        expect(contrast.ratio).toBeGreaterThanOrEqual(4.5)
      }
      const bounds = waitForSettledSample<{ overflow: boolean; targets: number[] }>(browser, `(() => ({
        overflow: document.documentElement.scrollWidth > innerWidth || [...document.querySelectorAll('${card}')].some(el => el.scrollWidth > el.clientWidth),
        targets: [...document.querySelectorAll('${peerCard} button, ${peerCard} a')].map(el => el.getBoundingClientRect().height),
      }))()`)
      expect(bounds.overflow).toBe(false)
      expect(bounds.targets.every(height => height >= 44)).toBe(true)
      browser.screenshot(join(artifacts, `${variant.id}-peer-cards.png`), { viewport: true })
    })
  }
})
