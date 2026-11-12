/**
 * The store's load-time status writers (slice S4a of .ai/specs/2026-11-03-run-store-owns-exits.md,
 * Table C): each applies a run exit to a record just read off disk, so it settles what that exit
 * settles at runtime (Table B targets B10, B11). `reconcileLoadedRun` (store.ts) runs them in order.
 */
import { engineOwnsRun } from '@open-mercato/cezar-contract/run-predicates';
import { applyExit } from './run-exits.ts';
import type { RunRecord } from './store.ts';

export function settleLoadedStop(run: RunRecord): void {
  // An accepted Stop is durable intent, never an interrupted run to auto-resume. It can meet a run
  // that settled before the Stop did (the engine's own late Stop), so it takes `cancel-late`.
  if (run.stopping) Object.assign(run, applyExit(run, 'cancel-late'));
  run.stopping = undefined;
}

export function restoreLoadedUsageLimitHold(run: RunRecord): void {
  // A usage-limited run is waiting for its resume (hearsay-tools/cezarion#1236, phase 4a). Rows a
  // schema-7 Squawk wrote kept it failed with the appointment; they read as the waiting run they are.
  if (run.status === 'failed' && run.autoResumeAt !== undefined) Object.assign(run, applyExit(run, 'hold'));
}

export function failLoadedInterruptedRun(run: RunRecord, opts?: { keepLive?: boolean }): void {
  // A run that was live when the previous process exited can never finish —
  // surface that instead of a forever-"running" ghost. `review` survives
  // restarts on purpose: the gate is pure data (worktree + branch + record)
  // with no live process, so the diff panel, Send back (resume) and Draft PR
  // all still work.
  // A usage-limit hold runs no process, so no exit interrupted it: its appointment stands.
  if (!opts?.keepLive && engineOwnsRun(run)) {
    Object.assign(run, applyExit(run, 'fail-interrupted'));
  }
}
