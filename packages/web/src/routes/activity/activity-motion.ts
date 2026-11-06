import type { ActivityRequest, ActivityRun } from '@open-mercato/cezar-api-client/contract/activity'

import { attentionOfRung, type AttentionTone } from '@/lib/attention'

import type { ActivityTrigger } from './activity-diff'
import type { PeerWait } from './activity-model'

/**
 * The motion of the activity view (spec 2026-11-05-live-activity-view, "Other motion", "Lines
 * between tasks" and "Size, motion and access"). Each trigger becomes timed entries in a motion
 * state that the cards, lines and rail read; a timer removes each entry when its animation ends,
 * so no motion outlives its trigger. Pure: `planMotion` turns triggers into changes and timers,
 * `applyMotion` applies changes. With reduced motion a trigger plans nothing: the view draws the
 * new snapshot at once.
 */

/** How long each animation runs, in ms. The stylesheet (`activity-motion.css`) uses the same. */
export const MOTION_MS = {
  flash: 1300,
  cardEnter: 700,
  cardLeave: 500,
  workerEnter: 700,
  /** A settled worker stays a row this long before it folds into the finished count. */
  workerHold: 3000,
  workerFold: 500,
  comet: 1100,
  /** After the reply comet: the line is solid and its label says "Replied". */
  replied: 900,
  fade: 800,
  bump: 500,
  slide: 450,
  check: 800,
} as const

interface Keyed {
  key: number
}

export interface MotionState {
  /** A card or pill whose rung changed: one border flash in the new tone. */
  flash: Record<string, Keyed & { tone: AttentionTone }>
  entering: Record<string, Keyed>
  /** Cards that left the view, drawn as the previous snapshot had them while they collapse. */
  leaving: Record<string, Keyed & { projectId: string; task: ActivityRun }>
  workerEnter: Record<string, Keyed>
  /** Settled workers kept as a row: a flash, then the fold. */
  workerHold: Record<string, Keyed & { tone: AttentionTone; phase: 'flash' | 'fold' }>
  /** Lines that fade in behind the opening comet (or, for a peer wait, on their own); rail
   *  entries that slide in. */
  opening: Record<string, Keyed>
  /** Closed requests still drawn: the reply comet, then "Replied", then the fade. */
  closing: Record<string, Keyed & { projectId: string; request: ActivityRequest; replied: boolean; phase: 'reply' | 'replied' | 'fade' }>
  /** Ended peer waits still drawn while their line fades out. */
  waitsClosing: Record<string, Keyed & { projectId: string; wait: PeerWait }>
  comets: Record<string, Keyed & { requestId: string; reverse: boolean; tone: CometTone }>
  bumps: Record<string, Keyed>
  /** A card whose main line slides in at a new tool call. */
  slides: Record<string, Keyed>
  /** A check segment that just passed, by `checkKey`. */
  checks: Record<string, Keyed>
}

export type CometTone = 'peer' | 'family' | 'success'
export type MotionField = keyof MotionState
type Entry<F extends MotionField> = MotionState[F][string]

export const EMPTY_MOTION: MotionState = {
  flash: {}, entering: {}, leaving: {}, workerEnter: {}, workerHold: {}, opening: {}, closing: {}, waitsClosing: {}, comets: {}, bumps: {}, slides: {}, checks: {},
}

export const checkKey = (runId: string, name: string) => `${runId}\n${name}`

/** The names of a run's checks that just passed. */
export function passedChecks(state: MotionState, runId: string): Set<string> {
  const prefix = checkKey(runId, '')
  return new Set(Object.keys(state.checks).filter((key) => key.startsWith(prefix)).map((key) => key.slice(prefix.length)))
}

/** One change to the motion state. `value` undefined removes the entry. With `ifKey`, the change
 *  applies only while the entry still carries that key: a later trigger for the same id wins. */
export interface MotionChange {
  field: MotionField
  id: string
  value?: Entry<MotionField>
  ifKey?: number
}

export interface MotionTimer {
  after: number
  change: MotionChange
}

export interface MotionPlan {
  changes: MotionChange[]
  timers: MotionTimer[]
}

class Planner {
  readonly changes: MotionChange[] = []
  readonly timers: MotionTimer[] = []
  constructor(readonly key: number) {}

  /** Put an entry now and remove it after `ms`. */
  timed<F extends MotionField>(field: F, id: string, value: Omit<Entry<F>, 'key'>, ms: number) {
    this.changes.push({ field, id, value: { ...value, key: this.key } as Entry<F> })
    this.timers.push({ after: ms, change: { field, id, ifKey: this.key } })
  }

  /** Replace an entry after `ms`, while it still carries this plan's key. */
  later<F extends MotionField>(field: F, id: string, value: Omit<Entry<F>, 'key'>, ms: number) {
    this.timers.push({ after: ms, change: { field, id, value: { ...value, key: this.key } as Entry<F>, ifKey: this.key } })
  }

  drop(field: MotionField, id: string) {
    this.changes.push({ field, id })
  }
}

const SETTLED_TONE: Record<string, AttentionTone> = { done: 'success', review: 'success', failed: 'danger', cancelled: 'neutral' }

function planWorkerSettled(plan: Planner, worker: ActivityRun['workers'][number]) {
  const tone = SETTLED_TONE[worker.status] ?? 'success'
  // A review worker stays a row: the parent still owes it a decision. It flashes and stays.
  if (worker.status === 'review') {
    plan.timed('workerHold', worker.runId, { tone, phase: 'flash' }, MOTION_MS.flash)
    return
  }
  plan.timed('workerHold', worker.runId, { tone, phase: 'flash' }, MOTION_MS.workerHold + MOTION_MS.workerFold)
  plan.later('workerHold', worker.runId, { tone, phase: 'fold' }, MOTION_MS.workerHold)
}

function planOpened(plan: Planner, request: ActivityRequest) {
  plan.drop('closing', request.requestId)
  plan.timed('opening', request.requestId, {}, MOTION_MS.fade)
  plan.timed('comets', `${request.requestId}:open:${plan.key}`, { requestId: request.requestId, reverse: false, tone: request.relationship }, MOTION_MS.comet)
}

function planClosed(plan: Planner, projectId: string, request: ActivityRequest, replied: boolean) {
  const id = request.requestId
  plan.drop('opening', id)
  if (!replied) {
    plan.timed('closing', id, { projectId, request, replied: false, phase: 'fade' }, MOTION_MS.fade)
    return
  }
  const total = MOTION_MS.comet + MOTION_MS.replied + MOTION_MS.fade
  plan.timed('closing', id, { projectId, request, replied: true, phase: 'reply' }, total)
  plan.later('closing', id, { projectId, request, replied: true, phase: 'replied' }, MOTION_MS.comet)
  plan.later('closing', id, { projectId, request, replied: true, phase: 'fade' }, MOTION_MS.comet + MOTION_MS.replied)
  plan.timed('comets', `${id}:reply:${plan.key}`, { requestId: id, reverse: true, tone: 'success' }, MOTION_MS.comet)
}

function planOne(plan: Planner, trigger: ActivityTrigger) {
  switch (trigger.kind) {
    case 'rung-changed': return plan.timed('flash', trigger.task.runId, { tone: attentionOfRung(trigger.task.rung).tone }, MOTION_MS.flash)
    case 'tool-started': return plan.timed('slides', trigger.runId, {}, MOTION_MS.slide)
    case 'worker-started': return plan.timed('workerEnter', trigger.worker.runId, {}, MOTION_MS.workerEnter)
    case 'worker-settled': return planWorkerSettled(plan, trigger.worker)
    case 'card-entered':
      plan.drop('leaving', trigger.task.runId)
      return plan.timed('entering', trigger.task.runId, {}, MOTION_MS.cardEnter)
    case 'card-left': return plan.timed('leaving', trigger.task.runId, { projectId: trigger.projectId, task: trigger.task }, MOTION_MS.cardLeave)
    case 'check-passed': return plan.timed('checks', checkKey(trigger.runId, trigger.name), {}, MOTION_MS.check)
    case 'request-opened': return planOpened(plan, trigger.request)
    case 'request-closed': return planClosed(plan, trigger.projectId, trigger.request, trigger.status === 'replied')
    case 'chip-changed': return plan.timed('bumps', trigger.chip, {}, MOTION_MS.bump)
    case 'wait-opened':
      plan.drop('waitsClosing', trigger.wait.id)
      return plan.timed('opening', trigger.wait.id, {}, MOTION_MS.fade)
    case 'wait-closed':
      plan.drop('opening', trigger.wait.id)
      return plan.timed('waitsClosing', trigger.wait.id, { projectId: trigger.projectId, wait: trigger.wait }, MOTION_MS.fade)
  }
}

/**
 * The changes and timers of one snapshot's triggers. `key` must differ between calls (a counter):
 * it ties each timer to the entry it planned. Reduced motion plans nothing, so every change
 * applies at once.
 */
export function planMotion(triggers: readonly ActivityTrigger[], key: number, reduced: boolean): MotionPlan {
  const plan = new Planner(key)
  if (!reduced) for (const trigger of triggers) planOne(plan, trigger)
  return { changes: plan.changes, timers: plan.timers }
}

function applyOne(state: MotionState, change: MotionChange): MotionState {
  const current = state[change.field] as Record<string, Keyed>
  if (change.ifKey !== undefined && current[change.id]?.key !== change.ifKey) return state
  if (change.value === undefined && !(change.id in current)) return state
  const next = { ...current }
  if (change.value === undefined) delete next[change.id]
  else next[change.id] = change.value
  return { ...state, [change.field]: next }
}

/** The motion state after `changes`, in order. */
export function applyMotion(state: MotionState, changes: readonly MotionChange[]): MotionState {
  return changes.reduce(applyOne, state)
}

/** True when no motion entry is left. */
export const isStill = (state: MotionState) => Object.values(state).every((field) => Object.keys(field).length === 0)

/** The ended peer waits whose lines still fade out, left out once `open` has them again. */
export function waitGhosts(projectId: string, open: readonly PeerWait[], motion: MotionState): PeerWait[] {
  const ids = new Set(open.map((wait) => wait.id))
  return Object.values(motion.waitsClosing).filter((ghost) => ghost.projectId === projectId && !ids.has(ghost.wait.id)).map((ghost) => ghost.wait)
}
