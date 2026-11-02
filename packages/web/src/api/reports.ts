import { useInfiniteQuery } from '@tanstack/react-query'
import { queryScope } from '@open-mercato/cezar-api-client/utils/project-scope'
import { reportsResponseSchema } from '@open-mercato/cezar-api-client/contract/reports'
import { cez, unwrap, init } from './client'

export async function getReports(projectId: string, q: string, before?: string, signal?: AbortSignal) {
  const response = await cez.api.v1.p[':projectId'].reports.$get({
    param: { projectId }, query: { q, ...(before ? { before } : {}) },
  }, init(signal ? { signal } : undefined))
  return reportsResponseSchema.parse(await unwrap(response, '/reports'))
}

export function useReports(q: string) {
  const scope = queryScope()
  return useInfiniteQuery({
    queryKey: [scope, 'reports', q],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) => getReports(scope, q, pageParam, signal),
    getNextPageParam: page => page.nextCursor ?? undefined,
    refetchOnWindowFocus: true,
  })
}
