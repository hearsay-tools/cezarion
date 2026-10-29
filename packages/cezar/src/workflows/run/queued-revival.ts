import { continuationDefStep, WorkerIdentityError, type WorkerStepIdentity } from '../../delegation/execution-identity.ts';
import type { RunRecord, RunStore, QueuedMessage } from '../../runs/store.ts';
import { DEFAULT_AGENT_ACCOUNT_ID } from '../../workspace/agent-accounts.ts';
import { loadWorkflows } from '../load.ts';
import { queuedRecoveryInput, queuedStartAt } from '../run-scheduling.ts';
import type { RunExitId } from '../run-states.ts';
import { stepKind, type WorkflowDef } from '../types.ts';
import type { PastedContent } from '../pasted-content.ts';
import type { PendingJob } from './run-line.ts';
import type { RunModuleContext, PendingContinuation, StartRunInput } from './types.ts';

export interface QueuedRevivalHost {
  move(runId: string, exit: RunExitId, patch?: Omit<Parameters<RunStore['updateRun']>[1], 'status'>): RunRecord | undefined;
  isActive(runId: string): boolean;
  workerExecutionStopped(runId: string): boolean;
  ownedJob(run: RunRecord): PendingJob;
  resumableSessionId(runId: string, step: RunRecord['steps'][number] | undefined): string | undefined;
  workerStep(runId: string, stepId: string | undefined): WorkerStepIdentity | undefined;
  toQueuedMessage(runId: string, content: PastedContent[]): QueuedMessage;
  hydrateQueuedInput(runId: string, input: StartRunInput): StartRunInput;
  enqueueJob(runId: string, job: PendingJob): void;
  enqueueContinuation(runId: string, continuation: PendingContinuation): void;
  isSyntheticContinuation(run: RunRecord, step: RunRecord['steps'][number]): boolean;
  restartContinuationPrompt: string;
  reviveQueuedRun(run: RunRecord, reason: string): Promise<void>;
  reviveWorkflow(run: RunRecord): Promise<WorkflowDef | null>;
  checkpointRestartContext(run: RunRecord, queuedStepId?: string): RunRecord;
}

/** Save restart evidence before queue admission or the next startup await. */
export function checkpointRestartContext(context: RunModuleContext, host: QueuedRevivalHost, run: RunRecord, queuedStepId?: string): RunRecord {
  const message = run.continuationMessage ?? (queuedStepId ? {
    ...host.toQueuedMessage(run.id, []), id: queuedStepId, text: 'Continue.', origin: 'lifecycle' as const,
  } : undefined);
  if (!message) return run;
  const updated = context.store.updateRun(run.id, { continuationMessage: {
    ...message,
    ...(message.origin === 'lifecycle' && message.text === host.restartContinuationPrompt ? { text: 'Continue.' } : {}),
    resumeContext: { ...message.resumeContext, restarted: true },
  } }) ?? run;
  context.store.flush();
  return updated;
}

/**
 * Rebuild executable state for a durable queued record. Shared by recovery and the watchdog;
 * reconstruct jobs or continuations before pumping.
 */
export async function reviveQueuedRun(context: RunModuleContext, host: QueuedRevivalHost, run: RunRecord, reason: string): Promise<void> {
  if (host.isActive(run.id) || host.workerExecutionStopped(run.id)) return;
  const queuedContinuation = [...run.steps]
    .reverse()
    .find((step) => step.status === 'pending' && host.isSyntheticContinuation(run, step));
  const sessionStep = queuedContinuation
    ? [...run.steps].reverse().find((step) => step.id !== queuedContinuation.id && step.sessionId)
    : undefined;
  if (queuedContinuation && sessionStep?.sessionId) {
    reviveQueuedContinuation(context, host, run, reason, queuedContinuation.id, sessionStep);
    return;
  }
  if (run.delegation?.role === 'worker') {
    reviveQueuedWorker(context, host, run, reason);
    return;
  }
  const workflow = await host.reviveWorkflow(run);
  if (!workflow) {
    host.move(run.id, 'fail-start', {
      error: 'interrupted — workflow definition not recoverable after a restart',
      finishedAt: new Date().toISOString(),
    });
    context.store.appendEvent(run.id, {
      type: 'lifecycle',
      message: `${reason} — workflow definition not recoverable, task failed`,
    });
    return;
  }
  host.enqueueJob(run.id, {
    workflow,
    startAt: queuedStartAt(run, workflow),
    // Rehydrate again at dequeue so edits and stacked messages keep their admission-time reads.
    input: host.hydrateQueuedInput(run.id, queuedRecoveryInput(run)),
  });
  context.store.appendEvent(run.id, { type: 'lifecycle', message: `${reason} — task re-queued` });
}

export function reviveQueuedContinuation(context: RunModuleContext, host: QueuedRevivalHost, run: RunRecord, reason: string, queuedStepId: string, sessionStep: RunRecord['steps'][number]): void {
  if (reason === 'cezar restarted') run = host.checkpointRestartContext(run, queuedStepId);
  const { backend, sessionBackend, sameAccount, recoveredSessionId } = queuedResumeSession(context, host, run, sessionStep);
  if (sessionStep.sessionTransport === 'cursor-print' && sessionBackend === backend && sameAccount && !recoveredSessionId) {
    const error = 'Cursor print session identity lacks a matching recorded session event';
    const finishedAt = new Date().toISOString();
    context.store.updateStep(run.id, queuedStepId, { status: 'failed', error, finishedAt });
    host.move(run.id, 'fail-start', { error, finishedAt, currentStepId: undefined });
    return;
  }
  host.enqueueContinuation(run.id, {
    stepId: queuedStepId,
    sessionId: recoveredSessionId,
    backend,
    prompt: run.continuationMessage?.text ?? host.restartContinuationPrompt,
    images: [],
    lineJoinedAt: Date.now(),
  });
  context.store.appendEvent(run.id, {
    type: 'lifecycle',
    message: `${reason} — interrupted continuation re-queued`,
  });
}

/** Match the pinned execution account before considering a persisted session resumable. */
export function queuedResumeSession(context: RunModuleContext, host: QueuedRevivalHost, run: RunRecord, sessionStep: RunRecord['steps'][number]) {
  // An accepted worker's continuation extends the step owning the resumed session, so its
  // runner and account come from that step's pinned identity, never the run-level
  // first-step fields — those would re-queue a claude review's Continue as a codex turn with
  // no session to resume. Broken identity evidence is left for the launch to report.
  let resumeIdentity: WorkerStepIdentity | undefined;
  try { resumeIdentity = host.workerStep(run.id, continuationDefStep(context.store, run, sessionStep.sessionId)?.id); }
  catch (error) { if (!(error instanceof WorkerIdentityError)) throw error; }
  const backend = resumeIdentity?.account.provider ?? run.runner ?? 'claude';
  const sessionBackend = sessionStep.backend ?? backend;
  const sessionAccount = sessionStep.profileId ?? DEFAULT_AGENT_ACCOUNT_ID;
  const agentProfile = resumeIdentity?.account.profileId ?? run.agentProfile;
  const sameAccount = agentProfile === undefined || agentProfile === sessionAccount;
  const recoveredSessionId = sessionBackend === backend && sameAccount
    ? host.resumableSessionId(run.id, sessionStep) : undefined;
  return { backend, sessionBackend, sameAccount, recoveredSessionId };
}

export function reviveQueuedWorker(context: RunModuleContext, host: QueuedRevivalHost, run: RunRecord, reason: string): void {
  try {
    const job = host.ownedJob(run);
    // Use the privately bound workflow, and the same durable pending-step
    // cursor as root recovery. A queued tail must not replay a failed source.
    host.enqueueJob(run.id, { ...job, startAt: queuedStartAt(run, job.workflow) });
    context.store.appendEvent(run.id, { type: 'lifecycle', message: `${reason} — owned task re-queued` });
  } catch (error) {
    host.move(run.id, 'fail-start', { error: String(error), finishedAt: new Date().toISOString() });
  }
}

/** True when the interrupted run has no session to continue and goes back to the queue. */
export function requeueInterruptedRun(context: RunModuleContext, host: QueuedRevivalHost, run: RunRecord, interruptedStepId: RunRecord['currentStepId']): boolean {
  const interruptedIndex = run.workflowDef?.steps.findIndex(step => step.id === interruptedStepId) ?? -1;
  const interruptedDef = interruptedIndex >= 0 ? run.workflowDef?.steps[interruptedIndex] : undefined;
  // Worktree setup (hearsay-tools/cezarion#917) interrupted before any agent session: there is no session to
  // continue, so start the workflow over. `execute` sees setup still `running` and reruns it.
  if (run.workflowDef && run.worktreeSetup?.status === 'running' && !run.steps.some(step => step.sessionId)) {
    host.move(run.id, 'requeue', { error: undefined, finishedAt: undefined, currentStepId: undefined });
    context.store.flush();
    host.enqueueJob(run.id, { workflow: run.workflowDef, startAt: 0, input: queuedRecoveryInput(run) });
    return true;
  }
  if (run.workflowDef && interruptedDef && stepKind(interruptedDef) === 'check') {
    context.store.updateStep(run.id, interruptedDef.id, { status: 'pending', error: undefined, finishedAt: undefined });
    host.move(run.id, 'requeue', { error: undefined, finishedAt: undefined, currentStepId: undefined });
    context.store.flush();
    host.enqueueJob(run.id, {
      workflow: run.workflowDef,
      startAt: interruptedIndex,
      input: queuedRecoveryInput(run),
    });
    return true;
  }
  return false;
}

/** The persisted definition when it looks sane, else the catalog by name. */
export async function reviveWorkflow(context: RunModuleContext, host: QueuedRevivalHost, run: RunRecord): Promise<WorkflowDef | null> {
  // "Looks sane" is the STORE's job now: it parses `workflowDef` against the definition schema
  // and `.catch`es a def that no longer fits to `undefined`, so anything present here already
  // has the `steps` array the old inline `Array.isArray` check was asking for.
  const def = run.workflowDef;
  if (def) return def;
  const { workflows } = await loadWorkflows(context.repoRoot);
  return workflows.find((w) => w.name === run.workflow) ?? null;
}
