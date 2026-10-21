import { HUMAN_ASK_EVENT_TYPES, askRequestSchema, pendingHumanAsk, type AskQuestion } from '@open-mercato/cezar-contract/ask';
import type { RunEvent, RunRecord } from '@open-mercato/cezar-contract';
import { readHistoryText } from '../runs/history-file.ts';

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

/**
 * The question card voice mode offers the engine (spec 2026-10-21-voice-mode, "How it decides"):
 * the latest `ask.requested` in the run's durable history that no delivery or Finish has retired.
 *
 * The transcript is the source because the cockpit's ask card renders from it, and voice offers
 * exactly the card the cockpit shows. Attention reads the open human wait instead
 * (hearsay-tools/cezarion#1236), and the two can differ: a run that goes terminal cancels its open
 * waits, yet its unanswered card stays shown and answerable through Continue, so a missing human
 * wait does not hide the card. An open human wait that names a different ask (`askSeq`) does: the
 * run waits on something else. Undefined when there is no card or the history cannot be read.
 */
export function readPendingHumanAsk(
  dataDir: string,
  run: Pick<RunRecord, 'id' | 'waits'>,
): { requestId: string; questions: AskQuestion[] } | undefined {
  try {
    const events = readHumanAskEvents(dataDir, run.id);
    const pending = events === undefined ? undefined : pendingHumanAsk(events);
    if (pending === undefined || typeof pending.requestId !== 'string') return undefined;
    const elsewhere = run.waits?.some(wait =>
      wait.kind === 'human' && wait.phase === 'open' && wait.askSeq !== undefined && wait.askSeq !== pending.seq);
    if (elsewhere) return undefined;
    const parsed = askRequestSchema.safeParse({ questions: pending.questions });
    return parsed.success ? { requestId: pending.requestId, questions: parsed.data.questions } : undefined;
  } catch {
    return undefined;
  }
}
