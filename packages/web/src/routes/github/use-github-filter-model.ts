import { useMemo } from 'react'

import { useProjectGithub, useProjectGithubSearch, useProjectRuns } from '@/api/queries'

import {
  FAILING_QUERY,
  GITHUB_LIST_LIMIT,
  REVIEW_QUERY,
  filterCounts,
  issueNumbersWithTask,
} from './github-sidebar-model'

/**
 * What the sidebar list and the phone's filter screen both read: the shared open list, the
 * project's runs (for the task join) and the two qualifier searches, reduced to counts.
 *
 * `scope` is the EXPLICIT cache/request scope — `'default'` for the boot project, the id
 * otherwise (the `useProjectRuns` convention). The sidebar renders in the shell, above the
 * `ProjectScopeProvider`, so `queryScope()` there still names the previous project; binding the
 * scope here is what keeps these reads on the entries the routed GitHub view fills.
 *
 * Every query is one the routed view already makes (list, runs) or a single cached `gh search`
 * (capped at 50 hits) — never a request per PR. Searches wait for the list to say the forge is
 * available, so a repo without `gh` costs nothing.
 */
export function useGithubFilterModel(scope: string) {
  const list = useProjectGithub(scope, { limit: GITHUB_LIST_LIMIT })
  const gh = list.data
  const forge = gh?.available === true
  const runs = useProjectRuns(scope, true, scope === 'default')
  const review = useProjectGithubSearch(scope, 'pr', REVIEW_QUERY, forge)
  const failing = useProjectGithubSearch(scope, 'pr', FAILING_QUERY, forge)
  const tasks = useMemo(
    () => (runs.data ? issueNumbersWithTask(runs.data, gh?.repo, scope) : null),
    [runs.data, gh?.repo, scope],
  )
  const counts = useMemo(
    () => filterCounts({ gh, tasks, review: review.data, failing: failing.data }),
    [gh, tasks, review.data, failing.data],
  )
  return {
    gh,
    counts,
    /** The row-level reasons a filter cannot be applied at all (not merely "still loading"). */
    blocked: {
      identity: gh?.available === true && !gh.viewerLogin ? 'GitHub login unavailable.' : null,
      tasks: runs.isError && !runs.data ? 'Task list unavailable.' : null,
    },
  }
}
