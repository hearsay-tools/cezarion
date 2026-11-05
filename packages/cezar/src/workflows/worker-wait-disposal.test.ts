import { runInternals } from './run-internals.testkit.ts';
import { describe, expect, it } from 'vitest';
import { currentUsage } from '../core/process-usage.ts';
import { bookkeeping, executions, manager, parent, register, reopenRuntime, store, until, useWorkerWaitFixture, waitOf, worker } from './worker-wait.testkit.ts';

// Real Git, durable fsync checkpoints and process shutdown share this outer budget.
// Keep the separate 15s state/termination assertions and actual runner timers intact.

describe('worker waits through RunManager', { timeout: 30_000 }, () => {
  useWorkerWaitFixture();
  for (const mode of ['fresh', 'continuation'] as const) {
    for (const completion of ['result', 'error'] as const) {
      it(`${mode}: disposal ignores late ${completion} and restart retains the wait and children`, async () => {
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
        const state = (manager as unknown as { active: Map<string, { liveSession: { session: { end(): void; sendMessage(content: unknown[]): boolean }; };  }> }).active.get(p.id)!;
        await until(() => currentUsage(p.id) !== undefined);
        manager.dispose();
        const snapshot = JSON.stringify(store.getRun(p.id));
        await runInternals(manager).turnBookkeeper.recordTurnEnd(p.id, 'CEZ:TITLE=late disposed callback');
        if (completion === 'error') state.liveSession.session.sendMessage([{ type: 'text', text: 'mock:auth-error' }]);
        else state.liveSession.session.end();
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
    const active = (manager as unknown as { active: Map<string, { liveSession: { session?: { interrupt(): void }; };  }> }).active;
    const sessions = [...active.values()].map(s => s.liveSession.session);
    manager.dispose();
    expect(waitOf(store.getRun(p.id))?.id).toBe(wait.id); expect(store.getRun(w.id)?.status).toBe('queued');
    for (const session of sessions) session?.interrupt();
    await Promise.all(executions.splice(0));
    expect(store.getRun(p.id)?.status).toBe('waiting');
    expect(store.getRun(w.id)?.status).toBe('queued');
  });
});
