import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { VoiceDecision, VoiceOutcome } from '@open-mercato/cezar-contract/voice';
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

type RecentEntry = { decisionId: string; sentence: string; action: string; outcome?: string };

/**
 * The last few decisions of each project, in memory, newest last. Jev has no memory between calls,
 * so the server hands it what just happened ("yes" after a proposal needs that). A restart empties
 * it, which only makes the next sentence stand alone.
 */
export class RecentVoiceActions {
  private readonly byProject = new Map<string, RecentEntry[]>();

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
