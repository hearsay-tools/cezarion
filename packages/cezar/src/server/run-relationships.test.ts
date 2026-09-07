import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { runRelationshipsSchema, type WorkerSpawnResult } from '@open-mercato/cezar-contract';
import { createApp } from './server.ts';
import { fixture } from '../delegation/service.testkit.ts';
let f: ReturnType<typeof fixture>;
beforeEach(() => { vi.stubEnv('CEZ_DELEGATION', '1'); f = fixture(); });
afterEach(() => { f.close(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
it('reads all owned workers including archived records through each human project alias with delegation off', async () => {
  const workers: WorkerSpawnResult[] = [];
  for (let i = 0; i < 32; i++) workers.push(await f.service.spawn(f.caller, { task: `worker ${i}`, baseline: 'HEAD', requestId: randomUUID() }));
  const owned = f.store.getRun(workers[0]!.workerId)!.delegation;
  if (owned?.role !== 'worker') throw new Error('missing worker fixture');
  f.store.updateRun(workers[0]!.workerId, { archived: true, status: 'cancelled', delegation: { ...owned, destroy: { requestedAt: '2026-09-06T00:00:00.000Z', phase: 'incomplete', remaining: ['branch'], error: 'Branch checked out' } } });
  vi.stubEnv('CEZ_DELEGATION', '0');
  const app = createApp({ repoRoot: f.root, store: f.store, manager: f.manager, version: 'test', bootProjectId: 'project' });
  let expected: unknown;
  for (const prefix of ['/api/v1', '/api/v1/p/project', '/api/v1/p/default']) {
    const res = await app.request(`http://127.0.0.1${prefix}/runs/${f.parent.id}/relationships`, { headers: { host: '127.0.0.1' } });
    expect(res.status).toBe(200);
    const body = await res.json();
    const data = runRelationshipsSchema.parse(body);
    expect(body).toEqual(data);
    expect(data.workers.map(worker => worker.workerId).sort()).toEqual(workers.map(worker => worker.workerId).sort());
    expect(data.workers.find(worker => worker.workerId === workers[0]!.workerId)?.status).toBe('cancelled');
    if (expected) expect(data).toEqual(expected); else expected = data;
    expect(data.workers.find(worker => worker.workerId === workers[0]!.workerId)?.destroy).toMatchObject({ phase: 'incomplete', remaining: ['branch'] });
    expect(JSON.stringify(body)).not.toMatch(/token|identity|claudeLayout/);
  }
});
it('retains parent identity without a parent record and distinguishes unknown runs from empty ordinary runs', async () => {
  const { workerId } = await f.service.spawn(f.caller, { task: 'child', baseline: 'HEAD', requestId: randomUUID() });
  const app = createApp({ repoRoot: f.root, store: f.store, manager: f.manager, version: 'test', bootProjectId: 'project' });
  const read = (id: string) => app.request(`http://127.0.0.1/api/v1/runs/${id}/relationships`, { headers: { host: '127.0.0.1' } });
  const originalGet = f.store.getRun.bind(f.store);
  vi.spyOn(f.store, 'getRun').mockImplementation(id => id === f.parent.id ? undefined : originalGet(id));
  const childResponse = await read(workerId); expect(childResponse.status).toBe(200);
  expect(await childResponse.json()).toEqual({ parentRunId: f.parent.id, workers: [] });
  const ordinary = f.store.createRun({ title: 'ordinary', task: 'ordinary', workflow: 'quick-task', steps: [] });
  expect(await (await read(ordinary.id)).json()).toEqual({ workers: [] });
  expect((await read(randomUUID())).status).toBe(404);
  expect((await read('bad%20id')).status).toBe(400);
  expect((await app.request(`http://127.0.0.1/api/v1/runs/${workerId}/relationships?parentRunId=forged`, { headers: { host: '127.0.0.1' } })).status).toBe(400);
  expect((await app.request(`http://127.0.0.1/api/v1/p/other/runs/${workerId}/relationships`, { headers: { host: '127.0.0.1' } })).status).toBe(404);
});
