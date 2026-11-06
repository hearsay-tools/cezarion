import type { ProcessUsage, RunRecord, RunSummary } from '@open-mercato/cezar-api-client/contract/runs'
import {
  workspaceReadyEventSchema,
  workspaceRunDeletedEventSchema,
  workspaceRunSummaryEventSchema,
  workspaceUsageEventSchema,
} from '@open-mercato/cezar-api-client/contract/workspace-events'

/**
 * Parse workspace frames and patch existing query caches. HTTP snapshots remain authoritative;
 * never synthesize an unfetched run list from a partial stream.
 */

// ---- wire → typed event ------------------------------------------------------------------

/** One message from `GET /api/events` (src/server/server.ts). */
export type GlobalEvent =
  | { type: 'run'; run: RunRecord }
  | { type: 'run-deleted'; id: string }
  | { type: 'usage'; usage: Record<string, ProcessUsage> }
  | { type: 'ping' }

/**
 * Parse an SSE `event:`/`data:` pair, or null when it is not something we act on.
 *
 * Null rather than a throw: this runs on data from a socket, and one malformed frame must cost
 * one frame — not the stream, and not the app. An unknown event name is the same case (the
 * server may grow events before this client knows them).
 */
export function parseGlobalEvent(name: string, data: string): GlobalEvent | null {
  // The keep-alive carries no payload at all, so it is answered before any parsing.
  if (name === 'ping') return { type: 'ping' }

  let payload: unknown
  try {
    payload = JSON.parse(data)
  } catch {
    return null
  }

  switch (name) {
    case 'run':
      return isRunRecord(payload) ? { type: 'run', run: payload } : null
    case 'run-deleted': {
      const id = (payload as { id?: unknown } | null)?.id
      return typeof id === 'string' && id ? { type: 'run-deleted', id } : null
    }
    case 'usage':
      return isRecord(payload) ? { type: 'usage', usage: payload as Record<string, ProcessUsage> } : null
    default:
      return null
  }
}

/**
 * One message from `GET /api/v1/workspace/events?runs=summary` (hearsay-tools/cezarion#2730).
 * Run changes arrive as list rows, never full records: a summary cannot stand in for the record a
 * detail view holds. `run-summary` and `run-deleted` carry the stream's `seq`; `ready` names the
 * generation and the last `seq` before this connection.
 */
export type WorkspaceEvent =
  | { type: 'run-summary'; summary: RunSummary; seq: number; relationships: string }
  | { type: 'run-deleted'; id: string; seq: number }
  | { type: 'usage'; usage: Record<string, ProcessUsage> }
  | { type: 'ready'; generation: string; seq: number }
  | { type: 'ping' }

/** The run frames that patch caches. */
export type WorkspaceRunEvent = Extract<WorkspaceEvent, { type: 'run-summary' | 'run-deleted' }>

/**
 * Parse one summary-mode workspace frame and its project stamp (null for the unstamped `ping`
 * and `ready`). Every payload is validated against the contract. A frame that does not parse, or
 * that has no usable `project`, is dropped whole: without the stamp there is no way to know whose
 * caches it belongs in. Workspace-only event names (`project-added`, `checkout-progress`) are not
 * parsed here.
 */
export function parseWorkspaceEvent(
  name: string,
  data: string,
): { project: string | null; event: WorkspaceEvent } | null {
  if (name === 'ping') return { project: null, event: { type: 'ping' } }

  let payload: unknown
  try {
    payload = JSON.parse(data)
  } catch {
    return null
  }

  switch (name) {
    case 'run-summary': {
      const frame = workspaceRunSummaryEventSchema.safeParse(payload)
      return frame.success
        ? { project: frame.data.project, event: { type: 'run-summary', summary: frame.data.run, seq: frame.data.seq, relationships: frame.data.relationships } }
        : null
    }
    case 'run-deleted': {
      const frame = workspaceRunDeletedEventSchema.safeParse(payload)
      return frame.success ? { project: frame.data.project, event: { type: 'run-deleted', id: frame.data.id, seq: frame.data.seq } } : null
    }
    case 'usage': {
      const frame = workspaceUsageEventSchema.safeParse(payload)
      return frame.success ? { project: frame.data.project, event: { type: 'usage', usage: frame.data.usage } } : null
    }
    case 'ready': {
      const frame = workspaceReadyEventSchema.safeParse(payload)
      return frame.success ? { project: null, event: { type: 'ready', generation: frame.data.generation, seq: frame.data.seq } } : null
    }
    default:
      return null
  }
}

/**
 * The `seq` fence of one workspace connection (hearsay-tools/cezarion#2730). Within one connection
 * and generation the numbers are contiguous; a jump means lost frames. `ready` and a reopened
 * connection set a new baseline, so a new generation is a reset, not a gap. Without a baseline
 * (a document that joined a shared feed after its `ready`), the first numbered frame sets it.
 */
export function createWorkspaceSeqFence(): {
  ready: (seq: number) => void
  /** True when the frame proves that frames before it were lost. */
  frame: (seq: number) => boolean
  reset: () => void
} {
  let last: number | undefined
  return {
    ready(seq) {
      last = seq
    },
    frame(seq) {
      const gap = last !== undefined && seq !== last + 1
      last = seq
      return gap
    },
    reset() {
      last = undefined
    },
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The one field every reducer keys on. Deep-validating the record would only re-implement the
 *  server's own schema in a place that cannot enforce it. */
function isRunRecord(value: unknown): value is RunRecord {
  return isRecord(value) && typeof value.id === 'string' && value.id !== ''
}

// ---- reducers ----------------------------------------------------------------------------

/**
 * Fold a `run-summary` frame into the cached run list.
 *
 * `undefined` in → `undefined` out: the list query has not fetched, so there is nothing to patch
 * and `[summary]` would be a lie. TanStack's `setQueryData` reads an `undefined` return as "leave
 * it alone", which is exactly the intent.
 *
 * An existing row is replaced in place — the same run arriving 50 times during its life must stay
 * one row, at its position, rather than churning the list order under the reader's cursor. A new
 * one is inserted by `createdAt` descending, matching `store.listRuns()`'s order, so a run that
 * appears mid-session lands where a refetch would have put it.
 *
 * The frame's row is the one `GET /run-summaries` answers (`toRunSummary` with the live usage
 * sample laid over it), so it replaces the cached row whole: its `usage` is as current as the
 * route's, and an absent one means the run has no live sample.
 */
export function applyRunSummary(list: RunSummary[] | undefined, summary: RunSummary): RunSummary[] | undefined {
  if (!list) return undefined

  const index = list.findIndex((r) => r.id === summary.id)
  if (index >= 0) {
    const next = [...list]
    next[index] = summary
    return next
  }

  const at = list.findIndex((r) => (r.createdAt ?? '').localeCompare(summary.createdAt) < 0)
  const next = [...list]
  next.splice(at < 0 ? list.length : at, 0, summary)
  return next
}

/** Drop a deleted run. Same reference back when the id isn't there — an event about a run this
 *  cache never held must not re-render every list on screen. */
export function applyRunDeleted<T extends { id: string }>(list: T[] | undefined, id: string): T[] | undefined {
  if (!list) return undefined
  const next = list.filter((r) => r.id !== id)
  return next.length === list.length ? list : next
}

// ---- live usage --------------------------------------------------------------------------

/**
 * Ephemeral run-resource samples outside durable records and query caches. Keep stable snapshots
 * between ticks and notify only subscribed selectors.
 */
export interface UsageStore {
  subscribe(listener: () => void): () => void
  get(): Record<string, ProcessUsage>
  /** Each tick is a complete snapshot of the runs that currently have samples, so it replaces
   *  rather than merges — a run that ended must stop reporting, not keep its last number. */
  set(usage: Record<string, ProcessUsage>): void
}

export const EMPTY_USAGE: Record<string, ProcessUsage> = Object.freeze({})

export function createUsageStore(): UsageStore {
  let snapshot: Record<string, ProcessUsage> = EMPTY_USAGE
  const listeners = new Set<() => void>()
  return {
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    get: () => snapshot,
    set(usage) {
      snapshot = usage
      for (const listener of listeners) listener()
    },
  }
}
