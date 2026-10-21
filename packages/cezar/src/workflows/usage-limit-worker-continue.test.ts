import { describe, expect, it } from 'vitest';
import { manager, parent, store, until, useWorkerWaitFixture, worker } from './worker-wait.testkit.ts';

/** A human Continue of an owned worker on a usage-limit hold joins the line (hearsay-tools/cezarion#1236).
 *  Its execution must be reserved unadmitted, or `canLeaveLine` refuses it forever: the pump admits it. */
describe('a held worker\'s human Continue', () => {
  useWorkerWaitFixture();

  it('queues with an unadmitted execution the pump can admit', async () => {
    const p = await parent();
    const child = await worker(p.id, 'mock:done ok');
    store.updateStep(child.id, 'task', { status: 'failed', sessionId: 'sess-held', backend: 'claude' });
    store.updateRun(child.id, { status: 'waiting', autoResumeAt: new Date(Date.now() + 3_600_000).toISOString() });
    // Another run's deadline on the same account keeps the continuation in the line.
    const holder = store.createRun({ title: 'holder', workflow: 'w', task: 't', runner: 'claude', steps: [] });
    store.updateRun(holder.id, { status: 'waiting', autoResumeAt: new Date(Date.now() + 3_600_000).toISOString() });

    expect(manager.continueRun(child.id, { text: 'mock:done carry on' })).toEqual({ ok: true });
    expect(store.getRun(child.id)?.status).toBe('queued');
    const engine = manager as unknown as { executions: Map<string, { admitted: boolean }> };
    expect(engine.executions.get(child.id)?.admitted).toBe(false);

    // The hold lifts: the pump admits the continuation and it runs.
    manager.cancelAutoResume(holder.id);
    await until(() => store.getRun(child.id)?.status !== 'queued', () => `child ${store.getRun(child.id)?.status}`);
    expect(engine.executions.get(child.id)?.admitted ?? true).toBe(true);
  }, 60_000);
});
