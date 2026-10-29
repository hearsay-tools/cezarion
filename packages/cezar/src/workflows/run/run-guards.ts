import type { ActiveRun } from '../active-run.ts';
import type { RunRecord, RunStore } from '../../runs/store.ts';

export function rootFinishRequested(store: Pick<RunStore, 'getRun'>, runId: string): boolean {
  const delegation = store.getRun(runId)?.delegation;
  return delegation?.role === 'root' && !!delegation.finishRequestedAt;
}

export function executionBlockedByRootFinish(store: Pick<RunStore, 'getRun'>, run: RunRecord): boolean {
  return rootFinishRequested(store, run.delegation?.role === 'worker' ? run.delegation.parentRunId : run.id);
}

/** Irreversible history removal is an execution tombstone, including for legacy children. */
export function historyDeletionPending(store: Pick<RunStore, 'getRun'>, runId: string): boolean {
  const run = store.getRun(runId);
  const parent = run?.delegation?.role === 'worker' ? store.getRun(run.delegation.parentRunId) : run;
  return parent?.delegation?.role === 'root' && parent.delegation.historyDeletion === 'pending';
}

export function canProceedWithRun(
  run: RunRecord | undefined,
  workerExecutionStopped: () => boolean,
  executionBlockedByRootFinish: (run: RunRecord) => boolean,
): run is RunRecord {
  return !(!run || run.stopping || workerExecutionStopped() || executionBlockedByRootFinish(run));
}

/** The delegation family a run belongs to, by its root's id: a worker's parent, else itself. */
export function familyOf(run: RunRecord): string {
  return run.delegation?.role === 'worker' ? run.delegation.parentRunId : run.id;
}

export function isDisposedDelegatedRun(store: Pick<RunStore, 'getRun'>, disposed: () => boolean, runId: string): boolean {
  const role = store.getRun(runId)?.delegation?.role;
  return disposed() && (role === 'root' || role === 'worker' || !!store.getRun(runId)?.waits?.length);
}

/** Shutdown is not completion. Explicit terminal controls retain their precedence. */
export function preserveRunAfterDisposal(store: Pick<RunStore, 'getRun'>, disposed: () => boolean, runId: string, state: ActiveRun): boolean {
  return isDisposedDelegatedRun(store, disposed, runId) && !state.cancelled && !state.finishRequested;
}

/** Only an original workflow that has never executed may return to its queue. */
export function isUntouchedCancelledRun(run: RunRecord): boolean {
  return run.status === 'cancelled' && !run.startedAt && !!run.workflowDef &&
    run.steps.every(step => step.status === 'pending' && !step.startedAt && !step.sessionId);
}
