import { logPrefix } from '../home/display.ts';
import { isFallbackProjectPath, projectPaths } from '../project-paths.ts';
// Count-based worktree retention (#483). A busy cockpit leaves one full repo
// checkout per finished task under `.ai/cezar/worktrees/<runId>`; nothing bounds
// the total, so disk saturates. This module decides *which* finished worktrees
// to reclaim (directory only — the `cez/<id8>` branch is kept, so the work stays
// recoverable) and the thin I/O enforcer that performs the reclaim. The selector
// is pure and unit-testable; the enforcer never throws (helper discipline).
import { existsSync } from 'node:fs';
import { autosaveCleanupBlocker } from '../autosave-cleanup.ts';
import { collectWorkerEvidence } from '../delegation/results.ts';
import { createWorktree } from '../git-worktree.ts';
import { releaseThenRemoveWorktree } from '../git-worktree-release.ts';
import type { PreviewHostLike } from '../preview/registration.ts';
import { isEndedRoot } from './run-row.ts';
import type { RunRecord, RunStatus, RunStore } from './store.ts';

/** The "finished" status set — mirrors the statuses `RunStore.archiveFinished` sweeps. A run at the
 *  `review` gate is deliberately excluded: it still needs its worktree to render
 *  the diff and open a draft PR, so reclaiming it would break the gate. */
const FINISHED: ReadonlySet<RunStatus> = new Set<RunStatus>(['done', 'failed', 'cancelled']);

/** Recency key for retention ordering: when a run finished, falling back to when
 *  it was created (a finished run should always have `finishedAt`, but old
 *  records may not). Lexicographic compare is correct for ISO-8601 timestamps. */
function recencyKey(run: RunRecord): string {
  return run.finishedAt ?? run.createdAt;
}

/** Whether an owned worker's family has ended: its parent was archived, by the user or by history
 *  retention, and is settled (`isEndedRoot`, hearsay-tools/squawk#2987). */
export function workerFamilyEnded(run: RunRecord, lookup: (id: string) => RunRecord | undefined): boolean {
  if (run.delegation?.role !== 'worker') return false;
  const parent = lookup(run.delegation.parentRunId);
  return parent !== undefined && isEndedRoot(parent);
}

/** A run is reclaimable when it is finished, still has a materialized worktree directory, and
 *  has not already been reclaimed. A finished owned worker counts once its parent is gone or
 *  settled (done, failed or cancelled, hearsay-tools/squawk#2987): its evidence is snapshotted
 *  and its branch kept, and only a clean directory goes. A live parent, or one at `review`, may
 *  still collect or diff from it. A worker at `review` counts once its family has ended. Live
 *  runs, `review`, `invalid`, and workers mid-destroy do not. `lookup` finds the parent by id
 *  (the store's `getRun`; a parent need not have a worktree of its own). */
export function isReclaimable(run: RunRecord, lookup: (id: string) => RunRecord | undefined = () => undefined): boolean {
  if (run.delegation?.role === 'invalid') return false;
  if (run.delegation?.role === 'worker') {
    const parent = lookup(run.delegation.parentRunId);
    if (run.delegation.destroy || (parent && !FINISHED.has(parent.status))) return false;
  }
  const settled = FINISHED.has(run.status) || (run.status === 'review' && workerFamilyEnded(run, lookup));
  return settled && Boolean(run.worktreePath) && existsSync(run.worktreePath!) && !run.worktreeReclaimedAt;
}

/**
 * Given the runs with a worktree and the keep-count `keep`, return the ids of the finished
 * worktrees whose *directory* should be reclaimed: every worker of an ended family, then, of the
 * rest, keep the `keep` most-recently-finished reclaimable worktrees and reclaim the others.
 * `lookup` finds an owned worker's parent; without it, the parent is looked for among `runs`.
 *
 * `keep === 0` means "unlimited — never auto-reclaim" and returns `[]`.
 * Pure: no I/O, no mutation of the input.
 */
export function selectReclaimableWorktrees(
  runs: readonly RunRecord[],
  keep: number,
  lookup: (id: string) => RunRecord | undefined = (id) => runs.find((run) => run.id === id),
): string[] {
  if (!Number.isFinite(keep) || keep <= 0) return [];
  const reclaimable = runs.filter((run) => isReclaimable(run, lookup));
  const ended = reclaimable.filter((run) => workerFamilyEnded(run, lookup));
  const budgeted = reclaimable.filter((run) => !ended.includes(run))
    .sort((a, b) => (recencyKey(a) < recencyKey(b) ? 1 : recencyKey(a) > recencyKey(b) ? -1 : 0));
  return [...ended, ...budgeted.slice(keep)].map((r) => r.id);
}

/** The slice of the runs store the enforcer needs. Kept structural so the
 *  enforcer stays easy to test and never imports the concrete store. */
export interface RetentionStore {
  /** The candidates: runs with a materialized worktree (an indexed query, #779). */
  listRunsWithWorktree(): RunRecord[];
  getRun(id: string): RunRecord | undefined;
  updateRun(id: string, patch: { worktreeReclaimedAt?: string }): unknown;
}

/** The slice of the store the re-materializer needs. */
export interface RematerializeStore {
  getRun(id: string): RunRecord | undefined;
  updateRun(id: string, patch: { worktreeReclaimedAt?: string | undefined }): unknown;
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
  /** The workspace preview host (#781): the default reclaimer releases the run's preview first. */
  previewHost?: Pick<PreviewHostLike, 'release'> | undefined;
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

/**
 * The proof a destructive step on `run`'s resources re-checks right before each step, as a
 * function that throws when it fails. Startup has no manager claim, and a terminal execution can
 * still have a retained autosave writer, so the autosave's durable proof is read each time. An
 * owned worker's generation and fresh resource holders must also be safe, including after async
 * evidence or preview work. Structural test stores have no execution machinery and skip that part.
 */
export function cleanupSafety(repoRoot: string, store: Partial<RunStore>, run: RunRecord): () => void {
  const execution = store.readWorkerExecution?.(run.id);
  return () => {
    if (autosaveCleanupBlocker(store.sourceDataDir?.(run.id) ?? projectPaths(repoRoot).write, run.id)) throw Error('Autosave cleanup is not confirmed');
    if (run.delegation?.role !== 'worker') return;
    if (typeof store.workerResourcesSafe === 'function' && (!execution ||
      !store.workerResourcesSafe(run.id, execution.generation, run.delegation.workspace.resourceId))) throw Error('Worker resources are not safe to reclaim');
  };
}

function readOnlyWorktree(repoRoot: string, store: RetentionStore, run: RunRecord): boolean {
  return (store as Partial<RunStore>).isFallbackRun?.(run.id) === true ||
    Boolean(run.worktreePath && isFallbackProjectPath(repoRoot, run.worktreePath));
}

export async function reclaimWorktrees(
  repoRoot: string,
  store: RetentionStore,
  keep: number,
  opts: ReclaimOptions = {},
): Promise<string[]> {
  const runs = store.listRunsWithWorktree();
  const byId = new Map(runs.map((r) => [r.id, r]));
  const reclaimed: string[] = [];
  const selected = selectReclaimableWorktrees(runs, keep, (parentId) => store.getRun(parentId));
  const readonly = (id: string) => Boolean(byId.get(id) && readOnlyWorktree(repoRoot, store, byId.get(id)!));
  const skipped = selected.filter(readonly).length;
  if (skipped) console.info(`${logPrefix()} Worktree retention skipped ${skipped} read-only fallback item(s) under ${projectPaths(repoRoot).reads[1]}.`);
  for (const id of selected.filter(id => !readonly(id))) {
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
  if (readOnlyWorktree(repoRoot, store, run)) return null;
  const now = opts.now ?? (() => new Date().toISOString());
  // Branch kept, and only a clean checkout goes: uncommitted work lives only in the directory. An
  // owned worker's evidence is snapshotted first, but a diff snapshot drops binary content and
  // caps its size, so it does not stand in for the directory (hearsay-tools/squawk#2987).
  const real = store as Partial<RunStore>;
  const assertSafe = cleanupSafety(repoRoot, real, run);
  const remove = opts.remove ?? ((root, path) =>
    releaseThenRemoveWorktree({ previewHost: opts.previewHost }, run.id, root, path, undefined,
      { reclaimOwnedDirectory: true, onlyClean: true, assertCurrent: assertSafe }));
  if (!run.worktreePath) return null;
  const release = opts.claim ? opts.claim(run) : () => undefined;
  if (!release) return null; // in use since it was selected
  // Claimed in the run database too, for the whole reclaim (#779, plan step 3): no other Squawk
  // process writes this run or reclaims it meanwhile, and another process's run is left alone.
  // Structural test stores have no claims.
  let pinned = typeof real.pin !== 'function';
  try { pinned ||= real.pin!.call(store, run.id, 'cleanup') !== undefined; } catch { /* busy: not claimed */ }
  if (!pinned) { release(); return null; }
  try {
    assertSafe();
    if (!(await preserveWorkerResult(repoRoot, store, run).catch(() => false))) return null;
    if (opts.remove) assertSafe(); // injected reclaimer has no final callback
    await remove(repoRoot, run.worktreePath);
    if (existsSync(run.worktreePath)) return null; // reclaim failed; retry next pass
    const stamp = now();
    store.updateRun(run.id, { worktreeReclaimedAt: stamp });
    return stamp;
  } catch {
    // best-effort: never let retention crash a terminal transition or startup.
    return null;
  } finally {
    real.unpin?.call(store, run.id, 'cleanup');
    release();
  }
}
