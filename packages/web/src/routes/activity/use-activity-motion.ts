import * as React from 'react'
import type { ActivitySnapshot } from '@open-mercato/cezar-api-client/contract/activity'

import { usePageActive } from '@/api/live-visibility'

import { diffActivity } from './activity-diff'
import { feedLine, feedNames, pushFeed, type FeedEntry } from './activity-feed'
import { EMPTY_MOTION, applyMotion, planMotion, type MotionChange, type MotionState } from './activity-motion'
import { useReducedMotion } from './use-reduced-motion'

/**
 * The motion of one activity view, from the difference between each snapshot and the one before
 * (spec 2026-11-05-live-activity-view, "Live transport"). The first snapshot of a scope never
 * animates. A hidden tab stops the motion: the view drops every running animation, and the first
 * snapshot after the tab returns applies at once (the reconcile), as the first one does.
 */

export interface ActivityMotion {
  motion: MotionState
  /** The "Just now" feed, newest first. */
  feed: FeedEntry[]
  reduced: boolean
  /** The tab is hidden: the stylesheet pauses every animation. */
  paused: boolean
}

type Action = { type: 'apply'; changes: readonly MotionChange[] } | { type: 'reset' }

function reducer(state: MotionState, action: Action): MotionState {
  return action.type === 'reset' ? EMPTY_MOTION : applyMotion(state, action.changes)
}

/** Timers that stop together: on hide, on a new scope and on unmount. */
function useTimers() {
  const timers = React.useRef(new Set<ReturnType<typeof setTimeout>>())
  const clear = React.useCallback(() => {
    for (const timer of timers.current) clearTimeout(timer)
    timers.current.clear()
  }, [])
  const after = React.useCallback((ms: number, run: () => void) => {
    const timer = setTimeout(() => {
      timers.current.delete(timer)
      run()
    }, ms)
    timers.current.add(timer)
  }, [])
  React.useEffect(() => clear, [clear])
  return { after, clear }
}

export function useActivityMotion(snapshot: ActivitySnapshot | undefined, scopeKey: string): ActivityMotion {
  const reduced = useReducedMotion()
  const active = usePageActive()
  const [motion, dispatch] = React.useReducer(reducer, EMPTY_MOTION)
  const [feed, setFeed] = React.useState<FeedEntry[]>([])
  const { after, clear } = useTimers()
  const seen = React.useRef<{ scope: string; snapshot: ActivitySnapshot } | undefined>(undefined)
  const reconcile = React.useRef(false)
  const seq = React.useRef(0)

  React.useEffect(() => {
    if (active) return
    // Hidden: drop the running motion; the next snapshot after the return applies at once.
    clear()
    dispatch({ type: 'reset' })
    reconcile.current = true
  }, [active, clear])

  React.useEffect(() => {
    if (scopeKey === seen.current?.scope) return
    clear()
    dispatch({ type: 'reset' })
    setFeed([])
  }, [scopeKey, clear])

  React.useEffect(() => {
    if (!snapshot) return
    const previous = seen.current?.scope === scopeKey ? seen.current.snapshot : undefined
    seen.current = { scope: scopeKey, snapshot }
    if (!previous || previous === snapshot || !active) return
    if (reconcile.current) {
      reconcile.current = false
      return
    }
    const triggers = diffActivity(previous, snapshot)
    if (triggers.length === 0) return
    const at = Date.parse(snapshot.generatedAt)
    const names = feedNames(previous, snapshot)
    const lines = triggers.flatMap((trigger) => feedLine(trigger, names, at) ?? [])
    const first = seq.current + 1
    seq.current += lines.length + 1
    if (lines.length > 0) setFeed((current) => pushFeed(current, lines, at, first))
    const plan = planMotion(triggers, seq.current, reduced)
    if (plan.changes.length > 0) dispatch({ type: 'apply', changes: plan.changes })
    for (const timer of plan.timers) after(timer.after, () => dispatch({ type: 'apply', changes: [timer.change] }))
    // `active` and `reduced` are read at the snapshot's arrival; a change to either alone plans nothing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot, scopeKey])

  return { motion, feed, reduced, paused: !active }
}
