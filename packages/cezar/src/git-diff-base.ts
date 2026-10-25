/**
 * Resolve task diff anchors for summaries and structured changes. Callers supply a git runner
 * bound to the worktree and its index environment.
 */

import { isSafeGitRef } from './git-refs.ts';

/** What a caller's `git` runner must answer with. Both existing runners are wider than this. */
export interface GitRunResult {
  ok: boolean;
  stdout: string;
}

/** A caller-supplied `git` invocation, already bound to a working directory (and env). */
export type GitRunner = (args: string[]) => Promise<GitRunResult>;

/** The task branch cezar created vs. the branch HEAD actually sits on. */
export interface RepointedHead {
  headBranch: string;
  taskBranch: string;
}

export interface TaskDiffBase {
  /** The ref to diff against. */
  base: string;
  /** Present only when HEAD left the task's branch — the reason `base` is what it is. */
  repointedHead?: RepointedHead;
}

/**
 * ISO-8601 instants only, for the `<branch>@{<date>}` revision below. The
 * timestamp comes from a stored run record, and a git revision expression is
 * the one place a stray value would be interpreted rather than compared —
 * `@{-1}` is "the previously checked-out branch", not a date. Anything that is
 * not plainly a timestamp simply disables the baseline anchor.
 */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * The freshest ref the configured base branch names: `origin/<base>` when the
 * local branch is behind it (or missing entirely), the local branch otherwise.
 *
 * Same rule as `resolveBaseRef` (`git-worktree.ts`), which picks the fork point
 * when the worktree is created; this one re-applies it every time a diff is
 * measured, because that is when the local ref's staleness actually shows up.
 * A base that is already remote-tracking, a commit sha pinned from a detached
 * HEAD, or a repo with no `origin` all fall through unchanged.
 */
export async function freshestBaseRef(runGit: GitRunner, base: string): Promise<string> {
  if (!isSafeGitRef(base) || base === 'HEAD' || base.startsWith('origin/')) return base;
  const remote = `origin/${base}`;
  const hasRemote = await runGit(['rev-parse', '--verify', '--quiet', `${remote}^{commit}`]);
  if (!hasRemote.ok) return base;
  // Exits 0 iff local is equal to or ahead of origin — the case where the local
  // ref carries unpushed base commits and is the better answer.
  const localCurrent = await runGit(['merge-base', '--is-ancestor', remote, base]);
  return localCurrent.ok ? base : remote;
}

/**
 * Where the repointed branch stood when this run started — `git rev-parse
 * <branch>@{<runStartedAt>}`, i.e. its own reflog, read at a point in time.
 *
 * Git answers this generously by design: a timestamp older than the whole
 * reflog resolves to the branch's OLDEST recorded state, which for a branch the
 * agent created during the run is its creation commit — exactly the fork point
 * we want. A branch that already existed resolves to the tip it had before the
 * run touched it, so the previous author's commits stay theirs.
 *
 * Null (→ the caller keeps the conservative `HEAD` anchor) when there is no run
 * start to read at, when HEAD is detached (no branch reflog to consult), or
 * when reflogs are unavailable — a guess is worse than the narrow answer.
 */
async function checkoutBaseline(
  runGit: GitRunner,
  headBranch: string,
  runStartedAt: string | undefined,
): Promise<string | null> {
  if (!runStartedAt || !ISO_INSTANT.test(runStartedAt)) return null;
  if (headBranch === 'HEAD' || !isSafeGitRef(headBranch)) return null;
  const at = await runGit([
    'rev-parse',
    '--verify',
    '--quiet',
    `${headBranch}@{${runStartedAt}}^{commit}`,
  ]);
  const sha = at.ok ? at.stdout.trim() : '';
  return sha || null;
}

/**
 * Count changed lines for anchor selection, not display. Use the caller’s index environment; run
 * probes sequentially to avoid concurrent index refreshes.
 */
async function changedLines(runGit: GitRunner, ref: string): Promise<number | null> {
  const res = await runGit(['diff', '--shortstat', ref]);
  if (!res.ok) return null;
  let total = 0;
  for (const m of res.stdout.matchAll(/(\d+) (?:insertions?\(\+\)|deletions?\(-\))/g)) {
    total += Number(m[1]);
  }
  return total;
}

/**
 * Resolve a task diff anchor. Without a task branch, use the merge-base; without a usable
 * repoint baseline, use HEAD. Failed git calls fall back to the base name.
 */
export async function resolveTaskDiffBase(
  runGit: GitRunner,
  baseBranch: string,
  opts: { taskBranch?: string | undefined; runStartedAt?: string | undefined } = {},
): Promise<TaskDiffBase> {
  const base = await freshestBaseRef(runGit, baseBranch);
  const mergeBase = async (): Promise<string> => {
    const res = await runGit(['merge-base', base, 'HEAD']);
    return res.ok && res.stdout.trim() ? res.stdout.trim() : base;
  };

  if (!opts.taskBranch) return { base: await mergeBase() };

  const headBranchResult = await runGit(['rev-parse', '--abbrev-ref', 'HEAD']);
  const headBranch = headBranchResult.ok ? headBranchResult.stdout.trim() : '';
  // An unreadable HEAD (no commits yet, broken worktree) is NOT evidence of a
  // repoint — fall through to the merge-base anchor rather than narrowing on a
  // guess. A detached HEAD, on the other hand, is by definition not the task's
  // branch and takes the repointed path below.
  if (!headBranch || headBranch === opts.taskBranch) return { base: await mergeBase() };

  const repointedHead = { headBranch, taskBranch: opts.taskBranch };
  const baseline = await checkoutBaseline(runGit, headBranch, opts.runStartedAt);
  if (!baseline) return { base: 'HEAD', repointedHead };

  // Two defensible anchors, so report the tighter one: the number must never
  // claim more than the least either measure attributes to this task. The
  // baseline is usually it — but not when the run merged the base branch in
  // afterwards, which drags the whole upstream delta past a pre-merge baseline
  // and leaves the merge-base as the only anchor that still measures the task.
  const anchor = await mergeBase();
  const viaBaseline = await changedLines(runGit, baseline);
  if (viaBaseline === null) return { base: anchor, repointedHead };
  const viaMergeBase = await changedLines(runGit, anchor);
  if (viaMergeBase === null || viaBaseline <= viaMergeBase) return { base: baseline, repointedHead };
  return { base: anchor, repointedHead };
}
