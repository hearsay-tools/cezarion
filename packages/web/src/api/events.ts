import { toRunSummary, type ApiRun, type ProcessUsage, type RunRecord, type RunSummary } from '@open-mercato/cezar-api-client/contract/runs'

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
 * One message from `GET /api/workspace/events` (multi-project spec, step 2.8): the same events
 * as the legacy stream, each stamped with the owning project — additively where the legacy
 * payload is an object (`run` grows a `project` key, `run-deleted` is `{id, project}`), wrapped
 * where it is not (`usage` → `{project, usage}`). This parser
 * unwraps the envelope back to today's `GlobalEvent` so the reducers below never learn the wire
 * changed; the caller dispatches or drops on `project` (null only for the unstamped `ping`).
 *
 * A stamped event with no usable `project` is dropped whole: without the stamp there is no way
 * to know whose caches it belongs in, and guessing is exactly the cross-project bleed the
 * envelope exists to prevent. Workspace-only event names (`project-added`, `checkout-progress`)
 * are not parsed here — no listener subscribes to them yet.
 */
export function parseWorkspaceEvent(
  name: string,
  data: string,
): { project: string | null; event: GlobalEvent } | null {
  if (name === 'ping') return { project: null, event: { type: 'ping' } }

  let payload: unknown
  try {
    payload = JSON.parse(data)
  } catch {
    return null
  }
  if (!isRecord(payload)) return null
  const project = payload.project
  if (typeof project !== 'string' || project === '') return null

  switch (name) {
    case 'run': {
      // Strip the stamp: the reducers (and the cache) must see today's bare RunRecord.
      const { project: _stamp, ...run } = payload
      return isRunRecord(run) ? { project, event: { type: 'run', run } } : null
    }
    case 'run-deleted': {
      const id = payload.id
      return typeof id === 'string' && id ? { project, event: { type: 'run-deleted', id } } : null
    }
    case 'usage':
      return isRecord(payload.usage)
        ? { project, event: { type: 'usage', usage: payload.usage as Record<string, ProcessUsage> } }
        : null
    default:
      return null
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
 * Fold a `run` event into the cached run list.
 *
 * `undefined` in → `undefined` out: the list query has not fetched, so there is nothing to patch
 * and `[run]` would be a lie. TanStack's `setQueryData` reads an `undefined` return as "leave it
 * alone", which is exactly the intent.
 *
 * An existing row is replaced in place — the same run arriving 50 times during its life must stay
 * one row, at its position, rather than churning the list order under the reader's cursor. A new
 * one is inserted by `createdAt` descending, matching `store.listRuns()`'s order, so a run that
 * appears mid-session lands where a refetch would have put it.
 *
 * The list holds summaries (#817), and the stream carries the full record, so every row written
 * here goes through `toRunSummary`, the same projection `GET /run-summaries` uses. A list row
 * never holds a field its route would not have sent.
 */
export function applyRunEvent(list: RunSummary[] | undefined, run: RunRecord): RunSummary[] | undefined {
  if (!list) return undefined

  const index = list.findIndex((r) => r.id === run.id)
  if (index >= 0) {
    const next = [...list]
    next[index] = mergeSummary(list[index], run)
    return next
  }

  // `?? ''` because only `id` is validated on the way in: a record missing `createdAt` must sort
  // last, not throw and take the stream's message loop with it.
  const createdAt = run.createdAt ?? ''
  const at = list.findIndex((r) => (r.createdAt ?? '').localeCompare(createdAt) < 0)
  const next = [...list]
  next.splice(at < 0 ? list.length : at, 0, toRunSummary(run))
  return next
}

/** Drop a deleted run. Same reference back when the id isn't there — an event about a run this
 *  cache never held must not re-render every list on screen. */
export function applyRunDeleted<T extends { id: string }>(list: T[] | undefined, id: string): T[] | undefined {
  if (!list) return undefined
  const next = list.filter((r) => r.id !== id)
  return next.length === list.length ? list : next
}

/**
 * The stream's record over the cached one.
 *
 * `usage` is carried over rather than dropped: the global `run` event is a bare `RunRecord`, while
 * `GET /api/runs` answers with the live sample attached (`withUsage`). An absent field on the wire
 * means "this message doesn't carry it", not "there is none" — overwriting would blink the sample
 * out on every status change. Freshness for it comes from the `usage` ticks either way.
 */
export function mergeRun(previous: ApiRun | undefined, run: RunRecord): ApiRun {
  return previous?.usage ? { ...run, usage: previous.usage } : run
}

/** `mergeRun` for a list row: the same `usage` carry-over, then the summary projection. */
export function mergeSummary(previous: RunSummary | undefined, run: RunRecord): RunSummary {
  return toRunSummary(previous?.usage ? { ...run, usage: previous.usage } : run)
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
