import { replaceEqualDeep } from '@tanstack/react-query'
import type { ProcessUsage, RunIndexEntry, RunsIndexResponse, RunSummary } from '@open-mercato/cezar-api-client'

/**
 * The workspace runs index as a cache that stream frames patch (hearsay-tools/cezarion#2729).
 *
 * Pure: every function takes the cached `GET /workspace/runs-index` answer and returns the next
 * one, or the same object when nothing changed. `runs-index-sync.ts` wires them to the query cache.
 *
 * Rows are keyed by `(projectId, id)`. A row comes only from a snapshot or from a `run-summary`
 * frame's `run` plus the frame's `project`: the frame's row is exactly the row the route returns,
 * so a patch never invents fields. `referenceStatuses` are cache-only server reads; a patch never
 * touches them, and only a snapshot refreshes them.
 *
 * The index holds every unarchived root run of each project and its newest `perProjectLimit`
 * archived roots by `createdAt`. A project in `truncated` has archived roots past that window. A
 * change that moves the window of such a project is patched, and the result asks for a
 * reconciliation, because the row that enters the window is not on the client.
 */

/** One run frame from the workspace stream, reduced to what the index needs. */
export type IndexChange =
  | { type: 'run'; project: string; seq: number; run: RunSummary }
  | { type: 'deleted'; project: string; seq: number; id: string }

/** A patched index, and whether only a full snapshot can make it exact. */
export interface IndexPatch {
  index: RunsIndexResponse
  reconcile: boolean
}

/** The overlay key of a row: `id` is unique only within one project. */
export function indexKey(project: string, id: string): string {
  return JSON.stringify([project, id])
}

function changeId(change: IndexChange): string {
  return change.type === 'run' ? change.run.id : change.id
}

function withRuns(index: RunsIndexResponse, runs: RunIndexEntry[]): RunsIndexResponse {
  return { ...index, runs }
}

function archivedCount(runs: readonly RunIndexEntry[], project: string): number {
  let count = 0
  for (const row of runs) if (row.projectId === project && row.archived) count += 1
  return count
}

/** Insert by `createdAt`, newest first, as the route sorts. */
function insertRow(runs: readonly RunIndexEntry[], row: RunIndexEntry): RunIndexEntry[] {
  const at = runs.findIndex((r) => (r.createdAt ?? '').localeCompare(row.createdAt) < 0)
  const next = [...runs]
  next.splice(at < 0 ? runs.length : at, 0, row)
  return next
}

/**
 * Whether the index may take rows of `project` without a snapshot. `registry` is the id set of
 * the registered projects when the cockpit holds it. Without it, a project is known when the index
 * already holds one of its rows.
 */
function isKnownProject(index: RunsIndexResponse, project: string, registry: ReadonlySet<string> | undefined): boolean {
  if (registry) return registry.has(project)
  return index.runs.some((row) => row.projectId === project)
}

/**
 * Fold one run frame into the index.
 *
 * - Membership is root-only: a worker row never enters, and a row that turns into a worker leaves.
 * - Update replaces the row in place and keeps the old object when the rows are deep-equal.
 * - Create inserts at the row's `createdAt` position.
 * - Archive and unarchive are exact for a project that is not truncated. In a truncated project,
 *   they move the window boundary: the row is patched and the result asks for a reconciliation.
 *   An archived row the truncated index does not hold is outside the window and stays out.
 * - Delete removes the row. Deleting an archived row of a truncated project asks for a
 *   reconciliation, because the next archived row enters the window.
 * - A frame of a project the cockpit does not know is not applied and asks for a reconciliation.
 */
export function applyIndexChange(
  index: RunsIndexResponse,
  change: IndexChange,
  registry?: ReadonlySet<string>,
): IndexPatch {
  const { project } = change
  const id = changeId(change)
  const at = index.runs.findIndex((row) => row.projectId === project && row.id === id)
  const previous = at >= 0 ? index.runs[at] : undefined
  const truncated = index.truncated.includes(project)

  if (change.type === 'deleted') {
    if (!previous) return { index, reconcile: false }
    return {
      index: withRuns(index, index.runs.filter((_, position) => position !== at)),
      reconcile: truncated && previous.archived,
    }
  }

  const { run } = change
  if (run.delegation?.role === 'worker') {
    return previous ? { index: withRuns(index, index.runs.filter((_, position) => position !== at)), reconcile: false } : { index, reconcile: false }
  }
  if (!previous && !isKnownProject(index, project, registry)) return { index, reconcile: true }

  const row = replaceEqualDeep(previous, { projectId: project, ...run } satisfies RunIndexEntry) as RunIndexEntry
  if (previous) {
    if (row === previous) return { index, reconcile: false }
    const runs = [...index.runs]
    runs[at] = row
    // Archive or unarchive: the window of a truncated project moves; a project that was complete
    // becomes truncated once it holds more archived rows than the window.
    const boundary = previous.archived !== row.archived
      && (truncated || archivedCount(runs, project) > index.perProjectLimit)
    return { index: withRuns(index, runs), reconcile: boundary }
  }
  // An archived row the index does not hold: outside a truncated project's window, or a row of a
  // complete project that was never seen. Only the second one belongs in the index.
  if (row.archived && truncated) return { index, reconcile: false }
  const runs = insertRow(index.runs, row)
  return {
    index: withRuns(index, runs),
    reconcile: row.archived && archivedCount(runs, project) > index.perProjectLimit,
  }
}

/**
 * One project's live usage tick. It is the complete set of that project's samples: a row with a
 * sample takes it, and a row without one loses its old sample. An empty tick clears the project.
 */
export function applyIndexUsage(
  index: RunsIndexResponse,
  project: string,
  usage: Readonly<Record<string, ProcessUsage>>,
): RunsIndexResponse {
  let changed = false
  const runs = index.runs.map((row) => {
    if (row.projectId !== project) return row
    const sample = usage[row.id]
    if (sample) {
      const next = replaceEqualDeep(row.usage, sample) as ProcessUsage
      if (next === row.usage) return row
      changed = true
      return { ...row, usage: next }
    }
    if (row.usage === undefined) return row
    changed = true
    const { usage: _dropped, ...rest } = row
    return rest
  })
  return changed ? withRuns(index, runs) : index
}

/** A removed project leaves the index whole: its rows, its `truncated` entry and its statuses. */
export function dropIndexProject(index: RunsIndexResponse, project: string): RunsIndexResponse {
  const runs = index.runs.filter((row) => row.projectId !== project)
  const truncated = index.truncated.filter((id) => id !== project)
  const hasStatuses = Object.prototype.hasOwnProperty.call(index.referenceStatuses, project)
  if (runs.length === index.runs.length && truncated.length === index.truncated.length && !hasStatuses) return index
  const referenceStatuses = { ...index.referenceStatuses }
  delete referenceStatuses[project]
  return { ...index, runs, truncated, referenceStatuses }
}

/**
 * The frames this document heard, kept until a snapshot includes them.
 *
 * - `generation` is the server process the frames came from: the stream's `ready`, or the first
 *   snapshot when this document joined the shared feed after its `ready`.
 * - `floor`: every frame above it is in `changes`. Undefined until the stream sets a baseline.
 * - `changes`: the newest frame per row key, deletes included (tombstones).
 */
export interface IndexOverlay {
  generation: string | undefined
  /** True when `generation` came from the stream's `ready`, not from a snapshot. */
  streamGeneration: boolean
  floor: number | undefined
  changes: Map<string, IndexChange>
}

export function createIndexOverlay(): IndexOverlay {
  return { generation: undefined, streamGeneration: false, floor: undefined, changes: new Map() }
}

/** A stream attachment. Another generation is a reset. In the same generation, frames up to
 *  `seq` may have passed while detached, so the overlay covers only frames above it. */
export function overlayReady(overlay: IndexOverlay, generation: string, seq: number): void {
  if (overlay.generation !== generation) {
    overlay.changes.clear()
    overlay.generation = generation
    overlay.floor = seq
  } else {
    overlay.floor = Math.max(overlay.floor ?? seq, seq)
  }
  overlay.streamGeneration = true
}

/**
 * Record one frame. `gap` says frames before it were lost: the overlay then covers only frames
 * from this one on. The first frame without a `ready` sets the baseline the same way.
 */
export function overlayRecord(overlay: IndexOverlay, change: IndexChange, gap = false): void {
  if (overlay.floor === undefined || gap) overlay.floor = change.seq - 1
  const key = indexKey(change.project, changeId(change))
  const held = overlay.changes.get(key)
  if (!held || held.seq < change.seq) overlay.changes.set(key, change)
}

/** A removed project's frames must not bring its rows back at the next snapshot. */
export function overlayDropProject(overlay: IndexOverlay, project: string): void {
  for (const [key, change] of overlay.changes) if (change.project === project) overlay.changes.delete(key)
}

function hasFence(snapshot: RunsIndexResponse): boolean {
  return typeof snapshot.generation === 'string' && typeof snapshot.eventSeq === 'number'
}

/**
 * Fence a snapshot against the frames this document already applied. Every snapshot passes
 * here: the query function, the shared live read and each reconciliation.
 *
 * - Another generation: when the overlay's generation came from the stream, the snapshot is from
 *   a process this stream no longer hears. It is kept unpatched and asks for a reconciliation.
 *   Otherwise the overlay resets to the snapshot's generation.
 * - A frame above `eventSeq` is newer than the snapshot and is laid over it.
 * - A frame at or below `eventSeq` is in the snapshot and leaves the overlay.
 * - A snapshot older than the overlay's floor misses frames the overlay no longer holds: the
 *   result asks for one more reconciliation.
 */
export function mergeIndexSnapshot(
  overlay: IndexOverlay,
  snapshot: RunsIndexResponse,
  registry?: ReadonlySet<string>,
): IndexPatch {
  if (!hasFence(snapshot)) return { index: snapshot, reconcile: false }
  if (overlay.generation !== undefined && overlay.generation !== snapshot.generation) {
    if (overlay.streamGeneration) return { index: snapshot, reconcile: true }
    overlay.changes.clear()
    overlay.floor = undefined
  }
  overlay.generation = snapshot.generation
  const eventSeq = snapshot.eventSeq
  const missed = overlay.floor !== undefined && eventSeq < overlay.floor
  let index = snapshot
  let reconcile = missed
  const newer = [...overlay.changes.values()].filter((change) => change.seq > eventSeq).sort((a, b) => a.seq - b.seq)
  for (const change of newer) {
    const patch = applyIndexChange(index, change, registry)
    index = patch.index
    reconcile ||= patch.reconcile
  }
  for (const [key, change] of overlay.changes) if (change.seq <= eventSeq) overlay.changes.delete(key)
  if (!missed && overlay.floor !== undefined) overlay.floor = eventSeq
  return { index, reconcile }
}
