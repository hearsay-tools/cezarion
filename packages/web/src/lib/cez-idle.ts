import type { QueryClient } from '@tanstack/react-query'

declare global {
  interface Window {
    /** Read-only: false while a tracked query, SSE reconcile, or WS topic is in flight (#415). */
    readonly __cezIdle?: boolean
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

/** Subscribe the product QueryClient so `__cezIdle` tracks in-flight fetches. */
export function attachQueryIdle(client: QueryClient): () => void {
  publish()
  const sync = (): void => {
    setIdleSource('queries', client.isFetching() > 0)
  }
  sync()
  return client.getQueryCache().subscribe(sync)
}

/** Mark SSE reconciliation busy until the invalidations settle. */
export function trackSseReconcile(work: () => Array<Promise<unknown> | undefined | void>): void {
  setIdleSource('sse', true)
  const tasks = work().filter((task): task is Promise<unknown> => task instanceof Promise)
  void Promise.all(tasks).finally(() => setIdleSource('sse', false))
}
