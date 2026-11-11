import { RUN_STATUS, STEP_KIND } from '@open-mercato/cezar-contract/test-factories.testkit';
import { describe, expect, it, vi } from 'vitest';

import * as catalog from './load.ts';
import { QUICK_TASK_WORKFLOW } from './types.ts';
import { fixtureUpdateRun, lastWaitOf, manager, parent, root, store, until, useWorkerWaitFixture, waitOf, worker } from './worker-wait-claude.testkit.ts';

/**
 * Recovery for one adopted family (#779, plan step 3) runs while the rest of the project is live.
 * Boot recovery holds back worker wakes, input flushes and delegation reconciles while it rebuilds;
 * a recovery scoped to one family may hold back only that family's.
 */
describe('a recovery scoped to one family', { timeout: 30_000 }, () => {
  useWorkerWaitFixture();

  it('holds back only its own family: another family\'s parent still wakes when its worker settles', async () => {
    const p = await parent(); const w = await worker(p.id);
    const wait = manager.registerWorkerWait(p.id, { workerIds: [w.id], timeoutSeconds: 600, mode: 'all' });
    await until(() => waitOf(store.getRun(p.id))?.phase === 'parked');
    // Another family: queued, in this store's memory, not in the manager's queue — the state an
    // adoption hands recovery. Its revive is held so the recovery stays in progress.
    const other = store.createRun({ title: 'other', workflow: 'quick-task', task: 'mock:cezar-done',
      steps: QUICK_TASK_WORKFLOW.steps.map((step) => ({ id: step.id, name: step.id, kind: STEP_KIND.agent })) });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let reached = false;
    const load = catalog.loadWorkflows;
    vi.spyOn(catalog, 'loadWorkflows').mockImplementation(async (...args) => {
      if (args[0] === root) { reached = true; await gate; }
      return load(...args);
    });
    const recovery = manager.recover(other.id);
    await until(() => reached);

    // The worker settles while the other family is still recovering.
    fixtureUpdateRun(w.id, { status: RUN_STATUS.done }); manager.reconcileWorkerWaits(p.id);
    await until(() => waitOf(store.getRun(p.id))?.phase === 'wake-pending');
    expect(store.getRun(p.id)?.agentInputs?.filter(input => input.id === wait.id)).toEqual([expect.objectContaining({ id: wait.id })]);
    expect(store.getRun(p.id)?.agentInputs?.find(input => input.id === wait.id)?.deliveredAt).toBeUndefined();
    release(); await recovery;
    await until(() => !waitOf(store.getRun(p.id)));
    expect(store.getRun(p.id)?.agentInputs?.filter((input) => input.id === wait.id)).toHaveLength(1);
    // hearsay-tools/cezarion#1235: an agent worker wait's receipt is in `lastWaits`.
    expect(lastWaitOf(store.getRun(p.id))).toMatchObject({ id: wait.id, reason: 'outcome' });
  });
});
