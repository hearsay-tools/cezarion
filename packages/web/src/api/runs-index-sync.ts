import type { QueryClient } from '@tanstack/react-query'
import type { ProcessUsage, ProjectsResponse, RunsIndexResponse } from '@open-mercato/cezar-api-client'

import type { WorkspaceRunEvent } from './events'
import {
  applyIndexChange,
  applyIndexUsage,
  createIndexOverlay,
  dropIndexProject,
  mergeIndexSnapshot,
  overlayDetach,
  overlayDropProject,
  overlayReady,
  overlayRecord,
  type IndexChange,
  type IndexOverlay,
} from './runs-index-cache'

/**
 * The workspace runs index, kept current from the workspace stream (hearsay-tools/cezarion#2729).
 *
 * Each `run-summary`, `run-deleted` and `usage` frame patches the cached index with no request.
 * The first patch after a quiet period lands in the next animation frame; after a write, the next
 * one waits until `RUNS_INDEX_WRITE_INTERVAL_MS` has passed, and that wait never restarts. This is
 * a measured correction of the plan's "once per animation frame" (accepted by the planner on
 * 2026-11-06): every index write re-renders the app shell, and the per-frame cadence turned a
 * bootstrap burst of about 120 frames into about 190 commits. A full `GET /workspace/runs-index`
 * runs only as a fenced reconciliation:
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

/** The shortest time between two index writes. Each write re-renders every index reader. */
export const RUNS_INDEX_WRITE_INTERVAL_MS = 250

type QueuedPatch =
  /** `generation`: the stream generation the frame came from. A patch never crosses a restart. */
  | { type: 'change'; change: IndexChange; generation: string | undefined }
  | { type: 'usage'; project: string; usage: Readonly<Record<string, ProcessUsage>>; generation: string | undefined }

export interface RunsIndexSync {
  /** The stream attached: `ready` names its generation and last frame number. */
  ready(generation: string, seq: number): void
  /** A new stream attachment: its generation is unknown until its `ready`. */
  detach(): void
  /** One run frame of `project`. `gap` is true when the stream's seq fence saw lost frames. */
  run(project: string, event: WorkspaceRunEvent, gap?: boolean): void
  /** One project's usage tick. */
  usage(project: string, usage: Readonly<Record<string, ProcessUsage>>): void
  /** The project left the registry: drop its rows now, with no request. Until the project is
   *  added again (`restoreProject`), no snapshot, from any source, and no frame brings it back. */
  dropProject(project: string): void
  /** The project was added (again): its rows may enter the index. */
  restoreProject(project: string): void
  /**
   * Who recovers a frame of unknown generation. The handler returns true when it took the
   * recovery (the shared workspace source rejoins, which sends the stream's `ready` and reopens),
   * so the sync asks for no reconciliation of its own. Without a handler, or when it returns
   * false, the sync asks for one fenced reconciliation.
   */
  setUnknownGenerationHandler(handler: (() => boolean) | undefined): void
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
  let lastWrite = -Infinity
  /**
   * Two fences hold every input. Generation: every frame records the generation of the stream
   * that delivered it (its `ready`; the shared worker sends one to a late subscriber too). A frame
   * of unknown generation is not applied and asks for one fenced reconciliation. A queued patch
   * (`run`, `usage`) applies only to data of its own generation (`data.generation`), and `merge`
   * (query function, shared read, reconciliation) lays only frames of the snapshot's own
   * generation over it. Removed project: `run` and `usage` are ignored, `flush` skips queued patches, and
   * `merge` strips the project from every snapshot; only `restoreProject` lifts it, because the
   * document read and the shared read are independent sources that can answer out of order.
   * `detach` and `reconcile` pass through these same paths.
   */
  const removed = new Set<string>()
  /** A frame of unknown generation arrived since the last `ready`; it asked for a reconciliation. */
  let unknownAsked = false
  let unknownHandler: (() => boolean) | undefined
  const unknownGeneration = (): void => {
    if (unknownAsked) return
    unknownAsked = true
    if (unknownHandler?.()) return
    void reconcile({ hold: true })
  }
  const write = (next: RunsIndexResponse): void => {
    lastWrite = Date.now()
    queryClient.setQueryData<RunsIndexResponse>(RUNS_INDEX_QUERY_KEY, next)
  }

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
    let next = data
    let needsReconcile = false
    for (const patch of patches) {
      // A frame from another server generation says nothing about these rows.
      if (patch.generation !== data.generation) continue
      if (patch.type === 'usage') {
        if (!removed.has(patch.project)) next = applyIndexUsage(next, patch.project, patch.usage)
        continue
      }
      if (removed.has(patch.change.project)) continue
      // Frames the cached snapshot already includes would only move a row back in time.
      if (patch.change.seq <= data.eventSeq) continue
      const result = applyIndexChange(next, patch.change, registry)
      next = result.index
      needsReconcile ||= result.reconcile
    }
    if (next !== data) write(next)
    if (needsReconcile) void reconcile({ hold: true })
  }

  /** Leading edge: the next frame. Within the interval after a write: one timer at its end. A
   *  scheduled flush is never moved, so a stream that never goes quiet cannot postpone it. */
  const schedule = (): void => {
    if (fallback !== undefined) return
    const wait = lastWrite + RUNS_INDEX_WRITE_INTERVAL_MS - Date.now()
    if (wait > 0) {
      fallback = setTimeout(flush, wait)
      return
    }
    fallback = setTimeout(flush, FLUSH_FALLBACK_MS)
    if (typeof requestAnimationFrame === 'function') frame = requestAnimationFrame(flush)
  }

  return {
    ready(generation, seq) {
      overlayReady(overlay, generation, seq)
      unknownAsked = false
    },
    detach() {
      overlayDetach(overlay)
    },
    run(project, event, gap = false) {
      if (removed.has(project)) return
      const change = toChange(project, event)
      if (!overlayRecord(overlay, change, gap)) {
        unknownGeneration()
        return
      }
      queue.push({ type: 'change', change, generation: overlay.stream })
      schedule()
    },
    usage(project, usage) {
      if (removed.has(project)) return
      if (overlay.stream === undefined) {
        unknownGeneration()
        return
      }
      queue.push({ type: 'usage', project, usage, generation: overlay.stream })
      schedule()
    },
    dropProject(project) {
      removed.add(project)
      overlayDropProject(overlay, project)
      queue = queue.filter((patch) => (patch.type === 'change' ? patch.change.project : patch.project) !== project)
      const data = cached()
      if (!data) return
      const next = dropIndexProject(data, project)
      if (next !== data) write(next)
    },
    setUnknownGenerationHandler(handler) {
      unknownHandler = handler
    },
    restoreProject(project) {
      removed.delete(project)
    },
    merge(snapshot) {
      const result = mergeIndexSnapshot(overlay, snapshot, registryOf(queryClient))
      for (const project of removed) result.index = dropIndexProject(result.index, project)
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
