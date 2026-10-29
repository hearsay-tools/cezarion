import { existsSync } from 'node:fs';
import type { RunRecord, RunStore, StepState } from '../../runs/store.ts';
import type { UiEventSink } from '../../runs/ui-event-sink.ts';
import type { ActiveRun } from '../active-run.ts';
import type { WorkflowDef, WorkflowStepDef } from '../types.ts';
import type { ContinuationClose, SessionTurn, StepLoop, RunModuleContext } from './types.ts';
import type { RunExitId } from '../run-states.ts';
import { RUN_EXITS, transition, transitionVia } from '../run-states.ts';
import { settledRootFinishPatch } from '../completion-policy.ts';
import { queuedRecoveryInput } from '../run-scheduling.ts';
import { loadConfig } from '../../config.ts';
import { worktreeDiff, type AutosaveReason } from '../../git-worktree.ts';
import { reviewGateEnabled } from '../../runs/review-gate.ts';
import { settlesAsDone } from './steps.ts';
import { clearIdleTimer, clearAutosaveTimer } from './input-timers.ts';
import { hasPendingHumanAsk, pendingHumanAskSeq } from './pending-ask-facts.ts';
import { waitingBeforeFinalWorkflowStep, waitingWorkflowStepIndex, ciWorkflowResumeStepIndex } from './workflow-position.ts';
import * as stepDecisions from './step-decisions.ts';
import * as completionGateReads from './completion-gate.ts';
import type { HumanWaits } from './human-waits.ts';
import type { WorkerQuestions } from './worker-questions.ts';
import type { WorktreeAutosave } from './worktree-autosave.ts';
import type { RunLine } from './run-line.ts';
import type { TurnBookkeeper } from './turn-bookkeeping.ts';
import type { AutoResumeScheduler } from './auto-resume.ts';
import type { WorkerExecutions } from './worker-executions.ts';
import { settledRunFamilies } from '../../delegation/conversations.ts';

interface RunSettlementHost {
  active: Map<string, ActiveRun>;
  isSyntheticContinuation(run: RunRecord, step: StepState): boolean;
  generation(id: string): symbol | undefined;
  isActive(id: string): boolean;
  move(id: string, exit: RunExitId, patch?: Omit<Parameters<RunStore['updateRun']>[1], 'status'>): RunRecord | undefined;
  dropActive(id: string): void;
  saveWorktree(id: string, state: ActiveRun, reason: AutosaveReason): Promise<void>;
  settleSuccess(id: string, durableRootFinish?: boolean, keepStepId?: string): Promise<void>;
  deferParentCompletion(id: string): boolean;
  closingWakeDecision(id: string, holds: boolean, cancelled: boolean, error: string | undefined): 'park' | 'settle' | 'capped';
  owesDelivery(id: string): boolean;
  preserveRunAfterDisposal(id: string, state: ActiveRun): boolean;
  isDisposedDelegatedRun(id: string): boolean;
  queueWaitWake(id: string): void;
  reconcileWorkerWaits(id?: string): void;
  releaseSlot(): void;
  enforceRetention(): Promise<void>;
  reapTerminalScratch(id: string): void;
  forgetMemoryPause(id: string): void;
}
export class RunSettlement {
  constructor(private readonly context: RunModuleContext, private readonly humanWaits: HumanWaits,
    private readonly workerQuestions: WorkerQuestions, private readonly worktreeAutosave: WorktreeAutosave,
    private readonly turnBookkeeper: TurnBookkeeper, private readonly line: RunLine,
    private readonly autoResumeScheduler: AutoResumeScheduler, private readonly workerExecutions: WorkerExecutions,
    private readonly completionGateHost: completionGateReads.CompletionGateHost, private readonly host: RunSettlementHost,
    private readonly wakeSessionClosedError: string, private readonly wakeDeliveryCapNote: string) {}
  private waitingWorkflowStepIndex(run: RunRecord): number {
    return waitingWorkflowStepIndex(run, this.host.isSyntheticContinuation, ciWorkflowResumeStepIndex);
  }
  /** A detail's finish verdict reads the live registries, and a session leaves them after its
   *  last write (the final autosave), so the cockpit's refetch on that write still saw "no open
   *  session" and hid Accept. Publish a resting run again once it is out of them
   *  (hearsay-tools/cezarion#1301). */
  republishFinishVerdict(runId: string): void {
    if (this.context.disposed() || this.host.isActive(runId)) return;
    const status = this.context.store.getRun(runId)?.status;
    if (status === 'waiting' || status === 'review') this.context.store.republish(runId);
  }

  /** A clean process exit cannot complete a workflow still blocked on a question.
   * Keep its existing durable waiting step so Continue can resume the tail. Cezar's fallback
   * question on a worker is not one: the clean exit supersedes it, so the workflow goes on as the
   * plain park it replaced did (hearsay-tools/cezarion#1301). */
  supersedeFallbackThenWorkflowAsk(runId: string, state: ActiveRun): boolean {
    if (!state.finishRequested) this.workerQuestions.supersedeWorkerFallback(runId);
    const run = this.context.store.getRun(runId);
    return !state.finishRequested && !!run && hasPendingHumanAsk(runId, id => pendingHumanAskSeq(this.context.store, id)) &&
      waitingBeforeFinalWorkflowStep(run, this.host.isSyntheticContinuation, record => this.waitingWorkflowStepIndex(record));
  }

  /**
   * Whether a step session closed without its done while a later step waits (hearsay-tools/cezarion#1620).
   * It reads the done `closeAsDone` recorded; callers clear the consumed mark. Finish is an explicit stop, settled as before.
   */
  stepLeftOpen(state: ActiveRun, stepId: string, next: WorkflowStepDef | undefined): boolean {
    const completed = state.completedStepId === stepId;
    return !!next && !completed && !state.finishRequested;
  }

  /** Consume the completion mark only when Continue reaches its completion check. */
  private continuationLeftOpen(state: ActiveRun, stepId: string, next: WorkflowStepDef | undefined): boolean {
    if (state.cancelled) return false;
    const open = this.stepLeftOpen(state, stepId, next);
    state.completedStepId = undefined;
    return open;
  }

  /** A resumed earlier step that closed without a done stays open: its workflow step, not the Continue's own. */
  async settleIncompleteContinuation(runId: string, stepId: string): Promise<void> {
    const resumed = this.context.store.getRun(runId);
    const source = resumed ? resumed.workflowDef?.steps[this.waitingWorkflowStepIndex(resumed)] : undefined;
    await this.settleIncompleteStep(runId, source?.id ?? stepId);
  }

  /** Settle a Continue whose session closed without a fault: undelivered wakes, a Stop, a step left
   *  open, a done, or an idle close. Returns the settlement to wait for, or undefined when it
   *  completed without yielding. */
  settleClosedContinuation(
    runId: string,
    state: ActiveRun,
    stepId: string,
    sink: UiEventSink,
    resumedNext: WorkflowStepDef | undefined,
    close: ContinuationClose,
  ): Promise<void> | undefined {
    if (completionGateReads.holdsClosingWakes(this.context, this.completionGateHost, runId) && !state.cancelled) {
      this.settleClosingWakes(runId, state, stepId, sink);
      return undefined;
    }
    if (!state.cancelled) {
      this.context.store.updateRun(runId, { continuationMessage: undefined });
      this.context.store.flush();
    }
    sink.sessionEnded(state.cancelled ? 'cancelled' : 'end_turn');
    const incomplete = this.continuationLeftOpen(state, stepId, resumedNext);
    const kind = stepDecisions.continuationCloseKind(state.cancelled, incomplete,
      !state.cancelled && !incomplete && (state.idleClosed || this.supersedeFallbackThenWorkflowAsk(runId, state)));
    if (kind === 'cancelled') {
      this.settleCancelledContinuation(runId, stepId);
      return undefined;
    }
    if (kind === 'incomplete') return this.settleIncompleteContinuation(runId, stepId);
    if (kind === 'done') return this.settleDoneContinuation(runId, state, stepId, close);
    return this.settleIdleClosedRun(runId, state);
  }

  /** The session closed with wakes it still holds: park the run, or fail it when their delivery
   *  failed. */
  settleClosingWakes(runId: string, state: ActiveRun, stepId: string, sink: UiEventSink): void {
    sink.sessionEnded('end_turn');
    // A clean close that leaves results undelivered is a failed delivery too.
    const delivery = this.host.closingWakeDecision(runId, true, false, this.host.owesDelivery(runId) ? this.wakeSessionClosedError : undefined);
    if (delivery === 'park') {
      // No turn end will show a human wait this session registered (hearsay-tools/cezarion#1234).
      this.humanWaits.surfaceHumanWait(runId, state);
      this.host.move(runId, 'park');
      return;
    }
    this.context.store.updateStep(runId, stepId, { status: 'failed', error: this.wakeSessionClosedError, finishedAt: new Date().toISOString() });
    this.context.store.appendEvent(runId, { type: 'step-end', stepId, status: 'failed' });
    this.host.move(runId, 'fail', { error: `continue failed: ${this.wakeSessionClosedError}`, finishedAt: new Date().toISOString(), currentStepId: undefined });
    this.context.store.appendEvent(runId, { type: 'lifecycle', message: `continue failed — ${this.wakeSessionClosedError}` });
    this.context.store.appendEvent(runId, { type: 'note', message: this.wakeDeliveryCapNote });
  }

  /** A Stop ended the Continue's session: cancel its step and the run. */
  settleCancelledContinuation(runId: string, stepId: string): void {
    this.context.store.updateStep(runId, stepId, { status: 'cancelled', finishedAt: new Date().toISOString() });
    this.host.move(runId, 'cancel', { finishedAt: new Date().toISOString(), currentStepId: undefined });
    this.context.store.appendEvent(runId, { type: 'lifecycle', message: 'run cancelled' });
  }

  /** The Continue's step is done: settle the run, or the workflow step it resumed. Returns the
   *  settlement to wait for, or undefined when it queued the workflow remainder. */
  settleDoneContinuation(runId: string, state: ActiveRun, stepId: string, close: ContinuationClose): Promise<void> | undefined {
    this.context.store.updateStep(runId, stepId, { status: 'done', finishedAt: new Date().toISOString() });
    this.context.store.appendEvent(runId, { type: 'step-end', stepId, status: 'done' });
    const completed = this.context.store.getRun(runId);
    const waitingIndex = completed ? this.waitingWorkflowStepIndex(completed) : -1;
    if (completed?.workflowDef && waitingIndex >= 0) {
      return this.settleResumedWorkflowStep(runId, state, stepId, completed, completed.workflowDef, waitingIndex, close);
    }
    return this.succeedContinuation(runId, stepId);
  }

  /** The Continue finished the workflow step it resumed: queue the workflow remainder, or settle
   *  the run when none is left or Finish was requested. */
  settleResumedWorkflowStep(
    runId: string,
    state: ActiveRun,
    stepId: string,
    completed: RunRecord,
    workflow: WorkflowDef,
    waitingIndex: number,
    close: ContinuationClose,
  ): Promise<void> | undefined {
    const waitingStep = workflow.steps[waitingIndex]!;
    // The continuation succeeded, not the failed attempt it recovered.
    if (waitingStep.id !== completed.workflowResumeStepId) {
      this.context.store.updateStep(runId, waitingStep.id, { status: 'done', finishedAt: new Date().toISOString() });
      this.context.store.appendEvent(runId, { type: 'step-end', stepId: waitingStep.id, status: 'done' });
    }
    // Finish accepts this resumed step before the async settlement gate,
    // but must not launch the remaining workflow. A later cancellation
    // may cancel still-live steps, never this completed one (R30).
    if (!state.finishRequested && waitingIndex < workflow.steps.length - 1) {
      close.resumeWorkflow = {
        workflow,
        startAt: waitingIndex + 1,
        input: queuedRecoveryInput(completed),
      };
      this.host.move(runId, 'requeue', { currentStepId: undefined, workflowResumeStepId: undefined });
      // The workflow remainder is a crash boundary. Persist it before the
      // finally block awaits worktree autosave and installs its in-memory job.
      this.context.store.flush();
      return undefined;
    }
    this.context.store.updateRun(runId, { workflowResumeStepId: undefined });
    return this.succeedContinuation(runId, stepId);
  }

  /** Settle the run after a successful Continue. */
  async succeedContinuation(runId: string, stepId: string): Promise<void> {
    await this.host.settleSuccess(runId);
  }

  /** The Continue's session failed, or its settlement threw: fail its step, then park the run
   *  when it still holds wakes, else fail it. */
  settleFailedContinuation(
    runId: string,
    state: ActiveRun,
    stepId: string,
    sink: UiEventSink,
    turn: SessionTurn,
    err: unknown,
  ): void {
    // Keep the provider failure that triggered teardown, even if teardown rejects.
    const message = turn.sessionError ?? state.agentInputError ?? (err instanceof Error ? err.message : String(err));
    sink.sessionEnded('error', message);
    this.context.store.updateStep(runId, stepId, { status: 'failed', error: message, finishedAt: new Date().toISOString() });
    this.humanWaits.withdrawCezarHumanWaits(runId);
    const delivery = this.host.closingWakeDecision(runId, completionGateReads.holdsClosingWakes(this.context, this.completionGateHost, runId), state.cancelled, message);
    if (delivery === 'park') {
      // Retain the wait and scheduler wake source while closing this attempt.
      // settleSuccess only completes running/waiting steps, so its failure is durable.
      this.humanWaits.surfaceHumanWait(runId, state);
      this.context.store.appendEvent(runId, { type: 'step-end', stepId, status: 'failed' });
      this.host.move(runId, 'park', { error: `continue failed: ${message}` });
      return;
    }
    this.host.move(runId, 'fail-continue', {
      error: `continue failed: ${message}`,
      finishedAt: new Date().toISOString(),
      currentStepId: undefined,
    });
    this.context.store.appendEvent(runId, { type: 'lifecycle', message: `continue failed — ${message}` });
    if (delivery === 'capped') this.context.store.appendEvent(runId, { type: 'note', message: this.wakeDeliveryCapNote });
  }

  /**
   * Settles the run once the step loop of `execute` ended: the final autosave, then the
   * cancelled, failed, incomplete-step, idle-closed or success settlement.
   */
  async settleExecution(runId: string, state: ActiveRun, loop: StepLoop): Promise<void> {
    // Final autosave: the task branch ends holding the finished state; on a branch the
    // agent checked out, the work stays uncommitted and the handoff's Autosave section
    // says so (#1004).
    clearAutosaveTimer(state);
    await this.host.saveWorktree(runId, state, 'run finalize');

    if (this.host.preserveRunAfterDisposal(runId, state)) {
      clearIdleTimer(state);
      this.host.dropActive(runId);
      return;
    }
    const settlement = stepDecisions.executionSettlementKind(state.cancelled, loop.runError, loop.incompleteStepId,
      !state.cancelled && !loop.runError && !loop.incompleteStepId && (state.idleClosed || this.supersedeFallbackThenWorkflowAsk(runId, state)));
    if (settlement.kind === 'cancelled') {
      this.settleCancelledRun(runId);
    } else if (settlement.kind === 'failed') {
      this.settleFailedRun(runId, settlement.error, loop.deliveryCapped);
    } else if (settlement.kind === 'incomplete') {
      await this.settleIncompleteStep(runId, settlement.stepId);
    } else if (settlement.kind === 'idle') {
      await this.settleIdleClosedRun(runId, state);
      this.host.dropActive(runId);
      return;
    } else {
      await this.host.settleSuccess(runId);
    }
    clearIdleTimer(state);
    this.host.dropActive(runId);
  }

  /** The cancelled settlement: the run and its running and waiting steps become cancelled. */
  settleCancelledRun(runId: string): void {
    const finishedAt = new Date().toISOString();
    const run = this.context.store.getRun(runId);
    for (const s of run?.steps ?? []) {
      if (s.status === 'running' || s.status === 'waiting') {
        this.context.store.updateStep(runId, s.id, { status: 'cancelled' });
      }
    }
    this.host.move(runId, 'cancel', { finishedAt, currentStepId: undefined });
    this.context.store.appendEvent(runId, { type: 'lifecycle', message: 'run cancelled' });
  }

  /** The failed settlement. A capped wake delivery adds the cap's note. */
  settleFailedRun(runId: string, runError: string, deliveryCapped: boolean): void {
    const finishedAt = new Date().toISOString();
    this.host.move(runId, 'fail', { error: runError, finishedAt, currentStepId: undefined });
    this.context.store.appendEvent(runId, { type: 'lifecycle', message: `run failed — ${runError}` });
    if (deliveryCapped) this.context.store.appendEvent(runId, { type: 'note', message: this.wakeDeliveryCapNote });
  }

  /**
   * Diff-first review gate (spec 009), shared by `execute` and
   * `runContinuation`: a *successful* run whose worktree holds changes rests
   * at `review` instead of `done` — the user inspects the diff first, then
   * sends feedback back, opens a draft PR, or just finishes. Failed/cancelled
   * runs never enter review; no worktree or an empty diff means plain `done`.
   *
   * The gate is opt-in (open-mercato/cezar#489): the review park happens only when it is enabled
   * (`reviewGateEnabled` — config toggle over the `CEZ_REVIEW_GATE` env, default
   * OFF) AND the run is not autonomous. Autonomous runs — and runs with the gate
   * off — settle straight to `done`, leaving the diff in the worktree untouched.
   */
  settleSuccess(runId: string, durableRootFinish = false, keepStepId?: string): Promise<void> {
    return this.context.work.track('settleSuccess', this.settleSuccessWork(runId, durableRootFinish, keepStepId));
  }

  private async settleSuccessWork(runId: string, durableRootFinish = false, keepStepId?: string): Promise<void> {
    const state = this.host.active.get(runId);
    const continuationGeneration = this.host.generation(runId);
    if (this.host.deferParentCompletion(runId)) return;
    const run = this.context.store.getRun(runId);
    let review = false;
    if (run?.worktreePath && existsSync(run.worktreePath)) {
      review = await this.successNeedsReview(run, run.worktreePath, durableRootFinish);
    }
    // Diff/config I/O can race cancellation or a replacement execution. Re-read
    // the record before touching steps, and never settle another session's work.
    const current = this.context.store.getRun(runId);
    if (!current || this.successSuperseded(runId, current.status, state, continuationGeneration)) return;
    if (state?.cancelled) {
      this.settleCancelledSuccess(runId, current);
      return;
    }
    // A worker's accepted continuation or a new child can defer parent completion.
    if (this.host.deferParentCompletion(runId)) return;
    if (durableRootFinish) {
      // A later explicit cancellation wins over a slow diff. Publication/cascade
      // follows the atomic terminal/step checkpoint, never the other way around.
      const exit = review ? 'succeed-review' as const : 'succeed' as const;
      if (!transitionVia(exit, () => this.context.store.getRun(runId), () => this.context.store.commitRootFinishSuccess(runId, RUN_EXITS[exit].to))) return;
    } else {
      this.commitOrdinarySuccess(runId, review, keepStepId);
    }
    this.context.store.appendEvent(runId, {
      type: 'lifecycle',
      message: review
        ? 'changes ready for review — send feedback, open a draft PR, or finish'
        : 'run finished',
    });
  }

  /**
   * Whether a successful run rests at `review`: its worktree holds a diff, the review gate is
   * on, and the run is not autonomous. A root finish cannot settle without a diff, so a failed
   * diff throws for it.
   */
  async successNeedsReview(run: RunRecord, worktreePath: string, durableRootFinish: boolean): Promise<boolean> {
    // An unresolved autosave may still own the real index. Conservatively
    // treat its retained work as reviewable without starting `git add -N`.
    const diff = this.worktreeAutosave.autosaveCleanupBlocker(run.id)
      ? 'autosave cleanup pending'
      : await worktreeDiff(worktreePath, run.baseBranch ?? 'HEAD');
    if (durableRootFinish && diff.startsWith('(diff failed')) throw new Error('parent finish diff unavailable');
    const hasDiff = diff.trim().length > 0 && !diff.startsWith('(diff failed');
    const config = await loadConfig(this.context.repoRoot);
    return hasDiff && reviewGateEnabled(config) && run.autonomous !== true;
  }

  /** True when the success settlement must not write: the run is no longer live, a newer
   *  continuation started, or another execution replaced the one that began settling. */
  successSuperseded(
    runId: string,
    status: RunRecord['status'],
    state: ActiveRun | undefined,
    continuationGeneration: symbol | undefined,
  ): boolean {
    const active = this.host.active.get(runId);
    // Disposal clears active, but cannot revoke an already accepted Finish/Stop.
    // A different active state is still a replacement, even after disposal.
    const disposedWithTerminalIntent = this.context.disposed() && active === undefined && (state?.finishRequested || state?.cancelled);
    return !['queued', 'running', 'waiting'].includes(status) ||
      this.host.generation(runId) !== continuationGeneration ||
      (active !== state && !disposedWithTerminalIntent);
  }

  /** A Stop accepted while the success settlement read the diff: the run and its running and
   *  waiting steps become cancelled, and a step keeps a finish time it already has. */
  settleCancelledSuccess(runId: string, current: RunRecord): void {
    const finishedAt = new Date().toISOString();
    for (const step of current.steps) {
      if (step.status === 'running' || step.status === 'waiting') {
        this.context.store.updateStep(runId, step.id, { status: 'cancelled', finishedAt: step.finishedAt ?? finishedAt });
      }
    }
    this.host.move(runId, 'cancel', { finishedAt, currentStepId: undefined });
    this.context.store.appendEvent(runId, { type: 'lifecycle', message: 'run cancelled' });
  }

  /** The ordinary success path (not a root finish): the steps that settle as done, then the run
   *  as `review` or `done`. */
  commitOrdinarySuccess(runId: string, review: boolean, keepStepId: string | undefined): void {
    const finishedAt = new Date().toISOString();
    // An idle-closed Continue remains waiting until the whole task succeeds.
    // Complete those intermediate steps before publishing terminal run status.
    // A worker's incomplete earlier step stays `waiting`: a parent resume re-enters it (hearsay-tools/cezarion#1620).
    for (const step of this.context.store.getRun(runId)?.steps ?? []) {
      if (settlesAsDone(step, keepStepId)) {
        this.context.store.updateStep(runId, step.id, { status: 'done', finishedAt: step.finishedAt ?? finishedAt });
      }
    }
    this.context.store.updateRun(runId, {
      status: transition(review ? 'succeed-review' : 'succeed', () => this.context.store.getRun(runId)),
      ...settledRootFinishPatch(this.context.store, runId),
      finishedAt,
      currentStepId: undefined,
      // A run that got all the way to a settled turn is not in a limit loop, so the resume
      // counter starts over — otherwise a task that legitimately met the limit once a week would
      // creep toward the cap forever and stop resuming for no reason anyone could see.
      autoResumeAttempts: undefined,
    });
  }

  /** Called only after session/process settlement. A refused nudge retained its
   * slot and running status until idle close; ordinary roots must now become
   * resumable. Previously parked roots and delegated lifecycle policy stay intact. */
  async settleIdleClosedRun(runId: string, state: ActiveRun): Promise<void> {
    const run = this.context.store.getRun(runId);
    if (run?.delegation?.role === 'worker') {
      await this.settleIdleClosedWorker(runId);
      return;
    }
    if (!run || !state.autonomousNudgePending || run.waits?.length || hasPendingHumanAsk(runId, id => pendingHumanAskSeq(this.context.store, id))) return;
    for (const step of run.steps) {
      if (step.status === 'running') this.context.store.updateStep(runId, step.id, { status: 'waiting' });
    }
    this.host.move(runId, 'park');
    this.context.store.flush();
  }

  /** An ordinary owned worker cannot accept an inactive Continue. Once its
   * idle-closed process has ended, publish the same terminal outcome recovery
   * would produce so its parent can collect it. Explicit asks and worker waits
   * remain durable attention states. */
  async settleIdleClosedWorker(runId: string, keepStepId?: string): Promise<boolean> {
    // An idle close supersedes Cezar's fallback question, so the worker settles as its plain park
    // did (hearsay-tools/cezarion#1301).
    this.workerQuestions.supersedeWorkerFallback(runId);
    const run = this.context.store.getRun(runId);
    if (run?.delegation?.role !== 'worker' || hasPendingHumanAsk(runId, id => pendingHumanAskSeq(this.context.store, id))) return false;
    const finishedAt = new Date().toISOString();
    if (run.invalidAsk) {
      for (const step of run.steps) if (step.status === 'waiting' || step.status === 'running') {
        this.context.store.updateStep(runId, step.id, { status: 'failed', error: 'invalid structured question', finishedAt });
      }
      this.host.move(runId, 'fail', { error: 'invalid structured question', finishedAt, currentStepId: undefined });
      return true;
    }
    for (const step of run.steps) {
      if (settlesAsDone(step, keepStepId)) {
        this.context.store.updateStep(runId, step.id, { status: 'done', finishedAt });
      }
    }
    await this.host.settleSuccess(runId, false, keepStepId);
    return true;
  }

  /**
   * An earlier workflow step whose session closed without a done: a clean exit, an idle close, or
   * a Continue that resumed it and closed the same way (hearsay-tools/cezarion#1620). The step stays
   * `waiting` and the tail never starts. A root waits for Continue, which resumes the step. An owned
   * worker settles as a single-step task's close does, so its parent can collect it; the step stays
   * `waiting`, and a parent resume re-enters it. A question still pending keeps either one waiting.
   */
  async settleIncompleteStep(runId: string, stepId: string): Promise<void> {
    const run = this.context.store.getRun(runId);
    if (!run) return;
    for (const step of run.steps) if (step.status === 'running') this.context.store.updateStep(runId, step.id, { status: 'waiting' });
    // A failed attempt a continuation recovers stays failed: the resume cursor finds it as it is.
    if (run.steps.find(step => step.id === stepId)?.status !== 'failed') this.context.store.updateStep(runId, stepId, { status: 'waiting' });
    this.context.store.appendEvent(runId, { type: 'lifecycle', stepId, message: `step "${stepId}" ended without done — Continue to resume it` });
    if (run.delegation?.role === 'worker' && await this.settleIdleClosedWorker(runId, stepId)) return;
    this.host.move(runId, 'park');
    this.context.store.flush();
  }

  afterDropActive(runId: string): void {
    // Open waits keep their watch or timer: their result reopens the run when it resolves. A
    // refusal queued for the closing session reopens it now (hearsay-tools/cezarion#1301).
    // A queued wake can pump before the usage-limit schedule. This is safe because
    // canQueueWaitWake refuses failed runs, while the schedule only acts on failed runs.
    if (!this.context.disposed() && (this.context.store.getRun(runId)?.waits?.length || completionGateReads.owesCompletionRefusal(this.context, this.completionGateHost, runId))) this.host.queueWaitWake(runId);
    if (!this.workerExecutions.has(runId) && this.context.store.getRun(runId)?.stopping) this.context.store.updateRun(runId, { stopping: undefined });
    this.republishFinishVerdict(runId);
    this.host.forgetMemoryPause(runId);
    this.turnBookkeeper.forget(runId);
    this.line.clearForced(runId);
    if (this.host.isDisposedDelegatedRun(runId)) return; // teardown above, no autonomous durable side effects
    // The run's slot is gone from busySlots() as of the deletes above — hand it
    // to the workspace's oldest queued run, in ANY project. Every terminal path
    // funnels through here, so this one call covers them all.
    // Same reasoning as retention below — every terminal path funnels through here, so the
    // usage-limit question ("did this run stop because the account is out of window, and when
    // does that window reopen?") is asked once, in one place, off the record the failing path
    // has already written. Nothing to do for any other outcome.
    //
    // BEFORE releasing the slot, and that order is the whole point: `releaseSlot` pumps every
    // manager, and a pump reads the hold off the records. Publishing the schedule afterwards
    // left a window — measured as exactly one extra task — where the queue saw a free slot and
    // an account that looked healthy, and started work that was already doomed.
    this.autoResumeScheduler.scheduleAutoResumeIfLimited(runId);
    // Closed-session success may have parked a completion wait without a live wire. The global
    // pass covers the families still in memory (#779); this run's own family may have just left
    // the live set with it, so it is reconciled by name first.
    const settled = this.context.store.getRun(runId);
    if (settled?.delegation) {
      for (const id of settledRunFamilies(this.context.store, settled)) this.host.reconcileWorkerWaits(id);
      // Then every other family still in memory (hearsay-tools/cezarion#779).
      this.host.reconcileWorkerWaits();
    }
    this.host.releaseSlot();
    // A run leaving the active registry may have reached a terminal transition
    // (done/review/failed/cancelled), increasing the finished-worktree count.
    // Enforce count-based retention (#483) here so a single hook covers every
    // terminal path. Fire-and-forget: retention must never delay or throw into
    // the lifecycle.
    void this.host.enforceRetention();
    this.host.reapTerminalScratch(runId);
  }
}
