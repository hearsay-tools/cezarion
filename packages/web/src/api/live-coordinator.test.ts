import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createLiveCoordinator, onLiveReconcile } from './live-coordinator'
import { LIVE_PROTOCOL } from './live-protocol'

class Worker {
  static all: Worker[] = []
  port = {
    onmessage: null as ((event: { data: unknown }) => void) | null,
    onmessageerror: null as (() => void) | null,
    postMessage: vi.fn(), start: vi.fn(), close: vi.fn(),
  }
  addEventListener = vi.fn()
  constructor() { Worker.all.push(this) }
  reply(data: unknown) { this.port.onmessage?.({ data }) }
}
let coordinator: ReturnType<typeof createLiveCoordinator>
beforeEach(() => {
  vi.useFakeTimers(); Worker.all = []
  vi.stubGlobal('SharedWorker', Worker)
  vi.stubGlobal('fetch', vi.fn(async path => new Response(JSON.stringify(String(path).endsWith('/health') ? { bootProject: 'boot', capabilities: { localHandoff: true, followups: true, singleProject: false, automations: false, preview: false, tokenMetrics: true, tokenUsageMetrics: true, costMetrics: true } } : { generation: 'one', results: [] }))))
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
  coordinator = createLiveCoordinator()
})
afterEach(() => { coordinator.dispose(); vi.useRealTimers(); vi.unstubAllGlobals() })
const local = { local: true, bootProject: 'boot', apiBase: '' }

describe('document live demand', () => {
  it('waits for authenticated bootstrap and suspends hidden/pagehide work', async () => {
    const release = coordinator.subscribe({ kind: 'workspace' }, {})
    expect(Worker.all).toHaveLength(0)
    coordinator.configure(local)
    expect(Worker.all).toHaveLength(1)
    const worker = Worker.all[0]!
    window.dispatchEvent(new Event('pagehide'))
    expect(worker.port.close).toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }))
    await vi.advanceTimersByTimeAsync(0)
    expect(Worker.all).toHaveLength(2)
    release()
    expect(vi.getTimerCount()).toBe(0)
  })
  it('does not open a transport for an initially hidden document', () => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
    coordinator.configure(local)
    coordinator.subscribe({ kind: 'workspace' }, {})
    expect(Worker.all).toHaveLength(0)
    expect(fetch).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
  it('moves a silent worker to finite HTTP within 15 seconds', async () => {
    coordinator.configure(local)
    coordinator.subscribe({ kind: 'run', projectId: 'default', runId: 'run', afterSeq: 0 }, {})
    await vi.advanceTimersByTimeAsync(15_000)
    expect(Worker.all[0]!.port.close).toHaveBeenCalled()
    expect(fetch).toHaveBeenCalledWith('/api/v1/workspace/run-event-batches', expect.objectContaining({ credentials: 'include', method: 'POST' }))
  })
  it('opens no SharedWorker, EventSource, or ordinary socket in remote mode', async () => {
    const eventSource = vi.fn(), socket = vi.fn()
    vi.stubGlobal('EventSource', eventSource); vi.stubGlobal('WebSocket', socket)
    coordinator.configure({ ...local, local: false })
    coordinator.subscribe({ kind: 'workspace' }, {})
    coordinator.subscribe({ kind: 'topic', topic: 'health' }, {})
    coordinator.subscribe({ kind: 'run', projectId: 'boot', runId: 'run', afterSeq: 0 }, {})
    await vi.advanceTimersByTimeAsync(2_000)
    expect(Worker.all).toHaveLength(0); expect(eventSource).not.toHaveBeenCalled(); expect(socket).not.toHaveBeenCalled()
    expect(fetch).toHaveBeenCalled()
  })
  it('filters stale epochs and other project transcripts before acknowledgement', () => {
    const frame = vi.fn()
    coordinator.configure(local)
    coordinator.subscribe({ kind: 'run', projectId: 'default', runId: 'same', afterSeq: 3 }, { frame })
    const worker = Worker.all[0]!
    const sync = worker.port.postMessage.mock.calls.at(-1)![0] as any
    const message = { version: LIVE_PROTOCOL, type: 'frame', epoch: sync.epoch, id: sync.entries[0].id,
      frame: { type: 'event', projectId: 'other', runId: 'same', name: 'run-event', event: { type: 'note', seq: 4, ts: '' } } }
    worker.reply(message)
    worker.reply({ ...message, epoch: sync.epoch - 1, frame: { ...message.frame, projectId: 'boot' } })
    expect(frame).not.toHaveBeenCalled()
    worker.reply({ ...message, frame: { ...message.frame, projectId: 'boot' } })
    expect(frame).toHaveBeenCalledTimes(1)
    expect(worker.port.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'ack', seq: 4 }))
  })
})

describe('worker recovery boundaries', () => {
  it('rejects incompatible worker protocols and catches up by authenticated finite HTTP', async () => {
    coordinator.configure(local)
    coordinator.subscribe({ kind: 'run', projectId: 'boot', runId: 'run', afterSeq: 0 }, {})
    Worker.all[0]!.reply({ type: 'hello', version: LIVE_PROTOCOL + 1 })
    await vi.advanceTimersByTimeAsync(0)
    expect(Worker.all[0]!.port.close).toHaveBeenCalled()
    expect(fetch).toHaveBeenCalledWith('/api/v1/workspace/run-event-batches', expect.objectContaining({ credentials: 'include' }))
  })
  it('clears shared delivery and uses document authentication after an authorization failure', async () => {
    const frame = vi.fn()
    coordinator.configure(local)
    coordinator.subscribe({ kind: 'run', projectId: 'boot', runId: 'run', afterSeq: 0 }, { frame })
    const worker = Worker.all[0]!
    const { epoch } = worker.port.postMessage.mock.calls.at(-1)![0] as any
    worker.reply({ type: 'unavailable', version: LIVE_PROTOCOL, epoch, reason: 'authentication required' })
    await vi.advanceTimersByTimeAsync(0)
    expect(worker.port.close).toHaveBeenCalled()
    expect(fetch).toHaveBeenCalled()
    expect(frame).not.toHaveBeenCalled()
  })
})


describe('authoritative restoration barriers', () => {
  it('recovers every subscription when one server generation invalidates a document', async () => {
    coordinator.configure(local)
    const resetA = vi.fn(async () => ({ afterSeq: 1 })), resetB = vi.fn(async () => ({ afterSeq: 2 }))
    coordinator.subscribe({ kind: 'run', projectId: 'boot', runId: 'a', afterSeq: 10 }, { reset: resetA })
    coordinator.subscribe({ kind: 'run', projectId: 'boot', runId: 'b', afterSeq: 20 }, { reset: resetB })
    const worker = Worker.all[0]!
    const { epoch, entries } = worker.port.postMessage.mock.calls.at(-1)![0] as any
    for (const entry of entries) worker.reply({ type: 'reset', version: LIVE_PROTOCOL, epoch, id: entry.id, reason: 'server restarted' })
    expect(resetA).toHaveBeenCalledTimes(1)
    expect(resetB).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(0)
  })
  it('authenticates and reconciles before a restored document rejoins shared traffic', async () => {
    coordinator.configure(local)
    coordinator.subscribe({ kind: 'workspace' }, {})
    window.dispatchEvent(new Event('pagehide'))
    let finish!: () => void
    const off = onLiveReconcile(() => new Promise<void>(resolve => { finish = resolve }))
    try {
      window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }))
      await vi.advanceTimersByTimeAsync(0)
      expect(fetch).toHaveBeenCalledWith('/api/v1/health', expect.objectContaining({ credentials: 'include' }))
      expect(Worker.all).toHaveLength(1)
      finish(); await vi.advanceTimersByTimeAsync(0)
      expect(Worker.all).toHaveLength(2)
    } finally { off(); finish?.() }
  })
  it('aborts stalled reset hydration at the finite-cycle deadline and retries', async () => {
    let signal: AbortSignal | undefined
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ generation: 'one', results: [{ type: 'reset', projectId: 'boot', runId: 'a', status: 409, error: 'expired' }] })))
    coordinator.configure({ ...local, local: false })
    coordinator.subscribe({ kind: 'run', projectId: 'boot', runId: 'a', afterSeq: 0 }, {
      reset: (_reason, current) => { signal = current; return new Promise<void>(resolve => current.addEventListener('abort', () => resolve(), { once: true })) },
    })
    await vi.advanceTimersByTimeAsync(0)
    const initial = signal
    expect(initial).toBeInstanceOf(AbortSignal)
    await vi.advanceTimersByTimeAsync(10_001)
    expect(initial!.aborted).toBe(true)
    await vi.advanceTimersByTimeAsync(4000)
    expect(vi.mocked(fetch).mock.calls.length).toBeGreaterThan(1)
  })
})


it('keeps shared delivery closed after restore authentication fails, then retries', async () => {
  coordinator.configure(local)
  coordinator.subscribe({ kind: 'workspace' }, {})
  window.dispatchEvent(new Event('pagehide'))
  const healthy = vi.mocked(fetch).getMockImplementation()!
  vi.mocked(fetch).mockImplementationOnce(async () => new Response('', { status: 401 }))
  window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }))
  await vi.advanceTimersByTimeAsync(0)
  coordinator.configure(local) // A retained query-cache notification cannot bypass the barrier.
  expect(Worker.all).toHaveLength(1)
  vi.mocked(fetch).mockImplementation(healthy)
  await vi.advanceTimersByTimeAsync(2_000)
  expect(Worker.all).toHaveLength(2)
})

it('uses the restored deployment mode and boot alias before resubscribing a task', async () => {
  coordinator.configure(local)
  coordinator.subscribe({ kind: 'run', projectId: 'default', runId: 'a', afterSeq: 5 }, { reset: async () => ({ afterSeq: 8 }) })
  window.dispatchEvent(new Event('pagehide'))
  const healthy = vi.mocked(fetch).getMockImplementation()!
  vi.mocked(fetch).mockImplementation(async (path, init) => {
    const response = await healthy(path, init)
    if (!String(path).endsWith('/health')) return response
    const health = await response.json()
    return new Response(JSON.stringify({ ...health, bootProject: 'new-boot', capabilities: { ...health.capabilities, localHandoff: false } }))
  })
  window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }))
  await vi.advanceTimersByTimeAsync(0)
  expect(Worker.all).toHaveLength(1)
  const batch = vi.mocked(fetch).mock.calls.find(([path]) => String(path).endsWith('/run-event-batches'))!
  expect(JSON.parse(String(batch[1]!.body)).runs).toEqual([{ projectId: 'new-boot', runId: 'a', afterSeq: 8 }])
})
