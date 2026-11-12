import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { type WorkerWait } from '@open-mercato/cezar-contract/delegation';
import { grantSteer, checkpoint, manager, parent, register, restart, semaphore, store, until, useWorkerWaitFixture, waitOf, worker } from './worker-wait-claude.testkit.ts';

// Real Git, durable fsync checkpoints and process shutdown share this outer budget.
// Keep the separate 15s state/termination assertions and actual runner timers intact.

describe('worker waits through RunManager', { timeout: 30_000 }, () => {
  useWorkerWaitFixture();
  // The question is the parent's (hearsay-tools/cezarion#2410); the parent's wait expiring answers
  // nothing of it.
  it("a parent timeout leaves a waiting child's question unanswered", async () => {
    const p = await parent(); grantSteer(p.id); const w = await worker(p.id, 'mock:cezar-ask');
    const wait = register(p.id, [w.id]); manager.enqueueOwnedRun(w.id);
    await until(() => store.readEvents(w.id).some(event => event.type === 'ask.requested'));
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(wait.deadline!);
    manager.reconcileWorkerWaits(); vi.useRealTimers();
    await until(() => !waitOf(store.getRun(p.id)));
    expect(store.getRun(w.id)?.status).toBe('waiting');
    expect(store.readEvents(w.id).filter(event => event.type === 'human-input-delivered')).toEqual([]);
    expect(store.transcriptFacts(w.id).pendingAsk?.routedMessageId).toBeDefined();
    // The worker's question is a conversation message; the wait's timeout notice is the parent's own.
    expect(store.getRun(p.id)?.agentInputs?.find(input => !input.conversation)?.text).toContain('waiting');
  });

  // hearsay-tools/cezarion#1235: an identical registration returns the open wait, and a question
  // neither withdraws it nor refuses one.
  it('rejects duplicate sets, excessive deadlines and foreign workers; an identical wait stays the open one beside a pending ask', async () => {
    const p = await parent(); const w = await worker(p.id);
    expect(() => register(p.id, [w.id, w.id])).toThrow();
    expect(() => register(p.id, [w.id], 7201)).toThrow();
    expect(() => register(p.id, [randomUUID()])).toThrow();
    const wait = manager.registerWorkerWait(p.id, { workerIds: [w.id] } as never);
    expect(Date.parse(wait.deadline!) - Date.now()).toBeGreaterThan(599_000);
    expect(register(p.id, [w.id]).id).toBe(wait.id);
    await until(() => waitOf(store.getRun(p.id))?.phase === 'parked');
    manager.sendMessage(p.id, [{ type: 'text', text: 'mock:cezar-ask' }]);
    await until(() => store.readEvents(p.id).some(e => e.type === 'ask.requested'));
    expect(waitOf(store.getRun(p.id))?.id).toBe(wait.id);
    expect(register(p.id, [w.id]).id).toBe(wait.id);
  });
  it('expires a registered executing parent without freeing its slot or cancelling workers', async () => {
    const p = await parent('mock:slow'); const w = await worker(p.id);
    const wait = register(p.id, [w.id], 1);
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(wait.deadline!); manager.reconcileWorkerWaits();
    expect(waitOf(store.getRun(p.id))?.phase).toBe('wake-pending');
    expect(semaphore.busy()).toBe(1); expect(store.getRun(w.id)?.status).toBe('queued');
    expect(store.getRun(p.id)?.agentInputs?.some(i => i.deliveredAt)).not.toBe(true);
  });
  it('rebuilds a parked deadline on restart, expires without cancelling the queued child', async () => {
    const p = await parent(); checkpoint('deadline-parent-open'); const w = await worker(p.id); checkpoint('deadline-worker-created');
    const wait = register(p.id, [w.id]);
    await until(() => waitOf(store.getRun(p.id))?.phase === 'parked');
    checkpoint('deadline-before-restart'); await restart(true); checkpoint('deadline-recovered');
    expect(store.getRun(p.id)?.status).toBe('waiting');
    expect(waitOf(store.getRun(p.id))?.id).toBe(wait.id);
    await vi.advanceTimersByTimeAsync(600_000); checkpoint('deadline-timer-fired');
    expect(waitOf(store.getRun(p.id))?.phase).toBe('wake-pending');
    vi.useRealTimers();
    await until(() => !waitOf(store.getRun(p.id)));
    expect(store.getRun(w.id)?.status).not.toBe('cancelled');
    expect(store.getRun(p.id)?.agentInputs?.[0]?.id).toBe(wait.id);
    expect(store.readEvents(p.id).filter(e => e.type === 'user-message')).toEqual([]);
  });
  for (const phase of ['registered', 'parked', 'wake-pending'] as const) {
    it(`restart reconciles ${phase} before generic waiting settlement and deduplicates recovery`, async () => {
      const p = await parent();
      await until(() => store.getRun(p.id)?.status === 'waiting');
      const w = await worker(p.id);
      const wait: WorkerWait = { id: randomUUID(), workerIds: [w.id], phase, deadline: new Date().toISOString(), outcomes: [] };
      const delegation = store.getRun(p.id)!.delegation!;
      if (delegation.role !== 'root') throw Error('fixture');
      store.commitDelegation([{ id: p.id, delegation: { ...delegation, wait } }]);
      await restart(); await manager.recover();
      await until(() => !waitOf(store.getRun(p.id)));
      expect(store.getRun(p.id)?.agentInputs?.filter(i => i.id === wait.id)).toHaveLength(1);
      expect(store.getRun(p.id)?.steps.filter(s => s.id.startsWith('continue-'))).toHaveLength(1);
      expect(store.readEvents(p.id).filter(e => e.type === 'user-message')).toEqual([]);
      // The continued handler must also park before DONE/monitoring behavior.
      const again = register(p.id, [w.id]);
      await until(() => waitOf(store.getRun(p.id))?.phase === 'parked');
      expect(again.id).not.toBe(wait.id);
    });
  }
});
