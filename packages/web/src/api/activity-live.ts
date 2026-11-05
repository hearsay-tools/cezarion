import { useEffect, useMemo } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { ActivitySnapshot } from '@open-mercato/cezar-api-client'
import { liveRefetchInterval } from '@/lib/live-refetch'
import { cez, init, unwrap, type ReadOptions } from './client'
import { liveTransport, onLiveTransport } from './live-coordinator'
import { subscribeLiveRead } from './live-reads'
import { subscribeTopic } from './ws'

/** One project's activity, or every project's (spec 2026-11-05-live-activity-view). */
export type ActivityScope = { kind: 'project'; projectId: string } | { kind: 'workspace' }

/** The no-topic re-read cadence while the view is visible (D7). */
export const ACTIVITY_READ_MS = 5_000

export const activityQueryKey = (scope: ActivityScope) =>
  ['workspace', 'activity', scope.kind === 'project' ? scope.projectId : null] as const

/** The topic of a scope: a project id is a slug and never holds a colon. */
export const activityTopic = (scope: ActivityScope): string =>
  scope.kind === 'project' ? `activity:project:${scope.projectId}` : 'activity:workspace'

/** The HTTP twin of the topic, a shared recurring read on the live coordinator's allowlist. */
export const activityPath = (scope: ActivityScope): string =>
  scope.kind === 'project' ? `/api/v1/workspace/activity?project=${encodeURIComponent(scope.projectId)}` : '/api/v1/workspace/activity'

export async function getActivity(scope: ActivityScope, opts?: ReadOptions): Promise<ActivitySnapshot> {
  const query = scope.kind === 'project' ? { project: scope.projectId } : {}
  return unwrap(await cez.api.v1.workspace.activity.$get({ query }, init(opts)), '/workspace/activity')
}

/**
 * The activity snapshot of a scope, live (spec 2026-11-05-live-activity-view, Live transport). It
 * reads the HTTP snapshot once for a fast first paint, then holds the scope's topic, whose frames
 * replace the cached snapshot. When the live coordinator has no topics (remote mode, no
 * SharedWorker, or a failed one), it re-reads the snapshot every 5 s instead; the coordinator runs
 * that read only while the document is visible. Call it in the view, so leaving the view releases
 * the topic and the read.
 */
export function useActivityLive(scope: ActivityScope) {
  const projectId = scope.kind === 'project' ? scope.projectId : undefined
  const stable = useMemo<ActivityScope>(() => (projectId === undefined ? { kind: 'workspace' } : { kind: 'project', projectId }), [projectId])
  const key = useMemo(() => activityQueryKey(stable), [stable])
  const client = useQueryClient()
  const query = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => getActivity(stable, { signal }),
    // The topic or the shared read keeps the cache fresh; a refetch on focus would only repeat it.
    staleTime: Infinity,
  })
  useEffect(() => {
    const fold = (value: unknown) => client.setQueryData(key, value as ActivitySnapshot)
    const releaseTopic = subscribeTopic(activityTopic(stable), fold)
    const intervalMs = liveRefetchInterval<number | false>(ACTIVITY_READ_MS)
    let releaseRead: (() => void) | undefined
    const follow = () => {
      const finite = liveTransport() === 'finite' && intervalMs !== false
      if (finite && !releaseRead) {
        releaseRead = subscribeLiveRead({ path: activityPath(stable), intervalMs }, (value, error) => { if (!error) fold(value) })
      } else if (!finite && releaseRead) {
        releaseRead()
        releaseRead = undefined
      }
    }
    follow()
    const releaseTransport = onLiveTransport(follow)
    return () => {
      releaseTransport()
      releaseRead?.()
      releaseTopic()
    }
  }, [client, key, stable])
  return query
}
