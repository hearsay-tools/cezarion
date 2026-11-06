import type { QueryClient } from '@tanstack/react-query'
import type { ProcessUsage, ProjectsResponse, RunsIndexResponse } from '@open-mercato/cezar-api-client'

import type { WorkspaceRunEvent } from './events'
import {
  applyIndexChange,
  applyIndexUsage,
  createIndexOverlay,
  dropIndexProject,
  mergeIndexSnapshot,
  overlayDropProject,
  overlayReady,
  overlayRecord,
  type IndexChange,
  type IndexOverlay,
} from './runs-index-cache'

/**
 * The workspace runs index, kept current from the workspace stream (hearsay-tools/cezarion#2729).
 *
 * Each `run-summary` and `run-deleted` frame patches the cached index row in the next animation
 * frame, with no request. A full `GET /workspace/runs-index` runs only as a fenced reconciliation:
 * bootstrap, reconnect, visibility restore, a `seq` gap, an unknown project, a truncated window
 * boundary, a new project, and the visible-only backstop read (`useRunsIndex`).
 *
 * Every snapshot passes `merge`, which lays the frames newer than the snapshot's `eventSeq` over
 * it (`runs-index-cache.ts`). A cold cache records those frames but is never created by them.
 */

/** The query key of `useRunsIndex`. Kept here so this module does not import `queries.ts`. */
export const RUNS_INDEX_QUERY_KEY = ['workspace', 'runs-index'] as const
const PROJECTS_QUERY_KEY = ['workspace', 'projects'] as const

/** How long an event-driven reconciliation waits for more triggers before it fires. The wait
 *  holds its first deadline, so sustained events cannot postpone it. */
export const RUNS_INDEX_RECONCILE_HOLD_MS = 400

/** The visible-only backstop read of the runs index (D2): one per minute per coordination group. */
export const RUNS_INDEX_BACKSTOP_MS = 60_000

/** A hidden document runs no animation frames. Patches still land within this bound. */
const FLUSH_FALLBACK_MS = 100

type QueuedPatch =
  | { type: 'change'; change: IndexChange }
  | { type: 'usage'; project: string; usage: Readonly<Record<string, ProcessUsage>> }

export interface RunsIndexSync {
  /** The stream attached: `ready` names its generation and last frame number. */
  ready(generation: string, seq: number): void
  /** A new stream attachment: frames may have passed unheard until its `ready` or first frame. */
  detach(): void
  /** One run frame of `project`. `gap` is true when the stream's seq fence saw lost frames. */
  run(project: string, event: WorkspaceRunEvent, gap?: boolean): void
  /** One project's usage tick. */
  usage(project: string, usage: Readonly<Record<string, ProcessUsage>>): void
  /** The project left the registry: drop its rows now, with no request. */
  dropProject(project: string): void
  /** Fence a snapshot. Every index snapshot passes here before it reaches the cache. */
  merge(snapshot: RunsIndexResponse): RunsIndexResponse
  /**
   * Ask for a full snapshot. At most one runs at a time, plus one trailing request for triggers
   * that arrive while it runs. `hold` waits `RUNS_INDEX_RECONCILE_HOLD_MS` first, to coalesce a
   * burst; the wait never restarts.
   */
  reconcile(options?: { hold?: boolean }): Promise<void>
  /** Apply the queued patches now. */
  flush(): void
  /** Cancel timers and queued patches. The overlay stays with the query client. */
  stop(): void
}

const syncs = new WeakMap<QueryClient, RunsIndexSync>()

/** The one index sync of a query client, created on first use. */
export function runsIndexSync(queryClient: QueryClient): RunsIndexSync {
  let sync = syncs.get(queryClient)
  if (!sync) {
    sync = createRunsIndexSync(queryClient)
    syncs.set(queryClient, sync)
  }
  return sync
}

/** The shared live read's merge hook (`useLiveRead`): a poll answer is a snapshot like any other. */
export function mergeRunsIndexRead(value: unknown, queryClient: QueryClient): unknown {
  if (typeof value !== 'object' || value === null || !Array.isArray((value as { runs?: unknown }).runs)) return value
  return runsIndexSync(queryClient).merge(value as RunsIndexResponse)
}

function registryOf(queryClient: QueryClient): ReadonlySet<string> | undefined {
  const projects = queryClient.getQueryData<ProjectsResponse>(PROJECTS_QUERY_KEY)?.projects
  return projects ? new Set(projects.map((project) => project.id)) : undefined
}

function toChange(project: string, event: WorkspaceRunEvent): IndexChange {
  return event.type === 'run-summary'
    ? { type: 'run', project, seq: event.seq, run: event.summary }
    : { type: 'deleted', project, seq: event.seq, id: event.id }
}

export function createRunsIndexSync(queryClient: QueryClient): RunsIndexSync {
  const overlay: IndexOverlay = createIndexOverlay()
  let queue: QueuedPatch[] = []
  let frame: number | undefined
  let fallback: ReturnType<typeof setTimeout> | undefined
  let hold: ReturnType<typeof setTimeout> | undefined
  let inFlight: Promise<void> | undefined
  let trailing = false

  const cached = () => queryClient.getQueryData<RunsIndexResponse>(RUNS_INDEX_QUERY_KEY)

  const fire = (): Promise<void> => {
    clearTimeout(hold)
    hold = undefined
    const query = queryClient.getQueryCache().find({ queryKey: RUNS_INDEX_QUERY_KEY, exact: true })
    // Invalidation reuses a running cold request, which may predate the trigger. Cancel it first.
    const cold = query !== undefined && query.state.data === undefined && query.state.fetchStatus !== 'idle'
    const run = cold
      ? queryClient.cancelQueries({ queryKey: RUNS_INDEX_QUERY_KEY, exact: true })
        .then(() => queryClient.invalidateQueries({ queryKey: RUNS_INDEX_QUERY_KEY }))
      : queryClient.invalidateQueries({ queryKey: RUNS_INDEX_QUERY_KEY })
    const current: Promise<void> = run.catch(() => undefined).finally(() => {
      if (inFlight !== current) return
      inFlight = undefined
      if (trailing) {
        trailing = false
        void fire()
      }
    })
    inFlight = current
    return current
  }

  const reconcile = (options: { hold?: boolean } = {}): Promise<void> => {
    if (inFlight) {
      trailing = true
      return inFlight
    }
    if (options.hold) {
      hold ??= setTimeout(() => { void fire() }, RUNS_INDEX_RECONCILE_HOLD_MS)
      return Promise.resolve()
    }
    return fire()
  }

  const flush = (): void => {
    if (frame !== undefined && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame)
    frame = undefined
    clearTimeout(fallback)
    fallback = undefined
    const patches = queue
    queue = []
    const data = cached()
    if (!data || patches.length === 0) return
    const registry = registryOf(queryClient)
    // Frames the cached snapshot already includes would only move a row back in time.
    const fenced = data.generation === overlay.generation ? data.eventSeq : undefined
    let next = data
    let needsReconcile = false
    for (const patch of patches) {
      if (patch.type === 'usage') {
        next = applyIndexUsage(next, patch.project, patch.usage)
        continue
      }
      if (fenced !== undefined && patch.change.seq <= fenced) continue
      const result = applyIndexChange(next, patch.change, registry)
      next = result.index
      needsReconcile ||= result.reconcile
    }
    if (next !== data) queryClient.setQueryData<RunsIndexResponse>(RUNS_INDEX_QUERY_KEY, next)
    if (needsReconcile) void reconcile({ hold: true })
  }

  const schedule = (): void => {
    if (fallback !== undefined) return
    fallback = setTimeout(flush, FLUSH_FALLBACK_MS)
    if (typeof requestAnimationFrame === 'function') frame = requestAnimationFrame(flush)
  }

  return {
    ready(generation, seq) {
      overlayReady(overlay, generation, seq)
    },
    detach() {
      overlay.floor = undefined
    },
    run(project, event, gap = false) {
      const change = toChange(project, event)
      overlayRecord(overlay, change, gap)
      queue.push({ type: 'change', change })
      schedule()
    },
    usage(project, usage) {
      queue.push({ type: 'usage', project, usage })
      schedule()
    },
    dropProject(project) {
      overlayDropProject(overlay, project)
      queue = queue.filter((patch) => (patch.type === 'change' ? patch.change.project : patch.project) !== project)
      const data = cached()
      if (!data) return
      const next = dropIndexProject(data, project)
      if (next !== data) queryClient.setQueryData<RunsIndexResponse>(RUNS_INDEX_QUERY_KEY, next)
    },
    merge(snapshot) {
      const result = mergeIndexSnapshot(overlay, snapshot, registryOf(queryClient))
      // The snapshot is still being written; the next reconciliation must start after it.
      if (result.reconcile) queueMicrotask(() => { void reconcile({ hold: true }) })
      return result.index
    },
    reconcile,
    flush,
    stop() {
      if (frame !== undefined && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame)
      frame = undefined
      clearTimeout(fallback)
      fallback = undefined
      clearTimeout(hold)
      hold = undefined
      queue = []
      trailing = false
    },
  }
}
