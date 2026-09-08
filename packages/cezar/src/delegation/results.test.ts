import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { fixture } from './service.testkit.ts';
import { ensureOwnedWorkspace } from './workspace.ts';
import { RunStore } from '../runs/store.ts';

describe('parent-owned collected worker results', () => {
  let f: ReturnType<typeof fixture>;
  beforeEach(() => { vi.stubEnv('CEZ_DELEGATION', '1'); f = fixture(); });
  afterEach(() => { f?.close(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
  async function worker() {
    const { workerId } = await f.service.spawn(f.caller, { task: 'work', baseline: 'HEAD', requestId: randomUUID() });
    return f.store.getRun(workerId)!;
  }
  it('collects assistant evidence, bounded Git snapshots and durable parent pointers with redaction', async () => {
    const run = await worker(); await ensureOwnedWorkspace(f.root, run);
    const path = run.delegation?.role === 'worker' ? run.delegation.workspace.path : '';
    f.store.registerSessionSecret(f.token);
    writeFileSync(join(path, 'result.txt'), `result ${f.token}`);
    execFileSync('git', ['add', '.'], { cwd: path });
    execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@local', 'commit', '-qm', 'worker'], { cwd: path });
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: path, encoding: 'utf8' }).trim();
    const event = f.store.appendEvent(run.id, { type: 'text', text: 'Implemented. ' + 'x'.repeat(4100) });
    f.store.updateRun(run.id, { status: 'review' });
    const generation = f.store.commitWorkerExecutionStart(run.id); f.store.commitWorkerExecutionComplete(run.id, generation);
    const result = await f.service.collect(f.caller, { workerId: run.id });
    expect(result).toMatchObject({ workerId: run.id, revision: 0, baselineSha: f.sha, outcome: 'review-ready', partial: false,
      summary: { state: 'available', source: 'assistant', seq: event.seq, truncated: true }, head: { state: 'available', sha: head }, diff: { state: 'available', path: expect.any(String) } });
    expect(result.summary.state === 'available' && result.summary.text.length).toBe(4000);
    expect(JSON.stringify(result)).not.toContain(f.token);
    const reopened = RunStore.open(join(f.root, '.ai/cezar'), { keepLive: true });
    expect(reopened.readWorkerResult(f.parent.id, run.id)).toEqual(result);
    expect(reopened.readWorkerResultDiff(f.parent.id, run.id)).toContain('[REDACTED]');
    expect(readFileSync(join(f.root, '.ai/cezar/runs.json'), 'utf8')).not.toContain('diff --git');
    reopened.flush();
  });
  it('never turns tool output into a summary and marks failures and running evidence partial', async () => {
    const run = await worker(); f.store.appendEvent(run.id, { type: 'tool-result', result: 'Success!' });
    let result = await f.service.collect(f.caller, { workerId: run.id });
    expect(result).toMatchObject({ outcome: 'running', status: 'queued', partial: true, summary: { state: 'unavailable', reason: 'no-assistant-output' } });
    f.store.updateRun(run.id, { status: 'failed', error: 'provider interrupted' });
    f.store.appendEvent(run.id, { type: 'item.completed', item: { kind: 'message', role: 'assistant', text: 'Partial analysis' } });
    result = await f.service.collect(f.caller, { workerId: run.id });
    expect(result).toMatchObject({ outcome: 'failed', partial: true, error: 'provider interrupted', summary: { state: 'available', text: 'Partial analysis' } });
  });
  it('rejects collection that races a new accepted execution revision', async () => {
    const run = await worker();
    const collecting = f.service.collect(f.caller, { workerId: run.id });
    f.store.commitWorkerContinuation(run.id, { status: 'queued' });
    await expect(collecting).rejects.toMatchObject({ code: 'incompatible_state' });
    expect(f.store.readWorkerResult(f.parent.id, run.id)).toBeUndefined();
  });
  it('retains historical evidence but does not reuse a previous execution assistant summary', async () => {
    const run = await worker(); f.store.appendEvent(run.id, { type: 'text', text: 'Old summary' }); f.store.updateRun(run.id, { status: 'review' });
    const old = await f.service.collect(f.caller, { workerId: run.id });
    f.store.commitWorkerContinuation(run.id, { status: 'queued' });
    expect(f.store.readWorkerResult(f.parent.id, run.id)).toEqual(old);
    const result = await f.service.collect(f.caller, { workerId: run.id });
    expect(result).toMatchObject({ revision: 1, partial: true, summary: { state: 'unavailable' } });
    expect(() => f.store.commitWorkerResult(f.parent.id, old)).toThrow();
  });
  it('bounds artifact descriptors and reports missing bytes honestly', async () => {
    const run = await worker();
    const dir = join(f.root, '.ai/cezar/runs', `${run.id}-images`); mkdirSync(dir, { recursive: true });
    for (let i = 0; i < 34; i++) { writeFileSync(join(dir, `${i}.png`), 'image'); f.store.appendEvent(run.id, { type: 'image', url: `/api/v1/runs/${run.id}/images/${i}.png` }); }
    rmSync(join(dir, '0.png'));
    const result = await f.service.collect(f.caller, { workerId: run.id });
    expect(result.artifacts).toMatchObject({ state: 'available', truncated: true });
    if (result.artifacts.state !== 'available') throw Error('missing descriptors');
    expect(result.artifacts.items).toHaveLength(32);
    expect(result.artifacts.items[0]).toMatchObject({ state: 'deleted', reason: 'missing', id: '0.png' });
  });
  it('does not publish or replace retained evidence when the parent index checkpoint fails', async () => {
    const run = await worker(); f.store.appendEvent(run.id, { type: 'text', text: 'First evidence' });
    const first = await f.service.collect(f.caller, { workerId: run.id });
    f.store.appendEvent(run.id, { type: 'text', text: 'Second evidence' });
    const published = vi.fn(); f.store.on('run', published);
    const fault = vi.spyOn(f.store as unknown as { writeIndex(): void }, 'writeIndex').mockImplementation(() => { throw Error('disk failure'); });
    await expect(f.service.collect(f.caller, { workerId: run.id })).rejects.toThrow('disk failure');
    expect(published).not.toHaveBeenCalled();
    expect(f.store.readWorkerResult(f.parent.id, run.id)).toEqual(first); fault.mockRestore();
  });
  it('reads retained parent evidence after child history deletion but denies a missing ownership receipt', async () => {
    const run = await worker(); f.store.appendEvent(run.id, { type: 'text', text: 'Retained summary' });
    const images = join(f.root, '.ai/cezar/runs', `${run.id}-images`); mkdirSync(images); writeFileSync(join(images, 'result.png'), 'bytes');
    f.store.appendEvent(run.id, { type: 'image', url: `/api/v1/runs/${run.id}/images/result.png` });
    await f.service.destroy(f.caller, { workerId: run.id });
    const result = await f.service.collect(f.caller, { workerId: run.id });
    rmSync(images, { recursive: true });
    const index = join(f.root, '.ai/cezar/runs.json');
    writeFileSync(index, JSON.stringify(f.store.listRuns().filter(record => record.id !== run.id)));
    const reopened = RunStore.open(join(f.root, '.ai/cezar'), { keepLive: true });
    f.service.registerProject({ id: 'project', root: f.root, store: reopened, manager: f.manager });
    expect(await f.service.collect(f.caller, { workerId: run.id })).toMatchObject({ summary: result.summary, outcome: 'destroyed', artifacts: { state: 'available', items: [{ state: 'deleted', id: 'result.png' }] } });
    const parent = reopened.getRun(f.parent.id)!;
    if (parent.delegation?.role !== 'root') throw Error('fixture');
    reopened.commitDelegation([{ id: parent.id, delegation: { ...parent.delegation, receipts: [] } }]);
    await expect(f.service.collect(f.caller, { workerId: run.id })).rejects.toMatchObject({ code: 'denied_scope' });
    reopened.flush();
  });
  it('a stopped public status is partial and unsettled until private termination is proven', async () => {
    const run = await worker(); const generation = f.store.commitWorkerExecutionStart(run.id);
    f.store.updateRun(run.id, { status: 'cancelled', error: 'interrupted' });
    expect(await f.service.collect(f.caller, { workerId: run.id })).toMatchObject({ settled: false, partial: true, summary: { state: 'unavailable' } });
    f.store.commitWorkerExecutionComplete(run.id, generation);
    expect(await f.service.collect(f.caller, { workerId: run.id })).toMatchObject({ settled: true, partial: true });
  });
  it('does not reuse a snapshot ID to overwrite durable evidence before an index checkpoint', async () => {
    const run = await worker(); await ensureOwnedWorkspace(f.root, run);
    const first = await f.service.collect(f.caller, { workerId: run.id });
    expect(first.diff.state).toBe('available');
    const original = f.store.readWorkerResultDiff(f.parent.id, run.id);
    const fault = vi.spyOn(f.store as unknown as { writeIndex(): void }, 'writeIndex').mockImplementation(() => { throw Error('disk failure'); });
    expect(() => f.store.commitWorkerResult(f.parent.id, first, 'replacement')).toThrow();
    expect(f.store.readWorkerResultDiff(f.parent.id, run.id)).toBe(original); fault.mockRestore();
  });

});
