import { describe, expect, it } from 'vitest'
import type { RunIndexEntry } from '@open-mercato/cezar-api-client'

import { projectInitials, projectSignal, projectSignalLabel, projectSignalParts, signalsByProject, sumSignals, type ProjectSignal } from './project-signal'

/** A minimal index row; every case overrides only what it is about. */
function entry(overrides: Partial<RunIndexEntry> = {}): RunIndexEntry {
  return {
    projectId: 'p',
    id: 'r',
    title: 't',
    status: 'done',
    hasPendingHumanAsk: false,
    createdAt: '2026-09-27T10:00:00Z',
    archived: false,
    workflow: 'quick-task',
    ...overrides,
  } as RunIndexEntry
}

const finished = { finishedAt: '2026-09-27T11:00:00Z' }
const idle: ProjectSignal = { needsYou: 0, failedUnread: 0, inMotion: 0, finishedUnread: 0 }

describe('projectSignal', () => {
  const cases: { name: string; runs: RunIndexEntry[]; expected: Partial<ProjectSignal> }[] = [
    { name: 'empty list is idle', runs: [], expected: {} },
    { name: 'a read done run is idle', runs: [entry({ ...finished, seenAt: '2026-09-27T12:00:00Z' })], expected: {} },
    { name: 'needs you only', runs: [entry({ status: 'waiting' })], expected: { needsYou: 1 } },
    { name: 'a pending human ask on a waiting run is needs you', runs: [entry({ status: 'waiting', hasPendingHumanAsk: true })], expected: { needsYou: 1 } },
    { name: 'unread failure only', runs: [entry({ status: 'failed', ...finished })], expected: { failedUnread: 1 } },
    { name: 'a read failure is not counted', runs: [entry({ status: 'failed', ...finished, seenAt: '2026-09-27T12:00:00Z' })], expected: {} },
    {
      name: 'both top segments',
      runs: [entry({ id: 'a', status: 'waiting' }), entry({ id: 'b', status: 'failed', ...finished })],
      expected: { needsYou: 1, failedUnread: 1 },
    },
    { name: 'running is in motion', runs: [entry({ status: 'running' })], expected: { inMotion: 1 } },
    { name: 'monitoring is in motion', runs: [entry({ status: 'running', activity: 'monitoring' })], expected: { inMotion: 1 } },
    {
      name: 'in motion + unread done',
      runs: [entry({ id: 'a', status: 'running' }), entry({ id: 'b', ...finished })],
      expected: { inMotion: 1, finishedUnread: 1 },
    },
    { name: 'unread done only', runs: [entry(finished)], expected: { finishedUnread: 1 } },
    { name: 'a re-finished run is unread again', runs: [entry({ ...finished, seenAt: '2026-09-27T10:30:00Z' })], expected: { finishedUnread: 1 } },
    { name: 'review-gate review counts amber, not green', runs: [entry({ status: 'review', ...finished })], expected: { needsYou: 1 } },
    {
      name: 'a parent waiting on two workers is one task in motion',
      runs: [
        entry({
          id: 'parent',
          status: 'waiting',
          delegation: { role: 'root', wait: { phase: 'parked' } },
        }),
        entry({ id: 'w1', status: 'running', delegation: { role: 'worker', parentRunId: 'parent' } }),
        entry({ id: 'w2', status: 'running', delegation: { role: 'worker', parentRunId: 'parent' } }),
      ],
      expected: { inMotion: 1 },
    },
    {
      name: 'owned workers are never counted, whatever their state',
      runs: [
        entry({ id: 'w1', status: 'waiting', delegation: { role: 'worker', parentRunId: 'parent' } }),
        entry({ id: 'w2', status: 'failed', ...finished, delegation: { role: 'worker', parentRunId: 'parent' } }),
        entry({ id: 'w3', ...finished, delegation: { role: 'worker', parentRunId: 'parent' } }),
      ],
      expected: {},
    },
    { name: 'queued is not counted', runs: [entry({ status: 'queued' })], expected: {} },
    {
      name: 'a scheduled usage-limit resume is not counted',
      runs: [entry({ status: 'failed', ...finished, autoResumeAt: '2026-09-27T13:00:00Z' })],
      expected: {},
    },
    { name: 'cancelled is not counted', runs: [entry({ status: 'cancelled', ...finished })], expected: {} },
    {
      name: 'archived runs are ignored everywhere',
      runs: [
        entry({ id: 'a', status: 'waiting', archived: true }),
        entry({ id: 'b', status: 'running', archived: true }),
        entry({ id: 'c', status: 'failed', ...finished, archived: true }),
        entry({ id: 'd', ...finished, archived: true }),
      ],
      expected: {},
    },
    {
      name: 'the worst case: 1 needs you, 1 failed, 2 in motion, 1 new',
      runs: [
        entry({ id: 'a', status: 'waiting' }),
        entry({ id: 'b', status: 'failed', ...finished }),
        entry({ id: 'c', status: 'running' }),
        entry({ id: 'd', status: 'running', activity: 'monitoring' }),
        entry({ id: 'e', ...finished }),
      ],
      expected: { needsYou: 1, failedUnread: 1, inMotion: 2, finishedUnread: 1 },
    },
  ]

  it.each(cases)('$name', ({ runs, expected }) => {
    expect(projectSignal(runs)).toEqual({ ...idle, ...expected })
  })
})

describe('the incident behind #864', () => {
  it('counts an old waiting root behind hundreds of newer archived runs and workers', () => {
    const runs = [
      entry({ id: 'old-waiting', status: 'waiting', hasPendingHumanAsk: true, createdAt: '2026-10-03T21:09:02Z' }),
      ...Array.from({ length: 200 }, (_, i) => entry({ id: `arch-${i}`, archived: true, ...finished })),
      ...Array.from({ length: 300 }, (_, i) => entry({ id: `w-${i}`, archived: true, ...finished, delegation: { role: 'worker', parentRunId: 'x' } as RunIndexEntry['delegation'] })),
    ]
    expect(projectSignal(runs)).toEqual({ ...idle, needsYou: 1 })
  })
})

describe('signalsByProject', () => {
  it('groups by projectId and counts each project on its own rows', () => {
    const signals = signalsByProject([
      entry({ projectId: 'a', id: '1', status: 'waiting' }),
      entry({ projectId: 'b', id: '2', status: 'running' }),
      entry({ projectId: 'a', id: '3', ...finished }),
    ])
    expect(signals.get('a')).toEqual({ ...idle, needsYou: 1, finishedUnread: 1 })
    expect(signals.get('b')).toEqual({ ...idle, inMotion: 1 })
    expect(signals.get('c')).toBeUndefined()
  })
})

describe('projectSignalLabel', () => {
  it('spells the signal out in order, omitting zero parts', () => {
    expect(projectSignalLabel('toolkit-dev', { needsYou: 1, failedUnread: 1, inMotion: 2, finishedUnread: 1 })).toBe(
      'toolkit-dev · 1 needs you · 1 failed · 2 working · 1 finished',
    )
    expect(projectSignalLabel('toolkit-dev', { ...idle, inMotion: 3 })).toBe('toolkit-dev · 3 working')
  })

  it('says idle when nothing is counted', () => {
    expect(projectSignalLabel('toolkit-dev', idle)).toBe('toolkit-dev · idle')
    expect(projectSignalLabel('toolkit-dev', undefined)).toBe('toolkit-dev · idle')
  })

  it('never qualifies the count: the index carries every unarchived run (#864)', () => {
    expect(projectSignalLabel('toolkit-dev', { ...idle, needsYou: 1 })).toBe('toolkit-dev · 1 needs you')
  })
})

describe('projectSignalLabel when the index is unknown', () => {
  it('says the activity is unknown, never idle', () => {
    expect(projectSignalLabel('toolkit-dev', undefined, { unknown: true })).toBe('toolkit-dev · activity unknown')
  })
})

describe('projectInitials', () => {
  it.each([
    ['toolkit-dev', 'td'],
    ['open_mercato', 'om'],
    ['my cool app', 'mc'],
    ['cezar.web', 'cw'],
    ['cezar', 'ce'],
    ['Cezarion', 'ce'],
    ['a', 'a'],
    ['--x--', 'x'],
    ['', ''],
  ])('%s → %s', (name, initials) => {
    expect(projectInitials(name)).toBe(initials)
  })
})

describe('projectSignalParts / sumSignals', () => {
  it('lists non-zero counts in pill order, tagged with the segment colour', () => {
    expect(projectSignalParts({ needsYou: 1, failedUnread: 0, inMotion: 2, finishedUnread: 1 })).toEqual([
      { tone: 'amber', text: '1 needs you' },
      { tone: 'violet', text: '2 working' },
      { tone: 'green', text: '1 finished' },
    ])
    expect(projectSignalParts(undefined)).toEqual([])
  })

  it('sums all four counts and skips projects with no runs', () => {
    expect(
      sumSignals([
        { needsYou: 1, failedUnread: 1, inMotion: 0, finishedUnread: 0 },
        undefined,
        { needsYou: 0, failedUnread: 0, inMotion: 2, finishedUnread: 1 },
      ]),
    ).toEqual({ needsYou: 1, failedUnread: 1, inMotion: 2, finishedUnread: 1 })
    expect(sumSignals([])).toEqual({ needsYou: 0, failedUnread: 0, inMotion: 0, finishedUnread: 0 })
  })
})
