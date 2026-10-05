import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { branchOwnerOf, type RunRecord } from '../runs/store.ts';

const exec = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];
const hook = vi.hoisted(() => ({ beforeUpdateRef: undefined as (() => Promise<void>) | undefined }));

// The one window this file exists for: after the delete read its witness under the lock, before
// its ref transaction. An outside process (a shell, an IDE) is not bound by cezar's lock.
vi.mock('../git-worktree-lock.ts', async (original) => {
  const real = await original<typeof import('../git-worktree-lock.ts')>();
  return {
    ...real,
    withWorktreeMutation: <T>(root: string, operation: Parameters<typeof real.withWorktreeMutation<T>>[1]) =>
      real.withWorktreeMutation(root, (git) =>
        operation(async (cwd, args, timeout, input) => {
          if (args[0] === 'update-ref' && hook.beforeUpdateRef) await hook.beforeUpdateRef();
          return git(cwd, args, timeout, input);
        }),
      ),
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
      { root, runs, isActive: () => false, currentBranch: 'main', hasRemote: false, forge: { prStates: async () => ({ available: true, states: {} }), listPrs: async () => ({ available: true, prs: [] }) } },
      ['cez/aaaaaaaa'],
    );
    expect(result.deleted).toEqual([]);
    expect(await git(root, 'rev-parse', 'cez/aaaaaaaa')).toBe(tip);
  });
});
