import { nonDumpableHolder } from '../delegation/non-dumpable.testkit.ts';
import { scopeFixtureProcesses } from '../delegation/process-scope.testkit.ts';
import { randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { managerDisposed } from './fixture-cleanup.testkit.ts';
import { RunStore, type RunRecord } from '../runs/store.ts';
import { agentTmpDirLocations, resolveAgentTmpDir } from '../runs/agent-tmpdir.ts';
import { ensureOwnedWorkspace, planOwnedWorkspace, removeOwnedWorkspace } from '../delegation/workspace.ts';
import { isReclaimable, rematerializeReclaimedWorktree } from '../runs/retention.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import * as config from '../config.ts';
import * as worktrees from '../git-worktree.ts';
import * as runners from '../core/runner-factory.ts';
import { CLAUDE_SPEC_SUPPORT } from '../core/claude-cli-runner.ts';
import { RunManager } from './run.ts';
import { DelegationService } from '../delegation/service.ts';
import { parseProcStat, processStartToken } from '../delegation/process-liveness.ts';
import { blockRunWrites } from '../runs/run-store.testkit.ts';

const until = async (predicate: () => boolean) => vi.waitFor(() => expect(predicate()).toBe(true), { timeout: 15_000, interval: 10 });
function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }

// Real Git, durable fsync checkpoints and process shutdown share this outer budget.
// Keep the separate 15s state/termination assertions and actual runner timers intact.
describe('worker termination barrier', { timeout: 30_000 }, () => {
  let root: string, store: RunStore, manager: RunManager, parent: RunRecord;
  const releases: Array<() => void> = [];
  const executions: Promise<unknown>[] = [];
  beforeEach(() => {
    scopeFixtureProcesses();
    vi.stubEnv('CEZ_DRY_RUN', '1'); vi.stubEnv('CEZ_AUTONAME', '0');
    root = mkdtempSync(join(tmpdir(), 'cez-worker-destroy-'));
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
    execFileSync('git', ['config', 'gc.auto', '0'], { cwd: root });
    execFileSync('git', ['config', 'maintenance.auto', 'false'], { cwd: root });
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
    // A test that restarted disposed this manager and closed this store: nothing to cancel here.
    if (!managerDisposed(manager)) for (const run of store.listRuns()) manager.cancel(run.id);
    await Promise.allSettled(executions.splice(0));
    await until(() => store.listRuns().every(run => !manager.isActive(run.id)));
    manager.dispose(); store.flush(); vi.restoreAllMocks(); vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  }, 30_000);
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
    store.close(); const reopened = RunStore.open(join(root, '.ai/cezar'), { keepLive: true });
    expect(reopened.getRun(w.id)?.status).toBe('cancelled');
    expect(reopened.readWorkerExecution(w.id)).toMatchObject({ phase: 'complete' });
    expect(JSON.stringify(reopened.getRun(w.id))).not.toMatch(/execution|generation/);
    expect(existsSync(workspace(w).path)).toBe(false);
    const other = new RunManager(reopened, root); expect(await other.awaitRunTermination(w.id, 10)).toBe(true); other.dispose(); reopened.flush();
  });

  it('requeues a stopped untouched owned worker under normal capacity and preserves parent guards', async () => {
    const w = await worker();
    store.updateRun(w.id, { workflowDef: { name: 'quick-task', source: 'built-in', steps: [{ id: 'task', prompt: '{{task}}' }] } });
    expect(manager.requestWorkerStop(w.id).state).toBe('terminated');
    manager.dispose();
    manager = new RunManager(store, root, { semaphore: new WorkspaceSemaphore({ initial: { maxParallel: 0 } }) });
    store.updateRun(parent.id, { status: 'review' });
    expect(manager.continueRun(w.id)).toMatchObject({ ok: false });
    store.updateRun(parent.id, { status: 'waiting' });
    expect(manager.continueRun(w.id, { text: 'keep working' })).toEqual({ ok: true });
    expect(store.getRun(w.id)?.status).toBe('queued');
    expect(store.getRun(w.id)?.steps.map(step => step.id)).toEqual(['task']);
    expect(manager.continueRun(w.id)).toMatchObject({ ok: false });
    expect(manager.requestWorkerStop(w.id).state).toBe('stopping');
    expect(await manager.awaitRunTermination(w.id, 1000)).toBe(true);
    expect(existsSync(workspace(w).path)).toBe(false);
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

  it('private never-materialized completion authorizes absent resources across restart and repeated destroy', async () => {
    const w = await worker();
    expect(manager.getWorkerNoMaterializationProof(w.id)).toBeUndefined();
    destroy(w); manager.requestWorkerStop(w.id);
    expect(await manager.awaitRunTermination(w.id, 10)).toBe(true);
    manager.dispose(); store.close(); const reopened = RunStore.open(join(root, '.ai/cezar'), { keepLive: true });
    const other = new RunManager(reopened, root);
    try {
      expect(reopened.readWorkerExecution(w.id)).toMatchObject({ phase: 'complete', neverMaterialized: true });
      const proof = other.getWorkerNoMaterializationProof(w.id);
      expect(proof).toBeTypeOf('function');
      expect(proof!({ ...workspace(w), resourceId: randomUUID() })).toBe(false);
      expect(await removeOwnedWorkspace(root, workspace(w))).toMatchObject({ state: 'incomplete' });
      expect(await removeOwnedWorkspace(root, workspace(w), proof)).toMatchObject({ state: 'complete', remaining: [] });
      expect(await removeOwnedWorkspace(root, workspace(w), proof)).toMatchObject({ state: 'complete', remaining: [] });
      mkdirSync(workspace(w).path, { recursive: true });
      expect(await removeOwnedWorkspace(root, workspace(w), proof)).toMatchObject({ state: 'incomplete' });
      expect(existsSync(workspace(w).path)).toBe(true);
      rmSync(workspace(w).path, { recursive: true });
      execFileSync('git', ['branch', workspace(w).branch], { cwd: root });
      expect(await removeOwnedWorkspace(root, workspace(w), proof)).toMatchObject({ state: 'incomplete' });
      expect(execFileSync('git', ['branch', '--list', workspace(w).branch], { cwd: root, encoding: 'utf8' })).toContain(workspace(w).branch);
      expect(JSON.stringify(reopened.getRun(w.id))).not.toMatch(/neverMaterialized|generation/);
    } finally { other.dispose(); reopened.flush(); }
  });

  it('contradictory abandonment cannot authorize no-materialization cleanup (hearsay-tools/cezarion#839)', async () => {
    const w = await worker(); destroy(w); manager.requestWorkerStop(w.id);
    const proof = store.readWorkerExecution(w.id)!;
    expect(proof.neverMaterialized).toBe(true);
    writeFileSync(join(root, '.ai/cezar/runs', `${w.id}.execution.json`), JSON.stringify({ ...proof, abandoned: true }), { mode: 0o600 });
    expect(manager.getWorkerNoMaterializationProof(w.id)).toBeUndefined();
    expect(await removeOwnedWorkspace(root, workspace(w))).toMatchObject({ state: 'incomplete' });
  });

  it('no-materialization proof is generation-bound and cannot survive starting or legacy completion', async () => {
    const w = await worker(); manager.requestWorkerStop(w.id);
    const first = store.readWorkerExecution(w.id)!;
    destroy(w); const proof = manager.getWorkerNoMaterializationProof(w.id)!;
    expect(proof(workspace(w))).toBe(true);
    const current = store.getRun(w.id)!;
    if (current.delegation?.role !== 'worker') throw Error('fixture');
    const { destroy: _destroy, ...delegation } = current.delegation;
    store.commitDelegation([{ id: w.id, delegation }]);
    const next = store.commitWorkerExecutionStart(w.id);
    expect(next).not.toBe(first.generation);
    store.commitWorkerCancellation(w.id); store.commitWorkerExecutionComplete(w.id, next); destroy(w);
    expect(proof(workspace(w))).toBe(false);
    expect(manager.getWorkerNoMaterializationProof(w.id)).toBeUndefined();
    expect(await removeOwnedWorkspace(root, workspace(w), proof)).toMatchObject({ state: 'incomplete' });
    writeFileSync(join(root, '.ai/cezar/runs', `${w.id}.execution.json`), JSON.stringify({ generation: next, phase: 'complete' }), { mode: 0o600 });
    expect(manager.getWorkerNoMaterializationProof(w.id)).toBeUndefined();
    writeFileSync(join(root, '.ai/cezar/runs', `${w.id}.execution.json`), JSON.stringify({ generation: next, phase: 'starting', neverMaterialized: true }), { mode: 0o600 });
    expect(store.readWorkerExecution(w.id)).toBeUndefined();
    expect(manager.getWorkerNoMaterializationProof(w.id)).toBeUndefined();
  });

  it('no-materialization proof is rechecked after asynchronous absence inspection', async () => {
    const w = await worker(); destroy(w); manager.requestWorkerStop(w.id);
    const proof = manager.getWorkerNoMaterializationProof(w.id)!;
    let calls = 0;
    const invalidated = (value: ReturnType<typeof workspace>) => {
      if (++calls === 2) rmSync(join(root, '.ai/cezar/runs', `${w.id}.execution.json`));
      return proof(value);
    };
    expect(await removeOwnedWorkspace(root, workspace(w), invalidated)).toMatchObject({ state: 'incomplete' });
    expect(calls).toBe(2);
  });

  it('never-materialized proof cannot override an unreadable creation receipt', async () => {
    const w = await worker(); destroy(w); manager.requestWorkerStop(w.id);
    const proof = manager.getWorkerNoMaterializationProof(w.id)!;
    const dir = join(root, '.git/cezar-owned-workspaces'); mkdirSync(dir, { recursive: true });
    const receipt = join(dir, `${workspace(w).resourceId}.json`); writeFileSync(receipt, '{broken');
    expect(await removeOwnedWorkspace(root, workspace(w), proof)).toMatchObject({ state: 'incomplete' });
    expect(readFileSync(receipt, 'utf8')).toBe('{broken');
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

  it.each(['fresh', 'Continue'])('%s post-spawn human flush failure retains resources until the session process closes', async mode => {
    const w = await worker();
    if (mode === 'Continue') {
      manager.enqueueOwnedRun(w.id); await until(() => store.getRun(w.id)?.status === 'waiting');
      manager.requestWorkerStop(w.id); expect(await manager.awaitRunTermination(w.id, 15_000)).toBe(true);
    }
    const child = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{}); console.log('ready'); setInterval(()=>{},1000)"], { stdio: ['ignore', 'pipe', 'pipe'] });
    const closed = new Promise<{ text: string; toolCalls: []; tokensUsed: number }>(resolve => child.once('close', () => resolve({ text: '', toolCalls: [], tokensUsed: 0 })));
    releases.push(() => child.kill('SIGKILL'));
    await new Promise<void>(resolve => child.stdout!.once('data', () => resolve()));
    let failedWrite = false;
    const append = store.appendEvent.bind(store);
    vi.spyOn(store, 'appendEvent').mockImplementation((id, event) => {
      if (id === w.id && event.type === 'user-message' && event.text === 'buffered during startup' && !failedWrite) {
        failedWrite = true; throw Error('controlled event write failure');
      }
      return append(id, event);
    });
    vi.spyOn(runners, 'createRunner').mockReturnValue({ backend: 'claude', specSupport: CLAUDE_SPEC_SUPPORT, interrupt: async () => undefined,
      run: async () => { throw Error('unused'); }, startSession: () => {
        expect(manager.deferMessage(w.id, [{ type: 'text', text: 'buffered during startup' }])).toBe(true);
        return { pid: child.pid, result: closed, open: true, sendMessage: () => true, sendAgentMessage: () => Promise.resolve(), discardQueuedMessages: () => {},
          interrupt: () => { child.kill('SIGTERM'); }, end: () => { child.kill('SIGTERM'); } };
      } });
    if (mode === 'fresh') manager.enqueueOwnedRun(w.id);
    else expect(manager.continueRun(w.id, { text: 'continue' }).ok).toBe(true);
    await until(() => failedWrite);
    expect.soft(await manager.awaitRunTermination(w.id, 30)).toBe(false);
    expect.soft(child.killed).toBe(true); // setup failure requested interruption, but SIGTERM is ignored
    expect(child.exitCode).toBeNull(); expect(child.signalCode).toBeNull();
    destroy(w); expect.soft(manager.requestWorkerStop(w.id).state).toBe('stopping');
    const terminated = await manager.awaitRunTermination(w.id, 30);
    expect.soft(terminated).toBe(false);
    if (terminated) await removeOwnedWorkspace(root, workspace(w));
    expect.soft(existsSync(workspace(w).path)).toBe(true);
    child.kill('SIGKILL'); await closed;
    expect(await manager.awaitRunTermination(w.id, 15_000)).toBe(true);
    expect(await removeOwnedWorkspace(root, workspace(w))).toMatchObject({ state: 'complete' });
  });

  it.each(['live', 'parked'])('%s ignored SIGTERM and concurrent stop waiters cannot mistake cancelled/killed for exit', async phase => {
    const w = await worker(); let child: ReturnType<typeof spawn> | undefined; let ready = false;
    vi.spyOn(runners, 'createRunner').mockReturnValue({ backend: 'claude', specSupport: CLAUDE_SPEC_SUPPORT, interrupt: async () => undefined, run: async () => { throw Error('unused'); }, startSession: (_spec, emit) => {
      child = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{}); console.log('ready'); setInterval(()=>{},1000)"], { stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout!.once('data', () => { ready = true; if (phase === 'parked') emit?.({ type: 'turn-end' }); });
      const result = new Promise<never>((_resolve, reject) => child!.once('close', () => reject(Error('stopped'))));
      return { pid: child.pid, result, open: true, sendMessage: () => false, sendAgentMessage: () => false, discardQueuedMessages: () => {}, interrupt: () => { child!.kill('SIGTERM'); }, end: () => { child!.kill('SIGTERM'); } };
    } });
    releases.push(() => child?.kill('SIGKILL'));
    manager.enqueueOwnedRun(w.id); await until(() => ready);
    expect(store.getRun(w.id)?.status).toBe(phase === 'parked' ? 'waiting' : 'running');
    destroy(w); expect(manager.requestWorkerStop(w.id).state).toBe('stopping');
    expect(manager.requestWorkerStop(w.id).state).toBe('stopping');
    expect(await Promise.all([manager.awaitRunTermination(w.id, 20), manager.awaitRunTermination(w.id, 30)])).toEqual([false, false]);
    expect(child?.killed).toBe(true); expect(existsSync(workspace(w).path)).toBe(true);
    child!.kill('SIGKILL'); expect(await manager.awaitRunTermination(w.id, 15_000)).toBe(true);
    expect(store.readWorkerExecution(w.id)?.phase).toBe('complete');
  });

  it('terminal status without a private completion checkpoint never proves termination after restart', async () => {
    const w = await worker(); store.updateRun(w.id, { status: 'cancelled', startedAt: new Date().toISOString() }); store.flush();
    rmSync(join(root, '.ai/cezar/runs', `${w.id}.execution.json`));
    expect(await manager.awaitRunTermination(w.id, 10)).toBe(false);
    expect(manager.requestWorkerStop(w.id).state).toBe('stopping');
    expect(await manager.awaitRunTermination(w.id, 10)).toBe(false);
  });

  it.each(['running', 'waiting', 'queued', 'failed', 'cancelled'] as const)('refuses %s recovery and Continue over a surviving prior process, then refuses real destroy', async status => {
    const w = await worker(); let child: ReturnType<typeof spawn> | undefined; let ready = false; let launches = 0;
    vi.spyOn(runners, 'createRunner').mockReturnValue({ backend: 'claude', specSupport: CLAUDE_SPEC_SUPPORT, interrupt: async () => undefined,
      run: async () => { throw Error('unused'); }, startSession: () => {
        if (++launches > 1) return { result: Promise.resolve({ text: '', toolCalls: [], tokensUsed: 0 }), open: false,
          sendMessage: () => false, sendAgentMessage: () => false, discardQueuedMessages: () => {}, interrupt() {}, end() {} };
        child = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{}); console.log('ready'); setInterval(()=>{},1000)"],
          { cwd: workspace(w).path, stdio: ['ignore', 'pipe', 'pipe'] });
        child.stdout!.once('data', () => { ready = true; });
        const result = new Promise<{ text: string; toolCalls: []; tokensUsed: number }>(resolve => child!.once('close', () => resolve({ text: '', toolCalls: [], tokensUsed: 0 })));
        return { pid: child.pid, result, open: true, sendMessage: () => true, sendAgentMessage: () => Promise.resolve(), discardQueuedMessages: () => {},
          interrupt: () => { child!.kill('SIGTERM'); }, end: () => { child!.kill('SIGTERM'); } };
      } });
    releases.push(() => child?.kill('SIGKILL'));
    manager.enqueueOwnedRun(w.id); await until(() => ready);
    const prior = store.readWorkerExecution(w.id)!;
    // Resolved, not hand-built: the run's scratch lives wherever the socket-safe
    // resolver (#387) put it, and the recovery barrier must see that location.
    const scratchDir = resolveAgentTmpDir(join(root, '.ai/cezar'), w.id);
    mkdirSync(scratchDir, { recursive: true });
    const scratch = join(scratchDir, 'retained.txt'); writeFileSync(scratch, 'old process scratch');
    manager.dispose(); store.updateRun(w.id, { status }); store.flush();
    store.close(); const reopened = RunStore.open(join(root, '.ai/cezar'), { keepLive: true }); const other = new RunManager(reopened, root);
    try {
      await other.recover();
      await until(() => !other.isActive(w.id) && reopened.getRun(w.id)?.status !== 'queued');
      expect.soft(reopened.readWorkerExecution(w.id)).toEqual(prior);
      expect.soft(existsSync(scratch)).toBe(true);
      expect.soft(other.continueRun(w.id, { text: 'try again' })).toMatchObject({ ok: false, error: expect.stringContaining('checkpoint') });
      await until(() => !other.isActive(w.id));
      const service = new DelegationService(); service.registerProject({ id: 'reopened', root, store: reopened, manager: other });
      expect.soft(await service.destroyForHuman('reopened', w.id)).toMatchObject({ state: 'incomplete', remaining: expect.arrayContaining(['process', 'worktree', 'branch']) });
      expect.soft(launches).toBe(1); expect.soft(existsSync(workspace(w).path)).toBe(true);
      expect.soft(existsSync(scratch)).toBe(true);
      expect.soft(child!.exitCode).toBeNull(); expect.soft(child!.signalCode).toBeNull();
      expect.soft(reopened.readWorkerExecution(w.id)).toEqual(prior);
      expect(reopened.getRun(w.id)).toBeDefined(); expect(reopened.readEvents(w.id).length).toBeGreaterThan(0);
    } finally { other.dispose(); reopened.flush(); child?.kill('SIGKILL'); }
  });

  it.each(['missing', 'malformed', 'starting'] as const)('cannot replace %s private execution evidence with a fresh generation', async shape => {
    const w = await worker(); const path = join(root, '.ai/cezar/runs', `${w.id}.execution.json`);
    if (shape === 'missing') rmSync(path);
    else if (shape === 'malformed') writeFileSync(path, '{broken');
    else store.commitWorkerExecutionStart(w.id);
    const before = existsSync(path) ? readFileSync(path, 'utf8') : undefined;
    expect(() => store.commitWorkerExecutionStart(w.id)).toThrow(/checkpoint/);
    expect(existsSync(path) ? readFileSync(path, 'utf8') : undefined).toBe(before);
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
    store.close(); const reopened = RunStore.open(join(root, '.ai/cezar'), { keepLive: true }); const other = new RunManager(reopened, root);
    expect(await other.awaitRunTermination(w.id, 10)).toBe(true); other.dispose(); reopened.flush();
  });

  it('destroying and invalid ownership never continue, reclaim, rematerialize or erase history', async () => {
    const w = await worker(); store.updateRun(w.id, { status: 'done', worktreePath: workspace(w).path, worktreeReclaimedAt: new Date().toISOString() });
    destroy(w);
    expect(manager.continueRun(w.id, { text: 'resume' }).ok).toBe(false);
    expect(isReclaimable({ ...store.getRun(w.id)!, worktreeReclaimedAt: undefined })).toBe(false);
    expect(await rematerializeReclaimedWorktree(root, store, w.id)).toBe(false);
    expect(store.deleteRun(w.id)).toBe(false); expect(store.deleteRun(parent.id)).toBe(false);
    store.updateRun(w.id, { delegation: { role: 'invalid' } });
    expect(isReclaimable({ ...store.getRun(w.id)!, worktreeReclaimedAt: undefined })).toBe(false);
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
    manager.enqueueOwnedRun(w.id);
    await vi.waitFor(() => expect(store.getRun(w.id)?.status).toBe('failed'), { timeout: 500 });
    expect(store.getRun(w.id)?.error).toContain('checkpoint');
    expect(existsSync(workspace(w).path)).toBe(false);
  });
  it('startup cancellation survives an asynchronous environment preflight in fresh and continued sessions', async () => {
    const w = await worker();
    const engine = manager as unknown as { agentEnvForStep(...args: unknown[]): Promise<unknown> };
    const real = engine.agentEnvForStep.bind(manager);
    for (const continuation of [false, true]) {
      const hold = gate(); releases.push(hold.release); let entered = false;
      engine.agentEnvForStep = async (...args) => { entered = true; await hold.promise; return real(...args); };
      if (continuation) {
        store.updateStep(w.id, 'task', { sessionId: 'mock-prior', backend: 'claude' });
        expect(manager.continueRun(w.id, { text: 'mock:hold' }).ok).toBe(true);
      } else manager.enqueueOwnedRun(w.id);
      await until(() => entered);
      manager.requestWorkerStop(w.id);
      expect(await manager.awaitRunTermination(w.id, 10)).toBe(false);
      hold.release(); expect(await manager.awaitRunTermination(w.id, 15_000)).toBe(true);
      expect(store.readEvents(w.id).some(event => event.type === 'session')).toBe(false);
      expect(store.getRun(w.id)?.status).toBe('cancelled');
    }
  });

  it('terminal completion and failed session startup both prove finalization, while disposal settles waiters false', async () => {
    const done = await worker('mock:done'); manager.enqueueOwnedRun(done.id);
    await until(() => ['done', 'review'].includes(store.getRun(done.id)!.status));
    expect(await manager.awaitRunTermination(done.id, 15_000)).toBe(true);
    const failure = await worker();
    const runnerSpy = vi.spyOn(runners, 'createRunner').mockReturnValue({ backend: 'claude', specSupport: CLAUDE_SPEC_SUPPORT, interrupt: async () => undefined, run: async () => { throw Error('unused'); }, startSession: () => { throw Error('startup failed'); } });
    manager.enqueueOwnedRun(failure.id); await until(() => store.getRun(failure.id)?.status === 'failed');
    expect(await manager.awaitRunTermination(failure.id, 15_000)).toBe(true);
    runnerSpy.mockRestore();
    const live = await worker(); manager.enqueueOwnedRun(live.id); await until(() => store.getRun(live.id)?.status === 'waiting');
    const wait = manager.awaitRunTermination(live.id, 30_000);
    manager.cancel(live.id); manager.dispose();
    expect(await wait).toBe(false);
    expect(store.readWorkerExecution(live.id)?.phase).toBe('starting');
  });

  it('queued destruction recovery never launches and missing or stale private evidence remains incomplete', async () => {
    const w = await worker(); destroy(w);
    manager.dispose(); store.close(); const reopened = RunStore.open(join(root, '.ai/cezar'), { keepLive: true }); const other = new RunManager(reopened, root);
    await other.recover(); expect(reopened.getRun(w.id)?.status).toBe('queued');
    expect(other.isActive(w.id)).toBe(false); expect(existsSync(workspace(w).path)).toBe(false);
    rmSync(join(root, '.ai/cezar/runs', `${w.id}.execution.json`));
    expect(other.requestWorkerStop(w.id).state).toBe('stopping');
    expect(await other.awaitRunTermination(w.id, 10)).toBe(false); other.dispose(); reopened.flush();
  });

  it('waits for an already-running periodic autosave before proving termination', async () => {
    vi.stubEnv('CEZ_AUTOSAVE', '1');
    const timers = vi.spyOn(globalThis, 'setInterval');
    const hold = gate(); releases.push(hold.release); let entered = false;
    const real = worktrees.autosaveCommit;
    vi.spyOn(worktrees, 'autosaveCommit').mockImplementation(async (...args) => {
      if (args[1] === 'periodic') { entered = true; await hold.promise; }
      return real(...args);
    });
    const w = await worker(); manager.enqueueOwnedRun(w.id); await until(() => store.getRun(w.id)?.status === 'waiting');
    const callback = timers.mock.calls.find(call => call[1] === 90_000)?.[0];
    expect(typeof callback).toBe('function'); (callback as () => void)(); await until(() => entered);
    manager.requestWorkerStop(w.id);
    expect(await manager.awaitRunTermination(w.id, 100)).toBe(false);
    hold.release(); expect(await manager.awaitRunTermination(w.id, 15_000)).toBe(true);
  });

  it('admits the same manager deferred Continue without rotating its exact owned generation', async () => {
    const w = await worker(); manager.enqueueOwnedRun(w.id); await until(() => store.getRun(w.id)?.status === 'waiting');
    manager.requestWorkerStop(w.id); expect(await manager.awaitRunTermination(w.id, 15000)).toBe(true);
    // Finish the old release sweep: Continue must schedule its own new queue entry.
    await (manager as unknown as { pump(): Promise<void> }).pump();
    expect(manager.continueRun(w.id, { text: 'mock:hold' }, true).ok).toBe(true);
    const deferred = store.readWorkerExecution(w.id)!;
    await until(() => store.getRun(w.id)?.status === 'waiting');
    expect(store.readWorkerExecution(w.id)).toEqual(deferred);
    manager.requestWorkerStop(w.id); expect(await manager.awaitRunTermination(w.id, 15000)).toBe(true);
    expect(store.readWorkerExecution(w.id)).toMatchObject({ generation: deferred.generation, phase: 'complete' });
  });

  it('capacity-deferred Continue invalidates prior completion before queueing and cancels without launching', async () => {
    const w = await worker(); manager.enqueueOwnedRun(w.id); await until(() => store.getRun(w.id)?.status === 'waiting');
    manager.requestWorkerStop(w.id); expect(await manager.awaitRunTermination(w.id, 15_000)).toBe(true);
    const first = store.readWorkerExecution(w.id)!;
    expect(manager.continueRun(w.id, { text: 'mock:hold' }, true).ok).toBe(true);
    expect(store.readWorkerExecution(w.id)).toMatchObject({ phase: 'starting' });
    expect(store.readWorkerExecution(w.id)?.generation).not.toBe(first.generation);
    manager.requestWorkerStop(w.id); expect(await manager.awaitRunTermination(w.id, 100)).toBe(true);
    expect(store.getRun(w.id)?.status).toBe('cancelled'); expect(manager.isActive(w.id)).toBe(false);
  });

  it('rejects human queued/startup input under destruction or parent Finish intent', async () => {
    const w = await worker();
    if (parent.delegation?.role !== 'root') throw Error('fixture');
    store.commitDelegation([{ id: parent.id, delegation: { ...parent.delegation, finishRequestedAt: new Date().toISOString() } }]);
    manager.enqueueOwnedRun(w.id);
    expect(manager.enqueueMessage(w.id, [{ type: 'text', text: 'new work' }])).toBeNull();
    store.commitRootFinishCancellation(parent.id);
    store.updateRun(parent.id, { status: 'waiting' });
    const another = await worker(); const hold = gate(); releases.push(hold.release);
    const engine = manager as unknown as { execute(...args: unknown[]): Promise<unknown>; starting: Set<string> };
    const real = engine.execute.bind(manager); engine.execute = async (...args) => { await hold.promise; return real(...args); };
    manager.enqueueOwnedRun(another.id); await until(() => engine.starting.has(another.id));
    destroy(another);
    expect(manager.deferMessage(another.id, [{ type: 'text', text: 'new work' }])).toBe(false);
    manager.requestWorkerStop(another.id); hold.release(); expect(await manager.awaitRunTermination(another.id, 15_000)).toBe(true);
  });

  it('private completion does not publish when final index persistence fails', async () => {
    const w = await worker(); const generation = store.commitWorkerExecutionStart(w.id);
    store.updateRun(w.id, { status: 'done' }); store.flush();
    const release = blockRunWrites(join(root, '.ai/cezar'));
    releases.push(release);
    expect(store.commitWorkerExecutionComplete(w.id, generation)).toBe(false);
    expect(store.readWorkerExecution(w.id)?.phase).toBe('starting');
    release();
    expect(store.commitWorkerExecutionComplete(w.id, generation)).toBe(true);
  });

  it('a parent with missing relationship receipts cannot erase a live child', async () => {
    await worker(); store.updateRun(parent.id, { delegation: { role: 'root', permissions: ['spawn'], receipts: [] } });
    expect(store.deleteRun(parent.id)).toBe(false);
  });

  it('cancellation during initial config lookup cannot be overwritten by late startup status', async () => {
    const w = await worker(); const hold = gate(); releases.push(hold.release); let entered = false;
    const real = config.loadConfig;
    vi.spyOn(config, 'loadConfig').mockImplementation(async (...args) => { entered = true; await hold.promise; return real(...args); });
    manager.enqueueOwnedRun(w.id); await until(() => entered);
    manager.requestWorkerStop(w.id); hold.release();
    expect(await manager.awaitRunTermination(w.id, 15_000)).toBe(true);
    expect(store.getRun(w.id)?.status).toBe('cancelled'); expect(existsSync(workspace(w).path)).toBe(false);
  });

  it('keeps workflow checks inside the termination barrier until the check process closes', async () => {
    const w = await worker(); const script = join(root, 'controlled-check.cjs');
    writeFileSync(script, "process.on('SIGTERM',()=>{}); require('node:fs').writeFileSync('check.pid', String(process.pid)); setInterval(()=>{},1000);");
    const engine = manager as unknown as { execute(...args: unknown[]): Promise<unknown> };
    const real = engine.execute.bind(manager);
    engine.execute = (...args) => real(args[0], { name: 'check barrier fixture', steps: [{ id: 'task', command: `exec '${process.execPath}' '${script}'` }] }, args[2]);
    const pidPath = join(workspace(w).path, 'check.pid'); let pid: number | undefined;
    releases.push(() => { if (pid) { try { process.kill(pid, 'SIGKILL'); } catch { /* already closed */ } } });
    manager.enqueueOwnedRun(w.id); await until(() => existsSync(pidPath)); pid = Number(readFileSync(pidPath, 'utf8'));
    manager.requestWorkerStop(w.id); expect(await manager.awaitRunTermination(w.id, 30)).toBe(false);
    expect(existsSync(workspace(w).path)).toBe(true);
    process.kill(pid, 'SIGKILL'); pid = undefined;
    expect(await manager.awaitRunTermination(w.id, 15_000)).toBe(true);
    expect(store.getRun(w.id)?.status).toBe('cancelled');
  });

  it('synchronous dequeue hydration failure still finalizes the admitted generation', async () => {
    const w = await worker();
    const engine = manager as unknown as { hydrateQueuedInput(...args: unknown[]): unknown; finishWorkerExecution(id: string): Promise<void> };
    engine.hydrateQueuedInput = () => { throw Error('fixture hydration failed'); };
    releases.push(() => { void engine.finishWorkerExecution(w.id); });
    manager.enqueueOwnedRun(w.id);
    await vi.waitFor(() => expect(store.getRun(w.id)?.status).toBe('failed'), { timeout: 500 });
    expect(await manager.awaitRunTermination(w.id, 100)).toBe(true);
    expect(existsSync(workspace(w).path)).toBe(false);
  });

  it('failed session startup cannot leave periodic autosave running after termination proof', async () => {
    vi.stubEnv('CEZ_AUTOSAVE', '1');
    const w = await worker(); manager.enqueueOwnedRun(w.id); await until(() => store.getRun(w.id)?.status === 'waiting');
    manager.requestWorkerStop(w.id); expect(await manager.awaitRunTermination(w.id, 15_000)).toBe(true);
    vi.useFakeTimers(); releases.push(() => vi.useRealTimers());
    const saves = vi.spyOn(worktrees, 'autosaveCommit');
    vi.spyOn(runners, 'createRunner').mockReturnValue({ backend: 'claude', specSupport: CLAUDE_SPEC_SUPPORT, interrupt: async () => undefined,
      run: async () => { throw Error('unused'); }, startSession: () => { throw Error('startup failed'); } });
    expect(manager.continueRun(w.id, { text: 'mock:hold' }).ok).toBe(true);
    await until(() => !manager.isActive(w.id));
    expect(await manager.awaitRunTermination(w.id, 100)).toBe(true);
    await vi.advanceTimersByTimeAsync(90_001);
    expect(saves.mock.calls.filter(call => call[1] === 'periodic')).toHaveLength(0);
    vi.useRealTimers();
  });

  it('destruction intent prevents synthetic monitoring wake bookkeeping before stop is sent', async () => {
    const w = await worker('mock:monitoring keep going');
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] }); releases.push(() => vi.useRealTimers());
    manager.enqueueOwnedRun(w.id); await until(() => !!store.getRun(w.id)?.monitoringWakeAt);
    const deadline = store.getRun(w.id)!.monitoringWakeAt!;
    const engine = manager as unknown as { active: Map<string, { monitoringWakeups?: number }> };
    const state = engine.active.get(w.id)!;
    destroy(w); await vi.advanceTimersByTimeAsync(Date.parse(deadline) - Date.now() + 1);
    expect(state.monitoringWakeups ?? 0).toBe(0);
    expect(store.getRun(w.id)?.monitoringWakeAt).toBe(deadline);
    expect(store.readEvents(w.id).some(event => event.type === 'note' && typeof event.message === 'string' && event.message.includes('automatic monitoring wake-up'))).toBe(false);
    vi.useRealTimers();
  });

  it('explicit termination retry can persist finalized same-process evidence after a checkpoint write failure', async () => {
    const w = await worker('mock:done');
    const complete = vi.spyOn(store, 'commitWorkerExecutionComplete').mockReturnValueOnce(false);
    manager.enqueueOwnedRun(w.id); await until(() => !manager.isActive(w.id));
    expect(store.readWorkerExecution(w.id)?.phase).toBe('starting');
    complete.mockRestore();
    expect(await manager.awaitRunTermination(w.id, 100)).toBe(true);
    expect(store.readWorkerExecution(w.id)?.phase).toBe('complete');
  });

  // #469: a crashed controller is simulated by a dead controller written into the process
  // record while the generation's `starting` proof stays exactly as the old manager left it.
  describe('orphaned generation after a controller crash (#469)', () => {
    const TERM_IGNORING = "process.on('SIGTERM',()=>{}); console.log('ready'); setInterval(()=>{},1000)";
    const spawnReady = async (cwd: string, script = TERM_IGNORING) => {
      const proc = spawn(process.execPath, ['-e', script], { cwd, stdio: ['ignore', 'pipe', 'ignore'] });
      releases.push(() => proc.kill('SIGKILL'));
      const exited = new Promise<void>(resolve => proc.once('exit', () => resolve()));
      await new Promise<void>(resolve => proc.stdout!.once('data', () => resolve()));
      return { proc, exited };
    };
    const deadPid = async () => { const proc = spawn(process.execPath, ['-e', '']); await new Promise(resolve => proc.once('exit', resolve)); return proc.pid!; };
    const recordPath = (id: string) => join(root, '.ai/cezar/runs', `${id}.processes.json`);
    const readRecord = (id: string) => JSON.parse(readFileSync(recordPath(id), 'utf8')) as { generation: string; controller: { pid: number; startToken?: string }; processes: { pid: number; startToken?: string }[] };
    const setController = (id: string, controller: { pid: number; startToken?: string }) => writeFileSync(recordPath(id), JSON.stringify({ ...readRecord(id), controller }));
    const branchExists = (branch: string) => execFileSync('git', ['branch', '--list', branch], { cwd: root, encoding: 'utf8' }).includes(branch);

    /** Launch 1 is a real child in the worktree; later launches (recovery's Continue) close at once. */
    async function crashed(status: RunRecord['status'] = 'running') {
      const w = await worker(); let first: Awaited<ReturnType<typeof spawnReady>> | undefined; let launches = 0; let ready!: () => void;
      const started = new Promise<void>(resolve => { ready = resolve; });
      vi.spyOn(runners, 'createRunner').mockReturnValue({ backend: 'claude', specSupport: CLAUDE_SPEC_SUPPORT, interrupt: async () => undefined,
        run: async () => { throw Error('unused'); }, startSession: () => {
          if (++launches > 1) return { result: Promise.resolve({ text: 'resumed', toolCalls: [], tokensUsed: 0 }), open: false,
            sendMessage: () => false, sendAgentMessage: () => false, discardQueuedMessages: () => {}, interrupt() {}, end() {} };
          const proc = spawn(process.execPath, ['-e', TERM_IGNORING], { cwd: workspace(w).path, stdio: ['ignore', 'pipe', 'ignore'] });
          releases.push(() => proc.kill('SIGKILL'));
          const exited = new Promise<void>(resolve => proc.once('exit', () => resolve()));
          first = { proc, exited }; proc.stdout!.once('data', () => ready());
          const result = exited.then(() => ({ text: '', toolCalls: [] as [], tokensUsed: 0 }));
          return { pid: proc.pid, result, open: true, sendMessage: () => true, sendAgentMessage: () => Promise.resolve(), discardQueuedMessages: () => {},
            interrupt: () => { proc.kill('SIGTERM'); }, end: () => { proc.kill('SIGTERM'); } };
        } });
      manager.enqueueOwnedRun(w.id); await started;
      const prior = store.readWorkerExecution(w.id)!;
      expect(prior.phase).toBe('starting');
      expect(readRecord(w.id)).toMatchObject({ generation: prior.generation, controller: { pid: process.pid }, processes: [{ pid: first!.proc.pid }] });
      manager.dispose(); store.updateRun(w.id, { status }); store.flush();
      setController(w.id, { pid: await deadPid(), startToken: '1' });
      store.close(); const reopened = RunStore.open(join(root, '.ai/cezar'), { keepLive: true }); const other = new RunManager(reopened, root);
      const service = new DelegationService(); service.registerProject({ id: 'reopened', root, store: reopened, manager: other });
      return { w, child: first!, prior, reopened, other, service, launches: () => launches };
    }

    it('the process record is generation-bound and never drops an entry past its cap', async () => {
      const w = await worker(); const generation = store.commitWorkerExecutionStart(w.id);
      expect(store.appendWorkerProcess(w.id, randomUUID(), 100)).toBe(false);
      for (let pid = 100; pid < 132; pid++) expect(store.appendWorkerProcess(w.id, generation, pid)).toBe(true);
      expect(store.appendWorkerProcess(w.id, generation, 132)).toBe(false);
      const record = store.readWorkerProcesses(w.id, generation);
      expect(typeof record === 'string' ? record : record.processes.map(entry => entry.pid)).toEqual(Array.from({ length: 32 }, (_, index) => 100 + index));
      expect(store.readWorkerProcesses(w.id, randomUUID())).toBe('unknown');
      rmSync(recordPath(w.id)); expect(store.readWorkerProcesses(w.id, generation)).toBe('absent');
    });

    it('a dead child is finalized by recovery, re-launches, and destroy completes', async () => {
      const { w, child, prior, reopened, other, service, launches } = await crashed();
      try {
        child.proc.kill('SIGKILL'); await child.exited;
        await other.recover();
        await until(() => !other.isActive(w.id) && reopened.getRun(w.id)?.status !== 'queued');
        expect(launches()).toBe(2);
        expect(reopened.readEvents(w.id).some(event => event.type === 'lifecycle' && String(event.message).includes('processes are gone'))).toBe(true);
        expect(reopened.readWorkerExecution(w.id)).toMatchObject({ phase: 'complete' });
        expect(reopened.readWorkerExecution(w.id)?.generation).not.toBe(prior.generation);
        expect(await service.destroyForHuman('reopened', w.id)).toMatchObject({ state: 'complete', remaining: [] });
        expect(existsSync(workspace(w).path)).toBe(false); expect(branchExists(workspace(w).branch)).toBe(false);
      } finally { other.dispose(); reopened.flush(); }
    });

    it('destroy reaps a recorded child that ignores SIGTERM, then completes', async () => {
      const { w, child, prior, reopened, other, service } = await crashed('failed');
      (other as unknown as { orphanTermGraceMs: number }).orphanTermGraceMs = 500;
      try {
        expect(await service.destroyForHuman('reopened', w.id)).toMatchObject({ state: 'complete', remaining: [] });
        await child.exited;
        expect(child.proc.signalCode).toBe('SIGKILL');
        expect(reopened.readWorkerExecution(w.id)).toMatchObject({ ...prior, phase: 'complete' });
        expect(existsSync(workspace(w).path)).toBe(false); expect(branchExists(workspace(w).branch)).toBe(false);
      } finally { other.dispose(); reopened.flush(); }
    });

    it('scan-only survivors are reported exactly, never signalled, and keep the worktree', async () => {
      const w = await worker();
      // Finish every Git operation before the scan. No original manager owns a live execution,
      // so the fixture cannot launch an autosave while destroy probes the orphan.
      await ensureOwnedWorkspace(root, w);
      store.commitWorkerExecutionStart(w.id);
      store.updateRun(w.id, { status: 'failed' }); store.flush();
      manager.dispose();
      const signalSensitive = "process.on('SIGTERM',()=>process.exit(42)); console.log('ready'); setInterval(()=>{},1000)";
      const worktreeHolder = await spawnReady(workspace(w).path, signalSensitive);
      const scratch = resolveAgentTmpDir(join(root, '.ai/cezar'), w.id); mkdirSync(scratch, { recursive: true });
      const scratchHolder = await spawnReady(scratch, signalSensitive);
      const expectedPids = [worktreeHolder.proc.pid!, scratchHolder.proc.pid!].sort((a, b) => a - b);
      const processKills = vi.spyOn(process, 'kill');
      const worktreeKills = vi.spyOn(worktreeHolder.proc, 'kill');
      const scratchKills = vi.spyOn(scratchHolder.proc, 'kill');
      const mutatingSignals = () => [
        ...processKills.mock.calls.filter(([pid, signal]) => expectedPids.includes(pid) && signal !== 0),
        ...worktreeKills.mock.calls.filter(([signal]) => signal !== 0),
        ...scratchKills.mock.calls.filter(([signal]) => signal !== 0),
      ];
      // A missing record makes these two real cwd holders scan-only evidence.
      rmSync(recordPath(w.id));
      const prior = store.readWorkerExecution(w.id);
      store.close(); const reopened = RunStore.open(join(root, '.ai/cezar'), { keepLive: true });
      const other = new RunManager(reopened, root);
      const service = new DelegationService(); service.registerProject({ id: 'reopened', root, store: reopened, manager: other });
      const since = Date.parse(w.createdAt) - 1_000;
      const bootTimeMs = process.platform === 'linux' ? Number(/^btime (\d+)$/m.exec(readFileSync('/proc/stat', 'utf8'))?.[1]) * 1_000 : 0;
      const clockTicks = process.platform === 'linux' ? Number(execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }).trim()) || 100 : 0;
      type ScanRead = { cwd?: string; readlinkError?: string; uid?: number; startToken?: string };
      const scanReads = new Map<number, ScanRead>();
      const observed = (pid: number) => {
        let entry = scanReads.get(pid);
        if (!entry) { entry = {}; scanReads.set(pid, entry); }
        return entry;
      };
      // Pass through the exact fs calls the Linux scanner makes. A second /proc read after
      // destroy can see a process that has exited or changed dumpability.
      const realReadlink = fs.readlinkSync;
      vi.spyOn(fs, 'readlinkSync').mockImplementation(((...args: unknown[]) => {
        const pid = /^\/proc\/(\d+)\/cwd$/.exec(String(args[0]))?.[1];
        // Each cwd read starts a fresh probe for this PID; an earlier pass's uid/start token
        // must not stand in when the current pass cannot read them.
        if (pid) scanReads.set(Number(pid), {});
        try {
          const result = Reflect.apply(realReadlink, fs, args);
          if (pid) { const entry = observed(Number(pid)); entry.cwd = String(result); entry.readlinkError = undefined; }
          return result;
        } catch (error) {
          if (pid) { const entry = observed(Number(pid)); entry.cwd = undefined; entry.readlinkError = (error as NodeJS.ErrnoException).code; }
          throw error;
        }
      }) as typeof fs.readlinkSync);
      const realStat = fs.statSync;
      vi.spyOn(fs, 'statSync').mockImplementation(((...args: unknown[]) => {
        const result = Reflect.apply(realStat, fs, args);
        const pid = /^\/proc\/(\d+)$/.exec(String(args[0]))?.[1];
        if (pid) observed(Number(pid)).uid = result.uid;
        return result;
      }) as typeof fs.statSync);
      const realReadFile = fs.readFileSync;
      vi.spyOn(fs, 'readFileSync').mockImplementation(((...args: unknown[]) => {
        const result = Reflect.apply(realReadFile, fs, args);
        const pid = /^\/proc\/(\d+)\/stat$/.exec(String(args[0]))?.[1];
        if (pid) observed(Number(pid)).startToken = parseProcStat(String(result))?.startToken;
        return result;
      }) as typeof fs.readFileSync);
      syncBuiltinESMExports();
      try {
        const describePid = (pid: number) => {
          const file = `/proc/${pid}`;
          const read = (path: string) => { try { return readFileSync(path, 'utf8').trim().slice(0, 160); } catch (error) { return (error as NodeJS.ErrnoException).code; } };
          let cwd: string | undefined;
          try { cwd = readlinkSync(`${file}/cwd`); } catch (error) { cwd = `readlink:${(error as NodeJS.ErrnoException).code}`; }
          const stat = read(`${file}/stat`);
          const ppid = stat?.includes(')') ? stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/)[1] : undefined;
          let uid: number | undefined;
          try { uid = statSync(file).uid; } catch { /* The PID may have exited since the scan. */ }
          return { pid, ppid, cwd, comm: read(`${file}/comm`), startToken: processStartToken(pid), uid };
        };
        // Snapshot the returned blocker immediately, before a transient PID can disappear.
        let blockerDiagnostics: ReturnType<typeof describePid>[] = [];
        let blockerPids: number[] = [];
        let blockerReads = new Map<number, ScanRead>();
        const takeBlocker = other.takeWorkerTerminationBlocker.bind(other);
        vi.spyOn(other, 'takeWorkerTerminationBlocker').mockImplementation(runId => {
          const taken = takeBlocker(runId);
          if (taken?.blocker.kind === 'processes') {
            blockerPids = [...taken.blocker.pids];
            blockerReads = new Map(blockerPids.map(pid => [pid, { ...scanReads.get(pid) }]));
            blockerDiagnostics = blockerPids.map(describePid);
          }
          return taken;
        });
        // Neither holder exits on its own, so each destroy waits out its deadline (#469).
        (service as unknown as { terminationTimeoutMs: number }).terminationTimeoutMs = 1_500;
        await other.recover();
        expect(mutatingSignals()).toEqual([]);
        expect(reopened.readWorkerExecution(w.id)).toEqual(prior);
        scanReads.clear();
        const blocked = await service.destroyForHuman('reopened', w.id);
        expect(blocked).toMatchObject({ state: 'incomplete', remaining: ['process', 'worktree', 'branch'] });
        const assertReported = (error: string | undefined) => {
          const reason = /^Worker termination is not proven: (processes [\d, ]+ still hold the worker's worktree or scratch); retry cleanup later$/.exec(error ?? '')?.[1];
          expect(reason).toBeDefined();
          const reported = reason!.match(/\d+/g)!.map(Number).sort((a, b) => a - b);
          const boundedDiagnostics = blockerDiagnostics.slice(0, 8).map(entry => ({ ...entry, cwd: entry.cwd?.slice(0, 160) }));
          expect(reported, JSON.stringify(boundedDiagnostics)).toEqual([...blockerPids].sort((a, b) => a - b));
          for (const pid of expectedPids) expect(reported).toContain(pid);
          // Every reported PID must have been observed by the real scan as a cwd holder or
          // under its conservative same-user unreadable-cwd rule.
          if (process.platform === 'linux') {
            const targets = [workspace(w).path, ...agentTmpDirLocations(join(root, '.ai/cezar'), w.id)]
              .map(path => { try { return realpathSync(path); } catch { return path; } });
            for (const entry of blockerDiagnostics) {
              const scan = blockerReads.get(entry.pid);
              expect(scan, JSON.stringify({ ...entry, cwd: entry.cwd?.slice(0, 160) })).toBeDefined();
              const startTick = Number(scan?.startToken);
              const eligibleStart = !scan?.startToken || !Number.isFinite(bootTimeMs) ||
                !Number.isFinite(startTick) || bootTimeMs + startTick / clockTicks * 1_000 >= since;
              const cwd = scan?.cwd?.replace(/ \(deleted\)$/, '');
              expect(((scan?.readlinkError === 'EACCES' || scan?.readlinkError === 'EPERM') &&
                scan.uid === process.getuid?.() && eligibleStart) ||
                (cwd !== undefined && targets.some(target => cwd === target || cwd.startsWith(target + sep))),
                JSON.stringify({ pid: entry.pid, ...scan, cwd: cwd?.slice(0, 160) })).toBe(true);
            }
          }
          return reason!;
        };
        const reason = assertReported(blocked.error);
        expect(mutatingSignals()).toEqual([]);
        scanReads.clear();
        const retried = await service.destroyForHuman('reopened', w.id);
        expect(retried).toMatchObject({ state: 'incomplete', remaining: ['process', 'worktree', 'branch'] });
        const retryReason = assertReported(retried.error);
        expect(mutatingSignals()).toEqual([]);
        // An unchanged blocker set appends no second event; a changed set is reported exactly.
        expect(reopened.readEvents(w.id).filter(event => event.type === 'lifecycle' && String(event.message).startsWith('destroy blocked:'))).toEqual([
          expect.objectContaining({ message: `destroy blocked: ${reason}` }),
          ...(retryReason === reason ? [] : [expect.objectContaining({ message: `destroy blocked: ${retryReason}` })])]);
        expect(existsSync(workspace(w).path)).toBe(true);
        expect(worktreeHolder.proc.exitCode).toBeNull(); expect(worktreeHolder.proc.signalCode).toBeNull();
        expect(scratchHolder.proc.exitCode).toBeNull(); expect(scratchHolder.proc.signalCode).toBeNull();
        expect(reopened.readWorkerExecution(w.id)).toEqual(prior);
      } finally { other.dispose(); reopened.flush(); vi.restoreAllMocks(); syncBuiltinESMExports(); }
    });

    it('a live foreign controller keeps the generation: nothing is finalized or signalled', async () => {
      const { w, child, prior, reopened, other, service } = await crashed('failed');
      const foreign = await spawnReady(tmpdir());
      try {
        child.proc.kill('SIGKILL'); await child.exited;
        const token = processStartToken(foreign.proc.pid!);
        setController(w.id, { pid: foreign.proc.pid!, ...(token ? { startToken: token } : {}) });
        await other.recover();
        expect(reopened.readWorkerExecution(w.id)).toEqual(prior);
        expect(other.continueRun(w.id, { text: 'try again' })).toEqual({ ok: false, error: `the worker is still controlled by a live cezar (pid ${foreign.proc.pid})` });
        expect(await service.destroyForHuman('reopened', w.id)).toMatchObject({ state: 'incomplete', remaining: expect.arrayContaining(['process']),
          error: `Worker termination is not proven: the worker is still controlled by a live cezar (pid ${foreign.proc.pid}); retry cleanup later` });
        expect(existsSync(workspace(w).path)).toBe(true);
        expect(foreign.proc.exitCode).toBeNull(); expect(foreign.proc.signalCode).toBeNull();
        expect(reopened.readWorkerExecution(w.id)).toEqual(prior);
      } finally { other.dispose(); reopened.flush(); }
    });

    it.each(['malformed', 'another generation'] as const)('a present but %s record proves nothing: no finalization, no reap', async shape => {
      const { w, child, prior, reopened, other, service } = await crashed('failed');
      try {
        child.proc.kill('SIGKILL'); await child.exited;
        writeFileSync(recordPath(w.id), shape === 'malformed' ? '{broken' : JSON.stringify({ ...readRecord(w.id), generation: randomUUID() }));
        await other.recover();
        expect(reopened.readWorkerExecution(w.id)).toEqual(prior);
        expect(await service.destroyForHuman('reopened', w.id)).toMatchObject({ state: 'incomplete', remaining: expect.arrayContaining(['process']),
          error: 'worker process record is unreadable; termination cannot be proven' });
        expect(existsSync(workspace(w).path)).toBe(true);
        expect(reopened.readWorkerExecution(w.id)).toEqual(prior);
      } finally { other.dispose(); reopened.flush(); }
    });

    it('resume right after a cached alive probe re-probes, so a survivor that just died does not refuse it', async () => {
      const { w, child, prior, reopened, other, launches } = await crashed('failed');
      try {
        await other.recover();
        expect(reopened.readWorkerExecution(w.id)).toEqual(prior); // cached "alive" for 2 s
        child.proc.kill('SIGKILL'); await child.exited;
        expect(other.continueRun(w.id, { text: 'resume' })).toEqual({ ok: true });
        await until(() => launches() === 2);
        expect(reopened.readWorkerExecution(w.id)?.generation).not.toBe(prior.generation);
      } finally { other.dispose(); reopened.flush(); }
    });

    it('recovery preserves a live worker scratchpad after finalizing its dead generation (#515)', async () => {
      const { w, child, reopened, other } = await crashed('waiting');
      const scratch = resolveAgentTmpDir(join(root, '.ai/cezar'), w.id);
      mkdirSync(scratch, { recursive: true });
      writeFileSync(join(scratch, 'notes'), 'answer still needed');
      reopened.appendEvent(w.id, { type: 'ask.requested', requestId: randomUUID(), questions: [{
        header: 'Choice', question: 'Which option?', options: [{ label: 'A' }, { label: 'B' }],
      }] });
      try {
        child.proc.kill('SIGKILL'); await child.exited;
        await other.recover();
        expect(reopened.readWorkerExecution(w.id)?.phase).toBe('complete');
        expect(reopened.getRun(w.id)?.status).toBe('waiting');
        expect(readFileSync(join(scratch, 'notes'), 'utf8')).toBe('answer still needed');
      } finally { other.dispose(); reopened.flush(); }
    });

    it('a process working in the run scratch keeps the generation alive', async () => {
      const { w, child, prior, reopened, other } = await crashed('failed');
      const scratch = resolveAgentTmpDir(join(root, '.ai/cezar'), w.id); mkdirSync(scratch, { recursive: true });
      const holder = await spawnReady(scratch);
      try {
        child.proc.kill('SIGKILL'); await child.exited;
        await other.recover();
        expect(reopened.readWorkerExecution(w.id)).toEqual(prior);
        expect(existsSync(scratch)).toBe(true);
        expect(holder.proc.exitCode).toBeNull();
      } finally { other.dispose(); reopened.flush(); }
    });

    it.each(['inside', 'after'] as const)('a parked parent wait resolves once a survivor dies %s the fast re-probe window', async window => {
      const { w, child, reopened, other } = await crashed('failed');
      const cadence = other as unknown as { orphanReprobeMs: number; orphanReprobeLimitMs: number; orphanReprobeSlowMs: number };
      // After the fast window a slow probe remains the wake source; it never gives up.
      if (window === 'inside') cadence.orphanReprobeMs = 100;
      else Object.assign(cadence, { orphanReprobeMs: 600_000, orphanReprobeLimitMs: 0, orphanReprobeSlowMs: 100 });
      const owner = reopened.getRun(parent.id)!;
      if (owner.delegation?.role !== 'root') throw Error('fixture');
      reopened.commitDelegation([{ id: parent.id, delegation: { ...owner.delegation, wait: { id: randomUUID(), workerIds: [w.id],
        revisions: [{ workerId: w.id, revision: 0 }], deadline: new Date(Date.now() + 600_000).toISOString(), phase: 'parked', outcomes: [] } } }]);
      const wait = () => { const run = reopened.getRun(parent.id); return run?.delegation?.role === 'root' ? run.delegation.wait ?? run.delegation.lastWait : undefined; };
      try {
        await other.recover();
        expect(reopened.readWorkerExecution(w.id)?.phase).toBe('starting');
        expect(wait()?.outcomes).toEqual([]);
        child.proc.kill('SIGKILL'); await child.exited;
        await until(() => reopened.readWorkerExecution(w.id)?.phase === 'complete');
        await until(() => !!wait()?.outcomes.some(outcome => outcome.workerId === w.id));
        expect(wait()!.outcomes).toEqual([expect.objectContaining({ workerId: w.id, revision: 0, status: 'failed' })]);
      } finally { other.dispose(); reopened.flush(); }
    });

    it('destroy waits out a scan-only survivor of a legacy generation instead of returning at once', async () => {
      const { w, child, reopened, other, service } = await crashed('failed');
      try {
        rmSync(recordPath(w.id));
        await other.recover();
        expect(reopened.readWorkerExecution(w.id)).toMatchObject({ phase: 'starting' });
        // The survivor exits on its own well inside destroy's deadline; nothing signals it.
        const exit = setTimeout(() => child.proc.kill('SIGKILL'), 1_000);
        try { expect(await service.destroyForHuman('reopened', w.id)).toMatchObject({ state: 'complete', remaining: [] }); }
        finally { clearTimeout(exit); }
        expect(existsSync(workspace(w).path)).toBe(false); expect(branchExists(workspace(w).branch)).toBe(false);
      } finally { other.dispose(); reopened.flush(); }
    });

    it.runIf(process.platform === 'linux')('refuses unreadable unverified candidates promptly without signalling or claiming holder membership (hearsay-tools/cezarion#839)', async () => {
      const w = await worker(); await ensureOwnedWorkspace(root, w);
      store.commitWorkerExecutionStart(w.id); store.updateRun(w.id, { status: 'failed' }); store.flush();
      manager.dispose(); store.close(); rmSync(recordPath(w.id)); // absent legacy ledger never authorizes abandonment
      const holder = await nonDumpableHolder(root);
      const reopened = RunStore.open(join(root, '.ai/cezar'), { keepLive: true }); const other = new RunManager(reopened, root);
      const service = new DelegationService(); const detach = service.registerProject({ id: 'reopened', root, store: reopened, manager: other });
      Object.assign(service, { terminationTimeoutMs: 1_500 });
      try {
        const began = performance.now();
        expect(await service.destroyForHuman('reopened', w.id)).toMatchObject({ state: 'incomplete', remaining: ['process', 'worktree', 'branch'],
          error: expect.stringMatching(/unverified|unreadable/) });
        expect(performance.now() - began).toBeLessThan(1_200);
        expect(reopened.readWorkerExecution(w.id)?.phase).toBe('starting');
        expect(existsSync(workspace(w).path)).toBe(true); await holder.write();
      } finally { detach(); other.dispose(); reopened.flush(); await holder.close(); }
    });

    it('a legacy generation (no record) with no process in the worktree is finalized', async () => {
      const { w, child, reopened, other, service } = await crashed('failed');
      try {
        child.proc.kill('SIGKILL'); await child.exited;
        rmSync(recordPath(w.id));
        await other.recover();
        expect(reopened.readWorkerExecution(w.id)).toMatchObject({ phase: 'complete' });
        expect(await service.destroyForHuman('reopened', w.id)).toMatchObject({ state: 'complete', remaining: [] });
        expect(existsSync(workspace(w).path)).toBe(false); expect(branchExists(workspace(w).branch)).toBe(false);
      } finally { other.dispose(); reopened.flush(); }
    });
  });
});
