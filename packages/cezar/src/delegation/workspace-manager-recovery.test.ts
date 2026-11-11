import { projectPaths } from '../project-paths.ts';
import { setRunStatus } from '../runs/run-store.testkit.ts';
import { RUN_STATUS, STEP_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { createFixtureManager } from '../workflows/fixture-claude.testkit.ts';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { createOwnedWorkspace, planOwnedWorkspace } from './workspace.ts';
import { stores, managers, fixture, durableRun, git, WORKSPACE_TEST_TIMEOUT_MS } from './workspace-fixture.testkit.ts';

// The timeout of a test that runs a dry-run task to completion through finished().
// The two such tests take 2.4-2.7 s alone and 2.7-2.9 s in an idle full `npm test`
// (measured 2026-10-07); a loaded full suite pushed them past vitest's 5 s default
// (hearsay-tools/cezarion#873). Sized to cover the fixture plus finished()'s 10 s wait.
const RUN_SETTLE_TEST_MS = 20_000;

async function finished(store: RunStore, id: string) {
  await vi.waitFor(() => {
    expect(['done', 'review', 'failed', 'cancelled']).toContain(store.getRun(id)?.status);
    expect(managers.some(manager => manager.isActive(id))).toBe(false);
  }, { timeout: 10_000, interval: 20 });
}
function managerFor(store: RunStore, root: string) {
  const manager = createFixtureManager(store, root); managers.push(manager); return manager;
}

describe('RunManager.enqueueOwnedRun', { timeout: WORKSPACE_TEST_TIMEOUT_MS }, () => {
  it('executes only the bundled quick-task from durable intent, pins before queuing and never autosaves parent edits', async () => {
    vi.stubEnv('CEZ_DRY_RUN', '1');
    const { root, parentPath, first, second } = await fixture();
    const workspace = await planOwnedWorkspace(root, randomUUID(), second);
    const { run, store } = durableRun(root, workspace);
    store.updateRun(run.id, {
      task: 'mock:cezar-done owned task', runner: 'claude', model: 'sonnet', systemPrompt: 'Inherited worker instruction',
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
  }, RUN_SETTLE_TEST_MS);

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
  }, RUN_SETTLE_TEST_MS);

  it('rejects missing/root/terminal/destroying records before queueing', async () => {
    const { root, second } = await fixture();
    const { run, store } = durableRun(root, await planOwnedWorkspace(root, randomUUID(), second));
    const manager = managerFor(store, root);
    expect(() => manager.enqueueOwnedRun(randomUUID())).toThrowError(expect.objectContaining({ code: 'incompatible_state' }));
    const parentId = run.delegation?.role === 'worker' ? run.delegation.parentRunId : '';
    expect(() => manager.enqueueOwnedRun(parentId)).toThrowError(expect.objectContaining({ code: 'incompatible_state' }));
    setRunStatus(store, run.id, RUN_STATUS.done);
    expect(() => manager.enqueueOwnedRun(run.id)).toThrowError(expect.objectContaining({ code: 'incompatible_state' }));
    if (run.delegation?.role !== 'worker') throw new Error('fixture');
    setRunStatus(store, run.id, RUN_STATUS.queued, { delegation: { ...run.delegation, destroy: { requestedAt: new Date().toISOString(), phase: 'requested', remaining: ['worktree', 'branch'] } } });
    expect(() => manager.enqueueOwnedRun(run.id)).toThrowError(expect.objectContaining({ code: 'incompatible_state' }));
  });
});

describe('owned workspace continuation and queued recovery', { timeout: WORKSPACE_TEST_TIMEOUT_MS }, () => {
  it.each(['missing', 'invalid-marker'])('never resumes in the root or rematerializes after %s resource identity', async (failure) => {
    vi.stubEnv('CEZ_DRY_RUN', '1');
    const { root, second } = await fixture();
    const workspace = await createOwnedWorkspace(root, randomUUID(), second);
    const { run, store } = durableRun(root, workspace);
    setRunStatus(store, run.id, RUN_STATUS.done, { runner: 'claude', worktreePath: workspace.path, branch: workspace.branch, baseBranch: second, worktreeReclaimedAt: new Date().toISOString() });
    store.updateStep(run.id, 'task', { status: STEP_STATUS.done, sessionId: 'mock-prior-session', backend: 'claude' });
    if (failure === 'missing') git(root, 'worktree', 'remove', '--force', workspace.path);
    else await writeFile(join(git(workspace.path, 'rev-parse', '--absolute-git-dir'), 'cezar-owned-resource'), 'wrong');
    const manager = managerFor(store, root);
    expect(manager.continueRun(run.id, { text: 'mock:cezar-done' }).ok).toBe(true);
    await finished(store, run.id);
    expect(run.status).toBe('failed');
    expect(run.error).toContain('owned workspace unavailable');
    expect(store.readEvents(run.id).some(event => event.type === 'step-start')).toBe(false);
    if (failure === 'missing') expect(existsSync(workspace.path)).toBe(false);
  }, RUN_SETTLE_TEST_MS);

  it('recovers an owned queued record with its bundled workflow, inherited settings and original start time', async () => {
    vi.stubEnv('CEZ_DRY_RUN', '1');
    const { root, second } = await fixture();
    const workspace = await planOwnedWorkspace(root, randomUUID(), second);
    const { run, store } = durableRun(root, workspace);
    store.updateRun(run.id, { task: 'mock:cezar-done', runner: 'claude', model: 'sonnet', systemPrompt: 'Recovered inherited instruction', startedAt: '2022-01-01T00:00:00.000Z',
      workflowDef: { name: 'not-worker-workflow', source: 'built-in', steps: [{ id: 'task', command: 'exit 99' }] } });
    store.close(); // a restart: the old store must not still own the queued run
    const recoveredStore = RunStore.open(projectPaths(root).write, { keepLive: true }); stores.push(recoveredStore);
    await managerFor(recoveredStore, root).recover();
    await finished(recoveredStore, run.id);
    expect(['done', 'review']).toContain(recoveredStore.getRun(run.id)?.status);
    expect(recoveredStore.getRun(run.id)).toMatchObject({ worktreePath: workspace.path, baseBranch: second, systemPrompt: 'Recovered inherited instruction', startedAt: '2022-01-01T00:00:00.000Z' });
  }, RUN_SETTLE_TEST_MS);
});

