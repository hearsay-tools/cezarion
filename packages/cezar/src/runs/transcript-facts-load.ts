/** Synchronous transcript facts loading, without sidecar writes or index orchestration. */
import { readFileSync } from 'node:fs';
import { historyPaths, historyStat, readHistoryText, readPlainHistoryRange } from './history-file.ts';
import { emptyFacts, factsFileSchema, foldText, sameStamp, stampOf, type TranscriptFacts } from './transcript-facts-fold.ts';

export interface FactsLoadResult {
  facts: TranscriptFacts;
  /** Existing sidecar byte count; -1 for a full rebuild. */
  written: number;
  /** Persist now only for a rebuild or meaningful tail change; byte-only tails await flush. */
  needsWrite: boolean;
}

/** Undefined for thrown stat/read errors. Preserve the history reader's corrupt-archive fallback. */
export function loadTranscriptFacts(dataDir: string, runId: string): FactsLoadResult | undefined {
  try { return load(dataDir, runId); } catch { return undefined; }
}

function load(dataDir: string, runId: string): FactsLoadResult {
  const stored = readFactsSidecar(historyPaths(dataDir, runId).facts);
  const { plainSize, archive } = historyStat(dataDir, runId);
  if (plainSize !== undefined) {
    if (stored && plainSize === stored.bytes) return { facts: stored, written: stored.bytes, needsWrite: false };
    if (stored && plainSize > stored.bytes) {
      const tail = readTail(dataDir, runId, stored.bytes, plainSize);
      if (tail !== undefined) {
        delete stored.archive;
        const entry = { facts: stored, written: stored.bytes, needsWrite: false };
        entry.needsWrite = foldText(stored, tail.toString('utf8'));
        return entry;
      }
    }
  } else if (!archive) {
    return { facts: emptyFacts(), written: 0, needsWrite: false };
  } else if (stored && sameStamp(stored.archive, stampOf(archive))) {
    return { facts: stored, written: stored.bytes, needsWrite: false };
  }
  // No sidecar describes this transcript (a new run, a crash, an archive an older cezar wrote):
  // one rebuild, with write intent for the index to persist so it is not repeated.
  const facts = emptyFacts();
  const text = readHistoryText(dataDir, runId);
  if (text !== undefined) foldText(facts, text);
  if (plainSize === undefined && archive) facts.archive = stampOf(archive);
  const entry = { facts, written: -1, needsWrite: true };
  return entry;
}

export function readFactsSidecar(path: string): TranscriptFacts | undefined {
  try {
    const parsed = factsFileSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
    return parsed.success ? parsed.data as TranscriptFacts : undefined;
  } catch { return undefined; }
}

/** `[from, to)` of the plain transcript, or undefined when `from` is not a line boundary. */
function readTail(dataDir: string, runId: string, from: number, to: number): Buffer | undefined {
  const start = from === 0 ? 0 : from - 1;
  const bytes = readPlainHistoryRange(dataDir, runId, start, to);
  if (bytes.length !== to - start) return undefined;
  if (from === 0) return bytes;
  return bytes[0] === 0x0a ? bytes.subarray(1) : undefined;
}

