import { createFixtureManager } from '../workflows/fixture-cleanup.testkit.ts';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RunStore } from '../runs/store.ts';

import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { createDelegationRoutes } from './routes.ts';
import { fixture } from './service.testkit.ts';
import { conversationSendResultSchema, conversationInspectResultSchema, inboxReserveResultSchema, inboxReceiptResultSchema, requestOutcomeSchema } from '@open-mercato/cezar-contract/conversations';
import { workerListResultSchema, delegationErrorResponseSchema, workerSpawnResultSchema, workerInspectionSchema, workerSteerResultSchema, workerStopResultSchema, workerDestroyResultSchema } from '@open-mercato/cezar-contract/delegation';
import { seedRuns } from '../runs/run-store.testkit.ts';

describe('authenticated delegation HTTP family', () => {
  let f: ReturnType<typeof fixture>, app: ReturnType<typeof createDelegationRoutes>;
  beforeEach(() => { vi.stubEnv('CEZ_DELEGATION', '1'); f = fixture(); app = createDelegationRoutes(f.service, f.credentials); });
  afterEach(async () => { await f?.close(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
  const request = (path: string, body?: unknown, headers: Record<string, string> = {}, method = body === undefined ? 'GET' : 'POST') => app.request(`http://127.0.0.1${path}`, { method, headers: { host: '127.0.0.1', authorization: `Bearer ${f.token}`, 'content-type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  async function spawn() {
    const response = await request('/spawn', { task: 'work', baseline: 'parent-head', requestId: randomUUID() });
    expect(response.status).toBe(201); return workerSpawnResultSchema.parse(await response.json());
  }
  it('lists only the parent’s workers, including incomplete cleanup and destroyed resources', async () => {
    expect(await (await request('/list')).json()).toEqual({ workers: [] });
    const { workerId } = await spawn();
    const other = f.store.createRun({ title: 'unrelated', task: 'unrelated', workflow: 'quick-task', steps: [] });
    const worker = f.store.getRun(workerId)!;
    if (worker.delegation?.role !== 'worker') throw Error('worker');
    f.store.updateRun(workerId, { delegation: { ...worker.delegation, executionRevision: 3,
      destroy: { phase: 'incomplete', requestedAt: new Date().toISOString(), remaining: ['worktree', 'branch'] } } });
    const response = await request('/list');
    expect(response.status).toBe(200);
    const result = workerListResultSchema.parse(await response.json());
    expect(result.workers).toHaveLength(1);
    expect(result.workers[0]).toMatchObject({ workerId, parentRunId: f.parent.id, status: 'queued', revision: 3,
      settled: false, destroyed: false, workspace: { path: worker.delegation.workspace.path }, destroy: { remaining: ['worktree', 'branch'] } });
    expect(JSON.stringify(result)).not.toContain(other.id);
    // A second root's worker is neither listed nor leaked, even through a stale receipt.
    const foreign = f.store.createRun({ title: 'foreign worker', task: 'foreign', workflow: 'quick-task', steps: [] });
    f.store.updateRun(foreign.id, { delegation: { ...worker.delegation, parentRunId: other.id,
      workspace: { ...worker.delegation.workspace, ownerRunId: foreign.id } } });
    const parent = f.store.getRun(f.parent.id)!;
    if (parent.delegation?.role !== 'root') throw Error('parent');
    f.store.updateRun(parent.id, { delegation: { ...parent.delegation, receipts: [...parent.delegation.receipts,
      { requestId: randomUUID(), workerId: foreign.id, requestHash: 'a'.repeat(64) }] } });
    expect(workerListResultSchema.parse(await (await request('/list')).json()).workers.map((entry: { workerId: string }) => entry.workerId)).toEqual([workerId]);
    const token = f.credentials.issue('project', workerId, randomUUID());
    expect((await request('/list', undefined, { authorization: `Bearer ${token}` })).status).toBe(403);
    const current = f.store.getRun(workerId)!;
    if (current.delegation?.role !== 'worker') throw Error('worker');
    f.store.updateRun(workerId, { delegation: { ...current.delegation,
      destroy: { phase: 'complete', requestedAt: new Date().toISOString(), remaining: [] } } });
    expect(workerListResultSchema.parse(await (await request('/list')).json()).workers[0]).toMatchObject({ workerId, destroyed: true, destroy: { remaining: [] } });
    expect((await request('/list?parentRunId=' + other.id)).status).toBe(400);
  });
  it('reports each execution revision and waits for durable settlement', async () => {
    const first = await spawn();
    const second = await spawn();
    const generation = f.store.commitWorkerExecutionStart(first.workerId);
    f.store.updateRun(first.workerId, { status: 'done' });
    expect(workerListResultSchema.parse(await (await request('/list')).json()).workers[0]).toMatchObject({ workerId: first.workerId, settled: false });
    expect(f.store.commitWorkerExecutionComplete(first.workerId, generation)).toBe(true);
    const result = workerListResultSchema.parse(await (await request('/list')).json());
    expect(result.workers).toHaveLength(2);
    expect(result.workers[0]).toMatchObject({ workerId: first.workerId, status: 'done', settled: true, revision: 0 });
    expect(result.workers[1]).toMatchObject({ workerId: second.workerId, status: 'queued', settled: false, revision: 0 });
    const parent = f.store.getRun(f.parent.id)!;
    if (parent.delegation?.role !== 'root') throw Error('parent');
    f.store.updateRun(parent.id, { delegation: { ...parent.delegation, permissions: ['spawn'] } });
    expect((await request('/list')).status).toBe(403);
  });
  it('pages worker summaries without repeating inspection inputs or outcomes', async () => {
    const { workerId } = await spawn();
    const original = f.store.getRun(workerId)!;
    if (original.delegation?.role !== 'worker') throw Error('worker');
    const parent = f.store.getRun(f.parent.id)!;
    if (parent.delegation?.role !== 'root') throw Error('parent');
    const receipts = [...parent.delegation.receipts];
    for (let i = 0; i < 34; i++) {
      const worker = f.store.createRun({ title: 'worker', task: 'work', workflow: 'quick-task', steps: [] });
      f.store.updateRun(worker.id, { delegation: { ...original.delegation,
        workspace: { ...original.delegation.workspace, ownerRunId: worker.id, resourceId: randomUUID() } } });
      receipts.push({ requestId: randomUUID(), workerId: worker.id, requestHash: 'a'.repeat(64) });
    }
    f.store.updateRun(parent.id, { delegation: { ...parent.delegation, receipts } });
    const first = await (await request('/list')).json() as { workers: unknown[]; nextOffset?: number };
    expect(first.workers).toHaveLength(32);
    expect(first.nextOffset).toBe(32);
    const second = await (await request('/list?offset=32')).json() as { workers: { workerId: string }[]; nextOffset?: number };
    expect(second.workers.map(worker => worker.workerId)).toEqual(receipts.slice(32).map(receipt => receipt.workerId));
    expect(second.nextOffset).toBeUndefined();
    expect((await request('/list?offset=-1')).status).toBe(400);
    expect((await request('/list?offset=1025')).status).toBe(400);
    expect((await request(`/${workerId}?offset=1`)).status).toBe(400);
    const inspection = await f.service.inspect(f.caller, { workerId });
    vi.spyOn(f.service, 'inspect').mockResolvedValue({ ...inspection, inputs: [],
      outcome: { workerId, status: 'done', observedAt: new Date().toISOString(), summary: 'x'.repeat(4_000) } });
    const result = await (await request('/list')).json() as { workers: Record<string, unknown>[] };
    expect(result.workers[0]).not.toHaveProperty('inputs');
    expect(result.workers[0]).not.toHaveProperty('outcome');
  });
  it('accepts a catalog workflow on spawn and rejects a malformed one before the service (#451)', async () => {
    const dir = join(f.root, '.ai/cezar/workflows'); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'review.yaml'), 'name: review\nsteps:\n  - id: inspect\n    prompt: "{{task}}"\n  - id: verify\n    command: \"true\"\n');
    const created = await request('/spawn', { task: 'work', baseline: 'parent-head', requestId: randomUUID(), workflow: 'review' });
    expect(created.status).toBe(201);
    const { workerId } = workerSpawnResultSchema.parse(await created.json());
    expect(f.store.getRun(workerId)).toMatchObject({ workflow: 'review', steps: [{ kind: 'agent' }, { kind: 'check' }] });
    expect((await request('/spawn', { task: 'work', baseline: 'parent-head', requestId: randomUUID(), workflow: '' })).status).toBe(400);
    const unknown = await request('/spawn', { task: 'work', baseline: 'parent-head', requestId: randomUUID(), workflow: 'absent' });
    expect(unknown.status).toBe(400);
    expect(delegationErrorResponseSchema.parse(await unknown.json())).toMatchObject({ code: 'invalid_input', error: expect.stringContaining('absent') });
  });
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
    expect(conversationInspectResultSchema.parse(await inspected.json()).messages).toHaveLength(3);
    const cancelled = await request('/cancel-request', { requestId: input.id });
    expect(requestOutcomeSchema.parse(await cancelled.json()).status).toBe('replied');
  });
  it('validates inbox bodies and scopes receipts to the authenticated session', async () => {
    const { workerId } = await spawn(); f.store.updateRun(workerId, { status: 'running' });
    const workerToken = f.credentials.issue('project', workerId, randomUUID());
    const sent = await request('/send', { id: randomUUID(), recipientRunId: workerId, kind: 'progress', text: 'Read me' });
    expect(sent.status).toBe(200);
    for (const body of [{ recipientRunId: workerId }, { receiptId: randomUUID() }, { projectId: 'project' }]) expect((await request('/inbox', body)).status).toBe(400);
    const reserve = await request('/inbox', {}, { authorization: `Bearer ${workerToken}` });
    expect(reserve.status).toBe(200);
    const batch = inboxReserveResultSchema.parse(await reserve.json());
    expect(batch.messages).toMatchObject([{ senderRunId: f.parent.id, recipientRunId: workerId, text: 'Read me' }]);
    expect((await request('/inbox/ack', { receiptId: batch.receiptId!, runId: workerId }, { authorization: `Bearer ${workerToken}` })).status).toBe(400);
    expect((await request('/inbox/ack', { receiptId: 'bad' }, { authorization: `Bearer ${workerToken}` })).status).toBe(400);
    expect((await request('/inbox/ack', { receiptId: batch.receiptId! })).status).toBe(403);
    const staleToken = workerToken;
    const currentToken = f.credentials.issue('project', workerId, randomUUID());
    expect((await request('/inbox/ack', { receiptId: batch.receiptId! }, { authorization: `Bearer ${staleToken}` })).status).toBe(401);
    expect((await request('/inbox/ack', { receiptId: batch.receiptId! }, { authorization: `Bearer ${currentToken}` })).status).toBe(403);
  });
  it('ACKs and releases only the supplied live receipt', async () => {
    const { workerId } = await spawn(); f.store.updateRun(workerId, { status: 'running' });
    const token = f.credentials.issue('project', workerId, randomUUID());
    await request('/send', { id: randomUUID(), recipientRunId: workerId, kind: 'progress', text: 'First' });
    const first = inboxReserveResultSchema.parse(await (await request('/inbox', {}, { authorization: `Bearer ${token}` })).json());
    expect(inboxReceiptResultSchema.parse(await (await request('/inbox/release', { receiptId: first.receiptId }, { authorization: `Bearer ${token}` })).json()).status).toBe('released');
    const second = inboxReserveResultSchema.parse(await (await request('/inbox', {}, { authorization: `Bearer ${token}` })).json());
    expect(second.messages.map(message => message.id)).toEqual(first.messages.map(message => message.id));
    expect(inboxReceiptResultSchema.parse(await (await request('/inbox/ack', { receiptId: second.receiptId }, { authorization: `Bearer ${token}` })).json()).status).toBe('acknowledged');
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
    // A restart: the old manager and store go, or the store would still own the family it reloads.
    f.manager.dispose(); f.store.close();
    seedRuns(join(f.root, '.ai/cezar'), records);
    const reopened = RunStore.open(join(f.root, '.ai/cezar'), { keepLive: true }); const manager = createFixtureManager(reopened, f.root);
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
