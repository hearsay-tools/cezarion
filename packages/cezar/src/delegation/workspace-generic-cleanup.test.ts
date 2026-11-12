import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createWorktree, pruneOrphans, removeWorktree } from '../git-worktree.ts';
import { createOwnedWorkspace } from './workspace.ts';
import { removeOwnedWorkspace } from './workspace-removal.ts';
import { fixture, git, receiptPath, WORKSPACE_TEST_TIMEOUT_MS } from './workspace-fixture.testkit.ts';

describe('owned resources bypass generic cleanup', { timeout: WORKSPACE_TEST_TIMEOUT_MS }, () => {
  it('preserves an owned orphan and receipt even when its run index is absent', async () => {
    const { root, first } = await fixture(); const workspace = await createOwnedWorkspace(root, randomUUID(), first);
    expect(await pruneOrphans(root, new Set())).not.toContain(workspace.ownerRunId);
    expect(existsSync(workspace.path)).toBe(true);
    await removeWorktree(root, workspace.path, workspace.branch);
    expect(existsSync(workspace.path)).toBe(true);
    expect(git(root, 'branch', '--list', workspace.branch)).not.toBe('');
  });
  it('lets retention reclaim an owned directory without deleting the branch (hearsay-tools/cezarion#575)', async () => {
    const { root, first } = await fixture(); const workspace = await createOwnedWorkspace(root, randomUUID(), first);
    await removeWorktree(root, workspace.path, workspace.branch, { reclaimOwnedDirectory: true });
    expect(existsSync(workspace.path)).toBe(true);
    expect(git(root, 'branch', '--list', workspace.branch)).not.toBe('');
    await removeWorktree(root, workspace.path, undefined, { reclaimOwnedDirectory: true });
    expect(existsSync(workspace.path)).toBe(false);
    expect(git(root, 'branch', '--list', workspace.branch)).not.toBe('');
  });
  it('does not recursively delete a substituted owned path on directory reclaim (hearsay-tools/cezarion#575)', async () => {
    const { root, first } = await fixture(); const workspace = await createOwnedWorkspace(root, randomUUID(), first);
    git(root, 'worktree', 'remove', '--force', workspace.path);
    await mkdir(workspace.path); await writeFile(join(workspace.path, 'unrelated'), 'keep');
    await removeWorktree(root, workspace.path, undefined, { reclaimOwnedDirectory: true });
    expect(await readFile(join(workspace.path, 'unrelated'), 'utf8')).toBe('keep');
  });
  it('preserves receipt-owned substituted paths from generic recursive removal', async () => {
    const { root, first } = await fixture(); const workspace = await createOwnedWorkspace(root, randomUUID(), first);
    git(root, 'worktree', 'remove', '--force', workspace.path);
    await mkdir(workspace.path); await writeFile(join(workspace.path, 'unrelated'), 'keep');
    expect(await pruneOrphans(root, new Set())).not.toContain(workspace.ownerRunId);
    expect(await readFile(join(workspace.path, 'unrelated'), 'utf8')).toBe('keep');
  });
  it('does not let a short branch collision adopt a partially removed worker branch', async () => {
    const { root, first } = await fixture(); const workspace = await createOwnedWorkspace(root, randomUUID(), first);
    const lock = join(root, '.git/refs/heads', workspace.branch + '.lock'); await writeFile(lock, 'lock');
    expect(await removeOwnedWorkspace(root, workspace)).toMatchObject({ remaining: ['branch'] }); await rm(lock);
    const collidingId = workspace.ownerRunId.slice(0, 8) + randomUUID().slice(8);
    await expect(createWorktree(root, collidingId, first)).rejects.toThrow();
    expect(existsSync(join(root, '.ai/cezar/worktrees', collidingId))).toBe(false);
  });

  it('does not infer permission from a symlinked receipt directory', async () => {
    const { root, first } = await fixture(); const workspace = await createOwnedWorkspace(root, randomUUID(), first);
    git(root, 'worktree', 'remove', '--force', workspace.path); await mkdir(workspace.path);
    await writeFile(join(workspace.path, 'keep'), 'unrelated');
    const receipts = join(root, '.git/cezar-owned-workspaces'); await rename(receipts, receipts + '-saved');
    const empty = join(root, 'empty'); await mkdir(empty); await symlink(empty, receipts);
    expect(await pruneOrphans(root, new Set())).toEqual([]);
    expect(await readFile(join(workspace.path, 'keep'), 'utf8')).toBe('unrelated');
  });

  it('malformed logical receipt ownership cannot authorize generic deletion of a replacement', async () => {
    const { root, first } = await fixture(); const workspace = await createOwnedWorkspace(root, randomUUID(), first);
    git(root, 'worktree', 'remove', '--force', workspace.path); await mkdir(workspace.path);
    await writeFile(join(workspace.path, 'keep'), 'unrelated');
    const path = receiptPath(root, workspace); const receipt = JSON.parse(await readFile(path, 'utf8'));
    receipt.workspace.path = join(root, 'elsewhere'); receipt.workspace.branch = 'unowned';
    await writeFile(path, JSON.stringify(receipt));
    expect(await pruneOrphans(root, new Set())).toEqual([]);
    expect(await readFile(join(workspace.path, 'keep'), 'utf8')).toBe('unrelated');
    expect(git(root, 'branch', '--list', workspace.branch)).not.toBe('');
  });

});
