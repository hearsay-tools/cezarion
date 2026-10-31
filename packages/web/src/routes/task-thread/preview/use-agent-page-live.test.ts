import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { RunEvent } from '@open-mercato/cezar-api-client'

import { agentPageLive, useAgentPageLive } from './use-agent-page-live'

const history = vi.hoisted(() => ({ visible: [] as unknown[], current: [] as unknown[] }))
vi.mock('@/api/run-history', () => ({ useRunHistory: () => ({ visibleEvents: history.visible, currentEvents: history.current }) }))

function event(seq: number, fields: Record<string, unknown>): RunEvent {
  return { seq, ts: '2026-10-26T10:00:00.000Z', ...fields } as RunEvent
}

describe('agentPageLive (hearsay-tools/cezarion#784)', () => {
  it('is false with no preview.agent-browser event', () => {
    expect(agentPageLive([])).toBe(false)
    expect(agentPageLive([event(1, { type: 'preview.server-state', port: 5173, state: 'up' })])).toBe(false)
  })

  it('follows the latest preview.agent-browser event', () => {
    expect(agentPageLive([event(1, { type: 'preview.agent-browser', state: 'connected' })])).toBe(true)
    expect(
      agentPageLive([
        event(1, { type: 'preview.agent-browser', state: 'connected' }),
        event(2, { type: 'preview.agent-browser', state: 'disconnected' }),
      ]),
    ).toBe(false)
    expect(
      agentPageLive([
        event(1, { type: 'preview.agent-browser', state: 'disconnected' }),
        event(2, { type: 'preview.agent-browser', state: 'connected' }),
        event(3, { type: 'run.output', text: 'later' }),
      ]),
    ).toBe(true)
  })

  it('skips an event the contract schema refuses', () => {
    expect(
      agentPageLive([
        event(1, { type: 'preview.agent-browser', state: 'connected' }),
        event(2, { type: 'preview.agent-browser', state: 'unknown' }),
      ]),
    ).toBe(true)
  })
})

describe('useAgentPageLive (hearsay-tools/cezarion#784)', () => {
  it("reads the history context, so a connection pushed out of the loaded pages still shows the agent's page", () => {
    history.visible = [event(90, { type: 'run.output', text: 'much later' })]
    history.current = [event(2, { type: 'preview.agent-browser', state: 'connected' }), ...history.visible]
    expect(renderHook(() => useAgentPageLive('r1')).result.current).toBe(true)
  })

  it('updates when the current history changes, including disconnection and an empty history', () => {
    history.visible = []
    history.current = [event(1, { type: 'preview.agent-browser', state: 'connected' })]
    const { result, rerender, unmount } = renderHook(() => useAgentPageLive(undefined))
    expect(result.current).toBe(true)
    history.current = [event(2, { type: 'preview.agent-browser', state: 'disconnected' })]
    rerender()
    expect(result.current).toBe(false)
    history.current = []
    rerender()
    expect(result.current).toBe(false)
    unmount()
  })

})
