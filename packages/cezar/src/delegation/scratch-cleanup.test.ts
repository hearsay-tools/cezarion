import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { agentTmpDir, agentTmpDirMayExist, agentTmpEnv, removeAgentTmpDir } from '../runs/agent-tmpdir.ts';
import { manager, store, root, worker, reopenRuntime, useWorkerWaitFixture } from '../workflows/worker-wait.testkit.ts';
import { nonDumpableHolder } from './non-dumpable.testkit.ts';
import { WorkerScratchCleanup } from './scratch-cleanup.ts';
import { readPersistedRuns, seedRuns } from '../runs/run-store.testkit.ts';

// os.tmpdir reads Node's original environment even after the workflow fixture replaces process.env.
const nativeEnvironment = process.env;
function setTmpRoot(value: string | undefined) {
  for (const env of [nativeEnvironment, process.env]) {
    if (value === undefined) delete env.TMPDIR; else env.TMPDIR = value;
  }
}

describe('durable scratch cleanup evidence', () => {
  useWorkerWaitFixture();
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

  it.runIf(process.platform === 'linux' && process.getuid?.() !== 0)('retains an unreadable old fallback owner and its pointer until ownership and the real holder clear', async () => {
    const priorTmpdir = process.env.TMPDIR;
    const oldRoot = mkdtempSync('/tmp/cez-old-');
    setTmpRoot(oldRoot);
    const { run, generation, dataDir, scratch } = await completed('fallback');
    expect(dirname(scratch)).toBe(oldRoot);
    const local = agentTmpDir(dataDir, run.id), pointer = join(local, '.cez-fallback'), owner = join(scratch, '.cez-owner');
    const child = spawn(process.execPath, ['-e', `
      const fs = require('node:fs'); process.stdout.write('ready');
      process.stdin.on('data', data => { fs.appendFileSync('holder-writes', data); process.stdout.write('written'); });
      process.stdin.on('end', () => process.exit(0));
    `], { cwd: scratch, stdio: ['pipe', 'pipe', 'inherit'] });
    const exited = once(child, 'exit'); await once(child.stdout, 'data');
    const write = async () => { const done = once(child.stdout, 'data'); child.stdin.write('still writable\n'); await done; };
    const cleanup = new WorkerScratchCleanup(store, dataDir, () => false);
    try {
      expect(readlinkSync(`/proc/${child.pid}/cwd`)).toBe(scratch);
      setTmpRoot('/tmp');
      if (run.delegation?.role !== 'worker') throw Error('missing worker');
      expect(store.workerScratchResourcesSafe(run.id, generation, run.delegation.workspace.resourceId)).toBe(false);
      chmodSync(owner, 0);
      expect(() => readFileSync(owner)).toThrow(/EACCES/);
      expect(store.workerScratchResourcesSafe(run.id, generation, run.delegation.workspace.resourceId)).toBe(false);
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      cleanup.recover(); await vi.advanceTimersByTimeAsync(120_000);
      expect(readFileSync(pointer, 'utf8')).toBe(scratch);
      expect(existsSync(join(scratch, 'keep'))).toBe(true);
      await write();
      // Restart reconstruction must also retain the only route to this old temp root.
      cleanup.pause(); cleanup.recover(); await vi.advanceTimersByTimeAsync(60_000);
      chmodSync(owner, 0o600);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(readFileSync(pointer, 'utf8')).toBe(scratch);
      await write();
      expect(readFileSync(join(scratch, 'holder-writes'), 'utf8')).toBe('still writable\nstill writable\n');
      child.stdin.end(); await exited;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(existsSync(scratch)).toBe(false);
      expect(existsSync(local)).toBe(false);
    } finally {
      cleanup.pause(); vi.useRealTimers(); child.stdin.end(); await exited;
      if (existsSync(owner)) chmodSync(owner, 0o600);
      rmSync(oldRoot, { recursive: true, force: true });
      setTmpRoot(priorTmpdir);
    }
  });

  it.runIf(process.platform === 'linux' && process.getuid?.() !== 0)('retains the old fallback pointer after partial removal and retries after its parent becomes writable', async () => {
    const priorTmpdir = process.env.TMPDIR;
    const oldRoot = mkdtempSync('/tmp/cez-old-'); setTmpRoot(oldRoot);
    const { run, dataDir, scratch } = await completed('fallback');
    expect(dirname(scratch)).toBe(oldRoot);
    const pointer = join(agentTmpDir(dataDir, run.id), '.cez-fallback');
    setTmpRoot('/tmp');
    let cleanup = new WorkerScratchCleanup(store, dataDir, () => false);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      chmodSync(oldRoot, 0o500);
      cleanup.recover(); await vi.advanceTimersByTimeAsync(120_000);
      expect(existsSync(scratch)).toBe(true);
      expect(existsSync(pointer)).toBe(true);
      expect(readFileSync(pointer, 'utf8')).toBe(scratch);
      // A new cleanup instance must recover even if recursive rm already removed .cez-owner.
      cleanup.pause(); cleanup = new WorkerScratchCleanup(store, dataDir, () => false); cleanup.recover();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(existsSync(scratch)).toBe(true);
      chmodSync(oldRoot, 0o700);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(existsSync(scratch)).toBe(false);
      expect(existsSync(agentTmpDir(dataDir, run.id))).toBe(false);
    } finally { cleanup.pause(); chmodSync(oldRoot, 0o700); rmSync(oldRoot, { recursive: true, force: true }); vi.useRealTimers();
      setTmpRoot(priorTmpdir);
    }
  });

  it.runIf(process.platform === 'linux' && process.getuid?.() !== 0).each(['missing owner', 'foreign owner'])('a partial-removal receipt cannot delete a replacement fallback with %s', async ownership => {
    const priorTmpdir = process.env.TMPDIR, oldRoot = mkdtempSync('/tmp/cez-old-'); setTmpRoot(oldRoot);
    const { run, dataDir, scratch } = await completed('fallback');
    expect(dirname(scratch)).toBe(oldRoot); setTmpRoot('/tmp');
    const cleanup = new WorkerScratchCleanup(store, dataDir, () => false);
    const displaced = `${scratch}.original`, pointer = join(agentTmpDir(dataDir, run.id), '.cez-fallback');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      chmodSync(oldRoot, 0o500); cleanup.recover(); await vi.advanceTimersByTimeAsync(0);
      expect(existsSync(scratch)).toBe(true);
      chmodSync(oldRoot, 0o700); renameSync(scratch, displaced); mkdirSync(scratch);
      writeFileSync(join(scratch, 'foreign'), 'replacement files');
      if (ownership === 'foreign owner') writeFileSync(join(scratch, '.cez-owner'), 'another project');
      await vi.advanceTimersByTimeAsync(120_000);
      expect(readFileSync(join(scratch, 'foreign'), 'utf8')).toBe('replacement files');
      expect(readFileSync(pointer, 'utf8')).toBe(scratch);
      rmSync(scratch, { recursive: true }); renameSync(displaced, scratch);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(existsSync(scratch)).toBe(false);
      expect(existsSync(pointer)).toBe(false);
    } finally {
      cleanup.pause(); chmodSync(oldRoot, 0o700); rmSync(oldRoot, { recursive: true, force: true });
      vi.useRealTimers(); setTmpRoot(priorTmpdir);
    }
  });

  it.runIf(process.platform === 'linux').each(['corrupt', 'missing', 'quarantined'].flatMap(mode => ['local', 'fallback'].map(location => ({ mode, location }))))('retains held $location scratch across $mode index recovery and retries after the holder exits', async ({ mode, location }) => {
    const { run, dataDir, scratch } = await completed(location);
    const holder = await nonDumpableHolder(scratch);
    try {
      // The helper asserts a real kernel EACCES/EPERM; no cwd or liveness read is mocked.
      await holder.write();
      manager.dispose(); store.close();
      const database = join(dataDir, 'runs.db');
      if (mode === 'corrupt') writeFileSync(database, '{corrupt');
      else if (mode === 'missing') for (const file of [database, `${database}-wal`, `${database}-shm`]) rmSync(file, { force: true });
      else {
        const rows = readPersistedRuns(dataDir);
        delete rows.find((row: { id: string }) => row.id === run.id)!.delegation.workspace.resourceId;
        seedRuns(dataDir, rows);
      }
      reopenRuntime();
      // An unreadable database is never reset: the store is unavailable, not empty (#779).
      if (mode === 'corrupt') expect(store.unavailable?.kind).toBe('corrupt');
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
      // Without an index nothing is cleaned up, held or not: it waits for the database to be restored.
      expect(existsSync(scratch)).toBe(mode === 'corrupt');
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
    manager.dispose(); store.close(); seedRuns(dataDir, []);
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
    manager.dispose(); store.close(); seedRuns(dataDir, []);
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
    manager.dispose(); store.close();
    const rows = readPersistedRuns(dataDir);
    delete rows.find((row: { id: string }) => row.id === run.id)!.delegation;
    seedRuns(dataDir, rows); reopenRuntime();
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
