import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'

import { cancelRun } from '@/api/client'
import { queryKeys } from '@/api/queries'
import type { ApiRun } from '@open-mercato/cezar-api-client'
import { isRunActive } from './run-actions'

/** Stop acceptance is not termination. Hold the composer until the run record confirms it. */
export function useStopAction(run: ApiRun) {
  const queryClient = useQueryClient()
  const [requestedRun, setRequestedRun] = useState<string>()
  const active = isRunActive(run.status)
  useEffect(() => {
    if (!active || (requestedRun && requestedRun !== run.id)) setRequestedRun(undefined)
  }, [active, run.id, requestedRun])
  const mutation = useMutation({
    mutationFn: async () => {
      setRequestedRun(run.id)
      try {
        const result = await cancelRun(run.id)
        if (!result.cancelled) throw new Error('The task changed before Stop was accepted. Check its status and retry.')
      } catch (error) {
        setRequestedRun(undefined)
        throw error
      }
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.runs.all }),
  })
  return {
    stopping: !!run.stopping || mutation.isPending || (active && requestedRun === run.id),
    stop: () => mutation.mutateAsync(),
  }
}
