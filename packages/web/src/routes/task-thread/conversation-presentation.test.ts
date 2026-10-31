import { summaryOf } from '@/test/run-summary-fixture'
import { describe, expect, it } from 'vitest'

import type { ApiRun } from '@open-mercato/cezar-api-client'

import {
  conversationDeliveryExplanation,
  conversationDeliveryLabel,
  isPeerMessage,
  conversationDirection,
  counterpartTitle,
  conversationKindLabel,
  conversationOutcomeLabel,
  conversationStatusLabel,
  taskTitleFor,
  titlesFromRuns,
  recipientBackendsFromRuns,
} from './conversation-presentation'

function run(over: Pick<ApiRun, 'id' | 'title'> & Partial<ApiRun>): ApiRun {
  return {
    workflow: 'quick-task',
    task: over.title,
    status: 'running',
    createdAt: '2026-09-08T12:00:00.000Z',
    tokensUsed: 0,
    archived: false,
    steps: [],
    ...over,
  }
}

describe('conversation presentation titles', () => {
  it('resolves sibling run titles the same way the relationships panel does', () => {
    const parent = run({ id: 'parent', title: 'Parent task', titleSummary: 'Parent' })
    const worker = run({ id: 'alpha', title: 'raw worker prompt', titleSummary: 'Alpha' })
    const titles = titlesFromRuns(parent, [summaryOf(worker)])
    expect(taskTitleFor('parent', titles)).toBe('Parent')
    expect(taskTitleFor('alpha', titles)).toBe('Alpha')
    expect(taskTitleFor('missing', titles)).toBe('Task')
  })

  it('names a related run the run list no longer carries from the relationships titles (#864)', () => {
    const parent = run({ id: 'parent', title: 'Parent task' })
    const titles = titlesFromRuns(parent, [], [{ id: 'old-worker', title: 'raw prompt', titleSummary: 'Old worker' }])
    expect(taskTitleFor('old-worker', titles)).toBe('Old worker')
    // The run list's own row wins: it is the one the stream keeps fresh.
    const fresher = titlesFromRuns(parent, [summaryOf(run({ id: 'old-worker', title: 'Renamed' }))], [{ id: 'old-worker', title: 'Stale' }])
    expect(taskTitleFor('old-worker', fresher)).toBe('Renamed')
  })

  it('labels direction and kinds without exposing raw identifiers', () => {
    expect(conversationDirection({ senderRunId: 'parent' }, 'parent')).toBe('outbound')
    expect(conversationDirection({ senderRunId: 'alpha' }, 'parent')).toBe('inbound')
    expect(conversationKindLabel('request')).toBe('Request')
    expect(conversationKindLabel('reply')).toBe('Reply')
    expect(conversationOutcomeLabel('replied')).toBe('Replied')
    expect(conversationOutcomeLabel('replied-late')).toBe('Replied late')
    expect(conversationOutcomeLabel('pending')).toBe('Pending')
  })

  it('names a request whose peer recipient was deleted (hearsay-tools/cezarion#1992)', () => {
    expect(conversationOutcomeLabel('deleted')).toBe('Recipient deleted')
    expect(conversationStatusLabel({ messageKind: 'request', delivery: 'queued', outcome: { status: 'deleted' } })).toBe('Recipient deleted')
  })

  it('falls back to the terminal delivery only for a request that can never settle', () => {
    expect(conversationStatusLabel({ messageKind: 'request', delivery: 'queued', outcome: { status: 'pending' } })).toBe('Pending')
    expect(conversationStatusLabel({ messageKind: 'request', delivery: 'not-delivered', outcome: { status: 'sender-closed' } })).toBe('Sender closed')
    expect(conversationStatusLabel({ messageKind: 'request', delivery: 'not-delivered' })).toBe('Not delivered')
    expect(conversationStatusLabel({ messageKind: 'progress', delivery: 'not-delivered' })).toBe('Not delivered')
    expect(conversationStatusLabel({ messageKind: 'request', delivery: 'queued' })).toBeUndefined()
  })
})

describe('recipient backend for queued guidance', () => {
  it('uses the active step backend before the run default, and keeps absent data unknown', () => {
    const parent = run({ id: 'parent', title: 'Parent', runner: 'codex' })
    const cursor = run({ id: 'cursor', title: 'Cursor worker', runner: 'codex', currentStepId: 'task', steps: [
      { id: 'task', name: 'Task', kind: 'agent', status: 'running', iterations: 1, tokensUsed: 0, backend: 'cursor' },
    ] })
    const unknown = run({ id: 'unknown', title: 'Old worker' })
    const backends = recipientBackendsFromRuns(parent, [summaryOf(cursor), summaryOf(unknown)])
    expect(backends.parent).toBe('codex')
    expect(backends.cursor).toBe('cursor')
    expect(backends.unknown).toBeUndefined()
  })
})

describe('conversation delivery labels (#505)', () => {
  it('names a message the recipient read', async () => {
    const { conversationDeliveryLabel } = await import('./conversation-presentation')
    expect(conversationDeliveryLabel('consumed')).toBe('Read')
  })
})

describe('worker question outcome labels (#505)', () => {
  it('names a question the parent could not receive', async () => {
    const { conversationOutcomeLabel } = await import('./conversation-presentation')
    expect(conversationOutcomeLabel('human-fallback')).toBe('Sent to a human')
  })
})

describe('conversation delivery explanations (hearsay-tools/cezarion#1992)', () => {
  it('prefers the server instruction over every derived text', () => {
    expect(conversationDeliveryExplanation({ instruction: 'Not delivered: task is done.', delivery: 'queued', state: 'accepted' }, 'cursor')).toBe('Not delivered: task is done.')
  })

  it.each([
    ['cursor', 'If Cursor is in a turn, delivery waits for that turn to end.'],
    ['claude', 'This agent can receive messages during its current turn.'],
    [undefined, 'Timing depends on the recipient agent.'],
  ] as const)('explains a queued message by its recipient backend (%s)', (backend, text) => {
    expect(conversationDeliveryExplanation({ delivery: 'queued' }, backend)).toContain(text)
  })

  it('words an undelivered message by relationship: a parent can resume a worker, nobody resumes a peer', () => {
    expect(conversationDeliveryExplanation({ delivery: 'not-delivered', state: 'continuation-required' }, undefined)).toContain('with cez worker resume')
    const peer = conversationDeliveryExplanation({ delivery: 'not-delivered', state: 'continuation-required', relationship: 'peer' }, undefined)
    expect(peer).toContain('Only its human can continue it')
    expect(peer).not.toContain('resume')
  })

  it('names a destroyed worker and says nothing for a delivered message', () => {
    expect(conversationDeliveryExplanation({ delivery: 'not-delivered', state: 'destroyed' }, undefined)).toBe('Not delivered. This worker was destroyed.')
    expect(conversationDeliveryExplanation({ delivery: 'delivered', state: 'accepted' }, undefined)).toBeUndefined()
  })

  it('names a counterpart: a worker falls back to "Task", a peer the run list lacks stays "peer task"', () => {
    expect(counterpartTitle('alpha', false, { alpha: 'Alpha' })).toBe('Alpha')
    expect(counterpartTitle('missing', false, {})).toBe('Task')
    expect(counterpartTitle('missing', true, {})).toBe('peer task')
    expect(counterpartTitle('alpha', true, { alpha: 'Alpha' })).toBe('Alpha')
  })
})

describe('complete conversation vocabulary', () => {
  it.each([
    ['request', 'Request'], ['progress', 'Progress'], ['follow-up', 'Follow-up'], ['reply', 'Reply'],
  ] as const)('labels kind %s', (kind, label) => {
    expect(conversationKindLabel(kind)).toBe(label)
  })

  it.each([
    ['pending', 'Pending'], ['replied', 'Replied'], ['replied-late', 'Replied late'],
    ['timed-out', 'Timed out'], ['cancelled', 'Cancelled'], ['completed-without-reply', 'Completed without reply'],
    ['failed', 'Failed'], ['destroyed', 'Destroyed'], ['sender-closed', 'Sender closed'],
    ['human-fallback', 'Sent to a human'], ['deleted', 'Recipient deleted'],
  ] as const)('labels outcome %s', (status, label) => {
    expect(conversationOutcomeLabel(status)).toBe(label)
  })

  it.each([
    ['queued', 'Queued'], ['delivered', 'Delivered'], ['consumed', 'Read'], ['not-delivered', 'Not delivered'],
  ] as const)('labels delivery %s', (delivery, label) => {
    expect(conversationDeliveryLabel(delivery)).toBe(label)
    expect(conversationStatusLabel({ messageKind: 'progress', delivery })).toBe(delivery === 'not-delivered' ? 'Not delivered' : undefined)
  })

  it('treats only explicit peer relationships as peer messages', () => {
    expect(isPeerMessage(undefined)).toBe(false)
    expect(isPeerMessage({})).toBe(false)
    expect(isPeerMessage({ relationship: 'family' })).toBe(false)
    expect(isPeerMessage({ relationship: 'peer' })).toBe(true)
  })

  it('preserves empty explicit titles and instructions and falls back for absent maps', () => {
    expect(taskTitleFor('a', undefined)).toBe('Task')
    expect(taskTitleFor('a', { a: '' })).toBe('')
    expect(counterpartTitle('a', true, undefined)).toBe('peer task')
    expect(counterpartTitle('a', true, { a: '' })).toBe('')
    expect(counterpartTitle('a', false, undefined)).toBe('Task')
    expect(conversationDeliveryExplanation({ instruction: '', delivery: 'queued' }, undefined)).toBe('')
  })

  it('keeps the current run authoritative and supports an absent run list', () => {
    const current = run({ id: 'a', title: 'Current', runner: 'claude' })
    expect(titlesFromRuns(current, undefined)).toEqual({ a: 'Current' })
    expect(titlesFromRuns(current, [summaryOf(run({ id: 'a', title: 'Stale' }))])).toEqual({ a: 'Current' })
    expect(recipientBackendsFromRuns(current, undefined)).toEqual({ a: 'claude' })
    const other = summaryOf(run({ id: 'b', title: 'Other', runner: 'codex' }))
    expect(recipientBackendsFromRuns(current, [{ ...other, currentStepBackend: 'cursor' }])).toEqual({ a: 'claude', b: 'cursor' })
  })
})
