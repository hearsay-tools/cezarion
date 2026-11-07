import { isReferenceStatus } from '@/lib/reference-status'
import type { ReferenceStatus } from '@open-mercato/cezar-api-client'

/** One chip's identity: which project's forge to ask, and about what. */
export interface ReferenceStatusRequest {
  projectId: string
  kind: 'PR' | 'Issue'
  number: number
}

/**
 * What is known about one chip — the status if we have ever learned it, AND what the request
 * covering it is doing, which are genuinely different questions.
 *
 * They were one question at first (`status | undefined`), and that was the bug behind "the chips
 * sometimes just go blank": `undefined` collapsed *still loading*, *GitHub is unreachable*, *there
 * is no such number* and *we already know this one, the batch was merely re-keyed* into one silent
 * neutral chip, with no way for the chip to say which of them had happened.
 */
export interface ReferenceStatusEntry {
  /** The last status we ever learned for this reference. Kept across refetches, re-keyed batches
   *  and forge failures — only ever REPLACED by a newer answer, never cleared by one that failed
   *  to arrive. */
  status?: ReferenceStatus | undefined
  /**
   * What the request covering this reference is doing right now:
   *  - `idle` — nothing has asked about it (no provider, or past the per-project cap);
   *  - `loading` — its request is in flight;
   *  - `ready` — the forge answered, and `status` is that answer;
   *  - `unknown` — the forge answered and does not have this number;
   *  - `unavailable` — the forge could not be reached (`reason` says why).
   */
  state: 'idle' | 'loading' | 'ready' | 'unknown' | 'unavailable'
  /** Only on `unavailable` — the server's human hint ("gh CLI not found…"). */
  reason?: string | undefined
  /**
   * Does this pull request's branch refuse to merge into its base? The second axis the status
   * cannot carry (`conflicts` in the contract), remembered on exactly the same terms as `status`.
   *
   * `undefined` means NOTHING IS KNOWN — no answer yet, or a server from before the field existed
   * — and is not the same as `false`, which is the forge having told us it merges cleanly. Only
   * `true` may paint anything.
   */
  conflicting?: boolean | undefined
}

export type ReferenceStatusLookup = (ref: ReferenceStatusRequest) => ReferenceStatusEntry

/**
 * Remember last-known status per reference across changing batch keys. Only forge answers
 * populate it; failures retain the prior value and its stale indication.
 */
export const rememberedStatuses = new Map<string, ReferenceStatus>(restoreRememberedStatuses())
/** Bounded like the server's own caches. Insertion-ordered, so the least recently learned goes. */
const REMEMBERED_MAX = 1000

export function rememberStatus(key: string, status: ReferenceStatus): void {
  if (rememberedStatuses.get(key) === status) return
  // Re-inserted rather than overwritten, so a status still being looked at stays young in the
  // eviction order.
  rememberedStatuses.delete(key)
  rememberedStatuses.set(key, status)
  while (rememberedStatuses.size > REMEMBERED_MAX) {
    const oldest = rememberedStatuses.keys().next().value
    if (oldest === undefined) break
    rememberedStatuses.delete(oldest)
  }
  scheduleRememberedSave()
}

/**
 * Remember only known conflicts. Remove resolved conflicts on false answers; absence means
 * unknown.
 */
export const rememberedConflicts = new Set<string>(restoreRememberedConflicts())

export function rememberConflict(key: string, conflicting: boolean): void {
  if (rememberedConflicts.has(key) === conflicting) return
  if (conflicting) {
    rememberedConflicts.add(key)
    // Bounded on the same terms as the statuses; insertion-ordered, so the oldest goes first.
    while (rememberedConflicts.size > REMEMBERED_MAX) {
      const oldest = rememberedConflicts.values().next().value
      if (oldest === undefined) break
      rememberedConflicts.delete(oldest)
    }
  } else {
    rememberedConflicts.delete(key)
  }
  scheduleRememberedSave()
}

/**
 * Persist last-known reference values in best-effort sessionStorage, scoped to this tab’s
 * lifetime. A live answer replaces them; unavailable forge data remains labelled last known.
 */
export const REMEMBERED_STORAGE_KEY = 'cez.reference-statuses.v1'
/** The conflict axis, under its own key rather than inside the payload above: the status file's
 *  format is read by every bundle that has ever run in this tab, and widening its entries would
 *  make an older one discard every status it found there. A key it has never heard of it simply
 *  never reads. */
export const REMEMBERED_CONFLICTS_STORAGE_KEY = 'cez.reference-conflicts.v1'

/** Exported for tests: it runs once at module load, which is not a moment a test can observe. */
export function restoreRememberedStatuses(): [string, ReferenceStatus][] {
  try {
    const raw = globalThis.sessionStorage?.getItem(REMEMBERED_STORAGE_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (entry): entry is [string, ReferenceStatus] =>
        // The status is checked against the vocabulary this bundle knows, not merely against
        // `string`: the payload may have been written by a NEWER cockpit in this same tab (it
        // survives reloads, and a server rollback does not clear it), and a value added after
        // this bundle shipped must degrade to the neutral chip rather than be painted with a
        // presentation that does not exist.
        Array.isArray(entry) && entry.length === 2 && typeof entry[0] === 'string' && isReferenceStatus(entry[1]),
    )
  } catch {
    return []
  }
}

/** Exported for tests, like its sibling. A key list, and anything else in the slot is ignored —
 *  the file is best-effort in every direction. */
export function restoreRememberedConflicts(): string[] {
  try {
    const raw = globalThis.sessionStorage?.getItem(REMEMBERED_CONFLICTS_STORAGE_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((key): key is string => typeof key === 'string')
  } catch {
    return []
  }
}

let rememberedSave: ReturnType<typeof setTimeout> | undefined
function scheduleRememberedSave(): void {
  // Coalesced: a table's worth of statuses arrives as one response and would otherwise stringify
  // the whole map once per reference.
  if (rememberedSave !== undefined) return
  rememberedSave = setTimeout(() => {
    rememberedSave = undefined
    try {
      globalThis.sessionStorage?.setItem(REMEMBERED_STORAGE_KEY, JSON.stringify([...rememberedStatuses]))
      // One timer, two slots: both are written by the same responses, so a second scheduler would
      // only mean a second stringify pass over the same arrival.
      globalThis.sessionStorage?.setItem(
        REMEMBERED_CONFLICTS_STORAGE_KEY,
        JSON.stringify([...rememberedConflicts]),
      )
    } catch {
      // Quota, private mode, storage disabled — the in-memory map still works.
    }
  }, 250)
}

/** Test-only: the memory is module-level AND persisted, so one case's statuses would leak into
 *  the next — and, without clearing the store, into the next run of the suite. */
export function __clearRememberedStatusesForTests(): void {
  rememberedStatuses.clear()
  rememberedConflicts.clear()
  clearTimeout(rememberedSave)
  rememberedSave = undefined
  try {
    globalThis.sessionStorage?.removeItem(REMEMBERED_STORAGE_KEY)
    globalThis.sessionStorage?.removeItem(REMEMBERED_CONFLICTS_STORAGE_KEY)
  } catch {
    // Nothing to clear.
  }
}

