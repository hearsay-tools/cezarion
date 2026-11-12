import { execFileSync, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RUN_STATUS, WAIT_KIND, WAIT_PHASE, WAIT_SOURCE, WAIT_VIA } from '@open-mercato/cezar-api-client/contract/test-factories.testkit'
import type { RunRecord } from '@open-mercato/cezar-api-client/contract/runs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDeliveryControl } from '../../cezar/scripts/mock-delivery-control.mjs'
import { AgentBrowser, bootProjectId, squawkCli, fixtureServeEnv } from './agent-browser'
import { spawnFixtureServer, stopFixtureServer, waitForFixtureServer } from './fixture-server'
import { pollFor, waitForStatus } from './poll'
import { seedRuns } from './seed-runs'
// fixture-server starts: 1

/**
 * The live activity view (spec .ai/specs/2026-11-05-live-activity-view.md, slice S8) on a real
 * dry-run cockpit. The store holds a peer request between two root tasks, a root that waits on a
 * peer (`cez message wait --peer`) and a worker that asks its parent; a live task runs and holds
 * its turn. The test reads the cards' now-box verbs, the text form of the lines (never their
 * geometry), whether the wait line is drawn, and the rail's open requests. Then it closes the peer
 * request through the cockpit's own route and waits until the view drops the line and the rail
 * entry, with no reload: the activity topic carries the change.
 *
 * Not covered here, on purpose:
 * - A CI wait. The dry-run `gh` answers every check as passed and `--watch` exits at once, so a
 *   seeded open PR wait resolves within seconds of boot. The CI now box is covered by the now-box
 *   unit tests (`packages/web/src/routes/activity/now-box.test.ts`).
 * - The reply comet. A reply needs a live agent session's delegation token. This test closes the
 *   request by cancelling its recipient (outcome `cancelled`: the leave path). The motion unit
 *   tests of slice S6 cover the reply comet.
 */

const HOLD = 'activity-e2e-hold'
const hourAhead = new Date(Date.now() + 3_600_000).toISOString()
const minuteAgo = new Date(Date.now() - 60_000).toISOString()
const WAIT_SECONDS = 1800

const senderId = randomUUID()
const recipientId = randomUUID()
const parentId = randomUUID()
const workerId = randomUUID()
const waiterId = randomUUID()
const titles = {
  sender: 'Schema migration',
  recipient: 'API contract review',
  waiter: 'Schema rollout',
  parent: 'Parser coordinator',
  worker: 'Parser worker',
}

const peerRequest = {
  id: randomUUID(), senderRunId: senderId, recipientRunId: recipientId, kind: 'request', relationship: 'peer',
  text: 'Is the API contract frozen?', createdAt: minuteAgo, deadline: hourAhead, requestHash: 'a'.repeat(64), state: 'accepted',
} as const
// A routed worker question carries no deadline.
const familyRequest = {
  id: randomUUID(), senderRunId: workerId, recipientRunId: parentId, kind: 'request',
  text: 'Which parser entry point should I keep?', createdAt: minuteAgo, requestHash: 'b'.repeat(64), state: 'accepted',
} as const

type RootDelegation = Extract<NonNullable<RunRecord['delegation']>, { role: 'root' }>
type WorkerWait = NonNullable<RootDelegation['wait']>
/** A parked wait far from its deadline: recovery re-arms it, and nothing resolves it while the test runs. */
const parked = (target: Pick<WorkerWait, 'workerIds'> & Partial<Pick<WorkerWait, 'requestIds'>>): WorkerWait =>
  ({ id: randomUUID(), deadline: hourAhead, phase: 'parked', outcomes: [], ...target })
const record = (id: string, title: string, extra: Partial<RunRecord>) =>
  ({ id, title, titleSummary: title, task: title, workflow: 'quick-task', runner: 'claude', status: RUN_STATUS.waiting, createdAt: minuteAgo, tokensUsed: 0, steps: [], ...extra } satisfies Partial<RunRecord>)

let root: string
let controlRoot: string
let server: ChildProcess
let base: string
let project: string
let browser: AgentBrowser
let runningId: string
let releaseHold: (() => void) | undefined

beforeAll(async () => {
  const deadline = Date.now() + 140_000
  root = mkdtempSync(join(tmpdir(), 'cezar-e2e-activity-'))
  controlRoot = mkdtempSync(join(tmpdir(), 'cezar-e2e-activity-control-'))
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args])
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'e2e@cezar.test')
  git('config', 'user.name', 'cezar e2e')
  writeFileSync(join(root, 'README.md'), '# activity e2e fixture repo\n', 'utf8')
  git('add', '.')
  git('commit', '-qm', 'init')
  mkdirSync(join(root, '.ai/cezar/runs'), { recursive: true })
  seedRuns(root, [
    // Waits for the peer's reply: "Waiting for reply".
    record(senderId, titles.sender, {
      delegation: { role: 'root', permissions: [], receipts: [], conversation: { messages: [peerRequest], outcomes: [] }, wait: parked({ workerIds: [], requestIds: [peerRequest.id] }) },
    }),
    // Owes the reply and asks the user: "Needs you".
    record(recipientId, titles.recipient, {
      delegation: { role: 'root', permissions: [], receipts: [] },
      waits: [{ id: randomUUID(), kind: WAIT_KIND.human, source: WAIT_SOURCE.agent, via: WAIT_VIA['ask-line'], registeredAt: minuteAgo, phase: WAIT_PHASE.open, turnId: 'turn-1',
        questions: [{ header: 'Scope', question: 'Ship the contract before the migration?' }] }],
    }),
    // Waits for the recipient to write or settle: "Waiting for a peer", and a wait line.
    record(waiterId, titles.waiter, {
      delegation: { role: 'root', permissions: [], receipts: [] },
      waits: [{ id: randomUUID(), kind: WAIT_KIND.peer, source: WAIT_SOURCE.agent, via: WAIT_VIA.cezar_wait, registeredAt: minuteAgo, phase: WAIT_PHASE.open, turnId: 'turn-1',
        deadline: new Date(Date.parse(minuteAgo) + WAIT_SECONDS * 1000).toISOString(), timeoutSeconds: WAIT_SECONDS, peerIds: [recipientId] }],
    }),
    // Waits for its worker, which asks it a question: "Waiting for workers" and "Asks parent".
    record(parentId, titles.parent, {
      delegation: {
        role: 'root', permissions: [], receipts: [{ workerId, requestId: randomUUID(), requestHash: 'c'.repeat(64) }],
        conversation: { messages: [familyRequest], outcomes: [] }, wait: parked({ workerIds: [workerId] }),
      },
    }),
    record(workerId, titles.worker, {
      delegation: {
        role: 'worker', parentRunId: parentId, permissions: [],
        workspace: { ownerRunId: workerId, resourceId: randomUUID(), kind: 'owned-isolated', path: join(root, '.ai/cezar/worktrees', workerId), branch: `cez/${workerId.slice(0, 8)}`, baselineSha: 'a'.repeat(40) },
        wait: parked({ workerIds: [], requestIds: [familyRequest.id] }),
      },
    }),
  ])
  // The running task's mock holds its turn until the test releases it, so the task stays
  // `running` for the whole spec without a timed turn.
  const control = createDeliveryControl(controlRoot, { kind: 'hold-response', match: HOLD })
  releaseHold = control.release
  server = spawnFixtureServer([squawkCli, 'serve', '--repo', root, '--port', '0', '--no-open'],
    { env: fixtureServeEnv(root, { CEZ_MOCK_DELIVERY_CONTROL: control.path }), stdio: 'ignore' }, { deadline })
  base = await waitForFixtureServer(server)
  project = await bootProjectId(base)
  const created = await fetch(`${base}/api/v1/runs`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ task: `${HOLD}: keep this task running`, workflow: 'quick-task' }),
  })
  runningId = ((await created.json()) as { id: string }).id
  await waitForStatus(base, runningId, ['running'], { deadline })
  await pollFor(async () => control.held() || undefined, () => 'cezar e2e: the running task never reached its held turn', { deadline })
  browser = AgentBrowser.open(`e2e-activity-${process.pid}`)
  browser.setViewport(1440, 900)
}, 180_000)

afterAll(async () => {
  releaseHold?.()
  browser?.close()
  await stopFixtureServer(server)
  for (const dir of [root, controlRoot]) if (dir) rmSync(dir, { recursive: true, force: true })
})

type CardFacts = { verb: string | null; lines: string[] }
type BoardFacts = {
  cards: Record<'sender' | 'recipient' | 'waiter' | 'parent' | 'running', CardFacts | null>
  waitLine: boolean
  worker: { line: string; lines: string[] } | null
  rail: { id: string; text: string }[]
  openChip: string | null
}

/** One page read of the project board: each card's verb and the text form of its own lines (not
 *  its workers'), whether the peer-wait line is drawn, the worker row, the rail's open requests
 *  and the open-requests chip. */
const board = () => {
  return `(() => {
  const ids = ${JSON.stringify({ sender: senderId, recipient: recipientId, waiter: waiterId, parent: parentId, running: runningId })};
  const texts = (el, selector) => [...el.querySelectorAll(selector)].map(li => li.textContent.trim());
  const card = id => {
    const el = document.querySelector('[data-activity-card="' + id + '"]');
    return el ? {
      verb: el.querySelector('[data-slot="activity-verb"]')?.textContent?.trim() ?? null,
      lines: texts(el, ':scope > [data-slot="activity-line-text"] li'),
    } : null;
  };
  const row = document.querySelector('[data-slot="activity-worker"][data-run="${workerId}"]');
  return {
    cards: Object.fromEntries(Object.entries(ids).map(([key, id]) => [key, card(id)])),
    waitLine: document.querySelector('path[data-wait="wait:${waiterId}:${recipientId}"]') !== null,
    worker: row ? {
      line: row.querySelector('[data-slot="activity-worker-line"]')?.textContent?.trim() ?? '',
      lines: texts(row, '[data-slot="activity-line-text"] li'),
    } : null,
    rail: [...document.querySelectorAll('[data-slot="activity-open-requests"] [data-slot="activity-request"]')]
      .map(entry => ({ id: entry.dataset.request, text: entry.textContent })),
    openChip: document.querySelector('[data-slot="activity-chip"][data-chip="open requests"] strong')?.textContent ?? null,
  };
})()`
}

describe('activity view', () => {
  it('shows the cards, the lines and the open requests, and drops a request when it closes', async () => {
    browser.goto(`${base}/p/${project}/activity`)
    const before = browser.waitForValue<BoardFacts>(board(), facts =>
      facts !== null && Object.values(facts.cards).every(card => card !== null) && facts.worker !== null && facts.rail.length === 2,
    { failure: 'the activity board never showed every card, the worker row and two open requests' })

    expect(before.cards.running?.verb).toBe('Doing')
    expect(before.cards.sender).toEqual({ verb: 'Waiting for reply', lines: [`Waiting for a reply from ${titles.recipient}`] })
    expect(before.cards.recipient).toEqual({ verb: 'Needs you', lines: [`${titles.sender} waits for your reply`, `${titles.waiter} waits for you to write`] })
    expect(before.cards.waiter).toEqual({ verb: 'Waiting for a peer', lines: [`Waiting for a message from ${titles.recipient}`] })
    expect(before.waitLine).toBe(true)
    expect(before.cards.parent).toEqual({ verb: 'Waiting for workers', lines: [`${titles.worker} waits for your reply`] })
    expect(before.worker?.line).toContain('Asks parent')
    expect(before.worker?.line).toContain(familyRequest.text)
    expect(before.worker?.lines).toEqual([`Waiting for a reply from ${titles.parent}`])
    expect(new Set(before.rail.map(entry => entry.id))).toEqual(new Set([peerRequest.id, familyRequest.id]))
    expect(before.rail.find(entry => entry.id === peerRequest.id)?.text).toContain(peerRequest.text)
    expect(before.rail.find(entry => entry.id === familyRequest.id)?.text).toContain(familyRequest.text)
    expect(before.openChip).toBe('2')

    // Cancelling the recipient stores `cancelled` in the sender's ledger, and the topic sends the
    // next snapshot. The view must drop the line and the rail entry without a reload.
    const cancelled = await fetch(`${base}/api/v1/runs/${recipientId}/cancel`, { method: 'POST' })
    expect(cancelled.ok).toBe(true)
    await waitForStatus(base, recipientId, ['cancelled'])
    const after = browser.waitForValue<BoardFacts>(board(), facts =>
      facts !== null && facts.cards.recipient === null && facts.rail.length === 1 && facts.cards.sender !== null && facts.cards.sender.lines.length === 0,
    { failure: 'the closed peer request never left the activity view' })

    expect(after.rail.map(entry => entry.id)).toEqual([familyRequest.id])
    expect(after.cards.parent?.lines).toEqual([`${titles.worker} waits for your reply`])
    expect(after.worker?.lines).toEqual([`Waiting for a reply from ${titles.parent}`])
    expect(after.openChip).toBe('1')
  })

  it('lists the project as a panel of pills in the global view, and the scope switch moves between views', () => {
    browser.goto(`${base}/activity`)
    const panel = `[data-slot="activity-panel"][data-project="${project}"]`
    const pills = browser.waitForValue<Record<string, string | null>>(`(() => {
      const panel = document.querySelector(${JSON.stringify(panel)});
      if (!panel) return null;
      const verb = id => panel.querySelector('[data-activity-pill="' + id + '"] [data-slot="activity-verb"]')?.textContent?.trim() ?? null;
      const facts = { running: verb(${JSON.stringify(runningId)}), parent: verb(${JSON.stringify(parentId)}), sender: verb(${JSON.stringify(senderId)}) };
      return Object.values(facts).every(Boolean) ? facts : null;
    })()`, undefined, { failure: 'the global view never listed the project panel with its pills' })
    expect(pills.running).toBe('Doing')
    expect(pills.parent).toBe('Waiting for workers')

    browser.click(`[data-slot="activity-scope"] a[href="/p/${project}/activity"]`)
    expect(browser.waitForValue<string>(`document.querySelector('[data-route="activity"] [data-activity-card="${parentId}"]') ? location.pathname : null`))
      .toBe(`/p/${project}/activity`)
    browser.click('[data-slot="activity-scope"] a[href="/activity"]')
    expect(browser.waitForValue<string>(`document.querySelector('[data-route="activity-global"] ${panel}') ? location.pathname : null`))
      .toBe('/activity')
  })
})
