import { ensureOwnedWorkspace } from '../delegation/workspace.ts';
import { setRunStatus } from '../runs/run-store.testkit.ts';
import { RUN_STATUS, STEP_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { describe, expect, it } from 'vitest';
import { manager, parent, root, store, until, useWorkerWaitFixture, worker } from './worker-wait-claude.testkit.ts';

/** A human Continue of an owned worker on a usage-limit hold joins the line (hearsay-tools/cezarion#1236).
 *  Its execution must be reserved unadmitted, or `canLeaveLine` refuses it forever: the pump admits it. */
describe('a held worker\'s human Continue', () => {
  useWorkerWaitFixture();

  it('queues with an unadmitted execution the pump can admit', async () => {
    const p = await parent();
    const child = await worker(p.id, 'mock:cezar-done ok');
    await ensureOwnedWorkspace(root, child);
    store.updateStep(child.id, 'task', { status: STEP_STATUS.failed, sessionId: 'sess-held', backend: 'claude' });
    setRunStatus(store, child.id, RUN_STATUS.waiting, { autoResumeAt: new Date(Date.now() + 3_600_000).toISOString() });
    // Another run's deadline on the same account keeps the continuation in the line.
    const holder = store.createRun({ title: 'holder', workflow: 'w', task: 't', runner: 'claude', steps: [] });
    setRunStatus(store, holder.id, RUN_STATUS.waiting, { autoResumeAt: new Date(Date.now() + 3_600_000).toISOString() });

    expect(manager.continueRun(child.id, { text: 'mock:cezar-done carry on' })).toEqual({ ok: true });
    expect(store.getRun(child.id)?.status).toBe('queued');
    expect(store.readWorkerExecution(child.id)?.phase).toBe('starting');

    // The hold lifts: the pump admits the continuation and it runs.
    manager.cancelAutoResume(holder.id);
    await until(() => store.getRun(child.id)?.status !== 'queued', () => `child ${store.getRun(child.id)?.status}`);
    await until(() => store.readEvents(child.id).some(event => event.type === 'text'));
    expect(store.getRun(child.id)?.steps[0]?.sessionId).toBeDefined();
  }, 60_000);
});
