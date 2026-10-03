import { useMemo } from 'react'

import { useRunHistory } from '@/api/run-history'

import { reduceThread, type ThreadPreviewServer } from '../thread-state'

/**
 * Where each registered server stands now, as the task's own events say (`preview.server-state`),
 * reduced by the same reducer the transcript's cards use so the two can never disagree. Shares the
 * history query with the thread view, so on the Session tab this costs nothing extra.
 *
 * A server no loaded event mentions is simply absent: callers fall back to its registration.
 */
export function usePreviewServerStates(runId: string): ReadonlyMap<number, ThreadPreviewServer> {
  const { visibleEvents } = useRunHistory(runId)
  return useMemo(() => {
    const states = new Map<number, ThreadPreviewServer>()
    for (const turn of reduceThread(visibleEvents, { activeTurn: false }).turns) {
      for (const item of turn.items) {
        if (item.kind === 'preview-server') states.set(item.server.port, item)
      }
    }
    return states
  }, [visibleEvents])
}
