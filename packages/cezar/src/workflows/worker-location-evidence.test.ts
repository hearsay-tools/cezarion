import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, existsSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RUNNER_IDS } from '../core/agent-runner.ts';
import { HARNESS_ADAPTERS } from '../core/harness-parity.testkit.ts';
import { CredentialRegistry } from '../delegation/credentials.ts';
import { DelegationService } from '../delegation/service.ts';
import { agentTmpDir, agentTmpEnv, agentTmpDirLocations } from '../runs/agent-tmpdir.ts';
import { manager, root, store, worker, until, executions, bookkeeping, reopenRuntime, useWorkerWaitFixture } from './worker-wait.testkit.ts';

// Node's os.tmpdir reads the original environment, including after this fixture replaces process.env.
const nativeEnvironment = process.env;
function setTmpRoot(value: string | undefined) {
  for (const env of [nativeEnvironment, process.env]) {
    if (value === undefined) delete env.TMPDIR; else env.TMPDIR = value;
  }
}

const cases = ['malformed receipt', 'denied receipt', 'malformed pointer', 'denied pointer'];
// Real Git, native runner startup/termination and durable settlement exceed 5s under load.
// Match the worker suites' process-work budget; keep the inner 15s state/termination limits.
describe.runIf(process.platform === 'linux' && process.getuid?.() !== 0)('R43 orphan execution location evidence', { timeout: 30_000 }, () => {
  useWorkerWaitFixture();
  let savedTmpdir: string | undefined;
  const temporaryRoots: string[] = [];
  beforeEach(() => { savedTmpdir = process.env.TMPDIR; });
  afterEach(() => {
    setTmpRoot(savedTmpdir);
    for (const path of temporaryRoots.splice(0)) rmSync(path, { recursive: true, force: true });
    vi.restoreAllMocks(); syncBuiltinESMExports();
  });

  for (const damage of cases) it.each(RUNNER_IDS)(`%s keeps legacy execution unsettled with a real fallback holder and ${damage}`, async runner => {
    process.env.CEZ_DELEGATION = '1';
    const adapter = HARNESS_ADAPTERS[runner];
    process.env.CEZ_DRY_RUN = '0'; process.env[adapter.binEnv] = adapter.mockBin;
    const parent = store.createRun({ title: 'parent', task: 'parent', workflow: 'quick-task', steps: [{ id: 'task', kind: 'agent', name: 'Task' }] });
    store.updateRun(parent.id, { status: 'waiting', currentStepId: 'task', delegation: { role: 'root', permissions: ['spawn', 'inspect'], receipts: [] } });
    const priorTmpdir = process.env.TMPDIR, oldRoot = mkdtempSync('/tmp/cez-old-');
    temporaryRoots.push(oldRoot); setTmpRoot(oldRoot);
    const run = await worker(parent.id, adapter.scenarios.baseline!);
    store.updateRun(run.id, { runner }); manager.enqueueOwnedRun(run.id);
    await until(() => store.getRun(run.id)?.status === 'waiting');
    const proof = store.readWorkerExecution(run.id)!;
    const { generation } = proof;
    const processes = store.readWorkerProcesses(run.id, generation);
    if (typeof processes === 'string') throw Error('missing native process record');
    expect(processes.processes.length).toBeGreaterThan(0);
    manager.requestWorkerStop(run.id);
    expect(await manager.awaitRunTermination(run.id, 15_000)).toBe(true);
    await Promise.all(executions.splice(0)); await Promise.all(bookkeeping.splice(0));
    manager.dispose(); store.flush(); reopenRuntime();
    const dataDir = join(root, '.ai/cezar');
    writeFileSync(join(dataDir, 'runs', `${run.id}.execution.json`), JSON.stringify(proof));
    writeFileSync(join(dataDir, 'runs', `${run.id}.processes.json`), JSON.stringify({
      ...processes, controller: { pid: 2147483001, startToken: '100' },
    }));
    const scratch = agentTmpEnv(dataDir, run.id, {}).TMPDIR!;
    expect(dirname(scratch)).toBe(oldRoot);
    const pointer = join(agentTmpDir(dataDir, run.id), '.cez-fallback');
    const metadata = damage.endsWith('receipt') ? join(agentTmpDir(dataDir, run.id), '.cez-fallback-removal.json') : pointer;
    if (damage.endsWith('receipt')) writeFileSync(metadata, '[]', { mode: 0o600 });
    const original = readFileSync(metadata);
    const holder = spawn(process.execPath, ['-e', `
      const fs = require('node:fs'); process.stdout.write('ready');
      process.stdin.on('data', data => { fs.appendFileSync('holder-writes', data); process.stdout.write('written'); });
      process.stdin.on('end', () => process.exit(0));
    `], { cwd: scratch, stdio: ['pipe', 'pipe', 'inherit'] });
    const exited = once(holder, 'exit'); await once(holder.stdout, 'data');
    const credentials = new CredentialRegistry();
    const caller = credentials.authenticate(credentials.issue('project', parent.id, 'test'))!;
    const service = new DelegationService(); const detach = service.registerProject({ id: 'project', root, store, manager });
    try {
      setTmpRoot('/tmp');
      expect(readlinkSync(`/proc/${holder.pid}/cwd`)).toBe(scratch);
      if (damage.startsWith('denied')) {
        chmodSync(metadata, 0); expect(() => readFileSync(metadata)).toThrow(/EACCES/);
      } else writeFileSync(metadata, '{corrupt');
      expect(manager.settleOrphanedWorkerExecution(run.id, { fresh: true })).toBe(false);
      expect(store.readWorkerExecution(run.id)).toMatchObject({ generation, phase: 'starting' });
      if (damage.endsWith('receipt')) expect(agentTmpDirLocations(dataDir, run.id)).toContain(scratch);
      expect(await service.collect(caller, { workerId: run.id })).toMatchObject({ settled: false });
      expect(manager.finishBlockedReason(parent.id)).toContain(run.id);
      expect(manager.finish(parent.id)).toBe(false);
      const written = once(holder.stdout, 'data'); holder.stdin.write('still writable\n'); await written;
      expect(readFileSync(join(scratch, 'holder-writes'), 'utf8')).toBe('still writable\n');
      holder.stdin.end(); await exited;
      // A clear scan of known locations cannot prove that undiscoverable locations are clear.
      expect(manager.settleOrphanedWorkerExecution(run.id, { fresh: true })).toBe(false);
      chmodSync(metadata, 0o600); writeFileSync(metadata, original);
      expect(manager.settleOrphanedWorkerExecution(run.id, { fresh: true })).toBe(true);
      expect(store.readWorkerExecution(run.id)).toMatchObject({ generation, phase: 'complete' });
      expect(await service.collect(caller, { workerId: run.id })).toMatchObject({ settled: true });
      expect(manager.finishBlockedReason(parent.id)).toBeUndefined();
      expect(manager.finish(parent.id)).toBe(true);
      await until(() => store.getRun(parent.id)?.status === 'done');
      await vi.waitFor(() => expect(existsSync(scratch)).toBe(false));
    } finally {
      detach(); credentials.close();
      holder.stdin.end(); await exited;
      if (existsSync(metadata)) chmodSync(metadata, 0o600);
      setTmpRoot(priorTmpdir); rmSync(oldRoot, { recursive: true, force: true });
    }
  });
});
