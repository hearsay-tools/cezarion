import { subscribeLive } from './live-coordinator'
import { queryScope } from '@open-mercato/cezar-api-client/utils/project-scope'
import type { LiveRunDemand } from '@open-mercato/cezar-api-client'
import { useEffect, useState } from 'react'

import type { RunEvent } from '@open-mercato/cezar-api-client'

/**
 * Ordered run-event and ui-event subscription list. Keep both generations. Deduplicate by seq
 * above the high-water mark; live-only events consume sequence numbers, so replay gaps are
 * normal.
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
  cursor?: string | undefined
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
