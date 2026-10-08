import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createLiveOwner, type LivePort, type LiveOwnerDeps } from './live-owner'
import { LIVE_PROTOCOL } from './live-protocol'

class Port implements LivePort {
  onmessage: ((event: { data: unknown }) => void) | null = null
  onmessageerror: (() => void) | null = null
  frames: any[] = []
  postMessage(value: unknown) { this.frames.push(value) }
  start() {}
  close() {}
  sync(documentId: string, entries: unknown[], epoch = 1) { this.onmessage?.({ data: { type: 'sync', version: LIVE_PROTOCOL, documentId, epoch, entries } }) }
}
const workspace = { id: 'workspace', demand: { kind: 'workspace' } }
const run = (afterSeq = 0) => ({ id: 'run', demand: { kind: 'run', projectId: 'boot', runId: 'one', afterSeq } })
let deps: LiveOwnerDeps
let streams: Array<{ kind: string; demand: any; signal: AbortSignal; frame: (frame: any) => void }>
beforeEach(() => {
  vi.useFakeTimers(); streams = []
  deps = {
    stream(kind, demand, frame, signal) { streams.push({ kind, demand, frame, signal }); return new Promise(resolve => signal.addEventListener('abort', () => resolve(), { once: true })) },
    topic: vi.fn(() => () => {}),
    read: vi.fn(async () => ({ value: {} })),
  }
})
afterEach(() => vi.useRealTimers())
describe('shared live ownership', () => {
  it('shares one workspace stream and closes it after the last lease leaves', async () => {
    const owner = createLiveOwner(deps)
    const ports = Array.from({ length: 10 }, () => new Port())
    for (const [index, port] of ports.entries()) { owner.attach(port); port.sync(String(index), [workspace]) }
    await vi.advanceTimersByTimeAsync(0)
    expect(streams.filter(s => !s.signal.aborted)).toHaveLength(1)
    ports[0]!.sync('0', [])
    expect(streams[0]!.signal.aborted).toBe(false)
    for (const [index, port] of ports.entries()) port.sync(String(index), [])
    await vi.advanceTimersByTimeAsync(0)
    expect(streams[0]!.signal.aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
    owner.dispose()
  })
  it('replays from a late subscriber cursor without duplicating the older subscriber', async () => {
    const owner = createLiveOwner(deps)
    const a = new Port(); owner.attach(a); a.sync('a', [run(10)])
    await vi.advanceTimersByTimeAsync(0)
    streams.at(-1)!.frame({ type: 'event', projectId: 'boot', runId: 'one', name: 'run-event', event: { seq: 11, type: 'note', ts: '' } })
    const b = new Port(); owner.attach(b); b.sync('b', [run(2)])
    await vi.advanceTimersByTimeAsync(0)
    expect(streams.filter(s => !s.signal.aborted)).toHaveLength(1)
    expect(streams.at(-1)!.demand[0].afterSeq).toBe(2)
    streams.at(-1)!.frame({ type: 'event', projectId: 'boot', runId: 'one', name: 'run-event', event: { seq: 3, type: 'note', ts: '' } })
    expect(a.frames.filter(f => f.type === 'frame')).toHaveLength(1)
    expect(b.frames.filter(f => f.type === 'frame')).toHaveLength(1)
    owner.dispose()
    expect(vi.getTimerCount()).toBe(0)
  })
  it('expires dead ports within 15 seconds while a renewed port survives', async () => {
    const owner = createLiveOwner(deps)
    const a = new Port(), b = new Port(); owner.attach(a); owner.attach(b)
    a.sync('a', [workspace]); b.sync('b', [workspace])
    await vi.advanceTimersByTimeAsync(10_000)
    b.sync('b', [workspace])
    await vi.advanceTimersByTimeAsync(5_000)
    a.frames = []; b.frames = []
    streams.find(s => !s.signal.aborted)!.frame({ event: 'ping', data: '', id: '' })
    expect(a.frames).toHaveLength(0)
    expect(b.frames).toHaveLength(1)
    owner.dispose()
  })
  it('reopens a silent feed even while worker leases are renewed', async () => {
    const owner = createLiveOwner(deps)
    const port = new Port(); owner.attach(port); port.sync('a', [workspace])
    for (let n = 0; n < 9; n++) { await vi.advanceTimersByTimeAsync(5_000); port.sync('a', [workspace]) }
    expect(streams.length).toBeGreaterThan(1)
    expect(streams[0]!.signal.aborted).toBe(true)
    owner.dispose()
  })
  it('never overwrites a late document hydration with an old periodic read', async () => {
    const owner = createLiveOwner(deps)
    const read = { id: 'read', demand: { kind: 'read', path: '/api/v1/workspace/runs-index', intervalMs: 1000 } }
    const a = new Port(); owner.attach(a); a.sync('a', [read])
    await vi.advanceTimersByTimeAsync(1000)
    expect(a.frames.some(frame => frame.type === 'value')).toBe(true)
    const b = new Port(); owner.attach(b); b.sync('b', [read])
    await vi.advanceTimersByTimeAsync(0)
    expect(b.frames.some(frame => frame.type === 'value')).toBe(false)
    owner.dispose()
  })

  it('notifies a workspace subscriber when its feed reconnects', async () => {
    const owner = createLiveOwner(deps)
    const port = new Port(); owner.attach(port); port.sync('a', [workspace])
    await vi.advanceTimersByTimeAsync(0)
    streams[0]!.frame({ event: 'ping', data: '', id: '' })
    for (let n = 0; n < 9; n++) { await vi.advanceTimersByTimeAsync(5000); port.sync('a', [workspace]) }
    expect(port.frames.some(frame => frame.type === 'frame' && frame.frame.event === 'reconnect')).toBe(true)
    owner.dispose()
  })
  it('delivers the latest topic snapshot to a late subscriber without another socket', async () => {
    let publish!: (value: unknown) => void
    deps.topic = vi.fn((_topic, listener) => { publish = listener; return () => {} })
    const owner = createLiveOwner(deps)
    const topic = { id: 'topic', demand: { kind: 'topic', topic: 'health' } }
    const a = new Port(); owner.attach(a); a.sync('a', [topic]); await vi.advanceTimersByTimeAsync(0)
    publish({ version: 'next' })
    const b = new Port(); owner.attach(b); b.sync('b', [topic]); await vi.advanceTimersByTimeAsync(0)
    expect(deps.topic).toHaveBeenCalledTimes(1)
    expect(b.frames).toContainEqual(expect.objectContaining({ type: 'value', value: { version: 'next' } }))
    owner.dispose()
  })

  it('releases all shared work when the transport rejects authentication', async () => {
    deps.stream = async () => { throw new Error('authentication required') }
    const owner = createLiveOwner(deps)
    const port = new Port(); owner.attach(port); port.sync('a', [workspace])
    await vi.advanceTimersByTimeAsync(0)
    expect(port.frames).toContainEqual(expect.objectContaining({ type: 'unavailable', reason: 'authentication required' }))
    expect(vi.getTimerCount()).toBe(0)
    owner.dispose()
  })

  it('keeps the replacement read deadline when an invalidation aborts its predecessor', async () => {
    const signals: AbortSignal[] = []
    deps.read = (_path, signal) => {
      signals.push(signal)
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
    }
    const owner = createLiveOwner(deps)
    const port = new Port(); owner.attach(port)
    const read = { id: 'read', demand: { kind: 'read', path: '/api/v1/workspace/runs-index', intervalMs: 1000 } }
    port.sync('a', [read])
    await vi.advanceTimersByTimeAsync(1000)
    port.onmessage?.({ data: { version: LIVE_PROTOCOL, type: 'refresh', documentId: 'a', epoch: 1, id: 'read' } })
    await vi.advanceTimersByTimeAsync(0)
    expect(signals).toHaveLength(2)
    expect(signals[0]!.aborted).toBe(true)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(signals[1]!.aborted).toBe(true)
    owner.dispose()
  })

})
