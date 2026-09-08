import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { createDelegationRoutes } from './routes.ts';
import { fixture } from './service.testkit.ts';
import { delegationErrorResponseSchema, workerSpawnResultSchema, workerInspectionSchema, workerSteerResultSchema, workerStopResultSchema, workerDestroyResultSchema } from '@open-mercato/cezar-contract';

describe('authenticated delegation HTTP family', () => {
  let f: ReturnType<typeof fixture>, app: ReturnType<typeof createDelegationRoutes>;
  beforeEach(() => { vi.stubEnv('CEZ_DELEGATION', '1'); f = fixture(); app = createDelegationRoutes(f.service, f.credentials); });
  afterEach(() => { f?.close(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
  const request = (path: string, body?: unknown, headers: Record<string, string> = {}, method = body === undefined ? 'GET' : 'POST') => app.request(`http://127.0.0.1${path}`, { method, headers: { host: '127.0.0.1', authorization: `Bearer ${f.token}`, 'content-type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  async function spawn() {
    const response = await request('/spawn', { task: 'work', baseline: 'parent-head', requestId: randomUUID() });
    expect(response.status).toBe(201); return workerSpawnResultSchema.parse(await response.json());
  }
  it('cancels with existing wait-only authority and returns retained settlement on retry', async () => {
    const { workerId } = await spawn(); const waitId = randomUUID();
    const delegation = f.store.getRun(f.parent.id)!.delegation!;
    if (delegation.role !== 'root') throw Error('fixture');
    f.store.commitDelegation([{ id: f.parent.id, delegation: { ...delegation, permissions: ['wait'], wait: {
      id: waitId, workerIds: [workerId], phase: 'registered', deadline: new Date(Date.now() + 600_000).toISOString(), outcomes: [],
    } } }]);
    const response = await request('/cancel-wait', { waitId });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ wait: { id: waitId, reason: 'cancelled' } });
    f.store.commitWorkerWaitWithdrawal(f.parent.id, waitId);
    expect(await (await request('/cancel-wait', { waitId })).json()).toMatchObject({ wait: { id: waitId, reason: 'cancelled' } });
    expect(f.store.getRun(workerId)?.status).toBe('queued');
    const retired = f.store.getRun(f.parent.id)!.delegation!;
    if (retired.role !== 'root') throw Error('fixture');
    f.store.commitDelegation([{ id: f.parent.id, delegation: { ...retired, permissions: ['inspect'] } }]);
    expect((await request('/cancel-wait', { waitId })).status).toBe(403);
  });
  it('validates cancellation IDs and bodies before any state mutation', async () => {
    for (const body of [{}, { waitId: 'bad' }, { waitId: randomUUID(), parentRunId: f.parent.id }]) {
      expect((await request('/cancel-wait', body)).status).toBe(400);
    }
    expect((await request('/cancel-wait', { waitId: randomUUID() })).status).toBe(409);
  });
  it.each(['stop', 'destroy'])('rejects malformed %s without lifecycle or intent changes, while accepting empty bodies', async operation => {
    const { workerId } = await spawn();
    const before = structuredClone(f.store.getRun(workerId));
    const events = f.store.readEvents(workerId);
    const response = await app.request(`http://127.0.0.1/${workerId}/${operation}`, { method: 'POST', headers: { host: '127.0.0.1', authorization: `Bearer ${f.token}`, 'content-type': 'application/json' }, body: '{' });
    expect(response.status).toBe(400); expect(await response.json()).toMatchObject({ code: 'invalid_input' });
    expect(f.store.getRun(workerId)).toEqual(before); expect(f.store.readEvents(workerId)).toEqual(events);
    for (const body of [undefined, {}]) {
      const accepted = await request(`/${workerId}/${operation}`, body, {}, 'POST');
      expect(accepted.status).toBe(200);
    }
  });
  it('exposes all operations with bounded contract results and no credentials', async () => {
    const { workerId } = await spawn();
    const inspection = await request(`/${workerId}`); expect(workerInspectionSchema.parse(await inspection.json())).toMatchObject({ workerId });
    const steer = await request(`/${workerId}/steer`, { text: 'hello' }); expect(workerSteerResultSchema.parse(await steer.json())).toEqual({ workerId, state: 'queued' });
    const diff = await request(`/${workerId}/diff`); expect(delegationErrorResponseSchema.parse(await diff.json()).code).toBe('unavailable_diff');
    const wait = await request('/wait', { workerIds: [workerId] }); expect(delegationErrorResponseSchema.parse(await wait.json()).code).toBe('incompatible_state');
    const stop = await request(`/${workerId}/stop`, {}); expect(workerStopResultSchema.parse(await stop.json())).toEqual({ workerId, state: 'terminated' });
    const destroy = await request(`/${workerId}/destroy`, {}); expect(workerDestroyResultSchema.parse(await destroy.json())).toEqual({ workerId, state: 'complete', remaining: [] });
    expect(JSON.stringify(f.store.listRuns()) + JSON.stringify(f.store.readEvents(workerId))).not.toContain(f.token);
  });
  it.each(['', 'Bearer bad', 'Basic ignored'])('rejects invalid credentials %s', async authorization => {
    const response = await request('/spawn', { task: 'x', baseline: 'HEAD', requestId: randomUUID() }, { authorization });
    expect(response.status).toBe(401); expect(await response.json()).toMatchObject({ code: 'unauthenticated' });
  });
  it.each<Record<string, string>>([{ host: 'evil.example' }, { host: '127.evil.example' }, { host: '' }, { origin: 'http://evil.example' }, { origin: 'null' }, { origin: 'http://127.0.0.1:9999' }, { 'sec-fetch-site': 'cross-site' }])('rejects rebinding/cross-origin %j even in hosted mode', async headers => {
    vi.stubEnv('CEZ_REMOTE', '1');
    const response = await request('/spawn', {}, headers);
    expect(response.status).toBe(403); expect(await response.json()).toMatchObject({ code: 'denied_scope' });
  });
  it('strictly rejects forged identities, malformed JSON/params/query, and arbitrary operation fields', async () => {
    const valid = { task: 'work', baseline: 'HEAD', requestId: randomUUID() };
    for (const name of ['parentRunId', 'projectId', 'runId', 'env', 'allowedTools', 'workflow']) {
      const response = await request('/spawn', { ...valid, [name]: 'forged' });
      expect(response.status).toBe(400); expect(delegationErrorResponseSchema.parse(await response.json()).code).toBe('invalid_input');
    }
    for (const path of ['/not-a-uuid', `/${randomUUID()}?token=override`]) {
      const response = await request(path); expect(response.status).toBe(400); expect(await response.json()).toMatchObject({ code: 'invalid_input' });
    }
    const malformed = await app.request('http://127.0.0.1/spawn', { method: 'POST', headers: { host: '127.0.0.1', authorization: `Bearer ${f.token}` }, body: '{' });
    expect(malformed.status).toBe(400); expect(await malformed.json()).toMatchObject({ code: 'invalid_input' });
  });
  it('denies unrelated, wrong-project and worker identities and revokes existing callers', async () => {
    const { workerId } = await spawn();
    for (const [projectId, runId] of [['other', f.parent.id], ['project', workerId]]) {
      const token = f.credentials.issue(projectId!, runId!, randomUUID());
      const response = await request(`/${workerId}`, undefined, { authorization: `Bearer ${token}` });
      expect(response.status).toBe(403); expect(await response.json()).toMatchObject({ code: 'denied_scope' });
    }
    f.credentials.revoke(f.parent.id);
    expect((await request(`/${workerId}`)).status).toBe(401);
  });
  it.each(['/api/v1/runs', '/api/v1/runs/other/continue', '/api/v1/projects', '/api/v1/fs/browse', '/api/v1/workspace/config', '/api/v1/health'])('does not mount cockpit authority at %s', async path => {
    const listener = new Hono().route('/api/v1/delegation', app);
    const response = await listener.request(`http://127.0.0.1${path}`, { headers: { authorization: `Bearer ${f.token}`, host: '127.0.0.1' } });
    expect(response.status).toBe(404);
  });
  it('disables existing credentials immediately', async () => {
    vi.stubEnv('CEZ_DELEGATION', '0');
    expect(await (await request('/spawn', {})).json()).toMatchObject({ code: 'unavailable_transport' });
  });
});
