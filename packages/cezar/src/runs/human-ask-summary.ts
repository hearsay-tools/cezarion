import { pendingHumanAsk, type RunEvent } from '@open-mercato/cezar-contract';
import { readHistoryText } from './history-file.ts';

type AttentionSummary = { id: string; hasPendingHumanAsk?: boolean };

/** Rebuild display metadata from the same durable evidence as delivery admission.
 * Called only for question/receipt appends and root-wait recovery, never token ticks.
 * Shared by owned stores and the read-only cold index; no context or process is opened. */
export function refreshHumanAskSummary(run: AttentionSummary, dataDir: string): boolean {
  let next: boolean;
  try {
    const raw = readHistoryText(dataDir, run.id);
    if (raw === undefined) {
      next = run.hasPendingHumanAsk === true;
    } else {
      const events: RunEvent[] = [];
      for (const line of raw.split('\n')) {
        if (!line) continue;
        try {
          const event: unknown = JSON.parse(line);
          if (event !== null && typeof event === 'object' && 'type' in event &&
            (event.type === 'ask.requested' || event.type === 'human-input-delivered')) events.push(event as RunEvent);
        } catch { /* Match readEvents: a damaged line does not hide later valid receipts. */ }
      }
      next = pendingHumanAsk(events) !== undefined;
    }
  } catch (error) {
    // An unavailable history cannot retract known human attention. Legacy runs with
    // no history need no new state; other read errors conservatively request attention.
    next = run.hasPendingHumanAsk === true || (error as NodeJS.ErrnoException).code !== 'ENOENT';
  }
  if (next === run.hasPendingHumanAsk) return false;
  run.hasPendingHumanAsk = next;
  return true;
}
