import { describe, expect, it, vi } from 'vitest';
import { WAIT_PHASE, WAIT_VIA, makeHumanWait, makePeerWait, makeProcessWait, makePrWait, makeRunRecord,
  makeSubagentWait, makeTimerWait, makeWorkerWait } from '@open-mercato/cezar-contract/test-factories.testkit';
import type { Wait } from '@open-mercato/cezar-contract/waits';
import { cappedTimersBeforeFlush } from './input-delivery.ts';

const cap = 40;
function fixture(spent: number, admitted: boolean, boundary: boolean) {
  const trace: string[] = [];
  const reads = {
    countAutomaticWakes: vi.fn((before?: { spent: number }) => { trace.push('count'); return before?.spent ?? spent; }),
    isAdmitted: vi.fn(() => { trace.push('admitted'); return admitted; }),
    atTurnBoundary: vi.fn(() => { trace.push('boundary'); return boundary; }),
  };
  return { trace, reads };
}

describe('cappedTimersBeforeFlush', () => {
  it('uses the old budget snapshot even after the durable budget reset', () => {
    const timer = makeTimerWait({ phase: WAIT_PHASE.resolved });
    const run = makeRunRecord({ automaticWakes: 0, waits: [timer] });
    const before = { spent: cap };
    const f = fixture(0, true, true);
    expect(cappedTimersBeforeFlush(run, before, f.reads, cap)).toEqual([timer]);
    expect(f.reads.countAutomaticWakes).toHaveBeenCalledWith(before);
    expect(f.trace).toEqual(['count', 'admitted', 'boundary']);
    expect(run.automaticWakes).toBe(0);
  });

  it.each([
    { spent: cap - 1, admitted: true, boundary: true, trace: ['count'] },
    { spent: cap, admitted: false, boundary: true, trace: ['count', 'admitted'] },
    { spent: cap + 1, admitted: false, boundary: true, trace: ['count', 'admitted'] },
    { spent: cap, admitted: true, boundary: false, trace: ['count', 'admitted', 'boundary'] },
  ])('leaves results owed for %j', row => {
    const f = fixture(row.spent, row.admitted, row.boundary);
    const run = makeRunRecord({ waits: [makeTimerWait({ phase: WAIT_PHASE.resolved })] });
    Object.defineProperty(run, 'waits', { get: () => { throw Error('waits read past a rejected guard'); } });
    expect(cappedTimersBeforeFlush(run, undefined, f.reads, cap)).toEqual([]);
    expect(f.reads.countAutomaticWakes).toHaveBeenCalledWith(undefined);
    expect(f.trace).toEqual(row.trace);
  });

  it.each([cap, cap + 1])('returns only resolved charging results, oldest first, at %s', spent => {
    const resolved = { phase: WAIT_PHASE.resolved, resolvedAt: '2026-11-01T00:00:00.000Z' };
    const timer = makeTimerWait({ ...resolved, via: WAIT_VIA.cezar_wait, resolvedAt: '2026-11-01T00:00:01.000Z' });
    const monitoring = makeTimerWait(resolved);
    const process = makeProcessWait(resolved);
    const peer = makePeerWait(resolved);
    const timeout = makeSubagentWait({ ...resolved, result: { reason: 'timeout' } });
    const noncharging: Wait[] = [makePrWait(resolved), makeWorkerWait(resolved), makeHumanWait(resolved),
      makeSubagentWait({ ...resolved, result: { reason: 'settled' } }),
      makeTimerWait(), makeTimerWait({ phase: WAIT_PHASE.delivered })];
    const waits = [timer, monitoring, process, peer, timeout, ...noncharging];
    const run = makeRunRecord({ waits });
    const f = fixture(spent, true, true);
    const result = cappedTimersBeforeFlush(run, undefined, f.reads, cap);
    expect(result).toEqual([monitoring, process, peer, timeout, timer]);
    expect(result[0]).toBe(monitoring);
    expect(run.waits).toBe(waits);
    expect(run.waits).toEqual(waits);
    expect(f.trace).toEqual(['count', 'admitted', 'boundary']);
  });

  it.each([{ waits: undefined }, { waits: [] }])('returns no charging results without waits: %j', ({ waits }) => {
    const f = fixture(cap, true, true);
    expect(cappedTimersBeforeFlush(makeRunRecord({ waits }), undefined, f.reads, cap)).toEqual([]);
  });
});
