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
});
