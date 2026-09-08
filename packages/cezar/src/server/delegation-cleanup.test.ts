import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from './server.ts';
import { fixture } from '../delegation/service.testkit.ts';
import { workerDestroyResultSchema } from '@open-mercato/cezar-contract';

describe('human owned-worker cleanup', () => {
  let f: ReturnType<typeof fixture>;
  beforeEach(() => { vi.stubEnv('CEZ_DELEGATION', '1'); f = fixture(); });
  afterEach(() => { f.close(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
  it('rejects malformed human cleanup without state or intent changes and accepts absent or empty bodies', async () => {
    const { workerId } = await f.service.spawn(f.caller, { task: 'child', baseline: 'HEAD', requestId: randomUUID() });
    vi.stubEnv('CEZ_DELEGATION', '0');
    const app = createApp({ repoRoot: f.root, store: f.store, manager: f.manager, version: 'test', bootProjectId: 'project' });
    const before = structuredClone(f.store.getRun(workerId)); const events = f.store.readEvents(workerId);
    const url = `http://127.0.0.1/api/v1/runs/${workerId}/worker-destroy`;
    const response = await app.request(url, { method: 'POST', headers: { host: '127.0.0.1', 'content-type': 'application/json' }, body: '{' });
    expect(response.status).toBe(400); expect(await response.json()).toMatchObject({ code: 'invalid_input' });
    expect(f.store.getRun(workerId)).toEqual(before); expect(f.store.readEvents(workerId)).toEqual(events);
    for (const body of [undefined, '{}']) {
      expect((await app.request(url, { method: 'POST', headers: { host: '127.0.0.1', 'content-type': 'application/json' }, ...(body === undefined ? {} : { body }) })).status).toBe(200);
    }
  });
  it('uses the scoped chained route and boot alias with delegation off, retaining completed records', async () => {
    const { workerId } = await f.service.spawn(f.caller, { task: 'child', baseline: 'HEAD', requestId: randomUUID() });
    vi.stubEnv('CEZ_DELEGATION', '0');
    const app = createApp({ repoRoot: f.root, store: f.store, manager: f.manager, version: 'test', bootProjectId: 'project' });
    for (const prefix of ['/api/v1', '/api/v1/p/project', '/api/v1/p/default']) {
      const response = await app.request(`http://127.0.0.1${prefix}/runs/${workerId}/worker-destroy`, { method: 'POST', headers: { host: '127.0.0.1', 'content-type': 'application/json' }, body: '{}' });
      expect(response.status).toBe(200); expect(workerDestroyResultSchema.parse(await response.json())).toEqual({ workerId, state: 'complete', remaining: [] });
    }
    expect(f.store.getRun(workerId)?.delegation).toMatchObject({ destroy: { phase: 'complete' } });
    const denied = await app.request(`http://127.0.0.1/api/v1/runs/${workerId}/worker-destroy`, { method: 'POST', headers: { host: '127.0.0.1', origin: 'http://evil.example' } }); expect(denied.status).toBe(403);
    const forged = await app.request(`http://127.0.0.1/api/v1/runs/${workerId}/worker-destroy`, { method: 'POST', headers: { host: '127.0.0.1', 'content-type': 'application/json' }, body: '{"parentRunId":"fake"}' }); expect(forged.status).toBe(400);
    const ordinary = await app.request(`http://127.0.0.1/api/v1/runs/${f.parent.id}/worker-destroy`, { method: 'POST', headers: { host: '127.0.0.1' } }); expect(ordinary.status).toBe(403);
  });
  it.each(['delete', 'remove-worktree', 'variant-pick'] as const)('never lets %s erase a reused worker path or branch', async operation => {
    const { workerId } = await f.service.spawn(f.caller, { task: 'child', baseline: 'HEAD', requestId: randomUUID() });
    await f.service.destroy(f.caller, { workerId });
    const worker = f.store.getRun(workerId)!;
    if (worker.delegation?.role !== 'worker') throw Error('fixture');
    const { path, branch } = worker.delegation.workspace;
    execFileSync('git', ['worktree', 'add', '-qb', branch, path, 'HEAD'], { cwd: f.root });
    writeFileSync(join(path, 'unrelated.txt'), 'keep me');
    f.store.updateRun(workerId, { worktreePath: path, branch });
    expect(f.store.canDeleteRun(workerId)).toBe(true);
    const app = createApp({ repoRoot: f.root, store: f.store, manager: f.manager, version: 'test', bootProjectId: 'project' });
    let url = `/runs/${workerId}`;
    let body: string | undefined;
    if (operation === 'remove-worktree') url += '/remove-worktree';
    if (operation === 'variant-pick') {
      const groupId = randomUUID();
      const winner = f.store.createRun({ task: 'winner', title: 'winner', workflow: 'quick-task', steps: [] });
      f.store.updateRun(winner.id, { groupId, variant: 'A', status: 'done' });
      f.store.updateRun(workerId, { groupId, variant: 'B' });
      url = `/groups/${groupId}/pick`; body = JSON.stringify({ runId: winner.id });
    }
    const response = await app.request(`http://127.0.0.1/api/v1${url}`, { method: operation === 'delete' ? 'DELETE' : 'POST',
      headers: { host: '127.0.0.1', 'content-type': 'application/json' }, ...(body ? { body } : {}) });
    expect(response.status).toBe(operation === 'remove-worktree' ? 409 : 200);
    expect(existsSync(join(path, 'unrelated.txt'))).toBe(true);
    expect(execFileSync('git', ['rev-parse', `refs/heads/${branch}`], { cwd: f.root, encoding: 'utf8' }).trim()).toBe(f.sha);
    expect(f.store.getRun(workerId) === undefined).toBe(operation === 'delete');
  });

});
