import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RunRecord } from '../runs/store.ts';
import { __clearPrListCacheForTests, type BranchForge, type ClassifyProject } from './repo-branches.ts';
import { __resetBranchSweepForTests, sweepMergedBranches } from './repo-branch-sweep.ts';
import { claimRepoGitMutation } from './repo-pull.ts';
import { addOrigin, commit, fakeForge, git, mergedPr, owners, runRecord, taskBranch } from './repo-branches.testkit.ts';

/**
 * The automatic branch sweep (hearsay-tools/cezarion#2268): it deletes the refs whose work landed,
 * found from `refs/heads` whether or not a worktree directory is left, and nothing else.
 */
describe('the branch sweep', () => {
  let root: string;
  let origin: string;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cez-sweep-'));
    origin = mkdtempSync(join(tmpdir(), 'cez-sweep-origin-'));
    await git(root, 'init', '-q', '-b', 'main');
    await commit(root, 'base.txt', 'base');
    await addOrigin(root, origin);
  });

  afterEach(() => {
    __resetBranchSweepForTests();
    __clearPrListCacheForTests();
    rmSync(root, { recursive: true, force: true });
    rmSync(origin, { recursive: true, force: true });
  });

  const project = (runs: readonly RunRecord[], claim: (ids: readonly string[]) => (() => void) | null = () => () => undefined): ClassifyProject => ({
    root,
    store: { listBranchOwners: () => owners(runs) },
    manager: { isActive: () => false, claimForBranchCleanup: claim },
  });
  const branches = async () => (await git(root, 'branch', '--format=%(refname:short)')).split('\n').sort();
  const log = () => undefined;

  /** Every case the sweep decides, none with a worktree directory except `cez/checkout`. */
  async function everyCase(): Promise<{ runs: RunRecord[]; forge: BranchForge }> {
    await git(root, 'branch', 'cez/starter1'); // a starter that never moved: empty
    await taskBranch(root, 'cez/merged01', 1);
    await git(root, 'merge', '-q', '--no-ff', '-m', 'Merge cez/merged01', 'cez/merged01');
    await taskBranch(root, 'cez/norecord', 1); // merged by ancestry, its run record long gone
    await git(root, 'merge', '-q', '--no-ff', '-m', 'Merge cez/norecord', 'cez/norecord');
    const squashTip = await taskBranch(root, 'cez/squash01', 1);
    const prTip = await taskBranch(root, 'fix/named-pr', 1);
    const squash = await commit(root, 'squash.txt', 'Squash both (#5, #6)');
    await taskBranch(root, 'cez/notlnd01', 1);
    const openTip = await taskBranch(root, 'cez/openpr01', 1);
    await taskBranch(root, 'cez/orphan01', 1); // commits, no run: only a typed delete
    await taskBranch(root, 'mine', 1);
    await git(root, 'branch', 'cez/checkout');
    await git(root, 'worktree', 'add', '-q', join(root, '.wt'), 'cez/checkout');
    const runs = [
      runRecord('starter1-1', 'done', { pullRequestUrl: 'https://github.com/acme/demo/pull/6' }),
      runRecord('merged01-1', 'done'),
      runRecord('squash01-1', 'done'),
      runRecord('notlnd01-1', 'done'),
      runRecord('openpr01-1', 'done'),
      runRecord('checkout-1', 'done'),
    ];
    const open = { ...mergedPr(7, 'cez/openpr01', openTip, squash), state: 'open' as const, mergeCommitOid: null };
    const { forge } = fakeForge({ prs: [mergedPr(5, 'cez/squash01', squashTip, squash), mergedPr(6, 'fix/named-pr', prTip, squash), open] });
    return { runs, forge };
  }

  it('deletes merged and empty refs without worktree directories, and keeps every other ref', async () => {
    const { runs, forge } = await everyCase();
    const result = await sweepMergedBranches(project(runs), { keep: 8, forge, log });
    expect(result?.deleted.sort()).toEqual(['cez/merged01', 'cez/norecord', 'cez/squash01', 'cez/starter1', 'fix/named-pr']);
    expect(await branches()).toEqual(['cez/checkout', 'cez/notlnd01', 'cez/openpr01', 'cez/orphan01', 'main', 'mine']);
  });

  it('does nothing when retention keeps every worktree', async () => {
    const { runs, forge } = await everyCase();
    const before = await branches();
    expect(await sweepMergedBranches(project(runs), { keep: 0, forge, log })).toBeNull();
    expect(await branches()).toEqual(before);
  });

  it('keeps the refs of a run it cannot claim, and deletes the rest', async () => {
    const { runs, forge } = await everyCase();
    const claim = (ids: readonly string[]) => (ids.includes('merged01-1') ? null : () => undefined);
    const result = await sweepMergedBranches(project(runs, claim), { keep: 8, forge, log });
    expect(result?.refused).toContainEqual({ name: 'cez/merged01', reason: 'its task is running or being continued — try again once it settles' });
    expect(await branches()).toContain('cez/merged01');
    expect(await branches()).not.toContain('cez/squash01');
  });

  it('waits for a branch switch or pull to finish', async () => {
    const { runs, forge } = await everyCase();
    const before = await branches();
    const release = claimRepoGitMutation(root);
    try {
      expect(await sweepMergedBranches(project(runs), { keep: 8, forge, log })).toBeNull();
    } finally {
      release?.();
    }
    expect(await branches()).toEqual(before);
  });

  it('joins a sweep already running, and skips one inside the interval', async () => {
    const { runs, forge } = await everyCase();
    const first = sweepMergedBranches(project(runs), { keep: 8, forge, log, minIntervalMs: 60_000 });
    expect(sweepMergedBranches(project(runs), { keep: 8, forge, log })).toBe(first);
    expect((await first)?.deleted).toHaveLength(5);
    await git(root, 'branch', 'cez/later001');
    expect(await sweepMergedBranches(project([...runs, runRecord('later001-1', 'done')]), { keep: 8, forge, log, minIntervalMs: 60_000 })).toBeNull();
    expect(await branches()).toContain('cez/later001');
  });
});
