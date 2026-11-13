import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createOwnedWorkspace, planOwnedWorkspace } from './workspace.ts';
import { removeOwnedWorkspace } from './workspace-removal.ts';
import { fixture, git, receiptPath, WORKSPACE_TEST_TIMEOUT_MS } from './workspace-fixture.testkit.ts';

describe('removeOwnedWorkspace verified retryable destruction', { timeout: WORKSPACE_TEST_TIMEOUT_MS }, () => {
  it('completes bookkeeping when recorded worktree, gitDir and branch are already gone without a checkpoint', async () => {
    const { root, first } = await fixture();
    const workspace = await createOwnedWorkspace(root, randomUUID(), first);
    const receipt = receiptPath(root, workspace);
    const receiptBefore = await readFile(receipt, 'utf8');
    const gitDir = JSON.parse(receiptBefore).gitDir as string;
    git(root, 'worktree', 'remove', workspace.path);
    git(root, 'branch', '-D', workspace.branch);
    expect(existsSync(workspace.path)).toBe(false);
    expect(existsSync(gitDir)).toBe(false);
    const result = await removeOwnedWorkspace(root, workspace);
    expect(result).toMatchObject({ state: 'complete', remaining: [] });
    expect(result).not.toHaveProperty('error');
    expect(existsSync(workspace.path)).toBe(false);
    expect(git(root, 'branch', '--list', workspace.branch)).toBe('');
    expect(await readFile(receipt, 'utf8')).toBe(receiptBefore);
    expect(existsSync(receipt.replace(/\.json$/, '.cleanup.json'))).toBe(false);
    expect(await removeOwnedWorkspace(root, workspace)).toEqual(result);
  });

  it('runs beforeRemove when completing bookkeeping for already-gone recorded resources', async () => {
    const { root, first } = await fixture();
    const workspace = await createOwnedWorkspace(root, randomUUID(), first);
    git(root, 'worktree', 'remove', workspace.path);
    git(root, 'branch', '-D', workspace.branch);
    let calls = 0;
    expect(await removeOwnedWorkspace(root, workspace, undefined, async () => { calls += 1; }))
      .toMatchObject({ state: 'complete', remaining: [] });
    expect(calls).toBe(1);
  });

  it('does not complete if recorded resources reappear during beforeRemove', async () => {
    const { root, first } = await fixture();
    const workspace = await createOwnedWorkspace(root, randomUUID(), first);
    git(root, 'worktree', 'remove', workspace.path);
    git(root, 'branch', '-D', workspace.branch);
    expect(await removeOwnedWorkspace(root, workspace, undefined, async () => {
      git(root, 'branch', workspace.branch, first);
    })).toMatchObject({ state: 'incomplete', remaining: ['worktree', 'branch'] });
    expect(git(root, 'branch', '--list', workspace.branch)).not.toBe('');
    expect(existsSync(workspace.path)).toBe(false);
  });

  it('preserves the owned directory on the first cleanup attempt when its branch is checked out elsewhere', async () => {
    const { root, first } = await fixture();
    const workspace = await createOwnedWorkspace(root, randomUUID(), first);
    const other = join(root, 'other-checkout');
    git(root, 'worktree', 'add', '--force', other, workspace.branch);
    expect.soft(await removeOwnedWorkspace(root, workspace)).toMatchObject({ state: 'incomplete', remaining: ['worktree', 'branch'] });
    expect.soft(existsSync(workspace.path)).toBe(true);
    expect(existsSync(other)).toBe(true);
    expect(git(root, 'branch', '--list', workspace.branch)).not.toBe('');
    git(root, 'worktree', 'remove', other);
    expect(await removeOwnedWorkspace(root, workspace)).toMatchObject({ state: 'complete' });
  });

  it('missing receipt cannot prove cleanup while a moved and renamed worktree still carries the resource marker', async () => {
    const { root, first } = await fixture();
    const workspace = await createOwnedWorkspace(root, randomUUID(), first);
    const moved = workspace.path + '-moved';
    git(root, 'worktree', 'move', workspace.path, moved);
    git(moved, 'branch', '-m', 'renamed-worker');
    await rm(receiptPath(root, workspace));
    expect(await removeOwnedWorkspace(root, workspace)).toMatchObject({ state: 'incomplete', remaining: ['worktree', 'branch'] });
    expect(existsSync(moved)).toBe(true);
    expect(git(root, 'branch', '--list', 'renamed-worker')).not.toBe('');
  });

  it('completes bookkeeping for a planned workspace that never left a receipt or any Git resource (hearsay-tools/cezarion#878)', async () => {
    const { root, first } = await fixture();
    const workspace = await planOwnedWorkspace(root, randomUUID(), first);
    const result = await removeOwnedWorkspace(root, workspace);
    expect(result).toEqual({ workerId: workspace.ownerRunId, state: 'complete', remaining: [] });
    expect(existsSync(receiptPath(root, workspace))).toBe(false);
    expect(existsSync(receiptPath(root, workspace).replace(/\.json$/, '.cleanup.json'))).toBe(false);
  });

  it('completes bookkeeping when the receipt, worktree, registration and branch are all already gone (hearsay-tools/cezarion#878)', async () => {
    const { root, first } = await fixture();
    const workspace = await createOwnedWorkspace(root, randomUUID(), first);
    const receipt = receiptPath(root, workspace);
    const gitDir = JSON.parse(await readFile(receipt, 'utf8')).gitDir as string;
    git(root, 'worktree', 'remove', workspace.path);
    git(root, 'branch', '-D', workspace.branch);
    await rm(receipt);
    expect(existsSync(gitDir)).toBe(false);
    let calls = 0;
    const result = await removeOwnedWorkspace(root, workspace, undefined, async () => { calls += 1; });
    expect(result).toEqual({ workerId: workspace.ownerRunId, state: 'complete', remaining: [] });
    expect(calls).toBe(1);
    // Bookkeeping only: no synthetic receipt or cleanup checkpoint is written.
    expect(existsSync(receipt)).toBe(false);
    expect(existsSync(receipt.replace(/\.json$/, '.cleanup.json'))).toBe(false);
    expect(await removeOwnedWorkspace(root, workspace)).toEqual(result);
  });

  it('keeps destroy incomplete when the receipt and worktree are gone but the branch is left over (hearsay-tools/cezarion#878)', async () => {
    const { root, first } = await fixture();
    const workspace = await createOwnedWorkspace(root, randomUUID(), first);
    git(root, 'worktree', 'remove', workspace.path);
    await rm(receiptPath(root, workspace));
    expect(await removeOwnedWorkspace(root, workspace)).toMatchObject({ state: 'incomplete', remaining: ['worktree', 'branch'] });
    expect(git(root, 'rev-parse', workspace.branch)).toBe(first);
    expect(existsSync(receiptPath(root, workspace).replace(/\.json$/, '.cleanup.json'))).toBe(false);
  });

  it('does not complete a receipt-absent destroy if the branch reappears during beforeRemove (hearsay-tools/cezarion#878)', async () => {
    const { root, first } = await fixture();
    const workspace = await createOwnedWorkspace(root, randomUUID(), first);
    git(root, 'worktree', 'remove', workspace.path);
    git(root, 'branch', '-D', workspace.branch);
    await rm(receiptPath(root, workspace));
    expect(await removeOwnedWorkspace(root, workspace, undefined, async () => {
      git(root, 'branch', workspace.branch, first);
    })).toMatchObject({ state: 'incomplete', remaining: ['worktree', 'branch'] });
    expect(git(root, 'rev-parse', workspace.branch)).toBe(first);
  });

});
