import { useReportsLive } from './reports-live'
import { useInfiniteQuery } from '@tanstack/react-query'
import { queryScope } from '@open-mercato/cezar-api-client/utils/project-scope'
import { reportsResponseSchema, REPORTS_QUERY_MAX } from '@open-mercato/cezar-api-client/contract/reports'
import { cez, unwrap, init } from './client'

export async function getReports(projectId: string, q: string, before?: string, signal?: AbortSignal) {
  const response = await cez.api.v1.p[':projectId'].reports.$get({
    param: { projectId }, query: { q: q.slice(0, REPORTS_QUERY_MAX), ...(before ? { before } : {}) },
  }, init(signal ? { signal } : undefined))
  return reportsResponseSchema.parse(await unwrap(response, '/reports'))
}

export function useReports(q: string) {
  const scope = queryScope()
  const fence = useReportsLive(scope)
  return useInfiniteQuery({
    queryKey: [scope, 'reports', q],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) => fence.read(q, () => getReports(scope, q, pageParam, signal)),
    getNextPageParam: page => page.nextCursor ?? undefined,
    staleTime: 0,
    refetchOnWindowFocus: true,
  })
}
