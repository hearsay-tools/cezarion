import { runDelegationSummarySchema, runWorkflowLabel, type RunRecord, type RunSummary } from '@open-mercato/cezar-api-client'

/**
 * A list-row fixture from a full test record (#817). List views now read `RunSummary`; the fields
 * a summary carries that a record lacks are derived (`workflowLabel`, `currentStepBackend`), so
 * this adds them by the same contract rules `toRunSummary` uses and leaves every other key as the
 * test wrote it.
 * A delegation that parses is slimmed exactly as the server slims it; a loose test shape that does
 * not parse is kept as written. That tolerance is why this is not `toRunSummary` itself, which
 * has its own tests in `packages/contract`.
 */
export function summaryOf(run: RunRecord): RunSummary {
  const currentStepBackend = run.steps.find((step) => step.id === run.currentStepId)?.backend
  const delegation = runDelegationSummarySchema.safeParse(run.delegation)
  return {
    ...run,
    ...(run.delegation !== undefined && delegation.success ? { delegation: delegation.data } : {}),
    workflowLabel: runWorkflowLabel(run),
    ...(currentStepBackend === undefined ? {} : { currentStepBackend }),
  } as unknown as RunSummary
}
