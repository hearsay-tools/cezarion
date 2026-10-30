import { composeRunModules, type RunModules } from './run/compose.ts';
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
  private readonly modules: RunModules;

  

  

  private readonly completionGateHost: completionGateReads.CompletionGateHost = {
    active: this.active,
    pendingHumanAskSeq: id => this.pendingHumanAskSeq(id),
    isActive: id => this.isActive(id),
    holdsAgentWaits: id => this.modules.humanWaits.holdsAgentWaits(id),
    waitingBeforeFinalWorkflowStep: run => this.waitingBeforeFinalWorkflowStep(run),
    parentCompletionBlockers: id => this.parentCompletionBlockers(id),
    unansweredQuestions: id => this.modules.workerQuestions.unansweredQuestions(id),
  };

  

  

  

  

  
  private readonly inputReceiptSteps: inputReceipts.InputReceiptSteps = {
    clearUnread: state => clearUnreadInputTimer(state), clearHeld: state => clearHeldHumanInputTimer(state),
    noteActivity: (id, state, event) => this.modules.turnNudges.noteNoWaitNudgeContent(id, state, event),
    persistAttachment: (id, mediaType, data) => this.modules.attachments.persistAttachment(id, mediaType, data),
    ready: (id, state, session) => this.modules.inputDelivery.handleAgentInputReady(id, state, session),
    pid: (id, pid) => { replaceRunProcess(id, pid); this.modules.workerExecutions.recordWorkerProcess(id, pid); },
    ui: (id, state, sink, event) => sessionEvents.handleRunnerUiEvent(this.context, this.modules.sessionHelperHost, id, state, sink, event),
    flushDeferred: id => this.modules.queuedInput.flushDeferred(id), recordProcess: (id, pid) => this.modules.workerExecutions.recordWorkerProcess(id, pid),
  };
  private readonly inputReceiptHost: inputReceipts.InputReceiptsHost = {
    reconcileWorkerWaits: () => this.reconcileWorkerWaits(),
    flushAgentInputs: id => this.modules.inputDelivery.flushAgentInputs(id),
    isCurrentState: (id, state) => this.active.get(id) === state,
  };

  

  settleOrphanedWorkerExecution(runId: string, opts: { admitting?: boolean; fresh?: boolean; cwds?: CwdSource } = {}): boolean { return this.modules.orphans.settleOrphanedWorkerExecution(runId, opts); }
  takeWorkerTerminationBlocker(runId: string): { blocker: WorkerTerminationBlocker; changed: boolean } | undefined { return this.modules.orphans.takeWorkerTerminationBlocker(runId); }

  requestWorkerStop(runId: string): WorkerStopResult { return this.modules.runCancel.requestWorkerStop(runId); }

  async awaitRunTermination(runId: string, timeoutMs: number, opts: { reapOrphans?: boolean } = {}): Promise<boolean> {
    const terminated = await this.modules.workerExecutions.proveRunTermination(runId, timeoutMs, opts);
    if (terminated && opts.reapOrphans && !this.disposed) await this.modules.orphans.terminateFinishedWorkerGroups(runId, timeoutMs);
    return terminated;
  }

  private historyDeletionPending(runId: string): boolean {
    return historyDeletionPending(this.store, runId);
  }

  private workerExecutionStopped(runId: string): boolean {
    const run = this.store.getRun(runId);
    return this.historyDeletionPending(runId) || run?.delegation?.role === 'invalid' || (run?.delegation?.role === 'worker' &&
      (!!run.delegation.destroy || this.modules.workerExecutions.isStopped(runId)));
  }

  /** Runs whose worktree a reclaim, or whose branch a delete, is removing right now
   *  (`claimWorktreeReclaim`, `claimForBranchCleanup`). `continueRun` refuses them. */

  

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

  
  private disposed = false;

  private readonly onDelegationRun = (run: RunRecord, source?: CommitSource): void => {
    // Delegation metadata checkpoints do not change task status.
    // A republish changed nothing durable: there is nothing to reap, cancel or reconcile.
    if (source === 'live-release') return;
    if (!this.disposed && source === undefined) this.reapTerminalScratch(run.id);
    if (!this.disposed && !['queued', 'running', 'waiting'].includes(run.status) && !holdsOwedResults(run)) this.modules.wakeAdmission.cancelOpenWaits(run.id);
    if (run.delegation && !['queued', 'running', 'waiting'].includes(run.status)) this.active.get(run.id)?.revokeDelegation?.();
    // Cleanup checkpoints emit terminal records too. With delegation disabled,
    // these observations must not replay the project's conversation histories.
    if (this.disposed || this.modules.recovery.recoveringRun(run) || (source === 'delegation-checkpoint' && process.env.CEZ_DELEGATION !== '1')) return;
    // A destroy retry changes nothing the family reconcile reads (#880).
    if (source === 'delegation-destroy-progress') return;
    if (run.delegation && run.delegation.role !== 'invalid' && !['queued', 'running', 'waiting'].includes(run.status)) {
      for (const id of settledRunFamilies(this.store, run)) this.reconcileWorkerWaits(id);
    }
    this.modules.waitRegistry.resolvePeerWaits(runsAwaitingPeer(run, () => this.store.listRuns())); // never in recovery: an interrupted peer fails, then continues
  };

  

  

  

  

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
    this.workerScratchCleanup = new WorkerScratchCleanup(store, this.dataDir, id => this.isActive(id) || this.modules.workerExecutions.has(id) || this.modules.claims.has(id) || !!this.autosaveCleanupBlocker(id));
    this.preview = options.preview;
    this.cezarPort = options.cezarPort;
    // #774: `serve` knows its bound origin before it recovers, so recovered runs carry it too.
    if (options.cockpit) this.setCockpitAddress(options.cockpit);
    /** Quiet window before unread input is resubmitted or left unconfirmed (#505). */
    const unreadInputGraceMs = options.unreadInputGraceMs ?? UNREAD_INPUT_GRACE_MS;
    this.semaphore = options.semaphore ?? new WorkspaceSemaphore();
    this.context = { store, repoRoot, dataDir: this.dataDir, semaphore: this.semaphore, disposed: () => this.disposed, work: options.work ?? new TrackedWork() };
    const facade = this;
    this.modules = composeRunModules(this.context, {
      move: (...args) => this.move(...args),
      isActive: (...args) => this.isActive(...args),
      workerExecutionStopped: (...args) => this.workerExecutionStopped(...args),
      resumableSessionId: (...args) => this.resumableSessionId(...args),
      reviveQueuedRun: (...args) => this.reviveQueuedRun(...args),
      get active() { return facade.active; },
      autosaveCleanupBlocker: (...args) => this.autosaveCleanupBlocker(...args),
      cancel: (...args) => this.cancel(...args),
      deliverConversationInput: (...args) => this.deliverConversationInput(...args),
      reconcileWorkerWaits: (...args) => this.reconcileWorkerWaits(...args),
      disarmWait: (...args) => this.disarmWait(...args),
      canProceedWithRun: (id, run): run is RunRecord => this.canProceedWithRun(id, run),
      get ciSupervisor() { return facade.ciSupervisor; },
      executionBlockedByRootFinish: (...args) => this.executionBlockedByRootFinish(...args),
      get inputReceiptHost() { return facade.inputReceiptHost; },
      agentEnvForStep: (...args) => this.agentEnvForStep(...args),
      get cockpit() { return facade.cockpit; },
      get completionGateHost() { return facade.completionGateHost; },
      settledTurnOutcome: (...args) => this.settledTurnOutcome(...args),
      reapTerminalScratch: (...args) => this.reapTerminalScratch(...args),
      settleOrphanedWorkerExecution: (...args) => this.settleOrphanedWorkerExecution(...args),
      get workerScratchCleanup() { return facade.workerScratchCleanup; },
      sendMessage: (...args) => this.sendMessage(...args),
      canClaimInboxInput: (...args) => this.canClaimInboxInput(...args),
      builtinSkills: (...args) => this.builtinSkills(...args),
      sessionEventHost: (...args) => this.sessionEventHost(...args),
      launchPreambleHost: (...args) => this.launchPreambleHost(...args),
      get inputReceiptSteps() { return facade.inputReceiptSteps; },
      continueRun: (...args) => this.continueRun(...args),
      recover: (...args) => this.recover(...args),
      adoptTranscriptAsk: (...args) => this.adoptTranscriptAsk(...args),
      settleAnsweredLegacyAsk: (...args) => this.settleAnsweredLegacyAsk(...args),
      dropActive: (...args) => this.dropActive(...args),
      runContinuation: (...args) => this.runContinuation(...args),
      enforceRetention: (...args) => this.enforceRetention(...args),
      get memoryPausing() { return facade.memoryPausing; },
      startRun: (...args) => this.startRun(...args),
      execute: (...args) => this.execute(...args),
      historyDeletionPending: (...args) => this.historyDeletionPending(...args),
      hasUnansweredHumanAsk: (...args) => this.hasUnansweredHumanAsk(...args),
      cancelAutoResume: (...args) => this.cancelAutoResume(...args),
      rootFinishRequested: (...args) => this.rootFinishRequested(...args),
      registerWait: (...args) => this.registerWait(...args),
      cancelWait: (...args) => this.cancelWait(...args),
      acceptDone: (...args) => this.acceptDone(...args),
      get preview() { return facade.preview; },
      get cezarPort() { return facade.cezarPort; },
    }, { noWaitNudgeReplyMs: options.noWaitNudgeReplyMs, unreadInputGraceMs });
    this.ciResources = acquireCiResources(this.semaphore);
    this.ciSupervisor = this.ciResources.supervisor;
    this.offSemaphore = this.semaphore.register({
      busySlots: () => this.modules.line.busySlots(),
      oldestWakeAt: () => this.modules.line.oldestWakeAt(),
      pump: () => this.modules.line.pump(),
      oldestQueuedAt: () => this.modules.line.oldestQueuedAt(),
      accountHolds: () => this.accountHolds(),
    });
    // Memory guard (#memory-guard): the shared process-tree sampler already ticks ~every 2 s for
    // the runs table; piggyback on it to enforce the per-task memory ceiling.
    this.offUsage = onUsage((snapshot) => void this.enforceMemoryLimit(snapshot));
    this.queueWatchdog = setInterval(() => void this.modules.line.rescueStalledQueue(), QUEUE_WATCHDOG_MS);
    this.queueWatchdog.unref?.();
    this.store.on('run', this.onDelegationRun);
    this.store.on('deleted', this.modules.wakeAdmission.onRunDeleted);
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
    this.modules.waitWatches.disposeWatches();
    this.modules.waitRegistry.dispose();
    this.modules.waitWatches.disposeRetries();
    this.modules.retries.dispose();
    // Wait records stay as they are: a later manager re-arms them from their deadlines.
    this.modules.waitWatches.dispose();
    this.ciResources.release();
    this.delegationProvisioner = undefined;
    this.modules.orphans.dispose();
    this.modules.workerExecutions.dispose();
    this.store.off('run', this.onDelegationRun);
    this.store.off('deleted', this.modules.wakeAdmission.onRunDeleted);
    this.modules.familyReconciler.dispose();
    this.modules.inboxClaims.dispose();
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
    this.modules.autoResumeScheduler.dispose();
    this.active.clear();
    this.modules.line.dispose();
    this.memoryPausing.clear();
    this.modules.turnBookkeeper.clear();
    this.modules.worktreeAutosave.dispose();
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

  /**
   * hearsay-tools/cezarion#1465: the project's one-time schedule service behind
   * `cezar_schedule_task` and `cezar_scheduled_tasks`, set by `startServer` beside the cockpit
   * address. Headless `cez run` never sets it, so the tools answer `unavailable` there. The
   * boot manager recovers runs before the server sets it, and a lazy project's manager recovers
   * before its context is announced: a resumed session can call a tool in that window. With a
   * cockpit address the call waits for the service, bounded like the CLI's startup retry.
   */

  setAutomationTools(tools: AutomationToolService | undefined): void { this.modules.automationToolsSlot.setAutomationTools(tools); }

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
  cezarToolHandlers(runId: string, generation: string): CezarToolHandlers { return cezarToolHandlers(runId, generation, this.modules.cezarToolsHost); }

  acceptDone(runId: string, generation: string, request: CezarDoneRequest, signal?: AbortSignal): CezarDoneAnswer { return this.modules.runFinish.acceptDone(runId, generation, request, signal); }

  async registerWait(runId: string, request: CezarWaitRequestInput, via: WaitVia, generation: string, capabilitySignal?: AbortSignal): Promise<PrWaitEntry | TimerWaitEntry | WorkerWaitEntry | ProcessWaitEntry | PeerWaitEntry> { return this.modules.waitRegistry.registerWait(runId, request, via, generation, capabilitySignal); }
  cancelWait(runId: string, waitId: string, generation: string) { return this.modules.waitRegistry.cancelWait(runId, waitId, generation); }

  private disarmWait(waitId: string): void { this.modules.waitWatches.disarmWait(waitId); this.modules.familyReconciler.forgetRetry(waitId); this.modules.waitWatches.disarmProcessWatch(waitId); }

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
  startRunIdempotent(workflow: WorkflowDef, input: StartRunInput, request: { id: string; hash: string }): { run: RunRecord; created: boolean } | { conflict: true } { return this.modules.runStart.startRunIdempotent(workflow, input, request); }

  startRun(workflow: WorkflowDef, input: StartRunInput, clientRequest?: { id: string; hash: string }): RunRecord { return this.modules.runStart.startRun(workflow, input, clientRequest); }

  /** Accept only the store's already-durable owned creation, never caller-supplied paths/workflows. */
  enqueueOwnedRun(runId: string): void { this.modules.runStart.enqueueOwnedRun(runId); }

  private async reviveQueuedRun(run: RunRecord, reason: string): Promise<void> { return queuedRevival.reviveQueuedRun(this.context, this.modules.queuedRevivalHost, run, reason); }

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
  async recover(familyRootId?: string): Promise<void> { return this.modules.recovery.recover(familyRootId); }

  /**
   * Adopt a dead owner’s family for a control, then recover the settled family without resuming
   * work. Stop cancels its target; only Continue starts work. Serialize adoptions after recovery.
   * False means missing or live-owned.
   */
  adoptOrphanedRun(runId: string, opts: { stop?: boolean } = {}): Promise<boolean> { return this.modules.recovery.adoptOrphanedRun(runId, opts); }

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
    this.modules.line.forget(runId);
    this.active.delete(runId);
    this.store.unpin(runId, 'active');
    this.modules.runSettlement.afterDropActive(runId);
  }

  private readonly workerScratchCleanup: WorkerScratchCleanup;
  /** Project detach cancels autonomous cleanup; reattach reconstructs the durable intents. */
  pauseWorkerCleanup(): void { this.workerScratchCleanup.pause(); }
  recoverWorkerCleanup(): void { if (!this.disposed) this.workerScratchCleanup.recover(); }

  claimWorkerCleanup(runId: string): (() => void) | undefined { return this.modules.claims.claimWorkerCleanup(runId); }

  /** Scratch belongs to the task, not its current agent process (#515).
   * Terminal status alone is not process-exit proof: an active session or an
   * unfinished private worker generation must retain its files until exit. */
  private reapTerminalScratch(runId: string): void {
    const run = this.store.getRun(runId);
    if (!run || ['queued', 'running', 'waiting'].includes(run.status)) return;
    if (this.active.has(runId) || this.modules.line.hasStarting(runId) || this.modules.line.hasQueued(runId) || this.modules.claims.has(runId) || !!this.autosaveCleanupBlocker(runId)) return;
    const privateWorkers = workerEvidenceRunIds(this.dataDir);
    if (run.delegation?.role === 'worker' || run.delegation?.role === 'invalid' || !privateWorkers || privateWorkers.includes(runId)) { this.workerScratchCleanup.schedule(runId); return; }
    removeAgentTmpDir(this.dataDir, runId);
  }

  // ---- usage-limit auto-resume (spec 2026-08-03-auto-resume-after-usage-limit) --------------

  accountHolds(now = Date.now()): AccountHolds {
    return deriveAccountHolds(this.store.listRuns(), run => this.modules.wakeAdmission.withExecutionAccount(run), now);
  }

  cancelAutoResume(runId: string): boolean { return this.modules.autoResumeScheduler.cancelAutoResume(runId); }

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

  /** Test seam: the module owns this same map for its whole lifetime. */

  cancel(runId: string): boolean { return this.modules.runCancel.cancel(runId); }

  isActive(runId: string): boolean {
    return this.modules.workerExecutions.has(runId) || this.active.has(runId) || this.modules.line.hasStarting(runId) || this.modules.line.hasQueued(runId);
  }

  claimWorktreeReclaim(runId: string): (() => void) | null { return this.modules.claims.claimWorktreeReclaim(runId); }
  claimForPublish(runId: string): (() => void) | null { return this.modules.claims.claimForPublish(runId); }
  claimForBranchCleanup(runIds: readonly string[]): (() => void) | null { return this.modules.claims.claimForBranchCleanup(runIds); }

  enqueueMessage(runId: string, content: PastedContent[]): QueuedMessage | null { return this.modules.queuedInput.enqueueMessage(runId, content); }
  editQueuedMessage(runId: string, msgId: string, edit: { text?: string; images?: PastedContent[] }): QueuedMessage | null { return this.modules.queuedInput.editQueuedMessage(runId, msgId, edit); }
  removeQueuedMessage(runId: string, msgId: string): boolean { return this.modules.queuedInput.removeQueuedMessage(runId, msgId); }
  editTask(runId: string, task: string): boolean { return this.modules.queuedInput.editTask(runId, task); }
  deferMessage(runId: string, content: PastedContent[]): boolean { return this.modules.queuedInput.deferMessage(runId, content); }

  private parentCompletionBlockers(runId: string) { return completionGateReads.parentCompletionBlockers(this.context, this.completionGateHost, runId); }

  finishBlockedReason(runId: string): string | undefined { return completionGateReads.finishBlockedReason(this.context, this.completionGateHost, runId); }

  registerWorkerWait(parentId: string, request: WorkerWaitRequest): WorkerWait { return this.modules.waitRegistry.registerWorkerWait(parentId, request); }
  registerWorkerListWait(runId: string, request: { workerIds?: string[]; requestIds?: string[] | undefined; mode?: WorkerWaitRequest['mode']; timeoutSeconds: number }, via: 'cezar_wait' | 'cez-worker-wait'): DeadlinedWorkerWaitEntry { return this.modules.waitRegistry.registerWorkerListWait(runId, request, via); }
  registerRequestWait(runId: string, request: RequestWaitRequest): WorkerWait { return this.modules.waitRegistry.registerRequestWait(runId, request); }
  registerPeerWait(runId: string, request: { peerIds: string[]; timeoutSeconds: number }, via: 'cezar_wait' | 'cez-message-wait'): PeerWaitEntry { return this.modules.waitRegistry.registerPeerWait(runId, request, via); }
  cancelPeerWait(runId: string, waitId: string): PeerWaitEntry { return this.modules.waitRegistry.cancelPeerWait(runId, waitId); }

  private hasUnansweredHumanAsk(runId: string): boolean {
    return pendingAskFacts.hasUnansweredHumanAsk(runId, this.active, id => this.pendingHumanAskSeq(id));
  }

  canClaimInboxInput(runId: string, id: string): boolean {
    return this.modules.inboxClaims.canClaimInboxInput(runId, id);
  }

  reserveInboxInputs(runId: string, generation: string, ids: readonly string[]): { receiptId: string; expiresAt: string; inputIds: string[] } | undefined {
    return this.modules.inboxClaims.reserveInboxInputs(runId, generation, ids);
  }

  acknowledgeInbox(runId: string, generation: string, receiptId: string): 'acknowledged' | 'already-acknowledged' {
    return this.modules.inboxClaims.acknowledgeInbox(runId, generation, receiptId);
  }

  releaseInbox(runId: string, generation: string, receiptId: string): 'released' {
    return this.modules.inboxClaims.releaseInbox(runId, generation, receiptId);
  }

  /** Accepted conversation input uses the existing scheduler admission for idle recipients. */
  deliverConversationInput(runId: string): void { return this.modules.inputDelivery.deliverConversationInput(runId); }

  /**
   * `cez worker cancel-wait`: cancels a worker wait in the list, as `cezar_cancel_wait` does, and
   * answers the legacy `WorkerWait` shape (hearsay-tools/cezarion#1235). A cancelled wait wakes
   * nothing. A resolved wait is owed: it is returned as its `wake-pending` receipt and arrives with
   * the next wake. A settled one returns its receipt; an unknown id is `incompatible_state`.
   */
  cancelWorkerWait(parentId: string, waitId: string): WorkerWait { return this.modules.runCancel.cancelWorkerWait(parentId, waitId); }

  private rootFinishRequested(runId: string): boolean {
    return rootFinishRequested(this.store, runId);
  }

  private executionBlockedByRootFinish(run: RunRecord): boolean {
    return executionBlockedByRootFinish(this.store, run);
  }

  private canProceedWithRun(runId: string, run: RunRecord | undefined): run is RunRecord {
    return canProceedWithRun(run, () => this.workerExecutionStopped(runId), run => this.executionBlockedByRootFinish(run));
  }

  reconcileWorkerWaits(familyRootId?: string): void { this.modules.familyReconciler.reconcileWorkerWaits(familyRootId); }

  /** Durable queue is the single hydration source for fresh, continuing and recovered runs. */
  steerWorker(runId: string, input: AgentInput): 'queued' | 'delivered' { return this.modules.inputDelivery.steerWorker(runId, input); }

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
    this.modules.humanWaits.withdrawCezarHumanWaits(runId);
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
  sendMessage(runId: string, content: PastedContent[], messageId?: string): boolean { return this.modules.inputDelivery.sendMessage(runId, content, messageId); }

  /** Only an explicit option from the permission card may answer a native grant. */
  respondPermission(runId: string, requestId: string, optionId: string): boolean { return this.modules.inputDelivery.respondPermission(runId, requestId, optionId); }

  finish(runId: string): boolean { return this.modules.runFinish.finish(runId); }

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
      return this.modules.continuationAcceptance.admitContinuation(runId, opts, deferForCapacity, conversation);
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
    if (this.workerExecutionStopped(runId)) { this.modules.line.unmarkStarting(runId); return; }
    if (this.modules.runFinish.holdContinuationForRootFinish(runId, { stepId, sessionId, backend, prompt, images, lineJoinedAt: Date.now() })) return;
    workerIdentity(this.store, this.repoRoot, runId);
    const record = this.store.getRun(runId);
    const workspace = await this.modules.continuationSession.continuationWorkspace(runId, stepId, record);
    if (!workspace) return;
    if (this.modules.continuationSession.settleStoppedContinuation(runId)) return;
    // Continue and restart recovery build their own ActiveRun: hydrate the durable mode here.
    const state = createActiveRun({
      cwd: workspace.cwd,
      pendingHumanAsk: this.hasPendingHumanAsk(runId),
      autonomous: record?.autonomous === true,
    });
    this.activate(runId, state);
    this.modules.line.unmarkStarting(runId);
    return this.modules.continuationSession.launchContinuation(runId, stepId, sessionId, backend, prompt,
      images, persistedImages, persistedAttachments, state, record, workspace.rematerialized);
  }

  // ---- execution -----------------------------------------------------------

  private async execute(runId: string, workflow: WorkflowDef, input: StartRunInput, startAt = 0): Promise<void> {
    if (this.workerExecutionStopped(runId)) { this.modules.line.unmarkStarting(runId); return; }
    workerIdentity(this.store, this.repoRoot, runId);
    const state = createActiveRun({
      cwd: this.repoRoot,
      pendingHumanAsk: this.hasPendingHumanAsk(runId),
      autonomous: input.autonomous === true,
    });
    this.activate(runId, state);
    this.modules.line.unmarkStarting(runId);
    const emit = (event: { type: string; stepId?: string; [k: string]: unknown }) =>
      this.store.appendEvent(runId, event);
    const execution: Execution = { runId, workflow, input, startAt, state, emit };

    const launch = await this.modules.stepLoop.startExecution(execution);
    if (!launch) return;
    if (!(await this.modules.stepLoop.prepareExecutionWorktree(execution, launch))) return;

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
        await this.modules.repoRootLease.acquireRepoRoot(runId, state);
      }
      // THE window that matters for an in-place run. Waiting for the exclusive tree can take
      // minutes, and a run parked on that lease holds no slot (#347) — so the queue keeps
      // advancing behind it and the dequeue-time gate is long past. Measured with five in-place
      // tasks and `maxParallel: 2`: four of them started. Re-ask here, where the very next thing
      // is a spawn, and hand the run back to the queue if the account closed meanwhile. This
      // check also covers the explicit lock-bypass path, where the account may close while the
      // run is preparing its first step.
      if (this.modules.stepLoop.requeueWhileHeld(runId, workflow, input, launch.taskBackend, state, startAt)) return;
    }

    // Handoff journal (spec 007) — seeded after the worktree exists so the
    // header can name the branch. Idempotent: an existing file stays as-is.
    const seeded = this.store.getRun(runId);
    if (seeded) seedHandoffFile(this.dataDir, seeded);
    // Worktree setup (#917): before the first step, so the agent starts in a prepared tree. Its
    // note rides the first agent step's opening message only, like the task's attachments.
    const setupNote = await this.modules.stepLoop.prepareWorktree(runId, state, launch.config.worktreeSetup, emit, 'start');

    // Every entry path loads the registry — `runContinuation` loads its own, and the one that
    // skipped this leaked raw `/skill` text to the backend (open-mercato/cezar#811). A failed discovery fails the run.
    await this.modules.runSkills.loadRunSkills(state, 'throw');
    const loop = await this.modules.stepLoop.runWorkflowSteps(execution, launch, { ...openingInputs(this.store, this.dataDir, execution), setupNote });
    if (loop) await this.modules.runSettlement.settleExecution(runId, state, loop);
  }

  private settleFailedRun(runId: string, runError: string, deliveryCapped: boolean): void { this.modules.runSettlement.settleFailedRun(runId, runError, deliveryCapped); }

  private sessionEventHost(): import('./run/session-events.ts').SessionEventHost {
    return {
      disposedSessionEvent: (...args) => sessionEvents.disposedSessionEvent(this.context, this.modules.sessionHelperHost, ...args),
      handleReceiptEvent: (...args) => inputReceipts.handleReceiptEvent(this.context, this.inputReceiptHost, this.inputReceiptSteps, ...args),
      recordSessionFault: (...args) => sessionEvents.recordSessionFault(this.context, this.modules.sessionHelperHost, ...args),
      markTurnBoundary: (...args) => sessionEvents.markTurnBoundary(this.context, this.modules.sessionHelperHost, ...args),
      trackTurnEnd: (...args) => this.modules.turnBookkeeper.trackTurnEnd(...args),
      endTurn: (...args) => this.modules.turnSettler.endTurn(...args),
    };
  }

  private launchPreambleHost(): import('./run/session-events.ts').LaunchPreambleHost {
    return {
      provisionSession: (...args) => launchContext.provisionSession(this.launchSettingsHost, ...args),
      agentWebhooksPart: () => launchContext.agentWebhooksPart(this.context, this.cockpit),
      provisionCiSession: (...args) => provisionCiSession(this.context, this.ciSessionHost, ...args),
      launchStale: (...args) => sessionEvents.launchStale(this.context, this.modules.sessionHelperHost, ...args),
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
    return this.modules.worktreeAutosave.autosaveCleanupBlocker(runId);
  }

}
