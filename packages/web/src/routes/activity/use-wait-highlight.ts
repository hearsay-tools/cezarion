import * as React from 'react'

import { linkedByWaits, type PeerWait } from './activity-model'

const NO_IDS: ReadonlySet<string> = new Set()

/**
 * The card under the pointer or holding the focus, and what the peer waits link to it: the cards
 * to outline and the wait lines to draw stronger.
 */
export function useWaitHighlight(waits: readonly PeerWait[]) {
  const [hovered, setHovered] = React.useState<string | undefined>(undefined)
  const linked = React.useMemo(() => (hovered === undefined ? NO_IDS : linkedByWaits(hovered, waits)), [hovered, waits])
  const active = React.useMemo(
    () => (hovered === undefined ? NO_IDS : new Set(waits.filter((wait) => wait.waiterRunId === hovered || wait.peerRunId === hovered).map((wait) => wait.id))),
    [hovered, waits],
  )
  return { linked, active, onHover: setHovered }
}
