import { describe, expect, it } from 'vitest'

import { NOW, RUN_STATUS, project, request, run, snapshot, worker } from './activity.testkit'
import type { ActivityTrigger } from './activity-diff'
import { FEED_SIZE, feedAge, feedLine, feedNames, pushFeed } from './activity-feed'

const A = run({ runId: 'a', title: 'Porting SSE' })
const B = run({ runId: 'b', title: 'Fixing shard 3' })
const PEER = request({ senderRunId: 'a', recipientRunId: 'b' })
const names = feedNames(undefined, snapshot(project({ tasks: [A, B] })))
const line = (trigger: ActivityTrigger) => feedLine(trigger, names, NOW)
const projectId = 'cezarion'

describe('feedLine', () => {
  it('says what changed, in the tone of its dot', () => {
    expect(line({ kind: 'request-opened', projectId, request: PEER })).toEqual({ tone: 'peer', text: 'Porting SSE asked Fixing shard 3' })
    expect(line({ kind: 'request-closed', projectId, request: PEER, status: 'replied' })).toEqual({ tone: 'success', text: 'Fixing shard 3 replied to Porting SSE' })
    expect(line({ kind: 'request-closed', projectId, request: PEER, status: 'timed-out' })).toEqual({ tone: 'neutral', text: 'Porting SSE’s request to Fixing shard 3 timed out' })
    expect(line({ kind: 'request-closed', projectId, request: PEER })?.text).toBe('Porting SSE’s request to Fixing shard 3 closed')
    expect(line({ kind: 'rung-changed', projectId, task: { ...A, status: RUN_STATUS.waiting, rung: 'needs-you' }, from: 'running' })).toEqual({ tone: 'pending', text: 'Porting SSE: Needs you' })
    expect(line({ kind: 'worker-started', projectId, parentId: 'a', worker: worker({ title: 'Review branch' }) })).toEqual({ tone: 'running', text: 'Review branch started' })
    expect(line({ kind: 'worker-settled', projectId, parentId: 'a', worker: worker({ title: 'Review branch', status: RUN_STATUS.done, rung: 'done' }) })).toEqual({ tone: 'success', text: 'Review branch finished' })
    expect(line({ kind: 'worker-settled', projectId, parentId: 'a', worker: worker({ title: 'Review branch', status: RUN_STATUS.failed, rung: 'failed' }) })).toEqual({ tone: 'danger', text: 'Review branch failed' })
    expect(line({ kind: 'card-entered', projectId, task: A })?.text).toBe('Porting SSE started')
    expect(line({ kind: 'card-left', projectId, task: A })?.text).toBe('Porting SSE left active work')
    expect(line({ kind: 'check-passed', projectId, runId: 'a', pr: 2724, name: 'lint' })).toEqual({ tone: 'success', text: 'PR 2724: check “lint” passed' })
  })

  it('lists no new tool call and no chip count', () => {
    expect(line({ kind: 'tool-started', projectId, runId: 'a' })).toBeUndefined()
    expect(line({ kind: 'chip-changed', chip: 'working', from: 1, to: 2 })).toBeUndefined()
  })

  it('names a run that just left the view from the previous snapshot', () => {
    const both = feedNames(snapshot(project({ tasks: [A, B] })), snapshot(project({ tasks: [A] })))
    expect(feedLine({ kind: 'request-closed', projectId, request: PEER, status: 'replied' }, both, NOW)?.text).toBe('Fixing shard 3 replied to Porting SSE')
  })
})

describe('pushFeed and feedAge', () => {
  it('keeps the newest six changes, newest first', () => {
    let feed = pushFeed([], [{ tone: 'success', text: 'one' }], 1_000, 1)
    feed = pushFeed(feed, Array.from({ length: FEED_SIZE }, (_, i) => ({ tone: 'neutral' as const, text: `n${i}` })), 2_000, 2)
    expect(feed.map((entry) => entry.text)).toEqual(['n0', 'n1', 'n2', 'n3', 'n4', 'n5'])
    expect(new Set(feed.map((entry) => entry.id)).size).toBe(FEED_SIZE)
  })

  it('reads an age as now, then seconds, then minutes', () => {
    expect([feedAge(0), feedAge(4_999), feedAge(12_000), feedAge(125_000)]).toEqual(['now', 'now', '12 s', '2 min'])
  })
})
