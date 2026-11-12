import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { WorkerWorkspace } from '@open-mercato/cezar-contract';
import { createOwnedWorkspace, removeOwnedWorkspace } from './workspace.ts';
import { fixture, git, receiptPath, WORKSPACE_TEST_TIMEOUT_MS } from './workspace-fixture.testkit.ts';

describe('removeOwnedWorkspace verified retryable destruction', { timeout: WORKSPACE_TEST_TIMEOUT_MS }, () => {
  // hearsay-tools/cezarion#905: the worktree, its admin directory and its registration went away
  // outside Squawk, so no cleanup checkpoint exists, but the branch stayed behind.
  async function strand(root: string, workspace: WorkerWorkspace, shape: 'externally removed' | 'deleted and pruned' | 'moved and pruned') {
    if (shape === 'externally removed') git(root, 'worktree', 'remove', workspace.path);
    else {
      if (shape === 'moved and pruned') await rename(workspace.path, join(root, 'manually-moved-worker'));
      else await rm(workspace.path, { recursive: true, force: true });
      git(root, 'worktree', 'prune', '--expire', 'now');
    }
    expect(git(root, 'worktree', 'list', '--porcelain')).not.toContain(workspace.path);
    expect(existsSync(JSON.parse(await readFile(receiptPath(root, workspace), 'utf8')).gitDir)).toBe(false);
  }

  it.each(['externally removed', 'deleted and pruned', 'moved and pruned'] as const)(
    '%s without a cleanup checkpoint deletes a branch still at its baseline (hearsay-tools/cezarion#905)', async shape => {
      const { root, first } = await fixture();
      const workspace = await createOwnedWorkspace(root, randomUUID(), first);
      await strand(root, workspace, shape);
      const receiptBefore = await readFile(receiptPath(root, workspace), 'utf8');
      let released = 0;
      const result = await removeOwnedWorkspace(root, workspace, undefined, async () => { released += 1; });
      expect(result).toEqual({ workerId: workspace.ownerRunId, state: 'complete', remaining: [], deleted: [
        { kind: 'worktree', path: workspace.path }, { kind: 'branch', ref: `refs/heads/${workspace.branch}` }] });
      expect(released).toBe(1);
      expect(git(root, 'branch', '--list', workspace.branch)).toBe('');
      expect(await readFile(receiptPath(root, workspace), 'utf8')).toBe(receiptBefore);
      expect(JSON.parse(await readFile(receiptPath(root, workspace).replace(/\.json$/, '.cleanup.json'), 'utf8')))
        .toMatchObject({ sha: first, phase: 'complete' });
      if (shape === 'moved and pruned') expect(await readFile(join(root, 'manually-moved-worker', 'tracked.txt'), 'utf8')).toBe('base');
      expect(await removeOwnedWorkspace(root, workspace)).toEqual(result);
    },
  );

  it.each([['committed on', 1], ['advanced past', 2]] as const)(
    'keeps a stranded branch %s its baseline and names it with the commit count (hearsay-tools/cezarion#905)', async (how, commits) => {
      const { root, first } = await fixture();
      const workspace = await createOwnedWorkspace(root, randomUUID(), first);
      for (let n = 0; n < commits; n += 1) {
        await writeFile(join(workspace.path, 'tracked.txt'), `worker ${n}`);
        git(workspace.path, 'commit', '-qam', `worker ${n}`);
      }
      const tip = git(workspace.path, 'rev-parse', 'HEAD');
      if (how === 'advanced past') git(workspace.path, 'checkout', '-q', '--detach', first);
      await strand(root, workspace, 'deleted and pruned');
      let released = 0;
      const result = await removeOwnedWorkspace(root, workspace, undefined, async () => { released += 1; });
      expect(result).toMatchObject({ state: 'incomplete', remaining: ['branch'] });
      expect(result.error).toBe(`Owned branch ${workspace.branch} holds ${commits} commit${commits === 1 ? '' : 's'} beyond its worker baseline; ` +
        'keep what you need, delete the branch, then retry destroy');
      expect(released).toBe(0);
      expect(git(root, 'rev-parse', workspace.branch)).toBe(tip);
      expect(existsSync(receiptPath(root, workspace).replace(/\.json$/, '.cleanup.json'))).toBe(false);
      // A human deleting the branch is what lets the next retry finish.
      git(root, 'branch', '-D', workspace.branch);
      expect(await removeOwnedWorkspace(root, workspace)).toMatchObject({ state: 'complete', remaining: [] });
    },
  );

  it('keeps a stranded branch moved behind its baseline, though it holds no commits of its own (hearsay-tools/cezarion#905)', async () => {
    const { root, first, second } = await fixture();
    const workspace = await createOwnedWorkspace(root, randomUUID(), second);
    await strand(root, workspace, 'externally removed');
    git(root, 'update-ref', `refs/heads/${workspace.branch}`, first);
    const result = await removeOwnedWorkspace(root, workspace);
    expect(result).toMatchObject({ state: 'incomplete', remaining: ['branch'] });
    expect(result.error).toBe(`Owned branch ${workspace.branch} no longer points at its worker baseline; ` +
      'keep what you need, delete the branch, then retry destroy');
    expect(git(root, 'rev-parse', workspace.branch)).toBe(first);
  });

  it('keeps a stranded branch reset to its baseline, whose reflog still records worker commits (hearsay-tools/cezarion#905)', async () => {
    const { root, first } = await fixture();
    const workspace = await createOwnedWorkspace(root, randomUUID(), first);
    await writeFile(join(workspace.path, 'tracked.txt'), 'worker');
    git(workspace.path, 'commit', '-qam', 'worker');
    git(workspace.path, 'reset', '-q', '--hard', first);
    await strand(root, workspace, 'deleted and pruned');
    const reflog = await readFile(join(root, '.git/logs/refs/heads', workspace.branch), 'utf8');
    const result = await removeOwnedWorkspace(root, workspace);
    expect(result).toMatchObject({ state: 'incomplete', remaining: ['branch'] });
    expect(result.error).toBe(`Owned branch ${workspace.branch} returned to its worker baseline after holding other commits; ` +
      'keep what you need, delete the branch, then retry destroy');
    expect(git(root, 'rev-parse', workspace.branch)).toBe(first);
    expect(await readFile(join(root, '.git/logs/refs/heads', workspace.branch), 'utf8')).toBe(reflog);
    expect(existsSync(receiptPath(root, workspace).replace(/\.json$/, '.cleanup.json'))).toBe(false);
  });

  it('refuses a stranded branch another worktree has checked out (hearsay-tools/cezarion#905)', async () => {
    const { root, first } = await fixture();
    const workspace = await createOwnedWorkspace(root, randomUUID(), first);
    await strand(root, workspace, 'externally removed');
    const other = join(root, 'other-checkout');
    git(root, 'worktree', 'add', '-q', other, workspace.branch);
    expect(await removeOwnedWorkspace(root, workspace)).toMatchObject({ state: 'incomplete', remaining: ['branch'] });
    expect(git(root, 'branch', '--list', workspace.branch)).not.toBe('');
    expect(existsSync(receiptPath(root, workspace).replace(/\.json$/, '.cleanup.json'))).toBe(false);
    git(root, 'worktree', 'remove', other);
    expect(await removeOwnedWorkspace(root, workspace)).toMatchObject({ state: 'complete', remaining: [] });
  });

  it('refuses a stranded branch recreated under the worker name (hearsay-tools/cezarion#905)', async () => {
    const { root, first } = await fixture();
    const workspace = await createOwnedWorkspace(root, randomUUID(), first);
    await strand(root, workspace, 'externally removed');
    git(root, 'branch', '-D', workspace.branch);
    execFileSync('git', ['branch', workspace.branch, first], { cwd: root, env: { ...process.env, GIT_COMMITTER_DATE: '2021-01-01T00:00:00Z' } });
    expect(await removeOwnedWorkspace(root, workspace)).toMatchObject({ state: 'incomplete', remaining: ['branch'] });
    expect(git(root, 'rev-parse', workspace.branch)).toBe(first);
    expect(existsSync(receiptPath(root, workspace).replace(/\.json$/, '.cleanup.json'))).toBe(false);
  });

  it('deletes a stranded branch only by compare-and-swap on the baseline (hearsay-tools/cezarion#905)', async () => {
    const { root, first, second } = await fixture();
    const workspace = await createOwnedWorkspace(root, randomUUID(), first);
    await strand(root, workspace, 'externally removed');
    // The branch moves after the baseline check, while the preview is released.
    expect(await removeOwnedWorkspace(root, workspace, undefined, async () => {
      git(root, 'update-ref', `refs/heads/${workspace.branch}`, second);
    })).toMatchObject({ state: 'incomplete', remaining: ['branch'] });
    expect(git(root, 'rev-parse', workspace.branch)).toBe(second);
  });

  it('resumes a stranded branch delete from its checkpoint after the delete failed (hearsay-tools/cezarion#905)', async () => {
    const { root, first } = await fixture();
    const workspace = await createOwnedWorkspace(root, randomUUID(), first);
    await strand(root, workspace, 'deleted and pruned');
    const lock = join(root, '.git/refs/heads', workspace.branch + '.lock');
    await writeFile(lock, 'test lock');
    expect(await removeOwnedWorkspace(root, workspace)).toMatchObject({ state: 'incomplete', remaining: ['branch'] });
    expect(JSON.parse(await readFile(receiptPath(root, workspace).replace(/\.json$/, '.cleanup.json'), 'utf8')))
      .toMatchObject({ sha: first, phase: 'worktree-removed' });
    await rm(lock);
    expect(await removeOwnedWorkspace(root, workspace)).toMatchObject({ state: 'complete', remaining: [] });
    expect(git(root, 'branch', '--list', workspace.branch)).toBe('');
  });

});
