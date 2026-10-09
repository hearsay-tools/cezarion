import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import fs, { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RUNNER_IDS } from '../core/agent-runner.ts';
import { HARNESS_ADAPTERS } from '../core/harness-parity.testkit.ts';
import { CredentialRegistry } from '../delegation/credentials.ts';
import { DelegationService } from '../delegation/service.ts';
import { nonDumpableHolder } from '../delegation/non-dumpable.testkit.ts';
import { processStartToken } from '../delegation/process-liveness.ts';
import { withWorktreeMutation } from '../git-worktree-lock.ts';
import { isLiveRecord } from '../runs/run-row.ts';
import { historyPaths } from '../runs/history-file.ts';
import { TranscriptFactsQueue } from '../runs/transcript-facts-queue.ts';
import { agentTmpDir } from '../runs/agent-tmpdir.ts';
import { manager, store, root, worker, until, executions, bookkeeping, reopenRuntime, useWorkerWaitFixture } from './worker-wait.testkit.ts';

// Only enumeration is synthetic. Native wires, tokens, kernel cwd denial, cancellation,
// persistence, Git locking, collection and parent Finish are real.
describe.runIf(process.platform === 'linux')('R47 same-boot interrupted worker settlement (hearsay-tools/cezarion#839, hearsay-tools/cezarion#889)', { timeout: 30_000 }, () => {
  useWorkerWaitFixture({ processScope: false });
  afterEach(() => { vi.restoreAllMocks(); syncBuiltinESMExports(); });
  it.each(RUNNER_IDS)('%s R53 cold terminal starting-proof recovery repairs execution without a synchronous facts join', async runner => {
    process.env.CEZ_DELEGATION = '1'; process.env.CEZ_DRY_RUN = '0';
    const adapter = HARNESS_ADAPTERS[runner]; process.env[adapter.binEnv] = adapter.mockBin;
    const p = store.createRun({ title: 'parent', task: 'parent', workflow: 'quick-task', steps: [] });
    store.updateRun(p.id, { status: 'waiting', delegation: { role: 'root', permissions: ['spawn', 'inspect'], receipts: [] } });
    const w = await worker(p.id, adapter.scenarios.baseline!);
    store.updateRun(w.id, { runner }); manager.enqueueOwnedRun(w.id);
    await until(() => store.getRun(w.id)?.status === 'waiting');
    const proof = store.readWorkerExecution(w.id)!;
    expect(proof.phase).toBe('starting');
    const recorded = store.readWorkerProcesses(w.id, proof.generation);
    if (typeof recorded === 'string') throw Error('missing native process ledger');
    expect(recorded.processes.length).toBeGreaterThan(0);
    manager.requestWorkerStop(w.id); expect(await manager.awaitRunTermination(w.id, 15_000)).toBe(true);
    await Promise.all(executions.splice(0)); await Promise.all(bookkeeping.splice(0)); manager.dispose();
    // Public completion can be durable before its private completion checkpoint.
    store.updateRun(w.id, { status: 'done', stopping: undefined, activity: undefined });
    store.updateRun(p.id, { status: 'done' });
    for (const id of [p.id, w.id]) expect(isLiveRecord(store.getRun(id)!)).toBe(false);
    const dataDir = join(root, '.ai/cezar'); const files = join(dataDir, 'runs');
    const before = store.readEvents(w.id);
    expect(before.length).toBeGreaterThan(0);
    store.flush(); store.close();
    writeFileSync(join(files, `${w.id}.execution.json`), JSON.stringify(proof));
    const boot = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    writeFileSync(join(files, `${w.id}.processes.json`), JSON.stringify({ ...recorded,
      controller: { pid: 2147483001, startToken: `${boot}:100` } }));
    for (const id of [p.id, w.id]) rmSync(historyPaths(dataDir, id).facts, { force: true });
    const joins = vi.spyOn(TranscriptFactsQueue.prototype, 'join');
    reopenRuntime();
    expect(store.listRuns()).toEqual([]); // no live, legacy or deferred family anchor
    expect(store.readWorkerExecution(w.id)).toMatchObject({ phase: 'starting', generation: proof.generation });
    expect(existsSync(historyPaths(dataDir, w.id).facts)).toBe(false);
    // No pre-awaited global warming: boot recovery itself owns readiness.
    await manager.recover();
    expect(joins).not.toHaveBeenCalled();
    expect(store.readWorkerExecution(w.id)).toMatchObject({ phase: 'complete', generation: proof.generation });
    expect(store.readWorkerExecution(w.id)?.abandoned).toBeUndefined();
    expect(store.getRun(w.id)?.status).toBe('done'); expect(store.getRun(p.id)?.status).toBe('done');
    const events = store.readEvents(w.id);
    const repaired = events.filter(e => e.type === 'lifecycle' && /execution was finalized/.test(String(e.message)));
    expect(repaired).toHaveLength(1);
    expect(repaired[0]!.seq).toBeGreaterThan(before.at(-1)!.seq);
    expect(new Set(events.map(e => e.seq)).size).toBe(events.length);
  });
  for (const ledgerKind of ['absent', 'incomplete'] as const) {
    it.each(RUNNER_IDS)(`%s completes destroy once the readable holder exits, while an unreadable process runs (${ledgerKind} ledger)`, async runner => {
      process.env.CEZ_DELEGATION = '1'; process.env.CEZ_DRY_RUN = '0';
      const adapter = HARNESS_ADAPTERS[runner]; process.env[adapter.binEnv] = adapter.mockBin;
      const p = store.createRun({ title: 'parent', task: 'parent', workflow: 'quick-task', steps: [] });
      store.updateRun(p.id, { status: 'waiting', delegation: { role: 'root', permissions: ['spawn', 'inspect'], receipts: [] } });
      const w = await worker(p.id, adapter.scenarios.baseline!);
      store.updateRun(w.id, { runner }); manager.enqueueOwnedRun(w.id);
      await until(() => store.getRun(w.id)?.status === 'waiting');
      const proof = store.readWorkerExecution(w.id)!;
      const recorded = store.readWorkerProcesses(w.id, proof.generation);
      if (typeof recorded === 'string') throw Error('missing native process ledger');
      expect(recorded.processes.length).toBeGreaterThan(0);
      manager.requestWorkerStop(w.id); expect(await manager.awaitRunTermination(w.id, 15_000)).toBe(true);
      await Promise.all(executions.splice(0)); await Promise.all(bookkeeping.splice(0)); manager.dispose();
      const workspace = w.delegation?.role === 'worker' ? w.delegation.workspace : undefined;
      if (!workspace) throw Error('missing workspace');
      const scratch = agentTmpDir(join(root, '.ai/cezar'), w.id);
      mkdirSync(scratch, { recursive: true }); writeFileSync(join(scratch, 'retained'), 'scratch');
      const files = join(root, '.ai/cezar/runs');
      writeFileSync(join(files, `${w.id}.execution.json`), JSON.stringify(proof));
      if (ledgerKind === 'absent') rmSync(join(files, `${w.id}.processes.json`));
      else {
        const boot = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
        // Structurally valid legacy evidence with a missing incarnation token.
        writeFileSync(join(files, `${w.id}.processes.json`), JSON.stringify({ ...recorded,
          controller: { pid: 2147483001, startToken: `${boot}:100` },
          processes: recorded.processes.map(({ pid }) => ({ pid })) }));
      }
      const holder = spawn(process.execPath, ['-e', "process.stdin.resume(); process.stdin.on('end',()=>process.exit(0)); console.log('ready')"],
        { cwd: workspace.path, stdio: ['pipe', 'pipe', 'pipe'] });
      let holderClosed = false;
      const exited = once(holder, 'exit').then(() => { holderClosed = true; });
      await Promise.race([once(holder.stdout, 'data'), exited.then(() => { throw Error('readable holder exited before readiness'); })]);
      const unreadable = await nonDumpableHolder(scratch);
      const readdir = fs.readdirSync; const readlink = fs.readlinkSync;
      vi.spyOn(fs, 'readdirSync').mockImplementation(((...args: unknown[]) => String(args[0]) === '/proc'
        ? [holder.pid!, unreadable.pid].map(String) : Reflect.apply(readdir, fs, args)) as typeof fs.readdirSync);
      let destroying = false; let observedHolder = false; let exitTimer: NodeJS.Timeout | undefined;
      vi.spyOn(fs, 'readlinkSync').mockImplementation(((...args: unknown[]) => {
        const cwd = Reflect.apply(readlink, fs, args);
        if (destroying && String(args[0]) === `/proc/${holder.pid}/cwd` && cwd === workspace.path && !observedHolder) {
          observedHolder = true;
          // Keep the real readable holder alive across a poll, then let it exit normally.
          exitTimer = setTimeout(() => holder.stdin.end(), 750);
        }
        return cwd;
      }) as typeof fs.readlinkSync);
      syncBuiltinESMExports();
      store.updateRun(w.id, { status: 'waiting' }); store.flush(); reopenRuntime();
      const service = new DelegationService(); const detach = service.registerProject({ id: 'project', root, store, manager });
      Object.assign(service, { terminationTimeoutMs: 4_000 });
      try {
        destroying = true;
        // Destroy waits on the readable holder through its polls, then the unreadable process is no evidence.
        expect(await service.destroyForHuman('project', w.id)).toMatchObject({ state: 'complete', remaining: [] });
        expect(observedHolder).toBe(true); expect(holderClosed).toBe(true); expect(holder.exitCode).toBe(0);
        expect(store.readWorkerExecution(w.id)).toMatchObject({ generation: proof.generation, phase: 'complete' });
        expect(store.readWorkerExecution(w.id)?.abandoned).toBeUndefined();
        expect(existsSync(workspace.path)).toBe(false);
        expect(execFileSync('git', ['branch', '--list', '--format=%(refname:short)', workspace.branch], { cwd: root, encoding: 'utf8' }).trim()).toBe('');
        expect(unreadable.running).toBe(true); // never signalled
      } finally {
        clearTimeout(exitTimer); holder.stdin.end(); await exited; await unreadable.close(); detach();
      }
    });
  }
  it.each(RUNNER_IDS)('%s settles a same-boot crash as gone once recorded processes exit, whatever unreadable process runs, and keeps cleanup locks bounded', async runner => {
    process.env.CEZ_DELEGATION = '1'; process.env.CEZ_DRY_RUN = '0';
    const adapter = HARNESS_ADAPTERS[runner]; process.env[adapter.binEnv] = adapter.mockBin;
    const p = store.createRun({ title: 'parent', task: 'parent', workflow: 'quick-task', steps: [{ id: 'task', kind: 'agent', name: 'Task' }] });
    store.updateRun(p.id, { status: 'waiting', currentStepId: 'task', delegation: { role: 'root', permissions: ['spawn', 'inspect'], receipts: [] } });
    const w = await worker(p.id, adapter.scenarios.baseline!);
    store.updateRun(w.id, { runner }); manager.enqueueOwnedRun(w.id);
    await until(() => store.getRun(w.id)?.status === 'waiting');
    const proof = store.readWorkerExecution(w.id)!;
    const recorded = store.readWorkerProcesses(w.id, proof.generation);
    if (typeof recorded === 'string') throw Error('missing native process ledger');
    expect(recorded.processes.length).toBeGreaterThan(0);
    manager.requestWorkerStop(w.id); expect(await manager.awaitRunTermination(w.id, 15_000)).toBe(true);
    await Promise.all(executions.splice(0)); await Promise.all(bookkeeping.splice(0)); manager.dispose();
    const workspace = w.delegation?.role === 'worker' ? w.delegation.workspace : undefined;
    if (!workspace) throw Error('missing workspace');
    const scratch = agentTmpDir(join(root, '.ai/cezar'), w.id);
    mkdirSync(scratch, { recursive: true }); writeFileSync(join(scratch, 'retained'), 'scratch');
    const files = join(root, '.ai/cezar/runs');
    const boot = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    const ledger = { ...recorded, controller: { pid: 2147483001, startToken: `${boot}:100` } };
    writeFileSync(join(files, `${w.id}.execution.json`), JSON.stringify(proof));
    // A real unreadable recorded descendant still blocks settlement, regardless of cwd.
    const descendant = await nonDumpableHolder(root);
    let descendantClosed = false;
    // An unrecorded unreadable process inside the worktree is no evidence (hearsay-tools/cezarion#889).
    const ambient = await nonDumpableHolder(workspace.path); let ambientClosed = false;
    const pids = [descendant.pid, ambient.pid];
    const readdir = fs.readdirSync;
    vi.spyOn(fs, 'readdirSync').mockImplementation(((...args: unknown[]) => String(args[0]) === '/proc'
      ? pids.map(String) : Reflect.apply(readdir, fs, args)) as typeof fs.readdirSync);
    syncBuiltinESMExports();
    writeFileSync(join(files, `${w.id}.processes.json`), JSON.stringify({ ...ledger,
      processes: [...ledger.processes, { pid: descendant.pid, startToken: processStartToken(descendant.pid) }] }));
    store.updateRun(w.id, { status: 'waiting' }); store.flush(); reopenRuntime();
    const credentials = new CredentialRegistry();
    const caller = credentials.authenticate(credentials.issue('project', p.id, 'test'))!;
    let service = new DelegationService(); let detach = service.registerProject({ id: 'project', root, store, manager });
    try {
      const partial = await service.collect(caller, { workerId: w.id });
      expect(partial).toMatchObject({ settled: false });
      expect(manager.finish(p.id)).toBe(false);
      expect(store.readWorkerExecution(w.id)).toMatchObject({ generation: proof.generation, phase: 'starting' });
      await descendant.write(); await descendant.close(); descendantClosed = true;
      // Include PID reuse: ambient PID cannot attest the exited old incarnation.
      writeFileSync(join(files, `${w.id}.processes.json`), JSON.stringify({ ...ledger,
        processes: [...ledger.processes, { pid: ambient.pid, startToken: `${boot}:1` }] }));
      detach(); manager.dispose(); store.flush(); reopenRuntime(); await manager.recover();
      service = new DelegationService(); detach = service.registerProject({ id: 'project', root, store, manager });
      // Exit proof, not abandonment: the generation completes and nothing cancels the task.
      expect(store.readWorkerExecution(w.id)).toMatchObject({ phase: 'complete', generation: proof.generation });
      expect(store.readWorkerExecution(w.id)?.abandoned).toBeUndefined();
      expect(store.readEvents(w.id).some(e => e.type === 'lifecycle' && /execution was finalized/.test(String(e.message)))).toBe(true);
      expect(store.readEvents(w.id).some(e => e.type === 'lifecycle' && /abandoned/.test(String(e.message)))).toBe(false);
      expect(manager.finish(p.id)).toBe(false); // earlier partial collection cannot authorize Finish
      // A live mutation keeper must not be stolen. Release at 5s also bounds the red test:
      // the old unbounded cleanup then wrongly deletes resources after waiting for the keeper.
      let release!: () => void; let entered!: () => void;
      const ready = new Promise<void>(resolve => { entered = resolve; });
      const held = withWorktreeMutation(root, async () => { entered(); await new Promise<void>(resolve => { release = resolve; }); });
      await ready;
      const timer = setTimeout(() => release(), 5_000);
      const lockStart = performance.now();
      try {
        expect(await service.destroyForHuman('project', w.id)).toMatchObject({ state: 'incomplete', remaining: ['worktree', 'branch'], error: expect.stringMatching(/lock.*busy|lock.*timed out/i) });
        expect(performance.now() - lockStart).toBeLessThan(4_000);
        expect(existsSync(workspace.path)).toBe(true);
        expect(execFileSync('git', ['branch', '--list', '--format=%(refname:short)', workspace.branch], { cwd: root, encoding: 'utf8' }).trim()).toBe(workspace.branch);
      } finally { clearTimeout(timer); release(); await held; }
      // Timed-out cleanup must withdraw, so unlocking cannot run it later.
      expect(existsSync(workspace.path)).toBe(true);
      await ambient.write();
      expect(await service.destroyForHuman('project', w.id)).toMatchObject({ state: 'complete', remaining: [] });
      expect(existsSync(workspace.path)).toBe(false);
      expect(ambient.running).toBe(true); // its cwd is gone, but nothing signalled it
      const settled = await service.collect(caller, { workerId: w.id });
      expect(settled).toMatchObject({ settled: true });
      expect(settled.revision).toBe(partial.revision); // settlement does not invent a new execution revision
      expect(manager.finishBlockedReason(p.id)).toBeUndefined(); expect(manager.finish(p.id)).toBe(true);
      await until(() => store.getRun(p.id)?.status === 'done');
    } finally {
      detach(); credentials.close();
      if (!descendantClosed) await descendant.close(); if (!ambientClosed) await ambient.close();
    }
  });
});
