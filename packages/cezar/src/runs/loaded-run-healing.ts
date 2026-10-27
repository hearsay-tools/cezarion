import { engineOwnsRun } from '@open-mercato/cezar-contract/run-predicates';

import type { RunRecord } from './store.ts';

/** Apply lifecycle healing in order, mutating the loaded record and its existing steps. */
export function healLoadedRunLifecycle(run: RunRecord, opts?: { keepLive?: boolean }): void {
  settleLoadedStop(run);
  restoreLoadedUsageLimitHold(run);
  failLoadedInterruptedRun(run, opts);
  clearLoadedStaleResume(run);
}

function settleLoadedStop(run: RunRecord): void {
  // An accepted Stop is durable intent, never an interrupted run to auto-resume.
  if (run.stopping) {
    run.status = 'cancelled';
    run.finishedAt ??= new Date().toISOString();
    for (const step of run.steps) {
      if (step.status === 'running' || step.status === 'waiting') step.status = 'cancelled';
    }
  }
  run.stopping = undefined;
}

function restoreLoadedUsageLimitHold(run: RunRecord): void {
  // A usage-limited run is waiting for its resume (hearsay-tools/cezarion#1236, phase 4a). Rows a
  // schema-7 cezar wrote kept it failed with the appointment; they read as the waiting run they are.
  if (run.status === 'failed' && run.autoResumeAt !== undefined) {
    run.status = 'waiting';
    run.finishedAt = undefined;
  }
}

function failLoadedInterruptedRun(run: RunRecord, opts?: { keepLive?: boolean }): void {
  // A run that was live when the previous process exited can never finish —
  // surface that instead of a forever-"running" ghost. `review` survives
  // restarts on purpose: the gate is pure data (worktree + branch + record)
  // with no live process, so the diff panel, Send back (resume) and Draft PR
  // all still work.
  // A usage-limit hold runs no process, so no exit interrupted it: its appointment stands.
  if (!opts?.keepLive && engineOwnsRun(run)) {
    run.status = 'failed';
    run.error = 'interrupted — cezar process exited during the run';
    run.finishedAt = run.finishedAt ?? new Date().toISOString();
    for (const step of run.steps) {
      if (step.status === 'running' || step.status === 'waiting') step.status = 'failed';
    }
  }
}

function clearLoadedStaleResume(run: RunRecord): void {
  // Open waits are left alone at every status: RunManager cancels them when a run ends (spec
  // 2026-10-17-unified-waits), and recovery reads the ones a crash left behind.
  // A pending usage-limit resume survives the restart on purpose (the wait can be
  // hours) — `RunManager.recover()` re-arms it from this field. It can only mean
  // anything on a `waiting` run, so anywhere else it is stale bookkeeping.
  if (run.status !== 'waiting') run.autoResumeAt = undefined;
}
