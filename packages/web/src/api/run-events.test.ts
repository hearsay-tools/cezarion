import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { setApiScope } from '@open-mercato/cezar-api-client'
import { flushAnimationFrames, installAnimationFrameQueue } from '../test/animation-frames'
import { parseRunEvent, useRunEvents } from './run-events'

import type { LiveDemand } from './live-protocol'
import type { LiveHandlers } from './live-coordinator'

// Hook tests inject the coordinator seam. Port, visibility, replay and watchdog behavior
// lives in live-coordinator/live-owner tests and the same-profile browser regressions.
vi.mock('./live-coordinator', () => ({ subscribeLive: (demand: LiveDemand, handlers: LiveHandlers) => {
  const source = new FakeFeed(demand, handlers)
  return () => source.close()
} }))
class FakeFeed {
  static instances: FakeFeed[] = []
  static get last(): FakeFeed { return FakeFeed.instances.at(-1)! }
  closeCount = 0
  readyState = 0
  constructor(readonly demand: LiveDemand, readonly handlers: LiveHandlers) { FakeFeed.instances.push(this) }
  close() { this.readyState = 2; this.closeCount++ }
  deliver(name: string, data: string) {
    const event = parseRunEvent(data)
    if (!event || this.demand.kind !== 'run') return
    this.handlers.frame?.({ type: 'event', name: name as 'run-event' | 'ui-event', event, projectId: this.demand.projectId, runId: this.demand.runId })
  }
  emit(name: string, data: string) { act(() => { this.deliver(name, data); flushAnimationFrames() }) }
}

/** A wire line as the server stamps it: seq + ts + type + payload. */
const line = (seq: number, type: string, rest: Record<string, unknown> = {}) =>
  JSON.stringify({ seq, ts: '2026-07-14T12:00:00.000Z', type, ...rest })

beforeEach(() => {
  FakeFeed.instances = []
  installAnimationFrameQueue()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('parseRunEvent', () => {
  it.each([
    { label: 'not JSON', data: 'nope{' },
    { label: 'an array', data: '[1,2]' },
    { label: 'null', data: 'null' },
    { label: 'no seq', data: '{"type":"stdout"}' },
    { label: 'seq not a number', data: '{"seq":"7","type":"stdout"}' },
    { label: 'no type', data: '{"seq":1}' },
    { label: 'empty type', data: '{"seq":1,"type":""}' },
  ])('rejects $label', ({ data }) => {
    expect(parseRunEvent(data)).toBeNull()
  })

  it('keeps the whole payload of a valid line', () => {
    expect(parseRunEvent(line(3, 'item.delta', { itemId: 'i1', field: 'text', delta: 'Hi' }))).toEqual({
      seq: 3,
      ts: '2026-07-14T12:00:00.000Z',
      type: 'item.delta',
      itemId: 'i1',
      field: 'text',
      delta: 'Hi',
    })
  })
})

describe('useRunEvents — subscription', () => {
  it('opens one stream at the run endpoint, and none without a run id', () => {
    renderHook(() => useRunEvents('run-1'))
    expect(FakeFeed.instances).toHaveLength(1)
    expect(FakeFeed.last.demand).toMatchObject({ kind: 'run', projectId: 'default', runId: 'run-1', afterSeq: 0 })

    cleanup()
    renderHook(() => useRunEvents(undefined))
    expect(FakeFeed.instances).toHaveLength(1)
  })

  it('opens the scoped endpoint when a project scope is active (multi-project, step 3.1)', () => {
    setApiScope('proj-a')
    try {
      renderHook(() => useRunEvents('run-1'))
      expect(FakeFeed.last.demand).toMatchObject({ projectId: 'proj-a', runId: 'run-1' })
    } finally {
      setApiScope(null)
    }
  })

  it('collects BOTH wire vocabularies into one ordered list — v1 `run-event` and v2 `ui-event`', () => {
    const { result } = renderHook(() => useRunEvents('run-1'))
    const source = FakeFeed.last

    source.emit('run-event', line(1, 'stdout', { text: 'building…' }))
    source.emit('ui-event', line(2, 'item.started', { item: { kind: 'message', id: 'm1', role: 'assistant', text: '' } }))
    source.emit('ui-event', line(3, 'item.delta', { itemId: 'm1', field: 'text', delta: 'Hello' }))
    source.emit('run-event', line(4, 'token-usage', { tokensUsed: 42 }))

    expect(result.current.map((event) => [event.seq, event.type])).toEqual([
      [1, 'stdout'],
      [2, 'item.started'],
      [3, 'item.delta'],
      [4, 'token-usage'],
    ])
  })

  it('survives a malformed frame — one bad line costs one line', () => {
    const { result } = renderHook(() => useRunEvents('run-1'))
    const source = FakeFeed.last

    source.emit('ui-event', 'not json{')
    source.emit('ui-event', '{"type":"item.started"}') // no seq — unorderable
    source.emit('ui-event', line(1, 'plan.updated', { entries: [] }))

    expect(result.current.map((event) => event.type)).toEqual(['plan.updated'])
  })

})

describe('useRunEvents — seq dedup uses `>`', () => {
  it('drops the replayed prefix after a reconnect instead of duplicating it', () => {
    const { result } = renderHook(() => useRunEvents('run-1'))
    const source = FakeFeed.last

    source.emit('run-event', line(1, 'stdout', { text: 'a' }))
    source.emit('ui-event', line(2, 'turn.started', { turnId: 't1' }))

    // EventSource reconnected on its own; the server replays the file from the top and then
    // carries on with what happened while we were away.
    source.emit('run-event', line(1, 'stdout', { text: 'a' }))
    source.emit('ui-event', line(2, 'turn.started', { turnId: 't1' }))
    source.emit('ui-event', line(3, 'turn.completed', { turnId: 't1', stopReason: 'end_turn' }))

    expect(result.current.map((event) => event.seq)).toEqual([1, 2, 3])
  })

  it('accepts seq gaps — ephemeral deltas burn numbers that never replay', () => {
    const { result } = renderHook(() => useRunEvents('run-1'))
    const source = FakeFeed.last

    source.emit('ui-event', line(2, 'item.started', { item: { kind: 'reasoning', id: 'r1', text: '' } }))
    // seq 3–6 were coalesced deltas this client never saw; the next persisted line jumps.
    source.emit('ui-event', line(7, 'item.completed', { item: { kind: 'reasoning', id: 'r1', text: 'done' } }))

    expect(result.current.map((event) => event.seq)).toEqual([2, 7])
  })

  it('drops a stale line at the high-water mark, not merely duplicates', () => {
    const { result } = renderHook(() => useRunEvents('run-1'))
    const source = FakeFeed.last

    source.emit('ui-event', line(5, 'turn.started', { turnId: 't1' }))
    source.emit('ui-event', line(5, 'turn.started', { turnId: 't1' })) // equal — not `>`
    source.emit('ui-event', line(4, 'stdout', { text: 'late' })) // below — replayed history

    expect(result.current).toHaveLength(1)
  })
})

describe('useRunEvents — batching (#881)', () => {
  it('applies every frame that arrived before an animation frame in one update', () => {
    let renders = 0
    const { result } = renderHook(() => {
      renders += 1
      return useRunEvents('run-1')
    })
    const source = FakeFeed.last
    const before = renders

    for (let seq = 1; seq <= 100; seq += 1) act(() => source.deliver('run-event', line(seq, 'stdout')))
    expect(result.current).toEqual([])
    expect(renders).toBe(before)

    act(() => flushAnimationFrames())
    expect(result.current.map((event) => event.seq)).toEqual(Array.from({ length: 100 }, (_, i) => i + 1))
    expect(renders).toBe(before + 1)
  })

  it('applies a batch after 50 ms when no animation frame runs, as in a hidden tab', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
    try {
      const { result } = renderHook(() => useRunEvents('run-1'))
      const source = FakeFeed.last
      act(() => source.deliver('run-event', line(1, 'stdout')))
      act(() => vi.advanceTimersByTime(49))
      expect(result.current).toEqual([])
      act(() => vi.advanceTimersByTime(1))
      expect(result.current.map((event) => event.seq)).toEqual([1])
    } finally {
      vi.useRealTimers()
    }
  })

  it('drops a pending batch on unmount', () => {
    const { result, unmount } = renderHook(() => useRunEvents('run-1'))
    act(() => FakeFeed.last.deliver('run-event', line(1, 'stdout')))
    const shown = result.current
    unmount()
    act(() => flushAnimationFrames())
    expect(shown).toEqual([])
  })
})

describe('useRunEvents — lifecycle', () => {
  it('closes the stream on unmount', () => {
    const { unmount } = renderHook(() => useRunEvents('run-1'))
    const source = FakeFeed.last
    expect(source.closeCount).toBe(0)

    unmount()
    expect(source.closeCount).toBe(1)
    expect(source.readyState).toBe(2)
  })

  it('resets the list and resubscribes when the run id changes', () => {
    const { result, rerender } = renderHook(({ id }: { id: string }) => useRunEvents(id), {
      initialProps: { id: 'run-1' },
    })
    const first = FakeFeed.last
    first.emit('ui-event', line(9, 'session.ended', { reason: 'end_turn' }))
    expect(result.current).toHaveLength(1)

    rerender({ id: 'run-2' })

    // Old socket closed, new one at the new endpoint, and run-1's events are gone.
    expect(first.closeCount).toBe(1)
    expect(FakeFeed.last.demand).toMatchObject({ runId: 'run-2' })
    expect(result.current).toEqual([])

    // The high-water mark reset with the list: run-2's own seq 1 must not be "stale".
    FakeFeed.last.emit('run-event', line(1, 'stdout', { text: 'fresh' }))
    expect(result.current.map((event) => event.seq)).toEqual([1])
  })

  it('rehydrates on owner reset and retains the displayed rows while waiting', async () => {
    const onReset = vi.fn(async () => ({ cursor: 'fresh', afterSeq: 5 }))
    const { result } = renderHook(() => useRunEvents('run-1', { onReset }))
    const source = FakeFeed.last
    source.emit('run-event', line(1, 'note'))
    await act(async () => { await source.handlers.reset?.('server restarted', new AbortController().signal) })
    source.emit('run-event', line(5, 'note'))
    source.emit('run-event', line(6, 'note'))
    expect(result.current.map(event => event.seq)).toEqual([1, 6])
    expect(onReset).toHaveBeenCalled()
  })
})
