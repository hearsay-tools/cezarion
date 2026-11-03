import { runInternals } from './run-internals.testkit.ts';
import { describe, expect, it } from 'vitest';
import { QUICK_TASK_WORKFLOW } from './types.ts';
import { manager, parent, restart, semaphore, store, until, worker } from './worker-wait.testkit.ts';
import { expectLegacyFinishRefused, useWorkerCapacityFixture } from './worker-wait-capacity.testkit.ts';

describe("worker waits through RunManager", { timeout: 30_000 }, () => {
  useWorkerCapacityFixture();

it.each(['queued', 'continued'])('legacy pending inactive Finish holds %s children while unrelated work progresses', async mode => {
    const p = await parent(); await until(() => store.getRun(p.id)?.status === 'waiting'); await restart();
    const w = await worker(p.id); manager.enqueueOwnedRun(w.id);
    await until(() => store.getRun(w.id)?.status === 'waiting');
    manager.finish(w.id); await until(() => !manager.isActive(w.id));
    const queued = await worker(p.id);
    const blocker = manager.startRun(QUICK_TASK_WORKFLOW, { task: 'mock:slow', runner: 'claude' });
    await until(() => (manager as unknown as { active: Map<string, { sessionEverOpened?: boolean }> }).active.get(blocker.id)?.sessionEverOpened === true);
    manager.enqueueOwnedRun(queued.id);
    const real = runInternals(manager).runSettlement.settleSuccess.bind(runInternals(manager).runSettlement);
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    let completion: Promise<void> | undefined;
    runInternals(manager).runSettlement.settleSuccess = (id, durable) => id === p.id ? completion = gate.then(() => real(id, durable)) : real(id, durable);
    try {
      store.commitRootFinishIntent(p.id); void runInternals(manager).runSettlement.settleSuccess(p.id, true);
      expect(completion).toBeInstanceOf(Promise);
      if (mode === 'continued') expect(manager.continueRun(w.id, { text: 'must not start' }).ok).toBe(false);
      const unrelated = manager.startRun(QUICK_TASK_WORKFLOW, { task: 'mock:hold', runner: 'claude' });
      manager.cancel(blocker.id);
      await until(() => store.getRun(unrelated.id)?.status === 'waiting');
      await runInternals(manager).line.rescueStalledQueue();
      expect(store.getRun(queued.id)?.status).toBe('queued');
      expect(store.getRun(queued.id)?.worktreePath).toBeUndefined();
      expect(store.readEvents(queued.id).some(event => event.type === 'session')).toBe(false);
      expect(semaphore.busy()).toBe(0);
    } finally { release(); await completion; }
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
    const engine = manager as unknown as {
      agentEnvForStep(id: string, ...args: unknown[]): Promise<unknown>;
    };
    const env = engine.agentEnvForStep.bind(manager); const settle = runInternals(manager).runSettlement.settleSuccess.bind(runInternals(manager).runSettlement);
    let start!: () => void; let finish!: () => void; let entered = false; let completion: Promise<void> | undefined;
    const startGate = new Promise<void>(resolve => { start = resolve; });
    const finishGate = new Promise<void>(resolve => { finish = resolve; });
    engine.agentEnvForStep = async (id, ...args) => { if (id === w.id) { entered = true; await startGate; } return env(id, ...args); };
    runInternals(manager).runSettlement.settleSuccess = (id, durable) => id === p.id ? completion = finishGate.then(() => settle(id, durable)) : settle(id, durable);
    const sessions = store.readEvents(w.id).filter(event => event.type === 'session').length;
    try {
      if (mode === 'continuation') expect(manager.continueRun(w.id, { text: 'mock:hold' }).ok).toBe(true);
      else manager.enqueueOwnedRun(w.id);
      await until(() => entered);
      store.commitRootFinishIntent(p.id); void runInternals(manager).runSettlement.settleSuccess(p.id, true);
      expect(completion).toBeInstanceOf(Promise);
      start();
      await until(() => store.getRun(w.id)?.status === 'queued');
      expect(store.readEvents(w.id).filter(event => event.type === 'session')).toHaveLength(sessions);
      expect(semaphore.busy()).toBe(0);
    } finally { start(); finish(); await completion; }
    expect(store.getRun(w.id)?.status).not.toBe('cancelled');
    expectLegacyFinishRefused(p.id);
  });
});
