/**
 * The run exit table (ADR 0056, .ai/specs/2026-11-03-run-store-owns-exits.md). An exit
 * (`RUN_EXITS`) is one kind of status write, with the statuses it may leave from. The trigger
 * rows in `workflows/run-states.ts` name the exit they take; this module imports nothing from
 * `workflows/`.
 *
 * `run.ts` writes every run status by applying an exit in the store: `RunStore.move`, or the
 * `exit` of `commitOutcome` and `commitWorkerContinuation`. Each checks the status of the record
 * its write changes against the exit's `from` (`exitStatus`). `transitionVia` checks a store
 * commit that writes a status itself. An undeclared transition is written as before and reported
 * as a violation; nothing throws in the write path. Strict mode (`vitest.setup.ts`) records each
 * violation, and the test setup fails the test after it ran. Outside strict mode each violation
 * is one `console.warn` and nothing is recorded.
 */
import type { RunRecord, RunStatus } from '@open-mercato/cezar-contract';

/** The fields a write that applies a run exit patches beside it: never the status, which the exit
 *  writes (`RunStore.move`). */
export type RunPatch = Partial<Omit<RunRecord, 'id' | 'steps' | 'status'>> & { status?: never };

/** One kind of status write: the statuses it may leave from and the one it writes. */
export const RUN_EXITS = {
  start: { from: ['queued', 'running', 'waiting'], to: 'running' },
  'start-held': { from: ['queued'], to: 'queued' },
  requeue: { from: ['queued', 'running', 'failed'], to: 'queued' },
  'continue-line': { from: ['waiting', 'review', 'done', 'failed', 'cancelled'], to: 'queued' },
  'continue-now': { from: ['waiting', 'review', 'done', 'failed', 'cancelled'], to: 'running' },
  park: { from: ['running', 'queued', 'waiting'], to: 'waiting' },
  'park-for-wake': { from: ['queued', 'waiting'], to: 'waiting' },
  hold: { from: ['failed', 'waiting'], to: 'waiting' },
  resume: { from: ['waiting'], to: 'running' },
  succeed: { from: ['running', 'waiting'], to: 'done' },
  'succeed-review': { from: ['running', 'waiting'], to: 'review' },
  'accept-review': { from: ['review'], to: 'done' },
  'fail-start': { from: ['queued', 'running'], to: 'failed' },
  fail: { from: ['running', 'waiting'], to: 'failed' },
  // settleFailedContinuation alone: a worker Stop can record cancelled before it settles.
  'fail-continue': { from: ['running', 'waiting', 'cancelled'], to: 'failed' },
  'fail-interrupted': { from: ['queued', 'running', 'waiting'], to: 'failed' },
  'fail-crash': { from: ['queued', 'running', 'waiting'], to: 'failed' },
  'withdraw-hold': { from: ['waiting'], to: 'failed' },
  cancel: { from: ['queued', 'running', 'waiting'], to: 'cancelled' },
  'stop-worker': { from: ['queued', 'running', 'waiting', 'review', 'done', 'failed'], to: 'cancelled' },
  'cancel-late': { from: ['queued', 'running', 'waiting', 'done', 'review', 'failed'], to: 'cancelled' },
} as const satisfies Record<string, { from: readonly RunStatus[]; to: RunStatus }>;
export type RunExitId = keyof typeof RUN_EXITS;

/** Reads the stored run; undefined when the store does not hold it. */
type ReadStatus = () => Pick<RunRecord, 'status'> | undefined;

let strict = false;
/** Strict mode only: outside it nothing is recorded, so production keeps no growing list. */
const violations: string[] = [];

/** Tests only: `vitest.setup.ts` calls it, so a violation is recorded for `throwRunExitViolations`
 *  instead of logged. Returns the previous mode, so a test that changes it can put it back. */
export function strictRunExits(on = true): boolean {
  const previous = strict;
  strict = on;
  return previous;
}

/** The violations recorded since the last call. */
export function takeRunExitViolations(): string[] {
  return violations.splice(0);
}

/** Throws the violations recorded since the last call: the test setup runs it after each test. */
export function throwRunExitViolations(): void {
  const taken = takeRunExitViolations();
  if (taken.length) throw new Error(taken.join('\n'));
}

function violate(message: string): void {
  if (strict) violations.push(message);
  else console.warn(message);
}

function checkFrom(exit: RunExitId, from: RunStatus | undefined): void {
  const spec = RUN_EXITS[exit];
  if (from === undefined || from === spec.to || (spec.from as readonly RunStatus[]).includes(from)) return;
  violate(`undeclared run transition: exit ${exit} from ${from} (declare it in runs/run-exits.ts)`);
}

/**
 * The status `exit` writes onto a run whose status is `from`. The store calls it inside the write
 * that applies the exit, with the record that write changes. It reports an exit that does not
 * leave from `from`, then returns the status all the same.
 */
export function exitStatus<E extends RunExitId>(exit: E, from: RunStatus): (typeof RUN_EXITS)[E]['to'] {
  checkFrom(exit, from);
  return RUN_EXITS[exit].to;
}

/**
 * For a store commit that writes a status it holds itself. It reads the stored status before and
 * after the commit. When the status changed, the old one must be in the exit's `from` and the new
 * one must be the exit's `to`, so the commit and its exit cannot drift apart. A commit that wrote
 * no status (it refused, or only cleared fields) passes. Both checks run after the commit and only
 * report, so the check never keeps a commit from running.
 */
export function transitionVia<T>(exit: RunExitId, read: ReadStatus, commit: () => T): T {
  const before = read()?.status;
  const result = commit();
  const after = read()?.status;
  if (before === after) return result;
  checkFrom(exit, before);
  if (after !== RUN_EXITS[exit].to) violate(`store commit drifted from its exit: exit ${exit} wrote ${after ?? 'nothing'}, not ${RUN_EXITS[exit].to}`);
  return result;
}
