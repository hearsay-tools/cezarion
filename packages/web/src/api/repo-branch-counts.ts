import type { RepoBranchCountsResponse } from '@open-mercato/cezar-api-client'
import { queryScope } from '@open-mercato/cezar-api-client/utils/project-scope'
import { useQuery } from '@tanstack/react-query'

import { cez, init, unwrap, type ReadOptions } from './client'

/** The branch classification's counts alone (`GET /repo/branches/counts`,
 *  hearsay-tools/cezarion#2029): what the Git sidebar reads, without the rows or a diff stat per
 *  branch. */
export async function getRepoBranchCounts(opts?: ReadOptions, projectId?: string): Promise<RepoBranchCountsResponse> {
  return unwrap(
    await cez.api.v1.p[':projectId'].repo.branches.counts.$get({ param: { projectId: projectId ?? queryScope() } }, init(opts)),
    '/repo/branches/counts',
  )
}

/** `getRepoBranchCounts` for an EXPLICIT scope: the always-mounted Git sidebar reads these, so it
 *  never asks for a diff stat per branch. The key sits under `queryKeys.repoBranches`, so every
 *  invalidation of the full list reaches it too. */
export function useProjectRepoBranchCounts(scope: string) {
  return useQuery({
    queryKey: [scope, 'repo', 'branches', 'counts'] as const,
    queryFn: ({ signal }) => getRepoBranchCounts({ signal }, scope),
  })
}
