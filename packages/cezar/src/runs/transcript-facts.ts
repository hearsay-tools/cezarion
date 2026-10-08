/**
 * The few transcript facts the delegation reconcile and message delivery ask about, folded as
 * events are appended so those paths never re-read a whole transcript (hearsay-tools/cezarion#880).
 * Spec: docs/superpowers/specs/2026-10-07-transcript-facts-index-design.md.
 */
import { randomBytes } from 'node:crypto';
import { renameSync, rmSync, writeFileSync } from 'node:fs';
import { type RunEvent } from '@open-mercato/cezar-contract';
import { historyPaths, historyStat } from './history-file.ts';

export { emptyFacts, foldEvent, foldText, stampOf, PROSE_HUMAN_GATE, workerOutcomeKey, type PendingAskFacts, type ArchiveStamp, type TranscriptFacts } from './transcript-facts-fold.ts';
import { emptyFacts, foldEvent, foldText, sameStamp, stampOf, type ArchiveStamp, type TranscriptFacts } from './transcript-facts-fold.ts';
import { readFactsSidecar, type FactsLoadResult } from './transcript-facts-load.ts';

import { REFRESH_FACTS, TranscriptFactsQueue } from './transcript-facts-queue.ts';

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

  private readonly queue: TranscriptFactsQueue<Entry | undefined>;

  constructor(private readonly dataDir: string) {
    this.queue = new TranscriptFactsQueue(
      dataDir,
      (id, loaded, serialized) => this.accept(id, loaded, serialized),
      (id) => this.peek(id) ? this.entries.get(id) : undefined,
    );
  }

  /** Read only an already-current entry or exact sidecar; never decode/fold history. */
  peek(runId: string): Readonly<TranscriptFacts> | undefined {
    const cached = this.entries.get(runId);
    if (cached && this.current(runId, cached.facts)) return cached.facts;
    const stored = readFactsSidecar(historyPaths(this.dataDir, runId).facts);
    if (!stored || !this.current(runId, stored)) return undefined;
    this.entries.set(runId, { facts: stored, written: stored.bytes });
    return stored;
  }

  async ready(runId: string): Promise<Readonly<TranscriptFacts> | undefined> {
    if (this.stopped) throw new Error('Transcript facts index stopped');
    // An in-flight owner remains authoritative even if a sidecar appears meanwhile.
    if (!this.queue.has(runId)) {
      const facts = this.peek(runId);
      if (facts) return facts;
    }
    return (await this.queue.request(runId))?.facts;
  }

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
    this.queue.forget(runId);
  }

  /** Register all IDs without reading history; requested runs can overtake background work. */
  async warm(runIds: Iterable<string>): Promise<void> {
    if (this.stopped) return;
    await Promise.all([...new Set(runIds)].map((id) => this.queue.request(id, false)));
  }

  /** Stop warming (store close). */
  stop(): void {
    this.stopped = true;
    this.queue.stop();
  }

  private entry(runId: string): Entry | undefined {
    const cached = this.entries.get(runId);
    if (cached && this.current(runId, cached.facts)) return cached;
    // Another process may have written the transcript since: reload from the sidecar and tail.
    if (cached) this.entries.delete(runId);
    if (this.stopped) return undefined;
    return this.queue.join(runId);
  }

  private accept(runId: string, loaded: FactsLoadResult | undefined, serialized?: string): Entry | undefined | typeof REFRESH_FACTS {
    const newer = this.entries.get(runId);
    if (newer && this.current(runId, newer.facts)) return newer;
    if (!loaded) return undefined;
    if (!this.current(runId, loaded.facts)) return REFRESH_FACTS;
    const entry = { facts: loaded.facts, written: loaded.written };
    try { if (loaded.needsWrite) this.persist(runId, entry, serialized); } catch { return undefined; }
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

  private persist(runId: string, entry: Entry, serialized?: string): void {
    const path = historyPaths(this.dataDir, runId).facts;
    const tmp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      writeFileSync(tmp, serialized ?? JSON.stringify(entry.facts), { mode: 0o600 });
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
