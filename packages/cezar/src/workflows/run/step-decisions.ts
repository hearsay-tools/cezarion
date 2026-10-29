import type { StepState } from '../../runs/store.ts';
import type { WorkflowDef, WorkflowStepDef } from '../types.ts';

/** The closing path chooses the delivery action; the facade applies its count and timers. */
export function closingWakeDecision(holdsClosingWakes: boolean, cancelled: boolean, undelivered: string | undefined):
  { kind: 'settle' | 'park' } | { kind: 'failed-delivery'; error: string } {
  if (!holdsClosingWakes || cancelled) return { kind: 'settle' };
  return undelivered !== undefined ? { kind: 'failed-delivery', error: undelivered } : { kind: 'park' };
}

/** Facts are read at their original settlement boundary, including the reads that clear state. */
export function continuationCloseKind(cancelled: boolean, incomplete: boolean, idle: boolean): 'cancelled' | 'incomplete' | 'idle' | 'done' {
  if (cancelled) return 'cancelled';
  if (incomplete) return 'incomplete';
  return idle ? 'idle' : 'done';
}

/** A Stop wins over failure, which wins over an unfinished step and the idle close. */
export function executionSettlementKind(cancelled: boolean, runError: string | null, incompleteStepId: string | undefined, idle: boolean):
  { kind: 'cancelled' | 'idle' | 'done' } | { kind: 'failed'; error: string } | { kind: 'incomplete'; stepId: string } {
  if (cancelled) return { kind: 'cancelled' };
  if (runError) return { kind: 'failed', error: runError };
  if (incompleteStepId) return { kind: 'incomplete', stepId: incompleteStepId };
  return { kind: idle ? 'idle' : 'done' };
}

type CheckStepOutcome = { kind: 'done'; nextIndex: number } |
  { kind: 'retry'; retryIndex: number; used: number; note: string } |
  { kind: 'failed'; error: string; runError: string };

/** A check consumes its own retry budget, including across a recovered workflow remainder. */
export function checkStepOutcome(workflow: WorkflowDef, index: number, record: StepState | undefined, ok: boolean): CheckStepOutcome {
  const step = workflow.steps[index] as WorkflowStepDef;
  if (ok) return { kind: 'done', nextIndex: index + 1 };
  // Retry consumption is distinct from executions: another check may loop
  // back through this step after it already passed. Persist only the times
  // this check itself invoked onFail so max remains bounded across restarts.
  const used = record?.retriesUsed ?? 0;
  if (step.onFail && used < step.onFail.max) {
    const retryIndex = workflow.steps.findIndex((s) => s.id === step.onFail?.retry);
    return { kind: 'retry', retryIndex, used,
      note: `check failed — retrying from "${step.onFail.retry}" (attempt ${used + 1}/${step.onFail.max})` };
  }
  return { kind: 'failed', error: `\`${step.command}\` exited non-zero`,
    runError: `check "${step.id}" failed${step.onFail ? ` after ${used + 1} attempts` : ''}` };
}
