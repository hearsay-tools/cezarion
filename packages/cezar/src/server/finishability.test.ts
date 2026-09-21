import { describe, expect, it } from 'vitest';
import { apiRunSchema } from '@open-mercato/cezar-contract';
import { createApp } from './server.js';
import { QUICK_TASK_WORKFLOW } from '../workflows/types.js';
import { apiRequest } from './loopback-request.testkit.js';
import { collect, manager, parent, root, store, until, useWorkerWaitFixture, worker } from '../workflows/worker-wait.testkit.js';

describe('authoritative finishability (#449)', () => {
  useWorkerWaitFixture();
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
    store.updateRun(w.id, { status: 'done' });
    store.commitWorkerExecutionComplete(w.id, generation);
    expect((await detail(p.id)).finishBlocked).toContain(w.id);
    await collect(w.id);
    expect((await detail(p.id)).finishBlocked).toBeNull();
    expect((await apiRequest(app(), `/api/v1/runs/${p.id}/finish`, { method: 'POST' })).status).toBe(200);
    await until(() => !manager.isActive(p.id));
  });

  it.each([false, true])('pending human ask, delegation root=%s: the verdict agrees with POST', async isRoot => {
    const p = isRoot ? await parent('mock:ask') : manager.startRun(QUICK_TASK_WORKFLOW, { task: 'mock:ask', runner: 'claude' });
    await until(() => store.getRun(p.id)?.hasPendingHumanAsk === true);
    const verdict = (await detail(p.id)).finishBlocked;
    if (isRoot) expect(verdict).toMatch(/pending human question/);
    else expect(verdict).toBeNull();
    expect((await apiRequest(app(), `/api/v1/runs/${p.id}/finish`, { method: 'POST' })).status).toBe(isRoot ? 409 : 200);
  });

  it.each(['queued', 'running', 'waiting', 'review', 'done', 'failed', 'cancelled'] as const)(
    'inactive %s with no workflow or session never advertises a false success', async status => {
      const run = store.createRun({ title: 'task', task: 'task', workflow: 'quick-task', steps: [] });
      store.updateRun(run.id, { status });
      const verdict = (await detail(run.id)).finishBlocked;
      if (status === 'review') expect(verdict).toBeNull();
      else expect(verdict).toEqual(expect.any(String));
      expect((await apiRequest(app(), `/api/v1/runs/${run.id}/finish`, { method: 'POST' })).status).toBe(status === 'review' ? 200 : 409);
    });

  it('allows an inactive final-step root and POST finishes it', async () => {
    const p = store.createRun({ title: 'parent', task: 'task', workflow: 'quick-task', steps: [{ id: 'task', name: 'Task', kind: 'agent' }] });
    store.updateRun(p.id, { status: 'waiting', currentStepId: 'task', delegation: { role: 'root', permissions: [], receipts: [] } });
    expect((await detail(p.id)).finishBlocked).toBeNull();
    expect((await apiRequest(app(), `/api/v1/runs/${p.id}/finish`, { method: 'POST' })).status).toBe(200);
    await until(() => store.getRun(p.id)?.status === 'done');
  });

  it.each([false, true])('explains an inactive mid-workflow refusal (synthetic=%s)', async synthetic => {
    const run = store.createRun({ title: 'workflow', task: 'task', workflow: 'two-steps', steps: [
      { id: 'first', name: 'First', kind: 'agent' }, { id: 'last', name: 'Last', kind: 'agent' },
    ] });
    store.updateStep(run.id, 'first', { status: 'waiting' });
    if (synthetic) store.addStep(run.id, { id: 'continue-1', name: 'Continue', kind: 'agent', synthetic: 'continuation' });
    store.updateRun(run.id, { status: 'waiting', currentStepId: synthetic ? 'continue-1' : 'first' });
    const blocked = await detail(run.id);
    expect(blocked.finishBlocked).toMatch(/workflow/i);
    const response = await apiRequest(app(), `/api/v1/runs/${run.id}/finish`, { method: 'POST' });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: blocked.finishBlocked });
    expect(store.getRun(run.id)?.status).toBe('waiting');
  });
});
