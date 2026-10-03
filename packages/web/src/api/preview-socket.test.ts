// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { connectPreview } from './preview-socket'

/** Records what a server would see; lifecycle is driven by hand. */
class FakeWebSocket {
  static instances: FakeWebSocket[] = []

  url: string
  binaryType = 'blob'
  readyState = 0
  sent: string[] = []
  private handlers = new Map<string, Set<(event: unknown) => void>>()

  constructor(url: string) {
    this.url = url
    FakeWebSocket.instances.push(this)
  }

  addEventListener(name: string, handler: (event: unknown) => void): void {
    const set = this.handlers.get(name) ?? new Set()
    set.add(handler)
    this.handlers.set(name, set)
  }

  send(data: string): void {
    this.sent.push(data)
  }

  close(): void {
    this.readyState = 3
  }

  open(): void {
    this.readyState = 1
    this.fire('open', {})
  }

  message(data: unknown): void {
    this.fire('message', { data })
  }

  /** A failed upgrade or a drop: browsers fire `error` then `close`. */
  drop(): void {
    this.readyState = 3
    this.fire('error', {})
    this.fire('close', {})
  }

  private fire(name: string, event: unknown): void {
    for (const handler of [...(this.handlers.get(name) ?? [])]) handler(event)
  }
}

const scope = { projectId: 'default', runId: 'r1' }

function connect() {
  const onFrame = vi.fn()
  const onMessage = vi.fn()
  const transport: Array<[string, number | undefined]> = []
  const onTransport = vi.fn((t: string, attempt?: number) => { transport.push([t, attempt]) })
  const handle = connectPreview(scope, { onFrame, onMessage, onTransport: onTransport as never })
  return { handle, onFrame, onMessage, onTransport, transport }
}

beforeEach(() => {
  vi.useFakeTimers()
  FakeWebSocket.instances = []
  vi.stubGlobal('WebSocket', FakeWebSocket)
  vi.stubGlobal('location', { protocol: 'http:', host: 'cez.test' })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('connectPreview', () => {
  it('opens the run-scoped preview path on its own socket and reports connecting then open', () => {
    const { transport } = connect()
    expect(FakeWebSocket.instances).toHaveLength(1)
    expect(FakeWebSocket.instances[0]!.url).toBe('ws://cez.test/api/v1/p/default/runs/r1/preview/ws')
    expect(FakeWebSocket.instances[0]!.binaryType).toBe('blob')
    FakeWebSocket.instances[0]!.open()
    expect(transport).toEqual([['connecting', undefined], ['open', undefined]])
  })

  it('uses wss behind TLS', () => {
    vi.stubGlobal('location', { protocol: 'https:', host: 'cez.test' })
    connect()
    expect(FakeWebSocket.instances[0]!.url.startsWith('wss://cez.test/')).toBe(true)
  })

  it('routes binary frames and validated JSON messages, and drops anything else', () => {
    const { onFrame, onMessage } = connect()
    const ws = FakeWebSocket.instances[0]!
    ws.open()
    const blob = new Blob([new Uint8Array([1, 2, 3])])
    ws.message(blob)
    ws.message(JSON.stringify({ t: 'url', url: 'http://localhost:5173/' }))
    ws.message(JSON.stringify({ t: 'not-a-message' }))
    ws.message('not json')
    expect(onFrame).toHaveBeenCalledTimes(1)
    expect(onFrame).toHaveBeenCalledWith(blob)
    expect(onMessage).toHaveBeenCalledTimes(1)
    expect(onMessage).toHaveBeenCalledWith({ t: 'url', url: 'http://localhost:5173/' })
  })

  it('sends client messages as JSON while open and drops them while not', () => {
    const { handle } = connect()
    const ws = FakeWebSocket.instances[0]!
    handle.send({ t: 'ping', ts: 1 })
    expect(ws.sent).toEqual([])
    ws.open()
    handle.send({ t: 'back' })
    expect(ws.sent).toEqual([JSON.stringify({ t: 'back' })])
  })

  it('two failed upgrades with no frame end in blocked, and no third attempt is made', () => {
    const { transport } = connect()
    FakeWebSocket.instances[0]!.drop()
    expect(transport.at(-1)).toEqual(['reconnecting', 1])
    vi.advanceTimersByTime(60_000)
    expect(FakeWebSocket.instances).toHaveLength(2)
    FakeWebSocket.instances[1]!.drop()
    expect(transport.at(-1)).toEqual(['blocked', undefined])
    vi.advanceTimersByTime(10 * 60_000)
    expect(FakeWebSocket.instances).toHaveLength(2)
  })

  it('a drop after a frame reconnects five times with backoff, then reports closed', () => {
    const { transport, onFrame } = connect()
    let ws = FakeWebSocket.instances[0]!
    ws.open()
    ws.message(new Blob([new Uint8Array([1])]))
    expect(onFrame).toHaveBeenCalledTimes(1)
    ws.drop()
    const delays: number[] = []
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      expect(transport.at(-1)).toEqual(['reconnecting', attempt])
      const before = FakeWebSocket.instances.length
      let waited = 0
      while (FakeWebSocket.instances.length === before) {
        vi.advanceTimersByTime(100)
        waited += 100
        expect(waited).toBeLessThan(60_000)
      }
      delays.push(waited)
      ws = FakeWebSocket.instances.at(-1)!
      ws.drop()
    }
    expect(FakeWebSocket.instances).toHaveLength(6)
    expect(transport.at(-1)).toEqual(['closed', undefined])
    expect(delays).toEqual([...delays].sort((a, b) => a - b)) // backoff never shrinks
    vi.advanceTimersByTime(10 * 60_000)
    expect(FakeWebSocket.instances).toHaveLength(6)
  })

  it('a frame after a reconnect resets the attempt budget', () => {
    const { transport } = connect()
    let ws = FakeWebSocket.instances[0]!
    ws.open()
    ws.message(new Blob([new Uint8Array([1])]))
    ws.drop()
    vi.advanceTimersByTime(60_000)
    ws = FakeWebSocket.instances.at(-1)!
    ws.open()
    ws.message(new Blob([new Uint8Array([1])]))
    ws.drop()
    expect(transport.at(-1)).toEqual(['reconnecting', 1])
  })

  it('close() stops reconnecting and closes the socket without further callbacks', () => {
    const { handle, transport } = connect()
    const ws = FakeWebSocket.instances[0]!
    ws.open()
    ws.message(new Blob([new Uint8Array([1])]))
    ws.drop()
    const seen = transport.length
    handle.close()
    vi.advanceTimersByTime(10 * 60_000)
    expect(FakeWebSocket.instances).toHaveLength(1)
    expect(transport).toHaveLength(seen)
  })
})
