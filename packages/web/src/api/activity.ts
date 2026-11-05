import { useQuery } from '@tanstack/react-query'
import { activitySnapshotSchema, type ActivitySnapshot } from '@open-mercato/cezar-api-client/contract/activity'
import { queryScope } from '@open-mercato/cezar-api-client/utils/project-scope'

import { ApiError, cez, init, unwrap, type ReadOptions } from './client'

/**
 * The live activity view's read (spec 2026-11-05-live-activity-view, Live transport): the
 * snapshot from `GET /api/v1/workspace/activity`. Workspace-level, so the project goes in the
 * query, never in a `/p/:projectId` prefix; `default` names the boot project.
 *
 * Slice S5 reads the snapshot once per mount. Slice S4 adds the `activity` topic and the 5 s
 * re-read without topics.
 */
export async function getActivity(project: string | undefined, opts?: ReadOptions): Promise<ActivitySnapshot> {
  const query = project === undefined ? {} : { project }
  const body = await unwrap(await cez.api.v1.workspace.activity.$get({ query }, init(opts)), '/workspace/activity')
  // Validated: the view draws lines between ids it finds here, so a malformed body must be an
  // error the view shows, never a crash.
  const parsed = activitySnapshotSchema.safeParse(body)
  if (!parsed.success) throw new ApiError(200, 'the cezar server answered /workspace/activity with an unexpected body')
  return parsed.data
}

export const activityQueryKey = (project: string | undefined) => ['workspace', 'activity', project ?? 'all'] as const

/** One project's snapshot (the active project scope), or every project's with `scope: 'all'`. */
export function useActivity(scope: 'project' | 'all') {
  const project = scope === 'all' ? undefined : queryScope()
  return useQuery({
    queryKey: activityQueryKey(project),
    queryFn: ({ signal }) => getActivity(project, { signal }),
    staleTime: 0,
  })
}
