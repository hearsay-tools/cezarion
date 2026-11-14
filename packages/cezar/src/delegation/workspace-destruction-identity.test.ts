import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createOwnedWorkspace } from './workspace.ts';
import { removeOwnedWorkspace } from './workspace-removal.ts';
import { fixture, git, receiptPath, WORKSPACE_TEST_TIMEOUT_MS } from './workspace-fixture.testkit.ts';

describe('removeOwnedWorkspace verified retryable destruction', { timeout: WORKSPACE_TEST_TIMEOUT_MS }, () => {
  it('preserves owned resources when shared mutation coordination is unavailable', async () => {
    const { root, first } = await fixture();
    const workspace = await createOwnedWorkspace(root, randomUUID(), first);
    const claims = join(root, '.git/cezar-worktree-mutations');
    await rm(claims, { recursive: true });
    await writeFile(claims, 'coordination unavailable');
    expect(await removeOwnedWorkspace(root, workspace)).toMatchObject({ state: 'incomplete', remaining: ['worktree', 'branch'] });
    expect(existsSync(workspace.path)).toBe(true);
    expect(git(root, 'rev-parse', workspace.branch)).toBe(first);
    await rm(claims);
    expect(await removeOwnedWorkspace(root, workspace)).toMatchObject({ state: 'complete', remaining: [] });
  });

  it('runs beforeRemove once the removal goes ahead, while the checkout still exists (hearsay-tools/cezarion#781: the preview is released first)', async () => {
    const { root, first } = await fixture();
    const workspace = await createOwnedWorkspace(root, randomUUID(), first);
    const seen: boolean[] = [];
    expect(await removeOwnedWorkspace(root, workspace, undefined, async () => { seen.push(existsSync(workspace.path)); }))
      .toMatchObject({ state: 'complete', remaining: [] });
    expect(seen).toEqual([true]);
  });

  it('never runs beforeRemove when the cleanup declines', async () => {
    const { root, first } = await fixture();
    const workspace = await createOwnedWorkspace(root, randomUUID(), first);
    const claims = join(root, '.git/cezar-worktree-mutations');
    await rm(claims, { recursive: true });
    await writeFile(claims, 'coordination unavailable');
    let calls = 0;
    expect(await removeOwnedWorkspace(root, workspace, undefined, async () => { calls += 1; }))
      .toMatchObject({ state: 'incomplete', remaining: ['worktree', 'branch'] });
    expect(calls).toBe(0);
    await rm(claims);
  });

  it('preserves owned resources when cleanup authority is revoked during preflight', async () => {
    const { root, first } = await fixture();
    const workspace = await createOwnedWorkspace(root, randomUUID(), first);
    let attached = true;
    const assertAttached = () => {
      if (!attached) throw new Error('project detached');
      queueMicrotask(() => { attached = false; });
    };

    expect(await removeOwnedWorkspace(root, workspace, assertAttached)).toMatchObject({
      state: 'incomplete', remaining: ['worktree', 'branch'],
    });
    expect(existsSync(workspace.path)).toBe(true);
    expect(git(root, 'branch', '--list', workspace.branch)).not.toBe('');
    expect(existsSync(receiptPath(root, workspace).replace(/\.json$/, '.cleanup.json'))).toBe(false);
  });

  it('preserves the branch when cleanup authority is revoked after worktree removal', async () => {
    const { root, first } = await fixture();
    const workspace = await createOwnedWorkspace(root, randomUUID(), first);
    let revokedAfterRemoval = false;
    const assertAttached = () => {
      if (!existsSync(workspace.path)) {
        revokedAfterRemoval = true;
        throw new Error('project detached');
      }
    };

    expect(await removeOwnedWorkspace(root, workspace, assertAttached)).toMatchObject({
      state: 'incomplete', remaining: ['branch'],
    });
    expect(revokedAfterRemoval).toBe(true);
    expect(existsSync(workspace.path)).toBe(false);
    expect(git(root, 'branch', '--list', workspace.branch)).not.toBe('');
    expect(await removeOwnedWorkspace(root, workspace)).toMatchObject({ state: 'complete', remaining: [] });
  });

  it('removes only owned resources, retains the receipt and is idempotent after reopen', async () => {
    const { root, first, parentPath } = await fixture();
    const workspace = await createOwnedWorkspace(root, randomUUID(), first);
    await writeFile(join(workspace.path, 'tracked.txt'), 'worker commit');
    git(workspace.path, 'commit', '-qam', 'worker');
    const result = await removeOwnedWorkspace(root, workspace);
    expect(result).toEqual({ workerId: workspace.ownerRunId, state: 'complete', remaining: [], deleted: [
      { kind: 'worktree', path: workspace.path }, { kind: 'branch', ref: `refs/heads/${workspace.branch}` },
    ] });
    expect(existsSync(workspace.path)).toBe(false);
    expect(git(root, 'branch', '--list', workspace.branch)).toBe('');
    expect(existsSync(receiptPath(root, workspace))).toBe(true);
    expect(await removeOwnedWorkspace(root, workspace)).toEqual(result);
    expect(await readFile(join(parentPath, 'tracked.txt'), 'utf8')).toBe('dirty');
  });

  for (const attack of ['symlink', 'moved', 'replacement', 'foreign checkout', 'detached', 'same-tip branch', 'missing identity', 'rewritten reflog', 'symlink reflog', 'resource collision'] as const) {
    it(`preserves ambiguous resources: ${attack}`, async () => {
      const { root, first } = await fixture();
      const workspace = await createOwnedWorkspace(root, randomUUID(), first);
      const log = join(root, '.git/logs/refs/heads', workspace.branch);
      if (attack === 'symlink') { await rename(workspace.path, workspace.path + '-moved'); await symlink(workspace.path + '-moved', workspace.path); }
      if (attack === 'moved') git(root, 'worktree', 'move', workspace.path, workspace.path + '-moved');
      if (attack === 'replacement') { git(root, 'worktree', 'remove', '--force', workspace.path); git(root, 'worktree', 'add', workspace.path, workspace.branch); }
      if (attack === 'foreign checkout') git(workspace.path, 'checkout', '-qb', 'unowned');
      if (attack === 'detached') git(workspace.path, 'checkout', '--detach');
      if (attack === 'same-tip branch') {
        // The reflog's creation entry identifies the branch (hearsay-tools/cezarion#904). Pin
        // the recreation to another second; a same-second recreation is the spec's named residual.
        git(workspace.path, 'checkout', '--detach'); git(root, 'branch', '-D', workspace.branch);
        execFileSync('git', ['branch', workspace.branch, first], { cwd: root, env: { ...process.env, GIT_COMMITTER_DATE: '2021-01-01T00:00:00Z' } });
        git(workspace.path, 'checkout', workspace.branch);
      }
      if (attack === 'missing identity') {
        const receipt = JSON.parse(await readFile(receiptPath(root, workspace), 'utf8')); delete receipt.branchIdentity;
        await writeFile(receiptPath(root, workspace), JSON.stringify(receipt));
      }
      if (attack === 'rewritten reflog') await writeFile(log, 'changed');
      if (attack === 'symlink reflog') { await rename(log, log + '-real'); await symlink(log + '-real', log); }
      const target = attack === 'resource collision' ? { ...workspace, resourceId: randomUUID() } : workspace;
      const result = await removeOwnedWorkspace(root, target);
      expect(result).toMatchObject({ state: 'incomplete', remaining: ['worktree', 'branch'] });
      expect(git(root, 'branch', '--list', workspace.branch)).not.toBe('');
      expect(existsSync(attack === 'moved' ? workspace.path + '-moved' : workspace.path)).toBe(true);
      // hearsay-tools/squawk#910: the refusal names where HEAD went and the command that returns it.
      const fix = `Keep the work you need on ${workspace.branch}, run git -C '${workspace.path}' switch '${workspace.branch}', then retry.`;
      if (attack === 'foreign checkout') expect(result.error).toBe(`Worktree HEAD is on unowned, not on its task branch ${workspace.branch}. ${fix}`);
      if (attack === 'detached') expect(result.error).toBe(`Worktree HEAD is detached at ${first.slice(0, 7)}, not on its task branch ${workspace.branch}. ${fix}`);
    });
  }
});
