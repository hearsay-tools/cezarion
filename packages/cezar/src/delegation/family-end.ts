/**
 * The branch step of the family-end rule (hearsay-tools/squawk#911; the case table is in
 * .ai/specs/2026-07-18-worktree-retention.md § Family end). Once a worker's family has ended and
 * retention has reclaimed its clean directory, the owned-workspace removal deletes the worker's
 * branch through its compare-and-swap, which deletes nothing while the branch holds commits that
 * no other ref keeps. A deleted branch completes the worker's destroy, so the parent's slot is
 * free again. A receipt whose run this project no longer has gets the same removal. The branch
 * sweep runs this step. Never throws.
 */
import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import type { WorkerWorkspace } from '@open-mercato/cezar-contract';
import { projectPaths } from '../project-paths.ts';
import { cleanupSafety, workerFamilyEnded } from '../runs/retention.ts';
import { isLiveRecord } from '../runs/run-row.ts';
import type { RunRecord, RunStore } from '../runs/store.ts';
import { ownedWorkspaceReceipts } from './workspace-record.ts';
import { releaseThenRemoveOwnedWorkspace } from './owned-workspace-release.ts';

export type FamilyEndStore = Pick<RunStore, 'getRun' | 'commitDelegation' | 'readWorkerExecution' |
  'workerResourcesSafe' | 'sourceDataDir' | 'unavailable'>;

const SETTLED: ReadonlySet<string> = new Set(['done', 'failed', 'cancelled', 'review']);

/** A settled worker whose family has ended, with no destroy recorded and its directory gone. */
export function endedWorkerBranch(run: RunRecord, lookup: (id: string) => RunRecord | undefined): boolean {
  if (run.delegation?.role !== 'worker' || run.delegation.destroy || isLiveRecord(run) || !SETTLED.has(run.status)) return false;
  return workerFamilyEnded(run, lookup) && !existsSync(run.delegation.workspace.path);
}

/** Release the branch of every ended worker family in `repoRoot`. `claim` holds the worker's run
 *  against Continue and other cleanup for the removal, or returns null when it is in use. Returns
 *  the worker ids whose branch went. */
export async function releaseEndedWorkerBranches(repoRoot: string, store: FamilyEndStore,
  claim: (runId: string) => (() => void) | null): Promise<string[]> {
  // Without its runs every receipt would look orphaned.
  if (store.unavailable) return [];
  const released: string[] = [];
  const lookup = (id: string) => store.getRun(id);
  for (const { workspace, cleaned } of await ownedWorkspaceReceipts(repoRoot).catch(() => [])) {
    const run = store.getRun(workspace.ownerRunId);
    const due = run
      ? endedWorkerBranch(run, lookup) && JSON.stringify(run.delegation?.role === 'worker' && run.delegation.workspace) === JSON.stringify(workspace)
      : !cleaned && !existsSync(workspace.path) && inProject(repoRoot, workspace);
    if (due && await releaseBranch(repoRoot, store, workspace, run, claim)) released.push(workspace.ownerRunId);
  }
  return released;
}

/** Receipts live in the repository's shared Git directory: another checkout's are not this project's. */
function inProject(repoRoot: string, workspace: WorkerWorkspace): boolean {
  try {
    const root = realpathSync(repoRoot);
    return projectPaths(root).reads.some((directory) => workspace.path === join(directory, 'worktrees', workspace.ownerRunId));
  } catch { return false; }
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
      if (run ? !current || !endedWorkerBranch(current, (id) => store.getRun(id)) : current) throw new Error('Worker changed');
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
