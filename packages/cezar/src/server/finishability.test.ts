import { RUN_STATUS, STEP_KIND, STEP_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { describe, expect, it } from 'vitest';
import { apiRunSchema } from '@open-mercato/cezar-contract/runs';
import { createApp } from './server.js';
import { QUICK_TASK_WORKFLOW } from '../workflows/types.js';
import { apiRequest } from './loopback-request.testkit.js';
import { collect, manager, parent, root, store, until, useWorkerWaitFixture, worker } from '../workflows/worker-wait.testkit.js';
import { setRunStatus, hasPendingAsk } from '../runs/run-store.testkit.ts';

describe('authoritative finishability (#449)', () => {
  // The race below includes the final autosave, so its worktree keeps the mock's notes.md change.
  useWorkerWaitFixture({ mockNotes: true });
  const app = () => createApp({ repoRoot: root, store, manager, version: 'test' });
  const detail = async (id: string) => {
    const response = await apiRequest(app(), `/api/v1/runs/${id}`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(apiRunSchema.parse(body)).toEqual(body);
    return apiRunSchema.parse(body);
  };

  it('advertises a clear root and rejects the same root after a worker is created', async () => {
    const p = await parent();
    await until(() => store.getRun(p.id)?.status === 'waiting');
    expect((await detail(p.id)).finishBlocked).toBeNull();
    const w = await worker(p.id);
    const blocked = await detail(p.id);
    expect(blocked.finishBlocked).toContain(w.id);
    const response = await apiRequest(app(), `/api/v1/runs/${p.id}/finish`, { method: 'POST' });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: blocked.finishBlocked });
    expect(store.getRun(p.id)?.status).toBe('waiting');
    expect(store.getRun(p.id)).not.toHaveProperty('finishBlocked');
    const list = apiRunSchema.array().parse(await (await apiRequest(app(), '/api/v1/runs')).json());
    expect(list.every((run: object) => !('finishBlocked' in run))).toBe(true);
    const generation = store.commitWorkerExecutionStart(w.id);
    setRunStatus(store, w.id, RUN_STATUS.done);
    store.commitWorkerExecutionComplete(w.id, generation);
    expect((await detail(p.id)).finishBlocked).toContain(w.id);
    await collect(w.id);
    expect((await detail(p.id)).finishBlocked).toBeNull();
    expect((await apiRequest(app(), `/api/v1/runs/${p.id}/finish`, { method: 'POST' })).status).toBe(200);
    await until(() => !manager.isActive(p.id));
  });

  // The verdict reads the manager's live registries, which a session leaves only after its final
  // autosave, so the cockpit's refetch on the settling `review` event saw "no open session" and
  // hid Accept (review-gate.e2e.ts). The run is published again once it leaves them
  // (hearsay-tools/cezarion#1301).
  it('the last run event of a settled review permits Accept, opening session and Continue alike', async () => {
    process.env.CEZ_REVIEW_GATE = '1';
    let id = '';
    const verdicts: string[] = [];
    store.on('run', run => { if (run.id === id && run.status === 'review') verdicts.push(manager.finishBlockedReason(id) ?? 'none'); });
    id = manager.startRun(QUICK_TASK_WORKFLOW, { task: 'Improve the project notes.', runner: 'claude' }).id;
    for (const sendBack of [false, true]) {
      if (sendBack) expect(manager.continueRun(id, { text: 'Review feedback: mention the port.' }).ok).toBe(true);
      await until(() => store.getRun(id)?.status === 'waiting');
      verdicts.length = 0;
      expect(manager.finish(id)).toBe(true);
      await until(() => verdicts.at(-1) === 'none');
      expect((await detail(id)).finishBlocked).toBeNull();
    }
  });

  // hearsay-tools/cezarion#2784: only a root with workers keeps its pending question through Finish;
  // every task is a root once provisioned, and a lone task finishes as before.
  it.each(['no record', 'root without workers', 'root with a worker'] as const)('pending human ask, %s: the verdict agrees with POST', async shape => {
    const p = shape === 'no record' ? manager.startRun(QUICK_TASK_WORKFLOW, { task: 'mock:cezar-ask', runner: 'claude' }) : await parent('mock:cezar-ask');
    await until(() => hasPendingAsk(store, p.id) === true);
    if (shape === 'root with a worker') await worker(p.id);
    const blocked = shape === 'root with a worker';
    const verdict = (await detail(p.id)).finishBlocked;
    if (blocked) expect(verdict).toMatch(/pending human question/);
    else expect(verdict).toBeNull();
    expect((await apiRequest(app(), `/api/v1/runs/${p.id}/finish`, { method: 'POST' })).status).toBe(blocked ? 409 : 200);
    if (blocked) return;
    // The accepted Finish settles the task and closes its question, root or not.
    await until(() => ['done', 'review'].includes(store.getRun(p.id)?.status ?? ''));
    expect(hasPendingAsk(store, p.id)).toBe(false);
  });

  it.each(['queued', 'running', 'waiting', 'review', 'done', 'failed', 'cancelled'] as const)(
    'inactive %s with no workflow or session never advertises a false success', async status => {
      const run = store.createRun({ title: 'task', task: 'task', workflow: 'quick-task', steps: [] });
      setRunStatus(store, run.id, status);
      const verdict = (await detail(run.id)).finishBlocked;
      if (status === 'review') expect(verdict).toBeNull();
      else expect(verdict).toEqual(expect.any(String));
      expect((await apiRequest(app(), `/api/v1/runs/${run.id}/finish`, { method: 'POST' })).status).toBe(status === 'review' ? 200 : 409);
    });

  it('allows an inactive final-step root and POST finishes it', async () => {
    const p = store.createRun({ title: 'parent', task: 'task', workflow: 'quick-task', steps: [{ id: 'task', name: 'Task', kind: STEP_KIND.agent }] });
    setRunStatus(store, p.id, RUN_STATUS.waiting, { currentStepId: 'task', delegation: { role: 'root', permissions: [], receipts: [] } });
    expect((await detail(p.id)).finishBlocked).toBeNull();
    expect((await apiRequest(app(), `/api/v1/runs/${p.id}/finish`, { method: 'POST' })).status).toBe(200);
    await until(() => store.getRun(p.id)?.status === 'done');
  });

  it.each([false, true])('explains an inactive mid-workflow refusal (synthetic=%s)', async synthetic => {
    const run = store.createRun({ title: 'workflow', task: 'task', workflow: 'two-steps', steps: [
      { id: 'first', name: 'First', kind: STEP_KIND.agent }, { id: 'last', name: 'Last', kind: STEP_KIND.agent },
    ] });
    store.updateStep(run.id, 'first', { status: STEP_STATUS.waiting });
    if (synthetic) store.addStep(run.id, { id: 'continue-1', name: 'Continue', kind: STEP_KIND.agent, synthetic: 'continuation' });
    setRunStatus(store, run.id, RUN_STATUS.waiting, { currentStepId: synthetic ? 'continue-1' : 'first' });
    const blocked = await detail(run.id);
    expect(blocked.finishBlocked).toMatch(/workflow/i);
    const response = await apiRequest(app(), `/api/v1/runs/${run.id}/finish`, { method: 'POST' });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: blocked.finishBlocked });
    expect(store.getRun(run.id)?.status).toBe('waiting');
  });
});
