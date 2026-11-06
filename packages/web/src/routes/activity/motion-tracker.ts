import type { ActivitySnapshot } from '@open-mercato/cezar-api-client/contract/activity'

import { diffActivity } from './activity-diff'
import { feedLine, feedNames, pushFeed, type FeedEntry } from './activity-feed'
import { EMPTY_MOTION, applyMotion, planMotion, type MotionState, type MotionTimer } from './activity-motion'

/**
 * The motion of one view as a pure state machine (spec 2026-11-05-live-activity-view, "Live
 * transport" and "Size, motion and access"). The view advances it while it renders, so a
 * snapshot change and the motion it plans (a ghost for a card that left, among others) reach the
 * screen in the same render: a card that leaves never loses its place first.
 */

export interface MotionInput {
  snapshot: ActivitySnapshot | undefined
  scope: string
  /** The tab is visible. */
  active: boolean
  reduced: boolean
}

export interface MotionTracker {
  input: MotionInput
  /** The last snapshot of this scope the tracker saw. */
  seen?: ActivitySnapshot
  /** The tab was hidden: the next snapshot applies at once, as a first one does. */
  reconcile: boolean
  /** Numbers each plan and feed entry. */
  seq: number
  motion: MotionState
  feed: FeedEntry[]
  /** The timers of the last plan, keyed so the view schedules each plan once. */
  plan?: { key: number; timers: MotionTimer[] }
  /** Bumped whenever the motion is dropped: the view clears every pending timer. */
  epoch: number
}

export function startMotion(input: MotionInput): MotionTracker {
  return { input, reconcile: false, seq: 0, motion: EMPTY_MOTION, feed: [], epoch: 0, ...(input.snapshot ? { seen: input.snapshot } : {}) }
}

/** Drop every running motion and its timers. Each motion entry's end state is the snapshot
 *  itself, so dropping them applies the end states at once. */
function still(tracker: MotionTracker): MotionTracker {
  const { plan: _plan, ...rest } = tracker
  return { ...rest, motion: EMPTY_MOTION, epoch: tracker.epoch + 1 }
}

function playSnapshot(tracker: MotionTracker, previous: ActivitySnapshot, next: ActivitySnapshot): MotionTracker {
  const triggers = diffActivity(previous, next)
  if (triggers.length === 0) return tracker
  const at = Date.parse(next.generatedAt)
  const names = feedNames(previous, next)
  const lines = triggers.flatMap((trigger) => feedLine(trigger, names, at) ?? [])
  const key = tracker.seq + lines.length + 1
  const plan = planMotion(triggers, key, tracker.input.reduced)
  return {
    ...tracker,
    seq: key,
    feed: lines.length > 0 ? pushFeed(tracker.feed, lines, at, tracker.seq + 1) : tracker.feed,
    motion: applyMotion(tracker.motion, plan.changes),
    ...(plan.timers.length > 0 ? { plan: { key, timers: plan.timers } } : {}),
  }
}

function nextSnapshot(tracker: MotionTracker, snapshot: ActivitySnapshot | undefined): MotionTracker {
  const previous = tracker.seen
  if (!snapshot || snapshot === previous) return tracker
  const seen = { ...tracker, seen: snapshot }
  // While hidden, snapshots only update what was seen; the first one after the return reconciles.
  if (!previous || !tracker.input.active) return seen
  if (tracker.reconcile) return { ...seen, reconcile: false }
  return playSnapshot(seen, previous, snapshot)
}

/**
 * The tracker after one render's input. In order: a new scope starts over (its first snapshot
 * never animates); a hidden tab drops the motion and reconciles later; reduced motion turning on
 * drops the motion; then a new snapshot plays its triggers. Returns the same tracker when nothing
 * changed.
 */
export function advanceMotion(tracker: MotionTracker, input: MotionInput): MotionTracker {
  const was = tracker.input
  if (input.scope !== was.scope) return { ...startMotion(input), seq: tracker.seq, epoch: tracker.epoch + 1 }
  if (input.snapshot === was.snapshot && input.active === was.active && input.reduced === was.reduced) return tracker
  let next: MotionTracker = { ...tracker, input }
  if (was.active && !input.active) next = { ...still(next), reconcile: true }
  return nextSnapshot(next, input.snapshot)
}
