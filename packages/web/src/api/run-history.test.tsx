import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { RunHistoryContext, RunHistoryPage } from '@open-mercato/cezar-api-client'
import { flushAnimationFrames, installAnimationFrameQueue } from '../test/animation-frames'
import { getRunHistory, getRunHistoryContext } from './client'
import { useRunHistory } from './run-history'

vi.mock('./client', () => ({
  getRunHistory: vi.fn(),
  getRunHistoryContext: vi.fn(),
}))

const mockHistory = vi.mocked(getRunHistory)
const mockContext = vi.mocked(getRunHistoryContext)

class FakeEventSource {
  static instances: FakeEventSource[] = []
  private readonly listeners = new Map<string, Set<(event: Event) => void>>()
  readyState = 0

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this)
  }

  addEventListener(name: string, listener: (event: Event) => void): void {
    const listeners = this.listeners.get(name) ?? new Set()
    listeners.add(listener)
    this.listeners.set(name, listeners)
  }

  close(): void {
    this.readyState = 2
  }

  /** One frame, then the animation frame that applies it (#881). Call inside `act`. */
  emit(name: string, data: string): void {
    this.deliver(name, data)
    flushAnimationFrames()
  }

  /** One frame with no animation frame after it. */
  deliver(name: string, data: string): void {
    for (const listener of this.listeners.get(name) ?? []) listener(new MessageEvent(name, { data }))
  }
}

const page = (
  seq: number,
  extras: Partial<RunHistoryPage> = {},
): RunHistoryPage => ({
  events: [{ seq, ts: '2026-07-30T00:00:00.000Z', type: 'note', message: `event-${seq}` }],
  itemCount: 1,
  liveCursor: `live-${seq}`,
  asOfSeq: seq,
  hasOlder: false,
  ...extras,
})

const context = (seq = 90): RunHistoryContext => ({
  contextEvents: [{
    seq,
    ts: '2026-07-30T00:00:00.000Z',
    type: 'plan.updated',
    entries: [{ content: 'current plan', status: 'in_progress' }],
  }],
  asOfSeq: 100,
})

function harness() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  return { client, wrapper }
}

beforeEach(() => {
  vi.clearAllMocks()
  // jsdom deliberately has no native EventSource; the stream hook degrades to no live frames.
  Reflect.deleteProperty(globalThis, 'EventSource')
  installAnimationFrameQueue()
})

const note = (seq: number) =>
  JSON.stringify({ seq, ts: '2026-07-30T00:00:00.000Z', type: 'note', message: `event-${seq}` })

const tail = (from: number, to: number): RunHistoryPage => ({
  ...page(to),
  events: Array.from({ length: to - from + 1 }, (_, index) => JSON.parse(note(from + index))),
  itemCount: Math.min(100, to - from + 1),
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => { resolve = settle })
  return { promise, resolve }
}

describe('useRunHistory', () => {
  it('hydrates the visible tail and current context independently, then prepends one older page', async () => {
    mockHistory.mockImplementation(async (_id, cursor) =>
      cursor === 'older-100'
        ? page(1)
        : page(100, { olderCursor: 'older-100', hasOlder: true }),
    )
    mockContext.mockResolvedValue(context())
    const { wrapper } = harness()
    const { result } = renderHook(() => useRunHistory('run-1'), { wrapper })

    await waitFor(() => expect(result.current.isPending).toBe(false))
    expect(result.current.visibleEvents.map(({ seq }) => seq)).toEqual([100])
    expect(result.current.currentEvents.map(({ seq }) => seq)).toEqual([90])
    expect(result.current.hasOlder).toBe(true)

    await act(() => result.current.loadOlder())
    await waitFor(() => expect(result.current.visibleEvents.map(({ seq }) => seq)).toEqual([1, 100]))
    expect(mockHistory).toHaveBeenLastCalledWith('run-1', 'older-100', expect.any(Object))
    expect(result.current.retainedPages).toBe(2)
  })

  it('falls back to the protected full replay when either optimized request cannot load', async () => {
    mockHistory.mockRejectedValue(new Error('old server'))
    mockContext.mockResolvedValue(context())
    const { wrapper } = harness()
    const { result } = renderHook(() => useRunHistory('run-1'), { wrapper })

    await waitFor(() => expect(result.current.fallback).toBe(true), { timeout: 3_000 })
    expect(result.current.isPending).toBe(false)
    expect(result.current.hasOlder).toBe(false)
  })

  it.each(['history', 'context'] as const)('fallback jump preserves full replay and its live SSE when %s is unavailable', async unavailable => {
    FakeEventSource.instances = []
    vi.stubGlobal('EventSource', FakeEventSource)
    if (unavailable === 'history') {
      mockHistory.mockRejectedValue(new Error('optimized history unavailable'))
      mockContext.mockResolvedValue(context())
    } else {
      mockHistory.mockResolvedValue(page(100))
      mockContext.mockRejectedValue(new Error('optimized context unavailable'))
    }
    const { client, wrapper } = harness()
    let observe = false
    const transitions: Array<{ pending: boolean; seqs: number[] }> = []
    const { result, unmount } = renderHook(() => {
      const state = useRunHistory('fallback-jump')
      if (observe) transitions.push({ pending: state.isPending, seqs: state.visibleEvents.map(event => event.seq) })
      return state
    }, { wrapper })
    try {
      await waitFor(() => expect(result.current.fallback).toBe(true), { timeout: 3_000 })
      const source = FakeEventSource.instances.at(-1)!
      await act(() => source.emit('run-event', JSON.stringify(page(1).events[0])))
      expect(result.current.visibleEvents.map(event => event.seq)).toEqual([1])
      const requestCount = mockHistory.mock.calls.length
      const streamCount = FakeEventSource.instances.length
      observe = true
      await act(() => result.current.jumpToLatest())
      expect(mockHistory).toHaveBeenCalledTimes(requestCount)
      expect(FakeEventSource.instances).toHaveLength(streamCount)
      expect(source.readyState).not.toBe(2)
      expect(transitions.every(state => !state.pending && state.seqs[0] === 1)).toBe(true)
      expect(result.current.currentEvents.map(event => event.seq)).toEqual([1])
      await act(() => source.emit('run-event', JSON.stringify(page(2).events[0])))
      expect(result.current.visibleEvents.map(event => event.seq)).toEqual([1, 2])
      expect(result.current.currentEvents.map(event => event.seq)).toEqual([1, 2])
    } finally {
      unmount(); client.clear(); vi.unstubAllGlobals()
    }
  })

  it('re-entry refreshes the newest page before the stream opens, showing the cached page meanwhile', async () => {
    FakeEventSource.instances = []
    vi.stubGlobal('EventSource', FakeEventSource)
    const refreshed = deferred<RunHistoryPage>()
    const answers: Array<() => Promise<RunHistoryPage>> = [
      async () => page(100), // first entry
      async () => tail(100, 105), // fold on exit
      () => refreshed.promise, // refresh on re-entry
    ]
    mockHistory.mockImplementation(() => answers.shift()!())
    mockContext.mockResolvedValue(context())
    const { client, wrapper } = harness()
    try {
      const first = renderHook(() => useRunHistory('run-1'), { wrapper })
      await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1))
      act(() => {
        for (let seq = 101; seq <= 105; seq += 1) FakeEventSource.instances[0]!.emit('run-event', note(seq))
      })
      expect(first.result.current.visibleEvents.at(-1)?.seq).toBe(105)
      first.unmount()
      await waitFor(() => expect(mockHistory).toHaveBeenCalledTimes(2))

      const transitions: Array<{ pending: boolean; seqs: number[] }> = []
      const second = renderHook(() => {
        const state = useRunHistory('run-1')
        transitions.push({ pending: state.isPending, seqs: state.visibleEvents.map(({ seq }) => seq) })
        return state
      }, { wrapper })
      await waitFor(() => expect(mockHistory).toHaveBeenCalledTimes(3))
      // The previous visit's frames are already in the cached page, and no stream opened yet.
      expect(second.result.current.visibleEvents.at(-1)?.seq).toBe(105)
      expect(FakeEventSource.instances).toHaveLength(1)

      await act(async () => refreshed.resolve(tail(101, 150)))
      await waitFor(() => expect(FakeEventSource.instances).toHaveLength(2))
      const stream = new URL(FakeEventSource.instances[1]!.url, 'http://localhost')
      expect(stream.searchParams.get('afterSeq')).toBe('150')
      expect(stream.searchParams.get('cursor')).toBe('live-150')
      expect(second.result.current.visibleEvents.at(-1)?.seq).toBe(150)
      // No flash: every render of the re-entry had the transcript and was never pending.
      expect(transitions.every(({ pending, seqs }) => !pending && seqs.includes(105))).toBe(true)
      second.unmount()
    } finally {
      client.clear()
      vi.unstubAllGlobals()
    }
  })

  it('a failed refresh on re-entry opens the stream from the cached page', async () => {
    FakeEventSource.instances = []
    vi.stubGlobal('EventSource', FakeEventSource)
    mockHistory.mockResolvedValueOnce(page(100)).mockRejectedValue(new Error('offline'))
    mockContext.mockResolvedValue(context())
    const { client, wrapper } = harness()
    try {
      const first = renderHook(() => useRunHistory('run-1'), { wrapper })
      await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1))
      first.unmount()

      const second = renderHook(() => useRunHistory('run-1'), { wrapper })
      await waitFor(() => expect(FakeEventSource.instances).toHaveLength(2))
      expect(new URL(FakeEventSource.instances[1]!.url, 'http://localhost').searchParams.get('afterSeq')).toBe('100')
      expect(second.result.current.fallback).toBe(false)
      expect(second.result.current.visibleEvents.map(({ seq }) => seq)).toEqual([100])
      second.unmount()
    } finally {
      client.clear()
      vi.unstubAllGlobals()
    }
  })

  it('keeps a late refresh from replacing a newer cached page', async () => {
    FakeEventSource.instances = []
    vi.stubGlobal('EventSource', FakeEventSource)
    const late = deferred<RunHistoryPage>()
    const answers: Array<() => Promise<RunHistoryPage>> = [async () => page(100), () => late.promise]
    mockHistory.mockImplementation(() => answers.shift()!())
    mockContext.mockResolvedValue(context())
    const { client, wrapper } = harness()
    try {
      const first = renderHook(() => useRunHistory('run-1'), { wrapper })
      await waitFor(() => expect(first.result.current.isPending).toBe(false))
      first.unmount()
      const second = renderHook(() => useRunHistory('run-1'), { wrapper })
      await waitFor(() => expect(mockHistory).toHaveBeenCalledTimes(2))
      // Something newer (jump-to-latest, a compaction) wrote the cache while the refresh was out.
      act(() => client.setQueryData(['run-history', 'default', 'run-1'], { pages: [page(200)], pageParams: [undefined] }))
      await act(async () => late.resolve(page(150)))
      await waitFor(() => expect(FakeEventSource.instances).toHaveLength(2))
      expect(second.result.current.visibleEvents.map(({ seq }) => seq)).toEqual([200])
      expect(new URL(FakeEventSource.instances[1]!.url, 'http://localhost').searchParams.get('afterSeq')).toBe('200')
      second.unmount()
    } finally {
      client.clear()
      vi.unstubAllGlobals()
    }
  })

  it('renders the thread at most 20 times for 1,000 replayed frames', async () => {
    FakeEventSource.instances = []
    vi.stubGlobal('EventSource', FakeEventSource)
    // Compaction at 200 frames stays in flight, so one socket carries the whole replay.
    mockHistory.mockResolvedValueOnce(page(0)).mockReturnValue(new Promise(() => {}))
    mockContext.mockResolvedValue(context())
    const { client, wrapper } = harness()
    let renders = 0
    const { result, unmount } = renderHook(() => {
      renders += 1
      return useRunHistory('run-1')
    }, { wrapper })
    try {
      await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1))
      await waitFor(() => expect(result.current.contextPending).toBe(false))
      const source = FakeEventSource.instances[0]!
      renders = 0
      // Every SSE message is its own task; ten animation frames pass during the replay.
      for (let seq = 1; seq <= 1_000; seq += 1) {
        act(() => source.deliver('run-event', note(seq)))
        if (seq % 100 === 0) act(() => flushAnimationFrames())
      }
      expect(result.current.visibleEvents.at(-1)?.seq).toBe(1_000)
      expect(renders).toBeLessThanOrEqual(20)
    } finally {
      unmount()
      client.clear()
      vi.unstubAllGlobals()
    }
  })

  it('jump-to-latest clears retained older pages and refetches the cursorless tail', async () => {
    mockHistory.mockImplementation(async (_id, cursor) =>
      cursor === 'older-100'
        ? page(1)
        : page(100, { olderCursor: 'older-100', hasOlder: true }),
    )
    mockContext.mockResolvedValue(context())
    const { wrapper } = harness()
    const { result } = renderHook(() => useRunHistory('run-1'), { wrapper })
    await waitFor(() => expect(result.current.hasOlder).toBe(true))
    await act(() => result.current.loadOlder())
    await waitFor(() => expect(result.current.retainedPages).toBe(2))

    await act(() => result.current.jumpToLatest())
    await waitFor(() => expect(result.current.retainedPages).toBe(1))
    expect(mockHistory).toHaveBeenLastCalledWith('run-1', undefined, expect.any(Object))
  })

  it('compacts a long live prefix into a fresh persisted tail page', async () => {
    FakeEventSource.instances = []
    vi.stubGlobal('EventSource', FakeEventSource)
    const compactedTail: RunHistoryPage = {
      ...page(300),
      events: Array.from({ length: 100 }, (_, index) => ({
        seq: 201 + index,
        ts: '2026-07-30T00:00:00.000Z',
        type: 'note',
        message: `event-${201 + index}`,
      })),
      itemCount: 100,
    }
    mockHistory
      .mockResolvedValueOnce(page(100))
      .mockResolvedValue(compactedTail)
    mockContext.mockResolvedValue(context())
    const { wrapper } = harness()
    const { result } = renderHook(() => useRunHistory('run-1'), { wrapper })
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1))

    act(() => {
      for (let seq = 101; seq <= 300; seq += 1) {
        FakeEventSource.instances[0]!.emit(
          'run-event',
          JSON.stringify({
            seq,
            ts: '2026-07-30T00:00:00.000Z',
            type: 'note',
            message: `event-${seq}`,
          }),
        )
      }
    })

    await waitFor(() => expect(mockHistory).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(result.current.visibleEvents.at(-1)?.seq).toBe(300))
    expect(result.current.visibleEvents).toHaveLength(100)
    expect(result.current.visibleEvents[0]?.seq).toBe(201)
    expect(result.current.retainedPages).toBe(1)
    expect(FakeEventSource.instances.length).toBeGreaterThanOrEqual(2)
    vi.unstubAllGlobals()
  })

  /**
   * The compaction call is fire-and-forget, so it has no query to carry a rejection (#827).
   * Since the client now REJECTS a malformed history page instead of casting it, this path can
   * be reached by a bad body as well as by a transport error — and must stay a silent no-op
   * rather than an unhandled rejection that fails the surrounding render.
   */
  it('survives a failed compaction: the live transcript stands and the guard reopens', async () => {
    FakeEventSource.instances = []
    vi.stubGlobal('EventSource', FakeEventSource)
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    mockHistory
      .mockResolvedValueOnce(page(100))
      .mockRejectedValue(new Error('the cezar server answered /runs/run-1/history with an unexpected body'))
    mockContext.mockResolvedValue(context())
    const { wrapper } = harness()
    const { result } = renderHook(() => useRunHistory('run-1'), { wrapper })
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1))

    act(() => {
      for (let seq = 101; seq <= 300; seq += 1) {
        FakeEventSource.instances[0]!.emit(
          'run-event',
          JSON.stringify({ seq, ts: '2026-07-30T00:00:00.000Z', type: 'note', message: `event-${seq}` }),
        )
      }
    })

    await waitFor(() => expect(mockHistory).toHaveBeenCalledTimes(2))
    // Nothing was compacted, so the events the SSE already delivered are still what renders.
    expect(result.current.visibleEvents.at(-1)?.seq).toBe(300)
    // A failed compaction is not a load failure: the transcript must NOT drop to full replay.
    expect(result.current.fallback).toBe(false)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(unhandled).not.toHaveBeenCalled()

    process.off('unhandledRejection', unhandled)
    vi.unstubAllGlobals()
  })
})
