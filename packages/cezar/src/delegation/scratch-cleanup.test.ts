import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agentTmpDir, agentTmpDirMayExist, agentTmpEnv, removeAgentTmpDir } from '../runs/agent-tmpdir.ts';
import { manager, store, root, worker, reopenRuntime, useWorkerWaitFixture } from '../workflows/worker-wait.testkit.ts';
import { scopeFixtureProcesses } from './process-scope.testkit.ts';
import { nonDumpableHolder } from './non-dumpable.testkit.ts';
import { WorkerScratchCleanup } from './scratch-cleanup.ts';

describe('durable scratch cleanup evidence', () => {
  useWorkerWaitFixture();
  beforeEach(() => scopeFixtureProcesses());
  afterEach(() => { vi.restoreAllMocks(); syncBuiltinESMExports(); });

  async function completed(location = 'local') {
    const parent = store.createRun({ title: 'parent', task: 'parent', workflow: 'quick-task', steps: [] });
    store.updateRun(parent.id, { status: 'waiting', delegation: { role: 'root', permissions: ['spawn'], receipts: [] } });
    const run = await worker(parent.id);
    const generation = store.commitWorkerExecutionStart(run.id);
    store.updateRun(run.id, { status: 'cancelled' }); store.commitWorkerExecutionComplete(run.id, generation);
    manager.pauseWorkerCleanup();
    const dataDir = join(root, '.ai/cezar'), scratch = location === 'local' ? agentTmpDir(dataDir, run.id) : agentTmpEnv(dataDir, run.id, {}).TMPDIR!;
    if (location === 'fallback') {
      expect(scratch).not.toBe(agentTmpDir(dataDir, run.id));
      expect(existsSync(join(scratch, '.cez-owner'))).toBe(true);
    }
    mkdirSync(scratch, { recursive: true }); writeFileSync(join(scratch, 'keep'), 'durable');
    return { run, generation, dataDir, scratch };
  }

  it.runIf(process.platform === 'linux').each(['corrupt', 'missing', 'quarantined'].flatMap(mode => ['local', 'fallback'].map(location => ({ mode, location }))))('retains held $location scratch across $mode index recovery and retries after the holder exits', async ({ mode, location }) => {
    const { run, dataDir, scratch } = await completed(location);
    const holder = await nonDumpableHolder(scratch);
    try {
      // The helper asserts a real kernel EACCES/EPERM; no cwd or liveness read is mocked.
      await holder.write();
      manager.dispose(); store.flush();
      const index = join(dataDir, 'runs.json');
      if (mode === 'corrupt') writeFileSync(index, '{corrupt');
      else if (mode === 'missing') rmSync(index);
      else {
        const rows = JSON.parse(readFileSync(index, 'utf8'));
        delete rows.find((row: { id: string }) => row.id === run.id).delegation.workspace.resourceId;
        writeFileSync(index, JSON.stringify(rows));
      }
      reopenRuntime();
      expect(store.getRun(run.id)?.delegation?.role).not.toBe('worker');
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      await manager.recover(); await vi.advanceTimersByTimeAsync(120_000);
      expect(existsSync(join(scratch, 'keep'))).toBe(true);
      expect(existsSync(join(dataDir, 'runs', `${run.id}.execution.json`))).toBe(true);
      expect(existsSync(join(dataDir, 'runs', `${run.id}.processes.json`))).toBe(true);
      await holder.write();
      expect(readFileSync(join(scratch, 'holder-writes'), 'utf8')).toBe('still writable\nstill writable\n');
      await holder.close();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(existsSync(scratch)).toBe(false);
    } finally { await holder.close(); removeAgentTmpDir(dataDir, run.id); vi.useRealTimers(); }
  });

  it.each(['legacy intent', 'unknown execution', 'unknown processes'].flatMap(condition => ['local', 'fallback'].map(location => ({ condition, location }))))('retains unindexed $location scratch with $condition until its evidence can authorize cleanup', async ({ condition, location }) => {
    const { run, dataDir, scratch } = await completed(location);
    const evidence = join(dataDir, 'runs', `${run.id}.${condition === 'unknown processes' ? 'processes' : 'execution'}.json`);
    const original = readFileSync(evidence);
    if (condition === 'legacy intent') {
      const proof = JSON.parse(original.toString()); delete proof.scratchCleanup;
      writeFileSync(evidence, JSON.stringify(proof));
    } else writeFileSync(evidence, '{corrupt');
    manager.dispose(); store.flush(); rmSync(join(dataDir, 'runs.json'));
    reopenRuntime(); vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      await manager.recover(); await vi.advanceTimersByTimeAsync(120_000);
      expect(readFileSync(join(scratch, 'keep'), 'utf8')).toBe('durable');
      writeFileSync(evidence, original);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(existsSync(scratch)).toBe(false);
    } finally { removeAgentTmpDir(dataDir, run.id); vi.useRealTimers(); }
  });

  it.runIf(process.platform === 'linux' && process.getuid?.() !== 0)('retries private evidence discovery after directory denial, then clears ordinary orphans too', async () => {
    const { dataDir, scratch } = await completed();
    const files = join(dataDir, 'runs'), orphan = agentTmpDir(dataDir, 'ordinary-orphan');
    mkdirSync(orphan, { recursive: true });
    manager.dispose(); store.flush(); rmSync(join(dataDir, 'runs.json'));
    reopenRuntime(); vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      chmodSync(files, 0);
      await manager.recover(); await vi.advanceTimersByTimeAsync(120_000);
      expect(existsSync(join(scratch, 'keep'))).toBe(true);
      expect(existsSync(orphan)).toBe(true);
      chmodSync(files, 0o700);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(existsSync(scratch)).toBe(false);
      expect(existsSync(orphan)).toBe(false);
    } finally { chmodSync(files, 0o700); vi.useRealTimers(); }
  });

  it('cannot treat a worker with stripped role metadata as an ordinary terminal run or deletable history', async () => {
    const { run, dataDir, scratch } = await completed();
    manager.dispose(); store.flush();
    const index = join(dataDir, 'runs.json'), rows = JSON.parse(readFileSync(index, 'utf8'));
    delete rows.find((row: { id: string }) => row.id === run.id).delegation;
    writeFileSync(index, JSON.stringify(rows)); reopenRuntime();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      await manager.recover(); store.updateRun(run.id, { status: 'cancelled' });
      await vi.advanceTimersByTimeAsync(120_000);
      expect(store.deleteRun(run.id)).toBe(false);
      expect(existsSync(join(scratch, 'keep'))).toBe(true);
      // Restoration of valid ownership permits the existing recovery path to retry it.
      store.updateRun(run.id, { delegation: run.delegation }); manager.recoverWorkerCleanup();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(existsSync(scratch)).toBe(false);
    } finally { vi.useRealTimers(); }
  });

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
