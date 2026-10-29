import { IDLE_TIMEOUT_MS, ROUTED_QUESTION_REFUSAL, UNREAD_INPUT_GRACE_MS, NO_WAIT_NUDGE_REPLY_MS, COMPLETION_WILL_WAIT, MAX_AUTO_CONTINUES, SCHEDULE_WAKEUP_MAX_SECONDS, MAX_WAKE_DELIVERY_ATTEMPTS, WAKE_DELIVERY_CAP_NOTE, WAKE_SESSION_CLOSED_ERROR, WAITS_DISCARDED_NOTE, REFUSAL_DISCARDED_NOTE, QUEUE_WATCHDOG_MS, RESTART_CONTINUATION_PROMPT } from './run/constants.ts';
export { IDLE_TIMEOUT_MS, UNREAD_INPUT_GRACE_MS, NO_WAIT_NUDGE_REPLY_MS, COMPLETION_WILL_WAIT, MAX_AUTO_CONTINUES, MAX_WAKE_DELIVERY_ATTEMPTS, WAKE_DELIVERY_CAP_NOTE, WAKE_SESSION_CLOSED_ERROR, WAITS_DISCARDED_NOTE, REFUSAL_DISCARDED_NOTE, QUEUE_WATCHDOG_MS } from './run/constants.ts';
import { isSyntheticContinuation } from './run/workflow-position.ts';
import { repositoryRootLockDisabled } from './run/repo-root-lease.ts';
export { repositoryRootLockDisabled } from './run/repo-root-lease.ts';
import { isUntouchedCancelledRun } from './run/run-guards.ts';
export { isUntouchedCancelledRun } from './run/run-guards.ts';
import { WorkerOrphanAliveError, admissionError } from './run/worker-orphans.ts';
import type { HumanAnswerBudget, PersistedAttachments } from './run/types.ts';
import { ContinuationSession } from './run/continuation-session.ts';
import { StepLoop as WorkflowStepLoop } from './run/step-loop.ts';
import { RunRecovery } from './run/run-recovery.ts';
import { TurnSettler } from './run/turn-settler.ts';
import { StepSession } from './run/step-session.ts';
import * as sessionEvents from './run/session-events.ts';
import { WakeAdmission } from './run/wake-admission.ts';
import { RunSettlement } from './run/run-settlement.ts';
import { InputDelivery } from './run/input-delivery.ts';
import { TurnNudges } from './run/turn-nudges.ts';
import { WorkerQuestions } from './run/worker-questions.ts';
import { FamilyReconciler } from './run/family-reconciler.ts';
import * as completionGateReads from './run/completion-gate.ts';
import { WaitRegistry } from './run/wait-registry.ts';
import { WakeRetries } from './run/wake-retries.ts';
import { WaitWatches } from './run/wait-watches.ts';
import { HumanWaits } from './run/human-waits.ts';
import { RunLine, type PendingJob } from './run/run-line.ts';
import { WorktreeAutosave } from './run/worktree-autosave.ts';
import { RunSkills } from './run/run-skills.ts';
import { InboxClaims } from './run/inbox-claims.ts';
import { WorkerExecutions } from './run/worker-executions.ts';
import { TurnBookkeeper } from './run/turn-bookkeeping.ts';
import { AutomationToolsSlot, cezarToolHandlers, toolSessionRefusal } from './run/cezar-tools.ts';
import { registerPreviewServer, stopPreviewServer } from '../preview/run-tools.ts';
import { AttachmentWriter } from './run/attachment-writer.ts';
import { QueuedInput } from './run/queued-input.ts';
import { RepoRootLease } from './run/repo-root-lease.ts';
import { MaintenanceClaims } from './run/maintenance-claims.ts';
import { WorkerOrphans } from './run/worker-orphans.ts';
import type {
  DelegationExecutionSettings, StartRunInput, PendingContinuation, Execution, StepLoop, WorkerTerminationBlocker, AutomationToolService,
} from './run/types.ts';
export type { TurnTail, DelegationExecutionSettings, StartRunInput, WorkerTerminationBlocker, AutomationToolService } from './run/types.ts';
import { openCompletionRequests, recordRequestRefusal, repairFailedRootFinish, startCompletionCycle, settledRootFinishPatch, type CompletionRefusal } from './completion-policy.ts';
import type { ContinueRunOptions } from './continuation-admission.ts';
import { workerEvidenceRunIds } from '../runs/worker-execution.ts';
import { doneErrorMessage } from '../ci-wait/errors.ts';
import { cezarDoneRequestSchema, type CezarDoneAnswer, type CezarDoneRequest, type CezarWaitRequestInput, type DoneErrorCode, type PeerWaitEntry, type PrWaitEntry, type ProcessWaitEntry, type HumanWaitEntry, type TimerWaitEntry, type Wait, type WaitVia, type WorkerWaitEntry, computeWaitingOn, hasWorkerDeadline, workerWaitEntryToLegacy, type DeadlinedWorkerWaitEntry, isUsageLimitHold } from '@open-mercato/cezar-contract/waits';
import { type PreviewStopRequest, type PreviewStopResult, type PreviewServeRequest, type PreviewServeResult } from '@open-mercato/cezar-contract/preview';
import { NO_WAIT_NUDGE_NOTE, NO_WAIT_NOTE, NO_WAIT_NO_REPLY_NOTE, COMPLETION_NO_REPLY_NOTE, WORKER_FALLBACK_NOTE, WORKER_FALLBACK_REPLY_NOTE, COMPLETION_NUDGE_NOTE, AUTONOMOUS_ASK_NOTE, AUTONOMOUS_NUDGE, type TurnEndOutcome } from './turn-end.ts';
import { createActiveRun, type ActiveRun } from './active-run.ts';
export { claudeScheduleWakeupDelay, appendTurnText, trackTurnTail, classifyTurnEnd } from './run/turn-markers.ts';
import { canProceedWithRun, executionBlockedByRootFinish, historyDeletionPending, rootFinishRequested, isDisposedDelegatedRun, preserveRunAfterDisposal } from './run/run-guards.ts';
import { beginUsageInvocation, recordUsagePeaks } from './run/usage-accounting.ts';
import { REPOSITORY_ROOT_LOCK_DISABLED_NOTE } from './run/run-workspace.ts';
import * as inputReceipts from './run/input-receipts.ts';
import { ContinuationAcceptance } from './run/continuation-acceptance.ts';
import { AutoResumeScheduler } from './run/auto-resume.ts';
export { AUTO_RESUME_GRACE_MS, MAX_AUTO_RESUMES, AUTO_RESUME_MISSED_WINDOW_MS } from './run/auto-resume.ts';
import { TrackedWork } from './run/tracked-work.ts';
import type { RunModuleContext } from './run/types.ts';
import * as launchContext from './run/launch-context.ts';
import { openingInputs } from './run/opening.ts';
import { releaseActiveResources } from './run/drop-active.ts';
import { delegationExecutionSettings, selectDelegationExecutionSettings } from '../delegation/execution-settings.ts';
import { stepLabel } from './run/steps.ts';
import { makeRunTitle } from '../runs/run-title.ts';
export { agentDirectories, composeSystemPrompt, expandRegistrySlashSkill, expandRegistrySlashSkillText, leadingSlashSkillName, resolveExtraSystemPrompt, skillSystemPrompt } from './run/prompts.ts';
export { stepLabel } from './run/steps.ts';
export { makeRunTitle } from '../runs/run-title.ts';
import { clearUnreadInputTimer, clearHeldHumanInputTimer, clearIdleTimer, clearAutosaveTimer } from './run/input-timers.ts';
import * as stepDecisions from './run/step-decisions.ts';
import * as pendingAskFacts from './run/pending-ask-facts.ts';
import * as workflowPosition from './run/workflow-position.ts';
import { RUN_EXITS, transition, transitionVia, type RunExitId } from './run-states.ts';
import { deriveAccountHolds, queuedRecoveryInput } from './run-scheduling.ts';
export { runAccountKey } from './run-scheduling.ts';
import { holdsOwedResults, isCezarHumanWait, openWaitList, openWaits, resolvedWaits } from './waits.ts';
import { runsAwaitingPeer } from './wait-scope.ts';
import { previewCdpSession, previewRunContext, type PreviewHostLike } from '../preview/registration.ts';
import { acquireCiResources } from '../ci-wait/resources.ts';
import type { CiWatcherSupervisor } from '../ci-wait/supervisor.ts';
import type { CezarToolHandlers } from '../ci-wait/controller.ts';
import { workerIdentity, continuationDefStep, ownedWorkflow, workerStepIdentity, WorkerIdentityError, type WorkerAccountBinding, type WorkerStepIdentity } from '../delegation/execution-identity.ts';
import type { DelegationProvisioner } from '../delegation/provision.ts';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { AskRequest } from '../core/ask.ts';
import { type AgentSession } from '../core/claude-cli-runner.ts';
import { onUsage, replaceRunProcess, type ProcessUsage } from '../core/process-usage.ts';
import { WorkerScratchCleanup } from '../delegation/scratch-cleanup.ts';
import { ORPHAN_BACKOFF, type Backoff } from '../delegation/retry-backoff.ts';
import { type CwdSource } from '../delegation/process-liveness.ts';
import { parseUsageLimit } from '../core/usage-limit.ts';
import type { RunnerId } from '../core/agent-runner.ts';
import { agentModelsLocked } from '../core/agent-model-policy.ts';
import {
  handoffPath,
  seedHandoffFile,
} from '../handoff.ts';
import type { SessionContext } from '../session-context.ts';
// Contract VALUES, like `workspaceUiStateSchema` in workspace/migrations.ts: the attachment
// vocabulary the routes validate with is the same one the engine stores and re-reads by, so the
// wire and the disk can never disagree about what counts as an image (#950).
import {
  type AgentInput,
  type WorkerStopResult,
  type WorkerWait,
  type WorkerWaitRequest,
  delegationStateSchema,
} from '@open-mercato/cezar-contract/delegation';
import type { ConversationState, RunEvent } from '@open-mercato/cezar-contract';
import {
  type ConversationMessage,
  type RequestWaitRequest,
} from '@open-mercato/cezar-contract/conversations';
import { contentBlocksOf, toPastedContent, type FileBlock, type PastedContent, type PersistedAttachment } from './pasted-content.ts';
export { contentBlocksOf, highestImageSeq, mediaTypeFor, pastedAttachmentsNote, pastedAttachmentsText, toPastedContent, type FileBlock, type PastedContent, type PersistedAttachment } from './pasted-content.ts';
import type { ContentBlock, ToolGrant } from '../core/agent-runner.ts';
import { readProjectUiState } from '../ui-state.ts';
import { discoverSkills, type Skill } from '../skills.ts';
import { readAgentModelSettings } from '../agent-config/models.ts';
import { resolveWorktreeRetention } from '../config.ts';
import { type AutosaveReason } from '../git-worktree.ts';
import { getRepoInfo } from '../server/git.ts';
import { enqueueAgentInput } from '../delegation/input.ts';
import { DelegationPolicyError } from '../delegation/policy.ts';
import { projectConversationEvents, settledRunFamilies } from '../delegation/conversations.ts';
import * as queuedRevival from './run/queued-revival.ts';
import type { RunOutcome } from '../runs/outcome-commit.ts';
import { RUN_IN_USE_ELSEWHERE, type CommitSource, type QueuedMessage, type RunRecord, type RunStore, type StepState } from '../runs/store.ts';
import { reclaimWorktrees } from '../runs/retention.ts';
import {
  removeAgentTmpDir,
} from '../runs/agent-tmpdir.ts';
import { extractTaskRefs, refineTaskRefs } from '../runs/task-refs.ts';
import { resolveProfileEnvForRoot } from '../workspace/agent-profiles.ts';
import { WorkspaceSemaphore, type AccountHolds } from '../workspace/semaphore.ts';
import type { UiEventSink } from '../runs/ui-event-sink.ts';
import type { UiEvent } from '../core/ui-events.ts';
import {
  QUICK_TASK_WORKFLOW, stepKind, type WorkflowDef, type WorkflowStepDef,
} from './types.ts';

import { PROSE_HUMAN_GATE } from '../runs/transcript-facts.ts';
export { CHECK_KILL_GRACE_MS, CHECK_TERMINATION_CONFIRM_MS } from './grouped-command.ts';
export { periodicAutosaveEnabled, AUTOSAVE_INTERVAL_MS } from './run/worktree-autosave.ts';
/** #486: recheck a turn-end that deferred close/park only because the harness still held a human follow-up. */
export { HELD_HUMAN_INPUT_RECHECK_MS } from './run/input-delivery.ts';
export { WORKER_FALLBACK_QUESTION, WORKER_FALLBACK_HEADER } from './run/worker-questions.ts';
export { AUTONOMOUS_NUDGE, NO_WAIT_NUDGE_NOTE, NO_WAIT_NOTE, NO_WAIT_NO_REPLY_NOTE, COMPLETION_NO_REPLY_NOTE, WORKER_FALLBACK_NOTE, WORKER_FALLBACK_REPLY_NOTE, COMPLETION_NUDGE_NOTE, AUTONOMOUS_ASK_NOTE };

/**
 * The mini workflow engine: executes a `WorkflowDef` against a repo, one step
 * at a time, persisting every event to the RunStore (which the SSE endpoints
 * relay live to the GUI). No GitHub choreography — agent steps and shell
 * checks with bounded retry loops, plus live sessions: the last agent step
 * stays open for follow-ups (`waiting`) until "finish", idle timeout, or
 * cancel. Runs queue behind the workspace-wide `maxParallel` slots (the shared
 * `WorkspaceSemaphore`, spec 2026-07-20 step 2.5) and each run executes in its
 * own git worktree on a `cez/<id8>` branch (spec 006), autosave-committed at
 * turn end and before a draft PR — plus every 90 s when opted in via
 * CEZ_AUTOSAVE=1 (#471). Each autosave records its trigger in the commit
 * subject, so the always-on flushes are not mistaken for the opt-in timer.
 * The user's working tree is never touched.
 */
export class RunManager {
  private readonly active = new Map<string, ActiveRun>();
  private readonly context: RunModuleContext;
  private readonly stepSession: StepSession;
  private readonly continuationSession: ContinuationSession;
  private readonly stepLoop: WorkflowStepLoop;
  private readonly sessionHelperHost: sessionEvents.SessionHelperHost;
  private readonly completionGateHost: completionGateReads.CompletionGateHost = {
    active: this.active,
    pendingHumanAskSeq: id => this.pendingHumanAskSeq(id),
    isActive: id => this.isActive(id),
    holdsAgentWaits: id => this.humanWaits.holdsAgentWaits(id),
    waitingBeforeFinalWorkflowStep: run => this.waitingBeforeFinalWorkflowStep(run),
    parentCompletionBlockers: id => this.parentCompletionBlockers(id),
    unansweredQuestions: id => this.unansweredQuestions(id),
  };
  private readonly queuedRevivalHost: queuedRevival.QueuedRevivalHost;
  private readonly humanWaits: HumanWaits;
  private readonly turnNudges: TurnNudges;
  private readonly runSettlement: RunSettlement;
  private readonly waitRegistry: WaitRegistry;
  private readonly waitWatches: WaitWatches;
  private readonly familyReconciler: FamilyReconciler;
  private readonly workerQuestions: WorkerQuestions;
  private get recoveryFactsPending() { return this.familyReconciler.recoveryFactsPending; }
  private readonly inputReceiptSteps: inputReceipts.InputReceiptSteps = {
    clearUnread: state => this.clearUnreadInputTimer(state), clearHeld: state => this.clearHeldHumanInputTimer(state),
    noteActivity: (id, state, event) => this.turnNudges.noteNoWaitNudgeContent(id, state, event),
    persistAttachment: (id, mediaType, data) => this.persistAttachment(id, mediaType, data),
    ready: (id, state, session) => this.handleAgentInputReady(id, state, session),
    pid: (id, pid) => { replaceRunProcess(id, pid); this.recordWorkerProcess(id, pid); },
    ui: (id, state, sink, event) => this.handleRunnerUiEvent(id, state, sink, event),
    flushDeferred: id => this.flushDeferred(id), recordProcess: (id, pid) => this.recordWorkerProcess(id, pid),
  };
  private readonly inputReceiptHost: inputReceipts.InputReceiptsHost = {
    reconcileWorkerWaits: () => this.reconcileWorkerWaits(),
    flushAgentInputs: id => this.flushAgentInputs(id),
    isCurrentState: (id, state) => this.active.get(id) === state,
  };
  private readonly line: RunLine;
  private readonly worktreeAutosave: WorktreeAutosave;
  private readonly workerExecutions: WorkerExecutions;
  private get executions() { return this.workerExecutions.executions; }
  private beginWorkerExecution(id: string, admitted = true) { this.workerExecutions.beginWorkerExecution(id, admitted); }
  private async finishWorkerExecution(id: string) { return this.workerExecutions.finishWorkerExecution(id); }
  private trackWorkerSessionResult(id: string, session: AgentSession) { return this.workerExecutions.trackWorkerSessionResult(id, session); }
  private recordWorkerProcess(id: string, pid: number) { this.workerExecutions.recordWorkerProcess(id, pid); }

  private readonly orphans: WorkerOrphans;
  private orphanBackoff: Backoff = ORPHAN_BACKOFF;
  private orphanTermGraceMs = 10_000;
  private get orphanDue() { return this.orphans.orphanDue; }
  private orphanedWorkerGeneration(runId: string, admitting = false) { return this.orphans.orphanedWorkerGeneration(runId, admitting); }
  settleOrphanedWorkerExecution(runId: string, opts: { admitting?: boolean; fresh?: boolean; cwds?: CwdSource } = {}): boolean { return this.orphans.settleOrphanedWorkerExecution(runId, opts); }
  private armOrphanReprobe(runId: string): void { this.orphans.armOrphanReprobe(runId); }
  takeWorkerTerminationBlocker(runId: string): { blocker: WorkerTerminationBlocker; changed: boolean } | undefined { return this.orphans.takeWorkerTerminationBlocker(runId); }
  private async terminateFinishedWorkerGroups(runId: string, timeoutMs: number): Promise<void> { return this.orphans.terminateFinishedWorkerGroups(runId, timeoutMs); }

  requestWorkerStop(runId: string): WorkerStopResult {
    if (this.store.getRun(runId)?.delegation?.role !== 'worker') throw new Error('Worker not found');
    if (!this.workerExecutions.has(runId) && !this.isActive(runId) && ['done', 'failed', 'cancelled', 'review'].includes(this.store.getRun(runId)!.status) && this.store.readWorkerExecution(runId)?.phase === 'complete') return { workerId: runId, state: 'terminated' };
    this.cancel(runId);
    return { workerId: runId, state: !this.workerExecutions.has(runId) && this.store.readWorkerExecution(runId)?.phase === 'complete' ? 'terminated' : 'stopping' };
  }

  async awaitRunTermination(runId: string, timeoutMs: number, opts: { reapOrphans?: boolean } = {}): Promise<boolean> {
    const terminated = await this.workerExecutions.proveRunTermination(runId, timeoutMs, opts);
    if (terminated && opts.reapOrphans && !this.disposed) await this.terminateFinishedWorkerGroups(runId, timeoutMs);
    return terminated;
  }

  private historyDeletionPending(runId: string): boolean {
    return historyDeletionPending(this.store, runId);
  }

  private workerExecutionStopped(runId: string): boolean {
    const run = this.store.getRun(runId);
    return this.historyDeletionPending(runId) || run?.delegation?.role === 'invalid' || (run?.delegation?.role === 'worker' &&
      (!!run.delegation.destroy || this.workerExecutions.isStopped(runId)));
  }

  /** Runs whose worktree a reclaim, or whose branch a delete, is removing right now
   *  (`claimWorktreeReclaim`, `claimForBranchCleanup`). `continueRun` refuses them. */
  private readonly claims: MaintenanceClaims;
  private get reclaiming(): Set<string> { return this.claims.reclaiming; }
  private readonly wakeAdmission: WakeAdmission;
  private readonly retries: WakeRetries;
  private readonly ciResources: ReturnType<typeof acquireCiResources>;
  /** #781: the workspace-wide preview host. Absent (`cez run`, tests) means every registration is `headless`. */
  private readonly preview?: PreviewHostLike | undefined;
  /** The same host, for a removal outside this manager that must release a run's preview first. */
  get previewHost(): PreviewHostLike | undefined {
    return this.preview;
  }
  /** #781: cezar's own listening port, which no dev server may register. */
  private readonly cezarPort?: (() => number | undefined) | undefined;
  private ciSupervisor: Pick<CiWatcherSupervisor, 'resolve' | 'watch' | 'close'>;
  private readonly inboxClaims: InboxClaims;
  private readonly recovery: RunRecovery;
  /** Quiet window before unread input is resubmitted or left unconfirmed (#505). */
  private readonly unreadInputGraceMs: number;
  /** Quiet window after a final-message nudge before a still-silent session parks (#544). */
  private readonly noWaitNudgeReplyMs: number;
  private disposed = false;

  /** Whether any recovery is in progress: one at a time (`recover`), and `pump` waits for it. */
  private get recovering(): boolean { return this.recovery.recovering; }

  /**
   * Whether a recovery in progress holds this run, so its wakes, input flushes and delegation
   * reconciles wait for that recovery's own passes: every run during boot recovery, and only the
   * adopted family's during a recovery scoped to one. The rest of a running project stays live: a
   * wake held back for an unrelated family would be lost, since the scoped passes never revisit it.
   */
  private recoveringRun(run: RunRecord | string | undefined): boolean { return this.recovery.recoveringRun(run); }

  private readonly onDelegationRun = (run: RunRecord, source?: CommitSource): void => {
    // Delegation metadata checkpoints do not change task status.
    // A republish changed nothing durable: there is nothing to reap, cancel or reconcile.
    if (source === 'live-release') return;
    if (!this.disposed && source === undefined) this.reapTerminalScratch(run.id);
    if (!this.disposed && !['queued', 'running', 'waiting'].includes(run.status) && !holdsOwedResults(run)) this.wakeAdmission.cancelOpenWaits(run.id);
    if (run.delegation && !['queued', 'running', 'waiting'].includes(run.status)) this.active.get(run.id)?.revokeDelegation?.();
    // Cleanup checkpoints emit terminal records too. With delegation disabled,
    // these observations must not replay the project's conversation histories.
    if (this.disposed || this.recoveringRun(run) || (source === 'delegation-checkpoint' && process.env.CEZ_DELEGATION !== '1')) return;
    // A destroy retry changes nothing the family reconcile reads (#880).
    if (source === 'delegation-destroy-progress') return;
    if (run.delegation && run.delegation.role !== 'invalid' && !['queued', 'running', 'waiting'].includes(run.status)) {
      for (const id of settledRunFamilies(this.store, run)) this.reconcileWorkerWaits(id);
    }
    this.waitRegistry.resolvePeerWaits(runsAwaitingPeer(run, () => this.store.listRuns())); // never in recovery: an interrupted peer fails, then continues
  };
  private readonly continuationAcceptance: ContinuationAcceptance;
  private readonly turnSettler: TurnSettler;
  private readonly inputDelivery: InputDelivery;
  private readonly runSkills: RunSkills;
  private readonly attachments: AttachmentWriter;
  private get queuedImageSeq(): Map<string, number> { return this.attachments.queuedImageSeq; }
  /** Messages after hydration in the dequeue → session-open gap (#472).
   * Wait-withdrawing entries also retain a durable queue ID until delivered. */
  private readonly queuedInput: QueuedInput;
  private get deferredMessages() { return this.queuedInput.deferredMessages; }
  private readonly autoResumeScheduler: AutoResumeScheduler;
  private get autoResumeTimers() { return this.autoResumeScheduler.autoResumeTimers; }
  private readonly repoRootLease: RepoRootLease;

  /** `.ai/cezar` — where the per-task handoff files live. */
  private readonly dataDir: string;

  /** Runs currently being paused by the memory guard — dedupes the ~2 s samples so one breach
   *  triggers one pause, not a burst. Cleared in dropActive when the run leaves the registry. */
  private readonly memoryPausing = new Set<string>();

  /** Unsubscribe handle for the constructor's `onUsage` subscription — released
   *  by dispose() so a torn-down manager stops receiving sampler ticks. */
  private readonly offUsage: () => void;

  /** The stalled-queue watchdog (see `rescueStalledQueue`). */
  private readonly queueWatchdog: ReturnType<typeof setInterval>;

  /** The workspace-wide parallel-cap semaphore + cached resource config
   *  (spec 2026-07-20, step 2.5). Boot constructs ONE and every manager shares
   *  it; the private fallback keeps single-manager callers and tests working. */
  private readonly semaphore: WorkspaceSemaphore;

  /** Unregister handle for this manager's semaphore membership — released by
   *  dispose() so a torn-down project stops counting against the cap. */
  private readonly offSemaphore: () => void;

  constructor(
    private readonly store: RunStore,
    private readonly repoRoot: string,
    options: { work?: TrackedWork; semaphore?: WorkspaceSemaphore; unreadInputGraceMs?: number; noWaitNudgeReplyMs?: number; preview?: PreviewHostLike | undefined; cezarPort?: (() => number | undefined) | undefined; cockpit?: { origin: string; projectId: string } | undefined } = {},
  ) {
    this.dataDir = join(repoRoot, '.ai/cezar');
    this.workerScratchCleanup = new WorkerScratchCleanup(store, this.dataDir, id => this.isActive(id) || this.workerExecutions.has(id) || this.claims.has(id) || !!this.autosaveCleanupBlocker(id));
    this.preview = options.preview;
    this.cezarPort = options.cezarPort;
    // #774: `serve` knows its bound origin before it recovers, so recovered runs carry it too.
    if (options.cockpit) this.setCockpitAddress(options.cockpit);
    this.unreadInputGraceMs = options.unreadInputGraceMs ?? UNREAD_INPUT_GRACE_MS;
    this.noWaitNudgeReplyMs = options.noWaitNudgeReplyMs ?? NO_WAIT_NUDGE_REPLY_MS;
    this.semaphore = options.semaphore ?? new WorkspaceSemaphore();
    this.context = { store, repoRoot, dataDir: this.dataDir, semaphore: this.semaphore, disposed: () => this.disposed, work: options.work ?? new TrackedWork() };
    this.retries = new WakeRetries(this.context, {
      owesWake: run => this.wakeAdmission.owesWake(run), queueWaitWake: id => this.wakeAdmission.queueWaitWake(id),
      retryWaitAdmission: id => this.retries.retryWaitAdmission(id),
    });
    this.queuedRevivalHost = {
      move: (id, exit, patch) => this.move(id, exit, patch), isActive: id => this.isActive(id),
      workerExecutionStopped: id => this.workerExecutionStopped(id), ownedJob: run => this.ownedJob(run),
      resumableSessionId: (id, step) => this.resumableSessionId(id, step), workerStep: (id, step) => this.workerStep(id, step),
      toQueuedMessage: (id, content) => this.toQueuedMessage(id, content), hydrateQueuedInput: (id, input) => this.hydrateQueuedInput(id, input),
      enqueueJob: (id, job) => this.line.enqueueJob(id, job), enqueueContinuation: (id, continuation) => this.line.enqueueContinuation(id, continuation),
      isSyntheticContinuation: (run, step) => isSyntheticContinuation(run, step), restartContinuationPrompt: RESTART_CONTINUATION_PROMPT,
      reviveQueuedRun: (run, reason) => this.reviveQueuedRun(run, reason), reviveWorkflow: run => queuedRevival.reviveWorkflow(this.context, this.queuedRevivalHost, run),
      checkpointRestartContext: (run, step) => queuedRevival.checkpointRestartContext(this.context, this.queuedRevivalHost, run, step),
    };
    this.line = new RunLine(this.context, {
      activeSize: () => this.active.size, activeHas: id => this.active.has(id),
      withExecutionAccount: run => this.wakeAdmission.withExecutionAccount(run),
      maintenance: id => this.claims.has(id) || !!this.autosaveCleanupBlocker(id),
      admitted: id => this.workerExecutions.admitted(id), workerExecutionStopped: id => this.workerExecutionStopped(id),
      recovering: () => this.recovering, recoveringRun: run => this.recoveringRun(run),
      reconcileAutoResumes: () => this.reconcileAutoResumes(), cancel: id => this.cancel(id),
      move: (id, patch) => this.move(id, 'fail-start', patch), beginWorkerExecution: id => this.beginWorkerExecution(id),
      admissionError: (error, fallback) => admissionError(error, fallback),
      admitQueuedWaitWake: id => this.wakeAdmission.admitQueuedWaitWake(id),
      launchQueuedRun: (id, job, continuation) => this.launchQueuedRun(id, job, continuation),
      reviveQueuedRun: (run, reason) => this.reviveQueuedRun(run, reason), pump: () => this.line.pump(),
      busySlots: () => this.line.busySlots(),
    });
    this.workerQuestions = new WorkerQuestions(this.context, {
      active: id => this.active.get(id), deliverConversationInput: id => this.deliverConversationInput(id),
      chargeAutomaticWake: id => this.wakeAdmission.chargeAutomaticWake(id), hasQueuedAgentInputs: id => this.hasQueuedAgentInputs(id),
      providerOwnsInboxInput: (id, inputId) => this.providerOwnsInboxInput(id, inputId), reconcileWorkerWaits: id => this.reconcileWorkerWaits(id),
      openHumanAlias: (id, state, via, card) => this.humanWaits.openHumanAlias(id, state, via, card), prepareHumanAsk: state => this.humanWaits.prepareHumanAsk(state),
      markHumanWaitSurfaced: (id, wait, card) => this.humanWaits.markHumanWaitSurfaced(id, wait, card), withdrawCezarHumanWaits: id => this.humanWaits.withdrawCezarHumanWaits(id),
      routeWorkerQuestion: id => this.routeWorkerQuestion(id), noticeParkedWorker: id => this.noticeParkedWorker(id),
      retireUnreadParentQuestion: (id, request) => this.retireUnreadParentQuestion(id, request),
      deleteUnreadInput: (id, input) => { this.active.get(id)?.unreadInputIds?.delete(input); },
      updatePendingHumanAsk: (id, value) => { const state = this.active.get(id); if (state) state.pendingHumanAsk = value; },
    }, MAX_AUTO_CONTINUES);
    this.familyReconciler = new FamilyReconciler(this.context, {
      active: id => this.active.get(id), isActive: id => this.isActive(id), recoveringRun: run => this.recoveringRun(run),
      cancel: id => this.cancel(id), armWait: (id, wait) => this.waitWatches.armWait(id, wait),
      armWorkerDeadline: (id, wait, delay) => this.waitWatches.armWorkerDeadline(id, wait, delay), disarmWait: id => this.disarmWait(id),
      resolveWait: (id, waitId, result, observed) => this.waitRegistry.resolveWait(id, waitId, result, observed),
      retireSettledQuestions: id => this.retireSettledQuestions(id), fallbackRoutedQuestions: (id, reason) => this.fallbackRoutedQuestions(id, reason),
      reconcileWorkerWaits: id => this.reconcileWorkerWaits(id),
    });
    this.waitWatches = new WaitWatches(this.context, {
      canProceedWithRun: (id, run) => this.canProceedWithRun(id, run), ciSupervisor: () => this.ciSupervisor,
      resolveWait: (id, waitId, result) => this.waitRegistry.resolveWait(id, waitId, result),
      reconcileWorkerWaits: family => this.reconcileWorkerWaits(family),
      resolvePeerWait: (id, wait) => this.waitRegistry.resolvePeerWait(id, wait), disarmWait: id => this.disarmWait(id),
      armWorkerDeadline: (id, wait, delay) => this.waitWatches.armWorkerDeadline(id, wait, delay),
      settleWait: (id, waitId, result) => this.waitWatches.settleWait(id, waitId, result), exitFileRoots: id => this.waitWatches.exitFileRoots(id),
    });
    this.waitRegistry = new WaitRegistry(this.context, {
      active: id => this.active.get(id), workerExecutionStopped: id => this.workerExecutionStopped(id),
      executionBlockedByRootFinish: run => this.executionBlockedByRootFinish(run), ciSupervisor: () => this.ciSupervisor,
      isParked: id => this.line.isParked(id), countAutomaticWakes: id => this.wakeAdmission.automaticWakes(id),
      reconcileWorkerWaits: family => this.reconcileWorkerWaits(family), noticeParkedWorkers: id => this.noticeParkedWorkers(id),
      canProceedWithRun: (id, run) => this.canProceedWithRun(id, run),
      exitFileRoots: (id, run) => this.waitWatches.exitFileRoots(id, run), disarmWait: id => this.disarmWait(id),
      settleWait: (id, waitId, result) => this.waitWatches.settleWait(id, waitId, result),
      withdrawCezarHumanWaits: id => this.humanWaits.withdrawCezarHumanWaits(id), armWait: (id, wait) => this.waitWatches.armWait(id, wait),
      parkOnWaits: (id, state) => this.wakeAdmission.parkOnWaits(id, state), cancelAutomaticAtCap: (id, waits) => this.wakeAdmission.cancelAutomaticAtCap(id, waits),
      reparkWithoutWaits: (id, state) => this.wakeAdmission.reparkWithoutWaits(id, state), waitOnUserWithoutSession: id => this.wakeAdmission.waitOnUserWithoutSession(id),
      queueWaitWake: id => this.wakeAdmission.queueWaitWake(id), retryWaitAdmission: id => this.retries.retryWaitAdmission(id),
    }, MAX_AUTO_CONTINUES);
    this.humanWaits = new HumanWaits(this.context, { routeWorkerQuestion: id => this.routeWorkerQuestion(id) }, MAX_AUTO_CONTINUES);
    this.sessionHelperHost = {
      active: this.active, line: this.line, humanWaits: this.humanWaits, inputReceiptHost: this.inputReceiptHost,
      move: (...args) => this.move(...args),
      workerExecutionStopped: id => this.workerExecutionStopped(id),
      executionBlockedByRootFinish: run => this.executionBlockedByRootFinish(run),
      agentEnvForStep: (...args) => this.agentEnvForStep(...args),
      sessionContextFor: (...args) => this.sessionContextFor(...args),
      automationsPart: () => this.automationsPart(),
      flushAgentInputs: id => this.flushAgentInputs(id),
      resumeParkedRun: (...args) => this.resumeParkedRun(...args),
      noteNoWaitNudgeContent: (...args) => this.turnNudges.noteNoWaitNudgeContent(...args),
      parkedOnWorkers: id => this.wakeAdmission.parkedOnWorkers(id),
      releaseSlot: () => this.line.releaseSlot(),
      routeWorkerQuestion: id => this.routeWorkerQuestion(id),
    };
    this.turnNudges = new TurnNudges(this.context, this.humanWaits, this.line, this.completionGateHost, {
      active: this.active, move: (id, exit, patch) => this.move(id, exit, patch),
      workerExecutionStopped: id => this.workerExecutionStopped(id), executionBlockedByRootFinish: run => this.executionBlockedByRootFinish(run),
      countAutomaticWakes: id => this.wakeAdmission.automaticWakes(id), hasQueuedAgentInputs: id => this.hasQueuedAgentInputs(id),
      submitAgentInput: (id, state, content) => this.submitAgentInput(id, state, content), resumeParkedRun: (id, state) => this.resumeParkedRun(id, state),
      chargeAutomaticWake: id => this.wakeAdmission.chargeAutomaticWake(id), retryWaitAdmission: id => this.retries.retryWaitAdmission(id), armIdleTimer: (id, state) => this.turnSettler.armIdleTimer(id, state),
      openTurnEndHumanWait: (id, state, step, via, note) => this.turnSettler.openTurnEndHumanWait(id, state, step, via, note),
      settledTurnOutcome: (id, entry, outcome) => this.settledTurnOutcome(id, entry, outcome), queueWaitWake: id => this.wakeAdmission.queueWaitWake(id),
      noWaitNudgeReplyMs: () => this.noWaitNudgeReplyMs,
    }, MAX_AUTO_CONTINUES, COMPLETION_WILL_WAIT);
    this.worktreeAutosave = new WorktreeAutosave(this.context,
      { holdForMaintenance: ids => this.holdForMaintenance(ids),
        reapTerminalScratch: id => this.reapTerminalScratch(id), releaseSlot: () => this.line.releaseSlot(),
        saveWorktree: (id, state, reason) => this.saveWorktree(id, state, reason),
        trackTurn: (id, task) => this.workerExecutions.trackTurn(id, task) },
    );
    this.orphans = new WorkerOrphans(this.context,
      { holds: (id, admitting) => this.workerExecutions.has(id) || this.active.has(id) || this.line.hasStarting(id) || (!admitting && this.line.hasQueued(id)),
        reapTerminalScratch: id => this.reapTerminalScratch(id),
        settleOrphanedWorkerExecution: (id, opts) => this.settleOrphanedWorkerExecution(id, opts),
        orphanBackoff: () => this.orphanBackoff, orphanTermGraceMs: () => this.orphanTermGraceMs },
    );
    this.workerExecutions = new WorkerExecutions(this.context, this.orphans,
      { maintenance: id => this.claims.has(id) || !!this.autosaveCleanupBlocker(id),
        admissionError: message => new WorkerOrphanAliveError(message),
        settleOrphanedWorkerExecution: (id, opts) => this.settleOrphanedWorkerExecution(id, opts),
        reapTerminalScratch: id => this.reapTerminalScratch(id), queueWaitWake: id => this.wakeAdmission.queueWaitWake(id),
        retryWaitAdmission: id => this.retries.retryWaitAdmission(id), releaseSlot: () => this.line.releaseSlot() },
    );
    this.automationToolsSlot = new AutomationToolsSlot(this.context,
      () => !!this.cockpit,
    );
    this.claims = new MaintenanceClaims(this.context,
      { isActive: id => this.isActive(id), autosaveCleanupBlocker: id => this.autosaveCleanupBlocker(id),
        hasExecution: id => this.workerExecutions.has(id), scheduleScratchCleanup: id => this.workerScratchCleanup.schedule(id),
        holdForMaintenance: ids => this.holdForMaintenance(ids) },
    );
    this.attachments = new AttachmentWriter(this.context,
      { persistAttachment: (id, mediaType, data, prefix) => this.persistAttachment(id, mediaType, data, prefix) },
    );
    this.queuedInput = new QueuedInput(this.context,
      { hasJob: id => this.line.hasJob(id), hasContinuation: id => this.line.hasContinuation(id), job: id => this.line.job(id),
        canProceedWithRun: (id, run): run is RunRecord => this.canProceedWithRun(id, run),
        activeGet: id => this.active.get(id), startingHas: id => this.line.hasStarting(id),
        persistPastedAttachments: (id, content) => this.persistPastedAttachments(id, content),
        toQueuedMessage: (id, content) => this.toQueuedMessage(id, content),
        sendMessage: (id, content, messageId) => this.sendMessage(id, content, messageId) },
    );
    this.inboxClaims = new InboxClaims(this.context,
      { activeGet: id => this.active.get(id),
        executionBlockedByRootFinish: run => this.executionBlockedByRootFinish(run),
        workerExecutionStopped: id => this.workerExecutionStopped(id),
        reconcileWorkerWaits: () => this.reconcileWorkerWaits(), retireEmptyWake: id => this.wakeAdmission.retireEmptyWake(id),
        deliverConversationInput: id => this.deliverConversationInput(id),
        settleIdleBoundary: (id, state, session) => this.inputDelivery.settleIdleBoundary(id, state, session),
        releaseSlot: () => this.line.releaseSlot(), providerOwnsInboxInput: (id, inputId) => this.providerOwnsInboxInput(id, inputId),
        canClaimInboxInput: (id, inputId) => this.canClaimInboxInput(id, inputId),
        armInboxClaimExpiry: id => this.armInboxClaimExpiry(id) },
    );
    this.repoRootLease = new RepoRootLease(this.context,
      { park: id => { this.line.park(id); }, unpark: id => { this.line.unpark(id); },
        releaseSlot: () => this.line.releaseSlot() },
    );
    this.turnBookkeeper = new TurnBookkeeper(this.context,
      { isDisposedDelegatedRun: id => this.isDisposedDelegatedRun(id), discoverSkills: () => this.discoverSkills(),
        reviveWorkflow: run => queuedRevival.reviveWorkflow(this.context, this.queuedRevivalHost, run), trackTurn: (id, task) => this.workerExecutions.trackTurn(id, task) },
    );
    this.runSkills = new RunSkills(this.context,
      { discoverSkills: () => this.discoverSkills(), workerExecutionStopped: id => this.workerExecutionStopped(id),
        isCurrentState: (id, state) => this.active.get(id) === state, flushAgentInputs: id => this.flushAgentInputs(id) },
    );
    this.stepSession = new StepSession(this.context, {
      workerExecutionStopped: id => this.workerExecutionStopped(id),
      executionBlockedByRootFinish: run => this.executionBlockedByRootFinish(run),
      trackWorkerSessionResult: (...args) => this.trackWorkerSessionResult(...args),
      workerStep: (...args) => this.workerStep(...args),
      beginUsageInvocation: (...args) => this.beginUsageInvocation(...args),
      recordUsagePeaks: id => this.recordUsagePeaks(id),
    }, this.sessionEventHost(), this.launchPreambleHost(), this.sessionHelperHost, this.line,
    this.runSkills, this.humanWaits, this.inputReceiptHost, this.inputReceiptSteps);
    this.autoResumeScheduler = new AutoResumeScheduler(this.context,
      { move: (id, exit, patch) => this.move(id, exit, patch),
        continueRun: (id, opts, defer) => this.continueRun(id, opts, defer), pump: () => this.line.pump() },
    );
    this.recovery = new RunRecovery(this.context, this.familyReconciler,
      this.workerQuestions, this.autoResumeScheduler, {
        workerScratchCleanup: this.workerScratchCleanup, humanWaits: this.humanWaits,
        waitWatches: this.waitWatches, inboxClaims: this.inboxClaims, orphans: this.orphans,
        isActive: (...args) => this.isActive(...args),
        workerExecutionStopped: (...args) => this.workerExecutionStopped(...args),
        move: (...args) => this.move(...args),
        cancel: (...args) => this.cancel(...args),
        continueRun: (...args) => this.continueRun(...args),
        reviveQueuedRun: (...args) => this.reviveQueuedRun(...args),
        requeueInterruptedRun: (...args) => queuedRevival.requeueInterruptedRun(this.context, this.queuedRevivalHost, ...args),
        checkpointRestartContext: (...args) => queuedRevival.checkpointRestartContext(this.context, this.queuedRevivalHost, ...args),
        deliverConversationInput: (...args) => this.deliverConversationInput(...args),
        answerRoutedQuestion: (...args) => this.answerRoutedQuestion(...args),
        queueWaitWake: (...args) => this.wakeAdmission.queueWaitWake(...args),
        owesWake: (...args) => this.wakeAdmission.owesWake(...args),
        cancelOpenWaits: (...args) => this.wakeAdmission.cancelOpenWaits(...args),
        settleOrphanedWorkerExecution: (...args) => this.settleOrphanedWorkerExecution(...args),
        settleRequestedRootFinish: (...args) => this.settleRequestedRootFinish(...args),
        settleSuccess: (...args) => this.settleSuccess(...args),
        reconcileWorkerWaits: (...args) => this.reconcileWorkerWaits(...args),
        pump: (...args) => this.line.pump(...args),
        recover: (...args) => this.recover(...args),
        adoptTranscriptAsk: (...args) => this.adoptTranscriptAsk(...args),
        settleAnsweredLegacyAsk: (...args) => this.settleAnsweredLegacyAsk(...args),
      }, RESTART_CONTINUATION_PROMPT);
    this.wakeAdmission = new WakeAdmission(this.context, {
      active: this.active, retries: this.retries, line: this.line, waitWatches: this.waitWatches, waitRegistry: this.waitRegistry,
      inboxClaims: this.inboxClaims, workerQuestions: this.workerQuestions, humanWaits: this.humanWaits,
      isActive: id => this.isActive(id), move: (id, exit) => this.move(id, exit), recoveringRun: run => this.recoveringRun(run),
      continueRun: (id, opts, defer) => this.continueRun(id, opts, defer), disarmWait: id => this.disarmWait(id),
      reconcileWorkerWaits: id => this.reconcileWorkerWaits(id), releaseSlot: () => this.line.releaseSlot(),
      parkForUser: (id, state, step) => this.turnSettler.parkForUser(id, state, step), armIdleTimer: (id, state) => this.turnSettler.armIdleTimer(id, state),
      flushAgentInputs: id => this.flushAgentInputs(id), answerRoutedQuestion: (id, flush) => this.answerRoutedQuestion(id, flush),
      queueWaitWake: id => this.wakeAdmission.queueWaitWake(id), retryWaitAdmission: id => this.retries.retryWaitAdmission(id),
      countAutomaticWakes: (id, budget) => this.wakeAdmission.automaticWakes(id, budget),
      workerExecutionStopped: id => this.workerExecutionStopped(id), executionBlockedByRootFinish: run => this.executionBlockedByRootFinish(run),
    }, MAX_AUTO_CONTINUES, MAX_WAKE_DELIVERY_ATTEMPTS);
    this.continuationAcceptance = new ContinuationAcceptance(this.context, {
      isActive: id => this.isActive(id), move: (id, exit, patch) => this.move(id, exit, patch),
      ownedJob: run => this.ownedJob(run), executionBlockedByRootFinish: run => this.executionBlockedByRootFinish(run),
      finishWorkerExecution: id => this.finishWorkerExecution(id), clearWakeBackoff: id => this.retries.clearWakeBackoff(id),
      dropActive: id => this.dropActive(id), pump: () => this.line.pump(),
      runContinuation: (...args) => this.runContinuation(...args), workerStep: (id, step) => this.workerStep(id, step),
      isUntouchedCancelledRun: run => isUntouchedCancelledRun(run), admissionError: (error, fallback) => admissionError(error, fallback),
      isSyntheticContinuation: (run, step) => isSyntheticContinuation(run, step),
    }, this.claims, this.line, this.workerExecutions, this.queuedInput, this.autoResumeScheduler,
    this.worktreeAutosave, this.workerQuestions, ROUTED_QUESTION_REFUSAL, RESTART_CONTINUATION_PROMPT);
    this.runSettlement = new RunSettlement(this.context, this.humanWaits, this.workerQuestions,
      this.worktreeAutosave, this.turnBookkeeper, this.line, this.autoResumeScheduler, this.workerExecutions,
      this.completionGateHost, {
        active: this.active, isSyntheticContinuation: (run, step) => isSyntheticContinuation(run, step),
        generation: id => this.continuationAcceptance.generation(id), isActive: id => this.isActive(id),
        move: (id, exit, patch) => this.move(id, exit, patch), dropActive: id => this.dropActive(id),
        saveWorktree: (id, state, reason) => this.saveWorktree(id, state, reason),
        settleSuccess: (id, durable, keep) => this.settleSuccess(id, durable, keep),
        deferParentCompletion: id => this.deferParentCompletion(id),
        closingWakeDecision: (id, holds, cancelled, error) => this.wakeAdmission.closingWakeDecision(id, holds, cancelled, error),
        owesDelivery: id => this.wakeAdmission.owesDelivery(id), preserveRunAfterDisposal: (id, state) => this.preserveRunAfterDisposal(id, state),
        isDisposedDelegatedRun: id => this.isDisposedDelegatedRun(id), queueWaitWake: id => this.wakeAdmission.queueWaitWake(id),
        reconcileWorkerWaits: id => this.reconcileWorkerWaits(id), releaseSlot: () => this.line.releaseSlot(),
        enforceRetention: () => this.enforceRetention(), reapTerminalScratch: id => this.reapTerminalScratch(id),
        forgetMemoryPause: id => { this.memoryPausing.delete(id); },
      }, WAKE_SESSION_CLOSED_ERROR, WAKE_DELIVERY_CAP_NOTE);
    this.continuationSession = new ContinuationSession(this.context, {
      move: (...args) => this.move(...args), dropActive: id => this.dropActive(id),
      isSyntheticContinuation: (run, step) => isSyntheticContinuation(run, step),
      beginUsageInvocation: (...args) => this.beginUsageInvocation(...args),
      trackWorkerSessionResult: (...args) => this.trackWorkerSessionResult(...args),
      recordUsagePeaks: id => this.recordUsagePeaks(id),
      saveWorktree: (...args) => this.saveWorktree(...args), pump: () => this.line.pump(),
      makeUiSink: (...args) => this.makeUiSink(...args),
      repositoryRootLockDisabled: () => repositoryRootLockDisabled(),
      prepareWorktree: (...args) => this.prepareWorktree(...args),
      workerStep: (...args) => this.workerStep(...args),
      latchAgentInputError: (...args) => this.latchAgentInputError(...args),
      reconcileWorkerWaits: () => this.reconcileWorkerWaits(),
      holdContinuationForRootFinish: (...args) => this.holdContinuationForRootFinish(...args),
    }, this.line, this.sessionHelperHost, this.repoRootLease, this.worktreeAutosave, this.runSkills,
    this.sessionEventHost(), this.launchPreambleHost(), this.inputReceiptHost, this.inputReceiptSteps,
    this.humanWaits, this.queuedInput, this.workerQuestions, this.runSettlement);
    this.stepLoop = new WorkflowStepLoop(this.context, {
      active: this.active, move: (id, exit, patch) => this.move(id, exit, patch), dropActive: id => this.dropActive(id),
      closingWakeDecision: (id, holds, cancelled, error) => this.wakeAdmission.closingWakeDecision(id, holds, cancelled, error),
      owesDelivery: id => this.wakeAdmission.owesDelivery(id),
      workerExecutionStopped: id => this.workerExecutionStopped(id),
      executionBlockedByRootFinish: run => this.executionBlockedByRootFinish(run),
    }, this.line, this.worktreeAutosave, this.humanWaits, this.runSettlement, this.stepSession,
    this.completionGateHost, WAKE_SESSION_CLOSED_ERROR);
    this.turnSettler = new TurnSettler(this.context, {
      humanWaits: this.humanWaits, line: this.line, waitWatches: this.waitWatches, waitRegistry: this.waitRegistry,
      workerQuestions: this.workerQuestions, completionGateHost: this.completionGateHost,
      move: (id, exit) => this.move(id, exit), releaseSlot: () => this.line.releaseSlot(), completionGate: id => this.completionGate(id),
      cancelOpenWaits: id => this.wakeAdmission.cancelOpenWaits(id), countAutomaticWakes: id => this.wakeAdmission.automaticWakes(id),
      workerExecutionStopped: id => this.workerExecutionStopped(id), executionBlockedByRootFinish: run => this.executionBlockedByRootFinish(run),
      submitAgentInput: (id, state, content) => this.submitAgentInput(id, state, content), flushAgentInputs: id => this.flushAgentInputs(id),
      hasQueuedAgentInputs: (id, except) => this.hasQueuedAgentInputs(id, except), armUnreadInputTimer: (id, state) => this.armUnreadInputTimer(id, state),
      armHeldHumanInputTimer: (id, state) => this.armHeldHumanInputTimer(id, state), parkOnWaits: (id, state) => this.wakeAdmission.parkOnWaits(id, state),
      queueWaitWake: id => this.wakeAdmission.queueWaitWake(id), leaveMonitoringPool: id => this.wakeAdmission.leaveMonitoringPool(id), chargeAutomaticWake: id => this.wakeAdmission.chargeAutomaticWake(id),
      canAutoContinue: (id, state) => this.turnNudges.canAutoContinue(id, state), tryAutonomousNudge: (id, state, step, ask) => this.turnNudges.tryAutonomousNudge(id, state, step, ask),
      sendTurnEndNudge: (id, state, step, text) => this.turnNudges.sendTurnEndNudge(id, state, step, text),
      awaitCompletionNudgeReply: (id, state, session) => this.turnNudges.awaitCompletionNudgeReply(id, state, session),
      noticeParkedWorker: id => this.noticeParkedWorker(id), routeWorkerQuestion: id => this.routeWorkerQuestion(id),
      settledTurnOutcome: (id, entry, outcome) => this.settledTurnOutcome(id, entry, outcome),
    }, IDLE_TIMEOUT_MS, MAX_AUTO_CONTINUES, COMPLETION_WILL_WAIT, SCHEDULE_WAKEUP_MAX_SECONDS);
    this.inputDelivery = new InputDelivery(this.context, {
      active: this.active, line: this.line, workerExecutions: this.workerExecutions, runSkills: this.runSkills,
      attachments: this.attachments, humanWaits: this.humanWaits, workerQuestions: this.workerQuestions,
      waitRegistry: this.waitRegistry, inputReceiptHost: this.inputReceiptHost,
      isActive: id => this.isActive(id), move: (id, exit) => this.move(id, exit),
      workerExecutionStopped: id => this.workerExecutionStopped(id), executionBlockedByRootFinish: run => this.executionBlockedByRootFinish(run),
      hasUnansweredHumanAsk: id => this.hasUnansweredHumanAsk(id), countAutomaticWakes: (id, budget) => this.wakeAdmission.automaticWakes(id, budget),
      recoveringRun: id => this.recoveringRun(id), continueRun: (id, opts, defer) => this.continueRun(id, opts, defer),
      latchAgentInputError: (id, state, session, message) => this.latchAgentInputError(id, state, session, message),
      parkForUser: (id, state, step) => this.turnSettler.parkForUser(id, state, step), settleTurn: (id, state, entry, turn) => this.turnSettler.settleTurn(id, state, entry, turn),
      boundaryTurn: (id, state, session, done) => this.turnSettler.boundaryTurn(id, state, session, done),
      canAutoContinue: (id, state) => this.turnNudges.canAutoContinue(id, state), armNoWaitNudgeReplyTimer: (id, state) => this.turnNudges.armNoWaitNudgeReplyTimer(id, state),
      awaitCompletionNudgeReply: (id, state, session) => this.turnNudges.awaitCompletionNudgeReply(id, state, session),
      queueWaitWake: id => this.wakeAdmission.queueWaitWake(id), owesWake: (run, budget) => this.wakeAdmission.owesWake(run, budget),
      pendingConversationWakes: (run, budget) => this.wakeAdmission.pendingConversationWakes(run, budget), routedAnswer: id => this.wakeAdmission.routedAnswer(id),
      spendWakeAdmission: (id, state, owed) => this.wakeAdmission.spendWakeAdmission(id, state, owed), cancelAutomaticAtCap: (id, waits) => this.wakeAdmission.cancelAutomaticAtCap(id, waits),
      reparkWithoutWaits: (id, state) => this.wakeAdmission.reparkWithoutWaits(id, state), holdPeerWakesAtCap: id => this.wakeAdmission.holdPeerWakesAtCap(id),
      reconcileWorkerWaits: () => this.reconcileWorkerWaits(), unreadInputGraceMs: () => this.unreadInputGraceMs,
      submitAgentInput: (id, state, content, inputs, budget) => this.submitAgentInput(id, state, content, inputs, budget),
    }, MAX_AUTO_CONTINUES, ROUTED_QUESTION_REFUSAL);
    this.ciResources = acquireCiResources(this.semaphore);
    this.ciSupervisor = this.ciResources.supervisor;
    this.offSemaphore = this.semaphore.register({
      busySlots: () => this.line.busySlots(),
      oldestWakeAt: () => this.line.oldestWakeAt(),
      pump: () => this.line.pump(),
      oldestQueuedAt: () => this.line.oldestQueuedAt(),
      accountHolds: () => this.accountHolds(),
    });
    // Memory guard (#memory-guard): the shared process-tree sampler already ticks ~every 2 s for
    // the runs table; piggyback on it to enforce the per-task memory ceiling.
    this.offUsage = onUsage((snapshot) => void this.enforceMemoryLimit(snapshot));
    this.queueWatchdog = setInterval(() => void this.line.rescueStalledQueue(), QUEUE_WATCHDOG_MS);
    this.queueWatchdog.unref?.();
    this.store.on('run', this.onDelegationRun);
    this.store.on('deleted', this.wakeAdmission.onRunDeleted);
  }

  /**
   * Release everything this manager owns without touching run records
   * (multi-project workspace, spec 2026-07-20: a removed project's context is
   * torn down while the process lives on). Unsubscribes the shared usage
   * sampler — before dispose() existed that subscription lived for the whole
   * process — clears every per-run idle/autosave timer, releases any held
   * repo-root locks, and empties the queued state so nothing fires later.
   * Live sessions are NOT ended here: run lifecycle stays the caller's policy;
   * dispose only guarantees the manager makes no further moves on its own.
   */
  dispose(): void {
    this.disposed = true;
    this.workerScratchCleanup.pause();
    this.waitWatches.disposeWatches();
    this.waitRegistry.dispose();
    this.waitWatches.disposeRetries();
    this.retries.dispose();
    // Wait records stay as they are: a later manager re-arms them from their deadlines.
    this.waitWatches.dispose();
    this.ciResources.release();
    this.delegationProvisioner = undefined;
    this.orphans.dispose();
    this.workerExecutions.dispose();
    this.store.off('run', this.onDelegationRun);
    this.store.off('deleted', this.wakeAdmission.onRunDeleted);
    this.familyReconciler.dispose();
    this.inboxClaims.dispose();
    this.offUsage();
    this.offSemaphore();
    clearInterval(this.queueWatchdog);
    for (const [runId, state] of this.active) {
      state.revokeCiTools?.(); state.revokeCiTools = undefined;
      state.revokeDelegation?.(); state.revokeDelegation = undefined;
      clearIdleTimer(state);
      this.clearAutosaveTimer(state);
      state.releaseRepoRoot?.();
      state.releaseRepoRoot = undefined;
    }
    this.autoResumeScheduler.dispose();
    this.active.clear();
    this.line.dispose();
    this.memoryPausing.clear();
    this.turnBookkeeper.clear();
    this.worktreeAutosave.dispose();
  }

  /**
   * Pause any active run whose whole process tree exceeds the WORKSPACE
   * `resources.memoryLimitMb`, freeing its slot so the queue advances
   * (#memory-guard). "Pause" closes the session — freeing the tree's
   * memory — and leaves the run resumable via Continue; a loud warning explains why. No-op when
   * no limit is set or the sampler has no data (e.g. `ps`/PowerShell unavailable).
   */
  private async enforceMemoryLimit(snapshot: Record<string, ProcessUsage>): Promise<void> {
    // The sampler is module-global (one `ps` for the whole process), so with
    // multiple projects a snapshot carries EVERY project's runs. Act only on
    // rows this manager owns (multi-project spec, step 2.4).
    const runIds = Object.keys(snapshot).filter((runId) => this.active.has(runId));
    if (runIds.length === 0) return;
    // Workspace limit from the shared semaphore's in-memory cache (step 2.5:
    // refreshed at boot and on PUT /api/workspace/config — never N per-tick
    // file reads across N projects). Legacy per-repo `memoryLimitMb` keys are
    // ignored post-migration.
    const limitMb = this.semaphore.memoryLimitMb();
    if (!limitMb || limitMb <= 0) return;
    const limitBytes = limitMb * 1024 * 1024;
    for (const runId of runIds) {
      const usage = snapshot[runId];
      if (!usage || usage.rssBytes <= limitBytes) continue;
      if (this.memoryPausing.has(runId)) continue;
      const state = this.active.get(runId);
      if (!state?.session?.open || state.cancelled) continue;
      this.memoryPausing.add(runId);
      const usedMb = Math.round(usage.rssBytes / (1024 * 1024));
      this.store.appendEvent(runId, {
        type: 'note',
        message: `⚠ memory limit exceeded — this task's process tree is using ${usedMb} MiB (limit ${limitMb} MiB). Pausing it and letting the next queued task run; resume it with Continue.`,
      });
      this.store.appendEvent(runId, {
        type: 'lifecycle',
        message: `paused — memory limit exceeded (${usedMb} MiB > ${limitMb} MiB)`,
      });
      // Closing the session frees the tree and lets the normal exit path settle the run and
      // pump the queue. Suppress autonomous auto-continue so the pause actually holds.
      state.autonomous = false;
      clearIdleTimer(state);
      state.session.end();
    }
  }

  private agentEnv(runId: string): Record<string, string> {
    return launchContext.agentEnv({ store: this.store, repoRoot: this.repoRoot, dataDir: this.dataDir }, this.cockpit, runId);
  }

  /** The pinned identity one agent step of an owned worker runs under; undefined for ordinary and internal runs. */
  private workerStep(runId: string, stepId: string | undefined): WorkerStepIdentity | undefined {
    const identity = workerIdentity(this.store, this.repoRoot, runId, stepId);
    if (!identity) return undefined;
    return stepId === undefined
      ? { account: identity.account, grants: identity.grants, ...(identity.model === undefined ? {} : { model: identity.model }), ...(identity.effort === undefined ? {} : { effort: identity.effort }) }
      : workerStepIdentity(identity, stepId);
  }

  private agentEnvForStep(
    runId: string,
    backend: RunnerId,
    options: { recordedProfileId?: string | undefined; stepId?: string | undefined } = {},
  ): Promise<{ env: Record<string, string>; profileId: string; accountBinding?: WorkerAccountBinding | undefined }> {
    return launchContext.agentEnvForStep({ store: this.store, repoRoot: this.repoRoot, dataDir: this.dataDir }, {
      agentEnv: (id) => this.agentEnv(id),
      workerStep: (id, stepId) => this.workerStep(id, stepId),
    }, runId, backend, options);
  }

  /**
   * The cockpit serving this manager's project, set by `startServer` once it listens (#774).
   * Every agent env then carries it as `CEZ_COCKPIT_URL`/`CEZ_PROJECT_ID`, which is how
   * `cez automation` reaches the cockpit without probing ports. A headless `cez run` never
   * sets it, so it is also the "a cockpit is attached" signal for the automations gate.
   */
  private cockpit?: { origin: string; projectId: string } | undefined;
  setCockpitAddress(address: { origin: string; projectId: string } | undefined): void {
    this.cockpit = address ? { ...address } : undefined;
  }
  cockpitAddress(): { origin: string; projectId: string } | undefined {
    return this.cockpit ? { ...this.cockpit } : undefined;
  }
  /**
   * hearsay-tools/cezarion#1465: the project's one-time schedule service behind
   * `cezar_schedule_task` and `cezar_scheduled_tasks`, set by `startServer` beside the cockpit
   * address. Headless `cez run` never sets it, so the tools answer `unavailable` there. The
   * boot manager recovers runs before the server sets it, and a lazy project's manager recovers
   * before its context is announced: a resumed session can call a tool in that window. With a
   * cockpit address the call waits for the service, bounded like the CLI's startup retry.
   */
  private readonly automationToolsSlot: AutomationToolsSlot;
  setAutomationTools(tools: AutomationToolService | undefined): void { this.automationToolsSlot.setAutomationTools(tools); }
  private awaitAutomationTools(signal: AbortSignal): Promise<AutomationToolService | undefined> { return this.automationToolsSlot.awaitAutomationTools(signal); }
  builtinSkills(): Skill[] { return launchContext.builtinSkills(this.cockpit); }
  private automationsPart(): string | undefined { return launchContext.automationsPart(this.cockpit); }
  private agentWebhooksPart(): Promise<string | undefined> { return launchContext.agentWebhooksPart({ store: this.store, repoRoot: this.repoRoot, dataDir: this.dataDir }, this.cockpit); }
  private sessionContextFor(runId: string, state: ActiveRun, stepId: string, openingPrompt: string): SessionContext {
    return launchContext.sessionContextFor({ store: this.store, repoRoot: this.repoRoot, dataDir: this.dataDir }, runId, state, stepId, openingPrompt);
  }
  /** Every skill lookup in this manager goes through here, so the built-ins reach all of them. */
  private discoverSkills(): Promise<Skill[]> {
    return discoverSkills(this.repoRoot, { builtin: this.builtinSkills() });
  }
  private loadRunSkills(state: ActiveRun, onFailure: 'throw' | 'ignore'): Promise<void> { return this.runSkills.loadRunSkills(state, onFailure); }
  private enabledSkills(state: ActiveRun): Skill[] { return this.runSkills.enabledSkills(state); }

  private delegationProvisioner?: DelegationProvisioner | undefined;
  setDelegationProvisioner(provisioner: DelegationProvisioner): () => void {
    this.delegationProvisioner = provisioner;
    return () => {
      if (this.delegationProvisioner === provisioner) this.delegationProvisioner = undefined;
      for (const state of this.active.values()) { state.revokeDelegation?.(); state.revokeDelegation = undefined; }
    };
  }
  private provisionSession(runId: string, state: ActiveRun) {
    state.revokeDelegation?.(); state.revokeDelegation = undefined;
    if (this.historyDeletionPending(runId)) return;
    const session = this.delegationProvisioner?.(runId);
    state.revokeDelegation = session?.revoke;
    return session;
  }

  /** Provision the same capability and descriptor on every start, Continue and recovered launch. */
  private async provisionCiSession(runId: string, state: ActiveRun) {
    state.revokeCiTools?.();
    state.revokeCiTools = undefined;
    state.ciGeneration = randomUUID();
    state.ciTurnId = randomUUID();
    const generation = state.ciGeneration;
    const controller = await this.ciResources.controller();
    state.toolless = !controller;
    if (!controller || this.disposed || state.cancelled || this.active.get(runId) !== state) return;
    const provisioned = previewCdpSession(controller.provision(this.cezarToolHandlers(runId, generation)), { host: this.preview, cockpitOrigin: this.cockpit?.origin, runId, worktree: !!this.store.getRun(runId)?.worktreePath, context: () => previewRunContext(this.store, this.dataDir, runId) });
    state.revokeCiTools = provisioned.revoke;
    return provisioned;
  }

  /**
   * The trusted callbacks behind one session's cezar tools (hearsay-tools/cezarion#1233). Both
   * answers list the waits still open; a coded refusal answers with its fixed message, never the
   * thrower's text, and anything else is left to the tool server's `unavailable`.
   */
  cezarToolHandlers(runId: string, generation: string): CezarToolHandlers {
    return cezarToolHandlers(runId, generation, { store: this.store,
      registerWait: (...args) => this.registerWait(...args), registerAsk: (...args) => this.waitRegistry.registerAsk(...args),
      cancelWait: (...args) => this.cancelWait(...args), acceptDone: (...args) => this.acceptDone(...args),
      registerPreviewServer: (...args) => this.registerPreviewServer(...args), stopPreviewServer: (...args) => this.stopPreviewServer(...args),
      awaitAutomationTools: signal => this.awaitAutomationTools(signal) });
  }

  /**
   * `cezar_done` (hearsay-tools/cezarion#1234). Accepted, the run finishes at this turn's end
   * through the done branch, which cancels every open wait; in a workflow step that is not the
   * last, that branch completes the step and the next one starts (hearsay-tools/cezarion#1620), and
   * the answer says which. Refused, the answer says what to do
   * first. The gate is the completion gate, in order: the session, a root finish, the user's
   * question, then for a root its workers' questions, live workers and uncollected results. The turn end re-checks it (`deferParentCompletion`).
   */
  acceptDone(runId: string, generation: string, request: CezarDoneRequest, signal?: AbortSignal): CezarDoneAnswer {
    const parsed = cezarDoneRequestSchema.parse(request);
    const state = this.active.get(runId);
    const open_waits = openWaitList(this.store.getRun(runId)?.waits ?? []);
    const refuse = (code: DoneErrorCode, message: string, workers: { worker_id: string; reason: 'outstanding' | 'uncollected' | 'question' }[] = []): CezarDoneAnswer => {
      // Fixed codes only, as for wait registration.
      console.warn(`[cez] cezar_done refused: ${code}`);
      return { ok: false, code, message, ...(workers.length ? { workers: workers.slice(0, 64) } : {}), open_waits };
    };
    const session = toolSessionRefusal(this.store.getRun(runId), state, this.active.get(runId), generation, signal, this.disposed);
    const run = this.store.getRun(runId);
    if (session || !run || !state?.session) return refuse(session ?? 'run_missing', doneErrorMessage(session ?? 'run_missing'));
    if (this.executionBlockedByRootFinish(run)) return refuse('root_finish_pending', doneErrorMessage('root_finish_pending'));
    // The answer a continuation opened with is not a pending question while its turn runs.
    if (state.pendingHumanAsk || this.hasUnansweredHumanAsk(runId)) return refuse('human_question_pending', doneErrorMessage('human_question_pending'));
    const refusal = this.completionRefusal(runId);
    if (refusal) {
      recordRequestRefusal(state, refusal, true);
      return refuse(refusal.code, refusal.message, refusal.workers);
    }
    state.doneRequested = { session: state.session, ...(parsed.summary === undefined ? {} : { summary: parsed.summary }) };
    const next = state.nextStep?.session === state.session ? state.nextStep.label : undefined;
    return { ok: true, finishes: 'at_turn_end', ...(next === undefined ? { completes: 'task' as const } : { completes: 'step' as const, next_step: next }), open_waits };
  }

  private completionRefusal(runId: string): CompletionRefusal | undefined { return completionGateReads.completionRefusal(this.context, this.completionGateHost, runId); }

  async stopPreviewServer(runId: string, request: PreviewStopRequest, signal?: AbortSignal): Promise<PreviewStopResult> {
    return stopPreviewServer(this.store, this.preview, this.cezarPort, () => this.disposed, runId, request, signal);
  }
  async registerPreviewServer(runId: string, request: PreviewServeRequest, signal?: AbortSignal): Promise<PreviewServeResult> {
    return registerPreviewServer(this.store, this.preview, this.cezarPort, () => this.disposed, runId, request, signal);
  }

  async registerWait(runId: string, request: CezarWaitRequestInput, via: WaitVia, generation: string, capabilitySignal?: AbortSignal): Promise<PrWaitEntry | TimerWaitEntry | WorkerWaitEntry | ProcessWaitEntry | PeerWaitEntry> { return this.waitRegistry.registerWait(runId, request, via, generation, capabilitySignal); }
  cancelWait(runId: string, waitId: string, generation: string) { return this.waitRegistry.cancelWait(runId, waitId, generation); }

  private disarmWait(waitId: string): void { this.waitWatches.disarmWait(waitId); this.familyReconciler.forgetRetry(waitId); this.waitWatches.disarmProcessWatch(waitId); }

  /** Snapshot of the actual active session, never guessed from partial run settings. */
  delegationExecutionSettings(runId: string): DelegationExecutionSettings {
    return delegationExecutionSettings(this.active.get(runId));
  }

  /**
   * Resolve one agent step's selection before acceptance; permission grants always come from the
   * parent. Called once per agent step of the accepted chain (#452): a same-backend step inherits
   * the parent's account, model and effort, another runner resolves its own project/default
   * account, and an explicit `agentProfile` names the account for either — an id the registry
   * does not know is refused rather than degraded to the default, because a worker silently
   * running on another login is a billing boundary crossed without anyone choosing it.
   */
  async selectDelegationExecutionSettings(runId: string, selection: { backend?: RunnerId | undefined; model?: string | undefined; effort?: string | undefined; agentProfile?: string }, validateModel?: (settings: DelegationExecutionSettings) => Promise<void>): Promise<DelegationExecutionSettings> {
    return selectDelegationExecutionSettings(this.repoRoot, this.delegationExecutionSettings(runId), selection, validateModel);
  }

  /**
   * Idempotent start (#504, spec 2026-09-24-cez-task-cli). Lookup and create share one
   * synchronous path, so the event loop serialises concurrent retries: the first creates, every
   * later one with the same hash gets that run back, and a different hash is a conflict.
   */
  startRunIdempotent(
    workflow: WorkflowDef,
    input: StartRunInput,
    request: { id: string; hash: string },
  ): { run: RunRecord; created: boolean } | { conflict: true } {
    const existing = this.store.findRunByClientRequestId(request.id);
    if (existing) {
      return existing.clientRequestHash === request.hash ? { run: existing, created: false } : { conflict: true };
    }
    return { run: this.startRun(workflow, input, request), created: true };
  }

  startRun(
    workflow: WorkflowDef,
    input: StartRunInput,
    clientRequest?: { id: string; hash: string },
  ): RunRecord {
    // Sanitize at the manager boundary so CLI runs, workflows, and
    // direct callers cannot bypass the HTTP policy.
    const effectiveInput = agentModelsLocked(this.repoRoot)
      ? { ...input, model: undefined, effort: undefined }
      : input;
    const run = this.store.createRun({
      title: makeRunTitle(input.task, workflow),
      workflow: workflow.name,
      task: input.task,
      systemPrompt: input.systemPrompt,
      model: effectiveInput.model,
      effort: effectiveInput.effort,
      runner: input.runner,
      // The composer's per-task account (spec 2026-07-29-agent-profiles). Persisted at creation
      // so a queued run picks it up at dequeue and every later resume reads the same answer.
      agentProfile: input.agentProfile,
      // Persist autonomy on the record (#489) so the terminal review gate
      // (`settleSuccess`) can honor it — mid-run
      // auto-nudge reads `input.autonomous` (`execute`), but the record is the
      // only source those after-the-fact consumers have.
      autonomous: input.autonomous === true,
      archiveWhenDone: input.archiveWhenDone,
      autoMergePr: input.autoMergePr,
      notify: input.notify === true,
      // Persist the explicit opt-out so queued-run restart recovery and the
      // session Git routes can distinguish it from a removed isolated worktree.
      worktree: input.worktree === false ? false : undefined,
      clientRequestId: clientRequest?.id,
      clientRequestHash: clientRequest?.hash,
      automation: input.automation,
      automationTrigger: input.automationTrigger,
      steps: workflow.steps.map((s) => ({ id: s.id, name: s.name ?? s.id, kind: stepKind(s) })),
    });
    // The row exists from here on. A later write that throws still queues the job, so the caller
    // that sees the throw finds a run that starts now, not one only a restart would start (#1465).
    try {
      // Persist the full definition so a queued run survives a restart (#367) —
      // ad-hoc "(planned)" chains exist nowhere else to re-resolve from.
      this.store.updateRun(run.id, { workflowDef: workflow });
      // Initial pasted attachments must be visible while the run is still queued (#612),
      // and must survive a restart before a slot opens. Persist them before the job
      // enters `pendingJobs`; `hydrateQueuedInput` reconstructs their content blocks
      // from these URLs when a recovered run eventually starts — and for a file (#950)
      // this write is the ONLY copy, since it never had a block to be rebuilt from.
      if (input.images?.length) {
        const persisted = this.persistPastedAttachments(run.id, input.images);
        if (persisted.length) {
          this.store.updateRun(run.id, { taskImages: persisted.map((saved) => saved.url) });
        }
      }
      // Step-0 reference extraction (task auto-naming spec): the regex layer's
      // numbers persist immediately; the namer may add the kind it verified later.
      const skillHint = workflow.steps.find((s) => stepKind(s) === 'agent' && s.skill)?.skill?.trim();
      const refs = refineTaskRefs(extractTaskRefs(input.task), skillHint);
      if (refs.prNumber !== undefined || refs.issueNumber !== undefined) {
        this.store.updateRun(run.id, {
          ...(refs.prNumber !== undefined ? { prNumber: refs.prNumber } : {}),
          ...(refs.issueNumber !== undefined ? { issueNumber: refs.issueNumber } : {}),
        });
      }
      // Fire-and-forget LLM naming (task auto-naming spec): the heuristic title
      // above shows instantly; the namer's short title replaces it when (and if)
      // the model answers. Never awaited, never fails the run.
      void this.turnBookkeeper.autoNameRun(run.id, skillHint, input.task);
    } finally {
      this.line.enqueueJob(run.id, { workflow, input: effectiveInput });
      void this.line.pump();
    }
    return run;
  }

  /** Accept only the store's already-durable owned creation, never caller-supplied paths/workflows. */
  enqueueOwnedRun(runId: string): void {
    const run = this.store.getRun(runId);
    if (!run) throw new DelegationPolicyError('incompatible_state', 'Owned queued run not found');
    const job = this.ownedJob(run);
    if (this.line.hasQueued(runId) || this.line.hasStarting(runId) || this.active.has(runId)) return;
    this.line.enqueueJob(runId, job);
    void this.line.pump();
  }

  private ownedJob(run: RunRecord): { workflow: WorkflowDef; input: StartRunInput } {
    const delegation = delegationStateSchema.safeParse(run.delegation);
    if (this.historyDeletionPending(run.id) || run.status !== 'queued' || !delegation.success || delegation.data.role !== 'worker' ||
        delegation.data.workspace.ownerRunId !== run.id || delegation.data.destroy) {
      throw new DelegationPolicyError('incompatible_state', 'Run is not an executable owned creation');
    }
    // Accepted permissions are private immutable evidence. Only explicit internal
    // primitive records retain the public-definition compatibility path.
    const grants = workerIdentity(this.store, this.repoRoot, run.id)?.grants
      ?? run.workflowDef?.steps.find(step => step.id === QUICK_TASK_WORKFLOW.steps[0]!.id);
    return {
      workflow: ownedWorkflow(run, this.store.readWorkerIdentity(run.id)) ?? { ...QUICK_TASK_WORKFLOW, steps: [{ ...QUICK_TASK_WORKFLOW.steps[0]!,
        ...(grants?.allowedTools === undefined ? {} : { allowedTools: [...grants.allowedTools] }),
        ...(grants?.bashAllowlist === undefined ? {} : { bashAllowlist: [...grants.bashAllowlist] }),
      }] },
      input: { ...queuedRecoveryInput(run), worktree: true },
    };
  }


  /** Read and hydrate mutable queued input in the same synchronous tick as dequeue. */
  private launchQueuedRun(runId: string, job: PendingJob | undefined, continuation: PendingContinuation | undefined): void {
    if (continuation) {
      void (async () => {
        const hydrated = this.hydrateQueuedContinuation(runId, continuation);
        await this.context.work.track('runContinuation', this.runContinuation(
          runId,
          hydrated.stepId,
          hydrated.sessionId,
          hydrated.backend,
          hydrated.prompt,
          hydrated.images,
          hydrated.persistedImages,
          hydrated.persistedAttachments,
        ));
      })().catch((err: unknown) => this.failCrashedContinuation(runId, err))
        .finally(() => this.finishWorkerExecution(runId));
      return;
    }
    if (!job) return;
    // Rebuild the prompt from the store at the last instant (open-mercato/cezar#472), so an edit
    // or a stacked message that landed while the run waited is honored. Entered
    // in the same synchronous tick as the `pendingJobs.delete` above, so no
    // handler can observe a half-dequeued run.
    void (async () => {
      const input = this.hydrateQueuedInput(runId, job.input);
      await this.context.work.track('execute', this.execute(runId, job.workflow, input, job.startAt));
    })().catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      this.move(runId, 'fail-crash', {
        error: `engine crashed: ${message}`,
        finishedAt: new Date().toISOString(),
      });
      const state = this.active.get(runId);
      if (state) {
        clearIdleTimer(state);
        this.clearAutosaveTimer(state);
      }
      this.line.unmarkStarting(runId);
      this.dropActive(runId);
    }).finally(() => this.finishWorkerExecution(runId));
  }

  private async reviveQueuedRun(run: RunRecord, reason: string): Promise<void> { return queuedRevival.reviveQueuedRun(this.context, this.queuedRevivalHost, run, reason); }

  /**
   * Startup recovery (#367) — re-adopt runs that were live when the previous
   * cezar process exited (requires the store opened with `keepLive`):
   *  - `queued`  → back into the queue (FIFO by createdAt), from the persisted
   *    workflowDef (or the catalog by name for older records);
   *  - `waiting` → preserve the durable attention state, while reaping the
   *    dead session's temporary resources (Continue or Finish still works);
   *  - `running` → mark interrupted, then immediately resume the last agent
   *    session via the Continue path, pointing the agent at its handoff file.
   * Call once, before the server starts taking requests.
   *
   * With `familyRootId`, the same recovery for the one delegation family a dead process left
   * behind, which `adoptOrphanedRun` has just loaded. Either way only runs this store owns are
   * touched: another live process's runs are not in the live set, and the passes that read every
   * worker or root skip their families (#779, plan step 3).
   */
  async recover(familyRootId?: string): Promise<void> { return this.recovery.recover(familyRootId); }

  /**
   * Adopt a dead owner’s family for a control, then recover the settled family without resuming
   * work. Stop cancels its target; only Continue starts work. Serialize adoptions after recovery.
   * False means missing or live-owned.
   */
  adoptOrphanedRun(runId: string, opts: { stop?: boolean } = {}): Promise<boolean> { return this.recovery.adoptOrphanedRun(runId, opts); }

  private isDisposedDelegatedRun(runId: string): boolean {
    return isDisposedDelegatedRun(this.store, () => this.disposed, runId);
  }

  /** Shutdown is not completion. Explicit terminal controls retain their precedence. */
  private preserveRunAfterDisposal(runId: string, state: ActiveRun): boolean {
    return preserveRunAfterDisposal(this.store, () => this.disposed, runId, state);
  }

  /**
   * Register an executing run: the ONE way an `ActiveRun` enters `active`. Both callers of
   * `createActiveRun` (`execute` and `runContinuation`, which serves Continue and restart
   * recovery) call it, so the store pins every run this manager executes (#779) — its record stays
   * the held object every turn-end handler reads and writes until `dropActive` lets it go. A site
   * that set `active` directly would execute a run the store could evict mid-turn (the open-mercato/cezar#811 shape).
   */
  private activate(runId: string, state: ActiveRun): void {
    state.pendingPermissions = new Set();
    if (this.store.getRun(runId)?.hasPendingPermission) this.store.updateRun(runId, { hasPendingPermission: false });
    this.active.set(runId, state);
    this.store.pin(runId, 'active');
  }

  /** Remove a run from the live registries — keeps `waiting ⊆ active`. */
  private dropActive(runId: string): void {
    const state = this.active.get(runId);
    releaseActiveResources(this.store, runId, state);
    if (state) {
      clearIdleTimer(state);
      this.clearAutosaveTimer(state);
      clearHeldHumanInputTimer(state);
    }
    this.line.forget(runId);
    this.active.delete(runId);
    this.store.unpin(runId, 'active');
    this.runSettlement.afterDropActive(runId);
  }

  private readonly workerScratchCleanup: WorkerScratchCleanup;
  /** Project detach cancels autonomous cleanup; reattach reconstructs the durable intents. */
  pauseWorkerCleanup(): void { this.workerScratchCleanup.pause(); }
  recoverWorkerCleanup(): void { if (!this.disposed) this.workerScratchCleanup.recover(); }

  claimWorkerCleanup(runId: string): (() => void) | undefined { return this.claims.claimWorkerCleanup(runId); }

  /** Scratch belongs to the task, not its current agent process (#515).
   * Terminal status alone is not process-exit proof: an active session or an
   * unfinished private worker generation must retain its files until exit. */
  private reapTerminalScratch(runId: string): void {
    const run = this.store.getRun(runId);
    if (!run || ['queued', 'running', 'waiting'].includes(run.status)) return;
    if (this.active.has(runId) || this.line.hasStarting(runId) || this.line.hasQueued(runId) || this.claims.has(runId) || !!this.autosaveCleanupBlocker(runId)) return;
    const privateWorkers = workerEvidenceRunIds(this.dataDir);
    if (run.delegation?.role === 'worker' || run.delegation?.role === 'invalid' || !privateWorkers || privateWorkers.includes(runId)) { this.workerScratchCleanup.schedule(runId); return; }
    removeAgentTmpDir(this.dataDir, runId);
  }

  // ---- usage-limit auto-resume (spec 2026-08-03-auto-resume-after-usage-limit) --------------

  private reconcileAutoResumes(): void { this.autoResumeScheduler.reconcileAutoResumes(); }

  private requeueWhileHeld(
    runId: string,
    workflow: WorkflowDef,
    input: StartRunInput,
    runner: RunnerId,
    state?: ActiveRun,
    startAt?: number,
  ): boolean { return this.stepLoop.requeueWhileHeld(runId, workflow, input, runner, state, startAt); }

  accountHolds(now = Date.now()): AccountHolds {
    return deriveAccountHolds(this.store.listRuns(), run => this.wakeAdmission.withExecutionAccount(run), now);
  }

  cancelAutoResume(runId: string): boolean { return this.autoResumeScheduler.cancelAutoResume(runId); }

  /** Reclaim finished worktrees beyond the keep-limit (#483) — directory only,
   *  `cez/<id8>` branch kept. Best-effort; a failure never affects run
   *  lifecycle. `review`/live runs are excluded by the selector. */
  private async enforceRetention(): Promise<void> {
    return this.context.work.track('enforceRetention', this.enforceRetentionWork());
  }

  private async enforceRetentionWork(): Promise<void> {
    try {
      const keep = await resolveWorktreeRetention(this.repoRoot);
      await reclaimWorktrees(this.repoRoot, this.store, keep, { claim: (run) => this.claimWorktreeReclaim(run.id), previewHost: this.preview });
    } catch {
      // retention is best-effort; swallow so terminal transitions never break.
    }
  }

  private readonly turnBookkeeper: TurnBookkeeper;
  /** Test seam: the module owns this same map for its whole lifetime. */

  private async acquireRepoRoot(runId: string, state: ActiveRun): Promise<boolean> {
    return this.repoRootLease.acquireRepoRoot(runId, state);
  }

  cancel(runId: string): boolean {
    // Another process's run (#779, plan step 3): only its owner can stop it.
    if (this.store.writeRefusal(runId)) return false;
    this.cancelWorkerExecution(runId);
    const hadWaits = !!this.store.getRun(runId)?.waits?.length;
    this.wakeAdmission.cancelOpenWaits(runId);
    const retiredRefusal = this.turnNudges.retireCompletionRefusal(runId);
    const cancelledFinish = transitionVia('cancel', () => this.store.getRun(runId), () => this.store.commitRootFinishCancellation(runId));
    // Still waiting in the queue: just drop it there.
    const queuedAt = this.line.indexOf(runId);
    if (queuedAt >= 0) {
      this.cancelQueuedRun(runId, queuedAt);
      return true;
    }
    const state = this.active.get(runId);
    if (!state) return this.cancelRunWithoutSession(runId, hadWaits, retiredRefusal, cancelledFinish);
    this.cancelActiveRun(runId, state);
    return true;
  }

  private cancelActiveRun(runId: string, state: ActiveRun): void {
    state.cancelled = true;
    this.store.updateRun(runId, { stopping: true });
    this.store.flush();
    state.revokeCiTools?.(); state.revokeCiTools = undefined;
    state.revokeDelegation?.(); state.revokeDelegation = undefined;
    clearIdleTimer(state);
    state.interrupt();
  }

  private cancelWorkerExecution(runId: string): void {
    if (this.store.getRun(runId)?.delegation?.role === 'worker') {
      const proof = this.store.readWorkerExecution(runId);
      transitionVia('stop-worker', () => this.store.getRun(runId), () => this.store.commitWorkerCancellation(runId));
      this.workerExecutions.markStopped(runId);
      if (!this.workerExecutions.has(runId) && !this.active.has(runId) && !this.line.hasStarting(runId) && proof?.phase === 'queued') {
        this.store.commitWorkerExecutionComplete(runId, proof.generation);
      }
    }
  }

  private cancelQueuedRun(runId: string, queuedAt: number): void {
    this.line.takeAt(queuedAt);
    this.line.takePending(runId);
    this.move(runId, 'cancel', { finishedAt: new Date().toISOString() });
    this.store.appendEvent(runId, { type: 'lifecycle', message: 'cancelled while queued' });
    this.store.flush();
    if (this.workerExecutions.admitted(runId) === false) void this.finishWorkerExecution(runId);
  }

  private cancelRunWithoutSession(runId: string, hadWaits: boolean, retiredRefusal: boolean, cancelledFinish: boolean): boolean {
    if (this.line.hasStarting(runId)) {
      this.store.updateRun(runId, { stopping: true });
      this.store.flush();
      return true;
    }
    if (cancelledFinish) return true;
    const run = this.store.getRun(runId);
    // Stop on a failed run that held wait results discards them, and the automatic resume that
    // would start a session on it later; the run stays failed. A usage-limit hold is that failed
    // run waiting for its resume (hearsay-tools/cezarion#1236), and settles failed the same way.
    if ((hadWaits || retiredRefusal) && (run?.status === 'failed' || isUsageLimitHold(run ?? {}))) {
      this.store.appendEvent(runId, { type: 'note', message: hadWaits ? WAITS_DISCARDED_NOTE : REFUSAL_DISCARDED_NOTE });
      this.cancelAutoResume(runId);
      this.store.flush();
      return true;
    }
    if (run && (run.delegation || hadWaits) && ['queued', 'running', 'waiting'].includes(run.status)) {
      this.move(runId, 'cancel', { finishedAt: new Date().toISOString() });
      return true;
    }
    return false;
  }

  isActive(runId: string): boolean {
    return this.workerExecutions.has(runId) || this.active.has(runId) || this.line.hasStarting(runId) || this.line.hasQueued(runId);
  }

  claimWorktreeReclaim(runId: string): (() => void) | null { return this.claims.claimWorktreeReclaim(runId); }
  private holdForMaintenance(runIds: readonly string[]): (() => void) | null { return this.claims.holdForMaintenance(runIds); }
  claimForPublish(runId: string): (() => void) | null { return this.claims.claimForPublish(runId); }
  claimForBranchCleanup(runIds: readonly string[]): (() => void) | null { return this.claims.claimForBranchCleanup(runIds); }

  private hydrateQueuedInput(runId: string, input: StartRunInput): StartRunInput { return this.queuedInput.hydrateQueuedInput(runId, input); }
  private hydrateQueuedContinuation(runId: string, value: PendingContinuation) { return this.queuedInput.hydrateQueuedContinuation(runId, value); }
  private toQueuedMessage(runId: string, content: PastedContent[]): QueuedMessage { return this.queuedInput.toQueuedMessage(runId, content); }
  enqueueMessage(runId: string, content: PastedContent[]): QueuedMessage | null { return this.queuedInput.enqueueMessage(runId, content); }
  editQueuedMessage(runId: string, msgId: string, edit: { text?: string; images?: PastedContent[] }): QueuedMessage | null { return this.queuedInput.editQueuedMessage(runId, msgId, edit); }
  removeQueuedMessage(runId: string, msgId: string): boolean { return this.queuedInput.removeQueuedMessage(runId, msgId); }
  editTask(runId: string, task: string): boolean { return this.queuedInput.editTask(runId, task); }
  deferMessage(runId: string, content: PastedContent[]): boolean { return this.queuedInput.deferMessage(runId, content); }

  private parentCompletionBlockers(runId: string) { return completionGateReads.parentCompletionBlockers(this.context, this.completionGateHost, runId); }

  /** The read-only verdict and explicit Finish share this decision. Operational failures
   * (for example a failed durable write) are still handled at execution time. */
  private finishDecision(runId: string):
    { action: 'session' | 'root' | 'waiting' | 'review' } | { reason: string; warn?: boolean } { return completionGateReads.finishDecision(this.context, this.completionGateHost, runId); }

  finishBlockedReason(runId: string): string | undefined { return completionGateReads.finishBlockedReason(this.context, this.completionGateHost, runId); }

  private deferParentCompletion(runId: string): boolean {
    const gate = this.completionGate(runId);
    if (gate === 'accept') return false;
    const state = this.active.get(runId);
    // Mid-turn, the live turn end takes its done to the gate itself, behind owed input and waits.
    if (typeof gate === 'object' && state?.session && state.atTurnBoundary === state.session) {
      this.turnSettler.settleTurn(runId, state, 'gate', this.turnSettler.boundaryTurn(runId, state, state.session, true), gate);
    }
    return true;
  }

  /** The completion gate for a root's done: `accept`; a refusal a live session takes as its turn
   *  end's (`settleTurn`); or `held` when the gate settled it itself: a stopped root, a refusal
   *  queued for a closed session, or a pending human question that parks for the user. */
  private completionGate(runId: string): 'accept' | 'held' | CompletionRefusal {
    let parent = this.store.getRun(runId);
    if (parent?.delegation?.role !== 'root') return 'accept';
    // A late success callback has no authority to reopen a stopped/reviewing root.
    if (['done', 'review', 'failed', 'cancelled'].includes(parent.status)) return 'held';
    const state = this.active.get(runId);
    const pendingAsk = this.hasPendingHumanAsk(runId) || state?.pendingHumanAsk;
    if (!pendingAsk && this.completionMayPass(runId)) return 'accept';
    if (parent.delegation.finishRequestedAt) {
      // Legacy accepted Finish cannot strand the new gate behind an execution ban.
      const { finishRequestedAt: _intent, ...delegation } = parent.delegation;
      this.store.commitDelegation([{ id: runId, delegation }]);
      parent = { ...parent, delegation };
    }
    if (parent.delegation?.role !== 'root') return 'accept';
    const refusal = pendingAsk ? undefined : this.completionRefusal(runId);
    if (refusal && state?.session?.open) return refusal;
    // A legacy accepted Finish takes the same path as a done: its refusal reopens the session.
    if (refusal) { this.turnNudges.queueCompletionRefusal(runId, refusal); return 'held'; }
    // Every blocker but the pending human question is a refusal: the question parks for the user.
    this.store.appendEvent(runId, { type: 'note', tone: 'warning', message: 'Completion blocked: answer the pending human question.' });
    this.move(runId, 'park', { finishedAt: undefined });
    this.store.flush();
    if (state) {
      clearIdleTimer(state);
      this.line.leavePool(runId); this.line.park(runId);
      if (state.currentStepId) this.store.updateStep(runId, state.currentStepId, { status: 'waiting' });
      this.line.releaseSlot();
    }
    return 'held';
  }

  /** Human Finish keeps the worker guarantees and bypasses request obligations only. */
  private completionMayPass(runId: string): boolean { return completionGateReads.completionMayPass(this.context, this.completionGateHost, runId); }

  registerWorkerWait(parentId: string, request: WorkerWaitRequest): WorkerWait { return this.waitRegistry.registerWorkerWait(parentId, request); }
  registerWorkerListWait(runId: string, request: { workerIds?: string[]; requestIds?: string[] | undefined; mode?: WorkerWaitRequest['mode']; timeoutSeconds: number }, via: 'cezar_wait' | 'cez-worker-wait'): DeadlinedWorkerWaitEntry { return this.waitRegistry.registerWorkerListWait(runId, request, via); }
  registerRequestWait(runId: string, request: RequestWaitRequest): WorkerWait { return this.waitRegistry.registerRequestWait(runId, request); }
  registerPeerWait(runId: string, request: { peerIds: string[]; timeoutSeconds: number }, via: 'cezar_wait' | 'cez-message-wait'): PeerWaitEntry { return this.waitRegistry.registerPeerWait(runId, request, via); }
  cancelPeerWait(runId: string, waitId: string): PeerWaitEntry { return this.waitRegistry.cancelPeerWait(runId, waitId); }

  private hasUnansweredHumanAsk(runId: string): boolean {
    return pendingAskFacts.hasUnansweredHumanAsk(runId, this.active, id => this.pendingHumanAskSeq(id));
  }

  private providerOwnsInboxInput(runId: string, id: string): boolean {
    return this.inboxClaims.providerOwnsInboxInput(runId, id);
  }

  canClaimInboxInput(runId: string, id: string): boolean {
    return this.inboxClaims.canClaimInboxInput(runId, id);
  }

  reserveInboxInputs(runId: string, generation: string, ids: readonly string[]): { receiptId: string; expiresAt: string; inputIds: string[] } | undefined {
    return this.inboxClaims.reserveInboxInputs(runId, generation, ids);
  }

  acknowledgeInbox(runId: string, generation: string, receiptId: string): 'acknowledged' | 'already-acknowledged' {
    return this.inboxClaims.acknowledgeInbox(runId, generation, receiptId);
  }

  releaseInbox(runId: string, generation: string, receiptId: string): 'released' {
    return this.inboxClaims.releaseInbox(runId, generation, receiptId);
  }

  private armInboxClaimExpiry(runId: string): void {
    this.inboxClaims.armInboxClaimExpiry(runId);
  }

  /** Accepted conversation input uses the existing scheduler admission for idle recipients. */
  deliverConversationInput(runId: string): void { return this.inputDelivery.deliverConversationInput(runId); }

  private routeWorkerQuestion(workerId: string): void { return this.workerQuestions.routeWorkerQuestion(workerId); }

  private noticeParkedWorker(workerId: string): void { return this.workerQuestions.noticeParkedWorker(workerId); }

  private noticeParkedWorkers(rootId: string): void { return this.workerQuestions.noticeParkedWorkers(rootId); }

  private routedAsk(runId: string): { askSeq: number; message: ConversationMessage } | undefined { return this.workerQuestions.routedAsk(runId); }

  /** The parent's reply answers the routed question like a human answer would: through the
   * live session's native answer seam, or by reopening a session that is gone (#505). */
  private answerRoutedQuestion(runId: string, admitted = false): void { return this.inputDelivery.answerRoutedQuestion(runId, admitted); }

  private retireSettledQuestions(parentId: string): void { return this.workerQuestions.retireSettledQuestions(parentId); }

  private unansweredQuestions(parentId: string): { workerId: string; messageId: string }[] { return this.workerQuestions.unansweredQuestions(parentId); }

  private fallbackRoutedQuestions(parentId: string, reason: string): void { return this.workerQuestions.fallbackRoutedQuestions(parentId, reason); }

  /**
   * `cez worker cancel-wait`: cancels a worker wait in the list, as `cezar_cancel_wait` does, and
   * answers the legacy `WorkerWait` shape (hearsay-tools/cezarion#1235). A cancelled wait wakes
   * nothing. A resolved wait is owed: it is returned as its `wake-pending` receipt and arrives with
   * the next wake. A settled one returns its receipt; an unknown id is `incompatible_state`.
   */
  cancelWorkerWait(parentId: string, waitId: string): WorkerWait {
    const run = this.store.getRun(parentId);
    if (!run?.delegation || run.delegation.role === 'invalid') throw new DelegationPolicyError('denied_scope', 'Worker scope denied');
    const entry = run.waits?.find((wait): wait is DeadlinedWorkerWaitEntry => wait.id === waitId && wait.kind === 'worker' && hasWorkerDeadline(wait));
    if (!entry) {
      const settled = run.lastWaits?.filter((wait): wait is DeadlinedWorkerWaitEntry => wait.id === waitId && wait.kind === 'worker' && hasWorkerDeadline(wait)).at(-1);
      if (settled) return workerWaitEntryToLegacy(settled);
      throw new DelegationPolicyError('incompatible_state', 'Worker wait is no longer current');
    }
    if (entry.phase !== 'open') return workerWaitEntryToLegacy(entry);
    if (this.disposed || !['queued', 'running', 'waiting'].includes(run.status) || this.rootFinishRequested(parentId) || this.historyDeletionPending(parentId)) {
      throw new DelegationPolicyError('incompatible_state', 'Parent cannot cancel a worker wait');
    }
    this.store.commitOutcome(parentId, { kind: 'cancelled', waitIds: [waitId] });
    this.disarmWait(waitId);
    const cancelled = this.store.getRun(parentId)?.lastWaits?.filter((wait): wait is DeadlinedWorkerWaitEntry => wait.id === waitId && wait.kind === 'worker' && hasWorkerDeadline(wait)).at(-1);
    return workerWaitEntryToLegacy(cancelled ?? { ...entry, phase: 'cancelled', cancelledAt: new Date().toISOString() });
  }

  private rootFinishRequested(runId: string): boolean {
    return rootFinishRequested(this.store, runId);
  }

  private executionBlockedByRootFinish(run: RunRecord): boolean {
    return executionBlockedByRootFinish(this.store, run);
  }

  private canProceedWithRun(runId: string, run: RunRecord | undefined): run is RunRecord {
    return canProceedWithRun(run, () => this.workerExecutionStopped(runId), run => this.executionBlockedByRootFinish(run));
  }

  /** Finish can arrive during continuation preflight. Retain its accepted
   * payload in the ordinary queue, releasing the slot without opening a session. */
  private holdContinuationForRootFinish(runId: string, continuation: PendingContinuation, state?: ActiveRun): boolean {
    const run = this.store.getRun(runId);
    if (!run || !this.executionBlockedByRootFinish(run)) return false;
    this.line.enqueueContinuation(runId, continuation, true);
    this.store.updateStep(runId, continuation.stepId, { status: 'pending' });
    this.move(runId, 'requeue', { currentStepId: undefined });
    if (state) this.clearAutosaveTimer(state);
    this.line.unmarkStarting(runId); this.dropActive(runId);
    return true;
  }
  private async settleRequestedRootFinish(runId: string): Promise<void> {
    return this.context.work.track('settleRequestedRootFinish', this.settleRequestedRootFinishWork(runId));
  }

  private async settleRequestedRootFinishWork(runId: string): Promise<void> {
    try {
      const status = this.store.getRun(runId)?.status;
      if (status === 'review') { this.finish(runId); return; }
      if (status === 'running') this.move(runId, 'park');
      this.reconcileWorkerWaits(runId);
      await this.settleSuccess(runId, true);
    }
    catch { console.warn('[cez] parent finish checkpoint failed; intent retained for retry'); }
  }
  reconcileWorkerWaits(familyRootId?: string): void { this.familyReconciler.reconcileWorkerWaits(familyRootId); }
  reconcileAllWorkerFamilies(): void { this.familyReconciler.reconcileAllWorkerFamilies(); }

  /** Durable queue is the single hydration source for fresh, continuing and recovered runs. */
  steerWorker(runId: string, input: AgentInput): 'queued' | 'delivered' {
    const run = this.store.getRun(runId);
    if (!run || run.delegation?.role !== 'worker' || run.delegation.parentRunId !== input.parentRunId) {
      throw new DelegationPolicyError('denied_scope', 'not an owned worker');
    }
    if (this.executionBlockedByRootFinish(run)) throw new DelegationPolicyError('incompatible_state', 'parent finish is pending');
    const queue = enqueueAgentInput(run, input);
    this.store.commitAgentInputs(runId, queue);
    this.store.appendEvent(runId, { type: 'agent-input', input: queue[queue.length - 1] });
    this.flushAgentInputs(runId);
    const error = this.active.get(runId)?.agentInputError;
    if (error) throw new DelegationPolicyError('incompatible_state', error);
    return this.store.getRun(runId)?.agentInputs?.find(entry => entry.id === input.id)?.deliveredAt ? 'delivered' : 'queued';
  }

  private pendingHumanAskSeq(runId: string): number | undefined {
    return pendingAskFacts.pendingHumanAskSeq(this.store, runId);
  }

  /** An unanswered `ask.requested` with no open human wait (a row written before every ask opened
   *  one) gets an open agent wait shown as that ask. Answer delivery still reads the transcript.
   *  Cezar's own wait not shown as that ask is replaced, as the live ask does: a crash between
   *  saving the ask and replacing it leaves that wait open (review of #1437). */
  private adoptTranscriptAsk(runId: string): boolean {
    const askSeq = this.pendingHumanAskSeq(runId);
    const human = openWaits(this.store.getRun(runId) ?? {}).filter((wait): wait is HumanWaitEntry => wait.kind === 'human');
    if (askSeq === undefined || !this.store.getRun(runId) || human.some(wait => !isCezarHumanWait(wait) || wait.askSeq === askSeq)) return false;
    this.humanWaits.withdrawCezarHumanWaits(runId);
    if (openWaits(this.store.getRun(runId) ?? {}).some(wait => wait.kind === 'human')) return false;
    try {
      this.store.commitWait(runId, { id: randomUUID(), kind: 'human', source: 'agent', via: 'ask-line', registeredAt: new Date().toISOString(), phase: 'open', turnId: 'recovered', askSeq });
      return true;
    } catch (error) {
      console.warn(`[cez] human wait checkpoint failed: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  /** The human wait upgraded from a stored `hasPendingHumanAsk` (`turnId: 'legacy'`, never shown)
   *  is settled as answered when the transcript's facts are known and hold no unanswered ask: that
   *  flag was read from the transcript, so its ask was answered after the row was last saved.
   *  Unknown facts are no evidence, and the wait stays open. */
  private settleAnsweredLegacyAsk(runId: string): boolean {
    const legacy = this.store.getRun(runId)?.waits?.filter(wait => wait.kind === 'human' && wait.phase === 'open' && wait.turnId === 'legacy' && wait.askSeq === undefined) ?? [];
    // Only facts read from a non-empty transcript are evidence of the answer (review of #1437).
    const facts = this.store.knownTranscriptFacts(runId);
    if (!legacy.length || !facts || facts.bytes === 0 || facts.pendingGateSeq !== undefined) return false;
    try {
      return this.store.commitOutcome(runId, { kind: 'answered', waitIds: legacy.map(wait => wait.id) }).answered.length > 0;
    } catch (error) {
      console.warn(`[cez] human wait checkpoint failed: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  private hasPendingHumanAsk(runId: string): boolean {
    return pendingAskFacts.hasPendingHumanAsk(runId, id => this.pendingHumanAskSeq(id));
  }

  /** Accepted input may be temporarily refused while a backend HTTP ack is
   * outstanding. That is not an empty queue and must not trigger automatic DONE. `except` leaves
   * out inputs already submitted, such as an acknowledgement still in flight. */
  private hasQueuedAgentInputs(runId: string, except: readonly string[] = []): boolean { return this.inputDelivery.hasQueuedAgentInputs(runId, except); }

  /** #505 liveness bound: a harness that accepted input and then neither read it nor ran
   * another turn must not hold the run and its slot forever. After a quiet grace window the
   * input is resubmitted once; after a second it is left delivered but unconfirmed. */
  private armUnreadInputTimer(runId: string, state: ActiveRun): void { return this.inputDelivery.armUnreadInputTimer(runId, state); }

  // Keep both launch paths' session-event handlers unchanged until Phase 3's
  // run/session-events.ts merges them (epic hearsay-tools/cezarion#2051).
  private clearUnreadInputTimer(state: ActiveRun): void { clearUnreadInputTimer(state); }
  private clearHeldHumanInputTimer(state: ActiveRun, resetClock = true): void { clearHeldHumanInputTimer(state, resetClock); }

  /** #486: a turn-end deferred close/park only because the harness still held a human follow-up. */
  private armHeldHumanInputTimer(runId: string, state: ActiveRun): void { return this.inputDelivery.armHeldHumanInputTimer(runId, state); }

  /** A callback from an old/replaced/disposed session carries no authority. */
  private handleAgentInputReady(runId: string, state: ActiveRun, session: AgentSession | undefined): void { return this.inputDelivery.handleAgentInputReady(runId, state, session); }

  /** Reservation is synchronous; only an acknowledged transport may checkpoint delivery. */
  private submitAgentInput(runId: string, state: ActiveRun, content: ContentBlock[], inputIds: readonly string[] = [], beforeHumanReset?: HumanAnswerBudget): boolean { return this.inputDelivery.submitAgentInput(runId, state, content, inputIds, beforeHumanReset); }

  /** False leaves the durable entry untouched. The answer commits its reset before this flush,
   *  but this one synchronous flush keeps the budget decisions it made before that reset
   *  (hearsay-tools/cezarion#1906). Later acknowledgements read the restarted budget normally. */
  private flushAgentInputs(runId: string, beforeHumanReset?: HumanAnswerBudget): boolean { return this.inputDelivery.flushAgentInputs(runId, beforeHumanReset); }

  private flushDeferred(runId: string): void { this.queuedInput.flushDeferred(runId); }

  /**
   * Deliver a user message into the run's live claude session (mid-turn or
   * while `waiting`). Returns false when there is no open session — the GUI
   * then offers "Continue" instead.
   */
  sendMessage(runId: string, content: PastedContent[], messageId?: string): boolean {
    const delivered = this.deliverMessage(runId, content, true, messageId);
    if (delivered) {
      const state = this.active.get(runId);
      if (state) state.monitoringCapNoted = undefined;
    }
    return delivered;
  }

  /** Only an explicit option from the permission card may answer a native grant. */
  respondPermission(runId: string, requestId: string, optionId: string): boolean {
    const state = this.active.get(runId);
    const run = this.store.getRun(runId);
    if (this.disposed || !state?.session?.open || state.cancelled || state.finishRequested || !this.canProceedWithRun(runId, run) ||
        !state.pendingPermissions?.has(requestId)) return false;
    return state.session.respondPermission?.(requestId, optionId) ?? false;
  }

  /** Restore active lifecycle/accounting when either Cezar or the backend
   * resumes work in a parked session. */
  private resumeParkedRun(runId: string, state: ActiveRun, beforeHumanReset?: HumanAnswerBudget): void { return this.inputDelivery.resumeParkedRun(runId, state, beforeHumanReset); }

  /** Shared live-session delivery. Synthetic scheduler prompts reuse lifecycle
   * bookkeeping without masquerading as user-authored transcript messages. */
  private deliverMessage(runId: string, content: PastedContent[], userAuthored: boolean, messageId?: string): boolean { return this.inputDelivery.deliverMessage(runId, content, userAuthored, messageId); }

  /** Close the open session gracefully — the run then completes as `done`
   *  (or rests at `review` when the worktree holds changes, spec 009).
   *  On a run already resting at `review` (no session — the engine loop is
   *  over), "Finish" is the third review exit: accept the changes without a
   *  PR and flip straight to `done`. */
  finish(runId: string): boolean {
    const decision = this.finishDecision(runId);
    if ('reason' in decision) {
      if (decision.warn) this.store.appendEvent(runId, { type: 'note', tone: 'warning', message: decision.reason });
      return false;
    }
    const state = this.active.get(runId);
    if (decision.action === 'session' && state?.session) {
      try {
        this.wakeAdmission.cancelOpenWaits(runId);
        this.acceptRootRequestFinish(runId);
      } catch { return false; }
      this.closeQuestionOnFinish(runId);
      state.finishRequested = true;
      clearIdleTimer(state);
      this.store.appendEvent(runId, { type: 'lifecycle', message: 'session closed by user' });
      state.session.end();
      return true;
    }
    const run = this.store.getRun(runId);
    if (decision.action === 'root') {
      try { this.store.commitRootFinishIntent(runId); this.reconcileWorkerWaits(runId); }
      catch { return false; }
      void this.settleRequestedRootFinish(runId);
      return true;
    }
    if (decision.action === 'waiting' && run) {
      this.closeQuestionOnFinish(runId);
      const finishedAt = new Date().toISOString();
      for (const step of run.steps) {
        if (step.status === 'waiting' || step.status === 'running') {
          this.store.updateStep(runId, step.id, { status: 'done', finishedAt });
        }
      }
      void this.settleSuccess(runId);
      return true;
    }
    if (decision.action === 'review') {
      try { this.acceptRootRequestFinish(runId); } catch { return false; }
      this.closeQuestionOnFinish(runId);
      this.move(runId, 'accept-review', settledRootFinishPatch(this.store, runId));
      this.store.appendEvent(runId, { type: 'lifecycle', message: 'review accepted — finished without a PR' });
      return true;
    }
    return false;
  }

  /** Persist the human's authority before settling obligations or closing a live session. */
  private acceptRootRequestFinish(runId: string): void {
    const run = this.store.getRun(runId);
    if (run?.delegation?.role !== 'root' || !openCompletionRequests(this.store, runId).sent.length) return;
    this.store.commitDelegation([{ id: runId, delegation: { ...run.delegation, finishRequestedAt: new Date().toISOString() } }]);
    this.reconcileWorkerWaits(runId);
  }

  /** Finish ends the task, so an unanswered question is closed rather than left answerable on a
   * finished run (hearsay-tools/cezarion#1260). A root never gets here with one pending: its Finish
   * is refused until the question is answered. Stop keeps the question, which a human may still
   * answer to reopen the run (#505). */
  private closeQuestionOnFinish(runId: string): void {
    const askSeq = this.pendingHumanAskSeq(runId);
    if (askSeq !== undefined) this.store.appendEvent(runId, { type: 'human-ask-closed', askSeq, reason: 'finish' });
  }

  private waitingBeforeFinalWorkflowStep(run: RunRecord): boolean {
    return workflowPosition.waitingBeforeFinalWorkflowStep(run, isSyntheticContinuation, record => this.waitingWorkflowStepIndex(record));
  }

  private waitingWorkflowStepIndex(run: RunRecord): number {
    return workflowPosition.waitingWorkflowStepIndex(run, isSyntheticContinuation, record => this.ciWorkflowResumeStepIndex(record));
  }

  private ciWorkflowResumeStepIndex(run: RunRecord): number {
    return workflowPosition.ciWorkflowResumeStepIndex(run);
  }

  private resumableSessionId(runId: string, sessionStep: StepState | undefined): string | undefined {
    return workflowPosition.resumableSessionId(this.store, runId, sessionStep);
  }

  /**
   * "Continue" (spec 003): reopen a finished run's claude session in-process
   * (`claude --resume <sessionId>`) as a new synthetic step. The session then
   * behaves exactly like an interactive step: `waiting` after each turn,
   * messages via sendMessage, closed by finish/idle/cancel.
   */
  continueRun(
    runId: string,
    opts: ContinueRunOptions = {},
    /** Restart recovery may discover several interrupted tasks at once. Those
     *  continuations are queued; an explicit user Continue remains immediate. */
    deferForCapacity = false,
    conversation?: Parameters<RunStore['commitWorkerContinuation']>[3],
  ): { ok: boolean; error?: string } {
    // Another process's run (#779, plan step 3) is its owner's to continue.
    const refusal = this.store.writeRefusal(runId);
    if (refusal) return { ok: false, error: refusal };
    // A finished run is loaded and held for the whole admission (#779): every read below sees
    // the record its own writes change, exactly as for a live run. Admission makes it live
    // (queued or running) or refuses it; either way the `continue` pin ends here.
    // The check above is a moment: another process may claim the run before the hold lands
    // (PR #851 review). Holding it is what claims it, so a failed hold refuses the Continue.
    if (!this.store.pin(runId, 'continue')) {
      return { ok: false, error: this.store.getRun(runId) ? this.store.writeRefusal(runId) ?? RUN_IN_USE_ELSEWHERE : 'not found' };
    }
    try {
      return this.continuationAcceptance.admitContinuation(runId, opts, deferForCapacity, conversation);
    } finally {
      this.store.unpin(runId, 'continue');
    }
  }

  private failCrashedContinuation(runId: string, err: unknown): void { return this.continuationAcceptance.failCrashedContinuation(runId, err); }

  private async runContinuation(
    runId: string,
    stepId: string,
    sessionId: string | undefined,
    backend: RunnerId,
    prompt: string,
    /** Attachments pasted into the follow-up composer — delivered with the
     *  reopened session's opening message, exactly like a live-session
     *  message's attachments. */
    images: PastedContent[] = [],
    /** Queued-message screenshots were persisted when they were enqueued and
     *  reconstructed at dequeue. Keep them separate from fresh `images` so
     *  opening a recovered continuation does not persist duplicate files. */
    persistedImages: ContentBlock[] = [],
    persistedAttachments: PersistedAttachment[] = [],
  ): Promise<void> {
    // Continuation runs in the task's worktree when it still exists (spec
    // 006) — the resumed session sees exactly what the original run left.
    // Retention (#483) may have reclaimed this run's worktree directory while
    // keeping its branch and worktreePath. Re-materialize it on resume and clear
    // the stamp so the session regains its isolated tree and the run is eligible
    // for retention again — otherwise it keeps a dir on disk while staying
    // invisible to the enforcer forever. Ordinary runs retain their best-effort
    // repoRoot fallback; owned workers must never adopt/recreate an unverified resource.
    if (this.workerExecutionStopped(runId)) { this.line.unmarkStarting(runId); return; }
    if (this.holdContinuationForRootFinish(runId, { stepId, sessionId, backend, prompt, images, lineJoinedAt: Date.now() })) return;
    workerIdentity(this.store, this.repoRoot, runId);
    const record = this.store.getRun(runId);
    const workspace = await this.continuationSession.continuationWorkspace(runId, stepId, record);
    if (!workspace) return;
    if (this.continuationSession.settleStoppedContinuation(runId)) return;
    // Continue and restart recovery build their own ActiveRun: hydrate the durable mode here.
    const state = createActiveRun({
      cwd: workspace.cwd,
      pendingHumanAsk: this.hasPendingHumanAsk(runId),
      autonomous: record?.autonomous === true,
    });
    this.activate(runId, state);
    this.line.unmarkStarting(runId);
    return this.continuationSession.launchContinuation(runId, stepId, sessionId, backend, prompt,
      images, persistedImages, persistedAttachments, state, record, workspace.rematerialized);
  }

  /** Latch an agent input error, then interrupt: a transport failure the interrupt causes is secondary. */
  private latchAgentInputError(runId: string, state: ActiveRun, session: AgentSession, message: string): void {
    state.agentInputError = message;
    try { session.interrupt(); } finally {
      try { this.store.appendEvent(runId, { type: 'error', message }); }
      catch { console.error(`[cez] ${message}`); }
    }
  }

  // ---- execution -----------------------------------------------------------

  private async execute(runId: string, workflow: WorkflowDef, input: StartRunInput, startAt = 0): Promise<void> {
    if (this.workerExecutionStopped(runId)) { this.line.unmarkStarting(runId); return; }
    workerIdentity(this.store, this.repoRoot, runId);
    const state = createActiveRun({
      cwd: this.repoRoot,
      pendingHumanAsk: this.hasPendingHumanAsk(runId),
      autonomous: input.autonomous === true,
    });
    this.activate(runId, state);
    this.line.unmarkStarting(runId);
    const emit = (event: { type: string; stepId?: string; [k: string]: unknown }) =>
      this.store.appendEvent(runId, event);
    const execution: Execution = { runId, workflow, input, startAt, state, emit };

    const launch = await this.stepLoop.startExecution(execution);
    if (!launch) return;
    if (!(await this.stepLoop.prepareExecutionWorktree(execution, launch))) return;

    if (state.cwd === this.repoRoot) {
      if (repositoryRootLockDisabled()) {
        emit({
          type: 'note',
          message: REPOSITORY_ROOT_LOCK_DISABLED_NOTE,
        });
      } else {
        emit({
          type: 'note',
          message: 'waiting for exclusive access to the repository working tree',
        });
        // A cancel during the wait leaves the lease ungranted; the step loop
        // below breaks on `cancelled` before touching the tree and settles the
        // run through the usual path.
        await this.acquireRepoRoot(runId, state);
      }
      // THE window that matters for an in-place run. Waiting for the exclusive tree can take
      // minutes, and a run parked on that lease holds no slot (#347) — so the queue keeps
      // advancing behind it and the dequeue-time gate is long past. Measured with five in-place
      // tasks and `maxParallel: 2`: four of them started. Re-ask here, where the very next thing
      // is a spawn, and hand the run back to the queue if the account closed meanwhile. This
      // check also covers the explicit lock-bypass path, where the account may close while the
      // run is preparing its first step.
      if (this.stepLoop.requeueWhileHeld(runId, workflow, input, launch.taskBackend, state, startAt)) return;
    }

    // Handoff journal (spec 007) — seeded after the worktree exists so the
    // header can name the branch. Idempotent: an existing file stays as-is.
    const seeded = this.store.getRun(runId);
    if (seeded) seedHandoffFile(this.dataDir, seeded);
    // Worktree setup (#917): before the first step, so the agent starts in a prepared tree. Its
    // note rides the first agent step's opening message only, like the task's attachments.
    const setupNote = await this.stepLoop.prepareWorktree(runId, state, launch.config.worktreeSetup, emit, 'start');

    // Every entry path loads the registry — `runContinuation` loads its own, and the one that
    // skipped this leaked raw `/skill` text to the backend (open-mercato/cezar#811). A failed discovery fails the run.
    await this.loadRunSkills(state, 'throw');
    const loop = await this.stepLoop.runWorkflowSteps(execution, launch, { ...openingInputs(this.store, this.dataDir, execution), setupNote });
    if (loop) await this.runSettlement.settleExecution(runId, state, loop);
  }

  private settleFailedRun(runId: string, runError: string, deliveryCapped: boolean): void { this.runSettlement.settleFailedRun(runId, runError, deliveryCapped); }

  private sessionEventHost(): import('./run/session-events.ts').SessionEventHost {
    return {
      disposedSessionEvent: (...args) => sessionEvents.disposedSessionEvent(this.context, this.sessionHelperHost, ...args),
      handleReceiptEvent: (...args) => inputReceipts.handleReceiptEvent(this.context, this.inputReceiptHost, this.inputReceiptSteps, ...args),
      recordSessionFault: (...args) => sessionEvents.recordSessionFault(this.context, this.sessionHelperHost, ...args),
      markTurnBoundary: (...args) => sessionEvents.markTurnBoundary(this.context, this.sessionHelperHost, ...args),
      trackTurnEnd: (...args) => this.turnBookkeeper.trackTurnEnd(...args),
      endTurn: (...args) => this.turnSettler.endTurn(...args),
    };
  }

  private launchPreambleHost(): import('./run/session-events.ts').LaunchPreambleHost {
    return {
      provisionSession: (...args) => this.provisionSession(...args),
      agentWebhooksPart: () => this.agentWebhooksPart(),
      provisionCiSession: (...args) => this.provisionCiSession(...args),
      launchStale: (...args) => sessionEvents.launchStale(this.context, this.sessionHelperHost, ...args),
    };
  }

  private makeUiSink(runId: string, stepId: string): UiEventSink { return sessionEvents.makeUiSink(this.context, this.sessionHelperHost, runId, stepId); }

  private handleRunnerUiEvent(runId: string, state: ActiveRun, sink: UiEventSink, event: UiEvent): void { return sessionEvents.handleRunnerUiEvent(this.context, this.sessionHelperHost, runId, state, sink, event); }

  /** Persist the invocation checkpoint before launching a runner. A throw or
   * process exit before `turn.started` therefore leaves a durable mismatch. */
  private beginUsageInvocation(runId: string, state: ActiveRun, stepId: string): void {
    beginUsageInvocation(this.store, runId, state, stepId);
  }

  private recordUsagePeaks(runId: string): void {
    recordUsagePeaks(this.store, { isDisposedDelegatedRun: id => this.isDisposedDelegatedRun(id) }, runId);
  }

  /**
   * Diff-first review gate (spec 009), shared by `execute` and
   * `runContinuation`: a *successful* run whose worktree holds changes rests
   * at `review` instead of `done` — the user inspects the diff first, then
   * sends feedback back, opens a draft PR, or just finishes. Failed/cancelled
   * runs never enter review; no worktree or an empty diff means plain `done`.
   *
   * The gate is opt-in (#489): the review park happens only when it is enabled
   * (`reviewGateEnabled` — config toggle over the `CEZ_REVIEW_GATE` env, default
   * OFF) AND the run is not autonomous. Autonomous runs — and runs with the gate
   * off — settle straight to `done`, leaving the diff in the worktree untouched.
   */
  private async settleSuccess(runId: string, durableRootFinish = false, keepStepId?: string): Promise<void> { return this.runSettlement.settleSuccess(runId, durableRootFinish, keepStepId); }

  private persistPastedAttachments(runId: string, content: readonly PastedContent[]): PersistedAttachment[] {
    return this.attachments.persistPastedAttachments(runId, content);
  }

  private persistAttachment(runId: string, mediaType: string, data: string, namePrefix: string = 'screenshot'): PersistedAttachment | null {
    return this.attachments.persistAttachment(runId, mediaType, data, namePrefix);
  }

  /** The outcome a settled turn reached, for the parity cells that prove which path ran
   *  (hearsay-tools/cezarion#1809, which removed the handoff heartbeat line that recorded it). No
   *  outcome for the completion gate's refusal outside a turn end, nor while input readiness waits. */
  private settledTurnOutcome(runId: string, entry: 'turn-end' | 'ack' | 'ready' | 'gate' | 'reply-timer',
    outcome: TurnEndOutcome): TurnEndOutcome | undefined {
    return entry === 'gate' || (entry === 'ready' && outcome.kind === 'readiness') ? undefined : outcome;
  }

  private retireUnreadParentQuestion(parentId: string, requestId: string): void { return this.workerQuestions.retireUnreadParentQuestion(parentId, requestId); }

  /** Every run status `run.ts` writes comes from the run state table (hearsay-tools/cezarion#1804). */
  private move(runId: string, exit: RunExitId, patch: Omit<Parameters<RunStore['updateRun']>[1], 'status'> = {}): RunRecord | undefined {
    const status = transition(exit, () => this.store.getRun(runId));
    return this.store.updateRun(runId, { ...patch, ...(status === 'failed' ? settledRootFinishPatch(this.store, runId) : {}), status });
  }

  autosaveCleanupBlocker(runId: string): string | undefined {
    return this.worktreeAutosave.autosaveCleanupBlocker(runId);
  }

  private async saveWorktree(runId: string, state: ActiveRun, reason: AutosaveReason): Promise<void> {
    return this.worktreeAutosave.saveWorktree(runId, state, reason);
  }

  private armAutosave(runId: string, state: ActiveRun): void {
    this.worktreeAutosave.armAutosave(runId, state);
  }

  private clearAutosaveTimer(state: ActiveRun): void {
    clearAutosaveTimer(state);
  }

  private async prepareWorktree(...args: Parameters<WorkflowStepLoop['prepareWorktree']>): Promise<string | undefined> {
    return this.stepLoop.prepareWorktree(...args);
  }

}
