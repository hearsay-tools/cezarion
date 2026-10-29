import { TurnSettler } from './run/turn-settler.ts';
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
  SettledTurn, DelegationExecutionSettings, StartRunInput, PendingContinuation, ExecutionEmit,
  Execution, ExecutionLaunch, StepLoop, SessionTurn, LaunchDelegation,
  LaunchCiTools, LaunchOpening, StepProfile, StepSessionLaunch,
  WorkerDelegationRecord, ContinuationOpening, OpeningAnswer, ContinuationSettings, ContinuationSkills,
  ContinuationSessionLaunch, ContinuationClose, WorkerTerminationBlocker, AutomationToolService,
} from './run/types.ts';
export type { TurnTail, DelegationExecutionSettings, StartRunInput, WorkerTerminationBlocker, AutomationToolService } from './run/types.ts';
import { openCompletionRequests, recordRequestRefusal, repairFailedRootFinish, startCompletionCycle, settledRootFinishPatch, type CompletionRefusal } from './completion-policy.ts';
import * as continuation from './continuation-admission.ts';
import type { ContinueRunOptions } from './continuation-admission.ts';
import { workerEvidenceRunIds } from '../runs/worker-execution.ts';
import { doneErrorMessage } from '../ci-wait/errors.ts';
import { cezarDoneRequestSchema, type CezarAskRequest, type CezarDoneAnswer, type CezarDoneRequest, type CezarWaitRequestInput, type DoneErrorCode, type PeerWaitEntry, type PeerWaitResult, type PrWaitEntry, type ProcessWaitEntry, type ProcessWaitResult, type HumanWaitEntry, type TimerWaitEntry, type Wait, type WaitVia, type WorkerWaitEntry, computeWaitingOn, hasWorkerDeadline, workerWaitEntryToLegacy, type DeadlinedWorkerWaitEntry, isUsageLimitHold } from '@open-mercato/cezar-contract/waits';
import { type CiWaitResult } from '@open-mercato/cezar-contract/ci-wait';
import { type PreviewStopRequest, type PreviewStopResult, type PreviewServeRequest, type PreviewServeResult } from '@open-mercato/cezar-contract/preview';
import { NO_WAIT_NUDGE_NOTE, NO_WAIT_NOTE, NO_WAIT_NO_REPLY_NOTE, COMPLETION_NO_REPLY_NOTE, WORKER_FALLBACK_NOTE, WORKER_FALLBACK_REPLY_NOTE, COMPLETION_NUDGE_NOTE, AUTONOMOUS_ASK_NOTE, AUTONOMOUS_NUDGE, stepScopedNudge, type TurnEndOutcome } from './turn-end.ts';
import { createActiveRun, type ActiveRun } from './active-run.ts';
import { isRunnerActivity } from './run/turn-markers.ts';
export { claudeScheduleWakeupDelay, appendTurnText, trackTurnTail, classifyTurnEnd } from './run/turn-markers.ts';
import { familyOf, canProceedWithRun, executionBlockedByRootFinish, historyDeletionPending, rootFinishRequested, isDisposedDelegatedRun, preserveRunAfterDisposal } from './run/run-guards.ts';
import { beginUsageInvocation, recordUsageUiEvent, recordUsagePeaks } from './run/usage-accounting.ts';
import { continuationModel, continuationEffort, continuationRunner, taskModelIdentity, stepModel } from './run/launch-settings.ts';
import { executionBaseRef, openExecutionWorktree, ownedContinuationWorkspace, executionSeedFiles, REPOSITORY_ROOT_LOCK_DISABLED_NOTE } from './run/run-workspace.ts';
import * as inputReceipts from './run/input-receipts.ts';
import { AutoResumeScheduler } from './run/auto-resume.ts';
export { AUTO_RESUME_GRACE_MS, MAX_AUTO_RESUMES, AUTO_RESUME_MISSED_WINDOW_MS } from './run/auto-resume.ts';
import type { RunModuleContext } from './run/types.ts';
import { createSessionEventHandler, launchPreamble } from './run/session-events.ts';
import * as launchContext from './run/launch-context.ts';
import { continuationOpening, openingInputs } from './run/opening.ts';
import { releaseActiveResources } from './run/drop-active.ts';
import { agentDirectories, applyTemplate, composeSystemPrompt, expandRegistrySlashSkillText, leadingSlashSkillName, resolveExtraSystemPrompt, skillSystemPrompt, withResumeContext } from './run/prompts.ts';
import { delegationExecutionSettings, selectDelegationExecutionSettings } from '../delegation/execution-settings.ts';
import { stepLabel, stepScope } from './run/steps.ts';
import { makeRunTitle } from '../runs/run-title.ts';
export { agentDirectories, composeSystemPrompt, expandRegistrySlashSkill, expandRegistrySlashSkillText, leadingSlashSkillName, resolveExtraSystemPrompt, skillSystemPrompt } from './run/prompts.ts';
export { stepLabel } from './run/steps.ts';
export { makeRunTitle } from '../runs/run-title.ts';
import { clearUnreadInputTimer, clearHeldHumanInputTimer, clearIdleTimer, clearAutosaveTimer } from './run/input-timers.ts';
import * as stepDecisions from './run/step-decisions.ts';
import * as pendingAskFacts from './run/pending-ask-facts.ts';
import * as workflowPosition from './run/workflow-position.ts';
import { RUN_EXITS, transition, transitionVia, type RunExitId } from './run-states.ts';
import { accountHeldFor, deriveAccountHolds, queuedRecoveryInput } from './run-scheduling.ts';
export { runAccountKey } from './run-scheduling.ts';
import { holdsOwedResults, isCezarHumanWait, openWaitList, openWaits, openWaitsFooter, resolvedWaits } from './waits.ts';
import { runsAwaitingPeer } from './wait-scope.ts';
import { previewCdpSession, previewRunContext, type PreviewHostLike } from '../preview/registration.ts';
import { acquireCiResources } from '../ci-wait/resources.ts';
import { artifactInstructions } from '../artifacts/lifecycle.ts';
import type { CiWatcherSupervisor } from '../ci-wait/supervisor.ts';
import type { CezarToolHandlers } from '../ci-wait/controller.ts';
import { workerIdentity, continuationDefStep, ownedWorkflow, workerStepIdentity, WorkerIdentityError, type WorkerAccountBinding, type WorkerStepIdentity } from '../delegation/execution-identity.ts';
import type { DelegationProvisioner } from '../delegation/provision.ts';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { AskRequest } from '../core/ask.ts';
import { type AgentSession } from '../core/claude-cli-runner.ts';
import { onUsage, replaceRunProcess, type ProcessUsage } from '../core/process-usage.ts';
import { type ExitFileRoots } from '../process-wait/exit-file.ts';
import { WorkerScratchCleanup } from '../delegation/scratch-cleanup.ts';
import { ORPHAN_BACKOFF, WAKE_RETRY_BACKOFF, type Backoff } from '../delegation/retry-backoff.ts';
import { type CwdSource } from '../delegation/process-liveness.ts';
import { parseUsageLimit } from '../core/usage-limit.ts';
import { startManagedSession } from '../core/managed-session.ts';
import { createRunner } from '../core/runner-factory.ts';
import type { RunnerId } from '../core/agent-runner.ts';
import { agentModelsLocked } from '../core/agent-model-policy.ts';
import {
  handoffInstructions,
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
import { contentBlocksOf, pastedAttachmentsText, toPastedContent, type FileBlock, type PastedContent, type PersistedAttachment } from './pasted-content.ts';
export { contentBlocksOf, highestImageSeq, mediaTypeFor, pastedAttachmentsNote, pastedAttachmentsText, toPastedContent, type FileBlock, type PastedContent, type PersistedAttachment } from './pasted-content.ts';
import { askPayloadOf, askRequestOf } from '@open-mercato/cezar-contract/pending-ask';
import type { AgentEvent, ContentBlock, ToolGrant } from '../core/agent-runner.ts';
import { inputDeliveryOf } from '../core/agent-runner.ts';
import { readProjectUiState } from '../ui-state.ts';
import { discoverSkills, type Skill } from '../skills.ts';
import { waitForCachedTeamSkills, waitForTeamSkills } from '../skills-remote.ts';
import { seedAgentConfigLocalLayer } from '../agent-config/seed.ts';
import { readAgentModelSettings } from '../agent-config/models.ts';
import { loadConfig, resolveWorktreeRetention } from '../config.ts';
import { type AutosaveReason } from '../git-worktree.ts';
import { runGroupedCommand } from './grouped-command.ts';
import {
  resolveWorktreeSetup,
  runWorktreeSetup,
  worktreeSetupAgentNote,
  worktreeSetupEndNote,
  worktreeSetupEnv,
  worktreeSetupRecordError,
  worktreeSetupStartNote,
  type WorktreeSetupOutcome,
} from '../worktree-setup.ts';
import { getHeadCommit, getRepoInfo } from '../server/git.ts';
import { enqueueAgentInput, hasLiveInboxClaim } from '../delegation/input.ts';
import { DelegationPolicyError } from '../delegation/policy.ts';
import { projectConversationEvents, settledRunFamilies } from '../delegation/conversations.ts';
import * as queuedRevival from './run/queued-revival.ts';
import type { RunOutcome } from '../runs/outcome-commit.ts';
import { RUN_IN_USE_ELSEWHERE, type CommitSource, type QueuedMessage, type RunRecord, type RunStore, type StepState } from '../runs/store.ts';
import { reclaimWorktrees, rematerializeReclaimedWorktree } from '../runs/retention.ts';
import {
  AgentTempDirError,
  agentTmpEnv,
  removeAgentTmpDir,
} from '../runs/agent-tmpdir.ts';
import { extractTaskRefs, refineTaskRefs } from '../runs/task-refs.ts';
import { AgentAccountUnavailableError, resolveProfileEnvForRoot } from '../workspace/agent-profiles.ts';
import { WorkspaceSemaphore, type AccountHolds } from '../workspace/semaphore.ts';
import { UiEventSink } from '../runs/ui-event-sink.ts';
import type { UiEvent } from '../core/ui-events.ts';
import {
  QUICK_TASK_WORKFLOW,
  chainStepNote,
  stepKind,
  stepToolGrant,
  toolGrantLists,
  type WorkflowDef,
  type WorkflowStepDef,
} from './types.ts';

const CHECK_OUTPUT_CAP = 20_000;

/** An interactive session that hears nothing from the user closes itself. */
export const IDLE_TIMEOUT_MS = 15 * 60_000;
import { PROSE_HUMAN_GATE } from '../runs/transcript-facts.ts';
/** #505: a worker question routed to its parent is answered there until it falls back. */
const ROUTED_QUESTION_REFUSAL = 'This question was sent to the parent task; answer it there.';
function isSyntheticContinuation(run: RunRecord, step: StepState): boolean {
  if (step.synthetic === 'continuation') return true;
  // Legacy records predate explicit provenance. Only an accepted continuation's
  // durable message links its generated step; an ID prefix alone is never identity.
  return (run.continuationMessage?.id === step.id ||
    (!!run.workflowDef && !run.workflowDef.steps.some(candidate => candidate.id === step.id) &&
      step.kind === 'agent' && step.name === 'Continue')) && /^continue-\d+$/.test(step.id);
}
export { CHECK_KILL_GRACE_MS, CHECK_TERMINATION_CONFIRM_MS } from './grouped-command.ts';
export { periodicAutosaveEnabled, AUTOSAVE_INTERVAL_MS } from './run/worktree-autosave.ts';

/**
 * Explicitly opt out of the repository-root lease for runs that execute in the
 * current checkout. This covers explicit worktree opt-out, non-Git degradation,
 * and continuations whose worktree cannot be restored (spec 006 hardening, #438).
 * This is intentionally unsafe: concurrent agents may overwrite each other's
 * files or Git state. Isolated worktree runs are unaffected.
 */
export function repositoryRootLockDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CEZ_DISABLE_REPO_LOCK === '1';
}

/** #505: a real steer is read at the harness's next model step; a quiet boundary this long
 * with input still unread means the harness will not read it without help. */
export const UNREAD_INPUT_GRACE_MS = 30_000;
/** #486: recheck a turn-end that deferred close/park only because the harness still held a human follow-up. */
export { HELD_HUMAN_INPUT_RECHECK_MS } from './run/input-delivery.ts';

/** Bound a no-wait nudge that is ACKed but never produces a turn (#544,
 *  hearsay-tools/cezarion#1234). OpenCode heartbeats re-arm the managed-session no-progress
 *  guard, so this is the DEFAULT-path exit when the agent stays silent. Overridable on RunManager. */
export const NO_WAIT_NUDGE_REPLY_MS = 5 * 60_000;
export { WORKER_FALLBACK_QUESTION, WORKER_FALLBACK_HEADER } from './run/worker-questions.ts';
/** A root's done blocked at a turn end is answered with the refusal `cezar_done` gives, as one
 *  automatic turn (hearsay-tools/cezarion#1301). The nudge adds this sentence when live workers block
 *  it; the mid-turn answer never does. */
export const COMPLETION_WILL_WAIT = 'If you end your turn with done again while these workers are live, Cezar will wait on them for you and wake you when they have all settled.';
/** Bound one unattended session; an explicit Continue starts a new budget. */
export const MAX_AUTO_CONTINUES = 40;
/** Claude's `ScheduleWakeup` accepts at most an hour (hearsay-tools/cezarion#1233). */
const SCHEDULE_WAKEUP_MAX_SECONDS = 3600;
export { AUTONOMOUS_NUDGE, NO_WAIT_NUDGE_NOTE, NO_WAIT_NOTE, NO_WAIT_NO_REPLY_NOTE, COMPLETION_NO_REPLY_NOTE, WORKER_FALLBACK_NOTE, WORKER_FALLBACK_REPLY_NOTE, COMPLETION_NUDGE_NOTE, AUTONOMOUS_ASK_NOTE };

/**
 * Consecutive failed automatic attempts to deliver a run's wait results (hearsay-tools/cezarion#1233):
 * each is a session that failed, or closed cleanly, while the results were still owed, counted across
 * the replacement sessions that retry them. At the bound the run settles `failed` and keeps the
 * results for a human. The count is in memory, per manager, so a restart starts it again, like the
 * per-session wake budget. A delivery acknowledgement, human input, Continue, Stop, Finish and
 * cancel reset it; a usage-limit failure is not counted, because its own hold and automatic resume
 * take it.
 */
export const MAX_WAKE_DELIVERY_ATTEMPTS = 3;
export const WAKE_DELIVERY_CAP_NOTE = `could not deliver wait results after ${MAX_WAKE_DELIVERY_ATTEMPTS} attempts — continue this task to retry`;
/** The error of a session that closed cleanly while it still owed wait results. */
export const WAKE_SESSION_CLOSED_ERROR = 'the session closed before the wait results were delivered';
/** Stop on a failed run that held wait results: the results and the open waits are gone. */
export const WAITS_DISCARDED_NOTE = 'Stop discarded the waits this task held and their results; the task stays failed';
/** Stop on a failed run that only owed a completion refusal (hearsay-tools/cezarion#1301). */
export const REFUSAL_DISCARDED_NOTE = 'Stop discarded the completion refusal this task still owed; the task stays failed';

/**
 * How often the queue checks that it is not wedged.
 *
 * A hold is the only thing in the engine that can make an idle queue CORRECT, so it is also the
 * only thing that can make a wedged one look correct. This tick is the way out: cheap (a few
 * in-memory checks), unref'd, and it only ever acts when idling has no justification left.
 */
export const QUEUE_WATCHDOG_MS = 60_000;

const RESTART_CONTINUATION_PROMPT =
  'The cezar process restarted while you were working on this task. Read the handoff file (CEZ_HANDOFF_FILE) to recover context, then continue the task from where you left off.';

/** What re-reading a message's persisted attachments yields: viewable blocks for the images, and
 *  a path for every attachment including the files that have no block. */
interface PersistedAttachments {
  blocks: ContentBlock[];
  attachments: PersistedAttachment[];
}

/** Only an original workflow that has never executed may return to its queue. */
export function isUntouchedCancelledRun(run: RunRecord): boolean {
  return run.status === 'cancelled' && !run.startedAt && !!run.workflowDef &&
    run.steps.every(step => step.status === 'pending' && !step.startedAt && !step.sessionId);
}

/** #469: admission refused because a process of the previous generation still runs. */
class WorkerOrphanAliveError extends Error {}
const admissionError = (error: unknown, fallback: string) => error instanceof WorkerOrphanAliveError ? error.message : fallback;

/** Only the synchronous delivery of a human answer uses the budget its reset replaced. */
type HumanAnswerBudget = { spent: number };
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
  private readonly inputReceiptContext: RunModuleContext;
  private readonly sessionHelperHost: sessionEvents.SessionHelperHost;
  private readonly completionGateHost: completionGateReads.CompletionGateHost = {
    active: this.active,
    pendingHumanAskSeq: id => this.pendingHumanAskSeq(id),
    isActive: id => this.isActive(id),
    holdsAgentWaits: id => this.holdsAgentWaits(id),
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
  private get waitTimers() { return this.waitWatches.waitTimers; }
  private get ciWatches() { return this.waitWatches.ciWatches; }
  private readonly inputReceiptSteps: inputReceipts.InputReceiptSteps = {
    clearUnread: state => this.clearUnreadInputTimer(state), clearHeld: state => this.clearHeldHumanInputTimer(state),
    noteActivity: (id, state, event) => this.noteNoWaitNudgeContent(id, state, event),
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
  // Queue + `starting` set (spec 006, janitor's pump() pattern): `starting`
  // covers the window between shifting a run off the queue and the run
  // registering in `active`, so parallel-slot counting is never racy.
  private readonly line: RunLine;
  private get queue() { return this.line.queue; }
  private readonly worktreeAutosave: WorktreeAutosave;
  private readonly workerExecutions: WorkerExecutions;
  private get executions() { return this.workerExecutions.executions; }
  private beginWorkerExecution(id: string, admitted = true) { this.workerExecutions.beginWorkerExecution(id, admitted); }
  private finishWorkerExecution(id: string) { return this.workerExecutions.finishWorkerExecution(id); }
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
  private orphanAdmissionRefusal(runId: string): string | undefined { return this.orphans.orphanAdmissionRefusal(runId); }
  private async reapOrphanedWorker(runId: string, timeoutMs: number): Promise<void> { return this.orphans.reapOrphanedWorker(runId, timeoutMs); }
  private async terminateFinishedWorkerGroups(runId: string, timeoutMs: number): Promise<void> { return this.orphans.terminateFinishedWorkerGroups(runId, timeoutMs); }

  private trackTurnEnd(runId: string, text: string): void {
    const task = this.recordTurnEnd(runId, text);
    this.workerExecutions.trackTurn(runId, task);
  }

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

  private get starting() { return this.line.starting; }
  /** Runs whose worktree a reclaim, or whose branch a delete, is removing right now
   *  (`claimWorktreeReclaim`, `claimForBranchCleanup`). `continueRun` refuses them. */
  private readonly claims: MaintenanceClaims;
  private get reclaiming(): Set<string> { return this.claims.reclaiming; }
  // Runs parked at `waiting` (open session, ball in the user's court). They
  // don't consume a `maxParallel` slot (#347) — an idle claude process costs
  // memory but no tokens, queued work progressing matters more, and the idle
  // timeout already bounds how long a session can sit open. Invariant:
  // `waiting ⊆ active` — always cleared together via dropActive().
  private get waiting() { return this.line.waiting; }
  /** Durable monitoring subset. Only the configured number receives the waiting-slot exemption. */
  private get monitoring() { return this.line.monitoring; }
  /** A run whose resolved waits wait for a wake (hearsay-tools/cezarion#1233). Separate from
   *  human waiting: these resumes MUST reacquire scheduler capacity. Keyed by run id. */
  private get waitWakeQueuedAt() { return this.line.waitWakeQueuedAt; }
  private get waitWakeAdmitted() { return this.line.waitWakeAdmitted; }
  /** CI lookups in flight, keyed by run id and normalized PR URL: two PRs may register at once. */
  private get ciRegistrations() { return this.waitRegistry.ciRegistrations; }
  private readonly wakeAdmission: WakeAdmission;
  private readonly retries: WakeRetries;
  private get wakeRetries() { return this.retries.wakeRetries; }
  private get wakeBackoffs() { return this.retries.wakeBackoffs; }
  // Private and overridable so tests need not wait out production cadence.
  private wakeRetryBackoff: Backoff = WAKE_RETRY_BACKOFF;
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
  private get inboxClaimTimers() { return this.inboxClaims.inboxClaimTimers; }
  /** What the recovery in progress covers: every run at boot (`family` undefined), or the one
   *  family an adoption hands it (#779, plan step 3). Undefined: no recovery in progress. */
  private recoveryScope: { family?: string } | undefined;
  /** Settles when the recovery in progress (if any) has finished. */
  private recoveryInFlight: Promise<void> | undefined;
  /** Adoptions of dead processes' runs, one at a time (`adoptOrphanedRun`). */
  private adoptionTail: Promise<unknown> = Promise.resolve();
  /** Quiet window before unread input is resubmitted or left unconfirmed (#505). */
  private readonly unreadInputGraceMs: number;
  /** Quiet window after a final-message nudge before a still-silent session parks (#544). */
  private readonly noWaitNudgeReplyMs: number;
  private disposed = false;

  /** Whether any recovery is in progress: one at a time (`recover`), and `pump` waits for it. */
  private get recovering(): boolean {
    return this.recoveryScope !== undefined;
  }

  /**
   * Whether a recovery in progress holds this run, so its wakes, input flushes and delegation
   * reconciles wait for that recovery's own passes: every run during boot recovery, and only the
   * adopted family's during a recovery scoped to one. The rest of a running project stays live: a
   * wake held back for an unrelated family would be lost, since the scoped passes never revisit it.
   */
  private recoveringRun(run: RunRecord | string | undefined): boolean {
    const scope = this.recoveryScope;
    if (!scope) return false;
    if (scope.family === undefined) return true;
    const record = typeof run === 'string' ? this.store.getRun(run) : run;
    return record !== undefined && familyOf(record) === scope.family;
  }

  private readonly onDelegationRun = (run: RunRecord, source?: CommitSource): void => {
    // Delegation metadata checkpoints do not change task status.
    // A republish changed nothing durable: there is nothing to reap, cancel or reconcile.
    if (source === 'live-release') return;
    if (!this.disposed && source === undefined) this.reapTerminalScratch(run.id);
    if (!this.disposed && !['queued', 'running', 'waiting'].includes(run.status) && !holdsOwedResults(run)) this.cancelOpenWaits(run.id);
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
  private get pendingJobs() { return this.line.pendingJobs; }
  /** Interrupted agent turns recovered after a process restart. Unlike an
   *  explicit user Continue, these are bulk scheduler work and must re-enter
   *  through `pump()` so both workspace and per-project caps are honored. */
  private get pendingContinuations() { return this.line.pendingContinuations; }
  /** Accepted Continues supersede in-flight settlement even before launch or after
   * idle close. Retain these across dropActive/dispose so absence cannot look like
   * the earlier execution again; disposal alone never revokes terminal intent. */
  private readonly continuationGenerations = new Map<string, symbol>();
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
    options: { semaphore?: WorkspaceSemaphore; unreadInputGraceMs?: number; noWaitNudgeReplyMs?: number; preview?: PreviewHostLike | undefined; cezarPort?: (() => number | undefined) | undefined; cockpit?: { origin: string; projectId: string } | undefined } = {},
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
    this.inputReceiptContext = { store, repoRoot, dataDir: this.dataDir, semaphore: this.semaphore, disposed: () => this.disposed };
    this.retries = new WakeRetries(this.inputReceiptContext, {
      owesWake: run => this.owesWake(run), queueWaitWake: id => this.queueWaitWake(id),
      retryWaitAdmission: id => this.retryWaitAdmission(id), wakeRetryBackoff: () => this.wakeRetryBackoff,
    });
    this.queuedRevivalHost = {
      move: (id, exit, patch) => this.move(id, exit, patch), isActive: id => this.isActive(id),
      workerExecutionStopped: id => this.workerExecutionStopped(id), ownedJob: run => this.ownedJob(run),
      resumableSessionId: (id, step) => this.resumableSessionId(id, step), workerStep: (id, step) => this.workerStep(id, step),
      toQueuedMessage: (id, content) => this.toQueuedMessage(id, content), hydrateQueuedInput: (id, input) => this.hydrateQueuedInput(id, input),
      enqueueJob: (id, job) => this.line.enqueueJob(id, job), enqueueContinuation: (id, continuation) => this.line.enqueueContinuation(id, continuation),
      isSyntheticContinuation: (run, step) => isSyntheticContinuation(run, step), restartContinuationPrompt: RESTART_CONTINUATION_PROMPT,
      reviveQueuedRun: (run, reason) => this.reviveQueuedRun(run, reason), reviveWorkflow: run => this.reviveWorkflow(run),
      checkpointRestartContext: (run, step) => this.checkpointRestartContext(run, step),
    };
    this.line = new RunLine(this.inputReceiptContext, {
      activeSize: () => this.active.size, activeHas: id => this.active.has(id),
      withExecutionAccount: run => this.withExecutionAccount(run),
      maintenance: id => this.claims.has(id) || !!this.autosaveCleanupBlocker(id),
      admitted: id => this.workerExecutions.admitted(id), workerExecutionStopped: id => this.workerExecutionStopped(id),
      recovering: () => this.recovering, recoveringRun: run => this.recoveringRun(run),
      reconcileAutoResumes: () => this.reconcileAutoResumes(), cancel: id => this.cancel(id),
      move: (id, patch) => this.move(id, 'fail-start', patch), beginWorkerExecution: id => this.beginWorkerExecution(id),
      admissionError: (error, fallback) => admissionError(error, fallback),
      admitQueuedWaitWake: id => this.admitQueuedWaitWake(id),
      launchQueuedRun: (id, job, continuation) => this.launchQueuedRun(id, job, continuation),
      reviveQueuedRun: (run, reason) => this.reviveQueuedRun(run, reason), pump: () => this.pump(),
      busySlots: () => this.busySlots(),
    });
    this.workerQuestions = new WorkerQuestions(this.inputReceiptContext, {
      active: id => this.active.get(id), deliverConversationInput: id => this.deliverConversationInput(id),
      chargeAutomaticWake: id => this.chargeAutomaticWake(id), hasQueuedAgentInputs: id => this.hasQueuedAgentInputs(id),
      providerOwnsInboxInput: (id, inputId) => this.providerOwnsInboxInput(id, inputId), reconcileWorkerWaits: id => this.reconcileWorkerWaits(id),
      openHumanAlias: (id, state, via, card) => this.openHumanAlias(id, state, via, card), prepareHumanAsk: state => this.prepareHumanAsk(state),
      markHumanWaitSurfaced: (id, wait, card) => this.markHumanWaitSurfaced(id, wait, card), withdrawCezarHumanWaits: id => this.withdrawCezarHumanWaits(id),
      routeWorkerQuestion: id => this.routeWorkerQuestion(id), noticeParkedWorker: id => this.noticeParkedWorker(id),
      retireUnreadParentQuestion: (id, request) => this.retireUnreadParentQuestion(id, request),
      deleteUnreadInput: (id, input) => { this.active.get(id)?.unreadInputIds?.delete(input); },
      updatePendingHumanAsk: (id, value) => { const state = this.active.get(id); if (state) state.pendingHumanAsk = value; },
    }, MAX_AUTO_CONTINUES);
    this.familyReconciler = new FamilyReconciler(this.inputReceiptContext, {
      active: id => this.active.get(id), isActive: id => this.isActive(id), recoveringRun: run => this.recoveringRun(run),
      cancel: id => this.cancel(id), armWait: (id, wait) => this.armWait(id, wait),
      armWorkerDeadline: (id, wait, delay) => this.armWorkerDeadline(id, wait, delay), disarmWait: id => this.disarmWait(id),
      resolveWait: (id, waitId, result, observed) => this.resolveWait(id, waitId, result, observed),
      retireSettledQuestions: id => this.retireSettledQuestions(id), fallbackRoutedQuestions: (id, reason) => this.fallbackRoutedQuestions(id, reason),
      reconcileWorkerWaits: id => this.reconcileWorkerWaits(id),
    });
    this.waitWatches = new WaitWatches(this.inputReceiptContext, {
      canProceedWithRun: (id, run) => this.canProceedWithRun(id, run), ciSupervisor: () => this.ciSupervisor,
      resolveWait: (id, waitId, result) => this.resolveWait(id, waitId, result),
      reconcileWorkerWaits: family => this.reconcileWorkerWaits(family),
      resolvePeerWait: (id, wait) => this.waitRegistry.resolvePeerWait(id, wait), disarmWait: id => this.disarmWait(id),
      armWorkerDeadline: (id, wait, delay) => this.armWorkerDeadline(id, wait, delay),
      settleWait: (id, waitId, result) => this.settleWait(id, waitId, result), exitFileRoots: id => this.exitFileRoots(id),
    });
    this.waitRegistry = new WaitRegistry(this.inputReceiptContext, {
      active: id => this.active.get(id), workerExecutionStopped: id => this.workerExecutionStopped(id),
      executionBlockedByRootFinish: run => this.executionBlockedByRootFinish(run), ciSupervisor: () => this.ciSupervisor,
      isParked: id => this.line.isParked(id), countAutomaticWakes: id => this.automaticWakes(id),
      reconcileWorkerWaits: family => this.reconcileWorkerWaits(family), noticeParkedWorkers: id => this.noticeParkedWorkers(id),
      canProceedWithRun: (id, run) => this.canProceedWithRun(id, run),
      exitFileRoots: (id, run) => this.exitFileRoots(id, run), disarmWait: id => this.disarmWait(id),
      settleWait: (id, waitId, result) => this.settleWait(id, waitId, result),
      withdrawCezarHumanWaits: id => this.withdrawCezarHumanWaits(id), armWait: (id, wait) => this.armWait(id, wait),
      parkOnWaits: (id, state) => this.parkOnWaits(id, state), cancelAutomaticAtCap: (id, waits) => this.cancelAutomaticAtCap(id, waits),
      reparkWithoutWaits: (id, state) => this.reparkWithoutWaits(id, state), waitOnUserWithoutSession: id => this.wakeAdmission.waitOnUserWithoutSession(id),
      queueWaitWake: id => this.queueWaitWake(id), retryWaitAdmission: id => this.retryWaitAdmission(id),
    }, MAX_AUTO_CONTINUES);
    this.humanWaits = new HumanWaits(this.inputReceiptContext, { routeWorkerQuestion: id => this.routeWorkerQuestion(id) }, MAX_AUTO_CONTINUES);
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
      noteNoWaitNudgeContent: (...args) => this.noteNoWaitNudgeContent(...args),
      parkedOnWorkers: id => this.parkedOnWorkers(id),
      releaseSlot: () => this.releaseSlot(),
      routeWorkerQuestion: id => this.routeWorkerQuestion(id),
    };
    this.turnNudges = new TurnNudges(this.inputReceiptContext, this.humanWaits, this.line, this.completionGateHost, {
      active: this.active, move: (id, exit, patch) => this.move(id, exit, patch),
      workerExecutionStopped: id => this.workerExecutionStopped(id), executionBlockedByRootFinish: run => this.executionBlockedByRootFinish(run),
      countAutomaticWakes: id => this.automaticWakes(id), hasQueuedAgentInputs: id => this.hasQueuedAgentInputs(id),
      submitAgentInput: (id, state, content) => this.submitAgentInput(id, state, content), resumeParkedRun: (id, state) => this.resumeParkedRun(id, state),
      chargeAutomaticWake: id => this.chargeAutomaticWake(id), retryWaitAdmission: id => this.retryWaitAdmission(id), armIdleTimer: (id, state) => this.armIdleTimer(id, state),
      openTurnEndHumanWait: (id, state, step, via, note) => this.openTurnEndHumanWait(id, state, step, via, note),
      settledTurnOutcome: (id, entry, outcome) => this.settledTurnOutcome(id, entry, outcome), queueWaitWake: id => this.queueWaitWake(id),
      armNoWaitNudgeReplyTimer: (id, state) => this.armNoWaitNudgeReplyTimer(id, state), noWaitNudgeReplyMs: () => this.noWaitNudgeReplyMs,
    }, MAX_AUTO_CONTINUES, COMPLETION_WILL_WAIT);
    this.worktreeAutosave = new WorktreeAutosave(
      this.inputReceiptContext,
      { holdForMaintenance: ids => this.holdForMaintenance(ids),
        reapTerminalScratch: id => this.reapTerminalScratch(id), releaseSlot: () => this.releaseSlot(),
        saveWorktree: (id, state, reason) => this.saveWorktree(id, state, reason),
        trackTurn: (id, task) => this.workerExecutions.trackTurn(id, task) },
    );
    this.orphans = new WorkerOrphans(
      { store, repoRoot, dataDir: this.dataDir, semaphore: this.semaphore, disposed: () => this.disposed },
      { holds: (id, admitting) => this.workerExecutions.has(id) || this.active.has(id) || this.line.hasStarting(id) || (!admitting && this.line.hasQueued(id)),
        reapTerminalScratch: id => this.reapTerminalScratch(id),
        settleOrphanedWorkerExecution: (id, opts) => this.settleOrphanedWorkerExecution(id, opts),
        orphanBackoff: () => this.orphanBackoff, orphanTermGraceMs: () => this.orphanTermGraceMs },
    );
    this.workerExecutions = new WorkerExecutions(
      { store, repoRoot, dataDir: this.dataDir, semaphore: this.semaphore, disposed: () => this.disposed }, this.orphans,
      { maintenance: id => this.claims.has(id) || !!this.autosaveCleanupBlocker(id),
        admissionError: message => new WorkerOrphanAliveError(message),
        settleOrphanedWorkerExecution: (id, opts) => this.settleOrphanedWorkerExecution(id, opts),
        reapTerminalScratch: id => this.reapTerminalScratch(id), queueWaitWake: id => this.queueWaitWake(id),
        retryWaitAdmission: id => this.retryWaitAdmission(id), releaseSlot: () => this.releaseSlot() },
    );
    this.automationToolsSlot = new AutomationToolsSlot(
      { store, repoRoot, dataDir: this.dataDir, semaphore: this.semaphore, disposed: () => this.disposed },
      () => !!this.cockpit,
    );
    this.claims = new MaintenanceClaims(
      { store, repoRoot, dataDir: this.dataDir, semaphore: this.semaphore, disposed: () => this.disposed },
      { isActive: id => this.isActive(id), autosaveCleanupBlocker: id => this.autosaveCleanupBlocker(id),
        hasExecution: id => this.workerExecutions.has(id), scheduleScratchCleanup: id => this.workerScratchCleanup.schedule(id),
        holdForMaintenance: ids => this.holdForMaintenance(ids) },
    );
    this.attachments = new AttachmentWriter(
      { store, repoRoot, dataDir: this.dataDir, semaphore: this.semaphore, disposed: () => this.disposed },
      { persistAttachment: (id, mediaType, data, prefix) => this.persistAttachment(id, mediaType, data, prefix) },
    );
    this.queuedInput = new QueuedInput(
      { store, repoRoot, dataDir: this.dataDir, semaphore: this.semaphore, disposed: () => this.disposed },
      { hasJob: id => this.line.hasJob(id), hasContinuation: id => this.line.hasContinuation(id), job: id => this.line.job(id),
        canProceedWithRun: (id, run): run is RunRecord => this.canProceedWithRun(id, run),
        activeGet: id => this.active.get(id), startingHas: id => this.line.hasStarting(id),
        persistPastedAttachments: (id, content) => this.persistPastedAttachments(id, content),
        toQueuedMessage: (id, content) => this.toQueuedMessage(id, content),
        sendMessage: (id, content, messageId) => this.sendMessage(id, content, messageId) },
    );
    this.inboxClaims = new InboxClaims(
      { store, repoRoot, dataDir: this.dataDir, semaphore: this.semaphore, disposed: () => this.disposed },
      { activeGet: id => this.active.get(id),
        executionBlockedByRootFinish: run => this.executionBlockedByRootFinish(run),
        workerExecutionStopped: id => this.workerExecutionStopped(id),
        reconcileWorkerWaits: () => this.reconcileWorkerWaits(), retireEmptyWake: id => this.retireEmptyWake(id),
        deliverConversationInput: id => this.deliverConversationInput(id),
        settleIdleBoundary: (id, state, session) => this.inputDelivery.settleIdleBoundary(id, state, session),
        releaseSlot: () => this.releaseSlot(), providerOwnsInboxInput: (id, inputId) => this.providerOwnsInboxInput(id, inputId),
        canClaimInboxInput: (id, inputId) => this.canClaimInboxInput(id, inputId),
        armInboxClaimExpiry: id => this.armInboxClaimExpiry(id) },
    );
    this.repoRootLease = new RepoRootLease(
      { store, repoRoot, dataDir: this.dataDir, semaphore: this.semaphore, disposed: () => this.disposed },
      { park: id => { this.line.park(id); }, unpark: id => { this.line.unpark(id); },
        releaseSlot: () => this.releaseSlot() },
    );
    this.turnBookkeeper = new TurnBookkeeper(
      { store, repoRoot, dataDir: this.dataDir, semaphore: this.semaphore, disposed: () => this.disposed },
      { isDisposedDelegatedRun: id => this.isDisposedDelegatedRun(id), discoverSkills: () => this.discoverSkills(),
        reviveWorkflow: run => this.reviveWorkflow(run), autoNameRun: (id, skill, task, live) => this.autoNameRun(id, skill, task, live) },
    );
    this.runSkills = new RunSkills(
      { store, repoRoot, dataDir: this.dataDir, semaphore: this.semaphore, disposed: () => this.disposed },
      { discoverSkills: () => this.discoverSkills(), workerExecutionStopped: id => this.workerExecutionStopped(id),
        isCurrentState: (id, state) => this.active.get(id) === state, flushAgentInputs: id => this.flushAgentInputs(id) },
    );
    this.autoResumeScheduler = new AutoResumeScheduler(
      { store, repoRoot, dataDir: this.dataDir, semaphore: this.semaphore, disposed: () => this.disposed },
      { move: (id, exit, patch) => this.move(id, exit, patch),
        continueRun: (id, opts, defer) => this.continueRun(id, opts, defer), pump: () => this.pump() },
    );
    this.wakeAdmission = new WakeAdmission(this.inputReceiptContext, {
      active: this.active, retries: this.retries, line: this.line, waitWatches: this.waitWatches, waitRegistry: this.waitRegistry,
      inboxClaims: this.inboxClaims, workerQuestions: this.workerQuestions, humanWaits: this.humanWaits,
      isActive: id => this.isActive(id), move: (id, exit) => this.move(id, exit), recoveringRun: run => this.recoveringRun(run),
      continueRun: (id, opts, defer) => this.continueRun(id, opts, defer), disarmWait: id => this.disarmWait(id),
      reconcileWorkerWaits: id => this.reconcileWorkerWaits(id), releaseSlot: () => this.releaseSlot(),
      parkForUser: (id, state, step) => this.parkForUser(id, state, step), armIdleTimer: (id, state) => this.armIdleTimer(id, state),
      flushAgentInputs: id => this.flushAgentInputs(id), answerRoutedQuestion: (id, flush) => this.answerRoutedQuestion(id, flush),
      queueWaitWake: id => this.queueWaitWake(id), retryWaitAdmission: id => this.retryWaitAdmission(id),
      countAutomaticWakes: (id, budget) => this.automaticWakes(id, budget),
      workerExecutionStopped: id => this.workerExecutionStopped(id), executionBlockedByRootFinish: run => this.executionBlockedByRootFinish(run),
    }, MAX_AUTO_CONTINUES, MAX_WAKE_DELIVERY_ATTEMPTS);
    this.runSettlement = new RunSettlement(this.inputReceiptContext, this.humanWaits, this.workerQuestions,
      this.worktreeAutosave, this.turnBookkeeper, this.line, this.autoResumeScheduler, this.workerExecutions,
      this.completionGateHost, {
        active: this.active, isSyntheticContinuation: (run, step) => isSyntheticContinuation(run, step),
        generation: id => this.continuationGenerations.get(id), isActive: id => this.isActive(id),
        move: (id, exit, patch) => this.move(id, exit, patch), dropActive: id => this.dropActive(id),
        saveWorktree: (id, state, reason) => this.saveWorktree(id, state, reason),
        settleSuccess: (id, durable, keep) => this.settleSuccess(id, durable, keep),
        deferParentCompletion: id => this.deferParentCompletion(id),
        closingWakeDecision: (id, holds, cancelled, error) => this.closingWakeDecision(id, holds, cancelled, error),
        owesDelivery: id => this.owesDelivery(id), preserveRunAfterDisposal: (id, state) => this.preserveRunAfterDisposal(id, state),
        isDisposedDelegatedRun: id => this.isDisposedDelegatedRun(id), queueWaitWake: id => this.queueWaitWake(id),
        reconcileWorkerWaits: id => this.reconcileWorkerWaits(id), releaseSlot: () => this.releaseSlot(),
        enforceRetention: () => this.enforceRetention(), reapTerminalScratch: id => this.reapTerminalScratch(id),
        forgetMemoryPause: id => { this.memoryPausing.delete(id); },
      }, WAKE_SESSION_CLOSED_ERROR, WAKE_DELIVERY_CAP_NOTE);
    this.turnSettler = new TurnSettler(this.inputReceiptContext, {
      humanWaits: this.humanWaits, line: this.line, waitWatches: this.waitWatches, waitRegistry: this.waitRegistry,
      workerQuestions: this.workerQuestions, completionGateHost: this.completionGateHost,
      move: (id, exit) => this.move(id, exit), releaseSlot: () => this.releaseSlot(), completionGate: id => this.completionGate(id),
      cancelOpenWaits: id => this.cancelOpenWaits(id), countAutomaticWakes: id => this.automaticWakes(id),
      workerExecutionStopped: id => this.workerExecutionStopped(id), executionBlockedByRootFinish: run => this.executionBlockedByRootFinish(run),
      submitAgentInput: (id, state, content) => this.submitAgentInput(id, state, content), flushAgentInputs: id => this.flushAgentInputs(id),
      hasQueuedAgentInputs: (id, except) => this.hasQueuedAgentInputs(id, except), armUnreadInputTimer: (id, state) => this.armUnreadInputTimer(id, state),
      armHeldHumanInputTimer: (id, state) => this.armHeldHumanInputTimer(id, state), parkOnWaits: (id, state) => this.parkOnWaits(id, state),
      queueWaitWake: id => this.queueWaitWake(id), leaveMonitoringPool: id => this.leaveMonitoringPool(id), chargeAutomaticWake: id => this.chargeAutomaticWake(id),
      canAutoContinue: (id, state) => this.canAutoContinue(id, state), tryAutonomousNudge: (id, state, step, ask) => this.tryAutonomousNudge(id, state, step, ask),
      sendTurnEndNudge: (id, state, step, text) => this.sendTurnEndNudge(id, state, step, text),
      awaitCompletionNudgeReply: (id, state, session) => this.awaitCompletionNudgeReply(id, state, session),
      noticeParkedWorker: id => this.noticeParkedWorker(id), routeWorkerQuestion: id => this.routeWorkerQuestion(id),
      settledTurnOutcome: (id, entry, outcome) => this.settledTurnOutcome(id, entry, outcome),
    }, IDLE_TIMEOUT_MS, MAX_AUTO_CONTINUES, COMPLETION_WILL_WAIT, SCHEDULE_WAKEUP_MAX_SECONDS);
    this.inputDelivery = new InputDelivery(this.inputReceiptContext, {
      active: this.active, line: this.line, workerExecutions: this.workerExecutions, runSkills: this.runSkills,
      attachments: this.attachments, humanWaits: this.humanWaits, workerQuestions: this.workerQuestions,
      waitRegistry: this.waitRegistry, inputReceiptHost: this.inputReceiptHost,
      isActive: id => this.isActive(id), move: (id, exit) => this.move(id, exit),
      workerExecutionStopped: id => this.workerExecutionStopped(id), executionBlockedByRootFinish: run => this.executionBlockedByRootFinish(run),
      hasUnansweredHumanAsk: id => this.hasUnansweredHumanAsk(id), countAutomaticWakes: (id, budget) => this.automaticWakes(id, budget),
      recoveringRun: id => this.recoveringRun(id), continueRun: (id, opts, defer) => this.continueRun(id, opts, defer),
      latchAgentInputError: (id, state, session, message) => this.latchAgentInputError(id, state, session, message),
      parkForUser: (id, state, step) => this.parkForUser(id, state, step), settleTurn: (id, state, entry, turn) => this.settleTurn(id, state, entry, turn),
      boundaryTurn: (id, state, session, done) => this.boundaryTurn(id, state, session, done),
      canAutoContinue: (id, state) => this.canAutoContinue(id, state), armNoWaitNudgeReplyTimer: (id, state) => this.armNoWaitNudgeReplyTimer(id, state),
      awaitCompletionNudgeReply: (id, state, session) => this.awaitCompletionNudgeReply(id, state, session),
      queueWaitWake: id => this.queueWaitWake(id), owesWake: (run, budget) => this.owesWake(run, budget),
      pendingConversationWakes: (run, budget) => this.pendingConversationWakes(run, budget), routedAnswer: id => this.routedAnswer(id),
      spendWakeAdmission: (id, state, owed) => this.spendWakeAdmission(id, state, owed), cancelAutomaticAtCap: (id, waits) => this.cancelAutomaticAtCap(id, waits),
      reparkWithoutWaits: (id, state) => this.reparkWithoutWaits(id, state), holdPeerWakesAtCap: id => this.holdPeerWakesAtCap(id),
      reconcileWorkerWaits: () => this.reconcileWorkerWaits(), unreadInputGraceMs: () => this.unreadInputGraceMs,
      submitAgentInput: (id, state, content, inputs, budget) => this.submitAgentInput(id, state, content, inputs, budget),
    }, MAX_AUTO_CONTINUES, ROUTED_QUESTION_REFUSAL);
    this.ciResources = acquireCiResources(this.semaphore);
    this.ciSupervisor = this.ciResources.supervisor;
    this.offSemaphore = this.semaphore.register({
      busySlots: () => this.busySlots(),
      oldestWakeAt: () => this.oldestWakeAt(),
      pump: () => this.pump(),
      oldestQueuedAt: () => this.oldestQueuedAt(),
      accountHolds: () => this.accountHolds(),
    });
    // Memory guard (#memory-guard): the shared process-tree sampler already ticks ~every 2 s for
    // the runs table; piggyback on it to enforce the per-task memory ceiling.
    this.offUsage = onUsage((snapshot) => void this.enforceMemoryLimit(snapshot));
    this.queueWatchdog = setInterval(() => void this.rescueStalledQueue(), QUEUE_WATCHDOG_MS);
    this.queueWatchdog.unref?.();
    this.store.on('run', this.onDelegationRun);
    this.store.on('deleted', this.onRunDeleted);
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
    this.store.off('deleted', this.onRunDeleted);
    this.familyReconciler.dispose();
    this.inboxClaims.dispose();
    this.offUsage();
    this.offSemaphore();
    clearInterval(this.queueWatchdog);
    for (const [runId, state] of this.active) {
      state.revokeCiTools?.(); state.revokeCiTools = undefined;
      state.revokeDelegation?.(); state.revokeDelegation = undefined;
      this.clearIdleTimer(state);
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
      this.clearIdleTimer(state);
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
      registerWait: (...args) => this.registerWait(...args), registerAsk: (...args) => this.registerAsk(...args),
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

  private completionRefusal(runId: string): CompletionRefusal | undefined { return completionGateReads.completionRefusal(this.inputReceiptContext, this.completionGateHost, runId); }

  async stopPreviewServer(runId: string, request: PreviewStopRequest, signal?: AbortSignal): Promise<PreviewStopResult> {
    return stopPreviewServer(this.store, this.preview, this.cezarPort, () => this.disposed, runId, request, signal);
  }
  async registerPreviewServer(runId: string, request: PreviewServeRequest, signal?: AbortSignal): Promise<PreviewServeResult> {
    return registerPreviewServer(this.store, this.preview, this.cezarPort, () => this.disposed, runId, request, signal);
  }

  async registerAsk(runId: string, request: CezarAskRequest, generation: string, capabilitySignal?: AbortSignal): Promise<HumanWaitEntry> { return this.waitRegistry.registerAsk(runId, request, generation, capabilitySignal); }
  async registerWait(runId: string, request: CezarWaitRequestInput, via: WaitVia, generation: string, capabilitySignal?: AbortSignal): Promise<PrWaitEntry | TimerWaitEntry | WorkerWaitEntry | ProcessWaitEntry | PeerWaitEntry> { return this.waitRegistry.registerWait(runId, request, via, generation, capabilitySignal); }
  private openWait<W extends Wait>(runId: string, state: ActiveRun, wait: W): W { return this.waitRegistry.openWait(runId, state, wait); }
  cancelWait(runId: string, waitId: string, generation: string) { return this.waitRegistry.cancelWait(runId, waitId, generation); }
  private readonly workerStatus = (workerId: string): string => this.waitRegistry.workerStatus(workerId);
  private resolveWait(runId: string, waitId: string, result?: CiWaitResult | ProcessWaitResult | PeerWaitResult, observed?: WorkerWaitEntry): void { this.waitRegistry.resolveWait(runId, waitId, result, observed); }

  private exitFileRoots(runId: string, run = this.store.getRun(runId)): ExitFileRoots {
    return this.waitWatches.exitFileRoots(runId, run);
  }

  private armWait(runId: string, wait: Wait): void { this.waitWatches.armWait(runId, wait); }
  private armWorkerDeadline(runId: string, wait: WorkerWaitEntry, firstDelay?: number): void { this.waitWatches.armWorkerDeadline(runId, wait, firstDelay); }
  private disarmWait(waitId: string): void { this.waitWatches.disarmWait(waitId); this.familyReconciler.forgetRetry(waitId); this.waitWatches.disarmProcessWatch(waitId); }
  private settleWait(runId: string, waitId: string, result?: CiWaitResult | ProcessWaitResult | PeerWaitResult): void { this.waitWatches.settleWait(runId, waitId, result); }

  private cancelAutomaticAtCap(runId: string, waits: readonly Wait[]): void { return this.wakeAdmission.cancelAutomaticAtCap(runId, waits); }

  private reparkWithoutWaits(runId: string, state: ActiveRun): void { return this.wakeAdmission.reparkWithoutWaits(runId, state); }

  private owesDelivery(runId: string): boolean { return this.wakeAdmission.owesDelivery(runId); }

  private closingWakeDecision(runId: string, holdsClosingWakes: boolean, cancelled: boolean, undelivered: string | undefined): 'park' | 'settle' | 'capped' { return this.wakeAdmission.closingWakeDecision(runId, holdsClosingWakes, cancelled, undelivered); }

  private clearWakeBackoff(runId: string): void {
    this.retries.clearWakeBackoff(runId);
  }

  /** Saves an accepted continuation. A human Continue also answers every human wait, ends failed
   *  deliveries and restarts the budget, in the same best-effort commit. */
  private commitContinuation(runId: string, human: boolean): void {
    const outcomes: RunOutcome[] = [{ kind: 'answered' }, { kind: 'counted', waitDeliveryFailures: undefined },
      ...(this.store.getRun(runId)?.automaticWakes ? [{ kind: 'charged' as const, automaticWakes: 0 }] : [])];
    if (!human || !this.store.commitOutcome(runId, outcomes, {}, { bestEffort: true }).committed) this.store.flush();
  }

  private spendWakeAdmission(runId: string, state: ActiveRun, owed: boolean): void { return this.wakeAdmission.spendWakeAdmission(runId, state, owed); }

  private automaticWakes(runId: string, beforeHumanReset?: HumanAnswerBudget): number { return this.wakeAdmission.automaticWakes(runId, beforeHumanReset); }

  private chargeAutomaticWake(runId: string): number { return this.wakeAdmission.chargeAutomaticWake(runId); }

  private retryWaitAdmission(runId: string): void {
    this.retries.retryWaitAdmission(runId);
  }

  private parkOnWaits(runId: string, state: ActiveRun): boolean { return this.wakeAdmission.parkOnWaits(runId, state); }

  private parkedOnWorkers(runId: string): boolean { return this.wakeAdmission.parkedOnWorkers(runId); }

  private leaveMonitoringPool(runId: string): void { return this.wakeAdmission.leaveMonitoringPool(runId); }

  private queueWaitWake(runId: string): void { return this.wakeAdmission.queueWaitWake(runId); }

  private wakeHeld(run: RunRecord): boolean { return this.wakeAdmission.wakeHeld(run); }

  private withExecutionAccount<T extends RunRecord>(run: T): T { return this.wakeAdmission.withExecutionAccount(run); }

  private pendingConversationWakes(run: RunRecord, beforeHumanReset?: HumanAnswerBudget): AgentInput[] { return this.wakeAdmission.pendingConversationWakes(run, beforeHumanReset); }

  private holdPeerWakesAtCap(runId: string): void { return this.wakeAdmission.holdPeerWakesAtCap(runId); }

  private routedAnswer(runId: string): AgentInput | undefined { return this.wakeAdmission.routedAnswer(runId); }

  private owesWake(run: RunRecord, beforeHumanReset?: HumanAnswerBudget): boolean { return this.wakeAdmission.owesWake(run, beforeHumanReset); }

  private retireEmptyWake(runId: string): void { return this.wakeAdmission.retireEmptyWake(runId); }

  private cancelOpenWaits(runId: string): void { return this.wakeAdmission.cancelOpenWaits(runId); }

  private readonly onRunDeleted = (runId: string): void => { this.wakeAdmission.onRunDeleted(runId); };

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
      void this.autoNameRun(run.id, skillHint, input.task);
    } finally {
      this.line.enqueueJob(run.id, { workflow, input: effectiveInput });
      void this.pump();
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
    void this.pump();
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

  private busySlots(): number { return this.line.busySlots(); }
  private oldestQueuedAt(): number | null { return this.line.oldestQueuedAt(); }
  private oldestWakeAt(): number | null { return this.line.oldestWakeAt(); }

  /**
   * A slot this manager held just came free. Pump the whole WORKSPACE, not
   * just this manager: `maxParallel` is counted across every project, so the
   * run that should take the slot is the workspace's oldest queued one — which
   * usually sits in another project's queue. Pumping only `this` is what left
   * a queued run in project B stuck at `queued` while project A's runs came
   * and went. `release()` pumps this manager too, so it replaces the local
   * `pump()` at every slot-freeing transition.
   */
  private releaseSlot(): void {
    void this.semaphore.release();
  }

  private pump(): Promise<void> { return this.line.pump(); }

  private admitQueuedWaitWake(runId: string): 'none' | 'handled' | 'deferred' { return this.wakeAdmission.admitQueuedWaitWake(runId); }

  /** Read and hydrate mutable queued input in the same synchronous tick as dequeue. */
  private launchQueuedRun(runId: string, job: PendingJob | undefined, continuation: PendingContinuation | undefined): void {
    if (continuation) {
      void (async () => {
        const hydrated = this.hydrateQueuedContinuation(runId, continuation);
        await this.runContinuation(
          runId,
          hydrated.stepId,
          hydrated.sessionId,
          hydrated.backend,
          hydrated.prompt,
          hydrated.images,
          hydrated.persistedImages,
          hydrated.persistedAttachments,
        );
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
      await this.execute(runId, job.workflow, input, job.startAt);
    })().catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      this.move(runId, 'fail-crash', {
        error: `engine crashed: ${message}`,
        finishedAt: new Date().toISOString(),
      });
      const state = this.active.get(runId);
      if (state) {
        this.clearIdleTimer(state);
        this.clearAutosaveTimer(state);
      }
      this.line.unmarkStarting(runId);
      this.dropActive(runId);
    }).finally(() => this.finishWorkerExecution(runId));
  }

  private checkpointRestartContext(run: RunRecord, queuedStepId?: string): RunRecord { return queuedRevival.checkpointRestartContext(this.inputReceiptContext, this.queuedRevivalHost, run, queuedStepId); }

  private async reviveQueuedRun(run: RunRecord, reason: string): Promise<void> { return queuedRevival.reviveQueuedRun(this.inputReceiptContext, this.queuedRevivalHost, run, reason); }

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
  async recover(familyRootId?: string): Promise<void> {
    // A store that could not open (#779) knows none of its runs: recovering it would read "none".
    if (this.disposed || this.recovering || this.store.unavailable) return;
    this.recoveryScope = { ...(familyRootId === undefined ? {} : { family: familyRootId }) };
    let settled!: () => void;
    this.recoveryInFlight = new Promise<void>((resolve) => { settled = resolve; });
    const inScope = (run: RunRecord) => familyRootId === undefined || familyOf(run) === familyRootId;
    try {
    this.familyReconciler.setRecoveryFactsPending(true);
    await this.store.prepareRecoveryFacts(familyRootId);
    if (this.disposed) return;
    // Public terminal state can precede the private completion checkpoint. Such a family
    // has no live/deferred anchor, but orphan settlement still appends its lifecycle event.
    // Prepare only eligible starting generations' families before any repair mutation;
    // retain IDs, never an ownership or execution snapshot, across readiness.
    const { orphanWorkerIds, orphanFactIds } = this.collectOrphanWorkerGenerations(familyRootId, inScope);
    await this.store.prepareTranscriptFacts(orphanFactIds);
    if (this.disposed) return;
    this.familyReconciler.setRecoveryFactsPending(false);
    // Recovery reads the live set (#779): `listRuns()` is the runs `open` loaded by the `live`
    // column, and finished runs have nothing to recover. The worker passes below go through
    // indexed queries instead.
    this.recoverUnreadInputs(inScope);
    // #469: a generation whose processes died with the old controller is finalized first, so it
    // re-launches through the ordinary Continue path; live task scratch is retained.
    // Any worker, finished or not, may hold a generation a dead controller left `starting`. Its
    // private proof is read first, so only those workers' records are decoded: settling and
    // re-probing are no-ops for every other proof phase.
    // Another process's workers are its own to settle.
    this.settleOrphanWorkerGenerations(orphanWorkerIds, inScope);
    this.reconcileWorkerWaits(familyRootId);
    const live = this.store
      .listRuns()
      .filter((r) => inScope(r) && ['queued', 'waiting', 'running'].includes(r.status))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    // Scratch cleanup discovers private evidence independently of the salvageable run index.
    // Terminal worker cleanup/retries and the generic orphan sweep share this boundary. An
    // adopted family only schedules its own members: the sweep belongs to restart.
    this.recoverWorkerScratch(familyRootId);
    for (const run of live) {
      // Await only what the run hands back, so a run that settles nothing recovers without
      // yielding to the work an earlier run started.
      const settling = this.recoverLiveRun(run);
      if (settling) await settling;
    }
    if (familyRootId === undefined) await this.familyReconciler.reconcileRecoveryWorkerFamilies();
    if (this.disposed) return;
    } finally {
      this.familyReconciler.setRecoveryFactsPending(false);
      this.recoveryScope = undefined;
      this.recoveryInFlight = undefined;
      settled();
    }
    // Only a family with a live member has anyone left to route to or fall back from.
    this.recoverWorkerMessages(familyRootId === undefined ? this.familyReconciler.liveFamilyMembers() : this.familyReconciler.familyMembers(familyRootId), familyRootId);
    // A parent reply accepted just before the crash still answers its worker (#505), and only a
    // live worker takes one.
    this.answerRecoveredRoutedQuestions(inScope);
    // The rest re-arms wakes from durable state and is idempotent, so it runs for every live run
    // even after one adopted family: anything the recovery window held back goes out now.
    this.rearmRecoveredWakes();
    // Re-arm usage-limit resumes (spec 2026-08-03-auto-resume-after-usage-limit): the wait is
    // routinely longer than a cezar session, so the deadline is durable and the timer is rebuilt
    // from it. `pump()` reconciles again on every sweep, so this is the fast path, not the only
    // one — see `reconcileAutoResumes`.
    this.reconcileAutoResumes();
    void this.pump();
  }

  /** The workers in scope whose generation a dead controller left `starting`, and the members of
   *  their families, whose transcript facts recovery prepares before it settles them. */
  private collectOrphanWorkerGenerations(
    familyRootId: string | undefined,
    inScope: (run: RunRecord) => boolean,
  ): { orphanWorkerIds: string[]; orphanFactIds: Set<string> } {
    const workerIds = familyRootId === undefined ? this.store.listWorkerIds() : this.store.listWorkersOf(familyRootId).map((run) => run.id);
    const orphanWorkerIds: string[] = [];
    const orphanFactIds = new Set<string>();
    for (const id of workerIds) {
      if (this.store.readWorkerExecution(id)?.phase !== 'starting' || this.store.writeRefusal(id)) continue;
      const run = this.store.getRun(id);
      if (run?.delegation?.role !== 'worker' || !inScope(run)) continue;
      orphanWorkerIds.push(id);
      for (const member of this.store.listFamilyRunIds(run.delegation.parentRunId)) orphanFactIds.add(member);
    }
    return { orphanWorkerIds, orphanFactIds };
  }

  /** Recovery's first pass over the live set: the input state a dead controller left behind. */
  private recoverUnreadInputs(inScope: (run: RunRecord) => boolean): void {
    for (const run of this.store.listRuns().filter(inScope)) {
      // A restarted controller cannot answer an old transport's permission RPC.
      if (!this.isActive(run.id) && run.hasPendingPermission) {
        // A permission wait interrupted an unfinished native turn. Route it
        // through interrupted-turn recovery, never the settled-worker fallback.
        this.store.updateRun(run.id, { hasPendingPermission: false,
          ...(run.status === 'waiting' && !run.stopping && !this.workerExecutionStopped(run.id) ? { status: transition('resume', () => this.store.getRun(run.id)) } : {}) });
      }
      this.store.clearExpiredInboxClaims(run.id, new Date().toISOString());
      this.armInboxClaimExpiry(run.id);
      // #505: the session that accepted this input died before the model read it.
      // Delivery is at-least-once: the replay keeps the input's ID in its text.
      if (['queued', 'running', 'waiting'].includes(run.status) && !this.isActive(run.id)) {
        const replayed = this.store.requeueAwaitingReadInputs(run.id);
        if (replayed.length) this.store.appendEvent(run.id, { type: 'note', message: `replaying ${replayed.length} message${replayed.length === 1 ? '' : 's'} accepted before the restart but not read` });
      }
    }
  }

  /** Settles each orphaned `starting` generation, or re-probes it when its proof does not settle. */
  private settleOrphanWorkerGenerations(orphanWorkerIds: string[], inScope: (run: RunRecord) => boolean): void {
    for (const id of orphanWorkerIds) {
      const run = this.store.getRun(id);
      if (!run || !inScope(run)) continue;
      if (this.store.readWorkerExecution(id)?.phase === 'starting' && !this.store.writeRefusal(id) &&
        !this.settleOrphanedWorkerExecution(id)) this.armOrphanReprobe(id);
    }
  }

  /** Restart sweeps every worker's scratch; an adopted family schedules only its own members. */
  private recoverWorkerScratch(familyRootId: string | undefined): void {
    if (familyRootId === undefined) this.workerScratchCleanup.recover();
    else for (const run of this.familyReconciler.familyMembers(familyRootId)) this.workerScratchCleanup.schedule(run.id);
  }

  /**
   * One live run of the restart loop. Returns the promise the loop must await (a root finish, a
   * re-queue or a settlement), else `undefined`.
   */
  private recoverLiveRun(found: RunRecord): Promise<void> | undefined {
    if (this.isActive(found.id)) return undefined;
    if (this.workerExecutionStopped(found.id)) return undefined;
    if (this.recoveryLeavesWorkerToRoot(found)) return undefined;
    if (this.rootFinishRequested(found.id)) return this.settleRequestedRootFinish(found.id);
    // A usage-limit hold ran no process, so nothing was interrupted: its waits re-arm and resolve,
    // and `reconcileAutoResumes` re-arms the resume that delivers them (hearsay-tools/cezarion#1236).
    if (isUsageLimitHold(found)) {
      for (const wait of openWaits(found)) this.armWait(found.id, wait);
      return undefined;
    }
    const run = this.reconcileRecoveredAsk(found);
    if (this.parkRecoveredRun(run)) return undefined;
    // A pending question or a queued message leaves the waits open: they re-arm, and a result
    // still wakes the run.
    for (const wait of openWaits(run)) this.armWait(run.id, wait);
    if (run.status === 'queued') return this.reviveQueuedRun(run, 'cezar restarted');
    this.deliverConversationInput(run.id);
    if (run.status === 'waiting') return this.recoverClosedWaitingRun(run);
    this.recoverInterruptedRun(run);
    return undefined;
  }

  /** True when a worker's root takes no more work from it: a closed root cancels the worker, and a
   *  root in review or finishing leaves it as it is. */
  private recoveryLeavesWorkerToRoot(run: RunRecord): boolean {
    if (run.delegation?.role !== 'worker') return false;
    const parent = this.store.getRun(run.delegation.parentRunId);
    if (parent?.delegation?.role !== 'root') return false;
    if (['done', 'failed', 'cancelled'].includes(parent.status)) {
      this.cancel(run.id);
      return true;
    }
    return parent.status === 'review' || Boolean(parent.delegation.finishRequestedAt);
  }

  /** The run as recovery reads it after it reconciles the run's question state. */
  private reconcileRecoveredAsk(found: RunRecord): RunRecord {
    let run = found;
    // A worker no process survived for is a closed session: Cezar's fallback question goes as at an
    // idle close, and the worker recovers as its plain park did (hearsay-tools/cezarion#1301).
    if (run.delegation?.role === 'worker' && run.status === 'waiting' && this.supersedeWorkerFallback(run.id)) run = this.store.getRun(run.id)!;
    // Phase 4b (hearsay-tools/cezarion#1236): attention reads the human wait, so an unanswered ask
    // an older cezar left without one gets one now, attached to that ask.
    if (this.adoptTranscriptAsk(run.id)) run = this.store.getRun(run.id)!;
    // A stored pending-question flag can be stale: the answer's receipt reached the transcript and
    // the row's save did not. The wait read from it is answered (review of #1437).
    if (this.settleAnsweredLegacyAsk(run.id)) run = this.store.getRun(run.id)!;
    return run;
  }

  /** True when the recovered run stays parked: on a human wait, a pending question or its waits. */
  private parkRecoveredRun(run: RunRecord): boolean {
    // hearsay-tools/cezarion#1234: a crash after a human wait's registration and before its turn
    // end shows the question now. The run waits on the user, its other waits re-armed.
    if (this.unsurfacedHumanWait(run.id)) {
      this.surfaceHumanWait(run.id, undefined);
      this.parkOnOpenWaits(run);
      return true;
    }
    if (run.delegation && run.delegation.role !== 'invalid' && this.hasPendingHumanAsk(run.id)) {
      // A pending question leaves its waits open: they re-arm, and a result still wakes the run.
      this.parkOnOpenWaits(run);
      // Only the durable, explicitly human payload may resume an unanswered
      // question. A refused recovery leaves attention, not terminal failure.
      if (run.continuationMessage?.origin === 'human') {
        const restarted = this.checkpointRestartContext(run);
        this.continueRun(restarted.id, {}, true);
      }
      return true;
    }
    // No process survived. Open waits re-arm from their stored deadlines (an overdue timer
    // resolves now); resolved ones wake through a scheduler-owned continuation after recovery.
    // A human message no longer withdraws a wait, so an interrupted or queued run with queued
    // messages still owes their delivery: it recovers as below, with its waits armed
    // (hearsay-tools/cezarion#1233). A parked one stays parked; its wake folds them in.
    if (run.waits?.length && !this.hasPendingHumanAsk(run.id) && (run.status === 'waiting' || !run.queuedMessages?.length)) {
      this.parkOnOpenWaits(run);
      return true;
    }
    return false;
  }

  /** Parks a recovered run: `waiting`, with each of its open waits re-armed. */
  private parkOnOpenWaits(run: RunRecord): void {
    this.move(run.id, 'park');
    for (const wait of openWaits(run)) this.armWait(run.id, wait);
  }

  /**
   * A `waiting` run that did not park. Returns the settlement the loop must await, else
   * `undefined`.
   */
  private recoverClosedWaitingRun(run: RunRecord): Promise<void> | undefined {
    // Waiting is durable human attention for roots and ordinary top-level
    // runs. A worker reaches here only when it has neither a recoverable ask
    // nor a worker wait; preserving that record would strand both it and its
    // parent because workers cannot accept an ordinary inactive Continue.
    if (run.delegation?.role !== 'worker' ||
      run.agentInputs?.some(input => !input.deliveredAt && hasLiveInboxClaim(input))) return undefined;
    const finishedAt = new Date().toISOString();
    if (run.invalidAsk) {
      this.failRecoveredInvalidAsk(run, finishedAt);
      return undefined;
    }
    if (this.ciWorkflowResumeStepIndex(run) >= 0) {
      // CI ACK retires the wait, but not the failed workflow source. A closed
      // worker at this boundary must resume before its remaining checks run.
      const resumed = this.continueRun(run.id, { text: RESTART_CONTINUATION_PROMPT }, true);
      this.store.appendEvent(run.id, { type: 'lifecycle', message: resumed.ok
        ? 'cezar restarted — resuming the worker CI recovery from its last session'
        : `cezar restarted — could not resume worker CI recovery (${resumed.error ?? 'unknown'})` });
      return undefined;
    }
    for (const step of run.steps) {
      if (step.status === 'waiting' || step.status === 'running') {
        this.store.updateStep(run.id, step.id, { status: 'done', finishedAt });
      }
    }
    this.store.appendEvent(run.id, {
      type: 'lifecycle',
      message: 'cezar restarted — the open worker session was settled',
    });
    return this.settleSuccess(run.id);
  }

  /** A recovered run whose structured question cannot be answered fails with its open steps. */
  private failRecoveredInvalidAsk(run: RunRecord, finishedAt: string): void {
    for (const step of run.steps) if (step.status === 'waiting' || step.status === 'running') {
      this.store.updateStep(run.id, step.id, { status: 'failed', error: 'invalid structured question', finishedAt });
    }
    this.move(run.id, 'fail', { error: 'invalid structured question', finishedAt, currentStepId: undefined });
  }

  /** A `running` run whose process died mid-turn. */
  private recoverInterruptedRun(found: RunRecord): void {
    // `running`: the process died mid-turn. Mark it interrupted (the state
    // continueRun expects), then pick the work back up from the last session.
    const run = this.checkpointRestartContext(found);
    const interruptedStepId = run.currentStepId;
    const finishedAt = new Date().toISOString();
    for (const step of run.steps) {
      if (step.status === 'running' || step.status === 'waiting') {
        this.store.updateStep(run.id, step.id, {
          status: 'failed',
          error: 'interrupted — cezar process exited during the run',
          finishedAt,
        });
      }
    }
    this.move(run.id, 'fail-interrupted', {
      error: 'interrupted — cezar process exited during the run',
      finishedAt,
      currentStepId: undefined,
    });
    if (this.requeueInterruptedRun(run, interruptedStepId)) return;
    const resumed = this.continueRun(
      run.id,
      {
        text: run.continuationMessage?.text ?? RESTART_CONTINUATION_PROMPT,
      },
      true,
    );
    this.store.appendEvent(run.id, {
      type: 'lifecycle',
      message: resumed.ok
        ? 'cezar restarted — resuming the interrupted task from its last session'
        : `cezar restarted — could not resume the interrupted task (${resumed.error ?? 'unknown'})`,
    });
  }

  private requeueInterruptedRun(run: RunRecord, interruptedStepId: RunRecord['currentStepId']): boolean { return queuedRevival.requeueInterruptedRun(this.inputReceiptContext, this.queuedRevivalHost, run, interruptedStepId); }

  /** Delivers the parent replies routed to each worker in scope. */
  private answerRecoveredRoutedQuestions(inScope: (run: RunRecord) => boolean): void {
    for (const run of this.store.listRuns().filter(inScope)) if (run.delegation?.role === 'worker') this.answerRoutedQuestion(run.id);
  }

  /** Re-arms each live run's waits, or queues the wake it owes. */
  private rearmRecoveredWakes(): void {
    for (const run of this.store.listRuns()) {
      // A terminal row keeps its waits (and stays live) until something cancels them. A failed run
      // that owes results keeps them for a human, and its open waits still resolve without a wake.
      if (run.waits?.length && holdsOwedResults(run)) for (const wait of openWaits(run)) this.armWait(run.id, wait);
      else if (run.waits?.length && !['running', 'waiting', 'queued'].includes(run.status)) this.cancelOpenWaits(run.id);
      else if (run.waits?.length) this.queueWaitWake(run.id);
      // A message the recovery window held back is a wake of its own (hearsay-tools/cezarion#1235).
      else if (['running', 'waiting', 'queued'].includes(run.status) && this.owesWake(run)) this.queueWaitWake(run.id);
    }
  }

  /**
   * Adopt a dead owner’s family for a control, then recover the settled family without resuming
   * work. Stop cancels its target; only Continue starts work. Serialize adoptions after recovery.
   * False means missing or live-owned.
   */
  adoptOrphanedRun(runId: string, opts: { stop?: boolean } = {}): Promise<boolean> {
    const adoption = this.adoptionTail.then(async () => {
      while (this.recovering && this.recoveryInFlight) await this.recoveryInFlight;
      if (this.disposed) return false;
      const family = this.store.adoptFamily(runId, opts);
      if (family === undefined) return false;
      await this.recover(family);
      return true;
    });
    this.adoptionTail = adoption.catch(() => undefined);
    return adoption;
  }

  private async reviveWorkflow(run: RunRecord): Promise<WorkflowDef | null> { return queuedRevival.reviveWorkflow(this.inputReceiptContext, this.queuedRevivalHost, run); }

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
      this.clearIdleTimer(state);
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

  private scheduleAutoResumeIfLimited(runId: string): void { this.autoResumeScheduler.scheduleAutoResumeIfLimited(runId); }

  private reconcileAutoResumes(): void { this.autoResumeScheduler.reconcileAutoResumes(); }

  /**
   * Hand a run that has not spawned anything back to the queue, when the account it would run on
   * went into a usage-limit hold (spec 2026-08-03-auto-resume-after-usage-limit).
   *
   * The dequeue-time gate in `pump()` cannot be the only one: a run can sit between dequeue and
   * spawn for a long time — an in-place run waiting for the exclusive repo-root lease is the
   * measured case — and the account can close in that gap. This is the last honest moment to
   * refuse, because everything after it costs a real agent turn.
   *
   * "Untouched" is the contract: the run has created no session and no worktree, so it goes back
   * as plain `queued` with its `startedAt` cleared, and `pump()` will pick it up when the window
   * reopens. Returns true when the caller must abandon the run.
   */
  private requeueWhileHeld(
    runId: string,
    workflow: WorkflowDef,
    input: StartRunInput,
    runner: RunnerId,
    state?: ActiveRun,
    startAt?: number,
  ): boolean {
    const run = this.store.getRun(runId);
    if (!run || run.status === 'cancelled' || state?.cancelled) return false;
    // The watchdog sent this one through. Checked, never consumed: the spawn path asks this
    // question TWICE — here at the top of `execute`, and again after the exclusive repo-root
    // lease is granted — so a one-shot flag would clear at the first gate and let the second one
    // hand an in-place run straight back, re-wedging the queue the rescue had just freed.
    // `dropActive` retires the entry on every terminal path, so the set still cleans itself up.
    const finishHeld = this.executionBlockedByRootFinish(run);
    if (!finishHeld && (this.line.isForced(runId) ||
      !accountHeldFor({ ...run, runner }, this.semaphore.accountHolds(), runner))) return false;
    state?.releaseRepoRoot?.();
    if (state) { state.releaseRepoRoot = undefined; this.clearAutosaveTimer(state); }
    this.line.enqueueJob(runId, { workflow, input, startAt });
    this.move(runId, 'requeue', {
      ...(startAt !== undefined && startAt > 0 ? {} : { startedAt: undefined }),
      currentStepId: undefined,
    });
    this.store.appendEvent(runId, {
      type: 'note',
      message: finishHeld ? 'held in the queue — parent finish is pending' : 'held in the queue — this agent account is waiting out a usage limit',
    });
    this.dropActive(runId);
    return true;
  }

  async rescueStalledQueue(now = Date.now()): Promise<void> { return this.line.rescueStalledQueue(now); }

  accountHolds(now = Date.now()): AccountHolds {
    return deriveAccountHolds(this.store.listRuns(), run => this.withExecutionAccount(run), now);
  }

  cancelAutoResume(runId: string): boolean { return this.autoResumeScheduler.cancelAutoResume(runId); }

  private clearAutoResume(runId: string): void { this.autoResumeScheduler.clearAutoResume(runId); }

  /** Reclaim finished worktrees beyond the keep-limit (#483) — directory only,
   *  `cez/<id8>` branch kept. Best-effort; a failure never affects run
   *  lifecycle. `review`/live runs are excluded by the selector. */
  private async enforceRetention(): Promise<void> {
    try {
      const keep = await resolveWorktreeRetention(this.repoRoot);
      await reclaimWorktrees(this.repoRoot, this.store, keep, { claim: (run) => this.claimWorktreeReclaim(run.id), previewHost: this.preview });
    } catch {
      // retention is best-effort; swallow so terminal transitions never break.
    }
  }

  private readonly turnBookkeeper: TurnBookkeeper;
  /** Test seam: the module owns this same map for its whole lifetime. */
  private get lastNamerKey() { return this.turnBookkeeper.lastNamerKey; }

  private async acquireRepoRoot(runId: string, state: ActiveRun): Promise<boolean> {
    return this.repoRootLease.acquireRepoRoot(runId, state);
  }

  cancel(runId: string): boolean {
    // Another process's run (#779, plan step 3): only its owner can stop it.
    if (this.store.writeRefusal(runId)) return false;
    this.cancelWorkerExecution(runId);
    const hadWaits = !!this.store.getRun(runId)?.waits?.length;
    this.cancelOpenWaits(runId);
    const retiredRefusal = this.retireCompletionRefusal(runId);
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
    this.clearIdleTimer(state);
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
  private readPersistedAttachments(runId: string, urls: string[], kind: 'task' | 'queued' | 'continuation'): PersistedAttachments { return this.queuedInput.readPersistedAttachments(runId, urls, kind); }
  private toQueuedMessage(runId: string, content: PastedContent[]): QueuedMessage { return this.queuedInput.toQueuedMessage(runId, content); }
  enqueueMessage(runId: string, content: PastedContent[]): QueuedMessage | null { return this.queuedInput.enqueueMessage(runId, content); }
  editQueuedMessage(runId: string, msgId: string, edit: { text?: string; images?: PastedContent[] }): QueuedMessage | null { return this.queuedInput.editQueuedMessage(runId, msgId, edit); }
  removeQueuedMessage(runId: string, msgId: string): boolean { return this.queuedInput.removeQueuedMessage(runId, msgId); }
  editTask(runId: string, task: string): boolean { return this.queuedInput.editTask(runId, task); }
  deferMessage(runId: string, content: PastedContent[]): boolean { return this.queuedInput.deferMessage(runId, content); }

  private parentCompletionBlockers(runId: string) { return completionGateReads.parentCompletionBlockers(this.inputReceiptContext, this.completionGateHost, runId); }

  /** A settled-but-uncollected result is work for the parent, not a live worker.
   * Keep the private termination proof: a public terminal status can precede exit. */
  private hasLiveWorkers(runId: string): boolean { return completionGateReads.hasLiveWorkers(this.inputReceiptContext, this.completionGateHost, runId); }

  /** Live workers keep a turn end monitoring unless the agent already waits on workers: an open
   *  worker entry is the wait, so no implicit re-check timer goes beside it (hearsay-tools/cezarion#1235). */
  private monitorsLiveWorkers(runId: string): boolean { return completionGateReads.monitorsLiveWorkers(this.inputReceiptContext, this.completionGateHost, runId); }

  private delegationFinishBlockedReason(runId: string): string | undefined { return completionGateReads.delegationFinishBlockedReason(this.inputReceiptContext, this.completionGateHost, runId); }

  /** The read-only verdict and explicit Finish share this decision. Operational failures
   * (for example a failed durable write) are still handled at execution time. */
  private finishDecision(runId: string):
    { action: 'session' | 'root' | 'waiting' | 'review' } | { reason: string; warn?: boolean } { return completionGateReads.finishDecision(this.inputReceiptContext, this.completionGateHost, runId); }

  finishBlockedReason(runId: string): string | undefined { return completionGateReads.finishBlockedReason(this.inputReceiptContext, this.completionGateHost, runId); }

  private deferParentCompletion(runId: string): boolean {
    const gate = this.completionGate(runId);
    if (gate === 'accept') return false;
    const state = this.active.get(runId);
    // Mid-turn, the live turn end takes its done to the gate itself, behind owed input and waits.
    if (typeof gate === 'object' && state?.session && state.atTurnBoundary === state.session) {
      this.settleTurn(runId, state, 'gate', this.boundaryTurn(runId, state, state.session, true), gate);
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
    if (refusal) { this.queueCompletionRefusal(runId, refusal); return 'held'; }
    // Every blocker but the pending human question is a refusal: the question parks for the user.
    this.store.appendEvent(runId, { type: 'note', tone: 'warning', message: 'Completion blocked: answer the pending human question.' });
    this.move(runId, 'park', { finishedAt: undefined });
    this.store.flush();
    if (state) {
      this.clearIdleTimer(state);
      this.line.leavePool(runId); this.line.park(runId);
      if (state.currentStepId) this.store.updateStep(runId, state.currentStepId, { status: 'waiting' });
      this.releaseSlot();
    }
    return 'held';
  }

  /** Human Finish keeps the worker guarantees and bypasses request obligations only. */
  private completionMayPass(runId: string): boolean { return completionGateReads.completionMayPass(this.inputReceiptContext, this.completionGateHost, runId); }

  /** The session just took a refusal nudge, live or queued (hearsay-tools/cezarion#1301): its turn is
   *  the nudge's, and its reply is bounded by the no-wait nudge's reply timer, so a harness that
   *  reads the refusal and says nothing parks on Cezar's human wait instead of holding the slot. */
  private awaitCompletionNudgeReply(runId: string, state: ActiveRun, session: AgentSession): void { this.turnNudges.awaitCompletionNudgeReply(runId, state, session); }

  /**
   * A blocked done found when the session is gone (`settleSuccess` after its async work, a
   * restart; hearsay-tools/cezarion#1301): the refusal is queued as one lifecycle input, charged as
   * the live nudge is, and the scheduler continuation reopens the session to deliver it
   * (`queueWaitWake`); its delivery marks that turn as the nudge's. Open waits come first: they wake
   * the run, and the refusal is a note. A spent budget opens Cezar's `budget` human wait, and an
   * input the full inbox refuses leaves the run waiting for the user. Always true.
   */
  private queueCompletionRefusal(runId: string, refusal: NonNullable<ReturnType<RunManager['completionRefusal']>>): boolean { return this.turnNudges.queueCompletionRefusal(runId, refusal); }

  /** Stop discards a refusal the run still owes, as it discards its waits: a later Continue must not
   *  deliver a stale one (hearsay-tools/cezarion#1301). One an inbox read holds is left to it. */
  private retireCompletionRefusal(runId: string): boolean { return this.turnNudges.retireCompletionRefusal(runId); }

  /** A refusal `queueCompletionRefusal` queued and the run has not received yet. */
  private owesCompletionRefusal(runId: string): boolean { return completionGateReads.owesCompletionRefusal(this.inputReceiptContext, this.completionGateHost, runId); }

  /** A closing session leaves the run something to reopen for: an agent wait, or a refusal queued
   *  for it (hearsay-tools/cezarion#1301). A refusal takes a wait's bounded delivery retry, so a
   *  session that keeps closing before it is submitted stops at `MAX_WAKE_DELIVERY_ATTEMPTS`
   *  instead of reaching the success path, which would queue the refusal again. */
  private holdsClosingWakes(runId: string): boolean { return completionGateReads.holdsClosingWakes(this.inputReceiptContext, this.completionGateHost, runId); }

  /** A human message or a wake (hearsay-tools/cezarion#1301): the turn it opens or steers no longer
   *  answers a refusal nudge, so its blocked done gets a fresh nudge rather than the second step. */
  private startCompletionCycle(state: ActiveRun): void { startCompletionCycle(state); }

  registerWorkerWait(parentId: string, request: WorkerWaitRequest): WorkerWait { return this.waitRegistry.registerWorkerWait(parentId, request); }
  registerWorkerListWait(runId: string, request: { workerIds?: string[]; requestIds?: string[] | undefined; mode?: WorkerWaitRequest['mode']; timeoutSeconds: number }, via: 'cezar_wait' | 'cez-worker-wait'): DeadlinedWorkerWaitEntry { return this.waitRegistry.registerWorkerListWait(runId, request, via); }
  private registerCompletionWait(runId: string, workerIds: string[], requestIds?: string[]): WorkerWaitEntry { return this.waitRegistry.registerCompletionWait(runId, workerIds, requestIds); }
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

  private recoverWorkerMessages(families: readonly RunRecord[], familyRootId: string | undefined): void { return this.workerQuestions.recoverWorkerMessages(families, familyRootId); }

  private noticeParkedWorkers(rootId: string): void { return this.workerQuestions.noticeParkedWorkers(rootId); }

  private answersFallenBackAsk(runId: string, opts: { text?: string | undefined; images?: PastedContent[] | undefined }, deferred: boolean): boolean { return this.workerQuestions.answersFallenBackAsk(runId, opts, deferred); }

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
    this.withdrawCezarHumanWaits(runId);
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
        this.cancelOpenWaits(runId);
        this.acceptRootRequestFinish(runId);
      } catch { return false; }
      this.closeQuestionOnFinish(runId);
      state.finishRequested = true;
      this.clearIdleTimer(state);
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

  /** A clean process exit cannot complete a workflow still blocked on a question.
   * Keep its existing durable waiting step so Continue can resume the tail. Cezar's fallback
   * question on a worker is not one: the clean exit supersedes it, so the workflow goes on as the
   * plain park it replaced did (hearsay-tools/cezarion#1301). */
  private supersedeFallbackThenWorkflowAsk(runId: string, state: ActiveRun): boolean { return this.runSettlement.supersedeFallbackThenWorkflowAsk(runId, state); }

  private waitingWorkflowStepIndex(run: RunRecord): number {
    return workflowPosition.waitingWorkflowStepIndex(run, isSyntheticContinuation, record => this.ciWorkflowResumeStepIndex(record));
  }

  /**
   * Whether a step session closed without its done while a later step waits (hearsay-tools/cezarion#1620).
   * It reads and clears the done `closeAsDone` recorded. Finish is an explicit stop, settled as before.
   */
  private stepLeftOpen(state: ActiveRun, stepId: string, next: WorkflowStepDef | undefined): boolean { return this.runSettlement.stepLeftOpen(state, stepId, next); }

  /** The workflow step after the one a continuation resumes, when that one is not the last: the
   *  continuation's done completes the resumed step and starts this one (hearsay-tools/cezarion#1620). */
  private continuationNextStep(runId: string): WorkflowStepDef | undefined {
    return workflowPosition.continuationNextStep(this.store, runId, record => this.waitingWorkflowStepIndex(record));
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
      return this.admitContinuation(runId, opts, deferForCapacity, conversation);
    } finally {
      this.store.unpin(runId, 'continue');
    }
  }

  private admitContinuation(
    runId: string,
    opts: ContinueRunOptions,
    deferForCapacity: boolean,
    conversation: continuation.ContinuationConversation,
  ): { ok: boolean; error?: string } {
    const admitted = new continuation.ContinuationChecks(runId, this.repoRoot, opts, deferForCapacity, conversation, {
      active: () => this.isActive(runId),
      autosaveBlocker: () => this.autosaveCleanupBlocker(runId),
      reclaiming: () => this.claims.has(runId),
      run: () => this.store.getRun(runId),
      historyDeletionPending: () => this.historyDeletionPending(runId),
      parentInReview: parentId => this.store.getRun(parentId)?.status === 'review',
      answersFallback: () => this.answersFallenBackAsk(runId, opts, deferForCapacity),
      identity: (run, session) => this.workerStep(runId, continuationDefStep(this.store, run, session)?.id),
      beforeFinalStep: run => this.waitingBeforeFinalWorkflowStep(run),
      waitingStepIndex: run => this.waitingWorkflowStepIndex(run),
      pendingFallback: () => this.pendingWorkerFallback(runId),
      pendingAsk: () => this.hasPendingHumanAsk(runId),
      rootFinishing: run => this.executionBlockedByRootFinish(run),
      routedAsk: () => this.routedAsk(runId),
      ciStepIndex: run => this.ciWorkflowResumeStepIndex(run),
      untouched: isUntouchedCancelledRun,
      sessionId: step => this.resumableSessionId(runId, step),
    }, ROUTED_QUESTION_REFUSAL).prepare();
    if (!admitted.ok) return admitted;
    return this.acceptContinuation(runId, opts, deferForCapacity, conversation, admitted);
  }

  /** Overrides still persist before the execution checkpoint, even if that checkpoint refuses. */
  private acceptContinuation(runId: string, opts: ContinueRunOptions, deferForCapacity: boolean,
    conversation: continuation.ContinuationConversation, admitted: continuation.ContinuationAdmission): { ok: boolean; error?: string } {
    if (admitted.identity === undefined && continuation.hasOverrides(opts)) {
      const refusal = continuation.modelRefusal(opts, admitted.targetRunner);
      if (refusal) return refusal;
      this.store.updateRun(runId, continuation.overridePatch(admitted.run, opts, admitted.targetRunner, admitted.originalRunner));
    }
    if (admitted.untouched) return this.acceptUntouchedContinuation(runId, opts, admitted.supersedes);
    return this.acceptResumedContinuation(runId, opts, deferForCapacity, conversation, admitted);
  }

  private acceptUntouchedContinuation(runId: string, opts: ContinueRunOptions, supersedes: boolean): { ok: boolean; error?: string } {
    const current = this.store.getRun(runId)!;
    let job: { workflow: WorkflowDef; input: StartRunInput };
    try {
      job = current.delegation?.role === 'worker'
        // A projection of the job the line will start, not a status write.
        // ast-grep-ignore: run-status-write-outside-transition
        ? this.ownedJob({ ...current, status: 'queued' })
        : { workflow: current.workflowDef!, input: queuedRecoveryInput(current) };
      this.beginWorkerExecution(runId, false);
    } catch (error) { return { ok: false, error: admissionError(error, 'original execution checkpoint unavailable') }; }
    if (supersedes) this.supersedeWorkerFallback(runId);
    const content = continuation.content(opts);
    const message = content.length ? this.toQueuedMessage(runId, content) : undefined;
    this.clearAutoResume(runId);
    this.store.setArchived(runId, false);
    this.move(runId, 'continue-line', { stopping: undefined, error: undefined, finishedAt: undefined,
      currentStepId: undefined, ...(message ? { queuedMessages: [...(current.queuedMessages ?? []), message] } : {}) });
    this.store.flush();
    this.line.enqueueJob(runId, job);
    void this.pump();
    return { ok: true };
  }

  private acceptResumedContinuation(runId: string, opts: ContinueRunOptions, deferForCapacity: boolean,
    conversation: continuation.ContinuationConversation, admitted: continuation.ContinuationAdmission): { ok: boolean; error?: string } {
    const { run, supersedes } = admitted;
    // Usage-limit holds join the line even for a human Continue, behind known account deadlines.
    const toLine = deferForCapacity || isUsageLimitHold(run);
    try { this.beginWorkerExecution(runId, !toLine); }
    catch (error) { return { ok: false, error: admissionError(error, 'worker execution checkpoint unavailable') }; }
    this.clearAutoResume(runId);
    if (!deferForCapacity) this.clearWakeBackoff(runId);
    const failure = continuation.previousFailure(run);
    const continuationStep = continuation.nextStep(run);
    const stepId = continuationStep.id;
    if (run.delegation?.role !== 'worker') this.store.addStep(runId, continuationStep);
    const recovered = deferForCapacity && !conversation && !opts.answerInputId ? run.continuationMessage : undefined;
    const message = recovered ?? this.toQueuedMessage(runId, continuation.content(opts));
    const { prompt, resumeContext } = continuation.opening(message, recovered, deferForCapacity, conversation, opts,
      RESTART_CONTINUATION_PROMPT, failure);
    // The recoverable status and original input must commit before startup can await anything.
    const acceptedPatch = {
      continuationMessage: continuation.acceptedMessage(message, stepId, prompt, resumeContext, recovered, conversation, opts, deferForCapacity),
      status: transition(toLine ? 'continue-line' : 'continue-now', () => this.store.getRun(runId)),
      error: undefined,
      finishedAt: undefined,
      currentStepId: toLine ? undefined : stepId,
      invalidAsk: undefined,
      archived: false,
      archivedAt: undefined,
    };
    const refusal = this.checkpointContinuation(runId, run, acceptedPatch, continuationStep, conversation);
    if (refusal) return refusal;
    if (supersedes) this.supersedeWorkerFallback(runId);
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
      try { this.store.commitWorkerContinuation(runId, acceptedPatch, continuationStep, conversation); }
      catch {
        // No session exists yet. Release the private reservation through execution finalization.
        void this.finishWorkerExecution(runId);
        return { ok: false, error: 'worker execution checkpoint unavailable' };
      }
    } else this.store.updateRun(runId, acceptedPatch);
  }

  private dispatchAcceptedContinuation(runId: string, toLine: boolean, stepId: string,
    resumeSessionId: string | undefined, targetRunner: RunnerId, prompt: string, images: PastedContent[]): { ok: boolean } {
    if (toLine) {
      this.line.enqueueContinuation(runId, {
        stepId, sessionId: resumeSessionId, backend: targetRunner, prompt, images, lineJoinedAt: Date.now(),
      });
      this.move(runId, 'continue-line', { error: undefined, finishedAt: undefined, currentStepId: undefined });
      // Enqueueing wakes the scheduler even after the previous execution released its slot.
      void this.pump();
      return { ok: true };
    }
    this.line.markStarting(runId);
    void this.runContinuation(runId, stepId, resumeSessionId, targetRunner, prompt, images)
      .catch((err: unknown) => this.failCrashedContinuation(runId, err))
      .finally(() => this.finishWorkerExecution(runId));
    return { ok: true };
  }

  /** A Continue whose engine threw: the run fails and leaves the active set (exit `fail-crash`). */
  private failCrashedContinuation(runId: string, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    this.move(runId, 'fail-crash', {
      error: `continue crashed: ${message}`,
      finishedAt: new Date().toISOString(),
    });
    this.line.unmarkStarting(runId);
    this.dropActive(runId);
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
    if (this.holdContinuationForRootFinish(runId, { stepId, sessionId, backend, prompt, images, lineJoinedAt: Date.now() })) return;
    workerIdentity(this.store, this.repoRoot, runId);
    const record = this.store.getRun(runId);
    const workspace = await this.continuationWorkspace(runId, stepId, record);
    if (!workspace) return;
    if (this.settleStoppedContinuation(runId)) return;
    // Continue and restart recovery build their own ActiveRun: hydrate the durable mode here.
    const state = createActiveRun({
      cwd: workspace.cwd,
      pendingHumanAsk: this.hasPendingHumanAsk(runId),
      autonomous: record?.autonomous === true,
    });
    this.activate(runId, state);
    this.line.unmarkStarting(runId);
    const lease = this.continuationRepoRootLease(runId, state);
    if (lease && !(await lease)) return;
    const setupNote = await this.prepareContinuationWorktree(runId, state, record, workspace.rematerialized);
    // A Stop during setup settles below, at the prelaunch cancellation check before any spawn.
    // Registry snapshot for `/skill` expansion. A continuation builds its OWN ActiveRun, and without
    // this the resumed session expanded against an empty registry and leaked `/om-...` verbatim to
    // the backend, which answered "Unknown skill" (open-mercato/cezar#811). Best-effort — discovery must never
    // break Continue.
    await this.loadRunSkills(state, 'ignore');

    this.startContinuationStep(runId, stepId, record, sessionId, backend);
    const opening = continuationOpening(this.store, {
      routedAsk: (id) => this.routedAsk(id),
      readPersistedAttachments: (id, urls, kind) => this.readPersistedAttachments(id, urls, kind),
    }, runId, stepId, state, record, { prompt, images, persistedImages, persistedAttachments });
    prompt = opening.prompt;
    const answer = this.openingAnswer(runId, state, opening);
    state.pendingHumanAsk = answer.askSeq === undefined && this.hasPendingHumanAsk(runId);

    const turn: SessionTurn = { text: '', completedText: '', tail: 'none', scheduleWakeup: undefined, sessionError: undefined };
    const sink = this.makeUiSink(runId, stepId);
    const onEvent = createSessionEventHandler(this.inputReceiptContext, this.sessionEventHost(), {
      runId, state, turn, stepId, backend, sink, tokenBase: 0,
      emit: event => this.store.appendEvent(runId, event),
      acknowledge: () => this.acknowledgeOpeningTurn(runId, state, answer),
    });

    const settings = await this.continuationLaunchSettings(runId, stepId, state, record, sessionId, backend, sink);
    if (!settings) return;
    if (state.cancelled) { this.settleContinuationPrelaunchCancel(runId, stepId, state); return; }
    if (this.holdContinuationForRootFinish(runId, { stepId, sessionId, backend, prompt, images, lineJoinedAt: Date.now() }, state)) return;
    this.applyContinuationSettings(runId, stepId, state, backend, settings);
    const { runner, skipSkillOnResume } = continuationRunner(backend, sessionId, settings.owningStep);
    // Re-expand the continued step's skill from the current registry (#790) BEFORE
    // provisionSession. Materializing the skill used to sit after the pre-launch
    // revalidation, so Stop during that await still launched with revoked tools.
    // `record.systemPrompt` is only the extra prompt; the opening session put
    // `skillSystemPrompt(skill)` in front. Skip that prefix only when this
    // session resumes into its own thread on an in-thread runner — those
    // already carry the playbook in history. A missing skill degrades to
    // today's extra-only prompt with one lifecycle warning; in-thread skips
    // do not warn. Workers still inherit only the extra prompt (#778).
    const pendingSkills = this.continuationSkills(runId, state, prompt, settings.toolsStep, skipSkillOnResume);
    const skills = pendingSkills
      ? await pendingSkills
      : { skillPrompt: undefined, fallbackSkillPrompt: undefined, files: new Map<string, string>() };
    state.currentStepId = stepId;
    this.beginUsageInvocation(runId, state, stepId);
    // A continuation's opening message becomes the session's `userPrompt` and never passes
    // through `deliverMessage`, so it needs the SAME delivery-only `/skill` rewrite the
    // live path applies (#811). Delivery-only: the `user-message` event above already
    // persisted the user's original text, and the transcript must keep showing that.
    state.agentSessionError = undefined;
    if (this.workerExecutionStopped(runId)) { state.cancelled = true; throw new Error('Worker stopped before launch'); }
    const launch = await launchPreamble(this.launchPreambleHost(), runId, state);
    const { delegation, webhooksPart, ciTools } = launch;
    // Stop/Finish can arrive while the local tool controller is starting.
    if (launch.stale) {
      this.settleStaleContinuationLaunch(runId, stepId, state, { stepId, sessionId, backend, prompt, images });
      return;
    }
    state.inputDelivery = inputDeliveryOf(runner); state.unreadInputIds = new Set(); state.consumedBeforeAck = new Set();
    const session = this.startContinuationSession(runId, state, runner, {
      stepId, sessionId, prompt, setupNote, opening, skills, skipSkillOnResume, settings, delegation, webhooksPart, ciTools,
    }, onEvent, turn, sink);
    return this.awaitContinuationSession(runId, state, session, { stepId, sink, turn, delegation, ciTools });
  }

  /** Where a Continue runs: an owned worker's verified workspace, or the task's worktree, which
   *  retention may have reclaimed (#483), else the repository root. Returns undefined after an
   *  unavailable owned workspace failed the run. */
  private async continuationWorkspace(
    runId: string,
    stepId: string,
    record: RunRecord | undefined,
  ): Promise<{ cwd: string; rematerialized: boolean } | undefined> {
    if (record?.delegation?.role === 'worker') {
      const cwd = await this.ownedContinuationWorkspace(runId, stepId, record, record.delegation);
      return cwd === undefined ? undefined : { cwd, rematerialized: false };
    }
    // Retention (#483) rebuilt a reclaimed directory: a bare checkout that needs setup again (#917).
    const rematerialized = await rematerializeReclaimedWorktree(this.repoRoot, this.store, runId);
    const cwd = record?.worktreePath && existsSync(record.worktreePath) ? record.worktreePath : this.repoRoot;
    return { cwd, rematerialized };
  }

  /** An owned worker's workspace for a Continue, verified with its parent's context. Returns
   *  undefined after it failed the run: owned workers never adopt or recreate an unverified resource. */
  private async ownedContinuationWorkspace(
    runId: string,
    stepId: string,
    record: RunRecord,
    delegation: WorkerDelegationRecord,
  ): Promise<string | undefined> {
    try {
      return await ownedContinuationWorkspace(this.store, this.repoRoot, this.dataDir, record, delegation);
    } catch (error) {
      const message = `owned workspace unavailable: ${error instanceof Error ? error.message : String(error)}`;
      const finishedAt = new Date().toISOString();
      this.store.updateStep(runId, stepId, { status: 'failed', error: message, finishedAt });
      this.move(runId, 'fail-start', { error: message, finishedAt, currentStepId: undefined });
      this.store.appendEvent(runId, { type: 'lifecycle', message });
      this.line.unmarkStarting(runId);
      this.dropActive(runId);
      return undefined;
    }
  }

  /** A Stop that arrived while the Continue resolved its workspace cancels the run before it
   *  becomes active. */
  private settleStoppedContinuation(runId: string): boolean {
    if (!this.store.getRun(runId)?.stopping) return false;
    this.move(runId, 'cancel', { finishedAt: new Date().toISOString() });
    this.line.unmarkStarting(runId);
    this.dropActive(runId);
    return true;
  }

  /** The repository-root lease of a Continue that runs in the repository root. Returns undefined
   *  when no lease is needed, so that path does not yield, else whether the lease was granted. */
  private continuationRepoRootLease(runId: string, state: ActiveRun): Promise<boolean> | undefined {
    if (state.cwd !== this.repoRoot) return undefined;
    if (repositoryRootLockDisabled()) {
      this.store.appendEvent(runId, {
        type: 'note',
        message: REPOSITORY_ROOT_LOCK_DISABLED_NOTE,
      });
      return undefined;
    }
    this.store.appendEvent(runId, {
      type: 'note',
      message: 'waiting for exclusive access to the repository working tree',
    });
    return this.acquireContinuationRepoRoot(runId, state);
  }

  /** Wait for the repository-root lease; a Stop during the wait cancels the run. */
  private async acquireContinuationRepoRoot(runId: string, state: ActiveRun): Promise<boolean> {
    if (await this.acquireRepoRoot(runId, state)) return true;
    this.move(runId, 'cancel', {
      finishedAt: new Date().toISOString(),
      currentStepId: undefined,
    });
    this.store.appendEvent(runId, { type: 'lifecycle', message: 'run cancelled' });
    this.dropActive(runId);
    return false;
  }

  /** Arm autosave, seed the handoff file, and run worktree setup. Returns setup's note for the
   *  opening message. */
  private async prepareContinuationWorktree(
    runId: string,
    state: ActiveRun,
    record: RunRecord | undefined,
    rematerialized: boolean,
  ): Promise<string | undefined> {
    this.armAutosave(runId, state);
    if (record) seedHandoffFile(this.dataDir, record); // idempotent — normally already there
    // Worktree setup (#917) for a directory retention rebuilt, or one a restart interrupted.
    return this.prepareWorktree(
      runId,
      state,
      (await loadConfig(this.repoRoot)).worktreeSetup,
      (event) => this.store.appendEvent(runId, event),
      rematerialized ? 'rematerialized' : 'resume',
    );
  }

  /** Mark the run and the Continue's step as running, then open the step. A Cursor session resumes
   *  on the transport it was opened with. */
  private startContinuationStep(
    runId: string,
    stepId: string,
    record: RunRecord | undefined,
    sessionId: string | undefined,
    backend: RunnerId,
  ): void {
    this.move(runId, 'start', {
      error: undefined,
      finishedAt: undefined,
      currentStepId: stepId,
    });
    this.store.updateStep(runId, stepId, {
      status: 'running',
      iterations: 1,
      startedAt: new Date().toISOString(),
      sessionId,
      backend,
      ...(sessionId && backend === 'cursor' ? {
        sessionTransport: record?.steps.find((step) => step.sessionId === sessionId)?.sessionTransport ?? 'cursor-acp',
      } : {}),
    });
    this.store.appendEvent(runId, { type: 'step-start', stepId, name: 'Continue', kind: 'agent', iteration: 1 });
  }

  /** The human ask a human Continue answers, and the human waits that answer settles. */
  private openingAnswer(runId: string, state: ActiveRun, opening: ContinuationOpening): OpeningAnswer {
    const askSeq = opening.checkpoint?.origin === 'human' ? this.pendingHumanAskSeq(runId) : undefined;
    state.openingAnswerAskSeq = askSeq;
    // The human waits this answer answers; one the opening turn opens is its next question.
    const waits = askSeq === undefined ? []
      : openWaits(this.store.getRun(runId) ?? {}).filter(wait => wait.kind === 'human').map(wait => wait.id);
    return { askSeq, waits, parentAnswer: opening.parentAnswer };
  }

  /**
   * A completed turn acknowledges the opening payload. Until then a restart
   * must replay it, including a crash after startSession but before delivery.
   * Returns false when the opening input's checkpoint failed, and the turn end stops there.
   */
  private acknowledgeOpeningTurn(runId: string, state: ActiveRun, answer: OpeningAnswer): boolean {
    if (state.cancelled) return true;
    const session = state.session?.open ? state.session : undefined;
    const opening = session ? state.openingAgentInputId : undefined;
    const askSeq = session ? answer.askSeq : undefined;
    // One commit (hearsay-tools/cezarion#1805): a store reopened after a crash never reads the
    // opening input handled while the question it answers is still open.
    const outcomes: RunOutcome[] = [
      ...(opening ? [{ kind: 'opening-handled' as const, inputId: opening, at: new Date().toISOString() }] : []),
      ...(askSeq !== undefined ? [{ kind: 'answered' as const, waitIds: answer.waits }] : []),
    ];
    // Only the opening input's checkpoint stops the turn end; the rest is best effort, as before.
    try { this.store.commitOutcome(runId, outcomes, { patch: { continuationMessage: undefined } }, { bestEffort: !opening }); }
    catch (error) { this.latchAgentInputError(runId, state, session!, `agent input delivery checkpoint failed: ${error instanceof Error ? error.message : String(error)}`); return false; }
    if (opening) { state.openingAgentInputId = undefined; this.reconcileWorkerWaits(); }
    if (askSeq !== undefined) {
      this.store.appendEvent(runId, { type: 'human-input-delivered', askSeq, ...(answer.parentAnswer ? { source: 'parent' } : {}) });
      answer.askSeq = undefined;
      state.openingAnswerAskSeq = undefined;
    }
    return true;
  }

  /** Latch an agent input error, then interrupt: a transport failure the interrupt causes is secondary. */
  private latchAgentInputError(runId: string, state: ActiveRun, session: AgentSession, message: string): void {
    state.agentInputError = message;
    try { session.interrupt(); } finally {
      try { this.store.appendEvent(runId, { type: 'error', message }); }
      catch { console.error(`[cez] ${message}`); }
    }
  }

  /**
   * What a Continue runs with. Backend + model come off the record: the run's current backend by
   * default, or the follow-up override that `continueRun` persisted before scheduling (#401).
   * Returns undefined after a pre-spawn gate failed the turn.
   */
  private async continuationLaunchSettings(
    runId: string,
    stepId: string,
    state: ActiveRun,
    record: RunRecord | undefined,
    sessionId: string | undefined,
    backend: RunnerId,
    sink: UiEventSink,
  ): Promise<ContinuationSettings | undefined> {
    // Resuming reattaches to a session that lives inside ONE account's config dir, so the
    // continuation must run under the account that created it — not whatever the project has
    // been switched to since. The owning step is the one carrying this session id.
    const owningStep = sessionId === undefined
      ? undefined
      : record?.steps.find((s) => s.sessionId === sessionId);
    // An owned worker's turn runs under the identity pinned for the step it extends (#452).
    const toolsStep = continuationDefStep(this.store, record, sessionId);
    const stepIdentity = this.workerStep(runId, toolsStep?.id);
    // The owning step also names the session's tools: resolve `allowedTools`/`bashAllowlist`
    // from the persisted `workflowDef` exactly as the first spawn did (`runAgentStep`).
    // Rebuilding with the bare DEFAULT_ALLOWED_TOOLS silently revoked every per-step grant
    // (MCP servers, subagents) on Continue, restart recovery and the usage-limit auto-resume
    // — and dropping `bashAllowlist` WIDENED Bash from an allowlist to unrestricted
    // (`AgentRunSpec.toolGrant`, #430). Record steps share ids with `workflowDef.steps`;
    // a synthetic `continue-N` owner and a fresh-session continuation (backend switch — no
    // owning session) both extend the run's tail, so they resolve from the definition's last
    // agent step. A legacy record without `workflowDef` (#367), or a session no step owns,
    // keeps today's defaults.
    const toolGrant = stepToolGrant(stepIdentity?.grants, toolsStep, backend);
    const model = await continuationModel(this.store, this.repoRoot, runId, state, record, toolsStep, stepIdentity, backend);
    if (typeof model === 'string') { this.failContinuationBeforeSpawn(runId, stepId, sink, model); return undefined; }
    const effort = continuationEffort(this.repoRoot, record, toolsStep, stepIdentity);
    if (typeof effort === 'string') { this.failContinuationBeforeSpawn(runId, stepId, sink, effort); return undefined; }
    // The temp-directory preflight (#785) rides along with the account resolution: a resumed
    // turn hits the same broken `/tmp` a fresh one would, and an agent whose shell silently
    // returns nothing is worse than a turn that refuses to start and says why. So does an account
    // that would open another folder than the one its session lives in (#1283).
    const profile = await this.stepProfileFor(runId, backend, {
      recordedProfileId: owningStep?.profileId,
      stepId: toolsStep?.id,
    });
    if (typeof profile === 'string') { this.failContinuationBeforeSpawn(runId, stepId, sink, profile); return undefined; }
    return {
      owningStep, toolsStep, toolGrant, backendModel: model.backendModel, effort: effort.effort, profile,
      extraSystemPrompt: record?.systemPrompt,
    };
  }

  /** Settle this turn as a failure before anything is spawned — the shape every
   *  pre-spawn gate needs (model identity, #405; temp directory, #785). */
  private failContinuationBeforeSpawn(runId: string, stepId: string, sink: UiEventSink, message: string): void {
    const failedAt = new Date().toISOString();
    sink.sessionEnded('error', message);
    this.store.updateStep(runId, stepId, {
      status: 'failed',
      error: message,
      finishedAt: failedAt,
    });
    this.move(runId, 'fail-start', {
      error: `continue failed: ${message}`,
      finishedAt: failedAt,
      currentStepId: undefined,
    });
    this.store.appendEvent(runId, {
      type: 'lifecycle',
      message: `continue failed — ${message}`,
    });
    this.dropActive(runId);
  }

  /** Record the Continue's account on its step and the settings its workers inherit. */
  private applyContinuationSettings(
    runId: string,
    stepId: string,
    state: ActiveRun,
    backend: RunnerId,
    settings: ContinuationSettings,
  ): void {
    this.store.updateStep(runId, stepId, { profileId: settings.profile.profileId });
    state.delegationSettings = { cwd: state.cwd, runner: backend, model: settings.backendModel,
      effort: settings.effort, agentProfile: settings.profile.profileId, accountBinding: settings.profile.accountBinding,
      systemPrompt: settings.extraSystemPrompt, ...toolGrantLists(settings.toolGrant) };
  }

  /** The continued step's skill files and playbook, when the step names a skill or the prompt
   *  starts with a `/name`. Returns undefined otherwise, so that path does not yield. */
  private continuationSkills(
    runId: string,
    state: ActiveRun,
    prompt: string,
    toolsStep: WorkflowStepDef | undefined,
    skipSkillOnResume: boolean,
  ): Promise<ContinuationSkills> | undefined {
    const continuedSkillName = toolsStep?.skill;
    // The continued step's skill and a leading `/name` in this prompt both get their companions;
    // upstream rebuilt only the slash name, so an ordinary Continue lost the step skill's (#1408).
    const continuationSlash = leadingSlashSkillName(prompt);
    if (!continuedSkillName && !continuationSlash) return undefined;
    return this.provisionContinuationSkills(runId, state, continuedSkillName, continuationSlash, skipSkillOnResume);
  }

  /** Reinstall the continued step's skill and a leading `/name`'s, and build the playbook. */
  private async provisionContinuationSkills(
    runId: string,
    state: ActiveRun,
    continuedSkillName: string | undefined,
    continuationSlash: string | undefined,
    skipSkillOnResume: boolean,
  ): Promise<ContinuationSkills> {
    let skillPrompt: string | undefined;
    let fallbackSkillPrompt: string | undefined;
    let files = new Map<string, string>();
    if (continuedSkillName) {
      let skill = this.enabledSkills(state).find((candidate) => candidate.name === continuedSkillName);
      if (!skill) skill = await this.awaitContinuedSkill(state, continuedSkillName);
      if (skill) {
        // Reinstall the skill and its companions — into a #483 rematerialized
        // worktree, or a team skill's cache copy when the worktree is gone — before
        // the playbook, which names a cache copy's directory (#1024, #1408). No note on Continue.
        files = (await this.runSkills.provisionRunSkills(runId, state, { stepSkill: skill.name, slash: continuationSlash })).filesDir;
        const playbook = skillSystemPrompt(skill, files.get(skill.name));
        if (skipSkillOnResume) fallbackSkillPrompt = playbook;
        else skillPrompt = playbook;
      } else if (!skipSkillOnResume) {
        this.store.appendEvent(runId, {
          type: 'lifecycle',
          message: `skill /${continuedSkillName} is not in the skill registry — its instructions were not re-sent to the continued session`,
        });
      }
    }
    if (!continuedSkillName || !this.enabledSkills(state).some((candidate) => candidate.name === continuedSkillName)) {
      if (continuationSlash) files = (await this.runSkills.provisionRunSkills(runId, state, { slash: continuationSlash })).filesDir;
    }
    return { skillPrompt, fallbackSkillPrompt, files };
  }

  /** The continued step's skill when the registry did not list it yet. */
  private async awaitContinuedSkill(state: ActiveRun, continuedSkillName: string): Promise<Skill | undefined> {
    // Boot recovery can outrun the async team-skills cache (`getTeamSkillsCached`
    // returns [] until `initialTeamSkillsLoad` resolves). Wait briefly, then
    // re-discover; never hang Continue on the network. The on-disk clone's
    // list arrives before the passive fetch (#859), so stop as soon as it
    // names this skill instead of waiting out a slow first fetch of the day.
    try {
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(resolve, 1_500);
        timeout.unref?.();
        const settle = () => { clearTimeout(timeout); resolve(); };
        waitForTeamSkills(this.repoRoot).then(settle, settle);
        waitForCachedTeamSkills(this.repoRoot).then((cached) => {
          if (cached.some((candidate) => candidate.name === continuedSkillName)) settle();
        }, () => undefined);
      });
      await this.loadRunSkills(state, 'ignore');
      return this.enabledSkills(state).find((candidate) => candidate.name === continuedSkillName);
    } catch {
      // Best-effort — a slow or failing team-skills load must not fail Continue.
      return undefined;
    }
  }

  /** A Stop before the Continue's session spawned: cancel the step and the run. */
  private settleContinuationPrelaunchCancel(runId: string, stepId: string, state: ActiveRun): void {
    this.store.updateStep(runId, stepId, { status: 'cancelled' });
    this.move(runId, 'cancel', { finishedAt: new Date().toISOString(), currentStepId: undefined });
    this.clearAutosaveTimer(state); this.dropActive(runId);
  }

  /** A Continue's launch went stale while it provisioned (`launchStale`). A replaced active run
   *  needs nothing more; a Stop cancels the run; a root Finish holds the Continue in the queue. */
  private settleStaleContinuationLaunch(
    runId: string,
    stepId: string,
    state: ActiveRun,
    held: Omit<PendingContinuation, 'lineJoinedAt'>,
  ): void {
    if (this.active.get(runId) !== state) return;
    if (state.cancelled || this.workerExecutionStopped(runId)) {
      state.cancelled = true;
      this.settleContinuationPrelaunchCancel(runId, stepId, state);
    } else {
      this.holdContinuationForRootFinish(runId, { ...held, lineJoinedAt: Date.now() }, state);
    }
  }

  /** Start a Continue's session, resuming its own session when it has one. A throw revokes the
   *  tools this launch was given and propagates to `continueRun`. */
  private startContinuationSession(
    runId: string,
    state: ActiveRun,
    runner: ReturnType<typeof createRunner>,
    launch: ContinuationSessionLaunch,
    onEvent: (event: AgentEvent) => void,
    turn: SessionTurn,
    sink: UiEventSink,
  ): AgentSession {
    const { delegation, ciTools, opening, skills, settings } = launch;
    let session: AgentSession | undefined;
    try {
      // Provisioning determines the actual capability, including a fresh session after recovery.
      const resumed = this.launchOpening(runId, state, launch.stepId, {
        body: expandRegistrySlashSkillText(launch.prompt, this.enabledSkills(state), skills.files) +
          (launch.setupNote ? `\n\n${launch.setupNote}` : ''),
        ciTools,
        checkpoint: opening.checkpoint,
      });
      const continuationTail = this.launchSystemTail({
        extraSystemPrompt: settings.extraSystemPrompt, delegation, webhooksPart: launch.webhooksPart,
        env: settings.profile.env, ciTools, handoffInjected: resumed.handoffInjected,
      });
      session = startManagedSession(runner,
        {
          // Skill body (when resent), then the run's extra system prompt, then
          // the handoff contract — the same order as the opening session (#790).
          // In-thread resume omits the skill from systemPrompt; OpenCode's 404
          // fallback uses resumeFallbackSystemPrompt so the fresh session still
          // gets the playbook.
          systemPrompt: composeSystemPrompt(skills.skillPrompt, continuationTail),
          ...(launch.skipSkillOnResume ? {
            resumeFallbackSystemPrompt: composeSystemPrompt(skills.fallbackSkillPrompt, continuationTail),
          } : {}),
          userPrompt: opening.attachments.length
            ? `${resumed.userPrompt}\n\n${pastedAttachmentsText(opening.attachments)}`
            : resumed.userPrompt,
          ...(opening.openingImages.length ? { images: opening.openingImages } : {}),
          cwd: state.cwd,
          toolGrant: settings.toolGrant,
          additionalDirectories: agentDirectories(join(this.dataDir, 'runs'), settings.profile.env),
          env: { ...settings.profile.env, ...delegation?.env, ...ciTools?.env },
          ...(ciTools ? { cezarTools: ciTools.descriptor } : {}),
          ...(delegation ? { restrictNativeDelegation: delegation.restrictNativeDelegation } : {}),
          model: settings.backendModel,
          effort: settings.effort,
          sessionId: launch.sessionId,
          resume: launch.sessionId !== undefined,
          timeoutMs: 0,
        },
        onEvent,
        inputReceipts.inputReceiptCallbacks(this.inputReceiptContext, this.inputReceiptHost, this.inputReceiptSteps, runId, state, () => session, turn, sink, true),
      );
    } catch (error) { ciTools?.revoke(); state.revokeCiTools = undefined; delegation?.revoke(); state.revokeDelegation = undefined; throw error; }
    return session;
  }

  /** Wait for a Continue's session to close, then settle the run by how it closed. Teardown always
   *  revokes the launch's tools, saves the worktree and leaves the active set
   *  (`releaseContinuationSession`). */
  private async awaitContinuationSession(runId: string, state: ActiveRun, session: AgentSession, launch: {
    stepId: string;
    sink: UiEventSink;
    turn: SessionTurn;
    delegation: LaunchDelegation;
    ciTools: LaunchCiTools;
  }): Promise<void> {
    const { stepId, sink, turn } = launch;
    const sessionClosed = this.trackWorkerSessionResult(runId, session);
    state.session = session;
    const resumedNext = this.continuationNextStep(runId);
    state.nextStep = stepScope(session, resumedNext);
    state.sessionEverOpened = true;
    state.interrupt = () => session.interrupt();
    let setupComplete = false;
    const close: ContinuationClose = {};
    try {
      const result = await inputReceipts.sessionResultWithReceipts(this.inputReceiptContext, this.inputReceiptHost, this.inputReceiptSteps, runId, state, session, () => { setupComplete = true; });
      if (this.preserveRunAfterDisposal(runId, state)) return;
      this.withdrawCezarHumanWaits(runId);
      this.persistWorkerAssistantResult(runId, stepId, result.text);
      // A durable CI wait keeps recovery live, not this failed attempt successful.
      if (turn.sessionError || state.agentInputError) throw new Error(turn.sessionError ?? state.agentInputError);
      const settled = this.settleClosedContinuation(runId, state, stepId, sink, resumedNext, close);
      if (settled) await settled;
    } catch (err) {
      if (!setupComplete) {
        try { session.interrupt(); } catch { /* Still wait for actual termination. */ }
        await sessionClosed;
      }
      if (this.preserveRunAfterDisposal(runId, state)) return;
      this.settleFailedContinuation(runId, state, stepId, sink, turn, err);
    } finally {
      await this.releaseContinuationSession(runId, state, launch.delegation, launch.ciTools, close);
    }
  }

  /** Settle a Continue whose session closed without a fault: undelivered wakes, a Stop, a step left
   *  open, a done, or an idle close. Returns the settlement to wait for, or undefined when it
   *  completed without yielding. */
  private settleClosedContinuation(
    runId: string,
    state: ActiveRun,
    stepId: string,
    sink: UiEventSink,
    resumedNext: WorkflowStepDef | undefined,
    close: ContinuationClose,
  ): Promise<void> | undefined { return this.runSettlement.settleClosedContinuation(runId, state, stepId, sink, resumedNext, close); }

  /** The Continue's session failed, or its settlement threw: fail its step, then park the run
   *  when it still holds wakes, else fail it. */
  private settleFailedContinuation(
    runId: string,
    state: ActiveRun,
    stepId: string,
    sink: UiEventSink,
    turn: SessionTurn,
    err: unknown,
  ): void { return this.runSettlement.settleFailedContinuation(runId, state, stepId, sink, turn, err); }

  /** A Continue's session teardown: revoke the launch's tools, record the usage peaks, clear the
   *  timers, save the worktree, leave the active set, then queue the workflow remainder. */
  private async releaseContinuationSession(
    runId: string,
    state: ActiveRun,
    delegation: LaunchDelegation,
    ciTools: LaunchCiTools,
    close: ContinuationClose,
  ): Promise<void> {
    ciTools?.revoke(); state.revokeCiTools = undefined;
    delegation?.revoke(); state.revokeDelegation = undefined;
    this.recordUsagePeaks(runId);
    this.clearIdleTimer(state);
    this.clearAutosaveTimer(state);
    await this.saveWorktree(runId, state, 'turn end');
    // Cancellation may be accepted while final autosave is yielding, even
    // after success was recorded. Retire any durable queue intent before
    // dropping the active state, otherwise pump can launch the tail with a
    // fresh `cancelled:false` state.
    if (state.cancelled) {
      close.resumeWorkflow = undefined;
      if (this.store.getRun(runId)?.status !== 'cancelled') {
        this.move(runId, 'cancel-late', {
          finishedAt: new Date().toISOString(), currentStepId: undefined,
        });
        this.store.appendEvent(runId, { type: 'lifecycle', message: 'run cancelled' });
      }
    }
    this.dropActive(runId);
    if (close.resumeWorkflow) {
      this.line.enqueueJob(runId, close.resumeWorkflow);
      void this.pump();
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

    const launch = await this.startExecution(execution);
    if (!launch) return;
    if (!(await this.prepareExecutionWorktree(execution, launch))) return;

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
      if (this.requeueWhileHeld(runId, workflow, input, launch.taskBackend, state, startAt)) return;
    }

    // Handoff journal (spec 007) — seeded after the worktree exists so the
    // header can name the branch. Idempotent: an existing file stays as-is.
    const seeded = this.store.getRun(runId);
    if (seeded) seedHandoffFile(this.dataDir, seeded);
    // Worktree setup (#917): before the first step, so the agent starts in a prepared tree. Its
    // note rides the first agent step's opening message only, like the task's attachments.
    const setupNote = await this.prepareWorktree(runId, state, launch.config.worktreeSetup, emit, 'start');

    // Every entry path loads the registry — `runContinuation` loads its own, and the one that
    // skipped this leaked raw `/skill` text to the backend (open-mercato/cezar#811). A failed discovery fails the run.
    await this.loadRunSkills(state, 'throw');
    const loop = await this.runWorkflowSteps(execution, launch, { ...openingInputs(this.store, this.dataDir, execution), setupNote });
    if (loop) await this.settleExecution(runId, state, loop);
  }

  /**
   * The launch half of `execute`: the backend, extra system prompt and model identity the run
   * starts with, recorded on the run as it starts. Undefined when the run was cancelled or went
   * back to the queue first.
   */
  private async startExecution(execution: Execution): Promise<ExecutionLaunch | undefined> {
    const { runId, workflow, input, startAt, state, emit } = execution;
    // Resolve the agent backend for this run: the task choice (GUI) wins over
    // the config default. Per-step `runner` can still override it at the step.
    const config = await loadConfig(this.repoRoot);
    if (state.cancelled || this.store.getRun(runId)?.stopping) {
      this.move(runId, 'cancel', { finishedAt: new Date().toISOString() });
      this.dropActive(runId);
      return undefined;
    }
    const taskBackend: RunnerId = input.runner ?? config.defaultRunner;
    // The account may have gone into a usage-limit hold since this run was dequeued — the queue
    // gate cannot be the only one, because dequeue is not the moment of no return. Nothing has
    // happened yet here, so the run goes back to the queue untouched (spec
    // 2026-08-03-auto-resume-after-usage-limit).
    if (this.requeueWhileHeld(runId, workflow, input, taskBackend, undefined, startAt)) return undefined;
    // Extra system prompt (R2 2.3): POST override > config default; echoed on
    // the record so the UI/API can show what the run actually used.
    const extraSystemPrompt = this.store.getRun(runId)?.delegation?.role === 'worker'
      ? input.systemPrompt
      : resolveExtraSystemPrompt(input.systemPrompt, config.systemPrompt);
    const modelIdentity = await taskModelIdentity(this.repoRoot, taskBackend, input);
    if (state.cancelled) {
      this.move(runId, 'cancel', { finishedAt: new Date().toISOString() });
      this.dropActive(runId);
      return undefined;
    }
    const ownedRun = this.store.getRun(runId);
    const owned = ownedRun?.delegation?.role === 'worker' ? ownedRun.delegation.workspace : undefined;
    this.store.updateRun(runId, {
      // A resumed workflow stays durably queued until its next step is actually
      // entered. If setup crashes, recovery can replay from `startAt` instead
      // of treating the previous continuation as the interrupted step.
      status: transition(startAt > 0 ? 'start-held' : 'start', () => this.store.getRun(runId)),
      invalidAsk: undefined,
      startedAt: ownedRun?.startedAt ?? new Date().toISOString(),
      runner: taskBackend,
      systemPrompt: extraSystemPrompt,
      modelIdentity,
    });
    emit({ type: 'lifecycle', message: `run started — workflow "${workflow.name}" (runner: ${taskBackend})` });
    return { config, taskBackend, extraSystemPrompt, ownedRun, owned };
  }

  /**
   * Worktree per task (spec 006): the agent works on its own branch in
   * `.ai/cezar/worktrees/<id>`, never in the user's working tree. A Git task
   * that requests isolation fails closed if the worktree cannot be
   * established; only explicit opt-out and non-Git modes run in place.
   * False when the run stopped here.
   */
  private async prepareExecutionWorktree(execution: Execution, launch: ExecutionLaunch): Promise<boolean> {
    const { runId, input, emit } = execution;
    const repo = await getRepoInfo(this.repoRoot);
    if (repo && input.worktree === false && !launch.owned) {
      // Composer opt-out: run in the repo working tree, no branch/worktree. The
      // repository-root lease serializes these runs by default; the explicit
      // CEZ_DISABLE_REPO_LOCK=1 escape hatch allows unsafe overlap.
      // Pin the starting commit: the session's Changes and Commits views use it
      // as their stable lower bound while reading the current working copy.
      const startingCommit = await getHeadCommit(repo.root);
      if (startingCommit && !launch.ownedRun?.baseBranch) this.store.updateRun(runId, { baseBranch: startingCommit });
      emit({ type: 'note', message: 'worktree off — running in the repo working tree' });
    } else if (repo || launch.owned) {
      emit({
        type: 'note',
        message: `worktree on — using an isolated task worktree (${input.worktree === true ? 'explicit request' : 'default'})`,
      });
      const base = await executionBaseRef(this.store, this.repoRoot, execution, repo, launch);
      return this.createExecutionWorktree(execution, launch, base);
    } else {
      emit({ type: 'note', message: 'not a git repository — running in place, one task at a time' });
    }
    return true;
  }

  /** Opens the task's worktree and prepares it for the first step. False when the worker stopped
   *  first, or when the worktree could not be established, which fails the run. */
  private async createExecutionWorktree(execution: Execution, launch: ExecutionLaunch, base: string): Promise<boolean> {
    const { runId, state, emit } = execution;
    const { owned, ownedRun } = launch;
    try {
      if (this.workerExecutionStopped(runId)) { this.dropActive(runId); return false; }
      const wt = await openExecutionWorktree(this.store, this.repoRoot, this.dataDir, execution, launch, base);
      state.cwd = wt.path;
      this.store.updateRun(runId, {
        worktreePath: wt.path,
        branch: wt.branch,
        baseBranch: wt.baseBranch,
        ...(owned ? { worktree: undefined } : {}),
      });
      emit({ type: 'note', message: `worktree ready — branch ${wt.branch} (base ${wt.baseBranch})` });
      // Seed from this manager's project root: each multi-project context has
      // its own manager/repoRoot and must never copy another project's layer.
      // A worker's explicit `--attach` files win over the main checkout's copy (hearsay-tools/cezarion#1149).
      const attached = executionSeedFiles(ownedRun);
      const seededConfig = await seedAgentConfigLocalLayer(this.repoRoot, state.cwd, process.env, attached).catch(() => []);
      if (seededConfig.length > 0) {
        emit({ type: 'note', message: `seeded personal agent config: ${seededConfig.join(', ')}` });
      }
      this.armAutosave(runId, state);
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const error = `worktree creation failed: ${message}`;
      emit({ type: 'note', message: `${error} — task stopped before workflow execution` });
      this.move(runId, 'fail-start', {
        error,
        finishedAt: new Date().toISOString(),
        currentStepId: undefined,
      });
      emit({ type: 'lifecycle', message: `run failed — ${error}` });
      this.dropActive(runId);
      return false;
    }
  }

  /**
   * The step loop of `execute`, from `startAt`. Returns its outcome for `settleExecution`, or
   * undefined when the run left this execution: parked, back in the queue, or held by another
   * owner.
   */
  private async runWorkflowSteps(
    execution: Execution,
    launch: ExecutionLaunch,
    opening: { attachments: PersistedAttachment[]; images: ContentBlock[] | undefined; setupNote: string | undefined },
  ): Promise<StepLoop | undefined> {
    const { runId, workflow, input, startAt, state, emit } = execution;
    const loop: StepLoop = { checkFailure: null, runError: null, deliveryCapped: false };
    let startImages = opening.images;
    let startAttachments = opening.attachments;
    let startSetupNote = opening.setupNote;

    let i = startAt;
    while (i < workflow.steps.length) {
      if (state.cancelled || this.workerExecutionStopped(runId)) { state.cancelled = true; break; }
      const step = workflow.steps[i] as WorkflowStepDef;
      const kind = stepKind(step);
      const record = this.store.getRun(runId)?.steps.find((s) => s.id === step.id);
      const iteration = (record?.iterations ?? 0) + 1;

      this.move(runId, 'start', { currentStepId: step.id });
      this.store.updateStep(runId, step.id, {
        status: 'running',
        iterations: iteration,
        startedAt: new Date().toISOString(),
        error: undefined,
      });
      emit({ type: 'step-start', stepId: step.id, name: step.name ?? step.id, kind, iteration });

      if (kind === 'agent') {
        // Every agent step's session stays open after its turn until a done, finish, idle or cancel
        // closes it. Only a done completes a step that is not the last (hearsay-tools/cezarion#1620).
        const nextStep = workflow.steps[i + 1];
        const attemptStartedAt = Date.now();
        const failure = await this.runAgentStep(
          runId,
          state,
          step,
          input,
          loop.checkFailure,
          nextStep,
          emit,
          startImages,
          launch.taskBackend,
          launch.extraSystemPrompt,
          chainStepNote(workflow.steps, i),
          startAttachments,
          startSetupNote,
        );
        startImages = undefined;
        startAttachments = [];
        startSetupNote = undefined;
        loop.checkFailure = null;
        const after = this.nextAfterAgentStep(execution, launch, loop, { index: i, step, nextStep, failure, startedAt: attemptStartedAt });
        if (after === 'handed-off') return undefined;
        if (after === 'settle') break;
        i++;
        continue;
      }

      const { ok, output } = await this.runCheckStep(state, step, emit);
      if (state.cancelled || this.preserveRunAfterDisposal(runId, state)) break;
      const nextIndex = this.settleCheckStep(execution, i, record, { ok, output }, loop);
      if (nextIndex === undefined) break;
      i = nextIndex;
    }
    return loop;
  }

  /**
   * What the step loop does once an agent step's session ended: start the next step, settle the
   * run, or leave the run to what holds it now (another owner, the queue, or a park). Synchronous,
   * like the loop body it came from, so the loop yields only where it awaits the step itself.
   */
  private nextAfterAgentStep(
    execution: Execution,
    launch: ExecutionLaunch,
    loop: StepLoop,
    attempt: { index: number; step: WorkflowStepDef; nextStep: WorkflowStepDef | undefined; failure: string | null; startedAt: number },
  ): 'next' | 'settle' | 'handed-off' {
    const { runId, workflow, input, state, emit } = execution;
    const { step, failure } = attempt;
    // Stale setup cannot finalize a replacement owner. Disposal also clears
    // active, but must still honor a previously accepted Stop/Finish intent.
    if (this.active.get(runId) !== state &&
      !(this.disposed && (state.cancelled || state.finishRequested))) return 'handed-off';
    if (state.cancelled || this.preserveRunAfterDisposal(runId, state)) return 'settle';
    this.withdrawCezarHumanWaits(runId);
    this.expireStepDeadlineWaits(runId, step, failure, attempt.startedAt);
    const current = this.store.getRun(runId);
    if (current && this.executionBlockedByRootFinish(current) && !state.sessionEverOpened) {
      this.store.updateStep(runId, step.id, { status: 'pending' });
      this.requeueWhileHeld(runId, workflow, input, launch.taskBackend, state, attempt.index);
      return 'handed-off';
    }
    if (this.settleAgentStepWakes(execution, step.id, failure, loop)) return 'handed-off';
    if (failure || loop.deliveryCapped) return 'settle';
    // A session that closed without a done leaves its step resumable; the tail never starts.
    if (this.stepLeftOpen(state, step.id, attempt.nextStep)) { loop.incompleteStepId = step.id; return 'settle'; }
    if (state.idleClosed || this.supersedeFallbackThenWorkflowAsk(runId, state)) return 'settle';
    this.finishStep(runId, step.id, 'done', undefined, emit);
    // Finish is an explicit stop, not an answer or permission to run checks.
    return state.finishRequested ? 'settle' : 'next';
  }

  /**
   * An authored step deadline bounds the whole step, its question included (#427 Q8, #470 T3):
   * once it has passed, the step's human waits expire with it and the failure settles as it
   * did before questions were waits. CI and timer waits still park the failure
   * (`settleAgentStepWakes`). The clock starts before session setup, so a failure that close to
   * the deadline counts as it.
   */
  private expireStepDeadlineWaits(runId: string, step: WorkflowStepDef, failure: string | null, attemptStartedAt: number): void {
    if (failure && step.timeoutMs && Date.now() - attemptStartedAt >= step.timeoutMs) {
      const human = openWaits(this.store.getRun(runId) ?? {}).filter(wait => wait.kind === 'human').map(wait => wait.id);
      if (human.length) this.store.commitOutcome(runId, { kind: 'cancelled', waitIds: human });
    }
  }

  /**
   * Records a failed agent step, then settles what the run's closing wakes need. True when the
   * run parked to deliver them; a capped delivery fails the step and marks the loop capped.
   */
  private settleAgentStepWakes(execution: Execution, stepId: string, failure: string | null, loop: StepLoop): boolean {
    const { runId, state, emit } = execution;
    // runAgentStep already emitted session.ended(error). Record the failed
    // attempt before parking so later successful CI recovery cannot erase it.
    if (failure) {
      if (this.holdsClosingWakes(runId)) this.store.updateRun(runId, { workflowResumeStepId: stepId });
      this.finishStep(runId, stepId, 'failed', failure, emit);
      loop.runError = `step "${stepId}" failed: ${failure}`;
    }
    // A clean close that leaves results undelivered is a failed delivery too.
    const undelivered = failure ?? (this.owesDelivery(runId) ? WAKE_SESSION_CLOSED_ERROR : undefined);
    const delivery = this.closingWakeDecision(runId, this.holdsClosingWakes(runId), state.cancelled, undelivered || undefined);
    if (delivery === 'capped') {
      loop.deliveryCapped = true;
      if (!failure) {
        this.finishStep(runId, stepId, 'failed', WAKE_SESSION_CLOSED_ERROR, emit);
        loop.runError = `step "${stepId}" failed: ${WAKE_SESSION_CLOSED_ERROR}`;
      }
    }
    if (delivery !== 'park') return false;
    this.surfaceHumanWait(runId, state);
    this.move(runId, 'park', {
      ...(failure ? { error: loop.runError! } : {}) });
    this.store.flush(); // checkpoint the failed attempt and its recoverable workflow cursor before parking
    this.dropActive(runId);
    return true;
  }

  /**
   * A check step's result: a pass goes on to the next step, a failure loops back to its
   * `onFail.retry` step while retries remain, and otherwise fails the run. Returns the index the
   * step loop continues from, or undefined when the run fails.
   */
  private settleCheckStep(
    execution: Execution,
    index: number,
    record: StepState | undefined,
    check: { ok: boolean; output: string },
    loop: StepLoop,
  ): number | undefined {
    const { runId, workflow, emit } = execution;
    const step = workflow.steps[index] as WorkflowStepDef;
    const outcome = stepDecisions.checkStepOutcome(workflow, index, record, check.ok);
    if (outcome.kind === 'done') {
      this.finishStep(runId, step.id, 'done', undefined, emit);
      return outcome.nextIndex;
    }

    if (outcome.kind === 'retry') {
      loop.checkFailure = check.output;
      this.finishStep(runId, step.id, 'failed', 'check failed — looping back', emit);
      emit({
        type: 'note',
        stepId: step.id,
        message: outcome.note,
      });
      // Steps we're about to re-run go back to pending so the GUI rail
      // reads top-to-bottom truthfully.
      for (const s of workflow.steps.slice(outcome.retryIndex, index + 1)) {
        this.store.updateStep(runId, s.id, { status: 'pending' });
      }
      this.store.updateStep(runId, step.id, { retriesUsed: outcome.used + 1 });
      this.move(runId, 'requeue', { currentStepId: undefined });
      // The retry target and its consumed budget form one crash boundary: a
      // restart must observe the queued target, budget, and cursor together.
      this.store.flush();
      return outcome.retryIndex;
    }

    this.finishStep(runId, step.id, 'failed', outcome.error, emit);
    loop.runError = outcome.runError;
    return undefined;
  }

  /**
   * Settles the run once the step loop of `execute` ended: the final autosave, then the
   * cancelled, failed, incomplete-step, idle-closed or success settlement.
   */
  private async settleExecution(runId: string, state: ActiveRun, loop: StepLoop): Promise<void> { return this.runSettlement.settleExecution(runId, state, loop); }
  private settleFailedRun(runId: string, runError: string, deliveryCapped: boolean): void { this.runSettlement.settleFailedRun(runId, runError, deliveryCapped); }
  /** Returns an error message, or null on success. */
  private async runAgentStep(
    runId: string,
    state: ActiveRun,
    step: WorkflowStepDef,
    input: StartRunInput,
    checkFailure: string | null,
    /** The step after this one, which this step's done starts; undefined for the last step. */
    nextStep: WorkflowStepDef | undefined,
    emit: (event: { type: string; stepId?: string; [k: string]: unknown }) => void,
    images: ContentBlock[] | undefined,
    taskBackend: RunnerId,
    extraSystemPrompt: string | undefined,
    /** The chain-boundary note for this step (#410), or undefined when the
     *  workflow has a single agent step and there is no boundary to explain. */
    chainNote: string | undefined,
    /** Pasted attachments already materialized to disk (#357) — their absolute
     *  paths are appended to `userPrompt` so the agent can operate on the
     *  real files, not just view the inline image blocks. */
    attachments: PersistedAttachment[] = [],
    /** Worktree setup's paragraph for the agent (#917) — appended to the opening message. */
    openingNote?: string,
  ): Promise<string | null> {
    const opening = await this.stepOpening(runId, state, step, input, emit, { checkFailure, images, chainNote, attachments, openingNote });

    const sessionId = randomUUID();
    const backend = step.runner ?? taskBackend;
    this.store.updateStep(runId, step.id, { sessionId, backend });

    const stepRecord = this.store.getRun(runId)?.steps.find((s) => s.id === step.id);
    const startTokens = stepRecord?.tokensUsed ?? 0;
    const turn: SessionTurn = { text: '', completedText: '', tail: 'none', scheduleWakeup: undefined, sessionError: undefined };
    const sink = this.makeUiSink(runId, step.id);
    const onEvent = createSessionEventHandler(this.inputReceiptContext, this.sessionEventHost(), {
      runId, state, turn, stepId: step.id, backend, sink, tokenBase: startTokens, emit,
      acknowledge: () => true,
    });

    const stepBackend = step.runner ?? taskBackend;
    // An owned worker's step runs under what its identity pinned for it (#452): model, effort,
    // account and grants alike. The bound `workflowDef` carries the same values; the private
    // evidence is the authority.
    const stepIdentity = this.workerStep(runId, step.id);
    const model = await stepModel(this.store, this.repoRoot, runId, state, step, input, stepBackend, stepIdentity);
    if (typeof model === 'string') return model;
    // Which agent account this step spawns under, and — recorded on the step before the spawn —
    // which one its session belongs to. `sessionId` and `profileId` are a pair: a resume that
    // reads the wrong account's config dir finds no session and silently starts a fresh one.
    const stepProfile = await this.stepProfileFor(runId, stepBackend, { stepId: step.id });
    if (typeof stepProfile === 'string') return stepProfile;
    const beforeSpawn = this.store.getRun(runId);
    if (state.cancelled || (beforeSpawn && this.executionBlockedByRootFinish(beforeSpawn))) return null;
    this.store.updateStep(runId, step.id, { profileId: stepProfile.profileId });

    const toolGrant = stepToolGrant(stepIdentity?.grants, step, stepBackend);
    // Workers inherit only the extra prompt, never the parent's selected skill (#778).
    state.delegationSettings = { cwd: state.cwd, runner: stepBackend, model: model.backendModel,
      effort: model.effectiveEffort,
      agentProfile: stepProfile.profileId, accountBinding: stepProfile.accountBinding, systemPrompt: extraSystemPrompt,
      ...toolGrantLists(toolGrant) };
    const runner = createRunner(stepBackend);
    state.agentSessionError = undefined;
    state.currentStepId = step.id;
    state.completedStepId = undefined;
    this.beginUsageInvocation(runId, state, step.id);
    const launch = await launchPreamble(this.launchPreambleHost(), runId, state);
    const { delegation, webhooksPart, ciTools } = launch;
    // Revalidate after provisioning, then let execute settle cancellation or
    // requeue a Finish-held step through its existing no-session paths.
    if (launch.stale) {
      if (this.workerExecutionStopped(runId)) state.cancelled = true;
      state.currentStepId = undefined;
      return null;
    }
    state.inputDelivery = inputDeliveryOf(runner); state.unreadInputIds = new Set(); state.consumedBeforeAck = new Set();
    const launchOpening = this.launchOpening(runId, state, step.id, { body: opening.userPrompt, ciTools });
    const session = this.startStepSession(runId, state, runner, {
      step, sessionId, images, opening: launchOpening, skillPrompt: opening.skillPrompt, extraSystemPrompt,
      toolGrant, profile: stepProfile, model, delegation, webhooksPart, ciTools,
    }, onEvent, turn, sink);
    if (typeof session === 'string') return session;
    return this.awaitStepSession(runId, state, session, { stepId: step.id, nextStep, sink, turn, startTokens, delegation, ciTools });
  }

  /** A fresh step's opening message, before the open-waits footer and the session-start context,
   *  and the selected skill's playbook for its system prompt. */
  private async stepOpening(
    runId: string,
    state: ActiveRun,
    step: WorkflowStepDef,
    input: StartRunInput,
    emit: ExecutionEmit,
    parts: {
      checkFailure: string | null;
      images: ContentBlock[] | undefined;
      chainNote: string | undefined;
      attachments: PersistedAttachment[];
      openingNote: string | undefined;
    },
  ): Promise<{ userPrompt: string; skillPrompt: string | undefined }> {
    let skillPrompt: string | undefined;
    const rawPrompt = applyTemplate(step.prompt ?? '{{task}}', input.task);
    // The selected skill, a leading `/name`, every skill the prompt names as `/name`, and their
    // companions go where the agent looks (#1408, #1672).
    const provisioned = await this.runSkills.provisionRunSkills(runId, state, {
      stepSkill: step.skill, slash: leadingSlashSkillName(rawPrompt), prompt: rawPrompt,
    });
    for (const message of provisioned.notes) emit({ type: 'note', stepId: step.id, message });
    if (step.skill) {
      const skill = this.enabledSkills(state).find((s) => s.name === step.skill);
      if (skill) {
        // The body alone often does not identify the selected skill. Keep its
        // name and catalog description in the normalized runner payload so a
        // numeric task such as "432" still gives the model enough context to
        // describe the work — and therefore derive a useful title (#432).
        // A directory team skill outside the worktree names its cache copy (#1024).
        skillPrompt = skillSystemPrompt(skill, provisioned.filesDir.get(skill.name));
      } else {
        emit({
          type: 'note',
          stepId: step.id,
          message: `skill "${step.skill}" not found in .ai/cezar/skills, .ai/skills or the team skills repo — running with the plain prompt`,
        });
      }
    }

    // Opening prompts bypass deliverMessage. Expand before workflow and attachment
    // context so a leading registry skill matches, without changing the stored task.
    let userPrompt = expandRegistrySlashSkillText(rawPrompt, this.enabledSkills(state), provisioned.filesDir);
    if (parts.chainNote) userPrompt = `${parts.chainNote}\n\n---\n\n${userPrompt}`;
    if (parts.checkFailure) {
      userPrompt += `\n\nA verification command failed after the previous attempt. Fix the cause. Failing output:\n\n${parts.checkFailure}`;
    }
    if (parts.images?.length) {
      emit({
        type: 'note',
        stepId: step.id,
        message: `${parts.images.length} screenshot${parts.images.length > 1 ? 's' : ''} attached to the task`,
      });
    }
    // Point the agent at the on-disk files (#357) — for an image the base64 block above already
    // let it *view* the file and this is what lets it *use* it (save, attach to an issue/PR, copy
    // into the repo); for a non-image attachment (#950) it is the only reference the agent gets
    // at all. Deliberately NOT nested in the branch above: gating the paths on an image block
    // existing is what would leave an agent holding a task about a `.pdf` it was never told the
    // location of.
    if (parts.attachments.length) userPrompt += `\n\n${pastedAttachmentsText(parts.attachments)}`;
    if (parts.openingNote) userPrompt += `\n\n${parts.openingNote}`;
    return { userPrompt, skillPrompt };
  }

  private sessionEventHost(): import('./run/session-events.ts').SessionEventHost {
    return {
      disposedSessionEvent: (...args) => sessionEvents.disposedSessionEvent(this.inputReceiptContext, this.sessionHelperHost, ...args),
      handleReceiptEvent: (...args) => inputReceipts.handleReceiptEvent(this.inputReceiptContext, this.inputReceiptHost, this.inputReceiptSteps, ...args),
      recordSessionFault: (...args) => sessionEvents.recordSessionFault(this.inputReceiptContext, this.sessionHelperHost, ...args),
      markTurnBoundary: (...args) => sessionEvents.markTurnBoundary(this.inputReceiptContext, this.sessionHelperHost, ...args),
      trackTurnEnd: (...args) => this.trackTurnEnd(...args),
      endTurn: (...args) => this.endTurn(...args),
    };
  }

  private launchPreambleHost(): import('./run/session-events.ts').LaunchPreambleHost {
    return {
      provisionSession: (...args) => this.provisionSession(...args),
      agentWebhooksPart: () => this.agentWebhooksPart(),
      provisionCiSession: (...args) => this.provisionCiSession(...args),
      launchStale: (...args) => sessionEvents.launchStale(this.inputReceiptContext, this.sessionHelperHost, ...args),
    };
  }

  private async stepProfileFor(
    runId: string,
    stepBackend: RunnerId,
    options: { recordedProfileId?: string | undefined; stepId?: string | undefined },
  ): Promise<StepProfile | string> { return sessionEvents.stepProfileFor(this.inputReceiptContext, this.sessionHelperHost, runId, stepBackend, options); }

  private launchOpening(
    runId: string,
    state: ActiveRun,
    stepId: string,
    launch: { body: string; ciTools: LaunchCiTools; checkpoint?: RunRecord['continuationMessage'] },
  ): LaunchOpening { return sessionEvents.launchOpening(this.inputReceiptContext, this.sessionHelperHost, runId, state, stepId, launch); }

  /** Start a fresh step's session. A throw revokes the tools this launch was given and returns its
   *  message as the step's error. */
  private startStepSession(
    runId: string,
    state: ActiveRun,
    runner: ReturnType<typeof createRunner>,
    launch: StepSessionLaunch,
    onEvent: (event: AgentEvent) => void,
    turn: SessionTurn,
    sink: UiEventSink,
  ): AgentSession | string {
    const { delegation, ciTools, profile } = launch;
    let session: AgentSession | undefined;
    try {
      session = startManagedSession(runner,
        {
          // Skill body, then the run's extra prompt (POST override or config
          // default), then the handoff contract — every agent step.
          systemPrompt: composeSystemPrompt(launch.skillPrompt, this.launchSystemTail({
            extraSystemPrompt: launch.extraSystemPrompt, delegation, webhooksPart: launch.webhooksPart,
            env: profile.env, ciTools, handoffInjected: launch.opening.handoffInjected,
          })),
          userPrompt: launch.opening.userPrompt,
          images: launch.images,
          cwd: state.cwd,
          toolGrant: launch.toolGrant,
          // The handoff file lives outside the worktree — grant access.
          additionalDirectories: agentDirectories(join(this.dataDir, 'runs'), profile.env),
          env: { ...profile.env, ...delegation?.env, ...ciTools?.env },
          ...(ciTools ? { cezarTools: ciTools.descriptor } : {}),
          ...(delegation ? { restrictNativeDelegation: delegation.restrictNativeDelegation } : {}),
          model: launch.model.backendModel,
          effort: launch.model.effectiveEffort,
          sessionId: launch.sessionId,
          // Managed work has no default wall clock, including non-final steps.
          // Only an authored step opts in; turn completion still advances the chain.
          timeoutMs: launch.step.timeoutMs ?? 0,
        },
        onEvent,
        inputReceipts.inputReceiptCallbacks(this.inputReceiptContext, this.inputReceiptHost, this.inputReceiptSteps, runId, state, () => session, turn, sink, false),
      );
    } catch (err) {
      ciTools?.revoke(); state.revokeCiTools = undefined;
      delegation?.revoke(); state.revokeDelegation = undefined;
      state.currentStepId = undefined;
      return err instanceof Error ? err.message : String(err);
    }
    return session;
  }

  private launchSystemTail(launch: {
    extraSystemPrompt: string | undefined;
    delegation: LaunchDelegation;
    webhooksPart: string | undefined;
    env: StepProfile['env'];
    ciTools: LaunchCiTools;
    handoffInjected: boolean;
  }): string { return sessionEvents.launchSystemTail(this.inputReceiptContext, this.sessionHelperHost, launch); }

  /** Wait for a fresh step's session to close. Returns the step's error, or null. Teardown always
   *  revokes the launch's tools and clears the session's state (`releaseStepSession`). */
  private async awaitStepSession(runId: string, state: ActiveRun, session: AgentSession, launch: {
    stepId: string;
    nextStep: WorkflowStepDef | undefined;
    sink: UiEventSink;
    turn: SessionTurn;
    startTokens: number;
    delegation: LaunchDelegation;
    ciTools: LaunchCiTools;
  }): Promise<string | null> {
    const { stepId, sink, turn } = launch;
    const sessionClosed = this.trackWorkerSessionResult(runId, session);
    state.session = session;
    state.nextStep = stepScope(session, launch.nextStep);
    state.sessionEverOpened = true;
    state.currentStepId = stepId;
    state.interrupt = () => session.interrupt();
    let setupComplete = false;
    try {
      const result = await inputReceipts.sessionResultWithReceipts(this.inputReceiptContext, this.inputReceiptHost, this.inputReceiptSteps, runId, state, session, () => { setupComplete = true; });
      if (this.isDisposedDelegatedRun(runId)) return null;
      this.persistWorkerAssistantResult(runId, stepId, result.text);
      const inputOrSessionError = turn.sessionError ?? state.agentInputError;
      if (inputOrSessionError) {
        sink.sessionEnded('error', inputOrSessionError);
        return inputOrSessionError;
      }
      // v2 counterpart of v1's `done` (spec: the mappers leave session-close
      // events to the RunManager — only it knows how the session settled).
      sink.sessionEnded(state.cancelled ? 'cancelled' : 'end_turn');
      this.store.updateStep(runId, stepId, { tokensUsed: launch.startTokens + result.tokensUsed });
      return null;
    } catch (err) {
      if (!setupComplete) {
        try { session.interrupt(); } catch { /* Still wait for actual termination. */ }
        await sessionClosed;
      }
      if (this.isDisposedDelegatedRun(runId)) return null;
      // Keep the provider failure that triggered teardown, even if teardown rejects.
      const message = turn.sessionError ?? state.agentInputError ?? (err instanceof Error ? err.message : String(err));
      sink.sessionEnded('error', message); // alongside v1's fatal `error`
      return message;
    } finally {
      this.releaseStepSession(runId, state, launch.delegation, launch.ciTools);
    }
  }

  /** A fresh step's session teardown: revoke the launch's tools, record the usage peaks, and clear
   *  what its turns left on the run state: the idle timer, the monitoring and waiting marks, the
   *  turn boundary, the park intents and the session itself. */
  private releaseStepSession(runId: string, state: ActiveRun, delegation: LaunchDelegation, ciTools: LaunchCiTools): void {
    ciTools?.revoke(); state.revokeCiTools = undefined;
    delegation?.revoke(); state.revokeDelegation = undefined;
    this.recordUsagePeaks(runId);
    this.clearIdleTimer(state);
    this.line.leavePool(runId);
    this.line.unpark(runId);
    state.nextStep = undefined;
    state.waitWakeTurn = undefined;
    state.atTurnBoundary = undefined;
    state.doneAtBoundary = undefined;
    state.parkAfterAck = undefined;
    state.session = undefined;
    state.currentStepId = undefined;
    state.interrupt = () => undefined;
  }

  private persistWorkerAssistantResult(runId: string, stepId: string, text: string): void { return sessionEvents.persistWorkerAssistantResult(this.inputReceiptContext, this.sessionHelperHost, runId, stepId, text); }

  private makeUiSink(runId: string, stepId: string): UiEventSink { return sessionEvents.makeUiSink(this.inputReceiptContext, this.sessionHelperHost, runId, stepId); }

  private prepareHumanAsk(state: ActiveRun): void { return this.humanWaits.prepareHumanAsk(state); }
  private raiseHumanGate(runId: string, state: ActiveRun): void { return this.humanWaits.raiseHumanGate(runId, state); }
  private unsurfacedHumanWait(runId: string): HumanWaitEntry | undefined { return this.humanWaits.unsurfacedHumanWait(runId); }
  private turnEndHumanWait(runId: string): HumanWaitEntry | undefined { return this.humanWaits.turnEndHumanWait(runId); }
  private openHumanAlias(runId: string, state: ActiveRun | undefined, via: WaitVia, card?: AskRequest): HumanWaitEntry | undefined { return this.humanWaits.openHumanAlias(runId, state, via, card); }
  private markHumanWaitSurfaced(runId: string, wait: HumanWaitEntry, shownCard?: AskRequest): void { return this.humanWaits.markHumanWaitSurfaced(runId, wait, shownCard); }
  private surfaceHumanWait(runId: string, state: ActiveRun | undefined, wait?: HumanWaitEntry): void { return this.humanWaits.surfaceHumanWait(runId, state, wait); }
  private showCezarHumanWait(runId: string, state: ActiveRun | undefined, wait: HumanWaitEntry, note?: string): void { return this.humanWaits.showCezarHumanWait(runId, state, wait, note); }
  private withdrawCezarHumanWaits(runId: string): void { return this.humanWaits.withdrawCezarHumanWaits(runId); }
  private holdsAgentWaits(runId: string): boolean { return this.humanWaits.holdsAgentWaits(runId); }
  private latchAskLineCard(runId: string, wait: HumanWaitEntry | undefined, turn: { ask: AskRequest | null; waitCard: boolean }): void { return this.humanWaits.latchAskLineCard(runId, wait, turn); }
  private humanWaitShown(runId: string, wait: HumanWaitEntry | undefined): boolean { return this.humanWaits.humanWaitShown(runId, wait); }
  private recordTurnEndQuestion(runId: string, state: ActiveRun, wait: HumanWaitEntry | undefined, ask: AskRequest | null): void { return this.humanWaits.recordTurnEndQuestion(runId, state, wait, ask); }

  private handleRunnerUiEvent(runId: string, state: ActiveRun, sink: UiEventSink, event: UiEvent): void { return sessionEvents.handleRunnerUiEvent(this.inputReceiptContext, this.sessionHelperHost, runId, state, sink, event); }

  /** Persist the invocation checkpoint before launching a runner. A throw or
   * process exit before `turn.started` therefore leaves a durable mismatch. */
  private beginUsageInvocation(runId: string, state: ActiveRun, stepId: string): void {
    beginUsageInvocation(this.store, runId, state, stepId);
  }

  private async autoNameRun(runId: string, skillName: string | undefined, task: string, live?: { turnText?: string; diffStat?: string | undefined }): Promise<void> {
    return this.turnBookkeeper.autoNameRun(runId, skillName, task, live);
  }

  async recordTurnEnd(runId: string, turnText: string): Promise<void> {
    return this.turnBookkeeper.recordTurnEnd(runId, turnText);
  }

  private async maybeRefreshTitle(runId: string, turnText: string): Promise<void> {
    return this.turnBookkeeper.maybeRefreshTitle(runId, turnText);
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

  /** Shared stop/input/liveness guards for an automatic continuation. */
  private canAutoContinue(runId: string, state: ActiveRun): boolean { return this.turnNudges.canAutoContinue(runId, state); }

  /**
   * Both turn-end paths keep a nudged session running, with no user-wait timer or
   * released slot. The next turn can finish with DONE, nudge again, or park at the
   * cap (waiting/monitoring with their existing wake/idle rules). Queued/accepted
   * input, worker/CI waits and parent completion keep priority. Cancel, Finish,
   * disposal and memory pause stop nudging; provider errors/exits use normal
   * teardown. Native mid-turn asks still park for an answer (outside this policy).
   * A refused ordinary nudge waits for readiness at this exact boundary; the idle
   * timeout bounds a missing readiness signal. New activity/input invalidates it.
   * `ask` is this turn's ask line, which an autonomous run does not register before the budget
   * (hearsay-tools/cezarion#1234). A wire that refuses the nudge registers it after all.
   */
  /** `text` is the turn-end rule's nudge; an ask line's nudge scopes the same one itself (hearsay-tools/cezarion#1620). */
  private tryAutonomousNudge(runId: string, state: ActiveRun, stepId: string, ask: AskRequest | null,
    text = stepScopedNudge(AUTONOMOUS_NUDGE, !!state.session && state.nextStep?.session === state.session)): boolean { return this.turnNudges.tryAutonomousNudge(runId, state, stepId, ask, text); }

  /**
   * A turn end on the runner's own signal, shared by the fresh step's and the Continue's turn-end
   * handlers (hearsay-tools/cezarion#1525): read what the turn said, keep it for an acknowledgement
   * that lands after the turn end (`parkAfterAck`), then settle it (`settleTurn`). Nothing reads the
   * turn's prose beyond its markers.
   */
  private endTurn(runId: string, state: ActiveRun, sink: UiEventSink, turn: { stepId: string; text: string; completedText: string; scheduleWakeup: number | null | undefined }): void { return this.turnSettler.endTurn(runId, state, sink, turn); }

  /** The turn end an entry settles after it (`settleIdleBoundary`, `handleAgentInputReady`), and
   *  the completion gate's live refusal: what `parkAfterAck` kept of it. */
  private boundaryTurn(runId: string, state: ActiveRun, session: AgentSession, done: boolean): SettledTurn { return this.turnSettler.boundaryTurn(runId, state, session, done); }

  /**
   * Settle a turn end (hearsay-tools/cezarion#1525). Every entry goes through it: the turn end
   * itself (`turn-end`, a fresh step or a Continue), an acknowledgement that lands after it
   * (`ack`), input readiness for a refused autonomous nudge (`ready`), and the completion gate's
   * refusal of a live session's done outside a turn end (`gate`). It takes a done to the completion
   * gate, gathers the facts, lets the pure rule (`decideTurnEnd`) decide and carries out the
   * decision. False when nothing was settled: the done closed the session, or the input checkpoint
   * failed.
   */
  private settleTurn(runId: string, state: ActiveRun, entry: 'turn-end' | 'ack' | 'ready' | 'gate', turn: SettledTurn,
    refusal?: CompletionRefusal): boolean { return this.turnSettler.settleTurn(runId, state, entry, turn, refusal); }

  /** The method for each decision kind (`carryOutTurnEnd`). A closed session settles elsewhere, and
   *  owed input runs as the session's next turn: the run keeps running. */

  /** The outcome a settled turn reached, for the parity cells that prove which path ran
   *  (hearsay-tools/cezarion#1809, which removed the handoff heartbeat line that recorded it). No
   *  outcome for the completion gate's refusal outside a turn end, nor while input readiness waits. */
  private settledTurnOutcome(runId: string, entry: 'turn-end' | 'ack' | 'ready' | 'gate' | 'reply-timer',
    outcome: TurnEndOutcome): TurnEndOutcome | undefined {
    return entry === 'gate' || (entry === 'ready' && outcome.kind === 'readiness') ? undefined : outcome;
  }

  /** The nudge a turn end with no wait or done gets: one automatic turn, charged to the
   *  automatic-wake budget. The autonomous wording repeats; the no-wait one is sent once and is
   *  bounded by its reply timer (#544's liveness). */
  private sendTurnEndNudge(runId: string, state: ActiveRun, stepId: string | undefined, text: string): boolean { return this.turnNudges.sendTurnEndNudge(runId, state, stepId, text); }

  /** Cezar's own human wait at a turn end (hearsay-tools/cezarion#1234): the cause as a note, the
   *  wait shown as Needs you, and the run parked for the user. A worker's `no-wait` fallback at its
   *  turn end (`turnEnd`) asks its parent instead (`askParentForWorker`, hearsay-tools/cezarion#1301);
   *  any other worker fallback stays a plain park. */
  private openTurnEndHumanWait(runId: string, state: ActiveRun, stepId: string | undefined, via: 'no-wait' | 'budget', note: string, turnEnd = false): void { return this.turnSettler.openTurnEndHumanWait(runId, state, stepId, via, note, turnEnd); }

  private askParentForWorker(runId: string, state: ActiveRun, stepId: string | undefined): void { return this.workerQuestions.askParentForWorker(runId, state, stepId); }

  private isWorkerFallbackAsk(runId: string, askSeq: number): boolean { return this.workerQuestions.isWorkerFallbackAsk(runId, askSeq); }

  private pendingWorkerFallback(runId: string): boolean { return this.workerQuestions.pendingWorkerFallback(runId); }

  private chargeWorkerFallbackReply(runId: string, beforeHumanReset?: HumanAnswerBudget): void { return this.workerQuestions.chargeWorkerFallbackReply(runId, beforeHumanReset); }

  private supersedeWorkerFallback(runId: string): boolean { return this.workerQuestions.supersedeWorkerFallback(runId); }

  private retireUnreadParentQuestion(parentId: string, requestId: string): void { return this.workerQuestions.retireUnreadParentQuestion(parentId, requestId); }

  /** A reply to the nudge clears its bound. One that arrives after the bound parked the run resumes
   *  it, as the final-message nudge's did (#544); its turn end then decides, and a run still on
   *  Cezar's no-wait wait parks on it again. */
  private noteNoWaitNudgeContent(runId: string, state: ActiveRun, event: { type: string; item?: { parentItemId?: string } }): void { this.turnNudges.noteNoWaitNudgeContent(runId, state, event); }

  /** A no-wait nudge the harness acknowledged but never answered (an OpenCode heartbeat keeps the
   *  session alive without a turn): at the bound Cezar opens the no-wait human wait and the run
   *  waits for the user. A reply that arrives after it runs, and the run stays on that question. */
  private armNoWaitNudgeReplyTimer(runId: string, state: ActiveRun): void { this.turnNudges.armNoWaitNudgeReplyTimer(runId, state); }

  /** Every run status `run.ts` writes comes from the run state table (hearsay-tools/cezarion#1804). */
  private move(runId: string, exit: RunExitId, patch: Omit<Parameters<RunStore['updateRun']>[1], 'status'> = {}): RunRecord | undefined {
    const status = transition(exit, () => this.store.getRun(runId));
    return this.store.updateRun(runId, { ...patch, ...(status === 'failed' ? settledRootFinishPatch(this.store, runId) : {}), status });
  }

  private armIdleTimer(runId: string, state: ActiveRun): void { return this.turnSettler.armIdleTimer(runId, state); }

  private clearIdleTimer(state: ActiveRun): void {
    clearIdleTimer(state);
  }

  /** The turn-end tail's park for the user: `waiting` with the idle timer, no slot. A result
   *  already in (a pending question beside a resolved wait) still queues its wake. */
  private parkForUser(runId: string, state: ActiveRun, stepId: string | undefined): void { return this.turnSettler.parkForUser(runId, state, stepId); }

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

  /**
   * Worktree setup (#917, spec `.ai/specs/2026-10-07-worktree-setup.md`): run the project's
   * `worktreeSetup` commands in this run's isolated worktree when it needs them, and return the
   * paragraph for the agent's opening message. `start` is a new task or worker, `rematerialized`
   * a Continue that rebuilt a reclaimed directory, and `resume` any other Continue, which only
   * finishes a setup a restart interrupted. In-place and non-Git runs never get setup: that tree
   * is the user's own checkout.
   */
  private async prepareWorktree(
    runId: string,
    state: ActiveRun,
    raw: unknown,
    emit: (event: { type: string; [k: string]: unknown }) => void,
    trigger: 'start' | 'rematerialized' | 'resume',
  ): Promise<string | undefined> {
    const record = this.store.getRun(runId);
    if (!record || state.cwd === this.repoRoot) return undefined;
    const plan = resolveWorktreeSetup(raw);
    const interrupted = record.worktreeSetup?.status === 'running';
    if (plan.kind === 'none') {
      // A restart interrupted setup the project has since removed: nothing is left to finish.
      if (interrupted) this.store.updateRun(runId, { worktreeSetup: undefined });
      return undefined;
    }
    const fresh = trigger === 'start' && record.worktreeSetup === undefined &&
      !record.steps.some((step) => step.kind === 'agent' && step.iterations > 0);
    if (!interrupted && !fresh && trigger !== 'rematerialized') return undefined;

    const startedAt = new Date().toISOString();
    let outcome: WorktreeSetupOutcome;
    if (plan.kind === 'invalid') {
      outcome = { status: 'invalid', issue: plan.issue };
    } else {
      // Durable before the first command: recovery reads `running` to requeue a run a restart
      // interrupted here, instead of failing it with no agent session to resume.
      this.store.updateRun(runId, { worktreeSetup: { status: 'running', startedAt } });
      this.store.flush();
      emit({ type: 'note', message: worktreeSetupStartNote(plan.commands.length) });
      let tmpEnv: Record<string, string> = {};
      try {
        tmpEnv = agentTmpEnv(this.dataDir, runId);
      } catch (err) {
        if (!(err instanceof AgentTempDirError)) throw err;
      }
      outcome = await runWorktreeSetup({
        plan,
        cwd: state.cwd,
        env: worktreeSetupEnv({ projectRoot: this.repoRoot, runId, tmpEnv }),
        setInterrupt: (stop) => { state.interrupt = stop; },
        isCancelled: () => state.cancelled,
        onCommandResult: (result) => emit({
          type: 'check-output',
          command: result.command,
          text: result.output,
          exitCode: result.exitCode ?? -1,
        }),
      });
    }
    const finishedAt = new Date().toISOString();
    const error = worktreeSetupRecordError(outcome);
    this.store.updateRun(runId, {
      worktreeSetup: {
        status: outcome.status === 'done' ? 'done' : 'failed',
        startedAt,
        finishedAt,
        durationMs: 'durationMs' in outcome ? outcome.durationMs : 0,
        ...(error !== undefined ? { error } : {}),
      },
    });
    const endNote = worktreeSetupEndNote(outcome);
    emit({ type: 'note', message: endNote });
    return worktreeSetupAgentNote(outcome);
  }

  private async runCheckStep(
    state: ActiveRun,
    step: WorkflowStepDef,
    emit: (event: { type: string; stepId?: string; [k: string]: unknown }) => void,
  ): Promise<{ ok: boolean; output: string }> {
    const command = step.command as string;
    emit({ type: 'note', stepId: step.id, message: `$ ${command}` });
    // Check steps run in the same cwd as the agent steps — the worktree — in their own process
    // group, shared with worktree setup (#917).
    const result = await runGroupedCommand({
      command,
      cwd: state.cwd,
      env: process.env,
      setInterrupt: (stop) => { state.interrupt = stop; },
      keep: 'head',
      cap: CHECK_OUTPUT_CAP,
    });
    emit({ type: 'check-output', stepId: step.id, command, text: result.output, exitCode: result.exitCode ?? -1 });
    return { ok: result.exitCode === 0, output: result.output };
  }

  private finishStep(
    runId: string,
    stepId: string,
    status: 'done' | 'failed',
    error: string | undefined,
    emit: (event: { type: string; stepId?: string; [k: string]: unknown }) => void,
  ): void {
    this.store.updateStep(runId, stepId, {
      status,
      error,
      finishedAt: new Date().toISOString(),
    });
    emit({ type: 'step-end', stepId, status, ...(error ? { error } : {}) });
  }
}
