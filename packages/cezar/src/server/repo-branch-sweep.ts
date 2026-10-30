/**
 * The automatic branch sweep (hearsay-tools/cezarion#2268). Retention reclaims a finished task's
 * worktree DIRECTORY and keeps its branch, so Continue can recover local-only commits; nothing
 * removed the branch once its work had landed, and local branches piled up by the thousand. The
 * sweep deletes the refs that hold no local-only work: the bulk-safe classes `merged` and `empty`.
 *
 * It reads every `refs/heads` ref, not the worktree directories, so it finds a branch whose
 * directory is long gone. Every guarantee comes from `deleteBranches`: a fresh classification under
 * run claims and the worktree mutation lock, a recheck of checkouts and owned-workspace receipts,
 * and a ref transaction that verifies the base and the tip it classified. It also holds the
 * cockpit's checkout-and-pull claim, so no branch switch lands between the verdict and the delete.
 * `worktreeRetention: 0` ("keep every worktree") turns it off with retention. Never throws.
 */
import { claimRepoGitMutation } from './repo-pull.ts';
import { classifyBranches, classifyInputFor, deleteBranches, githubBranchForge, type BranchForge, type ClassifyProject, type DeleteBranchesResult } from './repo-branches.ts';

export interface SweepResult {
  deleted: string[];
  refused: DeleteBranchesResult['refused'];
}

export interface SweepOptions {
  forge?: BranchForge;
  /** The retention keep-count; 0 means "keep everything", and the sweep does nothing. */
  keep: number;
  /** Skip the sweep when this repository was swept less than this long ago. Startup passes none. */
  minIntervalMs?: number;
  /** Where the one summary line goes. */
  log?: (line: string) => void;
}

/** After a terminal transition, at most one sweep per repository in this window. */
export const SWEEP_MIN_INTERVAL_MS = 5 * 60_000;

const running = new Map<string, Promise<SweepResult | null>>();
const lastStarted = new Map<string, number>();

/** Delete every `merged` and `empty` branch of `project`. A sweep already running for the same
 *  repository is joined, not repeated. Resolves null when nothing ran. */
export function sweepMergedBranches(project: ClassifyProject, options: SweepOptions): Promise<SweepResult | null> {
  if (!Number.isFinite(options.keep) || options.keep <= 0) return Promise.resolve(null);
  const joined = running.get(project.root);
  if (joined) return joined;
  const last = lastStarted.get(project.root);
  if (options.minIntervalMs && last !== undefined && Date.now() - last < options.minIntervalMs) return Promise.resolve(null);
  lastStarted.set(project.root, Date.now());
  const sweep = runSweep(project, options).catch(() => null).finally(() => running.delete(project.root));
  running.set(project.root, sweep);
  return sweep;
}

async function runSweep(project: ClassifyProject, options: SweepOptions): Promise<SweepResult | null> {
  const input = await classifyInputFor(project, options.forge ?? githubBranchForge);
  if (!input) return null;
  const release = claimRepoGitMutation(input.root);
  // A branch switch or pull is running: the next sweep tries again.
  if (!release) return null;
  try {
    const { payload } = await classifyBranches(input, { diffStats: false });
    const names = payload.branches.filter((b) => b.class === 'merged' || b.class === 'empty').map((b) => b.name);
    if (names.length === 0) return { deleted: [], refused: [] };
    const result = await deleteBranches(input, names);
    if (result.deleted.length > 0 || result.refused.length > 0) {
      (options.log ?? console.log)(
        `  removed ${result.deleted.length} merged local branch(es)${result.refused.length > 0 ? `, kept ${result.refused.length} that changed or are in use` : ''}`,
      );
    }
    return { deleted: result.deleted, refused: result.refused };
  } finally {
    release();
  }
}

/** Test-only: forget running sweeps and their start times. */
export function __resetBranchSweepForTests(): void {
  running.clear();
  lastStarted.clear();
}
