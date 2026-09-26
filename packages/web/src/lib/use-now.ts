import * as React from 'react'

import { isCockpitE2e } from './e2e-mode'

/**
 * Re-render on a slow tick so relative ages stay true between data updates.
 *
 * 30s is the callers' interval: finer than the coarsest unit an age can show ('1m'), and cheap
 * enough that a screen of rows costs nothing between SSE updates. Shared by the sidebar
 * quick-list and the Tasks table so the two never disagree about what time it is.
 *
 * E2e mode (#415) pins the first sample and never starts the interval, so a 25 s wait cannot
 * span a tick that re-renders every row it is watching.
 */
export function useNow(intervalMs: number): number {
  const [now, setNow] = React.useState(() => Date.now())
  React.useEffect(() => {
    if (isCockpitE2e()) return
    const timer = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(timer)
  }, [intervalMs])
  return now
}
