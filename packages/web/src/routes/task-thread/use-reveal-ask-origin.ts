import { useCallback, useEffect, useState } from 'react'

import type { RunHistoryState } from '@/api/run-history'
import { askRow, type TranscriptRowModel } from './session-transcript'
import type { ThreadScrollControls } from './thread-scroller'

/** The marker takes focus itself, so a screen reader reads "Question asked here" first. */
function focusMarker(row: HTMLElement): HTMLElement | null {
  const marker = row.querySelector<HTMLElement>('[data-slot="ask-origin"]')
  if (marker) marker.tabIndex = -1
  return marker
}

/**
 * "Show where it was asked" (hearsay-tools/cezarion#1495): reveal the pending question's original
 * place. When its turn is older than the loaded pages, load one older page at a time until its
 * row exists. The walk stops when the row is found, no older page is left, a load fails, or
 * the pending question changes. Retention drops the newest pages, so it can reach any depth;
 * "Jump to latest" brings the tail back.
 */
export function useRevealAskOrigin({ pendingAskId, askSeq, rows, history, jumpToRow }: {
  pendingAskId: string | undefined
  /** The pending `ask.requested` event's seq; undefined without progressive history. */
  askSeq: number | undefined
  rows: readonly TranscriptRowModel[]
  history: RunHistoryState | undefined
  jumpToRow: ThreadScrollControls['jumpToRow']
}): { reveal: () => void; seeking: boolean } {
  const [seekingFor, setSeekingFor] = useState<string | undefined>(undefined)
  const reveal = useCallback(() => setSeekingFor(pendingAskId), [pendingAskId])

  // Whether the ask's own event is loaded, not the oldest loaded seq: a page can also carry
  // events older than its window (the session start), which would end the walk too early.
  const visibleEvents = history?.visibleEvents
  const askLoaded = askSeq !== undefined && (visibleEvents?.some(({ seq }) => seq === askSeq) ?? false)
  const hasOlder = history?.hasOlder ?? false
  const isFetchingOlder = history?.isFetchingOlder ?? false
  const olderError = history?.olderError
  const loadOlder = history?.loadOlder
  useEffect(() => {
    if (seekingFor === undefined) return
    if (seekingFor !== pendingAskId) {
      setSeekingFor(undefined)
      return
    }
    const origin = askRow(rows, seekingFor, 'origin')
    if (origin) {
      setSeekingFor(undefined)
      jumpToRow(origin.key, origin.index, focusMarker)
      return
    }
    const older = loadOlder !== undefined && hasOlder && olderError === undefined && askSeq !== undefined && !askLoaded
    if (!older) {
      setSeekingFor(undefined)
      return
    }
    // One page at a time: the next pass runs when the page lands (`visibleEvents` changes).
    if (!isFetchingOlder) void loadOlder().catch(() => {})
  }, [seekingFor, pendingAskId, rows, visibleEvents, askLoaded, hasOlder, isFetchingOlder, olderError, loadOlder, askSeq, jumpToRow])

  return { reveal, seeking: seekingFor !== undefined && seekingFor === pendingAskId }
}
