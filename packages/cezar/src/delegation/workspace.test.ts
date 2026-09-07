import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { workerDiffSchema } from '@open-mercato/cezar-contract';
import type { WorkerWorkspace } from '@open-mercato/cezar-contract';
import { RunStore } from '../runs/store.ts';
import { RunManager } from '../workflows/run.ts';
import { autosaveCommit, createWorktree, pruneOrphans, removeWorktree } from '../git-worktree.ts';
import { createOwnedWorkspace, ensureOwnedWorkspace, planOwnedWorkspace, readOwnedDiff, removeOwnedWorkspace, resolveWorkerBaseline, verifyOwnedWorkspace } from './workspace.ts';

const roots: string[] = [];
const stores: RunStore[] = [];
const managers: RunManager[] = [];
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'cez-owned-workspace-'));
  roots.push(root);
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'test');
  git(root, 'config', 'user.email', 'test@local');
  await writeFile(join(root, 'tracked.txt'), 'base');
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'one');
  const first = git(root, 'rev-parse', 'HEAD');
  const parentPath = join(root, 'parent');
  git(root, 'worktree', 'add', '-qb', 'parent', parentPath);
  await writeFile(join(parentPath, 'tracked.txt'), 'committed');
  git(parentPath, 'commit', '-qam', 'two');
  const second = git(parentPath, 'rev-parse', 'HEAD');
  await writeFile(join(parentPath, 'tracked.txt'), 'dirty');
  await writeFile(join(parentPath, 'untracked.txt'), 'private');
  return { root, parentPath, first, second };
}
function durableRun(root: string, workspace: WorkerWorkspace) {
  const store = RunStore.open(join(root, '.ai/cezar'));
  stores.push(store);
  const parent = store.createRun({ title: 'parent', task: 'parent', workflow: 'quick-task', steps: [] });
  store.updateRun(parent.id, { delegation: { role: 'root', permissions: ['spawn'], receipts: [] } });
  store.flush();
  const run = store.createOwnedRun({ title: 'worker', task: 'worker', workflow: 'quick-task', steps: [{ id: 'task', name: 'Do the task', kind: 'agent' }] }, parent.id, randomUUID(), {
    role: 'worker', parentRunId: parent.id, permissions: [], workspace,
  }, 'a'.repeat(64));
  return { run, store };
}
function receiptPath(root: string, workspace: WorkerWorkspace) {
  return join(root, '.git', 'cezar-owned-workspaces', `${workspace.resourceId}.json`);
}
afterEach(async () => {
  for (const manager of managers.splice(0)) manager.dispose();
  for (const store of stores.splice(0)) store.flush();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('owned workspace committed isolation', () => {
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
    expect(RunStore.open(join(root, '.ai/cezar')).getRun(run.id)?.delegation).toEqual(run.delegation);
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

describe('readOwnedDiff', () => {
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

async function finished(store: RunStore, id: string) {
  await vi.waitFor(() => {
    expect(['done', 'review', 'failed', 'cancelled']).toContain(store.getRun(id)?.status);
    expect(managers.some(manager => manager.isActive(id))).toBe(false);
  }, { timeout: 10_000, interval: 20 });
}
function managerFor(store: RunStore, root: string) {
  const manager = new RunManager(store, root); managers.push(manager); return manager;
}

describe('RunManager.enqueueOwnedRun', () => {
  it('executes only the bundled quick-task from durable intent, pins before queuing and never autosaves parent edits', async () => {
    vi.stubEnv('CEZ_DRY_RUN', '1');
    const { root, parentPath, first, second } = await fixture();
    const workspace = await planOwnedWorkspace(root, randomUUID(), second);
    const { run, store } = durableRun(root, workspace);
    store.updateRun(run.id, {
      task: 'mock:done owned task', runner: 'claude', model: 'sonnet', systemPrompt: 'Inherited worker instruction',
      worktree: false, worktreePath: parentPath, baseBranch: first,
      workflowDef: { name: 'injected', source: 'built-in', steps: [{ id: 'task', command: 'exit 99' }] },
    }); store.flush();
    const manager = managerFor(store, root);
    manager.enqueueOwnedRun(run.id);
    manager.enqueueOwnedRun(run.id);
    await finished(store, run.id);
    expect(['done', 'review']).toContain(run.status);
    expect(run).toMatchObject({ worktreePath: workspace.path, branch: workspace.branch, baseBranch: second, runner: 'claude', model: 'sonnet', systemPrompt: 'Inherited worker instruction' });
    expect(run.worktree).toBeUndefined(); // Persisted isolation is absence of the explicit opt-out.
    expect(store.readEvents(run.id).filter(event => event.type === 'step-start')).toHaveLength(1);
    expect(git(parentPath, 'rev-parse', 'HEAD')).toBe(second);
    expect(await readFile(join(parentPath, 'tracked.txt'), 'utf8')).toBe('dirty');
    expect(await readFile(join(workspace.path, 'tracked.txt'), 'utf8')).toBe('committed');
  });

  it.each(['collision', 'non-git', 'missing-resource', 'invalid-marker'])('fails before any agent starts on %s with no in-place fallback', async (failure) => {
    vi.stubEnv('CEZ_DRY_RUN', '1');
    const { root, second } = await fixture();
    const workspace = await planOwnedWorkspace(root, randomUUID(), second);
    const { run, store } = durableRun(root, workspace);
    if (failure === 'collision') git(root, 'branch', workspace.branch, second);
    else if (failure === 'non-git') await rm(join(root, '.git'), { recursive: true });
    else {
      await createOwnedWorkspace(root, run.id, second, workspace);
      if (failure === 'missing-resource') git(root, 'worktree', 'remove', '--force', workspace.path);
      else await writeFile(join(git(workspace.path, 'rev-parse', '--absolute-git-dir'), 'cezar-owned-resource'), 'wrong');
    }
    managerFor(store, root).enqueueOwnedRun(run.id);
    await finished(store, run.id);
    expect(run.status).toBe('failed');
    expect(run.error).toContain('worktree creation failed');
    expect(store.readEvents(run.id).some(event => event.type === 'step-start')).toBe(false);
  });

  it('rejects missing/root/terminal/destroying records before queueing', async () => {
    const { root, second } = await fixture();
    const { run, store } = durableRun(root, await planOwnedWorkspace(root, randomUUID(), second));
    const manager = managerFor(store, root);
    expect(() => manager.enqueueOwnedRun(randomUUID())).toThrowError(expect.objectContaining({ code: 'incompatible_state' }));
    const parentId = run.delegation?.role === 'worker' ? run.delegation.parentRunId : '';
    expect(() => manager.enqueueOwnedRun(parentId)).toThrowError(expect.objectContaining({ code: 'incompatible_state' }));
    store.updateRun(run.id, { status: 'done' });
    expect(() => manager.enqueueOwnedRun(run.id)).toThrowError(expect.objectContaining({ code: 'incompatible_state' }));
    if (run.delegation?.role !== 'worker') throw new Error('fixture');
    store.updateRun(run.id, { status: 'queued', delegation: { ...run.delegation, destroy: { requestedAt: new Date().toISOString(), phase: 'requested', remaining: ['worktree', 'branch'] } } });
    expect(() => manager.enqueueOwnedRun(run.id)).toThrowError(expect.objectContaining({ code: 'incompatible_state' }));
  });
});

describe('owned workspace continuation and queued recovery', () => {
  it.each(['missing', 'invalid-marker'])('never resumes in the root or rematerializes after %s resource identity', async (failure) => {
    vi.stubEnv('CEZ_DRY_RUN', '1');
    const { root, second } = await fixture();
    const workspace = await createOwnedWorkspace(root, randomUUID(), second);
    const { run, store } = durableRun(root, workspace);
    store.updateRun(run.id, { status: 'done', runner: 'claude', worktreePath: workspace.path, branch: workspace.branch, baseBranch: second, worktreeReclaimedAt: new Date().toISOString() });
    store.updateStep(run.id, 'task', { status: 'done', sessionId: 'mock-prior-session', backend: 'claude' });
    if (failure === 'missing') git(root, 'worktree', 'remove', '--force', workspace.path);
    else await writeFile(join(git(workspace.path, 'rev-parse', '--absolute-git-dir'), 'cezar-owned-resource'), 'wrong');
    const manager = managerFor(store, root);
    expect(manager.continueRun(run.id, { text: 'mock:done' }).ok).toBe(true);
    await finished(store, run.id);
    expect(run.status).toBe('failed');
    expect(run.error).toContain('owned workspace unavailable');
    expect(store.readEvents(run.id).some(event => event.type === 'step-start')).toBe(false);
    if (failure === 'missing') expect(existsSync(workspace.path)).toBe(false);
  });

  it('recovers an owned queued record with its bundled workflow, inherited settings and original start time', async () => {
    vi.stubEnv('CEZ_DRY_RUN', '1');
    const { root, second } = await fixture();
    const workspace = await planOwnedWorkspace(root, randomUUID(), second);
    const { run, store } = durableRun(root, workspace);
    store.updateRun(run.id, { task: 'mock:done', runner: 'claude', model: 'sonnet', systemPrompt: 'Recovered inherited instruction', startedAt: '2022-01-01T00:00:00.000Z',
      workflowDef: { name: 'not-worker-workflow', source: 'built-in', steps: [{ id: 'task', command: 'exit 99' }] } });
    store.flush();
    const recoveredStore = RunStore.open(join(root, '.ai/cezar'), { keepLive: true }); stores.push(recoveredStore);
    await managerFor(recoveredStore, root).recover();
    await finished(recoveredStore, run.id);
    expect(['done', 'review']).toContain(recoveredStore.getRun(run.id)?.status);
    expect(recoveredStore.getRun(run.id)).toMatchObject({ worktreePath: workspace.path, baseBranch: second, systemPrompt: 'Recovered inherited instruction', startedAt: '2022-01-01T00:00:00.000Z' });
  });
});


describe('removeOwnedWorkspace verified retryable destruction', () => {
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

  it.each(['planned', 'moved and renamed'])('missing receipt cannot prove cleanup with absent planned resources: %s', async kind => {
    const { root, first } = await fixture();
    const workspace = kind === 'planned' ? await planOwnedWorkspace(root, randomUUID(), first) : await createOwnedWorkspace(root, randomUUID(), first);
    const moved = workspace.path + '-moved';
    if (kind !== 'planned') {
      git(root, 'worktree', 'move', workspace.path, moved);
      git(moved, 'branch', '-m', 'renamed-worker');
      await rm(receiptPath(root, workspace));
    }
    expect(await removeOwnedWorkspace(root, workspace)).toMatchObject({ state: 'incomplete', remaining: ['worktree', 'branch'] });
    if (kind !== 'planned') {
      expect(existsSync(moved)).toBe(true);
      expect(git(root, 'branch', '--list', 'renamed-worker')).not.toBe('');
    }
  });

  it('removes only owned resources, retains the receipt and is idempotent after reopen', async () => {
    const { root, first, parentPath } = await fixture();
    const workspace = await createOwnedWorkspace(root, randomUUID(), first);
    await writeFile(join(workspace.path, 'tracked.txt'), 'worker commit');
    git(workspace.path, 'commit', '-qam', 'worker');
    const result = await removeOwnedWorkspace(root, workspace);
    expect(result).toEqual({ workerId: workspace.ownerRunId, state: 'complete', remaining: [] });
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
        git(workspace.path, 'checkout', '--detach'); git(root, 'branch', '-D', workspace.branch);
        git(root, 'branch', workspace.branch, first); git(workspace.path, 'checkout', workspace.branch);
      }
      if (attack === 'missing identity') {
        const receipt = JSON.parse(await readFile(receiptPath(root, workspace), 'utf8')); delete receipt.branchIdentity;
        await writeFile(receiptPath(root, workspace), JSON.stringify(receipt));
      }
      if (attack === 'rewritten reflog') await writeFile(log, 'changed');
      if (attack === 'symlink reflog') { await rename(log, log + '-real'); await symlink(log + '-real', log); }
      const target = attack === 'resource collision' ? { ...workspace, resourceId: randomUUID() } : workspace;
      expect(await removeOwnedWorkspace(root, target)).toMatchObject({ state: 'incomplete', remaining: ['worktree', 'branch'] });
      expect(git(root, 'branch', '--list', workspace.branch)).not.toBe('');
      expect(existsSync(attack === 'moved' ? workspace.path + '-moved' : workspace.path)).toBe(true);
    });
  }

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
    expect(await removeOwnedWorkspace(root, workspace)).toMatchObject({ state: 'incomplete', remaining: ['branch'] });
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


describe('owned resources bypass generic cleanup', () => {
  it('preserves an owned orphan and receipt even when its run index is absent', async () => {
    const { root, first } = await fixture(); const workspace = await createOwnedWorkspace(root, randomUUID(), first);
    expect(await pruneOrphans(root, new Set())).not.toContain(workspace.ownerRunId);
    expect(existsSync(workspace.path)).toBe(true);
    await removeWorktree(root, workspace.path, workspace.branch);
    expect(existsSync(workspace.path)).toBe(true);
    expect(git(root, 'branch', '--list', workspace.branch)).not.toBe('');
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
