import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOwnedWorkspace } from './workspace.ts';
import { fixture, git, WORKSPACE_TEST_TIMEOUT_MS } from './workspace-fixture.testkit.ts';

const hook = vi.hoisted(() => ({ beforeContains: undefined as ((sha: string) => void) | undefined }));
afterEach(() => { hook.beforeContains = undefined; });

// The lock seam: a ref that keeps the worker's commits can move between two reads of it, as an
// outside process (a shell, an IDE) that does not follow Squawk's lock can move it.
vi.mock('../git-worktree-lock.ts', async (original) => {
  const real = await original<typeof import('../git-worktree-lock.ts')>();
  return {
    ...real,
    withWorktreeMutation: <T>(root: string, operation: Parameters<typeof real.withWorktreeMutation<T>>[1], options?: { waitMs?: number }) =>
      real.withWorktreeMutation(root, (lockedGit) => operation(async (cwd, args, timeout, input) => {
        if (args[0] === 'for-each-ref' && args[1] === '--contains' && args[2]) hook.beforeContains?.(args[2]);
        return lockedGit(cwd, args, timeout, input);
      }), options),
  };
});

const { removeOwnedWorkspace } = await import('./workspace-removal.ts');

describe('the owned-branch compare-and-swap witnesses (hearsay-tools/squawk#911)', { timeout: WORKSPACE_TEST_TIMEOUT_MS }, () => {
  it('keeps the branch when one ref is seen keeping two different commits', async () => {
    const { root, first } = await fixture();
    const workspace = await createOwnedWorkspace(root, randomUUID(), first);
    await writeFile(join(workspace.path, 'tracked.txt'), 'abandoned');
    git(workspace.path, 'commit', '-qam', 'abandoned');
    git(workspace.path, 'reset', '-q', '--hard', first);
    await writeFile(join(workspace.path, 'tracked.txt'), 'kept');
    git(workspace.path, 'commit', '-qam', 'kept');
    const tip = git(workspace.path, 'rev-parse', 'HEAD');
    git(root, 'branch', 'keeper', tip);
    git(root, 'worktree', 'remove', workspace.path);
    // Each question finds `keeper` at the commit it asks about, so no single state keeps both.
    hook.beforeContains = (sha) => { execFileSync('git', ['update-ref', 'refs/heads/keeper', sha], { cwd: root }); };
    try {
      expect(await removeOwnedWorkspace(root, workspace)).toMatchObject({ state: 'incomplete', remaining: ['branch'] });
    } finally { hook.beforeContains = undefined; }
    expect(git(root, 'rev-parse', workspace.branch)).toBe(tip);
  });

  it('keeps the branch when it moves away and back while its kept commits are proven', async () => {
    const { root, first } = await fixture();
    const workspace = await createOwnedWorkspace(root, randomUUID(), first);
    await writeFile(join(workspace.path, 'tracked.txt'), 'kept');
    git(workspace.path, 'commit', '-qam', 'kept');
    const tip = git(workspace.path, 'rev-parse', 'HEAD');
    git(root, 'branch', 'keeper', tip);
    git(root, 'worktree', 'remove', workspace.path);
    // The first proof prepares the checkpoint; during the second, right before the delete, an outside
    // writer moves the branch to a commit nothing else keeps and back: same tip, new reflog entries.
    let asked = 0;
    hook.beforeContains = () => {
      if (++asked !== 2) return;
      const away = git(root, 'commit-tree', `${tip}^{tree}`, '-p', tip, '-m', 'away');
      git(root, 'update-ref', `refs/heads/${workspace.branch}`, away);
      git(root, 'update-ref', `refs/heads/${workspace.branch}`, tip);
    };
    expect(await removeOwnedWorkspace(root, workspace)).toMatchObject({ state: 'incomplete', remaining: ['branch'] });
    expect(asked).toBe(2);
    expect(git(root, 'rev-parse', workspace.branch)).toBe(tip);
  });
});
