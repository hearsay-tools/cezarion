import { observationClock } from '../core/observation-clock.testkit.ts';
import { agentInputSchema } from '@open-mercato/cezar-contract/delegation';
import { RUN_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { type RunRecord } from '../runs/store.ts';
import { withHeldResponse } from '../core/owned-input-delivery.testkit.ts';
import { bookkeeping, collect, manager, parent, restart, root, store, until, worker, work, semaphore } from './worker-wait.testkit.ts';
import { blockRunWrites, readPersistedRuns } from '../runs/run-store.testkit.ts';
import { monitoringWakeOf } from './waits.testkit.ts';
import { useWorkerCapacityFixture } from './worker-wait-capacity.testkit.ts';

describe("worker waits through RunManager", { timeout: 30_000 }, () => {
  useWorkerCapacityFixture();

for (const failure of ['diff', 'checkpoint'] as const) {
    it(`inactive Finish retains retryable intent after ${failure} failure and checkpoints successful publication`, async () => {
      const p = await parent();
      await until(() => store.getRun(p.id)?.status === 'waiting');
      const w = await worker(p.id); await restart();
      await until(() => store.getRun(w.id)?.status === 'waiting');
      manager.requestWorkerStop(w.id); expect(await manager.awaitRunTermination(w.id, 15000)).toBe(true); await collect(w.id);
      await Promise.all(bookkeeping.splice(0));
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const move = store.move.bind(store);
      if (failure === 'diff') store.updateRun(p.id, { baseBranch: 'nonexistent-ref' });
      else store.move = (id, exit, ...rest) => {
        if (exit !== 'succeed-root' && exit !== 'succeed-root-review') return move(id, exit, ...rest);
        const release = blockRunWrites(join(root, '.ai/cezar'));
        try { return move(id, exit, ...rest); } finally { release(); }
      };
      expect(manager.finish(p.id)).toBe(true);
      await until(() => warn.mock.calls.length > 0);
      expect(store.getRun(p.id)?.status).toBe('waiting');
      expect(store.getRun(p.id)?.delegation).toHaveProperty('finishRequestedAt');
      expect(store.getRun(w.id)?.status).toBe('cancelled');
      expect(manager.continueRun(p.id, { text: 'cannot supersede finish' }).ok).toBe(false);
      expect(() => manager.steerWorker(w.id, { id: randomUUID(), parentRunId: p.id, source: agentInputSchema.shape.source.enum.agent,
        text: 'cannot steer', createdAt: new Date().toISOString() })).toThrow('finish');
      store.move = move; store.updateRun(p.id, { baseBranch: 'main' });
      let durableStatus: string | undefined;
      const observe = (run: RunRecord) => {
        if (run.id === p.id && run.status === 'done') {
          durableStatus = (readPersistedRuns(join(root, '.ai/cezar')) as RunRecord[]).find(run => run.id === p.id)?.status;
        }
      };
      store.on('run', observe);
      expect(manager.finish(p.id)).toBe(true);
      await until(() => store.getRun(p.id)?.status === 'done');
      expect(durableStatus).toBe('done');
      expect(store.getRun(p.id)?.delegation).not.toHaveProperty('finishRequestedAt');
      store.off('run', observe); warn.mockRestore();
    });
  }

it.each([false, true])('monitoring synthetic delivery respects legacy pending Finish=%s before wake bookkeeping', async pending => {
    await withHeldResponse('claude', async release => {
      const p = await parent(); await until(() => store.getRun(p.id)?.status === 'waiting'); await restart();
      const w = await worker(p.id, 'mock:schedule-wakeup keep going');
      vi.spyOn(semaphore, 'maxMonitoringSessions').mockReturnValue(1);
      const clock = observationClock(() => /\bat WaitWatches\.armWait \(/.test(new Error().stack ?? ''));
      const sessions = new Set(work.liveSessions);
      manager.enqueueOwnedRun(w.id);
      await until(() => !!monitoringWakeOf(store.getRun(w.id)));
      const session = [...work.liveSessions].find(session => !sessions.has(session))!;
      expect(session).toBeDefined();
      const send = vi.spyOn(session, 'sendAgentMessage');
      const deadline = monitoringWakeOf(store.getRun(w.id))!;
      const competing = await worker(p.id, 'mock:schedule-wakeup keep going');
      manager.enqueueOwnedRun(competing.id);
      await until(() => !!monitoringWakeOf(store.getRun(competing.id)));
      expect(semaphore.busy()).toBe(1);
      try {
        if (pending) store.commitRootFinishIntent(p.id);
        expect(clock.captured).toBe(2);
        clock.fire(0);
        await Promise.all([...work.pending].filter(([, label]) => label === 'pump').map(([promise]) => promise));
        expect(monitoringWakeOf(store.getRun(competing.id))).toBeDefined();
        if (pending) {
          expect(send).not.toHaveBeenCalled();
          expect((store.getRun(w.id)?.automaticWakes ?? 0)).toBe(0);
          expect({ ...store.getRun(w.id), monitoringWakeAt: monitoringWakeOf(store.getRun(w.id)) }).toMatchObject({ status: RUN_STATUS.waiting, monitoringWakeAt: deadline });
          expect(session.open).toBe(true);
          expect(semaphore.busy()).toBe(1);
          expect(store.readEvents(w.id).some(event => event.type === 'note' && typeof event.message === 'string' && event.message.includes('automatic monitoring wake-up'))).toBe(false);
          expect(manager.sendMessage(w.id, [{ type: 'text', text: 'synthetic retry' }])).toBe(false);
          expect(send).not.toHaveBeenCalled();
        } else {
          await until(() => store.getRun(w.id)?.automaticWakes === 1);
          expect(send).toHaveBeenCalledTimes(1);
          expect((store.getRun(w.id)?.automaticWakes ?? 0)).toBe(1);
          // The resumed run must inherit the sole exemption when its competitor leaves.
          expect(manager.cancel(competing.id)).toBe(true);
          expect(await manager.awaitRunTermination(competing.id, 15000)).toBe(true);
          await semaphore.release();
          // hearsay-tools/cezarion#1233: the wake turn keeps its pool slot until its own turn end.
          expect(session.open).toBe(true);
          expect(semaphore.busy()).toBe(0);
        }
      } finally { release(); clock.restore(); }
    }, 'Re-check the downstream work');
  });
});
