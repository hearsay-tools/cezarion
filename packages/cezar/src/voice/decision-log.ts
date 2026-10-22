import { appendFileSync, closeSync, fstatSync, mkdirSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { voiceOutcomeSchema, type VoiceDecision, type VoiceOutcome } from '@open-mercato/cezar-contract/voice';
import type { EngineAnswer, VoiceEngineError, VoiceEngineState } from './engine.ts';

/**
 * The local decision log (spec 2026-10-21-voice-mode, "Decision log"): one JSON line per decision,
 * per failed decision and per reported outcome, in `<dataDir>/voice/decisions.ndjson`. It is the
 * evidence for tuning the thresholds. It never holds the API key, an engine message or a header.
 * Best effort: a log that cannot be written never fails the user's action.
 */

export type VoiceLogLine =
  | {
      type: 'decision';
      at: string;
      decisionId: string;
      sentence: string;
      openRunId?: string;
      engine: 'jev' | 'fake';
      /** What the engine was told: the view, the proposal, the card headers and the recent actions. */
      state: VoiceEngineState;
      answers: Record<string, EngineAnswer>;
      decision: VoiceDecision;
      latencyMs: number;
    }
  | { type: 'decision-error'; at: string; decisionId: string; sentence: string; code: VoiceEngineError['code'] }
  | { type: 'outcome'; at: string; decisionId: string; outcome: VoiceOutcome };

export function appendVoiceLog(dataDir: string, line: VoiceLogLine): void {
  try {
    const dir = join(dataDir, 'voice');
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, 'decisions.ndjson'), `${JSON.stringify(line)}\n`, 'utf8');
  } catch {
    // Best effort, like the other local logs: the decision already reached the user.
  }
}

/** Most decisions kept per project; the engine is told only the newest few. */
const RECENT_MAX = 10;

/** `load` reads at most this much of the end of the log. */
const LOAD_TAIL_BYTES = 64 * 1024;

type RecentEntry = { decisionId: string; sentence: string; action: string; outcome?: string };

/** The last `LOAD_TAIL_BYTES` of a file as lines; a partial first line is dropped. Throws what the read throws. */
function readLogTail(path: string): string[] {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - LOAD_TAIL_BYTES);
    const buffer = Buffer.alloc(size - start);
    let filled = 0;
    while (filled < buffer.length) {
      const n = readSync(fd, buffer, filled, buffer.length - filled, start + filled);
      if (n === 0) break;
      filled += n;
    }
    const lines = buffer.subarray(0, filled).toString('utf8').split('\n');
    return start > 0 ? lines.slice(1) : lines;
  } finally {
    closeSync(fd);
  }
}

/**
 * The last few decisions of each project, in memory, newest last. Jev has no memory between calls,
 * so the server hands it what just happened ("yes" after a proposal needs that). The first `load`
 * for a project seeds it from that project's decision log, so a restart does not empty it.
 */
export class RecentVoiceActions {
  private readonly byProject = new Map<string, RecentEntry[]>();
  private readonly loaded = new Set<string>();

  /**
   * Seeds a project from the tail of its log, once. A missing, unreadable or damaged log seeds
   * nothing and never throws; later calls for the same project do nothing.
   */
  load(projectId: string, dataDir: string): void {
    if (this.loaded.has(projectId)) return;
    this.loaded.add(projectId);
    let lines: string[];
    try {
      lines = readLogTail(join(dataDir, 'voice', 'decisions.ndjson'));
    } catch {
      return;
    }
    for (const line of lines) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (parsed === null || typeof parsed !== 'object') continue;
      const entry = parsed as { type?: unknown; decisionId?: unknown; sentence?: unknown; decision?: unknown; outcome?: unknown };
      if (typeof entry.decisionId !== 'string') continue;
      if (entry.type === 'decision' && typeof entry.sentence === 'string') {
        // Only the action is replayed, so a line written by another version still seeds what it can.
        const action = (entry.decision as { action?: unknown } | null)?.action;
        if (typeof action === 'string') this.record(projectId, entry.decisionId, entry.sentence, action);
      } else if (entry.type === 'outcome') {
        const outcome = voiceOutcomeSchema.safeParse(entry.outcome);
        if (outcome.success) this.settle(projectId, entry.decisionId, outcome.data);
      }
    }
  }

  record(projectId: string, decisionId: string, sentence: string, action: string): void {
    const entries = this.byProject.get(projectId) ?? [];
    entries.push({ decisionId, sentence, action });
    if (entries.length > RECENT_MAX) entries.splice(0, entries.length - RECENT_MAX);
    this.byProject.set(projectId, entries);
  }

  /** Marks what became of a known decision; an unknown or forgotten id changes nothing. */
  settle(projectId: string, decisionId: string, outcome: VoiceOutcome): void {
    const entry = this.byProject.get(projectId)?.find((e) => e.decisionId === decisionId);
    if (entry) entry.outcome = outcome;
  }

  /** Up to `n` newest entries, oldest first. */
  last(projectId: string, n = 3): VoiceEngineState['recent'] {
    const entries = this.byProject.get(projectId) ?? [];
    return entries.slice(-n).map(({ sentence, action, outcome }) => ({ sentence, action, ...(outcome !== undefined ? { outcome } : {}) }));
  }
}
