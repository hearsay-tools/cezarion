import { HUMAN_ASK_EVENT_TYPES, askRequestSchema, pendingHumanAsk, type AskQuestion } from '@open-mercato/cezar-contract/ask';
import type { RunEvent } from '@open-mercato/cezar-contract';
import { readHistoryText } from './history-file.ts';

type AttentionSummary = { id: string; hasPendingHumanAsk?: boolean };

/** The ask events of a run's durable history, or undefined when it has no history. Throws what the read throws. */
function readHumanAskEvents(dataDir: string, runId: string): RunEvent[] | undefined {
  const raw = readHistoryText(dataDir, runId);
  if (raw === undefined) return undefined;
  const events: RunEvent[] = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    try {
      const event: unknown = JSON.parse(line);
      if (event !== null && typeof event === 'object' && 'type' in event &&
        typeof event.type === 'string' && HUMAN_ASK_EVENT_TYPES.has(event.type)) events.push(event as RunEvent);
    } catch { /* Match readEvents: a damaged line does not hide later valid receipts. */ }
  }
  return events;
}

/** Rebuild display metadata from the same durable evidence as delivery admission.
 * Called only for question/receipt appends and root-wait recovery, never token ticks.
 * Shared by owned stores and the read-only cold index; no context or process is opened. */
export function refreshHumanAskSummary(run: AttentionSummary, dataDir: string): boolean {
  let next: boolean;
  try {
    const events = readHumanAskEvents(dataDir, run.id);
    next = events === undefined ? run.hasPendingHumanAsk === true : pendingHumanAsk(events) !== undefined;
  } catch (error) {
    // An unavailable history cannot retract known human attention. Legacy runs with
    // no history need no new state; other read errors conservatively request attention.
    next = run.hasPendingHumanAsk === true || (error as NodeJS.ErrnoException).code !== 'ENOENT';
  }
  if (next === run.hasPendingHumanAsk) return false;
  run.hasPendingHumanAsk = next;
  return true;
}

/** The question card a run waits on, from its durable history: the latest `ask.requested` that no
 * delivery or Finish has retired. Undefined when there is none or the history cannot be read. */
export function readPendingHumanAsk(dataDir: string, runId: string): { requestId: string; questions: AskQuestion[] } | undefined {
  try {
    const events = readHumanAskEvents(dataDir, runId);
    const pending = events === undefined ? undefined : pendingHumanAsk(events);
    if (pending === undefined || typeof pending.requestId !== 'string') return undefined;
    const parsed = askRequestSchema.safeParse({ questions: pending.questions });
    return parsed.success ? { requestId: pending.requestId, questions: parsed.data.questions } : undefined;
  } catch {
    return undefined;
  }
}
