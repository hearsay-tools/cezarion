import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RunStore } from '../runs/store.ts';
import { RunManager } from '../workflows/run.ts';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { createDelegationRoutes } from './routes.ts';
import { fixture } from './service.testkit.ts';
import { conversationSendResultSchema, conversationStateSchema, requestOutcomeSchema, delegationErrorResponseSchema, workerSpawnResultSchema, workerInspectionSchema, workerSteerResultSchema, workerStopResultSchema, workerDestroyResultSchema } from '@open-mercato/cezar-contract';

describe('authenticated delegation HTTP family', () => {
  let f: ReturnType<typeof fixture>, app: ReturnType<typeof createDelegationRoutes>;
  beforeEach(() => { vi.stubEnv('CEZ_DELEGATION', '1'); f = fixture(); app = createDelegationRoutes(f.service, f.credentials); });
  afterEach(() => { f?.close(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
  const request = (path: string, body?: unknown, headers: Record<string, string> = {}, method = body === undefined ? 'GET' : 'POST') => app.request(`http://127.0.0.1${path}`, { method, headers: { host: '127.0.0.1', authorization: `Bearer ${f.token}`, 'content-type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  async function spawn() {
    const response = await request('/spawn', { task: 'work', baseline: 'parent-head', requestId: randomUUID() });
    expect(response.status).toBe(201); return workerSpawnResultSchema.parse(await response.json());
  }
  it('validates and routes conversations while deriving sender from the authenticated credential', async () => {
    const { workerId } = await spawn();
    const input = { id: randomUUID(), recipientRunId: workerId, kind: 'request', text: 'Which file?' };
    for (const body of [{ ...input, senderRunId: workerId }, { ...input, requestId: randomUUID() }, { ...input, timeoutSeconds: 0 }, { ...input, text: '   ' }]) {
      expect((await request('/send', body)).status).toBe(400);
    }
    const response = await request('/send', input);
    expect(response.status).toBe(200);
    expect(conversationSendResultSchema.parse(await response.json())).toMatchObject({ message: { senderRunId: f.parent.id, recipientRunId: workerId, kind: 'request' }, delivery: 'queued' });
    const followup = await request('/follow-up', { id: randomUUID(), recipientRunId: workerId, kind: 'follow-up', requestId: input.id, text: 'More detail' });
    expect(followup.status).toBe(200); conversationSendResultSchema.parse(await followup.json());
    const token = f.credentials.issue('project', workerId, randomUUID()); f.store.updateRun(workerId, { status: 'running' });
    const reply = await request('/reply', { id: randomUUID(), recipientRunId: f.parent.id, kind: 'reply', requestId: input.id, text: 'index.ts' }, { authorization: `Bearer ${token}` });
    expect(reply.status).toBe(200); expect(conversationSendResultSchema.parse(await reply.json()).outcome?.status).toBe('replied');
    const inspected = await request('/conversation', { recipientRunId: workerId });
    expect(conversationStateSchema.parse(await inspected.json()).messages).toHaveLength(3);
    const cancelled = await request('/cancel-request', { requestId: input.id });
    expect(requestOutcomeSchema.parse(await cancelled.json()).status).toBe('replied');
  });
  it('collects under legacy inspect-only authority with strict middleware', async () => {
    const { workerId } = await spawn(); const parent = f.store.getRun(f.parent.id)!;
    if (parent.delegation?.role !== 'root') throw Error('fixture');
    f.store.commitDelegation([{ id: parent.id, delegation: { ...parent.delegation, permissions: ['inspect'] } }]);
    expect((await request(`/${workerId}/collect`, {})).status).toBe(200);
    expect((await request(`/${workerId}/collect`, { forged: true })).status).toBe(400);
    expect((await request('/bad/collect', {})).status).toBe(400);
    expect((await request(`/${workerId}/collect?token=forged`, {})).status).toBe(400);
    const response = await app.request(`http://127.0.0.1/${workerId}/collect`, { method: 'POST', headers: { host: '127.0.0.1', authorization: `Bearer ${f.token}`, 'content-type': 'application/json' }, body: '{' });
    expect(response.status).toBe(400);
  });
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
  it.each([['queued', false], ['done', false], ['review', false], ['failed', false], ['cancelled', false], ['done', true]] as const)('reads a settled current cancellation over HTTP for a %s parent after restart (legacy=%s)', async (status, legacy) => {
    const { workerId } = await spawn(); const waitId = randomUUID();
    const wait = { id: waitId, workerIds: [workerId], phase: 'wake-pending', reason: 'timeout', wakeId: waitId,
      deadline: new Date(Date.now() - 1000).toISOString(), outcomes: [] };
    const records = f.store.listRuns().map(run => run.id === f.parent.id ? { ...run, status,
      delegation: { ...run.delegation, permissions: ['wait'], wait: legacy ? { id: wait.id, workerIds: wait.workerIds, phase: wait.phase, deadline: wait.deadline, outcomes: wait.outcomes } : wait } } : run);
    writeFileSync(join(f.root, '.ai/cezar/runs.json'), JSON.stringify(records));
    const reopened = RunStore.open(join(f.root, '.ai/cezar'), { keepLive: true }); const manager = new RunManager(reopened, f.root);
    f.service.registerProject({ id: 'project', root: f.root, store: reopened, manager });
    try {
      for (let i = 0; i < 2; i++) {
        const response = await request('/cancel-wait', { waitId });
        expect(response.status).toBe(200); expect(await response.json()).toEqual({ wait });
      }
      expect(reopened.getRun(workerId)?.status).toBe('queued');
      expect(reopened.getRun(f.parent.id)?.status).toBe(status);
    } finally { manager.dispose(); reopened.flush(); }
  });
  it.each(['worker', 'foreign', 'no-grant'] as const)('denies %s callers access to a queued cancellation receipt', async kind => {
    const { workerId } = await spawn(); const waitId = randomUUID(); const parent = f.store.getRun(f.parent.id)!;
    if (parent.delegation?.role !== 'root') throw Error('fixture');
    f.store.commitDelegation([{ id: parent.id, delegation: { ...parent.delegation, permissions: kind === 'no-grant' ? ['inspect'] : ['wait'], lastWait: {
      id: waitId, workerIds: [workerId], phase: 'wake-pending', reason: 'cancelled', wakeId: waitId,
      deadline: new Date().toISOString(), outcomes: [],
    } } }]);
    f.store.updateRun(parent.id, { status: 'queued' });
    const token = kind === 'worker' ? f.credentials.issue('project', workerId, randomUUID())
      : kind === 'foreign' ? f.credentials.issue('elsewhere', parent.id, randomUUID()) : f.token;
    const before = structuredClone(f.store.listRuns());
    expect((await request('/cancel-wait', { waitId }, { authorization: `Bearer ${token}` })).status).toBe(403);
    expect(f.store.listRuns()).toEqual(before);
  });

});
