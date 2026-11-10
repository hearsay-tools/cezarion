import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WAIT_LIMIT, type Wait } from '@open-mercato/cezar-contract/waits';
import { WAIT_PHASE, makeHumanWait, makeTimerWait } from '@open-mercato/cezar-contract/test-factories.testkit';
import { openTestRunStore, seedWaits } from './run-store.testkit.ts';
import { strictRunExits, takeRunExitViolations } from './run-exits.ts';
import type { RunStore } from './store.ts';

const at = '2026-11-09T12:00:00.000Z';
let directory: string;
let store: RunStore;
let id: string;
let previous: boolean;

beforeEach(() => {
  previous = strictRunExits(true);
  directory = mkdtempSync(join(tmpdir(), 'cez-wait-phases-'));
  store = openTestRunStore(join(directory, '.ai/cezar'), { keepLive: true });
  id = store.createRun({ title: 'phases', workflow: 'quick-task', task: 'wait', steps: [] }).id;
});
afterEach(() => {
  takeRunExitViolations();
  strictRunExits(previous);
  store.close();
  rmSync(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('wait writes use the shared violation sink', () => {
  it.each(['open', 'resolved'] as const)('accepts new open, open → %s and repeated writes', phase => {
    const wait = makeTimerWait({ id: randomUUID() });
    store.commitWait(id, wait);
    const next = { ...wait, phase, ...(phase === 'resolved' ? { resolvedAt: at } : {}) };
    store.commitWait(id, next);
    store.commitWait(id, next);
    expect(store.getRun(id)?.waits).toEqual([next]);
    expect(takeRunExitViolations()).toEqual([]);
  });

  it('accepts delivery, answers and cancellation and preserves settled order', () => {
    const resolved = makeTimerWait({ id: randomUUID(), phase: WAIT_PHASE.resolved, resolvedAt: at });
    const human = makeHumanWait({ id: randomUUID() });
    const open = makeTimerWait({ id: randomUUID() });
    const cancelled = makeTimerWait({ id: randomUUID(), phase: WAIT_PHASE.resolved, resolvedAt: at });
    seedWaits(store, id, { waits: [open, cancelled, human, resolved] });
    const receipt = store.commitOutcome(id, [
      { kind: 'delivered', inputIds: [resolved.id], at },
      { kind: 'answered' },
      { kind: 'cancelled', waitIds: [open.id, cancelled.id] },
    ]);
    expect(receipt.settled.map(wait => [wait.id, wait.phase])).toEqual([
      [resolved.id, 'delivered'], [human.id, 'delivered'], [open.id, 'cancelled'], [cancelled.id, 'cancelled'],
    ]);
    expect(store.getRun(id)?.lastWaits).toEqual(receipt.settled);
    expect(store.getRun(id)?.waits).toBeUndefined();
    expect(takeRunExitViolations()).toEqual([]);
  });

  it.each(['new', 'resolved', 'settled'] as const)('reports one %s violation after the write lands', from => {
    const wait = makeTimerWait({ id: randomUUID(), phase: from === 'new' ? 'resolved' : 'open' });
    if (from === 'resolved') seedWaits(store, id, { waits: [{ ...wait, phase: WAIT_PHASE.resolved, resolvedAt: at }] });
    if (from === 'settled') seedWaits(store, id, { lastWaits: [{ ...wait, phase: WAIT_PHASE.cancelled, cancelledAt: at }] });
    store.commitWait(id, wait);
    expect(store.getRun(id)?.waits).toEqual([wait]);
    expect(takeRunExitViolations()).toEqual([
      `undeclared wait transition: timer wait ${wait.id} from ${from} to ${wait.phase} (declare it in workflows/run-states.ts WAIT_PHASES)`,
    ]);
  });

  it('warns once per violation outside strict mode, records nothing and writes each entry', () => {
    strictRunExits(false);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const waits = Array.from({ length: 2 }, () => makeTimerWait({ id: randomUUID(), phase: WAIT_PHASE.resolved }));
    for (const wait of waits) store.commitWait(id, wait);
    expect(store.getRun(id)?.waits).toEqual(waits);
    expect(warn.mock.calls).toEqual(waits.map(wait => [
      `undeclared wait transition: timer wait ${wait.id} from new to resolved (declare it in workflows/run-states.ts WAIT_PHASES)`,
    ]));
    expect(takeRunExitViolations()).toEqual([]);
  });

  it('records nothing when capacity refuses a settled id written again', () => {
    const wait = makeTimerWait({ id: randomUUID() });
    const waits: Wait[] = Array.from({ length: WAIT_LIMIT }, () => makeTimerWait({ id: randomUUID() }));
    seedWaits(store, id, { waits, lastWaits: [{ ...wait, phase: WAIT_PHASE.cancelled, cancelledAt: at }] });
    expect(() => store.commitWait(id, wait)).toThrow(`open wait limit reached (${WAIT_LIMIT})`);
    expect(store.getRun(id)?.waits).toEqual(waits);
    expect(takeRunExitViolations()).toEqual([]);
  });

  it('records nothing for a matching receipt replay after settlement', () => {
    const wait = makeTimerWait({ id: randomUUID() });
    const registration = { operationId: randomUUID(), requestHash: 'a'.repeat(64), wait, deduplicated: false };
    store.commitWait(id, wait, undefined, registration);
    store.commitOutcome(id, { kind: 'cancelled', waitIds: [wait.id] });
    const before = store.getRun(id);
    store.commitWait(id, wait, undefined, registration);
    expect(store.getRun(id)).toEqual(before);
    expect(takeRunExitViolations()).toEqual([]);
  });

  it.each(['delivered', 'cancelled'] as const)('keeps the existing refusal for a %s registration', phase => {
    const wait = makeTimerWait({ id: randomUUID(), phase });
    expect(() => store.commitWait(id, wait)).toThrow('a settled wait is committed through its delivery or cancellation');
    expect(store.getRun(id)?.waits).toBeUndefined();
    expect(takeRunExitViolations()).toEqual([]);
  });
});
