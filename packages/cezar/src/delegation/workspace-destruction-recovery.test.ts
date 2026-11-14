import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createOwnedWorkspace } from './workspace.ts';
import { removeOwnedWorkspace } from './workspace-removal.ts';
import { fixture, git, receiptPath, WORKSPACE_TEST_TIMEOUT_MS } from './workspace-fixture.testkit.ts';

describe('removeOwnedWorkspace verified retryable destruction', { timeout: WORKSPACE_TEST_TIMEOUT_MS }, () => {
  it('retries branch-only cleanup after a locked ref; rejects repurposing after partial cleanup', async () => {
    const { root, first } = await fixture();
    const workspace = await createOwnedWorkspace(root, randomUUID(), first);
    const lock = join(root, '.git/refs/heads', workspace.branch + '.lock');
    await writeFile(lock, 'test lock');
    expect(await removeOwnedWorkspace(root, workspace)).toMatchObject({ state: 'incomplete', remaining: ['branch'] });
    expect(existsSync(workspace.path)).toBe(false);
    await rm(lock);
    expect(await removeOwnedWorkspace(root, workspace)).toMatchObject({ state: 'complete', remaining: [] });
    git(root, 'branch', workspace.branch, first);
    expect(await removeOwnedWorkspace(root, workspace)).toMatchObject({ state: 'incomplete', remaining: ['branch'] });
    expect(git(root, 'branch', '--list', workspace.branch)).not.toBe('');
  });

  it('refuses changed branch tip and checkout elsewhere after partial removal', async () => {
    const { root, first, second } = await fixture();
    const workspace = await createOwnedWorkspace(root, randomUUID(), first);
    const lock = join(root, '.git/refs/heads', workspace.branch + '.lock'); await writeFile(lock, 'lock');
    expect(await removeOwnedWorkspace(root, workspace)).toMatchObject({ remaining: ['branch'] }); await rm(lock);
    git(root, 'branch', '-f', workspace.branch, second);
    const commits = Number(git(root, 'rev-list', '--count', `${first}..${second}`));
    expect(await removeOwnedWorkspace(root, workspace)).toMatchObject({ state: 'incomplete', remaining: ['branch'],
      error: `Owned branch ${workspace.branch} holds ${commits} commit${commits === 1 ? '' : 's'} beyond the tip destroy recorded; ` +
        'keep what you need, delete the branch, then retry destroy' }); // hearsay-tools/squawk#910
    git(root, 'worktree', 'add', join(root, 'other-checkout'), workspace.branch);
    expect(await removeOwnedWorkspace(root, workspace)).toMatchObject({ state: 'incomplete', remaining: ['branch'] });
    expect(git(root, 'rev-parse', workspace.branch)).toBe(second);
  });

  it.each(['prepared', 'worktree-removed'])('replays a durable %s checkpoint after directory removal', async phase => {
    const { root, first } = await fixture(); const workspace = await createOwnedWorkspace(root, randomUUID(), first);
    const lock = join(root, '.git/refs/heads', workspace.branch + '.lock'); await writeFile(lock, 'lock');
    expect(await removeOwnedWorkspace(root, workspace)).toMatchObject({ remaining: ['branch'] }); await rm(lock);
    const path = receiptPath(root, workspace).replace(/\.json$/, '.cleanup.json');
    const checkpoint = JSON.parse(await readFile(path, 'utf8')); checkpoint.phase = phase;
    await writeFile(path, JSON.stringify(checkpoint));
    expect(await removeOwnedWorkspace(root, workspace)).toMatchObject({ state: 'complete', remaining: [] });
    expect(await removeOwnedWorkspace(root, workspace)).toMatchObject({ state: 'complete', remaining: [] });
  });

  it.each(['malformed', 'symlink'])('refuses a %s private cleanup checkpoint before deletion', async shape => {
    const { root, first } = await fixture(); const workspace = await createOwnedWorkspace(root, randomUUID(), first);
    const path = receiptPath(root, workspace).replace(/\.json$/, '.cleanup.json');
    if (shape === 'malformed') await writeFile(path, '{}', { mode: 0o600 });
    else { const target = join(root, 'outside-checkpoint'); await writeFile(target, '{}'); await symlink(target, path); }
    expect(await removeOwnedWorkspace(root, workspace)).toMatchObject({ state: 'incomplete', remaining: ['worktree', 'branch'] });
    expect(existsSync(workspace.path)).toBe(true);
  });

  it('never recursively removes a locked worktree and can retry after unlock', async () => {
    const { root, first } = await fixture(); const workspace = await createOwnedWorkspace(root, randomUUID(), first);
    git(root, 'worktree', 'lock', workspace.path);
    expect(await removeOwnedWorkspace(root, workspace)).toMatchObject({ state: 'incomplete', remaining: ['worktree', 'branch'] });
    expect(existsSync(workspace.path)).toBe(true); git(root, 'worktree', 'unlock', workspace.path);
    expect(await removeOwnedWorkspace(root, workspace)).toMatchObject({ state: 'complete' });
  });
});
