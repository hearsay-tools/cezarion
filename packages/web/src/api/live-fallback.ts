import { liveRunBatchResponseSchema, type LiveRunDemand } from '@open-mercato/cezar-api-client'
import type { LiveDemand, LiveFrame } from './live-protocol'

export interface FallbackEntry {
  id: string
  demand: LiveDemand
  frame(frame: LiveFrame): void
  value(value: unknown, error?: string): void
  reset(reason: string, signal: AbortSignal): Promise<void>
}
/** One finite cycle per document. Timers and pending HTTP work disappear with visible demand. */
export function createLiveFallback(
  entries: () => FallbackEntry[],
  reconcile: (signal: AbortSignal) => Promise<void>,
  fetcher: typeof fetch = (...args) => fetch(...args),
) {
  let controller: AbortController | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let deadline: ReturnType<typeof setTimeout> | undefined
  let stopped = true, failures = 0, workspaceAt = -Infinity, runsAt = -Infinity
  const readAt = new Map<string, number>()
  let generation: string | undefined
  const cycle = async () => {
    if (stopped || controller) return
    controller = new AbortController()
    const current = controller
    deadline = setTimeout(() => current.abort(), 10_000)
    let drain = false
    try {
      const active = entries()
      const paths = new Set(active.flatMap(entry => entry.demand.kind === 'read' ? [entry.demand.path] : []))
      for (const path of readAt.keys()) if (!paths.has(path)) readAt.delete(path)
      const runs = active.filter(entry => entry.demand.kind === 'run')
      if (runs.length && Date.now() - runsAt >= 2_000) {
        runsAt = Date.now()
        for (let start = 0; start < runs.length; start += 32) {
          const group = runs.slice(start, start + 32)
          // Multiple components in one document may subscribe to the same task.
          const unique = new Map<string, LiveRunDemand>()
          for (const entry of group) {
            const { kind: _, ...run } = entry.demand as Extract<LiveDemand, { kind: 'run' }>
            const key = `${run.projectId}/${run.runId}`
            if (!unique.has(key) || unique.get(key)!.afterSeq > run.afterSeq) unique.set(key, run)
          }
          const response = await fetcher('/api/v1/workspace/run-event-batches', {
            method: 'POST', credentials: 'include', signal: current.signal,
            headers: { 'content-type': 'application/json' }, body: JSON.stringify({ runs: [...unique.values()] }),
          })
          if (!response.ok) throw new Error(`task batch HTTP ${response.status}`)
          const batch = liveRunBatchResponseSchema.parse(await response.json())
          current.signal.throwIfAborted()
          const changed = generation !== undefined && generation !== batch.generation
          generation = batch.generation
          if (changed) { await Promise.all(group.map(entry => entry.reset('server restarted', current.signal))); continue }
          for (const result of batch.results) for (const entry of group) {
            const demand = entry.demand as Extract<LiveDemand, { kind: 'run' }>
            if (result.runId !== demand.runId || result.projectId !== demand.projectId) continue
            if (result.type !== 'batch') { await entry.reset(result.error, current.signal); current.signal.throwIfAborted(); continue }
            for (const event of result.events) if (event.seq > demand.afterSeq) {
              entry.frame({ type: 'event', projectId: demand.projectId, runId: demand.runId, name: event.type.includes('.') ? 'ui-event' : 'run-event', event })
              demand.afterSeq = event.seq
            }
            demand.cursor = result.cursor
            demand.afterSeq = Math.max(demand.afterSeq, result.afterSeq)
            drain ||= result.hasMore
          }
        }
      }
      if (active.some(entry => entry.demand.kind === 'workspace') && Date.now() - workspaceAt >= 5_000) {
        workspaceAt = Date.now()
        await reconcile(current.signal)
      }
      // Topic-only remote consumers reconcile through their authoritative HTTP queries.
      for (const entry of active) {
        if (entry.demand.kind !== 'read') continue
        const { path, intervalMs } = entry.demand
        if (!readAt.has(path)) { readAt.set(path, Date.now()); continue }
        if (Date.now() - readAt.get(path)! < intervalMs) continue
        readAt.set(path, Date.now())
        const response = await fetcher(path, { credentials: 'include', signal: current.signal })
        if (!response.ok) throw new Error(`read HTTP ${response.status}`)
        const value: unknown = await response.json()
        current.signal.throwIfAborted()
        for (const consumer of active) if (consumer.demand.kind === 'read' && consumer.demand.path === path) consumer.value(value)
      }
      failures = 0
    } catch { if (!stopped) failures = Math.min(failures + 1, 5) }
    finally {
      clearTimeout(deadline); deadline = undefined
      if (controller === current) controller = undefined
      if (!stopped && entries().length) {
        if (drain) runsAt = -Infinity
        // Yield between backlog batches, keeping ordinary reads ahead of the next finite read.
        const deadlines = entries().flatMap(entry => {
          if (entry.demand.kind === 'run') return [runsAt + 2_000]
          if (entry.demand.kind === 'workspace') return [workspaceAt + 5_000]
          if (entry.demand.kind === 'read') return [(readAt.get(entry.demand.path) ?? Date.now()) + entry.demand.intervalMs]
          return []
        })
        if (deadlines.length) timer = setTimeout(() => { timer = undefined; void cycle() }, failures ? Math.min(30_000, 1_000 * 2 ** failures) : drain ? 50 : Math.max(50, Math.min(...deadlines) - Date.now()) + (entries().some(entry => entry.demand.kind === 'run') ? Math.random() * 100 : 0))
      }
    }
  }
  return {
    start(workspaceReconciled = false) {
      if (!stopped) { if (!controller) { clearTimeout(timer); timer = undefined; void cycle() }; return }
      stopped = false
      // Restoration already awaited this wave; resume its normal freshness cadence.
      workspaceAt = workspaceReconciled ? Date.now() : -Infinity
      runsAt = -Infinity
      void cycle()
    },
    refresh() { workspaceAt = runsAt = -Infinity; for (const path of readAt.keys()) readAt.set(path, -Infinity); if (!controller && !stopped) { clearTimeout(timer); timer = undefined; void cycle() } },
    stop() { stopped = true; readAt.clear(); clearTimeout(timer); timer = undefined; clearTimeout(deadline); deadline = undefined; controller?.abort() },
  }
}
