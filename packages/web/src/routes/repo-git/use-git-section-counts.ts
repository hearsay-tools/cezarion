import type { RepoResponse } from '@open-mercato/cezar-api-client'

import { useProjectWorktrees } from '@/api/queries'
import { formatMem } from '@/lib/tasks-table'

import type { GitListSection } from './git-section-list'
import { commitsToday } from './git-sections'

/**
 * The counts on the Git section rows: Cleanup is the worktrees' total size on disk (the same
 * `/worktrees` entry the Cleanup card reads, so the two never disagree), All branches the local
 * branch count, and — on the phone only, as the board draws it — how many commits landed today.
 * `scope` is explicit (the sidebar sits above the `ProjectScopeProvider`).
 */
export function useGitSectionCounts(scope: string, repo: RepoResponse | null, variant: 'sidebar' | 'screen'): Record<GitListSection, string | null> {
  const worktrees = useProjectWorktrees(scope)
  const totalBytes = worktrees.data?.totalBytes ?? null
  const today = repo && variant === 'screen' ? commitsToday(repo.log) : 0
  return {
    main: today > 0 ? `${today} today` : null,
    // A known zero is "nothing on disk" and draws no count, like an empty list; null is unknown.
    cleanup: totalBytes ? formatMem(totalBytes) : null,
    branches: repo ? String(repo.branches.length) : null,
  }
}
