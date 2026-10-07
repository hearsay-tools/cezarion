/**
 * The few transcript facts the delegation reconcile and message delivery ask about, folded as
 * events are appended so those paths never re-read a whole transcript (hearsay-tools/cezarion#880).
 * Spec: docs/superpowers/specs/2026-10-07-transcript-facts-index-design.md.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync, renameSync, rmSync, writeFileSync, type Stats } from 'node:fs';
import { z } from 'zod';
import { advancePendingHumanAsk, type RunEvent } from '@open-mercato/cezar-contract';
import { historyPaths, historyStat, readHistoryText, readHistoryTextAsync, readPlainHistoryRange } from './history-file.ts';

/** A prose gate a turn ended on without a structured ask; answered like one. */
export const PROSE_HUMAN_GATE = 'unstructured-human-gate';

export interface PendingAskFacts {
  seq: number;
  requestId: string;
  questions: unknown;
  /** The worker routed this ask to its parent as this conversation message (#505). */
  routedMessageId?: string;
  /** The ask went back to the human. */
  fallback?: boolean;
}

export interface ArchiveStamp { size: number; mtimeMs: number; ino: number }

export interface TranscriptFacts {
  version: 1;
  /** Decoded transcript bytes folded so far. */
  bytes: number;
  lastSeq: number;
  projectionIds: string[];
  /** The latest structured ask with no matching delivery receipt. */
  pendingAsk?: PendingAskFacts;
  /** As `pendingAsk`, with prose human gates counted as asks. */
  pendingGateSeq?: number;
  workerOutcomeKeys: string[];
  /** Stat of the archive these facts were folded from, while the transcript is archived. */
  archive?: ArchiveStamp;
}

export function emptyFacts(): TranscriptFacts {
  return { version: 1, bytes: 0, lastSeq: 0, projectionIds: [], workerOutcomeKeys: [] };
}

export function workerOutcomeKey(waitId: string, workerId: string, revision: number): string {
  return `${waitId}:${workerId}:${revision}`;
}

/** Fold one event. True when a fact other than `bytes`/`lastSeq` changed, i.e. worth persisting. */
export function foldEvent(facts: TranscriptFacts, event: RunEvent): boolean {
  if (typeof event.seq === 'number' && event.seq > facts.lastSeq) facts.lastSeq = event.seq;
  let changed = false;
  if (typeof event.projectionId === 'string' && !facts.projectionIds.includes(event.projectionId)) {
    facts.projectionIds.push(event.projectionId);
    changed = true;
  }
  // advancePendingHumanAsk reads only the pending event's seq.
  const pending = facts.pendingAsk && ({ type: 'ask.requested', seq: facts.pendingAsk.seq, ts: '' } as RunEvent);
  const next = advancePendingHumanAsk(pending, event);
  if (next === event) {
    facts.pendingAsk = { seq: event.seq, requestId: event.requestId as string, questions: event.questions };
    changed = true;
  } else if (next === undefined && facts.pendingAsk) {
    delete facts.pendingAsk;
    changed = true;
  }
  if (facts.pendingAsk && event.askSeq === facts.pendingAsk.seq) {
    if (event.type === 'worker-question-routed' && facts.pendingAsk.routedMessageId === undefined && typeof event.messageId === 'string') {
      facts.pendingAsk.routedMessageId = event.messageId;
      changed = true;
    } else if (event.type === 'worker-question-fallback' && !facts.pendingAsk.fallback) {
      facts.pendingAsk.fallback = true;
      changed = true;
    }
  }
  const gate = event.type === 'note' && event.code === PROSE_HUMAN_GATE ? event
    : advancePendingHumanAsk(facts.pendingGateSeq === undefined ? undefined : ({ type: 'note', seq: facts.pendingGateSeq, ts: '' } as RunEvent), event);
  if (gate?.seq !== facts.pendingGateSeq) {
    if (gate) facts.pendingGateSeq = gate.seq; else delete facts.pendingGateSeq;
    changed = true;
  }
  if (event.type === 'worker-outcome' && typeof event.waitId === 'string') {
    const outcome = event.outcome as { workerId?: unknown; revision?: unknown } | undefined;
    if (typeof outcome?.workerId === 'string') {
      const key = workerOutcomeKey(event.waitId, outcome.workerId, typeof outcome.revision === 'number' ? outcome.revision : 0);
      if (!facts.workerOutcomeKeys.includes(key)) { facts.workerOutcomeKeys.push(key); changed = true; }
    }
  }
  return changed;
}

/** Fold NDJSON text. Unparsable lines are skipped, as `RunStore.readEvents` skips them. */
export function foldText(facts: TranscriptFacts, text: string): boolean {
  let changed = false;
  for (const line of text.split('\n')) {
    if (!line) continue;
    let event: unknown;
    try { event = JSON.parse(line); } catch { continue; }
    if (event !== null && typeof event === 'object' && foldEvent(facts, event as RunEvent)) changed = true;
  }
  facts.bytes += Buffer.byteLength(text);
  return changed;
}

const factsFileSchema = z.object({
  version: z.literal(1),
  bytes: z.number().int().nonnegative(),
  lastSeq: z.number(),
  projectionIds: z.array(z.string()),
  pendingAsk: z.object({
    seq: z.number(), requestId: z.string(), questions: z.unknown(),
    routedMessageId: z.string().optional(), fallback: z.boolean().optional(),
  }).optional(),
  pendingGateSeq: z.number().optional(),
  workerOutcomeKeys: z.array(z.string()),
  archive: z.object({ size: z.number(), mtimeMs: z.number(), ino: z.number() }).optional(),
});

interface Entry { facts: TranscriptFacts; written: number }

export const stampOf = (st: Stats): ArchiveStamp => ({ size: st.size, mtimeMs: st.mtimeMs, ino: st.ino });
const sameStamp = (a: ArchiveStamp | undefined, b: ArchiveStamp) => !!a && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ino === b.ino;

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
        const stored = this.readSidecar(historyPaths(this.dataDir, runId).facts);
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
    let entry: Entry | undefined;
    try { entry = this.load(runId); } catch { return undefined; }
    if (entry) this.entries.set(runId, entry);
    return entry;
  }

  private load(runId: string): Entry | undefined {
    const stored = this.readSidecar(historyPaths(this.dataDir, runId).facts);
    const { plainSize, archive } = historyStat(this.dataDir, runId);
    if (plainSize !== undefined) {
      if (stored && plainSize === stored.bytes) return { facts: stored, written: stored.bytes };
      if (stored && plainSize > stored.bytes) {
        const tail = this.readTail(runId, stored.bytes, plainSize);
        if (tail !== undefined) {
          delete stored.archive;
          const entry = { facts: stored, written: stored.bytes };
          if (foldText(stored, tail.toString('utf8'))) this.persist(runId, entry);
          return entry;
        }
      }
    } else if (!archive) {
      return { facts: emptyFacts(), written: 0 };
    } else if (stored && sameStamp(stored.archive, stampOf(archive))) {
      return { facts: stored, written: stored.bytes };
    }
    // No sidecar describes this transcript (a new run, a crash, an archive an older cezar wrote):
    // one rebuild, persisted so it is not repeated. Warm-up does it off the request path.
    const facts = emptyFacts();
    const text = readHistoryText(this.dataDir, runId);
    if (text !== undefined) foldText(facts, text);
    if (plainSize === undefined && archive) facts.archive = stampOf(archive);
    const entry = { facts, written: -1 };
    this.persist(runId, entry);
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

  private readSidecar(path: string): TranscriptFacts | undefined {
    try {
      const parsed = factsFileSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
      return parsed.success ? parsed.data as TranscriptFacts : undefined;
    } catch { return undefined; }
  }

  /** `[from, to)` of the plain transcript, or undefined when `from` is not a line boundary. */
  private readTail(runId: string, from: number, to: number): Buffer | undefined {
    const start = from === 0 ? 0 : from - 1;
    const bytes = readPlainHistoryRange(this.dataDir, runId, start, to);
    if (bytes.length !== to - start) return undefined;
    if (from === 0) return bytes;
    return bytes[0] === 0x0a ? bytes.subarray(1) : undefined;
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
