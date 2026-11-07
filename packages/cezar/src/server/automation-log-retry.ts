/**
 * The launch retry behind `POST /automation-log/:receiptId/retry`
 * (hearsay-tools/cezarion#2849).
 *
 * The handler in `server.ts` stays in the automations family chain so the
 * route stays on `AppType`. This module looks up the receipt and either fires
 * a schedule again under the lease or relaunches a GitHub candidate.
 */
import { AutomationCandidateChangedError, type GithubCandidate } from '../automations/github-poller.ts';
import {
  SCHEDULE_LEASE_HELD_REASON,
  ScheduleRunner,
  type ScheduleRunnerHandle,
} from '../automations/schedule-runner.ts';
import { launchAutomationRun } from '../automations/task-template.ts';
import {
  isGithubAutomation,
  isScheduleAutomation,
  type AutomationReceipt,
  type GithubAutomationDefinition,
  type ScheduleAutomationDefinition,
} from '../automations/types.ts';
import type { ProjectContext } from './project-context.ts';

export type AutomationLogRetryResult =
  | { status: 202; body: { receiptId: string; runId: string } }
  | { status: 404; body: { error: string } }
  | { status: 409; body: { error: string } };

export interface AutomationLogRetryInput {
  project: ProjectContext;
  receiptId: string;
  scheduleHandle: (project: ProjectContext) => ScheduleRunnerHandle;
  emitChange: (project: ProjectContext, automationId: string, revision: number) => void;
}

async function retryScheduleReceipt(
  input: AutomationLogRetryInput,
  scheduled: ScheduleAutomationDefinition,
  receipt: AutomationReceipt,
): Promise<AutomationLogRetryResult> {
  const { project } = input;
  const store = project.automationStore;
  const outcome = await new ScheduleRunner(input.scheduleHandle(project)).retry(scheduled, receipt);
  // Gone, or no longer a schedule, once re-read under the lease: nothing was launched.
  if (outcome.result === 'skipped') return { status: 404, body: { error: 'not found' } };
  if (outcome.result === 'manual') {
    input.emitChange(project, scheduled.id, store.get(scheduled.id)?.revision ?? scheduled.revision);
    return { status: 202, body: { receiptId: receipt.receiptId, runId: outcome.runId } };
  }
  if (outcome.result === 'lease-held') return { status: 409, body: { error: SCHEDULE_LEASE_HELD_REASON } };
  if (outcome.result === 'duplicate') return { status: 409, body: { error: 'receipt is not retryable' } };
  const latest = store.latestReceipts().get(receipt.receiptKey);
  return { status: 409, body: { error: latest?.error ?? 'the run could not be launched' } };
}

async function retryGithubReceipt(
  input: AutomationLogRetryInput,
  definition: GithubAutomationDefinition,
  receipt: AutomationReceipt,
  candidate: GithubCandidate,
): Promise<AutomationLogRetryResult> {
  const { project } = input;
  const store = project.automationStore;
  const lease = store.acquireLease();
  if (!lease) return { status: 409, body: { error: 'automation polling lease is held by another process' } };
  const reserved = { ...receipt, status: 'reserved' as const, error: undefined, updatedAt: new Date().toISOString() };
  store.appendReceipt(reserved);
  try {
    const launched = await launchAutomationRun({
      root: project.root,
      manager: project.manager,
      store: project.store,
      definition,
      candidate,
      receiptId: receipt.receiptId,
    });
    store.appendReceipt({ ...reserved, status: 'launched', runId: launched.runId, updatedAt: new Date().toISOString() });
    input.emitChange(project, definition.id, definition.revision);
    return { status: 202, body: { receiptId: receipt.receiptId, runId: launched.runId } };
  } catch (error) {
    store.appendReceipt({
      ...reserved,
      status: error instanceof AutomationCandidateChangedError ? 'released' : 'launch-error',
      error: error instanceof Error ? error.message : String(error),
      updatedAt: new Date().toISOString(),
    });
    return { status: 409, body: { error: error instanceof Error ? error.message : String(error) } };
  } finally {
    lease.release();
  }
}

/** Retry a `launch-error` receipt: the same receipt, fired again by hand. */
export async function retryAutomationLogReceipt(input: AutomationLogRetryInput): Promise<AutomationLogRetryResult> {
  const { project, receiptId } = input;
  const store = project.automationStore;
  const receipt = [...store.latestReceipts().values()].find((row) => row.receiptId === receiptId);
  if (!receipt) return { status: 404, body: { error: 'not found' } };
  if (receipt.status !== 'launch-error' || receipt.runId) return { status: 409, body: { error: 'receipt is not retryable' } };
  const scheduled = store.get(receipt.automationId);
  // A schedule receipt carries its occurrence instead of a GitHub candidate; it is fired
  // again by hand through the runner, under the lease, as the same receipt.
  if (scheduled && isScheduleAutomation(scheduled) && receipt.occurrenceAt) {
    return retryScheduleReceipt(input, scheduled, receipt);
  }
  if (!receipt.candidate) return { status: 409, body: { error: 'receipt predates retry context and cannot be retried safely' } };
  if (!scheduled) return { status: 404, body: { error: 'automation not found' } };
  if (!isGithubAutomation(scheduled)) return { status: 409, body: { error: 'receipt is not retryable' } };
  return retryGithubReceipt(input, scheduled, receipt, receipt.candidate);
}
