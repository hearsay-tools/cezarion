// Count-based worktree retention (#483). A busy cockpit leaves one full repo
// checkout per finished task under `.ai/cezar/worktrees/<runId>`; nothing bounds
// the total, so disk saturates. This module decides *which* finished worktrees
// to reclaim (directory only — the `cez/<id8>` branch is kept, so the work stays
// recoverable) and the thin I/O enforcer that performs the reclaim. The selector
// is pure and unit-testable; the enforcer never throws (helper discipline).
import { existsSync } from 'node:fs';
import { collectWorkerEvidence } from '../delegation/results.ts';
import { createWorktree, removeWorktree } from '../git-worktree.ts';
import type { RunRecord, RunStatus, RunStore } from './store.ts';

/** The "finished" status set — mirrors `RunStore.archiveFinished`. A run at the
 *  `review` gate is deliberately excluded: it still needs its worktree to render
 *  the diff and open a draft PR, so reclaiming it would break the gate. */
const FINISHED: ReadonlySet<RunStatus> = new Set<RunStatus>(['done', 'failed', 'cancelled']);

/** Recency key for retention ordering: when a run finished, falling back to when
 *  it was created (a finished run should always have `finishedAt`, but old
 *  records may not). Lexicographic compare is correct for ISO-8601 timestamps. */
function recencyKey(run: RunRecord): string {
  return run.finishedAt ?? run.createdAt;
}

/** A run is reclaimable when it is finished, still has a materialized worktree
 *  directory, and has not already been reclaimed. Finished owned workers count
 *  (#575) once their parent is gone or `done` (collection-gated). A live,
 *  failed, or cancelled parent can still collect/diff from the dir. Live runs,
 *  `review`, `invalid`, and workers mid-destroy do not. */
export function isReclaimable(run: RunRecord, runs: readonly RunRecord[] = []): boolean {
  if (run.delegation?.role === 'invalid') return false;
  if (run.delegation?.role === 'worker' && run.delegation.destroy) return false;
  if (!FINISHED.has(run.status) || !run.worktreePath || !existsSync(run.worktreePath) || run.worktreeReclaimedAt) return false;
  if (run.delegation?.role === 'worker') {
    const parentId = run.delegation.parentRunId;
    const parent = runs.find((candidate) => candidate.id === parentId);
    // `done` is collection-gated. failed/cancelled parents can still collect later.
    if (parent && parent.status !== 'done') return false;
  }
  return true;
}

/**
 * Given every run and the keep-count `keep`, return the ids of the finished
 * worktrees whose *directory* should be reclaimed: keep the `keep`
 * most-recently-finished reclaimable worktrees, reclaim the rest.
 *
 * `keep === 0` means "unlimited — never auto-reclaim" and returns `[]`.
 * Pure: no I/O, no mutation of the input.
 */
export function selectReclaimableWorktrees(runs: readonly RunRecord[], keep: number): string[] {
  if (!Number.isFinite(keep) || keep <= 0) return [];
  const reclaimable = runs
    .filter((run) => isReclaimable(run, runs))
    .sort((a, b) => (recencyKey(a) < recencyKey(b) ? 1 : recencyKey(a) > recencyKey(b) ? -1 : 0));
  return reclaimable.slice(keep).map((r) => r.id);
}

/** The slice of the runs store the enforcer needs. Kept structural so the
 *  enforcer stays easy to test and never imports the concrete store. */
export interface RetentionStore {
  listRuns(): RunRecord[];
  updateRun(id: string, patch: { worktreeReclaimedAt?: string }): unknown;
}

/** The slice of the store the re-materializer needs. */
export interface RematerializeStore {
  getRun(id: string): RunRecord | undefined;
  updateRun(id: string, patch: { worktreeReclaimedAt?: string }): unknown;
}

/**
 * If retention (#483) reclaimed this run's worktree — branch kept, directory
 * gone, `worktreeReclaimedAt` stamped — re-materialize the directory (via the
 * idempotent `createWorktree`, which reattaches the surviving `cez/<id8>`
 * branch) and CLEAR the stamp. Called on the resume/continue path so a resumed
 * run regains its isolated tree and becomes eligible for retention again;
 * without it the run would keep a directory on disk while staying invisible to
 * the enforcer forever (a leak). Returns true when it re-materialized.
 * Best-effort: never throws (the caller falls back to the repo root).
 * Owned workers still refuse this path: continue verifies the owned workspace
 * instead of recreating an unverified tree. `invalid` is never rematerialized.
 */
export async function rematerializeReclaimedWorktree(
  repoRoot: string,
  store: RematerializeStore,
  runId: string,
): Promise<boolean> {
  const run = store.getRun(runId);
  if (run?.delegation?.role === 'worker' || run?.delegation?.role === 'invalid') return false;
  if (!run?.worktreePath || !run.worktreeReclaimedAt || existsSync(run.worktreePath)) return false;
  try {
    await createWorktree(repoRoot, runId, run.baseBranch ?? 'HEAD');
    store.updateRun(runId, { worktreeReclaimedAt: undefined });
    return true;
  } catch {
    return false;
  }
}

/**
 * Enforce the retention budget: reclaim the *directory* of every over-limit
 * finished worktree (branch kept via `removeWorktree` without the branch arg),
 * stamping `worktreeReclaimedAt` on each run actually reclaimed. Returns the
 * reclaimed run ids (for logging/SSE).
 *
 * Never throws (helper discipline). `removeWorktree` is best-effort and does not
 * report failure, so a run is stamped only once its directory is confirmed gone
 * — a locked/permission failure leaves the stamp unset so the next pass retries.
 * Idempotent under races: `removeWorktree` is `--force` + `prune` and a repeated
 * stamp is harmless.
 */
export interface ReclaimOptions {
  /** Timestamp source for the stamp — injectable for deterministic tests. */
  now?: () => string;
  /** Directory reclaimer — defaults to the real `removeWorktree` (branch kept).
   *  Injectable so tests can exercise the "removal failed" branch without brittle
   *  filesystem-permission tricks. */
  remove?: (repoRoot: string, worktreePath: string) => Promise<void>;
  /** Claims the run for the whole reclaim, or returns null to skip it. A selection is made before
   *  any await, so without a claim a Continue admitted in between would resume into the directory
   *  the forced removal is about to delete. The run manager's `claimWorktreeReclaim` is the one
   *  that also blocks admission; startup sweeps run before any run can start and omit it. */
  claim?: (run: RunRecord) => (() => void) | null;
  /** Require a clean, ref-kept checkout for an owned worker too. Retention (#575) relies on the
   *  worker's evidence snapshot; a person pressing Reclaim on one row (issue 08 §B4) is not shown
   *  that a diff snapshot drops binary content and caps its size, so that path asks for clean. */
  requireClean?: boolean;
}

/** Snapshot parent-owned worker evidence before the checkout goes.
 *  Test fakes without `commitWorkerResult` skip this. A collect/commit failure
 *  returns false so the directory is left for the next pass. */
async function preserveWorkerResult(repoRoot: string, store: RetentionStore, run: RunRecord): Promise<boolean> {
  if (run.delegation?.role !== 'worker') return true;
  const commit = (store as Partial<RunStore>).commitWorkerResult;
  if (typeof commit !== 'function') return true;
  const evidence = await collectWorkerEvidence(repoRoot, store as RunStore, run);
  commit.call(store, run.delegation.parentRunId, evidence.result, evidence.diffSnapshot);
  return evidence.diffSnapshot !== undefined || evidence.result.diff.state === 'available';
}

export async function reclaimWorktrees(
  repoRoot: string,
  store: RetentionStore,
  keep: number,
  opts: ReclaimOptions = {},
): Promise<string[]> {
  const runs = store.listRuns();
  const byId = new Map(runs.map((r) => [r.id, r]));
  const reclaimed: string[] = [];
  for (const id of selectReclaimableWorktrees(runs, keep)) {
    const run = byId.get(id);
    if (run && (await reclaimWorktree(repoRoot, store, run, opts))) reclaimed.push(id);
  }
  return reclaimed;
}

/**
 * Reclaim ONE run's worktree directory — the step `reclaimWorktrees` applies to each over-limit
 * run, and what `POST /worktrees/:runId/reclaim` (issue 08 §B4) calls for a single row. The
 * caller has already decided the run `isReclaimable`. Branch kept; owned workers get their
 * evidence snapshotted first, and any other run's checkout must be clean — uncommitted work is
 * not on the branch, so removing it would not be recoverable. Returns the stamp it wrote, or null
 * when nothing was reclaimed (the directory survived or was dirty, or evidence could not be
 * preserved). Never throws.
 */
export async function reclaimWorktree(
  repoRoot: string,
  store: RetentionStore,
  run: RunRecord,
  opts: ReclaimOptions = {},
): Promise<string | null> {
  const now = opts.now ?? (() => new Date().toISOString());
  // Branch kept. An owned worker's evidence (uncommitted diff included) is snapshotted first; any
  // other run's uncommitted work lives only in the directory, so a dirty one is left for later.
  const onlyClean = opts.requireClean === true || run.delegation?.role !== 'worker';
  const remove = opts.remove ?? ((root, path) => removeWorktree(root, path, undefined, { reclaimOwnedDirectory: true, onlyClean }));
  if (!run.worktreePath) return null;
  const release = opts.claim ? opts.claim(run) : () => undefined;
  if (!release) return null; // in use since it was selected
  try {
    if (!(await preserveWorkerResult(repoRoot, store, run).catch(() => false))) return null;
    await remove(repoRoot, run.worktreePath);
    if (existsSync(run.worktreePath)) return null; // reclaim failed; retry next pass
    const stamp = now();
    store.updateRun(run.id, { worktreeReclaimedAt: stamp });
    return stamp;
  } catch {
    // best-effort: never let retention crash a terminal transition or startup.
    return null;
  } finally {
    release();
  }
}
