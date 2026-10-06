import { describe, expect, it, vi } from 'vitest';

import { QUICK_TASK_WORKFLOW } from './types.ts';
import { fixtureUpdateRun, manager, parent, store, until, useWorkerWaitFixture, waitOf, worker } from './worker-wait.testkit.ts';

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
    const other = store.createRun({ title: 'other', workflow: 'quick-task', task: 'mock:done', workflowDef: QUICK_TASK_WORKFLOW,
      steps: QUICK_TASK_WORKFLOW.steps.map((step) => ({ id: step.id, name: step.id, kind: 'agent' as const })) });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let reached = false;
    const internals = manager as unknown as { reviveQueuedRun(...args: unknown[]): Promise<void> };
    const revive = internals.reviveQueuedRun.bind(manager);
    vi.spyOn(internals, 'reviveQueuedRun').mockImplementation(async (...args) => { reached = true; await gate; return revive(...args); });
    const recovery = manager.recover(other.id);
    await until(() => reached);

    // The worker settles while the other family is still recovering.
    fixtureUpdateRun(w.id, { status: 'done' }); manager.reconcileWorkerWaits(p.id);
    release(); await recovery;

    await until(() => !waitOf(store.getRun(p.id)));
    expect(store.getRun(p.id)?.agentInputs?.filter((input) => input.id === wait.id)).toHaveLength(1);
    expect(store.getRun(p.id)?.delegation).toMatchObject({ lastWait: { id: wait.id, reason: 'outcome' } });
  });
});
