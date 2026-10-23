import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { RunEvent } from '@open-mercato/cezar-api-client'
import type { RunHistoryState } from '@/api/run-history'
import type { TranscriptRowModel } from './session-transcript'
import type { ThreadAsk } from './thread-state'
import { useRevealAskOrigin } from './use-reveal-ask-origin'

const ask = (id: string): ThreadAsk => ({ kind: 'ask', id, questions: [], resolved: false, placement: 'origin' })

const originRow = (askId: string): TranscriptRowModel => ({
  key: `t1:${askId}`,
  scope: 't1',
  content: { kind: 'block', block: { kind: 'entry', id: askId, entry: ask(askId) } },
})

const noteRow: TranscriptRowModel = {
  key: 't9:n',
  scope: 't9',
  content: { kind: 'block', block: { kind: 'entry', id: 'n', entry: { kind: 'message', id: 'n', role: 'assistant', text: 'later' } } },
}

const history = (overrides: Partial<RunHistoryState> = {}): RunHistoryState => ({
  visibleEvents: [{ seq: 500 } as RunEvent],
  currentEvents: [],
  isPending: false,
  contextPending: false,
  fallback: false,
  hasOlder: true,
  isFetchingOlder: false,
  olderError: undefined,
  loadOlder: vi.fn(() => Promise.resolve()),
  jumpToLatest: vi.fn(() => Promise.resolve()),
  retainedPages: 1,
  ...overrides,
})

type Props = Parameters<typeof useRevealAskOrigin>[0]

function setup(initial: Props) {
  return renderHook((props: Props) => useRevealAskOrigin(props), { initialProps: initial })
}

describe('useRevealAskOrigin (#1495)', () => {
  it('jumps at once when the origin row is loaded', () => {
    const jumpToRow = vi.fn()
    const h = history()
    const hook = setup({ pendingAskId: 'q1', askSeq: 10, rows: [originRow('q1'), noteRow], history: h, jumpToRow })
    act(() => hook.result.current.reveal())
    expect(jumpToRow).toHaveBeenCalledOnce()
    expect(jumpToRow.mock.calls[0]!.slice(0, 2)).toEqual(['t1:q1', 0])
    expect(h.loadOlder).not.toHaveBeenCalled()
    expect(hook.result.current.seeking).toBe(false)
  })

  it('pages older until the origin row appears', () => {
    const jumpToRow = vi.fn()
    const h = history()
    const props: Props = { pendingAskId: 'q1', askSeq: 10, rows: [noteRow], history: h, jumpToRow }
    const hook = setup(props)
    act(() => hook.result.current.reveal())
    expect(h.loadOlder).toHaveBeenCalledOnce()
    hook.rerender({ ...props, history: { ...h, isFetchingOlder: true } })
    expect(h.loadOlder).toHaveBeenCalledOnce()
    hook.rerender({ ...props, history: { ...h, visibleEvents: [{ seq: 300 } as RunEvent] } })
    expect(h.loadOlder).toHaveBeenCalledTimes(2)
    hook.rerender({ ...props, rows: [originRow('q1'), noteRow], history: { ...h, visibleEvents: [{ seq: 5 } as RunEvent] } })
    expect(jumpToRow).toHaveBeenCalledOnce()
    expect(hook.result.current.seeking).toBe(false)
  })

  it('stops when history has no older page', () => {
    const jumpToRow = vi.fn()
    const hook = setup({ pendingAskId: 'q1', askSeq: 10, rows: [noteRow], history: history({ hasOlder: false }), jumpToRow })
    act(() => hook.result.current.reveal())
    expect(jumpToRow).not.toHaveBeenCalled()
    expect(hook.result.current.seeking).toBe(false)
  })

  it('stops on a load error', () => {
    const jumpToRow = vi.fn()
    const h = history({ olderError: 'offline' })
    const hook = setup({ pendingAskId: 'q1', askSeq: 10, rows: [noteRow], history: h, jumpToRow })
    act(() => hook.result.current.reveal())
    expect(h.loadOlder).not.toHaveBeenCalled()
    expect(hook.result.current.seeking).toBe(false)
  })

  it('stops when the pending ask changes', () => {
    const jumpToRow = vi.fn()
    const h = history({ isFetchingOlder: true })
    const props: Props = { pendingAskId: 'q1', askSeq: 10, rows: [noteRow], history: h, jumpToRow }
    const hook = setup(props)
    act(() => hook.result.current.reveal())
    hook.rerender({ ...props, pendingAskId: 'q2', askSeq: 20, rows: [originRow('q1'), noteRow] })
    expect(jumpToRow).not.toHaveBeenCalled()
    expect(hook.result.current.seeking).toBe(false)
  })

  it('jumps without progressive history when the row is present', () => {
    const jumpToRow = vi.fn()
    const hook = setup({ pendingAskId: 'q1', askSeq: undefined, rows: [originRow('q1')], history: undefined, jumpToRow })
    act(() => hook.result.current.reveal())
    expect(jumpToRow).toHaveBeenCalledOnce()
  })
})
