import { notifyManager, type QueryClient } from '@tanstack/react-query'

declare global {
  interface Window {
    /**
     * Read-only: false while query results await subscriber delivery, a query fetch,
     * SSE reconcile, or WS topic is in flight (hearsay-tools/cezarion#3053).
     */
    readonly __cezIdle?: boolean
    /**
     * Read-only: true once this document's workspace stream has passed its attachment barrier —
     * the first `ping` after an open, which the server writes only after its store listeners
     * attach (#795) — and false again from the next open/reconnect until that ping
     * (hearsay-tools/cezarion#1069). An event written after this turns true reaches the reducers.
     */
    readonly __cezLive?: boolean
  }
}

const busy = { queries: false, sse: false, ws: false }

function isIdle(): boolean {
  return !busy.queries && !busy.sse && !busy.ws
}

function publish(): void {
  if (typeof window === 'undefined') return
  const current = Object.getOwnPropertyDescriptor(window, '__cezIdle')
  if (current?.get) return
  Object.defineProperty(window, '__cezIdle', {
    configurable: true,
    enumerable: false,
    get: isIdle,
  })
}

export function setIdleSource(source: keyof typeof busy, inFlight: boolean): void {
  busy[source] = inFlight
  publish()
}

let live = false

/** Mark the workspace stream attached (its barrier ping arrived) or detached (open/reconnect). */
export function setWorkspaceLive(attached: boolean): void {
  live = attached
  if (typeof window === 'undefined') return
  if (Object.getOwnPropertyDescriptor(window, '__cezLive')?.get) return
  Object.defineProperty(window, '__cezLive', { configurable: true, enumerable: false, get: () => live })
}

/** Keep queries busy through fetch settlement and delivery to React subscribers. */
export function attachQueryIdle(client: QueryClient): () => void {
  let revision = 0
  let attached = true
  setIdleSource('queries', client.isFetching() > 0)
  const sync = (): void => {
    const current = ++revision
    setIdleSource('queries', true)
    if (client.isFetching() > 0) return
    // Query observers enqueue batchCalls before the cache event. Drain that batch
    // first, then publish on the next notification turn so React can commit it.
    notifyManager.schedule(() => {
      notifyManager.schedule(() => {
        if (attached && current === revision && client.isFetching() === 0) {
          setIdleSource('queries', false)
        }
      })
    })
  }
  const unsubscribe = client.getQueryCache().subscribe(sync)
  return () => {
    attached = false
    unsubscribe()
    setIdleSource('queries', false)
  }
}

/** Mark SSE reconciliation busy until the invalidations settle. */
export function trackSseReconcile(work: () => Array<Promise<unknown> | undefined | void>): Promise<void> {
  setIdleSource('sse', true)
  const tasks = work().filter((task): task is Promise<unknown> => task instanceof Promise)
  return Promise.allSettled(tasks).then(() => setIdleSource('sse', false))
}
