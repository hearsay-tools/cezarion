import { testHome } from '../home/test-home.testkit.ts';
import { setRunStatus } from '../runs/run-store.testkit.ts';
import { RUN_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { createFixtureManager, fixtureWork } from './fixture-cleanup.testkit.ts';

import { randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { resolveAgentTmpDir } from '../runs/agent-tmpdir.ts';
import { removeOwnedWorkspace } from '../delegation/workspace.ts';
import { isReclaimable, rematerializeReclaimedWorktree } from '../runs/retention.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import * as config from '../config.ts';
import * as worktrees from '../git-worktree.ts';
import * as profiles from '../workspace/agent-profiles.ts';

import * as runners from '../core/runner-factory.ts';
import { CLAUDE_SPEC_SUPPORT } from '../core/claude-cli-runner.ts';
import { RunManager } from './run.ts';
import { acquireInertCiResources } from '../ci-wait/inert-ci-resources.testkit.ts';
import { DelegationService } from '../delegation/service.ts';

import { monitoringWakeOf } from './waits.testkit.ts';
import { HANG_GUARD_MS, until, gate, root, store, manager, parent, releases, worker, workspace, destroy, useWorkerDestroyFixture, replaceWorkerDestroyManager } from './worker-destroy.testkit.ts';
import { createRunner } from '../core/runner-factory.ts';

// Real Git, durable fsync checkpoints and process shutdown share this outer budget.
// Keep the separate 15s state/termination assertions and actual runner timers intact.
describe('worker termination barrier', { timeout: 30_000 }, () => {
  useWorkerDestroyFixture();
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
    const other = new RunManager(reopened, root, { acquireCiResources: acquireInertCiResources, createRunner, home: testHome() }); expect(await other.awaitRunTermination(w.id, 10)).toBe(true); other.dispose(); reopened.flush();
  });

  it('requeues a stopped untouched owned worker under normal capacity and preserves parent guards', async () => {
    const w = await worker();
    store.updateRun(w.id, { workflowDef: { name: 'quick-task', source: 'built-in', steps: [{ id: 'task', prompt: '{{task}}' }] } });
    expect(manager.requestWorkerStop(w.id).state).toBe('terminated');
    manager.dispose();
    replaceWorkerDestroyManager(createFixtureManager(store, root, { home: testHome(), semaphore: new WorkspaceSemaphore({ home: testHome(), initial: { maxParallel: 0 } }) }));
    setRunStatus(store, parent.id, RUN_STATUS.review);
    expect(manager.continueRun(w.id)).toMatchObject({ ok: false });
    setRunStatus(store, parent.id, RUN_STATUS.waiting);
    expect(manager.continueRun(w.id, { text: 'keep working' })).toEqual({ ok: true });
    expect(store.getRun(w.id)?.status).toBe('queued');
    expect(store.getRun(w.id)?.steps.map(step => step.id)).toEqual(['task']);
    expect(manager.continueRun(w.id)).toMatchObject({ ok: false });
    expect(manager.requestWorkerStop(w.id).state).toBe('stopping');
    expect(await manager.awaitRunTermination(w.id, 1000)).toBe(true);
    expect(existsSync(workspace(w).path)).toBe(false);
  });

  it('Stop during config preflight waits for startup finalization and prevents launch', async () => {
    const w = await worker(); const hold = gate(); releases.push(hold.release);
    const real = config.loadConfig; let entered = false;
    vi.spyOn(config, 'loadConfig').mockImplementation(async (...args) => { entered = true; await hold.promise; return real(...args); });
    manager.enqueueOwnedRun(w.id);
    // bound: config lookup is the public preflight boundary before any worktree or session.
    await until(() => entered);
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
    const other = new RunManager(reopened, root, { acquireCiResources: acquireInertCiResources, createRunner, home: testHome() });
    const service = new DelegationService(); const detach = service.registerProject({ home: testHome(), id: 'reopened', root, store: reopened, manager: other });
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
    setRunStatus(store, w.id, RUN_STATUS.cancelled); expect(store.commitWorkerExecutionComplete(w.id, generation)).toBe(true);
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
    const reopened = RunStore.open(join(root, '.ai/cezar'), { keepLive: true }); const other = new RunManager(reopened, root, { acquireCiResources: acquireInertCiResources, createRunner, home: testHome() });
    const service = new DelegationService({ terminationTimeoutMs: 50 }); const detach = service.registerProject({ home: testHome(), id: 'reopened', root, store: reopened, manager: other });
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
    const service = new DelegationService(); const detach = service.registerProject({ home: testHome(), id: 'p', root, store, manager });
    try {
      expect(await service.destroyForHuman('p', w.id)).toMatchObject({ state: 'incomplete', remaining: ['worktree', 'branch'] });
    } finally { detach(); }
    expect(readFileSync(receipt, 'utf8')).toBe('{broken');
  });

  it('parked stop waits for process result AND pending turn bookkeeping before allowing destruction', async () => {
    const w = await worker(); const hold = gate(); releases.push(hold.release);
    const real = worktrees.worktreeShortstat;
    const record = vi.spyOn(worktrees, 'worktreeShortstat').mockImplementation(async (...args) => { await hold.promise; return real(...args); });
    manager.enqueueOwnedRun(w.id); await until(() => store.getRun(w.id)?.status === 'waiting');
    expect(record).toHaveBeenCalled();
    destroy(w); expect(manager.requestWorkerStop(w.id).state).toBe('stopping');
    await until(() => [...fixtureWork(root).pending.values()].includes('finishWorkerExecution')
      || store.readWorkerExecution(w.id)?.phase === 'complete');
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
    const w = await worker(); setRunStatus(store, w.id, RUN_STATUS.cancelled, { startedAt: new Date().toISOString() }); store.flush();
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
    manager.dispose(); setRunStatus(store, w.id, status); store.flush();
    store.close(); const reopened = RunStore.open(join(root, '.ai/cezar'), { keepLive: true }); const other = new RunManager(reopened, root, { acquireCiResources: acquireInertCiResources, createRunner, home: testHome() });
    try {
      await other.recover();
      await until(() => !other.isActive(w.id) && reopened.getRun(w.id)?.status !== 'queued');
      expect.soft(reopened.readWorkerExecution(w.id)).toEqual(prior);
      expect.soft(existsSync(scratch)).toBe(true);
      expect.soft(other.continueRun(w.id, { text: 'try again' })).toMatchObject({ ok: false, error: expect.stringContaining('checkpoint') });
      await until(() => !other.isActive(w.id));
      const service = new DelegationService(); service.registerProject({ home: testHome(), id: 'reopened', root, store: reopened, manager: other });
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

  it('destroying and invalid ownership never continue, reclaim, rematerialize or erase history', async () => {
    const w = await worker(); setRunStatus(store, w.id, RUN_STATUS.done, { worktreePath: workspace(w).path, worktreeReclaimedAt: new Date().toISOString() });
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
    await vi.waitFor(() => expect(store.getRun(w.id)?.status).toBe('failed'), { timeout: HANG_GUARD_MS });
    expect(store.getRun(w.id)?.error).toContain('checkpoint');
    expect(existsSync(workspace(w).path)).toBe(false);
  });

  it('startup cancellation survives an asynchronous environment preflight in fresh and continued sessions', async () => {
    const w = await worker();
    const real = profiles.resolveProfileEnvForRoot;
    const environment = vi.spyOn(profiles, 'resolveProfileEnvForRoot');
    for (const continuation of [false, true]) {
      const hold = gate(); releases.push(hold.release); let entered = false;
      environment.mockImplementation(async (...args) => { entered = true; await hold.promise; return real(...args); });
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

  it('queued destruction recovery never launches and missing or stale private evidence remains incomplete', async () => {
    const w = await worker(); destroy(w);
    manager.dispose(); store.close(); const reopened = RunStore.open(join(root, '.ai/cezar'), { keepLive: true }); const other = new RunManager(reopened, root, { acquireCiResources: acquireInertCiResources, createRunner, home: testHome() });
    await other.recover(); expect(reopened.getRun(w.id)?.status).toBe('queued');
    expect(other.isActive(w.id)).toBe(false); expect(existsSync(workspace(w).path)).toBe(false);
    rmSync(join(root, '.ai/cezar/runs', `${w.id}.execution.json`));
    expect(other.requestWorkerStop(w.id).state).toBe('stopping');
    expect(await other.awaitRunTermination(w.id, 10)).toBe(false); other.dispose(); reopened.flush();
  });

  it('rejects human queued/startup input under destruction or parent Finish intent', async () => {
    const w = await worker();
    if (parent.delegation?.role !== 'root') throw Error('fixture');
    store.commitDelegation([{ id: parent.id, delegation: { ...parent.delegation, finishRequestedAt: new Date().toISOString() } }]);
    manager.enqueueOwnedRun(w.id);
    expect(manager.enqueueMessage(w.id, [{ type: 'text', text: 'new work' }])).toBeNull();
    store.move(parent.id, 'cancel-root');
    setRunStatus(store, parent.id, RUN_STATUS.waiting);
    const another = await worker(); const hold = gate(); releases.push(hold.release);
    const real = config.loadConfig; let entered = false;
    vi.spyOn(config, 'loadConfig').mockImplementation(async (...args) => { entered = true; await hold.promise; return real(...args); });
    manager.enqueueOwnedRun(another.id);
    // bound: config lookup holds this worker before it can open a session.
    await until(() => entered);
    destroy(another);
    expect(manager.deferMessage(another.id, [{ type: 'text', text: 'new work' }])).toBe(false);
    manager.requestWorkerStop(another.id); hold.release(); expect(await manager.awaitRunTermination(another.id, 15_000)).toBe(true);
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

  it('destruction intent prevents synthetic monitoring wake bookkeeping before stop is sent', async () => {
    const w = await worker('mock:schedule-wakeup keep going');
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] }); releases.push(() => vi.useRealTimers());
    manager.enqueueOwnedRun(w.id); await until(() => !!monitoringWakeOf(store.getRun(w.id)));
    const deadline = monitoringWakeOf(store.getRun(w.id))!;
    destroy(w); await vi.advanceTimersByTimeAsync(Date.parse(deadline) - Date.now() + 1);
    // An automatic wake must neither advance the durable deadline nor publish a wake event.
    expect(monitoringWakeOf(store.getRun(w.id))).toBe(deadline);
    expect(store.readEvents(w.id).some(event => event.type === 'note' && typeof event.message === 'string' && event.message.includes('automatic monitoring wake-up'))).toBe(false);
    vi.useRealTimers();
  });
});
