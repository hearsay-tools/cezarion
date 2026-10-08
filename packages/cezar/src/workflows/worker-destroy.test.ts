import { nonDumpableHolder } from '../delegation/non-dumpable.testkit.ts';
import { scopeFixtureProcesses } from '../delegation/process-scope.testkit.ts';
import { randomUUID } from 'node:crypto';
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { managerDisposed } from './fixture-cleanup.testkit.ts';
import { RunStore, type RunRecord } from '../runs/store.ts';
import { agentTmpDir, agentTmpDirLocations, resolveAgentTmpDir } from '../runs/agent-tmpdir.ts';
import { ensureOwnedWorkspace, planOwnedWorkspace, removeOwnedWorkspace } from '../delegation/workspace.ts';
import { isReclaimable, rematerializeReclaimedWorktree } from '../runs/retention.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import * as config from '../config.ts';
import * as worktrees from '../git-worktree.ts';
import * as runners from '../core/runner-factory.ts';
import { CLAUDE_SPEC_SUPPORT } from '../core/claude-cli-runner.ts';
import { RunManager } from './run.ts';
import { DelegationService } from '../delegation/service.ts';
import type { Backoff } from '../delegation/retry-backoff.ts';
import { processesWithCwdUnder, processStartToken } from '../delegation/process-liveness.ts';
import { signalSession, spawnSessionLeader } from '../core/session-process.ts';
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

  it('destroy of a never-started queued worker completes with no deletions across restart and repeats (hearsay-tools/cezarion#892)', async () => {
    const w = await worker(); manager.requestWorkerStop(w.id);
    expect(await manager.awaitRunTermination(w.id, 10)).toBe(true);
    manager.dispose(); store.close(); const reopened = RunStore.open(join(root, '.ai/cezar'), { keepLive: true });
    const other = new RunManager(reopened, root);
    const service = new DelegationService(); const detach = service.registerProject({ id: 'reopened', root, store: reopened, manager: other });
    try {
      // The flag stays in the checkpoint as a record of the queued completion; destroy no longer reads it.
      expect(reopened.readWorkerExecution(w.id)).toMatchObject({ phase: 'complete', neverMaterialized: true });
      for (let attempt = 0; attempt < 2; attempt++) {
        const result = await service.destroyForHuman('reopened', w.id);
        expect(result).toMatchObject({ state: 'complete', remaining: [] });
        expect(result).not.toHaveProperty('deleted');
      }
      expect(reopened.getRun(w.id)?.delegation).toMatchObject({ destroy: { phase: 'complete', remaining: [] } });
      expect(JSON.stringify(reopened.getRun(w.id))).not.toMatch(/neverMaterialized|generation/);
      // #878: absence must be total. A path or branch at the worker's name keeps it unverified.
      mkdirSync(workspace(w).path, { recursive: true });
      expect(await removeOwnedWorkspace(root, workspace(w))).toMatchObject({ state: 'incomplete' });
      expect(existsSync(workspace(w).path)).toBe(true);
      rmSync(workspace(w).path, { recursive: true });
      execFileSync('git', ['branch', workspace(w).branch], { cwd: root });
      expect(await removeOwnedWorkspace(root, workspace(w))).toMatchObject({ state: 'incomplete' });
      expect(execFileSync('git', ['branch', '--list', workspace(w).branch], { cwd: root, encoding: 'utf8' })).toContain(workspace(w).branch);
    } finally { detach(); other.dispose(); reopened.flush(); }
  });

  it('a checkpoint both abandoned and never-materialized does not parse (hearsay-tools/cezarion#839)', async () => {
    const w = await worker(); destroy(w); manager.requestWorkerStop(w.id);
    const proof = store.readWorkerExecution(w.id)!;
    expect(proof.neverMaterialized).toBe(true);
    writeFileSync(join(root, '.ai/cezar/runs', `${w.id}.execution.json`), JSON.stringify({ ...proof, abandoned: true }), { mode: 0o600 });
    expect(store.readWorkerExecution(w.id)).toBeUndefined();
    // #878: nothing was materialized, so absence alone still completes bookkeeping.
    expect(await removeOwnedWorkspace(root, workspace(w))).toMatchObject({ state: 'complete', remaining: [] });
  });

  it('a checkpoint an older cezar abandoned still parses, keeps its flag and refuses resume (hearsay-tools/cezarion#889)', async () => {
    const w = await worker();
    const generation = store.commitWorkerExecutionStart(w.id);
    store.updateRun(w.id, { status: 'cancelled' }); expect(store.commitWorkerExecutionComplete(w.id, generation)).toBe(true);
    const path = join(root, '.ai/cezar/runs', `${w.id}.execution.json`);
    writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), abandoned: true }), { mode: 0o600 });
    expect(store.readWorkerExecution(w.id)).toMatchObject({ generation, phase: 'complete', abandoned: true });
    expect(() => store.commitWorkerExecutionStart(w.id)).toThrow(/abandoned/);
    expect(store.commitWorkerExecutionComplete(w.id, generation)).toBe(true);
    expect(store.readWorkerExecution(w.id)).toMatchObject({ generation, phase: 'complete', abandoned: true });
  });

  it('destroy stays incomplete when a later starting generation carries the never-materialized flag', async () => {
    const w = await worker(); manager.requestWorkerStop(w.id);
    expect(store.readWorkerExecution(w.id)).toMatchObject({ phase: 'complete', neverMaterialized: true });
    manager.dispose(); store.close();
    // The schema refuses the flag outside `complete`, so this generation's termination is never proven.
    writeFileSync(join(root, '.ai/cezar/runs', `${w.id}.execution.json`), JSON.stringify({ generation: randomUUID(), phase: 'starting', neverMaterialized: true }), { mode: 0o600 });
    const reopened = RunStore.open(join(root, '.ai/cezar'), { keepLive: true }); const other = new RunManager(reopened, root);
    const service = new DelegationService(); const detach = service.registerProject({ id: 'reopened', root, store: reopened, manager: other });
    Object.assign(service, { terminationTimeoutMs: 50 });
    try {
      expect(reopened.readWorkerExecution(w.id)).toBeUndefined();
      expect(await service.destroyForHuman('reopened', w.id)).toMatchObject({ state: 'incomplete', remaining: ['process', 'worktree', 'branch'] });
    } finally { detach(); other.dispose(); reopened.flush(); }
  });

  it('an unreadable creation receipt keeps a never-materialized worker\'s destroy incomplete', async () => {
    const w = await worker(); manager.requestWorkerStop(w.id);
    expect(store.readWorkerExecution(w.id)).toMatchObject({ phase: 'complete', neverMaterialized: true });
    const dir = join(root, '.git/cezar-owned-workspaces'); mkdirSync(dir, { recursive: true });
    const receipt = join(dir, `${workspace(w).resourceId}.json`); writeFileSync(receipt, '{broken');
    const service = new DelegationService(); const detach = service.registerProject({ id: 'p', root, store, manager });
    try {
      expect(await service.destroyForHuman('p', w.id)).toMatchObject({ state: 'incomplete', remaining: ['worktree', 'branch'] });
    } finally { detach(); }
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
    vi.spyOn(runners, 'createRunner').mockReturnValue({ backend: 'claude', specSupport: CLAUDE_SPEC_SUPPORT, systemPromptOnResume: 'resent', interrupt: async () => undefined,
      run: async () => { throw Error('unused'); }, startSession: () => {
        expect(manager.deferMessage(w.id, [{ type: 'text', text: 'buffered during startup' }])).toBe(true);
        return { pid: child.pid, result: closed, open: true, sendMessage: () => true, sendAgentMessage: () => Promise.resolve(), discardQueuedMessages: () => {}, holdsHumanInput: () => false,
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
    vi.spyOn(runners, 'createRunner').mockReturnValue({ backend: 'claude', specSupport: CLAUDE_SPEC_SUPPORT, systemPromptOnResume: 'resent', interrupt: async () => undefined, run: async () => { throw Error('unused'); }, startSession: (_spec, emit) => {
      child = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{}); console.log('ready'); setInterval(()=>{},1000)"], { stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout!.once('data', () => { ready = true; if (phase === 'parked') emit?.({ type: 'turn-end' }); });
      const result = new Promise<never>((_resolve, reject) => child!.once('close', () => reject(Error('stopped'))));
      return { pid: child.pid, result, open: true, sendMessage: () => false, sendAgentMessage: () => false, discardQueuedMessages: () => {}, holdsHumanInput: () => false, interrupt: () => { child!.kill('SIGTERM'); }, end: () => { child!.kill('SIGTERM'); } };
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
    vi.spyOn(runners, 'createRunner').mockReturnValue({ backend: 'claude', specSupport: CLAUDE_SPEC_SUPPORT, systemPromptOnResume: 'resent', interrupt: async () => undefined,
      run: async () => { throw Error('unused'); }, startSession: () => {
        if (++launches > 1) return { result: Promise.resolve({ text: '', toolCalls: [], tokensUsed: 0 }), open: false,
          sendMessage: () => false, sendAgentMessage: () => false, discardQueuedMessages: () => {}, holdsHumanInput: () => false, interrupt() {}, end() {} };
        child = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{}); console.log('ready'); setInterval(()=>{},1000)"],
          { cwd: workspace(w).path, stdio: ['ignore', 'pipe', 'pipe'] });
        child.stdout!.once('data', () => { ready = true; });
        const result = new Promise<{ text: string; toolCalls: []; tokensUsed: number }>(resolve => child!.once('close', () => resolve({ text: '', toolCalls: [], tokensUsed: 0 })));
        return { pid: child.pid, result, open: true, sendMessage: () => true, sendAgentMessage: () => Promise.resolve(), discardQueuedMessages: () => {}, holdsHumanInput: () => false,
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
    const runnerSpy = vi.spyOn(runners, 'createRunner').mockReturnValue({ backend: 'claude', specSupport: CLAUDE_SPEC_SUPPORT, systemPromptOnResume: 'resent', interrupt: async () => undefined, run: async () => { throw Error('unused'); }, startSession: () => { throw Error('startup failed'); } });
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
    vi.spyOn(runners, 'createRunner').mockReturnValue({ backend: 'claude', specSupport: CLAUDE_SPEC_SUPPORT, systemPromptOnResume: 'resent', interrupt: async () => undefined,
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
      vi.spyOn(runners, 'createRunner').mockReturnValue({ backend: 'claude', specSupport: CLAUDE_SPEC_SUPPORT, systemPromptOnResume: 'resent', interrupt: async () => undefined,
        run: async () => { throw Error('unused'); }, startSession: () => {
          if (++launches > 1) return { result: Promise.resolve({ text: 'resumed', toolCalls: [], tokensUsed: 0 }), open: false,
            sendMessage: () => false, sendAgentMessage: () => false, discardQueuedMessages: () => {}, holdsHumanInput: () => false, interrupt() {}, end() {} };
          const proc = spawn(process.execPath, ['-e', TERM_IGNORING], { cwd: workspace(w).path, stdio: ['ignore', 'pipe', 'ignore'] });
          releases.push(() => proc.kill('SIGKILL'));
          const exited = new Promise<void>(resolve => proc.once('exit', () => resolve()));
          first = { proc, exited }; proc.stdout!.once('data', () => ready());
          const result = exited.then(() => ({ text: '', toolCalls: [] as [], tokensUsed: 0 }));
          return { pid: proc.pid, result, open: true, sendMessage: () => true, sendAgentMessage: () => Promise.resolve(), discardQueuedMessages: () => {}, holdsHumanInput: () => false,
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
      // A leader spawned outside spawnSessionLeader records no group (hearsay-tools/cezarion#890): pid-only reaping.
      expect(readRecord(w.id).processes.map(entry => 'pgid' in entry)).toEqual([false]);
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
      type ScanRead = { cwd?: string; readlinkError?: string };
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
        // Each cwd read starts a fresh probe for this PID.
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
          // Every reported PID must have been observed by the real scan as a readable cwd holder:
          // an unreadable cwd is no evidence (hearsay-tools/cezarion#889).
          if (process.platform === 'linux') {
            const targets = [workspace(w).path, ...agentTmpDirLocations(join(root, '.ai/cezar'), w.id)]
              .map(path => { try { return realpathSync(path); } catch { return path; } });
            for (const entry of blockerDiagnostics) {
              const scan = blockerReads.get(entry.pid);
              expect(scan, JSON.stringify({ ...entry, cwd: entry.cwd?.slice(0, 160) })).toBeDefined();
              const cwd = scan?.cwd?.replace(/ \(deleted\)$/, '');
              expect(cwd !== undefined && targets.some(target => cwd === target || cwd.startsWith(target + sep)),
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
      const cadence = other as unknown as { orphanBackoff: Backoff };
      // After the fast window a slow probe remains the wake source; it never gives up.
      cadence.orphanBackoff = window === 'inside' ? { fastMs: 100, fastCount: 60, capMs: 3_600_000 } : { fastMs: 600_000, fastCount: 0, capMs: 100 };
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

    it('scan-only survivors share one /proc scan per reprobe tick, and the reprobe backs off (hearsay-tools/cezarion#879)', async () => {
      const ids: string[] = []; const holders: Awaited<ReturnType<typeof spawnReady>>[] = [];
      for (let i = 0; i < 2; i++) {
        const w = await worker(); store.commitWorkerExecutionStart(w.id);
        const created = await ensureOwnedWorkspace(root, store.getRun(w.id)!);
        store.updateRun(w.id, { status: 'failed', worktreePath: created.path, branch: created.branch });
        rmSync(recordPath(w.id), { force: true }); // legacy: the cwd scan is the only evidence
        holders.push(await spawnReady(created.path)); ids.push(w.id);
      }
      type Cadence = { orphanBackoff: Backoff; orphanDue: Map<string, { at: number; attempts: number }>; armOrphanReprobe(id: string): void };
      const cadence = manager as unknown as Cadence;
      cadence.orphanBackoff = { fastMs: 400, fastCount: 2, capMs: 1_600 };
      const listings = () => vi.mocked(fs.readdirSync).mock.calls.filter(([path]) => path === '/proc').length;
      // The clock is fake too, so arming the two orphans one after the other cannot drift them apart
      // under load: recovery arms its orphans in one synchronous pass.
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      try {
        for (const id of ids) cadence.armOrphanReprobe(id);
        const before = listings();
        await vi.advanceTimersByTimeAsync(400);
        expect(listings() - before).toBe(1);
        expect(ids.map(id => store.readWorkerExecution(id)?.phase)).toEqual(['starting', 'starting']);
        expect(ids.map(id => cadence.orphanDue.get(id)?.attempts)).toEqual([1, 1]);
        // Then 400, 800 and 1,600 ms: past the fast window it doubles to the cap.
        await vi.advanceTimersByTimeAsync(400 + 800 + 1_600);
        expect(listings() - before).toBe(4);
        expect(ids.map(id => cadence.orphanDue.get(id)?.attempts)).toEqual([4, 4]);
        expect(cadence.orphanDue.get(ids[0]!)!.at - Date.now()).toBeGreaterThan(1_500);
        for (const holder of holders) { holder.proc.kill('SIGKILL'); await holder.exited; }
        await vi.advanceTimersByTimeAsync(1_700);
        expect(ids.map(id => store.readWorkerExecution(id)?.phase)).toEqual(['complete', 'complete']);
        expect(cadence.orphanDue.size).toBe(0);
      } finally { vi.useRealTimers(); }
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

    it.runIf(process.platform === 'linux')('an unreadable process in the worktree is no evidence: destroy finalizes a legacy generation without signalling it (hearsay-tools/cezarion#889)', async () => {
      const w = await worker(); await ensureOwnedWorkspace(root, w);
      store.commitWorkerExecutionStart(w.id); store.updateRun(w.id, { status: 'failed' }); store.flush();
      manager.dispose(); store.close(); rmSync(recordPath(w.id)); // an absent legacy ledger leaves the scan as the only evidence
      const holder = await nonDumpableHolder(workspace(w).path);
      const reopened = RunStore.open(join(root, '.ai/cezar'), { keepLive: true }); const other = new RunManager(reopened, root);
      const service = new DelegationService(); const detach = service.registerProject({ id: 'reopened', root, store: reopened, manager: other });
      Object.assign(service, { terminationTimeoutMs: 1_500 });
      try {
        expect(await service.destroyForHuman('reopened', w.id)).toMatchObject({ state: 'complete', remaining: [] });
        expect(reopened.readWorkerExecution(w.id)).toMatchObject({ phase: 'complete' });
        expect(reopened.readWorkerExecution(w.id)?.abandoned).toBeUndefined();
        expect(existsSync(workspace(w).path)).toBe(false);
        expect(holder.running).toBe(true); // its cwd is gone, but nothing signalled it
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

  describe('unreadable processes at destroy (hearsay-tools/cezarion#889)', () => {
    const branchExists = (branch: string) => execFileSync('git', ['branch', '--list', branch], { cwd: root, encoding: 'utf8' }).includes(branch);
    /** A settled worker with a materialized worktree; the scratch stays unmaterialized. */
    async function settled() {
      const w = await worker();
      // Admission runs before the worktree exists, so it never scans an ambient holder.
      const generation = store.commitWorkerExecutionStart(w.id);
      await ensureOwnedWorkspace(root, w);
      store.updateRun(w.id, { status: 'done' }); store.commitWorkerExecutionComplete(w.id, generation); store.flush();
      const service = new DelegationService(); const detach = service.registerProject({ id: 'p', root, store, manager });
      return { w, service, detach };
    }

    // Login sshd, systemd --user and gpg-agent are non-dumpable, so their cwds are unreadable.
    // Neither their age nor their parent chain matters any more: an unreadable cwd is no evidence.
    it.runIf(process.platform === 'linux')('completes when the only unreadable cwds belong to session daemons and a later sshd', async () => {
      const daemons = [await nonDumpableHolder(root)];
      const { w, service, detach } = await settled();
      const later = [await nonDumpableHolder(tmpdir()), await nonDumpableHolder(workspace(w).path)];
      try {
        expect(await service.destroyForHuman('p', w.id)).toMatchObject({ state: 'complete', remaining: [] });
        expect(existsSync(workspace(w).path)).toBe(false); expect(branchExists(workspace(w).branch)).toBe(false);
        for (const holder of [...daemons, later[0]!]) await holder.write(); // never signalled
        expect(later[1]!.running).toBe(true); // its cwd is gone, so it cannot write; nothing signalled it
      } finally { detach(); for (const holder of [...daemons, ...later]) await holder.close(); }
    });

    it('win32 has no cwd scan: destroy removes an unheld worktree instead of staying unknown', async () => {
      const { w, service, detach } = await settled();
      const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
      // Windows refuses to delete a directory a process holds, so the checked removal is the proof there.
      Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
      try {
        expect(await service.destroyForHuman('p', w.id)).toMatchObject({ state: 'complete', remaining: [] });
      } finally { Object.defineProperty(process, 'platform', platform); detach(); }
      expect(existsSync(workspace(w).path)).toBe(false); expect(branchExists(workspace(w).branch)).toBe(false);
    });

    it('win32 admission is judged by recorded processes: a live one refuses reuse, and Continue works once it exits', async () => {
      const w = await worker();
      const generation = store.commitWorkerExecutionStart(w.id);
      await ensureOwnedWorkspace(root, w);
      const recorded = spawn(process.execPath, ['-e', "console.log('ready'); setInterval(()=>{},1000)"], { cwd: tmpdir(), stdio: ['ignore', 'pipe', 'ignore'] });
      const exited = new Promise(resolve => recorded.once('exit', resolve));
      releases.push(() => recorded.kill('SIGKILL'));
      await new Promise(resolve => recorded.stdout!.once('data', resolve));
      expect(store.appendWorkerProcess(w.id, generation, recorded.pid!)).toBe(true);
      store.updateRun(w.id, { status: 'done' }); store.commitWorkerExecutionComplete(w.id, generation); store.flush();
      const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
      // No cwd scan exists on win32 (hearsay-tools/cezarion#889). Before, an `unknown` scan refused
      // every materialized worker's next generation, so Continue never worked there.
      Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
      try {
        expect(() => store.commitWorkerExecutionStart(w.id)).toThrow(/reuse is not proven safe/);
        recorded.kill('SIGKILL'); await exited;
        expect(store.commitWorkerExecutionStart(w.id)).not.toBe(generation);
      } finally { Object.defineProperty(process, 'platform', platform); }
    });

    it.each(['worktree', 'scratch'] as const)('retains resources and names the PID of a process whose cwd is in the %s', async location => {
      const { w, service, detach } = await settled();
      const cwd = location === 'worktree' ? workspace(w).path : agentTmpDir(join(root, '.ai/cezar'), w.id);
      mkdirSync(cwd, { recursive: true });
      const holder = spawn(process.execPath, ['-e', "console.log('ready'); setInterval(()=>{},1000)"], { cwd, stdio: ['ignore', 'pipe', 'ignore'] });
      const exited = new Promise(resolve => holder.once('exit', resolve));
      releases.push(() => holder.kill('SIGKILL'));
      await new Promise(resolve => holder.stdout!.once('data', resolve));
      try {
        const result = await service.destroyForHuman('p', w.id);
        expect(result).toMatchObject({ state: 'incomplete', remaining: ['worktree', 'branch'] });
        expect(result.error).toContain(String(holder.pid));
        expect(existsSync(workspace(w).path)).toBe(true); expect(holder.exitCode).toBeNull(); expect(holder.signalCode).toBeNull();
        holder.kill('SIGKILL'); await exited;
        expect(await service.destroyForHuman('p', w.id)).toMatchObject({ state: 'complete', remaining: [] });
      } finally { holder.kill('SIGKILL'); await exited; detach(); }
    });
  });

  // hearsay-tools/cezarion#890: the leader is spawned as a runner spawns it, in its own process
  // group, and leaves one member working in the worktree.
  describe('agent session process groups (hearsay-tools/cezarion#890)', () => {
    type Entry = { pid: number; startToken?: string; pgid?: number };
    const recordPath = (id: string) => join(root, '.ai/cezar/runs', `${id}.processes.json`);
    const readRecord = (id: string) => JSON.parse(readFileSync(recordPath(id), 'utf8')) as { generation: string; controller: Entry; processes: Entry[] };
    const branchExists = (branch: string) => execFileSync('git', ['branch', '--list', branch], { cwd: root, encoding: 'utf8' }).includes(branch);
    /** A zombie has exited; only its reaper's wait remains. */
    const alive = (pid: number) => {
      try { process.kill(pid, 0); } catch { return false; }
      if (process.platform !== 'linux') return true;
      try { const stat = readFileSync(`/proc/${pid}/stat`, 'utf8'); return stat.slice(stat.lastIndexOf(')') + 1).trim()[0] !== 'Z'; } catch { return false; }
    };

    /** `member`: a SIGTERM-ignoring child in the leader's group, or a SIGTERM-sensitive one that
     * left it with setsid. `leader`: stays up, or exits 0 on its own once the member runs. Before
     * it exits, one scan sees the member as its descendant, so the fixture's scoped enumeration
     * still counts it after it is reparented. */
    async function groupedWorker(opts: { member: 'group' | 'setsid'; leader: 'stay' | 'exit' }) {
      const w = await worker();
      const member = opts.member === 'setsid' ? "process.on('SIGTERM',()=>process.exit(42)); setInterval(()=>{},1000)" : "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)";
      const script = `const m = require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(member)}], { stdio: 'ignore', detached: ${opts.member === 'setsid'} });
console.log(String(m.pid)); ${opts.leader === 'exit' ? "m.unref(); process.stdin.on('end', () => process.exit(0)).resume();" : 'setInterval(()=>{},1000);'}`;
      let leader: ChildProcessWithoutNullStreams | undefined; let ready!: (pid: number) => void;
      const memberPid = new Promise<number>(resolve => { ready = resolve; });
      vi.spyOn(runners, 'createRunner').mockReturnValue({ backend: 'claude', specSupport: CLAUDE_SPEC_SUPPORT, systemPromptOnResume: 'resent', interrupt: async () => undefined,
        run: async () => { throw Error('unused'); }, startSession: () => {
          const proc = spawnSessionLeader(process.execPath, ['-e', script], { cwd: workspace(w).path, env: process.env });
          leader = proc;
          releases.push(() => { try { process.kill(-proc.pid!, 'SIGKILL'); } catch { /* gone */ } });
          proc.stdout.once('data', chunk => ready(Number(String(chunk).trim())));
          const result = new Promise<{ text: string; toolCalls: []; tokensUsed: number }>(resolve => proc.once('exit', () => resolve({ text: '', toolCalls: [], tokensUsed: 0 })));
          return { pid: proc.pid, result, open: true, sendMessage: () => true, sendAgentMessage: () => Promise.resolve(), discardQueuedMessages: () => {}, holdsHumanInput: () => false,
            interrupt: () => signalSession(proc, 'SIGTERM'), end: () => signalSession(proc, 'SIGTERM') };
        } });
      manager.enqueueOwnedRun(w.id);
      const pid = await memberPid;
      releases.push(() => { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } });
      expect(processesWithCwdUnder(workspace(w).path)).toContain(pid);
      if (opts.leader === 'exit') leader!.stdin.end();
      return { w, leader: leader!, member: pid };
    }

    it("the ledger records the session leader's process group", async () => {
      const { w, leader } = await groupedWorker({ member: 'group', leader: 'stay' });
      await until(() => existsSync(recordPath(w.id)) && readRecord(w.id).processes.length === 1);
      expect(readRecord(w.id)).toMatchObject({ generation: store.readWorkerExecution(w.id)!.generation,
        processes: [{ pid: leader.pid, pgid: leader.pid, ...(process.platform === 'linux' ? { startToken: expect.any(String) } : {}) }] });
    });

    const service = (projectStore: RunStore, projectManager: RunManager) => {
      (projectManager as unknown as { orphanTermGraceMs: number }).orphanTermGraceMs = 500;
      const delegation = new DelegationService(); delegation.registerProject({ id: 'p', root, store: projectStore, manager: projectManager });
      return delegation;
    };

    it.skipIf(process.platform === 'win32')("destroy ends a finished worker's leftover in its process group", async () => {
      const { w, member } = await groupedWorker({ member: 'group', leader: 'exit' });
      await until(() => !manager.isActive(w.id) && store.readWorkerExecution(w.id)?.phase === 'complete');
      expect(alive(member)).toBe(true);
      expect(await service(store, manager).destroyForHuman('p', w.id)).toMatchObject({ state: 'complete', remaining: [] });
      expect(alive(member)).toBe(false);
      expect(existsSync(workspace(w).path)).toBe(false); expect(branchExists(workspace(w).branch)).toBe(false);
    });

    it.skipIf(process.platform === 'win32')("destroy reaps a crashed generation's recorded group after its leader died", async () => {
      const { w, leader, member } = await groupedWorker({ member: 'group', leader: 'stay' });
      await until(() => existsSync(recordPath(w.id)) && readRecord(w.id).processes.length === 1);
      manager.dispose(); store.updateRun(w.id, { status: 'failed' }); store.flush();
      const corpse = spawn(process.execPath, ['-e', '']); await new Promise(resolve => corpse.once('exit', resolve));
      writeFileSync(recordPath(w.id), JSON.stringify({ ...readRecord(w.id), controller: { pid: corpse.pid!, startToken: '1' } }));
      // Only the leader dies: its member keeps the group, and the worktree, alive.
      const gone = new Promise(resolve => leader.once('exit', resolve)); process.kill(leader.pid!, 'SIGKILL'); await gone;
      expect(alive(member)).toBe(true);
      store.close(); const reopened = RunStore.open(join(root, '.ai/cezar'), { keepLive: true }); const other = new RunManager(reopened, root);
      try {
        expect(await service(reopened, other).destroyForHuman('p', w.id)).toMatchObject({ state: 'complete', remaining: [] });
        expect(alive(member)).toBe(false);
        expect(existsSync(workspace(w).path)).toBe(false);
      } finally { other.dispose(); reopened.flush(); }
    });

    it.skipIf(process.platform === 'win32')("destroy never signals a dead leader's recorded group that holds nothing of the worker", async () => {
      const w = await worker();
      const generation = store.commitWorkerExecutionStart(w.id);
      await ensureOwnedWorkspace(root, w);
      store.updateRun(w.id, { status: 'done' }); store.commitWorkerExecutionComplete(w.id, generation); store.flush();
      // An unrelated group whose number equals the recorded leader's pid, its leader already gone:
      // the shape a double-fork daemon leaves once a freed number is reused.
      const script = `const m = require('child_process').spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)"], { stdio: 'ignore' }); console.log(String(m.pid)); m.unref(); setTimeout(() => process.exit(0), 50);`;
      const foreign = spawn(process.execPath, ['-e', script], { cwd: tmpdir(), detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
      const member = Number(String(await new Promise<Buffer>(resolve => foreign.stdout!.once('data', resolve))).trim());
      releases.push(() => { try { process.kill(member, 'SIGKILL'); } catch { /* gone */ } });
      await new Promise(resolve => foreign.once('exit', resolve));
      expect(alive(member)).toBe(true);
      writeFileSync(recordPath(w.id), JSON.stringify({ ...readRecord(w.id), processes: [{ pid: foreign.pid!, pgid: foreign.pid! }] }));
      const kills = vi.spyOn(process, 'kill');
      expect(await service(store, manager).destroyForHuman('p', w.id)).toMatchObject({ state: 'complete', remaining: [] });
      expect(kills.mock.calls.filter(([pid, signal]) => pid === -foreign.pid! && signal !== 0)).toEqual([]);
      expect(alive(member)).toBe(true);
    });

    it.skipIf(process.platform === 'win32')('a setsid child keeps destroy incomplete and is never signalled', async () => {
      const { w, member } = await groupedWorker({ member: 'setsid', leader: 'exit' });
      await until(() => !manager.isActive(w.id) && store.readWorkerExecution(w.id)?.phase === 'complete');
      const kills = vi.spyOn(process, 'kill');
      const result = await service(store, manager).destroyForHuman('p', w.id);
      expect(result).toMatchObject({ state: 'incomplete', remaining: ['worktree', 'branch'] });
      expect(result.error).toContain(String(member));
      expect(alive(member)).toBe(true);
      expect(kills.mock.calls.filter(([pid, signal]) => Math.abs(pid) === member && signal !== 0)).toEqual([]);
      expect(existsSync(workspace(w).path)).toBe(true);
    });
  });
});
