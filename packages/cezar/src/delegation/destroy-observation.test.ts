import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agentTmpDir } from '../runs/agent-tmpdir.ts';
import { holdersStillLive, observeDestroy, recordHolders } from './destroy-observation.ts';
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

  it('changes when a locked worktree is unlocked', async () => {
    const { workspace, key } = await settled();
    execFileSync('git', ['worktree', 'lock', workspace.path], { cwd: f.root });
    const locked = key();
    execFileSync('git', ['worktree', 'unlock', workspace.path], { cwd: f.root });
    expect(key()).not.toBe(locked);
  });

  it('tells a live holder from one that exited or whose pid was reused', async () => {
    const child = spawn(process.execPath, ['-e', "console.log('ready'); setInterval(() => {}, 1000)"], { stdio: ['ignore', 'pipe', 'ignore'] });
    const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
    await new Promise<void>(resolve => child.stdout!.once('data', () => resolve()));
    const holders = recordHolders([child.pid!]);
    expect(holders).toEqual([{ pid: child.pid, startToken: expect.any(String) }]);
    expect(holdersStillLive(holders)).toBe(true);
    expect(holdersStillLive([{ pid: child.pid!, startToken: 'another-incarnation' }])).toBe(false);
    expect(holdersStillLive([])).toBe(true);
    child.kill('SIGKILL'); await exited;
    expect(holdersStillLive(holders)).toBe(false);
  });
});

type Settled = { workerId: string; workspace: { path: string; branch: string; resourceId: string }; dataDir: string; commonDir: string };
