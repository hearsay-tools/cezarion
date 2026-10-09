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

})
