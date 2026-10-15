import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { PermissionDecision } from '@open-mercato/cezar-api-client'
import { decidePermission } from './client'
import { queryKeys } from './queries'

/** Decisions never retry automatically or fall back to a chat message/continuation. */
export function usePermissionDecision(runId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (decision: PermissionDecision) => decidePermission(runId, decision),
    retry: false,
    networkMode: 'always',
    onSettled: () => { void queryClient.invalidateQueries({ queryKey: queryKeys.runs.all }) },
  })
}
