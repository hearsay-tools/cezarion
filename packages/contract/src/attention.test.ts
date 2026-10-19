import { describe, expect, it } from 'vitest';
import { computeWaitingOn, type WorkerWaitEntry } from './waits.ts';
import { ATTENTION_RANK, delegationWaitLabel, deriveAttention, type Attention, type AttentionInput } from './attention.ts';
import type { RunStatus } from './runs.ts';

/**
 * The attention ladder, pinned where it now lives (#553/#609). The cockpit's
 * `packages/web/src/lib/attention.test.ts` keeps the full rendering matrix (tones against
 * `StatusDot`, the #617 status key); this file pins what the CLI and the cockpit SHARE: the
 * rank order, one answer per status, and the delegation rungs that separate "waiting on you"
 * from "waiting on its own workers".
 */

const run = (over: Partial<AttentionInput> & { status: RunStatus }): AttentionInput => ({ ...over });

/** Every `RunStatus`, spelled out: a new status must get an explicit answer, not the chain's last `return`. */
const ALL_STATUSES: readonly RunStatus[] = ['queued', 'running', 'waiting', 'review', 'done', 'failed', 'cancelled'];

describe('ATTENTION_RANK', () => {
  it('is the spec ladder: permission > error > waiting > running > unseen > none', () => {
    const order = Object.entries(ATTENTION_RANK)
      .sort(([, a], [, b]) => a - b)
      .map(([bucket]) => bucket);
    expect(order).toEqual(['permission', 'error', 'waiting', 'running', 'unseen', 'none']);
  });

  it('ranks error above waiting — an error can never be masked by a gate', () => {
    expect(ATTENTION_RANK.error).toBeLessThan(ATTENTION_RANK.waiting);
    expect(ATTENTION_RANK.permission).toBeLessThan(ATTENTION_RANK.error);
  });
});

describe('deriveAttention', () => {
  const cases: ReadonlyArray<[RunStatus, Attention]> = [
    ['waiting', { bucket: 'waiting', tone: 'pending', shape: 'filled', pulse: true, label: 'needs you' }],
    ['review', { bucket: 'waiting', tone: 'info', shape: 'filled', pulse: true, label: 'needs review' }],
    ['running', { bucket: 'running', tone: 'running', shape: 'filled', pulse: true, label: 'running' }],
    ['queued', { bucket: 'none', tone: 'neutral', shape: 'ring', pulse: false, label: 'queued' }],
    ['done', { bucket: 'none', tone: 'success', shape: 'filled', pulse: false, label: 'done' }],
    ['failed', { bucket: 'error', tone: 'danger', shape: 'filled', pulse: false, label: 'failed' }],
    ['cancelled', { bucket: 'none', tone: 'neutral', shape: 'filled', pulse: false, label: 'cancelled' }],
  ];

  it.each(cases)('maps %s', (status, expected) => {
    expect(deriveAttention(run({ status }))).toEqual(expected);
  });

  it('answers for every status the API can send', () => {
    expect(cases.map(([status]) => status).sort()).toEqual([...ALL_STATUSES].sort());
  });

  it('is pure — the same record twice is the same answer, and the record is untouched', () => {
    const record = run({ status: 'waiting' });
    const frozen = JSON.stringify(record);
    expect(deriveAttention(record)).toEqual(deriveAttention(record));
    expect(JSON.stringify(record)).toBe(frozen);
  });

  it('never claims permission or unseen — nothing feeds those buckets yet', () => {
    for (const status of ALL_STATUSES) {
      expect(['permission', 'unseen']).not.toContain(deriveAttention(run({ status })).bucket);
    }
  });

  // The #609 contract: `waiting` is attention whether or not a structured question is pending.
  // An operator who clears on `hasPendingHumanAsk: false` alone clears a run the cockpit shows
  // as Needs You.
  it('treats waiting as attention even with hasPendingHumanAsk false', () => {
    expect(deriveAttention(run({ status: 'waiting', hasPendingHumanAsk: false }))).toMatchObject({ bucket: 'waiting', label: 'needs you' });
    expect(deriveAttention(run({ status: 'waiting', hasPendingHumanAsk: true }))).toMatchObject({ bucket: 'waiting', label: 'needs you' });
  });

  it("keeps running + activity 'monitoring' in the running bucket (#490): not settled, not attention", () => {
    expect(deriveAttention(run({ status: 'running', activity: 'monitoring' }))).toEqual({
      bucket: 'running', tone: 'running', shape: 'ring', pulse: true, label: 'monitoring',
    });
    // `activity` is only read while running — a stale value on a terminal record is ignored.
    expect(deriveAttention(run({ status: 'done', activity: 'monitoring' })).label).toBe('done');
  });

  it('reads a failed run with an auto-resume appointment as scheduled, not as an error', () => {
    expect(deriveAttention(run({ status: 'failed', autoResumeAt: '2026-08-03T19:33:53.000Z' }))).toEqual({
      bucket: 'none', tone: 'neutral', shape: 'ring', pulse: false, label: 'scheduled',
    });
    expect(deriveAttention(run({ status: 'running', autoResumeAt: '2026-08-03T19:33:53.000Z' })).label).toBe('running');
  });
});

describe('delegation rungs', () => {
  const parkedRoot = (wait: Record<string, unknown> = {}): AttentionInput => ({
    status: 'waiting',
    delegation: { role: 'root', wait: { phase: 'parked', ...wait } },
  } as unknown as AttentionInput);

  it.each(['registered', 'parked', 'wake-pending'] as const)('distinguishes worker wait %s without masking human attention', (phase) => {
    const record = parkedRoot({ phase, workerIds: ['child'], outcomes: [] });
    const attention = deriveAttention(record);
    if (phase === 'parked') {
      expect(attention).toMatchObject({ bucket: 'none', label: 'waiting on 1 worker' });
    } else if (phase === 'wake-pending') {
      // A queued automatic wake is a scheduler/capacity wait, not a human gate (#971).
      expect(attention).toEqual({
        bucket: 'none', tone: 'running', shape: 'ring', pulse: false, label: 'waiting for capacity',
      });
    } else {
      expect(attention).toMatchObject({ bucket: 'waiting', label: 'needs you' });
    }
  });

  it('a root parked on its own workers is bucket none — the CLI must not stop an attention wait on it', () => {
    expect(deriveAttention(parkedRoot({ workerIds: ['a', 'b'], outcomes: [] }))).toEqual({
      bucket: 'none', tone: 'running', shape: 'workers', pulse: false, label: 'waiting on 2 workers',
    });
    // The slim index projection carries only the phase: no count to claim.
    expect(deriveAttention(parkedRoot())).toMatchObject({ bucket: 'none', shape: 'workers', label: 'waiting on workers' });
  });

  it('a parked parent with a pending human ask is attention again', () => {
    const record = { ...parkedRoot({ workerIds: ['a'], outcomes: [] }), hasPendingHumanAsk: true };
    expect(deriveAttention(record)).toMatchObject({ bucket: 'waiting', label: 'needs you' });
    // …and the explicit argument the cockpit passes from transcript context says the same.
    expect(deriveAttention(parkedRoot({ workerIds: ['a'], outcomes: [] }), true)).toMatchObject({ bucket: 'waiting', label: 'needs you' });
  });

  it('a wake-pending parent with a pending human ask stays Needs you', () => {
    const record = { ...parkedRoot({ phase: 'wake-pending', workerIds: ['a'], outcomes: [] }), hasPendingHumanAsk: true };
    expect(deriveAttention(record)).toMatchObject({ bucket: 'waiting', label: 'needs you' });
    expect(deriveAttention(parkedRoot({ phase: 'wake-pending', workerIds: ['a'], outcomes: [] }), true))
      .toMatchObject({ bucket: 'waiting', label: 'needs you' });
  });

  it('a queued leftover wake-pending parent is waiting for capacity, not queued', () => {
    const record = { ...parkedRoot({ phase: 'wake-pending', workerIds: ['a'], outcomes: [] }), status: 'queued' as const };
    expect(deriveAttention(record)).toEqual({
      bucket: 'none', tone: 'running', shape: 'ring', pulse: false, label: 'waiting for capacity',
    });
  });

  it('running still wins over leftover wake-pending', () => {
    const record = { ...parkedRoot({ phase: 'wake-pending', workerIds: ['a'], outcomes: [] }), status: 'running' as const };
    expect(deriveAttention(record)).toEqual({
      bucket: 'running', tone: 'running', shape: 'filled', pulse: true, label: 'running',
    });
  });

  it('a queued leftover wake-pending parent with a pending ask stays queued', () => {
    const record = {
      ...parkedRoot({ phase: 'wake-pending', workerIds: ['a'], outcomes: [] }),
      status: 'queued' as const,
      hasPendingHumanAsk: true,
    };
    expect(deriveAttention(record)).toEqual({
      bucket: 'none', tone: 'neutral', shape: 'ring', pulse: false, label: 'queued',
    });
    expect(deriveAttention({ ...parkedRoot({ phase: 'wake-pending', workerIds: ['a'], outcomes: [] }), status: 'queued' as const }, true))
      .toEqual({ bucket: 'none', tone: 'neutral', shape: 'ring', pulse: false, label: 'queued' });
  });

  it('counts only the workers that have not reported yet', () => {
    const outcome = (workerId: string) => ({ workerId, status: 'done', observedAt: '2026-09-05T00:00:00.000Z' });
    expect(delegationWaitLabel(parkedRoot({ workerIds: ['a', 'b'], outcomes: [outcome('a')] }).delegation)).toBe('waiting on 1 worker');
    expect(delegationWaitLabel(parkedRoot({ workerIds: ['a', 'b'], outcomes: [outcome('a'), outcome('b')] }).delegation)).toBe('waiting on workers');
  });

  it('a worker waiting on its parent is a ring; a root waiting on worker replies is still its workers', () => {
    const worker = { status: 'waiting', delegation: { role: 'worker', wait: { phase: 'parked', requestIds: ['r'] } } } as unknown as AttentionInput;
    expect(deriveAttention(worker)).toMatchObject({ bucket: 'none', tone: 'running', shape: 'ring', pulse: false, label: 'waiting on parent reply' });
    expect(deriveAttention(parkedRoot({ requestIds: ['r'] }))).toMatchObject({ bucket: 'none', shape: 'workers', label: 'waiting on worker replies' });
  });

  it('an invalid delegation never hides a waiting run', () => {
    const invalid = { status: 'waiting', delegation: { role: 'invalid', reason: 'x' } } as unknown as AttentionInput;
    expect(deriveAttention(invalid)).toMatchObject({ bucket: 'waiting', label: 'needs you' });
  });
});

it('keeps a native permission prompt above worker-wait attention (hearsay-tools/cezarion#1049)', () => {
  const waiting = { status: 'waiting' as const, hasPendingPermission: true,
    delegation: { role: 'root' as const, wait: { phase: 'parked' as const, workerIds: ['child'] } } };
  expect(deriveAttention(waiting as AttentionInput)).toMatchObject({ bucket: 'permission', label: 'needs permission' });
});

/** CI and timer parks are `waiting` with an open wait (spec 2026-10-17-unified-waits, phase 1).
 *  The cockpit derives attention from full records and stream-patched records too, which carry
 *  `waits` but no `waitingOn` key, so the rows below pass RECORDS. */
describe('open waits', () => {
  const openCi = () => ({
    kind: 'ci' as const, id: '11111111-1111-4111-8111-111111111111', source: 'agent' as const, via: 'cezar_wait' as const,
    registeredAt: '2026-10-17T15:10:00.000Z', deadline: '2026-10-17T15:40:00.000Z', phase: 'open' as const, turnId: 'turn-1',
    prUrl: 'https://github.com/o/r/pull/12', repository: 'o/r', prNumber: 12, headSha: 'a'.repeat(40),
    generation: 'gen-1', timeoutSeconds: 1800,
  });
  const openTimer = () => ({
    kind: 'timer' as const, id: '22222222-2222-4222-8222-222222222222', source: 'agent' as const, via: 'cezar_wait' as const,
    registeredAt: '2026-10-17T15:00:00.000Z', deadline: '2026-10-17T15:05:00.000Z', phase: 'open' as const, turnId: 'turn-1',
    seconds: 300,
  });

  it('reads a waiting record with an open CI or timer wait as running, not Needs you', () => {
    expect(deriveAttention({ status: 'waiting', waits: [openCi()] })).toMatchObject({ bucket: 'running', shape: 'ring', label: 'waiting for CI' });
    expect(deriveAttention({ status: 'waiting', waits: [openTimer()] })).toMatchObject({ bucket: 'running', shape: 'ring', label: 'monitoring' });
    expect(deriveAttention({ status: 'waiting', waits: [openCi()] })).toEqual({
      bucket: 'running', tone: 'running', shape: 'ring', pulse: true, label: 'waiting for CI',
    });
  });

  it('keeps an open human signal above the wait', () => {
    expect(deriveAttention({ status: 'waiting', waits: [openCi()], hasPendingHumanAsk: true }).label).toBe('needs you');
    // The transcript-context argument the cockpit passes says the same.
    expect(deriveAttention({ status: 'waiting', waits: [openCi()] }, true).label).toBe('needs you');
    expect(deriveAttention({ status: 'waiting', waitingOn: { kind: 'human' }, waits: [openCi()] }).label).toBe('needs you');
  });

  it('follows a summary\'s waitingOn when the row carries no waits', () => {
    expect(deriveAttention({
      status: 'waiting',
      waitingOn: { kind: 'ci', waitId: '11111111-1111-4111-8111-111111111111', prUrl: 'https://github.com/o/r/pull/12', repository: 'o/r', prNumber: 12, deadline: '2026-10-17T15:40:00.000Z' },
    }).label).toBe('waiting for CI');
    expect(deriveAttention({ status: 'waiting', waitingOn: { kind: 'timer', waitId: '22222222-2222-4222-8222-222222222222', at: '2026-10-17T15:05:00.000Z' } }).label).toBe('monitoring');
  });

  // Rung 10: a resolved wait is a wake owed to the agent; until its turn starts the run waits for
  // a slot, not for the user.
  it('reads a waiting record with only a resolved wait as waiting for capacity', () => {
    const resolved = { ...openCi(), phase: 'resolved' as const, resolvedAt: '2026-10-17T15:20:00.000Z' };
    const capacity = { bucket: 'none', tone: 'running', shape: 'ring', pulse: false, label: 'waiting for capacity' };
    expect(deriveAttention({ status: 'waiting', waits: [resolved] })).toEqual(capacity);
    expect(deriveAttention({ status: 'waiting', waits: [{ ...openTimer(), phase: 'resolved' as const }] })).toEqual(capacity);
    // A summary carries the flag instead of the list.
    expect(deriveAttention({ status: 'waiting', waitWakePending: true })).toEqual(capacity);
    // An open CI or timer wait still names what the run waits on.
    expect(deriveAttention({ status: 'waiting', waits: [resolved, openTimer()] }).label).toBe('monitoring');
    expect(deriveAttention({ status: 'waiting', waits: [{ ...openTimer(), phase: 'resolved' as const }, openCi()] }).label).toBe('waiting for CI');
    // An open human signal still wins.
    expect(deriveAttention({ status: 'waiting', waits: [resolved], hasPendingHumanAsk: true }).label).toBe('needs you');
    expect(deriveAttention({ status: 'waiting', waits: [resolved] }, true).label).toBe('needs you');
    // Delivered and cancelled entries are no wake.
    expect(deriveAttention({ status: 'waiting', waits: [{ ...resolved, phase: 'delivered' as const }] }).label).toBe('needs you');
    expect(deriveAttention({ status: 'running', waits: [resolved] }).label).toBe('running');
  });

  // Workers outrank CI and timers (`computeWaitingOn`), and a worker park keeps its open waits
  // (hearsay-tools/cezarion#1233): the workers' label and their owed wake stay on top.
  it('keeps a parked or wake-pending worker wait above open CI and timer waits', () => {
    const root = (phase: 'parked' | 'wake-pending', waits: unknown[]) => ({
      status: 'waiting', waits, delegation: { role: 'root', wait: { phase, workerIds: ['a'], outcomes: [] } },
    } as unknown as AttentionInput);
    for (const waits of [[openTimer()], [openCi()], [openCi(), openTimer()]]) {
      expect(deriveAttention(root('parked', waits))).toMatchObject({ shape: 'workers', label: 'waiting on 1 worker' });
      expect(deriveAttention(root('wake-pending', waits))).toEqual({
        bucket: 'none', tone: 'running', shape: 'ring', pulse: false, label: 'waiting for capacity',
      });
      expect(deriveAttention({ ...root('wake-pending', waits), hasPendingHumanAsk: true }).label).toBe('needs you');
    }
  });

  it('leaves every other status alone', () => {
    expect(deriveAttention({ status: 'running', waits: [openCi()] }).label).toBe('running');
    expect(deriveAttention({ status: 'review', waits: [openCi()] }).label).toBe('needs review');
    expect(deriveAttention({ status: 'failed', waits: [openCi()] }).label).toBe('failed');
    expect(deriveAttention({ status: 'waiting' }).label).toBe('needs you'); // no wait: unchanged fallback
    expect(deriveAttention({ status: 'running', activity: 'monitoring' }).label).toBe('monitoring'); // legacy summary rows
  });
});

// hearsay-tools/cezarion#1235 (phase 3a): worker waits are wait-list entries.
describe('computeWaitingOn and worker entries', () => {
  const ids = (n: number) => Array.from({ length: n }, (_, i) => `99999999-9999-4999-8999-99999999999${i}`);
  const workerWait = (id: string, workerIds: string[], reported: string[] = []): WorkerWaitEntry => ({
    kind: 'worker', id, source: 'agent', via: 'cezar_wait', registeredAt: '2026-10-19T10:00:00.000Z',
    deadline: '2026-10-19T10:10:00.000Z', phase: 'open', turnId: 'turn-1', timeoutSeconds: 600,
    workerIds, revisions: [],
    outcomes: reported.map((workerId) => ({ workerId, status: 'done' as const, observedAt: '2026-10-19T10:03:00.000Z' })),
  });
  const ci = {
    kind: 'ci' as const, id: '11111111-1111-4111-8111-111111111111', source: 'agent' as const, via: 'cezar_wait' as const,
    registeredAt: '2026-10-19T10:00:00.000Z', deadline: '2026-10-19T10:30:00.000Z', phase: 'open' as const, turnId: 'turn-1',
    prUrl: 'https://github.com/o/r/pull/12', repository: 'o/r', prNumber: 12, headSha: 'a'.repeat(40), generation: 'gen-1', timeoutSeconds: 1800,
  };

  it('computeWaitingOn counts unreported workers across two worker entries', () => {
    const [a, b, c] = ids(3);
    const waits = [
      workerWait('88888888-8888-4888-8888-888888888881', [a!, b!], [b!]),
      workerWait('88888888-8888-4888-8888-888888888882', [c!]),
      workerWait('88888888-8888-4888-8888-888888888883', [a!, c!], [a!, c!]),
    ];
    // 1 + 1 unreported across the first two; the third has every worker reported.
    expect(computeWaitingOn({ waits: waits.slice(0, 2) })).toEqual({ kind: 'workers', count: 2 });
    expect(computeWaitingOn({ waits: [workerWait('88888888-8888-4888-8888-888888888884', [a!, b!]), workerWait('88888888-8888-4888-8888-888888888885', [c!])] }))
      .toEqual({ kind: 'workers', count: 3 });
    // Only open entries count.
    expect(computeWaitingOn({ waits: [{ ...waits[0]!, phase: 'resolved' as const }] })).toBeUndefined();
  });

  it('a worker entry outranks an open ci wait', () => {
    const [a] = ids(1);
    expect(computeWaitingOn({ waits: [ci, workerWait('88888888-8888-4888-8888-888888888881', [a!])] })).toEqual({ kind: 'workers', count: 1 });
  });

  it('a human wait outranks a worker entry', () => {
    const [a] = ids(1);
    const waits = [workerWait('88888888-8888-4888-8888-888888888881', [a!])];
    expect(computeWaitingOn({ waits, hasPendingHumanAsk: true })).toEqual({ kind: 'human' });
  });
});
