import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RUN_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { setRunStatus } from '../runs/run-store.testkit.ts';
import { releaseEndedWorkerBranches } from './family-end.ts';
import { createOwnedWorkspace } from './workspace.ts';
import { durableRun, fixture, git, WORKSPACE_TEST_TIMEOUT_MS } from './workspace-fixture.testkit.ts';

/** The branch step of the family-end rule (hearsay-tools/squawk#911): after retention reclaimed a
 *  worker's directory, its branch goes only once the family has ended and no work would be lost. */
describe('releasing the branches of ended worker families', { timeout: WORKSPACE_TEST_TIMEOUT_MS }, () => {
  function release(): void { /* nothing is held */ }
  function claim(): () => void { return release; }

  async function reclaimedWorker(commit: boolean) {
    const { root, first } = await fixture();
    const workspace = await createOwnedWorkspace(root, randomUUID(), first);
    if (commit) {
      await writeFile(join(workspace.path, 'tracked.txt'), 'worker');
      git(workspace.path, 'commit', '-qam', 'worker');
    }
    const { run, store } = durableRun(root, workspace);
    const generation = store.commitWorkerExecutionStart(run.id);
    setRunStatus(store, run.id, RUN_STATUS.done, { finishedAt: '2026-07-01T00:00:00Z' });
    expect(store.commitWorkerExecutionComplete(run.id, generation)).toBe(true);
    git(root, 'worktree', 'remove', workspace.path);
    const parentId = run.delegation?.role === 'worker' ? run.delegation.parentRunId : '';
    setRunStatus(store, parentId, RUN_STATUS.failed, { finishedAt: '2026-07-02T00:00:00Z' });
    return { root, workspace, store, workerId: run.id, parentId };
  }

  it('deletes a baseline branch once the parent is archived, and completes the destroy', async () => {
    const { root, workspace, store, workerId, parentId } = await reclaimedWorker(false);
    expect(await releaseEndedWorkerBranches(root, store, claim)).toEqual([]);
    expect(git(root, 'branch', '--list', workspace.branch)).not.toBe('');
    store.setArchived(parentId, true);
    expect(await releaseEndedWorkerBranches(root, store, claim)).toEqual([workerId]);
    expect(git(root, 'branch', '--list', workspace.branch)).toBe('');
    expect(store.getRun(workerId)?.delegation).toMatchObject({ destroy: { phase: 'complete', remaining: [] } });
    expect(await releaseEndedWorkerBranches(root, store, claim)).toEqual([]);
  });

  it('keeps the branch while the archived root still runs', async () => {
    const { root, workspace, store, parentId } = await reclaimedWorker(false);
    setRunStatus(store, parentId, RUN_STATUS.running);
    store.setArchived(parentId, true);
    expect(await releaseEndedWorkerBranches(root, store, claim)).toEqual([]);
    expect(git(root, 'branch', '--list', workspace.branch)).not.toBe('');
  });

  it('keeps a branch with commits no other ref keeps, and a run in use', async () => {
    const { root, workspace, store, workerId, parentId } = await reclaimedWorker(true);
    store.setArchived(parentId, true);
    expect(await releaseEndedWorkerBranches(root, store, () => null)).toEqual([]);
    expect(await releaseEndedWorkerBranches(root, store, claim)).toEqual([]);
    expect(git(root, 'branch', '--list', workspace.branch)).not.toBe('');
    expect(store.getRun(workerId)?.delegation).not.toHaveProperty('destroy');
  });

  it('reclaims the clean directory of a receipt whose run no longer exists, then its branch, and keeps a dirty one', async () => {
    const { root, first } = await fixture();
    const clean = await createOwnedWorkspace(root, randomUUID(), first);
    const dirty = await createOwnedWorkspace(root, randomUUID(), first);
    await writeFile(join(dirty.path, 'tracked.txt'), 'uncommitted');
    const { store } = durableRun(root, await createOwnedWorkspace(root, randomUUID(), first));
    expect(await releaseEndedWorkerBranches(root, store, claim)).toEqual([clean.ownerRunId]);
    expect(existsSync(clean.path)).toBe(false);
    expect(git(root, 'branch', '--list', clean.branch)).toBe('');
    expect(await readFile(join(dirty.path, 'tracked.txt'), 'utf8')).toBe('uncommitted');
    expect(git(root, 'branch', '--list', dirty.branch)).not.toBe('');
  });

  it('releases the baseline branch of a receipt whose run no longer exists', async () => {
    const { root, first } = await fixture();
    const workspace = await createOwnedWorkspace(root, randomUUID(), first);
    git(root, 'worktree', 'remove', workspace.path);
    const { store } = durableRun(root, await createOwnedWorkspace(root, randomUUID(), first));
    expect(await releaseEndedWorkerBranches(root, store, claim)).toEqual([workspace.ownerRunId]);
    expect(git(root, 'branch', '--list', workspace.branch)).toBe('');
  });
});
