import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agentTmpDir, agentTmpDirMayExist } from '../runs/agent-tmpdir.ts';
import { manager, store, root, worker, useWorkerWaitFixture } from '../workflows/worker-wait.testkit.ts';
import { scopeFixtureProcesses } from './process-scope.testkit.ts';
import { nonDumpableHolder } from './non-dumpable.testkit.ts';
import { WorkerScratchCleanup } from './scratch-cleanup.ts';

describe('durable scratch cleanup evidence', () => {
  useWorkerWaitFixture();
  beforeEach(() => scopeFixtureProcesses());
  afterEach(() => { vi.restoreAllMocks(); syncBuiltinESMExports(); });

  async function completed() {
    const parent = store.createRun({ title: 'parent', task: 'parent', workflow: 'quick-task', steps: [] });
    store.updateRun(parent.id, { status: 'waiting', delegation: { role: 'root', permissions: ['spawn'], receipts: [] } });
    const run = await worker(parent.id);
    const generation = store.commitWorkerExecutionStart(run.id);
    store.updateRun(run.id, { status: 'cancelled' }); store.commitWorkerExecutionComplete(run.id, generation);
    manager.pauseWorkerCleanup();
    const dataDir = join(root, '.ai/cezar'), scratch = agentTmpDir(dataDir, run.id);
    mkdirSync(scratch, { recursive: true }); writeFileSync(join(scratch, 'keep'), 'durable');
    return { run, generation, dataDir, scratch };
  }

  it.runIf(process.platform === 'linux')('admits fresh absent resources despite ambient denial, but refuses reuse of retained paths', async () => {
    const parent = store.createRun({ title: 'parent', task: 'parent', workflow: 'quick-task', steps: [] });
    store.updateRun(parent.id, { status: 'waiting', delegation: { role: 'root', permissions: ['spawn'], receipts: [] } });
    const run = await worker(parent.id);
    if (run.delegation?.role !== 'worker') throw Error('missing worker');
    const scratch = agentTmpDir(join(root, '.ai/cezar'), run.id);
    const holder = await nonDumpableHolder(root); // outside every worker resource, but unreadable
    try {
      expect(existsSync(run.delegation.workspace.path)).toBe(false);
      expect(agentTmpDirMayExist(join(root, '.ai/cezar'), run.id)).toBe(false);
      const generation = store.commitWorkerExecutionStart(run.id);
      expect(store.readWorkerExecution(run.id)).toMatchObject({ generation, phase: 'starting' });
      store.updateRun(run.id, { status: 'cancelled' }); store.commitWorkerExecutionComplete(run.id, generation);
      manager.pauseWorkerCleanup();
      mkdirSync(scratch, { recursive: true }); writeFileSync(join(scratch, 'retained'), 'task files');
      expect(() => store.commitWorkerExecutionStart(run.id)).toThrow(/resources may still be held/);
      expect(store.readWorkerExecution(run.id)?.generation).toBe(generation);
      await holder.write();
    } finally { await holder.close(); }
  });

  it.each(['execution', 'processes'])('reconstructs and keeps retrying while the private %s evidence is unreadable', async sidecar => {
    const { run, dataDir, scratch } = await completed();
    const path = join(dataDir, 'runs', `${run.id}.${sidecar}.json`), evidence = readFileSync(path);
    writeFileSync(path, '{unreadable');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const cleanup = new WorkerScratchCleanup(store, dataDir, () => false);
    try {
      cleanup.recover(); await vi.advanceTimersByTimeAsync(120_000);
      expect(existsSync(join(scratch, 'keep'))).toBe(true);
      expect(readFileSync(path, 'utf8')).toBe('{unreadable');
      writeFileSync(path, evidence);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(existsSync(scratch)).toBe(false);
    } finally { writeFileSync(path, evidence); cleanup.pause(); vi.useRealTimers(); }
  });

  it.runIf(process.platform === 'linux' && process.getuid?.() !== 0)('permission denial retains a scratch cleanup intent until its path becomes readable', async () => {
    const { run, dataDir, scratch } = await completed();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const cleanup = new WorkerScratchCleanup(store, dataDir, () => false);
    try {
      chmodSync(dirname(scratch), 0);
      expect(existsSync(scratch)).toBe(false); // the ambiguous check the old retry path used
      expect(agentTmpDirMayExist(dataDir, run.id)).toBe(true);
      cleanup.recover(); await vi.advanceTimersByTimeAsync(120_000);
      chmodSync(dirname(scratch), 0o700);
      expect(readFileSync(join(scratch, 'keep'), 'utf8')).toBe('durable');
      await vi.advanceTimersByTimeAsync(60_000);
      expect(existsSync(scratch)).toBe(false);
    } finally { chmodSync(dirname(scratch), 0o700); cleanup.pause(); vi.useRealTimers(); }
  });
});
