/**
 * The branch step of the family-end rule (hearsay-tools/squawk#911; the case table is in
 * .ai/specs/2026-07-18-worktree-retention.md § Family end). Once a worker's family has ended and
 * retention has reclaimed its clean directory, the owned-workspace removal deletes the worker's
 * branch through its compare-and-swap, which deletes nothing while the branch holds commits that
 * no other ref keeps. A deleted branch completes the worker's destroy, so the parent's slot is
 * free again. A receipt whose run this project no longer has gets the same removal, after its
 * directory is reclaimed if clean. The branch sweep runs this step. Never throws.
 */
import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import type { WorkerWorkspace } from '@open-mercato/cezar-contract';
import { projectPaths } from '../project-paths.ts';
import { cleanupSafety, workerFamilyEnded } from '../runs/retention.ts';
import { isLiveRecord } from '../runs/run-row.ts';
import type { RunRecord, RunStore } from '../runs/store.ts';
import { ownedWorkspaceReceipts } from './workspace-record.ts';
import { releaseThenRemoveWorktree } from '../git-worktree-release.ts';
import { releaseThenRemoveOwnedWorkspace } from './owned-workspace-release.ts';
import { inspectGeneration } from './process-liveness.ts';

export type FamilyEndStore = Pick<RunStore, 'getRun' | 'listWorkersOf' | 'commitDelegation' | 'readWorkerExecution' |
  'workerResourcesSafe' | 'sourceDataDir' | 'unavailable'>;

const SETTLED: ReadonlySet<string> = new Set(['done', 'failed', 'cancelled', 'review']);

/** A settled worker whose family has ended, with no member live, no destroy recorded and its
 *  directory gone. */
export function endedWorkerBranch(run: RunRecord, store: Pick<FamilyEndStore, 'getRun' | 'listWorkersOf'>): boolean {
  if (run.delegation?.role !== 'worker' || run.delegation.destroy || isLiveRecord(run) || !SETTLED.has(run.status)) return false;
  return workerFamilyEnded(run, (id) => store.getRun(id)) && !existsSync(run.delegation.workspace.path) &&
    !store.listWorkersOf(run.delegation.parentRunId).some(isLiveRecord);
}

/** Release the branch of every ended worker family in `repoRoot`. `claim` holds the worker's run
 *  against Continue and other cleanup for the removal, or returns null when it is in use. `signal`
 *  stops the step before its next workspace. Returns the worker ids whose branch went. */
export async function releaseEndedWorkerBranches(repoRoot: string, store: FamilyEndStore,
  claim: (runId: string) => (() => void) | null, signal?: AbortSignal): Promise<string[]> {
  // Without its runs every receipt would look orphaned.
  if (store.unavailable) return [];
  const released: string[] = [];
  for (const { workspace, cleaned } of await ownedWorkspaceReceipts(repoRoot).catch(() => [])) {
    if (signal?.aborted) break;
    const run = store.getRun(workspace.ownerRunId);
    const due = run
      ? endedWorkerBranch(run, store) && JSON.stringify(run.delegation?.role === 'worker' && run.delegation.workspace) === JSON.stringify(workspace)
      : !cleaned && inProject(repoRoot, workspace) && await reclaimOrphanDirectory(repoRoot, store, workspace);
    if (due && await releaseBranch(repoRoot, store, workspace, run, claim)) released.push(workspace.ownerRunId);
  }
  return released;
}

/** Receipts live in the repository's shared Git directory: another checkout's are not this
 *  project's, and the read-only fallback directory's are left alone. */
function inProject(repoRoot: string, workspace: WorkerWorkspace): boolean {
  try {
    return workspace.path === join(projectPaths(realpathSync(repoRoot)).write, 'worktrees', workspace.ownerRunId);
  } catch { return false; }
}

/** An orphan receipt's directory goes as an archived worker's does: only when it is clean, and only
 *  while still no run owns it and no process works in it. True once the directory is gone. */
async function reclaimOrphanDirectory(repoRoot: string, store: FamilyEndStore, workspace: WorkerWorkspace): Promise<boolean> {
  if (!existsSync(workspace.path)) return true;
  const assertOrphan = () => {
    if (store.getRun(workspace.ownerRunId)) throw new Error('The receipt has a run');
    if (inspectGeneration({ paths: [workspace.path] }).liveness !== 'gone') throw new Error('A process may hold the directory');
  };
  try { assertOrphan(); } catch { return false; }
  await releaseThenRemoveWorktree({}, workspace.ownerRunId, repoRoot, workspace.path, undefined,
    { reclaimOwnedDirectory: true, onlyClean: true, assertCurrent: assertOrphan });
  return !existsSync(workspace.path);
}

async function releaseBranch(repoRoot: string, store: FamilyEndStore, workspace: WorkerWorkspace,
  run: RunRecord | undefined, claim: (runId: string) => (() => void) | null): Promise<boolean> {
  const release = run ? claim(run.id) : () => undefined;
  if (!release) return false;
  try {
    const safe = run ? cleanupSafety(repoRoot, store, run) : () => undefined;
    // Rechecked before every destructive step: the run is still an ended worker (or still absent).
    const assertCurrent = () => {
      const current = store.getRun(workspace.ownerRunId);
      if (run ? !current || !endedWorkerBranch(current, store) : current) throw new Error('Worker changed');
      safe();
    };
    const result = await releaseThenRemoveOwnedWorkspace({}, repoRoot, workspace, assertCurrent, assertCurrent);
    if (result.state !== 'complete') return false;
    const current = run && store.getRun(run.id);
    if (current?.delegation?.role === 'worker' && !current.delegation.destroy) {
      store.commitDelegation([{ id: current.id, delegation: { ...current.delegation,
        destroy: { requestedAt: new Date().toISOString(), phase: 'complete', remaining: [] } } }]);
    }
    return true;
  } catch {
    return false;
  } finally {
    release();
  }
}
