import { autoEndObservationClock } from '../core/observation-clock.testkit.ts';
import { AUTO_END_DELAY_MS } from '../core/runner-runtime.ts';
import { describe, expect, it } from 'vitest';
import { withHeldResponse } from '../core/owned-input-delivery.testkit.ts';
import { captureState, collect, manager, register, semaphore, setFailureState, store, until, worker } from './worker-wait.testkit.ts';
import { parkedOnWorkers, useWorkerCapacityFixture } from './worker-wait-capacity.testkit.ts';

describe("worker waits through RunManager", { timeout: 30_000 }, () => {
  useWorkerCapacityFixture();

it.each(['agent', 'check'].flatMap(next => ['early', 'late'].map(timing => ({ next, timing }))))('holds a nonfinal agent session and the following $next behind $timing admitted worker wake at cap one', async ({ next, timing }) => {
    // hearsay-tools/cezarion#1856: delivery can outlive the wake turn and its slot. Hold the native
    // response while checking admission; after release, the next step still needs an explicit done.
    await withHeldResponse('claude', async (release, held) => {
      const clock = autoEndObservationClock();
      try {
        const run = manager.startRun({ name: 'multi-step wait', source: 'built-in', steps: [
          { id: 'first', prompt: 'mock:hold' },
          next === 'agent' ? { id: 'next', prompt: 'mock:hold' } : { id: 'next', command: 'echo checked' },
        ] }, { task: 'parent', runner: 'claude' });
        store.commitDelegation([{ id: run.id, delegation: { role: 'root', permissions: ['spawn', 'wait'], receipts: [] } }]);
        // hearsay-tools/cezarion#1235: an agent worker wait parks through the wait list, not `workerWaiting`.
        const engine = manager as unknown as { active: Map<string, { liveSession: { sessionEverOpened?: boolean; session?: { open: boolean }; };  }> };
        await until(() => !!engine.active.get(run.id)?.liveSession.sessionEverOpened);
        const first = engine.active.get(run.id)!.liveSession.session;
        const w = await worker(run.id, 'mock:slow');
        if (timing === 'late') await until(() => store.readEvents(run.id).some(event => event.type === 'turn-end'));
        register(run.id, [w.id]); manager.enqueueOwnedRun(w.id);
        await until(() => parkedOnWorkers(run.id) && !!engine.active.get(w.id)?.liveSession.sessionEverOpened);
        await until(() => store.readEvents(run.id).some(event => event.type === 'turn-end'));
        expect(clock.captured).toBe(0);
        await clock.advance(AUTO_END_DELAY_MS + 150);
        expect(clock.captured).toBe(0);
        expect.soft(engine.active.get(run.id)?.liveSession.session).toBe(first);
        expect.soft(first?.open).toBe(true);
        expect.soft(store.getRun(run.id)?.steps.find(step => step.id === 'next')?.status).toBe('pending');
        expect.soft(semaphore.busy()).toBe(1);
        manager.requestWorkerStop(w.id); expect(await manager.awaitRunTermination(w.id, 15000)).toBe(true);
        await until(() => held() && !!store.getRun(run.id)?.agentInputs?.some(input => input.source === 'lifecycle' && input.deliveredAt));
        expect(parkedOnWorkers(run.id)).toBe(false); expect(semaphore.busy()).toBe(1);
        expect(engine.active.get(run.id)?.liveSession.session).toBe(first);
        expect(first?.open).toBe(true);
        expect(store.getRun(run.id)?.steps.find(step => step.id === 'next')?.status).toBe('pending');
        const boundaries = store.readEvents(run.id).filter(event => event.type === 'turn-end').length;
        release();
        await until(() => store.getRun(run.id)?.status === 'waiting'
          && store.readEvents(run.id).filter(event => event.type === 'turn-end').length > boundaries);
        expect(engine.active.get(run.id)?.liveSession.session).toBe(first);
        expect(first?.open).toBe(true);
        expect(store.getRun(run.id)?.steps.find(step => step.id === 'next')?.status).toBe('pending');
        // The wake turn signals nothing; the earlier step completes only on a done (hearsay-tools/cezarion#1620),
        // which the uncollected worker would refuse on any step.
        await collect(w.id);
        expect(manager.sendMessage(run.id, [{ type: 'text', text: 'mock:cezar-done' }])).toBe(true);
        await until(() => store.getRun(run.id)?.steps.find(step => step.id === 'next')?.status !== 'pending');
        expect(store.getRun(run.id)?.steps.find(step => step.id === 'first')?.status).toBe('done');
        expect(parkedOnWorkers(run.id)).toBe(false);
      } finally {
        clock.restore();
        setFailureState(captureState());
        release();
        for (const record of store.listRuns()) manager.cancel(record.id);
        await until(() => store.listRuns().every(record => !manager.isActive(record.id)));
      }
    }, 'Worker wait');
  });
});
