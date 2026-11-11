import { WaitEngine } from './wait-engine.ts';
import { seedWaits } from '../../runs/run-store.testkit.ts';
import { afterEach, expect, it, vi } from 'vitest';
import { makeWorkerWait, WAIT_PHASE } from '@open-mercato/cezar-contract/test-factories.testkit';
import { unused } from '../fixture-no-runner.testkit.ts';
import { boundaryOrderFixture } from './boundary-order.testkit.ts';
import { FamilyReconciler } from './family-reconciler.ts';
import { transitionTurnBoundary } from './turn-boundary.ts';

afterEach(() => vi.restoreAllMocks());

it.each([true, false])('destroyed worker receipts retire only during an executing parent turn (%s)', atBoundary => {
  const f = boundaryOrderFixture();
  f.store.updateRun(f.run.id, { delegation: { role: 'root', permissions: ['spawn', 'wait', 'steer'], receipts: [] } });
  const child = f.store.createRun({ title: 'worker', task: 'work', workflow: 'quick-task', steps: [] });
  f.store.updateRun(child.id, { delegation: { role: 'worker', permissions: [], parentRunId: f.run.id,
    workspace: { ownerRunId: child.id, resourceId: child.id, kind: 'owned-isolated', path: f.root, branch: 'worker', baselineSha: 'a'.repeat(40) },
    destroy: { requestedAt: new Date().toISOString(), phase: 'complete', remaining: [] },
  } });
  const wait = makeWorkerWait({ phase: WAIT_PHASE.resolved, workerIds: [child.id] });
  seedWaits(f.store, f.run.id, { waits: [wait] });
  if (atBoundary) transitionTurnBoundary(f.state, { kind: 'turn-end', phase: 'ui-completed', session: f.wire });
  type Host = ConstructorParameters<typeof FamilyReconciler>[1];
  const reconciler = new FamilyReconciler(f.context, unused<Host>('family host', {
    waitEngine: Object.assign(new WaitEngine(f.context, unused<ConstructorParameters<typeof WaitEngine>[1]>('engine'), 10), { resolveWorkerWait: () => true }),
    active: id => f.active.get(id), isActive: id => f.active.has(id), recoveringRun: () => false,
    retireSettledQuestions: () => undefined,
  }));
  reconciler.reconcileWorkerWaits(f.run.id);
  expect(f.store.getRun(f.run.id)?.waits?.find(entry => entry.id === wait.id)?.phase).toBe(atBoundary ? WAIT_PHASE.resolved : undefined);
  reconciler.dispose();
});
