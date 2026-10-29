import type { RunnerId } from '../../core/agent-runner.ts';
import { continuationDefStep, type WorkerStepIdentity } from '../../delegation/execution-identity.ts';
import type { RunOutcome } from '../../runs/outcome-commit.ts';
import { isUsageLimitHold } from '@open-mercato/cezar-contract/waits';
import type { RunRecord, RunStore, StepState } from '../../runs/store.ts';
import * as continuation from '../continuation-admission.ts';
import type { ContinueRunOptions } from '../continuation-admission.ts';
import { queuedRecoveryInput } from '../run-scheduling.ts';
import { transition, type RunExitId } from '../run-states.ts';
import { contentBlocksOf, type PastedContent } from '../pasted-content.ts';
import type { WorkflowDef } from '../types.ts';
import type { RunModuleContext, StartRunInput } from './types.ts';
import type { MaintenanceClaims } from './maintenance-claims.ts';
import type { RunLine } from './run-line.ts';
import type { WorkerExecutions } from './worker-executions.ts';
import type { QueuedInput } from './queued-input.ts';
import type { AutoResumeScheduler } from './auto-resume.ts';
import type { WorktreeAutosave } from './worktree-autosave.ts';
import type { WorkerQuestions } from './worker-questions.ts';
import { historyDeletionPending } from './run-guards.ts';
import * as workflowPosition from './workflow-position.ts';
import { hasPendingHumanAsk, pendingHumanAskSeq } from './pending-ask-facts.ts';

interface ContinuationAcceptanceHost {
  isActive(runId: string): boolean;
  move(id: string, exit: RunExitId, patch: Omit<Parameters<RunStore['updateRun']>[1], 'status'>): RunRecord | undefined;
  ownedJob(run: RunRecord): { workflow: WorkflowDef; input: StartRunInput };
  executionBlockedByRootFinish(run: RunRecord): boolean;
  finishWorkerExecution(runId: string): Promise<void>;
  clearWakeBackoff(runId: string): void;
  dropActive(runId: string): void;
  pump(): Promise<void>;
  runContinuation(runId: string, stepId: string, sessionId: string | undefined, backend: RunnerId, prompt: string, images: PastedContent[]): Promise<void>;
  workerStep(runId: string, stepId: string | undefined): WorkerStepIdentity | undefined;
  isUntouchedCancelledRun(run: RunRecord): boolean;
  admissionError(error: unknown, fallback: string): string;
  isSyntheticContinuation(run: RunRecord, step: StepState): boolean;
}

export class ContinuationAcceptance {
  constructor(private readonly context: RunModuleContext, private readonly host: ContinuationAcceptanceHost,
    private readonly claims: MaintenanceClaims, private readonly line: RunLine, private readonly workerExecutions: WorkerExecutions,
    private readonly queuedInput: QueuedInput, private readonly autoResumeScheduler: AutoResumeScheduler,
    private readonly worktreeAutosave: WorktreeAutosave, private readonly workerQuestions: WorkerQuestions,
    private readonly routedQuestionRefusal: string, private readonly restartContinuationPrompt: string) {}
  /** Accepted Continues supersede in-flight settlement even before launch or after
   * idle close. Retain these across dropActive/dispose so absence cannot look like
   * the earlier execution again; disposal alone never revokes terminal intent. */
  private readonly continuationGenerations = new Map<string, symbol>();
  generation(runId: string): symbol | undefined { return this.continuationGenerations.get(runId); }

  /** Saves an accepted continuation. A human Continue also answers every human wait, ends failed
   *  deliveries and restarts the budget, in the same best-effort commit. */
  private commitContinuation(runId: string, human: boolean): void {
    const outcomes: RunOutcome[] = [{ kind: 'answered' }, { kind: 'counted', waitDeliveryFailures: undefined },
      ...(this.context.store.getRun(runId)?.automaticWakes ? [{ kind: 'charged' as const, automaticWakes: 0 }] : [])];
    if (!human || !this.context.store.commitOutcome(runId, outcomes, {}, { bestEffort: true }).committed) this.context.store.flush();
  }

  admitContinuation(
    runId: string,
    opts: ContinueRunOptions,
    deferForCapacity: boolean,
    conversation: continuation.ContinuationConversation,
  ): { ok: boolean; error?: string } {
    const admitted = new continuation.ContinuationChecks(runId, this.context.repoRoot, opts, deferForCapacity, conversation, {
      active: () => this.host.isActive(runId),
      autosaveBlocker: () => this.worktreeAutosave.autosaveCleanupBlocker(runId),
      reclaiming: () => this.claims.has(runId),
      run: () => this.context.store.getRun(runId),
      historyDeletionPending: () => historyDeletionPending(this.context.store, runId),
      parentInReview: parentId => this.context.store.getRun(parentId)?.status === 'review',
      answersFallback: () => this.workerQuestions.answersFallenBackAsk(runId, opts, deferForCapacity),
      identity: (run, session) => this.host.workerStep(runId, continuationDefStep(this.context.store, run, session)?.id),
      beforeFinalStep: run => workflowPosition.waitingBeforeFinalWorkflowStep(run, (record, step) => this.host.isSyntheticContinuation(record, step), record => this.waitingWorkflowStepIndex(record)),
      waitingStepIndex: run => this.waitingWorkflowStepIndex(run),
      pendingFallback: () => this.workerQuestions.pendingWorkerFallback(runId),
      pendingAsk: () => hasPendingHumanAsk(runId, id => pendingHumanAskSeq(this.context.store, id)),
      rootFinishing: run => this.host.executionBlockedByRootFinish(run),
      routedAsk: () => this.workerQuestions.routedAsk(runId),
      ciStepIndex: run => workflowPosition.ciWorkflowResumeStepIndex(run),
      untouched: run => this.host.isUntouchedCancelledRun(run),
      sessionId: step => workflowPosition.resumableSessionId(this.context.store, runId, step),
    }, this.routedQuestionRefusal).prepare();
    if (!admitted.ok) return admitted;
    return this.acceptContinuation(runId, opts, deferForCapacity, conversation, admitted);
  }

  /** Overrides still persist before the execution checkpoint, even if that checkpoint refuses. */
  private acceptContinuation(runId: string, opts: ContinueRunOptions, deferForCapacity: boolean,
    conversation: continuation.ContinuationConversation, admitted: continuation.ContinuationAdmission): { ok: boolean; error?: string } {
    if (admitted.identity === undefined && continuation.hasOverrides(opts)) {
      const refusal = continuation.modelRefusal(opts, admitted.targetRunner);
      if (refusal) return refusal;
      this.context.store.updateRun(runId, continuation.overridePatch(admitted.run, opts, admitted.targetRunner, admitted.originalRunner));
    }
    if (admitted.untouched) return this.acceptUntouchedContinuation(runId, opts, admitted.supersedes);
    return this.acceptResumedContinuation(runId, opts, deferForCapacity, conversation, admitted);
  }

  private acceptUntouchedContinuation(runId: string, opts: ContinueRunOptions, supersedes: boolean): { ok: boolean; error?: string } {
    const current = this.context.store.getRun(runId)!;
    let job: { workflow: WorkflowDef; input: StartRunInput };
    try {
      job = current.delegation?.role === 'worker'
        // A projection of the job the line will start, not a status write.
        // ast-grep-ignore: run-status-write-outside-transition
        ? this.host.ownedJob({ ...current, status: 'queued' })
        : { workflow: current.workflowDef!, input: queuedRecoveryInput(current) };
      this.workerExecutions.beginWorkerExecution(runId, false);
    } catch (error) { return { ok: false, error: this.host.admissionError(error, 'original execution checkpoint unavailable') }; }
    if (supersedes) this.workerQuestions.supersedeWorkerFallback(runId);
    const content = continuation.content(opts);
    const message = content.length ? this.queuedInput.toQueuedMessage(runId, content) : undefined;
    this.autoResumeScheduler.clearAutoResume(runId);
    this.context.store.setArchived(runId, false);
    this.host.move(runId, 'continue-line', { stopping: undefined, error: undefined, finishedAt: undefined,
      currentStepId: undefined, ...(message ? { queuedMessages: [...(current.queuedMessages ?? []), message] } : {}) });
    this.context.store.flush();
    this.line.enqueueJob(runId, job);
    void this.host.pump();
    return { ok: true };
  }

  private acceptResumedContinuation(runId: string, opts: ContinueRunOptions, deferForCapacity: boolean,
    conversation: continuation.ContinuationConversation, admitted: continuation.ContinuationAdmission): { ok: boolean; error?: string } {
    const { run, supersedes } = admitted;
    // Usage-limit holds join the line even for a human Continue, behind known account deadlines.
    const toLine = deferForCapacity || isUsageLimitHold(run);
    try { this.workerExecutions.beginWorkerExecution(runId, !toLine); }
    catch (error) { return { ok: false, error: this.host.admissionError(error, 'worker execution checkpoint unavailable') }; }
    this.autoResumeScheduler.clearAutoResume(runId);
    if (!deferForCapacity) this.host.clearWakeBackoff(runId);
    const failure = continuation.previousFailure(run);
    const continuationStep = continuation.nextStep(run);
    const stepId = continuationStep.id;
    if (run.delegation?.role !== 'worker') this.context.store.addStep(runId, continuationStep);
    const recovered = deferForCapacity && !conversation && !opts.answerInputId ? run.continuationMessage : undefined;
    const message = recovered ?? this.queuedInput.toQueuedMessage(runId, continuation.content(opts));
    const { prompt, resumeContext } = continuation.opening(message, recovered, deferForCapacity, conversation, opts,
      this.restartContinuationPrompt, failure);
    // The recoverable status and original input must commit before startup can await anything.
    const acceptedPatch = {
      continuationMessage: continuation.acceptedMessage(message, stepId, prompt, resumeContext, recovered, conversation, opts, deferForCapacity),
      status: transition(toLine ? 'continue-line' : 'continue-now', () => this.context.store.getRun(runId)),
      error: undefined,
      finishedAt: undefined,
      currentStepId: toLine ? undefined : stepId,
      invalidAsk: undefined,
      archived: false,
      archivedAt: undefined,
    };
    const refusal = this.checkpointContinuation(runId, run, acceptedPatch, continuationStep, conversation);
    if (refusal) return refusal;
    if (supersedes) this.workerQuestions.supersedeWorkerFallback(runId);
    // Resolve waits/restart budgets only with or after the dependent answer (hearsay-tools/cezarion#1805).
    this.commitContinuation(runId, !deferForCapacity);
    this.continuationGenerations.set(runId, Symbol());
    const images = contentBlocksOf(opts.images ?? []).filter(block => block.type === 'image');
    return this.dispatchAcceptedContinuation(runId, toLine, stepId, admitted.resumeSessionId, admitted.targetRunner, prompt, images);
  }

  private checkpointContinuation(runId: string, run: RunRecord,
    acceptedPatch: Parameters<RunStore['commitWorkerContinuation']>[1],
    continuationStep: Parameters<RunStore['commitWorkerContinuation']>[2],
    conversation: continuation.ContinuationConversation): continuation.ContinuationRefusal | undefined {
    if (run.delegation?.role === 'worker') {
      try { this.context.store.commitWorkerContinuation(runId, acceptedPatch, continuationStep, conversation); }
      catch {
        // No session exists yet. Release the private reservation through execution finalization.
        void this.host.finishWorkerExecution(runId);
        return { ok: false, error: 'worker execution checkpoint unavailable' };
      }
    } else this.context.store.updateRun(runId, acceptedPatch);
  }

  private dispatchAcceptedContinuation(runId: string, toLine: boolean, stepId: string,
    resumeSessionId: string | undefined, targetRunner: RunnerId, prompt: string, images: PastedContent[]): { ok: boolean } {
    if (toLine) {
      this.line.enqueueContinuation(runId, {
        stepId, sessionId: resumeSessionId, backend: targetRunner, prompt, images, lineJoinedAt: Date.now(),
      });
      this.host.move(runId, 'continue-line', { error: undefined, finishedAt: undefined, currentStepId: undefined });
      // Enqueueing wakes the scheduler even after the previous execution released its slot.
      void this.host.pump();
      return { ok: true };
    }
    this.line.markStarting(runId);
    void this.context.work.track('runContinuation', this.host.runContinuation(runId, stepId, resumeSessionId, targetRunner, prompt, images))
      .catch((err: unknown) => this.failCrashedContinuation(runId, err))
      .finally(() => this.host.finishWorkerExecution(runId));
    return { ok: true };
  }

  /** A Continue whose engine threw: the run fails and leaves the active set (exit `fail-crash`). */
  failCrashedContinuation(runId: string, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    this.host.move(runId, 'fail-crash', {
      error: `continue crashed: ${message}`,
      finishedAt: new Date().toISOString(),
    });
    this.line.unmarkStarting(runId);
    this.host.dropActive(runId);
  }

  private waitingWorkflowStepIndex(run: RunRecord): number {
    return workflowPosition.waitingWorkflowStepIndex(run, (record, step) => this.host.isSyntheticContinuation(record, step), workflowPosition.ciWorkflowResumeStepIndex);
  }
}
