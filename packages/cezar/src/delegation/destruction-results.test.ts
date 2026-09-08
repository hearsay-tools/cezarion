import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fixture } from './service.testkit.ts';
import { ensureOwnedWorkspace } from './workspace.ts';
import { RunStore } from '../runs/store.ts';

vi.mock('node:fs', async original => { const fs = await original<typeof import('node:fs')>(); return { ...fs, rmSync: vi.fn(fs.rmSync) }; });

describe('verified destruction retains results through explicit history deletion', () => {
  let f: ReturnType<typeof fixture>;
  beforeEach(() => { vi.stubEnv('CEZ_DELEGATION', '1'); f = fixture(); });
  afterEach(() => { vi.restoreAllMocks(); f.close(); vi.unstubAllEnvs(); });
  async function completed() {
    const { workerId } = await f.service.spawn(f.caller, { task: 'work', baseline: 'HEAD', requestId: randomUUID() });
    const run = f.store.getRun(workerId)!;
    f.manager.requestWorkerStop(workerId); // remove held scheduler admission before simulating a completed execution
    const generation = f.store.commitWorkerExecutionStart(workerId);
    const workspace = await ensureOwnedWorkspace(f.root, run);
    writeFileSync(join(workspace.path, 'result.txt'), 'retained patch');
    f.store.appendEvent(workerId, { type: 'text', text: 'Completed implementation' });
    f.store.updateRun(workerId, { status: 'review', worktreePath: workspace.path, branch: workspace.branch });
    expect(f.store.commitWorkerExecutionComplete(workerId, generation)).toBe(true);
    const files = join(f.root, '.ai/cezar/runs');
    mkdirSync(join(files, `${workerId}-images`));
    writeFileSync(join(files, `${workerId}-images/worker-context-0.input`), 'copied input');
    writeFileSync(join(files, `${workerId}.handoff.md`), 'handoff');
    f.store.appendEvent(workerId, { type: 'image', url: `/api/v1/runs/${workerId}/images/worker-context-0.input` });
    return { workerId, workspace, generation, files };
  }
  it('leaves worktree and branch intact when the parent result checkpoint fails', async () => {
    const { workerId, workspace } = await completed();
    vi.spyOn(f.store, 'commitWorkerResult').mockImplementation(() => { throw Error('snapshot disk failure'); });
    await expect(f.service.destroy(f.caller, { workerId })).rejects.toThrow('snapshot disk failure');
    expect(readFileSync(join(workspace.path, 'result.txt'), 'utf8')).toBe('retained patch');
    expect(execFileSync('git', ['rev-parse', `refs/heads/${workspace.branch}`], { cwd: f.root, encoding: 'utf8' }).trim()).toBe(f.sha);
  });
  it('preserves a settled summary and diff after destruction, child deletion and restart', async () => {
    const { workerId, workspace, generation, files } = await completed();
    expect(await f.service.destroy(f.caller, { workerId })).toMatchObject({ state: 'complete', deleted: [
      { kind: 'worktree', path: workspace.path }, { kind: 'branch', ref: `refs/heads/${workspace.branch}` },
    ] });
    expect(f.store.readWorkerExecution(workerId)).toMatchObject({ phase: 'complete', generation });
    expect(f.store.readWorkerResult(f.parent.id, workerId)).toMatchObject({ status: 'review', settled: true, partial: false,
      outcome: 'destroyed', lastExecutionOutcome: 'review-ready', cleanup: 'complete', workspace: { state: 'deleted' },
      summary: { state: 'available', text: 'Completed implementation' }, diff: { state: 'available' }, head: { state: 'deleted', sha: f.sha } });
    expect(existsSync(join(files, `${workerId}-images/worker-context-0.input`))).toBe(true);
    expect(f.store.canDeleteRun(f.parent.id)).toBe(false);
    expect(f.store.deleteRun(workerId)).toBe(true);
    for (const name of [`${workerId}.ndjson`, `${workerId}.handoff.md`, `${workerId}-images`]) expect(existsSync(join(files, name))).toBe(false);
    const reopened = RunStore.open(join(f.root, '.ai/cezar'), { keepLive: true });
    f.service.registerProject({ id: 'project', root: f.root, store: reopened, manager: f.manager });
    const result = await f.service.collect(f.caller, { workerId });
    expect(result).toMatchObject({ settled: true, summary: { text: 'Completed implementation' }, workspace: { state: 'deleted' },
      artifacts: { state: 'available', items: [{ state: 'deleted', id: 'worker-context-0.input' }] } });
    expect(reopened.readWorkerResultDiff(f.parent.id, workerId)).toContain('+retained patch');
    expect(reopened.deleteRun(f.parent.id)).toBe(true);
    expect(existsSync(join(files, `${f.parent.id}-worker-results`))).toBe(false);
    reopened.flush();
  });
  it('refuses child deletion without valid parent result bytes and current termination evidence', async () => {
    const { workerId, files } = await completed();
    await f.service.destroy(f.caller, { workerId });
    const path = join(files, `${workerId}.execution.json`); const proof = readFileSync(path, 'utf8');
    writeFileSync(path, JSON.stringify({ generation: randomUUID(), phase: 'starting' }));
    expect(f.store.deleteRun(workerId)).toBe(false); writeFileSync(path, proof);
    const result = f.store.readWorkerResult(f.parent.id, workerId)!;
    expect(result).toBeDefined();
    if (result.diff.state !== 'available') throw Error('missing diff');
    writeFileSync(result.diff.path, '{}');
    expect(f.store.deleteRun(workerId)).toBe(false);
    expect(existsSync(join(files, `${workerId}.ndjson`))).toBe(true);
  });
  it('checkpoints deletion before bytes and retries failed removal after reopening', async () => {
    const { workerId, files } = await completed(); await f.service.destroy(f.caller, { workerId });
    const real = vi.mocked(rmSync).getMockImplementation()!;
    vi.mocked(rmSync).mockImplementation((path, options) => {
      if (path === join(files, `${workerId}-images`)) {
        const disk = JSON.parse(readFileSync(join(f.root, '.ai/cezar/runs.json'), 'utf8'));
        expect(disk.find((r: { id: string }) => r.id === f.parent.id).delegation.receipts[0].deletion.phase).toBe('pending');
        throw Error('directory busy');
      }
      return real(path, options);
    });
    expect(f.store.deleteRun(workerId)).toBe(false);
    expect(f.store.getRun(workerId)).toBeDefined();
    expect(existsSync(join(files, `${workerId}-images/worker-context-0.input`))).toBe(true);
    vi.mocked(rmSync).mockImplementation(real);
    const reopened = RunStore.open(join(f.root, '.ai/cezar'), { keepLive: true });
    expect(reopened.deleteRun(workerId)).toBe(true);
    expect(existsSync(join(files, `${workerId}-images`))).toBe(false);
    expect(reopened.canDeleteRun(f.parent.id)).toBe(true); reopened.flush();
  });
  it('does not remove child history on a failed deletion metadata checkpoint', async () => {
    const { workerId, files } = await completed(); await f.service.destroy(f.caller, { workerId });
    const fault = vi.spyOn(f.store as unknown as { writeIndex(): void }, 'writeIndex').mockImplementation(() => { throw Error('index disk failure'); });
    expect(f.store.deleteRun(workerId)).toBe(false);
    expect(existsSync(join(files, `${workerId}.ndjson`))).toBe(true);
    expect(existsSync(join(files, `${workerId}-images/worker-context-0.input`))).toBe(true);
    fault.mockRestore();
  });
  it('retains the pre-removal snapshot when cleanup result publication fails and retries without losing its diff', async () => {
    const { workerId } = await completed();
    const original = f.store.commitWorkerResult.bind(f.store); let calls = 0;
    const fault = vi.spyOn(f.store, 'commitWorkerResult').mockImplementation((...args) => {
      if (++calls === 2) throw Error('final result checkpoint failed');
      return original(...args);
    });
    await expect(f.service.destroy(f.caller, { workerId })).rejects.toThrow('final result checkpoint failed');
    expect(f.store.canDeleteRun(workerId)).toBe(false);
    expect(f.store.readWorkerResultDiff(f.parent.id, workerId)).toContain('+retained patch');
    fault.mockRestore();
    expect(await f.service.destroy(f.caller, { workerId })).toMatchObject({ state: 'complete' });
    expect(f.store.readWorkerResultDiff(f.parent.id, workerId)).toContain('+retained patch');
  });
  it('collection and destroy cannot erase evidence during an interrupted child deletion', async () => {
    const { workerId, files } = await completed(); await f.service.destroy(f.caller, { workerId });
    const original = (f.store as unknown as { writeIndex(runs: unknown[]): void }).writeIndex.bind(f.store);
    const fault = vi.spyOn(f.store as unknown as { writeIndex(runs: Array<{ id: string }>): void }, 'writeIndex').mockImplementation(runs => {
      if (!runs.some(run => run.id === workerId)) throw Error('final deletion checkpoint failed');
      return original(runs);
    });
    expect(f.store.deleteRun(workerId)).toBe(false);
    expect(existsSync(join(files, `${workerId}.execution.json`))).toBe(false);
    expect(await f.service.collect(f.caller, { workerId })).toMatchObject({ summary: { state: 'available', text: 'Completed implementation' }, diff: { state: 'available' }, settled: true });
    await expect(f.service.destroy(f.caller, { workerId })).rejects.toMatchObject({ code: 'incompatible_state' });
    fault.mockRestore();
    expect(f.store.deleteRun(workerId)).toBe(true);
  });
  it('retries interrupted parent deletion after its snapshot directory was removed', async () => {
    const { workerId, files } = await completed(); await f.service.destroy(f.caller, { workerId }); expect(f.store.deleteRun(workerId)).toBe(true);
    const original = (f.store as unknown as { writeIndex(runs: unknown[]): void }).writeIndex.bind(f.store);
    const fault = vi.spyOn(f.store as unknown as { writeIndex(runs: Array<{ id: string }>): void }, 'writeIndex').mockImplementation(runs => {
      if (!runs.some(run => run.id === f.parent.id)) throw Error('final parent checkpoint failed');
      return original(runs);
    });
    expect(f.store.deleteRun(f.parent.id)).toBe(false);
    expect(existsSync(join(files, `${f.parent.id}-worker-results`))).toBe(false);
    fault.mockRestore();
    const reopened = RunStore.open(join(f.root, '.ai/cezar'), { keepLive: true });
    expect(reopened.deleteRun(f.parent.id)).toBe(true); reopened.flush();
  });
  it.each(['missing', 'malformed'] as const)('does not let a %s parent authorize deletion of cleaned child history', async kind => {
    const { workerId, files } = await completed(); await f.service.destroy(f.caller, { workerId });
    const records = f.store.listRuns();
    const parent = records.find(run => run.id === f.parent.id)!;
    writeFileSync(join(f.root, '.ai/cezar/runs.json'), JSON.stringify(kind === 'missing' ? records.filter(run => run.id !== parent.id)
      : records.map(run => run.id === parent.id ? { ...run, delegation: { invalid: true } } : run)));
    const reopened = RunStore.open(join(f.root, '.ai/cezar'), { keepLive: true });
    expect(reopened.deleteRun(workerId)).toBe(false);
    expect(existsSync(join(files, `${workerId}.ndjson`))).toBe(true); reopened.flush();
  });
  it('keeps worker history and parent snapshots through ordinary run retention eviction', async () => {
    const { workerId } = await completed(); await f.service.destroy(f.caller, { workerId });
    f.store.updateRun(workerId, { createdAt: '2000-01-01T00:00:00.000Z' });
    f.store.updateRun(f.parent.id, { createdAt: '2000-01-01T00:00:00.000Z' });
    const ordinary = f.store.createRun({ task: 'old', title: 'old', workflow: 'quick-task', steps: [] });
    f.store.updateRun(ordinary.id, { createdAt: '2000-01-01T00:00:00.000Z' });
    for (let i = 0; i < 302; i++) f.store.createRun({ task: 'new', title: 'new', workflow: 'quick-task', steps: [] });
    expect(f.store.getRun(ordinary.id)).toBeUndefined();
    expect(f.store.getRun(workerId)).toBeDefined();
    expect(f.store.getRun(f.parent.id)).toBeDefined();
    expect(f.store.readWorkerResultDiff(f.parent.id, workerId)).toContain('+retained patch');
  });

  it('reports branch-only cleanup failure while keeping the removed workspace and retained diff explicit on recollection', async () => {
    const { workerId, workspace } = await completed();
    const lock = join(f.root, '.git/refs/heads', `${workspace.branch}.lock`); writeFileSync(lock, 'locked');
    expect(await f.service.destroy(f.caller, { workerId })).toMatchObject({ state: 'incomplete', remaining: ['branch'],
      error: expect.any(String), deleted: [{ kind: 'worktree', path: workspace.path }] });
    expect(await f.service.collect(f.caller, { workerId })).toMatchObject({ cleanup: 'incomplete', workspace: { state: 'deleted' },
      head: { state: 'deleted', sha: f.sha }, diff: { state: 'available' } });
    expect(f.store.deleteRun(workerId)).toBe(false);
    rmSync(lock); expect(await f.service.destroy(f.caller, { workerId })).toMatchObject({ state: 'complete' });
    expect(f.store.readWorkerResultDiff(f.parent.id, workerId)).toContain('+retained patch');
  });
  it('allows terminal finished parent deletion only after every child history has a complete deletion receipt', async () => {
    const { workerId } = await completed(); await f.service.destroy(f.caller, { workerId });
    expect(f.store.deleteRun(workerId)).toBe(true);
    const parent = f.store.getRun(f.parent.id)!;
    if (parent.delegation?.role !== 'root') throw Error('fixture');
    f.store.commitDelegation([{ id: parent.id, delegation: { ...parent.delegation, finishRequestedAt: new Date().toISOString() } }]);
    expect(f.store.canDeleteRun(parent.id)).toBe(false);
    f.store.updateRun(parent.id, { status: 'done' });
    expect(f.store.deleteRun(parent.id)).toBe(true);
  });
  it('denies parent deletion when a missing child has a result but no completed deletion receipt', async () => {
    const { workerId } = await completed(); await f.service.destroy(f.caller, { workerId });
    writeFileSync(join(f.root, '.ai/cezar/runs.json'), JSON.stringify(f.store.listRuns().filter(run => run.id !== workerId)));
    const reopened = RunStore.open(join(f.root, '.ai/cezar'), { keepLive: true });
    expect(reopened.readWorkerResult(f.parent.id, workerId)).toBeDefined();
    expect(reopened.deleteRun(f.parent.id)).toBe(false); reopened.flush();
  });

  it('keeps an all-wait outcome and its revision after safe child deletion until the other worker settles', async () => {
    const { workerId } = await completed();
    f.store.commitWorkerContinuation(workerId, { status: 'review' });
    const generation = f.store.commitWorkerExecutionStart(workerId); f.store.commitWorkerExecutionComplete(workerId, generation);
    const other = await f.service.spawn(f.caller, { task: 'other', baseline: 'HEAD', requestId: randomUUID() });
    const parent = f.store.getRun(f.parent.id)!;
    if (parent.delegation?.role !== 'root') throw Error('fixture');
    f.store.commitDelegation([{ id: parent.id, delegation: { ...parent.delegation, wait: { id: randomUUID(),
      workerIds: [workerId, other.workerId], revisions: [{ workerId, revision: 1 }, { workerId: other.workerId, revision: 0 }],
      mode: 'all', phase: 'parked', outcomes: [], deadline: new Date(Date.now() + 600_000).toISOString(),
    } } }]);
    await f.service.destroy(f.caller, { workerId }); expect(f.store.deleteRun(workerId)).toBe(true);
    f.manager.reconcileWorkerWaits();
    expect(f.store.getRun(parent.id)?.delegation).toMatchObject({ wait: { phase: 'parked', outcomes: [{ workerId, revision: 1, status: 'review' }] } });
    const retained = f.store.readWorkerResult(f.parent.id, workerId)!;
    if (retained.diff.state !== 'available') throw Error('fixture diff');
    const bytes = readFileSync(retained.diff.path, 'utf8');
    writeFileSync(retained.diff.path, '{}');
    f.manager.reconcileWorkerWaits();
    expect(f.store.getRun(parent.id)?.delegation).toMatchObject({ wait: { phase: 'parked', outcomes: [] } });
    writeFileSync(retained.diff.path, bytes);
    f.manager.requestWorkerStop(other.workerId);
    f.manager.reconcileWorkerWaits();
    expect(f.store.getRun(parent.id)?.delegation).toMatchObject({ wait: { phase: 'wake-pending', reason: 'outcome',
      outcomes: expect.arrayContaining([{ workerId, revision: 1, status: 'review', observedAt: expect.any(String) },
        { workerId: other.workerId, revision: 0, status: 'cancelled', observedAt: expect.any(String) }]),
    } });
  });

  it('denies replacement evidence whose retained workspace names a different owner', async () => {
    const { workerId } = await completed(); await f.service.destroy(f.caller, { workerId }); expect(f.store.deleteRun(workerId)).toBe(true);
    const result = f.store.readWorkerResult(f.parent.id, workerId)!;
    if (result.diff.state !== 'available') throw Error('fixture diff');
    const file = JSON.parse(readFileSync(result.diff.path, 'utf8'));
    file.result.workspace.ownerRunId = randomUUID();
    writeFileSync(result.diff.path, JSON.stringify(file));
    expect(f.store.canDeleteRun(f.parent.id)).toBe(false);
    expect(f.manager.finishBlockedReason(f.parent.id)).toContain(workerId);
    await expect(f.service.collect(f.caller, { workerId })).rejects.toMatchObject({ code: 'denied_scope' });
  });

});
