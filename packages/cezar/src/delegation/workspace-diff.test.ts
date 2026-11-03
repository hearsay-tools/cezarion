import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { workerDiffSchema } from '@open-mercato/cezar-contract/delegation';
import { createOwnedWorkspace, ensureOwnedWorkspace, readOwnedDiff } from './workspace.ts';
import { fixture, durableRun, git, WORKSPACE_TEST_TIMEOUT_MS } from './workspace-fixture.testkit.ts';

describe('readOwnedDiff', { timeout: WORKSPACE_TEST_TIMEOUT_MS }, () => {
  it('attributes worker commits and dirty/untracked work, not the parent commit, without changing the index', async () => {
    const { root, second } = await fixture();
    const workspace = await createOwnedWorkspace(root, randomUUID(), second);
    const { run, store } = durableRun(root, workspace);
    store.updateRun(run.id, { branch: workspace.branch, baseBranch: second, worktreePath: workspace.path, startedAt: '2020-01-01T00:00:00.000Z' });
    await writeFile(join(workspace.path, 'worker.txt'), 'worker commit\n');
    git(workspace.path, 'add', '.'); git(workspace.path, 'commit', '-qm', 'worker');
    await writeFile(join(workspace.path, 'dirty.txt'), 'worker untracked\n');
    const before = git(workspace.path, 'status', '--porcelain');
    const result = await readOwnedDiff(root, run);
    expect(workerDiffSchema.parse(result)).toEqual(result);
    expect(result).toMatchObject({ workerId: run.id, baselineSha: second, truncated: false });
    expect(result.diff).toContain('+worker commit'); expect(result.diff).toContain('+worker untracked');
    expect(result.diff).not.toContain('tracked.txt');
    expect(git(workspace.path, 'status', '--porcelain')).toBe(before);
  });

  it.each([false, true])('includes force-staged ignored additions without changing the real index (split index: %s)', async (splitIndex) => {
    const { root } = await fixture();
    await writeFile(join(root, '.gitignore'), '*.ignored\n');
    git(root, 'add', '.gitignore'); git(root, 'commit', '-qm', 'ignore generated files');
    const baseline = git(root, 'rev-parse', 'HEAD');
    const workspace = await createOwnedWorkspace(root, randomUUID(), baseline);
    const { run } = durableRun(root, workspace);
    await writeFile(join(workspace.path, 'worker.ignored'), 'force-staged worker change\n');
    git(workspace.path, 'add', '-f', 'worker.ignored');
    if (splitIndex) git(workspace.path, 'update-index', '--split-index');
    const indexPath = git(workspace.path, 'rev-parse', '--path-format=absolute', '--git-path', 'index');
    const before = await readFile(indexPath);
    const staged = git(workspace.path, 'diff', '--cached');

    const result = await readOwnedDiff(root, run);

    expect(result.truncated).toBe(false);
    expect(result.diff).toContain('diff --git a/worker.ignored b/worker.ignored');
    expect(result.diff).toContain('+force-staged worker change');
    expect(await readFile(indexPath)).toEqual(before);
    expect(git(workspace.path, 'diff', '--cached')).toBe(staged);
  });

  it('retains original ownership after checkout and measures against the branch as the run found it', async () => {
    const { root, second } = await fixture();
    const workspace = await createOwnedWorkspace(root, randomUUID(), second);
    const { run, store } = durableRun(root, workspace);
    git(workspace.path, 'checkout', '-qb', 'existing-feature');
    await writeFile(join(workspace.path, 'prior.txt'), 'prior feature\n');
    git(workspace.path, 'add', '.'); git(workspace.path, '-c', 'core.logAllRefUpdates=true', 'commit', '-qm', 'prior');
    // Pin reflog timestamps explicitly, rather than relying on wall-clock sleeps.
    const prior = git(workspace.path, 'rev-parse', 'HEAD');
    git(workspace.path, 'update-ref', 'refs/heads/existing-feature', second);
    execFileSync('git', ['update-ref', 'refs/heads/existing-feature', prior], { cwd: workspace.path, env: { ...process.env, GIT_COMMITTER_DATE: '2021-01-01T00:00:00Z' } });
    await writeFile(join(workspace.path, 'worker.txt'), 'worker on feature\n');
    git(workspace.path, 'add', '.'); git(workspace.path, 'commit', '-qm', 'worker feature');
    store.updateRun(run.id, { branch: workspace.branch, baseBranch: second, startedAt: '2022-01-01T00:00:00.000Z' });
    expect(await ensureOwnedWorkspace(root, run)).toEqual(workspace);
    const diff = await readOwnedDiff(root, run);
    expect(diff.diff).toContain('+worker on feature'); expect(diff.diff).not.toContain('prior.txt');
    expect(run.delegation?.role === 'worker' && run.delegation.workspace.branch).toBe(workspace.branch);
  });

  it.each([30_000, 100_000])('returns explicit truncation at 400000 characters for %i input lines, including process-buffer overflow', async (lines) => {
    const { root, second } = await fixture();
    const workspace = await createOwnedWorkspace(root, randomUUID(), second);
    const { run } = durableRun(root, workspace);
    await writeFile(join(workspace.path, 'large.txt'), 'line of worker changes\n'.repeat(lines));
    const result = await readOwnedDiff(root, run);
    expect(result.truncated).toBe(true); expect(result.diff).toHaveLength(400_000);
    expect(workerDiffSchema.safeParse(result).success).toBe(true);
  });

  it('reports missing/replaced resources and mismatched ownership as unavailable, never empty success or root fallback', async () => {
    const { root, second } = await fixture();
    const workspace = await createOwnedWorkspace(root, randomUUID(), second);
    const { run } = durableRun(root, workspace);
    await expect(readOwnedDiff(root, { ...run, id: randomUUID() })).rejects.toMatchObject({ code: 'unavailable_diff' });
    await rm(workspace.path, { recursive: true });
    await expect(readOwnedDiff(root, run)).rejects.toMatchObject({ code: 'unavailable_diff' });
    await expect(ensureOwnedWorkspace(root, run)).rejects.toThrow();
    await mkdir(workspace.path); await symlink(join(root, '.git'), join(workspace.path, '.git'));
    await expect(readOwnedDiff(root, run)).rejects.toMatchObject({ code: 'unavailable_diff' });
  });
});
