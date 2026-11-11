import { WaitEngine } from './wait-engine.ts';
import { afterEach, expect, it, vi } from 'vitest';
import { makeWorkerWait, RUN_STATUS, WAIT_KIND, WAIT_VIA, WAIT_SOURCE, WAIT_PHASE } from '@open-mercato/cezar-contract/test-factories.testkit';
import { seedWaits } from '../../runs/run-store.testkit.ts';
import { unused } from '../fixture-no-runner.testkit.ts';
import * as rules from '../turn-end.ts';
import type { CompletionRefusal } from '../completion-policy.ts';
import type { UiEventSink } from '../../runs/ui-event-sink.ts';
import { boundaryOrderFixture } from './boundary-order.testkit.ts';
import { WaitRegistry } from './wait-registry.ts';
import { WakeAdmission } from './wake-admission.ts';
import { transitionTurnBoundary } from './turn-boundary.ts';

function fixture(count: number) {
  const f = boundaryOrderFixture();
  const worker = f.store.createRun({ title: 'worker', task: 'work', workflow: 'quick-task', steps: [] });
  f.store.updateRun(worker.id, { delegation: { role: 'worker', permissions: [], parentRunId: f.run.id,
    workspace: { ownerRunId: worker.id, resourceId: worker.id, kind: 'owned-isolated', path: f.root, branch: 'worker', baselineSha: 'a'.repeat(40) },
  } });
  seedWaits(f.store, f.run.id, { waits: Array.from({ length: count }, () => makeWorkerWait()) });
  type Host = ConstructorParameters<typeof WaitRegistry>[1];
  const reconcileWorkerWaits = vi.fn();
  const noticeParkedWorkers = vi.fn();
  const registry = new WaitRegistry(f.context, unused<Host>('registry', {
    active: id => f.active.get(id), reconcileWorkerWaits,
    waitEngine: new WaitEngine(f.context, unused<ConstructorParameters<typeof WaitEngine>[1]>('engine', { reconcileWorkerWaits, noticeParkedWorkers }), 10),
  }), 10);
  const commit = vi.spyOn(f.store, 'commitWait');
  return { ...f, worker, registry, commit, reconcileWorkerWaits, noticeParkedWorkers };
}

afterEach(() => vi.restoreAllMocks());

it('a full wait list silently refuses the completion wait before commit or reconciliation', () => {
  const f = fixture(16);
  const before = structuredClone(f.store.getRun(f.run.id)?.waits);
  expect(f.registry.registerCompletionWait(f.run.id, [f.worker.id])).toBeUndefined();
  expect(f.store.getRun(f.run.id)?.waits).toEqual(before);
  expect(f.commit).not.toHaveBeenCalled();
  expect(f.reconcileWorkerWaits).not.toHaveBeenCalled();
  expect(f.noticeParkedWorkers).not.toHaveBeenCalled();
});

it('below capacity the completion wait commits before reconcile and notice', () => {
  const f = fixture(15);
  const entry = f.registry.registerCompletionWait(f.run.id, [f.worker.id]);
  expect(entry).toMatchObject({ kind: WAIT_KIND.worker, via: WAIT_VIA.completion, source: WAIT_SOURCE.cezar, phase: WAIT_PHASE.open });
  expect(f.store.getRun(f.run.id)?.waits).toHaveLength(16);
  expect(f.commit).toHaveBeenCalledWith(f.run.id, entry);
  expect(f.reconcileWorkerWaits).toHaveBeenCalledWith(f.run.id);
  expect(f.noticeParkedWorkers).toHaveBeenCalledWith(f.run.id);
  expect(f.commit.mock.invocationCallOrder[0]).toBeLessThan(f.reconcileWorkerWaits.mock.invocationCallOrder[0]!);
  expect(f.reconcileWorkerWaits.mock.invocationCallOrder[0]).toBeLessThan(f.noticeParkedWorkers.mock.invocationCallOrder[0]!);
});

it('other commit errors escape without reconciliation or notice', () => {
  const f = fixture(0);
  const error = new Error('checkpoint failed');
  f.commit.mockImplementation(() => { throw error; });
  expect(() => f.registry.registerCompletionWait(f.run.id, [f.worker.id])).toThrow(error);
  expect(f.reconcileWorkerWaits).not.toHaveBeenCalled();
  expect(f.noticeParkedWorkers).not.toHaveBeenCalled();
});

it.each(['endTurn', 'settleTurn'] as const)('%s parks and frees the slot after a completion wait refusal', entry => {
  const f = fixture(16);
  const refusal: CompletionRefusal = { code: 'workers_outstanding', workers: [], message: 'workers remain', liveWorkerIds: [f.worker.id] };
  vi.spyOn(rules, 'decideTurnEnd').mockReturnValue({ kind: 'completion-wait' });
  type Host = ConstructorParameters<typeof WakeAdmission>[1];
  const admission = new WakeAdmission(f.context, unused<Host>('admission', {
    line: unused<Host['line']>('line', { park: vi.fn(), leavePool: () => false }),
    armIdleTimer: vi.fn(), queueWaitWake: vi.fn(), releaseSlot: f.host.releaseSlot,
  }), 10, 10);
  Object.assign(f.host, {
    waitRegistry: f.registry, completionGate: () => refusal,
    parkOnWaits: (id: string, state: typeof f.state) => admission.parkOnWaits(id, state),
  });
  if (entry === 'endTurn') {
    transitionTurnBoundary(f.state, { kind: 'done-request', session: f.wire });
    f.settler.endTurn(f.run.id, f.state, unused<UiEventSink>('sink'), { stepId: 'step', scheduleWakeup: undefined });
  } else {
    expect(f.settler.settleTurn(f.run.id, f.state, 'ack', {
      stepId: 'step', monitoring: false, humanGate: false, ask: null, done: false, nudgedLastTurn: false,
    }, refusal)).toBe(true);
  }
  expect(f.store.getRun(f.run.id)?.status).toBe(RUN_STATUS.waiting);
  expect(f.store.getRun(f.run.id)?.waits).toHaveLength(16);
  expect(f.host.releaseSlot).toHaveBeenCalledTimes(1);
  expect(f.commit).not.toHaveBeenCalled();
});
