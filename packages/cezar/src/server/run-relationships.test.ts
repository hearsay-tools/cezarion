import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { runRelationshipsSchema, type WorkerSpawnResult } from '@open-mercato/cezar-contract';
import { createApp } from './server.ts';
import { fixture } from '../delegation/service.testkit.ts';
let f: ReturnType<typeof fixture>;
beforeEach(() => { vi.stubEnv('CEZ_DELEGATION', '1'); f = fixture(); });
afterEach(async () => { await f.close(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
// Exercise all 32 real durable creations; this is not a 5s filesystem throughput assertion.
it('reads all owned workers including archived records through each human project alias with delegation off', { timeout: 30_000 }, async () => {
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
// #659: the human read is O(receipts), never a walk of the whole project index. A store with
// many unrelated (and archived) records must cost the same as one with none.
it('serves a parent\'s workers off its receipts without walking the run index', async () => {
  const spawned = await f.service.spawn(f.caller, { task: 'child', baseline: 'HEAD', requestId: randomUUID() });
  const unrelated = f.store.createRun({ title: 'unrelated', task: 'unrelated', workflow: 'quick-task', steps: [] });
  f.store.updateRun(unrelated.id, { archived: true, status: 'done' });
  const app = createApp({ repoRoot: f.root, store: f.store, manager: f.manager, version: 'test', bootProjectId: 'project' });
  const scan = vi.spyOn(f.store, 'listRuns');
  const read = (id: string) => app.request(`http://127.0.0.1/api/v1/runs/${id}/relationships`, { headers: { host: '127.0.0.1' } });
  expect(await (await read(f.parent.id)).json()).toEqual({ workers: [expect.objectContaining({ workerId: spawned.workerId, parentRunId: f.parent.id })],
    capacity: { outstanding: 1, limit: 32, created: 1, creationLimit: 1024 }, titles: [expect.objectContaining({ id: spawned.workerId })] });
  // A worker owns no workers, and an ordinary run owns none: neither reads a single other record.
  expect(await (await read(spawned.workerId)).json()).toEqual({ parentRunId: f.parent.id, workers: [], titles: [expect.objectContaining({ id: f.parent.id })] });
  expect(await (await read(unrelated.id)).json()).toEqual({ workers: [] });
  expect(scan).not.toHaveBeenCalled();
  // A receipt whose record is gone is skipped, not invented.
  const root = f.store.getRun(f.parent.id)!.delegation;
  if (root?.role !== 'root') throw new Error('missing root fixture');
  const stale = { ...root.receipts[0]!, requestId: randomUUID(), workerId: randomUUID() };
  f.store.updateRun(f.parent.id, { delegation: { ...root, receipts: [...root.receipts, stale] } });
  // The stale receipt still holds its slot: no deletion marker proves its resources are gone.
  expect(await (await read(f.parent.id)).json()).toEqual({ workers: [expect.objectContaining({ workerId: spawned.workerId })],
    capacity: { outstanding: 2, limit: 32, created: 2, creationLimit: 1024 }, titles: [expect.objectContaining({ id: spawned.workerId })] });
});
// #816: history beyond the old 32 is listed in full, never sliced, with the parent's capacity.
it('lists all 33 owned workers and the parent capacity after a verified destroy frees a slot', { timeout: 60_000 }, async () => {
  const workers: WorkerSpawnResult[] = [];
  for (let i = 0; i < 32; i++) workers.push(await f.service.spawn(f.caller, { task: `worker ${i}`, baseline: 'HEAD', requestId: randomUUID() }));
  expect(await f.service.destroy(f.caller, { workerId: workers[0]!.workerId })).toMatchObject({ state: 'complete' });
  workers.push(await f.service.spawn(f.caller, { task: 'worker 33', baseline: 'HEAD', requestId: randomUUID() }));
  const app = createApp({ repoRoot: f.root, store: f.store, manager: f.manager, version: 'test', bootProjectId: 'project' });
  const read = (id: string) => app.request(`http://127.0.0.1/api/v1/runs/${id}/relationships`, { headers: { host: '127.0.0.1' } });
  const data = runRelationshipsSchema.parse(await (await read(f.parent.id)).json());
  expect(data.workers.map(worker => worker.workerId).sort()).toEqual(workers.map(worker => worker.workerId).sort());
  expect(data.capacity).toEqual({ outstanding: 32, limit: 32, created: 33, creationLimit: 1024 });
  expect(await (await read(workers[32]!.workerId)).json()).not.toHaveProperty('capacity');
});
// #864: the cockpit's run list no longer carries archived workers, so the relationships answer
// names its own runs — the parent's title for a worker, each worker's for a parent.
it('carries the titles of the parent and of every worker, archived ones included', async () => {
  const { workerId } = await f.service.spawn(f.caller, { task: 'child', baseline: 'HEAD', requestId: randomUUID() });
  f.store.updateRun(workerId, { title: 'Child task', titleSummary: 'Fix the child', archived: true, status: 'done' });
  f.store.updateRun(f.parent.id, { title: 'Parent task' });
  const app = createApp({ repoRoot: f.root, store: f.store, manager: f.manager, version: 'test', bootProjectId: 'project' });
  const read = async (id: string) => runRelationshipsSchema.parse(await (await app.request(`http://127.0.0.1/api/v1/runs/${id}/relationships`, { headers: { host: '127.0.0.1' } })).json());
  expect((await read(f.parent.id)).titles).toEqual([{ id: workerId, title: 'Child task', titleSummary: 'Fix the child' }]);
  expect((await read(workerId)).titles).toEqual([{ id: f.parent.id, title: 'Parent task' }]);
});
