import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { autosaveCommit, type AutosaveOutcome } from './git-worktree.ts';

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];
const TASK_BRANCH = 'cez/abcd1234';

/**
 * hearsay-tools/cezarion#1004: an agent checked its own feature branch out in
 * its task worktree, and the `run finalize` flush committed
 * `cezar autosave (run finalize)` onto that branch. Given the task branch, the
 * save commits only while HEAD is that branch; anywhere else it leaves the
 * index and working tree alone and reports what it left.
 */
describe('autosave task-branch rule (#1004)', () => {
  let repo: string;

  const git = (args: string[]) => run('git', args, { cwd: repo });
  const out = async (args: string[]) => (await git(args)).stdout.trim();

  beforeEach(async () => {
    repo = mkdtempSync(join(tmpdir(), 'cez-autosave-branch-'));
    await git(['init', '-q', '-b', TASK_BRANCH]);
    await git(['config', 'gc.auto', '0']);
    await git(['config', 'maintenance.auto', 'false']);
    writeFileSync(join(repo, 'a.txt'), 'base\n');
    await git(['add', '-A']);
    await git([...GIT_ID, 'commit', '-q', '-m', 'base']);
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it('leaves a dirty tree uncommitted on a branch other than the task branch', async () => {
    await git(['checkout', '-q', '-b', 'fix/1004-x']);
    const tip = await out(['rev-parse', 'fix/1004-x']);
    writeFileSync(join(repo, 'a.txt'), 'edited\n');
    writeFileSync(join(repo, 'new.txt'), 'untracked\n');
    const outcomes: AutosaveOutcome[] = [];

    expect(await autosaveCommit(repo, 'run finalize', { taskBranch: TASK_BRANCH, onOutcome: o => outcomes.push(o) })).toBe('skipped');

    expect(outcomes).toEqual([{ result: 'skipped', branch: 'fix/1004-x', changedPaths: 2 }]);
    expect(await out(['rev-parse', 'fix/1004-x'])).toBe(tip);
    expect(await out(['rev-parse', TASK_BRANCH])).toBe(tip);
    // No `git add`: the edit stays unstaged and the new file untracked.
    expect((await git(['status', '--porcelain'])).stdout).toBe(' M a.txt\n?? new.txt\n');
  });

  it('leaves a dirty tree uncommitted on a detached HEAD', async () => {
    await git(['checkout', '-q', '--detach']);
    const head = await out(['rev-parse', 'HEAD']);
    writeFileSync(join(repo, 'new.txt'), 'untracked\n');
    const outcomes: AutosaveOutcome[] = [];

    expect(await autosaveCommit(repo, 'turn end', { taskBranch: TASK_BRANCH, onOutcome: o => outcomes.push(o) })).toBe('skipped');

    expect(outcomes).toEqual([{ result: 'skipped', branch: null, changedPaths: 1 }]);
    expect(await out(['rev-parse', 'HEAD'])).toBe(head);
    expect((await git(['status', '--porcelain'])).stdout).toBe('?? new.txt\n');
  });

  it('commits as before while HEAD is the task branch, and reports the commit', async () => {
    writeFileSync(join(repo, 'new.txt'), 'work\n');
    const outcomes: AutosaveOutcome[] = [];

    expect(await autosaveCommit(repo, 'run finalize', { taskBranch: TASK_BRANCH, onOutcome: o => outcomes.push(o) })).toBe('committed');

    expect(await out(['log', '-1', '--format=%s', TASK_BRANCH])).toBe('cezar autosave (run finalize)');
    expect(outcomes).toEqual([{ result: 'committed', sha: await out(['rev-parse', '--short', 'HEAD']), branch: TASK_BRANCH }]);
    expect((await git(['status', '--porcelain'])).stdout).toBe('');
  });

  it('still commits on any branch when no task branch is given (pre-PR)', async () => {
    await git(['checkout', '-q', '-b', 'fix/1004-x']);
    writeFileSync(join(repo, 'new.txt'), 'work\n');

    expect(await autosaveCommit(repo, 'pre-PR')).toBe('committed');

    expect(await out(['log', '-1', '--format=%s', 'fix/1004-x'])).toBe('cezar autosave (pre-PR)');
  });

  it('stays silent on a clean branch other than the task branch', async () => {
    await git(['checkout', '-q', '-b', 'fix/1004-x']);
    const outcomes: AutosaveOutcome[] = [];

    expect(await autosaveCommit(repo, 'turn end', { taskBranch: TASK_BRANCH, onOutcome: o => outcomes.push(o) })).toBe('nothing-to-do');

    expect(outcomes).toEqual([]);
  });
});
