import { testHome } from '../home/test-home.testkit.ts';
import { captureSessions } from './runner-session-capture.testkit.ts';
import { isDisposedDelegatedRun } from './run/run-guards.ts';
import { TurnBookkeeper } from './run/turn-bookkeeping.ts';
import { unused } from './fixture-cleanup.testkit.ts';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { makeTimerWait } from '@open-mercato/cezar-contract/test-factories.testkit';
import { describe, expect, it } from 'vitest';
import { currentUsage } from '../core/process-usage.ts';
import { bookkeeping, executions, manager, parent, register, reopenRuntime, root, semaphore, store, until, useWorkerWaitFixture, waitOf, worker, work } from './worker-wait.testkit.ts';
import { noRunners } from '../core/runners-under-test.testkit.ts';

// Real Git, durable fsync checkpoints and process shutdown share this outer budget.
// Keep the separate 15s state/termination assertions and actual runner timers intact.

describe('worker waits through RunManager', { timeout: 30_000 }, () => {
  useWorkerWaitFixture();
  for (const mode of ['fresh', 'continuation'] as const) {
    for (const completion of ['result', 'error'] as const) {
      it(`${mode}: disposal ignores late ${completion} and restart retains the wait and children`, async () => {
        const sessionOf = captureSessions();
        const p = await parent();
        if (mode === 'continuation') {
          await until(() => store.getRun(p.id)?.status === 'waiting');
          manager.finish(p.id); await until(() => !manager.isActive(p.id));
          expect(manager.continueRun(p.id, { text: 'mock:hold' }).ok).toBe(true);
          await until(() => store.getRun(p.id)?.status === 'waiting');
        }
        const w = await worker(p.id); const wait = register(p.id, [w.id]);
        await until(() => waitOf(store.getRun(p.id))?.phase === 'parked');
        await Promise.all(bookkeeping.splice(0));
        const session = sessionOf(p.id);
        await until(() => currentUsage(p.id) !== undefined);
        manager.dispose();
        const snapshot = JSON.stringify(store.getRun(p.id));
        if (completion === 'error') session.sendMessage([{ type: 'text', text: 'mock:request-error' }]);
        else session.end();
        await Promise.all(executions.splice(0));
        expect(store.getRun(p.id)?.status).toBe('waiting');
        expect(waitOf(store.getRun(p.id))?.id).toBe(wait.id);
        expect(JSON.stringify(store.getRun(p.id))).toBe(snapshot);
        expect(currentUsage(p.id)).toBeUndefined();
        store.flush();
        reopenRuntime();
        await manager.recover();
        expect(waitOf(store.getRun(p.id))?.id).toBe(wait.id);
        expect(store.getRun(w.id)?.status).not.toBe('cancelled');
      });
    }
  }

  it('disposed turn bookkeeping leaves durable fields unchanged before applying title markers', async () => {
    const run = store.createRun({ title: 'disposed root', task: 'task', workflow: 'quick-task', steps: [] });
    const disposed = () => true;
    const context = { createRunner: noRunners, home: testHome(), store, repoRoot: root, dataDir: join(root, '.ai/cezar'), semaphore, work, disposed };
    const host = unused<ConstructorParameters<typeof TurnBookkeeper>[1]>('TurnBookkeeperHost', { isDisposedDelegatedRun: disposed });
    const bookkeeper = new TurnBookkeeper(context, host);
    const snapshot = structuredClone(store.getRun(run.id));
    await bookkeeper.recordTurnEnd(run.id, 'CEZ:TITLE=late disposed callback');
    expect(store.getRun(run.id)).toEqual(snapshot);
  });

  it('recognizes disposed roots, workers and waits without treating ordinary runs as delegated', async () => {
    const p = await parent(); const w = await worker(p.id);
    const ordinary = store.createRun({ title: 'ordinary', task: 'ordinary', workflow: 'quick-task', steps: [] });
    const waiting = store.createRun({ title: 'waits only', task: 'waits only', workflow: 'quick-task', steps: [] });
    store.commitWait(waiting.id, makeTimerWait({ id: randomUUID(),
      registeredAt: new Date().toISOString(), deadline: new Date(Date.now() + 60_000).toISOString(), seconds: 60, turnId: 'turn' }));
    for (const disposed of [false, true]) {
      for (const id of [p.id, w.id, waiting.id]) expect(isDisposedDelegatedRun(store, () => disposed, id)).toBe(disposed);
      for (const id of [ordinary.id, 'missing']) expect(isDisposedDelegatedRun(store, () => disposed, id)).toBe(false);
    }
  });

  for (const intent of ['cancel'] as const) {
    it(`explicit ${intent} before disposal is not resurrected on restart`, async () => {
      const p = await parent(); const w = await worker(p.id);
      register(p.id, [w.id]); await until(() => waitOf(store.getRun(p.id))?.phase === 'parked');
      manager[intent](p.id); manager.dispose();
      await Promise.all(executions.splice(0));
      expect(store.getRun(p.id)?.status).toBe(intent === 'cancel' ? 'cancelled' : 'done');
      await Promise.all(bookkeeping.splice(0));
      store.flush();
      reopenRuntime();
      await manager.recover();
      expect(store.getRun(w.id)?.status).toBe('cancelled');
      expect(waitOf(store.getRun(p.id))).toBeUndefined();
    });
  }

  it('controller disposal does not cascade or clear durable waits', async () => {
    const p = await parent(); const w = await worker(p.id); const wait = register(p.id, [w.id]);
    await until(() => waitOf(store.getRun(p.id))?.phase === 'parked');
    // Stop fixture processes only AFTER disposal; disposal itself must not mutate records.
    const sessions = [...work.liveSessions];
    manager.dispose();
    expect(waitOf(store.getRun(p.id))?.id).toBe(wait.id); expect(store.getRun(w.id)?.status).toBe('queued');
    for (const session of sessions) session?.interrupt();
    await Promise.all(executions.splice(0));
    expect(store.getRun(p.id)?.status).toBe('waiting');
    expect(store.getRun(w.id)?.status).toBe('queued');
  });
});
