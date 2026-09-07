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
import * as config from '../config.ts';
import * as worktrees from '../git-worktree.ts';
import * as runners from '../core/runner-factory.ts';
import { RunManager } from './run.ts';
import { DelegationService } from '../delegation/service.ts';

const until = async (predicate: () => boolean) => vi.waitFor(() => expect(predicate()).toBe(true), { timeout: 15_000, interval: 10 });
function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }

// Real Git, durable fsync checkpoints and process shutdown share this outer budget.
// Keep the separate 15s state/termination assertions and actual runner timers intact.
describe('worker termination barrier', { timeout: 30_000 }, () => {
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

  it('private never-materialized completion authorizes absent resources across restart and repeated destroy', async () => {
    const w = await worker();
    expect(manager.getWorkerNoMaterializationProof(w.id)).toBeUndefined();
    destroy(w); manager.requestWorkerStop(w.id);
    expect(await manager.awaitRunTermination(w.id, 10)).toBe(true);
    const reopened = RunStore.open(join(root, '.ai/cezar'), { keepLive: true });
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
    vi.spyOn(runners, 'createRunner').mockReturnValue({ backend: 'claude', interrupt: async () => undefined,
      run: async () => { throw Error('unused'); }, startSession: () => {
        expect(manager.deferMessage(w.id, [{ type: 'text', text: 'buffered during startup' }])).toBe(true);
        return { pid: child.pid, result: closed, open: true, sendMessage: () => true, sendAgentMessage: () => true, discardQueuedMessages: () => {},
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
    vi.spyOn(runners, 'createRunner').mockReturnValue({ backend: 'claude', interrupt: async () => undefined, run: async () => { throw Error('unused'); }, startSession: (_spec, emit) => {
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

  it.each(['running', 'queued', 'failed', 'cancelled'] as const)('refuses %s recovery and Continue over a surviving prior process, then refuses real destroy', async status => {
    const w = await worker(); let child: ReturnType<typeof spawn> | undefined; let ready = false; let launches = 0;
    vi.spyOn(runners, 'createRunner').mockReturnValue({ backend: 'claude', interrupt: async () => undefined,
      run: async () => { throw Error('unused'); }, startSession: () => {
        if (++launches > 1) return { result: Promise.resolve({ text: '', toolCalls: [], tokensUsed: 0 }), open: false,
          sendMessage: () => false, sendAgentMessage: () => false, discardQueuedMessages: () => {}, interrupt() {}, end() {} };
        child = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{}); console.log('ready'); setInterval(()=>{},1000)"],
          { cwd: workspace(w).path, stdio: ['ignore', 'pipe', 'pipe'] });
        child.stdout!.once('data', () => { ready = true; });
        const result = new Promise<{ text: string; toolCalls: []; tokensUsed: number }>(resolve => child!.once('close', () => resolve({ text: '', toolCalls: [], tokensUsed: 0 })));
        return { pid: child.pid, result, open: true, sendMessage: () => true, sendAgentMessage: () => true, discardQueuedMessages: () => {},
          interrupt: () => { child!.kill('SIGTERM'); }, end: () => { child!.kill('SIGTERM'); } };
      } });
    releases.push(() => child?.kill('SIGKILL'));
    manager.enqueueOwnedRun(w.id); await until(() => ready);
    const prior = store.readWorkerExecution(w.id)!;
    const scratch = join(root, '.ai/cezar/tmp', w.id, 'retained.txt'); writeFileSync(scratch, 'old process scratch');
    manager.dispose(); store.updateRun(w.id, { status }); store.flush();
    const reopened = RunStore.open(join(root, '.ai/cezar'), { keepLive: true }); const other = new RunManager(reopened, root);
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
    vi.spyOn(runners, 'createRunner').mockReturnValue({ backend: 'claude', interrupt: async () => undefined, run: async () => { throw Error('unused'); }, startSession: () => { throw Error('startup failed'); } });
    manager.enqueueOwnedRun(failure.id); await until(() => store.getRun(failure.id)?.status === 'failed');
    expect(await manager.awaitRunTermination(failure.id, 15_000)).toBe(true);
    vi.restoreAllMocks();
    const live = await worker(); manager.enqueueOwnedRun(live.id); await until(() => store.getRun(live.id)?.status === 'waiting');
    const wait = manager.awaitRunTermination(live.id, 30_000);
    manager.cancel(live.id); manager.dispose();
    expect(await wait).toBe(false);
    expect(store.readWorkerExecution(live.id)?.phase).toBe('starting');
  });

  it('queued destruction recovery never launches and missing or stale private evidence remains incomplete', async () => {
    const w = await worker(); destroy(w); store.flush();
    const reopened = RunStore.open(join(root, '.ai/cezar'), { keepLive: true }); const other = new RunManager(reopened, root);
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
    expect(manager.continueRun(w.id, { text: 'mock:hold' }, true).ok).toBe(true);
    const deferred = store.readWorkerExecution(w.id)!;
    await until(() => store.getRun(w.id)?.status === 'waiting');
    expect(store.readWorkerExecution(w.id)).toEqual(deferred);
    manager.requestWorkerStop(w.id); expect(await manager.awaitRunTermination(w.id, 15000)).toBe(true);
    expect(store.readWorkerExecution(w.id)).toEqual({ generation: deferred.generation, phase: 'complete' });
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
    const indexTemp = join(root, '.ai/cezar/runs.json.tmp'); mkdirSync(indexTemp);
    releases.push(() => rmSync(indexTemp, { recursive: true, force: true }));
    expect(store.commitWorkerExecutionComplete(w.id, generation)).toBe(false);
    expect(store.readWorkerExecution(w.id)?.phase).toBe('starting');
    rmSync(indexTemp, { recursive: true });
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
    vi.spyOn(runners, 'createRunner').mockReturnValue({ backend: 'claude', interrupt: async () => undefined,
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

});
