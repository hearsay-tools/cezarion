import { handleRunnerUiEvent, makeUiSink } from './run/session-events.ts';
import { runInternals } from './run-internals.testkit.ts';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type WorkerWait } from '@open-mercato/cezar-contract/delegation';
import { RunStore } from '../runs/store.ts';
import { captureState, fixtureUpdateRun, manager, parent, register, restart, root, semaphore, store, timeline, until, useWorkerWaitFixture, waitOf, workerEntryOf, worker } from './worker-wait.testkit.ts';
import { blockRunWrites } from '../runs/run-store.testkit.ts';
import { RUN_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';

// Real Git, durable fsync checkpoints and process shutdown share this outer budget.
// Keep the separate 15s state/termination assertions and actual runner timers intact.

describe('worker waits through RunManager', { timeout: 30_000 }, () => {
  useWorkerWaitFixture();
  it('preserves a delegated parent ask across restart and never uses a lifecycle prompt as its answer', async () => {
    const p = await parent('mock:cezar-ask'); const w = await worker(p.id);
    await until(() => store.readEvents(p.id).some(e => e.type === 'ask.requested'));
    const delegation = store.getRun(p.id)!.delegation!;
    if (delegation.role !== 'root') throw Error('fixture');
    // hearsay-tools/cezarion#1235: upgraded into a list entry, an overdue wait would wake beside the
    // question; one still running keeps this case about the ask.
    const wait: WorkerWait = { id: randomUUID(), workerIds: [w.id], phase: 'parked', deadline: new Date(Date.now() + 600_000).toISOString(), outcomes: [] };
    store.commitDelegation([{ id: p.id, delegation: { ...delegation, wait } }]);
    await restart(); await manager.recover();
    expect(store.getRun(p.id)?.status).toBe('waiting');
    expect(manager.isActive(p.id)).toBe(false);
    expect(manager.continueRun(p.id).ok).toBe(false);
    expect(store.readEvents(p.id).filter(e => e.type === 'human-input-delivered')).toEqual([]);
    expect(manager.continueRun(p.id, { text: 'Vitest' }).ok).toBe(true);
    // hearsay-tools/cezarion#1235: the answer withdraws nothing; the answered turn parks on the wait.
    await until(() => store.getRun(p.id)?.status === 'waiting' && waitOf(store.getRun(p.id))?.phase === 'parked' &&
      store.readEvents(p.id).some(e => e.type === 'human-input-delivered'));
    expect(waitOf(store.getRun(p.id))).toMatchObject({ id: wait.id, workerIds: [w.id] });
    expect(store.readEvents(p.id).filter(e => e.type === 'human-input-delivered')).toHaveLength(1);
  });
  for (const status of ['done', 'failed', 'cancelled'] as const) {
    it(`parent ${status} clears wait and cancels unfinished children, preserving terminal artifacts`, async () => {
      const p = await parent(); const w = await worker(p.id); const done = await worker(p.id);
      fixtureUpdateRun(done.id, { status: RUN_STATUS.review }); register(p.id, [w.id]);
      store.updateRun(p.id, { status });
      await until(() => store.getRun(w.id)?.status === 'cancelled');
      expect(waitOf(store.getRun(p.id))).toBeUndefined(); expect(store.getRun(done.id)?.status).toBe('review');
      expect(store.getRun(w.id)?.delegation?.role).toBe('worker');
      // Its session is still live, which a settled parent never has: back to running before
      // teardown stops it (hearsay-tools/cezarion#1804).
      store.updateRun(p.id, { status: RUN_STATUS.running });
    });
  }
  it('persists lifecycle continuation origin through a queued restart', async () => {
    const p = await parent();
    await until(() => store.getRun(p.id)?.status === 'waiting');
    manager.finish(p.id); await until(() => !manager.isActive(p.id));
    const blocker = await parent('mock:slow');
    expect(manager.continueRun(p.id, { text: 'internal restart' }, true).ok).toBe(true);
    expect(store.getRun(p.id)?.continuationMessage).toMatchObject({ origin: 'lifecycle' });
    store.flush();
    const reopened = RunStore.open(join(root, '.ai/cezar'), { keepLive: true });
    expect(reopened.getRun(p.id)?.continuationMessage).toMatchObject({ origin: 'lifecycle' });
    reopened.flush();
    manager.cancel(blocker.id);
    await until(() => store.getRun(p.id)?.status === 'waiting');
    expect(store.readEvents(p.id).filter(e => e.type === 'user-message')).toEqual([]);
  });
  it('backend activity restores an executing parent slot without withdrawing its durable wait', async () => {
    const p = await parent(); const w = await worker(p.id);
    const wait = register(p.id, [w.id]);
    await until(() => waitOf(store.getRun(p.id))?.phase === 'parked');
    const engine = runInternals(manager);
    handleRunnerUiEvent(engine.context, engine.sessionHelperHost, p.id, engine.active.get(p.id)!, makeUiSink(engine.context, engine.sessionHelperHost, p.id, 'task'), {
      type: 'turn.started', turnId: randomUUID(),
    });
    expect(store.getRun(p.id)?.status).toBe('running');
    expect(semaphore.busy()).toBe(1);
    expect(waitOf(store.getRun(p.id))?.id).toBe(wait.id);
  });

  it('does not release capacity before the parked intent reaches disk', async () => {
    const p = await parent('mock:slow'); const w = await worker(p.id);
    register(p.id, [w.id]); store.flush();
    const release = blockRunWrites(join(root, '.ai/cezar'));
    // hearsay-tools/cezarion#1235: an agent worker wait parks through the wait list (`parkOnWaits`).
    const engine = runInternals(manager);
    try {
      expect(() => engine.wakeAdmission.parkOnWaits(p.id, engine.active.get(p.id)!)).toThrow();
      expect(waitOf(store.getRun(p.id))?.phase).toBe('registered');
      expect(semaphore.busy()).toBe(1);
    } finally {
      release();
    }
  });

  it('recovery admits an older queued child before an expired parent wake', async () => {
    const p = await parent(); const w = await worker(p.id, 'mock:slow');
    const explain = (stage: string) => {
      const engine = runInternals(manager);
      return `${stage}\n${JSON.stringify({ ...captureState(), queue: runInternals(manager).line.queue, starting: [...runInternals(manager).line.starting],
        active: [...engine.active.keys()], executions: [...engine.workerExecutions.executions.keys()], workerExecution: store.readWorkerExecution(w.id) })}\n${timeline(p.id)}\n${timeline(w.id)}`;
    };
    // Expire the deadline only after the parent parks; mock startup must not race a 1 s budget.
    register(p.id, [w.id]);
    await until(() => waitOf(store.getRun(p.id))?.phase === 'parked', () => explain('parent wait parks before restart'));
    const entry = workerEntryOf(store.getRun(p.id));
    if (!entry) throw Error('fixture');
    store.commitWait(p.id, { ...entry, deadline: new Date().toISOString() });
    await restart();
    await until(() => store.getRun(w.id)?.status === 'running' || store.getRun(p.id)?.status === 'running',
      () => explain('recovery admits the queued child or parent wake'));
    expect(store.getRun(w.id)?.status).toBe('running');
    expect(store.getRun(p.id)?.status).toBe('queued');
    expect(store.getRun(p.id)?.agentInputs?.some(input => input.deliveredAt)).not.toBe(true);
  });

});
