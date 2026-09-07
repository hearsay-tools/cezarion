import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunStore } from '../runs/store.ts';
import type { Caller } from './credentials.ts';

import { fixture } from './service.testkit.ts';

describe('delegation service durable authority', () => {
  let f: ReturnType<typeof fixture>;
  beforeEach(() => { vi.stubEnv('CEZ_DELEGATION', '1'); f = fixture(); });
  afterEach(() => { f?.close(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
  const input = () => ({ task: 'do work', baseline: 'parent-head', requestId: randomUUID() });
  it('accepts one durable owned creation, no resource before admission, replay survives moving HEAD and restart', async () => {
    const request = input();
    const [a, b] = await Promise.all([f.service.spawn(f.caller, request), f.service.spawn(f.caller, request)]);
    expect(a).toEqual(b); expect(a.baselineSha).toBe(f.sha);
    const worker = f.store.getRun(a.workerId)!;
    expect(worker).toMatchObject({ status: 'queued', runner: 'claude', model: 'opus', effort: 'high', delegation: { role: 'worker', permissions: [], parentRunId: f.parent.id } });
    if (worker.delegation?.role !== 'worker') throw Error('worker');
    expect(existsSync(worker.delegation.workspace.path)).toBe(false);
    const proof = f.store.readWorkerExecution(worker.id);
    execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@local', 'commit', '--allow-empty', '-qm', 'moved'], { cwd: f.root });
    expect(await f.service.spawn(f.caller, request)).toEqual(a);
    expect(f.store.readWorkerExecution(worker.id)).toEqual(proof);
    const reopened = RunStore.open(join(f.root, '.ai/cezar'), { keepLive: true });
    expect(reopened.getRun(f.parent.id)?.delegation).toMatchObject({ receipts: [{ workerId: a.workerId }] });
    expect(reopened.getRun(a.workerId)?.delegation).toEqual(worker.delegation); reopened.flush();
    await expect(f.service.spawn(f.caller, { ...request, task: 'different' })).rejects.toMatchObject({ code: 'invalid_input' });
  });
  it('publishes concrete private identity before worker events/enqueue and never rewrites it on replay', async () => {
    const request = input(); let publishedIdentity: unknown;
    f.store.on('run', run => { if (run.delegation?.role === 'worker') publishedIdentity = f.store.readWorkerIdentity(run.id); });
    const worker = await f.service.spawn(f.caller, request);
    expect(publishedIdentity).toEqual({ kind: 'accepted', account: { provider: 'claude', profileId: 'default', homePath: f.root, claudeLayout: { kind: 'relocated' } }, model: 'opus', effort: 'high' });
    const path = join(f.root, '.ai/cezar/runs', `${worker.workerId}.identity.json`);
    const before = readFileSync(path, 'utf8');
    vi.mocked(f.manager.delegationExecutionSettings).mockReturnValue({ cwd: f.root, runner: 'claude', agentProfile: 'other', accountBinding: { provider: 'claude', profileId: 'other', homePath: '/different', claudeLayout: { kind: 'relocated' } } });
    expect(await f.service.spawn(f.caller, request)).toEqual(worker); expect(readFileSync(path, 'utf8')).toBe(before);
    expect(JSON.stringify(f.store.listRuns()) + JSON.stringify(f.store.readEvents(worker.workerId))).not.toContain('homePath');
  });
  it('cannot accept a worker without a concrete account binding', async () => {
    vi.mocked(f.manager.delegationExecutionSettings).mockReturnValue({ cwd: f.root, runner: 'claude', agentProfile: 'default' });
    await expect(f.service.spawn(f.caller, input())).rejects.toThrow();
    expect(f.store.listRuns()).toHaveLength(1); expect(f.parent.delegation).toMatchObject({ receipts: [] });
  });
  it('publishes neither receipt nor worker when private identity cannot be written', async () => {
    f.store.flush();
    const writer = f.store as unknown as { writeWorkerIdentity(id: string, identity: unknown): void };
    const write = writer.writeWorkerIdentity.bind(f.store);
    vi.spyOn(writer, 'writeWorkerIdentity').mockImplementation((id, identity) => {
      mkdirSync(join(f.root, '.ai/cezar/runs', `${id}.identity.json`), { recursive: true });
      write(id, identity);
    });
    await expect(f.service.spawn(f.caller, input())).rejects.toThrow();
    expect(f.store.listRuns()).toHaveLength(1); expect(f.parent.delegation).toMatchObject({ receipts: [] });
    const reopened = RunStore.open(join(f.root, '.ai/cezar'), { keepLive: true });
    expect(reopened.listRuns()).toHaveLength(1); expect(reopened.getRun(f.parent.id)?.delegation).toMatchObject({ receipts: [] }); reopened.flush();
  });
  it('authorizes before replay and rejects copied caller, wrong project, and worker credentials', async () => {
    const request = input(); const worker = await f.service.spawn(f.caller, request);
    for (const caller of [{ ...f.caller } as Caller, f.credentials.authenticate(f.credentials.issue('elsewhere', f.parent.id, 'new'))!, f.credentials.authenticate(f.credentials.issue('project', worker.workerId, 'new'))!]) {
      await expect(f.service.spawn(caller, request)).rejects.toMatchObject({ code: 'denied_scope' });
    }
  });
  it('blocks spawn/steer/wait during parent Finish, keeping inspect/stop/cleanup usable', async () => {
    const request = input(); const { workerId } = await f.service.spawn(f.caller, request);
    const parent = f.store.getRun(f.parent.id)!;
    if (parent.delegation?.role !== 'root') throw Error('parent');
    f.store.commitDelegation([{ id: parent.id, delegation: { ...parent.delegation, finishRequestedAt: new Date().toISOString() } }]);
    await expect(f.service.spawn(f.caller, request)).rejects.toMatchObject({ code: 'incompatible_state' });
    await expect(f.service.steer(f.caller, { workerId }, { text: 'hello' })).rejects.toMatchObject({ code: 'incompatible_state' });
    await expect(f.service.wait(f.caller, { workerIds: [workerId], timeoutSeconds: 600 })).rejects.toMatchObject({ code: 'incompatible_state' });
    expect(await f.service.inspect(f.caller, { workerId })).toMatchObject({ workerId });
    expect(await f.service.stop(f.caller, { workerId })).toEqual({ workerId, state: 'terminated' });
    expect(await f.service.destroy(f.caller, { workerId })).toEqual({ workerId, state: 'complete', remaining: [] });
  });
  it('serializes cleanup, preserves tombstone/history, and permits human retry with delegation off', async () => {
    const { workerId } = await f.service.spawn(f.caller, input());
    f.store.appendEvent(workerId, { type: 'note', message: 'history retained' });
    const result = await Promise.all([f.service.destroy(f.caller, { workerId }), f.service.destroy(f.caller, { workerId })]);
    expect(result).toEqual([{ workerId, state: 'complete', remaining: [] }, { workerId, state: 'complete', remaining: [] }]);
    expect(f.store.getRun(workerId)?.delegation).toMatchObject({ destroy: { phase: 'complete', remaining: [] } });
    expect(f.store.readEvents(workerId).some(e => e.message === 'history retained')).toBe(true);
    vi.stubEnv('CEZ_DELEGATION', '0');
    await expect(f.service.inspect(f.caller, { workerId })).rejects.toMatchObject({ code: 'unavailable_transport' });
    expect(await f.service.destroyForHuman('project', workerId)).toEqual({ workerId, state: 'complete', remaining: [] });
  });
  it('does not clean unknown termination; durably records exact remaining resources', async () => {
    const { workerId } = await f.service.spawn(f.caller, input());
    f.store.commitWorkerExecutionStart(workerId); // restart provenance: process result not known
    vi.spyOn(f.manager, 'awaitRunTermination').mockResolvedValue(false);
    expect(await f.service.destroy(f.caller, { workerId })).toMatchObject({ state: 'incomplete', remaining: ['process', 'worktree', 'branch'] });
    expect(f.store.getRun(workerId)?.delegation).toMatchObject({ destroy: { phase: 'incomplete', remaining: ['process', 'worktree', 'branch'] } });
  });
  it('retains already-cleaned resources across an incomplete termination retry', async () => {
    const { workerId } = await f.service.spawn(f.caller, input());
    const worker = f.store.getRun(workerId)!;
    if (worker.delegation?.role !== 'worker') throw Error('worker');
    f.store.commitDelegation([{ id: workerId, delegation: { ...worker.delegation, destroy: { requestedAt: new Date().toISOString(), phase: 'incomplete', remaining: ['branch'] } } }]);
    vi.spyOn(f.manager, 'awaitRunTermination').mockResolvedValue(false);
    expect(await f.service.destroy(f.caller, { workerId })).toMatchObject({ state: 'incomplete', remaining: ['process', 'branch'] });
  });
  it('replays a spawn-only authority without requiring an unrelated inspect grant', async () => {
    const request = input(); const result = await f.service.spawn(f.caller, request);
    const parent = f.store.getRun(f.parent.id)!;
    if (parent.delegation?.role !== 'root') throw Error('parent');
    f.store.commitDelegation([{ id: parent.id, delegation: { ...parent.delegation, permissions: ['spawn'] } }]);
    expect(await f.service.spawn(f.caller, request)).toEqual(result);
  });
  it('caps accepted creations at 32 including destroyed workers; replay does not consume a creation', async () => {
    const first = input(); const result = await f.service.spawn(f.caller, first);
    await f.service.destroy(f.caller, { workerId: result.workerId });
    for (let n = 1; n < 32; n++) await f.service.spawn(f.caller, input());
    expect(await f.service.spawn(f.caller, first)).toEqual(result);
    await expect(f.service.spawn(f.caller, input())).rejects.toMatchObject({ code: 'capacity_limit' });
    expect(f.store.listRuns()).toHaveLength(33);
  });
  it('queues attributed steering and denies the 33rd undelivered message', async () => {
    const { workerId } = await f.service.spawn(f.caller, input());
    for (let n = 0; n < 32; n++) expect(await f.service.steer(f.caller, { workerId }, { text: `/skill note ${n}` })).toEqual({ workerId, state: 'queued' });
    await expect(f.service.steer(f.caller, { workerId }, { text: 'excess' })).rejects.toMatchObject({ code: 'capacity_limit' });
    expect(f.store.getRun(workerId)?.agentInputs?.[0]).toMatchObject({ source: 'agent', parentRunId: f.parent.id, text: '/skill note 0' });
  });
  it('rejects generated credentials in agent task/steering text before persistence or delivery', async () => {
    f.store.registerSessionSecret(f.token);
    await expect(f.service.spawn(f.caller, { ...input(), task: `use ${f.token}` })).rejects.toMatchObject({ code: 'invalid_input' });
    expect(f.store.listRuns()).toHaveLength(1);
    const { workerId } = await f.service.spawn(f.caller, input());
    await expect(f.service.steer(f.caller, { workerId }, { text: `use ${f.token}` })).rejects.toMatchObject({ code: 'invalid_input' });
    expect(JSON.stringify(f.store.listRuns()) + JSON.stringify(f.store.readEvents(workerId))).not.toContain(f.token);
    expect(f.store.getRun(workerId)?.agentInputs ?? []).toEqual([]);
  });
  it('does not reveal absent or unrelated workers for any targeted operation', async () => {
    const unrelated = f.store.createRun({ title: 'other', task: 'other', workflow: 'quick-task', steps: [] });
    for (const workerId of [randomUUID(), unrelated.id]) {
      for (const op of ['inspect', 'stop', 'destroy', 'diff'] as const) await expect(f.service[op](f.caller, { workerId })).rejects.toMatchObject({ code: 'denied_scope', message: 'Worker scope denied' });
      await expect(f.service.steer(f.caller, { workerId }, { text: 'hello' })).rejects.toMatchObject({ code: 'denied_scope' });
      await expect(f.service.wait(f.caller, { workerIds: [workerId], timeoutSeconds: 600 })).rejects.toMatchObject({ code: 'denied_scope' });
    }
  });
});
