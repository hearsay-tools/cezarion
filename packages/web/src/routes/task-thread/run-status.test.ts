import { describe, expect, it } from 'vitest'
import { openHumanWait } from '@/test/run-summary-fixture'

import type { ApiRun, RunStatus } from '@open-mercato/cezar-api-client'

import { runStatusLine, statusLineText } from './run-status'

type CiEntry = Extract<NonNullable<ApiRun['waits']>[number], { kind: 'pr' }>
type TimerEntry = Extract<NonNullable<ApiRun['waits']>[number], { kind: 'timer' }>

const run = (status: RunStatus, extra: Partial<ApiRun> = {}): ApiRun => ({
  id: 'r1',
  title: 'Do the thing',
  workflow: 'quick-task',
  task: 'Do the thing.',
  status,
  createdAt: '2026-10-20T12:00:00.000Z',
  tokensUsed: 0,
  archived: false,
  steps: [],
  ...extra,
})

const ciEntry = (extra: Partial<CiEntry> = {}): CiEntry => ({
  id: '00000000-0000-4000-8000-000000000474', kind: 'pr', source: 'agent', via: 'cezar_wait',
  generation: 'session-1', turnId: 'turn-1', timeoutSeconds: 1800, until: 'checks' as const, wakeOnConflict: true,
  prUrl: 'https://github.com/owner/repo/pull/474', repository: 'owner/repo', prNumber: 474,
  headSha: '123456789abcdef', registeredAt: '2026-10-20T12:00:00.000Z',
  deadline: '2026-10-20T12:30:00.000Z', phase: 'open', ...extra,
})

const timerEntry = (extra: Partial<TimerEntry> = {}): TimerEntry => ({
  id: '00000000-0000-4000-8000-000000000005', kind: 'timer', source: 'agent', via: 'cezar_wait',
  turnId: 'turn-1', seconds: 300, registeredAt: '2026-10-20T12:00:00.000Z',
  deadline: '2026-10-20T12:15:00.000Z', phase: 'open', ...extra,
})

const shortTime = (iso: string) => new Intl.DateTimeFormat(undefined, { timeStyle: 'short' }).format(new Date(iso))
const now = new Date('2026-10-20T12:01:00.000Z')

describe('runStatusLine', () => {
  it('sentence-cases the attention label and appends the queue position', () => {
    expect(runStatusLine(run('running'), { now }).label).toBe('Running')
    expect(runStatusLine(run('queued'), { queuePosition: 2, now }).label).toBe('Queued #2')
    expect(runStatusLine(run('waiting', { waits: [ciEntry()] }), { now }).label).toBe('Waiting for CI')
  })

  it('names the earliest open timer as next check', () => {
    const line = runStatusLine(run('waiting', { waits: [
      ciEntry(),
      timerEntry({ id: '00000000-0000-4000-8000-000000000006', deadline: '2026-10-20T12:45:00.000Z' }),
      timerEntry(),
    ] }), { now })
    expect(line.nextCheck).toEqual({ at: '2026-10-20T12:15:00.000Z', text: shortTime('2026-10-20T12:15:00.000Z') })
    expect(statusLineText(line)).toBe(`Waiting for CI · Next check ${shortTime('2026-10-20T12:15:00.000Z')}`)
  })

  it('never treats a CI deadline as a next check', () => {
    const line = runStatusLine(run('waiting', { waits: [ciEntry()] }), { now })
    expect(line.nextCheck).toBeUndefined()
    expect(statusLineText(line)).toBe('Waiting for CI')
  })

  it('drops next check for a resolved timer and for a terminal run', () => {
    expect(runStatusLine(run('waiting', { waits: [timerEntry({ phase: 'resolved' })] }), { now }).nextCheck).toBeUndefined()
    expect(runStatusLine(run('done', { waits: [timerEntry()] }), { now }).nextCheck).toBeUndefined()
    expect(runStatusLine(run('waiting', { waits: [timerEntry({ deadline: 'not a date' })] }), { now }).nextCheck).toBeUndefined()
  })

  it('formats a next-day check with its date', () => {
    const deadline = '2026-10-22T09:30:00.000Z'
    const line = runStatusLine(run('waiting', { waits: [timerEntry({ deadline })] }), { now })
    expect(line.nextCheck?.text).toBe(
      new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(deadline)),
    )
  })

  it('reads a pending human ask over the wait it parked on', () => {
    expect(runStatusLine(run('waiting', { waits: [ciEntry(), openHumanWait()] }), { now }).label).toBe('Needs you')
  })
})
