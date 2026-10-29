import type { RunRecord, RunStore, StepState } from '../../runs/store.ts';
import { stepKind, type WorkflowStepDef } from '../types.ts';

type SyntheticContinuationRead = (run: RunRecord, step: StepState) => boolean;

/** A synthetic continuation can settle only the resumed agent turn. If the
 * original workflow still has steps after the waiting one, that would skip
 * those steps rather than resume the workflow engine. */
export function waitingBeforeFinalWorkflowStep(run: RunRecord, isSyntheticContinuation: SyntheticContinuationRead, waitingWorkflowStepIndex: (run: RunRecord) => number): boolean {
  const steps = run.workflowDef?.steps ?? run.steps.filter(step => !isSyntheticContinuation(run, step));
  if (!steps.length || !run.currentStepId) return true;
  const currentStep = run.steps.find(step => step.id === run.currentStepId);
  if (currentStep && isSyntheticContinuation(run, currentStep)) {
    const waiting = waitingWorkflowStepIndex(run);
    return waiting >= 0 && waiting < steps.length - 1;
  }
  const current = steps.findIndex((step) => step.id === run.currentStepId);
  return current < 0 || current < steps.length - 1;
}

/** Locate the original workflow step whose closed session a synthetic Continue is resuming. */
export function waitingWorkflowStepIndex(run: RunRecord, isSyntheticContinuation: SyntheticContinuationRead, ciWorkflowResumeStepIndex: (run: RunRecord) => number): number {
  const steps = run.workflowDef?.steps ?? run.steps.filter(step => !isSyntheticContinuation(run, step));
  if (!steps.length) return -1;
  // CI recovery can resume a failed attempt. Its cursor must survive both the
  // synthetic continuation replacing currentStepId and wait delivery retiring the wait.
  const ciSource = ciWorkflowResumeStepIndex(run);
  if (ciSource >= 0) return ciSource;
  const interrupted = steps.findIndex((step) => {
    const persisted = run.steps.find((candidate) => candidate.id === step.id);
    return stepKind(step) === 'agent' && persisted?.status === 'failed' && persisted.error === 'interrupted — cezar process exited during the run';
  });
  if (interrupted >= 0) return interrupted;
  for (let index = steps.length - 1; index >= 0; index--) {
    const persisted = run.steps.find((step) => step.id === steps[index]!.id);
    // Startup recovery records an interrupted live step as failed before it
    // constructs the synthetic continuation. Later workflow steps are still
    // pending, so that failed step remains the continuation's source.
    if (persisted?.status === 'waiting' || persisted?.status === 'running') return index;
  }
  return -1;
}

export function continuationNextStep(store: Pick<RunStore, 'getRun'>, runId: string, waitingWorkflowStepIndex: (run: RunRecord) => number): WorkflowStepDef | undefined {
  const run = store.getRun(runId);
  const index = run?.workflowDef ? waitingWorkflowStepIndex(run) : -1;
  return index >= 0 ? run!.workflowDef!.steps[index + 1] : undefined;
}

export function ciWorkflowResumeStepIndex(run: RunRecord): number {
  if (!run.workflowResumeStepId) return -1;
  return run.workflowDef?.steps.findIndex(step => step.id === run.workflowResumeStepId &&
    stepKind(step) === 'agent' && run.steps.find(persisted => persisted.id === step.id)?.status === 'failed') ?? -1;
}

/**
 * Session ids Cursor will accept on `session/load`. A launch UUID written
 * before `session.started` is only for the step rail (hearsay-tools/cezarion#583).
 */
export function resumableSessionId(store: Pick<RunStore, 'getRun' | 'readEvents'>, runId: string, sessionStep: StepState | undefined): string | undefined {
  if (!sessionStep?.sessionId) return undefined;
  if ((sessionStep.backend ?? store.getRun(runId)?.runner) === 'cursor') {
    const run = store.getRun(runId);
    const sessionStepIndex = run?.steps.findIndex((step) => step.id === sessionStep.id) ?? -1;
    // A Continue records the existing ID before the resumed process emits its
    // own session event. After a crash, its original owning step still holds
    // the print-session proof; later steps cannot establish that proof.
    const printEvidenceSteps = new Set(run?.steps.slice(0, sessionStepIndex + 1)
      .filter((step) => step.sessionId === sessionStep.sessionId && step.sessionTransport === 'cursor-print')
      .map((step) => step.id));
    const confirmed = store.readEvents(runId).some(
      (event) => event.type === 'session' && event.sessionId === sessionStep.sessionId &&
        (sessionStep.sessionTransport !== 'cursor-print' ||
          (event.stepId !== undefined && printEvidenceSteps.has(event.stepId) &&
            event.sessionTransport === 'cursor-print')),
    );
    if (!confirmed) return undefined;
  }
  return sessionStep.sessionId;
}

export function isSyntheticContinuation(run: RunRecord, step: StepState): boolean {
  if (step.synthetic === 'continuation') return true;
  // Legacy records predate explicit provenance. Only an accepted continuation's
  // durable message links its generated step; an ID prefix alone is never identity.
  return (run.continuationMessage?.id === step.id ||
    (!!run.workflowDef && !run.workflowDef.steps.some(candidate => candidate.id === step.id) &&
      step.kind === 'agent' && step.name === 'Continue')) && /^continue-\d+$/.test(step.id);
}
