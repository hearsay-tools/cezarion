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
    manager.enqueueOwnedRun(w.id);
    await until(() => store.readEvents(w.id).some((event) => event.type === 'turn-end') && store.getRun(w.id)?.status === 'waiting');
    expect(stateOf(store.getRun(w.id)!)).toBe('waiting:plain');
    const timer = manager['active'].get(w.id)?.idleTimer as (NodeJS.Timeout & { _onTimeout(): void }) | undefined;
    expect(timer).toBeDefined();
    const expire = timer!._onTimeout;
    clearTimeout(timer);
    expire();
    await until(() => store.getRun(w.id)?.status === 'done');
    expect(RUN_TRIGGERS.find((row) => row.id === 'plain.worker-idle')?.to).toEqual(['done']);
  });

  // The cockpit's Stop calls cancel() on any run. For an owned worker it commits cancelled first,
  // whatever the status, so a settled worker's done is replaced.
  it('Stop on a worker that settled done records it cancelled', async () => {
    const p = await parent();
    await until(() => store.getRun(p.id)?.status === 'waiting');
    const w = await worker(p.id, 'mock:cezar-done');
    manager.enqueueOwnedRun(w.id);
    await until(() => store.getRun(w.id)?.status === 'done' && !manager.isActive(w.id));
    expect(manager.cancel(w.id)).toBe(false);
    expect(store.getRun(w.id)?.status).toBe('cancelled');
    expect(RUN_TRIGGERS.find((row) => row.id === 'worker.stop-settled')?.to).toEqual(['cancelled']);
  });
});
