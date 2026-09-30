import type { DiffStat, RunRecord, WorktreeInfo } from '@open-mercato/cezar-api-client'

import { deriveAttention, type Attention } from '@/lib/attention'
import { runTitle } from '@/lib/task-groups'

/** One row of the Git view's Task worktrees list. */
export interface WorktreeRow {
  runId: string
  /** The worktree's branch, or null when the API has none on record (the list says so). */
  branch: string | null
  title: string
  attention: Attention
  /** Null is UNKNOWN (run not in the list, or never measured) — never a fabricated `+0 −0`. */
  diff: DiffStat | null
  /** Scoped by the router's `Link`; the task's Changes tab. */
  to: string
}

/**
 * Worktrees on disk, joined with the project's runs. `/worktrees` alone decides which rows exist
 * (a run's stored `worktreePath` outlives a reclaimed or removed directory, so runs never add a
 * row); the run only lends what the worktree entry does not carry: the diff stat, the attention
 * inputs beyond `status`, and the live title. `runs` undefined means "not loaded", which reads as
 * unknown diffs, not empty ones.
 */
export function worktreeRows(worktrees: readonly WorktreeInfo[], runs: readonly RunRecord[] | undefined): WorktreeRow[] {
  const byId = new Map((runs ?? []).map((run) => [run.id, run]))
  return worktrees.map((worktree) => {
    const run = byId.get(worktree.runId)
    return {
      runId: worktree.runId,
      branch: worktree.branch,
      title: run ? runTitle(run) : worktree.title,
      attention: deriveAttention(run ?? { status: worktree.status }, run?.hasPendingHumanAsk),
      diff: run?.diffStat ?? null,
      to: `/tasks/${worktree.runId}/changes`,
    }
  })
}
