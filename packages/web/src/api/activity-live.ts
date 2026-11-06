import { useEffect, useMemo } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { activitySnapshotSchema, type ActivitySnapshot } from '@open-mercato/cezar-api-client/contract/activity'
import { liveRefetchInterval } from '@/lib/live-refetch'
import { ApiError, cez, init, unwrap, type ReadOptions } from './client'
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

/** The error a snapshot that fails the contract becomes. The view draws lines between the ids it
 *  finds in a snapshot, so a malformed one, read or pushed, is an error it shows, never a crash. */
export const UNEXPECTED_ACTIVITY = 'the cezar server answered /workspace/activity with an unexpected body'

/** A read or pushed snapshot, checked against the contract. */
export function parseActivity(value: unknown): ActivitySnapshot {
  const parsed = activitySnapshotSchema.safeParse(value)
  if (!parsed.success) throw new ApiError(200, UNEXPECTED_ACTIVITY)
  return parsed.data
}

export async function getActivity(scope: ActivityScope, opts?: ReadOptions): Promise<ActivitySnapshot> {
  const query = scope.kind === 'project' ? { project: scope.projectId } : {}
  return parseActivity(await unwrap(await cez.api.v1.workspace.activity.$get({ query }, init(opts)), '/workspace/activity'))
}

/** A snapshot, read or pushed, never replaces a cached one the server built later. */
export function newerActivity(cached: ActivitySnapshot | undefined, fetched: ActivitySnapshot): ActivitySnapshot {
  return cached !== undefined && Date.parse(fetched.generatedAt) < Date.parse(cached.generatedAt) ? cached : fetched
}

/**
 * The `generatedAt` of a snapshot the client built with no server snapshot behind it: older than
 * any snapshot the server builds, so the next one replaces it (`newerActivity`). It is not a server
 * time: a view's clock never follows it (`isServerTime`).
 */
export const NO_SERVER_TIME = new Date(0).toISOString()

/** True when `generatedAt` is a time the server stamped: a valid date, never `NO_SERVER_TIME`. */
export function isServerTime(generatedAt: string | undefined): generatedAt is string {
  return generatedAt !== undefined && generatedAt !== NO_SERVER_TIME && !Number.isNaN(Date.parse(generatedAt))
}

/** The answers a project route gives for a project it cannot serve: removed, its folder gone,
 *  or its store unavailable. The view shows the project as unavailable, as the topic does. */
const UNAVAILABLE_STATUSES = new Set([404, 409, 503])

/**
 * The snapshot a scoped read that the project route refused stands for: the project, unavailable,
 * in the shape the topic sends on removal. It keeps the cached name, and the cached `generatedAt`,
 * so any snapshot the server builds later replaces it.
 */
export function unavailableActivity(cached: ActivitySnapshot | undefined, projectId: string, status: 404 | 409 | 503, error: string): ActivitySnapshot {
  const name = cached?.projects.find((project) => project.projectId === projectId)?.name ?? projectId
  return {
    generatedAt: cached?.generatedAt ?? NO_SERVER_TIME,
    projects: [{ projectId, name, loaded: true, unavailable: { status, error }, inReview: 0, tasks: [], requests: [], closed: [] }],
  }
}

/** A failed shared read (`HTTP <status>` with the answer's body) as the error the query reports. */
export function readFailure(body: unknown, error: string): ApiError {
  const status = Number(/^HTTP (\d+)$/.exec(error)?.[1] ?? 0)
  const message = body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string' ? (body as { error: string }).error : error
  return new ApiError(status, message)
}

const unavailableStatus = (scope: ActivityScope, error: ApiError): 404 | 409 | 503 | undefined =>
  scope.kind === 'project' && UNAVAILABLE_STATUSES.has(error.status) ? (error.status as 404 | 409 | 503) : undefined

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
    queryFn: async ({ signal }) => {
      const cached = client.getQueryData<ActivitySnapshot>(key)
      try {
        return newerActivity(cached, await getActivity(stable, { signal }))
      } catch (error) {
        const status = error instanceof ApiError ? unavailableStatus(stable, error) : undefined
        if (status === undefined || stable.kind !== 'project') throw error
        return unavailableActivity(cached, stable.projectId, status, (error as ApiError).message)
      }
    },
    // The topic or the shared read keeps the cache fresh; a refetch on focus would only repeat it.
    staleTime: Infinity,
  })
  useEffect(() => {
    let active = true
    // A refused scoped read shows the project unavailable; any other failure is the query's
    // error, and the last good snapshot stays.
    const failed = (error: ApiError) => {
      void client.cancelQueries({ queryKey: key, exact: true }).then(() => {
        if (!active) return
        const status = unavailableStatus(stable, error)
        if (status !== undefined && stable.kind === 'project') {
          client.setQueryData<ActivitySnapshot>(key, (cached) => unavailableActivity(cached, stable.projectId, status, error.message))
          return
        }
        const query = client.getQueryCache().find<ActivitySnapshot>({ queryKey: key, exact: true })
        query?.setState({ status: 'error', error, errorUpdatedAt: Date.now(), errorUpdateCount: query.state.errorUpdateCount + 1, fetchStatus: 'idle' })
      })
    }
    // A pending HTTP read is cancelled first, so its older answer cannot land on top of this one.
    // Topic frames and HTTP answers alike never replace a snapshot the server built later: a
    // delayed frame stays behind a newer read. Removal and unavailable frames carry the server's
    // current clock, so they still win.
    const fold = (value: unknown) => {
      let next: ActivitySnapshot
      try {
        next = parseActivity(value)
      } catch (error) {
        failed(error as ApiError)
        return
      }
      void client.cancelQueries({ queryKey: key, exact: true }).then(() => {
        if (!active) return
        client.setQueryData<ActivitySnapshot>(key, (cached) => newerActivity(cached, next))
      })
    }
    const releaseTopic = subscribeTopic(activityTopic(stable), fold)
    const intervalMs = liveRefetchInterval<number | false>(ACTIVITY_READ_MS)
    let releaseRead: (() => void) | undefined
    const follow = () => {
      const finite = liveTransport() === 'finite' && intervalMs !== false
      if (finite && !releaseRead) {
        releaseRead = subscribeLiveRead({ path: activityPath(stable), intervalMs }, (value, error) => {
          if (error === undefined) fold(value)
          else failed(readFailure(value, error))
        })
      } else if (!finite && releaseRead) {
        releaseRead()
        releaseRead = undefined
      }
    }
    follow()
    const releaseTransport = onLiveTransport(follow)
    return () => {
      active = false
      releaseTransport()
      releaseRead?.()
      releaseTopic()
    }
  }, [client, key, stable])
  return query
}
