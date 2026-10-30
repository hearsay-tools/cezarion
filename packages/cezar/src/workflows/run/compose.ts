import { MemoryGuard } from './memory-guard.ts';
import { RunCancel } from './run-cancel.ts';
import { IDLE_TIMEOUT_MS, ROUTED_QUESTION_REFUSAL, NO_WAIT_NUDGE_REPLY_MS, COMPLETION_WILL_WAIT, MAX_AUTO_CONTINUES, SCHEDULE_WAKEUP_MAX_SECONDS, MAX_WAKE_DELIVERY_ATTEMPTS, WAKE_DELIVERY_CAP_NOTE, WAKE_SESSION_CLOSED_ERROR, RESTART_CONTINUATION_PROMPT } from './constants.ts';
import { isSyntheticContinuation } from './workflow-position.ts';
import { repositoryRootLockDisabled } from './repo-root-lease.ts';
import { isUntouchedCancelledRun } from './run-guards.ts';
import { WorkerOrphanAliveError, admissionError } from './worker-orphans.ts';
import { ContinuationSession } from './continuation-session.ts';
import { StepLoop as WorkflowStepLoop } from './step-loop.ts';
import { RunRecovery } from './run-recovery.ts';
import { TurnSettler } from './turn-settler.ts';
import { StepSession } from './step-session.ts';
import * as sessionEvents from './session-events.ts';
import { WakeAdmission } from './wake-admission.ts';
import { RunFinish } from './run-finish.ts';
import { RunSettlement } from './run-settlement.ts';
import { InputDelivery } from './input-delivery.ts';
import { TurnNudges } from './turn-nudges.ts';
import { WorkerQuestions } from './worker-questions.ts';
import { FamilyReconciler } from './family-reconciler.ts';
import * as completionGateReads from './completion-gate.ts';
import { WaitRegistry } from './wait-registry.ts';
import { WakeRetries } from './wake-retries.ts';
import { WaitWatches } from './wait-watches.ts';
import { HumanWaits } from './human-waits.ts';
import { RunStart } from './run-start.ts';
import { RunLine } from './run-line.ts';
import { WorktreeAutosave } from './worktree-autosave.ts';
import { RunSkills } from './run-skills.ts';
import { InboxClaims } from './inbox-claims.ts';
import { WorkerExecutions } from './worker-executions.ts';
import { TurnBookkeeper } from './turn-bookkeeping.ts';
import { AutomationToolsSlot, cezarToolHandlers, provisionCiSession, type ToolHost, type CiSessionHost } from './cezar-tools.ts';
import { registerPreviewServer, stopPreviewServer } from '../../preview/run-tools.ts';
import { AttachmentWriter } from './attachment-writer.ts';
import { QueuedInput } from './queued-input.ts';
import { RepoRootLease } from './repo-root-lease.ts';
import { MaintenanceClaims } from './maintenance-claims.ts';
import { WorkerOrphans } from './worker-orphans.ts';
import type { StartRunInput } from './types.ts';
import type { ContinueRunOptions } from '../continuation-admission.ts';
import { type CezarDoneAnswer, type CezarDoneRequest, type CezarWaitRequestInput, type PeerWaitEntry, type PrWaitEntry, type ProcessWaitEntry, type TimerWaitEntry, type WaitVia, type WorkerWaitEntry } from '@open-mercato/cezar-contract/waits';
import { type TurnEndOutcome } from '../turn-end.ts';
import { type ActiveRun } from '../active-run.ts';
import { canProceedWithRun, executionBlockedByRootFinish, historyDeletionPending, rootFinishRequested, isDisposedDelegatedRun, preserveRunAfterDisposal } from './run-guards.ts';
import { beginUsageInvocation, recordUsagePeaks } from './usage-accounting.ts';
import * as inputReceipts from './input-receipts.ts';
import { ContinuationAcceptance } from './continuation-acceptance.ts';
import { AutoResumeScheduler } from './auto-resume.ts';
import type { RunModuleContext } from './types.ts';
import * as launchContext from './launch-context.ts';
import { clearUnreadInputTimer, clearHeldHumanInputTimer } from './input-timers.ts';
import { type RunExitId } from '../run-states.ts';
import { type PreviewHostLike } from '../../preview/registration.ts';
import { acquireCiResources } from '../../ci-wait/resources.ts';
import type { CiWatcherSupervisor } from '../../ci-wait/supervisor.ts';
import type { CezarToolHandlers } from '../../ci-wait/controller.ts';
import { type WorkerAccountBinding } from '../../delegation/execution-identity.ts';
import type { DelegationProvisioner } from '../../delegation/provision.ts';
import { replaceRunProcess } from '../../core/process-usage.ts';
import { WorkerScratchCleanup } from '../../delegation/scratch-cleanup.ts';
import { type CwdSource } from '../../delegation/process-liveness.ts';
import type { RunnerId } from '../../core/agent-runner.ts';
import { type PastedContent, type PersistedAttachment } from '../pasted-content.ts';
import type { ContentBlock } from '../../core/agent-runner.ts';
import { type Skill } from '../../skills.ts';
import * as queuedRevival from './queued-revival.ts';
import { type RunRecord, type RunStore, type StepState } from '../../runs/store.ts';
import { type WorkflowDef } from '../types.ts';

export interface RunModules {
  memoryGuard: MemoryGuard;
  workerScratchCleanup: WorkerScratchCleanup;
  completionGateHost: completionGateReads.CompletionGateHost;
  inputReceiptSteps: inputReceipts.InputReceiptSteps;
  inputReceiptHost: inputReceipts.InputReceiptsHost;
  ciSessionHost: CiSessionHost;
  launchSettingsHost: launchContext.LaunchSettingsHost;
  retries: WakeRetries;
  queuedRevivalHost: queuedRevival.QueuedRevivalHost;
  line: RunLine;
  workerQuestions: WorkerQuestions;
  familyReconciler: FamilyReconciler;
  waitWatches: WaitWatches;
  waitRegistry: WaitRegistry;
  humanWaits: HumanWaits;
  sessionHelperHost: sessionEvents.SessionHelperHost;
  turnNudges: TurnNudges;
  worktreeAutosave: WorktreeAutosave;
  orphans: WorkerOrphans;
  workerExecutions: WorkerExecutions;
  automationToolsSlot: AutomationToolsSlot;
  /** Runs whose worktree a reclaim, or whose branch a delete, is removing right now
   *  (`claimWorktreeReclaim`, `claimForBranchCleanup`). `continueRun` refuses them. */
  claims: MaintenanceClaims;
  attachments: AttachmentWriter;
  queuedInput: QueuedInput;
  inboxClaims: InboxClaims;
  repoRootLease: RepoRootLease;
  turnBookkeeper: TurnBookkeeper;
  runSkills: RunSkills;
  stepSession: StepSession;
  autoResumeScheduler: AutoResumeScheduler;
  recovery: RunRecovery;
  wakeAdmission: WakeAdmission;
  continuationAcceptance: ContinuationAcceptance;
  runSettlement: RunSettlement;
  continuationSession: ContinuationSession;
  stepLoop: WorkflowStepLoop;
  runStart: RunStart;
  turnSettler: TurnSettler;
  runFinish: RunFinish;
  runCancel: RunCancel;
  inputDelivery: InputDelivery;
  cezarToolsHost: ToolHost;
}

export interface FacadeHost {
  unreadInputGraceMs(): number;
  noWaitNudgeReplyMs(): number | undefined;
  claimWorktreeReclaim(runId: string): ReturnType<MaintenanceClaims['claimWorktreeReclaim']>;
  pendingHumanAskSeq(runId: string): number | undefined;
  waitingBeforeFinalWorkflowStep(run: RunRecord): boolean;
  parentCompletionBlockers(runId: string): ReturnType<typeof completionGateReads.parentCompletionBlockers>;
  ciResources: ReturnType<typeof acquireCiResources>;
  cezarToolHandlers(runId: string, generation: string): CezarToolHandlers;
  delegationProvisioner?: DelegationProvisioner | undefined;
  move(runId: string, exit: RunExitId, patch?: Omit<Parameters<RunStore['updateRun']>[1], 'status'>): RunRecord | undefined;
  isActive(runId: string): boolean;
  workerExecutionStopped(runId: string): boolean;
  resumableSessionId(runId: string, sessionStep: StepState | undefined): string | undefined;
  reviveQueuedRun(run: RunRecord, reason: string): Promise<void>;
  active: Map<string, ActiveRun>;
  autosaveCleanupBlocker(runId: string): string | undefined;
  cancel(runId: string): boolean;
  deliverConversationInput(runId: string): void;
  reconcileWorkerWaits(familyRootId?: string): void;
  disarmWait(waitId: string): void;
  canProceedWithRun(runId: string, run: RunRecord | undefined): run is RunRecord;
  ciSupervisor: Pick<CiWatcherSupervisor, 'resolve' | 'watch' | 'close'>;
  executionBlockedByRootFinish(run: RunRecord): boolean;
  agentEnvForStep(runId: string, backend: RunnerId, options?: { recordedProfileId?: string | undefined; stepId?: string | undefined }): Promise<{ env: Record<string, string>; profileId: string; accountBinding?: WorkerAccountBinding | undefined }>;
  cockpit?: { origin: string; projectId: string } | undefined;
  settledTurnOutcome(runId: string, entry: 'turn-end' | 'ack' | 'ready' | 'gate' | 'reply-timer', outcome: TurnEndOutcome): TurnEndOutcome | undefined;
  settleOrphanedWorkerExecution(runId: string, opts?: { admitting?: boolean; fresh?: boolean; cwds?: CwdSource }): boolean;
  sendMessage(runId: string, content: PastedContent[], messageId?: string): boolean;
  canClaimInboxInput(runId: string, id: string): boolean;
  builtinSkills(): Skill[];
  continueRun(runId: string, opts?: ContinueRunOptions, deferForCapacity?: boolean, conversation?: Parameters<RunStore['commitWorkerContinuation']>[3]): { ok: boolean; error?: string };
  recover(familyRootId?: string): Promise<void>;
  dropActive(runId: string): void;
  runContinuation(runId: string, stepId: string, sessionId: string | undefined, backend: RunnerId, prompt: string, images?: PastedContent[], persistedImages?: ContentBlock[], persistedAttachments?: PersistedAttachment[]): Promise<void>;
  startRun(workflow: WorkflowDef, input: StartRunInput, clientRequest?: { id: string; hash: string }): RunRecord;
  execute(runId: string, workflow: WorkflowDef, input: StartRunInput, startAt?: number): Promise<void>;
  historyDeletionPending(runId: string): boolean;
  hasUnansweredHumanAsk(runId: string): boolean;
  cancelAutoResume(runId: string): boolean;
  rootFinishRequested(runId: string): boolean;
  registerWait(runId: string, request: CezarWaitRequestInput, via: WaitVia, generation: string, capabilitySignal?: AbortSignal): Promise<PrWaitEntry | TimerWaitEntry | WorkerWaitEntry | ProcessWaitEntry | PeerWaitEntry>;
  cancelWait(runId: string, waitId: string, generation: string): ReturnType<WaitRegistry['cancelWait']>;
  acceptDone(runId: string, generation: string, request: CezarDoneRequest, signal?: AbortSignal): CezarDoneAnswer;
  preview?: PreviewHostLike | undefined;
  cezarPort?: (() => number | undefined) | undefined;
}

/** Build modules in dependency order; callbacks read the facade at use time. */
export function composeRunModules(context: RunModuleContext, host: FacadeHost): RunModules {
  const modules = {} as RunModules;
  modules.workerScratchCleanup = new WorkerScratchCleanup(context.store, context.dataDir, id => host.isActive(id) || modules.workerExecutions.has(id) || modules.claims.has(id) || !!host.autosaveCleanupBlocker(id));
  modules.completionGateHost = {
    active: host.active,
    pendingHumanAskSeq: id => host.pendingHumanAskSeq(id),
    isActive: id => host.isActive(id),
    holdsAgentWaits: id => modules.humanWaits.holdsAgentWaits(id),
    waitingBeforeFinalWorkflowStep: run => host.waitingBeforeFinalWorkflowStep(run),
    parentCompletionBlockers: id => host.parentCompletionBlockers(id),
    unansweredQuestions: id => modules.workerQuestions.unansweredQuestions(id),
  };
  modules.inputReceiptSteps = {
    clearUnread: state => clearUnreadInputTimer(state), clearHeld: state => clearHeldHumanInputTimer(state),
    noteActivity: (id, state, event) => modules.turnNudges.noteNoWaitNudgeContent(id, state, event),
    persistAttachment: (id, mediaType, data) => modules.attachments.persistAttachment(id, mediaType, data),
    ready: (id, state, session) => modules.inputDelivery.handleAgentInputReady(id, state, session),
    pid: (id, pid) => { replaceRunProcess(id, pid); modules.workerExecutions.recordWorkerProcess(id, pid); },
    ui: (id, state, sink, event) => sessionEvents.handleRunnerUiEvent(context, modules.sessionHelperHost, id, state, sink, event),
    flushDeferred: id => modules.queuedInput.flushDeferred(id), recordProcess: (id, pid) => modules.workerExecutions.recordWorkerProcess(id, pid),
  };
  modules.inputReceiptHost = {
    reconcileWorkerWaits: () => host.reconcileWorkerWaits(),
    flushAgentInputs: id => modules.inputDelivery.flushAgentInputs(id),
    isCurrentState: (id, state) => host.active.get(id) === state,
  };
  modules.ciSessionHost = {
    active: host.active, ciResources: () => host.ciResources, cezarToolHandlers: (...args) => host.cezarToolHandlers(...args),
    preview: () => host.preview, cockpit: () => host.cockpit,
  };
  modules.launchSettingsHost = {
    active: host.active, setCockpit: address => { host.cockpit = address; },
    delegationProvisioner: () => host.delegationProvisioner, setProvisioner: provisioner => { host.delegationProvisioner = provisioner; },
    historyDeletionPending: id => host.historyDeletionPending(id),
  };

  function sessionEventHost(): import('./session-events.ts').SessionEventHost {
    return {
      disposedSessionEvent: (...args) => sessionEvents.disposedSessionEvent(context, modules.sessionHelperHost, ...args),
      handleReceiptEvent: (...args) => inputReceipts.handleReceiptEvent(context, modules.inputReceiptHost, modules.inputReceiptSteps, ...args),
      recordSessionFault: (...args) => sessionEvents.recordSessionFault(context, modules.sessionHelperHost, ...args),
      markTurnBoundary: (...args) => sessionEvents.markTurnBoundary(context, modules.sessionHelperHost, ...args),
      trackTurnEnd: (...args) => modules.turnBookkeeper.trackTurnEnd(...args),
      endTurn: (...args) => modules.turnSettler.endTurn(...args),
    };
  }

  function launchPreambleHost(): import('./session-events.ts').LaunchPreambleHost {
    return {
      provisionSession: (...args) => launchContext.provisionSession(modules.launchSettingsHost, ...args),
      agentWebhooksPart: () => launchContext.agentWebhooksPart(context, host.cockpit),
      provisionCiSession: (...args) => provisionCiSession(context, modules.ciSessionHost, ...args),
      launchStale: (...args) => sessionEvents.launchStale(context, modules.sessionHelperHost, ...args),
    };
  }

  modules.memoryGuard = new MemoryGuard(context, { active: host.active });
  modules.retries = new WakeRetries(context, {
    owesWake: run => modules.wakeAdmission.owesWake(run), queueWaitWake: id => modules.wakeAdmission.queueWaitWake(id),
    retryWaitAdmission: id => modules.retries.retryWaitAdmission(id),
  });
  modules.queuedRevivalHost = {
    move: (id, exit, patch) => host.move(id, exit, patch), isActive: id => host.isActive(id),
    workerExecutionStopped: id => host.workerExecutionStopped(id), ownedJob: run => modules.runStart.ownedJob(run),
    resumableSessionId: (id, step) => host.resumableSessionId(id, step), workerStep: (id, step) => launchContext.workerStep(context, id, step),
    toQueuedMessage: (id, content) => modules.queuedInput.toQueuedMessage(id, content), hydrateQueuedInput: (id, input) => modules.queuedInput.hydrateQueuedInput(id, input),
    enqueueJob: (id, job) => modules.line.enqueueJob(id, job), enqueueContinuation: (id, continuation) => modules.line.enqueueContinuation(id, continuation),
    isSyntheticContinuation: (run, step) => isSyntheticContinuation(run, step), restartContinuationPrompt: RESTART_CONTINUATION_PROMPT,
    reviveQueuedRun: (run, reason) => host.reviveQueuedRun(run, reason), reviveWorkflow: run => queuedRevival.reviveWorkflow(context, modules.queuedRevivalHost, run),
    checkpointRestartContext: (run, step) => queuedRevival.checkpointRestartContext(context, modules.queuedRevivalHost, run, step),
  };
  modules.line = new RunLine(context, {
    activeSize: () => host.active.size, activeHas: id => host.active.has(id),
    withExecutionAccount: run => modules.wakeAdmission.withExecutionAccount(run),
    maintenance: id => modules.claims.has(id) || !!host.autosaveCleanupBlocker(id),
    admitted: id => modules.workerExecutions.admitted(id), workerExecutionStopped: id => host.workerExecutionStopped(id),
    recovering: () => modules.recovery.recovering, recoveringRun: run => modules.recovery.recoveringRun(run),
    reconcileAutoResumes: () => modules.autoResumeScheduler.reconcileAutoResumes(), cancel: id => host.cancel(id),
    move: (id, patch) => host.move(id, 'fail-start', patch), beginWorkerExecution: id => modules.workerExecutions.beginWorkerExecution(id),
    admissionError: (error, fallback) => admissionError(error, fallback),
    admitQueuedWaitWake: id => modules.wakeAdmission.admitQueuedWaitWake(id),
    launchQueuedRun: (id, job, continuation) => modules.runStart.launchQueuedRun(id, job, continuation),
    reviveQueuedRun: (run, reason) => host.reviveQueuedRun(run, reason), pump: () => modules.line.pump(),
    busySlots: () => modules.line.busySlots(),
  });
  modules.workerQuestions = new WorkerQuestions(context, {
    active: id => host.active.get(id), deliverConversationInput: id => host.deliverConversationInput(id),
    chargeAutomaticWake: id => modules.wakeAdmission.chargeAutomaticWake(id), hasQueuedAgentInputs: id => modules.inputDelivery.hasQueuedAgentInputs(id),
    providerOwnsInboxInput: (id, inputId) => modules.inboxClaims.providerOwnsInboxInput(id, inputId), reconcileWorkerWaits: id => host.reconcileWorkerWaits(id),
    openHumanAlias: (id, state, via, card) => modules.humanWaits.openHumanAlias(id, state, via, card), prepareHumanAsk: state => modules.humanWaits.prepareHumanAsk(state),
    markHumanWaitSurfaced: (id, wait, card) => modules.humanWaits.markHumanWaitSurfaced(id, wait, card), withdrawCezarHumanWaits: id => modules.humanWaits.withdrawCezarHumanWaits(id),
    routeWorkerQuestion: id => modules.workerQuestions.routeWorkerQuestion(id), noticeParkedWorker: id => modules.workerQuestions.noticeParkedWorker(id),
    retireUnreadParentQuestion: (id, request) => modules.workerQuestions.retireUnreadParentQuestion(id, request),
    deleteUnreadInput: (id, input) => { host.active.get(id)?.unreadInputIds?.delete(input); },
    updatePendingHumanAsk: (id, value) => { const state = host.active.get(id); if (state) state.pendingHumanAsk = value; },
  }, MAX_AUTO_CONTINUES);
  modules.familyReconciler = new FamilyReconciler(context, {
    reapTerminalScratch: id => modules.runSettlement.reapTerminalScratch(id), cancelOpenWaits: id => modules.wakeAdmission.cancelOpenWaits(id),
    resolvePeerWaits: runs => modules.waitRegistry.resolvePeerWaits(runs),
    active: id => host.active.get(id), isActive: id => host.isActive(id), recoveringRun: run => modules.recovery.recoveringRun(run),
    cancel: id => host.cancel(id), armWait: (id, wait) => modules.waitWatches.armWait(id, wait),
    armWorkerDeadline: (id, wait, delay) => modules.waitWatches.armWorkerDeadline(id, wait, delay), disarmWait: id => host.disarmWait(id),
    resolveWait: (id, waitId, result, observed) => modules.waitRegistry.resolveWait(id, waitId, result, observed),
    retireSettledQuestions: id => modules.workerQuestions.retireSettledQuestions(id), fallbackRoutedQuestions: (id, reason) => modules.workerQuestions.fallbackRoutedQuestions(id, reason),
    reconcileWorkerWaits: id => host.reconcileWorkerWaits(id),
  });
  modules.waitWatches = new WaitWatches(context, {
    canProceedWithRun: (id, run) => host.canProceedWithRun(id, run), ciSupervisor: () => host.ciSupervisor,
    resolveWait: (id, waitId, result) => modules.waitRegistry.resolveWait(id, waitId, result),
    reconcileWorkerWaits: family => host.reconcileWorkerWaits(family),
    resolvePeerWait: (id, wait) => modules.waitRegistry.resolvePeerWait(id, wait), disarmWait: id => host.disarmWait(id),
    armWorkerDeadline: (id, wait, delay) => modules.waitWatches.armWorkerDeadline(id, wait, delay),
    settleWait: (id, waitId, result) => modules.waitWatches.settleWait(id, waitId, result), exitFileRoots: id => modules.waitWatches.exitFileRoots(id),
  });
  modules.waitRegistry = new WaitRegistry(context, {
    active: id => host.active.get(id), workerExecutionStopped: id => host.workerExecutionStopped(id),
    executionBlockedByRootFinish: run => host.executionBlockedByRootFinish(run), ciSupervisor: () => host.ciSupervisor,
    isParked: id => modules.line.isParked(id), countAutomaticWakes: id => modules.wakeAdmission.automaticWakes(id),
    reconcileWorkerWaits: family => host.reconcileWorkerWaits(family), noticeParkedWorkers: id => modules.workerQuestions.noticeParkedWorkers(id),
    canProceedWithRun: (id, run) => host.canProceedWithRun(id, run),
    exitFileRoots: (id, run) => modules.waitWatches.exitFileRoots(id, run), disarmWait: id => host.disarmWait(id),
    settleWait: (id, waitId, result) => modules.waitWatches.settleWait(id, waitId, result),
    withdrawCezarHumanWaits: id => modules.humanWaits.withdrawCezarHumanWaits(id), armWait: (id, wait) => modules.waitWatches.armWait(id, wait),
    parkOnWaits: (id, state) => modules.wakeAdmission.parkOnWaits(id, state), cancelAutomaticAtCap: (id, waits) => modules.wakeAdmission.cancelAutomaticAtCap(id, waits),
    reparkWithoutWaits: (id, state) => modules.wakeAdmission.reparkWithoutWaits(id, state), waitOnUserWithoutSession: id => modules.wakeAdmission.waitOnUserWithoutSession(id),
    queueWaitWake: id => modules.wakeAdmission.queueWaitWake(id), retryWaitAdmission: id => modules.retries.retryWaitAdmission(id),
  }, MAX_AUTO_CONTINUES);
  modules.humanWaits = new HumanWaits(context, { routeWorkerQuestion: id => modules.workerQuestions.routeWorkerQuestion(id) }, MAX_AUTO_CONTINUES);
  modules.sessionHelperHost = {
    active: host.active, line: modules.line, humanWaits: modules.humanWaits, inputReceiptHost: modules.inputReceiptHost,
    move: (...args) => host.move(...args),
    workerExecutionStopped: id => host.workerExecutionStopped(id),
    executionBlockedByRootFinish: run => host.executionBlockedByRootFinish(run),
    agentEnvForStep: (...args) => host.agentEnvForStep(...args),
    sessionContextFor: (...args) => launchContext.sessionContextFor(context, ...args),
    automationsPart: () => launchContext.automationsPart(host.cockpit),
    flushAgentInputs: id => modules.inputDelivery.flushAgentInputs(id),
    resumeParkedRun: (...args) => modules.inputDelivery.resumeParkedRun(...args),
    noteNoWaitNudgeContent: (...args) => modules.turnNudges.noteNoWaitNudgeContent(...args),
    parkedOnWorkers: id => modules.wakeAdmission.parkedOnWorkers(id),
    releaseSlot: () => modules.line.releaseSlot(),
    routeWorkerQuestion: id => modules.workerQuestions.routeWorkerQuestion(id),
  };
  modules.turnNudges = new TurnNudges(context, modules.humanWaits, modules.line, modules.completionGateHost, {
    active: host.active, move: (id, exit, patch) => host.move(id, exit, patch),
    workerExecutionStopped: id => host.workerExecutionStopped(id), executionBlockedByRootFinish: run => host.executionBlockedByRootFinish(run),
    countAutomaticWakes: id => modules.wakeAdmission.automaticWakes(id), hasQueuedAgentInputs: id => modules.inputDelivery.hasQueuedAgentInputs(id),
    submitAgentInput: (id, state, content) => modules.inputDelivery.submitAgentInput(id, state, content), resumeParkedRun: (id, state) => modules.inputDelivery.resumeParkedRun(id, state),
    chargeAutomaticWake: id => modules.wakeAdmission.chargeAutomaticWake(id), retryWaitAdmission: id => modules.retries.retryWaitAdmission(id), armIdleTimer: (id, state) => modules.turnSettler.armIdleTimer(id, state),
    openTurnEndHumanWait: (id, state, step, via, note) => modules.turnSettler.openTurnEndHumanWait(id, state, step, via, note),
    settledTurnOutcome: (id, entry, outcome) => host.settledTurnOutcome(id, entry, outcome), queueWaitWake: id => modules.wakeAdmission.queueWaitWake(id),
  }, MAX_AUTO_CONTINUES, COMPLETION_WILL_WAIT, host.noWaitNudgeReplyMs() ?? NO_WAIT_NUDGE_REPLY_MS);
  modules.worktreeAutosave = new WorktreeAutosave(context,
    { holdForMaintenance: ids => modules.claims.holdForMaintenance(ids),
      reapTerminalScratch: id => modules.runSettlement.reapTerminalScratch(id), releaseSlot: () => modules.line.releaseSlot(),
      saveWorktree: (id, state, reason) => modules.worktreeAutosave.saveWorktree(id, state, reason),
      trackTurn: (id, task) => modules.workerExecutions.trackTurn(id, task) },
  );
  modules.orphans = new WorkerOrphans(context,
    { holds: (id, admitting) => modules.workerExecutions.has(id) || host.active.has(id) || modules.line.hasStarting(id) || (!admitting && modules.line.hasQueued(id)),
      reapTerminalScratch: id => modules.runSettlement.reapTerminalScratch(id),
      settleOrphanedWorkerExecution: (id, opts) => host.settleOrphanedWorkerExecution(id, opts) },
  );
  modules.workerExecutions = new WorkerExecutions(context, modules.orphans,
    { maintenance: id => modules.claims.has(id) || !!host.autosaveCleanupBlocker(id),
      admissionError: message => new WorkerOrphanAliveError(message),
      settleOrphanedWorkerExecution: (id, opts) => host.settleOrphanedWorkerExecution(id, opts),
      reapTerminalScratch: id => modules.runSettlement.reapTerminalScratch(id), queueWaitWake: id => modules.wakeAdmission.queueWaitWake(id),
      retryWaitAdmission: id => modules.retries.retryWaitAdmission(id), releaseSlot: () => modules.line.releaseSlot() },
  );
  modules.automationToolsSlot = new AutomationToolsSlot(context,
    () => !!host.cockpit,
  );
  modules.claims = new MaintenanceClaims(context,
    { isActive: id => host.isActive(id), autosaveCleanupBlocker: id => host.autosaveCleanupBlocker(id),
      hasExecution: id => modules.workerExecutions.has(id), scheduleScratchCleanup: id => modules.workerScratchCleanup.schedule(id),
      holdForMaintenance: ids => modules.claims.holdForMaintenance(ids) },
  );
  modules.attachments = new AttachmentWriter(context,
    { persistAttachment: (id, mediaType, data, prefix) => modules.attachments.persistAttachment(id, mediaType, data, prefix) },
  );
  modules.queuedInput = new QueuedInput(context,
    { hasJob: id => modules.line.hasJob(id), hasContinuation: id => modules.line.hasContinuation(id), job: id => modules.line.job(id),
      canProceedWithRun: (id, run): run is RunRecord => host.canProceedWithRun(id, run),
      activeGet: id => host.active.get(id), startingHas: id => modules.line.hasStarting(id),
      persistPastedAttachments: (id, content) => modules.attachments.persistPastedAttachments(id, content),
      toQueuedMessage: (id, content) => modules.queuedInput.toQueuedMessage(id, content),
      sendMessage: (id, content, messageId) => host.sendMessage(id, content, messageId) },
  );
  modules.inboxClaims = new InboxClaims(context,
    { activeGet: id => host.active.get(id),
      executionBlockedByRootFinish: run => host.executionBlockedByRootFinish(run),
      workerExecutionStopped: id => host.workerExecutionStopped(id),
      reconcileWorkerWaits: () => host.reconcileWorkerWaits(), retireEmptyWake: id => modules.wakeAdmission.retireEmptyWake(id),
      deliverConversationInput: id => host.deliverConversationInput(id),
      settleIdleBoundary: (id, state, session) => modules.inputDelivery.settleIdleBoundary(id, state, session),
      releaseSlot: () => modules.line.releaseSlot(), providerOwnsInboxInput: (id, inputId) => modules.inboxClaims.providerOwnsInboxInput(id, inputId),
      canClaimInboxInput: (id, inputId) => host.canClaimInboxInput(id, inputId),
      armInboxClaimExpiry: id => modules.inboxClaims.armInboxClaimExpiry(id) },
  );
  modules.repoRootLease = new RepoRootLease(context,
    { park: id => { modules.line.park(id); }, unpark: id => { modules.line.unpark(id); },
      releaseSlot: () => modules.line.releaseSlot() },
  );
  modules.turnBookkeeper = new TurnBookkeeper(context,
    { isDisposedDelegatedRun: id => isDisposedDelegatedRun(context.store, () => context.disposed(), id), discoverSkills: () => modules.runSkills.discoverSkills(),
      reviveWorkflow: run => queuedRevival.reviveWorkflow(context, modules.queuedRevivalHost, run), trackTurn: (id, task) => modules.workerExecutions.trackTurn(id, task) },
  );
  modules.runSkills = new RunSkills(context,
    { builtinSkills: () => host.builtinSkills(), workerExecutionStopped: id => host.workerExecutionStopped(id),
      isCurrentState: (id, state) => host.active.get(id) === state, flushAgentInputs: id => modules.inputDelivery.flushAgentInputs(id) },
  );
  modules.stepSession = new StepSession(context, {
    workerExecutionStopped: id => host.workerExecutionStopped(id),
    executionBlockedByRootFinish: run => host.executionBlockedByRootFinish(run),
    trackWorkerSessionResult: (...args) => modules.workerExecutions.trackWorkerSessionResult(...args),
    workerStep: (...args) => launchContext.workerStep(context, ...args),
    beginUsageInvocation: (...args) => beginUsageInvocation(context.store, ...args),
    recordUsagePeaks: id => recordUsagePeaks(context.store, { isDisposedDelegatedRun: id => isDisposedDelegatedRun(context.store, () => context.disposed(), id) }, id),
  }, sessionEventHost(), launchPreambleHost(), modules.sessionHelperHost, modules.line,
  modules.runSkills, modules.humanWaits, modules.inputReceiptHost, modules.inputReceiptSteps);
  modules.autoResumeScheduler = new AutoResumeScheduler(context,
    { move: (id, exit, patch) => host.move(id, exit, patch),
      continueRun: (id, opts, defer) => host.continueRun(id, opts, defer), pump: () => modules.line.pump() },
  );
  modules.recovery = new RunRecovery(context, modules.familyReconciler,
    modules.workerQuestions, modules.autoResumeScheduler, {
      workerScratchCleanup: modules.workerScratchCleanup, humanWaits: modules.humanWaits,
      waitWatches: modules.waitWatches, inboxClaims: modules.inboxClaims, orphans: modules.orphans,
      isActive: (...args) => host.isActive(...args),
      workerExecutionStopped: (...args) => host.workerExecutionStopped(...args),
      move: (...args) => host.move(...args),
      cancel: (...args) => host.cancel(...args),
      continueRun: (...args) => host.continueRun(...args),
      reviveQueuedRun: (...args) => host.reviveQueuedRun(...args),
      requeueInterruptedRun: (...args) => queuedRevival.requeueInterruptedRun(context, modules.queuedRevivalHost, ...args),
      checkpointRestartContext: (...args) => queuedRevival.checkpointRestartContext(context, modules.queuedRevivalHost, ...args),
      deliverConversationInput: (...args) => host.deliverConversationInput(...args),
      answerRoutedQuestion: (...args) => modules.inputDelivery.answerRoutedQuestion(...args),
      queueWaitWake: (...args) => modules.wakeAdmission.queueWaitWake(...args),
      owesWake: (...args) => modules.wakeAdmission.owesWake(...args),
      cancelOpenWaits: (...args) => modules.wakeAdmission.cancelOpenWaits(...args),
      settleOrphanedWorkerExecution: (...args) => host.settleOrphanedWorkerExecution(...args),
      settleRequestedRootFinish: (...args) => modules.runFinish.settleRequestedRootFinish(...args),
      settleSuccess: (...args) => modules.runSettlement.settleSuccess(...args),
      reconcileWorkerWaits: (...args) => host.reconcileWorkerWaits(...args),
      pump: (...args) => modules.line.pump(...args),
      recover: (...args) => host.recover(...args),
    }, RESTART_CONTINUATION_PROMPT);
  modules.wakeAdmission = new WakeAdmission(context, {
    active: host.active, retries: modules.retries, line: modules.line, waitWatches: modules.waitWatches, waitRegistry: modules.waitRegistry,
    inboxClaims: modules.inboxClaims, workerQuestions: modules.workerQuestions, humanWaits: modules.humanWaits,
    isActive: id => host.isActive(id), move: (id, exit) => host.move(id, exit),
    recoveringRun: run => modules.recovery.recoveringRun(run),
    continueRun: (id, opts, defer) => host.continueRun(id, opts, defer), disarmWait: id => host.disarmWait(id),
    reconcileWorkerWaits: id => host.reconcileWorkerWaits(id), releaseSlot: () => modules.line.releaseSlot(),
    parkForUser: (id, state, step) => modules.turnSettler.parkForUser(id, state, step), armIdleTimer: (id, state) => modules.turnSettler.armIdleTimer(id, state),
    flushAgentInputs: id => modules.inputDelivery.flushAgentInputs(id), answerRoutedQuestion: (id, flush) => modules.inputDelivery.answerRoutedQuestion(id, flush),
    queueWaitWake: id => modules.wakeAdmission.queueWaitWake(id), retryWaitAdmission: id => modules.retries.retryWaitAdmission(id),
    countAutomaticWakes: (id, budget) => modules.wakeAdmission.automaticWakes(id, budget),
    workerExecutionStopped: id => host.workerExecutionStopped(id), executionBlockedByRootFinish: run => host.executionBlockedByRootFinish(run),
  }, MAX_AUTO_CONTINUES, MAX_WAKE_DELIVERY_ATTEMPTS);
  modules.continuationAcceptance = new ContinuationAcceptance(context, {
    isActive: id => host.isActive(id), move: (id, exit, patch) => host.move(id, exit, patch),
    ownedJob: run => modules.runStart.ownedJob(run), executionBlockedByRootFinish: run => host.executionBlockedByRootFinish(run),
    finishWorkerExecution: id => modules.workerExecutions.finishWorkerExecution(id), clearWakeBackoff: id => modules.retries.clearWakeBackoff(id),
    dropActive: id => host.dropActive(id), pump: () => modules.line.pump(),
    runContinuation: (...args) => host.runContinuation(...args), workerStep: (id, step) => launchContext.workerStep(context, id, step),
    isUntouchedCancelledRun: run => isUntouchedCancelledRun(run), admissionError: (error, fallback) => admissionError(error, fallback),
    isSyntheticContinuation: (run, step) => isSyntheticContinuation(run, step),
  }, modules.claims, modules.line, modules.workerExecutions, modules.queuedInput, modules.autoResumeScheduler,
  modules.worktreeAutosave, modules.workerQuestions, ROUTED_QUESTION_REFUSAL, RESTART_CONTINUATION_PROMPT);
  modules.runSettlement = new RunSettlement(context, modules.humanWaits, modules.workerQuestions,
    modules.worktreeAutosave, modules.turnBookkeeper, modules.line, modules.autoResumeScheduler, modules.workerExecutions,
    modules.completionGateHost, {
      active: host.active, isSyntheticContinuation: (run, step) => isSyntheticContinuation(run, step),
      generation: id => modules.continuationAcceptance.generation(id), isActive: id => host.isActive(id),
      move: (id, exit, patch) => host.move(id, exit, patch), dropActive: id => host.dropActive(id),
      saveWorktree: (id, state, reason) => modules.worktreeAutosave.saveWorktree(id, state, reason),
      settleSuccess: (id, durable, keep) => modules.runSettlement.settleSuccess(id, durable, keep),
      deferParentCompletion: id => modules.runFinish.deferParentCompletion(id),
      closingWakeDecision: (id, holds, cancelled, error) => modules.wakeAdmission.closingWakeDecision(id, holds, cancelled, error),
      owesDelivery: id => modules.wakeAdmission.owesDelivery(id), preserveRunAfterDisposal: (id, state) => preserveRunAfterDisposal(context.store, () => context.disposed(), id, state),
      isDisposedDelegatedRun: id => isDisposedDelegatedRun(context.store, () => context.disposed(), id), queueWaitWake: id => modules.wakeAdmission.queueWaitWake(id),
      reconcileWorkerWaits: id => host.reconcileWorkerWaits(id), releaseSlot: () => modules.line.releaseSlot(),
      workerScratchCleanup: modules.workerScratchCleanup, hasClaim: id => modules.claims.has(id),
      autosaveCleanupBlocker: id => host.autosaveCleanupBlocker(id),
      claimWorktreeReclaim: id => host.claimWorktreeReclaim(id), preview: host.preview,
      forgetMemoryPause: id => modules.memoryGuard.forgetMemoryPause(id),
    }, WAKE_SESSION_CLOSED_ERROR, WAKE_DELIVERY_CAP_NOTE);
  modules.continuationSession = new ContinuationSession(context, {
    move: (...args) => host.move(...args), dropActive: id => host.dropActive(id),
    isSyntheticContinuation: (run, step) => isSyntheticContinuation(run, step),
    beginUsageInvocation: (...args) => beginUsageInvocation(context.store, ...args),
    trackWorkerSessionResult: (...args) => modules.workerExecutions.trackWorkerSessionResult(...args),
    recordUsagePeaks: id => recordUsagePeaks(context.store, { isDisposedDelegatedRun: id => isDisposedDelegatedRun(context.store, () => context.disposed(), id) }, id),
    saveWorktree: (...args) => modules.worktreeAutosave.saveWorktree(...args), pump: () => modules.line.pump(),
    makeUiSink: (...args) => sessionEvents.makeUiSink(context, modules.sessionHelperHost, ...args),
    repositoryRootLockDisabled: () => repositoryRootLockDisabled(),
    prepareWorktree: (...args) => modules.stepLoop.prepareWorktree(...args),
    workerStep: (...args) => launchContext.workerStep(context, ...args),
    latchAgentInputError: (...args) => modules.inputDelivery.latchAgentInputError(...args),
    reconcileWorkerWaits: () => host.reconcileWorkerWaits(),
    holdContinuationForRootFinish: (...args) => modules.runFinish.holdContinuationForRootFinish(...args),
  }, modules.line, modules.sessionHelperHost, modules.repoRootLease, modules.worktreeAutosave, modules.runSkills,
  sessionEventHost(), launchPreambleHost(), modules.inputReceiptHost, modules.inputReceiptSteps,
  modules.humanWaits, modules.queuedInput, modules.workerQuestions, modules.runSettlement);
  modules.stepLoop = new WorkflowStepLoop(context, {
    active: host.active, move: (id, exit, patch) => host.move(id, exit, patch), dropActive: id => host.dropActive(id),
    closingWakeDecision: (id, holds, cancelled, error) => modules.wakeAdmission.closingWakeDecision(id, holds, cancelled, error),
    owesDelivery: id => modules.wakeAdmission.owesDelivery(id),
    workerExecutionStopped: id => host.workerExecutionStopped(id),
    executionBlockedByRootFinish: run => host.executionBlockedByRootFinish(run),
  }, modules.line, modules.worktreeAutosave, modules.humanWaits, modules.runSettlement, modules.stepSession,
  modules.completionGateHost, WAKE_SESSION_CLOSED_ERROR);
  modules.runStart = new RunStart(context, {
    active: host.active, startRun: (...args) => host.startRun(...args),
    execute: (...args) => host.execute(...args), runContinuation: (...args) => host.runContinuation(...args),
    move: (...args) => host.move(...args), dropActive: id => host.dropActive(id),
    historyDeletionPending: id => host.historyDeletionPending(id),
  }, modules.line, modules.attachments, modules.turnBookkeeper, modules.queuedInput, modules.continuationAcceptance, modules.workerExecutions);
  modules.turnSettler = new TurnSettler(context, {
    humanWaits: modules.humanWaits, line: modules.line, waitWatches: modules.waitWatches, waitRegistry: modules.waitRegistry,
    workerQuestions: modules.workerQuestions, completionGateHost: modules.completionGateHost,
    move: (id, exit) => host.move(id, exit), releaseSlot: () => modules.line.releaseSlot(), completionGate: id => modules.runFinish.completionGate(id),
    cancelOpenWaits: id => modules.wakeAdmission.cancelOpenWaits(id), countAutomaticWakes: id => modules.wakeAdmission.automaticWakes(id),
    workerExecutionStopped: id => host.workerExecutionStopped(id), executionBlockedByRootFinish: run => host.executionBlockedByRootFinish(run),
    submitAgentInput: (id, state, content) => modules.inputDelivery.submitAgentInput(id, state, content), flushAgentInputs: id => modules.inputDelivery.flushAgentInputs(id),
    hasQueuedAgentInputs: (id, except) => modules.inputDelivery.hasQueuedAgentInputs(id, except), armUnreadInputTimer: (id, state) => modules.inputDelivery.armUnreadInputTimer(id, state),
    armHeldHumanInputTimer: (id, state) => modules.inputDelivery.armHeldHumanInputTimer(id, state), parkOnWaits: (id, state) => modules.wakeAdmission.parkOnWaits(id, state),
    queueWaitWake: id => modules.wakeAdmission.queueWaitWake(id), leaveMonitoringPool: id => modules.wakeAdmission.leaveMonitoringPool(id), chargeAutomaticWake: id => modules.wakeAdmission.chargeAutomaticWake(id),
    canAutoContinue: (id, state) => modules.turnNudges.canAutoContinue(id, state), tryAutonomousNudge: (id, state, step, ask) => modules.turnNudges.tryAutonomousNudge(id, state, step, ask),
    sendTurnEndNudge: (id, state, step, text) => modules.turnNudges.sendTurnEndNudge(id, state, step, text),
    awaitCompletionNudgeReply: (id, state, session) => modules.turnNudges.awaitCompletionNudgeReply(id, state, session),
    noticeParkedWorker: id => modules.workerQuestions.noticeParkedWorker(id), routeWorkerQuestion: id => modules.workerQuestions.routeWorkerQuestion(id),
    settledTurnOutcome: (id, entry, outcome) => host.settledTurnOutcome(id, entry, outcome),
  }, IDLE_TIMEOUT_MS, MAX_AUTO_CONTINUES, COMPLETION_WILL_WAIT, SCHEDULE_WAKEUP_MAX_SECONDS);
  modules.runFinish = new RunFinish(context, modules.completionGateHost, modules.runSettlement, modules.turnSettler, modules.turnNudges, modules.line, {
    move: (id, exit, patch) => host.move(id, exit, patch), dropActive: id => host.dropActive(id),
    cancelOpenWaits: id => modules.wakeAdmission.cancelOpenWaits(id), reconcileWorkerWaits: id => host.reconcileWorkerWaits(id),
    executionBlockedByRootFinish: run => host.executionBlockedByRootFinish(run), hasUnansweredHumanAsk: id => host.hasUnansweredHumanAsk(id),
  });
  modules.runCancel = new RunCancel(context, modules.line, modules.workerExecutions, modules.wakeAdmission, modules.turnNudges, {
    active: host.active, cancel: id => host.cancel(id), isActive: id => host.isActive(id),
    cancelAutoResume: id => host.cancelAutoResume(id), rootFinishRequested: id => host.rootFinishRequested(id),
    historyDeletionPending: id => host.historyDeletionPending(id), disarmWait: id => host.disarmWait(id),
    move: (id, exit, patch) => host.move(id, exit, patch),
  });
  modules.inputDelivery = new InputDelivery(context, {
    active: host.active, line: modules.line, workerExecutions: modules.workerExecutions, runSkills: modules.runSkills,
    attachments: modules.attachments, humanWaits: modules.humanWaits, workerQuestions: modules.workerQuestions,
    waitRegistry: modules.waitRegistry, inputReceiptHost: modules.inputReceiptHost,
    isActive: id => host.isActive(id), move: (id, exit) => host.move(id, exit),
    canProceedWithRun: (id, run) => host.canProceedWithRun(id, run),
    workerExecutionStopped: id => host.workerExecutionStopped(id), executionBlockedByRootFinish: run => host.executionBlockedByRootFinish(run),
    hasUnansweredHumanAsk: id => host.hasUnansweredHumanAsk(id), countAutomaticWakes: (id, budget) => modules.wakeAdmission.automaticWakes(id, budget),
    recoveringRun: id => modules.recovery.recoveringRun(id), continueRun: (id, opts, defer) => host.continueRun(id, opts, defer),
    parkForUser: (id, state, step) => modules.turnSettler.parkForUser(id, state, step), settleTurn: (id, state, entry, turn) => modules.turnSettler.settleTurn(id, state, entry, turn),
    boundaryTurn: (id, state, session, done) => modules.turnSettler.boundaryTurn(id, state, session, done),
    canAutoContinue: (id, state) => modules.turnNudges.canAutoContinue(id, state), armNoWaitNudgeReplyTimer: (id, state) => modules.turnNudges.armNoWaitNudgeReplyTimer(id, state),
    awaitCompletionNudgeReply: (id, state, session) => modules.turnNudges.awaitCompletionNudgeReply(id, state, session),
    queueWaitWake: id => modules.wakeAdmission.queueWaitWake(id), owesWake: (run, budget) => modules.wakeAdmission.owesWake(run, budget),
    pendingConversationWakes: (run, budget) => modules.wakeAdmission.pendingConversationWakes(run, budget), routedAnswer: id => modules.wakeAdmission.routedAnswer(id),
    spendWakeAdmission: (id, state, owed) => modules.wakeAdmission.spendWakeAdmission(id, state, owed), cancelAutomaticAtCap: (id, waits) => modules.wakeAdmission.cancelAutomaticAtCap(id, waits),
    reparkWithoutWaits: (id, state) => modules.wakeAdmission.reparkWithoutWaits(id, state), holdPeerWakesAtCap: id => modules.wakeAdmission.holdPeerWakesAtCap(id),
    reconcileWorkerWaits: () => host.reconcileWorkerWaits(), unreadInputGraceMs: () => host.unreadInputGraceMs(),
    submitAgentInput: (id, state, content, inputs, budget) => modules.inputDelivery.submitAgentInput(id, state, content, inputs, budget),
  }, MAX_AUTO_CONTINUES, ROUTED_QUESTION_REFUSAL);
  modules.cezarToolsHost = { store: context.store,
    registerWait: (...args) => host.registerWait(...args), registerAsk: (...args) => modules.waitRegistry.registerAsk(...args),
    cancelWait: (...args) => host.cancelWait(...args), acceptDone: (...args) => host.acceptDone(...args),
    registerPreviewServer: (...args) => registerPreviewServer(context.store, host.preview, host.cezarPort, () => context.disposed(), ...args), stopPreviewServer: (...args) => stopPreviewServer(context.store, host.preview, host.cezarPort, () => context.disposed(), ...args),
    awaitAutomationTools: signal => modules.automationToolsSlot.awaitAutomationTools(signal) };
  return modules;
}
