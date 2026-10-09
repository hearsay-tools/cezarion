import { healthResponseSchema, type LiveRunDemand } from '@open-mercato/cezar-api-client'
import { createLiveFallback, type FallbackEntry } from './live-fallback'
import { LEASE_MS, LIVE_PROTOCOL, LIVE_WORKER_NAME, RENEW_MS, liveDemandSchema, ownerOutputSchema, type LiveDemand, type LiveFrame } from './live-protocol'
import { pageIsActive, subscribePageActivity } from './live-visibility'

export interface LiveHandlers {
  frame?(frame: LiveFrame): void
  value?(value: unknown, error?: string): void
  ready?(): void
  reset?(reason: string, signal: AbortSignal): Promise<Pick<LiveRunDemand, 'cursor' | 'afterSeq'> | void> | void
}
interface Subscription extends FallbackEntry { handlers: LiveHandlers; bootAlias: boolean; recovering: boolean; released: boolean; recovery?: AbortController }
interface LiveSession { local: boolean; bootProject: string; apiBase: string }
type ReconcileListener = (signal: AbortSignal, periodic: boolean) => void | Promise<void>
const reconciliations = new Set<ReconcileListener>()
export function onLiveReconcile(listener: ReconcileListener): () => void {
  reconciliations.add(listener)
  return () => { reconciliations.delete(listener) }
}
async function reconcileLive(signal: AbortSignal, periodic = false) {
  signal.throwIfAborted()
  await untilAborted(Promise.all([...reconciliations].map(async listener => listener(signal, periodic))), signal)
}

/** Bound even an observer that fails to settle its promise when cancelled. */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

/** Documents own their cursors. The worker owns only local wire work for visible demand. */
export function createLiveCoordinator() {
  const subscriptions = new Map<string, Subscription>()
  const documentId = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`
  let session: LiveSession | undefined
  let worker: SharedWorker | undefined
  let renewal: ReturnType<typeof setInterval> | undefined
  let releaseActivity: (() => void) | undefined
  let epoch = 0, nextId = 0, lastAlive = 0
  let active = false, workerFailed = false, disposed = false
  let restoration: AbortController | undefined
  let restoreRetry: ReturnType<typeof setTimeout> | undefined
  let restoreFailures = 0
  const available = () => [...subscriptions.values()].filter(entry => !entry.recovering && !entry.released)
  let reconciliation: AbortController | undefined
  const reconcile = () => {
    reconciliation?.abort()
    const current = reconciliation = new AbortController()
    const deadline = setTimeout(() => current.abort(), 10_000)
    void reconcileLive(current.signal).catch(() => {}).finally(() => clearTimeout(deadline))
  }
  const fallback = createLiveFallback(available, signal => reconcileLive(signal, true), (path, init) => fetch(`${session?.apiBase ?? ''}${String(path)}`, init))
  const canonical = (demand: LiveDemand): LiveDemand => demand.kind === 'run' && demand.projectId === 'default' && session
    ? { ...demand, projectId: session.bootProject } : demand
  const post = (payload: Record<string, unknown>) => {
    if (!worker) return
    try { worker.port.postMessage({ version: LIVE_PROTOCOL, documentId, epoch, ...payload }) }
    catch { failWorker() }
  }
  const sync = () => {
    if (!active || restoration) return
    const entries = available().map(entry => ({ id: entry.id, demand: entry.demand }))
    if (!entries.length) { disconnect(); return }
    post({ type: 'sync', entries })
  }
  const disconnect = () => {
    clearInterval(renewal); renewal = undefined
    if (worker) {
      const old = worker; worker = undefined
      try { old.port.postMessage({ type: 'sync', version: LIVE_PROTOCOL, documentId, epoch: ++epoch, entries: [] }) } catch { /* lease handles crash */ }
      old.port.onmessage = null; old.port.onmessageerror = null; old.port.close()
    }
  }
  function failWorker() {
    if (!active || disposed) return
    workerFailed = true
    disconnect()
    // No permanent page SSE/WS fallback: ordinary HTTP always keeps connection capacity.
    for (const entry of available()) entry.handlers.ready?.()
    fallback.start()
    reconcile()
  }
  const recover = async (entry: Subscription, reason: string, parentSignal?: AbortSignal) => {
    if (entry.recovering || entry.released) return
    const recovery = new AbortController()
    const abort = () => recovery.abort(parentSignal?.reason)
    parentSignal?.addEventListener('abort', abort, { once: true })
    if (parentSignal?.aborted) abort()
    const deadline = setTimeout(() => recovery.abort(), 10_000)
    entry.recovery = recovery
    entry.recovering = true; ++epoch; sync()
    try {
      const cursor = await untilAborted(Promise.resolve(entry.handlers.reset?.(reason, recovery.signal)), recovery.signal)
      recovery.signal.throwIfAborted()
      if (entry.released || !active) return
      if (cursor && entry.demand.kind === 'run') Object.assign(entry.demand, cursor)
    } catch (error) {
      // Preserve document cursors on a failed hydration; finite fallback backs off its reads.
      if (parentSignal) throw error
      if (active && !restoration) failWorker()
    } finally {
      clearTimeout(deadline)
      parentSignal?.removeEventListener('abort', abort)
      entry.recovery = undefined
      entry.recovering = false
      if (!entry.released && active && !parentSignal) { ++epoch; start() }
    }
  }
  const start = (workspaceReconciled = false) => {
    if (disposed || restoration || !session || !subscriptions.size || !pageIsActive()) return
    active = true
    const apiUrl = new URL(session.apiBase || '/', location.href)
    // The shared owner serves root-relative URLs. Other origins or service prefixes
    // use document-authenticated finite requests, which preserve the configured base.
    if (!session.local || apiUrl.origin !== location.origin || apiUrl.pathname !== '/' || workerFailed || typeof SharedWorker !== 'function') {
      for (const entry of available()) entry.handlers.ready?.()
      fallback.start(workspaceReconciled)
      return
    }
    if (worker) { for (const entry of available()) entry.handlers.ready?.(); sync(); return }
    try {
      const url = import.meta.env.DEV ? new URL('./live-worker.ts', import.meta.url) : new URL('/live-worker.js', location.href)
      const created = new SharedWorker(url, { type: 'module', name: LIVE_WORKER_NAME })
      worker = created; lastAlive = Date.now()
      created.addEventListener('error', () => { if (worker === created) failWorker() })
      created.port.onmessageerror = () => { if (worker === created) failWorker() }
      created.port.onmessage = ({ data }: MessageEvent<unknown>) => {
        if (worker !== created || !active) return
        const parsed = ownerOutputSchema.safeParse(data)
        if (!parsed.success) { failWorker(); return }
        const message = parsed.data
        if (message.type === 'hello') { lastAlive = Date.now(); sync(); return }
        if (message.epoch !== epoch) return
        lastAlive = Date.now()
        if (message.type === 'alive') return
        if (message.type === 'unavailable') { failWorker(); return }
        const entry = subscriptions.get(message.id)
        if (!entry || entry.recovering) return
        if (message.type === 'reset') {
          if (message.reason === 'shared task capacity reached') failWorker()
          // All entries from the old generation are invalid together. Recover them
          // before advancing epochs can discard the owner's remaining reset messages.
          else if (message.reason === 'server restarted') {
            for (const affected of available()) void recover(affected, message.reason)
          }
          else void recover(entry, message.reason)
          return
        }
        if (message.type === 'value') { entry.handlers.value?.(message.value, message.error); return }
        entry.frame(message.frame)
      }
      created.port.start()
      for (const entry of available()) entry.handlers.ready?.()
      sync()
      renewal = setInterval(() => {
        if (Date.now() - lastAlive >= LEASE_MS) { failWorker(); return }
        sync()
      }, RENEW_MS)
    } catch { failWorker() }
  }
  const stop = () => {
    active = false; disconnect(); fallback.stop(); reconciliation?.abort()
    restoration?.abort(); restoration = undefined
    clearTimeout(restoreRetry); restoreRetry = undefined
    for (const entry of subscriptions.values()) entry.recovery?.abort()
  }
  const onActivity = (visible: boolean) => {
    if (!visible) { stop(); return }
    if (active || disposed || !session || !subscriptions.size) return
    workerFailed = false
    active = true
    const current = restoration = new AbortController()
    const deadline = setTimeout(() => current.abort(), 10_000)
    // Cached health is not proof of the current proxy session or deployment mode.
    // Keep all shared delivery closed until authenticated scope and history recover.
    void (async () => {
      const response = await fetch(`${session!.apiBase}/api/v1/health`, { credentials: 'include', signal: current.signal, cache: 'no-store' })
      if (!response.ok) throw new Error(`bootstrap HTTP ${response.status}`)
      const health = healthResponseSchema.pick({ capabilities: true, bootProject: true }).parse(await response.json())
      current.signal.throwIfAborted()
      session = { ...session!, local: health.capabilities.localHandoff, bootProject: health.bootProject }
      for (const entry of subscriptions.values()) if (entry.bootAlias && entry.demand.kind === 'run') entry.demand.projectId = health.bootProject
      await reconcileLive(current.signal)
      await Promise.all(available().filter(entry => entry.demand.kind === 'run').map(entry => recover(entry, 'document resumed', current.signal)))
      current.signal.throwIfAborted()
      if (restoration !== current) return
      restoration = undefined; restoreFailures = 0
      start(true)
    })().catch(() => {
      if (restoration !== current || disposed || !pageIsActive()) return
      active = false
      restoreFailures = Math.min(restoreFailures + 1, 5)
      restoreRetry = setTimeout(() => { restoreRetry = undefined; onActivity(true) }, Math.min(30_000, 1_000 * 2 ** restoreFailures))
    }).finally(() => clearTimeout(deadline))
  }
  const onOnline = () => { if (pageIsActive()) { stop(); onActivity(true) } }
  const watch = () => {
    if (releaseActivity || typeof window === 'undefined') return
    releaseActivity = subscribePageActivity(onActivity)
    window.addEventListener('online', onOnline)
  }
  return {
    resetSession() { stop(); session = undefined; workerFailed = false },
    configure(next: LiveSession) {
      if (restoration) return
      if (session && session.local === next.local && session.apiBase === next.apiBase && session.bootProject === next.bootProject) return
      stop(); session = next; workerFailed = false
      for (const entry of subscriptions.values()) if (entry.bootAlias && entry.demand.kind === 'run') entry.demand.projectId = next.bootProject
      ++epoch; start()
    },
    subscribe(input: LiveDemand, handlers: LiveHandlers) {
      const demand = canonical(liveDemandSchema.parse(input))
      const id = String(++nextId)
      const entry: Subscription = {
        id, demand, handlers, bootAlias: input.kind === 'run' && input.projectId === 'default', recovering: false, released: false,
        frame(frame) {
          if (entry.released || entry.recovering || !active || restoration) return
          if ('type' in frame && frame.type === 'event' && entry.demand.kind === 'run') {
            if (frame.projectId !== entry.demand.projectId || frame.runId !== entry.demand.runId || frame.event.seq <= entry.demand.afterSeq) return
            handlers.frame?.(frame)
            entry.demand.afterSeq = frame.event.seq
            post({ type: 'ack', id, seq: frame.event.seq })
          } else if ('type' in frame && (frame.type === 'reset' || frame.type === 'error')) {
            void recover(entry, frame.error)
          } else handlers.frame?.(frame)
        },
        value: (value, error) => { if (!entry.released && active && !restoration) handlers.value?.(value, error) },
        reset: (reason, signal) => recover(entry, reason, signal),
      }
      subscriptions.set(id, entry); ++epoch; watch(); start()
      return () => {
        if (entry.released) return
        entry.released = true; entry.recovery?.abort(); subscriptions.delete(id); ++epoch
        if (subscriptions.size) { sync(); return }
        stop(); releaseActivity?.(); releaseActivity = undefined
        window.removeEventListener('online', onOnline)
      }
    },
    invalidateReads() {
      for (const entry of available()) if (entry.demand.kind === 'read') post({ type: 'refresh', id: entry.id })
      fallback.refresh()
    },
    dispose() {
      disposed = true; stop(); subscriptions.clear(); releaseActivity?.(); releaseActivity = undefined
      if (typeof window !== 'undefined') window.removeEventListener('online', onOnline)
    },
  }
}
const coordinator = createLiveCoordinator()
export const configureLiveSession = coordinator.configure
export const subscribeLive = coordinator.subscribe
export const invalidateLiveReads = coordinator.invalidateReads

export const resetLiveSession = coordinator.resetSession
