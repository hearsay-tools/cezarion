import { describe, expect, it, vi } from 'vitest';
import * as profiles from '../workspace/agent-profiles.ts';
import { QUICK_TASK_WORKFLOW } from './types.ts';
import { executions, manager, parent, restart, semaphore, store, until, worker, work } from './worker-wait.testkit.ts';
import { sessionOf } from './worker-wait-readiness.testkit.ts';
import { expectLegacyFinishRefused, useWorkerCapacityFixture } from './worker-wait-capacity.testkit.ts';

async function pumps() {
  await Promise.all([...work.pending].filter(([, label]) => label === 'pump').map(([promise]) => promise));
}

describe('worker waits through RunManager', { timeout: 30_000 }, () => {
  useWorkerCapacityFixture();

  it.each(['queued', 'continued'])('legacy pending inactive Finish holds %s children while unrelated work progresses', async mode => {
    const p = await parent(); await until(() => store.getRun(p.id)?.status === 'waiting'); await restart();
    const w = await worker(p.id); manager.enqueueOwnedRun(w.id);
    await until(() => store.getRun(w.id)?.status === 'waiting');
    manager.finish(w.id); await until(() => !manager.isActive(w.id));
    const queued = await worker(p.id);
    const blocker = manager.startRun(QUICK_TASK_WORKFLOW, { task: 'mock:slow', runner: 'claude' });
    // bound: the captured runner session proves preflight finished and the blocker owns capacity.
    await vi.waitFor(() => expect(sessionOf(blocker.id).open).toBe(true), { timeout: 15_000 });
    manager.enqueueOwnedRun(queued.id);
    await pumps();
    store.commitRootFinishIntent(p.id);
    if (mode === 'continued') expect(manager.continueRun(w.id, { text: 'must not start' }).ok).toBe(false);
    const unrelated = manager.startRun(QUICK_TASK_WORKFLOW, { task: 'mock:hold', runner: 'claude' });
    manager.cancel(blocker.id);
    await sessionOf(blocker.id).result;
    // bound: the blocker's cleanup releases its slot even if a regression admits the child next.
    await until(() => !manager.isActive(blocker.id));
    await semaphore.release(); await pumps();
    expect(store.getRun(queued.id)?.status).toBe('queued');
    expect(store.readWorkerExecution(queued.id)?.phase).toBe('queued');
    expect(store.getRun(queued.id)?.worktreePath).toBeUndefined();
    expect(store.readEvents(queued.id).some(event => event.type === 'session')).toBe(false);
    // bound: the unrelated run's turn end proves it passed the held child in the shared queue.
    await until(() => store.getRun(unrelated.id)?.status === 'waiting');
    await semaphore.release(); await pumps();
    expect(semaphore.busy()).toBe(0);
    // Recovery is the public consumer of a legacy inactive parent's persisted Finish.
    await manager.recover(p.id);
    expect(store.getRun(queued.id)?.status).not.toBe('cancelled');
    expectLegacyFinishRefused(p.id);
  });

  it.each(['fresh', 'continuation'])('legacy pending inactive Finish rechecks a %s child at the pre-spawn boundary', async mode => {
    const p = await parent(); await until(() => store.getRun(p.id)?.status === 'waiting'); await restart();
    const w = await worker(p.id);
    if (mode === 'continuation') {
      manager.enqueueOwnedRun(w.id); await until(() => store.getRun(w.id)?.status === 'waiting');
      manager.finish(w.id); await until(() => !manager.isActive(w.id));
    }
    const env = profiles.resolveProfileEnvForRoot;
    let release!: () => void; let entered = false;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const environment = vi.spyOn(profiles, 'resolveProfileEnvForRoot').mockImplementation(async (...args) => {
      entered = true; await gate; return env(...args);
    });
    const sessions = store.readEvents(w.id).filter(event => event.type === 'session').length;
    let spawned!: () => void;
    const sessionStarted = new Promise<void>(resolve => { spawned = resolve; });
    const trackSession = work.trackSession.bind(work);
    const sessionLaunch = vi.spyOn(work, 'trackSession').mockImplementation((...args) => {
      spawned(); return trackSession(...args);
    });
    const firstExecution = executions.length;
    try {
      if (mode === 'continuation') expect(manager.continueRun(w.id, { text: 'mock:hold' }).ok).toBe(true);
      else manager.enqueueOwnedRun(w.id);
      // bound: profile resolution is the real async boundary immediately before launch settings.
      await until(() => entered);
      store.commitRootFinishIntent(p.id);
      release();
      // Either requeue settles execution or a regression opens a tracked runner session.
      await Promise.race([Promise.all(executions.slice(firstExecution)), sessionStarted]);
      expect(store.getRun(w.id)?.status).toBe('queued');
      expect(store.readEvents(w.id).filter(event => event.type === 'session')).toHaveLength(sessions);
      expect(semaphore.busy()).toBe(0);
    } finally { release(); environment.mockRestore(); sessionLaunch.mockRestore(); }
    await manager.recover(p.id);
    expect(store.getRun(w.id)?.status).not.toBe('cancelled');
    expectLegacyFinishRefused(p.id);
  });
});
