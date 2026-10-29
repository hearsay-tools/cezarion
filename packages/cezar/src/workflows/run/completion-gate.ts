import type { ActiveRun } from '../active-run.ts';
import type { RunRecord } from '../../runs/store.ts';
import type { RunModuleContext } from './types.ts';
import { hasRegisteredRunProcess } from '../../core/process-usage.ts';
import { parentReadiness } from '../../delegation/readiness.ts';
import { openWaits } from '../waits.ts';
import { openCompletionRequests, rootCompletionRefusal, type CompletionRefusal } from '../completion-policy.ts';
import { hasPendingHumanAsk } from './pending-ask-facts.ts';

export interface CompletionGateHost {
  active: Pick<Map<string, ActiveRun>, 'get'>;
  pendingHumanAskSeq(runId: string): number | undefined;
  isActive(runId: string): boolean;
  holdsAgentWaits(runId: string): boolean;
  waitingBeforeFinalWorkflowStep(run: RunRecord): boolean;
  parentCompletionBlockers(runId: string): ReturnType<typeof parentCompletionBlockers>;
  unansweredQuestions(runId: string): { workerId: string; messageId: string }[];
}

export function completionRefusal(context: RunModuleContext, host: CompletionGateHost, runId: string): CompletionRefusal | undefined {
  if (context.store.getRun(runId)?.delegation?.role !== 'root') return undefined;
  return rootCompletionRefusal({ questions: host.unansweredQuestions(runId), blockers: host.parentCompletionBlockers(runId),
    requests: openCompletionRequests(context.store, runId), incomingRefused: !!host.active.get(runId)?.incomingRequestRefused });
}

export function parentCompletionBlockers(context: RunModuleContext, host: CompletionGateHost, runId: string) {
  const parent = context.store.getRun(runId);
  if (parent?.delegation?.role !== 'root') return [];
  const ids = new Set([...parent.delegation.receipts.map(receipt => receipt.workerId),
    ...context.store.listWorkersOf(runId).map(run => run.id)]);
  const workers = parentReadiness(parent, [...ids].map(workerId => ({ workerId, run: context.store.getRun(workerId),
    terminated: context.store.readWorkerExecution(workerId)?.phase === 'complete', result: context.store.getRun(workerId)
      ? context.store.readWorkerResult(runId, workerId) : context.store.readDeletedWorkerResult(runId, workerId),
  })));
  return [...workers, ...openCompletionRequests(context.store, runId).sent.map(request => ({ workerId: request.recipientRunId, reason: 'request' as const, request }))];
}

/** A settled-but-uncollected result is work for the parent, not a live worker.
 * Keep the private termination proof: a public terminal status can precede exit. */
export function hasLiveWorkers(context: RunModuleContext, host: CompletionGateHost, runId: string): boolean {
  return host.parentCompletionBlockers(runId).some(blocker => {
    const worker = context.store.getRun(blocker.workerId)?.delegation;
    return blocker.reason === 'outstanding' && worker?.role === 'worker' && worker.parentRunId === runId;
  });
}

/** Live workers keep a turn end monitoring unless the agent already waits on workers: an open
 *  worker entry is the wait, so no implicit re-check timer goes beside it (hearsay-tools/cezarion#1235). */
export function monitorsLiveWorkers(context: RunModuleContext, host: CompletionGateHost, runId: string): boolean {
  return hasLiveWorkers(context, host, runId) && !openWaits(context.store.getRun(runId) ?? {}).some(wait => wait.kind === 'worker');
}

export function delegationFinishBlockedReason(context: RunModuleContext, host: CompletionGateHost, runId: string): string | undefined {
  const parent = context.store.getRun(runId);
  if (parent?.delegation?.role !== 'root') return undefined;
  if (hasPendingHumanAsk(runId, id => host.pendingHumanAskSeq(id)) || host.active.get(runId)?.pendingHumanAsk) return 'Answer the pending human question before finishing.';
  const questions = host.unansweredQuestions(runId);
  if (questions.length) return `Answer your workers' questions before finishing: ${questions.map(q => q.workerId).join(', ')}`;
  const blockers = host.parentCompletionBlockers(runId).filter(blocker => blocker.reason !== 'request');
  return blockers.length ? `Workers must finish or be stopped, prove termination, and have their latest results collected before finishing: ${blockers.map(b => `${b.workerId} (${b.reason})`).join(', ')}` : undefined;
}

/** The read-only verdict and explicit Finish share this decision. Operational failures
 * (for example a failed durable write) are still handled at execution time. */
export function finishDecision(context: RunModuleContext, host: CompletionGateHost, runId: string):
  { action: 'session' | 'root' | 'waiting' | 'review' } | { reason: string; warn?: boolean } {
  const blocked = delegationFinishBlockedReason(context, host, runId);
  if (blocked) return { reason: blocked, warn: true };
  if (host.active.get(runId)?.session?.open) return { action: 'session' };
  const run = context.store.getRun(runId);
  if (run?.status === 'waiting' && !hasRegisteredRunProcess(runId) && !host.isActive(runId) &&
    (run.delegation?.role === 'root' || run.delegation === undefined)) {
    if (host.waitingBeforeFinalWorkflowStep(run)) {
      return { reason: 'Continue the remaining workflow steps before finishing.' };
    }
    return { action: run.delegation?.role === 'root' ? 'root' : 'waiting' };
  }
  if (run?.status === 'review' && !host.isActive(runId)) return { action: 'review' };
  return { reason: 'no open session' };
}

export function finishBlockedReason(context: RunModuleContext, host: CompletionGateHost, runId: string): string | undefined {
  const decision = finishDecision(context, host, runId);
  return 'reason' in decision ? decision.reason : undefined;
}

/** Human Finish keeps the worker guarantees and bypasses request obligations only. */
export function completionMayPass(context: RunModuleContext, host: CompletionGateHost, runId: string): boolean {
  const run = context.store.getRun(runId);
  const humanFinish = host.active.get(runId)?.finishRequested || (run?.delegation?.role === 'root' && run.delegation.finishRequestedAt);
  return humanFinish ? host.parentCompletionBlockers(runId).every(blocker => blocker.reason === 'request') : !completionRefusal(context, host, runId);
}

/** A refusal `queueCompletionRefusal` queued and the run has not received yet. */
export function owesCompletionRefusal(context: RunModuleContext, host: CompletionGateHost, runId: string): boolean {
  return !!context.store.getRun(runId)?.agentInputs?.some(input => !input.deliveredAt && input.purpose === 'completion-refusal');
}

/** A closing session leaves the run something to reopen for: an agent wait, or a refusal queued
 *  for it (hearsay-tools/cezarion#1301). A refusal takes a wait's bounded delivery retry, so a
 *  session that keeps closing before it is submitted stops at `MAX_WAKE_DELIVERY_ATTEMPTS`
 *  instead of reaching the success path, which would queue the refusal again. */
export function holdsClosingWakes(context: RunModuleContext, host: CompletionGateHost, runId: string): boolean {
  return host.holdsAgentWaits(runId) || owesCompletionRefusal(context, host, runId);
}

