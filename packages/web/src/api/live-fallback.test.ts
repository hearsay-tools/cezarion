import { afterEach, describe, expect, it, vi } from 'vitest'
import { createLiveFallback, type FallbackEntry } from './live-fallback'

const run = (): FallbackEntry => ({ id: 'one', demand: { kind: 'run', projectId: 'boot', runId: 'one', afterSeq: 0 }, frame: vi.fn(), value: vi.fn(), reset: vi.fn(async () => {}) })
afterEach(() => vi.useRealTimers())
describe('finite HTTP recovery', () => {
  it('drains accepted prefixes without losing events and stops all work on release', async () => {
    vi.useFakeTimers()
    const entry = run()
    let call = 0
    const fetcher = vi.fn(async () => {
      const seq = ++call
      return new Response(JSON.stringify({ generation: 'one', results: [{ type: 'batch', projectId: 'boot', runId: 'one', afterSeq: seq, cursor: `cursor-${seq}`, hasMore: seq === 1, events: [{ seq, type: 'note', ts: '' }] }] }))
    })
    const recovery = createLiveFallback(() => [entry], async () => {}, fetcher)
    recovery.start()
    await vi.advanceTimersByTimeAsync(100)
    expect(entry.frame).toHaveBeenCalledTimes(2)
    const body = JSON.parse((fetcher.mock.calls[1] as any)[1].body)
    expect(body.runs[0]).toMatchObject({ afterSeq: 1, cursor: 'cursor-1' })
    recovery.stop()
    expect(vi.getTimerCount()).toBe(0)
  })
  it('never overlaps cycles, and aborts a pending request when hidden', async () => {
    vi.useFakeTimers()
    let signal: AbortSignal | undefined
    const fetcher = vi.fn((_path: RequestInfo | URL, init?: RequestInit) => {
      signal = init?.signal ?? undefined
      return new Promise<Response>((_resolve, reject) => signal?.addEventListener('abort', () => reject(signal?.reason)))
    })
    const recovery = createLiveFallback(() => [run()], async () => {}, fetcher)
    recovery.start(); recovery.refresh(); recovery.refresh()
    await vi.advanceTimersByTimeAsync(9_000)
    expect(fetcher).toHaveBeenCalledTimes(1)
    recovery.stop()
    expect(signal?.aborted).toBe(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('passes cancellation to workspace recovery and stops its in-flight work', async () => {
    vi.useFakeTimers()
    let signal: AbortSignal | undefined
    const reconcile = vi.fn((current: AbortSignal) => {
      signal = current
      return new Promise<void>(resolve => current.addEventListener('abort', () => resolve(), { once: true }))
    })
    const recovery = createLiveFallback(() => [{ ...run(), demand: { kind: 'workspace' } }], reconcile)
    recovery.start()
    expect(signal).toBeInstanceOf(AbortSignal)
    recovery.stop()
    expect(signal?.aborted).toBe(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  /** A server that never answers: the request ends only when its signal aborts. */
  const hung = () => vi.fn((_path: RequestInfo | URL, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))))
  const reader = (): FallbackEntry => ({ ...run(), demand: { kind: 'read', path: '/api/v1/workspace/activity?project=shop', intervalMs: 5_000 } })

  it('hands a read the server never answers to its consumers as HTTP 0 at the deadline', async () => {
    vi.useFakeTimers()
    const entry = reader()
    const fetcher = hung()
    const recovery = createLiveFallback(() => [entry], async () => {}, fetcher)
    recovery.start()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(entry.value).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(entry.value).toHaveBeenCalledExactlyOnceWith(undefined, 'HTTP 0')
    recovery.stop()
  })

  it('delivers nothing for a read that a stop aborts', async () => {
    vi.useFakeTimers()
    const entry = reader()
    const fetcher = hung()
    const recovery = createLiveFallback(() => [entry], async () => {}, fetcher)
    recovery.start()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(fetcher).toHaveBeenCalledTimes(1)
    recovery.stop()
    await vi.advanceTimersByTimeAsync(15_000)
    expect(entry.value).not.toHaveBeenCalled()
  })

  it('still fetches run batches on a restart after a later batch throws once hasMore was seen', async () => {
    vi.useFakeTimers()
    const entries = Array.from({ length: 33 }, (_, i) => ({
      id: String(i),
      demand: { kind: 'run' as const, projectId: 'boot', runId: String(i), afterSeq: 0 },
      frame: vi.fn(), value: vi.fn(), reset: vi.fn(async () => {}),
    }))
    let n = 0
    const fetcher = vi.fn(async () => {
      n += 1
      if (n === 1) {
        return new Response(JSON.stringify({
          generation: 'g',
          results: [{ type: 'batch', projectId: 'boot', runId: '0', afterSeq: 1, cursor: 'c', hasMore: true, events: [] }],
        }))
      }
      if (n === 2) return new Response('nope', { status: 500 })
      return new Response(JSON.stringify({
        generation: 'g',
        results: [{ type: 'batch', projectId: 'boot', runId: '0', afterSeq: 2, cursor: 'c', hasMore: false, events: [] }],
      }))
    })
    const recovery = createLiveFallback(() => entries, async () => {}, fetcher)
    recovery.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(fetcher).toHaveBeenCalledTimes(2)
    recovery.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(fetcher.mock.calls.length).toBeGreaterThan(2)
    recovery.stop()
  })

  it('hands a failed read to its consumers with the status and the answer, then backs off', async () => {
    vi.useFakeTimers()
    const entry: FallbackEntry = { ...run(), demand: { kind: 'read', path: '/api/v1/workspace/activity?project=shop', intervalMs: 5_000 } }
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ error: 'unknown project: shop' }), { status: 404 }))
    const recovery = createLiveFallback(() => [entry], async () => {}, fetcher)
    recovery.start()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(entry.value).toHaveBeenCalledExactlyOnceWith({ error: 'unknown project: shop' }, 'HTTP 404')
    await vi.advanceTimersByTimeAsync(1_000) // the first back-off step is 2 s, not the 5 s cadence
    expect(fetcher).toHaveBeenCalledTimes(1)
    recovery.stop()
  })

})
