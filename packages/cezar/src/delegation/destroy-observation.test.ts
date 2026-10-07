import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agentTmpDir } from '../runs/agent-tmpdir.ts';
import { holdersStillHold, observeDestroy, recordHolders } from './destroy-observation.ts';
import { scopeFixtureProcesses } from './process-scope.testkit.ts';
import { fixture } from './service.testkit.ts';
import { ensureOwnedWorkspace, gitCommonDir } from './workspace.ts';

describe('destroy observation (hearsay-tools/cezarion#879)', () => {
  let f: ReturnType<typeof fixture>;
  beforeEach(() => { scopeFixtureProcesses(); vi.stubEnv('CEZ_DELEGATION', '1'); f = fixture(); });
  afterEach(async () => { await f?.close(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

  /** A settled worker with a real worktree, the shape a stuck destroy has. */
  async function settled() {
    const { workerId } = await f.service.spawn(f.caller, { task: 'work', baseline: 'HEAD', requestId: randomUUID() });
    const generation = f.store.commitWorkerExecutionStart(workerId);
    const workspace = await ensureOwnedWorkspace(f.root, f.store.getRun(workerId)!);
    f.store.updateRun(workerId, { status: 'review', worktreePath: workspace.path, branch: workspace.branch });
    expect(f.store.commitWorkerExecutionComplete(workerId, generation)).toBe(true);
    const dataDir = join(f.root, '.ai/cezar'), commonDir = await gitCommonDir(f.root);
    return { workerId, workspace, dataDir, commonDir, key: () => observeDestroy({ store: f.store, dataDir, commonDir, workerId }) };
  }
  const withDestroy = (workerId: string, destroy: object) => {
    const run = f.store.getRun(workerId)!;
    if (run.delegation?.role !== 'worker') throw Error('worker');
    f.store.commitDelegation([{ id: workerId, delegation: { ...run.delegation, destroy: { requestedAt: new Date().toISOString(), ...destroy } } as never }]);
  };

  it('is stable while nothing changes, and ignores what destroy itself writes', async () => {
    const { workerId, key } = await settled();
    const first = key();
    expect(key()).toBe(first);
    withDestroy(workerId, { phase: 'incomplete', remaining: ['worktree', 'branch'], error: 'held' });
    expect(key()).toBe(first);
    withDestroy(workerId, { phase: 'incomplete', remaining: ['worktree', 'branch'], retry: { attempts: 4, nextAt: new Date().toISOString() } });
    expect(key()).toBe(first);
  });

  it.each([
    ['a new completed execution generation', ({ workerId }: Settled) => {
      const next = f.store.commitWorkerExecutionStart(workerId); f.store.commitWorkerExecutionComplete(workerId, next);
    }],
    ['the worktree removed', ({ workspace }: Settled) => { rmSync(workspace.path, { recursive: true, force: true }); }],
    ['the branch ref deleted', ({ workspace }: Settled) => { execFileSync('git', ['update-ref', '-d', `refs/heads/${workspace.branch}`], { cwd: f.root }); }],
    ['refs packed', () => { execFileSync('git', ['pack-refs', '--all'], { cwd: f.root }); }],
    ['the worktree locked', ({ workspace }: Settled) => { execFileSync('git', ['worktree', 'lock', workspace.path], { cwd: f.root }); }],
    ['the ownership marker rewritten in place', ({ workspace }: Settled) => { writeFileSync(join(adminOf(workspace.path), 'cezar-owned-resource'), randomUUID()); }],
    ['a cleanup checkpoint written', ({ workspace, commonDir }: Settled) => {
      writeFileSync(join(commonDir, 'cezar-owned-workspaces', `${workspace.resourceId}.cleanup.json`), '{}', { mode: 0o600 });
    }],
    ['the worktree permissions changed', ({ workspace }: Settled) => { chmodSync(workspace.path, 0o700); }],
    ['the ownership receipt removed', ({ workspace, commonDir }: Settled) => {
      rmSync(join(commonDir, 'cezar-owned-workspaces', `${workspace.resourceId}.json`), { force: true });
    }],
    ["the parent's receipt removed", ({ workerId }: Settled) => {
      const parent = f.store.getRun(f.parent.id)!;
      if (parent.delegation?.role !== 'root') throw Error('root');
      f.store.commitDelegation([{ id: f.parent.id, delegation: { ...parent.delegation, receipts: parent.delegation.receipts.filter(receipt => receipt.workerId !== workerId) } }]);
    }],
    ['a scratch dir created', ({ workerId, dataDir }: Settled) => { mkdirSync(agentTmpDir(dataDir, workerId), { recursive: true }); }],
    ['the process record rewritten', ({ workerId, dataDir }: Settled) => {
      writeFileSync(join(dataDir, 'runs', `${workerId}.processes.json`), '{"unreadable":');
    }],
  ] as const)('changes when %s', async (_, change) => {
    const settledWorker = await settled();
    const before = settledWorker.key();
    change(settledWorker);
    expect(settledWorker.key()).not.toBe(before);
  });

  it('ignores a cleanup checkpoint rewritten with the same bytes, as every removal attempt does', async () => {
    const { workspace, commonDir, key } = await settled();
    const checkpoint = join(commonDir, 'cezar-owned-workspaces', `${workspace.resourceId}.cleanup.json`);
    writeFileSync(checkpoint, '{"phase":"prepared"}', { mode: 0o600 });
    const before = key();
    // An atomic rewrite: a new inode and new times, the same content and mode.
    writeFileSync(`${checkpoint}.tmp`, '{"phase":"prepared"}', { mode: 0o600 }); renameSync(`${checkpoint}.tmp`, checkpoint);
    expect(key()).toBe(before);
    writeFileSync(checkpoint, '{"phase":"worktree-removed"}');
    expect(key()).not.toBe(before);
  });

  it('changes when a locked worktree is unlocked', async () => {
    const { workspace, key } = await settled();
    execFileSync('git', ['worktree', 'lock', workspace.path], { cwd: f.root });
    const locked = key();
    execFileSync('git', ['worktree', 'unlock', workspace.path], { cwd: f.root });
    expect(key()).not.toBe(locked);
  });

  it.runIf(process.platform === 'linux')('a reused PID left in a stale process record does not count as the generation\'s', async () => {
    const { workerId, workspace, dataDir } = await settled();
    const child = spawn(process.execPath, ['-e', "console.log('ready'); process.stdin.on('data', () => { process.chdir('/'); console.log('moved'); })"],
      { cwd: workspace.path, stdio: ['pipe', 'pipe', 'ignore'] });
    const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
    const line = () => new Promise<void>(resolve => child.stdout!.once('data', () => resolve()));
    await line();
    try {
      // The record names this PID, but as an earlier incarnation: the OS has since reused the number.
      const execution = f.store.readWorkerExecution(workerId)!;
      expect(f.store.appendWorkerProcess(workerId, execution.generation, child.pid!)).toBe(true);
      const path = join(dataDir, 'runs', `${workerId}.processes.json`);
      const record = JSON.parse(readFileSync(path, 'utf8')) as { processes: { pid: number; startToken?: string }[] };
      for (const entry of record.processes) if (entry.pid === child.pid) entry.startToken = 'an-earlier-incarnation';
      writeFileSync(path, JSON.stringify(record));
      const holders = recordHolders([child.pid!]);
      const holds = () => holdersStillHold({ store: f.store, dataDir, workerId, holders });
      expect(holds()).toBe(true);
      const moved = line(); child.stdin!.write('go\n'); await moved;
      expect(holds()).toBe(false);
    } finally { child.kill('SIGKILL'); await exited; }
  });

  it.runIf(process.platform === 'linux')('a holder still holds only while it is the same live process working under the worker', async () => {
    const { workerId, workspace } = await settled();
    const child = spawn(process.execPath, ['-e', "console.log('ready'); process.stdin.on('data', () => { process.chdir('/'); console.log('moved'); })"],
      { cwd: workspace.path, stdio: ['pipe', 'pipe', 'ignore'] });
    const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
    const line = () => new Promise<void>(resolve => child.stdout!.once('data', () => resolve()));
    await line();
    const holds = (holders: ReturnType<typeof recordHolders>) => holdersStillHold({ store: f.store, dataDir: join(f.root, '.ai/cezar'), workerId, holders });
    try {
      const holders = recordHolders([child.pid!]);
      expect(holders).toEqual([{ pid: child.pid, startToken: expect.any(String) }]);
      expect(holds([])).toBe(true);
      expect(holds(holders)).toBe(true);
      expect(holds([{ pid: child.pid!, startToken: 'another-incarnation' }])).toBe(false);
      // Moving away is a change: a fresh attempt would no longer find it.
      const moved = line(); child.stdin!.write('go\n'); await moved;
      expect(holds(holders)).toBe(false);
      // A process of the generation's own record blocks wherever it works.
      const execution = f.store.readWorkerExecution(workerId)!;
      expect(f.store.appendWorkerProcess(workerId, execution.generation, child.pid!)).toBe(true);
      expect(holds(holders)).toBe(true);
      child.kill('SIGKILL'); await exited;
      expect(holds(holders)).toBe(false);
    } finally { child.kill('SIGKILL'); }
  });
});

/** A linked worktree's own admin dir, as its `.git` file names it. */
function adminOf(worktree: string): string {
  return resolve(worktree, /^gitdir: (.+)$/m.exec(readFileSync(join(worktree, '.git'), 'utf8'))![1]!.trim());
}

type Settled = { workerId: string; workspace: { path: string; branch: string; resourceId: string }; dataDir: string; commonDir: string };
