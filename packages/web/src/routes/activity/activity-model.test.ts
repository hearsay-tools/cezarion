// @vitest-environment node
import { describe, expect, it } from 'vitest'

import { NOW, iso, project, request, run, worker } from './activity.testkit'
import { directionOf, replyDueText, runIndex } from './activity-model'

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
