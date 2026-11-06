import * as React from 'react'

import { isServerTime } from '@/api/activity-live'
import { useNow } from '@/lib/use-now'

/**
 * The server's clock, ticked once a second on the client (spec 2026-11-05-live-activity-view,
 * "Every age and countdown ticks once a second on the client from the server's timestamps"). The
 * offset is a server snapshot's `generatedAt` minus the time the client received it, taken once
 * for each new server time. A snapshot the client built (a project unavailable before any server
 * snapshot, or one that keeps the cached `generatedAt`) never moves the clock: its `generatedAt`
 * is no server time, or no new one.
 */
export function useServerNow(generatedAt: string | undefined, receivedAt: number): number {
  const now = useNow(1000)
  const [clock, setClock] = React.useState<{ generatedAt?: string; offset: number }>({ offset: 0 })
  let offset = clock.offset
  if (isServerTime(generatedAt) && generatedAt !== clock.generatedAt && receivedAt !== 0) {
    offset = Date.parse(generatedAt) - receivedAt
    // Derived state: React renders again at once with the new offset, before it commits.
    setClock({ generatedAt, offset })
  }
  return now + offset
}
