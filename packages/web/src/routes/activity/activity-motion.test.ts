import { describe, expect, it } from 'vitest'

import { RUN_STATUS, iso, request, run, worker } from './activity.testkit'
import type { ActivityTrigger } from './activity-diff'
import { EMPTY_MOTION, MOTION_MS, applyMotion, checkKey, isStill, passedChecks, planMotion, type MotionState } from './activity-motion'

const A = run({ runId: 'a', title: 'Porting upstream SSE' })
const PEER = request({ senderRunId: 'a', recipientRunId: 'b' })
const WAIT = { id: 'wait:a:b', waiterRunId: 'a', peerRunId: 'b', since: iso(-1_000), deadline: iso(600_000) }
const projectId = 'cezarion'

/** One trigger of each kind. */
const TRIGGERS: ActivityTrigger[] = [
  { kind: 'request-opened', projectId, request: PEER },
  { kind: 'request-closed', projectId, request: PEER, status: 'replied' },
  { kind: 'request-closed', projectId, request: PEER, status: 'timed-out' },
  { kind: 'rung-changed', projectId, task: { ...A, rung: 'needs-you' }, from: 'running' },
  { kind: 'tool-started', projectId, runId: 'a' },
  { kind: 'worker-started', projectId, parentId: 'a', worker: worker({ runId: 'w' }) },
  { kind: 'worker-settled', projectId, parentId: 'a', worker: worker({ runId: 'w', status: RUN_STATUS.done, rung: 'done' }) },
  { kind: 'worker-settled', projectId, parentId: 'a', worker: worker({ runId: 'w', status: RUN_STATUS.review, rung: 'needs-review' }) },
  { kind: 'card-entered', projectId, task: A },
  { kind: 'card-left', projectId, task: A },
  { kind: 'check-passed', projectId, runId: 'a', pr: 7, name: 'lint' },
  { kind: 'chip-changed', chip: 'working', from: 1, to: 2 },
  { kind: 'wait-opened', projectId, wait: WAIT },
  { kind: 'wait-closed', projectId, wait: WAIT },
]

/** The state after the plan's changes, then after each of its timers in time order. */
function playOut(triggers: ActivityTrigger[], key = 1) {
  const plan = planMotion(triggers, key, false)
  const started = applyMotion(EMPTY_MOTION, plan.changes)
  const states: { at: number; state: MotionState }[] = []
  let state = started
  for (const timer of [...plan.timers].sort((a, b) => a.after - b.after)) {
    state = applyMotion(state, [timer.change])
    states.push({ at: timer.after, state })
  }
  return { plan, started, states, end: state }
}

describe('planMotion', () => {
  it.each(TRIGGERS.map((trigger) => [trigger.kind, trigger] as const))('plays %s, and its timers remove all of it', (_kind, trigger) => {
    const { plan, started, end } = playOut([trigger])
    expect(plan.changes.length).toBeGreaterThan(0)
    expect(isStill(started)).toBe(false)
    expect(isStill(end)).toBe(true)
  })

  it.each(TRIGGERS.map((trigger) => [trigger.kind, trigger] as const))('with reduced motion turns %s into an immediate change: no motion, no timer', (_kind, trigger) => {
    expect(planMotion([trigger], 1, true)).toEqual({ changes: [], timers: [] })
  })

  it('sends a comet from the sender on open, and back in the success tone on a reply', () => {
    const open = playOut([{ kind: 'request-opened', projectId, request: PEER }]).started
    expect(Object.values(open.comets)).toEqual([{ key: 1, requestId: PEER.requestId, reverse: false, tone: 'peer' }])
    const reply = playOut([{ kind: 'request-closed', projectId, request: PEER, status: 'replied' }]).started
    expect(Object.values(reply.comets)).toEqual([{ key: 1, requestId: PEER.requestId, reverse: true, tone: 'success' }])
    const fade = playOut([{ kind: 'request-closed', projectId, request: PEER, status: 'destroyed' }]).started
    expect(fade.comets).toEqual({})
    expect(fade.closing[PEER.requestId]?.phase).toBe('fade')
  })

  it('plays a reply as the comet, then "Replied", then the fade, then nothing', () => {
    const { started, states } = playOut([{ kind: 'request-closed', projectId, request: PEER, status: 'replied' }])
    expect(started.closing[PEER.requestId]?.phase).toBe('reply')
    const phases = states.map(({ at, state }) => [at, state.closing[PEER.requestId]?.phase])
    expect(phases).toEqual([
      [MOTION_MS.comet, 'replied'],
      [MOTION_MS.comet, 'replied'],
      [MOTION_MS.comet + MOTION_MS.replied, 'fade'],
      [MOTION_MS.comet + MOTION_MS.replied + MOTION_MS.fade, undefined],
    ])
  })

  it('keeps a settled worker as a row for 3 s, folds it, then lets it go; a review worker only flashes', () => {
    const done = playOut([{ kind: 'worker-settled', projectId, parentId: 'a', worker: worker({ runId: 'w', status: RUN_STATUS.done, rung: 'done' }) }])
    expect(done.started.workerHold.w).toMatchObject({ tone: 'success', phase: 'flash' })
    expect(done.states.map(({ at, state }) => [at, state.workerHold.w?.phase])).toEqual([[MOTION_MS.workerHold, 'fold'], [MOTION_MS.workerHold + MOTION_MS.workerFold, undefined]])
    const failed = playOut([{ kind: 'worker-settled', projectId, parentId: 'a', worker: worker({ runId: 'w', status: RUN_STATUS.failed, rung: 'failed' }) }])
    expect(failed.started.workerHold.w?.tone).toBe('danger')
    const review = playOut([{ kind: 'worker-settled', projectId, parentId: 'a', worker: worker({ runId: 'w', status: RUN_STATUS.review, rung: 'needs-review' }) }])
    expect(review.states.map(({ at }) => at)).toEqual([MOTION_MS.flash])
  })

  it('lets a later trigger for the same id outlive the earlier timer', () => {
    const first = planMotion([{ kind: 'tool-started', projectId, runId: 'a' }], 1, false)
    const second = planMotion([{ kind: 'tool-started', projectId, runId: 'a' }], 2, false)
    let state = applyMotion(applyMotion(EMPTY_MOTION, first.changes), second.changes)
    state = applyMotion(state, first.timers.map((timer) => timer.change))
    expect(state.slides.a?.key).toBe(2)
    state = applyMotion(state, second.timers.map((timer) => timer.change))
    expect(state.slides).toEqual({})
  })

  it('stops drawing a card that leaves once it enters again', () => {
    const left = applyMotion(EMPTY_MOTION, planMotion([{ kind: 'card-left', projectId, task: A }], 1, false).changes)
    const back = applyMotion(left, planMotion([{ kind: 'card-entered', projectId, task: A }], 2, false).changes)
    expect(back.leaving).toEqual({})
    expect(back.entering.a?.key).toBe(2)
  })

  it('names the checks of a run that just passed', () => {
    const state = applyMotion(EMPTY_MOTION, planMotion([{ kind: 'check-passed', projectId, runId: 'a', pr: 7, name: 'lint' }, { kind: 'check-passed', projectId, runId: 'ab', pr: 7, name: 'test' }], 1, false).changes)
    expect(Object.keys(state.checks)).toEqual([checkKey('a', 'lint'), checkKey('ab', 'test')])
    expect([...passedChecks(state, 'a')]).toEqual(['lint'])
  })

  it('fades a new wait line in, and keeps an ended one drawn while it fades out, with no comet', () => {
    const opened = playOut([{ kind: 'wait-opened', projectId, wait: WAIT }])
    expect(opened.started.opening).toHaveProperty(WAIT.id)
    expect(opened.started.comets).toEqual({})
    expect(opened.end.opening).toEqual({})
    const closed = playOut([{ kind: 'wait-closed', projectId, wait: WAIT }])
    expect(closed.started.waitsClosing[WAIT.id]).toMatchObject({ projectId, wait: WAIT })
    expect(closed.started.comets).toEqual({})
    expect(closed.states.at(-1)?.at).toBe(MOTION_MS.fade)
    expect(closed.end.waitsClosing).toEqual({})
  })

  it('stops the fade of a wait that opens again', () => {
    const plan = planMotion([{ kind: 'wait-opened', projectId, wait: WAIT }], 2, false)
    const state = applyMotion(playOut([{ kind: 'wait-closed', projectId, wait: WAIT }]).started, plan.changes)
    expect(state.waitsClosing).toEqual({})
  })
})
