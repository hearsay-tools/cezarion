import { describe, expect, it } from 'vitest'

import type { RunEvent } from '@open-mercato/cezar-api-client'

import { agentPageLive } from './use-agent-page-live'

const event = (seq: number, fields: Record<string, unknown>): RunEvent => ({ seq, ts: '2026-10-26T10:00:00.000Z', ...fields }) as RunEvent

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
