import { testHome } from '../home/test-home.testkit.ts';
import { RUN_STATUS, STEP_KIND } from '@open-mercato/cezar-contract/test-factories.testkit';

import { readPid, requirePid } from '../pid-file.testkit.ts';

import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { planOwnedWorkspace } from '../delegation/workspace.ts';
import { workerWorkflowHash } from '../delegation/execution-identity.ts';
import { existsSync, writeFileSync } from "node:fs";
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { RunStore } from '../runs/store.ts';

import * as worktrees from '../autosave-commit.ts';
import * as runners from '../core/runner-factory.ts';
import { CLAUDE_SPEC_SUPPORT } from '../core/claude-cli-runner.ts';
import { RunManager } from './run.ts';
import { acquireInertCiResources } from '../ci-wait/inert-ci-resources.testkit.ts';
import type { WorkflowDef } from './types.ts';
import { createFixtureManager } from './fixture-cleanup.testkit.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';

import { setRunStatus, blockRunWrites } from '../runs/run-store.testkit.ts';

import { HANG_GUARD_MS, until, gate, root, store, manager, parent, releases, worker, workspace, useWorkerDestroyFixture, replaceWorkerDestroyManager } from "./worker-destroy.testkit.ts";
import { createRunner } from '../core/runner-factory.ts';

// Real Git, durable fsync checkpoints and process shutdown share this outer budget.
// Keep the separate 15s state/termination assertions and actual runner timers intact.
describe('worker termination barrier', { timeout: 30_000 }, () => {
  useWorkerDestroyFixture();
  it('completion rotates on Continue; stale completion cannot authorize a newer execution', async () => {
    const w = await worker(); manager.enqueueOwnedRun(w.id); await until(() => store.getRun(w.id)?.status === 'waiting');
    manager.requestWorkerStop(w.id); expect(await manager.awaitRunTermination(w.id, 15_000)).toBe(true);
    const first = store.readWorkerExecution(w.id)!;
    expect(manager.continueRun(w.id, { text: 'mock:hold' }).ok).toBe(true);
    const next = store.readWorkerExecution(w.id)!; expect(next.generation).not.toBe(first.generation); expect(next.phase).toBe('starting');
    expect(store.commitWorkerExecutionComplete(w.id, first.generation)).toBe(false);
    await until(() => store.getRun(w.id)?.status === 'waiting'); manager.requestWorkerStop(w.id);
    expect(await manager.awaitRunTermination(w.id, 15_000)).toBe(true);
    store.close(); const reopened = RunStore.open(join(root, '.ai/cezar'), { keepLive: true }); const other = new RunManager(reopened, root, { acquireCiResources: acquireInertCiResources, createRunner, home: testHome() });
    expect(await other.awaitRunTermination(w.id, 10)).toBe(true); other.dispose(); reopened.flush();
  });

  it('terminal completion and failed session startup both prove finalization, while disposal settles waiters false', async () => {
    const done = await worker('mock:cezar-done'); manager.enqueueOwnedRun(done.id);
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
    manager.dispose();
    const semaphore = new WorkspaceSemaphore({ home: testHome(), initial: { maxParallel: 1 } });
    replaceWorkerDestroyManager(createFixtureManager(store, root, { home: testHome(), semaphore }));
    const w = await worker(); manager.enqueueOwnedRun(w.id); await until(() => store.getRun(w.id)?.status === 'waiting');
    manager.requestWorkerStop(w.id); expect(await manager.awaitRunTermination(w.id, 15000)).toBe(true);
    // Finish the old release sweep: Continue must schedule its own new queue entry.
    await semaphore.release();
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

  it('private completion does not publish when final index persistence fails', async () => {
    const w = await worker(); const generation = store.commitWorkerExecutionStart(w.id);
    setRunStatus(store, w.id, RUN_STATUS.done); store.flush();
    const release = blockRunWrites(join(root, '.ai/cezar'));
    releases.push(release);
    expect(store.commitWorkerExecutionComplete(w.id, generation)).toBe(false);
    expect(store.readWorkerExecution(w.id)?.phase).toBe('starting');
    release();
    expect(store.commitWorkerExecutionComplete(w.id, generation)).toBe(true);
  });

  it('keeps workflow checks inside the termination barrier until the check process closes', async () => {
    const script = join(root, 'controlled-check.cjs');
    writeFileSync(script, "process.on('SIGTERM',()=>{}); const fs = require('node:fs'); fs.writeFileSync('check.pid.tmp', String(process.pid)); fs.renameSync('check.pid.tmp', 'check.pid'); setInterval(()=>{},1000);");
    const workflow: WorkflowDef = { name: 'check barrier fixture', source: 'built-in', steps: [{ id: 'task', command: `exec '${process.execPath}' '${script}'` }] };
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    const owned = await planOwnedWorkspace(root, randomUUID(), sha);
    const w = store.createOwnedRun({ title: 'worker', task: 'check', workflow: workflow.name, workflowDef: workflow,
      runner: 'claude', steps: [{ id: 'task', name: 'Task', kind: STEP_KIND.check }] }, parent.id, randomUUID(), {
      role: 'worker', permissions: [], parentRunId: parent.id, workspace: owned,
    }, 'a'.repeat(64), { kind: 'internal', workflowHash: workerWorkflowHash(workflow) });
    const pidPath = join(workspace(w).path, 'check.pid'); let pid: number | undefined;
    releases.push(() => { if (pid) { try { process.kill(pid, 'SIGKILL'); } catch { /* already closed */ } } });
    manager.enqueueOwnedRun(w.id); await until(() => readPid(pidPath) !== undefined); pid = requirePid(pidPath);
    manager.requestWorkerStop(w.id); expect(await manager.awaitRunTermination(w.id, 30)).toBe(false);
    expect(existsSync(workspace(w).path)).toBe(true);
    process.kill(pid, 'SIGKILL'); pid = undefined;
    expect(await manager.awaitRunTermination(w.id, 15_000)).toBe(true);
    expect(store.getRun(w.id)?.status).toBe('cancelled');
  });

  it('synchronous dequeue hydration failure still finalizes the admitted generation', async () => {
    const w = await worker();
    const read = store.getRun.bind(store); let failedRead = false;
    vi.spyOn(store, 'getRun').mockImplementation(id => {
      const run = read(id);
      if (id !== w.id || !run || failedRead || store.readWorkerExecution(id)?.phase !== 'starting') return run;
      return new Proxy(run, { get(target, key, receiver) {
        if (key === 'queuedMessages') { failedRead = true; throw Error('fixture hydration failed'); }
        return Reflect.get(target, key, receiver);
      } });
    });
    manager.enqueueOwnedRun(w.id);
    await vi.waitFor(() => expect(store.getRun(w.id)?.status).toBe('failed'), { timeout: HANG_GUARD_MS });
    expect(await manager.awaitRunTermination(w.id, 100)).toBe(true);
    expect(existsSync(workspace(w).path)).toBe(false);
    expect(failedRead).toBe(true);
    expect(store.getRun(w.id)?.error).toContain('fixture hydration failed');
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

  it('explicit termination retry can persist finalized same-process evidence after a checkpoint write failure', async () => {
    const w = await worker('mock:cezar-done');
    const complete = vi.spyOn(store, 'commitWorkerExecutionComplete').mockReturnValueOnce(false);
    manager.enqueueOwnedRun(w.id); await until(() => !manager.isActive(w.id));
    expect(store.readWorkerExecution(w.id)?.phase).toBe('starting');
    complete.mockRestore();
    expect(await manager.awaitRunTermination(w.id, 100)).toBe(true);
    expect(store.readWorkerExecution(w.id)?.phase).toBe('complete');
  });
});
