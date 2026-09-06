import { randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunStore, type RunRecord } from '../runs/store.ts';
import { planOwnedWorkspace, removeOwnedWorkspace } from '../delegation/workspace.ts';
import { isReclaimable, rematerializeReclaimedWorktree } from '../runs/retention.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import * as runners from '../core/runner-factory.ts';
import { RunManager } from './run.ts';

const until = async (predicate: () => boolean) => vi.waitFor(() => expect(predicate()).toBe(true), { timeout: 15_000, interval: 10 });
function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }

describe('worker termination barrier', () => {
  let root: string, store: RunStore, manager: RunManager, parent: RunRecord;
  const releases: Array<() => void> = [];
  const executions: Promise<unknown>[] = [];
  beforeEach(() => {
    vi.stubEnv('CEZ_DRY_RUN', '1'); vi.stubEnv('CEZ_AUTONAME', '0');
    root = mkdtempSync(join(tmpdir(), 'cez-worker-destroy-'));
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
    execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@local', 'commit', '--allow-empty', '-qm', 'base'], { cwd: root });
    store = RunStore.open(join(root, '.ai/cezar'), { keepLive: true });
    manager = new RunManager(store, root, { semaphore: new WorkspaceSemaphore({ initial: { maxParallel: 1 } }) });
    const engine = manager as unknown as Record<'execute' | 'runContinuation', (...args: unknown[]) => Promise<unknown>>;
    for (const name of ['execute', 'runContinuation'] as const) {
      const real = engine[name].bind(manager);
      engine[name] = (...args) => { const p = real(...args); executions.push(p); return p; };
    }
    parent = store.createRun({ title: 'parent', task: 'parent', workflow: 'quick-task', steps: [] });
    store.updateRun(parent.id, { status: 'waiting', delegation: { role: 'root', permissions: ['spawn'], receipts: [] } });
  });
  afterEach(async () => {
    for (const release of releases.splice(0)) release();
    for (const run of store.listRuns()) manager.cancel(run.id);
    await Promise.allSettled(executions.splice(0));
    await until(() => store.listRuns().every(run => !manager.isActive(run.id)));
    manager.dispose(); store.flush(); vi.restoreAllMocks(); vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });
  async function worker(task = 'mock:hold') {
    const id = randomUUID(); const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    const workspace = await planOwnedWorkspace(root, id, sha);
    return store.createOwnedRun({ title: 'worker', task, workflow: 'quick-task', runner: 'claude', steps: [{ id: 'task', name: 'Task', kind: 'agent' }] }, parent.id, randomUUID(), {
      role: 'worker', permissions: [], parentRunId: parent.id, workspace,
    }, 'a'.repeat(64));
  }
  function workspace(run: RunRecord) { if (run.delegation?.role !== 'worker') throw Error('fixture'); return run.delegation.workspace; }
  function destroy(run: RunRecord) {
    if (run.delegation?.role !== 'worker') throw Error('fixture');
    store.commitDelegation([{ id: run.id, delegation: { ...run.delegation, destroy: { requestedAt: new Date().toISOString(), phase: 'requested', remaining: ['process', 'worktree', 'branch'] } } }]);
  }

  it('queued never-started stop is durable, idempotent, private and proven across reopen', async () => {
    const w = await worker();
    expect(manager.requestWorkerStop(w.id)).toEqual({ workerId: w.id, state: 'terminated' });
    expect(await manager.awaitRunTermination(w.id, 10)).toBe(true);
    expect(manager.requestWorkerStop(w.id).state).toBe('terminated');
    const reopened = RunStore.open(join(root, '.ai/cezar'), { keepLive: true });
    expect(reopened.getRun(w.id)?.status).toBe('cancelled');
    expect(reopened.readWorkerExecution(w.id)).toMatchObject({ phase: 'complete' });
    expect(JSON.stringify(reopened.getRun(w.id))).not.toMatch(/execution|generation/);
    expect(existsSync(workspace(w).path)).toBe(false);
    const other = new RunManager(reopened, root); expect(await other.awaitRunTermination(w.id, 10)).toBe(true); other.dispose(); reopened.flush();
  });

  it('stop in starting-before-ActiveRun waits for startup finalization and prevents launch', async () => {
    const w = await worker(); const hold = gate(); releases.push(hold.release);
    const engine = manager as unknown as { execute(...args: unknown[]): Promise<unknown>; starting: Set<string> };
    const real = engine.execute.bind(manager);
    engine.execute = async (...args) => { await hold.promise; return real(...args); };
    manager.enqueueOwnedRun(w.id); await until(() => engine.starting.has(w.id));
    expect(store.readWorkerExecution(w.id)).toMatchObject({ phase: 'starting' });
    expect(existsSync(workspace(w).path)).toBe(false);
    destroy(w); expect(manager.requestWorkerStop(w.id).state).toBe('stopping');
    expect(await manager.awaitRunTermination(w.id, 10)).toBe(false);
    hold.release(); expect(await manager.awaitRunTermination(w.id, 15_000)).toBe(true);
    expect(store.getRun(w.id)?.status).toBe('cancelled');
    expect(store.readEvents(w.id).some(event => event.type === 'session')).toBe(false);
    expect(existsSync(workspace(w).path)).toBe(false);
  });

  it('parked stop waits for process result AND pending turn bookkeeping before allowing destruction', async () => {
    const w = await worker(); const hold = gate(); releases.push(hold.release);
    const real = manager.recordTurnEnd.bind(manager);
    manager.recordTurnEnd = async (...args) => { await hold.promise; return real(...args); };
    manager.enqueueOwnedRun(w.id); await until(() => store.getRun(w.id)?.status === 'waiting');
    destroy(w); expect(manager.requestWorkerStop(w.id).state).toBe('stopping');
    expect(await manager.awaitRunTermination(w.id, 30)).toBe(false);
    expect(existsSync(workspace(w).path)).toBe(true);
    hold.release(); expect(await manager.awaitRunTermination(w.id, 15_000)).toBe(true);
    expect(await removeOwnedWorkspace(root, workspace(w))).toMatchObject({ state: 'complete' });
    expect(store.getRun(w.id)).toBeDefined(); expect(store.readEvents(w.id).length).toBeGreaterThan(0);
  });

  it('ignored SIGTERM and concurrent stop waiters cannot mistake cancelled/killed for exit', async () => {
    const w = await worker(); let child: ReturnType<typeof spawn> | undefined;
    vi.spyOn(runners, 'createRunner').mockReturnValue({ backend: 'claude', run: async () => { throw Error('unused'); }, startSession: (_spec, emit) => {
      child = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{}); console.log('ready'); setInterval(()=>{},1000)"], { stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout!.once('data', () => { emit?.({ type: 'turn-end' }); });
      const result = new Promise<never>((_resolve, reject) => child!.once('close', () => reject(Error('stopped'))));
      return { pid: child.pid, result, open: true, sendMessage: () => false, sendAgentMessage: () => false, interrupt: () => { child!.kill('SIGTERM'); }, end: () => { child!.kill('SIGTERM'); } };
    } });
    releases.push(() => child?.kill('SIGKILL'));
    manager.enqueueOwnedRun(w.id); await until(() => store.getRun(w.id)?.status === 'waiting');
    destroy(w); expect(manager.requestWorkerStop(w.id).state).toBe('stopping');
    expect(manager.requestWorkerStop(w.id).state).toBe('stopping');
    expect(await Promise.all([manager.awaitRunTermination(w.id, 20), manager.awaitRunTermination(w.id, 30)])).toEqual([false, false]);
    expect(child?.killed).toBe(true); expect(existsSync(workspace(w).path)).toBe(true);
    child!.kill('SIGKILL'); expect(await manager.awaitRunTermination(w.id, 15_000)).toBe(true);
    expect(store.readWorkerExecution(w.id)?.phase).toBe('complete');
  });

  it('terminal status without a private completion checkpoint never proves termination after restart', async () => {
    const w = await worker(); store.updateRun(w.id, { status: 'cancelled', startedAt: new Date().toISOString() }); store.flush();
    expect(await manager.awaitRunTermination(w.id, 10)).toBe(false);
    expect(manager.requestWorkerStop(w.id).state).toBe('stopping');
    expect(await manager.awaitRunTermination(w.id, 10)).toBe(false);
  });

  it('completion rotates on Continue; stale completion cannot authorize a newer execution', async () => {
    const w = await worker(); manager.enqueueOwnedRun(w.id); await until(() => store.getRun(w.id)?.status === 'waiting');
    manager.requestWorkerStop(w.id); expect(await manager.awaitRunTermination(w.id, 15_000)).toBe(true);
    const first = store.readWorkerExecution(w.id)!;
    expect(manager.continueRun(w.id, { text: 'mock:hold' }).ok).toBe(true);
    const next = store.readWorkerExecution(w.id)!; expect(next.generation).not.toBe(first.generation); expect(next.phase).toBe('starting');
    expect(store.commitWorkerExecutionComplete(w.id, first.generation)).toBe(false);
    await until(() => store.getRun(w.id)?.status === 'waiting'); manager.requestWorkerStop(w.id);
    expect(await manager.awaitRunTermination(w.id, 15_000)).toBe(true);
    const reopened = RunStore.open(join(root, '.ai/cezar'), { keepLive: true }); const other = new RunManager(reopened, root);
    expect(await other.awaitRunTermination(w.id, 10)).toBe(true); other.dispose(); reopened.flush();
  });

  it('destroying and invalid ownership never continue, reclaim, rematerialize or erase history', async () => {
    const w = await worker(); store.updateRun(w.id, { status: 'done', worktreePath: workspace(w).path, worktreeReclaimedAt: new Date().toISOString() });
    destroy(w);
    expect(manager.continueRun(w.id, { text: 'resume' }).ok).toBe(false);
    expect(isReclaimable({ ...w, worktreeReclaimedAt: undefined })).toBe(false);
    expect(await rematerializeReclaimedWorktree(root, store, w.id)).toBe(false);
    expect(store.deleteRun(w.id)).toBe(false); expect(store.deleteRun(parent.id)).toBe(false);
    store.updateRun(w.id, { delegation: { role: 'invalid' } });
    expect(isReclaimable({ ...w, worktreeReclaimedAt: undefined })).toBe(false);
    expect(await rematerializeReclaimedWorktree(root, store, w.id)).toBe(false);
    expect(manager.continueRun(w.id, { text: 'resume' }).ok).toBe(false);
    expect(store.deleteRun(w.id)).toBe(false);
  });

  it('private checkpoint failure or symlink substitution fails closed without publishing proof', async () => {
    const w = await worker(); const generation = store.commitWorkerExecutionStart(w.id);
    const path = join(root, '.ai/cezar/runs', `${w.id}.execution.json`);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ generation, phase: 'starting' });
    const original = readFileSync(path, 'utf8'); rmSync(path); symlinkSync(join(root, 'outside'), path);
    writeFileSync(join(root, 'outside'), original);
    expect(store.readWorkerExecution(w.id)).toBeUndefined();
    expect(store.commitWorkerExecutionComplete(w.id, generation)).toBe(false);
    expect(readFileSync(join(root, 'outside'), 'utf8')).toBe(original);
    rmSync(path); mkdirSync(path);
    expect(() => store.commitWorkerExecutionStart(w.id)).toThrow();
    expect(await manager.awaitRunTermination(w.id, 10)).toBe(false);
  });
});
