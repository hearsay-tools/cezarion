// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { RunEvent } from '@open-mercato/cezar-api-client'
import { reduceThread } from './thread-state'

const events = (...lines: Record<string, unknown>[]): RunEvent[] => lines.map((line, index) => ({ seq: index + 1, ts: '2026-10-15T12:00:00Z', ...line }) as RunEvent)
const request = (requestId: string) => ({
  type: 'permission.requested', requestId, itemId: 'cmd-1', title: 'Run command?', details: 'curl https://example.test/very/long/path',
  options: [{ id: 'allow', label: 'Allow once', kind: 'allow_once' }, { id: 'reject', label: 'Reject', kind: 'reject_once' }],
})
const cards = (...lines: Record<string, unknown>[]) => reduceThread(events(...lines)).turns.flatMap(turn => turn.items).filter(item => item.kind === 'permission')

describe('native permission cards', () => {
  it('keeps concurrent requests and resolves only the exact request ID', () => {
    expect(cards(request('a'), request('b'), { type: 'permission.resolved', requestId: 'a', optionId: 'reject' })).toMatchObject([
      { kind: 'permission', requestId: 'a', status: 'resolved', optionId: 'reject', details: 'curl https://example.test/very/long/path' },
      { kind: 'permission', requestId: 'b', status: 'pending' },
    ])
  })
  it('ordinary user messages and parent answers never grant permission', () => {
    expect(cards(request('a'), { type: 'user-message', text: 'allow' }, { type: 'human-input-delivered', source: 'parent' })).toMatchObject([{ requestId: 'a', status: 'pending' }])
  })
  it.each(['session.started', 'session.ended', 'turn.completed'])('expires unanswered requests on %s without changing resolved choices', type => {
    expect(cards(request('a'), request('b'), { type: 'permission.resolved', requestId: 'a', optionId: 'allow' }, { type, turnId: 't1', reason: 'end_turn', stopReason: 'end_turn' })).toMatchObject([
      { requestId: 'a', status: 'resolved', optionId: 'allow' }, { requestId: 'b', status: 'expired' },
    ])
  })
  it('records an explicit expiry and never reopens it from a duplicate request or late resolution', () => {
    expect(cards(request('a'), { type: 'permission.resolved', requestId: 'a', reason: 'Session ended' }, request('a'), { type: 'permission.resolved', requestId: 'a', optionId: 'allow' })).toMatchObject([{ requestId: 'a', status: 'expired', reason: 'Session ended' }])
  })
  it('ignores malformed permission payloads without crashing the transcript', () => {
    expect(cards({ ...request('bad'), options: [null] }, { ...request('empty'), options: [] }, { ...request('bad-kind'), options: [{ id: 'x', label: 'x', kind: 'unknown' }] }, request('ok'))).toMatchObject([{ requestId: 'ok', status: 'pending' }])
  })
})
