import { RunCancel } from './run/run-cancel.ts';
import { IDLE_TIMEOUT_MS, ROUTED_QUESTION_REFUSAL, UNREAD_INPUT_GRACE_MS, NO_WAIT_NUDGE_REPLY_MS, COMPLETION_WILL_WAIT, MAX_AUTO_CONTINUES, SCHEDULE_WAKEUP_MAX_SECONDS, MAX_WAKE_DELIVERY_ATTEMPTS, WAKE_DELIVERY_CAP_NOTE, WAKE_SESSION_CLOSED_ERROR, WAITS_DISCARDED_NOTE, REFUSAL_DISCARDED_NOTE, QUEUE_WATCHDOG_MS, RESTART_CONTINUATION_PROMPT } from './run/constants.ts';
export { IDLE_TIMEOUT_MS, UNREAD_INPUT_GRACE_MS, NO_WAIT_NUDGE_REPLY_MS, COMPLETION_WILL_WAIT, MAX_AUTO_CONTINUES, MAX_WAKE_DELIVERY_ATTEMPTS, WAKE_DELIVERY_CAP_NOTE, WAKE_SESSION_CLOSED_ERROR, WAITS_DISCARDED_NOTE, REFUSAL_DISCARDED_NOTE, QUEUE_WATCHDOG_MS } from './run/constants.ts';
import { isSyntheticContinuation } from './run/workflow-position.ts';
import { repositoryRootLockDisabled } from './run/repo-root-lease.ts';
export { repositoryRootLockDisabled } from './run/repo-root-lease.ts';
import { isUntouchedCancelledRun } from './run/run-guards.ts';
export { isUntouchedCancelledRun } from './run/run-guards.ts';
import { WorkerOrphanAliveError, admissionError } from './run/worker-orphans.ts';
import type { PersistedAttachments } from './run/types.ts';
import { ContinuationSession } from './run/continuation-session.ts';
import { StepLoop as WorkflowStepLoop } from './run/step-loop.ts';
import { RunRecovery } from './run/run-recovery.ts';
import { TurnSettler } from './run/turn-settler.ts';
import { StepSession } from './run/step-session.ts';
import * as sessionEvents from './run/session-events.ts';
import { WakeAdmission } from './run/wake-admission.ts';
import { RunFinish } from './run/run-finish.ts';
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
import { RunStart } from './run/run-start.ts';
import { RunLine } from './run/run-line.ts';
import { WorktreeAutosave } from './run/worktree-autosave.ts';
import { RunSkills } from './run/run-skills.ts';
import { InboxClaims } from './run/inbox-claims.ts';
import { WorkerExecutions } from './run/worker-executions.ts';
import { TurnBookkeeper } from './run/turn-bookkeeping.ts';
import { AutomationToolsSlot, cezarToolHandlers, provisionCiSession, type ToolHost, type CiSessionHost } from './run/cezar-tools.ts';
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
import { repairFailedRootFinish, startCompletionCycle, settledRootFinishPatch } from './completion-policy.ts';
import type { ContinueRunOptions } from './continuation-admission.ts';
import { workerEvidenceRunIds } from '../runs/worker-execution.ts';
import { type CezarDoneAnswer, type CezarDoneRequest, type CezarWaitRequestInput, type PeerWaitEntry, type PrWaitEntry, type ProcessWaitEntry, type HumanWaitEntry, type TimerWaitEntry, type Wait, type WaitVia, type WorkerWaitEntry, computeWaitingOn, type DeadlinedWorkerWaitEntry } from '@open-mercato/cezar-contract/waits';
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
export { agentDirectories, composeSystemPrompt, expandRegistrySlashSkill, expandRegistrySlashSkillText, leadingSlashSkillName, resolveExtraSystemPrompt, skillSystemPrompt } from './run/prompts.ts';
export { stepLabel } from './run/steps.ts';
export { makeRunTitle } from '../runs/run-title.ts';
import { clearUnreadInputTimer, clearHeldHumanInputTimer, clearIdleTimer, clearAutosaveTimer } from './run/input-timers.ts';
import * as stepDecisions from './run/step-decisions.ts';
import * as pendingAskFacts from './run/pending-ask-facts.ts';
import * as workflowPosition from './run/workflow-position.ts';
import { RUN_EXITS, transition, type RunExitId } from './run-states.ts';
import { deriveAccountHolds } from './run-scheduling.ts';
export { runAccountKey } from './run-scheduling.ts';
import { holdsOwedResults, isCezarHumanWait, openWaits, resolvedWaits } from './waits.ts';
import { runsAwaitingPeer } from './wait-scope.ts';
import { type PreviewHostLike } from '../preview/registration.ts';
import { acquireCiResources } from '../ci-wait/resources.ts';
import type { CiWatcherSupervisor } from '../ci-wait/supervisor.ts';
import type { CezarToolHandlers } from '../ci-wait/controller.ts';
import { workerIdentity, continuationDefStep, WorkerIdentityError, type WorkerAccountBinding } from '../delegation/execution-identity.ts';
import type { DelegationProvisioner } from '../delegation/provision.ts';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { AskRequest } from '../core/ask.ts';
import { type AgentSession } from '../core/claude-cli-runner.ts';
import { onUsage, replaceRunProcess, type ProcessUsage } from '../core/process-usage.ts';
import { WorkerScratchCleanup } from '../delegation/scratch-cleanup.ts';
import { type CwdSource } from '../delegation/process-liveness.ts';
import { parseUsageLimit } from '../core/usage-limit.ts';
import type { RunnerId } from '../core/agent-runner.ts';
import {
  handoffPath,
  seedHandoffFile,
} from '../handoff.ts';
// Contract VALUES, like `workspaceUiStateSchema` in workspace/migrations.ts: the attachment
// vocabulary the routes validate with is the same one the engine stores and re-reads by, so the
// wire and the disk can never disagree about what counts as an image (#950).
import {
  type AgentInput,
  type WorkerStopResult,
  type WorkerWait,
  type WorkerWaitRequest,
} from '@open-mercato/cezar-contract/delegation';
import type { ConversationState, RunEvent } from '@open-mercato/cezar-contract';
import {
  type RequestWaitRequest,
} from '@open-mercato/cezar-contract/conversations';
import { contentBlocksOf, toPastedContent, type FileBlock, type PastedContent, type PersistedAttachment } from './pasted-content.ts';
export { contentBlocksOf, highestImageSeq, mediaTypeFor, pastedAttachmentsNote, pastedAttachmentsText, toPastedContent, type FileBlock, type PastedContent, type PersistedAttachment } from './pasted-content.ts';
import type { ContentBlock, ToolGrant } from '../core/agent-runner.ts';
import { readProjectUiState } from '../ui-state.ts';
import { type Skill } from '../skills.ts';
import { readAgentModelSettings } from '../agent-config/models.ts';
import { resolveWorktreeRetention } from '../config.ts';
import { getRepoInfo } from '../server/git.ts';
import { DelegationPolicyError } from '../delegation/policy.ts';
import { projectConversationEvents, settledRunFamilies } from '../delegation/conversations.ts';
import * as queuedRevival from './run/queued-revival.ts';
import type { RunOutcome } from '../runs/outcome-commit.ts';
import { RUN_IN_USE_ELSEWHERE, type CommitSource, type QueuedMessage, type RunRecord, type RunStore, type StepState } from '../runs/store.ts';
import { reclaimWorktrees } from '../runs/retention.ts';
import {
  removeAgentTmpDir,
} from '../runs/agent-tmpdir.ts';
import { resolveProfileEnvForRoot } from '../workspace/agent-profiles.ts';
import { WorkspaceSemaphore, type AccountHolds } from '../workspace/semaphore.ts';
import {
  type WorkflowDef, type WorkflowStepDef,
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
  private readonly runStart: RunStart;
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
    unansweredQuestions: id => this.workerQuestions.unansweredQuestions(id),
  };
  private readonly queuedRevivalHost: queuedRevival.QueuedRevivalHost;
  private readonly humanWaits: HumanWaits;
  private readonly turnNudges: TurnNudges;
  private readonly runSettlement: RunSettlement;
  private readonly runFinish: RunFinish;
  private readonly runCancel: RunCancel;
  private readonly waitRegistry: WaitRegistry;
  private readonly waitWatches: WaitWatches;
  private readonly familyReconciler: FamilyReconciler;
  private readonly workerQuestions: WorkerQuestions;
  private readonly inputReceiptSteps: inputReceipts.InputReceiptSteps = {
    clearUnread: state => clearUnreadInputTimer(state), clearHeld: state => clearHeldHumanInputTimer(state),
    noteActivity: (id, state, event) => this.turnNudges.noteNoWaitNudgeContent(id, state, event),
    persistAttachment: (id, mediaType, data) => this.attachments.persistAttachment(id, mediaType, data),
    ready: (id, state, session) => this.inputDelivery.handleAgentInputReady(id, state, session),
    pid: (id, pid) => { replaceRunProcess(id, pid); this.workerExecutions.recordWorkerProcess(id, pid); },
    ui: (id, state, sink, event) => sessionEvents.handleRunnerUiEvent(this.context, this.sessionHelperHost, id, state, sink, event),
    flushDeferred: id => this.queuedInput.flushDeferred(id), recordProcess: (id, pid) => this.workerExecutions.recordWorkerProcess(id, pid),
  };
  private readonly inputReceiptHost: inputReceipts.InputReceiptsHost = {
    reconcileWorkerWaits: () => this.reconcileWorkerWaits(),
    flushAgentInputs: id => this.inputDelivery.flushAgentInputs(id),
    isCurrentState: (id, state) => this.active.get(id) === state,
  };
  private readonly line: RunLine;
  private readonly worktreeAutosave: WorktreeAutosave;
  private readonly workerExecutions: WorkerExecutions;

  private readonly orphans: WorkerOrphans;
  settleOrphanedWorkerExecution(runId: string, opts: { admitting?: boolean; fresh?: boolean; cwds?: CwdSource } = {}): boolean { return this.orphans.settleOrphanedWorkerExecution(runId, opts); }
  takeWorkerTerminationBlocker(runId: string): { blocker: WorkerTerminationBlocker; changed: boolean } | undefined { return this.orphans.takeWorkerTerminationBlocker(runId); }

  requestWorkerStop(runId: string): WorkerStopResult { return this.runCancel.requestWorkerStop(runId); }

  async awaitRunTermination(runId: string, timeoutMs: number, opts: { reapOrphans?: boolean } = {}): Promise<boolean> {
    const terminated = await this.workerExecutions.proveRunTermination(runId, timeoutMs, opts);
    if (terminated && opts.reapOrphans && !this.disposed) await this.orphans.terminateFinishedWorkerGroups(runId, timeoutMs);
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
  private disposed = false;


  private readonly onDelegationRun = (run: RunRecord, source?: CommitSource): void => {
    // Delegation metadata checkpoints do not change task status.
    // A republish changed nothing durable: there is nothing to reap, cancel or reconcile.
    if (source === 'live-release') return;
    if (!this.disposed && source === undefined) this.reapTerminalScratch(run.id);
    if (!this.disposed && !['queued', 'running', 'waiting'].includes(run.status) && !holdsOwedResults(run)) this.wakeAdmission.cancelOpenWaits(run.id);
    if (run.delegation && !['queued', 'running', 'waiting'].includes(run.status)) this.active.get(run.id)?.revokeDelegation?.();
    // Cleanup checkpoints emit terminal records too. With delegation disabled,
    // these observations must not replay the project's conversation histories.
    if (this.disposed || this.recovery.recoveringRun(run) || (source === 'delegation-checkpoint' && process.env.CEZ_DELEGATION !== '1')) return;
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
  private readonly queuedInput: QueuedInput;
  private readonly autoResumeScheduler: AutoResumeScheduler;
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
    /** Quiet window before unread input is resubmitted or left unconfirmed (#505). */
    const unreadInputGraceMs = options.unreadInputGraceMs ?? UNREAD_INPUT_GRACE_MS;
    this.semaphore = options.semaphore ?? new WorkspaceSemaphore();
    this.context = { store, repoRoot, dataDir: this.dataDir, semaphore: this.semaphore, disposed: () => this.disposed, work: options.work ?? new TrackedWork() };
    this.retries = new WakeRetries(this.context, {
      owesWake: run => this.wakeAdmission.owesWake(run), queueWaitWake: id => this.wakeAdmission.queueWaitWake(id),
      retryWaitAdmission: id => this.retries.retryWaitAdmission(id),
    });
    this.queuedRevivalHost = {
      move: (id, exit, patch) => this.move(id, exit, patch), isActive: id => this.isActive(id),
      workerExecutionStopped: id => this.workerExecutionStopped(id), ownedJob: run => this.runStart.ownedJob(run),
      resumableSessionId: (id, step) => this.resumableSessionId(id, step), workerStep: (id, step) => launchContext.workerStep(this.context, id, step),
      toQueuedMessage: (id, content) => this.queuedInput.toQueuedMessage(id, content), hydrateQueuedInput: (id, input) => this.queuedInput.hydrateQueuedInput(id, input),
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
      recovering: () => this.recovery.recovering, recoveringRun: run => this.recovery.recoveringRun(run),
      reconcileAutoResumes: () => this.autoResumeScheduler.reconcileAutoResumes(), cancel: id => this.cancel(id),
      move: (id, patch) => this.move(id, 'fail-start', patch), beginWorkerExecution: id => this.workerExecutions.beginWorkerExecution(id),
      admissionError: (error, fallback) => admissionError(error, fallback),
      admitQueuedWaitWake: id => this.wakeAdmission.admitQueuedWaitWake(id),
      launchQueuedRun: (id, job, continuation) => this.runStart.launchQueuedRun(id, job, continuation),
      reviveQueuedRun: (run, reason) => this.reviveQueuedRun(run, reason), pump: () => this.line.pump(),
      busySlots: () => this.line.busySlots(),
    });
    this.workerQuestions = new WorkerQuestions(this.context, {
      active: id => this.active.get(id), deliverConversationInput: id => this.deliverConversationInput(id),
      chargeAutomaticWake: id => this.wakeAdmission.chargeAutomaticWake(id), hasQueuedAgentInputs: id => this.inputDelivery.hasQueuedAgentInputs(id),
      providerOwnsInboxInput: (id, inputId) => this.inboxClaims.providerOwnsInboxInput(id, inputId), reconcileWorkerWaits: id => this.reconcileWorkerWaits(id),
      openHumanAlias: (id, state, via, card) => this.humanWaits.openHumanAlias(id, state, via, card), prepareHumanAsk: state => this.humanWaits.prepareHumanAsk(state),
      markHumanWaitSurfaced: (id, wait, card) => this.humanWaits.markHumanWaitSurfaced(id, wait, card), withdrawCezarHumanWaits: id => this.humanWaits.withdrawCezarHumanWaits(id),
      routeWorkerQuestion: id => this.workerQuestions.routeWorkerQuestion(id), noticeParkedWorker: id => this.workerQuestions.noticeParkedWorker(id),
      retireUnreadParentQuestion: (id, request) => this.workerQuestions.retireUnreadParentQuestion(id, request),
      deleteUnreadInput: (id, input) => { this.active.get(id)?.unreadInputIds?.delete(input); },
      updatePendingHumanAsk: (id, value) => { const state = this.active.get(id); if (state) state.pendingHumanAsk = value; },
    }, MAX_AUTO_CONTINUES);
    this.familyReconciler = new FamilyReconciler(this.context, {
      active: id => this.active.get(id), isActive: id => this.isActive(id), recoveringRun: run => this.recovery.recoveringRun(run),
      cancel: id => this.cancel(id), armWait: (id, wait) => this.waitWatches.armWait(id, wait),
      armWorkerDeadline: (id, wait, delay) => this.waitWatches.armWorkerDeadline(id, wait, delay), disarmWait: id => this.disarmWait(id),
      resolveWait: (id, waitId, result, observed) => this.waitRegistry.resolveWait(id, waitId, result, observed),
      retireSettledQuestions: id => this.workerQuestions.retireSettledQuestions(id), fallbackRoutedQuestions: (id, reason) => this.workerQuestions.fallbackRoutedQuestions(id, reason),
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
      reconcileWorkerWaits: family => this.reconcileWorkerWaits(family), noticeParkedWorkers: id => this.workerQuestions.noticeParkedWorkers(id),
      canProceedWithRun: (id, run) => this.canProceedWithRun(id, run),
      exitFileRoots: (id, run) => this.waitWatches.exitFileRoots(id, run), disarmWait: id => this.disarmWait(id),
      settleWait: (id, waitId, result) => this.waitWatches.settleWait(id, waitId, result),
      withdrawCezarHumanWaits: id => this.humanWaits.withdrawCezarHumanWaits(id), armWait: (id, wait) => this.waitWatches.armWait(id, wait),
      parkOnWaits: (id, state) => this.wakeAdmission.parkOnWaits(id, state), cancelAutomaticAtCap: (id, waits) => this.wakeAdmission.cancelAutomaticAtCap(id, waits),
      reparkWithoutWaits: (id, state) => this.wakeAdmission.reparkWithoutWaits(id, state), waitOnUserWithoutSession: id => this.wakeAdmission.waitOnUserWithoutSession(id),
      queueWaitWake: id => this.wakeAdmission.queueWaitWake(id), retryWaitAdmission: id => this.retries.retryWaitAdmission(id),
    }, MAX_AUTO_CONTINUES);
    this.humanWaits = new HumanWaits(this.context, { routeWorkerQuestion: id => this.workerQuestions.routeWorkerQuestion(id) }, MAX_AUTO_CONTINUES);
    this.sessionHelperHost = {
      active: this.active, line: this.line, humanWaits: this.humanWaits, inputReceiptHost: this.inputReceiptHost,
      move: (...args) => this.move(...args),
      workerExecutionStopped: id => this.workerExecutionStopped(id),
      executionBlockedByRootFinish: run => this.executionBlockedByRootFinish(run),
      agentEnvForStep: (...args) => this.agentEnvForStep(...args),
      sessionContextFor: (...args) => launchContext.sessionContextFor(this.context, ...args),
      automationsPart: () => launchContext.automationsPart(this.cockpit),
      flushAgentInputs: id => this.inputDelivery.flushAgentInputs(id),
      resumeParkedRun: (...args) => this.inputDelivery.resumeParkedRun(...args),
      noteNoWaitNudgeContent: (...args) => this.turnNudges.noteNoWaitNudgeContent(...args),
      parkedOnWorkers: id => this.wakeAdmission.parkedOnWorkers(id),
      releaseSlot: () => this.line.releaseSlot(),
      routeWorkerQuestion: id => this.workerQuestions.routeWorkerQuestion(id),
    };
    this.turnNudges = new TurnNudges(this.context, this.humanWaits, this.line, this.completionGateHost, {
      active: this.active, move: (id, exit, patch) => this.move(id, exit, patch),
      workerExecutionStopped: id => this.workerExecutionStopped(id), executionBlockedByRootFinish: run => this.executionBlockedByRootFinish(run),
      countAutomaticWakes: id => this.wakeAdmission.automaticWakes(id), hasQueuedAgentInputs: id => this.inputDelivery.hasQueuedAgentInputs(id),
      submitAgentInput: (id, state, content) => this.inputDelivery.submitAgentInput(id, state, content), resumeParkedRun: (id, state) => this.inputDelivery.resumeParkedRun(id, state),
      chargeAutomaticWake: id => this.wakeAdmission.chargeAutomaticWake(id), retryWaitAdmission: id => this.retries.retryWaitAdmission(id), armIdleTimer: (id, state) => this.turnSettler.armIdleTimer(id, state),
      openTurnEndHumanWait: (id, state, step, via, note) => this.turnSettler.openTurnEndHumanWait(id, state, step, via, note),
      settledTurnOutcome: (id, entry, outcome) => this.settledTurnOutcome(id, entry, outcome), queueWaitWake: id => this.wakeAdmission.queueWaitWake(id),
    }, MAX_AUTO_CONTINUES, COMPLETION_WILL_WAIT, options.noWaitNudgeReplyMs ?? NO_WAIT_NUDGE_REPLY_MS);
    this.worktreeAutosave = new WorktreeAutosave(this.context,
      { holdForMaintenance: ids => this.claims.holdForMaintenance(ids),
        reapTerminalScratch: id => this.reapTerminalScratch(id), releaseSlot: () => this.line.releaseSlot(),
        saveWorktree: (id, state, reason) => this.worktreeAutosave.saveWorktree(id, state, reason),
        trackTurn: (id, task) => this.workerExecutions.trackTurn(id, task) },
    );
    this.orphans = new WorkerOrphans(this.context,
      { holds: (id, admitting) => this.workerExecutions.has(id) || this.active.has(id) || this.line.hasStarting(id) || (!admitting && this.line.hasQueued(id)),
        reapTerminalScratch: id => this.reapTerminalScratch(id),
        settleOrphanedWorkerExecution: (id, opts) => this.settleOrphanedWorkerExecution(id, opts) },
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
        holdForMaintenance: ids => this.claims.holdForMaintenance(ids) },
    );
    this.attachments = new AttachmentWriter(this.context,
      { persistAttachment: (id, mediaType, data, prefix) => this.attachments.persistAttachment(id, mediaType, data, prefix) },
    );
    this.queuedInput = new QueuedInput(this.context,
      { hasJob: id => this.line.hasJob(id), hasContinuation: id => this.line.hasContinuation(id), job: id => this.line.job(id),
        canProceedWithRun: (id, run): run is RunRecord => this.canProceedWithRun(id, run),
        activeGet: id => this.active.get(id), startingHas: id => this.line.hasStarting(id),
        persistPastedAttachments: (id, content) => this.attachments.persistPastedAttachments(id, content),
        toQueuedMessage: (id, content) => this.queuedInput.toQueuedMessage(id, content),
        sendMessage: (id, content, messageId) => this.sendMessage(id, content, messageId) },
    );
    this.inboxClaims = new InboxClaims(this.context,
      { activeGet: id => this.active.get(id),
        executionBlockedByRootFinish: run => this.executionBlockedByRootFinish(run),
        workerExecutionStopped: id => this.workerExecutionStopped(id),
        reconcileWorkerWaits: () => this.reconcileWorkerWaits(), retireEmptyWake: id => this.wakeAdmission.retireEmptyWake(id),
        deliverConversationInput: id => this.deliverConversationInput(id),
        settleIdleBoundary: (id, state, session) => this.inputDelivery.settleIdleBoundary(id, state, session),
        releaseSlot: () => this.line.releaseSlot(), providerOwnsInboxInput: (id, inputId) => this.inboxClaims.providerOwnsInboxInput(id, inputId),
        canClaimInboxInput: (id, inputId) => this.canClaimInboxInput(id, inputId),
        armInboxClaimExpiry: id => this.inboxClaims.armInboxClaimExpiry(id) },
    );
    this.repoRootLease = new RepoRootLease(this.context,
      { park: id => { this.line.park(id); }, unpark: id => { this.line.unpark(id); },
        releaseSlot: () => this.line.releaseSlot() },
    );
    this.turnBookkeeper = new TurnBookkeeper(this.context,
      { isDisposedDelegatedRun: id => isDisposedDelegatedRun(this.store, () => this.disposed, id), discoverSkills: () => this.runSkills.discoverSkills(),
        reviveWorkflow: run => queuedRevival.reviveWorkflow(this.context, this.queuedRevivalHost, run), trackTurn: (id, task) => this.workerExecutions.trackTurn(id, task) },
    );
    this.runSkills = new RunSkills(this.context,
      { builtinSkills: () => this.builtinSkills(), workerExecutionStopped: id => this.workerExecutionStopped(id),
        isCurrentState: (id, state) => this.active.get(id) === state, flushAgentInputs: id => this.inputDelivery.flushAgentInputs(id) },
    );
    this.stepSession = new StepSession(this.context, {
      workerExecutionStopped: id => this.workerExecutionStopped(id),
      executionBlockedByRootFinish: run => this.executionBlockedByRootFinish(run),
      trackWorkerSessionResult: (...args) => this.workerExecutions.trackWorkerSessionResult(...args),
      workerStep: (...args) => launchContext.workerStep(this.context, ...args),
      beginUsageInvocation: (...args) => beginUsageInvocation(this.store, ...args),
      recordUsagePeaks: id => recordUsagePeaks(this.store, { isDisposedDelegatedRun: id => isDisposedDelegatedRun(this.store, () => this.disposed, id) }, id),
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
        answerRoutedQuestion: (...args) => this.inputDelivery.answerRoutedQuestion(...args),
        queueWaitWake: (...args) => this.wakeAdmission.queueWaitWake(...args),
        owesWake: (...args) => this.wakeAdmission.owesWake(...args),
        cancelOpenWaits: (...args) => this.wakeAdmission.cancelOpenWaits(...args),
        settleOrphanedWorkerExecution: (...args) => this.settleOrphanedWorkerExecution(...args),
        settleRequestedRootFinish: (...args) => this.runFinish.settleRequestedRootFinish(...args),
        settleSuccess: (...args) => this.runSettlement.settleSuccess(...args),
        reconcileWorkerWaits: (...args) => this.reconcileWorkerWaits(...args),
        pump: (...args) => this.line.pump(...args),
        recover: (...args) => this.recover(...args),
        adoptTranscriptAsk: (...args) => this.adoptTranscriptAsk(...args),
        settleAnsweredLegacyAsk: (...args) => this.settleAnsweredLegacyAsk(...args),
      }, RESTART_CONTINUATION_PROMPT);
    this.wakeAdmission = new WakeAdmission(this.context, {
      active: this.active, retries: this.retries, line: this.line, waitWatches: this.waitWatches, waitRegistry: this.waitRegistry,
      inboxClaims: this.inboxClaims, workerQuestions: this.workerQuestions, humanWaits: this.humanWaits,
      isActive: id => this.isActive(id), move: (id, exit) => this.move(id, exit),
      recoveringRun: run => this.recovery.recoveringRun(run),
      continueRun: (id, opts, defer) => this.continueRun(id, opts, defer), disarmWait: id => this.disarmWait(id),
      reconcileWorkerWaits: id => this.reconcileWorkerWaits(id), releaseSlot: () => this.line.releaseSlot(),
      parkForUser: (id, state, step) => this.turnSettler.parkForUser(id, state, step), armIdleTimer: (id, state) => this.turnSettler.armIdleTimer(id, state),
      flushAgentInputs: id => this.inputDelivery.flushAgentInputs(id), answerRoutedQuestion: (id, flush) => this.inputDelivery.answerRoutedQuestion(id, flush),
      queueWaitWake: id => this.wakeAdmission.queueWaitWake(id), retryWaitAdmission: id => this.retries.retryWaitAdmission(id),
      countAutomaticWakes: (id, budget) => this.wakeAdmission.automaticWakes(id, budget),
      workerExecutionStopped: id => this.workerExecutionStopped(id), executionBlockedByRootFinish: run => this.executionBlockedByRootFinish(run),
    }, MAX_AUTO_CONTINUES, MAX_WAKE_DELIVERY_ATTEMPTS);
    this.continuationAcceptance = new ContinuationAcceptance(this.context, {
      isActive: id => this.isActive(id), move: (id, exit, patch) => this.move(id, exit, patch),
      ownedJob: run => this.runStart.ownedJob(run), executionBlockedByRootFinish: run => this.executionBlockedByRootFinish(run),
      finishWorkerExecution: id => this.workerExecutions.finishWorkerExecution(id), clearWakeBackoff: id => this.retries.clearWakeBackoff(id),
      dropActive: id => this.dropActive(id), pump: () => this.line.pump(),
      runContinuation: (...args) => this.runContinuation(...args), workerStep: (id, step) => launchContext.workerStep(this.context, id, step),
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
        saveWorktree: (id, state, reason) => this.worktreeAutosave.saveWorktree(id, state, reason),
        settleSuccess: (id, durable, keep) => this.runSettlement.settleSuccess(id, durable, keep),
        deferParentCompletion: id => this.runFinish.deferParentCompletion(id),
        closingWakeDecision: (id, holds, cancelled, error) => this.wakeAdmission.closingWakeDecision(id, holds, cancelled, error),
        owesDelivery: id => this.wakeAdmission.owesDelivery(id), preserveRunAfterDisposal: (id, state) => preserveRunAfterDisposal(this.store, () => this.disposed, id, state),
        isDisposedDelegatedRun: id => isDisposedDelegatedRun(this.store, () => this.disposed, id), queueWaitWake: id => this.wakeAdmission.queueWaitWake(id),
        reconcileWorkerWaits: id => this.reconcileWorkerWaits(id), releaseSlot: () => this.line.releaseSlot(),
        enforceRetention: () => this.enforceRetention(), reapTerminalScratch: id => this.reapTerminalScratch(id),
        forgetMemoryPause: id => { this.memoryPausing.delete(id); },
      }, WAKE_SESSION_CLOSED_ERROR, WAKE_DELIVERY_CAP_NOTE);
    this.continuationSession = new ContinuationSession(this.context, {
      move: (...args) => this.move(...args), dropActive: id => this.dropActive(id),
      isSyntheticContinuation: (run, step) => isSyntheticContinuation(run, step),
      beginUsageInvocation: (...args) => beginUsageInvocation(this.store, ...args),
      trackWorkerSessionResult: (...args) => this.workerExecutions.trackWorkerSessionResult(...args),
      recordUsagePeaks: id => recordUsagePeaks(this.store, { isDisposedDelegatedRun: id => isDisposedDelegatedRun(this.store, () => this.disposed, id) }, id),
      saveWorktree: (...args) => this.worktreeAutosave.saveWorktree(...args), pump: () => this.line.pump(),
      makeUiSink: (...args) => sessionEvents.makeUiSink(this.context, this.sessionHelperHost, ...args),
      repositoryRootLockDisabled: () => repositoryRootLockDisabled(),
      prepareWorktree: (...args) => this.stepLoop.prepareWorktree(...args),
      workerStep: (...args) => launchContext.workerStep(this.context, ...args),
      latchAgentInputError: (...args) => this.inputDelivery.latchAgentInputError(...args),
      reconcileWorkerWaits: () => this.reconcileWorkerWaits(),
      holdContinuationForRootFinish: (...args) => this.runFinish.holdContinuationForRootFinish(...args),
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
    this.runStart = new RunStart(this.context, {
      active: this.active, startRun: (...args) => this.startRun(...args),
      execute: (...args) => this.execute(...args), runContinuation: (...args) => this.runContinuation(...args),
      move: (...args) => this.move(...args), dropActive: id => this.dropActive(id),
      historyDeletionPending: id => this.historyDeletionPending(id),
    }, this.line, this.attachments, this.turnBookkeeper, this.queuedInput, this.continuationAcceptance, this.workerExecutions);
    this.turnSettler = new TurnSettler(this.context, {
      humanWaits: this.humanWaits, line: this.line, waitWatches: this.waitWatches, waitRegistry: this.waitRegistry,
      workerQuestions: this.workerQuestions, completionGateHost: this.completionGateHost,
      move: (id, exit) => this.move(id, exit), releaseSlot: () => this.line.releaseSlot(), completionGate: id => this.runFinish.completionGate(id),
      cancelOpenWaits: id => this.wakeAdmission.cancelOpenWaits(id), countAutomaticWakes: id => this.wakeAdmission.automaticWakes(id),
      workerExecutionStopped: id => this.workerExecutionStopped(id), executionBlockedByRootFinish: run => this.executionBlockedByRootFinish(run),
      submitAgentInput: (id, state, content) => this.inputDelivery.submitAgentInput(id, state, content), flushAgentInputs: id => this.inputDelivery.flushAgentInputs(id),
      hasQueuedAgentInputs: (id, except) => this.inputDelivery.hasQueuedAgentInputs(id, except), armUnreadInputTimer: (id, state) => this.inputDelivery.armUnreadInputTimer(id, state),
      armHeldHumanInputTimer: (id, state) => this.inputDelivery.armHeldHumanInputTimer(id, state), parkOnWaits: (id, state) => this.wakeAdmission.parkOnWaits(id, state),
      queueWaitWake: id => this.wakeAdmission.queueWaitWake(id), leaveMonitoringPool: id => this.wakeAdmission.leaveMonitoringPool(id), chargeAutomaticWake: id => this.wakeAdmission.chargeAutomaticWake(id),
      canAutoContinue: (id, state) => this.turnNudges.canAutoContinue(id, state), tryAutonomousNudge: (id, state, step, ask) => this.turnNudges.tryAutonomousNudge(id, state, step, ask),
      sendTurnEndNudge: (id, state, step, text) => this.turnNudges.sendTurnEndNudge(id, state, step, text),
      awaitCompletionNudgeReply: (id, state, session) => this.turnNudges.awaitCompletionNudgeReply(id, state, session),
      noticeParkedWorker: id => this.workerQuestions.noticeParkedWorker(id), routeWorkerQuestion: id => this.workerQuestions.routeWorkerQuestion(id),
      settledTurnOutcome: (id, entry, outcome) => this.settledTurnOutcome(id, entry, outcome),
    }, IDLE_TIMEOUT_MS, MAX_AUTO_CONTINUES, COMPLETION_WILL_WAIT, SCHEDULE_WAKEUP_MAX_SECONDS);
    this.runFinish = new RunFinish(this.context, this.completionGateHost, this.runSettlement, this.turnSettler, this.turnNudges, this.line, {
      move: (id, exit, patch) => this.move(id, exit, patch), dropActive: id => this.dropActive(id),
      cancelOpenWaits: id => this.wakeAdmission.cancelOpenWaits(id), reconcileWorkerWaits: id => this.reconcileWorkerWaits(id),
      executionBlockedByRootFinish: run => this.executionBlockedByRootFinish(run), hasUnansweredHumanAsk: id => this.hasUnansweredHumanAsk(id),
    });
    this.runCancel = new RunCancel(this.context, this.line, this.workerExecutions, this.wakeAdmission, this.turnNudges, {
      active: this.active, cancel: id => this.cancel(id), isActive: id => this.isActive(id),
      cancelAutoResume: id => this.cancelAutoResume(id), rootFinishRequested: id => this.rootFinishRequested(id),
      historyDeletionPending: id => this.historyDeletionPending(id), disarmWait: id => this.disarmWait(id),
      move: (id, exit, patch) => this.move(id, exit, patch),
    });
    this.inputDelivery = new InputDelivery(this.context, {
      active: this.active, line: this.line, workerExecutions: this.workerExecutions, runSkills: this.runSkills,
      attachments: this.attachments, humanWaits: this.humanWaits, workerQuestions: this.workerQuestions,
      waitRegistry: this.waitRegistry, inputReceiptHost: this.inputReceiptHost,
      isActive: id => this.isActive(id), move: (id, exit) => this.move(id, exit),
      canProceedWithRun: (id, run) => this.canProceedWithRun(id, run),
      workerExecutionStopped: id => this.workerExecutionStopped(id), executionBlockedByRootFinish: run => this.executionBlockedByRootFinish(run),
      hasUnansweredHumanAsk: id => this.hasUnansweredHumanAsk(id), countAutomaticWakes: (id, budget) => this.wakeAdmission.automaticWakes(id, budget),
      recoveringRun: id => this.recovery.recoveringRun(id), continueRun: (id, opts, defer) => this.continueRun(id, opts, defer),
      parkForUser: (id, state, step) => this.turnSettler.parkForUser(id, state, step), settleTurn: (id, state, entry, turn) => this.turnSettler.settleTurn(id, state, entry, turn),
      boundaryTurn: (id, state, session, done) => this.turnSettler.boundaryTurn(id, state, session, done),
      canAutoContinue: (id, state) => this.turnNudges.canAutoContinue(id, state), armNoWaitNudgeReplyTimer: (id, state) => this.turnNudges.armNoWaitNudgeReplyTimer(id, state),
      awaitCompletionNudgeReply: (id, state, session) => this.turnNudges.awaitCompletionNudgeReply(id, state, session),
      queueWaitWake: id => this.wakeAdmission.queueWaitWake(id), owesWake: (run, budget) => this.wakeAdmission.owesWake(run, budget),
      pendingConversationWakes: (run, budget) => this.wakeAdmission.pendingConversationWakes(run, budget), routedAnswer: id => this.wakeAdmission.routedAnswer(id),
      spendWakeAdmission: (id, state, owed) => this.wakeAdmission.spendWakeAdmission(id, state, owed), cancelAutomaticAtCap: (id, waits) => this.wakeAdmission.cancelAutomaticAtCap(id, waits),
      reparkWithoutWaits: (id, state) => this.wakeAdmission.reparkWithoutWaits(id, state), holdPeerWakesAtCap: id => this.wakeAdmission.holdPeerWakesAtCap(id),
      reconcileWorkerWaits: () => this.reconcileWorkerWaits(), unreadInputGraceMs: () => unreadInputGraceMs,
      submitAgentInput: (id, state, content, inputs, budget) => this.inputDelivery.submitAgentInput(id, state, content, inputs, budget),
    }, MAX_AUTO_CONTINUES, ROUTED_QUESTION_REFUSAL);
    this.cezarToolsHost = { store: this.store,
      registerWait: (...args) => this.registerWait(...args), registerAsk: (...args) => this.waitRegistry.registerAsk(...args),
      cancelWait: (...args) => this.cancelWait(...args), acceptDone: (...args) => this.acceptDone(...args),
      registerPreviewServer: (...args) => registerPreviewServer(this.store, this.preview, this.cezarPort, () => this.disposed, ...args), stopPreviewServer: (...args) => stopPreviewServer(this.store, this.preview, this.cezarPort, () => this.disposed, ...args),
      awaitAutomationTools: signal => this.automationToolsSlot.awaitAutomationTools(signal) };
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
      clearAutosaveTimer(state);
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
    return launchContext.agentEnv(this.context, this.cockpit, runId);
  }

  private agentEnvForStep(
    runId: string,
    backend: RunnerId,
    options: { recordedProfileId?: string | undefined; stepId?: string | undefined } = {},
  ): Promise<{ env: Record<string, string>; profileId: string; accountBinding?: WorkerAccountBinding | undefined }> {
    return launchContext.agentEnvForStep(this.context, {
      agentEnv: (id) => this.agentEnv(id),
      workerStep: (id, stepId) => launchContext.workerStep(this.context, id, stepId),
    }, runId, backend, options);
  }

  /**
   * The cockpit serving this manager's project, set by `startServer` once it listens (#774).
   * Every agent env then carries it as `CEZ_COCKPIT_URL`/`CEZ_PROJECT_ID`, which is how
   * `cez automation` reaches the cockpit without probing ports. A headless `cez run` never
   * sets it, so it is also the "a cockpit is attached" signal for the automations gate.
   */
  private cockpit?: { origin: string; projectId: string } | undefined;
  setCockpitAddress(address: { origin: string; projectId: string } | undefined): void { return launchContext.setCockpitAddress(this.launchSettingsHost, address); }
  cockpitAddress(): { origin: string; projectId: string } | undefined { return launchContext.cockpitAddress(this.cockpit); }
  private readonly ciSessionHost: CiSessionHost = {
    active: this.active, ciResources: () => this.ciResources, cezarToolHandlers: (...args) => this.cezarToolHandlers(...args),
    preview: () => this.preview, cockpit: () => this.cockpit,
  };
  private readonly cezarToolsHost: ToolHost;

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

  builtinSkills(): Skill[] { return launchContext.builtinSkills(this.cockpit); }

  private readonly launchSettingsHost: launchContext.LaunchSettingsHost = {
    active: this.active, setCockpit: address => { this.cockpit = address; },
    delegationProvisioner: () => this.delegationProvisioner, setProvisioner: provisioner => { this.delegationProvisioner = provisioner; },
    historyDeletionPending: id => this.historyDeletionPending(id),
  };
  private delegationProvisioner?: DelegationProvisioner | undefined;
  setDelegationProvisioner(provisioner: DelegationProvisioner): () => void { return launchContext.setDelegationProvisioner(this.launchSettingsHost, provisioner); }

  /**
   * The trusted callbacks behind one session's cezar tools (hearsay-tools/cezarion#1233). Both
   * answers list the waits still open; a coded refusal answers with its fixed message, never the
   * thrower's text, and anything else is left to the tool server's `unavailable`.
   */
  cezarToolHandlers(runId: string, generation: string): CezarToolHandlers { return cezarToolHandlers(runId, generation, this.cezarToolsHost); }

  acceptDone(runId: string, generation: string, request: CezarDoneRequest, signal?: AbortSignal): CezarDoneAnswer { return this.runFinish.acceptDone(runId, generation, request, signal); }




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
  startRunIdempotent(workflow: WorkflowDef, input: StartRunInput, request: { id: string; hash: string }): { run: RunRecord; created: boolean } | { conflict: true } { return this.runStart.startRunIdempotent(workflow, input, request); }

  startRun(workflow: WorkflowDef, input: StartRunInput, clientRequest?: { id: string; hash: string }): RunRecord { return this.runStart.startRun(workflow, input, clientRequest); }

  /** Accept only the store's already-durable owned creation, never caller-supplied paths/workflows. */
  enqueueOwnedRun(runId: string): void { this.runStart.enqueueOwnedRun(runId); }

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
      clearAutosaveTimer(state);
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

  cancel(runId: string): boolean { return this.runCancel.cancel(runId); }









  isActive(runId: string): boolean {
    return this.workerExecutions.has(runId) || this.active.has(runId) || this.line.hasStarting(runId) || this.line.hasQueued(runId);
  }

  claimWorktreeReclaim(runId: string): (() => void) | null { return this.claims.claimWorktreeReclaim(runId); }
  claimForPublish(runId: string): (() => void) | null { return this.claims.claimForPublish(runId); }
  claimForBranchCleanup(runIds: readonly string[]): (() => void) | null { return this.claims.claimForBranchCleanup(runIds); }

  enqueueMessage(runId: string, content: PastedContent[]): QueuedMessage | null { return this.queuedInput.enqueueMessage(runId, content); }
  editQueuedMessage(runId: string, msgId: string, edit: { text?: string; images?: PastedContent[] }): QueuedMessage | null { return this.queuedInput.editQueuedMessage(runId, msgId, edit); }
  removeQueuedMessage(runId: string, msgId: string): boolean { return this.queuedInput.removeQueuedMessage(runId, msgId); }
  editTask(runId: string, task: string): boolean { return this.queuedInput.editTask(runId, task); }
  deferMessage(runId: string, content: PastedContent[]): boolean { return this.queuedInput.deferMessage(runId, content); }

  private parentCompletionBlockers(runId: string) { return completionGateReads.parentCompletionBlockers(this.context, this.completionGateHost, runId); }


  finishBlockedReason(runId: string): string | undefined { return completionGateReads.finishBlockedReason(this.context, this.completionGateHost, runId); }




  registerWorkerWait(parentId: string, request: WorkerWaitRequest): WorkerWait { return this.waitRegistry.registerWorkerWait(parentId, request); }
  registerWorkerListWait(runId: string, request: { workerIds?: string[]; requestIds?: string[] | undefined; mode?: WorkerWaitRequest['mode']; timeoutSeconds: number }, via: 'cezar_wait' | 'cez-worker-wait'): DeadlinedWorkerWaitEntry { return this.waitRegistry.registerWorkerListWait(runId, request, via); }
  registerRequestWait(runId: string, request: RequestWaitRequest): WorkerWait { return this.waitRegistry.registerRequestWait(runId, request); }
  registerPeerWait(runId: string, request: { peerIds: string[]; timeoutSeconds: number }, via: 'cezar_wait' | 'cez-message-wait'): PeerWaitEntry { return this.waitRegistry.registerPeerWait(runId, request, via); }
  cancelPeerWait(runId: string, waitId: string): PeerWaitEntry { return this.waitRegistry.cancelPeerWait(runId, waitId); }

  private hasUnansweredHumanAsk(runId: string): boolean {
    return pendingAskFacts.hasUnansweredHumanAsk(runId, this.active, id => this.pendingHumanAskSeq(id));
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

  /** Accepted conversation input uses the existing scheduler admission for idle recipients. */
  deliverConversationInput(runId: string): void { return this.inputDelivery.deliverConversationInput(runId); }








  /**
   * `cez worker cancel-wait`: cancels a worker wait in the list, as `cezar_cancel_wait` does, and
   * answers the legacy `WorkerWait` shape (hearsay-tools/cezarion#1235). A cancelled wait wakes
   * nothing. A resolved wait is owed: it is returned as its `wake-pending` receipt and arrives with
   * the next wake. A settled one returns its receipt; an unknown id is `incompatible_state`.
   */
  cancelWorkerWait(parentId: string, waitId: string): WorkerWait { return this.runCancel.cancelWorkerWait(parentId, waitId); }

  private rootFinishRequested(runId: string): boolean {
    return rootFinishRequested(this.store, runId);
  }

  private executionBlockedByRootFinish(run: RunRecord): boolean {
    return executionBlockedByRootFinish(this.store, run);
  }

  private canProceedWithRun(runId: string, run: RunRecord | undefined): run is RunRecord {
    return canProceedWithRun(run, () => this.workerExecutionStopped(runId), run => this.executionBlockedByRootFinish(run));
  }


  reconcileWorkerWaits(familyRootId?: string): void { this.familyReconciler.reconcileWorkerWaits(familyRootId); }

  /** Durable queue is the single hydration source for fresh, continuing and recovered runs. */
  steerWorker(runId: string, input: AgentInput): 'queued' | 'delivered' { return this.inputDelivery.steerWorker(runId, input); }

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

  /**
   * Deliver a user message into the run's live claude session (mid-turn or
   * while `waiting`). Returns false when there is no open session — the GUI
   * then offers "Continue" instead.
   */
  sendMessage(runId: string, content: PastedContent[], messageId?: string): boolean { return this.inputDelivery.sendMessage(runId, content, messageId); }

  /** Only an explicit option from the permission card may answer a native grant. */
  respondPermission(runId: string, requestId: string, optionId: string): boolean { return this.inputDelivery.respondPermission(runId, requestId, optionId); }

  finish(runId: string): boolean { return this.runFinish.finish(runId); }



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
    if (this.runFinish.holdContinuationForRootFinish(runId, { stepId, sessionId, backend, prompt, images, lineJoinedAt: Date.now() })) return;
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
        await this.repoRootLease.acquireRepoRoot(runId, state);
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
    await this.runSkills.loadRunSkills(state, 'throw');
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
      provisionSession: (...args) => launchContext.provisionSession(this.launchSettingsHost, ...args),
      agentWebhooksPart: () => launchContext.agentWebhooksPart(this.context, this.cockpit),
      provisionCiSession: (...args) => provisionCiSession(this.context, this.ciSessionHost, ...args),
      launchStale: (...args) => sessionEvents.launchStale(this.context, this.sessionHelperHost, ...args),
    };
  }



  /** The outcome a settled turn reached, for the parity cells that prove which path ran
   *  (hearsay-tools/cezarion#1809, which removed the handoff heartbeat line that recorded it). No
   *  outcome for the completion gate's refusal outside a turn end, nor while input readiness waits. */
  private settledTurnOutcome(runId: string, entry: 'turn-end' | 'ack' | 'ready' | 'gate' | 'reply-timer',
    outcome: TurnEndOutcome): TurnEndOutcome | undefined {
    return entry === 'gate' || (entry === 'ready' && outcome.kind === 'readiness') ? undefined : outcome;
  }


  /** Every run status `run.ts` writes comes from the run state table (hearsay-tools/cezarion#1804). */
  private move(runId: string, exit: RunExitId, patch: Omit<Parameters<RunStore['updateRun']>[1], 'status'> = {}): RunRecord | undefined {
    const status = transition(exit, () => this.store.getRun(runId));
    return this.store.updateRun(runId, { ...patch, ...(status === 'failed' ? settledRootFinishPatch(this.store, runId) : {}), status });
  }

  private autosaveCleanupBlocker(runId: string): string | undefined {
    return this.worktreeAutosave.autosaveCleanupBlocker(runId);
  }

}
