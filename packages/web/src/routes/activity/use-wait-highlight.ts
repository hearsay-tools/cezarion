import * as React from 'react'

import { linkedByWaits, type PeerWait } from './activity-model'

const NO_IDS: ReadonlySet<string> = new Set()

/** What moved onto or off a card: the pointer or the keyboard focus. */
export type HoverSource = 'pointer' | 'focus'

/** The pointer or the focus entered a card (its run id) or left it (undefined). */
export type OnHover = (source: HoverSource, runId: string | undefined) => void

/**
 * The card under the pointer or holding the focus, and what the peer waits link to it: the cards
 * to outline and the wait lines to draw stronger. The pointer and the focus are kept apart, so the
 * pointer leaving a card does not drop the highlight of the card that holds the focus. While the
 * pointer is on a card, that card wins.
 */
export function useWaitHighlight(waits: readonly PeerWait[]) {
  const [at, setAt] = React.useState<Partial<Record<HoverSource, string>>>({})
  const hovered = at.pointer ?? at.focus
  const onHover = React.useCallback<OnHover>((source, runId) => setAt((current) => (current[source] === runId ? current : { ...current, [source]: runId })), [])
  const linked = React.useMemo(() => (hovered === undefined ? NO_IDS : linkedByWaits(hovered, waits)), [hovered, waits])
  const active = React.useMemo(
    () => (hovered === undefined ? NO_IDS : new Set(waits.filter((wait) => wait.waiterRunId === hovered || wait.peerRunId === hovered).map((wait) => wait.id))),
    [hovered, waits],
  )
  return { linked, active, onHover }
}
