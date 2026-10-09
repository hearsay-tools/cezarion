import { pageIsActive, subscribePageActivity } from './live-visibility'
/**
 * The preview pane's own WebSocket (#781, spec 2026-10-02-live-preview-v1, "Transport").
 *
 * A named exception to the one-socket-per-cockpit rule in `ws.ts`: that hub carries small shared
 * topics, while this socket carries one viewer's JPEG frames and input, lives only while a pane
 * is open, and speaks per run. It opens in local and remote mode alike: the hub's remote-mode
 * rule (no browser WebSocket) exists because the hub is session-global, and the preview is a
 * deliberate, user-opened feature. A deployment that cannot carry the upgrade lands on `blocked`.
 *
 * Wire: binary messages are JPEG frames; text messages are `previewServerMessageSchema` JSON.
 * Retry policy (design 5.11 and 5.14): an upgrade that never opens is tried twice and then
 * `blocked`, never retried (the #688 failure mode); once a socket has opened, a drop gets 5
 * reconnects with backoff and then `closed`.
 */

import {
  previewServerMessageSchema,
  type PreviewClientMessage,
  type PreviewServerMessage,
} from '@open-mercato/cezar-api-client'

export type PreviewTransport = 'connecting' | 'open' | 'reconnecting' | 'blocked' | 'closed'

export interface PreviewHandlers {
  onFrame(blob: Blob): void
  onMessage(message: PreviewServerMessage): void
  onTransport(transport: PreviewTransport, attempt?: number): void
}

export interface PreviewConnection {
  send(message: PreviewClientMessage): void
  close(): void
}

/** Failed upgrades (the socket never opened) tolerated before the proxy is declared blocking. */
export const PREVIEW_UPGRADE_ATTEMPTS = 2
/** Reconnects after a socket that did open drops. */
export const PREVIEW_RECONNECTS = 5
const UPGRADE_RETRY_DELAY_MS = 1_000
const RECONNECT_BACKOFF_MS = [500, 1_000, 2_000, 4_000, 8_000]

const OPEN = 1

export function connectPreview(
  scope: { projectId: string; runId: string },
  handlers: PreviewHandlers,
): PreviewConnection {
  const path = `/api/v1/p/${encodeURIComponent(scope.projectId)}/runs/${encodeURIComponent(scope.runId)}/preview/ws`
  const url = (): string => `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}${path}`

  let socket: WebSocket | null = null
  let retryTimer: ReturnType<typeof setTimeout> | undefined
  let stopped = false
  /** Whether any socket of this connection has ever opened: the upgrade got through. */
  let upgraded = false
  let failedUpgrades = 0
  /** Reconnects spent since the last frame; a frame proves the stream works and refills it. */
  let reconnects = 0

  const active = () => typeof document === 'undefined' || pageIsActive()
  const connect = (): void => {
    if (stopped || !active()) return
    const Ctor = globalThis.WebSocket
    if (typeof Ctor !== 'function') return // jsdom / prerender: stay silent
    const ws = new Ctor(url())
    ws.binaryType = 'blob'
    socket = ws

    ws.addEventListener('open', () => {
      if (ws !== socket) return
      upgraded = true
      handlers.onTransport('open')
    })

    ws.addEventListener('message', (event) => {
      if (ws !== socket) return
      const data = (event as MessageEvent).data as unknown
      if (typeof data === 'string') {
        let json: unknown
        try {
          json = JSON.parse(data)
        } catch {
          return
        }
        const parsed = previewServerMessageSchema.safeParse(json)
        if (parsed.success) handlers.onMessage(parsed.data)
        return
      }
      if (data instanceof Blob) {
        reconnects = 0
        handlers.onFrame(data)
      }
    })

    ws.addEventListener('error', () => undefined) // always followed by 'close'
    ws.addEventListener('close', () => {
      if (ws !== socket || stopped) return
      socket = null
      if (!upgraded) {
        failedUpgrades += 1
        if (failedUpgrades >= PREVIEW_UPGRADE_ATTEMPTS) {
          stopped = true
          handlers.onTransport('blocked')
          return
        }
        handlers.onTransport('reconnecting', failedUpgrades)
        retryTimer = setTimeout(connect, UPGRADE_RETRY_DELAY_MS)
        return
      }
      if (reconnects >= PREVIEW_RECONNECTS) {
        stopped = true
        handlers.onTransport('closed')
        return
      }
      const delay = RECONNECT_BACKOFF_MS[Math.min(reconnects, RECONNECT_BACKOFF_MS.length - 1)]!
      reconnects += 1
      handlers.onTransport('reconnecting', reconnects)
      retryTimer = setTimeout(connect, delay)
    })
  }

  const releaseActivity = subscribePageActivity(visible => {
    if (stopped) return
    if (!visible) {
      clearTimeout(retryTimer); retryTimer = undefined
      const ws = socket; socket = null; ws?.close()
    } else if (!socket) connect()
  })
  handlers.onTransport('connecting')
  connect()

  return {
    send(message) {
      if (socket?.readyState === OPEN) socket.send(JSON.stringify(message))
    },
    close() {
      stopped = true
      releaseActivity()
      clearTimeout(retryTimer)
      retryTimer = undefined
      const ws = socket
      socket = null // the async close event then fails its `ws === socket` guard
      ws?.close()
    },
  }
}
