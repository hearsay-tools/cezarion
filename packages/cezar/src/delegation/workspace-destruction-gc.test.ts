import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { lstat, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { WorkerWorkspace } from '@open-mercato/cezar-contract';
import { createOwnedWorkspace } from './workspace.ts';
import { removeOwnedWorkspace } from './workspace-removal.ts';
import { fixture, git, receiptPath, WORKSPACE_TEST_TIMEOUT_MS } from './workspace-fixture.testkit.ts';

describe('removeOwnedWorkspace verified retryable destruction', { timeout: WORKSPACE_TEST_TIMEOUT_MS }, () => {
  // hearsay-tools/cezarion#904: `git gc` expires every reflog by writing it to a lock file and
  // renaming that over the original. Kept entries survive byte-for-byte; the file is a new inode.
  async function gcRewritesReflog(root: string, workspace: WorkerWorkspace) {
    const log = join(root, '.git/logs/refs/heads', workspace.branch);
    const before = await lstat(log); const content = await readFile(log);
    git(root, 'gc', '--quiet');
    expect((await lstat(log)).ino).not.toBe(before.ino);
    expect(await readFile(log)).toEqual(content);
  }

  it('completes after git gc rewrote the branch reflog between provisioning and destroy (hearsay-tools/cezarion#904)', async () => {
    const { root, first } = await fixture(); const workspace = await createOwnedWorkspace(root, randomUUID(), first);
    // Still recorded, though no longer compared: an older Squawk requires it to parse the receipt.
    expect(JSON.parse(await readFile(receiptPath(root, workspace), 'utf8')).branchIdentity.file).toMatchObject({ ino: expect.any(Number) });
    await gcRewritesReflog(root, workspace);
    expect(await removeOwnedWorkspace(root, workspace)).toMatchObject({ state: 'complete', remaining: [] });
    expect(existsSync(workspace.path)).toBe(false); expect(git(root, 'branch', '--list', workspace.branch)).toBe('');
  });

  it('completes after git gc rewrote the branch reflog between prepare and removal (hearsay-tools/cezarion#904)', async () => {
    const { root, first } = await fixture(); const workspace = await createOwnedWorkspace(root, randomUUID(), first);
    expect(await removeOwnedWorkspace(root, workspace, undefined, () => gcRewritesReflog(root, workspace)))
      .toMatchObject({ state: 'complete', remaining: [] });
    expect(existsSync(workspace.path)).toBe(false); expect(git(root, 'branch', '--list', workspace.branch)).toBe('');
  });

  it('retries a prepared checkpoint after git gc rewrote the branch reflog (hearsay-tools/cezarion#904)', async () => {
    const { root, first } = await fixture(); const workspace = await createOwnedWorkspace(root, randomUUID(), first);
    expect(await removeOwnedWorkspace(root, workspace, undefined, async () => { throw new Error('preview release failed'); }))
      .toMatchObject({ state: 'incomplete', remaining: ['worktree', 'branch'] });
    const checkpoint = receiptPath(root, workspace).replace(/\.json$/, '.cleanup.json');
    expect(JSON.parse(await readFile(checkpoint, 'utf8'))).toMatchObject({ phase: 'prepared', logFile: { ino: expect.any(Number) } });
    await gcRewritesReflog(root, workspace);
    expect(await removeOwnedWorkspace(root, workspace)).toMatchObject({ state: 'complete', remaining: [] });
    expect(existsSync(workspace.path)).toBe(false); expect(git(root, 'branch', '--list', workspace.branch)).toBe('');
  });

  it('refuses a branch deleted and recreated at the same tip after partial removal (hearsay-tools/cezarion#904)', async () => {
    const { root, first } = await fixture(); const workspace = await createOwnedWorkspace(root, randomUUID(), first);
    const lock = join(root, '.git/refs/heads', workspace.branch + '.lock'); await writeFile(lock, 'lock');
    expect(await removeOwnedWorkspace(root, workspace)).toMatchObject({ remaining: ['branch'] }); await rm(lock);
    git(root, 'branch', '-D', workspace.branch);
    execFileSync('git', ['branch', workspace.branch, first], { cwd: root, env: { ...process.env, GIT_COMMITTER_DATE: '2021-01-01T00:00:00Z' } });
    expect(await removeOwnedWorkspace(root, workspace)).toMatchObject({ state: 'incomplete', remaining: ['branch'] });
    expect(git(root, 'rev-parse', workspace.branch)).toBe(first);
  });
});
