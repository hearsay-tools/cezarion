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
 *   A row a truncated index does not hold is placed by the window edge (`applyToTruncatedWindow`).
 * - Delete removes the row. Deleting an archived row of a truncated project asks for a
 *   reconciliation, because the next archived row enters the window. A delete of a row the index
 *   does not hold cannot be placed (it may be a worker) and changes nothing: a `truncated` it
 *   made stale heals at the next reconciliation or backstop read.
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
  if (truncated) return applyToTruncatedWindow(index, row)
  const runs = insertRow(index.runs, row)
  return {
    index: withRuns(index, runs),
    reconcile: row.archived && archivedCount(runs, project) > index.perProjectLimit,
  }
}

/** The `createdAt` of the oldest archived row a truncated project still holds: the window edge. */
function windowEdge(runs: readonly RunIndexEntry[], project: string): string | undefined {
  let edge: string | undefined
  for (const row of runs) {
    if (row.projectId === project && row.archived && (edge === undefined || row.createdAt < edge)) edge = row.createdAt
  }
  return edge
}

/**
 * A row the index does not hold, in a truncated project. The window edge tells where it was:
 *
 * - unarchived and older than the edge: it was unarchived from beyond the window, so the project
 *   may no longer be truncated. Insert it and reconcile.
 * - unarchived otherwise: a create. Insert it; the window is unchanged.
 * - archived and newer than the edge: it belongs in the window, and the window's oldest row leaves.
 *   Insert it and reconcile.
 * - archived otherwise: beyond the window. It stays out.
 *
 * With no held archived row there is no edge, so an unarchived row reconciles to stay honest.
 */
function applyToTruncatedWindow(index: RunsIndexResponse, row: RunIndexEntry): IndexPatch {
  const edge = windowEdge(index.runs, row.projectId)
  const insideWindow = edge !== undefined && row.createdAt > edge
  if (row.archived && !insideWindow) return { index, reconcile: false }
  return { index: withRuns(index, insertRow(index.runs, row)), reconcile: row.archived || edge === undefined || row.createdAt < edge }
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

/** A recorded frame and the generation of the stream that delivered it. */
export type OverlayEntry = IndexChange & { generation: string }

/**
 * The frames this document heard, kept until a snapshot of their generation includes them.
 *
 * - `stream`: the generation of the stream delivering frames now, from its `ready`. Undefined
 *   from a new attachment (`overlayDetach`) until its `ready`: a frame then has no known
 *   generation and is not recorded.
 * - `lastStream`: the last generation a `ready` named. `floor` belongs to it.
 * - `floor`: within `lastStream`, every frame above it is in `changes`.
 * - `changes`: the newest frame per row key, deletes included (tombstones), each with its own
 *   generation. A merge uses only the entries of the snapshot's generation.
 */
export interface IndexOverlay {
  stream: string | undefined
  lastStream: string | undefined
  /** The last snapshot generation that disagreed with the stream's. It asks for one
   *  reconciliation, not one per snapshot: the stream's next `ready` settles which is current. */
  mismatch: string | undefined
  floor: number | undefined
  changes: Map<string, OverlayEntry>
}

export function createIndexOverlay(): IndexOverlay {
  return { stream: undefined, lastStream: undefined, mismatch: undefined, floor: undefined, changes: new Map() }
}

/** A stream `ready`. Another generation than the last one is a reset: frames of other
 *  generations leave. In the same generation, frames up to `seq` may have passed while
 *  detached, so the overlay covers only frames above it. */
export function overlayReady(overlay: IndexOverlay, generation: string, seq: number): void {
  if (overlay.lastStream === generation) {
    overlay.floor = Math.max(overlay.floor ?? seq, seq)
  } else {
    for (const [key, entry] of overlay.changes) if (entry.generation !== generation) overlay.changes.delete(key)
    overlay.floor = seq
  }
  overlay.stream = generation
  overlay.lastStream = generation
  overlay.mismatch = undefined
}

/** A new attachment: until its `ready`, the stream's generation is unknown. */
export function overlayDetach(overlay: IndexOverlay): void {
  overlay.stream = undefined
}

/**
 * Record one frame of the current stream generation. `gap` says frames before it were lost: the
 * overlay then covers only frames from this one on. Returns false, recording nothing, while the
 * stream's generation is unknown.
 */
export function overlayRecord(overlay: IndexOverlay, change: IndexChange, gap = false): boolean {
  const generation = overlay.stream
  if (generation === undefined) return false
  if (overlay.floor === undefined || gap) overlay.floor = change.seq - 1
  const key = JSON.stringify([generation, change.project, changeId(change)])
  const held = overlay.changes.get(key)
  if (!held || held.seq < change.seq) overlay.changes.set(key, { ...change, generation })
  return true
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
 * - Another generation than the stream's: the snapshot is from a process this stream does not
 *   hear. It is kept unpatched and asks for one reconciliation per such generation, so a stream
 *   that stays down cannot cause a read loop.
 * - Only frames of the snapshot's own generation touch it: one above `eventSeq` is newer and is
 *   laid over it; one at or below `eventSeq` is in the snapshot and leaves the overlay.
 * - A snapshot of the last stream generation older than the overlay's floor misses frames the
 *   overlay no longer holds: the result asks for one more reconciliation.
 */
export function mergeIndexSnapshot(
  overlay: IndexOverlay,
  snapshot: RunsIndexResponse,
  registry?: ReadonlySet<string>,
): IndexPatch {
  if (!hasFence(snapshot)) return { index: snapshot, reconcile: false }
  const { generation, eventSeq } = snapshot
  if (overlay.stream !== undefined && overlay.stream !== generation) {
    const first = overlay.mismatch !== generation
    overlay.mismatch = generation
    return { index: snapshot, reconcile: first }
  }
  const covered = overlay.lastStream === generation && overlay.floor !== undefined
  const missed = covered && eventSeq < overlay.floor!
  let index = snapshot
  let reconcile = missed
  const own = [...overlay.changes.entries()].filter(([, entry]) => entry.generation === generation)
  const newer = own.map(([, entry]) => entry).filter((entry) => entry.seq > eventSeq).sort((a, b) => a.seq - b.seq)
  for (const change of newer) {
    const patch = applyIndexChange(index, change, registry)
    index = patch.index
    reconcile ||= patch.reconcile
  }
  for (const [key, entry] of own) if (entry.seq <= eventSeq) overlay.changes.delete(key)
  if (covered && !missed) overlay.floor = eventSeq
  return { index, reconcile }
}
