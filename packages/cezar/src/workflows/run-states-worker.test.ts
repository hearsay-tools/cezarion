import { idleClose, observeIdleClose } from './worker-wait-readiness.testkit.ts';
import { describe, expect, it } from 'vitest';
import { RUN_TRIGGERS, stateOf } from './run-states.ts';
import { manager, parent, spendWorkerBudget, store, until, useWorkerWaitFixture, worker } from './worker-wait.testkit.ts';

/** Rows of the run state table that only an owned worker reaches (hearsay-tools/cezarion#1804). */
describe('run states of an owned worker', { timeout: 45_000 }, () => {
  useWorkerWaitFixture();

  // unified-waits phase 3b lists only a person or the parent as exits of this park. The code arms
  // the idle timer at the park, and the idle close settles the worker done.
  it('a budget-spent worker plain park settles done after the idle timer', async () => {
    const p = await parent();
    await until(() => store.getRun(p.id)?.status === 'waiting');
    const w = await worker(p.id);
    spendWorkerBudget(w.id);
    const clock = observeIdleClose();
    manager.enqueueOwnedRun(w.id);
    await until(() => store.readEvents(w.id).some((event) => event.type === 'turn-end') && store.getRun(w.id)?.status === 'waiting');
    expect(stateOf(store.getRun(w.id)!)).toBe('waiting:plain');
    await idleClose(clock, w.id, manager, store, until);
    await until(() => store.getRun(w.id)?.status === 'done');
    expect(RUN_TRIGGERS.find((row) => row.id === 'plain.worker-idle')?.to).toEqual(['done']);
  });

  // The cockpit's Stop calls cancel() on any run. A settled owned worker keeps its status, so the
  // result its parent collects stays the one it settled with (hearsay-tools/squawk#1907).
  it('Stop on a worker that settled done keeps done', async () => {
    const p = await parent();
    await until(() => store.getRun(p.id)?.status === 'waiting');
    const w = await worker(p.id, 'mock:cezar-done');
    manager.enqueueOwnedRun(w.id);
    await until(() => store.getRun(w.id)?.status === 'done' && !manager.isActive(w.id));
    expect(manager.cancel(w.id)).toBe(false);
    expect(store.getRun(w.id)?.status).toBe('done');
    expect(RUN_TRIGGERS.find((row) => row.id === 'worker.stop')?.states).not.toContain('done');
  });
});
