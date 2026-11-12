import { projectPaths } from '../project-paths.ts';
import { copyWorkspaceSeed, workspaceSeed } from './workspace-seed.testkit.ts';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { createWorktree } from '../git-worktree.ts';
import { autosaveCommit } from '../autosave-commit.ts';
import { createOwnedWorkspace, ensureOwnedWorkspace, planOwnedWorkspace, readOwnedDiff, resolveWorkerBaseline, verifyOwnedWorkspace } from './workspace.ts';
import { roots, fixture, durableRun, git, receiptPath, WORKSPACE_TEST_TIMEOUT_MS } from './workspace-fixture.testkit.ts';

function repositoryState(root: string) {
  return {
    refs: git(root, 'show-ref'),
    head: git(root, 'symbolic-ref', 'HEAD'),
    config: git(root, 'config', '--local', '--list'),
    index: git(root, 'ls-files', '--stage'),
    status: git(root, 'status', '--porcelain'),
  };
}

it('copies seed repositories without sharing Git files or working files', async () => {
  const first = await mkdtemp(join(tmpdir(), 'cez-seed-isolation-'));
  const second = await mkdtemp(join(tmpdir(), 'cez-seed-isolation-'));
  roots.push(first, second);
  await copyWorkspaceSeed(first);
  await copyWorkspaceSeed(second);
  const template = await workspaceSeed();
  const original = repositoryState(template);
  expect(repositoryState(first)).toEqual(original);
  expect(repositoryState(second)).toEqual(original);
  for (const path of ['tracked.txt', '.git/HEAD', '.git/config', '.git/index']) {
    const files = await Promise.all([first, second, template].map(root => lstat(join(root, path), { bigint: true })));
    expect(new Set(files.map(file => `${file.dev}:${file.ino}`)).size).toBe(3);
  }
  git(first, 'checkout', '-qb', 'isolated');
  git(first, 'config', 'fixture.only', 'first');
  await writeFile(join(first, 'tracked.txt'), 'changed');
  git(first, 'commit', '-qam', 'isolated change');
  await writeFile(join(first, 'staged.txt'), 'index change');
  git(first, 'add', 'staged.txt');
  expect(repositoryState(first)).not.toEqual(original);
  for (const root of [second, template]) {
    expect(repositoryState(root)).toEqual(original);
    expect(await readFile(join(root, 'tracked.txt'), 'utf8')).toBe('base');
    expect(existsSync(join(root, 'staged.txt'))).toBe(false);
  }
});

describe('owned workspace committed isolation', { timeout: WORKSPACE_TEST_TIMEOUT_MS }, () => {
  it('pins parent HEAD, excludes dirty tracked/untracked files, and never autosaves the parent', async () => {
    const { root, parentPath, first, second } = await fixture();
    const status = git(parentPath, 'status', '--porcelain');
    const pinned = await resolveWorkerBaseline(root, parentPath, 'parent-head');
    expect(pinned).toBe(second); expect(pinned).not.toBe(first);
    const workspace = await createOwnedWorkspace(root, randomUUID(), pinned);
    expect(workspace.baselineSha).toBe(pinned);
    expect(await readFile(join(parentPath, 'tracked.txt'), 'utf8')).toBe('dirty');
    expect(await readFile(join(workspace.path, 'tracked.txt'), 'utf8')).toBe('committed');
    expect(existsSync(join(workspace.path, 'untracked.txt'))).toBe(false);
    expect(git(parentPath, 'status', '--porcelain')).toBe(status);
    expect(git(parentPath, 'rev-parse', 'HEAD')).toBe(second);
    expect(await autosaveCommit(parentPath, 'turn end')).toBe('committed');
    expect(git(parentPath, 'log', '-1', '--format=%s')).toBe('cezar autosave (turn end)');
  });

  it('keeps a resolved named ref pinned after it moves before creation', async () => {
    const { root, parentPath, first, second } = await fixture();
    git(root, 'branch', 'chosen', first);
    const pinned = await resolveWorkerBaseline(root, parentPath, 'chosen');
    git(root, 'branch', '-f', 'chosen', second);
    const workspace = await createOwnedWorkspace(root, randomUUID(), pinned);
    expect(workspace.baselineSha).toBe(first);
    expect(git(workspace.path, 'rev-parse', 'HEAD')).toBe(first);
  });

  it('rejects non-Git parents, foreign repositories, invalid refs and noncommits', async () => {
    const { root, parentPath } = await fixture();
    const nonGit = await mkdtemp(join(tmpdir(), 'cez-owned-nongit-')); roots.push(nonGit);
    const foreign = await fixture();
    for (const cwd of [nonGit, foreign.root]) {
      await expect(resolveWorkerBaseline(root, cwd, 'main')).rejects.toMatchObject({ code: 'invalid_baseline' });
    }
    for (const ref of ['', '--output=unsafe', 'missing', 'HEAD:tracked.txt', 'a'.repeat(1025), 'HEAD\0']) {
      await expect(resolveWorkerBaseline(root, parentPath, ref)).rejects.toMatchObject({ code: 'invalid_baseline' });
    }
    await expect(createOwnedWorkspace(nonGit, randomUUID(), 'a'.repeat(40))).rejects.toThrow();
    await expect(createOwnedWorkspace(root, randomUUID(), 'main')).rejects.toThrow();
    await expect(createOwnedWorkspace(root, '../escape', git(root, 'rev-parse', 'HEAD'))).rejects.toThrow();
  });

  it('plans without Git side effects, persists intent and provisions the same resource for recovery', async () => {
    const { root, second } = await fixture();
    const workspace = await planOwnedWorkspace(root, randomUUID(), second);
    expect(existsSync(workspace.path)).toBe(false);
    expect(git(root, 'branch', '--list', workspace.branch)).toBe('');
    const { run } = durableRun(root, workspace);
    expect(RunStore.open(projectPaths(root).write).getRun(run.id)?.delegation).toEqual(run.delegation);
    expect(await ensureOwnedWorkspace(root, run)).toEqual(workspace);
    expect(await ensureOwnedWorkspace(root, run)).toEqual(workspace);
    expect(await verifyOwnedWorkspace(root, run)).toEqual(workspace);
    expect((await lstat(receiptPath(root, workspace))).mode & 0o777).toBe(0o600);
    expect((await lstat(join(root, '.git', 'cezar-owned-workspaces'))).mode & 0o777).toBe(0o700);
  });

  it.each(['branch', 'directory', 'registered', 'stale-registration'])('never adopts a colliding %s without a receipt', async (collision) => {
    const { root, second } = await fixture();
    const workspace = await planOwnedWorkspace(root, randomUUID(), second);
    const { run } = durableRun(root, workspace);
    if (collision === 'branch') git(root, 'branch', workspace.branch, second);
    else if (collision === 'directory') await mkdir(workspace.path, { recursive: true });
    else {
      await createWorktree(root, run.id, second);
      if (collision === 'stale-registration') await rm(workspace.path, { recursive: true });
    }
    const registrations = git(root, 'worktree', 'list', '--porcelain');
    await expect(ensureOwnedWorkspace(root, run)).rejects.toThrow();
    await expect(createOwnedWorkspace(root, run.id, second, workspace)).rejects.toThrow();
    expect(git(root, 'worktree', 'list', '--porcelain')).toBe(registrations);
  });

  it('rejects fresh creation even when an existing resource has a valid receipt', async () => {
    const { root, second } = await fixture();
    const workspace = await createOwnedWorkspace(root, randomUUID(), second);
    await expect(createOwnedWorkspace(root, workspace.ownerRunId, second, workspace)).rejects.toThrow();
  });

  it.each(['malformed', 'mismatch', 'symlink-file', 'symlink-directory'])('fails closed on %s receipt substitution', async (mode) => {
    const { root, second } = await fixture();
    const workspace = await createOwnedWorkspace(root, randomUUID(), second);
    const { run } = durableRun(root, workspace);
    const path = receiptPath(root, workspace);
    if (mode === 'malformed') await writeFile(path, '{broken');
    if (mode === 'mismatch') {
      const receipt = JSON.parse(await readFile(path, 'utf8'));
      receipt.workspace.resourceId = randomUUID(); await writeFile(path, JSON.stringify(receipt));
    }
    if (mode === 'symlink-file') {
      const copy = join(root, 'copy.json'); await writeFile(copy, await readFile(path));
      await rm(path); await symlink(copy, path);
    }
    if (mode === 'symlink-directory') {
      const dir = join(root, '.git', 'cezar-owned-workspaces');
      const copy = join(root, 'receipts'); await mkdir(copy);
      await writeFile(join(copy, `${workspace.resourceId}.json`), await readFile(path));
      await rm(dir, { recursive: true }); await symlink(copy, dir);
    }
    await expect(ensureOwnedWorkspace(root, run)).rejects.toThrow();
    await expect(readOwnedDiff(root, run)).rejects.toMatchObject({ code: 'unavailable_diff' });
    expect(existsSync(workspace.path)).toBe(true);
  });

  it('rejects a resource removed and recreated by Git at the same path and administrative directory', async () => {
    const { root, second } = await fixture();
    const workspace = await createOwnedWorkspace(root, randomUUID(), second);
    const { run } = durableRun(root, workspace);
    const gitDir = git(workspace.path, 'rev-parse', '--absolute-git-dir');
    git(root, 'worktree', 'remove', '--force', workspace.path);
    git(root, 'worktree', 'add', workspace.path, workspace.branch);
    expect(git(workspace.path, 'rev-parse', '--absolute-git-dir')).toBe(gitDir);
    await expect(verifyOwnedWorkspace(root, run)).rejects.toThrow();
    await expect(readOwnedDiff(root, run)).rejects.toMatchObject({ code: 'unavailable_diff' });
  });

  it.each(['missing', 'mismatch', 'symlink'])('rejects a %s administrative resource marker', async (mode) => {
    const { root, second } = await fixture();
    const workspace = await createOwnedWorkspace(root, randomUUID(), second);
    const { run } = durableRun(root, workspace);
    const marker = join(git(workspace.path, 'rev-parse', '--absolute-git-dir'), 'cezar-owned-resource');
    if (mode === 'mismatch') await writeFile(marker, randomUUID());
    else {
      await rm(marker, { force: true });
      if (mode === 'symlink') {
        const copy = join(root, 'marker-copy'); await writeFile(copy, workspace.resourceId, { mode: 0o600 });
        await symlink(copy, marker);
      }
    }
    await expect(verifyOwnedWorkspace(root, run)).rejects.toThrow();
    expect(existsSync(workspace.path)).toBe(true);
  });

  it.each(['receipt', 'marker'])('preserves resources when %s writing fails after Git creation', async (failure) => {
    const { root, second } = await fixture();
    const workspace = await planOwnedWorkspace(root, randomUUID(), second);
    const { run } = durableRun(root, workspace);
    // A post-checkout hook simulates the crash-window competitor after worktree add.
    const hook = join(root, '.git', 'hooks', 'post-checkout');
    const block = failure === 'receipt'
      ? `mkdir -p '${receiptPath(root, workspace)}'`
      : 'mkdir "$(git rev-parse --absolute-git-dir)/cezar-owned-resource"';
    await writeFile(hook, `#!/bin/sh\n${block}\n`, { mode: 0o700 });
    await expect(ensureOwnedWorkspace(root, run)).rejects.toThrow();
    expect(existsSync(workspace.path)).toBe(true);
    expect(git(root, 'branch', '--list', workspace.branch)).toContain(workspace.branch);
    await expect(ensureOwnedWorkspace(root, run)).rejects.toThrow();
  });
});
