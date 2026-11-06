import * as React from 'react'
import type { ActivitySnapshot } from '@open-mercato/cezar-api-client/contract/activity'

import { usePageActive } from '@/api/live-visibility'

import type { FeedEntry } from './activity-feed'
import { applyMotion, type MotionState } from './activity-motion'
import { advanceMotion, startMotion, type MotionTracker } from './motion-tracker'
import { useReducedMotion } from './use-reduced-motion'

/**
 * The motion of one activity view, from the difference between each snapshot and the one before
 * (spec 2026-11-05-live-activity-view, "Live transport"). The first snapshot of a scope never
 * animates. The motion is planned while the view renders (`advanceMotion`), so the snapshot change
 * and its motion commit together. A hidden tab and reduced motion turning on drop the running
 * motion and its timers; the first snapshot after the tab returns applies at once.
 */

export interface ActivityMotion {
  motion: MotionState
  /** The "Just now" feed, newest first. */
  feed: FeedEntry[]
  reduced: boolean
  /** The tab is hidden: the stylesheet pauses every animation. */
  paused: boolean
}

/** Schedule each plan's timers once; drop them all when the tracker's epoch moves on. */
function usePlanTimers(tracker: MotionTracker, setTracker: React.Dispatch<React.SetStateAction<MotionTracker>>) {
  const timers = React.useRef(new Set<ReturnType<typeof setTimeout>>())
  React.useEffect(() => {
    const pending = timers.current
    return () => {
      for (const timer of pending) clearTimeout(timer)
      pending.clear()
    }
  }, [tracker.epoch])
  React.useEffect(() => {
    for (const { after, change } of tracker.plan?.timers ?? []) {
      const timer = setTimeout(() => {
        timers.current.delete(timer)
        setTracker((current) => ({ ...current, motion: applyMotion(current.motion, [change]) }))
      }, after)
      timers.current.add(timer)
    }
    // Keyed by the plan: a re-render with the same plan schedules nothing again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tracker.plan?.key])
}

export function useActivityMotion(snapshot: ActivitySnapshot | undefined, scopeKey: string): ActivityMotion {
  const reduced = useReducedMotion()
  const active = usePageActive()
  const input = { snapshot, scope: scopeKey, active, reduced }
  const [tracker, setTracker] = React.useState(() => startMotion(input))
  const next = advanceMotion(tracker, input)
  // Derived state: React renders again at once with the advanced tracker, before it commits.
  if (next !== tracker) setTracker(next)
  usePlanTimers(next, setTracker)
  return { motion: next.motion, feed: next.feed, reduced, paused: !active }
}
