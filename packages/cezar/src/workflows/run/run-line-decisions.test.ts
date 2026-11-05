import { describe, expect, it, vi } from 'vitest';
import { makeRunRecord } from '@open-mercato/cezar-contract/test-factories.testkit';
import type { RunnerId } from '../../core/agent-runner.ts';
import type { AccountHolds } from '../../workspace/semaphore.ts';
import { oldestEligibleWakeAt } from './run-line.ts';

function fixture(entries: Array<[string, number | undefined]>, held = false) {
  const trace: string[] = [];
  const holds: AccountHolds = { deadline: new Set(held ? ['codex:default'] : []), inFlight: new Set() };
  const runs = new Map(entries.map(([id]) => [id, makeRunRecord({ id, runner: 'claude' })]));
  const blocked = new Set<string>();
  const reads = {
    wakeJoinedAt: vi.fn((id: string) => { trace.push(`wake:${id}`); return new Map(entries).get(id); }),
    accountHolds: vi.fn(() => { trace.push('holds'); return holds; }),
    getRun: vi.fn((id: string) => { trace.push(`run:${id}`); return runs.get(id); }),
    canLeaveLine: vi.fn((id: string, actual: AccountHolds, fallback: RunnerId) => {
      trace.push(`leave:${id}:${fallback}`); expect(actual).toBe(holds); return !blocked.has(id);
    }),
  };
  return { trace, holds, runs, blocked, reads, ids: entries.map(([id]) => id) };
}

describe('oldestEligibleWakeAt', () => {
  it.each([{ entries: [] }, { entries: [['fresh', undefined]] }] satisfies Array<{ entries: Array<[string, number | undefined]> }>)(
    'does not read holds or eligibility without a wake: %j', ({ entries }) => {
      const f = fixture(entries);
      expect(oldestEligibleWakeAt(f.ids, f.reads, undefined)).toBeNull();
      expect(f.reads.accountHolds).not.toHaveBeenCalled();
      expect(f.reads.getRun).not.toHaveBeenCalled();
      expect(f.reads.canLeaveLine).not.toHaveBeenCalled();
    });

  it('does not advertise a reclaiming candidate that cannot leave the line', () => {
    const f = fixture([['reclaiming', 1]]);
    f.blocked.add('reclaiming');
    expect(oldestEligibleWakeAt(f.ids, f.reads, 'claude')).toBeNull();
    expect(f.trace).toEqual(['wake:reclaiming', 'holds', 'leave:reclaiming:claude']);
  });

  it('keeps scanning after a blocked older candidate, and reads holds only once', () => {
    const f = fixture([['blocked', 1], ['eligible', 5], ['newer', 8], ['equal', 5], ['oldest', 0]], true);
    f.blocked.add('blocked');
    expect(oldestEligibleWakeAt(f.ids, f.reads, 'codex')).toBe(0);
    expect(f.trace).toEqual(['wake:blocked', 'holds', 'run:blocked', 'leave:blocked:codex',
      'wake:eligible', 'run:eligible', 'leave:eligible:codex', 'wake:newer', 'wake:equal',
      'wake:oldest', 'run:oldest', 'leave:oldest:codex']);
    expect(f.reads.accountHolds).toHaveBeenCalledTimes(1);
  });

  it('allows a runnerless wake with unknown default when nothing is held, without reading its record', () => {
    const f = fixture([['legacy', 1]]);
    f.runs.set('legacy', makeRunRecord({ id: 'legacy' }));
    expect(oldestEligibleWakeAt(f.ids, f.reads, undefined)).toBe(1);
    expect(f.trace).toEqual(['wake:legacy', 'holds', 'leave:legacy:claude']);
  });

  it.each(['runnerless', 'missing'] as const)('does not advertise a %s wake before the default is known while held', kind => {
    const f = fixture([['legacy', 1]], true);
    if (kind === 'missing') f.runs.delete('legacy');
    else f.runs.set('legacy', makeRunRecord({ id: 'legacy' }));
    expect(oldestEligibleWakeAt(f.ids, f.reads, undefined)).toBeNull();
    expect(f.trace).toEqual(['wake:legacy', 'holds', 'run:legacy']);
    expect(f.reads.canLeaveLine).not.toHaveBeenCalled();
  });

  it.each([false, true])('passes the configured default to runnerless eligibility, blocked=%s', blocked => {
    const f = fixture([['legacy', 1]], true);
    f.runs.set('legacy', makeRunRecord({ id: 'legacy' }));
    if (blocked) f.blocked.add('legacy');
    expect(oldestEligibleWakeAt(f.ids, f.reads, 'codex')).toBe(blocked ? null : 1);
    expect(f.trace).toEqual(['wake:legacy', 'holds', 'run:legacy', 'leave:legacy:codex']);
  });

  it('does not reject an explicit runner when the configured default is unknown', () => {
    const f = fixture([['explicit', 1]], true);
    expect(oldestEligibleWakeAt(f.ids, f.reads, undefined)).toBe(1);
    expect(f.trace).toEqual(['wake:explicit', 'holds', 'run:explicit', 'leave:explicit:claude']);
  });

  it('reads deadline then in-flight holds, including an in-flight-only hold', () => {
    const f = fixture([['legacy', 1]]);
    f.runs.set('legacy', makeRunRecord({ id: 'legacy' }));
    Object.defineProperty(f.holds, 'deadline', { get: () => { f.trace.push('deadline'); return new Set(); } });
    Object.defineProperty(f.holds, 'inFlight', { get: () => { f.trace.push('inFlight'); return new Set(['codex:default']); } });
    expect(oldestEligibleWakeAt(f.ids, f.reads, undefined)).toBeNull();
    expect(f.trace).toEqual(['wake:legacy', 'holds', 'deadline', 'inFlight', 'run:legacy']);
  });
});
