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
