import { describe, expect, it } from 'vitest'

import type { ApiRun } from '@open-mercato/cezar-api-client'

import {
  conversationDirection,
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
    const titles = titlesFromRuns(parent, [worker])
    expect(taskTitleFor('parent', titles)).toBe('Parent')
    expect(taskTitleFor('alpha', titles)).toBe('Alpha')
    expect(taskTitleFor('missing', titles)).toBe('Task')
  })

  it('labels direction and kinds without exposing raw identifiers', () => {
    expect(conversationDirection({ senderRunId: 'parent' }, 'parent')).toBe('outbound')
    expect(conversationDirection({ senderRunId: 'alpha' }, 'parent')).toBe('inbound')
    expect(conversationKindLabel('request')).toBe('Request')
    expect(conversationKindLabel('reply')).toBe('Reply')
    expect(conversationOutcomeLabel('replied')).toBe('Replied')
    expect(conversationOutcomeLabel('pending')).toBe('Pending')
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
    const backends = recipientBackendsFromRuns(parent, [cursor, unknown])
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
