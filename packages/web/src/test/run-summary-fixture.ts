import { runDelegationSummarySchema } from '@open-mercato/cezar-api-client/contract/delegation'
import { runWorkflowLabel } from '@open-mercato/cezar-api-client/contract/run-labels'
import type { HumanWaitEntry, RunRecord, RunSummary } from '@open-mercato/cezar-api-client'

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

/** An open human wait: how a record says the agent asked the user (phase 4b,
 *  hearsay-tools/cezarion#1236). `askSeq` marks a question the user already sees. */
export function openHumanWait(askSeq?: number): HumanWaitEntry {
  return {
    id: '00000000-0000-4000-8000-0000000000ac', kind: 'human', source: 'agent', via: 'cezar_ask',
    registeredAt: '2026-09-16T00:00:00.000Z', phase: 'open', turnId: 'turn-1',
    ...(askSeq === undefined ? {} : { askSeq }),
  }
}
