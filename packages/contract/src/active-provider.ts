import type { Runner } from './health.ts';

interface ActiveProviderRun {
  currentStepId?: string | undefined;
  runner?: Runner | undefined;
  steps: readonly { id: string; backend?: Runner | undefined }[];
}

/** The provider that owns a currently live session, when the record is attributed. */
export function providerForActiveRun(run: ActiveProviderRun): Runner {
  const current = run.currentStepId
    ? run.steps.find((step) => step.id === run.currentStepId)
    : undefined;
  if (current?.backend) return current.backend;

  // `execute()` persists the task backend before it starts a step. This is the
  // conservative fallback for older records whose current step lacks affinity.
  if (run.runner) return run.runner;

  // Pre-affinity records can still carry a prior attributed session. It is a
  // better fallback than guessing Claude, but never outranks the live step or
  // the run's current runner.
  for (let index = run.steps.length - 1; index >= 0; index -= 1) {
    const backend = run.steps[index]?.backend;
    if (backend) return backend;
  }
  return 'claude';
}

