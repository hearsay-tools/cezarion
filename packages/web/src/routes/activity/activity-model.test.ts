// @vitest-environment node
import { describe, expect, it } from 'vitest'

import { ACTIVITY_WAIT_KIND, NOW, RUN_STATUS, iso, project, request, run, worker } from './activity.testkit'
import { directionOf, lineTexts, linkedByWaits, peerWaits, replyDueText, runIndex, sentPeerWaits } from './activity-model'

describe('directionOf', () => {
  const parent = run({ runId: 'parent', workers: [worker({ runId: 'w' })] })
  const index = runIndex(project({ tasks: [parent] }))

  it('reads the direction from the recipient when the sender is not on the view', () => {
    const asks = request({ relationship: 'family', senderRunId: 'unreadable-worker', recipientRunId: 'parent' })
    expect(directionOf(asks, index).relation).toBe('Worker → parent')
    const told = request({ relationship: 'family', senderRunId: 'unreadable-parent', recipientRunId: 'w' })
    expect(directionOf(told, index).relation).toBe('Parent → worker')
  })

  it('reads the direction from the sender when it is on the view', () => {
    expect(directionOf(request({ relationship: 'family', senderRunId: 'w', recipientRunId: 'parent' }), index).relation).toBe('Worker → parent')
    expect(directionOf(request({ relationship: 'family', senderRunId: 'parent', recipientRunId: 'w' }), index).relation).toBe('Parent → worker')
  })
})

describe('replyDueText', () => {
  it('counts down before the deadline and says overdue once it passes', () => {
    expect(replyDueText(iso(348_000), NOW)).toBe('reply due in 5:48')
    expect(replyDueText(iso(0), NOW)).toBe('reply overdue')
    expect(replyDueText(iso(-60_000), NOW)).toBe('reply overdue')
  })
})

describe('peerWaits', () => {
  const waiting = (runId: string, peerRunIds: string[], overrides = {}) => run({
    runId,
    status: RUN_STATUS.waiting,
    rung: 'waiting-on-workers',
    wait: { kind: ACTIVITY_WAIT_KIND.peers, since: iso(-192_000), deadline: iso(408_000), detail: { peerRunIds } },
    ...overrides,
  })

  it('gives one link for each peer a live root waits on, from the peer to the waiter', () => {
    expect(peerWaits([waiting('a', ['b', 'c']), run({ runId: 'b' }), run({ runId: 'c' })])).toEqual([
      { id: 'wait:a:b', waiterRunId: 'a', peerRunId: 'b', since: iso(-192_000), deadline: iso(408_000) },
      { id: 'wait:a:c', waiterRunId: 'a', peerRunId: 'c', since: iso(-192_000), deadline: iso(408_000) },
    ])
  })

  it('names a peer once, never the waiter itself, and skips a run that is not live', () => {
    expect(peerWaits([waiting('a', ['b', 'b', 'a'])]).map((wait) => wait.id)).toEqual(['wait:a:b'])
    expect(peerWaits([waiting('a', ['b'], { status: RUN_STATUS.review })])).toEqual([])
  })

  it('draws nothing for a run whose top wait is not a peer wait', () => {
    expect(peerWaits([run({ runId: 'a', wait: { kind: ACTIVITY_WAIT_KIND.timer, since: iso(0), deadline: iso(60_000), detail: { wakeAt: iso(60_000) } } })])).toEqual([])
  })

  it('says each end of a wait as text, and finds the cards a wait links', () => {
    const tasks = [waiting('a', ['b'], { title: 'Schema migration' }), run({ runId: 'b', title: 'API contract review' })]
    const waits = peerWaits(tasks)
    const index = runIndex(project({ tasks }))
    expect(lineTexts('a', [], index, waits)).toEqual(['Waiting for a message from API contract review'])
    expect(lineTexts('b', [], index, waits)).toEqual(['Schema migration waits for you to write'])
    expect(lineTexts('a', [], runIndex(project({ tasks: tasks.slice(0, 1) })), waits)).toEqual(['Waiting for a message from Unreadable task'])
    expect([...linkedByWaits('a', waits)]).toEqual(['b'])
    expect([...linkedByWaits('b', waits)]).toEqual(['a'])
    expect([...linkedByWaits('c', waits)]).toEqual([])
    expect(sentPeerWaits('a', waits).map((wait) => wait.peerRunId)).toEqual(['b'])
    expect(sentPeerWaits('b', waits)).toEqual([])
  })
})
