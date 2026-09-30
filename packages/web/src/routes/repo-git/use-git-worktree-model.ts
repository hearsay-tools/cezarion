import { useMemo } from 'react'

import { useProjectRuns, useProjectWorktrees } from '@/api/queries'

import { worktreeRows } from './git-worktree-model'

/**
 * What the Git sidebar and the phone's worktree screen both read: `/worktrees` for which
 * worktrees exist and the project's runs for their diff and attention — two requests total,
 * never one per row. `scope` is the EXPLICIT cache/request scope (`'default'` for the boot
 * project), because the sidebar renders above the `ProjectScopeProvider`.
 *
 * Only `/worktrees` gates the list: a failed or pending `/runs` leaves the rows on screen with
 * unknown diffs rather than hiding worktrees that are on disk.
 */
export function useGitWorktreeModel(scope: string) {
  const worktrees = useProjectWorktrees(scope)
  const runs = useProjectRuns(scope, true, scope === 'default')
  const rows = useMemo(
    () => (worktrees.data ? worktreeRows(worktrees.data.worktrees, runs.data) : null),
    [worktrees.data, runs.data],
  )
  return {
    rows,
    loading: worktrees.isPending,
    error: worktrees.isError && !worktrees.data ? worktrees.error.message : null,
  }
}
