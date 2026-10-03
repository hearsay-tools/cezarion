import { execFileSync } from 'node:child_process';
import fs, { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RUNNER_IDS } from '../core/agent-runner.ts';
import { HARNESS_ADAPTERS } from '../core/harness-parity.testkit.ts';
import { CredentialRegistry } from '../delegation/credentials.ts';
import { DelegationService } from '../delegation/service.ts';
import { manager, store, root, worker, until, executions, bookkeeping, reopenRuntime, useWorkerWaitFixture } from './worker-wait.testkit.ts';

// The OS cannot stage a reboot or an own-user non-dumpable process portably. Inject only
// those /proc reads; native runner wires, process exit, Git and durable lifecycle stay real.
function unreadablePostBootProcess() {
  const pid = '2147483000';
  const readdir = fs.readdirSync, readlink = fs.readlinkSync, stat = fs.statSync, read = fs.readFileSync;
  vi.spyOn(fs, 'readdirSync').mockImplementation(((...args: unknown[]) => String(args[0]) === '/proc'
    ? [...readdir('/proc'), pid] : Reflect.apply(readdir, fs, args)) as typeof fs.readdirSync);
  vi.spyOn(fs, 'readlinkSync').mockImplementation(((...args: unknown[]) => {
    if (String(args[0]) === `/proc/${pid}/cwd`) throw Object.assign(new Error('non-dumpable'), { code: 'EACCES' });
    return Reflect.apply(readlink, fs, args);
  }) as typeof fs.readlinkSync);
  vi.spyOn(fs, 'statSync').mockImplementation(((...args: unknown[]) => String(args[0]) === `/proc/${pid}`
    ? { uid: process.getuid!() } : Reflect.apply(stat, fs, args)) as typeof fs.statSync);
  vi.spyOn(fs, 'readFileSync').mockImplementation(((...args: unknown[]) => String(args[0]) === `/proc/${pid}/stat`
    ? `${pid} (systemd --user) S ${Array(18).fill('0').join(' ')} 100`
    : Reflect.apply(read, fs, args)) as typeof fs.readFileSync);
  syncBuiltinESMExports();
}

describe.runIf(process.platform === 'linux')('R35 reboot orphan settlement (#738)', { timeout: 30_000 }, () => {
  useWorkerWaitFixture();
  afterEach(() => { vi.restoreAllMocks(); syncBuiltinESMExports(); });

  for (const settleVia of ['collect', 'destroy'] as const) it.each(RUNNER_IDS)(`%s ${settleVia} settles and collects a dead worker beside a successful twin, then clears parent Finish`, async runner => {
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
    reopenRuntime(); unreadablePostBootProcess();
    const credentials = new CredentialRegistry();
    const caller = credentials.authenticate(credentials.issue('project', p.id, 'test'))!;
    const service = new DelegationService(); service.registerProject({ id: 'project', root, store, manager });
    try {
      expect(await service.collect(caller, { workerId: twin.id })).toMatchObject({ settled: true, status: 'done' });
      expect(manager.finishBlockedReason(p.id)).toContain(orphan.id);
      expect(manager.finish(p.id)).toBe(false);
      if (settleVia === 'destroy') {
        Object.assign(service, { terminationTimeoutMs: 100 });
        expect(await service.destroyForHuman('project', orphan.id)).toMatchObject({ state: 'complete', remaining: [] });
      }
      expect(await service.collect(caller, { workerId: orphan.id })).toMatchObject({ settled: true, status: 'cancelled' });
      expect(store.readWorkerExecution(orphan.id)).toMatchObject({ phase: 'complete', generation: proof.generation });
      expect(manager.finishBlockedReason(p.id)).toBeUndefined();
      const workspace = orphan.delegation?.role === 'worker' ? orphan.delegation.workspace : undefined;
      expect(workspace).toBeDefined();
      expect(await service.destroyForHuman('project', orphan.id)).toMatchObject({ state: 'complete', remaining: [] });
      expect(existsSync(workspace!.path)).toBe(false);
      expect(execFileSync('git', ['branch', '--list', workspace!.branch], { cwd: root, encoding: 'utf8' }).trim()).toBe('');
      expect(await service.collect(caller, { workerId: orphan.id })).toMatchObject({ settled: true, cleanup: 'complete' });
      expect(manager.finishBlockedReason(p.id)).toBeUndefined();
      expect(manager.finish(p.id)).toBe(true);
      await until(() => store.getRun(p.id)?.status === 'done');
    } finally { credentials.close(); }
  });
});
