import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RUN_IN_USE_ELSEWHERE, RunStore } from '../runs/store.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { createFixtureManager, drainFixtureManagers } from './fixture-cleanup.testkit.ts';
import type { RunManager } from './run.ts';

/**
 * An ownership check is a moment; the work it admits is not (#779, plan step 3, PR #851 review).
 * A Continue admission and the async maintenance claims (publish, worktree reclaim, branch
 * cleanup) must HOLD the run's family claim for as long as they act on it, so another cezar
 * process cannot claim and Continue the run in between, and must refuse when the hold fails.
 */
describe('claims that admit work on a finished run', () => {
  let root: string;
  let dataDir: string;
  const savedDryRun = process.env.CEZ_DRY_RUN;

  beforeEach(() => {
    process.env.CEZ_DRY_RUN = '1';
    root = mkdtempSync(join(tmpdir(), 'cez-maintenance-claims-'));
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

  function settledRun(store: RunStore): string {
    const run = store.createRun({ title: 'settled', workflow: 'quick-task', task: 'settled', steps: [] });
    // A materialized worktree, so worktree reclaim has something to claim.
    const worktreePath = join(root, `wt-${run.id.slice(0, 8)}`); mkdirSync(worktreePath);
    store.updateRun(run.id, { status: 'done', finishedAt: new Date().toISOString(), branch: `cez/${run.id.slice(0, 8)}`, worktreePath });
    store.flush();
    return run.id;
  }

  function managerFor(store: RunStore): RunManager {
    return createFixtureManager(store, root, { semaphore: new WorkspaceSemaphore({ initial: { maxParallel: 0 } }) });
  }

  const claims: Array<[string, (manager: RunManager, id: string) => (() => void) | null]> = [
    ['publish', (manager, id) => manager.claimForPublish(id)],
    ['worktree reclaim', (manager, id) => manager.claimWorktreeReclaim(id)],
    ['branch cleanup', (manager, id) => manager.claimForBranchCleanup([id])],
  ];

  it.each(claims)('%s holds the family claim until it is released', (_name, claim) => {
    const seed = RunStore.open(dataDir, { keepLive: true });
    const id = settledRun(seed);
    seed.close();

    const ours = RunStore.open(dataDir, { keepLive: true });
    const theirs = RunStore.open(dataDir, { keepLive: true });
    try {
      const release = claim(managerFor(ours), id);
      expect(release).not.toBeNull();
      // While the claim stands, the other process sees the run as ours and cannot act on it.
      expect(theirs.runOwnership(id)).toBe('foreign');
      expect(theirs.writeRefusal(id)).toBe(RUN_IN_USE_ELSEWHERE);
      release!();
      // A released run leaves memory, and its family claim, at the next save.
      ours.flush();
      expect(theirs.writeRefusal(id)).toBeUndefined();
    } finally {
      ours.close();
      theirs.close();
    }
  });

  it.each(claims)('%s refuses when another process claimed the run first', (_name, claim) => {
    const seed = RunStore.open(dataDir, { keepLive: true });
    const id = settledRun(seed);
    seed.close();

    const ours = RunStore.open(dataDir, { keepLive: true });
    const theirs = RunStore.open(dataDir, { keepLive: true });
    try {
      const manager = managerFor(ours);
      // The other process takes the claim after our ownership check would have passed.
      vi.spyOn(ours, 'writeRefusal').mockReturnValue(undefined);
      expect(theirs.pin(id, 'cleanup')).toBeDefined();
      expect(claim(manager, id)).toBeNull();
    } finally {
      ours.close();
      theirs.close();
    }
  });

  it('Continue refuses, and starts nothing, when the run cannot be held', () => {
    const store = RunStore.open(dataDir, { keepLive: true });
    try {
      const id = settledRun(store);
      const manager = managerFor(store);
      // Another process claimed the run between the ownership check and the hold.
      vi.spyOn(store, 'pin').mockReturnValue(undefined);
      const result = manager.continueRun(id);
      expect(result).toEqual({ ok: false, error: RUN_IN_USE_ELSEWHERE });
      expect(store.getRun(id)?.status).toBe('done');
      expect(manager.isActive(id)).toBe(false);
    } finally {
      store.close();
    }
  });
});
