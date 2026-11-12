import { autoEndObservationClock } from '../core/observation-clock.testkit.ts';
import { AUTO_END_DELAY_MS } from '../core/runner-runtime.ts';
import { describe, expect, it } from 'vitest';
import { HARNESS_ADAPTERS } from '../core/harness-parity.testkit.ts';
import { withHeldAck } from '../core/owned-input-delivery.testkit.ts';
import { captureState, collect, manager, register, semaphore, setFailureState, store, until, waitOf, worker, work } from './worker-wait.testkit.ts';
import { parkedOnWorkers, useWorkerCapacityFixture } from './worker-wait-capacity.testkit.ts';

describe("worker waits through RunManager", { timeout: 30_000 }, () => {
  useWorkerCapacityFixture();

it.each(['codex', 'opencode', 'pi', 'omp'].flatMap(backend => ['agent', 'check'].map(next => ({ backend: backend as 'codex' | 'opencode' | 'pi' | 'omp', next }))))(
    '$backend keeps a completed wake and following $next held until its real transport ACK at cap one', async ({ backend, next }) => {
      await withHeldAck(backend, async release => {
        process.env.CEZ_DRY_RUN = '0';
        process.env.CEZ_CLAUDE_BIN = HARNESS_ADAPTERS.claude.mockBin;
        process.env[HARNESS_ADAPTERS[backend].binEnv] = HARNESS_ADAPTERS[backend].mockBin;
        const run = manager.startRun({ name: 'ACK held chain', source: 'built-in', steps: [
          { id: 'first', prompt: 'mock:hold' },
          next === 'agent' ? { id: 'next', prompt: 'mock:cezar-done' } : { id: 'next', command: 'echo checked' },
        ] }, { task: 'parent', runner: backend });
        store.commitDelegation([{ id: run.id, delegation: { role: 'root', permissions: ['spawn', 'wait'], receipts: [] } }]);
        // hearsay-tools/cezarion#1235: the list's park and admission, not `workerWaiting`/`workerWakeAdmitted`.
        await until(() => store.getRun(run.id)?.steps.some(step => !!step.sessionId) === true && work.liveSessions.size === 1);
        const [session] = work.liveSessions;
        const w = await worker(run.id, 'mock:slow');
        register(run.id, [w.id]); manager.enqueueOwnedRun(w.id);
        const clock = autoEndObservationClock();
        try {
          await until(() => parkedOnWorkers(run.id) && store.getRun(w.id)?.steps.some(step => !!step.sessionId) === true);
          expect(semaphore.busy()).toBe(1);
          const boundaries = store.readEvents(run.id).filter(event => event.type === 'turn-end').length;
          manager.requestWorkerStop(w.id); expect(await manager.awaitRunTermination(w.id, 15000)).toBe(true);
          // The wake turn's own frames reach the runner while its acknowledgement is held. The wake is
          // Squawk's text, so the mock answers it with its ordinary turn rather than an echo.
          await until(() => store.readEvents(run.id).filter(event => event.type === 'turn-end').length > boundaries);
          expect(clock.captured).toBe(0);
          await clock.advance(AUTO_END_DELAY_MS + 150);
          expect(clock.captured).toBe(0);
          const wake = store.getRun(run.id)?.agentInputs?.find(input => input.source === 'lifecycle');
          expect(wake).toBeDefined(); expect(wake?.deliveredAt).toBeUndefined();
          expect(waitOf(store.getRun(run.id))?.wakeId).toBe(wake?.id);
          expect(parkedOnWorkers(run.id)).toBe(false);
          expect(manager.isActive(run.id)).toBe(true);
          expect(work.liveSessions.has(session!)).toBe(true); expect(session!.open).toBe(true);
          expect(store.getRun(run.id)?.steps.find(step => step.id === 'next')?.status).toBe('pending');
          expect(semaphore.busy()).toBe(1);
          await collect(w.id);
          release();
          await until(() => !!store.getRun(run.id)?.agentInputs?.find(input => input.id === wake?.id)?.deliveredAt);
          expect(waitOf(store.getRun(run.id))).toBeUndefined();
          // The wake turn signals nothing; the earlier step completes only on a done (hearsay-tools/cezarion#1620).
          expect(manager.sendMessage(run.id, [{ type: 'text', text: HARNESS_ADAPTERS[backend].scenarios['cezar-done']! }])).toBe(true);
          await until(() => store.getRun(run.id)?.steps.find(step => step.id === 'next')?.status !== 'pending');
          expect(store.getRun(run.id)?.steps.find(step => step.id === 'first')?.status).toBe('done');
          await until(() => !manager.isActive(run.id));
          expect(store.getRun(run.id)?.steps.map(step => step.status)).toEqual(['done', 'done']);
        } finally {
          clock.restore();
          setFailureState(captureState());
          release();
          for (const record of store.listRuns()) manager.cancel(record.id);
          await until(() => store.listRuns().every(record => !manager.isActive(record.id)));
        }
      }, 'Worker wait');
    },
  );
});
