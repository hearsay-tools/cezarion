/**
 * The worker-wait helpers that need no fixture: `until`, the event timeline and the readers of a
 * run's worker wait. `worker-wait-core.testkit.ts` re-exports them. A test that uses only these
 * imports this module, so it loads no `RunManager` (hearsay-tools/cezarion#3242).
 */
import { expect, vi } from 'vitest';
import type { WorkerWait } from '@open-mercato/cezar-contract/delegation';
import { hasWorkerDeadline, workerWaitEntryToLegacy, workerWaitView, type DeadlinedWorkerWaitEntry, type WorkerWaitEntry } from '@open-mercato/cezar-contract/waits';
import type { RunEvent, RunRecord } from '../runs/store.ts';

export const terminal = ['review', 'done', 'failed', 'cancelled'];
/** Every failure names its predicate; `explain` adds state, such as `() => timeline(id)`, lazily. */
export async function until(predicate: () => boolean, explain?: () => string) {
  // bound: fail a stuck state/termination check after 15 s; the predicate remains the signal.
  await vi.waitFor(() => expect(predicate()).toBe(true), { timeout: 15_000, interval: 10 }).catch((error: unknown) => {
    if (error instanceof Error) {
      let explanation = '';
      try {
        if (explain) explanation = `${explain()}: `;
      } catch (diagnosticError) {
        explanation = `diagnostics unavailable: ${String(diagnosticError)}: `;
      }
      error.message = `Waiting for ${predicate.toString()}\n${explanation}${error.message}`;
    }
    throw error;
  });
}
/** A run's events after `afterSeq`, one line each: seq, UTC time of day, type, turn, step and the
 *  first characters of its text, note or message. The time shows whether a stuck wait began late or
 *  stalled after its last event (hearsay-tools/squawk#2535). An event without a `turnId` takes the
 *  one its `turn.started` opened, until the `turn-end`; events between turns show `turn=-`. The last line, `assertion`, takes the
 *  `: expected …` that Vitest appends to a message. */
export function formatTimeline(runId: string, events: readonly RunEvent[], afterSeq = 0): string {
  const lines: string[] = []; let turn: string | undefined;
  for (const event of events) {
    const own = typeof event.turnId === 'string' ? event.turnId : undefined;
    if (event.type === 'turn.started') turn = own;
    if (event.seq > afterSeq) {
      // A note's `message` is a string; a conversation message's is an object with its `text`.
      const message = typeof event.message === 'object' && event.message !== null ? (event.message as { text?: unknown }).text : event.message;
      const said = typeof event.text === 'string' ? event.text : typeof message === 'string' ? message : '';
      const excerpt = said.replace(/\s+/g, ' ').trim();
      lines.push(`  ${event.seq} ${event.ts.slice(11, 23)} ${event.type} turn=${own ?? turn ?? '-'} step=${event.stepId ?? '-'}`
        + (excerpt ? ` ${JSON.stringify(excerpt.length > 80 ? `${excerpt.slice(0, 80)}…` : excerpt)}` : ''));
    }
    if (event.type === 'turn-end') turn = undefined;
  }
  return [`events of run ${runId} after seq ${afterSeq}:`, ...(lines.length ? lines : ['  (none)']), 'assertion'].join('\n');
}
/** The run's worker wait in the legacy `WorkerWait` shape (`workerWaitView`): since
 *  hearsay-tools/cezarion#1235 phase 3a an agent's worker wait is a `worker` entry in the list. */
export const waitOf = (run: RunRecord | undefined): WorkerWait | undefined => run ? workerWaitView(run) : undefined;
/** The newest settled worker wait (`lastWaits`), in the legacy shape: what `delegation.lastWait` was. */
export const lastWaitOf = (run: RunRecord | undefined): WorkerWait | undefined => {
  const entry = (run?.lastWaits ?? []).filter((wait): wait is DeadlinedWorkerWaitEntry => wait.kind === 'worker' && hasWorkerDeadline(wait)).at(-1);
  return entry ? workerWaitEntryToLegacy(entry) : undefined;
};
/** The open worker entry of a run, for fixtures that move its deadline. */
export const workerEntryOf = (run: RunRecord | undefined): WorkerWaitEntry | undefined =>
  (run?.waits ?? []).filter((wait): wait is WorkerWaitEntry => wait.kind === 'worker' && wait.phase === 'open').at(-1);
/** The root took input that is not its workers' own messages. An idle worker tells its parent why it
 *  parked (hearsay-tools/cezarion#1327, hearsay-tools/cezarion#2410); a wake's own input is what a
 *  capacity check reads. */
export function deliveredBesideWorkerMessages(run: RunRecord | undefined): boolean {
  return !!run?.agentInputs?.some(input => input.deliveredAt && !(input.conversation && input.conversation.senderRunId !== run.id && input.conversation.recipientRunId === run.id));
}
