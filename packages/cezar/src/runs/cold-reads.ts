import type { RawExtras } from './raw-record.ts';
import type { RunRecord } from './store.ts';

/** A row as the store last read or wrote it (see `RunStore.base`). */
export interface StoredRow {
  revision: number;
  /** The row's insertion order, where it lists among runs created in the same millisecond. */
  seq: number;
  data: string;
  extras?: RawExtras | undefined;
}

/** Just the `StoredRow` part of a `coldBase` entry. */
export function storedRow({ revision, seq, data, extras }: StoredRow): StoredRow {
  return { revision, seq, data, extras };
}

/**
 * The cold reads of one `RunStore.withReadCache` scope (hearsay-tools/cezarion#2378): the frozen
 * copy of each run that was not held, with the row revision it was decoded from. Every read of the
 * scope shares it, so a family reconcile pass decodes each member once, not once per message.
 *
 * The store keeps each entry at its run's `coldBase` revision: a decode of another revision drops
 * it (`at`), and a run that leaves memory or is deleted leaves it (`forget`). A held run is always
 * read from memory first, and a write holds its run, so no read after a write sees the copy from
 * before it. Synchronous and re-entrant: the cache ends with the outermost scope, inside the turn
 * that `coldBase` fences.
 */
export class ColdReadCache {
  private entries: Map<string, { revision: number; run: RunRecord }> | undefined;

  scope<T>(fn: () => T): T {
    if (this.entries) return fn();
    this.entries = new Map();
    try { return fn(); } finally { this.entries = undefined; }
  }

  get(id: string): RunRecord | undefined { return this.entries?.get(id)?.run; }

  /** The cached copy when it was decoded from `revision`; one decoded from another is dropped. */
  at(id: string, revision: number): RunRecord | undefined {
    const entry = this.entries?.get(id);
    if (entry && entry.revision !== revision) this.entries!.delete(id);
    return entry?.revision === revision ? entry.run : undefined;
  }

  /** Keep a cold answer for the rest of the scope. A held run (`held`) needs none. */
  keep(run: RunRecord, read: StoredRow | undefined, held: boolean): RunRecord {
    if (this.entries && read && !held) this.entries.set(run.id, { revision: read.revision, run });
    return run;
  }

  forget(id: string): void { this.entries?.delete(id); }

  /** A mutable copy of the cached read for a write that has just claimed its family: when the row
   *  is still at the revision that read decoded, it is the claimed version, without a second
   *  decode. Its fence entry (`read`) is then owned. */
  claimed(id: string, read: (StoredRow & { owned: boolean }) | undefined, currentRevision: () => number | undefined): RunRecord | undefined {
    const entry = this.entries?.get(id);
    if (!entry || read?.revision !== entry.revision || currentRevision() !== entry.revision) return undefined;
    read.owned = true;
    return structuredClone(entry.run);
  }
}
