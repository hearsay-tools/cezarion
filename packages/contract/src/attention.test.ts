import { describe, expect, it } from 'vitest';
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
    expect(attention.label).toBe(phase === 'parked' ? 'waiting on 1 worker' : 'needs you');
    expect(attention.bucket).toBe(phase === 'parked' ? 'none' : 'waiting');
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
