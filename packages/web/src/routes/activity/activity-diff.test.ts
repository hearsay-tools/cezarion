import { describe, expect, it } from 'vitest'
import type { ActivityProject, ActivitySnapshot } from '@open-mercato/cezar-api-client/contract/activity'

import { ACTIVITY_WAIT_KIND, RUN_STATUS, TOOL_STATUS, iso, project, request, run, worker } from './activity.testkit'
import { diffActivity, type ActivityTrigger } from './activity-diff'

const at = (offsetMs: number, ...projects: ActivityProject[]): ActivitySnapshot => ({ generatedAt: iso(offsetMs), projects })
const kinds = (triggers: ActivityTrigger[]) => triggers.map((trigger) => trigger.kind)
/** The triggers between two states of one project, without the chip counts. */
const between = (before: Partial<ActivityProject>, after: Partial<ActivityProject>) =>
  diffActivity(at(0, project(before)), at(1_000, project(after))).filter((trigger) => trigger.kind !== 'chip-changed')

const A = run({ runId: 'a', title: 'Porting upstream SSE' })
const B = run({ runId: 'b', title: 'Implementing worker spawn' })
const PEER = request({ senderRunId: 'a', recipientRunId: 'b' })

const ci = (runId: string, checks: { name: string; bucket: 'pass' | 'pending' | 'fail' }[], number = 7) => run({
  runId,
  status: RUN_STATUS.waiting,
  rung: 'waiting-for-ci',
  wait: { kind: ACTIVITY_WAIT_KIND.pr, since: iso(-1_000), deadline: iso(900_000), detail: { number, target: 'checks', checks, counts: { pass: 0, fail: 0, pending: checks.length, skipping: 0, cancel: 0 } } },
})

describe('diffActivity', () => {
  it('never animates the first snapshot', () => {
    expect(diffActivity(undefined, at(0, project({ tasks: [A, B], requests: [PEER] })))).toEqual([])
  })

  it('finds nothing between two equal snapshots', () => {
    const value = project({ tasks: [A, B], requests: [PEER] })
    expect(diffActivity(at(0, value), at(1_000, value))).toEqual([])
  })

  it('opens a request with a new id', () => {
    expect(between({ tasks: [A, B] }, { tasks: [A, B], requests: [PEER] })).toEqual([{ kind: 'request-opened', projectId: 'cezarion', request: PEER }])
  })

  it('closes a request with its stored outcome: replied plays the reply, any other status fades', () => {
    const replied = between({ tasks: [A, B], requests: [PEER] }, { tasks: [A, B], closed: [{ requestId: PEER.requestId, senderRunId: 'a', recipientRunId: 'b', status: 'replied', observedAt: iso(500) }] })
    expect(replied).toEqual([{ kind: 'request-closed', projectId: 'cezarion', request: PEER, status: 'replied' }])
    const timedOut = between({ tasks: [A, B], requests: [PEER] }, { tasks: [A, B], closed: [{ requestId: PEER.requestId, senderRunId: 'a', recipientRunId: 'b', status: 'timed-out', observedAt: iso(500) }] })
    expect(timedOut).toEqual([{ kind: 'request-closed', projectId: 'cezarion', request: PEER, status: 'timed-out' }])
  })

  it('fades a request that left the open list with no stored outcome (closed by reconcile)', () => {
    expect(between({ tasks: [A, B], requests: [PEER] }, { tasks: [A, B] })).toEqual([{ kind: 'request-closed', projectId: 'cezarion', request: PEER }])
  })

  it('never closes again a request whose outcome stays in the closed list', () => {
    const closed = [{ requestId: PEER.requestId, senderRunId: 'a', recipientRunId: 'b', status: 'replied' as const, observedAt: iso(500) }]
    expect(between({ tasks: [A, B], closed }, { tasks: [A, B], closed })).toEqual([])
  })

  it('flashes a card whose rung changed', () => {
    const waiting = { ...A, status: RUN_STATUS.waiting, rung: 'needs-you' as const }
    expect(between({ tasks: [A] }, { tasks: [waiting] })).toEqual([{ kind: 'rung-changed', projectId: 'cezarion', task: waiting, from: 'running' }])
  })

  it('slides the main line in at a new tool call', () => {
    const tool = (title: string, startedAt: string) => ({ ...A, tool: { title, toolKind: 'edit' as const, status: TOOL_STATUS.running, startedAt } })
    expect(between({ tasks: [tool('Edit a.ts', iso(-2_000))] }, { tasks: [tool('Edit b.ts', iso(-500))] })).toEqual([{ kind: 'tool-started', projectId: 'cezarion', runId: 'a' }])
    expect(between({ tasks: [tool('Edit a.ts', iso(-2_000))] }, { tasks: [tool('Edit a.ts', iso(-2_000))] })).toEqual([])
  })

  it('starts a new live worker and settles a worker that left the live statuses', () => {
    const live = worker({ runId: 'w' })
    const done = { ...live, status: RUN_STATUS.done, rung: 'done' as const }
    expect(between({ tasks: [A] }, { tasks: [{ ...A, workers: [live] }] })).toEqual([{ kind: 'worker-started', projectId: 'cezarion', parentId: 'a', worker: live }])
    expect(between({ tasks: [{ ...A, workers: [live] }] }, { tasks: [{ ...A, workers: [done] }] })).toEqual([{ kind: 'worker-settled', projectId: 'cezarion', parentId: 'a', worker: done }])
  })

  it('only counts a worker first seen settled: it never moved on screen', () => {
    const done = worker({ runId: 'w', status: RUN_STATUS.done, rung: 'done' })
    expect(between({ tasks: [A] }, { tasks: [{ ...A, workers: [done] }] })).toEqual([])
  })

  it('enters a new card and lets a card that left collapse as it was drawn', () => {
    expect(between({ tasks: [A] }, { tasks: [A, B] })).toEqual([{ kind: 'card-entered', projectId: 'cezarion', task: B }])
    expect(between({ tasks: [A, B] }, { tasks: [A] })).toEqual([{ kind: 'card-left', projectId: 'cezarion', task: B }])
  })

  it('passes a check that moved from pending to pass on the same pull request', () => {
    const before = ci('c', [{ name: 'lint', bucket: 'pending' }, { name: 'test', bucket: 'pending' }])
    const after = ci('c', [{ name: 'lint', bucket: 'pass' }, { name: 'test', bucket: 'fail' }])
    expect(between({ tasks: [before] }, { tasks: [after] })).toEqual([{ kind: 'check-passed', projectId: 'cezarion', runId: 'c', pr: 7, name: 'lint' }])
    expect(between({ tasks: [before] }, { tasks: [ci('c', [{ name: 'lint', bucket: 'pass' }], 8)] })).toEqual([])
  })

  it('changes a chip count over every project of the snapshot', () => {
    const triggers = diffActivity(at(0, project({ tasks: [A] }), project({ projectId: 'shop', tasks: [] })), at(1_000, project({ tasks: [A] }), project({ projectId: 'shop', tasks: [B], inReview: 2 })))
    expect(triggers.filter((trigger) => trigger.kind === 'chip-changed')).toEqual([
      { kind: 'chip-changed', chip: 'working', from: 1, to: 2 },
      { kind: 'chip-changed', chip: 'inReview', from: 0, to: 2 },
    ])
  })

  it.each([
    ['not loaded', { loaded: false }],
    ['unavailable', { unavailable: { status: 503 as const, error: 'locked' } }],
  ])('compares no cards or requests of a project that is %s on either side', (_name, notice) => {
    expect(between({ tasks: [A, B], requests: [PEER] }, { ...notice })).toEqual([])
    expect(between({ ...notice }, { tasks: [A, B], requests: [PEER] })).toEqual([])
  })

  it('lists the triggers of one snapshot in a stable order: cards, then requests, then chips', () => {
    const triggers = diffActivity(at(0, project({ tasks: [A] })), at(1_000, project({ tasks: [A, B], requests: [PEER] })))
    expect(kinds(triggers)).toEqual(['card-entered', 'request-opened', 'chip-changed', 'chip-changed'])
  })

  it('opens and closes a peer wait as the waiter starts and stops waiting on a peer', () => {
    const waiting = { ...A, status: RUN_STATUS.waiting, rung: 'waiting-on-workers' as const, wait: { kind: ACTIVITY_WAIT_KIND.peers, since: iso(-1_000), deadline: iso(600_000), detail: { peerRunIds: ['b'] } } }
    const wait = { id: 'wait:a:b', waiterRunId: 'a', peerRunId: 'b', since: iso(-1_000), deadline: iso(600_000) }
    const isWait = (trigger: ActivityTrigger) => trigger.kind === 'wait-opened' || trigger.kind === 'wait-closed'
    expect(between({ tasks: [A, B] }, { tasks: [waiting, B] }).filter(isWait)).toEqual([{ kind: 'wait-opened', projectId: 'cezarion', wait }])
    expect(between({ tasks: [waiting, B] }, { tasks: [A, B] }).filter(isWait)).toEqual([{ kind: 'wait-closed', projectId: 'cezarion', wait }])
    expect(between({ tasks: [waiting, B] }, { tasks: [waiting, B] })).toEqual([])
  })
})
