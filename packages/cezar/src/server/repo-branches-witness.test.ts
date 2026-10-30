import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createOwnedWorkspace } from '../delegation/workspace.ts';
import type { WorktreeGit } from '../git-worktree-lock.ts';
import { fakeForge, owners, runRecord } from './repo-branches.testkit.ts';
import { branchOwnerOf, type RunRecord } from '../runs/store.ts';

const exec = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];
const hook = vi.hoisted(() => ({
  beforeUpdateRef: undefined as (() => Promise<void>) | undefined,
  beforeOperation: undefined as (() => Promise<void>) | undefined,
  command: undefined as ((args: string[]) => ReturnType<WorktreeGit> | undefined) | undefined,
}));

// The one window this file exists for: after the delete read its witness under the lock, before
// its ref transaction. An outside process (a shell, an IDE) is not bound by cezar's lock.
vi.mock('../git-worktree-lock.ts', async (original) => {
  const real = await original<typeof import('../git-worktree-lock.ts')>();
  return {
    ...real,
    withWorktreeMutation: <T>(root: string, operation: Parameters<typeof real.withWorktreeMutation<T>>[1]) =>
      real.withWorktreeMutation(root, async (git) => {
        await hook.beforeOperation?.();
        return operation(async (cwd, args, timeout, input) => {
          const injected = hook.command?.(args);
          if (injected) return injected;
          if (args[0] === 'update-ref' && hook.beforeUpdateRef) await hook.beforeUpdateRef();
          return git(cwd, args, timeout, input);
        });
      }),
  };
});

const { deleteBranches } = await import('./repo-branches.ts');

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await exec('git', [...GIT_ID, ...args], { cwd })).stdout.trim();
}

describe('deleting an empty branch whose commits another ref keeps (issue 08)', () => {
  let root: string;
  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cez-branches-witness-'));
    await git(root, 'init', '-q', '-b', 'main');
    writeFileSync(join(root, 'base.txt'), 'base\n');
    await git(root, 'add', '-A');
    await git(root, 'commit', '-q', '-m', 'base');
  });
  afterEach(() => {
    hook.beforeUpdateRef = undefined;
    hook.beforeOperation = undefined;
    hook.command = undefined;
    rmSync(root, { recursive: true, force: true });
  });

  it('refuses when that ref goes between the check and the delete', async () => {
    await git(root, 'checkout', '-q', '-b', 'topic');
    writeFileSync(join(root, 'topic.txt'), 'unmerged\n');
    await git(root, 'add', '-A');
    await git(root, 'commit', '-q', '-m', 'topic work');
    const tip = await git(root, 'rev-parse', 'HEAD');
    await git(root, 'checkout', '-q', 'main');
    await git(root, 'branch', 'cez/aaaaaaaa', 'topic');
    hook.beforeUpdateRef = async () => {
      hook.beforeUpdateRef = undefined;
      await git(root, 'branch', '-D', 'topic');
    };
    const runs = [{
      id: 'aaaaaaaa-1', title: 't', workflow: 'w', task: 't', status: 'done', steps: [],
      createdAt: '2026-09-01T00:00:00.000Z', archived: false, branch: 'cez/aaaaaaaa', baseBranch: 'topic',
    } as unknown as RunRecord].flatMap((run) => branchOwnerOf(run) ?? []);
    const result = await deleteBranches(
      { root, runs, isActive: () => false, currentBranch: 'main', hasRemote: false, forge: { prStates: async () => ({ available: true, states: {} }), prsForHeads: async () => ({ available: true, prs: [], incomplete: new Set<string>() }) } },
      ['cez/aaaaaaaa'],
    );
    expect(result.deleted).toEqual([]);
    expect(await git(root, 'rev-parse', 'cez/aaaaaaaa')).toBe(tip);
  });

  function input() {
    return { root, runs: [], isActive: () => false, currentBranch: 'main', hasRemote: false, forge: fakeForge().forge };
  }

  it('refuses a branch checked out after classification at the mutation lock', async () => {
    const name = 'cez/checkout';
    await git(root, 'branch', name);
    const tip = await git(root, 'rev-parse', name);
    hook.beforeOperation = async () => { await git(root, 'worktree', 'add', '-q', join(root, '.wt'), name); };
    expect(await deleteBranches(input(), [name])).toEqual({
      deleted: [], refused: [{ name, reason: 'checked out in a worktree' }],
    });
    expect(await git(root, 'rev-parse', name)).toBe(tip);
    expect(await git(join(root, '.wt'), 'symbolic-ref', '--short', 'HEAD')).toBe(name);
  });

  it('refuses a delegated workspace owner appearing after classification at the mutation lock', async () => {
    const tip = await git(root, 'rev-parse', 'HEAD');
    const workspace = await createOwnedWorkspace(root, 'aaaaaaaa-1111-4111-8111-111111111111', tip);
    await git(root, 'worktree', 'remove', '--force', workspace.path);
    const receipts = join(root, '.git', 'cezar-owned-workspaces');
    const hidden = join(root, '.git', 'hidden-receipts');
    renameSync(receipts, hidden);
    hook.beforeOperation = async () => { renameSync(hidden, receipts); };
    expect(await deleteBranches(input(), [workspace.branch])).toEqual({
      deleted: [], refused: [{ name: workspace.branch, reason: 'owned by a delegated workspace' }],
    });
    expect(await git(root, 'rev-parse', workspace.branch)).toBe(tip);
  });

  it('refuses uncertain ownership appearing at the mutation lock', async () => {
    const name = 'cez/uncertain';
    await git(root, 'branch', name);
    hook.beforeOperation = async () => {
      const receipts = join(root, '.git', 'cezar-owned-workspaces');
      mkdirSync(receipts);
      writeFileSync(join(receipts, 'broken.json'), '{');
    };
    expect(await deleteBranches(input(), [name])).toEqual({
      deleted: [], refused: [{ name, reason: 'owned by a delegated workspace' }],
    });
    expect(await git(root, 'rev-parse', name)).toBe(await git(root, 'rev-parse', 'main'));
  });

  it('refuses a symbolic alias substituted at the mutation lock', async () => {
    const name = 'cez/alias';
    await git(root, 'branch', name);
    const tip = await git(root, 'rev-parse', 'main');
    hook.beforeOperation = async () => { await git(root, 'symbolic-ref', `refs/heads/${name}`, 'refs/heads/main'); };
    expect(await deleteBranches(input(), [name])).toEqual({
      deleted: [], refused: [{ name, reason: 'not a cezar task branch' }],
    });
    expect(await git(root, 'rev-parse', 'main')).toBe(tip);
    expect(await git(root, 'symbolic-ref', `refs/heads/${name}`)).toBe('refs/heads/main');
  });

  it('keeps completed deletions and refusals when a later locked command throws, and releases claims', async () => {
    const names = ['cez/aaaaaaaa', 'cez/bbbbbbbb', 'cez/cccccccc', 'cez/dddddddd'];
    for (const name of names) await git(root, 'branch', name);
    const releases = names.map(() => vi.fn());
    let claim = 0;
    const claimRuns = () => releases[claim++]!;
    hook.beforeOperation = async () => { await git(root, 'worktree', 'add', '-q', join(root, '.wt'), names[1]!); };
    hook.command = (args) => {
      if (args[0] === 'symbolic-ref' && args[2] === `refs/heads/${names[2]}`) return Promise.reject(new Error('lost keeper'));
      return undefined;
    };
    const runs = owners(names.map((branch, i) => runRecord(`${'abcd'[i]!.repeat(8)}-1`, 'done', { branch })));
    expect(await deleteBranches({ ...input(), runs, claimRuns }, names)).toEqual({
      deleted: [names[0]],
      refused: [
        { name: names[1], reason: 'checked out in a worktree' },
        { name: names[2], reason: 'the repository is busy — try again' },
        { name: names[3], reason: 'the repository is busy — try again' },
      ],
    });
    for (const release of releases) expect(release).toHaveBeenCalledOnce();
    expect(await git(root, 'branch', '--list', names[0]!)).toBe('');
    for (const name of names.slice(1)) expect(await git(root, 'branch', '--list', name)).toContain(name);
  });


  it('refuses an empty branch when its retention lookup fails with partial output', async () => {
    await git(root, 'checkout', '-q', '-b', 'topic');
    writeFileSync(join(root, 'topic.txt'), 'unmerged\n');
    await git(root, 'add', '-A');
    await git(root, 'commit', '-q', '-m', 'topic');
    const tip = await git(root, 'rev-parse', 'HEAD');
    await git(root, 'checkout', '-q', 'main');
    const name = 'cez/aaaaaaaa';
    await git(root, 'branch', name, 'topic');
    hook.command = (args) => args[0] === 'for-each-ref'
      ? Promise.resolve({ ok: false, stdout: `refs/heads/topic\0${tip}\0\n`, stderr: 'interrupted' })
      : undefined;
    const runs = owners([runRecord('aaaaaaaa-1', 'done', { baseBranch: tip })]);
    expect(await deleteBranches({ ...input(), runs }, [name])).toEqual({
      deleted: [], refused: [{ name, reason: 'its commits are not on main and only branches in this request keep them — delete it on its own, with confirmation' }],
    });
    expect(await git(root, 'rev-parse', name)).toBe(tip);
  });

  it('does not use symbolic or incomplete refs as retention witnesses', async () => {
    await git(root, 'checkout', '-q', '-b', 'topic');
    writeFileSync(join(root, 'topic.txt'), 'unmerged\n');
    await git(root, 'add', '-A');
    await git(root, 'commit', '-q', '-m', 'topic');
    const tip = await git(root, 'rev-parse', 'HEAD');
    await git(root, 'checkout', '-q', 'main');
    const name = 'cez/aaaaaaaa';
    await git(root, 'branch', name, 'topic');
    hook.command = (args) => args[0] === 'for-each-ref'
      ? Promise.resolve({ ok: true, stdout: [
        `refs/heads/${name}\0${tip}\0`,
        `refs/remotes/origin/HEAD\0${tip}\0refs/heads/${name}`,
        `\0${tip}\0`, 'refs/heads/missing-tip\0\0', '',
      ].join('\n'), stderr: '' })
      : undefined;
    const runs = owners([runRecord('aaaaaaaa-1', 'done', { baseBranch: tip })]);
    expect(await deleteBranches({ ...input(), runs }, [name])).toEqual({
      deleted: [], refused: [{ name, reason: 'its commits are not on main and only branches in this request keep them — delete it on its own, with confirmation' }],
    });
    expect(await git(root, 'rev-parse', name)).toBe(tip);
  });

});
