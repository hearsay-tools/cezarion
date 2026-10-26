import { useMemo } from 'react'

import { useRunHistory } from '@/api/run-history'
import { previewAgentBrowserEventSchema } from '@open-mercato/cezar-api-client/contract/preview'
import type { RunEvent } from '@open-mercato/cezar-api-client'

/**
 * Whether the latest `preview.agent-browser` event in these events says `connected`: an agent
 * drives the task's browser through cezar's CDP link now (hearsay-tools/cezarion#784). No such
 * event reads as not connected.
 */
export function agentPageLive(events: readonly RunEvent[]): boolean {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const parsed = previewAgentBrowserEventSchema.safeParse(events[index])
    if (parsed.success) return parsed.data.state === 'connected'
  }
  return false
}

/**
 * Whether the agent's page is live, so the pane lists it beside the registered servers. Shares the
 * history query with the thread view and `usePreviewServerStates`.
 */
export function useAgentPageLive(runId: string | undefined): boolean {
  const { visibleEvents } = useRunHistory(runId)
  return useMemo(() => agentPageLive(visibleEvents), [visibleEvents])
}
