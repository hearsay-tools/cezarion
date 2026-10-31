import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ApiRun, RunStatus, StepState } from '@open-mercato/cezar-api-client'

import { makePeerWait, RUN_STATUS, WAIT_PHASE } from '@open-mercato/cezar-api-client/contract/test-factories.testkit'
import { RunWaitDetails, hasWaitDetails } from './run-waits'

/** The run's wait details, which moved from the run header into the Session activity card's
 *  first row (hearsay-tools/cezarion#1333). The status label itself is `run-status.test.ts`'s. */

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const step = (extra: Partial<StepState> = {}): StepState => ({
  id: 'task',
  name: 'Do the task',
  kind: 'agent',
  status: 'done',
  iterations: 1,
  tokensUsed: 0,
  ...extra,
})

const run = (status: RunStatus, extra: Partial<ApiRun> = {}): ApiRun => ({
  id: 'r1',
  title: 'do the thing plz',
  workflow: 'quick-task',
  task: 'Summarize what this project does.',
  status,
  createdAt: '2026-07-14T12:00:00.000Z',
  tokensUsed: 0,
  archived: false,
  steps: [step({ sessionId: 'sess-1' })],
  ...extra,
})

function renderWaits(record: ApiRun) {
  return render(<RunWaitDetails run={record} />)
}

describe('RunWaitDetails', () => {
  type CiEntry = Extract<NonNullable<ApiRun['waits']>[number], { kind: 'pr' }>
  type TimerEntry = Extract<NonNullable<ApiRun['waits']>[number], { kind: 'timer' }>
  const ciEntry = (extra: Partial<CiEntry> = {}): CiEntry => ({
    id: '00000000-0000-4000-8000-000000000474', kind: 'pr', source: 'agent', via: 'cezar_wait',
    generation: 'session-1', turnId: 'turn-1', timeoutSeconds: 1800, until: 'checks' as const, wakeOnConflict: true,
    prUrl: 'https://github.com/owner/repo/pull/474', repository: 'owner/repo', prNumber: 474,
    headSha: '123456789abcdef', registeredAt: '2026-09-22T12:00:00.000Z',
    deadline: '2026-09-22T12:30:00.000Z', phase: 'open', ...extra,
  })
  const timerEntry = (extra: Partial<TimerEntry> = {}): TimerEntry => ({
    id: '00000000-0000-4000-8000-000000000005', kind: 'timer', source: 'agent', via: 'cezar_wait',
    turnId: 'turn-1', seconds: 300, registeredAt: '2026-09-22T12:00:00.000Z',
    deadline: '2026-09-22T12:05:00.000Z', phase: 'open', ...extra,
  })
  const observed = (outcome: NonNullable<CiEntry['result']>['outcome']): CiEntry['result'] => ({
    outcome, headSha: '123456789abcdef', observedHeadSha: 'fedcba987654321',
    observedAt: '2026-09-22T12:02:00.000Z', checks: [], totalChecks: 0, truncated: false,
  })
  const ciItems = () => [...document.querySelectorAll<HTMLElement>('[data-slot="ci-wait-status"]')]
  const timerItems = () => [...document.querySelectorAll<HTMLElement>('[data-slot="monitoring-schedule"]')]

  it('lists every open wait: CI with its PR link and deadline, timer with its time and note', () => {
    renderWaits(run('waiting', { waits: [
      ciEntry(),
      ciEntry({ id: '00000000-0000-4000-8000-000000000475', prUrl: 'https://github.com/owner/other/pull/12',
        repository: 'owner/other', prNumber: 12, deadline: '2026-09-22T13:00:00.000Z' }),
      timerEntry({ note: 'Re-check the staging deploy' }),
    ] }))
    expect(ciItems()).toHaveLength(2)
    expect(ciItems().map(item => item.getAttribute('role'))).toEqual(['status', 'status'])
    expect(ciItems().map(item => item.querySelector('time')?.getAttribute('datetime')))
      .toEqual(['2026-09-22T12:30:00.000Z', '2026-09-22T13:00:00.000Z'])
    expect(screen.getAllByText('Waiting for CI')).toHaveLength(2)
    const link = screen.getByRole('link', { name: 'owner/repo#474' })
    expect(link.getAttribute('href')).toBe('https://github.com/owner/repo/pull/474')
    link.focus()
    expect(document.activeElement).toBe(link)
    expect(screen.getByRole('link', { name: 'owner/other#12' }).getAttribute('href')).toBe('https://github.com/owner/other/pull/12')
    expect(timerItems()).toHaveLength(1)
    expect(timerItems()[0]?.textContent).toContain('Next automatic check')
    expect(timerItems()[0]?.querySelector('time')?.getAttribute('datetime')).toBe('2026-09-22T12:05:00.000Z')
    expect(screen.getByText('Re-check the staging deploy')).not.toBeNull()
    expect(screen.queryByText(/waiting for capacity/)).toBeNull()
  })

  it('lists an open worker wait with its deadline', () => {
    type WorkerEntry = Extract<NonNullable<ApiRun['waits']>[number], { kind: 'worker' }>
    const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
    const base = {
      kind: 'worker', source: 'agent', via: 'cez-worker-wait', turnId: 'turn-1', timeoutSeconds: 600,
      registeredAt: '2026-09-22T12:00:00.000Z', deadline: '2026-09-22T12:10:00.000Z', mode: 'any',
    } as const
    const byWorker = {
      ...base, id: uuid(61), phase: 'open', workerIds: [uuid(1), uuid(2)],
      revisions: [{ workerId: uuid(1), revision: 0 }, { workerId: uuid(2), revision: 0 }], outcomes: [],
    } as WorkerEntry
    const byRequest = {
      ...base, id: uuid(62), phase: 'open', deadline: '2026-09-22T12:20:00.000Z', requestIds: [uuid(3)], requestOutcomes: [],
    } as WorkerEntry
    const settled = {
      ...base, id: uuid(63), phase: 'cancelled', cancelledAt: '2026-09-22T12:01:00.000Z', workerIds: [uuid(4)],
      revisions: [{ workerId: uuid(4), revision: 0 }], outcomes: [],
    } as WorkerEntry
    renderWaits(run('waiting', { waits: [byWorker, byRequest, settled] }))
    const items = [...document.querySelectorAll<HTMLElement>('[data-slot="worker-wait-status"]')]
    expect(items.map(item => item.querySelector('p')?.textContent)).toEqual(['Waiting on 2 workers', 'Waiting on 1 request reply'])
    expect(items.map(item => item.querySelector('time')?.getAttribute('datetime')))
      .toEqual(['2026-09-22T12:10:00.000Z', '2026-09-22T12:20:00.000Z'])
  })

  it('counts only the targets not yet reported, and hides a resolved worker entry', () => {
    type WorkerEntry = Extract<NonNullable<ApiRun['waits']>[number], { kind: 'worker' }>
    const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
    const base = {
      kind: 'worker', source: 'agent', via: 'cez-worker-wait', turnId: 'turn-1', timeoutSeconds: 600,
      registeredAt: '2026-09-22T12:00:00.000Z', deadline: '2026-09-22T12:10:00.000Z', mode: 'all',
    } as const
    const partialWorkers = {
      ...base, id: uuid(71), phase: 'open', workerIds: [uuid(1), uuid(2), uuid(3)],
      revisions: [uuid(1), uuid(2), uuid(3)].map(workerId => ({ workerId, revision: 0 })),
      outcomes: [{ workerId: uuid(1), status: 'done' }],
    } as unknown as WorkerEntry
    const partialRequests = {
      ...base, id: uuid(72), phase: 'open', requestIds: [uuid(4), uuid(5)],
      requestOutcomes: [{ requestId: uuid(4), status: 'replied' }],
    } as unknown as WorkerEntry
    const resolved = {
      ...base, id: uuid(73), phase: 'resolved', resolvedAt: '2026-09-22T12:01:00.000Z', result: { reason: 'outcome' },
      workerIds: [uuid(6)], revisions: [{ workerId: uuid(6), revision: 0 }], outcomes: [],
    } as unknown as WorkerEntry
    renderWaits(run('waiting', { waits: [partialWorkers, partialRequests, resolved] }))
    const items = [...document.querySelectorAll<HTMLElement>('[data-slot="worker-wait-status"]')]
    expect(items.map(item => item.querySelector('p')?.textContent)).toEqual(['Waiting on 2 workers', 'Waiting on 1 request reply'])
  })

  // hearsay-tools/cezarion#1995: a peer wait lists its peer tasks while it is open.
  it('lists an open peer wait with its task count and deadline, and hides it once resolved', () => {
    const peerIds = ['00000000-0000-4000-8000-000000000081', '00000000-0000-4000-8000-000000000082']
    const open = makePeerWait({ peerIds, deadline: '2026-09-22T12:10:00.000Z' })
    const resolved = makePeerWait({ phase: WAIT_PHASE.resolved, resolvedAt: '2026-09-22T12:01:00.000Z', result: { reason: 'timeout' } })
    renderWaits(run(RUN_STATUS.waiting, { waits: [open, resolved] }))
    const items = [...document.querySelectorAll<HTMLElement>('[data-slot="peer-wait-status"]')]
    expect(items.map(item => item.querySelector('p')?.textContent)).toEqual(['Waiting on 2 tasks'])
    expect(items[0]?.querySelector('time')?.getAttribute('datetime')).toBe('2026-09-22T12:10:00.000Z')
  })

  it('reads a run with only a timer open as monitoring, without a note line when there is none', () => {
    renderWaits(run('waiting', { waits: [timerEntry()] }))
    expect(ciItems()).toHaveLength(0)
    expect(timerItems()).toHaveLength(1)
    expect(timerItems()[0]?.querySelectorAll('p')).toHaveLength(1)
  })

  it.each([
    ['running', 'CI result ready — current turn still working', 'Automatic check due — current turn still working'],
    ['waiting', 'CI result ready — waiting for capacity', 'Automatic check due — waiting for capacity'],
    ['queued', 'CI result ready — waiting for capacity', 'Automatic check due — waiting for capacity'],
  ] as const)('describes a resolved wait honestly while %s', (status, ciLabel, timerLabel) => {
    renderWaits(run(status, { waits: [
      ciEntry({ phase: 'resolved', result: observed('passed') }),
      timerEntry({ phase: 'resolved', note: 'Look at the deploy' }),
    ] }))
    expect(screen.getByText(ciLabel)).not.toBeNull()
    expect(screen.getByRole('link', { name: 'owner/repo#474' })).not.toBeNull()
    expect(screen.getByText(timerLabel)).not.toBeNull()
    expect(screen.getByText('Look at the deploy')).not.toBeNull()
    expect(screen.queryByText(/Next automatic check/)).toBeNull()
  })

  it.each([
    ['passed', 'CI checks passed — observed checks only; not merge approval'],
    ['failed', 'CI checks failed — inspect the PR checks'],
    ['cancelled', 'CI wait cancelled'],
    ['skipped', 'CI checks skipped — inspect the PR checks'],
    ['no_checks', 'No CI checks found — inspect the PR workflows'],
    ['conflicting', 'PR has merge conflicts — inspect the PR; not merge approval'],
    ['deadline', 'CI wait timed out — inspect the PR checks'],
    ['error', 'CI wait unavailable — inspect access and the PR checks'],
    ['head_changed', 'CI head changed — 1234567 → fedcba9'],
  ] as const)('shows the last settled CI observation when nothing is open (%s)', (outcome, label) => {
    renderWaits(run('done', { lastWaits: [ciEntry({ phase: 'delivered', result: observed(outcome) })] }))
    expect(screen.getByText(label)).not.toBeNull()
    expect(screen.getByRole('link', { name: 'owner/repo#474' })).not.toBeNull()
    expect(ciItems()).toHaveLength(1)
    expect(ciItems()[0]?.textContent).toContain('Observed')
    expect(ciItems()[0]?.querySelector('time')?.getAttribute('datetime')).toBe('2026-09-22T12:02:00.000Z')
  })

  it('shows the newest settled CI wait, past a newer settled timer, beside an open timer', () => {
    renderWaits(run('waiting', {
      waits: [timerEntry({ id: '00000000-0000-4000-8000-000000000007', deadline: '2026-09-22T12:20:00.000Z' })],
      lastWaits: [
        ciEntry({ id: '00000000-0000-4000-8000-000000000001', phase: 'delivered', result: observed('passed') }),
        ciEntry({ id: '00000000-0000-4000-8000-000000000002', phase: 'delivered', result: observed('failed') }),
        timerEntry({ id: '00000000-0000-4000-8000-000000000006', phase: 'delivered', deliveredAt: '2026-09-22T12:10:00.000Z' }),
      ],
    }))
    expect(screen.getByText('CI checks failed — inspect the PR checks')).not.toBeNull()
    expect(screen.queryByText(/CI checks passed/)).toBeNull()
    expect(ciItems()).toHaveLength(1)
    expect(timerItems()).toHaveLength(1)
    expect(timerItems()[0]?.querySelector('time')?.getAttribute('datetime')).toBe('2026-09-22T12:20:00.000Z')
  })

  it('shows a new wait instead of a stale previous success', () => {
    renderWaits(run('waiting', { waits: [ciEntry()], lastWaits: [ciEntry({
      id: '00000000-0000-4000-8000-000000000001', phase: 'delivered', result: observed('passed'),
    })] }))
    expect(screen.getByText('Waiting for CI')).not.toBeNull()
    expect(screen.queryByText(/CI checks passed/)).toBeNull()
  })

  it('shows a cancelled wait as cancelled even when it carried a result, with when it was cancelled', () => {
    renderWaits(run('waiting', { lastWaits: [ciEntry({
      phase: 'cancelled', cancelledAt: '2026-09-22T12:03:00.000Z', result: observed('passed'),
    })] }))
    expect(screen.getByText('CI wait cancelled')).not.toBeNull()
    expect(screen.queryByText(/CI checks passed/)).toBeNull()
    expect(ciItems()[0]?.textContent).toContain('Cancelled')
    expect(ciItems()[0]?.querySelector('time')?.getAttribute('datetime')).toBe('2026-09-22T12:03:00.000Z')
    // Human input no longer withdraws a CI wait, so the old withdrawal advice has no case left.
    expect(screen.queryByText(/General monitoring does not restart/)).toBeNull()
    expect(screen.queryByText(/A new CI wait is needed/)).toBeNull()
  })

  it('shows lastWaitsError when a saved wait was unreadable', () => {
    renderWaits(run('done', { lastWaitsError: 'CI wait unavailable — saved observation is unreadable; register a new wait.' }))
    expect(screen.getByText(/saved observation is unreadable/)).not.toBeNull()
    expect(ciItems()[0]?.getAttribute('role')).toBe('status')
    expect(screen.queryByRole('link', { name: 'owner/repo#474' })).toBeNull()
  })

  it('keeps the last snapshot visible offline and falls back for an invalid deadline', () => {
    vi.stubGlobal('navigator', { ...navigator, onLine: false })
    renderWaits(run('waiting', { waits: [ciEntry({ deadline: 'invalid' }), timerEntry({ deadline: 'invalid' })] }))
    expect(screen.getByText('Waiting for CI')).not.toBeNull()
    expect(screen.getByText('CI deadline unavailable')).not.toBeNull()
    expect(screen.getByText('Automatic check time unavailable')).not.toBeNull()
    expect(screen.queryByText(/Invalid Date/)).toBeNull()
  })

  it('shows no open wait on a finished run, and skips kinds this cockpit does not render', () => {
    const { unmount } = renderWaits(run('done', { waits: [ciEntry(), timerEntry()] }))
    expect(screen.queryByText('Waiting for CI')).toBeNull()
    expect(timerItems()).toHaveLength(0)
    unmount()

    // A later phase adds human and worker waits; an older header leaves them to the pill.
    const later = { id: '00000000-0000-4000-8000-000000000009', kind: 'human', phase: 'open' } as unknown as CiEntry
    renderWaits(run('waiting', { waits: [later, timerEntry()] }))
    expect(ciItems()).toHaveLength(0)
    expect(timerItems()).toHaveLength(1)
  })

  // hearsay-tools/cezarion#1446: a process wait names its PID, its note and deadline, then its outcome.
  describe('process waits', () => {
    type ProcessEntry = Extract<NonNullable<ApiRun['waits']>[number], { kind: 'process' }>
    const processEntry = (extra: Partial<ProcessEntry> = {}): ProcessEntry => ({
      id: '00000000-0000-4000-8000-000000001446', kind: 'process', source: 'agent', via: 'cezar_wait',
      turnId: 'turn-1', timeoutSeconds: 1800, pid: 4242, registeredAt: '2026-09-22T12:00:00.000Z',
      deadline: '2026-09-22T12:30:00.000Z', phase: 'open', ...extra,
    })
    const result = (outcome: NonNullable<ProcessEntry['result']>['outcome'], extra: Partial<NonNullable<ProcessEntry['result']>> = {}) =>
      ({ outcome, observedAt: '2026-09-22T12:10:00.000Z', ...extra })
    const processItems = () => [...document.querySelectorAll<HTMLElement>('[data-slot="process-wait-status"]')]

    it('lists an open process wait with its PID, note and deadline', () => {
      renderWaits(run('waiting', { waits: [processEntry({ note: 'npm run build' })] }))
      expect(processItems()).toHaveLength(1)
      expect(processItems()[0]?.getAttribute('role')).toBe('status')
      expect(processItems()[0]?.querySelector('p')?.textContent).toBe('Waiting for PID 4242 — npm run build')
      expect(processItems()[0]?.querySelector('time')?.getAttribute('datetime')).toBe('2026-09-22T12:30:00.000Z')
      expect(hasWaitDetails(run('waiting', { waits: [processEntry()] }))).toBe(true)
    })

    it('says a resolved process wait is owed to the agent', () => {
      renderWaits(run('waiting', { waits: [processEntry({ phase: 'resolved', result: result('exit_file', { exitCode: 0 }) })] }))
      expect(processItems()[0]?.querySelector('p')?.textContent).toBe('PID 4242 exited with code 0 — waiting for capacity')
    })

    it.each([
      [result('exit_file', { exitCode: 0 }), 'PID 4242 exited with code 0'],
      [result('exit_file', { exitCode: 3 }), 'PID 4242 exited with code 3'],
      [result('exit_file', { exitFileNote: 'not-an-exit-code' }), 'PID 4242 wrote an exit file that is not an exit code'],
      [result('exited'), 'PID 4242 exited, code unknown'],
      [result('deadline'), 'PID 4242 still running at the deadline'],
      [result('error', { diagnostic: 'EACCES' }), 'PID 4242 could not be checked'],
    ])('shows the last settled process wait: %j', (outcome, label) => {
      renderWaits(run('waiting', { lastWaits: [processEntry({ phase: 'delivered', result: outcome })] }))
      expect(processItems().map(item => item.querySelector('p')?.textContent)).toEqual([label])
    })

    it('shows a cancelled process wait as cancelled, and an open one in place of the last result', () => {
      const { unmount } = renderWaits(run('waiting', { lastWaits: [processEntry({ phase: 'cancelled', cancelledAt: '2026-09-22T12:01:00.000Z' })] }))
      expect(processItems().map(item => item.querySelector('p')?.textContent)).toEqual(['Process wait on PID 4242 cancelled'])
      unmount()
      renderWaits(run('waiting', {
        lastWaits: [processEntry({ phase: 'delivered', result: result('exited') })],
        waits: [processEntry({ id: '00000000-0000-4000-8000-000000001447', pid: 4343 })],
      }))
      expect(processItems().map(item => item.querySelector('p')?.textContent)).toEqual(['Waiting for PID 4343'])
    })
  })

  // hearsay-tools/cezarion#1425: a merge wait says what it waits for and how it ended.
  it('names an open merge wait and its merged, closed and timed-out results', () => {
    renderWaits(run('waiting', { waits: [ciEntry({ until: 'merge' })] }))
    expect(screen.getByText('Waiting for merge')).toBeTruthy()
    cleanup()
    for (const [outcome, label] of [
      ['merged', 'PR merged'],
      ['closed', 'PR closed without merge — inspect the PR'],
      ['deadline', 'Merge wait timed out — merge not confirmed'],
      ['conflicting', 'PR has merge conflicts — inspect the PR; not merged'],
    ] as const) {
      renderWaits(run('done', { lastWaits: [ciEntry({ until: 'merge', phase: 'delivered', result: observed(outcome) })] }))
      expect(screen.getByText(label)).toBeTruthy()
      cleanup()
    }
  })

  it('keeps a saved CI error until a new CI wait replaces it', () => {
    const error = 'Saved CI observation is unreadable'
    const { unmount } = renderWaits(run('waiting', { lastWaitsError: error, waits: [timerEntry()] }))
    expect(screen.getByText(error)).toBeTruthy()
    unmount()
    renderWaits(run('waiting', { lastWaitsError: error, waits: [ciEntry()] }))
    expect(screen.queryByText(error)).toBeNull()
    expect(screen.getByText('Waiting for CI')).toBeTruthy()
  })

  it('shows a settled CI entry still in waits ahead of an older lastWaits entry', () => {
    renderWaits(run('done', {
      lastWaits: [ciEntry({ phase: WAIT_PHASE.delivered, result: observed('passed') })],
      waits: [ciEntry({ phase: WAIT_PHASE.resolved, result: observed('failed') })],
    }))
    expect(screen.getByText('CI checks failed — inspect the PR checks')).toBeTruthy()
    expect(screen.queryByText(/CI checks passed/)).toBeNull()
  })

  it('shows unavailable settled CI without a result or timestamp', () => {
    renderWaits(run('done', { lastWaits: [ciEntry({ phase: WAIT_PHASE.delivered })] }))
    expect(screen.getByText('CI wait unavailable')).toBeTruthy()
    expect(screen.queryByText('Observed')).toBeNull()
    expect(document.querySelector('time')).toBeNull()
  })

  it('shows an unknown observed head and refuses an unsafe PR link', () => {
    renderWaits(run('done', { lastWaits: [ciEntry({ phase: WAIT_PHASE.delivered, prUrl: 'javascript:void(0)',
      result: { ...observed('head_changed')!, observedHeadSha: undefined },
    })] }))
    expect(screen.getByText('CI head changed — 1234567 → unknown')).toBeTruthy()
    expect(screen.getByText('owner/repo#474')).toBeTruthy()
    expect(screen.queryByRole('link')).toBeNull()
  })

  it.each([
    ['cancelled', 'Merge wait cancelled'], ['error', 'Merge wait unavailable — inspect access and the PR'],
  ] as const)('names a merge-specific %s outcome', (outcome, label) => {
    renderWaits(run('done', { lastWaits: [ciEntry({ until: 'merge', phase: WAIT_PHASE.delivered, result: observed(outcome) })] }))
    expect(screen.getByText(label)).toBeTruthy()
  })

  it('renders nothing for a run with no waits at all', () => {
    renderWaits(run('running'))
    expect(document.querySelector('[data-slot="open-waits"]')).toBeNull()
  })
})

describe('hasWaitDetails', () => {
  it('is false exactly when the details render nothing', () => {
    expect(hasWaitDetails(run('running'))).toBe(false)
    expect(hasWaitDetails(run('done', { lastWaitsError: 'unreadable' }))).toBe(true)
  })
})
