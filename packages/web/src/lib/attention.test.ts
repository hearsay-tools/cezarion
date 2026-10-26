// @vitest-environment node

import { summaryOf } from '@/test/run-summary-fixture'
import { openHumanWait } from '@/test/run-summary-fixture'
import { describe, expect, it } from 'vitest'

import type { RunRecord, RunSummary, RunStatus } from '@open-mercato/cezar-api-client'
import type { StatusDotTone } from '@/components/status-dot'
import {
  ATTENTION_RANK,
  workerWaitLabel,
  deriveAttention,
  wantsAttention,
  type Attention,
  type AttentionTone,
} from '@/lib/attention'

function run(over: Partial<RunRecord> = {}): RunSummary {
  return summaryOf({
    id: 'r1',
    title: 'Normalize the agent-event protocol',
    workflow: 'default',
    task: 'normalize the protocol',
    status: 'running',
    createdAt: '2026-07-14T10:00:00.000Z',
    tokensUsed: 0,
    archived: false,
    steps: [],
    ...over,
  })
}

/** The whole `RunStatus` union, spelled out. If the server ever adds a status, this array stops
 *  type-checking — which is the point: a new status must get an explicit attention answer rather
 *  than silently falling into the chain's last `return`. */
const ALL_STATUSES: readonly RunStatus[] = [
  'queued',
  'running',
  'waiting',
  'review',
  'done',
  'failed',
  'cancelled',
]

describe('deriveAttention', () => {
  const cases: ReadonlyArray<[RunStatus, Attention]> = [
    ['waiting', { rung: 'needs-you', bucket: 'waiting', tone: 'pending', shape: 'filled', pulse: true, label: 'needs you' }],
    ['review', { rung: 'needs-review', bucket: 'waiting', tone: 'info', shape: 'filled', pulse: true, label: 'needs review' }],
    ['running', { rung: 'running', bucket: 'running', tone: 'running', shape: 'filled', pulse: true, label: 'running' }],
    ['queued', { rung: 'queued', bucket: 'none', tone: 'neutral', shape: 'ring', pulse: false, label: 'queued' }],
    ['done', { rung: 'done', bucket: 'none', tone: 'success', shape: 'filled', pulse: false, label: 'done' }],
    ['failed', { rung: 'failed', bucket: 'error', tone: 'danger', shape: 'filled', pulse: false, label: 'failed' }],
    ['cancelled', { rung: 'cancelled', bucket: 'none', tone: 'neutral', shape: 'filled', pulse: false, label: 'cancelled' }],
  ]

  it.each(cases)('maps %s', (status, expected) => {
    expect(deriveAttention(run({ status }))).toEqual(expected)
  })

  it('answers for every status the API can send', () => {
    expect(cases.map(([status]) => status).sort()).toEqual([...ALL_STATUSES].sort())
  })

  it('pulses exactly the transitioning states', () => {
    // The spec's "pulsing while transitioning": something is happening, or something is waiting
    // on you. A finished or parked run is still — a list where everything pulses says nothing.
    const pulsing = ALL_STATUSES.filter((status) => deriveAttention(run({ status })).pulse)
    expect(pulsing).toEqual(['running', 'waiting', 'review'])
  })

  describe('permutations', () => {
    // `error` is a message, not a state: the server sets it *with* `status: 'failed'` (and with
    // 'cancelled' when a run was interrupted). The dot follows the status, so an error string
    // must not turn a done run red — and must not fail to turn a failed one red either.
    it.each(ALL_STATUSES)('ignores a stray error message on a %s run', (status) => {
      expect(deriveAttention(run({ status, error: 'interrupted — cezar process exited' }))).toEqual(
        deriveAttention(run({ status }))
      )
    })

    it.each(ALL_STATUSES)('is unchanged by archiving a %s run', (status) => {
      // Archiving files a run away; it does not change what happened to it. The list drops
      // archived runs into their own view (lib/task-groups.ts) — that is a list concern, not an
      // attention one, and a notification for an archived run is the list's to suppress.
      expect(deriveAttention(run({ status, archived: true, archivedAt: '2026-07-14T11:00:00.000Z' }))).toEqual(
        deriveAttention(run({ status }))
      )
    })

    it.each(ALL_STATUSES)('is unchanged by an open PR on a %s run', (status) => {
      expect(deriveAttention(run({ status, pullRequestUrl: 'https://github.com/o/r/pull/1' }))).toEqual(
        deriveAttention(run({ status }))
      )
    })

    it('does not read the steps', () => {
      // Attention is a property of the run's own status. A failed *step* inside a run that
      // recovered and finished must not leave a red dot on a green run.
      const withFailedStep = run({
        status: 'done',
        steps: [
          { id: 's1', name: 'implement', kind: 'agent', status: 'failed', iterations: 1, tokensUsed: 10 },
          { id: 's2', name: 'retry', kind: 'agent', status: 'done', iterations: 1, tokensUsed: 10 },
        ],
      })
      expect(deriveAttention(withFailedStep).tone).toBe('success')
    })
  })

  it('is pure — the same record twice is the same answer, and the record is untouched', () => {
    const record = run({ status: 'waiting' })
    const frozen = JSON.stringify(record)
    expect(deriveAttention(record)).toEqual(deriveAttention(record))
    expect(JSON.stringify(record)).toBe(frozen)
  })

  it('never claims a permission prompt — cezar emits none yet', () => {
    // The bucket exists (the spec ranks it first) but R2's `permission.*` events are what will
    // feed it. Until then no record can produce it: this test is the guard that nothing invented
    // a source in the meantime.
    for (const status of ALL_STATUSES) {
      expect(deriveAttention(run({ status })).bucket).not.toBe('permission')
    }
  })

  it('never claims unseen — there is no seen marker to compare against', () => {
    for (const status of ALL_STATUSES) {
      expect(deriveAttention(run({ status })).bucket).not.toBe('unseen')
    }
  })
})

describe('ATTENTION_RANK', () => {
  it('is the spec ladder: permission > error > waiting > running > unseen', () => {
    const order = Object.entries(ATTENTION_RANK)
      .sort(([, a], [, b]) => a - b)
      .map(([bucket]) => bucket)
    expect(order).toEqual(['permission', 'error', 'waiting', 'running', 'unseen', 'none'])
  })

  it('ranks error above waiting — an error can never be masked by a gate', () => {
    expect(ATTENTION_RANK.error).toBeLessThan(ATTENTION_RANK.waiting)
    expect(ATTENTION_RANK.permission).toBeLessThan(ATTENTION_RANK.error)
  })
})

describe('a run waiting out a usage limit', () => {
  const scheduled = run({ status: 'waiting', autoResumeAt: '2026-08-03T19:33:53.000Z' })

  it('reads as a usage limit, parked and still, never as a red failure', () => {
    // A waiting run with a resume booked (spec 2026-10-17-unified-waits, hearsay-tools/cezarion#1236):
    // neutral and still, like `queued`.
    expect(deriveAttention(scheduled)).toEqual({
      rung: 'usage-limit',
      bucket: 'none',
      tone: 'neutral',
      shape: 'ring',
      pulse: false,
      label: 'usage limit',
    })
  })

  it('asks for nothing — no notification, no attention bucket', () => {
    expect(wantsAttention(scheduled)).toBe(false)
    // …while a failure with no schedule is unchanged.
    expect(deriveAttention(run({ status: 'failed' })).label).toBe('failed')
    expect(wantsAttention(run({ status: 'failed' }))).toBe(true)
  })

  it('only applies to a WAITING run — a live run with a stale stamp is still live', () => {
    expect(deriveAttention(run({ status: 'running', autoResumeAt: '2026-08-03T19:33:53.000Z' })).label)
      .toBe('running')
  })
})

describe('wantsAttention', () => {
  it.each(ALL_STATUSES)('%s', (status) => {
    // The spec's notification trigger (Phase R6): "waiting/review/failed".
    const expected = status === 'waiting' || status === 'review' || status === 'failed'
    expect(wantsAttention(run({ status }))).toBe(expected)
  })
})

describe('tone vocabulary', () => {
  it('is exactly the StatusDot tones', () => {
    // attention.ts names its tones itself to stay UI-free, so the two lists can drift. These
    // assignments are the drift alarm: they only compile while the unions are identical.
    const toDot = (tone: AttentionTone): StatusDotTone => tone
    const fromDot = (tone: StatusDotTone): AttentionTone => tone
    expect(toDot('accent')).toBe('accent')
    expect(fromDot('neutral')).toBe('neutral')
  })

  it('every status yields a tone StatusDot can paint', () => {
    const tones = new Set(ALL_STATUSES.map((status) => deriveAttention(run({ status })).tone))
    expect([...tones].sort()).toEqual(['danger', 'info', 'neutral', 'pending', 'running', 'success'])
  })
})

/** A worker wait in the list (hearsay-tools/cezarion#1301): an agent's registered wait, or Cezar's
 *  deadline-less completion wait. */
const workerEntry = (over: Record<string, unknown> = {}) => ({
  kind: 'worker' as const, id: '00000000-0000-4000-8000-0000000000e1', source: 'agent' as const, via: 'cezar_wait' as const,
  registeredAt: '2026-09-05T00:00:00.000Z', deadline: '2026-09-06T00:00:00.000Z', phase: 'open' as const, turnId: 'turn-1',
  timeoutSeconds: 600, workerIds: ['child'], revisions: [], outcomes: [],
  ...over,
})
const completionEntry = (over: Record<string, unknown> = {}) => {
  const { deadline: _deadline, timeoutSeconds: _timeout, ...entry } = workerEntry({ source: 'cezar', via: 'completion', ...over })
  return { ...entry, mode: 'all' as const }
}
const onWaits = (status: RunStatus, waits: unknown[], over: Partial<RunRecord> = {}) =>
  run({ status, waits, delegation: { role: 'root', permissions: [], receipts: [] }, ...over } as Partial<RunRecord>)

it.each(['open', 'resolved'] as const)('distinguishes a %s worker wait without masking human attention', phase => {
  const record = onWaits('waiting', [workerEntry({ phase })])
  if (phase === 'open') {
    expect(deriveAttention(record).label).toBe('waiting on 1 worker')
    expect(wantsAttention(record)).toBe(false)
    expect(deriveAttention(record).pulse).toBe(false)
  } else {
    expect(deriveAttention(record)).toEqual({
      rung: 'waiting-for-capacity', bucket: 'none', tone: 'running', shape: 'ring', pulse: false, label: 'waiting for capacity',
    })
    expect(wantsAttention(record)).toBe(false)
  }
})

it("reads Cezar's completion wait as waiting on its workers", () => {
  expect(deriveAttention(onWaits('waiting', [completionEntry({ workerIds: ['a', 'b'] })]))).toMatchObject({
    rung: 'waiting-on-workers', bucket: 'none', tone: 'running', shape: 'workers', pulse: false, label: 'waiting on 2 workers',
  })
})

it("never reads an old row's delegation.wait", () => {
  const record = run({ status: 'waiting', delegation: { role: 'root', permissions: [], receipts: [], wait: { id: 'wait', workerIds: ['child'], deadline: '2026-09-06T00:00:00.000Z', phase: 'parked', outcomes: [] } } } as Partial<RunRecord>)
  expect(deriveAttention(record).label).toBe('needs you')
})

it('keeps a parked parent with a pending human ask in list attention without transcript context', () => {
  const record = onWaits('waiting', [workerEntry(), openHumanWait()])
  expect(deriveAttention(record)).toEqual({ rung: 'needs-you', bucket: 'waiting', tone: 'pending', shape: 'filled', pulse: true, label: 'needs you' })
  expect(wantsAttention(record)).toBe(true)
})

it('keeps a resolved worker wait with a pending human ask in list attention', () => {
  const record = onWaits('waiting', [workerEntry({ phase: 'resolved' }), openHumanWait()])
  expect(deriveAttention(record)).toEqual({ rung: 'needs-you', bucket: 'waiting', tone: 'pending', shape: 'filled', pulse: true, label: 'needs you' })
  expect(wantsAttention(record)).toBe(true)
})

it('keeps a running parent with a resolved worker wait as running', () => {
  expect(deriveAttention(onWaits('running', [workerEntry({ phase: 'resolved' })]))).toEqual({
    rung: 'running', bucket: 'running', tone: 'running', shape: 'filled', pulse: true, label: 'running',
  })
})

// Rung 3 (phase 4b, hearsay-tools/cezarion#1236): a question the user cannot see yet does not
// outrank the queued wake; one the user sees is Needs you at any live status.
it('reads a queued parent with a resolved worker wait by whether its question is shown', () => {
  const unshown = onWaits('queued', [workerEntry({ phase: 'resolved' }), openHumanWait()])
  expect(deriveAttention(unshown)).toEqual({
    rung: 'waiting-for-capacity', bucket: 'none', tone: 'running', shape: 'ring', pulse: false, label: 'waiting for capacity',
  })
  expect(wantsAttention(unshown)).toBe(false)
  const shown = onWaits('queued', [workerEntry({ phase: 'resolved' }), openHumanWait(3)])
  expect(deriveAttention(shown).label).toBe('needs you')
  expect(wantsAttention(shown)).toBe(true)
})

/** A CI or timer park is `waiting` with an open wait (spec 2026-10-17-unified-waits, phase 1).
 *  `summaryOf` keeps the record's `waits` and adds no `waitingOn`, the shape of a full or
 *  stream-patched record, which is what the cockpit derives attention from outside lists. */
const openCi = () => ({
  kind: 'pr' as const, id: '00000000-0000-4000-8000-0000000000c1', source: 'agent' as const, via: 'cezar_wait' as const,
  registeredAt: '2026-10-17T15:10:00.000Z', deadline: '2026-10-17T15:40:00.000Z', phase: 'open' as const, turnId: 'turn-1',
  prUrl: 'https://github.com/o/r/pull/12', repository: 'o/r', prNumber: 12, headSha: 'a'.repeat(40),
  generation: 'gen-1', timeoutSeconds: 1800, until: 'checks' as const, wakeOnConflict: true,
})
const openTimer = () => ({
  kind: 'timer' as const, id: '00000000-0000-4000-8000-0000000000d1', source: 'agent' as const, via: 'cezar_wait' as const,
  registeredAt: '2026-10-17T15:00:00.000Z', deadline: '2026-10-17T15:05:00.000Z', phase: 'open' as const, turnId: 'turn-1',
  seconds: 300,
})

describe('a run parked on an open wait', () => {
  it('reads as running on its own downstream work, never Needs you', () => {
    for (const record of [run({ status: 'waiting', waits: [openCi()] }), run({ status: 'waiting', waits: [openTimer()] })]) {
      expect(deriveAttention(record)).toMatchObject({ bucket: 'running', tone: 'running', shape: 'ring', pulse: true })
      expect(wantsAttention(record)).toBe(false)
    }
    expect(deriveAttention(run({ status: 'waiting', waits: [openCi()] })).label).toBe('waiting for CI')
    expect(deriveAttention(run({ status: 'waiting', waits: [openTimer()] })).label).toBe('monitoring')
  })

  it('is Needs you again with a pending human ask', () => {
    const record = run({ status: 'waiting', waits: [openCi(), openHumanWait()] })
    expect(deriveAttention(record).label).toBe('needs you')
    expect(wantsAttention(record)).toBe(true)
  })
})

/** The status key (#617): hue says the family, shape says whether it is waiting. One row per
 *  state in the issue's table, so a regression in any rung is named by the row it broke. */
describe('status key (#617)', () => {
  const parkedRoot = (wait: Record<string, unknown> = {}) => onWaits('waiting', [
    workerEntry({ workerIds: ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002'], ...wait }),
  ])
  const rows: ReadonlyArray<[string, RunSummary, Pick<Attention, 'tone' | 'shape' | 'pulse' | 'label'>]> = [
    ['needs you', run({ status: 'waiting' }), { tone: 'pending', shape: 'filled', pulse: true, label: 'needs you' }],
    ['needs review', run({ status: 'review' }), { tone: 'info', shape: 'filled', pulse: true, label: 'needs review' }],
    ['running', run({ status: 'running' }), { tone: 'running', shape: 'filled', pulse: true, label: 'running' }],
    ['waiting for CI', run({ status: 'waiting', waits: [openCi()] }), { tone: 'running', shape: 'ring', pulse: true, label: 'waiting for CI' }],
    ['timer', run({ status: 'waiting', waits: [openTimer()] }), { tone: 'running', shape: 'ring', pulse: true, label: 'monitoring' }],
    ['waiting on workers', parkedRoot(), { tone: 'running', shape: 'workers', pulse: false, label: 'waiting on 2 workers' }],
    ['waiting for capacity', parkedRoot({ phase: 'resolved' }), { tone: 'running', shape: 'ring', pulse: false, label: 'waiting for capacity' }],
    ['wait result owed', run({ status: 'waiting', waits: [{ ...openCi(), phase: 'resolved', resolvedAt: '2026-10-17T15:20:00.000Z' }] }), { tone: 'running', shape: 'ring', pulse: false, label: 'waiting for capacity' }],
    ['queued', run({ status: 'queued' }), { tone: 'neutral', shape: 'ring', pulse: false, label: 'queued' }],
    ['usage limit', run({ status: 'waiting', autoResumeAt: '2026-08-03T19:33:53.000Z' }), { tone: 'neutral', shape: 'ring', pulse: false, label: 'usage limit' }],
    ['done', run({ status: 'done' }), { tone: 'success', shape: 'filled', pulse: false, label: 'done' }],
    ['failed', run({ status: 'failed' }), { tone: 'danger', shape: 'filled', pulse: false, label: 'failed' }],
    ['cancelled', run({ status: 'cancelled' }), { tone: 'neutral', shape: 'filled', pulse: false, label: 'cancelled' }],
  ]

  it.each(rows)('%s', (_name, record, expected) => {
    expect(deriveAttention(record)).toMatchObject(expected)
  })

  const look = (record: RunSummary) => { const { tone, shape } = deriveAttention(record); return `${tone}/${shape}` }
  it('separates the pairs that used to collide', () => {
    expect(look(run({ status: 'running' }))).not.toBe(look(run({ status: 'waiting', waits: [openTimer()] })))
    expect(look(parkedRoot())).not.toBe(look(run({ status: 'done' })))
    expect(look(run({ status: 'queued' }))).not.toBe(look(run({ status: 'cancelled' })))
  })

  it('no status rung paints the brand accent any more', () => {
    for (const [, record] of rows) expect(deriveAttention(record).tone).not.toBe('accent')
  })

  it('counts one worker in the singular, and says no number when the list row carries none', () => {
    expect(deriveAttention(parkedRoot({ workerIds: ['00000000-0000-4000-8000-000000000001'] })).label).toBe('waiting on 1 worker')
    // A summary without a count (`waitingOn.count` 0) claims no number.
    const slim = run({ status: 'waiting', waitingOn: { kind: 'workers', count: 0 } } as unknown as Partial<RunRecord>)
    expect(deriveAttention(slim)).toMatchObject({ shape: 'workers', label: 'waiting on workers' })
  })

  // Review round 5: a parked wait-for-all stays `parked` after one worker has reported, so the
  // count is the workers still owed an outcome, not every id the wait names.
  it('counts only the workers that have not reported yet', () => {
    const outcome = (workerId: string) => ({ workerId, status: 'done' as const, observedAt: '2026-09-05T00:00:00.000Z' })
    const one = parkedRoot({ mode: 'all', outcomes: [outcome('00000000-0000-4000-8000-000000000001')] })
    expect(deriveAttention(one).label).toBe('waiting on 1 worker')
    expect(workerWaitLabel('root', { workerIds: ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002'], outcomes: [outcome('00000000-0000-4000-8000-000000000001')] })).toBe('waiting on 1 worker')
    const all = parkedRoot({ mode: 'all', outcomes: [outcome('00000000-0000-4000-8000-000000000001'), outcome('00000000-0000-4000-8000-000000000002')] })
    expect(deriveAttention(all).label).toBe('waiting on workers')
    // An outcome for an id the wait does not name resolves nothing.
    expect(deriveAttention(parkedRoot({ outcomes: [outcome('00000000-0000-4000-8000-000000000009')] })).label).toBe('waiting on 2 workers')
  })

  it('a root waiting on worker replies is still its own workers; a worker waiting on its parent is a ring', () => {
    expect(deriveAttention(parkedRoot({ requestIds: ['00000000-0000-4000-8000-000000000009'] }))).toMatchObject({ shape: 'workers', label: 'waiting on worker replies' })
    const worker = run({ status: 'waiting', waits: [workerEntry({ workerIds: ['00000000-0000-4000-8000-000000000001'], requestIds: ['00000000-0000-4000-8000-000000000009'] })], delegation: { role: 'worker', parentRunId: '00000000-0000-4000-8000-000000000001', permissions: [] } } as unknown as Partial<RunRecord>)
    expect(deriveAttention(worker)).toMatchObject({ tone: 'running', shape: 'ring', pulse: false, label: 'waiting on parent reply' })
  })
})
