/**
 * The few transcript facts the delegation reconcile and message delivery ask about, folded as
 * events are appended so those paths never re-read a whole transcript (hearsay-tools/cezarion#880).
 * Spec: docs/superpowers/specs/2026-10-07-transcript-facts-index-design.md.
 */
import { randomBytes } from 'node:crypto';
import { renameSync, rmSync, writeFileSync } from 'node:fs';
import { type RunEvent } from '@open-mercato/cezar-contract';
import { historyPaths, historyStat, readHistoryTextAsync } from './history-file.ts';

export { emptyFacts, foldEvent, foldText, stampOf, PROSE_HUMAN_GATE, workerOutcomeKey, type PendingAskFacts, type ArchiveStamp, type TranscriptFacts } from './transcript-facts-fold.ts';
import { emptyFacts, foldEvent, foldText, sameStamp, stampOf, type ArchiveStamp, type TranscriptFacts } from './transcript-facts-fold.ts';
import { loadTranscriptFacts, readFactsSidecar } from './transcript-facts-load.ts';

interface Entry { facts: TranscriptFacts; written: number }

/**
 * Per-run `runs/<id>.facts.json`, kept current by `append` and checked against the transcript on
 * first use in a process: its byte length while it is plain, its stat once it is archived.
 * A cache: anything unreadable or stale is rebuilt from the transcript.
 */
export class TranscriptFactsIndex {
  private readonly entries = new Map<string, Entry>();
  private readonly warnedWrite = new Set<string>();
  private stopped = false;

  constructor(private readonly dataDir: string) {}

  /** Undefined only when the transcript exists but cannot be read; that answer is not cached. */
  get(runId: string): Readonly<TranscriptFacts> | undefined {
    return this.entry(runId)?.facts;
  }

  /** After `line` (of `lineBytes` bytes) was appended to the plain transcript. */
  append(runId: string, event: RunEvent, lineBytes: number): void {
    const cached = this.entries.get(runId);
    // A first load reads the transcript, which already holds this line. So does a reload when
    // the transcript is not exactly the cached bytes plus this line: another writer got there.
    if (!cached || historyStat(this.dataDir, runId).plainSize !== cached.facts.bytes + lineBytes) {
      this.entries.delete(runId);
      this.entry(runId);
      return;
    }
    delete cached.facts.archive;
    const changed = foldEvent(cached.facts, event);
    cached.facts.bytes += lineBytes;
    if (changed) this.persist(runId, cached);
  }

  /** The compressor archived `plain` as a `.br` with `stamp`. */
  adoptArchive(runId: string, plain: Buffer, stamp: ArchiveStamp): void {
    let entry = this.entries.get(runId);
    if (!entry || entry.facts.bytes !== plain.length) {
      const facts = emptyFacts();
      foldText(facts, plain.toString('utf8'));
      entry = { facts, written: -1 };
      this.entries.set(runId, entry);
    }
    entry.facts.archive = stamp;
    this.persist(runId, entry);
  }

  /** Persist every entry whose byte count moved since its last write. */
  flush(): void {
    for (const [runId, entry] of this.entries) if (entry.written !== entry.facts.bytes) this.persist(runId, entry);
  }

  forget(runId: string): void {
    this.entries.delete(runId);
  }

  /**
   * Build, off the event loop, every index a first `get` would have to rebuild from the whole
   * transcript: one run at a time, async reads and async brotli. A run some reader loaded first,
   * or whose transcript moved meanwhile, is left to `get`. Never throws.
   */
  async warm(runIds: Iterable<string>): Promise<void> {
    for (const runId of runIds) {
      if (this.stopped) return;
      if (this.entries.has(runId)) continue;
      try {
        const stored = readFactsSidecar(historyPaths(this.dataDir, runId).facts);
        const before = historyStat(this.dataDir, runId);
        const current = before.plainSize !== undefined ? !!stored && before.plainSize >= stored.bytes
          : !before.archive || (!!stored && sameStamp(stored.archive, stampOf(before.archive)));
        if (current) continue;
        const text = await readHistoryTextAsync(this.dataDir, runId);
        if (this.stopped || this.entries.has(runId)) continue;
        const after = historyStat(this.dataDir, runId);
        if (after.plainSize !== before.plainSize || (before.archive && (!after.archive || !sameStamp(stampOf(before.archive), stampOf(after.archive))))) continue;
        const facts = emptyFacts();
        if (text !== undefined) foldText(facts, text);
        if (after.archive) facts.archive = stampOf(after.archive);
        const entry = { facts, written: -1 };
        this.entries.set(runId, entry);
        this.persist(runId, entry);
      } catch { /* the first `get` rebuilds it */ }
    }
  }

  /** Stop warming (store close). */
  stop(): void {
    this.stopped = true;
  }

  private entry(runId: string): Entry | undefined {
    const cached = this.entries.get(runId);
    if (cached && this.current(runId, cached.facts)) return cached;
    // Another process may have written the transcript since: reload from the sidecar and tail.
    if (cached) this.entries.delete(runId);
    const loaded = loadTranscriptFacts(this.dataDir, runId);
    if (!loaded) return undefined;
    const entry = { facts: loaded.facts, written: loaded.written };
    try { if (loaded.needsWrite) this.persist(runId, entry); } catch { return undefined; }
    this.entries.set(runId, entry);
    return entry;
  }

  /** A cache hit costs one stat (two once archived): the run may have changed hands (a second
   *  process on the project, an adopted family) since these facts were cached. */
  private current(runId: string, facts: TranscriptFacts): boolean {
    try {
      const { plainSize, archive } = historyStat(this.dataDir, runId);
      if (plainSize !== undefined) return plainSize === facts.bytes;
      if (archive) return sameStamp(facts.archive, stampOf(archive));
      return facts.bytes === 0;
    } catch {
      return false;
    }
  }

  private persist(runId: string, entry: Entry): void {
    const path = historyPaths(this.dataDir, runId).facts;
    const tmp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(entry.facts), { mode: 0o600 });
      renameSync(tmp, path);
      entry.written = entry.facts.bytes;
    } catch (error) {
      rmSync(tmp, { force: true });
      if (!this.warnedWrite.has(runId)) {
        this.warnedWrite.add(runId);
        console.warn(`[cez] could not save transcript facts for ${runId}: ${(error as Error).message}`);
      }
    }
  }
}
