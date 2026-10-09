import { subscribeLive } from './live-coordinator'
import { queryScope } from '@open-mercato/cezar-api-client'
import type { LiveRunDemand } from '@open-mercato/cezar-api-client'
import { useEffect, useState } from 'react'

import type { RunEvent } from '@open-mercato/cezar-api-client'

/**
 * The per-run event stream (`GET /api/runs/:id/events`), as a raw ordered list — R2 Step 2.4's
 * proof that the protocol-v2 pipe works end to end. Deliberately NO rendering and NO
 * interpretation: R3's thread view is the consumer that turns these into items; this hook only
 * owns the subscription mechanics that every consumer would otherwise get wrong the same way.
 *
 * The endpoint speaks TWO SSE event names on one socket (src/server/server.ts):
 *  - `run-event` — the v1 lines, what the legacy transcript renders;
 *  - `ui-event`  — protocol v2 (dotted types): persisted snapshots AND the ephemeral coalesced
 *    `item.delta` flushes, which never hit the NDJSON file.
 * Both land in the one list, in arrival (= `seq`) order, because v2 is *additive*: a consumer
 * migrating one panel at a time needs both vocabularies over one clock.
 *
 * Dedup MUST be `seq > maxSeq`, never equality or gap detection: the server replays the whole
 * NDJSON file on every (re)connect — dropping everything at or below the high-water mark is
 * what makes an EventSource auto-reconnect invisible — and ephemeral deltas consume seq numbers
 * that never reappear in a replay, so gaps are normal, not loss.
 */

/** Both wire names. Exported so tests and future consumers subscribe to exactly this set. */
export const RUN_EVENT_NAMES = ['run-event', 'ui-event'] as const

/**
 * Parse one SSE frame into a `RunEvent`, or null for anything malformed. Null rather than a
 * throw, as everywhere on the stream boundary: one bad frame costs one frame, not the socket.
 * `seq` must be a number — it is the dedup axis, and a line without one cannot be ordered.
 */
export function parseRunEvent(data: string): RunEvent | null {
  let payload: unknown
  try {
    payload = JSON.parse(data)
  } catch {
    return null
  }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null
  const { seq, type } = payload as { seq?: unknown; type?: unknown }
  if (typeof seq !== 'number' || typeof type !== 'string' || type === '') return null
  return payload as RunEvent
}

/**
 * Subscribe to one run's event stream and accumulate the raw ordered list.
 *
 * The list resets when `runId` changes (a different run's events are not "earlier state" of
 * this one) and the socket closes on unmount — an EventSource left unclosed retries forever.
 * No reducer cache, no query-client involvement: unlike the global stream, this data belongs
 * to exactly the component that asked for it.
 */
export interface RunEventStreamOptions {
  cursor?: string
  afterSeq?: number
  /** Optimized history keeps a bounded live tail; full-replay fallback leaves this absent. */
  maxEvents?: number
  /** Ask the history owner to fold the live prefix into a fresh persisted tail page. */
  compactAt?: number
  onCompact?: () => void
  onReset?: (reason: string, signal: AbortSignal) => Promise<Pick<LiveRunDemand, 'cursor' | 'afterSeq'> | void>
}

export function useRunEvents(runId: string | undefined, options: RunEventStreamOptions = {}): RunEvent[] {
  const [events, setEvents] = useState<RunEvent[]>([])
  const { cursor, afterSeq = 0, maxEvents, compactAt, onCompact, onReset } = options

  useEffect(() => {
    // The reset also covers the runId-changed case: whatever accumulated belongs to the old id.
    setEvents([])
    if (!runId) return

    let maxSeq = afterSeq
    let disposed = false
    let compactionRequested = false
    const scope = queryScope()

    // Frames are batched into one state update per animation frame (#881). Every SSE message is
    // its own task, so a per-frame `setEvents` re-rendered the whole thread once per frame: a
    // 1,051-frame replay cost a thousand renders. The 50 ms timer races the animation frame
    // because a hidden tab never runs one, and a buffer must not wait for the tab to return.
    const FLUSH_FALLBACK_MS = 50
    let pending: RunEvent[] = []
    let flushFrame: number | undefined
    let flushTimer: ReturnType<typeof setTimeout> | undefined

    const flush = (): void => {
      if (flushFrame !== undefined) globalThis.cancelAnimationFrame?.(flushFrame)
      clearTimeout(flushTimer)
      flushFrame = undefined
      flushTimer = undefined
      if (disposed || pending.length === 0) return
      const batch = pending
      pending = []
      setEvents((current) => {
        const next = [...current, ...batch]
        if (
          !compactionRequested &&
          compactAt !== undefined &&
          next.length >= compactAt
        ) {
          compactionRequested = true
          queueMicrotask(() => {
            if (!disposed) onCompact?.()
          })
        }
        return maxEvents === undefined || next.length <= maxEvents ? next : next.slice(-maxEvents)
      })
    }

    const scheduleFlush = (): void => {
      if (flushTimer !== undefined) return
      flushTimer = setTimeout(flush, FLUSH_FALLBACK_MS)
      if (typeof globalThis.requestAnimationFrame === 'function') {
        flushFrame = globalThis.requestAnimationFrame(flush)
      }
    }

    const release = subscribeLive({ kind: 'run', projectId: scope, runId, afterSeq, ...(cursor ? { cursor } : {}) }, {
      frame: frame => {
        if (!('type' in frame) || frame.type !== 'event' || frame.event.seq <= maxSeq) return
        maxSeq = frame.event.seq
        pending.push(frame.event)
        scheduleFlush()
      },
      reset: async (reason, signal) => {
        flush()
        const resume = await onReset?.(reason, signal)
        if (resume) maxSeq = Math.max(maxSeq, resume.afterSeq)
        return resume
      },
    })

    return () => {
      disposed = true
      if (flushFrame !== undefined) globalThis.cancelAnimationFrame?.(flushFrame)
      clearTimeout(flushTimer)
      release()
    }
  }, [runId, cursor, afterSeq, maxEvents, compactAt, onCompact, onReset])

  return events
}
