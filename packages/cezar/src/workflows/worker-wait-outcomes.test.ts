import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { QUICK_TASK_WORKFLOW } from './types.ts';
import { deliveredBesideWorkerMessages, checkpoint, controlledWire, fixtureUpdateRun, manager, parent, register, root, semaphore, store, terminal, timeline, until, useWorkerWaitFixture, waitOf, worker } from './worker-wait-claude.testkit.ts';
import { RUN_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';

// Real Git, durable fsync checkpoints and process shutdown share this outer budget.
// Keep the separate 15s state/termination assertions and actual runner timers intact.

describe('worker waits through RunManager', { timeout: 30_000 }, () => {
  useWorkerWaitFixture();
  it('releases only on yield and admits a live wake behind already queued work', async () => {
    const p = await parent(); const w = await worker(p.id);
    register(p.id, [w.id]); manager.enqueueOwnedRun(w.id);
    expect(store.getRun(w.id)?.status).toBe('queued'); expect(semaphore.busy()).toBe(1);
    await until(() => waitOf(store.getRun(p.id))?.phase === 'parked');
    await until(() => store.getRun(w.id)?.status === 'running');
    expect(semaphore.busy()).toBe(1); // only child, not parked parent
    const release = join(root, 'release-live-wake-blocker');
    process.env.CEZ_MOCK_RELEASE_FILE = release;
    const blocker = manager.startRun(QUICK_TASK_WORKFLOW, { task: 'mock:hold-gated', runner: 'claude' });
    const explain = () => `worker execution: ${JSON.stringify(store.readWorkerExecution(w.id))}\n${timeline(w.id)}\n${timeline(p.id)}\n${timeline(blocker.id)}`;
    try {
      await until(() => store.getRun(w.id)?.status === 'waiting', explain);
      await until(() => store.getRun(blocker.id)?.status === 'running' &&
        store.readEvents(blocker.id).some(event => event.type === 'turn.started'), explain);
      manager.finish(w.id);
      await until(() => terminal.includes(store.getRun(w.id)?.status ?? ''), explain);
      // Terminal status precedes execution cleanup; only the resolved wait proves the wake is owed.
      // bound: until's 15 s guards execution cleanup and durable wait resolution, not blocker lifetime.
      await until(() => waitOf(store.getRun(p.id))?.phase === 'wake-pending', explain);
      const wake = waitOf(store.getRun(p.id)); expect(wake?.phase).toBe('wake-pending');
      expect(store.getRun(blocker.id)?.status).toBe('running');
      expect(semaphore.busy()).toBe(1);
      expect(deliveredBesideWorkerMessages(store.getRun(p.id))).toBe(false);
      manager.reconcileWorkerWaits(); manager.reconcileWorkerWaits();
      expect(deliveredBesideWorkerMessages(store.getRun(p.id))).toBe(false);
      manager.cancel(blocker.id);
      await until(() => !waitOf(store.getRun(p.id)), explain);
      // Beside the idle worker's own park notice (hearsay-tools/cezarion#1327), the wake is the one input.
      const own = store.getRun(p.id)?.agentInputs?.filter(input => input.conversation?.senderRunId !== w.id);
      expect(own).toHaveLength(1);
      expect(own?.[0]).toMatchObject({ id: wake?.wakeId, source: 'lifecycle', parentRunId: p.id, deliveredAt: expect.any(String) });
      expect(store.readEvents(p.id).filter(e => e.type === 'user-message')).toEqual([]);
    } finally { writeFileSync(release, ''); }
  });

  for (const status of ['review', 'done', 'failed', 'cancelled'] as const) {
    it(`observes ${status} before registration, includes all selected statuses and wakes once`, async () => {
      const p = await parent(); const a = await worker(p.id); const b = await worker(p.id);
      fixtureUpdateRun(a.id, { status });
      const wait = register(p.id, [a.id, b.id]);
      expect(wait.phase).toBe('wake-pending'); expect(wait.outcomes[0]?.status).toBe(status);
      await until(() => !waitOf(store.getRun(p.id)));
      const inputs = store.getRun(p.id)?.agentInputs;
      expect(inputs).toHaveLength(1);
      expect(inputs?.[0]?.text).toContain(a.id); expect(inputs?.[0]?.text).toContain(status);
      expect(inputs?.[0]?.text).toContain(b.id); expect(inputs?.[0]?.text).toContain('queued');
      expect(store.readEvents(p.id).filter(e => e.type === 'worker-outcome')).toHaveLength(1);
    });
  }
  it('delivers all 32 terminal outcomes within the input bound without dropping durable summaries', async () => {
    const p = await parent(); checkpoint('32-parent-open'); const ids: string[] = [];
    for (let i = 0; i < 32; i++) {
      const w = await worker(p.id); ids.push(w.id); checkpoint(`32-created-${i + 1}`);
      fixtureUpdateRun(w.id, { status: RUN_STATUS.failed, error: '\u0000'.repeat(4_000) });
    }
    checkpoint('32-before-register'); const wait = register(p.id, ids); checkpoint('32-registered');
    expect(wait.outcomes).toHaveLength(32);
    expect(wait.outcomes.every(outcome => outcome.summary?.length === 4_000)).toBe(true);
    await until(() => !waitOf(store.getRun(p.id)));
    const input = store.getRun(p.id)?.agentInputs?.[0];
    expect(input?.text.length).toBeLessThanOrEqual(100_000);
    for (const id of ids) expect(input?.text).toContain(id);
    expect(store.readEvents(p.id).filter(event => event.type === 'worker-outcome')).toHaveLength(32);
  });

  it('observes completion between registration and park and reports every selected status', async () => {
    // Hold the real wire's first result until every real Git fixture exists.
    // A fixed playback delay cannot establish this ordering on a loaded host.
    const release = join(root, 'release-first-turn'); const wire = controlledWire({ firstResultGate: release });
    const p = await parent(); await until(wire.initialReceived);
    const statuses = ['queued', 'running', 'waiting', 'review', 'done', 'failed', 'cancelled'] as const;
    const children = [];
    for (const status of statuses) children.push({ run: await worker(p.id), status });
    const wait = register(p.id, children.map(child => child.run.id));
    expect(wait.phase).toBe('registered');
    // hearsay-tools/cezarion#1235: the entry resolves at its first observation, mid-turn, so the
    // statuses land together in one reconciliation for the result to report every one of them.
    const observe = vi.spyOn(manager, 'reconcileWorkerWaits').mockImplementation(() => {});
    for (const child of children) fixtureUpdateRun(child.run.id, { status: child.status });
    observe.mockRestore(); manager.reconcileWorkerWaits();
    expect(store.getRun(p.id)?.waits?.find(entry => entry.id === wait.id)?.phase).toBe('resolved');
    writeFileSync(release, 'release');
    await until(() => !waitOf(store.getRun(p.id)));
    const input = store.getRun(p.id)?.agentInputs?.[0];
    for (const child of children) expect(input?.text).toContain(JSON.stringify({ workerId: child.run.id, status: child.status }));
    expect(input?.id).toBe(wait.id);
    expect(store.readEvents(p.id).filter(event => event.type === 'worker-outcome')).toHaveLength(4);
  });

});
