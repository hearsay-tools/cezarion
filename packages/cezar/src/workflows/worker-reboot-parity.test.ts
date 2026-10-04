import { execFileSync } from 'node:child_process';
import fs, { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RUNNER_IDS } from '../core/agent-runner.ts';
import { HARNESS_ADAPTERS } from '../core/harness-parity.testkit.ts';
import { nonDumpableHolder } from '../delegation/non-dumpable.testkit.ts';
import { agentTmpDir } from '../runs/agent-tmpdir.ts';
import { reclaimWorktree } from '../runs/retention.ts';
import { CredentialRegistry } from '../delegation/credentials.ts';
import { DelegationService } from '../delegation/service.ts';
import { manager, store, root, worker, until, semaphore, executions, bookkeeping, reopenRuntime, useWorkerWaitFixture } from './worker-wait.testkit.ts';

// Enumerate only fixture processes to make eventual release independent of host daemons.
// cwd permissions, process tokens, exit, runner wires, Git and all deletion stay real.
function scopeProcesses(pids: number[]) {
  const readdir = fs.readdirSync;
  vi.spyOn(fs, 'readdirSync').mockImplementation(((...args: unknown[]) => String(args[0]) === '/proc'
    ? pids.map(String) : Reflect.apply(readdir, fs, args)) as typeof fs.readdirSync);
  syncBuiltinESMExports();
}

describe.runIf(process.platform === 'linux')('R43 reboot orphan settlement (#738)', { timeout: 30_000 }, () => {
  useWorkerWaitFixture();
  afterEach(() => { vi.restoreAllMocks(); syncBuiltinESMExports(); });

  for (const settleVia of ['collect', 'destroy'] as const) it.each(RUNNER_IDS)(`%s ${settleVia} settles and clears parent Finish while an unreadable holder retains resources until retry after restart`, async runner => {
    // Service collection is opt-in; useWorkerWaitFixture restores the caller's environment.
    process.env.CEZ_DELEGATION = '1';
    const adapter = HARNESS_ADAPTERS[runner];
    process.env.CEZ_DRY_RUN = '0'; process.env[adapter.binEnv] = adapter.mockBin;
    const p = store.createRun({ title: 'parent', task: 'parent', workflow: 'quick-task', steps: [{ id: 'task', kind: 'agent', name: 'Task' }] });
    store.updateRun(p.id, { status: 'waiting', currentStepId: 'task', delegation: { role: 'root', permissions: ['spawn', 'inspect'], receipts: [] } });
    const orphan = await worker(p.id, adapter.scenarios.baseline!);
    store.updateRun(orphan.id, { runner }); manager.enqueueOwnedRun(orphan.id);
    await until(() => store.getRun(orphan.id)?.status === 'waiting');
    const files = join(root, '.ai/cezar/runs');
    const proof = store.readWorkerExecution(orphan.id)!;
    expect(proof.phase).toBe('starting');
    const processes = store.readWorkerProcesses(orphan.id, proof.generation);
    if (typeof processes === 'string') throw Error('missing native process record');
    expect(processes.processes.length).toBeGreaterThan(0);
    manager.requestWorkerStop(orphan.id);
    expect(await manager.awaitRunTermination(orphan.id, 15_000)).toBe(true);

    const twin = await worker(p.id, adapter.scenarios.done!);
    store.updateRun(twin.id, { runner }); manager.enqueueOwnedRun(twin.id);
    await until(() => store.readWorkerExecution(twin.id)?.phase === 'complete');
    expect(store.getRun(twin.id)?.status).toBe('done');
    await Promise.all(executions.splice(0)); await Promise.all(bookkeeping.splice(0));
    manager.dispose();
    const boot = Number(/^btime (\d+)$/m.exec(readFileSync('/proc/stat', 'utf8'))![1]) * 1000;
    store.updateRun(orphan.id, { createdAt: new Date(boot - 60_000).toISOString() });
    store.flush();
    // Restore only crash evidence, not a forged completion: native children have really exited.
    writeFileSync(join(files, `${orphan.id}.execution.json`), JSON.stringify(proof));
    writeFileSync(join(files, `${orphan.id}.processes.json`), JSON.stringify({ ...processes, controller: { pid: 2147483001, startToken: '11111111-1111-4111-8111-111111111111:100' } }));
    const workspace = orphan.delegation?.role === 'worker' ? orphan.delegation.workspace : undefined;
    if (!workspace) throw Error('missing workspace');
    const scratch = agentTmpDir(join(root, '.ai/cezar'), orphan.id);
    mkdirSync(scratch, { recursive: true }); writeFileSync(join(scratch, 'retained'), 'scratch');
    // Unknown location evidence blocks legacy settlement, but cannot negate known-reboot
    // execution proof. The independent cleanup still requires this evidence to recover.
    const receipt = join(scratch, '.cez-fallback-removal.json');
    writeFileSync(receipt, '{corrupt', { mode: 0o600 });
    const holder = await nonDumpableHolder(settleVia === 'collect' ? scratch : workspace.path);
    const scopedPids = [holder.pid]; scopeProcesses(scopedPids);
    reopenRuntime();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const credentials = new CredentialRegistry();
    const caller = credentials.authenticate(credentials.issue('project', p.id, 'test'))!;
    let service = new DelegationService(); let detach = service.registerProject({ id: 'project', root, store, manager });
    let holderClosed = false;
    try {
      expect(await service.collect(caller, { workerId: twin.id })).toMatchObject({ settled: true, status: 'done' });
      expect(manager.finishBlockedReason(p.id)).toContain(orphan.id);
      expect(manager.finish(p.id)).toBe(false);
      if (settleVia === 'destroy') {
        Object.assign(service, { terminationTimeoutMs: 100 });
        expect(await service.destroyForHuman('project', orphan.id)).toMatchObject({ state: 'incomplete', remaining: ['worktree', 'branch'] });
      }
      const resourceProbe = vi.spyOn(fs, 'readlinkSync'); syncBuiltinESMExports();
      resourceProbe.mockClear();
      expect(await service.collect(caller, { workerId: orphan.id })).toMatchObject({ settled: true, status: 'cancelled' });
      expect(existsSync(scratch)).toBe(true);
      expect(resourceProbe.mock.calls.filter(([path]) => String(path).startsWith('/proc/'))).toHaveLength(0);
      expect(store.readWorkerExecution(orphan.id)).toMatchObject({ phase: 'complete', generation: proof.generation });
      expect(manager.finishBlockedReason(p.id)).toBeUndefined();
      expect(manager.finish(p.id)).toBe(true);
      expect(existsSync(scratch)).toBe(true);
      expect(resourceProbe.mock.calls.filter(([path]) => String(path).startsWith('/proc/'))).toHaveLength(0);
      // Restore metadata before testing holder-only deletion/reuse guards below.
      rmSync(receipt);
      await until(() => store.getRun(p.id)?.status === 'done');
      expect(semaphore.busy()).toBe(0);
      await holder.write();
      expect(existsSync(workspace.path)).toBe(true); expect(existsSync(scratch)).toBe(true);
      expect(() => store.commitWorkerExecutionStart(orphan.id)).toThrow();
      // Retention after parent Finish must preserve the same uncertain resources.
      expect(await reclaimWorktree(root, store, store.getRun(orphan.id)!, { claim: run => manager.claimWorktreeReclaim(run.id) })).toBeNull();
      await vi.advanceTimersByTimeAsync(0); // first deferred scratch attempt
      expect(existsSync(scratch)).toBe(true);
      // Collection alone leaves the worktree; scratch has its own retry even without destroy.
      detach(); manager.dispose(); store.flush(); reopenRuntime();
      await manager.recover();
      service = new DelegationService(); detach = service.registerProject({ id: 'project', root, store, manager });
      service.armDestroyRetries('project');
      await vi.advanceTimersByTimeAsync(60_000);
      expect(existsSync(workspace.path)).toBe(true); expect(existsSync(scratch)).toBe(true);
      await holder.write();
      expect(semaphore.busy()).toBe(0);
      expect(manager.continueRun(orphan.id)).toMatchObject({ ok: false });
      expect(store.readWorkerExecution(orphan.id)?.generation).toBe(proof.generation);
      if (settleVia === 'destroy') {
        expect(await service.destroyForHuman('project', orphan.id)).toMatchObject({ state: 'incomplete', remaining: ['worktree', 'branch'] });
      }
      expect(store.canDeleteRun(orphan.id)).toBe(false);
      await holder.close(); holderClosed = true;
      // Production 60s timers, no shortened override or manual scratch cleanup call: real exit
      // clears the kernel denial and recovered cleanup finishes on its next wake.
      await vi.advanceTimersByTimeAsync(60_000);
      if (settleVia === 'collect') {
        expect(existsSync(scratch)).toBe(false);
        expect(existsSync(workspace.path)).toBe(true); // collection never requests worktree removal
        expect(await service.destroyForHuman('project', orphan.id)).toMatchObject({ state: 'complete', remaining: [] });
      }
      vi.useRealTimers();
      await until(() => !existsSync(workspace.path) && !existsSync(scratch));
      await until(() => store.getRun(orphan.id)?.delegation?.role === 'worker' &&
        (store.getRun(orphan.id)!.delegation as { destroy?: { phase: string } }).destroy?.phase === 'complete');
      expect(execFileSync('git', ['branch', '--list', workspace.branch], { cwd: root, encoding: 'utf8' }).trim()).toBe('');
      expect(store.readWorkerResult(p.id, orphan.id)).toMatchObject({ settled: true, cleanup: 'complete' });
      expect(store.getRun(p.id)?.status).toBe('done');
      expect(store.canDeleteRun(orphan.id)).toBe(true);
      // With every resource physically absent, an ambient denial cannot strand history.
      const ambient = await nonDumpableHolder(root); scopedPids.push(ambient.pid);
      try { expect(store.canDeleteRun(orphan.id)).toBe(true); } finally { await ambient.close(); }
      // A completed cleanup/checkpoint cannot authorize later history removal over a new holder.
      mkdirSync(scratch, { recursive: true });
      const later = await nonDumpableHolder(scratch); scopedPids.push(later.pid);
      try {
        expect(store.deleteRun(orphan.id)).toBe(false);
        expect(existsSync(join(files, `${orphan.id}.processes.json`))).toBe(true);
        expect(existsSync(join(files, `${orphan.id}.execution.json`))).toBe(true);
        await later.write();
      } finally { await later.close(); }
      expect(store.deleteRun(orphan.id)).toBe(true);
      expect(existsSync(scratch)).toBe(false);
    } finally { detach(); credentials.close(); if (!holderClosed) await holder.close(); vi.useRealTimers(); }
  });
  it.each(RUNNER_IDS)('%s refuses reuse until the real holder exits and a stale cleanup wake preserves the next native execution', async runner => {
    process.env.CEZ_DELEGATION = '1';
    const adapter = HARNESS_ADAPTERS[runner];
    process.env.CEZ_DRY_RUN = '0'; process.env[adapter.binEnv] = adapter.mockBin;
    const p = store.createRun({ title: 'parent', task: 'parent', workflow: 'quick-task', steps: [{ id: 'task', kind: 'agent', name: 'Task' }] });
    store.updateRun(p.id, { status: 'waiting', currentStepId: 'task', delegation: { role: 'root', permissions: ['spawn', 'inspect'], receipts: [] } });
    const w = await worker(p.id, adapter.scenarios.baseline!);
    store.updateRun(w.id, { runner }); manager.enqueueOwnedRun(w.id);
    await until(() => store.getRun(w.id)?.status === 'waiting');
    manager.requestWorkerStop(w.id); expect(await manager.awaitRunTermination(w.id, 15_000)).toBe(true);
    await Promise.all(executions.splice(0)); await Promise.all(bookkeeping.splice(0));
    const generation = store.readWorkerExecution(w.id)!.generation;
    const scratch = agentTmpDir(join(root, '.ai/cezar'), w.id);
    mkdirSync(scratch, { recursive: true }); writeFileSync(join(scratch, 'retained'), 'old task scratch');
    const holder = await nonDumpableHolder(scratch); let closed = false;
    const scoped = [holder.pid]; scopeProcesses(scoped);
    try {
      manager.pauseWorkerCleanup();
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      manager.recoverWorkerCleanup(); await vi.advanceTimersByTimeAsync(0);
      expect(manager.continueRun(w.id)).toMatchObject({ ok: false });
      expect(store.readWorkerExecution(w.id)?.generation).toBe(generation);
      await holder.write();
      await holder.close(); closed = true;
      // Pending retry is still captured against generation one. Admit generation two using
      // the real native continuation and give it task scratch before that old timer fires.
      expect(manager.continueRun(w.id)).toMatchObject({ ok: true });
      const next = store.readWorkerExecution(w.id)!; expect(next.generation).not.toBe(generation);
      writeFileSync(join(scratch, 'new-generation'), next.generation);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(readFileSync(join(scratch, 'new-generation'), 'utf8')).toBe(next.generation);
      vi.useRealTimers();
      await until(() => store.getRun(w.id)?.status === 'waiting');
      const record = store.readWorkerProcesses(w.id, next.generation);
      expect(typeof record).toBe('object');
      if (typeof record !== 'string') scoped.push(...record.processes.map(entry => entry.pid));
      manager.requestWorkerStop(w.id); expect(await manager.awaitRunTermination(w.id, 15_000)).toBe(true);
      await until(() => !existsSync(scratch));
    } finally { if (!closed) await holder.close(); vi.useRealTimers(); }
  });

});
