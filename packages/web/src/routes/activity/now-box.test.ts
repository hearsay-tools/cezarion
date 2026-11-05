// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { ActivityRun, ActivityWait } from '@open-mercato/cezar-api-client/contract/activity'

import { ACTIVITY_WAIT_KIND, NOW, RUN_STATUS, TOOL_STATUS, iso, run, worker } from './activity.testkit'
import { clockOf } from './activity-format'
import { rootNow, workerLine, type NowBox, type NowContext } from './now-box'

const TITLES: Record<string, string> = { 'peer-a': 'Porting upstream SSE', 'peer-b': 'Fixing flaky shard', 'w-1': 'Dedupe findings' }
const ctx: NowContext = { now: NOW, titleOf: (id) => TITLES[id] ?? 'a task' }

const waiting = (rung: ActivityRun['rung'], wait: ActivityWait, extra: Partial<ActivityRun> = {}) =>
  run({ status: RUN_STATUS.waiting, rung, wait, ...extra })

type Row = [name: string, input: ActivityRun, expected: Partial<NowBox>]

/** The spec's state table (2026-11-05-live-activity-view, "What the user sees"), one row each. */
const STATE_TABLE: Row[] = [
  ['running, a tool in flight', run({ tool: { title: 'Edit workers/spawn.ts', toolKind: 'edit', status: TOOL_STATUS.running, startedAt: iso(-6_000) } }),
    { verb: 'Doing', main: 'Edit workers/spawn.ts', mono: true, detail: 'Last tool 6 s ago', since: iso(-6_000) }],
  ['running, the last tool ended under 10 s ago', run({ tool: { title: 'Read lease.ts', toolKind: 'read', status: TOOL_STATUS.completed, startedAt: iso(-9_000), endedAt: iso(-8_000) } }),
    { verb: 'Doing', main: 'Read lease.ts', detail: 'Last tool 8 s ago' }],
  ['running, the last tool ended over 10 s ago', run({ tool: { title: 'Read lease.ts', toolKind: 'read', status: TOOL_STATUS.completed, startedAt: iso(-30_000), endedAt: iso(-12_000) } }),
    { verb: 'Doing', main: 'Thinking', detail: 'Last tool 12 s ago' }],
  ['running, before the first tool call', run(), { verb: 'Doing', main: 'Thinking' }],
  ['needs you with a question', waiting('needs-you', { kind: ACTIVITY_WAIT_KIND.human, since: iso(-60_000), detail: { reason: 'question', question: 'Accept the live activity prototype?' } }),
    { verb: 'Needs you', main: 'Accept the live activity prototype?', action: 'answer', tone: 'pending' }],
  ['needs you after a plain turn end', waiting('needs-you', { kind: ACTIVITY_WAIT_KIND.human, since: iso(-60_000), detail: { reason: 'turn-end' } }),
    { verb: 'Needs you', main: 'Your turn', action: 'open' }],
  ['needs you with no wait entry', run({ status: RUN_STATUS.waiting, rung: 'needs-you' }), { verb: 'Needs you', main: 'Your turn', action: 'open' }],
  ['needs you: the wake budget is spent', waiting('needs-you', { kind: ACTIVITY_WAIT_KIND.human, since: iso(-60_000), detail: { reason: 'budget', queuedMessages: 2 } }),
    { verb: 'Needs you', main: 'Automatic wakes used up · 2 queued messages', action: 'open' }],
  ['needs permission', run({ rung: 'needs-permission', tool: { title: 'Bash rm -rf dist', toolKind: 'execute', status: TOOL_STATUS.pending, startedAt: iso(-2_000) } }),
    { verb: 'Needs you', main: 'Permission: Bash rm -rf dist', action: 'open' }],
  ['waiting on workers, outcomes only, one entry', waiting('waiting-on-workers', { kind: ACTIVITY_WAIT_KIND.workers, since: iso(-640_000), deadline: iso(1_080_000), detail: { owed: 2, total: 3, settled: 1, mode: 'any', recipientRunIds: [] } }),
    { verb: 'Waiting for workers', main: 'Any of 3 · 1 settled', bar: 1 / 3, detail: `Deadline ${clockOf(iso(1_080_000))}` }],
  ['waiting on workers, several entries', waiting('waiting-on-workers', { kind: ACTIVITY_WAIT_KIND.workers, since: iso(-640_000), detail: { owed: 4, total: 5, settled: 1, recipientRunIds: [] } }),
    { verb: 'Waiting for workers', main: '4 owed', bar: 0.2 }],
  ['waiting on replies from one task', waiting('waiting-on-workers', { kind: ACTIVITY_WAIT_KIND.workers, since: iso(-250_000), deadline: iso(600_000), detail: { owed: 1, total: 1, settled: 0, replies: true, recipientRunIds: ['peer-a'] } }),
    { verb: 'Waiting for reply', main: 'From Porting upstream SSE', detail: `Reply due ${clockOf(iso(600_000))}` }],
  ['waiting on replies from several tasks', waiting('waiting-on-workers', { kind: ACTIVITY_WAIT_KIND.workers, since: iso(-250_000), detail: { owed: 2, total: 2, settled: 0, replies: true, recipientRunIds: ['peer-a', 'peer-b'] } }),
    { verb: 'Waiting for reply', main: 'From 2 tasks' }],
  ['waiting on workers, mixed with replies', waiting('waiting-on-workers', { kind: ACTIVITY_WAIT_KIND.workers, since: iso(-250_000), detail: { owed: 3, total: 4, settled: 1, recipientRunIds: ['peer-a'] } }),
    { verb: 'Waiting for workers', main: '3 owed · 1 settled', bar: 0.25 }],
  ['waiting on subagents', waiting('waiting-on-subagents', { kind: ACTIVITY_WAIT_KIND.subagents, since: iso(-20_000), deadline: iso(300_000), detail: { running: 2 } }),
    { verb: 'Waiting for subagents', main: '2 native subagents' }],
  ['waiting for CI', waiting('waiting-for-ci', {
    kind: ACTIVITY_WAIT_KIND.pr, since: iso(-410_000), deadline: iso(900_000),
    detail: { number: 2724, target: 'checks', checks: [{ name: 'unit', bucket: 'pending' }, { name: 'e2e', bucket: 'pass' }, { name: 'lint', bucket: 'skipping' }], counts: { pass: 6, fail: 0, pending: 3, skipping: 1, cancel: 1 } },
  }), { verb: 'Waiting for CI', main: 'PR 2724 checks · 6 of 9 passed', checks: [{ name: 'e2e', bucket: 'pass' }, { name: 'lint', bucket: 'skipping' }, { name: 'unit', bucket: 'pending' }] }],
  ['waiting for CI before the first progress', waiting('waiting-for-ci', { kind: ACTIVITY_WAIT_KIND.pr, since: iso(-10_000), deadline: iso(900_000), detail: { number: 7, target: 'checks' } }),
    { verb: 'Waiting for CI', main: 'PR 7 checks' }],
  ['waiting for merge', waiting('waiting-for-merge', { kind: ACTIVITY_WAIT_KIND.pr, since: iso(-10_000), deadline: iso(900_000), detail: { number: 7, target: 'merge' } }),
    { verb: 'Waiting for merge', main: 'PR 7', detail: `Deadline ${clockOf(iso(900_000))}` }],
  ['waiting for a command with a note', waiting('waiting-for-command', { kind: ACTIVITY_WAIT_KIND.process, since: iso(-192_000), deadline: iso(600_000), detail: { pid: 4242, note: 'npm run test:e2e' } }),
    { verb: 'Waiting for command', main: 'npm run test:e2e', detail: `Running 3:12 · deadline ${clockOf(iso(600_000))}` }],
  ['waiting for a command without a note', waiting('waiting-for-command', { kind: ACTIVITY_WAIT_KIND.process, since: iso(-1_000), deadline: iso(600_000), detail: { pid: 4242 } }),
    { main: 'Process 4242' }],
  ['monitoring a timer', waiting('monitoring', { kind: ACTIVITY_WAIT_KIND.timer, since: iso(-1_500_000), deadline: iso(1_672_000), detail: { wakeAt: iso(1_672_000), note: 'Re-check npm advisories' } }),
    { verb: 'Waiting for timer', main: 'Re-check npm advisories', detail: `Wakes ${clockOf(iso(1_672_000))} · in 27:52` }],
  ['waiting for a peer', waiting('waiting-on-workers', { kind: ACTIVITY_WAIT_KIND.peers, since: iso(-30_000), deadline: iso(600_000), detail: { peerRunIds: ['peer-b'] } }),
    { verb: 'Waiting for a peer', main: 'For Fixing flaky shard' }],
  ['paused on a usage limit', waiting('usage-limit', { kind: ACTIVITY_WAIT_KIND['usage-limit'], detail: { resumeAt: iso(480_000) } }),
    { verb: 'Paused', main: 'Usage limit', detail: `Resumes ${clockOf(iso(480_000))} · in 8:00` }],
  ['queued', run({ status: RUN_STATUS.queued, rung: 'queued', startedAt: iso(-180_000) }), { verb: 'Queued', main: 'Waiting for a free slot', detail: 'Waiting 3 min' }],
  ['waiting for capacity', run({ status: RUN_STATUS.waiting, rung: 'waiting-for-capacity' }), { verb: 'Queued', main: 'Waiting for a free slot' }],
]

describe('rootNow: the state table', () => {
  it.each(STATE_TABLE)('%s', (_name, input, expected) => {
    expect(rootNow(input, ctx)).toMatchObject(expected)
  })

  it('names no mode when several worker waits are open', () => {
    expect(rootNow(STATE_TABLE.find(([name]) => name === 'waiting on workers, several entries')![1], ctx).main).not.toMatch(/of/)
  })
})

describe('rootNow: a root that is not active work but has live workers (D8)', () => {
  it.each([
    ['review', 'needs-review', 'In review'],
    ['failed', 'failed', 'Failed'],
    ['done', 'done', 'Done'],
    ['cancelled', 'cancelled', 'Cancelled'],
  ] as const)('%s', (status, rung, verb) => {
    const root = run({ status, rung, workers: [worker(), worker({ status: RUN_STATUS.done, rung: 'done' })] })
    expect(rootNow(root, ctx)).toMatchObject({ verb, main: '1 live worker' })
  })
})

describe('workerLine', () => {
  it('uses the short form of the state table', () => {
    const line = workerLine(worker({ tool: { title: 'Read workflows/run.ts', toolKind: 'read', status: TOOL_STATUS.running, startedAt: iso(-1_000) } }), ctx)
    expect(line).toEqual({ verb: 'Doing', tone: 'running', main: 'Read workflows/run.ts', mono: true })
  })

  it('says "Asks parent" with the question, tinted, while the worker asks its parent', () => {
    const line = workerLine(worker({ status: RUN_STATUS.waiting, rung: 'waiting-on-workers' }), ctx, 'Keep 5 cards or show 7?')
    expect(line).toMatchObject({ verb: 'Asks parent', main: '“Keep 5 cards or show 7?”', asks: true })
  })

  it.each([
    ['done, not collected', worker({ status: RUN_STATUS.done, rung: 'done' }), { verb: 'Done', main: 'Ready to collect', tone: 'success' }],
    ['done, collected', worker({ status: RUN_STATUS.done, rung: 'done', collected: true }), { verb: 'Done', main: 'Collected' }],
    ['review', worker({ status: RUN_STATUS.review, rung: 'needs-review' }), { verb: 'In review', main: 'Waiting for the parent’s review', tone: 'info' }],
    ['failed, with its error line', worker({ status: RUN_STATUS.failed, rung: 'failed', error: 'npm test exited 1' }), { verb: 'Failed', main: 'npm test exited 1', tone: 'danger' }],
    ['cancelled', worker({ status: RUN_STATUS.cancelled, rung: 'cancelled' }), { verb: 'Cancelled', main: 'Cancelled', tone: 'neutral' }],
  ] as const)('a settled worker: %s', (_name, input, expected) => {
    expect(workerLine(input, ctx)).toMatchObject(expected)
  })

  it('never says "Asks parent" for a settled worker', () => {
    expect(workerLine(worker({ status: RUN_STATUS.done, rung: 'done' }), ctx, 'late question').verb).toBe('Done')
  })
})
