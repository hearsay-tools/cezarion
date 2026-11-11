import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { type RunRecord } from '../runs/store.ts';
import { controlledWire, manager, parent, register, restart, root, semaphore, store, until, useWorkerWaitFixture, waitOf, lastWaitOf, worker } from './worker-wait-claude.testkit.ts';
import { blockRunWrites, readPersistedRuns } from '../runs/run-store.testkit.ts';

// Real Git, durable fsync checkpoints and process shutdown share this outer budget.
// Keep the separate 15s state/termination assertions and actual runner timers intact.

// Real Git, durable checkpoints and native process shutdown retain their original budgets.
describe('worker waits: cancellation', { timeout: 30_000 }, () => {
  useWorkerWaitFixture();

it('cancels before park durably without releasing an executing parent slot', async () => {
    const release = join(root, 'release-cancelled-turn'); const wire = controlledWire({ firstResultGate: release });
    const p = await parent(); await until(wire.initialReceived); const w = await worker(p.id);
    const wait = register(p.id, [w.id]);
    const cancelled = manager.cancelWorkerWait(p.id, wait.id);
    expect(cancelled).toMatchObject({ id: wait.id, phase: 'wake-pending', reason: 'cancelled', wakeId: wait.id });
    expect(semaphore.busy()).toBe(1); expect(store.getRun(w.id)?.status).toBe('queued');
    const disk = readPersistedRuns(join(root, '.ai/cezar')) as RunRecord[];
    // hearsay-tools/cezarion#1235: a cancelled wait moves to lastWaits and queues no wake.
    expect(lastWaitOf(disk.find(run => run.id === p.id))).toMatchObject({ id: wait.id, reason: 'cancelled' });
    expect(store.getRun(p.id)?.agentInputs?.some(input => input.deliveredAt)).not.toBe(true);
    writeFileSync(release, 'release');
    await until(() => !waitOf(store.getRun(p.id)));
    expect(manager.cancelWorkerWait(p.id, wait.id).reason).toBe('cancelled');
    expect(store.getRun(p.id)?.agentInputs?.filter(input => input.id === wait.id) ?? []).toEqual([]);
  });
it('answers a cancelled wait from the entry its commit settled, and never one the commit did not settle', async () => {
    const release = join(root, 'release-unsettled-cancel'); const wire = controlledWire({ firstResultGate: release });
    const p = await parent(); await until(wire.initialReceived); const w = await worker(p.id);
    const wait = register(p.id, [w.id]);
    const commit = vi.spyOn(store, 'commitOutcome').mockReturnValueOnce({ committed: false, answered: [], settled: [] });
    expect(() => manager.cancelWorkerWait(p.id, wait.id)).toThrow(expect.objectContaining({ code: 'incompatible_state' }));
    commit.mockRestore();
    expect(store.getRun(p.id)?.waits?.find(entry => entry.id === wait.id)?.phase).toBe('open');
    const cancelled = manager.cancelWorkerWait(p.id, wait.id);
    expect(cancelled).toEqual(lastWaitOf(readPersistedRuns(join(root, '.ai/cezar')).find(run => run.id === p.id)));
    expect(cancelled).toMatchObject({ id: wait.id, reason: 'cancelled' });
    writeFileSync(release, 'release');
    await until(() => !waitOf(store.getRun(p.id)));
  });
it('cancelled parked wait queues no wake behind a running worker and stale IDs cannot cancel a later wait', async () => {
    const p = await parent(); const w = await worker(p.id, 'mock:slow');
    const wait = register(p.id, [w.id]); manager.enqueueOwnedRun(w.id);
    await until(() => waitOf(store.getRun(p.id))?.phase === 'parked' && store.getRun(w.id)?.status === 'running');
    manager.cancelWorkerWait(p.id, wait.id); manager.cancelWorkerWait(p.id, wait.id); manager.reconcileWorkerWaits();
    expect(store.getRun(w.id)?.status).toBe('running'); expect(semaphore.busy()).toBe(1);
    // hearsay-tools/cezarion#1235: the cancelled entry moves to lastWaits; nothing wakes the parent.
    expect(lastWaitOf(store.getRun(p.id))).toMatchObject({ id: wait.id, reason: 'cancelled' });
    expect(store.getRun(p.id)?.agentInputs?.filter(input => input.id === wait.id) ?? []).toEqual([]);
    manager.requestWorkerStop(w.id); await manager.awaitRunTermination(w.id, 15_000);
    await until(() => !waitOf(store.getRun(p.id)));
    const nextWorker = await worker(p.id); const next = register(p.id, [nextWorker.id]);
    expect(manager.cancelWorkerWait(p.id, wait.id).reason).toBe('cancelled');
    expect(waitOf(store.getRun(p.id))?.id).toBe(next.id);
    expect(() => manager.cancelWorkerWait(p.id, randomUUID())).toThrow();
    expect(waitOf(store.getRun(p.id))?.reason).toBeUndefined();
    expect(store.getRun(p.id)?.agentInputs?.filter(input => input.id === wait.id) ?? []).toEqual([]);
  });
it('restarts a cancelled wait and retains its receipt across restarts without a wake', async () => {
    const release = join(root, 'release-recovered-turn'); const wire = controlledWire({ firstResultGate: release });
    const p = await parent(); await until(wire.initialReceived); const w = await worker(p.id);
    const wait = register(p.id, [w.id]); manager.cancelWorkerWait(p.id, wait.id);
    const disk = readPersistedRuns(join(root, '.ai/cezar'));
    writeFileSync(release, 'release');
    await restart(false, disk);
    await until(() => !waitOf(store.getRun(p.id)));
    expect(manager.cancelWorkerWait(p.id, wait.id).reason).toBe('cancelled');
    expect(store.getRun(p.id)?.agentInputs?.filter(input => input.id === wait.id) ?? []).toEqual([]);
    expect(store.getRun(w.id)?.status).not.toBe('cancelled');
    await restart();
    expect(manager.cancelWorkerWait(p.id, wait.id).reason).toBe('cancelled');
    expect(store.getRun(p.id)?.agentInputs?.filter(input => input.id === wait.id) ?? []).toEqual([]);
  });
it('failed cancellation checkpoint publishes no wake and keeps the original wait retryable', async () => {
    const p = await parent('mock:slow'); const w = await worker(p.id); const wait = register(p.id, [w.id]);
    store.flush(); const release = blockRunWrites(join(root, '.ai/cezar'));
    try {
      expect(() => manager.cancelWorkerWait(p.id, wait.id)).toThrow();
      expect(waitOf(store.getRun(p.id))).toEqual(wait);
      expect(store.getRun(p.id)?.agentInputs).toBeUndefined();
      expect(lastWaitOf(store.getRun(p.id))).toBeUndefined();
      expect(semaphore.busy()).toBe(1);
    } finally { release(); }
    expect(manager.cancelWorkerWait(p.id, wait.id).reason).toBe('cancelled');
  });
it('parent cancellation retires its wait with a receipt while cancelling workers', async () => {
    const p = await parent(); const w = await worker(p.id); const wait = register(p.id, [w.id]);
    await until(() => waitOf(store.getRun(p.id))?.phase === 'parked');
    manager.cancel(p.id);
    expect(waitOf(store.getRun(p.id))).toBeUndefined();
    expect(lastWaitOf(store.getRun(p.id))).toMatchObject({ id: wait.id, reason: 'cancelled' });
    await until(() => store.getRun(w.id)?.status === 'cancelled');
    expect(store.getRun(p.id)?.agentInputs).toBeUndefined();
  });
});
