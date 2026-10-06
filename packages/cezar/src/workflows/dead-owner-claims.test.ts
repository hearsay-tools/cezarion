import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { planOwnedWorkspace } from '../delegation/workspace.ts';
import { agentTmpDir } from '../runs/agent-tmpdir.ts';
import { RUNS_DB_FILE, RunDatabase } from '../runs/run-database.ts';
import { crashStore } from '../runs/run-store.testkit.ts';
import { RunStore } from '../runs/store.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { createFixtureManager, drainFixtureManagers } from './fixture-cleanup.testkit.ts';

/**
 * A process that crashed while it still held a settled family in memory leaves that family's claim
 * behind (#779, plan step 3). Nothing in it is live, so there is nothing to recover: the next boot's
 * background repairs and cleanups must treat it as free, never as "in use by another process" —
 * otherwise only a human control would ever release it.
 */
describe('a crashed owner\'s claim on a settled family', () => {
  let root: string;
  let dataDir: string;
  const savedDryRun = process.env.CEZ_DRY_RUN;

  beforeEach(() => {
    process.env.CEZ_DRY_RUN = '1';
    root = mkdtempSync(join(tmpdir(), 'cez-dead-owner-'));
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
    execFileSync('git', ['config', 'gc.auto', '0'], { cwd: root });
    execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@local', 'commit', '--allow-empty', '-qm', 'base'], { cwd: root });
    dataDir = join(root, '.ai/cezar');
    mkdirSync(dataDir, { recursive: true });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await drainFixtureManagers(root);
    rmSync(root, { recursive: true, force: true });
    if (savedDryRun === undefined) delete process.env.CEZ_DRY_RUN;
    else process.env.CEZ_DRY_RUN = savedDryRun;
  });

  it('is free at the next boot, so every repair and cleanup reaches it', async () => {
    const owner = RunStore.open(dataDir, { keepLive: true });
    // A settled delegation family: a root with a conversation (#661 repairs it at boot), and a
    // worker whose generation the crashed controller left `starting` (#469 settles it at boot).
    const parent = owner.createRun({ title: 'root', workflow: 'quick-task', task: 'root', steps: [] });
    owner.commitDelegation([{ id: parent.id, delegation: { role: 'root', permissions: ['spawn'], receipts: [] } }]);
    owner.commitConversation(parent.id, { messages: [], outcomes: [] });
    const workerId = randomUUID();
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    const workspace = await planOwnedWorkspace(root, workerId, sha);
    const worker = owner.createOwnedRun({ title: 'worker', task: 'worker', workflow: 'quick-task', steps: [] }, parent.id, randomUUID(),
      { role: 'worker', permissions: [], parentRunId: parent.id, workspace }, 'a'.repeat(64));
    owner.commitWorkerExecutionStart(worker.id);
    const finishedAt = new Date().toISOString();
    owner.updateRun(worker.id, { status: 'done', finishedAt });
    owner.updateRun(parent.id, { status: 'done', finishedAt });
    // An ordinary settled run with a materialized worktree, a branch and agent scratch.
    const plain = owner.createRun({ title: 'plain', workflow: 'quick-task', task: 'plain', steps: [] });
    const worktree = join(root, 'plain-worktree'); mkdirSync(worktree);
    owner.updateRun(plain.id, { status: 'done', finishedAt, worktreePath: worktree, branch: `cez/${plain.id.slice(0, 8)}` });
    const scratch = agentTmpDir(dataDir, plain.id); mkdirSync(scratch, { recursive: true });
    // The process dies while both families are still in its memory: their claims stay behind.
    owner.pin(parent.id, 'cleanup'); owner.pin(plain.id, 'cleanup'); owner.flush();
    crashStore(owner);
    const raw = RunDatabase.open(join(dataDir, RUNS_DB_FILE));
    try { expect(raw.listClaims().map((claim) => claim.family).sort()).toEqual([parent.id, plain.id].sort()); } finally { raw.close(); }

    const store = RunStore.open(dataDir, { keepLive: true });
    const manager = createFixtureManager(store, root, { semaphore: new WorkspaceSemaphore({ initial: { maxParallel: 0 } }) });
    const reconciled = vi.spyOn(manager, 'reconcileWorkerWaits');
    const settled = vi.spyOn(manager, 'settleOrphanedWorkerExecution');
    try {
      await manager.recover();
      // Each refused path on its own line, so a regression names every one it breaks.
      expect.soft(reconciled, '#661 reconcile').toHaveBeenCalledWith(parent.id); // the settled conversation family
      expect.soft(settled, '#469 settle').toHaveBeenCalledWith(worker.id); // the generation a dead controller left
      expect.soft(existsSync(scratch), 'scratch sweep').toBe(false);
      const reclaim = manager.claimWorktreeReclaim(plain.id); // worktree retention and Reclaim
      expect.soft(reclaim, 'worktree reclaim').not.toBeNull();
      reclaim?.();
      const cleanup = manager.claimForBranchCleanup([plain.id]);
      expect.soft(cleanup, 'branch cleanup').not.toBeNull();
      cleanup?.();
      // The two claims above hold `plain` until the next save (PR #851 review: a claim is held
      // across its async work); flush so the families they held are released again.
      store.flush();
      // Nothing in either family is live: a dead owner's claim on it is no claim at all.
      for (const id of [parent.id, worker.id, plain.id]) expect.soft(store.runOwnership(id), `ownership of ${id}`).toBe('free');
    } finally {
      await drainFixtureManagers(root);
      store.close();
    }
  });
});
