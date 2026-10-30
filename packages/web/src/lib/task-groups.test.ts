// @vitest-environment node

import { summaryOf } from '@/test/run-summary-fixture'
import { openHumanWait } from '@/test/run-summary-fixture'
import { timerWait, workerWait } from '@/test/wait-fixtures'
import { describe, expect, it } from 'vitest'

import type { RunRecord, RunSummary, RunStatus } from '@open-mercato/cezar-api-client'
import {
  BUCKET_ORDER,
  bucketOf,
  capBuckets,
  groupRuns,
  listCounts,
  loudestMember,
  parseSectionParam,
  queuePositions,
  refPrefixMatches,
  runTitle,
  sectionTasksPath,
  SIDEBAR_SECTIONS,
  sidebarActiveRunId,
  sidebarCounts,
  sidebarRuns,
  sortRuns,
  splitRefPrefix,
  type QuickListBucket,
} from '@/lib/task-groups'

let seq = 0

function run(over: Partial<RunRecord> = {}): RunSummary {
  seq += 1
  return summaryOf({
    id: `r${seq}`,
    title: `Task ${seq}`,
    workflow: 'default',
    task: `task ${seq}`,
    status: 'done',
    createdAt: '2026-07-14T10:00:00.000Z',
    tokensUsed: 0,
    archived: false,
    steps: [],
    ...over,
  })
}

/** Flatten to `Bucket: id, id` lines — the assertions are about placement and order, and a
 *  structural `toEqual` of whole records buries that in noise. */
function shape(buckets: QuickListBucket[]): string[] {
  return buckets.map(
    (bucket) =>
      `${bucket.label}: ${bucket.rows
        .map((row) => row.run.id)
        .join(', ')}`
  )
}

/** `groupRuns(...)` rows for one bucket, asserted to exist — the tests are about their content,
 *  and `noUncheckedIndexedAccess` would otherwise put a `?.` on every line of that. */
function rowsOf(buckets: QuickListBucket[], index = 0) {
  const bucket = buckets[index]
  if (!bucket) throw new Error(`no bucket at ${index}`)
  return bucket.rows
}

describe('bucketOf', () => {
  const cases: ReadonlyArray<[RunStatus, string]> = [
    ['waiting', 'Needs you'],
    ['review', 'Needs you'],
    ['running', 'Working'],
    ['queued', 'Working'],
    ['done', 'Finished'],
    ['failed', 'Finished'],
    ['cancelled', 'Finished'],
  ]

  it.each(cases)('%s → %s in the active view', (status, label) => {
    expect(bucketOf(run({ status }), 'active')).toBe(label)
  })

  it.each(cases)('%s → Archived in the archived view', (status) => {
    expect(bucketOf(run({ status, archived: true }), 'archived')).toBe('Archived')
  })

  // The monitoring park is the agent's open timer since hearsay-tools/cezarion#1301.
  it("a monitoring run stays in Working, not Needs you (#490)", () => {
    expect(bucketOf(run({ status: 'waiting', waits: [timerWait()] } as Partial<RunRecord>), 'active')).toBe('Working')
  })

  it('a run waiting out a usage limit is Working, not Finished', () => {
    // Failed on the record, but it has an appointment to resume itself (spec
    // 2026-08-03-auto-resume-after-usage-limit) — it is work in flight, not an outcome. And it
    // asks for nothing, so never "Needs you".
    const scheduled = run({ status: 'waiting', autoResumeAt: '2026-08-03T19:33:53.000Z' })
    expect(bucketOf(scheduled, 'active')).toBe('Working')
    expect(bucketOf(run({ status: 'failed' }), 'active')).toBe('Finished')
    // Archived still collapses everything, schedule or not.
    expect(bucketOf({ ...scheduled, archived: true }, 'archived')).toBe('Archived')
  })
})

describe('sortRuns', () => {
  it('orders by status priority, then newest first', () => {
    const runs = [
      run({ id: 'done-old', status: 'done', createdAt: '2026-07-14T09:00:00.000Z' }),
      run({ id: 'running', status: 'running', createdAt: '2026-07-14T08:00:00.000Z' }),
      run({ id: 'done-new', status: 'done', createdAt: '2026-07-14T11:00:00.000Z' }),
      run({ id: 'review', status: 'review', createdAt: '2026-07-14T07:00:00.000Z' }),
      run({ id: 'queued', status: 'queued', createdAt: '2026-07-14T12:00:00.000Z' }),
      run({ id: 'waiting', status: 'waiting', createdAt: '2026-07-14T06:00:00.000Z' }),
    ]
    // Needs-you first even though it is the oldest run in the list; a fresh `done` never
    // outranks a run that is blocked on you.
    expect(sortRuns(runs, 'active').map((r) => r.id)).toEqual([
      'waiting',
      'review',
      'running',
      'queued',
      'done-new',
      'done-old',
    ])
  })

  it('orders scheduled runs by their appointment — soonest on top, not newest', () => {
    // "What happens next" has to hold INSIDE the rank too: a task resuming at 11:14 sits above
    // one resuming at 11:40 however old each is (spec 2026-08-03-auto-resume-after-usage-limit).
    // Creation order is deliberately the inverse of appointment order here.
    const runs = [
      run({ id: 'late', status: 'waiting', autoResumeAt: '2026-08-03T11:40:00.000Z', createdAt: '2026-07-14T12:00:00.000Z' }),
      run({ id: 'soon', status: 'waiting', autoResumeAt: '2026-08-03T11:14:00.000Z', createdAt: '2026-07-14T08:00:00.000Z' }),
      run({ id: 'mid', status: 'waiting', autoResumeAt: '2026-08-03T11:20:00.000Z', createdAt: '2026-07-14T10:00:00.000Z' }),
    ]
    expect(sortRuns(runs, 'active').map((r) => r.id)).toEqual(['soon', 'mid', 'late'])
  })

  it('orders queued runs FIFO, so the row order matches the #N positions they print', () => {
    const runs = [
      run({ id: 'third', status: 'queued', createdAt: '2026-07-14T12:00:00.000Z' }),
      run({ id: 'first', status: 'queued', createdAt: '2026-07-14T10:00:00.000Z' }),
      run({ id: 'second', status: 'queued', createdAt: '2026-07-14T11:00:00.000Z' }),
    ]
    const sorted = sortRuns(runs, 'active')
    expect(sorted.map((r) => r.id)).toEqual(['first', 'second', 'third'])
    // …which is exactly the order `queuePositions` numbers them in.
    const positions = queuePositions(runs)
    expect(sorted.map((r) => positions.get(r.id))).toEqual([1, 2, 3])
  })

  it('ranks the outcomes done → failed → cancelled, recency within each', () => {
    const runs = [
      run({ id: 'cancelled', status: 'cancelled', createdAt: '2026-07-14T09:00:00.000Z' }),
      run({ id: 'failed', status: 'failed', createdAt: '2026-07-14T10:00:00.000Z' }),
      run({ id: 'done', status: 'done', createdAt: '2026-07-14T08:00:00.000Z' }),
      run({ id: 'done-newer', status: 'done', createdAt: '2026-07-14T11:00:00.000Z' }),
    ]
    expect(sortRuns(runs, 'active').map((r) => r.id)).toEqual([
      'done-newer',
      'done',
      'failed',
      'cancelled',
    ])
  })

  it('puts a scheduled run between running and queued — the pipeline in the order it happens', () => {
    // A usage-limit hold is work with an appointment, not an outcome (spec
    // 2026-08-03-auto-resume-after-usage-limit), so it must never sink into the terminal block
    // with the plain failures, nor rise with the waits that need a human (hearsay-tools/cezarion#1236).
    // Reading top-down answers "what happens next".
    const runs = [
      run({ id: 'failed', status: 'failed', createdAt: '2026-07-14T12:00:00.000Z' }),
      run({ id: 'queued', status: 'queued', createdAt: '2026-07-14T11:00:00.000Z' }),
      run({
        id: 'scheduled',
        status: 'waiting',
        autoResumeAt: '2026-08-03T19:33:53.000Z',
        createdAt: '2026-07-14T08:00:00.000Z',
      }),
      run({ id: 'running', status: 'running', createdAt: '2026-07-14T07:00:00.000Z' }),
      run({ id: 'waiting', status: 'waiting', createdAt: '2026-07-14T06:00:00.000Z' }),
    ]
    expect(sortRuns(runs, 'active').map((r) => r.id)).toEqual([
      'waiting',
      'running',
      'scheduled',
      'queued',
      'failed',
    ])
  })

  it('filters to the view', () => {
    const runs = [run({ id: 'a' }), run({ id: 'b', archived: true })]
    expect(sortRuns(runs, 'active').map((r) => r.id)).toEqual(['a'])
    expect(sortRuns(runs, 'archived').map((r) => r.id)).toEqual(['b'])
  })

  it('does not reorder its input', () => {
    const runs = [run({ id: 'done', status: 'done' }), run({ id: 'waiting', status: 'waiting' })]
    sortRuns(runs, 'active')
    expect(runs.map((r) => r.id)).toEqual(['done', 'waiting'])
  })
})

describe('queuePositions', () => {
  it('numbers queued runs 1..n by creation order, not list order', () => {
    const runs = [
      run({ id: 'third', status: 'queued', createdAt: '2026-07-14T12:00:00.000Z' }),
      run({ id: 'first', status: 'queued', createdAt: '2026-07-14T10:00:00.000Z' }),
      run({ id: 'second', status: 'queued', createdAt: '2026-07-14T11:00:00.000Z' }),
    ]
    expect(queuePositions(runs)).toEqual(
      new Map([
        ['first', 1],
        ['second', 2],
        ['third', 3],
      ])
    )
  })

  it('counts only active queued runs', () => {
    const runs = [
      run({ id: 'running', status: 'running' }),
      run({ id: 'archived-queued', status: 'queued', archived: true, createdAt: '2026-07-14T09:00:00.000Z' }),
      run({ id: 'queued', status: 'queued', createdAt: '2026-07-14T10:00:00.000Z' }),
    ]
    // The archived one is not in the engine's queue, so it must not push the real one to #2.
    expect(queuePositions(runs)).toEqual(new Map([['queued', 1]]))
  })
})

describe('splitRefPrefix', () => {
  it.each([
    // Exactly what `postValidateTitle` writes.
    ['775: implementing comment threads', 775, 'implementing comment threads'],
    ['1: a', 1, 'a'],
    ['123456789: nine digits still parse', 123_456_789, 'nine digits still parse'],
    // Not the shape: no space, no digits, nothing after the colon, or a colon that is prose.
    ['775:implementing comment threads', null, '775:implementing comment threads'],
    ['fix: the login bug', null, 'fix: the login bug'],
    ['775: ', null, '775: '],
    ['775', null, '775'],
    ['#775: hash-prefixed is not our shape', null, '#775: hash-prefixed is not our shape'],
    [' 775: leading space is not our shape', null, ' 775: leading space is not our shape'],
    ['1234567890: ten digits is not a tracker number', null, '1234567890: ten digits is not a tracker number'],
    // A second `NNN: ` inside the rest is left alone — only the leading one is the prefix.
    ['775: 776: nested', 775, '776: nested'],
  ])('%s → %s / %s', (title, ref, rest) => {
    expect(splitRefPrefix(title)).toEqual({ ref, rest })
  })
})

describe('refPrefixMatches', () => {
  it('agrees only when the prefix IS the reference the chip will show', () => {
    expect(refPrefixMatches('775: implementing comment threads', 775)).toBe(true)
    // Opened on issue #788, shipped as PR #790 — two numbers, two facts. Neither may be hidden.
    expect(refPrefixMatches('788: implementing comment threads', 790)).toBe(false)
    // A title that legitimately begins with a number is never mistaken for a reference.
    expect(refPrefixMatches('2026: the year in review', 2026)).toBe(true)
    expect(refPrefixMatches('2026: the year in review', 790)).toBe(false)
    // Nothing to match against, or nothing to strip.
    expect(refPrefixMatches('775: implementing comment threads', undefined)).toBe(false)
    expect(refPrefixMatches('implementing comment threads', 775)).toBe(false)
  })
})

describe('groupRuns', () => {
  it('emits the buckets in the mockup order, and omits empty ones', () => {
    const runs = [
      run({ id: 'done', status: 'done' }),
      run({ id: 'waiting', status: 'waiting' }),
      run({ id: 'running', status: 'running' }),
    ]
    expect(shape(groupRuns(runs, 'active'))).toEqual(['Needs you: waiting', 'Finished: done', 'Working: running'])

    // Nothing waiting → no "Needs you" header at all.
    expect(shape(groupRuns([run({ id: 'done', status: 'done' })], 'active'))).toEqual(['Finished: done'])
  })

  it('declares the bucket order it renders in', () => {
    expect(BUCKET_ORDER).toEqual(['Needs you', 'Finished', 'Working', 'Archived'])
  })

  it('puts every archived run under one Archived bucket regardless of status', () => {
    const runs = [
      run({ id: 'w', status: 'waiting', archived: true }),
      run({ id: 'd', status: 'done', archived: true, createdAt: '2026-07-14T11:00:00.000Z' }),
      run({ id: 'active', status: 'running' }),
    ]
    expect(shape(groupRuns(runs, 'archived'))).toEqual(['Archived: w, d'])
  })

  it('carries queue positions onto the rows', () => {
    const runs = [
      run({ id: 'q2', status: 'queued', createdAt: '2026-07-14T11:00:00.000Z' }),
      run({ id: 'q1', status: 'queued', createdAt: '2026-07-14T10:00:00.000Z' }),
      run({ id: 'r', status: 'running' }),
    ]
    const rows = rowsOf(groupRuns(runs, 'active'))
    expect(
      rows.map((row) => [row.run.id, row.queuePosition])
    ).toEqual([
      // FIFO now (the sort), so the rows run in the same order as the numbers they carry —
      // the engine's start order, top to bottom.
      ['r', null],
      ['q1', 1],
      ['q2', 2],
    ])
  })

  it('lists historical variant runs as ordinary rows (hearsay-tools/cezarion#1760)', () => {
    const runs = [
      run({ id: 'a', groupId: 'g1', variant: 'A', status: 'running', title: 'Add autocomplete (A)' }),
      run({ id: 'b', groupId: 'g1', variant: 'B', status: 'waiting', title: 'Add autocomplete (B)' }),
      run({ id: 'c', groupId: 'g1', variant: 'C', status: 'running', title: 'Add autocomplete (C)', archived: true }),
    ]
    expect(shape(groupRuns(runs, 'active'))).toEqual(['Needs you: b', 'Working: a'])
    expect(shape(groupRuns(runs, 'archived'))).toEqual(['Archived: c'])
  })

  it('handles an empty list', () => {
    expect(groupRuns([], 'active')).toEqual([])
    expect(groupRuns([], 'archived')).toEqual([])
  })
})

describe('runTitle — the one name every surface shows', () => {
  it.each([
    {
      label: 'the auto-summary wins over the raw title once a turn produced one',
      over: { title: 'fix the login bug plz', titleSummary: 'Catch AuthError in the login handler' },
      expected: 'Catch AuthError in the login handler',
    },
    {
      label: 'no summary yet (or a pre-R2 record) → the raw title, honestly',
      over: { title: 'fix the login bug plz' },
      expected: 'fix the login bug plz',
    },
    {
      label: 'a user edit set BOTH fields (PATCH /api/v1/runs/:id), so the edit is what shows',
      over: { title: 'Login 500 fix', titleSummary: 'Login 500 fix' },
      expected: 'Login 500 fix',
    },
    {
      label: 'legacy concatenated narration falls back without rewriting persisted state',
      over: {
        title: '469: /om-auto-review-pr',
        titleSummary: 'Loading the pipeline config and tracker descriptor, then claim PR #469.Config loaded',
      },
      expected: '469: /om-auto-review-pr',
    },
    {
      label: 'user-owned titles preserve punctuation byte-for-byte',
      over: {
        title: 'Release v2.Config migration',
        titleSummary: 'Release v2.Config migration',
        titleOrigin: 'user' as const,
      },
      expected: 'Release v2.Config migration',
    },
    {
      label: 'marker-owned titles preserve punctuation byte-for-byte',
      over: {
        title: 'raw task',
        titleSummary: 'Testing SDK.Config support',
        titleOrigin: 'marker' as const,
      },
      expected: 'Testing SDK.Config support',
    },
    {
      label: 'well-formed identifiers and acronyms remain untouched',
      over: { title: 'raw task', titleSummary: 'updating README.md for OAuth2' },
      expected: 'updating README.md for OAuth2',
    },
  ])('$label', ({ over, expected }) => {
    expect(runTitle(run(over))).toBe(expected)
  })
})

describe('listCounts', () => {
  it('counts active, archived, and the runs that want you', () => {
    const runs = [
      run({ status: 'running' }),
      run({ status: 'waiting' }),
      run({ status: 'review' }),
      run({ status: 'failed' }),
      run({ status: 'done', archived: true }),
      run({ status: 'waiting', archived: true }),
    ]
    // The archived `waiting` counts as archived only — an archived run is not asking for you.
    expect(listCounts(runs)).toEqual({ active: 4, archived: 2, waiting: 2 })
  })

  it('is all zeroes for an empty list', () => {
    expect(listCounts([])).toEqual({ active: 0, archived: 0, waiting: 0 })
  })
})

describe('status sections (#811)', () => {
  it('keeps pins first inside their status and allocates the shared budget to Finished before Working', () => {
    const runs = [
      run({ id: 'work', status: 'running' }),
      run({ id: 'pin-work', status: 'queued', pinned: true }),
      run({ id: 'done', status: 'done' }),
      run({ id: 'pin-done', status: 'failed', pinned: true }),
      run({ id: 'ask', status: 'waiting' }),
      run({ id: 'pin-ask', status: 'review', pinned: true }),
    ]
    expect(shape(groupRuns(runs, 'active'))).toEqual([
      'Needs you: pin-ask, ask', 'Finished: pin-done, done', 'Working: pin-work, work',
    ])
    expect(shape(capBuckets(groupRuns(runs, 'active'), 2))).toEqual([
      'Needs you: pin-ask, ask', 'Finished: pin-done, done', 'Working: pin-work',
    ])
    expect(shape(groupRuns(runs.map(r => r.id === 'pin-work' ? { ...r, status: 'done' as const } : r), 'active'))).toEqual([
      'Needs you: pin-ask, ask', 'Finished: pin-work, pin-done, done', 'Working: work',
    ])
  })
})

describe('pinned tasks (#935)', () => {
  const pinned = (over: Partial<RunRecord> = {}) => run({ pinned: true, pinnedAt: '2026-08-29T10:00:00.000Z', ...over })

  describe('bucketOf', () => {
    it.each(['waiting', 'review', 'running', 'queued', 'done', 'failed', 'cancelled'] as RunStatus[])(
      'a pinned %s run yields to attention',
      (status) => {
        expect(bucketOf(pinned({ status }), 'active')).toBe(['waiting', 'review'].includes(status) ? 'Needs you' : ['running', 'queued'].includes(status) ? 'Working' : 'Finished')
      },
    )

    it('the archived view still collapses everything, pin or no pin', () => {
      // Archiving retires the pin server-side, so this is a hand-edited record — and in that
      // view the answer is history either way.
      expect(bucketOf(pinned({ status: 'waiting', archived: true }), 'archived')).toBe('Archived')
    })
  })

  describe('sortRuns', () => {
    it('puts pinned runs first, ahead of every status weight', () => {
      const runs = [
        run({ id: 'waiting', status: 'waiting' }),
        pinned({ id: 'pinned-done', status: 'done' }),
        run({ id: 'running', status: 'running' }),
      ]
      expect(sortRuns(runs, 'active').map((r) => r.id)).toEqual(['pinned-done', 'waiting', 'running'])
    })

    it('keeps the ordinary rules INSIDE the pinned block', () => {
      const runs = [
        pinned({ id: 'pinned-done', status: 'done' }),
        pinned({ id: 'pinned-waiting', status: 'waiting' }),
        run({ id: 'plain-waiting', status: 'waiting' }),
      ]
      expect(sortRuns(runs, 'active').map((r) => r.id)).toEqual([
        'pinned-waiting',
        'pinned-done',
        'plain-waiting',
      ])
    })

    it('ignores the pin in the archived view', () => {
      const runs = [
        run({ id: 'newer', archived: true, createdAt: '2026-07-14T12:00:00.000Z' }),
        pinned({ id: 'older-pinned', archived: true, createdAt: '2026-07-14T09:00:00.000Z' }),
      ]
      expect(sortRuns(runs, 'archived').map((r) => r.id)).toEqual(['newer', 'older-pinned'])
    })
  })

  describe('groupRuns', () => {
    it('emits Needs you before Finished, and each pinned run exactly once', () => {
      const runs = [
        run({ id: 'waiting', status: 'waiting' }),
        pinned({ id: 'p-waiting', status: 'waiting' }),
        run({ id: 'running', status: 'running' }),
        pinned({ id: 'p-done', status: 'done' }),
      ]
      expect(shape(groupRuns(runs, 'active'))).toEqual([
        'Needs you: p-waiting, waiting',
        'Finished: p-done',
        'Working: running',
      ])
    })

    it('omits the bucket entirely when nothing is pinned', () => {
      expect(shape(groupRuns([run({ id: 'done', status: 'done' })], 'active'))).toEqual(['Finished: done'])
    })

  })

  describe('capBuckets', () => {
    const bucketRows = (n: number, prefix: string) =>
      Array.from({ length: n }, (_, index) => ({
        kind: 'run' as const,
        run: run({ id: `${prefix}${index}` }),
        queuePosition: null,
      }))

    it('trims across buckets in order and drops the ones the cap empties', () => {
      const capped = capBuckets(
        [
          { label: 'Needs you', rows: bucketRows(2, 'n') },
          { label: 'Working', rows: bucketRows(3, 'w') },
          { label: 'Finished', rows: bucketRows(4, 'r') },
        ],
        4,
      )
      expect(capped.map((bucket) => `${bucket.label}:${bucket.rows.length}`)).toEqual([
        'Needs you:2',
        'Working:2',
      ])
    })

    it('never trims pins, and spends none of the budget on them', () => {
      // A pin is an explicit request for that row to be on screen — and the ten rows still go
      // to the other buckets, so pinning three tasks cannot hide what needs you.
      const capped = capBuckets(
        [
          { label: 'Needs you', rows: bucketRows(3, 'n') },
          { label: 'Finished', rows: bucketRows(12, 'p').map(row => ({ ...row, run: { ...row.run, pinned: true } })) },
        ],
        10,
      )
      expect(capped.map((bucket) => `${bucket.label}:${bucket.rows.length}`)).toEqual([
        'Needs you:3',
        'Finished:12',
      ])
    })
  })

  it('does not change the tab counts — those count by status, never by bucket', () => {
    const runs = [pinned({ status: 'waiting' }), run({ status: 'done' }), run({ archived: true })]
    expect(listCounts(runs)).toEqual({ active: 2, archived: 1, waiting: 1 })
  })
})

it.each(['open', 'resolved'] as const)('keeps %s worker waits in the appropriate existing group/count', phase => {
  const record = run({ status: 'waiting', delegation: { role: 'root', permissions: [], receipts: [] }, waits: [workerWait({ workerIds: ['worker'], phase })] } as Partial<RunRecord>)
  expect(bucketOf(record, 'active')).toBe('Working')
  expect(listCounts([record, run({ status: 'waiting' })])).toEqual({ active: 2, archived: 0, waiting: 1 })
})

it('counts a parked parent question as Needs you from the run summary', () => {
  const parked = { status: 'waiting', delegation: { role: 'root', permissions: [], receipts: [] }, waits: [workerWait({ workerIds: ['worker'] })] } as Partial<RunRecord>
  const record = run({ ...parked, waits: [...parked.waits!, openHumanWait()] })
  expect(bucketOf(record, 'active')).toBe('Needs you')
  expect(listCounts([record])).toEqual({ active: 1, archived: 0, waiting: 1 })
  expect(bucketOf(run(parked), 'active')).toBe('Working')
})

function ownedWorker(over: Partial<RunRecord> = {}, parentRunId = 'parent'): RunSummary {
  const base = run(over)
  return {
    ...base,
    delegation: (over.delegation as RunSummary['delegation']) ?? { role: 'worker', parentRunId },
  }
}

describe('owned workers are not list rows (#312)', () => {
  it('omits a worker from groupRuns even when pinned, and even when the parent is archived', () => {
    const parent = run({ id: 'parent', archived: true })
    const child = ownedWorker({ id: 'child', pinned: true, pinnedAt: '2026-08-29T10:00:00.000Z' })
    const other = run({ id: 'other' })
    expect(shape(groupRuns([parent, child, other], 'active'))).toEqual(['Finished: other'])
    expect(shape(groupRuns([parent, child, other], 'archived'))).toEqual(['Archived: parent'])
  })

  it('does not count workers in Active, Archived, or waiting', () => {
    const runs = [
      run({ status: 'running' }),
      ownedWorker({ status: 'waiting' }),
      ownedWorker({ archived: true }),
      run({ archived: true }),
    ]
    expect(listCounts(runs)).toEqual({ active: 1, archived: 1, waiting: 0 })
  })

  it('does not let workers spend the capBuckets row budget', () => {
    const parents = Array.from({ length: 10 }, (_, i) =>
      run({ id: `p${i}`, status: 'done', createdAt: `2026-07-14T10:${String(i).padStart(2, '0')}:00.000Z` }),
    )
    const workers = Array.from({ length: 20 }, (_, i) =>
      ownedWorker({
        id: `w${i}`,
        status: 'running',
        createdAt: `2026-07-14T12:${String(i).padStart(2, '0')}:00.000Z`,
      }),
    )
    const capped = capBuckets(groupRuns([...parents, ...workers], 'active'), 10)
    const ids = capped.flatMap((bucket) =>
      bucket.rows.map((row) => row.run.id),
    )
    expect(ids).toHaveLength(10)
    expect(ids).toEqual(parents.map((parent) => parent.id).reverse())
  })

  it('maps a worker currentRunId to its parent', () => {
    const parent = run({ id: 'parent' })
    const child = ownedWorker({ id: 'child' }, 'parent')
    expect(sidebarActiveRunId('child', [parent, child])).toBe('parent')
    expect(sidebarActiveRunId('parent', [parent, child])).toBe('parent')
    expect(sidebarActiveRunId(null, [parent, child])).toBeNull()
    expect(sidebarActiveRunId(undefined, [parent, child])).toBeNull()
  })

  it('returns the parent id even when the parent is missing from runs', () => {
    const child = ownedWorker({ id: 'child' }, 'parent')
    expect(sidebarActiveRunId('child', [child])).toBe('parent')
  })

  it('returns the current id when it is not an owned worker', () => {
    expect(sidebarActiveRunId('missing', [])).toBe('missing')
  })
})

describe("a section's dot (#617): the loudest run by attention, not the list's first", () => {
  it('shows a failed run over a done one, though sortRuns ranks done first', () => {
    expect(loudestMember([
      run({ id: 'd', status: 'done', finishedAt: '2026-07-14T11:00:00.000Z' }),
      run({ id: 'f', status: 'failed', finishedAt: '2026-07-14T11:00:00.000Z' }),
    ]).id).toBe('f')
  })

  it('shows a needs-you run over a pinned done one', () => {
    expect(loudestMember([run({ id: 'pd', status: 'done', pinned: true }), run({ id: 'w', status: 'waiting' })]).id).toBe('w')
  })

  it('breaks a tie on the same attention rung by status weight, then list order', () => {
    expect(loudestMember([run({ id: 'b', status: 'running' }), run({ id: 'a', status: 'running' })]).id).toBe('b')
    // Same `none` rung: queued (still to happen) outranks done.
    expect(loudestMember([run({ id: 'dd', status: 'done' }), run({ id: 'q', status: 'queued' })]).id).toBe('q')
  })
})

it('keeps attentive pins after the cap is exhausted without spending ordinary row budget', () => {
  const buckets = groupRuns([
    run({ id: 'plain-wait', status: 'waiting' }),
    run({ id: 'pin-review', status: 'review', pinned: true }),
    run({ id: 'work', status: 'running' }),
  ], 'active')
  expect(shape(capBuckets(buckets, 0))).toEqual(['Needs you: pin-review'])
  expect(shape(capBuckets(buckets, 2))).toEqual(['Needs you: pin-review, plain-wait', 'Working: work'])
})

it('does not exempt a stale archived pin from the row cap', () => {
  expect(capBuckets(groupRuns([run({ archived: true, pinned: true })], 'archived'), 0)).toEqual([])
})

describe('project sidebar combined limits (#810)', () => {
  const records = () => ['waiting', 'done', 'running'].flatMap((status, section) =>
    Array.from({ length: 5 }, (_, i) => run({ id: `${section}-${i}`, status: status as RunStatus })))
  it('defaults to ten overall with unlimited sections', () => {
    expect(shape(capBuckets(groupRuns(records(), 'active')))).toEqual([
      'Needs you: 0-0, 0-1, 0-2, 0-3, 0-4', 'Finished: 1-0, 1-1, 1-2, 1-3, 1-4',
    ])
  })
  it.each([
    [{ overall: 4, needsYou: 1, finished: 2, working: 3 }, ['Needs you: 0-0', 'Finished: 1-0, 1-1', 'Working: 2-0']],
    [{ overall: null, needsYou: 1, finished: 1, working: 1 }, ['Needs you: 0-0', 'Finished: 1-0', 'Working: 2-0']],
    [{ overall: 6, needsYou: null, finished: 1, working: null }, ['Needs you: 0-0, 0-1, 0-2, 0-3, 0-4', 'Finished: 1-0']],
  ])('combines overall and independent section constraints: %j', (limits, expected) => {
    expect(shape(capBuckets(groupRuns(records(), 'active'), limits))).toEqual(expected)
  })
  it('exempts pins from both budgets', () => {
    const rows = [
      run({ id: 'c', status: 'done', pinned: true }),
      run({ id: 'pin', status: 'running', pinned: true }), ...records(),
    ]
    expect(shape(capBuckets(groupRuns(rows, 'active'), { overall: 1, needsYou: 1, finished: 1, working: 1 })))
      .toEqual(['Needs you: 0-0', 'Finished: c', 'Working: pin'])
  })
  it('Archived ignores section caps and denies stale pin exemptions', () => {
    const rows = records().map(row => ({ ...row, archived: true, pinned: true }))
    expect(capBuckets(groupRuns(rows, 'archived'), { overall: 3, needsYou: 1, finished: 1, working: 1 })[0]?.rows).toHaveLength(3)
    expect(capBuckets(groupRuns(rows, 'archived'), { overall: null, needsYou: 1, finished: 1, working: 1 })[0]?.rows).toHaveLength(15)
  })
})

it.each([null, [], 'broken', { overall: -1 }, { overall: 'unlimited' }].map(value => [value]))('applies shipped defaults to malformed stored limits %j', limits => {
  const buckets = groupRuns(Array.from({ length: 12 }, (_, i) => run({ id: `malformed-${i}` })), 'active')
  expect(capBuckets(buckets, limits as never).flatMap(bucket => bucket.rows)).toHaveLength(10)
})

describe('sidebar Active and Automations (#1332)', () => {
  const auto = (over: Partial<RunRecord> = {}): RunSummary => ({ ...run(over), automationId: 'auto-1' })
  const fixture = () => [
    run({ id: 'manual', status: 'running' }),
    run({ id: 'autonomous', autonomous: true }),
    auto({ id: 'scheduled' }),
    auto({ id: 'asks', status: 'waiting' }),
    auto({ id: 'gone', archived: true }),
    run({ id: 'archived', archived: true }),
    { ...ownedWorker({ id: 'worker', status: 'waiting' }), automationId: 'auto-1' },
  ]

  it('splits unarchived tasks by recorded origin, never by autonomy', () => {
    expect(sidebarRuns(fixture(), 'active').map((r) => r.id)).toEqual(['manual', 'autonomous'])
    expect(sidebarRuns(fixture(), 'automations').map((r) => r.id)).toEqual(['scheduled', 'asks', 'worker'])
  })

  it('places automation tasks in their status sections', () => {
    expect(shape(groupRuns(sidebarRuns(fixture(), 'automations'), 'active'))).toEqual(['Needs you: asks', 'Finished: scheduled'])
  })

  it('counts each tab and its own attention, without workers or archived tasks', () => {
    expect(sidebarCounts(fixture())).toEqual({ active: 2, automations: 2, activeWaiting: 0, automationsWaiting: 1 })
    expect(sidebarCounts([])).toEqual({ active: 0, automations: 0, activeWaiting: 0, automationsWaiting: 0 })
  })
})

describe('sectionTasksPath / parseSectionParam', () => {
  it('opens each section on the origin of its sidebar tab, and reads it back', () => {
    expect(sectionTasksPath('Needs you', 'active')).toBe('/?origin=direct&section=needs-you')
    expect(sectionTasksPath('Working', 'automations')).toBe('/?origin=automations&section=working')
    for (const section of SIDEBAR_SECTIONS) {
      const param = new URLSearchParams(sectionTasksPath(section, 'active').slice(2)).get('section')
      expect(parseSectionParam(param)).toBe(section)
    }
    expect(parseSectionParam(null)).toBeNull()
    expect(parseSectionParam('Finished')).toBeNull()
    expect(parseSectionParam('archived')).toBeNull()
  })
})
