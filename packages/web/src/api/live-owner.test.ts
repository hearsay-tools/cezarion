import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createLiveOwner, type LivePort, type LiveOwnerDeps } from './live-owner'
import { LIVE_PROTOCOL } from './live-protocol'
import { createWorkspaceSeqFence } from './events'

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
  it('keeps a ten-minute read alive after two of three documents leave without polling early', async () => {
    const owner = createLiveOwner(deps)
    const ports = [new Port(), new Port(), new Port()]
    const read = { id: 'status', demand: { kind: 'read', path: '/api/v1/p/boot/github/ref-status?issues=1', intervalMs: 600_000 } }
    for (const [i, port] of ports.entries()) { owner.attach(port); port.sync(String(i), [read]) }
    const renewal = setInterval(() => ports[0]!.sync('0', [read]), 5_000)
    try {
      await vi.advanceTimersByTimeAsync(10_000)
      ports[1]!.sync('1', []); ports[2]!.sync('2', [])
      await vi.advanceTimersByTimeAsync(589_999)
      expect(deps.read).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      expect(deps.read).toHaveBeenCalledTimes(1)
      expect(ports[0]!.frames).toContainEqual(expect.objectContaining({ type: 'value', id: 'status' }))
      expect(ports[1]!.frames.some(frame => frame.type === 'value')).toBe(false)
      expect(ports[2]!.frames.some(frame => frame.type === 'value')).toBe(false)
    } finally { clearInterval(renewal); owner.dispose() }
    expect(vi.getTimerCount()).toBe(0)
  })

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
  it('tells workspace subscribers at once when an attached feed ends, before its retry (hearsay-tools/cezarion#1069)', async () => {
    let end!: () => void
    deps.stream = (kind, demand, frame, signal) => {
      streams.push({ kind, demand, frame, signal })
      return new Promise(resolve => { end = resolve; signal.addEventListener('abort', () => resolve(), { once: true }) })
    }
    const owner = createLiveOwner(deps)
    const port = new Port(); owner.attach(port); port.sync('a', [workspace])
    await vi.advanceTimersByTimeAsync(0)
    streams[0]!.frame({ event: 'ping', data: '', id: '' })
    const events = (p: Port) => p.frames.filter(frame => frame.type === 'frame').map(frame => frame.frame.event)
    end()
    await vi.advanceTimersByTimeAsync(0)
    expect(events(port)).toEqual(['ping', 'disconnect'])
    // A document arriving during the retry gap gets no synthetic ready ping.
    const late = new Port(); owner.attach(late); late.sync('b', [workspace])
    await vi.advanceTimersByTimeAsync(0)
    expect(events(late)).toEqual([])
    await vi.advanceTimersByTimeAsync(1_500)
    expect(streams).toHaveLength(2)
    expect(events(port)).toEqual(['ping', 'disconnect', 'reconnect'])
    expect(events(late)).toEqual(['reconnect'])
    owner.dispose()
  })

  describe('workspace generation for late subscribers (hearsay-tools/cezarion#2729)', () => {
    const frames = (p: Port) => p.frames.filter(frame => frame.type === 'frame').map(frame => frame.frame.data ? `${frame.frame.event} ${frame.frame.data}` : frame.frame.event)
    const ready = (generation: string, seq: number) => ({ event: 'ready', data: JSON.stringify({ generation, seq }), id: '' })
    const summary = (seq: number) => ({ event: 'run-summary', data: JSON.stringify({ project: 'boot', seq, run: { id: 'r' }, relationships: 'd' }), id: '' })

    it('sends a late subscriber a ready with the generation and the last delivered seq, then the barrier ping', async () => {
      const owner = createLiveOwner(deps)
      const first = new Port(); owner.attach(first); first.sync('a', [workspace])
      await vi.advanceTimersByTimeAsync(0)
      streams[0]!.frame(ready('g1', 10))
      streams[0]!.frame({ event: 'ping', data: '', id: '' })
      streams[0]!.frame(summary(11)); streams[0]!.frame(summary(12))
      const late = new Port(); owner.attach(late); late.sync('b', [workspace])
      await vi.advanceTimersByTimeAsync(0)
      expect(frames(late)).toEqual([`ready ${JSON.stringify({ generation: 'g1', seq: 12 })}`, 'ping'])
      streams[0]!.frame(summary(13))
      expect(frames(late).at(-1)).toContain('"seq":13')
      // The first subscriber saw the stream's own ready and no synthetic one.
      expect(frames(first).filter(frame => frame.startsWith('ready'))).toEqual([`ready ${JSON.stringify({ generation: 'g1', seq: 10 })}`])
      owner.dispose()
    })

    it('a document that rejoins after a server restart learns the new generation before any frame', async () => {
      const owner = createLiveOwner(deps)
      const port = new Port(); owner.attach(port); port.sync('a', [workspace])
      await vi.advanceTimersByTimeAsync(0)
      streams[0]!.frame(ready('g1', 10))
      streams[0]!.frame({ event: 'ping', data: '', id: '' })
      // The server restarted: the held entry is reset and the new ready reaches nobody.
      streams[0]!.frame(ready('g2', 0))
      expect(port.frames.some(frame => frame.type === 'reset')).toBe(true)
      streams[0]!.frame(summary(1))
      // The document recovers (it was hidden, or it rejoins after the reset) with a new epoch.
      const before = port.frames.length
      port.sync('a', [workspace], 2)
      await vi.advanceTimersByTimeAsync(0)
      const rejoined = port.frames.slice(before).filter(frame => frame.type === 'frame').map(frame => frame.frame)
      expect(rejoined[0]).toEqual(ready('g2', 1))
      expect(rejoined[1]).toMatchObject({ event: 'ping' })
      owner.dispose()
    })

    it('a demand change (new epoch) in the same generation sends no ready, so a frame dropped under the old epoch still shows as a gap', async () => {
      const owner = createLiveOwner(deps)
      const port = new Port(); owner.attach(port); port.sync('a', [workspace], 1)
      await vi.advanceTimersByTimeAsync(0)
      streams[0]!.frame(ready('g1', 10))
      streams[0]!.frame({ event: 'ping', data: '', id: '' })
      // The document has already moved to epoch 2 (a demand change), so it drops seq 11.
      streams[0]!.frame(summary(11))
      port.sync('a', [workspace, run()], 2)
      await vi.advanceTimersByTimeAsync(0)
      streams[0]!.frame(summary(12))
      // The document's own fence over the frames it accepts. It moved to epoch 2 just before seq 11
      // arrived, so from then on it drops every epoch-1 message.
      const fence = createWorkspaceSeqFence()
      const gaps: boolean[] = []
      let documentEpoch = 1
      for (const message of port.frames) {
        if (message.type !== 'frame' || !message.frame.data) continue
        const data = JSON.parse(message.frame.data) as { seq: number }
        if (message.frame.event === 'run-summary' && data.seq === 11) documentEpoch = 2
        if (message.epoch !== documentEpoch) continue
        if (message.frame.event === 'ready') fence.ready(data.seq)
        else gaps.push(fence.frame(data.seq))
      }
      expect(gaps).toEqual([true])
      owner.dispose()
    })

    it('a sync that asks for the workspace ready gets ready(generation, current seq), without restarting the stream', async () => {
      const owner = createLiveOwner(deps)
      const port = new Port(); owner.attach(port); port.sync('a', [workspace], 1)
      await vi.advanceTimersByTimeAsync(0)
      streams[0]!.frame(ready('g1', 10))
      streams[0]!.frame({ event: 'ping', data: '', id: '' })
      streams[0]!.frame(summary(11))
      // The document lost that ready to an epoch change and asks for it again.
      port.onmessage?.({ data: { type: 'sync', version: LIVE_PROTOCOL, documentId: 'a', epoch: 2, entries: [workspace], workspaceReady: true } })
      await vi.advanceTimersByTimeAsync(0)
      const after = port.frames.filter(message => message.type === 'frame' && message.epoch === 2).map(message => message.frame)
      expect(after[0]).toEqual(ready('g1', 11))
      expect(after[1]).toMatchObject({ event: 'ping' })
      expect(streams).toHaveLength(1)
      expect(streams[0]!.signal.aborted).toBe(false)
      // A sync without the request, in the same generation, sends no ready.
      port.sync('a', [workspace], 3)
      await vi.advanceTimersByTimeAsync(0)
      expect(port.frames.filter(message => message.type === 'frame' && message.epoch === 3 && message.frame.event === 'ready')).toEqual([])
      owner.dispose()
    })

    it('a document that joins before the barrier gets the ready at once and contiguous frames after it', async () => {
      const owner = createLiveOwner(deps)
      const port = new Port(); owner.attach(port); port.sync('a', [workspace])
      await vi.advanceTimersByTimeAsync(0)
      // Joined before the barrier (no ping yet): the ready comes at once, the ping with the stream.
      streams[0]!.frame(ready('g1', 4))
      const late = new Port(); owner.attach(late); late.sync('b', [workspace])
      await vi.advanceTimersByTimeAsync(0)
      expect(frames(late)).toEqual([`ready ${JSON.stringify({ generation: 'g1', seq: 4 })}`])
      streams[0]!.frame(summary(5))
      expect(frames(late)).toEqual([`ready ${JSON.stringify({ generation: 'g1', seq: 4 })}`, expect.stringContaining('"seq":5')])
      owner.dispose()
    })
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
