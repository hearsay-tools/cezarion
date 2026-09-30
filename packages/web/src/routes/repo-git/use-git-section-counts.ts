import type { RepoResponse } from '@open-mercato/cezar-api-client'

import { useProjectRepoBranches, useProjectWorktrees } from '@/api/queries'
import { formatMem } from '@/lib/tasks-table'

import type { GitListSection } from './git-section-list'
import { commitsToday } from './git-sections'

/**
 * The counts on the Git section rows (issue 08 §C): Not landed is `counts.notLanded` from
 * `GET /repo/branches`; Cleanup is the worktrees' total size on disk (the same `/worktrees` entry
 * the Cleanup card reads, so the two never disagree), or the safe-to-delete branch count when the
 * size degraded; All branches the local branch count; and, on the phone only, as the board draws
 * it, how many commits landed today. `scope` is explicit (the sidebar sits above the
 * `ProjectScopeProvider`).
 */
export function useGitSectionCounts(scope: string, repo: RepoResponse | null, variant: 'sidebar' | 'screen'): Record<GitListSection, string | null> {
  const worktrees = useProjectWorktrees(scope)
  const branches = useProjectRepoBranches(scope)
  const totalBytes = worktrees.data?.totalBytes ?? null
  const counts = branches.data?.counts ?? null
  const today = repo && variant === 'screen' ? commitsToday(repo.log) : 0
  return {
    main: today > 0 ? `${today} today` : null,
    // A known zero draws no count, like an empty list; null is unknown and draws nothing either.
    'not-landed': counts?.notLanded ? String(counts.notLanded) : null,
    cleanup: totalBytes ? formatMem(totalBytes) : worktrees.data && totalBytes === null && counts?.cleanup ? String(counts.cleanup) : null,
    branches: repo ? String(repo.branches.length) : null,
  }
}
