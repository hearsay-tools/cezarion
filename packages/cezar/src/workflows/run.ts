import { TurnBookkeeper } from './run/turn-bookkeeping.ts';
import { AutomationToolsSlot, cezarToolHandlers, toolSessionRefusal } from './run/cezar-tools.ts';
import { registerPreviewServer, stopPreviewServer } from '../preview/run-tools.ts';
import { AttachmentWriter } from './run/attachment-writer.ts';
import { RepoRootLease } from './run/repo-root-lease.ts';
import { MaintenanceClaims } from './run/maintenance-claims.ts';
import { WorkerOrphans } from './run/worker-orphans.ts';
import type {
  DelegationExecutionSettings, StartRunInput, PendingContinuation, ExecutionEmit,
  Execution, ExecutionLaunch, StepLoop, SessionTurn, LaunchDelegation,
  LaunchCiTools, LaunchOpening, StepProfile, StepSessionLaunch,
  WorkerDelegationRecord, ContinuationOpening, OpeningAnswer, ContinuationSettings, ContinuationSkills,
  ContinuationSessionLaunch, ContinuationClose, WorkerTerminationBlocker, AutomationToolService,
} from './run/types.ts';
export type { TurnTail, DelegationExecutionSettings, StartRunInput, WorkerTerminationBlocker, AutomationToolService } from './run/types.ts';
import { openCompletionRequests, recordRequestRefusal, repairFailedRootFinish, rootCompletionRefusal, sentRequestInstructions, settledRootFinishPatch, type CompletionRefusal } from './completion-policy.ts';
import * as continuation from './continuation-admission.ts';
import type { ContinueRunOptions } from './continuation-admission.ts';
import { autosaveCleanupBlocker, retainAutosaveCleanup, clearAutosaveCleanup } from '../autosave-cleanup.ts';
import { workerEvidenceRunIds } from '../runs/worker-execution.ts';
import { askErrorMessage, doneErrorMessage, waitErrorMessage } from '../ci-wait/errors.ts';
import { cezarAskRequestSchema, cezarDoneRequestSchema, cezarWaitRequestSchema, type AskErrorCode, type CezarAskRequest, type CezarDoneAnswer, type CezarDoneRequest, type CezarWaitRequest, type CezarWaitRequestInput, type DoneErrorCode, type PeerWaitEntry, type PeerWaitResult, type PrWaitEntry, type ProcessWaitEntry, type ProcessWaitResult, type HumanWaitEntry, type TimerWaitEntry, type Wait, type WaitErrorCode, type WaitVia, type WorkerWaitEntry, computeWaitingOn, hasWorkerDeadline, workerWaitEntryToLegacy, type DeadlinedWorkerWaitEntry, isUsageLimitHold, TIMER_MAX_SECONDS, TIMER_MIN_SECONDS, WAIT_LIMIT } from '@open-mercato/cezar-contract/waits';
import { ciWaitResultSchema, type CiWaitResult } from '@open-mercato/cezar-contract/ci-wait';
import { type PreviewStopRequest, type PreviewStopResult, type PreviewServeRequest, type PreviewServeResult } from '@open-mercato/cezar-contract/preview';
import { NO_WAIT_NUDGE_NOTE, NO_WAIT_NOTE, NO_WAIT_NO_REPLY_NOTE, COMPLETION_NO_REPLY_NOTE, WORKER_FALLBACK_NOTE, WORKER_FALLBACK_REPLY_NOTE, COMPLETION_NUDGE_NOTE, AUTONOMOUS_ASK_NOTE, AUTONOMOUS_NUDGE, decideTurnEnd, stepScopedNudge, type TurnEndDecision, type TurnEndFacts, type TurnEndOutcome } from './turn-end.ts';
import { createActiveRun, type ActiveRun } from './active-run.ts';
import { claudeScheduleWakeupDelay, isRunnerActivity, appendTurnText, appendCompletedAssistantText, trackTurnTail, stripDoneMarker, stripMonitoringMarker, emitAskRequested, askCardFields, humanWaitCard, classifyTurnEnd, discardQueuedMessagesOnAsk, type TurnEndRead } from './run/turn-markers.ts';
export { claudeScheduleWakeupDelay, appendTurnText, trackTurnTail, classifyTurnEnd } from './run/turn-markers.ts';
import { canProceedWithRun, executionBlockedByRootFinish, historyDeletionPending, rootFinishRequested } from './run/run-guards.ts';
import { beginUsageInvocation, recordReportedCost, recordUsageUiEvent, recordUsagePeaks } from './run/usage-accounting.ts';
import { continuationModel, continuationEffort, continuationRunner, taskModelIdentity, stepModel } from './run/launch-settings.ts';
import { executionBaseRef, openExecutionWorktree, ownedContinuationWorkspace, executionSeedFiles, REPOSITORY_ROOT_LOCK_DISABLED_NOTE } from './run/run-workspace.ts';
import { continuationOpening, openingInputs } from './run/opening.ts';
import { releaseActiveResources } from './run/drop-active.ts';
import { agentDirectories, applyTemplate, composeSystemPrompt, expandRegistrySlashSkill, expandRegistrySlashSkillText, leadingSlashSkillName, resolveExtraSystemPrompt, skillSystemPrompt, withResumeContext } from './run/prompts.ts';
import { delegationExecutionSettings, selectDelegationExecutionSettings } from '../delegation/execution-settings.ts';
import { settlesAsDone, stepLabel, stepScope } from './run/steps.ts';
import { makeRunTitle } from '../runs/run-title.ts';
export { agentDirectories, composeSystemPrompt, expandRegistrySlashSkill, expandRegistrySlashSkillText, leadingSlashSkillName, resolveExtraSystemPrompt, skillSystemPrompt } from './run/prompts.ts';
export { stepLabel } from './run/steps.ts';
export { makeRunTitle } from '../runs/run-title.ts';
import { pendingConversationBatch, reservesAutomaticWake, formatAgentInput } from './run/input-batch.ts';
import { clearUnreadInputTimer, clearHeldHumanInputTimer, harnessOwesInput, harnessHoldsHumanInput, clearNoWaitNudgeReplyTimer, clearIdleTimer, clearAutosaveTimer } from './run/input-timers.ts';
import * as wakeLedger from './run/wake-ledger.ts';
import * as stepDecisions from './run/step-decisions.ts';
import * as pendingAskFacts from './run/pending-ask-facts.ts';
import * as workflowPosition from './run/workflow-position.ts';
import { RUN_EXITS, transition, transitionVia, type RunExitId } from './run-states.ts';
import { nextLineEntry } from './line-order.ts';
import { accountHeldFor, formatWakeInstant, resumeInFlight, runAccountKey, queuedRecoveryInput, queuedStartAt, sessionlessWakePrompt } from './run-scheduling.ts';
export { runAccountKey } from './run-scheduling.ts';
import { executionAccount } from './execution-account.ts';
import { chargesBudget, chargesBudgetMessage, ciWatchRequest, hasPrWait, holdsOwedResults, identicalWait, identicalWorkerWait, isCezarHumanWait, isMonitoringTimer, normalizePrUrl, openWaitList, openWaits, openWaitsFooter, resolvedWaits, waitInputId, waitResultText } from './waits.ts';
import { assertOwnedWorkerWaitScope, assertRequestWaitScope, delegationWaitRefusal, isDelegationWait, peerWaitEntry, peerWaitOf, peerWaitResult, runsAwaitingPeer, workerListTarget, workerWaitTarget } from './wait-scope.ts';
import { previewCdpSession, previewRunContext, type PreviewHostLike } from '../preview/registration.ts';
import { acquireCiResources } from '../ci-wait/resources.ts';
import { artifactInstructions, provisionArtifactDirectory } from '../artifacts/lifecycle.ts';
import type { CiWatcherSupervisor } from '../ci-wait/supervisor.ts';
import type { CezarToolHandlers } from '../ci-wait/controller.ts';
import { workerIdentity, continuationDefStep, ownedWorkflow, workerStepIdentity, captureWorkerAccount, boundWorkerAccountEnv, WorkerIdentityError, type WorkerAccountBinding, type WorkerStepIdentity } from '../delegation/execution-identity.ts';
import { buildChildEnv } from '../core/agent-env.ts';
import type { DelegationProvisioner } from '../delegation/provision.ts';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  stripAskMarker,
  type AskRequest,
} from '../core/ask.ts';
import { type AgentSession } from '../core/claude-cli-runner.ts';
import { hasRegisteredRunProcess, onUsage, registerRunProcess, replaceRunProcess, type ProcessUsage } from '../core/process-usage.ts';
import { isSessionLeader, sessionGroupOf } from '../core/session-process.ts';
import { ProcessWaitSupervisor, probeProcessWait } from '../process-wait/supervisor.ts';
import { confineExitFile, type ExitFileRoots } from '../process-wait/exit-file.ts';
import { WorkerScratchCleanup } from '../delegation/scratch-cleanup.ts';
import { noJitter, ORPHAN_BACKOFF, retryDelayMs, WAKE_RETRY_BACKOFF, type Backoff } from '../delegation/retry-backoff.ts';
import { processStartToken, recordedProcessLive, type CwdSource } from '../delegation/process-liveness.ts';
import { parseUsageLimit } from '../core/usage-limit.ts';
import { startManagedSession } from '../core/managed-session.ts';
import { createRunner } from '../core/runner-factory.ts';
import type { RunnerId } from '../core/agent-runner.ts';
import { agentModelsLocked } from '../core/agent-model-policy.ts';
import {
  handoffInstructions,
  handoffPath,
  recordHandoffAutosave,
  recordHandoffPeriodicAutosave,
  refreshHandoffRecords,
  seedHandoffFile,
} from '../handoff.ts';
import { buildSessionContext, formatSessionContextReport, type SessionContext } from '../session-context.ts';
import { resolveAttachmentPath } from './attachment-path.ts';
// Contract VALUES, like `workspaceUiStateSchema` in workspace/migrations.ts: the attachment
// vocabulary the routes validate with is the same one the engine stores and re-reads by, so the
// wire and the disk can never disagree about what counts as an image (#950).
import {
  type AgentInput,
  type InboxClaim,
  type WorkerStopResult,
  type WorkerWait,
  type WorkerWaitRequest,
  workerWaitRequestSchema,
  delegationStateSchema,
} from '@open-mercato/cezar-contract/delegation';
import type { ConversationState, RunEvent } from '@open-mercato/cezar-contract';
import {
  type ConversationMessage,
  type RequestWaitRequest,
  requestWaitRequestSchema,
} from '@open-mercato/cezar-contract/conversations';
import { isImageAttachmentName } from '@open-mercato/cezar-contract/attachments';
import { contentBlocksOf, mediaTypeFor, pastedAttachmentsNote, pastedAttachmentsText, toPastedContent, type FileBlock, type PastedContent, type PersistedAttachment } from './pasted-content.ts';
export { contentBlocksOf, highestImageSeq, mediaTypeFor, pastedAttachmentsNote, pastedAttachmentsText, toPastedContent, type FileBlock, type PastedContent, type PersistedAttachment } from './pasted-content.ts';
import { askPayloadOf, askRequestOf } from '@open-mercato/cezar-contract/pending-ask';
import type { AgentEvent, ContentBlock, ToolGrant } from '../core/agent-runner.ts';
import { inputDeliveryOf } from '../core/agent-runner.ts';
import { readProjectUiState, readProjectUiStateSync } from '../ui-state.ts';
import { discoverSkills, filterDisabledTeamSkills, readDisabledTeamSkills, type Skill } from '../skills.ts';
import { resolveCapabilities } from '../server/capabilities.ts';
import { automationCliCommand, automationsPrompt } from '../automations/prompts.ts';
import { registryEntry } from '../runs/webhook.ts';
import { agentWebhooksPrompt, webhookCliCommand } from '../webhooks/prompt.ts';
import { agentWebhooks } from '../workspace/webhooks.ts';
import { createAutomationSkill } from '../automations/builtin-skill.ts';
import { getTeamSkillsCached, materializeSkillToCache, TEAM_SKILL_AGENT_DIRS, waitForCachedTeamSkills, waitForTeamSkills } from '../skills-remote.ts';
import { MAX_SKILL_CLOSURE, namesSkillCommand, provisionSkills } from '../skills-provision.ts';
import { seedAgentConfigLocalLayer } from '../agent-config/seed.ts';
import { readAgentModelSettings } from '../agent-config/models.ts';
import { loadConfig, resolveWorktreeRetention } from '../config.ts';
import { autosaveCommit, type AutosaveOutcome, type AutosaveReason, worktreeDiff } from '../git-worktree.ts';
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
import { enqueueAgentInput, agentInputBatch, hasLiveInboxClaim } from '../delegation/input.ts';
import { resolvedWaitInputBatch } from './run/resolved-wait-input-batch.ts';
import { DelegationPolicyError } from '../delegation/policy.ts';
import { reconcileWorkerEntry } from '../delegation/wait.ts';
import { commitNewMessage, inboxSlotsUsed, reconcileConversationState, projectConversationEvents, rootsAwaitingPeer, settledRunFamilies } from '../delegation/conversations.ts';
import { parentReadiness } from '../delegation/readiness.ts';
import { answersQuestion, questionMessage, reservedReplies } from '../delegation/questions.ts';
import { workerQuestionFallback } from './question-routing.ts';
import { messagedParentSince, parkNoticeIdInUse, parkNoticeMessage, parkNoticeWait, parkingTurn } from '../delegation/park-notice.ts';
import { workerOutcome } from '../runs/delegation-state.ts';
import { loadWorkflows } from './load.ts';
import type { RunOutcome } from '../runs/outcome-commit.ts';
import { acknowledgedBatch, answerOutcomes, chargedIf, retryDeliveryCheckpoint } from './outcome-batches.ts';
import { analyseAcknowledgedInput, type AcknowledgedInput } from './input-acknowledgement.ts';
import { RUN_IN_USE_ELSEWHERE, type CommitSource, type QueuedMessage, type RunRecord, type RunStore, type StepState } from '../runs/store.ts';
import { reclaimWorktrees, rematerializeReclaimedWorktree } from '../runs/retention.ts';
import {
  AgentTempDirError,
  agentTmpEnv,
  agentTmpDirEnabled,
  resolveAgentTmpDir,
  removeAgentTmpDir,
} from '../runs/agent-tmpdir.ts';
import { extractTaskRefs, refineTaskRefs } from '../runs/task-refs.ts';
import { stripTaskMarkers } from '../runs/task-markers.ts';
import { reviewGateEnabled } from '../runs/review-gate.ts';
import { AgentAccountUnavailableError, resolveProfileEnvForRoot } from '../workspace/agent-profiles.ts';
import { DEFAULT_AGENT_ACCOUNT_ID } from '../workspace/agent-accounts.ts';
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
import { PROSE_HUMAN_GATE, workerOutcomeKey } from '../runs/transcript-facts.ts';
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
/** Periodic "cezar autosave" commit in the task worktree (spec 006). */
export const AUTOSAVE_INTERVAL_MS = 90_000;

export { CHECK_KILL_GRACE_MS, CHECK_TERMINATION_CONFIRM_MS } from './grouped-command.ts';

/**
 * Periodic saves are opt-in. Turn-end, finalization and pre-PR flushes remain enabled; only
 * pre-PR follows a repointed HEAD. Coalesce timer-save evidence in the handoff.
 */
export function periodicAutosaveEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CEZ_AUTOSAVE === '1';
}

/** The handoff block's autosave record and cockpit note for a save that committed or left work
 *  behind (hearsay-tools/cezarion#1004): a resumed session reads this, not `git log`. */
function autosaveReportLine(reason: AutosaveReason, outcome: AutosaveOutcome, taskBranch: string | undefined): string {
  const where = outcome.branch ?? 'detached HEAD';
  if (outcome.result === 'committed') {
    const what = outcome.sha ? `${outcome.sha} on ${where}` : `on ${where} (sha unavailable)`;
    return `${reason}: cezar autosave committed ${what}; ` +
      `to fold it into your own commits while it is HEAD, run \`git reset --soft ${outcome.sha ?? 'HEAD'}~1\``;
  }
  return `${reason}: ${outcome.changedPaths} changed path(s) left uncommitted on ${where}; ` +
    `cezar does not autosave on a branch other than the task branch ${taskBranch ?? '(unrecorded)'}`;
}

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



/** What a turn end said, as the entry that settles it reads it (hearsay-tools/cezarion#1525). The
 *  turn end reads it from the turn; a later entry from what `parkAfterAck` kept (`boundaryTurn`). */
type SettledTurn = {
  stepId: string | undefined;
  monitoring: boolean;
  humanGate: boolean;
  /** This turn's ask, which the turn end surfaces as a card; a later entry has none. */
  ask: AskRequest | null;
  /** The ask line's autonomous nudge went instead of the question. */
  askNudged: boolean;
  humanWait?: HumanWaitEntry | undefined;
  sink?: UiEventSink;
  done: boolean;
  doneRequest?: ActiveRun['doneRequested'];
  /** The turn answered the no-wait nudge. The completion cause's flag is `completionNudgeAnswered`. */
  nudgedLastTurn: boolean;
  scheduleWakeup?: number | null | undefined;
};
/** What `carryOutTurnEnd` hands the method for a decision kind. `session` is the session as the
 *  decision found it. */
type TurnEndCarry = {
  runId: string; state: ActiveRun; session: AgentSession | undefined; stepId: string | undefined;
  refused: CompletionRefusal | undefined; noteRefusal: () => void;
  /** The refusal settles this turn end, so Cezar's own human waits are already withdrawn. */
  settlesRefusal: boolean;
};
/** One method per decision kind of `decideTurnEnd` (`RunManager.turnEndCarriers`). */
type TurnEndCarriers = { [K in TurnEndDecision['kind']]: (carry: TurnEndCarry, decision: Extract<TurnEndDecision, { kind: K }>) => TurnEndOutcome };

/** #505: a real steer is read at the harness's next model step; a quiet boundary this long
 * with input still unread means the harness will not read it without help. */
export const UNREAD_INPUT_GRACE_MS = 30_000;
/** #486: recheck a turn-end that deferred close/park only because the harness still held a human follow-up. */
export const HELD_HUMAN_INPUT_RECHECK_MS = 250;

function unreadInputUnconfirmedNote(count: number): string {
  return `delivered ${count} message${count === 1 ? '' : 's'}; the agent did not confirm reading ${count === 1 ? 'it' : 'them'}`;
}
/** Bound a no-wait nudge that is ACKed but never produces a turn (#544,
 *  hearsay-tools/cezarion#1234). OpenCode heartbeats re-arm the managed-session no-progress
 *  guard, so this is the DEFAULT-path exit when the agent stays silent. Overridable on RunManager. */
export const NO_WAIT_NUDGE_REPLY_MS = 5 * 60_000;
/** A worker's second turn end with no wait or done asks its parent, as a routed open question
 *  (hearsay-tools/cezarion#1301). */
export const WORKER_FALLBACK_QUESTION = (workerId: string) => `Worker ${workerId} ended its turn without waiting on anything or finishing. Reply with what it should do next.`;
export const WORKER_FALLBACK_HEADER = 'Worker idle';
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
 * Auto-resume after a provider usage limit (spec 2026-08-03-auto-resume-after-usage-limit).
 *
 * The wait is the provider's own reset instant plus this grace: resuming AT the boundary races the
 * provider's clock (and its rounding), and one failed resume costs the whole window over again.
 * Thirty seconds is cheap next to five hours and long enough to be past any sane skew.
 */
export const AUTO_RESUME_GRACE_MS = 30_000;
/**
 * Consecutive automatic resumes allowed without a human turn. A resume can only fire after a real
 * reset instant, so this is not a throttle — it is the backstop for the pathological case (a
 * provider that answers "limit reached, retry now" in a loop), and it is deliberately generous
 * enough to sit through a couple of days of five-hour windows.
 */
export const MAX_AUTO_RESUMES = 12;
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
 * How long a missed deadline stays worth acting on. The promise is "we pick this up when the
 * window reopens" — kept across a restart or an overnight close, which is the case the feature
 * exists for. A day later it is no longer that promise: the user has moved on, and a task
 * springing back to life is a surprise rather than a service. Such a deadline is retired with a
 * note instead of fired, so the only tasks a sweep can revive are ones someone is still waiting on.
 */
export const AUTO_RESUME_MISSED_WINDOW_MS = 24 * 60 * 60_000;

/**
 * How often the queue checks that it is not wedged.
 *
 * A hold is the only thing in the engine that can make an idle queue CORRECT, so it is also the
 * only thing that can make a wedged one look correct. This tick is the way out: cheap (a few
 * in-memory checks), unref'd, and it only ever acts when idling has no justification left.
 */
export const QUEUE_WATCHDOG_MS = 60_000;
/** Shared empty holds for the common "nothing is held" pump — avoids allocating per sweep. */
const NO_HOLDS: AccountHolds = { deadline: new Set(), inFlight: new Set() };

const AUTO_RESUME_PROMPT =
  'The provider usage limit that interrupted this task has reset. Read the handoff file (CEZ_HANDOFF_FILE) to recover context, then continue the task from where you left off.';


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

/** The delegation family a run belongs to, by its root's id: a worker's parent, else itself. */
function familyOf(run: RunRecord): string {
  return run.delegation?.role === 'worker' ? run.delegation.parentRunId : run.id;
}


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
  // Queue + `starting` set (spec 006, janitor's pump() pattern): `starting`
  // covers the window between shifting a run off the queue and the run
  // registering in `active`, so parallel-slot counting is never racy.
  private readonly queue: string[] = [];
  private readonly executions = new Map<string, { generation: string; admitted: boolean; promise: Promise<void>; resolve: () => void; sessions: Set<Promise<void>>; turns: Set<Promise<void>>; deliveries: Set<Promise<void>> }>();
  private readonly finalizedWorkers = new Map<string, string>();
  private readonly stoppedWorkers = new Set<string>();
  private readonly terminationWaiters = new Set<() => void>();

  private beginWorkerExecution(runId: string, admitted = true): void {
    if (this.store.getRun(runId)?.delegation?.role !== 'worker') return;
    if (this.claims.has(runId) || !!this.autosaveCleanupBlocker(runId)) throw new Error('Worker resources are being cleaned up');
    // #469: one site for Continue, --resume, parent replies and queued revival after a crash.
    // Fresh: admission is one-shot, so a cached "alive" must not refuse an orphan that has since died.
    if (!this.executions.has(runId)) this.settleOrphanedWorkerExecution(runId, { admitting: true, fresh: true });
    const refusal = this.executions.has(runId) ? undefined : this.orphanAdmissionRefusal(runId);
    if (refusal) throw new WorkerOrphanAliveError(refusal);
    const existing = this.executions.get(runId);
    if (existing) {
      const proof = this.store.readWorkerExecution(runId);
      if (!existing.admitted && admitted && proof?.generation === existing.generation && proof.phase === 'starting') {
        existing.admitted = true; return;
      }
      throw new Error('Worker execution is still finalizing');
    }
    const generation = this.store.commitWorkerExecutionStart(runId);
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    this.executions.set(runId, { generation, admitted, promise, resolve, sessions: new Set(), turns: new Set(), deliveries: new Set() });
    this.finalizedWorkers.delete(runId);
    // #469: an earlier generation's destroy blocker never describes this one.
    this.orphans.forgetBlockers(runId);
    this.stoppedWorkers.delete(runId);
  }

  private async finishWorkerExecution(runId: string): Promise<void> {
    const execution = this.executions.get(runId);
    if (!execution) return;
    await Promise.allSettled([...execution.sessions]);
    await Promise.allSettled([...execution.turns]);
    await Promise.allSettled([...execution.deliveries]);
    // Every wrapper settles after runner result, workflow and final filesystem work.
    // A disposed manager cannot attest to the recovered generation's state.
    if (!this.disposed) {
      this.finalizedWorkers.set(runId, execution.generation);
      this.persistWorkerCompletion(runId, execution.generation);
    }
    if (this.executions.get(runId) === execution) this.executions.delete(runId);
    execution.resolve();
    if (!this.disposed) {
      try { this.queueWaitWake(runId); } catch { this.retryWaitAdmission(runId); }
    }
    if (!this.disposed && this.store.getRun(runId)?.stopping) this.store.updateRun(runId, { stopping: undefined });
    if (!this.disposed) this.releaseSlot();
  }

  /** Capture every returned process result before setup can throw. A setup
   * exception or an interrupt request cannot stand in for session termination. */
  private trackWorkerSessionResult(runId: string, session: AgentSession): Promise<void> {
    const closed = session.result.then(() => undefined, () => undefined);
    this.executions.get(runId)?.sessions.add(closed);
    return closed;
  }

  private persistWorkerCompletion(runId: string, generation: string): void {
    try {
      if (this.stoppedWorkers.has(runId)) transitionVia('stop-worker', () => this.store.getRun(runId), () => this.store.commitWorkerCancellation(runId));
      if (this.store.commitWorkerExecutionComplete(runId, generation)) {
        this.finalizedWorkers.delete(runId);
        this.reapTerminalScratch(runId);
      }
    } catch { /* Finalized in this process; preserve exact generation for an explicit retry. */ }
  }

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

  /** Best effort: a failed write leaves the working-directory scan as this process's evidence. */
  private recordWorkerProcess(runId: string, pid: number): void {
    const generation = this.executions.get(runId)?.generation;
    if (!generation) return;
    try { if (!this.store.appendWorkerProcess(runId, generation, pid, sessionGroupOf(pid))) console.warn(`[cez] worker ${runId} process record unavailable; relying on the working-directory scan`); }
    catch { console.warn(`[cez] worker ${runId} process record write failed; relying on the working-directory scan`); }
  }

  private trackTurnEnd(runId: string, text: string): void {
    const task = this.recordTurnEnd(runId, text);
    const turns = this.executions.get(runId)?.turns;
    turns?.add(task);
    void task.catch(() => undefined).finally(() => turns?.delete(task));
  }

  requestWorkerStop(runId: string): WorkerStopResult {
    if (this.store.getRun(runId)?.delegation?.role !== 'worker') throw new Error('Worker not found');
    if (!this.executions.has(runId) && !this.isActive(runId) && ['done', 'failed', 'cancelled', 'review'].includes(this.store.getRun(runId)!.status) && this.store.readWorkerExecution(runId)?.phase === 'complete') return { workerId: runId, state: 'terminated' };
    this.cancel(runId);
    return { workerId: runId, state: !this.executions.has(runId) && this.store.readWorkerExecution(runId)?.phase === 'complete' ? 'terminated' : 'stopping' };
  }

  async awaitRunTermination(runId: string, timeoutMs: number, opts: { reapOrphans?: boolean } = {}): Promise<boolean> {
    const terminated = await this.proveRunTermination(runId, timeoutMs, opts);
    if (terminated && opts.reapOrphans && !this.disposed) await this.terminateFinishedWorkerGroups(runId, timeoutMs);
    return terminated;
  }

  private async proveRunTermination(runId: string, timeoutMs: number, opts: { reapOrphans?: boolean }): Promise<boolean> {
    const execution = this.executions.get(runId);
    if (!execution) {
      const generation = this.finalizedWorkers.get(runId);
      if (!this.disposed && generation) this.persistWorkerCompletion(runId, generation);
      else if (!generation && opts.reapOrphans) await this.reapOrphanedWorker(runId, timeoutMs);
      else if (!generation) this.settleOrphanedWorkerExecution(runId);
      return this.store.readWorkerExecution(runId)?.phase === 'complete';
    }
    if (this.disposed) return false;
    await new Promise<void>(resolve => {
      const settle = () => { clearTimeout(timer); this.terminationWaiters.delete(settle); resolve(); };
      const timer = setTimeout(settle, Math.min(30_000, Math.max(0, Number.isFinite(timeoutMs) ? timeoutMs : 0)));
      this.terminationWaiters.add(settle);
      void execution.promise.then(settle);
    });
    return !this.executions.has(runId) && this.store.readWorkerExecution(runId)?.phase === 'complete';
  }

  private historyDeletionPending(runId: string): boolean {
    return historyDeletionPending(this.store, runId);
  }

  private workerExecutionStopped(runId: string): boolean {
    const run = this.store.getRun(runId);
    return this.historyDeletionPending(runId) || run?.delegation?.role === 'invalid' || (run?.delegation?.role === 'worker' &&
      (!!run.delegation.destroy || this.stoppedWorkers.has(runId)));
  }

  private readonly starting = new Set<string>();
  /** Runs whose worktree a reclaim, or whose branch a delete, is removing right now
   *  (`claimWorktreeReclaim`, `claimForBranchCleanup`). `continueRun` refuses them. */
  private readonly claims: MaintenanceClaims;
  private get reclaiming(): Set<string> { return this.claims.reclaiming; }
  // Runs parked at `waiting` (open session, ball in the user's court). They
  // don't consume a `maxParallel` slot (#347) — an idle claude process costs
  // memory but no tokens, queued work progressing matters more, and the idle
  // timeout already bounds how long a session can sit open. Invariant:
  // `waiting ⊆ active` — always cleared together via dropActive().
  private readonly waiting = new Set<string>();
  /** Durable monitoring subset. Only the configured number receives the waiting-slot exemption. */
  private readonly monitoring = new Set<string>();
  /** A run whose resolved waits wait for a wake (hearsay-tools/cezarion#1233). Separate from
   *  human waiting: these resumes MUST reacquire scheduler capacity. Keyed by run id. */
  private readonly waitWakeQueuedAt = new Map<string, number>();
  private readonly waitWakeAdmitted = new Set<string>();
  /** One CI watch per open CI wait, keyed by wait id. */
  private readonly ciWatches = new Map<string, { runId: string; abort: AbortController }>();
  /** CI lookups in flight, keyed by run id and normalized PR URL: two PRs may register at once. */
  private readonly ciRegistrations = new Map<string, { runId: string; abort: AbortController; promise: Promise<PrWaitEntry | TimerWaitEntry> }>();
  /** A resolution whose checkpoint failed, retried by wait id. */
  private readonly ciRetries = new Map<string, { runId: string; timer: NodeJS.Timeout }>();
  /** Process waits' watches (hearsay-tools/cezarion#1446), by wait id. */
  private readonly processWatches = new Map<string, { runId: string; abort: AbortController }>();
  private readonly processSupervisor = new ProcessWaitSupervisor();
  /** Worker waits whose resolution write failed and is being retried: the warning is said once. */
  private readonly workerResolveRetries = new Set<string>();
  /** A wake that could not be admitted yet, retried by run id. */
  private readonly wakeRetries = new Map<string, NodeJS.Timeout>();
  /** The last "retained; continuation unavailable" note per run: the 1 Hz admission retry writes
   *  it on the transition into refusal or when the reason changes, never once per retry. */
  private readonly retainedNotes = new Map<string, string>();
  /** The wait before the next automatic delivery attempt after a failed one, by run id. */
  private readonly wakeBackoffs = new Map<string, NodeJS.Timeout>();
  // Private and overridable so tests need not wait out production cadence.
  private wakeRetryBackoff: Backoff = WAKE_RETRY_BACKOFF;
  /** One timer per open timer wait, keyed by wait id. */
  private readonly waitTimers = new Map<string, { runId: string; timer: NodeJS.Timeout }>();
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
  /** Each family's conversation request deadlines. Every worker wait, Cezar's completion wait
   *  included, parks, wakes and times out through the wait list (hearsay-tools/cezarion#1301). */
  private readonly requestDeadlineTimers = new Map<string, NodeJS.Timeout>();
  private readonly inboxClaimTimers = new Map<string, NodeJS.Timeout>();
  private reconcilingWorkers = false;
  private reconcilingFamily: string | undefined;
  private readonly pendingReconciliations = new Set<string | undefined>();
  /** What the recovery in progress covers: every run at boot (`family` undefined), or the one
   *  family an adoption hands it (#779, plan step 3). Undefined: no recovery in progress. */
  private recoveryScope: { family?: string } | undefined;
  /** Settles when the recovery in progress (if any) has finished. */
  private recoveryInFlight: Promise<void> | undefined;
  private recoveryFactsPending = false;
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
    this.resolvePeerWaits(runsAwaitingPeer(run, () => this.store.listRuns())); // never in recovery: an interrupted peer fails, then continues
  };
  private readonly pendingJobs = new Map<string, { workflow: WorkflowDef; input: StartRunInput; startAt?: number | undefined }>();
  /** Interrupted agent turns recovered after a process restart. Unlike an
   *  explicit user Continue, these are bulk scheduler work and must re-enter
   *  through `pump()` so both workspace and per-project caps are honored. */
  private readonly pendingContinuations = new Map<string, PendingContinuation>();
  /** The configured default runner as `pump()` last read it, so the sync `oldestWakeAt()` resolves
   *  a runnerless record's account the same way (hearsay-tools/cezarion#1236). */
  private configuredDefaultRunner: RunnerId | undefined;
  /** Accepted Continues supersede in-flight settlement even before launch or after
   * idle close. Retain these across dropActive/dispose so absence cannot look like
   * the earlier execution again; disposal alone never revokes terminal intent. */
  private readonly continuationGenerations = new Map<string, symbol>();
  private readonly attachments: AttachmentWriter;
  private get queuedImageSeq(): Map<string, number> { return this.attachments.queuedImageSeq; }
  /** Messages after hydration in the dequeue → session-open gap (#472).
   * Wait-withdrawing entries also retain a durable queue ID until delivered. */
  private readonly deferredMessages = new Map<string, Array<{ content: PastedContent[]; messageId?: string }>>();
  /** Armed usage-limit resumes, keyed by run id (spec
   *  2026-08-03-auto-resume-after-usage-limit). The DEADLINE itself lives on the record
   *  (`autoResumeAt`) — this map holds only the process-local timer, so a restart rebuilds it
   *  from the record rather than losing the wait. Runs here are `failed` and therefore NOT in
   *  `active`, which is why the timer cannot live on an `ActiveRun` like the monitoring one. */
  private readonly autoResumeTimers = new Map<string, NodeJS.Timeout>();
  private pumping = false;
  /** The scheduler only needs repo presence, stable for this manager's lifetime.
   * Cache the promise (including null) so every sweep doesn't spawn Git (#364).
   * execute() still reads fresh branch/remote metadata for each run. */
  private pumpRepoInfo?: ReturnType<typeof getRepoInfo>;
  /** A pump that arrived while one was in flight — replayed by `pump()`'s own
   *  loop so a slot freed mid-sweep is never a lost wakeup. */
  private pumpAgain = false;
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

  /** Set by the watchdog for exactly one sweep: ignore the usage-limit hold and make progress. */
  private forceNextPump = false;

  /** Runs the watchdog started despite the hold. The spawn-time gate (`requeueWhileHeld`) would
   *  otherwise hand them straight back and the rescue would undo itself in a millisecond. */
  private readonly forceStarted = new Set<string>();

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
    this.workerScratchCleanup = new WorkerScratchCleanup(store, this.dataDir, id => this.isActive(id) || this.executions.has(id) || this.claims.has(id) || !!this.autosaveCleanupBlocker(id));
    this.preview = options.preview;
    this.cezarPort = options.cezarPort;
    // #774: `serve` knows its bound origin before it recovers, so recovered runs carry it too.
    if (options.cockpit) this.setCockpitAddress(options.cockpit);
    this.unreadInputGraceMs = options.unreadInputGraceMs ?? UNREAD_INPUT_GRACE_MS;
    this.noWaitNudgeReplyMs = options.noWaitNudgeReplyMs ?? NO_WAIT_NUDGE_REPLY_MS;
    this.semaphore = options.semaphore ?? new WorkspaceSemaphore();
    this.orphans = new WorkerOrphans(
      { store, repoRoot, dataDir: this.dataDir, semaphore: this.semaphore, disposed: () => this.disposed },
      { holds: (id, admitting) => this.executions.has(id) || this.active.has(id) || this.starting.has(id) || (!admitting && this.queue.includes(id)),
        reapTerminalScratch: id => this.reapTerminalScratch(id),
        settleOrphanedWorkerExecution: (id, opts) => this.settleOrphanedWorkerExecution(id, opts),
        orphanBackoff: () => this.orphanBackoff, orphanTermGraceMs: () => this.orphanTermGraceMs },
    );
    this.automationToolsSlot = new AutomationToolsSlot(
      { store, repoRoot, dataDir: this.dataDir, semaphore: this.semaphore, disposed: () => this.disposed },
      () => !!this.cockpit,
    );
    this.claims = new MaintenanceClaims(
      { store, repoRoot, dataDir: this.dataDir, semaphore: this.semaphore, disposed: () => this.disposed },
      { isActive: id => this.isActive(id), autosaveCleanupBlocker: id => this.autosaveCleanupBlocker(id),
        hasExecution: id => this.executions.has(id), scheduleScratchCleanup: id => this.workerScratchCleanup.schedule(id),
        holdForMaintenance: ids => this.holdForMaintenance(ids) },
    );
    this.attachments = new AttachmentWriter(
      { store, repoRoot, dataDir: this.dataDir, semaphore: this.semaphore, disposed: () => this.disposed },
      { persistAttachment: (id, mediaType, data, prefix) => this.persistAttachment(id, mediaType, data, prefix) },
    );
    this.repoRootLease = new RepoRootLease(
      { store, repoRoot, dataDir: this.dataDir, semaphore: this.semaphore, disposed: () => this.disposed },
      { park: id => { this.waiting.add(id); }, unpark: id => { this.waiting.delete(id); },
        releaseSlot: () => this.releaseSlot() },
    );
    this.turnBookkeeper = new TurnBookkeeper(
      { store, repoRoot, dataDir: this.dataDir, semaphore: this.semaphore, disposed: () => this.disposed },
      { isDisposedDelegatedRun: id => this.isDisposedDelegatedRun(id), discoverSkills: () => this.discoverSkills(),
        reviveWorkflow: run => this.reviveWorkflow(run), autoNameRun: (id, skill, task, live) => this.autoNameRun(id, skill, task, live) },
    );
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
    for (const task of this.ciWatches.values()) task.abort.abort();
    this.processSupervisor.close();
    this.ciWatches.clear();
    for (const task of this.ciRegistrations.values()) task.abort.abort();
    this.ciRegistrations.clear();
    for (const retry of this.ciRetries.values()) clearTimeout(retry.timer);
    this.ciRetries.clear();
    for (const timer of this.wakeRetries.values()) clearTimeout(timer);
    this.wakeRetries.clear();
    for (const timer of this.wakeBackoffs.values()) clearTimeout(timer);
    this.wakeBackoffs.clear();
    // Wait records stay as they are: a later manager re-arms them from their deadlines.
    for (const entry of this.waitTimers.values()) clearTimeout(entry.timer);
    this.waitTimers.clear();
    this.ciResources.release();
    this.delegationProvisioner = undefined;
    this.finalizedWorkers.clear();
    this.orphans.dispose();
    for (const settle of this.terminationWaiters) settle();
    this.store.off('run', this.onDelegationRun);
    this.store.off('deleted', this.onRunDeleted);
    for (const timer of this.requestDeadlineTimers.values()) clearTimeout(timer);
    this.requestDeadlineTimers.clear();
    for (const timer of this.inboxClaimTimers.values()) clearTimeout(timer);
    this.inboxClaimTimers.clear();
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
    for (const timer of this.autoResumeTimers.values()) clearTimeout(timer);
    this.autoResumeTimers.clear();
    this.active.clear();
    this.waiting.clear();
    this.starting.clear();
    this.queue.length = 0;
    this.pendingJobs.clear();
    this.pendingContinuations.clear();
    this.memoryPausing.clear();
    this.turnBookkeeper.clear();
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

  /** Env for the rolling handoff and artifacts.
   *
   *  `TMPDIR`/`TEMP`/`TMP` (#785) point at this run's own scratch directory
   *  instead of the machine-wide one every agent used to share. Created and
   *  write-probed here, on the last common path before a spawn, so an unusable
   *  temp directory throws `AgentTempDirError` at the caller rather than
   *  turning into empty command output inside a running agent. */
  private agentEnv(runId: string): Record<string, string> {
    return {
      CEZ_ARTIFACTS_DIR: provisionArtifactDirectory(this.dataDir, runId),
      CEZ_HANDOFF_FILE: handoffPath(this.dataDir, runId),
      CEZ_TASK_ID: runId,
      // Shadow a path inherited from an older parent process.
      CEZ_TODOS_FILE: '',
      ...agentTmpEnv(this.dataDir, runId),
      ...(this.cockpit ? { CEZ_COCKPIT_URL: this.cockpit.origin, CEZ_PROJECT_ID: this.cockpit.projectId } : {}),
    };
  }

  /** The pinned identity one agent step of an owned worker runs under; undefined for ordinary and internal runs. */
  private workerStep(runId: string, stepId: string | undefined): WorkerStepIdentity | undefined {
    const identity = workerIdentity(this.store, this.repoRoot, runId, stepId);
    if (!identity) return undefined;
    return stepId === undefined
      ? { account: identity.account, grants: identity.grants, ...(identity.model === undefined ? {} : { model: identity.model }), ...(identity.effort === undefined ? {} : { effort: identity.effort }) }
      : workerStepIdentity(identity, stepId);
  }

  private async agentEnvForStep(
    runId: string,
    backend: RunnerId,
    options: { recordedProfileId?: string | undefined; stepId?: string | undefined } = {},
  ): Promise<{ env: Record<string, string>; profileId: string; accountBinding?: WorkerAccountBinding | undefined }> {
    // An owned worker binds the account its identity pinned for THIS step (#452); a legacy identity
    // answers every step with its single run-level account, so the one-provider rule still holds there.
    const step = this.workerStep(runId, options.stepId);
    if (step) {
      if (backend !== step.account.provider) throw new WorkerIdentityError('Accepted worker provider identity cannot change');
      const env = this.agentEnv(runId);
      return { env: { ...env, ...boundWorkerAccountEnv(step.account, buildChildEnv({ backend, extraEnv: env })) },
        profileId: step.account.profileId, accountBinding: step.account };
    }
    const run = this.store.getRun(runId);
    const profileId = options.recordedProfileId
      ?? (backend === (run?.runner ?? 'claude') ? run?.agentProfile : undefined);
    const resolved = await resolveProfileEnvForRoot(this.repoRoot, backend, profileId);
    const env = { ...this.agentEnv(runId), ...resolved.env };
    return {
      env,
      profileId: resolved.profile.id,
      accountBinding: process.env.CEZ_DELEGATION === '1' ? captureWorkerAccount(resolved.profile, buildChildEnv({ backend, extraEnv: env })) : undefined,
    };
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
  /** Automations on AND a cockpit attached: the one predicate behind the prompt part and the built-in skill. */
  private automationsReachable(): boolean {
    return !!this.cockpit && resolveCapabilities().automations;
  }
  /** The built-in skills this manager may offer now; empty unless automations are reachable. */
  builtinSkills(): Skill[] {
    return this.automationsReachable() ? [createAutomationSkill(automationCliCommand())] : [];
  }
  /** The automations part of every session's system prompt, or nothing. */
  private automationsPart(): string | undefined {
    return this.automationsReachable() ? automationsPrompt(automationCliCommand()) : undefined;
  }
  /** The "Project webhooks" part (#1576): the webhooks this project exposes to agents, read from
   *  the registry when a session starts. Needs a cockpit to send through; nothing exposed, or an
   *  unreadable registry, adds nothing. */
  private async agentWebhooksPart(): Promise<string | undefined> {
    if (!this.cockpit) return undefined;
    const entry = await registryEntry(this.cockpit.projectId, this.repoRoot).catch(() => undefined);
    return agentWebhooksPrompt(webhookCliCommand(), agentWebhooks(entry));
  }
  /**
   * One launch's session-start context (hearsay-tools/cezarion#1584): the run's own handoff,
   * then the project's `context.yaml` rules for this recipient, read now and rendered once.
   * Every launch reports its outcome as one lifecycle line. Both launch sites — a fresh step
   * and `runContinuation` — come here; a live message never does. The prefix goes into the
   * opening message only, never the system prompt a worker inherits (#778).
   */
  private sessionContextFor(runId: string, state: ActiveRun, stepId: string, openingPrompt: string): SessionContext {
    const run = this.store.getRun(runId);
    const role = run?.delegation?.role === 'worker' ? 'worker' : 'parent';
    const handoff = handoffPath(this.dataDir, runId);
    refreshHandoffRecords(this.store, this.dataDir, runId);
    // A backend's own slash command only works at character zero (#676); a prefix would turn
    // it into plain text, so such a launch gets no context and keeps the read instruction.
    const context: SessionContext = leadingSlashSkillName(openingPrompt)
      ? { prefix: '', handoffInjected: false, reports: [{ id: 'session-context', status: 'skipped', sources: [], reason: 'the opening message is a slash command, which must stay at its start' }] }
      : buildSessionContext({
        projectRoot: this.repoRoot,
        cwd: state.cwd,
        role,
        handoffPath: handoff,
        variables: {
          ...(run ? { task: run.task, 'workflow.name': run.workflow } : {}),
          'run.id': runId,
          role,
          'step.id': stepId,
          'project.root': this.repoRoot,
          'worktree.root': state.cwd,
          'handoff.path': handoff,
        },
      });
    this.store.appendEvent(runId, { type: 'lifecycle', message: formatSessionContextReport(context.reports) });
    return context;
  }
  /** Every skill lookup in this manager goes through here, so the built-ins reach all of them. */
  private discoverSkills(): Promise<Skill[]> {
    return discoverSkills(this.repoRoot, { builtin: this.builtinSkills() });
  }
  /**
   * Load the run's skill registry: the ONLY writer of `state.skills` (hearsay-tools/cezarion#1806).
   * `execute` and `runContinuation` both call it, once the run is registered and after the awaits
   * that precede its first prompt. `'throw'` lets a failed discovery fail the run, as a fresh run
   * always did; `'ignore'` keeps the registry the run already has, or none, because discovery must
   * never break a Continue (open-mercato/cezar#811). An empty registry expands no `/skill` (it is not an error).
   */
  private async loadRunSkills(state: ActiveRun, onFailure: 'throw' | 'ignore'): Promise<void> {
    // Only a rejected discovery is a failure to ignore; a synchronous throw escaped the old
    // `.catch` too, and still fails the caller.
    const discovery = this.discoverSkills();
    try {
      state.skills = await discovery;
    } catch (error) {
      if (onFailure === 'throw') throw error;
    }
  }
  /**
   * The run's skill registry minus the project's off-list as it is now (#1494): the ONLY reader of
   * `state.skills`. The registry is discovered when the run starts or continues, so a team skill
   * switched off since then is still in `state.skills`; every prompt a step, a Continue or a live
   * `/name` builds reads this instead. A caller that already read the off-list passes it as
   * `disabled`, so that both see one list.
   */
  private enabledSkills(
    state: ActiveRun,
    disabled = readDisabledTeamSkills(readProjectUiStateSync(this.repoRoot)),
  ): Skill[] {
    return filterDisabledTeamSkills(state.skills ?? [], disabled);
  }
  /**
   * A live `/name` message already carries the skill's body, and `sendMessage` answers
   * synchronously, so its files and companions install after the message went out (#1408).
   * When anything new landed, or a team skill's files went to a cache copy the message could not
   * name, one durable agent input says what and where. Whether a runner's native lookup sees a skill
   * added mid-session is not relied on: that input is the delivery for every runner. Nothing
   * new: no input. A run that stopped, or moved to another session, gets none.
   */
  private provisionLiveSlashSkill(runId: string, state: ActiveRun, blocks: ContentBlock[]): void {
    const first = blocks.find((block) => block.type === 'text');
    const name = first?.type === 'text' ? leadingSlashSkillName(first.text) : undefined;
    if (!name) return;
    const session = state.session;
    state.liveSkillProvisioning = (async () => {
      const { filesDir, installed } = await this.provisionRunSkills(runId, state, { slash: name });
      const dir = filesDir.get(name);
      if (installed.length === 0 && !dir) return;
      if (state.cancelled || this.active.get(runId) !== state || state.session !== session) return;
      const text = [
        ...(installed.length ? [`Skills installed for /${name}: ${installed.join(', ')}.`] : []),
        ...(dir ? [`Skill files for /${name} are at ${dir}.`] : []),
      ].join(' ');
      // The durable queue delivers it at the runner's next opportunity: several runners refuse
      // agent input while the human message is in flight, and a restart replays it.
      const input: AgentInput = { id: randomUUID(), parentRunId: runId, source: 'lifecycle', text, createdAt: new Date().toISOString() };
      this.store.commitAgentInputs(runId, enqueueAgentInput(this.store.getRun(runId)!, input));
      this.store.appendEvent(runId, { type: 'agent-input', input });
      this.flushAgentInputs(runId);
    })().catch(() => undefined);
  }

  /**
   * Provision the step skill and leading registry slash skill for start, Continue, recovery and
   * live input, and at a step's start every registry skill its prompt names as a typed `/name`
   * (#1672). Native slashes that are not registry skills install nothing.
   *
   * The run's OWN task worktree gets every root and the companions their bodies name
   * (`provisionSkills`): links to local and global skills, generated `SKILL.md` files, and marked
   * team copies, in `.claude/skills`, `.agents/skills` and `.cursor/skills`, recorded in the
   * worktree's git dir and kept out of git by a worktree-local `.gitignore`. The project's
   * off-list (`disabledTeamSkills`) is read fresh on every pass and applied to the saved
   * registry, the roots and the team list alike: a team skill switched off for the project is
   * never installed, not even for a skill that runs it, and a switch-off made after the run
   * started holds for the next step, a live `/name` and Continue. Copies a pass installed before
   * the switch stay in the worktree until the task ends: cezar removes nothing mid-task.
   *
   * Any other cwd — worktree off, a non-git project, a Continue whose worktree is gone — is the
   * main checkout or unknown, where those directories are LOCAL skills to `discoverSkills` that
   * would shadow the team source for every later run. A selected or leading-slash directory team
   * root gets a per-commit cache copy there instead, and nothing else is installed: a skill only
   * the prompt names gets nothing there, like a companion. So does a worktree where no copy of
   * it landed, such as one whose three agent dirs all link out of it; one that took only some
   * copies names the first that landed, since the runner's own dir may be the one skipped.
   * Returns the step-start notes and, per team root, the directory its prompt must name.
   */
  private async provisionRunSkills(
    runId: string,
    state: ActiveRun,
    wanted: { stepSkill?: string | undefined; slash?: string | undefined; prompt?: string },
  ): Promise<{ notes: string[]; filesDir: Map<string, string>; installed: string[] }> {
    const notes: string[] = [];
    const filesDir = new Map<string, string>();
    const wantedNames = [...new Set([wanted.stepSkill, wanted.slash].filter((name): name is string => Boolean(name)))];
    // Stop can land during an earlier await (Continue's team-cache wait): a stopped run writes
    // nothing, here or between the pass's own steps.
    const stopped = () => Boolean(state.cancelled) || this.workerExecutionStopped(runId);
    // The off-list as it is now, applied to every input: the saved registry predates a switch
    // made during the run, so it is filtered as well as the fresh team list.
    const disabled = readDisabledTeamSkills(await readProjectUiState(this.repoRoot));
    const registry = this.enabledSkills(state, disabled);
    // A skill the prompt names as `/name` is a root after the selected ones, so a capped closure
    // never leaves it out (#1672). It installs only in the task worktree, like a companion.
    const named = registry.filter((skill) => namesSkillCommand(wanted.prompt ?? '', skill.name)).map((skill) => skill.name);
    const roots = [...new Set([...wantedNames, ...named])]
      .flatMap((name) => registry.filter((skill) => skill.name === name).slice(0, 1));
    if (roots.length === 0 || stopped()) return { notes, filesDir, installed: [] };
    const teamRoots = roots.filter((skill) => wantedNames.includes(skill.name) && skill.source === 'team' && skill.team?.dir);
    const cacheCopy = async (skill: Skill): Promise<void> => {
      const dir = await materializeSkillToCache(skill).catch(() => null);
      if (!dir) return;
      notes.push(`team skill "${skill.name}" materialized to ${dir}`);
      filesDir.set(skill.name, dir);
    };
    if (!this.isOwnTaskWorktree(runId, state.cwd)) {
      for (const skill of teamRoots) await cacheCopy(skill);
      return { notes, filesDir, installed: [] };
    }
    const catalog = [...registry, ...filterDisabledTeamSkills(getTeamSkillsCached(this.repoRoot), disabled)];
    const result = await provisionSkills(state.cwd, roots, catalog, { cancelled: stopped });
    if (stopped()) return { notes, filesDir, installed: [] };
    for (const skill of teamRoots) {
      const written = result.teamCopies[skill.name] ?? [];
      if (written.length === TEAM_SKILL_AGENT_DIRS.length) {
        notes.push(`team skill "${skill.name}" materialized to .claude/skills/${skill.name}/ ` +
          `.agents/skills/${skill.name}/, and .cursor/skills/${skill.name}/`);
      } else if (written.length > 0) {
        notes.push(`team skill "${skill.name}" materialized to ${written.map((dir) => `${relative(state.cwd, dir)}/`).join(' and ')}`);
        filesDir.set(skill.name, written[0]!);
      } else {
        await cacheCopy(skill);
      }
    }
    const others = result.installed.filter((name) => !teamRoots.some((skill) => skill.name === name));
    if (others.length > 0 || result.truncated) {
      notes.push(`skills installed in the task's workspace: ${others.join(', ') || 'none new'}` +
        (result.truncated ? `; closure capped at ${MAX_SKILL_CLOSURE}, skipped ${result.truncated} and later` : ''));
    }
    return { notes, filesDir, installed: result.installed };
  }
  /** `cwd` is the run's recorded task worktree, and not the project root. Unresolvable means no. */
  private isOwnTaskWorktree(runId: string, cwd: string): boolean {
    const worktreePath = this.store.getRun(runId)?.worktreePath;
    if (!worktreePath) return false;
    const real = (path: string): string | undefined => { try { return realpathSync(path); } catch { return undefined; } };
    const dir = real(cwd);
    return dir !== undefined && dir === real(worktreePath) && dir !== real(this.repoRoot);
  }

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

  private completionRefusal(runId: string): CompletionRefusal | undefined {
    if (this.store.getRun(runId)?.delegation?.role !== 'root') return undefined;
    return rootCompletionRefusal({ questions: this.unansweredQuestions(runId), blockers: this.parentCompletionBlockers(runId),
      requests: openCompletionRequests(this.store, runId), incomingRefused: !!this.active.get(runId)?.incomingRequestRefused });
  }

  /** The `cezar_done` this session accepted since its last turn end, taken by this turn end: a
   *  later turn must call it again, as it must repeat the done line. */
  private takeDoneRequest(state: ActiveRun) {
    const request = state.doneRequested?.session === state.session ? state.doneRequested : undefined;
    state.doneRequested = undefined;
    return request;
  }

  /** The DONE boundary and close metadata; a refused DONE may retain metadata for readiness. */
  private recordDoneAtBoundary(state: ActiveRun, done: boolean, request: ActiveRun['doneRequested'], keepClose = done): void {
    state.doneAtBoundary = done ? state.session : undefined;
    state.doneClose = keepClose ? { via: request ? 'cezar_done' : 'done-line', ...(request?.summary === undefined ? {} : { summary: request.summary }) } : undefined;
  }

  /** Goal achieved (agent contract, #347): the summary `cezar_done` gave as a note, the closing
   *  event naming what declared it, every open wait cancelled (DONE ranks above every wait), and
   *  the session closes instead of parking, so the run completes and frees its slot. */
  private closeAsDone(runId: string, state: ActiveRun, session: AgentSession | undefined): void {
    const close = state.doneClose;
    // A workflow step that is not the last completes, and the next step starts (hearsay-tools/cezarion#1620).
    const step = !!session && state.nextStep?.session === session;
    state.completedStepId = state.currentStepId;
    if (close?.summary) this.store.appendEvent(runId, { type: 'note', message: close.summary });
    this.store.appendEvent(runId, { type: 'lifecycle', message: step ? 'step complete — session closed' : 'goal achieved — session closed', via: close?.via ?? 'done-line' });
    this.cancelOpenWaits(runId);
    session?.end();
  }

  async stopPreviewServer(runId: string, request: PreviewStopRequest, signal?: AbortSignal): Promise<PreviewStopResult> {
    return stopPreviewServer(this.store, this.preview, this.cezarPort, () => this.disposed, runId, request, signal);
  }
  async registerPreviewServer(runId: string, request: PreviewServeRequest, signal?: AbortSignal): Promise<PreviewServeResult> {
    return registerPreviewServer(this.store, this.preview, this.cezarPort, () => this.disposed, runId, request, signal);
  }

  /** The checks every wait registration shares: the session that called is the run's current one,
   *  and no root finish blocks it. Refusals throw `{ code }`. */
  private registrationGate(runId: string, generation: string, capabilitySignal?: AbortSignal) {
    const state = this.active.get(runId);
    const refuse = (code: WaitErrorCode | AskErrorCode): never => {
      // Fixed codes only: no tool arguments, credentials or provider diagnostics.
      console.warn(`[cez] wait registration refused: ${code}`);
      throw Object.assign(new Error(code === 'autonomous_run' ? askErrorMessage(code) : waitErrorMessage(code)), { code });
    };
    const assertCanRegister = () => {
      const refused = toolSessionRefusal(this.store.getRun(runId), state, this.active.get(runId), generation, capabilitySignal, this.disposed);
      const run = this.store.getRun(runId);
      if (refused || !run || !state) return refuse(refused ?? 'run_missing');
      if (this.workerExecutionStopped(runId)) refuse('worker_execution_stopped');
      if (this.executionBlockedByRootFinish(run)) refuse('root_finish_pending');
      return { state, run };
    };
    return { refuse, assertCanRegister };
  }

  /**
   * `cezar_ask` (hearsay-tools/cezarion#1234): open the run's human wait with its card. A run holds
   * one: a registration in the turn that opened it replaces its card and keeps its id, and one after
   * the user saw it returns it unchanged. An autonomous run assumes and continues instead, until
   * its automatic wakes are spent.
   */
  async registerAsk(runId: string, request: CezarAskRequest, generation: string, capabilitySignal?: AbortSignal): Promise<HumanWaitEntry> {
    const card = askCardFields(cezarAskRequestSchema.parse(request));
    const { refuse, assertCanRegister } = this.registrationGate(runId, generation, capabilitySignal);
    const { state: active, run } = assertCanRegister();
    const turnId = active.ciTurnId ??= randomUUID();
    if (active.autonomous && this.automaticWakes(runId) < MAX_AUTO_CONTINUES) refuse('autonomous_run');
    const open = openWaits(run).find((wait): wait is HumanWaitEntry => wait.kind === 'human' && wait.source !== 'cezar');
    if (open?.askSeq !== undefined) return open;
    if (!open && openWaits(run).length >= WAIT_LIMIT) refuse('capacity');
    const base: HumanWaitEntry = open ?? { id: randomUUID(), kind: 'human', source: 'agent', via: 'cezar_ask', registeredAt: new Date().toISOString(), phase: 'open', turnId };
    const { context: _replaced, ...kept } = base;
    return this.openWait(runId, active, { ...kept, ...card });
  }

  /**
   * Open a CI or timer wait (hearsay-tools/cezarion#1233). Trusted capability callbacks supply run
   * identity; the model supplies only the PR and deadline, or the seconds and note. Refusals throw
   * `{ code }`. An identical registration (same PR; or same seconds and note in the same turn)
   * returns the open wait it repeats.
   */
  async registerWait(runId: string, request: CezarWaitRequestInput, via: WaitVia, generation: string, capabilitySignal?: AbortSignal): Promise<PrWaitEntry | TimerWaitEntry | WorkerWaitEntry | ProcessWaitEntry | PeerWaitEntry> {
    const parsed = cezarWaitRequestSchema.parse(request);
    const { refuse, assertCanRegister } = this.registrationGate(runId, generation, capabilitySignal);
    const { state: active, run } = assertCanRegister();
    // hearsay-tools/cezarion#1235, hearsay-tools/cezarion#1995: as `cez worker wait` and `cez message wait`, under the
    // tool's own codes. It answers its own repeat, so it is checked before the capacity below.
    if (isDelegationWait(parsed)) {
      if (!run.delegation || run.delegation.role === 'invalid') refuse('denied_scope');
      try {
        return parsed.kind === 'peer' ? this.registerPeerWait(runId, { peerIds: parsed.peer_ids, timeoutSeconds: parsed.timeout_seconds }, 'cezar_wait')
          : this.registerWorkerListWait(runId, workerListTarget(parsed), 'cezar_wait');
      } catch (error) { return refuse(delegationWaitRefusal(error, () => this.executionBlockedByRootFinish(run))); }
    }
    const turnId = active.ciTurnId ??= randomUUID();
    if (parsed.kind === 'process') return this.registerProcessWait(runId, active, run, parsed, via, turnId);
    const existing = identicalWait(run.waits ?? [], parsed, turnId);
    if (existing) return existing;
    // Counted as the store counts them, so a registration accepted here is never refused there.
    if (openWaits(run).length >= WAIT_LIMIT) refuse('capacity');
    if (parsed.kind === 'timer') {
      if (this.semaphore.monitoringWakeIntervalMinutes() === null) refuse('timers_disabled');
      if (this.automaticWakes(runId) >= MAX_AUTO_CONTINUES) refuse('wake_budget_spent');
      const now = Date.now();
      const wait: TimerWaitEntry = { id: randomUUID(), kind: 'timer', source: 'agent', via, registeredAt: new Date(now).toISOString(),
        deadline: new Date(now + parsed.seconds * 1000).toISOString(), phase: 'open', turnId, seconds: parsed.seconds,
        ...(parsed.note === undefined ? {} : { note: parsed.note }) };
      return this.openWait(runId, active, wait);
    }
    const key = `${runId}\n${normalizePrUrl(parsed.pr)}\n${parsed.until}\n${parsed.wake_on_conflict}`;
    const pending = this.ciRegistrations.get(key);
    if (pending) return pending.promise;
    const abort = new AbortController();
    const signal = capabilitySignal ? AbortSignal.any([abort.signal, capabilitySignal]) : abort.signal;
    const promise = (async () => {
      const assertLookupCurrent = () => {
        assertCanRegister();
        if (signal.aborted) refuse('registration_aborted');
        if (active.ciTurnId !== turnId) refuse('turn_changed');
      };
      const identity = await this.ciSupervisor.resolve(parsed.pr, signal).catch(error => {
        assertLookupCurrent();
        throw error;
      });
      assertLookupCurrent();
      // The same PR may have registered while this lookup was in flight under another spelling.
      const repeated = identicalWait(this.store.getRun(runId)?.waits ?? [], parsed, turnId);
      if (repeated && repeated.kind !== 'process') return repeated;
      if (openWaits(this.store.getRun(runId) ?? {}).length >= WAIT_LIMIT) refuse('capacity');
      const now = Date.now();
      const wait: PrWaitEntry = { ...identity, id: randomUUID(), kind: 'pr', source: 'agent', via, generation, turnId,
        timeoutSeconds: parsed.timeout_seconds, until: parsed.until, wakeOnConflict: parsed.wake_on_conflict, registeredAt: new Date(now).toISOString(),
        deadline: new Date(now + parsed.timeout_seconds * 1000).toISOString(), phase: 'open' };
      return this.openWait(runId, active, wait);
    })();
    this.ciRegistrations.set(key, { runId, abort, promise });
    try { return await promise; }
    finally { if (this.ciRegistrations.get(key)?.abort === abort) this.ciRegistrations.delete(key); }
  }

  /**
   * A process wait (hearsay-tools/cezarion#1446, spec § Process wait decisions). Cezar refuses only
   * what it cannot watch to an end: another user's PID, its own, and an agent session's leader;
   * the agent's shell can already observe any process of its own, so there is no ownership proof.
   * A PID already gone is no error: the command was fast, and the wait resolves at once from its
   * exit file, or as exited.
   */
  private registerProcessWait(runId: string, active: ActiveRun, run: RunRecord, request: Extract<CezarWaitRequest, { kind: 'process' }>, via: WaitVia, turnId: string): ProcessWaitEntry {
    const refuse = (code: WaitErrorCode): never => { throw Object.assign(new Error(waitErrorMessage(code)), { code }); };
    if (this.semaphore.monitoringWakeIntervalMinutes() === null) refuse('timers_disabled');
    if (this.automaticWakes(runId) >= MAX_AUTO_CONTINUES) refuse('wake_budget_spent');
    const roots = this.exitFileRoots(runId, run);
    let exitFile: string | undefined;
    if (request.exit_file !== undefined) {
      const confined = confineExitFile(request.exit_file, roots);
      if (!confined.ok) return refuse('exit_file_outside');
      exitFile = confined.path;
    }
    if (request.pid === process.pid || isSessionLeader(request.pid)) refuse('process_not_allowed');
    try { process.kill(request.pid, 0); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EPERM') refuse('process_not_owned'); }
    const live = recordedProcessLive({ pid: request.pid });
    const startToken = live ? processStartToken(request.pid) : undefined;
    const existing = identicalWait(run.waits ?? [], request, turnId, { ...(startToken === undefined ? {} : { startToken }), ...(exitFile === undefined ? {} : { exitFile }) });
    if (existing?.kind === 'process') return existing;
    if (openWaits(run).length >= WAIT_LIMIT) refuse('capacity');
    const now = Date.now();
    const wait: ProcessWaitEntry = { id: randomUUID(), kind: 'process', source: 'agent', via, registeredAt: new Date(now).toISOString(),
      deadline: new Date(now + request.timeout_seconds * 1000).toISOString(), phase: 'open', turnId, timeoutSeconds: request.timeout_seconds,
      pid: request.pid, ...(startToken === undefined ? {} : { startToken }), ...(exitFile === undefined ? {} : { exitFile }),
      ...(request.note === undefined ? {} : { note: request.note }) };
    const opened = this.openWait(runId, active, wait);
    if (!live) {
      this.disarmWait(wait.id);
      this.settleWait(runId, wait.id, probeProcessWait({ pid: wait.pid, deadline: wait.deadline, roots, ...(exitFile === undefined ? {} : { exitFile }) }, now));
    }
    return opened;
  }

  /** Where a process wait's exit file may sit: the run's worktree (the checkout for a run without
   *  one) and, unless turned off, the Cezar temp directory its agent gets as `TMPDIR`. */
  private exitFileRoots(runId: string, run = this.store.getRun(runId)): ExitFileRoots {
    return { worktree: run?.worktreePath ?? this.repoRoot, ...(agentTmpDirEnabled() ? { tmpDir: resolveAgentTmpDir(this.dataDir, runId) } : {}) };
  }

  /** Commit, arm and (at a boundary) park on a newly registered wait. */
  private openWait<W extends Wait>(runId: string, state: ActiveRun, wait: W): W {
    this.withdrawCezarHumanWaits(runId);
    try { this.store.commitWait(runId, wait); }
    catch { throw Object.assign(new Error(waitErrorMessage('persistence')), { code: 'persistence' }); }
    this.armWait(runId, wait);
    if (state.atTurnBoundary === state.session || this.waiting.has(runId)) this.parkOnWaits(runId, state);
    // The store keeps the entry it was given; only its phase can have moved since.
    return (this.store.getRun(runId)?.waits?.find(entry => entry.id === wait.id) as W | undefined) ?? wait;
  }

  /**
   * The agent's `cezar_cancel_wait`. An open wait is cancelled with its watch or timer, and no
   * result for it is ever delivered. A resolved wait is already owed: cancelling it is a no-op and
   * its result arrives with the next wake. A settled or unknown id is `not_found`. A human wait the
   * user already sees is theirs to answer (`human_question`); one from this turn can be withdrawn.
   */
  cancelWait(runId: string, waitId: string, generation: string): { cancelled: true } | { cancelled: false; code: 'not_found' | 'already_resolved' | 'human_question' } {
    const state = this.active.get(runId);
    if (this.disposed || !state || state.ciGeneration !== generation) {
      throw Object.assign(new Error(waitErrorMessage('generation_mismatch')), { code: 'generation_mismatch' });
    }
    const wait = this.store.getRun(runId)?.waits?.find(entry => entry.id === waitId);
    if (!wait) return { cancelled: false, code: 'not_found' };
    if (wait.phase !== 'open') return { cancelled: false, code: 'already_resolved' };
    if (wait.kind === 'human' && wait.askSeq !== undefined) return { cancelled: false, code: 'human_question' };
    this.store.commitOutcome(runId, { kind: 'cancelled', waitIds: [waitId] });
    this.disarmWait(waitId);
    return { cancelled: true };
  }

  /** Start what resolves an open wait: its CI watch, or its timer from the stored deadline. An
   *  overdue timer (restart) resolves at once. */
  private armWait(runId: string, wait: Wait): void {
    if (this.disposed || wait.phase !== 'open') return;
    if (wait.kind === 'pr') { this.startCiWatch(runId, wait); return; }
    if (wait.kind === 'process') { this.startProcessWatch(runId, wait); return; }
    // Only the user's answer, or a cancel, ends a human wait: nothing to arm.
    if (wait.kind === 'human') return;
    if (this.waitTimers.has(wait.id)) return;
    if (wait.kind === 'worker') { this.armWorkerDeadline(runId, wait); return; }
    // A peer that already wrote or settled resolves it first, at registration and recovery alike.
    if (wait.kind === 'peer' && this.resolvePeerWait(runId, wait)) return;
    // A stopping, stopped or finishing run takes no self-generated wake: the timer stays open
    // for that transition to cancel, as the monitoring timer did before it was a wait.
    const fire = () => {
      const run = this.store.getRun(runId);
      if (!this.canProceedWithRun(runId, run)) return;
      this.settleWait(runId, wait.id);
    };
    const due = Date.parse(wait.deadline) - Date.now();
    if (due <= 0) { fire(); return; }
    const timer = setTimeout(() => {
      if (this.waitTimers.get(wait.id)?.timer !== timer) return;
      this.waitTimers.delete(wait.id);
      fire();
    }, due);
    timer.unref?.();
    this.waitTimers.set(wait.id, { runId, timer });
  }

  /**
   * A worker wait's deadline re-observes its family (hearsay-tools/cezarion#1235): the reconcile
   * resolves it with `timeout`, keeping any outcome observed by then. A failed checkpoint is
   * retried every second while the wait is still open, never dropped as an uncaught error. An
   * outcome whose resolution failed to commit arms the same retry with `firstDelay` 1 second.
   */
  private armWorkerDeadline(runId: string, wait: WorkerWaitEntry, firstDelay?: number): void {
    // A deadline-less (Cezar completion) wait ends only when its workers settle (hearsay-tools/cezarion#1301).
    if (firstDelay === undefined && wait.deadline === undefined) return;
    const run = this.store.getRun(runId);
    if (!run) return;
    const family = familyOf(run);
    let warned = false;
    const arm = (delay: number) => {
      const timer = setTimeout(() => {
        if (this.waitTimers.get(wait.id)?.timer !== timer) return;
        this.waitTimers.delete(wait.id);
        try { this.reconcileWorkerWaits(family); }
        catch {
          if (!warned) console.warn('[cez] worker wait checkpoint failed; retrying in 1 second');
          warned = true;
          if (!this.disposed && this.store.getRun(runId)?.waits?.some(entry => entry.id === wait.id && entry.phase === 'open')) arm(1_000);
        }
      }, delay);
      timer.unref?.();
      this.waitTimers.set(wait.id, { runId, timer });
    };
    arm(Math.max(0, firstDelay ?? Date.parse(wait.deadline!) - Date.now()));
  }

  /** Stop everything that could still resolve this wait. */
  private disarmWait(waitId: string): void {
    this.ciWatches.get(waitId)?.abort.abort(); this.ciWatches.delete(waitId);
    const timer = this.waitTimers.get(waitId); if (timer) clearTimeout(timer.timer); this.waitTimers.delete(waitId);
    const retry = this.ciRetries.get(waitId); if (retry) clearTimeout(retry.timer); this.ciRetries.delete(waitId);
    this.workerResolveRetries.delete(waitId);
    this.processWatches.get(waitId)?.abort.abort(); this.processWatches.delete(waitId);
  }

  /**
   * Watch a process wait's command (hearsay-tools/cezarion#1446). Like a timer, its wake is the
   * agent's own arrangement: a stopping, stopped or finishing run takes none, and the wait stays
   * open for that transition to cancel.
   */
  private startProcessWatch(runId: string, wait: ProcessWaitEntry): void {
    if (this.disposed || this.processWatches.has(wait.id) || wait.phase !== 'open') return;
    const abort = new AbortController();
    const watch = { runId, abort };
    this.processWatches.set(wait.id, watch);
    const settle = (result: ProcessWaitResult) => {
      if (this.disposed || abort.signal.aborted || this.processWatches.get(wait.id) !== watch) return;
      this.processWatches.delete(wait.id);
      const run = this.store.getRun(runId);
      if (!this.canProceedWithRun(runId, run)) return;
      this.settleWait(runId, wait.id, result);
    };
    const request = { pid: wait.pid, deadline: wait.deadline, roots: this.exitFileRoots(runId),
      ...(wait.startToken === undefined ? {} : { startToken: wait.startToken }), ...(wait.exitFile === undefined ? {} : { exitFile: wait.exitFile }) };
    void this.processSupervisor.watch(request, abort.signal).then(settle, (error: unknown) => settle({ outcome: 'error', observedAt: new Date().toISOString(),
      diagnostic: (error instanceof Error ? error.message : String(error)).slice(0, 512) }));
  }

  private startCiWatch(runId: string, wait: PrWaitEntry): void {
    if (this.disposed || this.ciWatches.has(wait.id) || wait.phase !== 'open') return;
    const abort = new AbortController();
    const watch = { runId, abort };
    this.ciWatches.set(wait.id, watch);
    const current = () => !this.disposed && !abort.signal.aborted && this.ciWatches.get(wait.id) === watch;
    const settle = (result: CiWaitResult) => {
      if (!current()) return;
      const parsed = ciWaitResultSchema.safeParse(result);
      const validated: CiWaitResult = parsed.success ? parsed.data : { outcome: 'error', headSha: wait.headSha,
        observedAt: new Date().toISOString(), checks: [], totalChecks: 0, truncated: false,
        diagnostic: 'CI watcher returned an invalid observation; inspect the PR and register a new wait.' };
      this.ciWatches.delete(wait.id);
      this.settleWait(runId, wait.id, validated);
    };
    void this.ciSupervisor.watch(ciWatchRequest(wait), abort.signal).then(settle, () => settle({ outcome: 'error', headSha: wait.headSha,
      observedAt: new Date().toISOString(), checks: [], totalChecks: 0, truncated: false,
      diagnostic: 'CI watcher unavailable; inspect the pull request and retry the wait.' }));
  }

  /** `resolveWait`, retried while its durable checkpoint is unavailable: a failed write may not
   *  drop the accepted intent or publish a false result. */
  private settleWait(runId: string, waitId: string, result?: CiWaitResult | ProcessWaitResult | PeerWaitResult): void {
    if (this.disposed) return;
    try { this.resolveWait(runId, waitId, result); }
    catch {
      if (this.ciRetries.has(waitId)) return;
      console.warn('[cez] wait checkpoint unavailable; retaining result for retry.');
      const timer = setTimeout(() => { this.ciRetries.delete(waitId); this.settleWait(runId, waitId, result); }, 1000);
      timer.unref(); this.ciRetries.set(waitId, { runId, timer });
    }
  }

  /** Commit an open wait as resolved together with its lifecycle input (id = wait id, or an
   *  upgraded worker wait's `wakeInputId`), then queue the run's wake. A worker wait passes the
   *  entry as reconciled, with its outcomes and `result`. Throws when the checkpoint fails; a wait
   *  no longer open is ignored. */
  private resolveWait(runId: string, waitId: string, result?: CiWaitResult | ProcessWaitResult | PeerWaitResult, observed?: WorkerWaitEntry): void {
    const latest = this.store.getRun(runId)?.waits?.find(wait => wait.id === waitId);
    if (!latest || latest.phase !== 'open') return;
    const state = this.active.get(runId);
    // The count includes a timer batch still awaiting its acknowledgement.
    if (chargesBudget(latest) && this.automaticWakes(runId) >= MAX_AUTO_CONTINUES) {
      this.cancelAutomaticAtCap(runId, [latest]);
      if (state) this.reparkWithoutWaits(runId, state);
      else this.waitOnUserWithoutSession(runId);
      return;
    }
    const resolvedAt = new Date().toISOString();
    const settled: Wait = latest.kind === 'pr'
      ? { ...latest, phase: 'resolved', resolvedAt, result: (result as CiWaitResult | undefined) ?? { outcome: 'deadline', headSha: latest.headSha, observedAt: resolvedAt, checks: [], totalChecks: 0, truncated: false } }
      : latest.kind === 'process'
        ? { ...latest, phase: 'resolved', resolvedAt, result: (result as ProcessWaitResult | undefined) ?? { outcome: 'deadline', observedAt: resolvedAt } }
      : latest.kind === 'worker'
        ? { ...observed ?? latest, phase: 'resolved', resolvedAt, result: observed?.result ?? { reason: 'timeout' } }
      : latest.kind === 'peer'
        ? { ...latest, phase: 'resolved', resolvedAt, result: (result as PeerWaitResult | undefined) ?? { reason: 'timeout' } }
        : { ...latest, phase: 'resolved', resolvedAt };
    const input: AgentInput = { id: waitInputId(settled), parentRunId: runId, source: 'lifecycle', createdAt: resolvedAt,
      text: waitResultText(settled, { tools: !state?.toolless, workerStatus: this.workerStatus }) };
    this.store.commitWait(runId, settled, input);
    try { this.queueWaitWake(runId); }
    catch { this.retryWaitAdmission(runId); }
  }

  /** A worker's current status, as a worker wait's result names it. */
  private readonly workerStatus = (workerId: string): string => this.store.getRun(workerId)?.status ?? 'unavailable';

  /** A timer, process or peer wait due, or still owed, once the automatic-wake budget is spent
   *  wakes nothing: it is cancelled with the cap note, and the run keeps whatever else it waits on
   *  (hearsay-tools/cezarion#1233, hearsay-tools/cezarion#1446, hearsay-tools/cezarion#1995). */
  private cancelAutomaticAtCap(runId: string, waits: readonly Wait[]): void {
    if (!waits.length) return;
    this.store.commitOutcome(runId, { kind: 'cancelled', waitIds: waits.map(wait => wait.id) });
    for (const wait of waits) {
      this.disarmWait(wait.id);
      this.store.appendEvent(runId, { type: 'note', message: wait.kind === 'process' || wait.kind === 'peer'
        ? `automatic ${wait.kind} wake-up cap reached (${MAX_AUTO_CONTINUES}); ${wait.kind} wait ${wait.id} cancelled`
        : `automatic ${isMonitoringTimer(wait) ? 'monitoring' : 'timer'} wake-up cap reached (${MAX_AUTO_CONTINUES}); timer ${wait.id} cancelled` });
    }
  }

  /** A parked run whose last wait was cancelled at the budget without a wake waits on the user: a
   *  `budget` human wait opens and is shown (hearsay-tools/cezarion#1234), and the run leaves the
   *  monitoring pool and its slot, as `parkForUser` does. A turn in progress is left to its own
   *  turn end. */
  private reparkWithoutWaits(runId: string, state: ActiveRun): void {
    const run = this.store.getRun(runId);
    if (!run || run.status !== 'waiting' || !this.waiting.has(runId) || state.atTurnBoundary !== state.session || run.waits?.length) return;
    this.surfaceHumanWait(runId, state, this.openHumanAlias(runId, state, 'budget'));
    this.leaveMonitoringPool(runId);
    this.armIdleTimer(runId, state);
  }

  /** The same for a parked run with no live session, as when recovery fires an overdue timer
   *  before any session exists: once no wait is left, the `budget` human wait opens and is shown,
   *  and the user's Continue answers it. */
  private waitOnUserWithoutSession(runId: string): void {
    const run = this.store.getRun(runId);
    if (!run || run.status !== 'waiting' || this.active.has(runId) || run.waits?.length) return;
    this.surfaceHumanWait(runId, undefined, this.openHumanAlias(runId, undefined, 'budget'));
    this.leaveMonitoringPool(runId);
  }

  /**
   * A session failed, or closed cleanly, while the run still owed wait results
   * (hearsay-tools/cezarion#1233). Count the failed delivery and decide what the closing path does:
   * `park` keeps the run waiting and retries after the backoff (or, with nothing resolved, leaves
   * its open waits to wake it); `settle` fails the run the ordinary way, which a usage limit takes
   * into its own hold and resume without being counted; `capped` fails it at
   * `MAX_WAKE_DELIVERY_ATTEMPTS`. Every settled run keeps its results.
   */
  private failedWakeDelivery(runId: string, error: string): 'park' | 'settle' | 'capped' {
    if (!this.owesDelivery(runId)) return 'park';
    if (parseUsageLimit(error)) return 'settle';
    const failures = (this.store.getRun(runId)?.waitDeliveryFailures ?? 0) + 1;
    if (failures >= MAX_WAKE_DELIVERY_ATTEMPTS) {
      // Nothing may wake the settled run: its admission retry goes with the count.
      this.resetWakeDelivery(runId);
      const retry = this.wakeRetries.get(runId); if (retry) clearTimeout(retry); this.wakeRetries.delete(runId);
      return 'capped';
    }
    this.store.commitOutcome(runId, { kind: 'counted', waitDeliveryFailures: failures }, {}, { bestEffort: true });
    const previous = this.wakeBackoffs.get(runId); if (previous) clearTimeout(previous);
    const timer = setTimeout(() => {
      if (this.wakeBackoffs.get(runId) !== timer) return;
      this.wakeBackoffs.delete(runId);
      try { this.queueWaitWake(runId); } catch { this.retryWaitAdmission(runId); }
    }, retryDelayMs(failures - 1, this.wakeRetryBackoff, noJitter));
    timer.unref(); this.wakeBackoffs.set(runId, timer);
    return 'park';
  }

  private owesDelivery(runId: string): boolean {
    return wakeLedger.owesDelivery(this.store, runId, run => this.owesWake(run));
  }

  /** Apply the pure closing-wake decision without moving delivery counters or timers. */
  private closingWakeDecision(runId: string, holdsClosingWakes: boolean, cancelled: boolean, undelivered: string | undefined): 'park' | 'settle' | 'capped' {
    const decision = stepDecisions.closingWakeDecision(holdsClosingWakes, cancelled, undelivered);
    return decision.kind === 'failed-delivery' ? this.failedWakeDelivery(runId, decision.error) : decision.kind;
  }

  /** A delivery, a human or a terminal path ends a run of failed deliveries and its backoff. */
  private resetWakeDelivery(runId: string): void {
    this.clearWakeDeliveryFailures(runId);
    this.clearWakeBackoff(runId);
  }

  private clearWakeBackoff(runId: string): void {
    const timer = this.wakeBackoffs.get(runId); if (timer) clearTimeout(timer); this.wakeBackoffs.delete(runId);
  }

  /** Saves an accepted continuation. A human Continue also answers every human wait, ends failed
   *  deliveries and restarts the budget, in the same best-effort commit. */
  private commitContinuation(runId: string, human: boolean): void {
    const outcomes: RunOutcome[] = [{ kind: 'answered' }, { kind: 'counted', waitDeliveryFailures: undefined },
      ...(this.store.getRun(runId)?.automaticWakes ? [{ kind: 'charged' as const, automaticWakes: 0 }] : [])];
    if (!human || !this.store.commitOutcome(runId, outcomes, {}, { bestEffort: true }).committed) this.store.flush();
  }

  /** An acknowledged wake turn runs: a retry stops unless a wake is still `owed`. Pool membership
   *  changes only at a turn end or a terminal path; a worker park's idle timer belongs to the park,
   *  not to the wake turn. */
  private spendWakeAdmission(runId: string, state: ActiveRun, owed: boolean): void {
    if (!owed) { const retry = this.wakeRetries.get(runId); if (retry) clearTimeout(retry); this.wakeRetries.delete(runId); }
    this.waiting.delete(runId); this.clearIdleTimer(state);
    this.move(runId, 'resume');
  }

  private withFailuresCleared(runId: string, outcomes: RunOutcome[], ids: readonly string[], cleared = false): RunOutcome[] {
    return wakeLedger.withFailuresCleared(this.store, runId, outcomes, ids, cleared);
  }

  /** The failure count is on the run record, so a restart keeps it (hearsay-tools/cezarion#1234). */
  private clearWakeDeliveryFailures(runId: string): void {
    this.store.commitOutcome(runId, { kind: 'counted', waitDeliveryFailures: undefined }, {}, { bestEffort: true });
  }

  private automaticWakes(runId: string, beforeHumanReset?: HumanAnswerBudget): number {
    return wakeLedger.automaticWakes(this.store, this.active, runId, beforeHumanReset);
  }

  /** Spend one automatic wake on the record; returns the count after it. */
  private chargeAutomaticWake(runId: string): number {
    const next = (this.store.getRun(runId)?.automaticWakes ?? 0) + 1;
    // Best-effort: a refused write never stops the nudge or the cleanup that charges it.
    this.store.commitOutcome(runId, { kind: 'charged', automaticWakes: next }, {}, { bestEffort: true });
    return next;
  }

  private retryWaitAdmission(runId: string): void {
    const run = this.store.getRun(runId);
    if (this.disposed || this.wakeRetries.has(runId) || !run || !this.owesWake(run)) return;
    const timer = setTimeout(() => {
      this.wakeRetries.delete(runId);
      try { this.queueWaitWake(runId); } catch { this.retryWaitAdmission(runId); }
    }, 1000);
    timer.unref(); this.wakeRetries.set(runId, timer);
  }

  /**
   * Park a session on its waits (hearsay-tools/cezarion#1233): `waiting`. A CI or
   * timer park keeps its slot in the monitoring pool, so its wake starts at once, and needs no idle
   * timer; a resolved wait with nothing left open is a wake due now and keeps it too. Worker waits
   * rank above CI and timers (hearsay-tools/cezarion#1235): a park on them holds no slot and arms
   * the idle timer, so the session closes after `IDLE_TIMEOUT_MS` and the run stays `waiting` for
   * the next resolution or message to reopen it. Its intent reaches disk before the slot is freed.
   * An open human wait is shown and parks for the user, with no slot (hearsay-tools/cezarion#1234).
   */
  private parkOnWaits(runId: string, state: ActiveRun): boolean {
    const run = this.store.getRun(runId);
    if (!run?.waits?.length || !state.session?.open || state.cancelled || state.pendingHumanAsk) return false;
    const human = openWaits(run).find((wait): wait is HumanWaitEntry => wait.kind === 'human');
    if (human) {
      this.surfaceHumanWait(runId, state, human);
      this.parkForUser(runId, state, state.currentStepId);
      return true;
    }
    this.clearIdleTimer(state);
    const top = computeWaitingOn(run)?.kind;
    const keepsSlot = top === 'pr' || top === 'process' || top === 'timer' || (top === undefined && resolvedWaits(run).length > 0);
    // A park that frees its slot publishes the intent first: a refused write throws and keeps it.
    if (keepsSlot) {
      this.move(runId, 'park');
      if (state.currentStepId) this.store.updateStep(runId, state.currentStepId, { status: 'waiting' });
    } else transitionVia('park', () => this.store.getRun(runId), () => this.store.commitParked(runId, state.currentStepId));
    this.waiting.add(runId);
    if (keepsSlot) this.monitoring.add(runId); else this.leaveMonitoringPool(runId);
    if (top === 'workers' || top === 'peers') this.armIdleTimer(runId, state);
    this.queueWaitWake(runId);
    this.releaseSlot();
    return true;
  }

  /** Parked with `workers` or `peers` as its top wait (hearsay-tools/cezarion#1235, hearsay-tools/cezarion#1995): the
   *  park holds no slot, so runner activity resumes it as it resumes a monitoring park. */
  private parkedOnWorkers(runId: string): boolean {
    const run = this.store.getRun(runId);
    return run?.status === 'waiting' && ['workers', 'peers'].includes(computeWaitingOn(run)?.kind ?? '');
  }

  /** Leave the monitoring pool. Only a turn end or a terminal path does; a member's slot
   *  goes back to the workspace. */
  private leaveMonitoringPool(runId: string): void {
    if (this.monitoring.delete(runId)) this.releaseSlot();
  }

  /**
   * Queue one wake for every resolved wait of a run and every message it has not received
   * (`owesWake`). A live session takes it only at a turn boundary: a turn in progress, a native
   * question included, picks it up at its own turn end. A monitoring-pool member already holds its
   * slot and is admitted at once; any other live session waits for scheduler admission; a run with
   * no session reopens through a scheduler-owned continuation. A pending question does not hold the
   * wake back: the wake turn delivers the results and the messages beside it, and the question
   * stays answerable (hearsay-tools/cezarion#1235).
   */
  private queueWaitWake(runId: string): void {
    const run = this.store.getRun(runId);
    const resolved = run ? resolvedWaits(run) : [];
    if (!this.canQueueWaitWake(runId, run)) return;
    const state = this.active.get(runId);
    this.restoreWorkerWaitInputs(runId);
    if (state && (!state.session?.open || !this.takesWake(runId, state))) return;
    // Settlement ends the watcher. Keep a bounded-rate wake source until ACK,
    // cancellation or termination, including refusals with no runner-ready callback.
    this.retryWaitAdmission(runId);
    if (this.waitWakeAdmitted.has(runId)) { this.deliverAdmittedWake(runId); return; }
    // A pool member's wake is admitted at once, unless its account is on a usage-limit hold: then
    // it waits in the line, keeping its monitoring slot, until the hold lifts (hearsay-tools/cezarion#1236).
    if (state && this.monitoring.has(runId) && !this.wakeHeld(run)) {
      if (this.waitWakeQueuedAt.delete(runId)) { const at = this.queue.indexOf(runId); if (at >= 0) this.queue.splice(at, 1); }
      this.waitWakeAdmitted.add(runId);
      this.deliverAdmittedWake(runId);
      return;
    }
    if (this.waitWakeQueuedAt.has(runId)) { this.releaseSlot(); return; }
    if (state) {
      this.waitWakeQueuedAt.set(runId, Date.now());
      if (!this.queue.includes(runId)) this.queue.push(runId);
    } else if (!this.isActive(runId)) {
      if (!this.queueSessionlessWaitWake(runId, resolved)) return;
    }
    this.releaseSlot();
  }

  /** Reject only the same durable and manager-level holds before restoring wake inputs. */
  private canQueueWaitWake(runId: string, run: RunRecord | undefined): run is RunRecord {
    // A run on a usage-limit hold is woken by its resume only, which delivers what resolved
    // meanwhile (hearsay-tools/cezarion#1236).
    if (this.disposed || this.recoveringRun(run) || !run || isUsageLimitHold(run) || !this.owesWake(run) ||
      !['running', 'waiting', 'queued'].includes(run.status) || !this.canProceedWithRun(runId, run)) return false;
    // A failed delivery waits out its backoff; the backoff's own timer queues this wake again.
    if (this.wakeBackoffs.has(runId)) return false;
    return true;
  }

  private queueSessionlessWaitWake(runId: string, resolved: ReturnType<typeof resolvedWaits>): boolean {
    // No live session: create a scheduler-owned continuation, never a direct provider call.
    this.move(runId, 'park-for-wake');
    const text = sessionlessWakePrompt(resolved);
    const resumed = this.continueRun(runId, { text, waitWake: true }, true);
    if (!resumed.ok) {
      const message = `${resolved.length ? 'Wait result' : 'Messages'} retained; continuation unavailable: ${resumed.error ?? 'unknown'}`;
      if (this.retainedNotes.get(runId) !== message) {
        this.retainedNotes.set(runId, message);
        this.store.appendEvent(runId, { type: 'note', message });
      }
      return false;
    }
    this.retainedNotes.delete(runId);
    this.waitWakeQueuedAt.set(runId, Date.now());
    return true;
  }

  /** Is this run's account on a usage-limit hold that keeps its wake in the line? */
  private wakeHeld(run: RunRecord): boolean {
    const holds = this.semaphore.accountHolds();
    if (!holds.deadline.size && !holds.inFlight.size) return false;
    return accountHeldFor(this.withExecutionAccount(run), holds, run.runner ?? 'claude');
  }

  /** The run with the account its next turn runs on (`executionAccount`): a live session's step
   *  settings, a queued continuation's account, else its latest session step. Both sides of a hold
   *  read it, so a mixed-runner step is held by the account it ran on (hearsay-tools/cezarion#1236). */
  private withExecutionAccount<T extends RunRecord>(run: T): T {
    const live = this.active.get(run.id)?.delegationSettings;
    return { ...run, ...executionAccount(run, this.pendingContinuations.get(run.id), live) };
  }

  /** A monitoring-pool member's wake waiting in the line: it already holds its slot, so it needs
   *  no regular one to leave (hearsay-tools/cezarion#1236). */
  private poolWakeQueued(runId: string): boolean {
    return this.monitoring.has(runId) && this.waitWakeQueuedAt.has(runId) && this.active.has(runId);
  }

  /** A worker wait the store upgraded from the old engine as already settled may have had no wake input
   *  queued yet (hearsay-tools/cezarion#1235): the old engine wrote it on its next pass, so its
   *  result is written here, once, before the wake that delivers it. A full inbox waits. */
  private restoreWorkerWaitInputs(runId: string): void {
    const run = this.store.getRun(runId);
    for (const wait of resolvedWaits(run ?? {})) {
      if (!run || wait.kind !== 'worker' || run.agentInputs?.some(input => input.id === waitInputId(wait))) continue;
      if ((this.store.getRun(runId)?.agentInputs ?? []).filter(input => !input.deliveredAt).length >= 32) return;
      this.store.commitWait(runId, wait, { id: waitInputId(wait), parentRunId: runId, source: 'lifecycle', createdAt: wait.resolvedAt ?? new Date().toISOString(),
        text: waitResultText(wait, { tools: !this.active.get(runId)?.toolless, workerStatus: this.workerStatus }) });
    }
  }

  private pendingConversationWakes(run: RunRecord, beforeHumanReset?: HumanAnswerBudget): AgentInput[] {
    return wakeLedger.pendingConversationWakes(run, { routedAnswer: id => this.routedAnswer(id), countAutomaticWakes: (id, budget) => this.automaticWakes(id, budget), providerOwnsInboxInput: (id, inputId) => this.providerOwnsInboxInput(id, inputId) }, MAX_AUTO_CONTINUES, beforeHumanReset);
  }

  /** Peer messages the spent budget keeps from waking the run (spec § 8). A turn in progress takes
   *  them as steering, which charges nothing. A parked run waits on the user instead: Cezar's
   *  `budget` human wait opens and is shown, and a human message resets the budget. */
  private holdPeerWakesAtCap(runId: string): void {
    const run = this.store.getRun(runId);
    if (!run || this.automaticWakes(runId) < MAX_AUTO_CONTINUES ||
      !run.agentInputs?.some(input => !input.deliveredAt && !hasLiveInboxClaim(input) && chargesBudgetMessage(input))) return;
    const state = this.active.get(runId);
    if (state?.session?.open && state.atTurnBoundary !== state.session) { if (!this.recoveringRun(runId)) this.flushAgentInputs(runId); return; }
    if (run.status === 'waiting') this.surfaceHumanWait(runId, state, this.openHumanAlias(runId, state, 'budget'));
  }

  /** The parent's reply that answers a worker's pending routed question, still undelivered. */
  private routedAnswer(runId: string): AgentInput | undefined {
    const routed = this.routedAsk(runId);
    return routed && this.store.getRun(runId)?.agentInputs?.find(input => !input.deliveredAt && answersQuestion(routed.message, input));
  }

  private owesWake(run: RunRecord, beforeHumanReset?: HumanAnswerBudget): boolean {
    return wakeLedger.owesWake(run, { routedAnswer: id => this.routedAnswer(id), pendingConversationWakes: (record, budget) => this.pendingConversationWakes(record, budget) }, beforeHumanReset);
  }

  private takesWake(runId: string, state: ActiveRun): boolean {
    return wakeLedger.takesWake(runId, state, id => this.routedAnswer(id));
  }

  /** An admitted wake goes to the agent: a parent's answer through the answer seam, everything
   *  else as one submission. */
  private deliverAdmittedWake(runId: string): void {
    const state = this.active.get(runId);
    const midTurn = !!state && state.atTurnBoundary !== state.session;
    if ((midTurn || !resolvedWaits(this.store.getRun(runId) ?? {}).length) && this.routedAnswer(runId)) this.answerRoutedQuestion(runId, true);
    else this.flushAgentInputs(runId);
  }

  /** An admitted or queued wake whose messages an inbox read took has nothing left to deliver: the
   *  run goes back to its park and gives up the slot the admission reserved. */
  private retireEmptyWake(runId: string): void {
    const run = this.store.getRun(runId);
    const state = this.active.get(runId);
    if (!run || this.owesWake(run) || state?.agentInputFlight) return;
    if (this.waitWakeQueuedAt.delete(runId)) { const at = this.queue.indexOf(runId); if (at >= 0) this.queue.splice(at, 1); }
    if (this.waitWakeAdmitted.delete(runId) && state && run.status === 'waiting' && state.atTurnBoundary === state.session) this.waiting.add(runId);
    const retry = this.wakeRetries.get(runId); if (retry) clearTimeout(retry); this.wakeRetries.delete(runId);
  }

  /**
   * Cancel every open or resolved wait of a run without waking the agent: stop, Finish, cancel,
   * deletion, DONE and any terminal status. Human input cancels none (hearsay-tools/cezarion#1233).
   * A failed commit leaves the record as a crash would and never stops the disarm, so Stop still
   * reaches the session when the store is closed or broken (hearsay-tools/cezarion#1234).
   */
  private cancelOpenWaits(runId: string): void {
    const before = this.store.getRun(runId)?.waits ?? [];
    const remaining = (this.store.getRun(runId)?.waits ?? []).map(wait => wait.id);
    try { if (remaining.length) this.store.commitOutcome(runId, { kind: 'cancelled', waitIds: remaining }); }
    catch (error) { console.warn(`[cez] wait cancellation failed: ${error instanceof Error ? error.message : String(error)}`); }
    for (const wait of before) this.disarmWait(wait.id);
    this.disarmRunWaits(runId);
  }

  /** Stop every watch, timer, retry and queued wake a run's waits hold in memory. */
  private disarmRunWaits(runId: string): void {
    for (const [key, registration] of this.ciRegistrations) {
      if (registration.runId !== runId) continue;
      registration.abort.abort(); this.ciRegistrations.delete(key);
    }
    for (const [id, watch] of this.ciWatches) if (watch.runId === runId) this.disarmWait(id);
    for (const [id, entry] of this.waitTimers) if (entry.runId === runId) this.disarmWait(id);
    for (const [id, retry] of this.ciRetries) if (retry.runId === runId) this.disarmWait(id);
    for (const [id, watch] of this.processWatches) if (watch.runId === runId) this.disarmWait(id);
    const timer = this.wakeRetries.get(runId); if (timer) clearTimeout(timer); this.wakeRetries.delete(runId);
    this.retainedNotes.delete(runId);
    this.resetWakeDelivery(runId);
    if (this.waitWakeQueuedAt.delete(runId) && this.active.has(runId)) {
      const index = this.queue.indexOf(runId); if (index >= 0) this.queue.splice(index, 1);
    }
    this.waitWakeAdmitted.delete(runId);
  }

  /** A deleted run's row is gone with its waits; only what they armed in memory is left. */
  private readonly onRunDeleted = (runId: string): void => {
    this.disarmRunWaits(runId);
    if (!this.disposed) this.resolvePeerWaits(runsAwaitingPeer(runId, () => this.store.listRuns()));
    // A peer's open requests to the deleted run settle `deleted` (spec 2026-10-27 § 5): each ledger
    // that holds one is reconciled, live or settled.
    if (this.disposed || process.env.CEZ_DELEGATION !== '1') return;
    try { for (const id of rootsAwaitingPeer(this.store, runId)) this.reconcileWorkerWaits(id); } catch { /* the next reconcile settles them */ }
  };

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
      this.pendingJobs.set(run.id, { workflow, input: effectiveInput });
      this.queue.push(run.id);
      void this.pump();
    }
    return run;
  }

  /** Accept only the store's already-durable owned creation, never caller-supplied paths/workflows. */
  enqueueOwnedRun(runId: string): void {
    const run = this.store.getRun(runId);
    if (!run) throw new DelegationPolicyError('incompatible_state', 'Owned queued run not found');
    const job = this.ownedJob(run);
    if (this.queue.includes(runId) || this.starting.has(runId) || this.active.has(runId)) return;
    this.pendingJobs.set(runId, job);
    this.queue.push(runId);
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

  /**
   * Slots this manager holds against the workspace-wide cap. `waiting` runs
   * don't hold a slot (#347): an idle claude process costs memory but no
   * tokens, queued work progressing matters more, and the idle timeout already
   * bounds how long a session can sit open. Because the exemption lives HERE —
   * in the count, not in any acquire path — a message into a `waiting` run
   * (sendMessage) resumes it immediately even when that momentarily exceeds
   * `maxParallel`, including when other projects saturate the cap.
   */
  private busySlots(): number {
    // A CI or timer park keeps its slot (hearsay-tools/cezarion#1233): up to
    // `maxMonitoringSessions` of them hold a monitoring slot instead of a regular one, and the
    // rest keep their regular slot. Every other park holds none: a park whose top wait is human
    // or workers (hearsay-tools/cezarion#1235) is in `waiting` and outside the pool.
    const parkedWithoutSlot = [...this.waiting].filter(id => !this.monitoring.has(id)).length;
    const pool = Math.min(this.monitoring.size, this.semaphore.maxMonitoringSessions());
    return this.active.size + this.starting.size - parkedWithoutSlot - pool;
  }

  /** Epoch ms of this manager's oldest queued run (the semaphore's fairness
   *  key when a freed slot is broadcast), or null when nothing is queued.
   *  `queue` is FIFO — `startRun` pushes and `recover()` re-queues by
   *  `createdAt` — so the head is the oldest. */
  private oldestQueuedAt(): number | null {
    const head = this.queue[0];
    if (!head) return null;
    const wakeQueuedAt = this.wakeJoinedAt(head);
    if (wakeQueuedAt !== undefined) return wakeQueuedAt;
    const createdAt = this.store.getRun(head)?.createdAt;
    const ms = createdAt ? Date.parse(createdAt) : Number.NaN;
    return Number.isNaN(ms) ? null : ms;
  }

  /** When a queued entry joined the line as a wake of a run already in progress, or undefined for
   *  a run that has not started (hearsay-tools/cezarion#1236, `nextLineEntry`). */
  private wakeJoinedAt(runId: string): number | undefined {
    const wake = this.waitWakeQueuedAt.get(runId) ?? this.pendingContinuations.get(runId)?.lineJoinedAt;
    if (wake !== undefined || !this.pendingJobs.has(runId)) return wake;
    // An owned worker is its family's work in progress, not a new task: it joins the wakes at its
    // creation, so its parent's later wake (a worker wait that timed out, say) does not take the
    // slot before the worker it waits on has run.
    const run = this.store.getRun(runId);
    if (run?.delegation?.role !== 'worker') return undefined;
    const created = Date.parse(run.createdAt);
    return Number.isFinite(created) ? created : undefined;
  }

  /** The oldest wake in this manager's line that an account hold does not keep there, or null:
   *  the semaphore gives a freed slot to the project holding the oldest such wake before any
   *  project's unstarted runs. A held wake is left out, or its project would take the slot and
   *  start a new task ahead of another project's started run (hearsay-tools/cezarion#1236). */
  private oldestWakeAt(): number | null {
    let oldest: number | null = null;
    let holds: AccountHolds | undefined;
    for (const id of this.queue) {
      const at = this.wakeJoinedAt(id);
      if (at === undefined || (oldest !== null && at >= oldest)) continue;
      holds ??= this.semaphore.accountHolds();
      // The same blockers `pump()` applies, capacity aside: a wake that cannot leave for any of
      // them must not win the slot for its project's unstarted work. A runnerless record runs on
      // the configured default, which only `pump()` reads (async); until it has, such a wake is
      // not advertised while anything is held.
      const runnerless = holds.deadline.size + holds.inFlight.size > 0 && this.store.getRun(id)?.runner === undefined;
      if (runnerless && this.configuredDefaultRunner === undefined) continue;
      if (!this.canLeaveLine(id, holds, this.configuredDefaultRunner ?? 'claude')) continue;
      oldest = at;
    }
    return oldest;
  }

  /** Can this queued entry leave the line now, capacity aside? No worktree cleanup, no
   *  autosave cleanup, no pending root finish, no account hold, and not already admitted
   *  elsewhere. `pump()` and `oldestWakeAt()` share it, so the workspace order and the project
   *  order agree (hearsay-tools/cezarion#1236). */
  private canLeaveLine(id: string, holds: AccountHolds, fallbackRunner: RunnerId): boolean {
    if (this.claims.has(id) || this.autosaveCleanupBlocker(id)) return false;
    const queued = this.store.getRun(id);
    if (!queued || this.historyDeletionPending(id)) return true;
    if (this.executions.get(id)?.admitted && !this.active.has(id)) return false;
    if (this.executionBlockedByRootFinish(queued)) return false;
    return !accountHeldFor(this.withExecutionAccount(queued), holds, fallbackRunner);
  }

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

  /**
   * Start queued runs while parallel slots are free. A run starts only under
   * BOTH ceilings: the WORKSPACE `resources.maxParallel` (default 2, counted
   * across every manager — spec 2026-07-20, step 2.5) AND this project's own
   * per-project `maxParallel` when the registry sets one (spec 2026-07-22,
   * inherits the workspace cap when unset). Legacy per-repo `maxParallel` keys
   * are ignored. A non-git directory degrades to 1 sequential run in the repo
   * root (spec 006 degradation rule), which is always the tighter bound.
   */
  private async pump(): Promise<void> {
    // Any recovery, scoped or not: each ends with a pump of its own, so nothing waits for long.
    if (this.disposed || this.recovering) return;
    this.reconcileAutoResumes();
    // A pump requested while one is in flight can't just be dropped: the
    // in-flight pass may already have read capacity (it awaits `getRepoInfo`
    // before the first check), so a slot freed in that window would be lost
    // until the next unrelated event. Re-run the sweep instead.
    if (this.pumping) {
      this.pumpAgain = true;
      return;
    }
    this.pumping = true;
    try {
      do {
        this.pumpAgain = false;
        const repo = await (this.pumpRepoInfo ??= getRepoInfo(this.repoRoot));
        const maxParallel = this.semaphore.maxParallel();
        // Per-project ceiling (spec 2026-07-22-per-project-concurrency): this
        // project never runs more than its own configured `maxParallel`; absent
        // an override it equals the workspace cap, so behavior is unchanged.
        const projectMax = this.semaphore.projectMaxParallel(this.repoRoot);
        // `waiting` runs don't hold a slot (#347) — see busySlots(). The check
        // below is the only slot gate: resumes never pass through it. A run
        // starts only under BOTH the workspace cap and this project's ceiling.
        const capacity = () =>
          this.semaphore.busy() < maxParallel &&
          this.busySlots() < projectMax &&
          (repo !== null || this.busySlots() < 1);
        // The usage-limit hold (spec 2026-08-03-auto-resume-after-usage-limit).
        //
        // A limit closes an ACCOUNT, not a run — so starting the next queued task walks it into
        // the same wall. Measured before this gate existed: eight tasks under `maxParallel: 2`
        // all failed within 517 ms, each spawning a CLI (and, outside worktree-opt-out mode, a
        // worktree and a branch) only to be marked `scheduled`. The cap was respected at every
        // instant and was no brake at all, because a doomed run lives ~200 ms.
        //
        // So: while any run on an account is waiting out a limit, nothing new starts on THAT
        // account. Other accounts (a second login, a different backend) keep running — the hold
        // is keyed, not global. The set is derived from the durable records rather than tracked
        // separately, which is what makes it survive a restart, expire on its own, and lift the
        // instant a user cancels a resume.
        // The watchdog's one-shot override — read and cleared here, so a forced sweep never
        // leaks into the next ordinary one.
        const forced = this.forceNextPump;
        this.forceNextPump = false;
        const holds = this.queue.length > 0 && !forced ? this.semaphore.accountHolds() : NO_HOLDS;
        const anyHold = holds.deadline.size > 0 || holds.inFlight.size > 0;
        // Only pay for the config read when something is actually held: a queued record may name
        // no runner, and then the account it would use is the configured default.
        const defaultRunner = anyHold ? (await loadConfig(this.repoRoot)).defaultRunner : undefined;
        if (defaultRunner !== undefined) this.configuredDefaultRunner = defaultRunner;
        while (this.queue.length > 0) {
          // Recovery may have begun while this pump awaited repository/config discovery.
          if (this.disposed || this.recovering) return;
          // Wakes first, then unstarted runs, each FIFO among the entries that CAN start
          // (hearsay-tools/cezarion#1236); a held one keeps its place in the queue rather than
          // being dequeued and re-queued (which would churn its position and its record).
          const next = nextLineEntry(this.queue, (id) => this.wakeJoinedAt(id),
            (id) => (capacity() || this.poolWakeQueued(id)) && this.canLeaveLine(id, anyHold ? holds : NO_HOLDS, defaultRunner ?? 'claude'));
          if (next === -1) break; // every queued run has a durable reason to remain held
          const candidate = this.queue[next]!;
          if (this.workerExecutionStopped(candidate)) { this.cancel(candidate); continue; }
          if (!this.checkpointQueuedWorker(candidate, next)) continue;
          const runId = this.queue.splice(next, 1)[0];
          if (!runId) break;
          const wake = this.admitQueuedWaitWake(runId);
          if (wake === 'deferred') break;
          if (wake === 'handled') continue;
          this.launchQueuedRun(runId, forced);
        }
      } while (this.pumpAgain);
    } finally {
      this.pumping = false;
    }
  }

  /** Checkpoint before dequeue, while worker cancellation can still find the queued entry. */
  private checkpointQueuedWorker(candidate: string, next: number): boolean {
    if (!this.active.has(candidate) && (this.pendingJobs.has(candidate) || this.pendingContinuations.has(candidate))) {
      try { this.beginWorkerExecution(candidate); }
      catch (error) {
        this.queue.splice(next, 1); this.pendingJobs.delete(candidate); this.pendingContinuations.delete(candidate);
        this.move(candidate, 'fail-start', { error: admissionError(error, 'worker execution checkpoint unavailable'), finishedAt: new Date().toISOString() });
        return false;
      }
    }
    return true;
  }

  /** A lost runner boundary requeues the wake and ends this pass instead of spinning. */
  private admitQueuedWaitWake(runId: string): 'none' | 'handled' | 'deferred' {
    if (this.waitWakeQueuedAt.has(runId) && this.active.has(runId)) {
      this.waitWakeQueuedAt.delete(runId);
      const state = this.active.get(runId)!;
      const queued = this.store.getRun(runId);
      const owed = !!queued && this.owesWake(queued);
      if (owed && this.takesWake(runId, state)) {
        // The wake holds a regular slot from admission until its acknowledgement.
        this.waiting.delete(runId);
        this.waitWakeAdmitted.add(runId);
        this.deliverAdmittedWake(runId);
      } else if (owed) {
        // The runner may lose its boundary between queueing and admission.
        // Retain the wake, but do not spin on it in this pump pass.
        this.waitWakeQueuedAt.set(runId, Date.now());
        this.queue.push(runId);
        this.retryWaitAdmission(runId);
        return 'deferred';
      }
      return 'handled';
    }
    return 'none';
  }

  /** Read and hydrate mutable queued input in the same synchronous tick as dequeue. */
  private launchQueuedRun(runId: string, forced: boolean): void {
    if (this.waitWakeQueuedAt.delete(runId)) this.waitWakeAdmitted.add(runId);
    // A forced sweep has to reach the spawn: the gate inside `execute` asks the same
    // question and would send this run straight back to the queue.
    if (forced) this.forceStarted.add(runId);
    const job = this.pendingJobs.get(runId);
    const continuation = this.pendingContinuations.get(runId);
    this.pendingJobs.delete(runId);
    this.pendingContinuations.delete(runId);
    if (!job && !continuation) return;
    this.starting.add(runId);
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
      this.starting.delete(runId);
      this.dropActive(runId);
    }).finally(() => this.finishWorkerExecution(runId));
  }

  /** Save restart evidence before queue admission or the next startup await. */
  private checkpointRestartContext(run: RunRecord, queuedStepId?: string): RunRecord {
    const message = run.continuationMessage ?? (queuedStepId ? {
      ...this.toQueuedMessage(run.id, []), id: queuedStepId, text: 'Continue.', origin: 'lifecycle' as const,
    } : undefined);
    if (!message) return run;
    const updated = this.store.updateRun(run.id, { continuationMessage: {
      ...message,
      ...(message.origin === 'lifecycle' && message.text === RESTART_CONTINUATION_PROMPT ? { text: 'Continue.' } : {}),
      resumeContext: { ...message.resumeContext, restarted: true },
    } }) ?? run;
    this.store.flush();
    return updated;
  }

  /**
   * Rebuild executable state for a durable queued record. Shared by recovery and the watchdog;
   * reconstruct jobs or continuations before pumping.
   */
  private async reviveQueuedRun(run: RunRecord, reason: string): Promise<void> {
    if (this.isActive(run.id) || this.workerExecutionStopped(run.id)) return;
    const queuedContinuation = [...run.steps]
      .reverse()
      .find((step) => step.status === 'pending' && isSyntheticContinuation(run, step));
    const sessionStep = queuedContinuation
      ? [...run.steps].reverse().find((step) => step.id !== queuedContinuation.id && step.sessionId)
      : undefined;
    if (queuedContinuation && sessionStep?.sessionId) {
      this.reviveQueuedContinuation(run, reason, queuedContinuation.id, sessionStep);
      return;
    }
    if (run.delegation?.role === 'worker') {
      this.reviveQueuedWorker(run, reason);
      return;
    }
    const workflow = await this.reviveWorkflow(run);
    if (!workflow) {
      this.move(run.id, 'fail-start', {
        error: 'interrupted — workflow definition not recoverable after a restart',
        finishedAt: new Date().toISOString(),
      });
      this.store.appendEvent(run.id, {
        type: 'lifecycle',
        message: `${reason} — workflow definition not recoverable, task failed`,
      });
      return;
    }
    this.pendingJobs.set(run.id, {
      workflow,
      startAt: queuedStartAt(run, workflow),
      // Rehydrate again at dequeue so edits and stacked messages keep their admission-time reads.
      input: this.hydrateQueuedInput(run.id, queuedRecoveryInput(run)),
    });
    this.queue.push(run.id);
    this.store.appendEvent(run.id, { type: 'lifecycle', message: `${reason} — task re-queued` });
  }

  private reviveQueuedContinuation(run: RunRecord, reason: string, queuedStepId: string, sessionStep: RunRecord['steps'][number]): void {
    if (reason === 'cezar restarted') run = this.checkpointRestartContext(run, queuedStepId);
    const { backend, sessionBackend, sameAccount, recoveredSessionId } = this.queuedResumeSession(run, sessionStep);
    if (sessionStep.sessionTransport === 'cursor-print' && sessionBackend === backend && sameAccount && !recoveredSessionId) {
      const error = 'Cursor print session identity lacks a matching recorded session event';
      const finishedAt = new Date().toISOString();
      this.store.updateStep(run.id, queuedStepId, { status: 'failed', error, finishedAt });
      this.move(run.id, 'fail-start', { error, finishedAt, currentStepId: undefined });
      return;
    }
    this.pendingContinuations.set(run.id, {
      stepId: queuedStepId,
      sessionId: recoveredSessionId,
      backend,
      prompt: run.continuationMessage?.text ?? RESTART_CONTINUATION_PROMPT,
      images: [],
      lineJoinedAt: Date.now(),
    });
    this.queue.push(run.id);
    this.store.appendEvent(run.id, {
      type: 'lifecycle',
      message: `${reason} — interrupted continuation re-queued`,
    });
  }

  /** Match the pinned execution account before considering a persisted session resumable. */
  private queuedResumeSession(run: RunRecord, sessionStep: RunRecord['steps'][number]) {
    // An accepted worker's continuation extends the step owning the resumed session, so its
    // runner and account come from that step's pinned identity, never the run-level
    // first-step fields — those would re-queue a claude review's Continue as a codex turn with
    // no session to resume. Broken identity evidence is left for the launch to report.
    let resumeIdentity: WorkerStepIdentity | undefined;
    try { resumeIdentity = this.workerStep(run.id, continuationDefStep(this.store, run, sessionStep.sessionId)?.id); }
    catch (error) { if (!(error instanceof WorkerIdentityError)) throw error; }
    const backend = resumeIdentity?.account.provider ?? run.runner ?? 'claude';
    const sessionBackend = sessionStep.backend ?? backend;
    const sessionAccount = sessionStep.profileId ?? DEFAULT_AGENT_ACCOUNT_ID;
    const agentProfile = resumeIdentity?.account.profileId ?? run.agentProfile;
    const sameAccount = agentProfile === undefined || agentProfile === sessionAccount;
    const recoveredSessionId = sessionBackend === backend && sameAccount
      ? this.resumableSessionId(run.id, sessionStep) : undefined;
    return { backend, sessionBackend, sameAccount, recoveredSessionId };
  }

  private reviveQueuedWorker(run: RunRecord, reason: string): void {
    try {
      const job = this.ownedJob(run);
      // Use the privately bound workflow, and the same durable pending-step
      // cursor as root recovery. A queued tail must not replay a failed source.
      this.pendingJobs.set(run.id, { ...job, startAt: queuedStartAt(run, job.workflow) });
      this.queue.push(run.id);
      this.store.appendEvent(run.id, { type: 'lifecycle', message: `${reason} — owned task re-queued` });
    } catch (error) {
      this.move(run.id, 'fail-start', { error: String(error), finishedAt: new Date().toISOString() });
    }
  }

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
    this.recoveryFactsPending = true;
    await this.store.prepareRecoveryFacts(familyRootId);
    if (this.disposed) return;
    // Public terminal state can precede the private completion checkpoint. Such a family
    // has no live/deferred anchor, but orphan settlement still appends its lifecycle event.
    // Prepare only eligible starting generations' families before any repair mutation;
    // retain IDs, never an ownership or execution snapshot, across readiness.
    const { orphanWorkerIds, orphanFactIds } = this.collectOrphanWorkerGenerations(familyRootId, inScope);
    await this.store.prepareTranscriptFacts(orphanFactIds);
    if (this.disposed) return;
    this.recoveryFactsPending = false;
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
    if (familyRootId === undefined) await this.reconcileRecoveryWorkerFamilies();
    if (this.disposed) return;
    } finally {
      this.recoveryFactsPending = false;
      this.recoveryScope = undefined;
      this.recoveryInFlight = undefined;
      settled();
    }
    // Only a family with a live member has anyone left to route to or fall back from.
    this.recoverWorkerMessages(familyRootId === undefined ? this.liveFamilyMembers() : this.familyMembers(familyRootId), familyRootId);
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
    else for (const run of this.familyMembers(familyRootId)) this.workerScratchCleanup.schedule(run.id);
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

  /** True when the interrupted run has no session to continue and goes back to the queue. */
  private requeueInterruptedRun(run: RunRecord, interruptedStepId: RunRecord['currentStepId']): boolean {
    const interruptedIndex = run.workflowDef?.steps.findIndex(step => step.id === interruptedStepId) ?? -1;
    const interruptedDef = interruptedIndex >= 0 ? run.workflowDef?.steps[interruptedIndex] : undefined;
    // Worktree setup (#917) interrupted before any agent session: there is no session to
    // continue, so start the workflow over. `execute` sees setup still `running` and reruns it.
    if (run.workflowDef && run.worktreeSetup?.status === 'running' && !run.steps.some(step => step.sessionId)) {
      this.move(run.id, 'requeue', { error: undefined, finishedAt: undefined, currentStepId: undefined });
      this.store.flush();
      this.pendingJobs.set(run.id, { workflow: run.workflowDef, startAt: 0, input: queuedRecoveryInput(run) });
      this.queue.push(run.id);
      return true;
    }
    if (run.workflowDef && interruptedDef && stepKind(interruptedDef) === 'check') {
      this.store.updateStep(run.id, interruptedDef.id, { status: 'pending', error: undefined, finishedAt: undefined });
      this.move(run.id, 'requeue', { error: undefined, finishedAt: undefined, currentStepId: undefined });
      this.store.flush();
      this.pendingJobs.set(run.id, {
        workflow: run.workflowDef,
        startAt: interruptedIndex,
        input: queuedRecoveryInput(run),
      });
      this.queue.push(run.id);
      return true;
    }
    return false;
  }

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

  /** The persisted definition when it looks sane, else the catalog by name. */
  private async reviveWorkflow(run: RunRecord): Promise<WorkflowDef | null> {
    // "Looks sane" is the STORE's job now: it parses `workflowDef` against the definition schema
    // and `.catch`es a def that no longer fits to `undefined`, so anything present here already
    // has the `steps` array the old inline `Array.isArray` check was asking for.
    const def = run.workflowDef;
    if (def) return def;
    const { workflows } = await loadWorkflows(this.repoRoot);
    return workflows.find((w) => w.name === run.workflow) ?? null;
  }

  private isDisposedDelegatedRun(runId: string): boolean {
    const role = this.store.getRun(runId)?.delegation?.role;
    return this.disposed && (role === 'root' || role === 'worker' || !!this.store.getRun(runId)?.waits?.length);
  }

  /** Shutdown is not completion. Explicit terminal controls retain their precedence. */
  private preserveRunAfterDisposal(runId: string, state: ActiveRun): boolean {
    return this.isDisposedDelegatedRun(runId) && !state.cancelled && !state.finishRequested;
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

  /** A detail's finish verdict reads the live registries, and a session leaves them after its
   *  last write (the final autosave), so the cockpit's refetch on that write still saw "no open
   *  session" and hid Accept. Publish a resting run again once it is out of them
   *  (hearsay-tools/cezarion#1301). */
  private republishFinishVerdict(runId: string): void {
    if (this.disposed || this.isActive(runId)) return;
    const status = this.store.getRun(runId)?.status;
    if (status === 'waiting' || status === 'review') this.store.republish(runId);
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
    this.waiting.delete(runId);
    this.monitoring.delete(runId);
    this.waitWakeAdmitted.delete(runId);
    if (this.waitWakeQueuedAt.delete(runId)) {
      const index = this.queue.indexOf(runId); if (index >= 0) this.queue.splice(index, 1);
    }
    this.active.delete(runId);
    this.store.unpin(runId, 'active');
    // Open waits keep their watch or timer: their result reopens the run when it resolves. A
    // refusal queued for the closing session reopens it now (hearsay-tools/cezarion#1301).
    if (!this.disposed && (this.store.getRun(runId)?.waits?.length || this.owesCompletionRefusal(runId))) this.queueWaitWake(runId);
    if (!this.executions.has(runId) && this.store.getRun(runId)?.stopping) this.store.updateRun(runId, { stopping: undefined });
    this.republishFinishVerdict(runId);
    this.memoryPausing.delete(runId);
    this.turnBookkeeper.forget(runId);
    this.forceStarted.delete(runId);
    if (this.isDisposedDelegatedRun(runId)) return; // teardown above, no autonomous durable side effects
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
    this.scheduleAutoResumeIfLimited(runId);
    // Closed-session success may have parked a completion wait without a live wire. The global
    // pass covers the families still in memory (#779); this run's own family may have just left
    // the live set with it, so it is reconciled by name first.
    const settled = this.store.getRun(runId);
    if (settled?.delegation) {
      for (const id of settledRunFamilies(this.store, settled)) this.reconcileWorkerWaits(id);
      // Then every other family still in memory (hearsay-tools/cezarion#779).
      this.reconcileWorkerWaits();
    }
    this.releaseSlot();
    // A run leaving the active registry may have reached a terminal transition
    // (done/review/failed/cancelled), increasing the finished-worktree count.
    // Enforce count-based retention (#483) here so a single hook covers every
    // terminal path. Fire-and-forget: retention must never delay or throw into
    // the lifecycle.
    void this.enforceRetention();
    this.reapTerminalScratch(runId);
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
    if (this.active.has(runId) || this.starting.has(runId) || this.queue.includes(runId) || this.claims.has(runId) || !!this.autosaveCleanupBlocker(runId)) return;
    const privateWorkers = workerEvidenceRunIds(this.dataDir);
    if (run.delegation?.role === 'worker' || run.delegation?.role === 'invalid' || !privateWorkers || privateWorkers.includes(runId)) { this.workerScratchCleanup.schedule(runId); return; }
    removeAgentTmpDir(this.dataDir, runId);
  }

  // ---- usage-limit auto-resume (spec 2026-08-03-auto-resume-after-usage-limit) --------------

  /**
   * A run just failed: if the provider said "usage limit, back at T", promise to resume it at
   * `T + AUTO_RESUME_GRACE_MS` instead of leaving the task dead until someone notices.
   *
   * Every refusal below is silent-but-honest — the run stays `failed` with its Continue button,
   * which is exactly the pre-feature behavior — except the safety cap, which says so on the
   * transcript, because a run that stops resuming itself needs to explain why.
   */
  private scheduleAutoResumeIfLimited(runId: string): void {
    if (this.autoResumeTimers.has(runId)) return; // already promised
    const run = this.store.getRun(runId);
    if (!run || run.status !== 'failed') return;
    // Archiving IS resigning from a task. Reviving one because a window happened to reopen would
    // be the feature working against the clearest signal the user can give it.
    if (run.archived) return;
    const limit = parseUsageLimit(run.error);
    if (!limit) return;
    if (!this.semaphore.autoResumeOnUsageLimit()) return;
    // No session to resume = nothing this feature can do; `continueRun` would refuse anyway.
    if (!run.steps.some((step) => step.sessionId)) return;
    const attempts = run.autoResumeAttempts ?? 0;
    if (attempts >= MAX_AUTO_RESUMES) {
      this.store.appendEvent(runId, {
        type: 'note',
        message: `automatic resume cap reached (${MAX_AUTO_RESUMES}) — continue this task manually`,
      });
      return;
    }
    const wakeAt = new Date(limit.resetAt.getTime() + AUTO_RESUME_GRACE_MS);
    this.armAutoResume(runId, wakeAt.getTime());
    this.store.appendEvent(runId, {
      type: 'lifecycle',
      message: `usage limit reached — resuming automatically at ${formatWakeInstant(wakeAt)}`,
    });
  }

  /** Publish the deadline on the record (the cockpit's only source) and arm the timer for it. The
   *  run waits for it (hearsay-tools/cezarion#1236): `waiting`, its error kept for a withdrawal. */
  private armAutoResume(runId: string, deadline: number): void {
    this.move(runId, 'hold', { finishedAt: undefined, autoResumeAt: new Date(deadline).toISOString() });
    const timer = setTimeout(() => this.fireAutoResume(runId), Math.max(0, deadline - Date.now()));
    timer.unref?.();
    this.autoResumeTimers.set(runId, timer);
  }

  /**
   * The window has reopened. Re-check the record synchronously — hours may have passed, and the
   * user may have continued, deleted or cancelled the run in them — then hand the resume to the
   * ordinary queued-continuation path so it obeys both concurrency caps like any other work.
   */
  private fireAutoResume(runId: string): void {
    this.autoResumeTimers.delete(runId);
    const run = this.store.getRun(runId);
    if (!run || !isUsageLimitHold(run)) return;
    // Belt and braces against the one gap `reconcileAutoResumes` cannot close: the setting going
    // off in the window between the last pump and this tick.
    if (!this.semaphore.autoResumeOnUsageLimit()) {
      this.withdrawAutoResume(runId, 'automatic resume cancelled — auto-resume is switched off');
      return;
    }
    const attempts = (run.autoResumeAttempts ?? 0) + 1;
    // `continueRun` retires the pending resume (timer + record fields) on the way in — this is a
    // resume, not a user turn, so the counter is put back straight after.
    const resumed = this.continueRun(runId, { text: AUTO_RESUME_PROMPT }, true);
    if (!resumed.ok) {
      // Refusals happen before `continueRun` retires anything, so the deadline is still on the
      // record — and a deadline in the past is a promise the cockpit keeps displaying and the
      // engine will never keep. Retire it here instead, and say why.
      this.withdrawAutoResume(runId, `automatic resume could not start — ${resumed.error ?? 'unknown'}`);
      return;
    }
    this.store.updateRun(runId, { autoResumeAttempts: attempts });
    this.store.appendEvent(runId, {
      type: 'lifecycle',
      message: `usage limit reset — resuming automatically (${attempts}/${MAX_AUTO_RESUMES})`,
    });
    // A deferred continuation only ENQUEUES itself; the queue moves when something pumps it, and
    // `recover()` — the other deferring caller — pumps once after its whole bulk sweep. A timer
    // firing on its own has no such follow-up, so without this the resumed run sits at `queued`
    // until some unrelated run happens to finish. This is the pump for it.
    void this.pump();
  }

  /**
   * Reconcile process-local resume timers from durable records on pump and recovery. Retire
   * appointments when disabled or invalid; do not leave a deadline with no wake source.
   */
  private reconcileAutoResumes(): void {
    if (!this.semaphore.autoResumeOnUsageLimit()) {
      // Sweep the RECORDS, not the timer map. A record promising a resume that no timer is
      // holding is the exact population this method exists for, and it is also the one the
      // setting can be switched off in front of: cezar restarted while it was off, the config
      // was hand-edited, or the project context was disposed mid-wait. Retiring only the armed
      // timers leaves such a record with a live `autoResumeAt`, which `accountHolds()` reads as
      // a deadline hold — so nothing new starts on that account, `rescueStalledQueue` treats the
      // phantom appointment as a legitimate reason to sit still, and the cockpit shows a
      // `scheduled` row for a resume that will never come. `clearAutoResume` covers the armed
      // ones too, so this one loop is the whole cancellation. It reads any resume time, not
      // `isUsageLimitHold`, so a stale one is retired too.
      const pending = new Set([
        ...this.autoResumeTimers.keys(),
        ...this.store.listRuns().filter((run) => run.autoResumeAt !== undefined).map((run) => run.id),
      ]);
      for (const runId of pending) this.withdrawAutoResume(runId, 'automatic resume cancelled — auto-resume is switched off');
      return;
    }
    for (const run of this.store.listRuns()) {
      if (!isUsageLimitHold(run)) continue;
      if (this.autoResumeTimers.has(run.id)) continue;
      const deadline = Date.parse(run.autoResumeAt);
      // A deadline that is unreadable, belongs to a run that has spent its cap, or belongs to a
      // task the user has archived is retired rather than re-armed: it can only mislead. One
      // that has just passed arms at zero — the window is open, which is the point.
      if (
        run.archived
        || !Number.isFinite(deadline)
        || (run.autoResumeAttempts ?? 0) >= MAX_AUTO_RESUMES
      ) {
        this.withdrawAutoResume(run.id);
        continue;
      }
      // …and one missed by more than a day is retired loudly: reviving a task from another era
      // is a surprise, not a service, and this is what keeps a sweep from resurrecting every
      // limit-stopped task a user has long since walked away from.
      if (Date.now() - deadline > AUTO_RESUME_MISSED_WINDOW_MS) {
        this.withdrawAutoResume(run.id, 'automatic resume expired — its window reopened over a day ago; continue this task manually');
        continue;
      }
      this.armAutoResume(run.id, deadline);
    }
  }

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
    if (!finishHeld && (this.forceStarted.has(runId) ||
      !accountHeldFor({ ...run, runner }, this.semaphore.accountHolds(), runner))) return false;
    state?.releaseRepoRoot?.();
    if (state) { state.releaseRepoRoot = undefined; this.clearAutosaveTimer(state); }
    this.pendingJobs.set(runId, { workflow, input, startAt });
    this.queue.push(runId);
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

  /**
   * Repair queued records missing executable state. Rescue an idle queue only when no running work
   * or future appointment explains it; start through ordinary caps. Public for direct tests.
   */
  async rescueStalledQueue(now = Date.now()): Promise<void> {
    if (this.disposed) return;
    // First, the worst shape: a record that says `queued` while the engine holds no job, no
    // continuation and no queue entry for it. `pump()` cannot see such a run — it iterates the
    // queue, and this one is not in it — so nothing will ever start it. Re-adopt it through the
    // same path boot recovery uses.
    for (const run of this.store.listRuns()) {
      if (run.status !== 'queued' || this.recoveringRun(run)) continue;
      if (this.active.has(run.id) || this.starting.has(run.id)) continue;
      if (this.pendingJobs.has(run.id) || this.pendingContinuations.has(run.id)) continue;
      if (this.queue.includes(run.id)) continue;
      console.warn(`[cez] queue watchdog: re-adopting queued run ${run.id} the engine had lost`);
      await this.reviveQueuedRun(run, 'queue watchdog');
    }
    if (this.queue.length === 0) return;
    if (this.busySlots() > 0 || this.starting.size > 0) return;
    if (this.semaphore.busy() > 0) return;
    // A future deadline is a real reason to sit still: that timer will fire and pump.
    for (const run of this.store.listRuns()) {
      if (!isUsageLimitHold(run)) continue;
      const deadline = Date.parse(run.autoResumeAt);
      if (Number.isFinite(deadline) && deadline > now) return;
    }
    if (this.semaphore.accountHolds().inFlight.size === 0) {
      // Not the hold, then — some other wakeup went missing. An ordinary pump is the whole fix,
      // and it is idempotent, so this stays quiet.
      void this.pump();
      return;
    }
    console.warn(
      '[cez] queue watchdog: work is queued, nothing is running, and the usage-limit hold has no'
      + ' deadline behind it — starting the next task anyway',
    );
    this.forceNextPump = true;
    void this.pump();
  }

  /**
   * Derive this project’s future-deadline and in-flight account holds from records for the shared
   * semaphore. Past deadlines do not block the queue.
   */
  accountHolds(now = Date.now()): AccountHolds {
    const deadline = new Set<string>();
    const inFlight = new Set<string>();
    for (const run of this.store.listRuns()) {
      // A holding run always carries the runner it actually ran on, so the fallback is unused
      // here — it is spelled out rather than `!` so a future record shape degrades, not throws.
      const key = () => runAccountKey(this.withExecutionAccount(run), run.runner ?? 'claude');
      if (isUsageLimitHold(run)) {
        const at = Date.parse(run.autoResumeAt);
        if (Number.isFinite(at) && at > now) deadline.add(key());
      } else if (resumeInFlight(run)) {
        inFlight.add(key());
      }
    }
    return { deadline, inFlight };
  }

  /**
   * The PER-TASK off switch (`DELETE /api/v1/runs/:id/auto-resume`, and the archive route):
   * stop resuming THIS task, without touching the workspace setting or any other task.
   *
   * Idempotent — a run with nothing pending answers the same way, because "this task will not
   * resume itself" is equally true either way. Returns false only when the run does not exist,
   * which is the route's 404.
   */
  cancelAutoResume(runId: string): boolean {
    const run = this.store.getRun(runId);
    if (!run) return false;
    // Any resume time, not `isUsageLimitHold`: a withdrawal also retires one a record kept by mistake.
    const pending = run.autoResumeAt !== undefined || this.autoResumeTimers.has(runId);
    this.withdrawAutoResume(runId, pending ? 'automatic resume cancelled for this task' : undefined);
    if (pending) {
      // This run may have been the last thing holding its account's queue — nothing else will
      // notice, since the hold is derived and its release is not an event.
      void this.pump();
    }
    return true;
  }

  /** Retire a pending resume — timer, deadline and counter. The counter goes too because every
   *  caller is a fresh epoch: a human Continue, or a resume that re-stamps its own count. */
  private clearAutoResume(runId: string): void {
    const timer = this.autoResumeTimers.get(runId);
    if (timer) clearTimeout(timer);
    this.autoResumeTimers.delete(runId);
    const run = this.store.getRun(runId);
    if (!run) return;
    // A continuation's own status write retires the appointment of a run on hold
    // (hearsay-tools/cezarion#1236): clearing it first would show a waiting run with no
    // appointment, which reads as Needs you, for the moment between the two writes.
    if (isUsageLimitHold(run)) {
      if (run.autoResumeAttempts !== undefined) this.store.updateRun(runId, { autoResumeAttempts: undefined });
      return;
    }
    // Any resume time, not `isUsageLimitHold`: it retires a stale one too.
    if (run.autoResumeAt !== undefined || run.autoResumeAttempts !== undefined) {
      this.store.updateRun(runId, { autoResumeAt: undefined, autoResumeAttempts: undefined });
    }
  }

  /**
   * Withdraw a pending resume without continuing the run: a per-task cancel, the setting switched
   * off, a missed window, the cap, or a resume that could not start. A run on hold settles
   * `failed` with the error it kept, the state it was in before it waited (owner,
   * 2026-10-21). Its waits stay as a failed run's do: open ones armed, resolved ones owed to the
   * next Continue.
   */
  private withdrawAutoResume(runId: string, note?: string): void {
    // Committed first: a store that cannot write throws here with the timer still armed, and the
    // note is written only once the withdrawal is on disk (hearsay-tools/cezarion#1236).
    if (this.store.getRun(runId)) transitionVia('withdraw-hold', () => this.store.getRun(runId), () => this.store.commitAutoResumeWithdrawal(runId));
    const timer = this.autoResumeTimers.get(runId);
    if (timer) clearTimeout(timer);
    this.autoResumeTimers.delete(runId);
    if (note && this.store.getRun(runId)) this.store.appendEvent(runId, { type: 'note', message: note });
  }

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
    const queuedAt = this.queue.indexOf(runId);
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
      this.stoppedWorkers.add(runId);
      if (!this.executions.has(runId) && !this.active.has(runId) && !this.starting.has(runId) && proof?.phase === 'queued') {
        this.store.commitWorkerExecutionComplete(runId, proof.generation);
      }
    }
  }

  private cancelQueuedRun(runId: string, queuedAt: number): void {
    this.queue.splice(queuedAt, 1);
    this.pendingJobs.delete(runId);
    this.pendingContinuations.delete(runId);
    this.move(runId, 'cancel', { finishedAt: new Date().toISOString() });
    this.store.appendEvent(runId, { type: 'lifecycle', message: 'cancelled while queued' });
    this.store.flush();
    if (this.executions.get(runId)?.admitted === false) void this.finishWorkerExecution(runId);
  }

  private cancelRunWithoutSession(runId: string, hadWaits: boolean, retiredRefusal: boolean, cancelledFinish: boolean): boolean {
    if (this.starting.has(runId)) {
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
    return this.executions.has(runId) || this.active.has(runId) || this.starting.has(runId) || this.queue.includes(runId);
  }

  claimWorktreeReclaim(runId: string): (() => void) | null { return this.claims.claimWorktreeReclaim(runId); }
  private holdForMaintenance(runIds: readonly string[]): (() => void) | null { return this.claims.holdForMaintenance(runIds); }
  claimForPublish(runId: string): (() => void) | null { return this.claims.claimForPublish(runId); }
  claimForBranchCleanup(runIds: readonly string[]): (() => void) | null { return this.claims.claimForBranchCleanup(runIds); }

  /**
   * Fold the persisted task and queued message stack immediately before execution. Keep durable
   * record state authoritative over pendingJobs. Read-only: never write the composite back to
   * RunRecord.task; task and stack stay separate.
   */
  private hydrateQueuedInput(runId: string, input: StartRunInput): StartRunInput {
    const run = this.store.getRun(runId);
    if (!run) return input;
    const stack = run.queuedMessages ?? [];

    const task = [run.task, ...stack.map((m) => m.text)]
      .map((part) => part.trim())
      .filter((part) => part.length > 0)
      .join('\n\n');

    // Keep the original in-memory blocks for a live process (including the
    // best-effort case where persistence failed). Recovery has no such copy,
    // so rebuild it from the durable task-image URLs.
    const images = input.images?.length
      ? input.images
      : this.readPersistedAttachments(runId, run.taskImages ?? [], 'task').blocks;
    const stackedImages = this.readPersistedAttachments(
      runId,
      stack.flatMap((m) => m.images ?? []),
      'queued',
    ).blocks;

    return {
      ...input,
      task,
      ...(images.length ? { images } : { images: undefined }),
      ...(stackedImages.length ? { stackedImages } : { stackedImages: undefined }),
    };
  }

  /** Apply edits and messages made while a restart continuation waits for
   * capacity. The durable record remains the source of truth, just as it is for
   * an ordinary queued workflow (#472), so a second restart reconstructs and
   * hydrates the same amendments instead of dropping them. */
  private hydrateQueuedContinuation(
    runId: string,
    continuation: PendingContinuation,
  ): PendingContinuation & {
    persistedImages: ContentBlock[];
    persistedAttachments: PersistedAttachment[];
  } {
    const run = this.store.getRun(runId);
    if (!run) {
      return { ...continuation, persistedImages: [], persistedAttachments: [] };
    }
    const stack = run.queuedMessages ?? [];
    const amendedTask = [run.task, ...stack.map((message) => message.text)]
      .map((part) => part.trim())
      .filter((part) => part.length > 0)
      .join('\n\n');
    const openingPrompt = run.continuationMessage?.text ?? continuation.prompt;
    const prompt = amendedTask
      ? `${openingPrompt}\n\nCurrent task and queued updates:\n\n${amendedTask}`
      : openingPrompt;
    const persisted = this.readPersistedAttachments(
      runId,
      stack.flatMap((message) => message.images ?? []),
      'queued',
    );
    return {
      ...continuation,
      prompt,
      persistedImages: persisted.blocks,
      persistedAttachments: persisted.attachments,
    };
  }

  /**
   * Re-read persisted attachments at dequeue/restart (#472): an image comes back as a viewable
   * block AND a path, a file (#950) as a path only. The branch is on the NAME's extension, never
   * on which list the URL came from — images and files share one list, and re-encoding a `.pdf`
   * into a base64 image block is a message no backend can accept.
   *
   * A file is still `stat`-checked here rather than trusted: an attachment the user deleted must
   * drop out of the paths handed to the agent, exactly as a missing image does.
   */
  private readPersistedAttachments(
    runId: string,
    urls: string[],
    kind: 'task' | 'queued' | 'continuation',
  ): PersistedAttachments {
    const blocks: ContentBlock[] = [];
    const attachments: PersistedAttachment[] = [];
    for (const url of urls) {
      const name = url.split('/').pop();
      if (!name || name.includes('..') || name.includes('/') || name.includes('\\')) continue;
      const path = resolveAttachmentPath(this.dataDir, runId, name);
      try {
        if (!path) throw new Error('missing or unsafe attachment');
        if (isImageAttachmentName(name)) {
          const data = readFileSync(path);
          blocks.push({
            type: 'image',
            source: { type: 'base64', media_type: mediaTypeFor(name), data: data.toString('base64') },
          });
        } else if (!existsSync(path)) {
          throw new Error('missing');
        }
        attachments.push({ name, url, path });
      } catch {
        // Degrade, never fail the boot (AGENTS.md): the user deleted `.ai/cezar/`
        // or the file is unreadable — start with the text and say which attachment went.
        this.store.appendEvent(runId, {
          type: 'note',
          message: `${kind} attachment ${name} could not be read — starting without it`,
        });
      }
    }
    return { blocks, attachments };
  }

  /**
   * Still waiting for a slot? Checked against the engine's own queue rather than
   * the record's `status` (#472): the record is written by `execute()` a tick
   * after `pump()` dequeues, so a status read can see `queued` for a run that has
   * already started. The pending maps are deleted synchronously at dequeue, so
   * they are the authoritative answer for "can this prompt still be amended".
   */
  private isQueued(runId: string): boolean {
    return this.pendingJobs.has(runId) || this.pendingContinuations.has(runId);
  }

  /** Split a pasted message into the persisted shape a stacked message holds. */
  private toQueuedMessage(runId: string, content: PastedContent[]): QueuedMessage {
    const text = content
      .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
      .map((b) => b.text)
      .join('\n');
    const images = this.persistPastedAttachments(runId, content).map((saved) => saved.url);
    return {
      id: randomUUID(),
      text: text.trim() || images.length || !content.some((block) => block.type !== 'text')
        ? text
        : 'The user attached a file, but it could not be saved. Ask them to attach it again before discussing its contents.',
      ...(images.length ? { images } : {}),
      createdAt: new Date().toISOString(),
    };
  }

  /**
   * Append a prompt message onto a still-queued run (#472). Returns the stored
   * entry, or null when the run has already started — the caller then falls
   * through to `deferMessage`.
   */
  enqueueMessage(runId: string, content: PastedContent[]): QueuedMessage | null {
    if (!this.isQueued(runId)) return null;
    const run = this.store.getRun(runId);
    if (!this.canProceedWithRun(runId, run)) return null;
    const message = this.toQueuedMessage(runId, content);
    // Human input cancels no wait in the list (hearsay-tools/cezarion#1233, #1235): beside a wait
    // the message is accepted durably and opens the wake's continuation.
    if (run.waits?.length) this.store.commitHumanMessageBesideWaits(runId, message);
    else this.store.updateRun(runId, { queuedMessages: [...(run.queuedMessages ?? []), message] });
    return message;
  }

  /** Edit a stacked message in place. Omitted fields retain their current value. */
  editQueuedMessage(
    runId: string,
    msgId: string,
    edit: { text?: string; images?: PastedContent[] },
  ): QueuedMessage | null {
    if (!this.isQueued(runId)) return null;
    const run = this.store.getRun(runId);
    const stack = run?.queuedMessages;
    if (!stack) return null;
    const at = stack.findIndex((m) => m.id === msgId);
    if (at < 0) return null;
    const current = stack[at]!;
    const uploaded = edit.images === undefined ? undefined : this.toQueuedMessage(runId, edit.images);
    const replacementImages = uploaded ? uploaded.images : current.images;
    const replacementText = edit.text ?? current.text;
    const replacement: QueuedMessage = {
      id: msgId,
      text: replacementText.trim() ? replacementText : uploaded?.text || replacementText,
      ...(replacementImages?.length ? { images: replacementImages } : {}),
      createdAt: current.createdAt,
    };
    const next = [...stack];
    next[at] = replacement;
    this.store.updateRun(runId, { queuedMessages: next });
    // Images the edit dropped are now orphans.
    this.dropOrphanImages(runId, stack[at]!.images ?? [], next);
    return replacement;
  }

  /** Remove a stacked message and its now-orphaned attachments. */
  removeQueuedMessage(runId: string, msgId: string): boolean {
    if (!this.isQueued(runId)) return false;
    const run = this.store.getRun(runId);
    const stack = run?.queuedMessages;
    if (!stack) return false;
    const target = stack.find((m) => m.id === msgId);
    if (!target) return false;
    const next = stack.filter((m) => m.id !== msgId);
    this.store.updateRun(runId, { queuedMessages: next });
    this.dropOrphanImages(runId, target.images ?? [], next);
    return true;
  }

  /**
   * Delete image files no longer referenced by anything (#472). Best effort — a
   * leftover file is harmless and goes with the run. Never touches a URL still
   * referenced by another stacked entry or by the initial prompt's `taskImages`.
   */
  private dropOrphanImages(runId: string, candidates: string[], stack: QueuedMessage[]): void {
    if (!candidates.length) return;
    const run = this.store.getRun(runId);
    const referenced = new Set([
      ...(run?.taskImages ?? []),
      ...stack.flatMap((m) => m.images ?? []),
    ]);
    for (const url of candidates) {
      if (referenced.has(url)) continue;
      const name = url.split('/').pop();
      // Defend the join against a crafted URL: only a bare file name may be deleted.
      if (!name || name.includes('..') || name.includes('/') || name.includes('\\')) continue;
      try {
        rmSync(join(this.dataDir, 'runs', `${runId}-images`, name), { force: true });
      } catch {
        /* best effort */
      }
    }
  }

  /**
   * Edit the initial prompt of a still-queued run (#472). Re-derives the
   * heuristic title and the PR/issue chips, but never re-runs the LLM namer —
   * it already fired at creation and a second model call per edit is unjustified.
   */
  editTask(runId: string, task: string): boolean {
    if (!this.isQueued(runId)) return false;
    const run = this.store.getRun(runId);
    if (!run) return false;
    const workflow = this.pendingJobs.get(runId)?.workflow;
    const skillHint = workflow?.steps.find((s) => stepKind(s) === 'agent' && s.skill)?.skill?.trim();
    const refs = refineTaskRefs(extractTaskRefs(task), skillHint);
    // Hand-edited titles always win (#389): `user` beats the heuristic, and a
    // `marker` title the agent declared beats it too.
    const keepTitle = run.titleOrigin === 'user' || run.titleOrigin === 'marker';
    this.store.updateRun(runId, {
      task,
      ...(keepTitle || !workflow ? {} : { title: makeRunTitle(task, workflow) }),
      ...(refs.prNumber !== undefined ? { prNumber: refs.prNumber } : {}),
      ...(refs.issueNumber !== undefined ? { issueNumber: refs.issueNumber } : {}),
    });
    return true;
  }

  /**
   * Buffer a message that arrived in the gap between dequeue and session-open
   * (#472). `pump()` has already folded the stack and `execute()` is spawning the
   * backend, so there is nothing left to amend and no session to deliver into —
   * without this rung the message would 409, a genuinely dropped message in the
   * feature built to stop dropping them. Flushed as an ordinary follow-up turn
   * the instant the session opens; dropped if the run never starts, which the
   * existing error path already surfaces.
   *
   * The buffer lives on the manager rather than the `ActiveRun` because the
   * `ActiveRun` does not exist yet for part of this window.
   */
  deferMessage(runId: string, content: PastedContent[]): boolean {
    const run = this.store.getRun(runId);
    if (!this.canProceedWithRun(runId, run)) return false;
    // The window spans two sub-states: `starting` (no `ActiveRun` yet) and the
    // longer stretch where the `ActiveRun` exists but the backend is still being
    // spawned. `execute()` deletes the run from `starting` as soon as it builds
    // the state — seconds before the session opens — so checking `starting`
    // alone would reopen exactly the drop this rung exists to close.
    const state = this.active.get(runId);
    const startingUp = this.starting.has(runId) || (state !== undefined && !state.sessionEverOpened && !state.cancelled);
    if (!startingUp) return false;
    // The pending maps were removed only AFTER hydration. This entry therefore
    // needs live delivery, never a second fold into the already-created opening.
    // Beside a wait in the list it is accepted durably, and every wait stays
    // (hearsay-tools/cezarion#1235), so a crash before delivery replays it.
    const message = run.waits?.length ? this.toQueuedMessage(runId, content) : undefined;
    if (message) this.store.commitHumanMessageBesideWaits(runId, message);
    const pending = this.deferredMessages.get(runId) ?? [];
    pending.push({ content, ...(message ? { messageId: message.id } : {}) });
    this.deferredMessages.set(runId, pending);
    return true;
  }

  private parentCompletionBlockers(runId: string) {
    const parent = this.store.getRun(runId);
    if (parent?.delegation?.role !== 'root') return [];
    const ids = new Set([...parent.delegation.receipts.map(receipt => receipt.workerId),
      ...this.store.listWorkersOf(runId).map(run => run.id)]);
    const workers = parentReadiness(parent, [...ids].map(workerId => ({ workerId, run: this.store.getRun(workerId),
      terminated: this.store.readWorkerExecution(workerId)?.phase === 'complete', result: this.store.getRun(workerId)
        ? this.store.readWorkerResult(runId, workerId) : this.store.readDeletedWorkerResult(runId, workerId),
    })));
    return [...workers, ...openCompletionRequests(this.store, runId).sent.map(request => ({ workerId: request.recipientRunId, reason: 'request' as const, request }))];
  }

  /** A settled-but-uncollected result is work for the parent, not a live worker.
   * Keep the private termination proof: a public terminal status can precede exit. */
  private hasLiveWorkers(runId: string): boolean {
    return this.parentCompletionBlockers(runId).some(blocker => {
      const worker = this.store.getRun(blocker.workerId)?.delegation;
      return blocker.reason === 'outstanding' && worker?.role === 'worker' && worker.parentRunId === runId;
    });
  }

  /** Live workers keep a turn end monitoring unless the agent already waits on workers: an open
   *  worker entry is the wait, so no implicit re-check timer goes beside it (hearsay-tools/cezarion#1235). */
  private monitorsLiveWorkers(runId: string): boolean {
    return this.hasLiveWorkers(runId) && !openWaits(this.store.getRun(runId) ?? {}).some(wait => wait.kind === 'worker');
  }

  private delegationFinishBlockedReason(runId: string): string | undefined {
    const parent = this.store.getRun(runId);
    if (parent?.delegation?.role !== 'root') return undefined;
    if (this.hasPendingHumanAsk(runId) || this.active.get(runId)?.pendingHumanAsk) return 'Answer the pending human question before finishing.';
    const questions = this.unansweredQuestions(runId);
    if (questions.length) return `Answer your workers' questions before finishing: ${questions.map(q => q.workerId).join(', ')}`;
    const blockers = this.parentCompletionBlockers(runId).filter(blocker => blocker.reason !== 'request');
    return blockers.length ? `Workers must finish or be stopped, prove termination, and have their latest results collected before finishing: ${blockers.map(b => `${b.workerId} (${b.reason})`).join(', ')}` : undefined;
  }

  /** The read-only verdict and explicit Finish share this decision. Operational failures
   * (for example a failed durable write) are still handled at execution time. */
  private finishDecision(runId: string):
    { action: 'session' | 'root' | 'waiting' | 'review' } | { reason: string; warn?: boolean } {
    const blocked = this.delegationFinishBlockedReason(runId);
    if (blocked) return { reason: blocked, warn: true };
    if (this.active.get(runId)?.session?.open) return { action: 'session' };
    const run = this.store.getRun(runId);
    if (run?.status === 'waiting' && !hasRegisteredRunProcess(runId) && !this.isActive(runId) &&
      (run.delegation?.role === 'root' || run.delegation === undefined)) {
      if (this.waitingBeforeFinalWorkflowStep(run)) {
        return { reason: 'Continue the remaining workflow steps before finishing.' };
      }
      return { action: run.delegation?.role === 'root' ? 'root' : 'waiting' };
    }
    if (run?.status === 'review' && !this.isActive(runId)) return { action: 'review' };
    return { reason: 'no open session' };
  }

  finishBlockedReason(runId: string): string | undefined {
    const decision = this.finishDecision(runId);
    return 'reason' in decision ? decision.reason : undefined;
  }

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
      this.monitoring.delete(runId); this.waiting.add(runId);
      if (state.currentStepId) this.store.updateStep(runId, state.currentStepId, { status: 'waiting' });
      this.releaseSlot();
    }
    return 'held';
  }

  /** Human Finish keeps the worker guarantees and bypasses request obligations only. */
  private completionMayPass(runId: string): boolean {
    const run = this.store.getRun(runId);
    const humanFinish = this.active.get(runId)?.finishRequested || (run?.delegation?.role === 'root' && run.delegation.finishRequestedAt);
    return humanFinish ? this.parentCompletionBlockers(runId).every(blocker => blocker.reason === 'request') : !this.completionRefusal(runId);
  }

  /** The session just took a refusal nudge, live or queued (hearsay-tools/cezarion#1301): its turn is
   *  the nudge's, and its reply is bounded by the no-wait nudge's reply timer, so a harness that
   *  reads the refusal and says nothing parks on Cezar's human wait instead of holding the slot. */
  private awaitCompletionNudgeReply(runId: string, state: ActiveRun, session: AgentSession): void {
    state.completionNudged = session;
    const refusal = this.completionRefusal(runId);
    if (refusal) recordRequestRefusal(state, refusal);
    state.noWaitNudgeSawContent = false;
    this.clearIdleTimer(state);
    this.armNoWaitNudgeReplyTimer(runId, state);
  }

  /**
   * A blocked done found when the session is gone (`settleSuccess` after its async work, a
   * restart; hearsay-tools/cezarion#1301): the refusal is queued as one lifecycle input, charged as
   * the live nudge is, and the scheduler continuation reopens the session to deliver it
   * (`queueWaitWake`); its delivery marks that turn as the nudge's. Open waits come first: they wake
   * the run, and the refusal is a note. A spent budget opens Cezar's `budget` human wait, and an
   * input the full inbox refuses leaves the run waiting for the user. Always true.
   */
  private queueCompletionRefusal(runId: string, refusal: NonNullable<ReturnType<RunManager['completionRefusal']>>): boolean {
    const state = this.active.get(runId);
    this.store.appendEvent(runId, { type: 'note', tone: 'warning', message: `Completion blocked: ${refusal.message}` });
    this.move(runId, 'park', { finishedAt: undefined });
    this.store.flush();
    if (this.holdsAgentWaits(runId)) return true;
    // One refusal owed at a time: the copy already queued reopens the run (hearsay-tools/cezarion#1301).
    if (this.owesCompletionRefusal(runId)) {
      try { this.queueWaitWake(runId); } catch { this.retryWaitAdmission(runId); }
      return true;
    }
    if (this.automaticWakes(runId) >= MAX_AUTO_CONTINUES) {
      this.surfaceHumanWait(runId, state, this.openHumanAlias(runId, state, 'budget'));
      return true;
    }
    const text = refusal.liveWorkerIds.length ? `${refusal.message} ${COMPLETION_WILL_WAIT}` : refusal.message;
    // Its purpose is on the persisted input, so a Continue after a failed run and a restart still
    // deliver it as the nudge (hearsay-tools/cezarion#1301).
    const input: AgentInput = { id: randomUUID(), parentRunId: runId, source: 'lifecycle', purpose: 'completion-refusal', text, createdAt: new Date().toISOString() };
    // The refusal is queued with its charge (hearsay-tools/cezarion#1805): no restart delivers it uncharged.
    const spent = (this.store.getRun(runId)?.automaticWakes ?? 0) + 1;
    try {
      enqueueAgentInput(this.store.getRun(runId)!, input);
      this.store.commitOutcome(runId, { kind: 'charged', automaticWakes: spent }, { enqueue: [input] });
    } catch (error) {
      console.warn(`[cez] completion refusal not queued: ${error instanceof Error ? error.message : String(error)}`);
      return true;
    }
    this.store.appendEvent(runId, { type: 'agent-input', input });
    this.store.appendEvent(runId, { type: 'note', message: `${COMPLETION_NUDGE_NOTE} (${spent}/${MAX_AUTO_CONTINUES}): ${refusal.code}` });
    try { this.queueWaitWake(runId); } catch { this.retryWaitAdmission(runId); }
    return true;
  }

  /** Stop discards a refusal the run still owes, as it discards its waits: a later Continue must not
   *  deliver a stale one (hearsay-tools/cezarion#1301). One an inbox read holds is left to it. */
  private retireCompletionRefusal(runId: string): boolean {
    const inputs = this.store.getRun(runId)?.agentInputs ?? [];
    const kept = inputs.filter(input => input.deliveredAt || input.purpose !== 'completion-refusal' || hasLiveInboxClaim(input));
    if (kept.length === inputs.length) return false;
    try { this.store.commitAgentInputs(runId, kept); }
    catch (error) {
      console.warn(`[cez] completion refusal not retired: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
    return true;
  }

  /** A refusal `queueCompletionRefusal` queued and the run has not received yet. */
  private owesCompletionRefusal(runId: string): boolean {
    return !!this.store.getRun(runId)?.agentInputs?.some(input => !input.deliveredAt && input.purpose === 'completion-refusal');
  }

  /** A closing session leaves the run something to reopen for: an agent wait, or a refusal queued
   *  for it (hearsay-tools/cezarion#1301). A refusal takes a wait's bounded delivery retry, so a
   *  session that keeps closing before it is submitted stops at `MAX_WAKE_DELIVERY_ATTEMPTS`
   *  instead of reaching the success path, which would queue the refusal again. */
  private holdsClosingWakes(runId: string): boolean {
    return this.holdsAgentWaits(runId) || this.owesCompletionRefusal(runId);
  }

  /** A human message or a wake (hearsay-tools/cezarion#1301): the turn it opens or steers no longer
   *  answers a refusal nudge, so its blocked done gets a fresh nudge rather than the second step. */
  private startCompletionCycle(state: ActiveRun): void {
    state.incomingRequestRefused = undefined;
    state.sentRequestRefused = undefined;
    state.completionNudged = undefined;
    state.completionNudgeAnswered = undefined;
  }

  /** `cez worker wait`: an alias into the wait list, answered in the legacy `WorkerWait` shape
   *  (hearsay-tools/cezarion#1235). */
  registerWorkerWait(parentId: string, request: WorkerWaitRequest): WorkerWait {
    const parsed = workerWaitRequestSchema.parse(request);
    return workerWaitEntryToLegacy(this.registerWorkerListWait(parentId, parsed, 'cez-worker-wait'));
  }

  /**
   * Open a `worker` wait in the list (hearsay-tools/cezarion#1235): on workers the parent owns, or
   * on replies to requests the run sent. It stands beside CI, timer and human waits, up to
   * `WAIT_LIMIT` open ones; the same target and mode return the open wait instead. The family is
   * reconciled at once, so outcomes already in resolve it now, and its deadline is armed.
   * Refusals throw `DelegationPolicyError`: `incompatible_state`, `denied_scope` or
   * `capacity_limit`.
   */
  registerWorkerListWait(runId: string, request: { workerIds?: string[]; requestIds?: string[] | undefined; mode?: WorkerWaitRequest['mode']; timeoutSeconds: number },
    via: 'cezar_wait' | 'cez-worker-wait'): DeadlinedWorkerWaitEntry {
    this.reconcileWorkerWaits();
    this.assertCanRegisterWorkerWait(runId);
    const run = this.store.getRun(runId)!;
    const state = this.active.get(runId)!;
    if (!run.delegation || run.delegation.role === 'invalid') throw new DelegationPolicyError('denied_scope', 'Worker scope denied');
    const getRun = (id: string) => this.store.getRun(id);
    if (request.workerIds) assertOwnedWorkerWaitScope(runId, run.delegation, request.workerIds, getRun);
    else assertRequestWaitScope(run, run.delegation, request.requestIds ?? [], getRun);
    const repeated = identicalWorkerWait(run.waits ?? [], request);
    if (repeated && hasWorkerDeadline(repeated)) return repeated;
    if (openWaits(run).length >= WAIT_LIMIT) throw new DelegationPolicyError('capacity_limit', `This run already has ${WAIT_LIMIT} open waits; cancel one first`);
    const now = Date.now();
    const target = workerWaitTarget(request, getRun);
    const entry: DeadlinedWorkerWaitEntry = { id: randomUUID(), kind: 'worker', source: 'agent', via, registeredAt: new Date(now).toISOString(),
      deadline: new Date(now + request.timeoutSeconds * 1000).toISOString(), timeoutSeconds: request.timeoutSeconds,
      turnId: state.ciTurnId ??= randomUUID(), phase: 'open', ...(request.mode === undefined ? {} : { mode: request.mode }), ...target };
    this.withdrawCezarHumanWaits(runId);
    this.store.commitWait(runId, entry);
    // Outcomes already in resolve it now (or, with every worker destroyed, cancel it); the rest arm it.
    this.reconcileWorkerWaits(familyOf(run));
    // A worker that parked before this wait opened tells the parent now (hearsay-tools/cezarion#1327).
    this.noticeParkedWorkers(familyOf(run));
    const current = this.store.getRun(runId);
    if (current?.waits?.some(wait => wait.id === entry.id) && (state.atTurnBoundary === state.session || this.waiting.has(runId))) this.parkOnWaits(runId, state);
    return this.recordedWorkerWait(runId, entry.id) ?? entry;
  }

  /** The wait as the store now holds it, open or already delivered, with its deadline. */
  private recordedWorkerWait(runId: string, id: string): DeadlinedWorkerWaitEntry | undefined {
    const latest = this.store.getRun(runId);
    return [...latest?.waits ?? [], ...latest?.lastWaits ?? []].find((wait): wait is DeadlinedWorkerWaitEntry => wait.id === id && wait.kind === 'worker' && hasWorkerDeadline(wait));
  }

  /** Cezar waits on live workers or open requests without adding a deadline of its own. */
  private registerCompletionWait(runId: string, workerIds: string[], requestIds?: string[]): WorkerWaitEntry {
    const state = this.active.get(runId)!;
    const ids = workerIds.filter(id => { const worker = this.store.getRun(id)?.delegation; return worker?.role === 'worker' && worker.parentRunId === runId; });
    const entry: WorkerWaitEntry = { id: randomUUID(), kind: 'worker', source: 'cezar', via: 'completion', registeredAt: new Date().toISOString(),
      turnId: state.ciTurnId ??= randomUUID(), phase: 'open', mode: 'all',
      ...workerWaitTarget(requestIds?.length ? { requestIds } : { workerIds: ids }, id => this.store.getRun(id)) };
    this.store.commitWait(runId, entry);
    this.reconcileWorkerWaits(familyOf(this.store.getRun(runId)!));
    this.noticeParkedWorkers(runId);
    return entry;
  }

  /** The states no worker wait registers in: refusals throw `incompatible_state`. Waits stand
   *  beside CI, timer and human waits and beside each other (hearsay-tools/cezarion#1235). */
  private assertCanRegisterWorkerWait(runId: string): void {
    const run = this.store.getRun(runId);
    const state = this.active.get(runId);
    const refuse = (message: string): never => { throw new DelegationPolicyError('incompatible_state', message); };
    if (!run?.delegation || run.delegation.role === 'invalid') refuse('Worker waits require an owned worker or parent run');
    if (this.historyDeletionPending(runId)) refuse('History deletion is pending; finish deletion before registering a wait');
    if (this.executionBlockedByRootFinish(run!)) refuse('Parent finish is pending; a finishing parent cannot register a wait');
    if (!['running', 'waiting'].includes(run!.status) || !state?.session?.open || state.cancelled) {
      refuse(`Run is ${run!.status} with no available active session; register a wait from an executing parent or worker`);
    }
  }

  private hasUnansweredHumanAsk(runId: string): boolean {
    return pendingAskFacts.hasUnansweredHumanAsk(runId, this.active, id => this.pendingHumanAskSeq(id));
  }

  /** Both roles can select their own requests without acquiring worker-management authority.
   *  `cez message wait --request`: an alias into the wait list (hearsay-tools/cezarion#1235). */
  registerRequestWait(runId: string, request: RequestWaitRequest): WorkerWait {
    const parsed = requestWaitRequestSchema.parse(request);
    return workerWaitEntryToLegacy(this.registerWorkerListWait(runId, parsed, 'cez-worker-wait'));
  }

  /** `cezar_wait` kind `peer` and `cez message wait --peer` (hearsay-tools/cezarion#1995): checked
   *  and built by `peerWaitEntry`; a peer that already wrote or settled resolves it at once (`armWait`). */
  registerPeerWait(runId: string, request: { peerIds: string[]; timeoutSeconds: number }, via: 'cezar_wait' | 'cez-message-wait'): PeerWaitEntry {
    this.assertCanRegisterWorkerWait(runId);
    const state = this.active.get(runId)!;
    const entry = peerWaitEntry(this.store.getRun(runId)!, request, via, () => state.ciTurnId ??= randomUUID(), id => this.store.getRun(id));
    return this.store.getRun(runId)?.waits?.some(wait => wait.id === entry.id) ? entry : this.openWait(runId, state, entry);
  }

  /** `cez message cancel-wait` on a peer wait, through the list, as `cancelWorkerWait`; a settled one comes back as it is. */
  cancelPeerWait(runId: string, waitId: string): PeerWaitEntry {
    const run = this.store.getRun(runId)!;
    if (peerWaitOf(run, waitId).phase !== 'open') return peerWaitOf(run, waitId);
    if (this.disposed || !['queued', 'running', 'waiting'].includes(run.status) || this.rootFinishRequested(runId) || this.historyDeletionPending(runId)) {
      throw new DelegationPolicyError('incompatible_state', 'Parent cannot cancel a peer wait');
    }
    this.store.commitOutcome(runId, { kind: 'cancelled', waitIds: [waitId] });
    this.disarmWait(waitId);
    return peerWaitOf(this.store.getRun(runId), waitId);
  }

  /** The open peer waits of these runs whose named peer already wrote, settled or was deleted resolve now. */
  private resolvePeerWaits(runIds: readonly string[]): void {
    for (const id of runIds) for (const wait of openWaits(this.store.getRun(id) ?? {})) if (wait.kind === 'peer') this.resolvePeerWait(id, wait);
  }

  /** Like a timer, the wake is the agent's own arrangement: a stopping or finishing run takes none,
   *  and the wait stays for that transition to cancel. True when the wait is no longer open. */
  private resolvePeerWait(runId: string, wait: PeerWaitEntry): boolean {
    const run = this.store.getRun(runId);
    if (this.disposed || !this.canProceedWithRun(runId, run)) return false;
    const result = peerWaitResult(run, wait, this.store);
    if (result) this.settleWait(runId, wait.id, result);
    return !!result && this.store.getRun(runId)?.waits?.find(entry => entry.id === wait.id)?.phase !== 'open';
  }

  /** A wait wake is only a pointer. Only provider submission/opening prompts own delivery. */
  private providerOwnsInboxInput(runId: string, id: string): boolean {
    const state = this.active.get(runId);
    return !!state?.agentInputFlight?.inputIds.includes(id) || state?.openingAgentInputId === id ||
      this.store.getRun(runId)?.continuationMessage?.agentInputId === id;
  }

  canClaimInboxInput(runId: string, id: string): boolean {
    const run = this.store.getRun(runId);
    const input = run?.agentInputs?.find(entry => entry.id === id);
    return !this.disposed && !!run && ['queued', 'running', 'waiting'].includes(run.status) &&
      !this.historyDeletionPending(runId) && !this.executionBlockedByRootFinish(run) && !this.workerExecutionStopped(runId) &&
      !!input && input.source === 'agent' && !!input.conversation && !input.deliveredAt &&
      !hasLiveInboxClaim(input) && !this.providerOwnsInboxInput(runId, id);
  }

  /** The service supplies authorized, bounded IDs; claim and flight reservations are synchronous. */
  reserveInboxInputs(runId: string, generation: string, ids: readonly string[]): { receiptId: string; expiresAt: string; inputIds: string[] } | undefined {
    if (!ids.length || ids.some(id => !this.canClaimInboxInput(runId, id)) ||
      this.store.getRun(runId)?.agentInputs?.some(input => !input.deliveredAt && hasLiveInboxClaim(input))) return undefined;
    const claim: InboxClaim = { receiptId: randomUUID(), generation, expiresAt: new Date(Date.now() + 120_000).toISOString() };
    this.store.claimInboxInputs(runId, ids, claim);
    this.armInboxClaimExpiry(runId);
    return { receiptId: claim.receiptId, expiresAt: claim.expiresAt, inputIds: [...ids] };
  }

  acknowledgeInbox(runId: string, generation: string, receiptId: string): 'acknowledged' | 'already-acknowledged' {
    if (this.disposed || this.store.getRun(runId)?.agentInputs?.some(input => input.inboxClaim?.receiptId === receiptId &&
      !input.deliveredAt && this.providerOwnsInboxInput(runId, input.id))) throw new Error('inbox receipt displaced');
    const result = this.store.ackInboxInputs(runId, receiptId, generation, new Date().toISOString());
    this.armInboxClaimExpiry(runId);
    this.reconcileWorkerWaits();
    this.retireEmptyWake(runId);
    this.deliverConversationInput(runId);
    // A done the turn end kept behind this claim settles now that the input is read: the inbox
    // acknowledgement is the boundary's last owed input (hearsay-tools/cezarion#1620).
    const state = this.active.get(runId);
    if (state?.session?.open) this.settleIdleBoundary(runId, state, state.session);
    this.releaseSlot();
    return result;
  }

  releaseInbox(runId: string, generation: string, receiptId: string): 'released' {
    if (this.disposed) throw new Error('inbox manager disposed');
    const result = this.store.releaseInboxInputs(runId, receiptId, generation);
    this.armInboxClaimExpiry(runId);
    this.reconcileWorkerWaits();
    this.deliverConversationInput(runId);
    this.releaseSlot();
    return result;
  }

  /** Expiry is an independent wake source, including after the provider's last turn. */
  private armInboxClaimExpiry(runId: string): void {
    const previous = this.inboxClaimTimers.get(runId);
    if (previous) clearTimeout(previous);
    this.inboxClaimTimers.delete(runId);
    if (this.disposed) return;
    const deadlines = (this.store.getRun(runId)?.agentInputs ?? []).flatMap(input =>
      input.inboxClaim && !input.inboxClaim.acknowledgedAt ? [Date.parse(input.inboxClaim.expiresAt)] : []);
    if (!deadlines.length) return;
    let warned = false;
    const expire = () => {
      this.inboxClaimTimers.delete(runId);
      if (this.disposed || !this.store.getRun(runId)) return;
      try {
        this.store.clearExpiredInboxClaims(runId, new Date().toISOString());
        this.reconcileWorkerWaits();
        this.deliverConversationInput(runId);
        this.armInboxClaimExpiry(runId);
        this.releaseSlot();
      } catch {
        if (!warned) console.warn('[cez] inbox expiry checkpoint failed; retrying in 1 second');
        warned = true;
        if (!this.disposed) arm(1_000);
      }
    };
    const arm = (delay: number) => {
      const timer = setTimeout(expire, delay);
      timer.unref?.(); this.inboxClaimTimers.set(runId, timer);
    };
    arm(Math.max(0, Math.min(...deadlines) - Date.now()));
  }

  /** Accepted conversation input uses the existing scheduler admission for idle recipients. */
  deliverConversationInput(runId: string): void {
    if (this.disposed) return;
    const run = this.store.getRun(runId);
    if (!run?.delegation || run.delegation.role === 'invalid' || this.historyDeletionPending(runId) ||
      this.executionBlockedByRootFinish(run) || !['queued', 'running', 'waiting'].includes(run.status) ||
      this.workerExecutionStopped(runId)) return;
    // Only the parent's reply to a routed question answers it (#505), through the answer seam.
    // An answer already executing keeps its checkpoint until turn-end but holds no input (#935).
    if (this.hasUnansweredHumanAsk(runId)) this.answerRoutedQuestion(runId);
    this.resolvePeerWaits([runId]); // The one exception: a named peer's message ends a peer wait (hearsay-tools/cezarion#1995).
    // Messages are not waits (hearsay-tools/cezarion#1235): one the run has not received wakes it
    // through the wait list's admission, beside every open wait and a pending question, and ends
    // none of them. A turn in progress takes it at once, as steering.
    const current = this.store.getRun(runId);
    if (!current || !this.pendingConversationWakes(current).length) { this.holdPeerWakesAtCap(runId); return; }
    const state = this.active.get(runId);
    if (current.status === 'waiting' && (!state || state.atTurnBoundary === state.session)) this.queueWaitWake(runId);
    else if (!this.recoveringRun(runId)) this.flushAgentInputs(runId);
  }

  /** A worker's pending question goes to its owning parent as a conversation request
   * (#505). The worker still parks on its ask; only the parent's reply, or a human after
   * fallback, answers it. Routing is idempotent: the message ID derives from the ask seq. */
  private routeWorkerQuestion(workerId: string): void {
    const worker = this.store.getRun(workerId);
    if (worker?.delegation?.role !== 'worker') return;
    const ask = this.store.transcriptFacts(workerId).pendingAsk;
    if (!ask || ask.routedMessageId !== undefined || ask.fallback) return;
    const fallback = (reason: string) => { this.store.appendEvent(workerId, { type: 'worker-question-fallback', askSeq: ask.seq, reason }); };
    const request = askRequestOf(ask);
    if (!request) { fallback('the question cannot be carried to the parent'); return; }
    const parentId = worker.delegation.parentRunId;
    const root = this.store.getRun(parentId);
    const now = new Date().toISOString();
    const message = questionMessage({ workerRunId: workerId, parentRunId: parentId, askSeq: ask.seq, request, now });
    // Already committed (a crash before the routing event): the question did reach the parent,
    // whatever its capacity or state is now. Record the routing; fallback sweeps follow.
    const committed = root?.delegation?.role === 'root' && !!root.delegation.conversation?.messages.some(m => m.id === message.id);
    if (committed) {
      this.store.appendEvent(workerId, { type: 'worker-question-routed', askSeq: ask.seq, messageId: message.id, parentRunId: parentId });
      return;
    }
    const routing = workerQuestionFallback(worker, root, parent => this.parentCanReceive(parent));
    if ('reason' in routing) { fallback(routing.reason); return; }
    const { state } = routing;
    const input = { id: message.id, source: 'agent' as const, parentRunId: parentId, text: message.text, createdAt: now,
      conversation: { senderRunId: workerId, recipientRunId: parentId, kind: 'request' as const } };
    if (!commitNewMessage(this.store, parentId, { ...state, messages: [...state.messages, message] }, { recipientRunId: parentId, input }, () => fallback('its message ID is already in use in the parent conversation'))) return;
    projectConversationEvents(this.store, this.store.getRun(parentId)!);
    this.store.appendEvent(workerId, { type: 'worker-question-routed', askSeq: ask.seq, messageId: message.id, parentRunId: parentId });
    this.deliverConversationInput(parentId);
  }

  /**
   * A worker parked before finishing while its parent waits on it tells the parent why
   * (hearsay-tools/cezarion#1327): Cezar posts a progress message from the worker, which wakes the
   * parent and closes no wait. A parked question needs none, since the question itself goes to the
   * parent. At most one notice per parent wait (`parkNoticeId`), and none when the turn that
   * parked already messaged the parent, Cezar's own notice included. The message and the parent's
   * input commit together; a crash before that commit leaves the recovery sweep to post it.
   */
  private noticeParkedWorker(workerId: string): void {
    const worker = this.store.getRun(workerId);
    if (worker?.delegation?.role !== 'worker' || worker.delegation.destroy || !this.parkedBeforeFinishing(worker)) return;
    const parentId = worker.delegation.parentRunId;
    const root = this.store.getRun(parentId);
    if (root?.delegation?.role !== 'root' || !this.parentTakesMessages(root) ||
      !root.delegation.receipts.some(receipt => receipt.workerId === workerId && !receipt.deletion)) return;
    const state = root.delegation.conversation ?? { messages: [], outcomes: [] };
    const wait = parkNoticeWait(workerId, root.waits ?? [], state.messages);
    if (!wait) return;
    const turn = parkingTurn(this.store.readEvents(workerId));
    if (messagedParentSince(state.messages, workerId, parentId, turn.startedAt) || this.parkNoticeAtCapacity(workerId, wait.id, root, state)) return;
    const now = new Date().toISOString();
    const message = parkNoticeMessage({ workerRunId: workerId, parentRunId: parentId, waitId: wait.id, waits: worker.waits ?? [],
      ...(turn.text === undefined ? {} : { lastText: turn.text }), now, redact: text => this.store.redactText(text) });
    const input = { id: message.id, source: 'agent' as const, parentRunId: parentId, text: message.text, createdAt: now,
      conversation: { senderRunId: workerId, recipientRunId: parentId, kind: 'progress' as const } };
    if (!commitNewMessage(this.store, parentId, { ...state, messages: [...state.messages, message] }, { recipientRunId: parentId, input }, () => parkNoticeIdInUse(this.store, workerId, wait.id))) return;
    projectConversationEvents(this.store, this.store.getRun(parentId)!);
    this.deliverConversationInput(parentId);
  }

  /** A worker parked before finishing: waiting, not stopping or complete, with no pending question
   *  and no queued input. */
  private parkedBeforeFinishing(worker: RunRecord): boolean {
    // A question goes to the parent through `routeWorkerQuestion`; a prose gate does not, so it gets a notice.
    // Queued input wakes the worker, so the turn that takes it decides at its own park.
    return worker.status === 'waiting' && !worker.stopping && !this.store.transcriptFacts(worker.id).pendingAsk &&
      !this.active.get(worker.id)?.pendingHumanAsk && this.store.readWorkerExecution(worker.id)?.phase !== 'complete' &&
      !this.hasQueuedAgentInputs(worker.id);
  }

  /** The ledger and the parent's inbox keep room as `service.send` counts it, beside open
   *  questions' replies. When either is full, the worker's log says so once per wait. */
  private parkNoticeAtCapacity(workerId: string, waitId: string, root: RunRecord, state: ConversationState): boolean {
    if (state.messages.length + reservedReplies(state) < 1024 && inboxSlotsUsed(root) < 32) return false;
    const projectionId = `park-notice-skipped:${waitId}`;
    if (!this.store.hasProjection(workerId, projectionId)) {
      this.store.appendEvent(workerId, { type: 'note', tone: 'warning', projectionId, message: 'Parked, but the parent conversation is at capacity: no park notice was sent.' });
    }
    return true;
  }

  /** Recovery's pass over family members: a question (#505) or a park notice
   *  (hearsay-tools/cezarion#1327) that a crash caught before or after its commit to the parent
   *  still reaches it. The worker waits settle between the two, so a notice selects only a wait
   *  that is still open. */
  private recoverWorkerMessages(families: readonly RunRecord[], familyRootId: string | undefined): void {
    for (const run of families) if (run.delegation?.role === 'worker') this.routeWorkerQuestion(run.id);
    this.reconcileWorkerWaits(familyRootId);
    for (const run of families) this.noticeParkedWorker(run.id);
  }

  /** `noticeParkedWorker` for every worker a family's root owns. */
  private noticeParkedWorkers(rootId: string): void {
    for (const child of this.store.listWorkersOf(rootId)) this.noticeParkedWorker(child.id);
  }

  /** A human answering a worker question its parent handed back (#505): the reviewing parent
   * can no longer answer it, so it must not also block the human. */
  private answersFallenBackAsk(runId: string, opts: { text?: string | undefined; images?: PastedContent[] | undefined }, deferred: boolean): boolean {
    if (deferred || !(opts.text?.trim() || opts.images?.length)) return false;
    return !!this.store.transcriptFacts(runId).pendingAsk?.fallback;
  }

  /** The worker's pending ask when it went to the parent and has not fallen back to a human. */
  private routedAsk(runId: string): { askSeq: number; message: ConversationMessage } | undefined {
    const run = this.store.getRun(runId);
    if (run?.delegation?.role !== 'worker') return undefined;
    // Indexed at append time (#880): the reconcile and every message to a worker ask this.
    const ask = this.store.transcriptFacts(runId).pendingAsk;
    if (!ask || ask.fallback || ask.routedMessageId === undefined) return undefined;
    const root = this.store.getRun(run.delegation.parentRunId);
    const message = root?.delegation?.role === 'root'
      ? root.delegation.conversation?.messages.find(entry => entry.id === ask.routedMessageId) : undefined;
    return message ? { askSeq: ask.seq, message } : undefined;
  }

  /** The parent's reply answers the routed question like a human answer would: through the
   * live session's native answer seam, or by reopening a session that is gone (#505). */
  private answerRoutedQuestion(runId: string, admitted = false): void {
    const answer = this.pendingRoutedAnswer(runId);
    if (!answer) return;
    const { state } = answer;
    if (!state) this.reopenRoutedAnswer(runId, answer);
    else this.deliverRoutedAnswer(runId, state, answer, admitted);
  }

  private pendingRoutedAnswer(runId: string) {
    const routed = this.routedAsk(runId);
    const run = this.store.getRun(runId);
    const reply = routed && run?.agentInputs?.find(input => !input.deliveredAt && answersQuestion(routed.message, input));
    // A stopped worker is the human's to continue; a parent answer never revives it.
    if (!routed || !reply || run?.delegation?.role !== 'worker' || !['queued', 'running', 'waiting'].includes(run.status)) return undefined;
    // Verbatim: a native answer seam parses `Header: label` lines, exactly as a human's.
    const text = reply.text;
    const state = this.active.get(runId);
    const fallback = this.isWorkerFallbackAsk(runId, routed.askSeq);
    return { routed, reply, text, state, fallback };
  }

  private reopenRoutedAnswer(runId: string, answer: NonNullable<ReturnType<RunManager['pendingRoutedAnswer']>>): void {
    const { text, reply, fallback } = answer;
    // An automated answer is not a human override: the reopened session waits for capacity.
    // It withdraws no wait (hearsay-tools/cezarion#1235).
    if (this.isActive(runId)) return;
    const result = this.continueRun(runId, { text, answerInputId: reply.id }, true);
    if (!result.ok) this.store.appendEvent(runId, { type: 'note', tone: 'warning', message: `parent answer not delivered: ${result.error}` });
    else if (fallback) this.chargeWorkerFallbackReply(runId);
  }

  private deliverRoutedAnswer(runId: string, state: ActiveRun, answer: NonNullable<ReturnType<RunManager['pendingRoutedAnswer']>>, admitted: boolean): void {
    const { routed, reply, text, fallback } = answer;
    if (!state.session?.open || state.cancelled || state.openingAgentInputId === reply.id) return;
    // Already waiting for admission: only the admission itself may deliver it.
    if (!admitted && (this.waitWakeQueuedAt.has(runId) || this.waitWakeAdmitted.has(runId))) return;
    if (!admitted && this.waiting.has(runId)) {
      // The parked worker released its slot: the answer is a wake (`owesWake`), which the
      // scheduler's admission delivers here (`deliverAdmittedWake`). It withdraws no wait the
      // worker registered before asking (hearsay-tools/cezarion#1235).
      this.queueWaitWake(runId);
      return;
    }
    const bundle = state.atTurnBoundary === state.session ? pendingConversationBatch(this.store.getRun(runId), state, input => formatAgentInput(input, id => this.store.getRun(id)), reply.id) : undefined;
    if (!state.session.sendMessage([{ type: 'text', text }, ...(bundle ? [{ type: 'text' as const, text: bundle.text }] : [])])) return;
    this.store.appendEvent(runId, { type: 'human-input-delivered', askSeq: routed.askSeq, source: 'parent' });
    this.commitRoutedAnswer(runId, state, [reply.id, ...(bundle?.inputs.map(input => input.id) ?? [])], fallback);
    // Spend the answer's admission now so later messages can steer before its turn ends.
    if (this.waitWakeAdmitted.delete(runId)) state.waitWakeTurn = state.session;
    state.pendingHumanAsk = this.hasPendingHumanAsk(runId);
    if (!state.pendingHumanAsk) this.flushAgentInputs(runId);
    this.resumeParkedRun(runId, state);
  }

  /** A routed question settled without a reply (its worker stopped, a deadline, fallback) can
   * never be answered by the parent any more: hand it to the human on the worker (#505). */
  private retireSettledQuestions(parentId: string): void {
    const root = this.store.getRun(parentId);
    const conversation = root?.delegation?.role === 'root' ? root.delegation.conversation : undefined;
    if (!conversation) return;
    for (const message of conversation.messages) {
      const outcome = message.question && conversation.outcomes.find(entry => entry.requestId === message.id);
      // A reply still waiting for a live worker answers it; one a stopped worker never took does not.
      const worker = this.store.getRun(message.senderRunId);
      const live = !!worker && ['queued', 'running', 'waiting'].includes(worker.status) && !worker.stopping;
      if (!outcome || (outcome.status === 'replied' && live)) continue;
      const routed = this.routedAsk(message.senderRunId);
      if (routed?.message.id === message.id) {
        this.store.appendEvent(message.senderRunId, { type: 'worker-question-fallback', askSeq: routed.askSeq, reason: outcome.status === 'human-fallback' ? `parent-${root!.status}` : outcome.status === 'replied' ? 'worker-stopped' : `question-${outcome.status}` });
      }
    }
  }

  /** Routed questions this parent has not answered yet, by asking worker. */
  private unansweredQuestions(parentId: string): { workerId: string; messageId: string }[] {
    return this.store.listWorkersOf(parentId).flatMap(run => {
      const routed = this.routedAsk(run.id);
      const root = this.store.getRun(parentId);
      const answered = root?.delegation?.role === 'root' && root.delegation.conversation?.outcomes.some(outcome => outcome.requestId === routed?.message.id);
      return routed && !answered ? [{ workerId: run.id, messageId: routed.message.id }] : [];
    });
  }

  /** The parent can no longer answer: its workers' routed questions go back to the human
   * (#505). The outcome lands first, so a crash before the worker's event repeats this. */
  private fallbackRoutedQuestions(parentId: string, reason: string): void {
    const parent = this.store.getRun(parentId);
    if (parent?.delegation?.role !== 'root') return;
    const state = parent.delegation.conversation ?? { messages: [], outcomes: [] };
    const routed = this.store.listWorkersOf(parentId).flatMap(run => {
      const ask = this.routedAsk(run.id);
      // An accepted reply still on its way to a live worker answers it; no human card beside it.
      const replied = ask && state.outcomes.some(outcome => outcome.requestId === ask.message.id && outcome.status === 'replied');
      return ask && !(replied && ['queued', 'running', 'waiting'].includes(run.status) && !run.stopping) ? [{ workerId: run.id, ...ask }] : [];
    });
    if (!routed.length) return;
    const observedAt = new Date().toISOString();
    const missing = routed.filter(entry => !state.outcomes.some(outcome => outcome.requestId === entry.message.id));
    if (missing.length) {
      this.store.commitConversation(parentId, { ...state, outcomes: [...state.outcomes,
        ...missing.map(entry => ({ requestId: entry.message.id, status: 'human-fallback' as const, observedAt }))] });
      projectConversationEvents(this.store, this.store.getRun(parentId)!);
    }
    for (const entry of routed) this.store.appendEvent(entry.workerId, { type: 'worker-question-fallback', askSeq: entry.askSeq, reason });
  }

  /** The parent can still read and answer a routed question; answering needs its steer grant. */
  private parentCanReceive(parent: RunRecord): boolean {
    return parent.delegation?.role === 'root' && parent.delegation.permissions.includes('steer') && this.parentTakesMessages(parent);
  }

  /** The parent can still read a message from its worker. */
  private parentTakesMessages(parent: RunRecord): boolean {
    return parent.delegation?.role === 'root' && ['queued', 'running', 'waiting'].includes(parent.status) && !parent.stopping &&
      !this.rootFinishRequested(parent.id) && !this.historyDeletionPending(parent.id);
  }

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

  /** A turn of this run is executing now: a recovered run's is not, whatever it last recorded. */
  private isExecutingWorkerWaitTurn(runId: string): boolean {
    const state = this.active.get(runId);
    return !!state?.session?.open && !state.cancelled && !this.recoveringRun(runId) && state.atTurnBoundary !== state.session;
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
    this.pendingContinuations.set(runId, continuation);
    if (!this.queue.includes(runId)) this.queue.push(runId);
    this.store.updateStep(runId, continuation.stepId, { status: 'pending' });
    this.move(runId, 'requeue', { currentStepId: undefined });
    if (state) this.clearAutosaveTimer(state);
    this.starting.delete(runId); this.dropActive(runId);
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
  /** Request deadlines share the existing reconciliation timer registry, never a polling loop. */
  private reconcileConversations(family: readonly RunRecord[]): void {
    const now = new Date().toISOString();
    for (const root of family) {
      if (root.delegation?.role !== 'root' || !root.delegation.conversation) continue;
      const next = reconcileConversationState(root, (id) => this.store.getRun(id), now, run =>
        run.delegation?.role === 'worker' ? this.store.readWorkerExecution(run.id)?.phase === 'complete' : !this.isActive(run.id), id => this.store.isUnreadable(id));
      if (next && next !== root.delegation.conversation) this.store.commitConversation(root.id, next);
      projectConversationEvents(this.store, this.store.getRun(root.id)!);
      this.retireSettledQuestions(root.id);
      const key = `conversation:${root.id}`;
      const timer = this.requestDeadlineTimers.get(key);
      if (timer) { clearTimeout(timer); this.requestDeadlineTimers.delete(key); }
      const deadlines = next?.messages.filter(message => message.kind === 'request' && message.deadline &&
        !next.outcomes.some(outcome => outcome.requestId === message.id)).map(message => Date.parse(message.deadline!)) ?? [];
      if (deadlines.length) {
        const arm = (delay: number) => {
          const handle = setTimeout(() => {
            this.requestDeadlineTimers.delete(key);
            // This root's own family by name: it may have no live member left by its deadline
            // (#779), which the pass over live families would skip.
            try { this.reconcileWorkerWaits(root.id); this.reconcileWorkerWaits(); }
            catch {
              // A failed disk checkpoint retains the obligation; a bounded retry follows the
              // same failure policy as worker wait deadlines, never drops an unhandled error.
              if (!this.disposed) arm(1_000);
            }
          }, delay);
          handle.unref?.(); this.requestDeadlineTimers.set(key, handle);
        };
        arm(Math.max(0, Math.min(...deadlines) - Date.now()));
      }
    }
  }

  /** One delegation family: its root, then the root's direct workers (the store's
   *  `parent_run_id` query). Workers cannot delegate, so this never recurses. */
  private familyMembers(rootId: string): RunRecord[] {
    const root = this.store.getRun(rootId);
    return [...(root ? [root] : []), ...this.store.listWorkersOf(rootId)];
  }

  /** Every member of every family with a live member, each once: the families the store holds
   *  in memory (#779), which is where every delegation sweep that is not about one family looks. */
  private liveFamilyMembers(): RunRecord[] {
    const roots = new Set<string>();
    for (const run of this.store.listRuns()) {
      if (run.delegation?.role === 'root') roots.add(run.id);
      else if (run.delegation?.role === 'worker') roots.add(run.delegation.parentRunId);
    }
    return [...roots].flatMap(rootId => this.familyMembers(rootId));
  }

  /**
   * Recovery's full pass (#661): every family whose root carries a conversation — settled ones
   * too, so a projection or outcome a crash interrupted is repaired — then every live family.
   * Only roots with a conversation are read; a settled family without one has nothing to settle:
   * the other repair the sweep makes on a finished member (a cancelled root's Finish
   * intent) is a clause of `isLiveRecord`, so open already holds that family.
   * Everything else asks `reconcileWorkerWaits()`, which covers the live families (#779).
   */
  private async reconcileRecoveryWorkerFamilies(): Promise<void> {
    for (const rootId of this.store.listConversationRootIds()) {
      if (this.store.writeRefusal(rootId)) continue;
      this.recoveryFactsPending = true;
      await this.store.prepareRecoveryFacts(rootId);
      if (this.disposed) return;
      this.recoveryFactsPending = false;
      this.reconcileWorkerWaits(rootId);
    }
  }

  reconcileAllWorkerFamilies(): void {
    // Another process's families are its own to repair (#779, plan step 3).
    for (const rootId of this.store.listConversationRootIds()) if (!this.store.writeRefusal(rootId)) this.reconcileWorkerWaits(rootId);
    this.reconcileWorkerWaits();
  }

  /** Authority and wait live on disk; these collections are admission/timer caches only. One
   *  family by its root's id, or (no id) every family with a live member. */
  reconcileWorkerWaits(familyRootId?: string): void {
    if (this.disposed) return;
    if (this.reconcilingWorkers) {
      // The current pass already observes its own writes. A different family
      // (or an explicit global pass) must not disappear behind the recursion guard.
      if (this.reconcilingFamily !== undefined && this.reconcilingFamily !== familyRootId) {
        this.pendingReconciliations.add(familyRootId);
      }
      return;
    }
    this.pendingReconciliations.add(familyRootId);
    for (const pending of this.pendingReconciliations) {
      this.pendingReconciliations.delete(pending);
      if (this.disposed) break;
      this.reconcileWorkerFamily(pending);
    }
  }

  private reconcileWorkerFamily(familyRootId?: string): void {
    this.reconcilingWorkers = true;
    this.reconcilingFamily = familyRootId;
    try {
      // One family by name, or every family with a live member (#779): a family nobody in it is
      // live has nothing left to settle, and its members are no longer in memory.
      const family = (familyRootId === undefined ? this.liveFamilyMembers() : this.familyMembers(familyRootId))
        .filter(run => !this.recoveryFactsPending || !this.recoveringRun(run));
      this.reconcileConversations(family);
      for (const parent of family) {
        if (!parent.delegation || parent.delegation.role === 'invalid' || this.historyDeletionPending(parent.id)) continue;
        repairFailedRootFinish(this.store, parent);
        if (parent.status === 'cancelled' && parent.delegation.role === 'root' && parent.delegation.finishRequestedAt) {
          transitionVia('cancel', () => this.store.getRun(parent.id), () => this.store.commitRootFinishCancellation(parent.id));
        }
        if (!['queued', 'running', 'waiting'].includes(parent.status)) {
          if (!this.recoveringRun(parent)) {
            // A settled parent waits on nobody: its worker waits are cancelled, which also lets a
            // stored wait upgraded onto a finished root go (hearsay-tools/cezarion#1301).
            const stale = (parent.waits ?? []).filter(wait => wait.kind === 'worker' && (wait.phase === 'open' || wait.phase === 'resolved')).map(wait => wait.id);
            if (stale.length) { this.store.commitOutcome(parent.id, { kind: 'cancelled', waitIds: stale }); for (const id of stale) this.disarmWait(id); }
            this.fallbackRoutedQuestions(parent.id, `parent-${parent.status}`);
            for (const child of parent.delegation.role === 'root' && parent.status !== 'review' ? this.store.listWorkersOf(parent.id) : []) {
              if (['queued', 'running', 'waiting'].includes(child.status)) this.cancel(child.id);
            }
          }
          continue;
        }
        if (this.executionBlockedByRootFinish(parent)) continue;
        const observed = (now: string) => this.workerObservations(parent, now);
        this.reconcileWorkerEntries(parent, observed);
      }
    } finally { this.reconcilingWorkers = false; this.reconcilingFamily = undefined; }
  }

  /** The settled outcomes a run's worker waits can observe now: each owned worker whose execution
   *  is provably complete, and each deleted worker's retained result. */
  private workerObservations(parent: RunRecord, now: string) {
    const outcomes = this.store.listWorkersOf(parent.id).flatMap(child => {
      const outcome = workerOutcome(child, now);
      return outcome && this.store.readWorkerExecution(child.id)?.phase === 'complete' ? [outcome] : [];
    });
    // Explicit history deletion replaces the live execution proof with a completed
    // parent receipt. Keep its acknowledged outcome while other all-wait workers run.
    const deletedResults = new Map((parent.delegation?.role === 'root' ? parent.delegation.receipts : []).flatMap(receipt => {
      const result = this.store.readDeletedWorkerResult(parent.id, receipt.workerId);
      return result ? [[receipt.workerId, result] as const] : [];
    }));
    for (const result of deletedResults.values()) {
      if (result.status === 'review' || result.status === 'done' || result.status === 'failed' || result.status === 'cancelled') {
        outcomes.push({ workerId: result.workerId, revision: result.revision, status: result.status, observedAt: result.observedAt,
          ...(result.error ? { summary: result.error } : {}) });
      }
    }
    return { outcomes, deletedResults };
  }

  /** The family conversation's request outcomes, which settle request waits. */
  private requestOutcomesOf(run: RunRecord) {
    const root = run.delegation?.role === 'root' ? run : run.delegation?.role === 'worker' ? this.store.getRun(run.delegation.parentRunId) : undefined;
    return root?.delegation?.role === 'root' ? root.delegation.conversation?.outcomes ?? [] : [];
  }

  /**
   * Reconcile a run's open `worker` entries (hearsay-tools/cezarion#1235): the same observation
   * rules as the old engine's wait had (an unsettled wait follows a re-run worker's revision; an
   * observation without current proof is dropped). A satisfied or overdue entry resolves through
   * `resolveWait`, unless every worker it names was destroyed while the turn that waits on them is
   * still executing: nothing is left to await, so it is cancelled. Any other entry has its deadline
   * armed. Messages never resolve one.
   */
  private reconcileWorkerEntries(parent: RunRecord, observe: (now: string) => ReturnType<RunManager['workerObservations']>): void {
    const entries = (parent.waits ?? []).filter((wait): wait is WorkerWaitEntry => wait.kind === 'worker');
    if (!entries.length) return;
    const now = new Date().toISOString();
    const { outcomes, deletedResults } = observe(now);
    const requests = this.requestOutcomesOf(parent);
    const destroyed = (entry: WorkerWaitEntry) => !!entry.workerIds?.length && this.isExecutingWorkerWaitTurn(parent.id) && entry.workerIds.every(id => {
      const child = this.store.getRun(id)?.delegation;
      return child?.role === 'worker' ? child.destroy?.phase === 'complete' : deletedResults.get(id)?.cleanup === 'complete';
    });
    // A result still owed for workers the executing turn has since destroyed is no longer news.
    const retired = entries.filter(entry => entry.phase === 'resolved' && destroyed(entry)).map(entry => entry.id);
    if (retired.length) this.store.commitOutcome(parent.id, { kind: 'cancelled', waitIds: retired });
    for (const entry of entries.filter(wait => wait.phase === 'open')) {
      let selected = entry;
      if (entry.workerIds) {
        const revisions = entry.workerIds.map(workerId => {
          const metadata = this.store.getRun(workerId)?.delegation;
          return { workerId, revision: metadata?.role === 'worker' ? metadata.executionRevision ?? 0 : deletedResults.get(workerId)?.revision ?? 0 };
        });
        if (JSON.stringify(entry.revisions) !== JSON.stringify(revisions)) selected = { ...selected, revisions };
        const proven = (selected.outcomes ?? []).filter(previous => outcomes.some(current =>
          current.workerId === previous.workerId && (current.revision ?? 0) === (previous.revision ?? 0)));
        if (proven.length !== (selected.outcomes ?? []).length) selected = { ...selected, outcomes: proven };
      }
      const { entry: next, reason } = reconcileWorkerEntry(selected, outcomes, now, requests);
      if (reason && destroyed(next)) {
        this.store.commitOutcome(parent.id, { kind: 'cancelled', waitIds: [entry.id] });
        this.disarmWait(entry.id);
      } else if (reason) {
        // The deadline stays armed until the resolution is durable. A failed write is retried in a
        // second, since nothing else may touch this family again before the deadline.
        try { this.resolveWait(parent.id, entry.id, undefined, { ...next, result: { reason } }); }
        catch {
          if (!this.workerResolveRetries.has(entry.id)) console.warn('[cez] worker wait checkpoint failed; retrying in 1 second');
          this.disarmWait(entry.id);
          this.workerResolveRetries.add(entry.id);
          this.armWorkerDeadline(parent.id, entry, 1_000);
          continue;
        }
        this.disarmWait(entry.id);
      } else {
        if (next !== entry) this.store.commitWait(parent.id, next);
        this.armWait(parent.id, next);
      }
      const recorded = this.store.transcriptFacts(parent.id).workerOutcomeKeys;
      for (const outcome of next.outcomes ?? []) {
        if (!recorded.includes(workerOutcomeKey(entry.id, outcome.workerId, outcome.revision ?? 0))) {
          this.store.appendEvent(parent.id, { type: 'worker-outcome', waitId: entry.id, outcome });
        }
      }
    }
  }

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
  private hasQueuedAgentInputs(runId: string, except: readonly string[] = []): boolean {
    const run = this.store.getRun(runId);
    return !!run && ['queued', 'running', 'waiting'].includes(run.status) &&
      !(run.delegation?.role === 'worker' && run.delegation.destroy) &&
      (!!run.agentInputs?.some(input => !input.deliveredAt && !except.includes(input.id)) || harnessOwesInput(this.active.get(runId)));
  }

  /** Only the current session's observation writes consumedAt (#505). An ID reported
   * before its acceptance checkpoint lands is applied when that checkpoint commits. */
  private handleAgentInputConsumed(runId: string, state: ActiveRun, session: AgentSession | undefined, ids: readonly string[]): void {
    if (!session || this.active.get(runId) !== state || state.session !== session) return;
    const inFlight = state.agentInputFlight?.inputIds ?? [];
    for (const id of ids) if (inFlight.includes(id)) state.consumedBeforeAck?.add(id);
    const read = ids.filter(id => !inFlight.includes(id));
    for (const id of read) state.unreadInputIds?.delete(id);
    if (!harnessOwesInput(state)) clearUnreadInputTimer(state);
    try {
      if (!read.length) return;
      // The read and the failure count it ends are one commit (hearsay-tools/cezarion#1805).
      this.store.commitOutcome(runId, this.withFailuresCleared(runId, [{ kind: 'consumed', inputIds: read, at: new Date().toISOString() }], read));
      this.reconcileWorkerWaits(); // projects the consumed receipt
    } catch (error) { console.warn(`[cez] agent input consumption checkpoint failed: ${error instanceof Error ? error.message : String(error)}`); }
  }

  /** #505: input the harness accepted but will never read returns to the queue, so
   * DONE, auto-end and park see queued work. Out of a turn (an OpenCode lost wake)
   * it is submitted right away; at a turn-end the handler's own flush submits it. */
  private retireUnreadInputs(runId: string, state: ActiveRun, ids: readonly string[], outOfTurn: boolean): void {
    if (!ids.length || state.cancelled || this.active.get(runId) !== state) return;
    // Durable first: a failed checkpoint must never let this boundary finish (DONE, park)
    // over input that is still marked delivered but was never read.
    try { this.store.commitOutcome(runId, { kind: 'requeued', inputIds: ids }); }
    catch (error) {
      if (state.agentInputError) return;
      state.agentInputError = `agent input requeue checkpoint failed: ${error instanceof Error ? error.message : String(error)}`;
      try { state.session?.interrupt(); } finally {
        try { this.store.appendEvent(runId, { type: 'error', message: state.agentInputError }); }
        catch { console.error(`[cez] ${state.agentInputError}`); }
      }
      return;
    }
    for (const id of ids) state.unreadInputIds?.delete(id);
    // Reported before its own acknowledgement landed: that acknowledgement must not
    // mark it delivered again.
    for (const id of ids) if (state.agentInputFlight?.inputIds.includes(id)) (state.retiredInFlight ??= new Set()).add(id);
    this.store.appendEvent(runId, { type: 'note', message: `resubmitting ${ids.length} message${ids.length === 1 ? '' : 's'} the agent did not read` });
    if (outOfTurn) this.flushAgentInputs(runId);
  }

  /** #505: the harness started the opening turn, so the opening input was accepted.
   * Its replay-prompt retirement still waits for that turn's successful end. */
  private recordOpeningAccepted(runId: string, state: ActiveRun): void {
    const id = state.openingAgentInputId;
    if (!id || state.cancelled || this.active.get(runId) !== state) return;
    const inputs = this.store.getRun(runId)?.agentInputs ?? [];
    if (!inputs.some(input => input.id === id && !input.deliveredAt)) return;
    const deliveredAt = new Date().toISOString();
    try { this.store.commitOutcome(runId, { kind: 'delivered', inputIds: [id], at: deliveredAt }); }
    catch (error) { console.warn(`[cez] opening input acceptance checkpoint failed: ${error instanceof Error ? error.message : String(error)}`); }
  }

  /** Bundled messages and answer outcomes commit together. A refused write retries its
   *  accounting best effort; `retryDeliveryCheckpoint` preserves a deferred message's replay
   *  policy (hearsay-tools/cezarion#1805). Returns why the first write was refused. */
  private commitBundledDelivery(runId: string, state: ActiveRun, ids: readonly string[], also: readonly RunOutcome[] = []): string | undefined {
    const deliveredAt = new Date().toISOString();
    const awaiting = state.inputDelivery?.consumption === 'observable' ? { awaitingRead: true as const } : {};
    const outcomes = [...also, ...(ids.length ? [{ kind: 'delivered' as const, inputIds: ids, at: deliveredAt, ...awaiting }] : [])];
    let refused: string | undefined;
    try { this.store.commitOutcome(runId, outcomes); } catch (error) {
      refused = error instanceof Error ? error.message : String(error);
      console.warn(`[cez] bundled delivery checkpoint failed: ${refused}`);
      const retry = retryDeliveryCheckpoint(this.store, runId, outcomes);
      if (retry.outcomes !== outcomes) return refused;
      if (retry.committed) refused = undefined;
    }
    if (ids.length) state.bundledInputIds = [...(state.bundledInputIds ?? []), ...ids];
    return refused;
  }

  /** The fallback reply's charge, the question it answers and the reply it delivers are one commit
   *  (hearsay-tools/cezarion#1805): no restart reads the charge without the reply. */
  private commitRoutedAnswer(runId: string, state: ActiveRun, delivered: readonly string[], fallback: boolean): void {
    const spent = fallback ? (this.store.getRun(runId)?.automaticWakes ?? 0) + 1 : undefined;
    this.commitBundledDelivery(runId, state, delivered, [{ kind: 'answered' }, ...chargedIf(spent)]);
    if (spent !== undefined) this.store.appendEvent(runId, { type: 'note', message: `${WORKER_FALLBACK_REPLY_NOTE} (${spent}/${MAX_AUTO_CONTINUES})` });
  }

  /** One commit (hearsay-tools/cezarion#1805): the human waits a message answers, the messages bundled
   *  with it and a deferred message's queue entry. A refused queue entry interrupts the session:
   *  stdin and disk cannot transact, so it stays for conservative recovery. */
  private commitAnswer(runId: string, state: ActiveRun, bundle: { inputs: AgentInput[] } | undefined, messageId: string | undefined): void {
    const refused = this.commitBundledDelivery(runId, state, bundle?.inputs.map(input => input.id) ?? [], answerOutcomes(messageId, this.store.getRun(runId)?.automaticWakes));
    if (!refused || !messageId) return;
    state.agentInputError = `human input delivery checkpoint failed: ${refused}`;
    state.session?.interrupt();
  }

  /** The turn that carried bundled messages has ended: the model read them. */
  private readBundledInputs(runId: string, state: ActiveRun): void {
    const ids = state.bundledInputIds ?? [];
    state.bundledInputIds = undefined;
    if (!ids.length || state.cancelled) return;
    try { this.store.commitOutcome(runId, { kind: 'consumed', inputIds: ids, at: new Date().toISOString() }); this.reconcileWorkerWaits(); }
    catch (error) { console.warn(`[cez] bundled read checkpoint failed: ${error instanceof Error ? error.message : String(error)}`); }
  }

  /** #505: the session closed without reporting it read (failure, stop, exit): the input
   * goes back to the queue so a later session delivers it; never shown as delivered. */
  private requeueUnreadAtClose(runId: string, state: ActiveRun, session: AgentSession | undefined): void {
    clearUnreadInputTimer(state);
    clearHeldHumanInputTimer(state);
    // Everything this session accepted but never saw read: steered input, messages bundled
    // behind a human answer, and an opening instruction whose turn never succeeded.
    const opening = state.openingAgentInputId && this.store.getRun(runId)?.agentInputs?.some(input =>
      input.id === state.openingAgentInputId && input.deliveredAt && !input.consumedAt) ? [state.openingAgentInputId] : [];
    const ids = [...new Set([...(state.unreadInputIds ?? []), ...(state.bundledInputIds ?? []), ...opening])];
    if (!session || !ids.length || this.active.get(runId) !== state || state.session !== session) return;
    state.unreadInputIds?.clear();
    state.bundledInputIds = undefined;
    try { this.store.commitOutcome(runId, { kind: 'requeued', inputIds: ids }); }
    catch (error) { console.warn(`[cez] agent input requeue failed: ${error instanceof Error ? error.message : String(error)}`); }
  }

  /** An idle, open boundary with nothing left to deliver: DONE closes, otherwise the
   * run parks as waiting or monitoring. Shared by acknowledgements that land after a
   * turn ended and by the unread-input grace timer (#505). */
  private settleIdleBoundary(runId: string, state: ActiveRun, session: AgentSession): void {
    // An in-flight acknowledgement still owns this boundary; its .then re-settles.
    if (harnessHoldsHumanInput(state) || state.agentInputFlight) return;
    const proseGate = state.parkAfterAck?.session === session && state.parkAfterAck.humanGate;
    // A wake beside a pending question can be acknowledged after its turn ended, and its
    // checkpoint takes the run out of the question's park: park for the question again
    // (hearsay-tools/cezarion#1233).
    if (state.pendingHumanAsk && !proseGate && state.atTurnBoundary === session && session.open &&
      !this.waiting.has(runId) && state.currentStepId) {
      this.parkForUser(runId, state, state.currentStepId);
      return;
    }
    if (state.atTurnBoundary !== session || (state.pendingHumanAsk && !proseGate) || (!proseGate && this.hasQueuedAgentInputs(runId))) return;
    // The turn end deferred to this acknowledgement (OpenCode HTTP/SSE): the turn that answered an
    // input finished before the input's acknowledgement. Its done, the waits still owed (a wake
    // acknowledged after its turn ended) or the turn end it kept (`parkAfterAck`) settle now, with
    // queued and accepted input still taking priority above (hearsay-tools/cezarion#1234, #1525).
    // Cezar's own human wait is not owed: the rule decides, and the agent's wait replaces it.
    const done = state.doneAtBoundary === session;
    if (!done && (this.waiting.has(runId) ||
      (state.parkAfterAck?.session !== session && (proseGate || !this.holdsAgentWaits(runId))))) return;
    this.settleTurn(runId, state, 'ack', this.boundaryTurn(runId, state, session, done));
  }

  /** #505 liveness bound: a harness that accepted input and then neither read it nor ran
   * another turn must not hold the run and its slot forever. After a quiet grace window the
   * input is resubmitted once; after a second it is left delivered but unconfirmed. */
  private armUnreadInputTimer(runId: string, state: ActiveRun): void {
    clearUnreadInputTimer(state);
    const session = state.session;
    if (!session?.open || state.pendingHumanAsk || !harnessOwesInput(state) || state.agentInputFlight) return;
    const timer = setTimeout(() => {
      state.unreadInputTimer = undefined;
      if (this.disposed || this.active.get(runId) !== state || state.session !== session || !session.open || state.cancelled ||
        state.pendingHumanAsk || state.agentInputFlight || !harnessOwesInput(state)) return;
      const ids = [...state.unreadInputIds!];
      const retried = ids.filter(id => state.unreadRetried?.has(id));
      const fresh = ids.filter(id => !state.unreadRetried?.has(id));
      if (retried.length) {
        for (const id of retried) state.unreadInputIds?.delete(id);
        try { this.store.commitAgentInputsUnconfirmed(runId, retried); } catch { /* receipt stays awaiting; a restart replays it */ }
        this.store.appendEvent(runId, { type: 'note', message: unreadInputUnconfirmedNote(retried.length) });
      }
      if (fresh.length) {
        state.unreadRetried ??= new Set();
        for (const id of fresh) state.unreadRetried.add(id);
        this.retireUnreadInputs(runId, state, fresh, true);
      }
      // No content since the last turn ended: the harness is idle, whatever turn it announced.
      if (!harnessOwesInput(state) && !state.agentInputFlight) {
        state.atTurnBoundary = session;
        if (state.parkAfterAck?.session !== session) state.parkAfterAck = { session, monitoring: false };
        this.settleIdleBoundary(runId, state, session);
      }
    }, this.unreadInputGraceMs);
    timer.unref?.();
    state.unreadInputTimer = timer;
  }

  // Keep both launch paths' session-event handlers unchanged until Phase 3's
  // run/session-events.ts merges them (epic hearsay-tools/cezarion#2051).
  private clearUnreadInputTimer(state: ActiveRun): void { clearUnreadInputTimer(state); }
  private clearHeldHumanInputTimer(state: ActiveRun, resetClock = true): void { clearHeldHumanInputTimer(state, resetClock); }

  /** #486: a turn-end deferred close/park only because the harness still held a human follow-up. */
  private armHeldHumanInputTimer(runId: string, state: ActiveRun): void {
    clearHeldHumanInputTimer(state, false);
    const session = state.session;
    if (!session?.open || !harnessHoldsHumanInput(state)) {
      state.heldHumanInputSince = undefined;
      return;
    }
    state.heldHumanInputSince ??= Date.now();
    const timer = setTimeout(() => {
      state.heldHumanInputTimer = undefined;
      if (this.disposed || this.active.get(runId) !== state || state.session !== session || !session.open ||
        state.cancelled || state.idleClosed || state.atTurnBoundary !== session) return;
      if (harnessHoldsHumanInput(state)) {
        // An in-flight ACK still owns this boundary; its .then re-settles.
        if (state.agentInputFlight) {
          this.armHeldHumanInputTimer(runId, state);
          return;
        }
        if (Date.now() - (state.heldHumanInputSince ?? 0) >= this.unreadInputGraceMs) {
          const held = session.heldHumanInputCount?.() ?? 0;
          this.store.appendEvent(runId, {
            type: 'note',
            message: held > 0
              ? unreadInputUnconfirmedNote(held)
              : 'delivered held messages; the agent did not confirm reading them',
          });
          state.heldHumanInputExpired = true;
          this.settleIdleBoundary(runId, state, session);
          return;
        }
        this.armHeldHumanInputTimer(runId, state);
        return;
      }
      this.settleIdleBoundary(runId, state, session);
    }, HELD_HUMAN_INPUT_RECHECK_MS);
    timer.unref?.();
    state.heldHumanInputTimer = timer;
  }

  /** A callback from an old/replaced/disposed session carries no authority. */
  private handleAgentInputReady(runId: string, state: ActiveRun, session: AgentSession | undefined): void {
    if (!session || this.disposed || this.active.get(runId) !== state || state.session !== session ||
      !session.open || state.idleClosed || state.cancelled || state.finishRequested || state.agentInputError || state.agentSessionError) return;
    // Durable input always gets the first opportunity. Only the same refused,
    // completed boundary may retry; ordinary/native question parks are not wakes.
    if (this.flushAgentInputs(runId)) return;
    // #486: held human input drained at this still-current boundary with no new turn.
    // Runners fire onAgentInputReady from the transport ACK finally/callback while
    // agentInputFlight is still set; settling here parks before the ACK .then can nudge.
    const idle = state.atTurnBoundary === session && !harnessHoldsHumanInput(state) &&
      !state.agentInputFlight && !harnessOwesInput(state);
    // The refused autonomous nudge retries at the boundary it waited at: the turn-end rule decides it
    // again (hearsay-tools/cezarion#1525).
    // It keeps tryAutonomousNudge's own guards: a run that may not continue on its own keeps the
    // retry pending, bounded by the idle timer.
    if (idle && state.autonomousNudgePending === session && state.doneAtBoundary !== session && state.currentStepId &&
      state.autonomous && this.canAutoContinue(runId, state)) {
      this.settleTurn(runId, state, 'ready', { ...this.boundaryTurn(runId, state, session, false), monitoring: false });
      return;
    }
    if (idle) this.settleIdleBoundary(runId, state, session);
  }

  /** Reservation is synchronous; only an acknowledged transport may checkpoint delivery. */
  private submitAgentInput(runId: string, state: ActiveRun, content: ContentBlock[], inputIds: readonly string[] = [], beforeHumanReset?: HumanAnswerBudget): boolean {
    const session = state.session;
    if (!session?.open || state.agentInputFlight || state.cancelled || state.finishRequested || state.agentInputError) return false;
    if (!this.admitsAgentInput(runId, state, session, inputIds, beforeHumanReset)) return false;
    // Every delivered turn ends with the waits still open.
    const footer = openWaitsFooter(this.store.getRun(runId)?.waits ?? [], { tools: !state.toolless });
    if (footer) content = [...content, { type: 'text', text: `\n\n${footer}` }];
    // A refusal queued for a closed session (hearsay-tools/cezarion#1301): this turn is the nudge's.
    const refusal = !!this.store.getRun(runId)?.agentInputs?.some(input => input.purpose === 'completion-refusal' && inputIds.includes(input.id));
    const flight: NonNullable<ActiveRun['agentInputFlight']> = { session, inputIds,
      ...(this.waitWakeAdmitted.has(runId) && state.atTurnBoundary === session ? { admittedWake: true } : {}) };
    // A batch with timer results is an automatic wake: it reserves one unit of the budget now, so a timer that comes due before this acknowledgement counts it, and gives it back if the batch is refused or its acknowledgement rejects (hearsay-tools/cezarion#1233).
    if (reservesAutomaticWake(this.store.getRun(runId), flight, inputIds, () => this.automaticWakes(runId, beforeHumanReset), MAX_AUTO_CONTINUES)) flight.wakeReserved = true;
    state.agentInputFlight = flight;
    const settled = this.sendAgentInput(runId, state, flight, content, refusal);
    if (!settled) return false;
    const deliveries = this.executions.get(runId)?.deliveries; deliveries?.add(settled);
    void settled.then(() => deliveries?.delete(settled));
    this.resumeParkedRun(runId, state, beforeHumanReset);
    this.recordAgentInputTurn(runId, state, flight, refusal);
    return true;
  }
  private recordAgentInputTurn(runId: string, state: ActiveRun, flight: NonNullable<ActiveRun['agentInputFlight']>, refusal: boolean): void {
    const { session, inputIds } = flight;
    if (flight.admittedWake || resolvedWaits(this.store.getRun(runId) ?? {}).some(wait => inputIds.includes(waitInputId(wait)))) state.waitWakeTurn = session;
    // A refusal queued while the session was gone makes this the nudge's turn; any other input is a wake, which starts a fresh cycle (hearsay-tools/cezarion#1301). A live nudge carries no input.
    if (refusal) this.awaitCompletionNudgeReply(runId, state, session);
    else if (inputIds.length) this.startCompletionCycle(state);
  }
  private admitsAgentInput(runId: string, state: ActiveRun, session: NonNullable<ActiveRun['session']>, inputIds: readonly string[], beforeHumanReset?: HumanAnswerBudget): boolean {
    // A pending question admits only a wake made of resolved-wait results and messages, at a turn boundary: it stays answerable, and nothing else is delivered until it is answered (hearsay-tools/cezarion#1233, #1235).
    if (state.pendingHumanAsk) {
      const run = this.store.getRun(runId);
      const owed = new Set(run ? [...resolvedWaits(run).map(waitInputId), ...this.pendingConversationWakes(run, beforeHumanReset).map(input => input.id)] : []);
      if (state.atTurnBoundary !== session || !inputIds.length || !inputIds.every(id => owed.has(id))) return false;
    }
    return true;
  }
  private sendAgentInput(runId: string, state: ActiveRun, flight: NonNullable<ActiveRun['agentInputFlight']>, content: ContentBlock[], refusal: boolean): Promise<void> | false {
    const { session, inputIds } = flight;
    const refund = (): void => { flight.wakeReserved = false; };
    const current = (): boolean => !this.disposed && this.active.get(runId) === state && state.session === session &&
      state.agentInputFlight === flight && !state.cancelled && !state.finishRequested && !this.workerExecutionStopped(runId) &&
      !!this.store.getRun(runId) && !this.executionBlockedByRootFinish(this.store.getRun(runId)!);
    const fail = (error: unknown, checkpoint: boolean): void => {
      if (!current() || state.agentSessionError || state.agentInputError) return;
      this.latchAgentInputError(runId, state, session, `${checkpoint ? 'agent input delivery checkpoint failed' : 'agent input delivery failed'}: ${error instanceof Error ? error.message : String(error)}`);
    };
    let acknowledgement: false | Promise<void>;
    // A wake beside a pending question tells the runner so: native wires refuse agent input while a portable CEZ:ASK is pending, and this input is not its answer. The question stays Cezar's and its card stays answerable; the provider's acknowledgement is still the checkpoint, and a rejected one fails the session like any other, leaving the waits resolved for a continuation.
    const besideQuestion = !!state.pendingHumanAsk;
    try {
      acknowledgement = besideQuestion ? session.sendAgentMessage(content, inputIds, { besideQuestion })
        : session.sendAgentMessage(content, inputIds);
    }
    catch (error) { refund(); fail(error, false); state.agentInputFlight = undefined; return false; }
    if (!acknowledgement) { refund(); state.agentInputFlight = undefined; return false; }
    // Attach rejection handling before any persistence/capacity work can throw.
    flight.settled = acknowledgement.then(() => {
      // A positive command ACK can precede a provider-close frame in the same read batch. Closing the transport afterwards does not revoke that ACK; explicit stop/disposal/replacement still revoke authority via current().
      if (!current()) return;
      try {
        if (inputIds.length) {
          const batch = analyseAcknowledgedInput(runId, state, flight, inputIds, this.store, this.waitWakeAdmitted, run => this.owesWake(run));
          if (!batch) return;
          const { accepted, resolvedIds, early, spent, observable, at, resumes } = batch;
          // One commit (hearsay-tools/cezarion#1805): the messages, then each wait's delivery (a message a wait carries keeps its read receipt), the charge, the early reads, the cleared failure count and the resume (hearsay-tools/cezarion#1235).
          this.store.commitOutcome(runId, this.withFailuresCleared(runId, acknowledgedBatch({ accepted, resolvedIds, early, spent, observable, at }), accepted, resolvedIds.length > 0),
            resumes ? { patch: { status: transition('resume', () => this.store.getRun(runId)) }, resumeStepId: resolvedIds.length ? state.currentStepId : undefined } : {});
          this.applyAcknowledgedInput(runId, state, flight, batch, refusal);
        }
      } catch (error) { fail(error, true); }
    }, error => { refund(); fail(error, false); }).then(() => {
      if (state.agentInputFlight !== flight) return;
      const authorized = current();
      state.agentInputFlight = undefined;
      if (!authorized || !session.open || state.agentSessionError || state.agentInputError) return;
      // A liveness resubmission gets its own quiet window, and so does input acknowledged after its turn already ended: no later turn-end would arm one (#505 review).
      if (inputIds.some(id => state.unreadRetried?.has(id)) || state.atTurnBoundary === session) this.armUnreadInputTimer(runId, state);
      if (this.flushAgentInputs(runId)) return;
      this.settleIdleBoundary(runId, state, session);
    }).catch(error => {
      // Bookkeeping failures cannot become unhandled promise rejections.
      if (state.agentInputFlight === undefined) state.agentInputFlight = flight;
      try { fail(error, true); } finally { if (state.agentInputFlight === flight) state.agentInputFlight = undefined; }
    });
    return flight.settled;
  }

  /** Apply the acknowledgement's effects only after its outcome commit succeeds. */
  private applyAcknowledgedInput(runId: string, state: ActiveRun, flight: NonNullable<ActiveRun['agentInputFlight']>, batch: AcknowledgedInput, refusal: boolean): void {
    const { accepted, resolvedIds, early, spent, observable, timers, peers, resumes, owedBefore } = batch;
    const { session } = flight;
    if (spent !== undefined) {
      flight.wakeReserved = false;
      const kind = !timers.length && peers.length ? 'peer message' : timers.some(isMonitoringTimer) ? 'monitoring' : (['timer', 'process', 'peer'] as const).find(k => timers.some(wait => wait.kind === k));
      this.store.appendEvent(runId, { type: 'note', message: `automatic ${kind} wake-up (${spent}/${MAX_AUTO_CONTINUES})` });
    }
    // A wake of results always spends its admission; a wake of messages alone, only one it holds.
    if (resumes && (this.waitWakeAdmitted.delete(runId) || resolvedIds.length > 0)) {
      this.spendWakeAdmission(runId, state, resolvedIds.length ? resolvedWaits(this.store.getRun(runId) ?? {}).length > 0 : owedBefore);
    }
    // Rearm the refusal turn's bound after the wake checkpoint cleared the park's timers.
    if (refusal && state.completionNudged === session) this.armNoWaitNudgeReplyTimer(runId, state);
    // Until observed read, a failed steering session requeues the input and counts a failure.
    for (const id of observable ? accepted : []) { if (early.includes(id)) state.consumedBeforeAck?.delete(id); else state.unreadInputIds?.add(id); }
    this.reconcileWorkerWaits();
  }

  /** False leaves the durable entry untouched. The answer commits its reset before this flush,
   *  but this one synchronous flush keeps the budget decisions it made before that reset
   *  (hearsay-tools/cezarion#1906). Later acknowledgements read the restarted budget normally. */
  private flushAgentInputs(runId: string, beforeHumanReset?: HumanAnswerBudget): boolean {
    const state = this.active.get(runId);
    let run = this.store.getRun(runId);
    if (!state?.session?.open || state.cancelled || state.agentInputError || state.agentInputFlight || !run ||
      !['queued', 'running', 'waiting'].includes(run.status) || this.executionBlockedByRootFinish(run) ||
      (run.delegation?.role === 'worker' && run.delegation.destroy)) return false;
    run = this.supersedeFallbackBeforeFlush(runId, state, run, beforeHumanReset);
    // A question pending at a turn boundary still takes an admitted wake of resolved-wait results
    // and messages; one pending mid-turn (a native ask) takes nothing until its turn ends.
    const askPending = state.pendingHumanAsk || this.hasUnansweredHumanAsk(runId);
    if (askPending && state.atTurnBoundary !== state.session) return false;
    run = this.cancelCappedTimersBeforeFlush(runId, state, run, beforeHumanReset);
    return this.flushAgentInputBatch(runId, state, run, askPending, beforeHumanReset);
  }

  private supersedeFallbackBeforeFlush(runId: string, state: ActiveRun, run: RunRecord, beforeHumanReset?: HumanAnswerBudget): RunRecord {
    // A parent's input to a worker supersedes Cezar's fallback question, charged as its reply would
    // be (hearsay-tools/cezarion#1301); the parent's reply to it goes through the answer seam.
    const answer = this.routedAnswer(runId)?.id;
    if (run.agentInputs?.some(input => !input.deliveredAt && input.source === 'agent' && input.id !== answer && input.id !== state.openingAgentInputId) &&
      this.supersedeWorkerFallback(runId)) {
      // The old post-flush reset erased this charge. Keep its decision and note, without writing
      // an old charge over the reset already committed with the human answer.
      this.chargeWorkerFallbackReply(runId, beforeHumanReset);
      run = this.store.getRun(runId)!;
    }
    return run;
  }

  private cancelCappedTimersBeforeFlush(runId: string, state: ActiveRun, run: RunRecord, beforeHumanReset?: HumanAnswerBudget): RunRecord {
    // A timer result still owed when the budget is spent is cancelled before its batch is sent; the
    // CI results beside it are delivered.
    if (this.automaticWakes(runId, beforeHumanReset) >= MAX_AUTO_CONTINUES && this.waitWakeAdmitted.has(runId) && state.atTurnBoundary === state.session) {
      const owedTimers = resolvedWaits(run).filter(chargesBudget);
      if (owedTimers.length) {
        this.cancelAutomaticAtCap(runId, owedTimers);
        run = this.store.getRun(runId)!;
        // Nothing left to wake for: the admission ends here, and a parked run becomes a plain park.
        if (!resolvedWaits(run).length) { this.waitWakeAdmitted.delete(runId); this.reparkWithoutWaits(runId, state); }
      }
    }
    return run;
  }

  private flushAgentInputBatch(runId: string, state: ActiveRun, run: RunRecord, askPending: boolean, beforeHumanReset?: HumanAnswerBudget): boolean {
    // The opening prompt already carries its own input; later input steers the
    // opening turn instead of waiting for it to end (#505).
    const resolved = resolvedWaits(run);
    const owed = new Set(resolved.map(waitInputId));
    // A resolved wait's input is delivered only by its admitted wake, never as ordinary input.
    // Beside a pending question only messages go with it (hearsay-tools/cezarion#1235).
    const beside = new Set(this.pendingConversationWakes(run, beforeHumanReset).map(input => input.id));
    // A refusal queued for a closed session waits for the reopened session's turn boundary: the
    // turn that answers it is the nudge's (hearsay-tools/cezarion#1301), not the opening turn.
    const boundary = state.atTurnBoundary === state.session;
    const queue = (run.agentInputs ?? []).filter(input => input.id !== state.openingAgentInputId && !owed.has(input.id) &&
      (!askPending || beside.has(input.id)) && (boundary || input.purpose !== 'completion-refusal'));
    const admitted = this.waitWakeAdmitted.has(runId) && state.atTurnBoundary === state.session;
    if (resolved.length && admitted) {
      const batch = resolvedWaitInputBatch(run, resolved, queue, input => formatAgentInput(input, id => this.store.getRun(id)), { tools: !state.toolless, workerStatus: this.workerStatus });
      if (!batch) return false;
      return this.submitAgentInput(runId, state, [{ type: 'text', text: batch.text }], batch.inputIds, beforeHumanReset);
    }
    // Messages beside a pending question go only with an admitted wake (hearsay-tools/cezarion#1235).
    if (askPending && !admitted) return false;
    // An open or owed CI wait holds conversation input for its own admitted wake (#476); a message
    // is a wake of its own, so an admitted one goes beside it (hearsay-tools/cezarion#1235).
    if (!admitted && (hasPrWait(run) || (resolved.length && !queue.some(input => !input.deliveredAt)))) return false;
    const batch = agentInputBatch(queue, input => formatAgentInput(input, id => this.store.getRun(id)));
    if (!batch) return false;
    const text = batch.inputs.map(input => formatAgentInput(input, id => this.store.getRun(id))).join('\n\n');
    return this.submitAgentInput(runId, state, [{ type: 'text', text }], batch.inputs.map(input => input.id), beforeHumanReset);
  }

  /** Deliver anything `deferMessage` buffered, once the session is live. */
  private flushDeferred(runId: string): void {
    const pending = this.deferredMessages.get(runId);
    if (!pending?.length) return;
    // Re-buffer whatever the session refused rather than dropping it. `sendMessage`
    // answers false when the session is not open yet — and silently losing a message
    // here would be precisely the failure `deferMessage` exists to prevent. Anything
    // left over is retried by the next session that opens on this run.
    const unsent = [];
    for (const entry of pending) {
      const state = this.active.get(runId);
      // A queue entry the delivery's checkpoint left in place stays buffered (`deliverMessage`).
      if (state?.agentInputError || !this.sendMessage(runId, entry.content, entry.messageId) ||
        (entry.messageId && this.store.getRun(runId)?.queuedMessages?.some(message => message.id === entry.messageId))) unsent.push(entry);
    }
    if (unsent.length) this.deferredMessages.set(runId, unsent);
    else this.deferredMessages.delete(runId);
  }

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
  private resumeParkedRun(runId: string, state: ActiveRun, beforeHumanReset?: HumanAnswerBudget): void {
    clearHeldHumanInputTimer(state);
    state.autonomousNudgePending = undefined;
    state.atTurnBoundary = undefined;
    state.doneAtBoundary = undefined;
    state.parkAfterAck = undefined;
    this.clearIdleTimer(state);
    // A wake command can emit activity before its transport ACK. Keep its park
    // until the durable delivery checkpoint; admission already reserves capacity.
    const owing = this.store.getRun(runId);
    if (owing && this.owesWake(owing, beforeHumanReset) && this.waitWakeAdmitted.has(runId)) return;
    // Its waits stay open and a pool member keeps its slot: only a turn end or a terminal path
    // changes either (hearsay-tools/cezarion#1233).
    this.waiting.delete(runId);
    this.move(runId, 'resume');
    if (state.currentStepId) {
      this.store.updateStep(runId, state.currentStepId, { status: 'running' });
    }
  }

  /** Shared live-session delivery. Synthetic scheduler prompts reuse lifecycle
   * bookkeeping without masquerading as user-authored transcript messages. */
  private deliverMessage(runId: string, content: PastedContent[], userAuthored: boolean, messageId?: string): boolean {
    const state = this.active.get(runId);
    if (!state?.session?.open || state.cancelled || state.pendingPermissions?.size) return false;
    const run = this.store.getRun(runId);
    if (!this.canProceedWithRun(runId, run)) return false;

    if (userAuthored && this.routedAsk(runId)) {
      this.store.appendEvent(runId, { type: 'note', tone: 'warning', message: ROUTED_QUESTION_REFUSAL });
      return false;
    }
    // Cezar's fallback question on a worker never holds what the plain park it replaced let
    // through: an automatic message supersedes it, as a parent's input does (hearsay-tools/cezarion#1301).
    if (!userAuthored) this.supersedeWorkerFallback(runId);
    const prepared = this.prepareMessageContent(runId, state, content, userAuthored);
    const { blocks, expanded, deliverable } = prepared;
    const delivered = userAuthored ? state.session.sendMessage(deliverable) : this.submitAgentInput(runId, state, deliverable);
    if (delivered && expanded !== blocks) this.provisionLiveSlashSkill(runId, state, blocks);
    if (delivered) {
      if (userAuthored) this.applyHumanMessageDelivery(runId, state, prepared, messageId);
      else this.resumeParkedRun(runId, state);
    }
    return delivered;
  }

  private prepareMessageContent(runId: string, state: ActiveRun, content: PastedContent[], userAuthored: boolean) {
    const text = content
      .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
      .map((b) => b.text)
      .join('\n');
    // Persist human attachments before the user-message event so the thread can render them.
    const persisted = userAuthored ? this.persistPastedAttachments(runId, content) : [];
    const images = persisted.map((saved) => saved.url);
    if (userAuthored) {
      this.store.appendEvent(runId, {
        type: 'user-message',
        stepId: state.currentStepId,
        text,
        imageCount: content.filter((b) => b.type === 'image').length,
        images,
      });
    }

    // Send paths beside image blocks: backends that drop images still receive usable files.
    const blocks = contentBlocksOf(content);
    const expanded = userAuthored ? expandRegistrySlashSkill(blocks, this.enabledSkills(state)) : blocks;
    const attached: ContentBlock[] = persisted.length
      ? [...expanded, pastedAttachmentsNote(persisted)]
      : expanded.length ? expanded : [{ type: 'text', text: 'The user attached a document, but it could not be saved. Ask them to attach it again before discussing its contents.' }];
    const answeringAskSeq = userAuthored ? this.pendingHumanAskSeq(runId) : undefined;
    // An answer opening a turn carries held conversation messages after the answer.
    const bundle = userAuthored && answeringAskSeq !== undefined && state.atTurnBoundary === state.session
      ? pendingConversationBatch(this.store.getRun(runId), state, input => formatAgentInput(input, id => this.store.getRun(id))) : undefined;
    // Human input answers all human waits. Agent input gets its footer in submitAgentInput.
    const footer = userAuthored ? openWaitsFooter((this.store.getRun(runId)?.waits ?? []).filter(wait => wait.kind !== 'human'), { tools: !state.toolless }) : undefined;
    const deliverable = userAuthored ? [...attached, ...(bundle ? [{ type: 'text' as const, text: bundle.text }] : []),
      ...(footer ? [{ type: 'text' as const, text: `\n\n${footer}` }] : [])] : attached;
    return { blocks, expanded, deliverable, answeringAskSeq, bundle };
  }

  private applyHumanMessageDelivery(runId: string, state: ActiveRun, prepared: ReturnType<RunManager['prepareMessageContent']>, messageId: string | undefined): void {
    const { answeringAskSeq, bundle } = prepared;
    const beforeHumanReset = { spent: this.store.getRun(runId)?.automaticWakes ?? 0 };
    // The turn that would have finished now answers the user (hearsay-tools/cezarion#1234).
    state.doneRequested = undefined;
    state.noWaitNudged = undefined;
    state.noWaitNudgeParked = undefined;
    state.noWaitNudgeSawContent = undefined;
    // A human message starts a fresh completion cycle (hearsay-tools/cezarion#1301).
    this.startCompletionCycle(state);
    if (answeringAskSeq !== undefined) {
      this.store.appendEvent(runId, { type: 'human-input-delivered', askSeq: answeringAskSeq });
    }
    this.commitAnswer(runId, state, bundle, messageId);
    state.pendingHumanAsk = this.hasPendingHumanAsk(runId);
    // A native answer or a full bundle leaves remaining messages to steer behind the answer.
    if (answeringAskSeq !== undefined && !state.pendingHumanAsk) this.flushAgentInputs(runId, beforeHumanReset);
    this.resumeParkedRun(runId, state, beforeHumanReset);
  }

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
  private unansweredWorkflowAsk(runId: string, state: ActiveRun): boolean {
    if (!state.finishRequested) this.supersedeWorkerFallback(runId);
    const run = this.store.getRun(runId);
    return !state.finishRequested && !!run && this.hasPendingHumanAsk(runId) &&
      this.waitingBeforeFinalWorkflowStep(run);
  }

  private waitingWorkflowStepIndex(run: RunRecord): number {
    return workflowPosition.waitingWorkflowStepIndex(run, isSyntheticContinuation, record => this.ciWorkflowResumeStepIndex(record));
  }

  /** The workflow step after the one a continuation resumes, when that one is not the last: the
   *  continuation's done completes the resumed step and starts this one (hearsay-tools/cezarion#1620). */
  /**
   * Whether a step session closed without its done while a later step waits (hearsay-tools/cezarion#1620).
   * It reads and clears the done `closeAsDone` recorded. Finish is an explicit stop, settled as before.
   */
  private stepLeftOpen(state: ActiveRun, stepId: string, next: WorkflowStepDef | undefined): boolean {
    const completed = state.completedStepId === stepId;
    state.completedStepId = undefined;
    return !!next && !completed && !state.finishRequested;
  }

  /** A resumed earlier step that closed without a done stays open: its workflow step, not the Continue's own. */
  private async settleIncompleteContinuation(runId: string, stepId: string): Promise<void> {
    const resumed = this.store.getRun(runId);
    const source = resumed ? resumed.workflowDef?.steps[this.waitingWorkflowStepIndex(resumed)] : undefined;
    await this.settleIncompleteStep(runId, source?.id ?? stepId);
  }

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
    this.pendingJobs.set(runId, job);
    this.queue.push(runId);
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
      this.pendingContinuations.set(runId, {
        stepId, sessionId: resumeSessionId, backend: targetRunner, prompt, images, lineJoinedAt: Date.now(),
      });
      this.queue.push(runId);
      this.move(runId, 'continue-line', { error: undefined, finishedAt: undefined, currentStepId: undefined });
      // Enqueueing wakes the scheduler even after the previous execution released its slot.
      void this.pump();
      return { ok: true };
    }
    this.starting.add(runId);
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
    this.starting.delete(runId);
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
    if (this.workerExecutionStopped(runId)) { this.starting.delete(runId); return; }
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
    this.starting.delete(runId);
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
    const onEvent = (event: AgentEvent) => {
      if (this.disposedSessionEvent(runId, state, event)) return;
      if (event.type === 'image') {
        const saved = this.persistAttachment(runId, event.mediaType, event.data);
        if (saved) this.store.appendEvent(runId, { type: 'image', stepId, ...saved });
        return;
      }
      if (event.type === 'text') {
        this.clearUnreadInputTimer(state); // real content: the harness is working
        this.clearHeldHumanInputTimer(state);
        this.noteNoWaitNudgeContent(runId, state, event);
        turn.text = appendTurnText(turn.text, event.text);
        const text = stripAskMarker(stripTaskMarkers(stripMonitoringMarker(stripDoneMarker(event.text))), false);
        if (text) this.store.appendEvent(runId, { type: 'text', text, stepId });
        return;
      }
      if (event.type === 'input-unconsumed') { this.retireUnreadInputs(runId, state, event.inputIds, true); return; }
      if (event.type === 'tool-call' || event.type === 'tool-result') {
        this.clearUnreadInputTimer(state);
        this.clearHeldHumanInputTimer(state);
        this.noteNoWaitNudgeContent(runId, state, event);
      }
      this.store.appendEvent(runId, { ...event, stepId });
      if (event.type === 'cost') recordReportedCost(this.store, runId, stepId, state, backend, event.usd);
      if (event.type === 'error') { this.recordSessionFault(state, turn, event.message); return; }
      if (turn.sessionError || state.agentInputError) return;
      if (event.type === 'session') {
        this.store.updateStep(runId, stepId, { sessionId: event.sessionId, backend,
          ...(event.sessionTransport ? { sessionTransport: event.sessionTransport } : {}) });
      }
      if (event.type === 'token-usage') {
        this.store.updateStep(runId, stepId, { tokensUsed: event.tokensUsed });
      }
      const wakeDelay = claudeScheduleWakeupDelay(event, backend);
      if (wakeDelay !== undefined) turn.scheduleWakeup = wakeDelay;
      if (event.type === 'turn-end') {
        this.markTurnBoundary(runId, state, event);
        if (!this.acknowledgeOpeningTurn(runId, state, answer)) return;
        // Belt-and-braces: v2 `turn.completed` already flushed the delta
        // coalescers; the v1 turn boundary flushes again (idempotent) so no
        // buffered delta can outlive its turn.
        sink.flushAll();
        this.trackTurnEnd(runId, turn.text); // titleSummary + diffStat (#389)
        const text = turn.text;
        const completedText = turn.completedText;
        turn.text = '';
        turn.completedText = '';
        turn.tail = 'none';
        const turnWakeDelay = turn.scheduleWakeup;
        turn.scheduleWakeup = undefined;
        this.endTurn(runId, state, sink, { stepId, text, completedText, scheduleWakeup: turnWakeDelay });
      }
    };

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
    const delegation = this.provisionSession(runId, state);
    // Read before the cancellation checks below, which also cover this await (#1576).
    const webhooksPart = await this.agentWebhooksPart();
    const ciTools = await this.provisionCiSession(runId, state);
    // Stop/Finish can arrive while the local tool controller is starting.
    if (this.launchStale(runId, state, delegation, ciTools)) {
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
      this.starting.delete(runId);
      this.dropActive(runId);
      return undefined;
    }
  }

  /** A Stop that arrived while the Continue resolved its workspace cancels the run before it
   *  becomes active. */
  private settleStoppedContinuation(runId: string): boolean {
    if (!this.store.getRun(runId)?.stopping) return false;
    this.move(runId, 'cancel', { finishedAt: new Date().toISOString() });
    this.starting.delete(runId);
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
        files = (await this.provisionRunSkills(runId, state, { stepSkill: skill.name, slash: continuationSlash })).filesDir;
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
      if (continuationSlash) files = (await this.provisionRunSkills(runId, state, { slash: continuationSlash })).filesDir;
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
        {
          onUiEvent: (event) => {
            turn.completedText = appendCompletedAssistantText(turn.completedText, event);
            turn.tail = trackTurnTail(turn.tail, event);
            if (event.type === 'turn.started') this.recordOpeningAccepted(runId, state);
            this.handleRunnerUiEvent(runId, state, sink, event);
          },
          onAgentInputReady: () => this.handleAgentInputReady(runId, state, session),
          onAgentInputConsumed: (ids) => this.handleAgentInputConsumed(runId, state, session, ids),
          onPidChange: (pid) => { replaceRunProcess(runId, pid); this.recordWorkerProcess(runId, pid); },
        },
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
      this.flushDeferred(runId);
      this.flushAgentInputs(runId);
      if (session.pid !== undefined) { registerRunProcess(runId, session.pid); this.recordWorkerProcess(runId, session.pid); }
      setupComplete = true;
      const result = await session.result.finally(() => state.agentInputFlight?.settled).finally(() => this.requeueUnreadAtClose(runId, state, session));
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
  ): Promise<void> | undefined {
    if (this.holdsClosingWakes(runId) && !state.cancelled) {
      this.settleClosingWakes(runId, state, stepId, sink);
      return undefined;
    }
    if (!state.cancelled) {
      this.store.updateRun(runId, { continuationMessage: undefined });
      this.store.flush();
    }
    sink.sessionEnded(state.cancelled ? 'cancelled' : 'end_turn');
    const incomplete = !state.cancelled && this.stepLeftOpen(state, stepId, resumedNext);
    const kind = stepDecisions.continuationCloseKind(state.cancelled, incomplete,
      !state.cancelled && !incomplete && (state.idleClosed || this.unansweredWorkflowAsk(runId, state)));
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
  private settleClosingWakes(runId: string, state: ActiveRun, stepId: string, sink: UiEventSink): void {
    sink.sessionEnded('end_turn');
    // A clean close that leaves results undelivered is a failed delivery too.
    const delivery = this.closingWakeDecision(runId, true, false, this.owesDelivery(runId) ? WAKE_SESSION_CLOSED_ERROR : undefined);
    if (delivery === 'park') {
      // No turn end will show a human wait this session registered (hearsay-tools/cezarion#1234).
      this.surfaceHumanWait(runId, state);
      this.move(runId, 'park');
      return;
    }
    this.store.updateStep(runId, stepId, { status: 'failed', error: WAKE_SESSION_CLOSED_ERROR, finishedAt: new Date().toISOString() });
    this.store.appendEvent(runId, { type: 'step-end', stepId, status: 'failed' });
    this.move(runId, 'fail', { error: `continue failed: ${WAKE_SESSION_CLOSED_ERROR}`, finishedAt: new Date().toISOString(), currentStepId: undefined });
    this.store.appendEvent(runId, { type: 'lifecycle', message: `continue failed — ${WAKE_SESSION_CLOSED_ERROR}` });
    this.store.appendEvent(runId, { type: 'note', message: WAKE_DELIVERY_CAP_NOTE });
  }

  /** A Stop ended the Continue's session: cancel its step and the run. */
  private settleCancelledContinuation(runId: string, stepId: string): void {
    this.store.updateStep(runId, stepId, { status: 'cancelled', finishedAt: new Date().toISOString() });
    this.move(runId, 'cancel', { finishedAt: new Date().toISOString(), currentStepId: undefined });
    this.store.appendEvent(runId, { type: 'lifecycle', message: 'run cancelled' });
  }

  /** The Continue's step is done: settle the run, or the workflow step it resumed. Returns the
   *  settlement to wait for, or undefined when it queued the workflow remainder. */
  private settleDoneContinuation(runId: string, state: ActiveRun, stepId: string, close: ContinuationClose): Promise<void> | undefined {
    this.store.updateStep(runId, stepId, { status: 'done', finishedAt: new Date().toISOString() });
    this.store.appendEvent(runId, { type: 'step-end', stepId, status: 'done' });
    const completed = this.store.getRun(runId);
    const waitingIndex = completed ? this.waitingWorkflowStepIndex(completed) : -1;
    if (completed?.workflowDef && waitingIndex >= 0) {
      return this.settleResumedWorkflowStep(runId, state, stepId, completed, completed.workflowDef, waitingIndex, close);
    }
    return this.succeedContinuation(runId, stepId);
  }

  /** The Continue finished the workflow step it resumed: queue the workflow remainder, or settle
   *  the run when none is left or Finish was requested. */
  private settleResumedWorkflowStep(
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
      this.store.updateStep(runId, waitingStep.id, { status: 'done', finishedAt: new Date().toISOString() });
      this.store.appendEvent(runId, { type: 'step-end', stepId: waitingStep.id, status: 'done' });
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
      this.move(runId, 'requeue', { currentStepId: undefined, workflowResumeStepId: undefined });
      // The workflow remainder is a crash boundary. Persist it before the
      // finally block awaits worktree autosave and installs its in-memory job.
      this.store.flush();
      return undefined;
    }
    this.store.updateRun(runId, { workflowResumeStepId: undefined });
    return this.succeedContinuation(runId, stepId);
  }

  /** Settle the run after a successful Continue. */
  private async succeedContinuation(runId: string, stepId: string): Promise<void> {
    await this.settleSuccess(runId);
  }

  /** The Continue's session failed, or its settlement threw: fail its step, then park the run
   *  when it still holds wakes, else fail it. */
  private settleFailedContinuation(
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
    this.store.updateStep(runId, stepId, { status: 'failed', error: message, finishedAt: new Date().toISOString() });
    this.withdrawCezarHumanWaits(runId);
    const delivery = this.closingWakeDecision(runId, this.holdsClosingWakes(runId), state.cancelled, message);
    if (delivery === 'park') {
      // Retain the wait and scheduler wake source while closing this attempt.
      // settleSuccess only completes running/waiting steps, so its failure is durable.
      this.surfaceHumanWait(runId, state);
      this.store.appendEvent(runId, { type: 'step-end', stepId, status: 'failed' });
      this.move(runId, 'park', { error: `continue failed: ${message}` });
      return;
    }
    this.move(runId, 'fail-continue', {
      error: `continue failed: ${message}`,
      finishedAt: new Date().toISOString(),
      currentStepId: undefined,
    });
    this.store.appendEvent(runId, { type: 'lifecycle', message: `continue failed — ${message}` });
    if (delivery === 'capped') this.store.appendEvent(runId, { type: 'note', message: WAKE_DELIVERY_CAP_NOTE });
  }

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
      this.pendingJobs.set(runId, close.resumeWorkflow);
      this.queue.push(runId);
      void this.pump();
    }
  }

  // ---- execution -----------------------------------------------------------

  private async execute(runId: string, workflow: WorkflowDef, input: StartRunInput, startAt = 0): Promise<void> {
    if (this.workerExecutionStopped(runId)) { this.starting.delete(runId); return; }
    workerIdentity(this.store, this.repoRoot, runId);
    const state = createActiveRun({
      cwd: this.repoRoot,
      pendingHumanAsk: this.hasPendingHumanAsk(runId),
      autonomous: input.autonomous === true,
    });
    this.activate(runId, state);
    this.starting.delete(runId);
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
    if (state.idleClosed || this.unansweredWorkflowAsk(runId, state)) return 'settle';
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
  private async settleExecution(runId: string, state: ActiveRun, loop: StepLoop): Promise<void> {
    // Final autosave: the task branch ends holding the finished state; on a branch the
    // agent checked out, the work stays uncommitted and the handoff's Autosave section
    // says so (#1004).
    this.clearAutosaveTimer(state);
    await this.saveWorktree(runId, state, 'run finalize');

    if (this.preserveRunAfterDisposal(runId, state)) {
      this.clearIdleTimer(state);
      this.dropActive(runId);
      return;
    }
    const settlement = stepDecisions.executionSettlementKind(state.cancelled, loop.runError, loop.incompleteStepId,
      !state.cancelled && !loop.runError && !loop.incompleteStepId && (state.idleClosed || this.unansweredWorkflowAsk(runId, state)));
    if (settlement.kind === 'cancelled') {
      this.settleCancelledRun(runId);
    } else if (settlement.kind === 'failed') {
      this.settleFailedRun(runId, settlement.error, loop.deliveryCapped);
    } else if (settlement.kind === 'incomplete') {
      await this.settleIncompleteStep(runId, settlement.stepId);
    } else if (settlement.kind === 'idle') {
      await this.settleIdleClosedRun(runId, state);
      this.dropActive(runId);
      return;
    } else {
      await this.settleSuccess(runId);
    }
    this.clearIdleTimer(state);
    this.dropActive(runId);
  }

  /** The cancelled settlement: the run and its running and waiting steps become cancelled. */
  private settleCancelledRun(runId: string): void {
    const finishedAt = new Date().toISOString();
    const run = this.store.getRun(runId);
    for (const s of run?.steps ?? []) {
      if (s.status === 'running' || s.status === 'waiting') {
        this.store.updateStep(runId, s.id, { status: 'cancelled' });
      }
    }
    this.move(runId, 'cancel', { finishedAt, currentStepId: undefined });
    this.store.appendEvent(runId, { type: 'lifecycle', message: 'run cancelled' });
  }

  /** The failed settlement. A capped wake delivery adds the cap's note. */
  private settleFailedRun(runId: string, runError: string, deliveryCapped: boolean): void {
    const finishedAt = new Date().toISOString();
    this.move(runId, 'fail', { error: runError, finishedAt, currentStepId: undefined });
    this.store.appendEvent(runId, { type: 'lifecycle', message: `run failed — ${runError}` });
    if (deliveryCapped) this.store.appendEvent(runId, { type: 'note', message: WAKE_DELIVERY_CAP_NOTE });
  }

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
    const onEvent = (event: AgentEvent) => {
      if (this.disposedSessionEvent(runId, state, event)) return;
      if (event.type === 'image') {
        const saved = this.persistAttachment(runId, event.mediaType, event.data);
        if (saved) emit({ type: 'image', stepId: step.id, ...saved });
        return;
      }
      if (event.type === 'text') {
        this.clearUnreadInputTimer(state); // real content: the harness is working
        this.clearHeldHumanInputTimer(state);
        this.noteNoWaitNudgeContent(runId, state, event);
        turn.text = appendTurnText(turn.text, event.text);
        const text = stripAskMarker(stripTaskMarkers(stripMonitoringMarker(stripDoneMarker(event.text))), false);
        if (text) emit({ type: 'text', text, stepId: step.id });
        return;
      }
      if (event.type === 'input-unconsumed') { this.retireUnreadInputs(runId, state, event.inputIds, true); return; }
      if (event.type === 'tool-call' || event.type === 'tool-result') {
        this.clearUnreadInputTimer(state);
        this.clearHeldHumanInputTimer(state);
        this.noteNoWaitNudgeContent(runId, state, event);
      }
      emit({ ...event, stepId: step.id });
      if (event.type === 'cost') recordReportedCost(this.store, runId, step.id, state, backend, event.usd);
      if (event.type === 'error') { this.recordSessionFault(state, turn, event.message); return; }
      if (turn.sessionError || state.agentInputError) return;
      if (event.type === 'session') {
        // Codex/OpenCode mint their own session id — persist it so resume works.
        this.store.updateStep(runId, step.id, { sessionId: event.sessionId, backend,
          ...(event.sessionTransport ? { sessionTransport: event.sessionTransport } : {}) });
      }
      if (event.type === 'token-usage') {
        this.store.updateStep(runId, step.id, { tokensUsed: startTokens + event.tokensUsed });
      }
      const wakeDelay = claudeScheduleWakeupDelay(event, backend);
      if (wakeDelay !== undefined) turn.scheduleWakeup = wakeDelay;
      if (event.type === 'turn-end') {
        this.markTurnBoundary(runId, state, event);
        // v2 `turn.completed` already flushed the coalescers; the v1 turn
        // boundary flushes again (idempotent) as a backstop.
        sink.flushAll();
        this.trackTurnEnd(runId, turn.text); // titleSummary + diffStat (#389)
        const text = turn.text;
        const completedText = turn.completedText;
        turn.text = '';
        turn.completedText = '';
        turn.tail = 'none';
        const turnWakeDelay = turn.scheduleWakeup;
        turn.scheduleWakeup = undefined;
        this.endTurn(runId, state, sink, { stepId: step.id, text, completedText, scheduleWakeup: turnWakeDelay });
      }
    };

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
    const delegation = this.provisionSession(runId, state);
    // Read before the cancellation checks below, which also cover this await (#1576).
    const webhooksPart = await this.agentWebhooksPart();
    const ciTools = await this.provisionCiSession(runId, state);
    // Revalidate after provisioning, then let execute settle cancellation or
    // requeue a Finish-held step through its existing no-session paths.
    if (this.launchStale(runId, state, delegation, ciTools)) {
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
    const provisioned = await this.provisionRunSkills(runId, state, {
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

  /** Shutdown left this delegated run to restart recovery: its session's events are dropped, and an
   *  error still interrupts the session. */
  private disposedSessionEvent(runId: string, state: ActiveRun, event: AgentEvent): boolean {
    if (!this.isDisposedDelegatedRun(runId)) return false;
    if (event.type === 'error') state.session?.interrupt();
    return true;
  }

  /** A session's fault: the first one stands, an agent input error recorded before it wins, and the
   *  session is interrupted. */
  private recordSessionFault(state: ActiveRun, turn: SessionTurn, message: string): void {
    // Preserve the initiating fault: interrupt may fail an in-flight HTTP request.
    turn.sessionError ??= state.agentInputError ?? message;
    state.agentSessionError = turn.sessionError;
    state.session?.interrupt();
  }

  /** The session reached a turn end: retire the inputs it left unread, read the bundled inputs, and
   *  open the turn boundary with a fresh CI turn id. */
  private markTurnBoundary(runId: string, state: ActiveRun, event: Extract<AgentEvent, { type: 'turn-end' }>): void {
    this.retireUnreadInputs(runId, state, event.unconsumedInputIds ?? [], false);
    this.readBundledInputs(runId, state);
    state.waitWakeTurn = undefined;
    state.atTurnBoundary = state.session;
    state.ciTurnId = randomUUID();
  }

  /**
   * The account a step's session spawns under, resolved together with the temp-directory preflight
   * (#785): the step fails with a named, actionable error instead of spawning a backend whose shell
   * would return empty output. An account that would open another folder than its own fails the
   * same way (#1283). Returns the profile, or that error's message.
   */
  private async stepProfileFor(
    runId: string,
    stepBackend: RunnerId,
    options: { recordedProfileId?: string | undefined; stepId?: string | undefined },
  ): Promise<StepProfile | string> {
    try {
      return await this.agentEnvForStep(runId, stepBackend, options);
    } catch (err) {
      if (err instanceof AgentTempDirError || err instanceof AgentAccountUnavailableError) return err.message;
      throw err;
    }
  }

  /**
   * Pre-launch revalidation (hearsay-tools/cezarion#1632). Stop, a stopped execution, a replaced
   * active run or a root Finish can arrive while provisioning awaits. Then this launch's CI tools
   * and delegation are revoked, and the run state forgets each one only while it is still this
   * launch's. The caller settles the run.
   */
  private launchStale(runId: string, state: ActiveRun, delegation: LaunchDelegation, ciTools: LaunchCiTools): boolean {
    const launchRun = this.store.getRun(runId);
    if (!(state.cancelled || this.workerExecutionStopped(runId) || this.active.get(runId) !== state ||
      (launchRun && this.executionBlockedByRootFinish(launchRun)))) return false;
    ciTools?.revoke();
    if (state.revokeCiTools === ciTools?.revoke) state.revokeCiTools = undefined;
    delegation?.revoke();
    if (state.revokeDelegation === delegation?.revoke) state.revokeDelegation = undefined;
    return true;
  }

  /** A launch's opening message (hearsay-tools/cezarion#1632): the body, the open-waits footer, the
   *  resume context of a Continue's checkpoint, then the session-start context in front. */
  private launchOpening(
    runId: string,
    state: ActiveRun,
    stepId: string,
    launch: { body: string; ciTools: LaunchCiTools; checkpoint?: RunRecord['continuationMessage'] },
  ): LaunchOpening {
    // Opening prompts bypass live delivery; do not infer tools before provisioning finishes.
    const footer = openWaitsFooter(this.store.getRun(runId)?.waits ?? [], { tools: !!launch.ciTools });
    const prompt = withResumeContext(footer ? `${launch.body}\n\n${footer}` : launch.body, launch.checkpoint);
    const sessionContext = this.sessionContextFor(runId, state, stepId, prompt);
    return { userPrompt: sessionContext.prefix + prompt, handoffInjected: sessionContext.handoffInjected };
  }

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
        {
          onUiEvent: (event) => {
            turn.completedText = appendCompletedAssistantText(turn.completedText, event);
            turn.tail = trackTurnTail(turn.tail, event);
            this.handleRunnerUiEvent(runId, state, sink, event);
          },
          onAgentInputReady: () => this.handleAgentInputReady(runId, state, session),
          onAgentInputConsumed: (ids) => this.handleAgentInputConsumed(runId, state, session, ids),
          onPidChange: (pid) => { replaceRunProcess(runId, pid); this.recordWorkerProcess(runId, pid); },
        },
      );
    } catch (err) {
      ciTools?.revoke(); state.revokeCiTools = undefined;
      delegation?.revoke(); state.revokeDelegation = undefined;
      state.currentStepId = undefined;
      return err instanceof Error ? err.message : String(err);
    }
    return session;
  }

  /**
   * The system prompt after the skill playbook (hearsay-tools/cezarion#1632): the run's extra
   * prompt, the delegation instructions, the automations and project webhooks parts, the artifact
   * contract, then the handoff contract.
   */
  private launchSystemTail(launch: {
    extraSystemPrompt: string | undefined;
    delegation: LaunchDelegation;
    webhooksPart: string | undefined;
    env: StepProfile['env'];
    ciTools: LaunchCiTools;
    handoffInjected: boolean;
  }): string {
    return composeSystemPrompt(
      launch.extraSystemPrompt,
      launch.delegation?.instructions,
      this.automationsPart(),
      launch.webhooksPart,
      artifactInstructions(launch.env.CEZ_ARTIFACTS_DIR),
      handoffInstructions({ tools: !!launch.ciTools, handoffInjected: launch.handoffInjected }),
    );
  }

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
      this.flushDeferred(runId);
      this.flushAgentInputs(runId);
      if (session.pid !== undefined) { registerRunProcess(runId, session.pid); this.recordWorkerProcess(runId, session.pid); }
      setupComplete = true;
      const result = await session.result.finally(() => state.agentInputFlight?.settled).finally(() => this.requeueUnreadAtClose(runId, state, session));
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
    this.monitoring.delete(runId);
    this.waiting.delete(runId);
    state.nextStep = undefined;
    state.waitWakeTurn = undefined;
    state.atTurnBoundary = undefined;
    state.doneAtBoundary = undefined;
    state.parkAfterAck = undefined;
    state.session = undefined;
    state.currentStepId = undefined;
    state.interrupt = () => undefined;
  }

  /** Some adapters return assistant text only in their final result. Preserve that
   * evidence for collection without duplicating an already persisted transcript. */
  private persistWorkerAssistantResult(runId: string, stepId: string, text: string): void {
    if (this.store.getRun(runId)?.delegation?.role !== 'worker' || !text.trim()) return;
    const present = this.store.readEvents(runId).some(event => {
      if (event.stepId !== stepId) return false;
      const item = event.item as { kind?: string; role?: string; text?: string; parentItemId?: string } | undefined;
      return (event.type === 'text' && typeof event.text === 'string' && !!event.text.trim()) ||
        (event.type === 'item.completed' && item?.kind === 'message' && item.role === 'assistant' && !item.parentItemId && !!item.text?.trim());
    });
    if (!present) this.store.appendEvent(runId, { type: 'text', text, stepId });
  }

  /**
   * Protocol-v2 sink for one agent session (R2 step 2.1): the runner's
   * `onUiEvent` stream flows through here. Persisted snapshots ride the same
   * NDJSON file as v1 (the store stamps `seq`/`ts`, `appendEvent` fans them
   * out live too); coalesced `item.delta` flushes go out live-only via
   * `emitEphemeral` — raw deltas never hit disk (spec §performance
   * guardrails). One sink per session: cumulative usage dedup and the
   * item-shape cache are session-scoped, like the mapper state feeding them.
   */
  private makeUiSink(runId: string, stepId: string): UiEventSink {
    return new UiEventSink({
      persist: (event) => this.store.appendEvent(runId, { ...event, stepId }),
      emitLive: (event) => this.store.emitEphemeral(runId, { ...event, stepId }),
    });
  }

  /** Ask precedence: the question is pending, and no autonomous nudge goes beside it. Durable
   *  input and waits stay queued until an actual human answer. */
  private prepareHumanAsk(state: ActiveRun): void {
    state.autonomousNudgePending = undefined;
    state.pendingHumanAsk = true;
  }

  /** The human gate a human wait without a card raises (the monitoring line with re-checks off):
   * `PROSE_HUMAN_GATE` names it in the transcript. Keep the checkpoint through idle closure/restart
   * and hold worker input until a successful human delivery, just as for a structured ask. */
  private raiseHumanGate(runId: string, state: ActiveRun): void {
    this.store.appendEvent(runId, { type: 'note', stepId: state.currentStepId,
      code: PROSE_HUMAN_GATE, message: 'waiting for a human response to the assistant’s request' });
    this.prepareHumanAsk(state);
    clearUnreadInputTimer(state);
    clearHeldHumanInputTimer(state);
  }

  /** The open human wait nobody has shown the user yet (hearsay-tools/cezarion#1234): one this
   *  turn registered, or one a failure, close or crash caught before its turn end. */
  private unsurfacedHumanWait(runId: string): HumanWaitEntry | undefined {
    return openWaits(this.store.getRun(runId) ?? {}).find((wait): wait is HumanWaitEntry => wait.kind === 'human' && wait.askSeq === undefined);
  }

  /** The human wait this turn end raises: one nobody has seen yet. One registered while a question
   *  is pending waits on that question instead, and raises nothing. */
  private turnEndHumanWait(runId: string): HumanWaitEntry | undefined {
    const wait = this.unsurfacedHumanWait(runId);
    if (!wait || !this.hasPendingHumanAsk(runId)) return wait;
    this.markHumanWaitSurfaced(runId, wait);
    return undefined;
  }

  /** An alias's human wait, or the one already open: a run holds one. A full list opens none. */
  private openHumanAlias(runId: string, state: ActiveRun | undefined, via: WaitVia, card?: AskRequest): HumanWaitEntry | undefined {
    const run = this.store.getRun(runId);
    if (!run) return undefined;
    const source = via === 'budget' || via === 'no-wait' || via === 'completion' ? 'cezar' : 'agent';
    if (source === 'agent') this.withdrawCezarHumanWaits(runId);
    const open = openWaits(this.store.getRun(runId) ?? run).find((wait): wait is HumanWaitEntry => wait.kind === 'human');
    if (open || openWaits(this.store.getRun(runId) ?? run).length >= WAIT_LIMIT) return open;
    const wait: HumanWaitEntry = { id: randomUUID(), kind: 'human', source, via,
      registeredAt: new Date().toISOString(), phase: 'open', turnId: state?.ciTurnId ?? via, ...(card ? askCardFields(card) : {}) };
    try { this.store.commitWait(runId, wait); }
    catch (error) { console.warn(`[cez] human wait checkpoint failed: ${error instanceof Error ? error.message : String(error)}`); return undefined; }
    return wait;
  }

  /** Record which question a human wait is shown as: the pending card or gate, whose answer settles
   *  it. A card shown in place of the wait's own replaces it. A wait already shown is left alone. */
  private markHumanWaitSurfaced(runId: string, wait: HumanWaitEntry, shownCard?: AskRequest): void {
    const askSeq = this.pendingHumanAskSeq(runId);
    const latest = this.store.getRun(runId)?.waits?.find((entry): entry is HumanWaitEntry => entry.id === wait.id && entry.kind === 'human');
    if (askSeq === undefined || !latest || latest.phase !== 'open' || latest.askSeq !== undefined) return;
    const { questions: _questions, context: _context, ...kept } = latest;
    const card = shownCard ?? humanWaitCard(latest);
    try { this.store.commitWait(runId, { ...kept, ...(card ? askCardFields(card) : {}), askSeq }); }
    catch (error) { console.warn(`[cez] human wait checkpoint failed: ${error instanceof Error ? error.message : String(error)}`); }
  }

  /**
   * Show a human wait outside its turn end (hearsay-tools/cezarion#1234): at a boundary, at the
   * budget, or from the failure, close and recovery paths, where no turn end will. A card raises
   * `ask.requested` and goes to a worker's parent; a wait without one raises the human gate. A
   * question already pending is the one it waits on. A wait already shown is left alone. Cezar's
   * own wait is shown as its note instead (`showCezarHumanWait`).
   */
  private surfaceHumanWait(runId: string, state: ActiveRun | undefined, wait = this.unsurfacedHumanWait(runId)): void {
    if (!wait || wait.askSeq !== undefined) return;
    if (wait.source === 'cezar') { this.showCezarHumanWait(runId, state, wait); return; }
    if (this.pendingHumanAskSeq(runId) === undefined) {
      const run = this.store.getRun(runId);
      const stepId = state?.currentStepId ?? run?.currentStepId ?? run?.steps.at(-1)?.id;
      if (wait.questions) {
        this.store.appendEvent(runId, { type: 'ask.requested', requestId: randomUUID(), ...askCardFields({ questions: wait.questions, context: wait.context }), ...(stepId ? { stepId } : {}) });
        if (state) this.prepareHumanAsk(state);
      } else if (state) this.raiseHumanGate(runId, state);
      else {
        this.store.appendEvent(runId, { type: 'note', ...(stepId ? { stepId } : {}), code: PROSE_HUMAN_GATE, message: 'waiting for a human response to the assistant’s request' });
      }
    } else if (state) state.pendingHumanAsk = true;
    this.markHumanWaitSurfaced(runId, wait);
    this.routeWorkerQuestion(runId);
  }

  /**
   * Cezar's own human wait (`no-wait`, `budget`) is shown as a note, recorded as its `askSeq`, and
   * raises no human gate (hearsay-tools/cezarion#1234). The agent asked nothing: the run waits for
   * the user as the plain park did before these waits, so worker messages still wake it and its
   * wait registrations, `cezar_done` and the user's Finish are not refused. The user's message
   * settles it, and the agent's own wait or question replaces it (`withdrawCezarHumanWaits`).
   */
  private showCezarHumanWait(runId: string, state: ActiveRun | undefined, wait: HumanWaitEntry, note?: string): void {
    const run = this.store.getRun(runId);
    const stepId = state?.currentStepId ?? run?.currentStepId ?? run?.steps.at(-1)?.id;
    const shown = this.store.appendEvent(runId, { type: 'note', ...(stepId ? { stepId } : {}),
      message: note ?? (wait.via === 'no-wait' ? NO_WAIT_NOTE : wait.via === 'completion' ? 'completion blocked; waiting for you'
        : `automatic-wake budget spent (${MAX_AUTO_CONTINUES}); waiting for you`) });
    const latest = run?.waits?.find((entry): entry is HumanWaitEntry => entry.id === wait.id && entry.kind === 'human');
    if (!latest || latest.phase !== 'open' || latest.askSeq !== undefined) return;
    try { this.store.commitWait(runId, { ...latest, askSeq: shown.seq }); }
    catch (error) { console.warn(`[cez] human wait checkpoint failed: ${error instanceof Error ? error.message : String(error)}`); }
  }

  /** Cezar waited on the user only because the agent had nothing to wait on: the agent's own wait
   *  or question replaces that wait (hearsay-tools/cezarion#1234). It also ends with the session
   *  that opened it, so a close, an idle close or a failure settles as the plain park did. */
  private withdrawCezarHumanWaits(runId: string): void {
    const ids = openWaits(this.store.getRun(runId) ?? {}).filter(isCezarHumanWait).map(wait => wait.id);
    if (!ids.length) return;
    try { this.store.commitOutcome(runId, { kind: 'cancelled', waitIds: ids }); }
    catch (error) { console.warn(`[cez] human wait checkpoint failed: ${error instanceof Error ? error.message : String(error)}`); }
  }

  /** Whether a closing session leaves the run waits to park on. Cezar's own human waits end with the
   *  session, even when the store refused their cancellation (`withdrawCezarHumanWaits`). */
  private holdsAgentWaits(runId: string): boolean {
    return (this.store.getRun(runId)?.waits ?? []).some(wait => !isCezarHumanWait(wait));
  }

  /** A valid ask line replaces the card of the human wait its turn registered. It is saved
   *  before the turn end can re-enter a boundary (Cursor print's ready callback from
   *  `discardQueuedMessages`), so a wait shown there shows the later card. */
  private latchAskLineCard(runId: string, wait: HumanWaitEntry | undefined, turn: { ask: AskRequest | null; waitCard: boolean }): void {
    if (!wait || !turn.ask || turn.waitCard) return;
    const latest = this.store.getRun(runId)?.waits?.find((entry): entry is HumanWaitEntry => entry.id === wait.id && entry.kind === 'human');
    if (!latest || latest.phase !== 'open' || latest.askSeq !== undefined) return;
    const { context: _replaced, ...kept } = latest;
    try { this.store.commitWait(runId, { ...kept, ...askCardFields(turn.ask) }); }
    catch (error) { console.warn(`[cez] human wait checkpoint failed: ${error instanceof Error ? error.message : String(error)}`); }
  }

  /** Read fresh: a boundary the turn end re-enters (Cursor print's ready callback from
   *  `discardQueuedMessages`) may have shown the wait already, and its card stands. */
  private humanWaitShown(runId: string, wait: HumanWaitEntry | undefined): boolean {
    return !!wait && this.store.getRun(runId)?.waits?.some(entry => entry.id === wait.id && entry.kind === 'human' && entry.askSeq !== undefined) === true;
  }

  /** The turn end raised a card or the gate: record the human wait it shows. A turn that registered
   *  none opens the ask line's. */
  private recordTurnEndQuestion(runId: string, state: ActiveRun, wait: HumanWaitEntry | undefined, ask: AskRequest | null): void {
    const shown = wait ?? (ask ? this.openHumanAlias(runId, state, 'ask-line', ask) : undefined);
    if (shown) this.markHumanWaitSurfaced(runId, shown, ask ?? undefined);
  }

  /** Native backend asks arrive before turn-end. Persist and park immediately
   * so the cockpit shows attention and the run releases its workspace slot. */
  private handleRunnerUiEvent(runId: string, state: ActiveRun, sink: UiEventSink, event: UiEvent): void {
    if (this.isDisposedDelegatedRun(runId)) return;
    recordUsageUiEvent(this.store, runId, state, event);
    sink.handle(event);
    if (state.cancelled) return;
    this.noteNoWaitNudgeContent(runId, state, event);
    if (isRunnerActivity(event)) {
      if (state.autonomousNudgePending) { state.autonomousNudgePending = undefined; this.clearIdleTimer(state); }
      clearHeldHumanInputTimer(state);
      state.atTurnBoundary = undefined; state.doneAtBoundary = undefined; state.parkAfterAck = undefined;
    }
    if (event.type === 'permission.requested') {
      this.handlePermissionRequested(runId, state, event.requestId);
      return;
    }
    if (event.type === 'permission.resolved' && state.pendingPermissions?.delete(event.requestId)) {
      this.handlePermissionResolved(runId, state, state.pendingPermissions);
      return;
    }
    const ask = askPayloadOf(event);
    if (ask) {
      this.handleNativeAskRequested(runId, state, ask);
      return;
    }
    // Pi can resume autonomously when an async subagent completes — the mapper
    // synthesizes a parent `turn.started` for that work (#61). Nested child
    // items without a parent turn must not unpark monitoring or worker waits (#121).
    // A list worker park (hearsay-tools/cezarion#1235), Cezar's completion wait included
    // (hearsay-tools/cezarion#1301), resumes the same way.
    if (this.waiting.has(runId) && (this.monitoring.has(runId) || this.parkedOnWorkers(runId)) && isRunnerActivity(event)) {
      this.resumeParkedRun(runId, state);
    }
  }

  private handlePermissionRequested(runId: string, state: ActiveRun, requestId: string): void {
    (state.pendingPermissions ??= new Set()).add(requestId);
    this.prepareHumanAsk(state);
    state.session?.discardQueuedMessages();
    this.clearIdleTimer(state);
    clearUnreadInputTimer(state);
    clearHeldHumanInputTimer(state);
    this.monitoring.delete(runId); // released below; its waits stay open
    this.waiting.add(runId);
    this.move(runId, 'park', { hasPendingPermission: true });
    if (state.currentStepId) this.store.updateStep(runId, state.currentStepId, { status: 'waiting' });
    this.releaseSlot();
    // Authorization is the human's, even when this run is an owned worker.
  }

  private handlePermissionResolved(runId: string, state: ActiveRun, pendingPermissions: ReadonlySet<string>): void {
    if (!pendingPermissions.size) {
      this.store.updateRun(runId, { hasPendingPermission: false });
      state.pendingHumanAsk = this.hasPendingHumanAsk(runId);
      if (!state.pendingHumanAsk && state.session?.open && !this.store.getRun(runId)?.stopping) {
        this.resumeParkedRun(runId, state);
        this.flushAgentInputs(runId);
      }
    }
  }

  private handleNativeAskRequested(runId: string, state: ActiveRun, ask: NonNullable<ReturnType<typeof askPayloadOf>>): void {
    this.prepareHumanAsk(state);
    // A native ask is a human wait the user already sees (hearsay-tools/cezarion#1234).
    const questions = askRequestOf({ questions: ask.questions })?.questions;
    const wait = this.openHumanAlias(runId, state, 'native-ask', questions ? { questions } : undefined);
    if (wait) this.markHumanWaitSurfaced(runId, wait, questions ? { questions } : undefined);
    this.clearIdleTimer(state);
    this.monitoring.delete(runId); // released below; its waits stay open
    this.waiting.add(runId);
    this.move(runId, 'park');
    if (state.currentStepId) this.store.updateStep(runId, state.currentStepId, { status: 'waiting' });
    this.releaseSlot();
    this.routeWorkerQuestion(runId);
  }

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
  private async settleSuccess(runId: string, durableRootFinish = false, keepStepId?: string): Promise<void> {
    const state = this.active.get(runId);
    const continuationGeneration = this.continuationGenerations.get(runId);
    if (this.deferParentCompletion(runId)) return;
    const run = this.store.getRun(runId);
    let review = false;
    if (run?.worktreePath && existsSync(run.worktreePath)) {
      review = await this.successNeedsReview(run, run.worktreePath, durableRootFinish);
    }
    // Diff/config I/O can race cancellation or a replacement execution. Re-read
    // the record before touching steps, and never settle another session's work.
    const current = this.store.getRun(runId);
    if (!current || this.successSuperseded(runId, current.status, state, continuationGeneration)) return;
    if (state?.cancelled) {
      this.settleCancelledSuccess(runId, current);
      return;
    }
    // A worker's accepted continuation or a new child can defer parent completion.
    if (this.deferParentCompletion(runId)) return;
    if (durableRootFinish) {
      // A later explicit cancellation wins over a slow diff. Publication/cascade
      // follows the atomic terminal/step checkpoint, never the other way around.
      const exit = review ? 'succeed-review' as const : 'succeed' as const;
      if (!transitionVia(exit, () => this.store.getRun(runId), () => this.store.commitRootFinishSuccess(runId, RUN_EXITS[exit].to))) return;
    } else {
      this.commitOrdinarySuccess(runId, review, keepStepId);
    }
    this.store.appendEvent(runId, {
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
  private async successNeedsReview(run: RunRecord, worktreePath: string, durableRootFinish: boolean): Promise<boolean> {
    // An unresolved autosave may still own the real index. Conservatively
    // treat its retained work as reviewable without starting `git add -N`.
    const diff = this.autosaveCleanupBlocker(run.id)
      ? 'autosave cleanup pending'
      : await worktreeDiff(worktreePath, run.baseBranch ?? 'HEAD');
    if (durableRootFinish && diff.startsWith('(diff failed')) throw new Error('parent finish diff unavailable');
    const hasDiff = diff.trim().length > 0 && !diff.startsWith('(diff failed');
    const config = await loadConfig(this.repoRoot);
    return hasDiff && reviewGateEnabled(config) && run.autonomous !== true;
  }

  /** True when the success settlement must not write: the run is no longer live, a newer
   *  continuation started, or another execution replaced the one that began settling. */
  private successSuperseded(
    runId: string,
    status: RunRecord['status'],
    state: ActiveRun | undefined,
    continuationGeneration: symbol | undefined,
  ): boolean {
    const active = this.active.get(runId);
    // Disposal clears active, but cannot revoke an already accepted Finish/Stop.
    // A different active state is still a replacement, even after disposal.
    const disposedWithTerminalIntent = this.disposed && active === undefined && (state?.finishRequested || state?.cancelled);
    return !['queued', 'running', 'waiting'].includes(status) ||
      this.continuationGenerations.get(runId) !== continuationGeneration ||
      (active !== state && !disposedWithTerminalIntent);
  }

  /** A Stop accepted while the success settlement read the diff: the run and its running and
   *  waiting steps become cancelled, and a step keeps a finish time it already has. */
  private settleCancelledSuccess(runId: string, current: RunRecord): void {
    const finishedAt = new Date().toISOString();
    for (const step of current.steps) {
      if (step.status === 'running' || step.status === 'waiting') {
        this.store.updateStep(runId, step.id, { status: 'cancelled', finishedAt: step.finishedAt ?? finishedAt });
      }
    }
    this.move(runId, 'cancel', { finishedAt, currentStepId: undefined });
    this.store.appendEvent(runId, { type: 'lifecycle', message: 'run cancelled' });
  }

  /** The ordinary success path (not a root finish): the steps that settle as done, then the run
   *  as `review` or `done`. */
  private commitOrdinarySuccess(runId: string, review: boolean, keepStepId: string | undefined): void {
    const finishedAt = new Date().toISOString();
    // An idle-closed Continue remains waiting until the whole task succeeds.
    // Complete those intermediate steps before publishing terminal run status.
    // A worker's incomplete earlier step stays `waiting`: a parent resume re-enters it (hearsay-tools/cezarion#1620).
    for (const step of this.store.getRun(runId)?.steps ?? []) {
      if (settlesAsDone(step, keepStepId)) {
        this.store.updateStep(runId, step.id, { status: 'done', finishedAt: step.finishedAt ?? finishedAt });
      }
    }
    this.store.updateRun(runId, {
      status: transition(review ? 'succeed-review' : 'succeed', () => this.store.getRun(runId)),
      ...settledRootFinishPatch(this.store, runId),
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
  private async settleIdleClosedRun(runId: string, state: ActiveRun): Promise<void> {
    const run = this.store.getRun(runId);
    if (run?.delegation?.role === 'worker') {
      await this.settleIdleClosedWorker(runId);
      return;
    }
    if (!run || !state.autonomousNudgePending || run.waits?.length || this.hasPendingHumanAsk(runId)) return;
    for (const step of run.steps) {
      if (step.status === 'running') this.store.updateStep(runId, step.id, { status: 'waiting' });
    }
    this.move(runId, 'park');
    this.store.flush();
  }

  /** An ordinary owned worker cannot accept an inactive Continue. Once its
   * idle-closed process has ended, publish the same terminal outcome recovery
   * would produce so its parent can collect it. Explicit asks and worker waits
   * remain durable attention states. */
  private async settleIdleClosedWorker(runId: string, keepStepId?: string): Promise<boolean> {
    // An idle close supersedes Cezar's fallback question, so the worker settles as its plain park
    // did (hearsay-tools/cezarion#1301).
    this.supersedeWorkerFallback(runId);
    const run = this.store.getRun(runId);
    if (run?.delegation?.role !== 'worker' || this.hasPendingHumanAsk(runId)) return false;
    const finishedAt = new Date().toISOString();
    if (run.invalidAsk) {
      for (const step of run.steps) if (step.status === 'waiting' || step.status === 'running') {
        this.store.updateStep(runId, step.id, { status: 'failed', error: 'invalid structured question', finishedAt });
      }
      this.move(runId, 'fail', { error: 'invalid structured question', finishedAt, currentStepId: undefined });
      return true;
    }
    for (const step of run.steps) {
      if (settlesAsDone(step, keepStepId)) {
        this.store.updateStep(runId, step.id, { status: 'done', finishedAt });
      }
    }
    await this.settleSuccess(runId, false, keepStepId);
    return true;
  }

  /**
   * An earlier workflow step whose session closed without a done: a clean exit, an idle close, or
   * a Continue that resumed it and closed the same way (hearsay-tools/cezarion#1620). The step stays
   * `waiting` and the tail never starts. A root waits for Continue, which resumes the step. An owned
   * worker settles as a single-step task's close does, so its parent can collect it; the step stays
   * `waiting`, and a parent resume re-enters it. A question still pending keeps either one waiting.
   */
  private async settleIncompleteStep(runId: string, stepId: string): Promise<void> {
    const run = this.store.getRun(runId);
    if (!run) return;
    for (const step of run.steps) if (step.status === 'running') this.store.updateStep(runId, step.id, { status: 'waiting' });
    // A failed attempt a continuation recovers stays failed: the resume cursor finds it as it is.
    if (run.steps.find(step => step.id === stepId)?.status !== 'failed') this.store.updateStep(runId, stepId, { status: 'waiting' });
    this.store.appendEvent(runId, { type: 'lifecycle', stepId, message: `step "${stepId}" ended without done — Continue to resume it` });
    if (run.delegation?.role === 'worker' && await this.settleIdleClosedWorker(runId, stepId)) return;
    this.move(runId, 'park');
    this.store.flush();
  }

  private persistPastedAttachments(runId: string, content: readonly PastedContent[]): PersistedAttachment[] {
    return this.attachments.persistPastedAttachments(runId, content);
  }

  private persistAttachment(runId: string, mediaType: string, data: string, namePrefix: string = 'screenshot'): PersistedAttachment | null {
    return this.attachments.persistAttachment(runId, mediaType, data, namePrefix);
  }

  /** Shared stop/input/liveness guards for an automatic continuation. */
  private canAutoContinue(runId: string, state: ActiveRun): boolean {
    const run = this.store.getRun(runId);
    return !!run && !this.disposed && !run.stopping && !state.cancelled && !state.finishRequested &&
      !state.agentInputError && !state.pendingHumanAsk && !this.hasPendingHumanAsk(runId) && !!state.session?.open &&
      !this.workerExecutionStopped(runId) && !this.executionBlockedByRootFinish(run) && !run.waits?.length &&
      !state.agentInputFlight && !harnessOwesInput(state) && !this.hasQueuedAgentInputs(runId);
  }

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
    text = stepScopedNudge(AUTONOMOUS_NUDGE, !!state.session && state.nextStep?.session === state.session)): boolean {
    const session = state.session;
    if (!state.autonomous || !session || !this.canAutoContinue(runId, state)) return false;
    state.autonomousNudgePending = undefined;
    this.clearIdleTimer(state);
    // One budget with the timer wakes (hearsay-tools/cezarion#1234).
    if (this.automaticWakes(runId) >= MAX_AUTO_CONTINUES) {
      this.store.appendEvent(runId, { type: 'note', stepId, message: `autonomous — safety cap reached (${MAX_AUTO_CONTINUES}); automatic continuation paused` });
      return false;
    }
    const content: ContentBlock[] = [{ type: 'text', text }];
    // sendAgentMessage deliberately refuses portable asks on some native wires.
    // The existing answer transport clears that marker, but is safe ONLY for this
    // fresh turn-end ask line: the guards above exclude every pending native/persisted
    // question. Do not route via deliverMessage, which attributes a human answer.
    // Ordinary nudges keep #505's acknowledged agent-input failure semantics.
    const sent = ask ? session.sendMessage(content) : this.submitAgentInput(runId, state, content);
    if (!sent) {
      // An unregistered ask line uses sendMessage: its POST may still be awaiting ACK
      // after the next SSE turn ends. It is not an agentInputFlight. Keep this
      // exact boundary running until onAgentInputReady retries, without charging
      // the cap or claiming delivery. Missing readiness closes via the idle bound.
      if (!ask && session.open && !state.agentInputError && !state.agentSessionError) {
        state.autonomousNudgePending = session;
        this.armIdleTimer(runId, state);
      }
      return false;
    }
    if (ask) this.resumeParkedRun(runId, state);
    // The marker is stripped from visible text. Retain the question as a note,
    // never an ask card or a fabricated human-input-delivered acknowledgement.
    if (ask) this.store.appendEvent(runId, {
      type: 'note', stepId,
      message: `${AUTONOMOUS_ASK_NOTE}: ${ask.questions.map(question => question.question).join(' | ')}`,
    });
    const spent = this.chargeAutomaticWake(runId);
    this.store.appendEvent(runId, {
      type: 'note', stepId,
      message: `autonomous — continuing without pausing (${spent}/${MAX_AUTO_CONTINUES})`,
    });
    return true;
  }

  /**
   * A turn end on the runner's own signal, shared by the fresh step's and the Continue's turn-end
   * handlers (hearsay-tools/cezarion#1525): read what the turn said, keep it for an acknowledgement
   * that lands after the turn end (`parkAfterAck`), then settle it (`settleTurn`). Nothing reads the
   * turn's prose beyond its markers.
   */
  private endTurn(runId: string, state: ActiveRun, sink: UiEventSink, turn: {
    stepId: string; text: string; completedText: string; scheduleWakeup: number | null | undefined;
  }): void {
    const sessionOpen = !state.cancelled && !!state.session?.open;
    const humanWait = this.turnEndHumanWait(runId);
    const doneRequest = this.takeDoneRequest(state);
    const read = classifyTurnEnd(turn.text, turn.completedText, {
      sessionOpen, pendingHumanAsk: !!state.pendingHumanAsk,
      scheduledWake: turn.scheduleWakeup !== undefined,
      liveWorkers: this.monitorsLiveWorkers(runId),
      humanWait, doneRequested: !!doneRequest,
    });
    const { monitoring, humanGate, ask } = read;
    this.latchAskLineCard(runId, humanWait, read);
    discardQueuedMessagesOnAsk(state.session, read);
    // The turn that just ended answered a nudge: one flag per cause (hearsay-tools/cezarion#1234,
    // hearsay-tools/cezarion#1301).
    const nudgedLastTurn = state.noWaitNudged === state.session;
    state.noWaitNudged = undefined;
    state.completionNudgeAnswered = state.completionNudged === state.session ? state.session : undefined;
    state.completionNudged = undefined;
    const askNudged = this.prepareTurnAsk(runId, state, { stepId: turn.stepId, sessionOpen, humanWait }, read);
    state.parkAfterAck = sessionOpen && state.session
      ? { session: state.session, monitoring, humanGate, nudgedLastTurn, scheduleWakeup: turn.scheduleWakeup } : undefined;
    const settled = this.settleTurn(runId, state, 'turn-end', {
      stepId: turn.stepId, monitoring, humanGate, ask, askNudged, humanWait, sink,
      done: read.done, doneRequest, nudgedLastTurn, scheduleWakeup: turn.scheduleWakeup,
    });
    // A turn that completed is the ONLY evidence the provider's window actually reopened, so
    // it is what retires the consecutive-resume counter — which in turn releases the account
    // hold for every other task queued behind it (spec
    // 2026-08-03-auto-resume-after-usage-limit). `settleSuccess` does the same for a run that
    // finishes outright; this covers the far more common "parked for the user" ending.
    if (settled && this.store.getRun(runId)?.autoResumeAttempts !== undefined) {
      this.store.updateRun(runId, { autoResumeAttempts: undefined });
    }
  }

  /** Prepare the turn's ask before the turn end settles (`endTurn`): its notes, the `invalidAsk`
   *  flag, and the ask or human gate the run parks on. True when the autonomous nudge went instead
   *  of the ask line. */
  private prepareTurnAsk(runId: string, state: ActiveRun, turn: { stepId: string; sessionOpen: boolean; humanWait: HumanWaitEntry | undefined },
    read: TurnEndRead): boolean {
    const { humanGate, ask, notes: askNotes, waitCard } = read;
    for (const note of askNotes) this.store.appendEvent(runId, { type: 'note', stepId: turn.stepId, ...note });
    this.store.updateRun(runId, { invalidAsk: !ask && askNotes.length > 0 ? true : undefined });
    // An autonomous run registers no newly parsed ask line before the budget, as `cezar_ask`
    // refuses it (hearsay-tools/cezarion#1234): the autonomous nudge goes instead. Do this before
    // prepareHumanAsk latches it; an existing/native ask or a human wait's card still blocks the helper.
    const askNudged = !!ask && !waitCard && turn.sessionOpen && this.tryAutonomousNudge(runId, state, turn.stepId, ask);
    if (ask && !askNudged) this.prepareHumanAsk(state);
    if (humanGate && !ask && !state.pendingHumanAsk) this.raiseHumanGate(runId, state);
    if (humanGate && !ask) this.recordTurnEndQuestion(runId, state, turn.humanWait, null);
    return askNudged;
  }

  /** The turn end an entry settles after it (`settleIdleBoundary`, `handleAgentInputReady`), and
   *  the completion gate's live refusal: what `parkAfterAck` kept of it. */
  private boundaryTurn(runId: string, state: ActiveRun, session: AgentSession, done: boolean): SettledTurn {
    const ack = state.parkAfterAck?.session === session ? state.parkAfterAck : undefined;
    return {
      stepId: state.currentStepId, humanGate: !!ack?.humanGate, ask: null, askNudged: false, done,
      // A done names no monitoring, as the turn end's own reading of it does (`classifyTurnEnd`).
      monitoring: !done && !!ack && (ack.monitoring || (!ack.humanGate && this.monitorsLiveWorkers(runId))),
      nudgedLastTurn: !!ack?.nudgedLastTurn, scheduleWakeup: ack?.scheduleWakeup,
    };
  }

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
    refusal?: CompletionRefusal): boolean {
    const session = state.session;
    const stepId = turn.stepId;
    // A done goes to the completion gate first (hearsay-tools/cezarion#1301). A refused done is not a done.
    const gate = refusal ?? (turn.done && session?.open ? this.completionGate(runId) : 'accept');
    if (gate === 'held') return this.settleHeldTurn(runId, state, entry, turn);
    const refused = typeof gate === 'object' ? gate : undefined;
    if (entry === 'ready') state.autonomousNudgePending = undefined;
    let noted = false;
    const noteRefusal = () => {
      if (!refused || noted) return;
      noted = true;
      this.store.appendEvent(runId, { type: 'note', tone: 'warning', ...(stepId ? { stepId } : {}), message: `Completion blocked: ${refused.message}` });
    };
    if (turn.askNudged) return this.settleAskNudgedTurn(runId, state, entry, turn);
    const { decision, tried } = this.decideSettledTurn(runId, state, session, entry, turn, refused, noteRefusal);
    if (entry === 'turn-end' && !this.settleTurnEndInput(runId, state, turn, tried, decision)) return false;
    // A run an earlier entry already parked keeps that park: a second one would free its slot twice.
    if (entry !== 'turn-end' && decision.kind === 'park' && this.waiting.has(runId)) return true;
    const outcome = this.carryOutTurnEnd(runId, state, stepId, decision, refused, noteRefusal);
    if (outcome.kind === 'done') return false;
    this.settledTurnOutcome(runId, entry, outcome);
    return true;
  }

  /** The completion gate held the done (`settleTurn`). A stopped root, or a question that parked
   *  for the user: the done stays at the boundary. False when the input checkpoint failed. */
  private settleHeldTurn(runId: string, state: ActiveRun, entry: 'turn-end' | 'ack' | 'ready' | 'gate', turn: SettledTurn): boolean {
    if (entry === 'turn-end') {
      this.recordDoneAtBoundary(state, true, turn.doneRequest);
      clearHeldHumanInputTimer(state);
      if (state.agentInputError) return false;
    }
    this.settledTurnOutcome(runId, entry, { kind: 'park', keepsSlot: this.monitoring.has(runId) });
    return true;
  }

  /** The ask line's autonomous nudge went instead of the question (`settleTurn`): its turn is the
   *  next one. False when the input checkpoint failed. */
  private settleAskNudgedTurn(runId: string, state: ActiveRun, entry: 'turn-end' | 'ack' | 'ready' | 'gate', turn: SettledTurn): boolean {
    this.recordDoneAtBoundary(state, false, turn.doneRequest);
    clearHeldHumanInputTimer(state);
    if (state.agentInputError) return false;
    this.settledTurnOutcome(runId, entry, { kind: 'nudge', cause: 'no-wait', autonomous: true });
    return true;
  }

  /** What the turn-end rule decides for a settled turn (`settleTurn`): the timer alias the rule
   *  reads, the first decision and the done it keeps, then the owed input a `take-input` decision
   *  tries and the decision after it. `tried` is true when that input was tried. */
  private decideSettledTurn(runId: string, state: ActiveRun, session: AgentSession | undefined, entry: 'turn-end' | 'ack' | 'ready' | 'gate',
    turn: SettledTurn, refused: CompletionRefusal | undefined, noteRefusal: () => void): { decision: TurnEndDecision; tried: boolean } {
    // A turn end opens it once owed input was tried; this turn's ask keeps that input back, so its
    // monitoring line opens the timer now. A refused done decides before any alias, as before.
    if (entry !== 'turn-end' || (turn.ask && !refused)) this.openTurnTimerAlias(runId, state, session, turn);
    // The turn end and the gate deliver owed input; an acknowledgement or readiness finds it already tried.
    const decision = decideTurnEnd(this.turnEndFacts(runId, state, session, turn, refused, entry === 'turn-end' || entry === 'gate' ? undefined : false));
    this.keepSettledDone(state, entry, turn, refused, decision);
    if (decision.kind !== 'take-input') return { decision, tried: false };
    if (decision.refused) noteRefusal();
    const taken = this.takeOwedInput(runId, state, turn);
    if (!taken) this.openTurnTimerAlias(runId, state, session, turn);
    return { decision: decideTurnEnd(this.turnEndFacts(runId, state, session, turn, refused, taken)), tried: true };
  }

  /** The facts the turn-end rule reads for a settled turn (`decideSettledTurn`). `session` is the
   *  session `settleTurn` found. */
  private turnEndFacts(runId: string, state: ActiveRun, session: AgentSession | undefined, turn: SettledTurn,
    refused: CompletionRefusal | undefined, inputTaken: boolean | undefined): TurnEndFacts {
    const run = this.store.getRun(runId);
    return {
      sessionOpen: !state.cancelled && !!session?.open,
      done: turn.done,
      ...(refused ? { doneRefused: { liveWorkers: refused.liveWorkerIds.length > 0 || !!refused.requestIds?.length } } : {}),
      inputInFlight: !!state.agentInputFlight,
      inputQueued: this.hasQueuedAgentInputs(runId, state.agentInputFlight?.inputIds),
      inputTaken,
      nudgePending: !!session && state.autonomousNudgePending === session,
      turnAsk: !!turn.ask,
      nativeAsk: !!state.pendingHumanAsk,
      question: !!turn.ask || turn.humanGate || !!state.pendingHumanAsk || this.hasPendingHumanAsk(runId),
      agentWaits: this.holdsAgentWaits(runId),
      cezarHumanWait: (run?.waits ?? []).some(isCezarHumanWait),
      stepScope: !!session && state.nextStep?.session === session,
      noWaitNudgedLastTurn: turn.nudgedLastTurn,
      completionNudgedLastTurn: (!!session && state.completionNudgeAnswered === session) || (!!refused?.requestIds?.length && !!state.sentRequestRefused),
      autonomous: !!state.autonomous,
      budgetSpent: this.automaticWakes(runId) >= MAX_AUTO_CONTINUES,
      tools: !state.toolless,
    };
  }

  /** The monitoring line and `ScheduleWakeup` open their timer before the rule reads the waits, as
   *  the `cezar_wait` timer they alias. An autonomous nudge waiting for readiness keeps precedence. */
  private openTurnTimerAlias(runId: string, state: ActiveRun, session: AgentSession | undefined, turn: SettledTurn): void {
    if (turn.monitoring && session?.open && state.autonomousNudgePending !== session) this.openTimerAlias(runId, state, turn.scheduleWakeup);
  }

  /** The done the first decision keeps at the boundary (`decideSettledTurn`): a turn end records
   *  it, and an acknowledgement drops a refused done the rule does not keep. */
  private keepSettledDone(state: ActiveRun, entry: 'turn-end' | 'ack' | 'ready' | 'gate', turn: SettledTurn,
    refused: CompletionRefusal | undefined, decision: TurnEndDecision): void {
    const keepDone = turn.done && (!refused || (decision.kind === 'defer' && !!decision.keepDone));
    if (entry === 'turn-end') this.recordDoneAtBoundary(state, keepDone, turn.doneRequest, turn.done);
    else if (entry === 'ack' && turn.done && !keepDone) state.doneAtBoundary = undefined;
  }

  /** The owed input a `take-input` decision tries (`decideSettledTurn`). True when input was taken.
   *  #505: input the harness accepted but has not read yet runs as its next turn. An in-flight
   *  submission is settled by its acknowledgement (parkAfterAck), not here. */
  private takeOwedInput(runId: string, state: ActiveRun, turn: SettledTurn): boolean {
    return this.flushAgentInputs(runId) || (!turn.humanGate && harnessOwesInput(state)) ||
      !!state.agentInputFlight || harnessHoldsHumanInput(state);
  }

  /** A turn end's own steps after the rule decided (`settleTurn`): the unread and held input timers,
   *  then the `CEZ:ASK` card. False when the input checkpoint failed. */
  private settleTurnEndInput(runId: string, state: ActiveRun, turn: SettledTurn, tried: boolean, decision: TurnEndDecision): boolean {
    if (tried) this.armUnreadInputTimer(runId, state);
    if (tried && harnessHoldsHumanInput(state)) this.armHeldHumanInputTimer(runId, state);
    else clearHeldHumanInputTimer(state);
    if (state.agentInputError) return false;
    // `CEZ:ASK` surfaces the structured question as an ask card (#473) before the rule parks on it.
    if (turn.ask && turn.sink && decision.kind !== 'closed' && decision.kind !== 'input' && !this.humanWaitShown(runId, turn.humanWait)) {
      emitAskRequested(turn.sink, turn.ask);
      this.recordTurnEndQuestion(runId, state, turn.humanWait, turn.ask);
      this.routeWorkerQuestion(runId);
    }
    return true;
  }

  /** Carry out what the turn-end rule decided, and report how it left the run. A refusal the
   *  decision follows is noted first; then the decision kind's own method runs (`turnEndCarriers`). */
  private carryOutTurnEnd(runId: string, state: ActiveRun, stepId: string | undefined, decision: TurnEndDecision,
    refused: CompletionRefusal | undefined, noteRefusal: () => void): TurnEndOutcome {
    const session = state.session;
    const decisionRefused = 'refused' in decision && !!decision.refused;
    if (decisionRefused) noteRefusal();
    // A refusal that settles the turn end replaces Cezar's own human wait, as the agent's own wait would.
    const settlesRefusal = !!refused && !decisionRefused && !(decision.kind === 'defer' && decision.keepDone);
    if (settlesRefusal) this.withdrawCezarHumanWaits(runId);
    const carryOut = this.turnEndCarriers[decision.kind] as (carry: TurnEndCarry, decision: TurnEndDecision) => TurnEndOutcome;
    return carryOut({ runId, state, session, stepId, refused, noteRefusal, settlesRefusal }, decision);
  }

  /** The method for each decision kind (`carryOutTurnEnd`). A closed session settles elsewhere, and
   *  owed input runs as the session's next turn: the run keeps running. */
  private readonly turnEndCarriers: TurnEndCarriers = {
    closed: () => ({ kind: 'running' }),
    input: () => ({ kind: 'running' }),
    'take-input': () => ({ kind: 'running' }),
    defer: (carry, decision) => this.carryOutDefer(carry, decision),
    done: carry => this.carryOutDone(carry),
    park: carry => this.carryOutPark(carry),
    'completion-wait': carry => this.carryOutCompletionWait(carry),
    'human-wait': (carry, { via }) => via === 'completion' ? this.carryOutCompletionHumanWait(carry) : this.carryOutHumanWait(carry, via),
    nudge: (carry, decision) => decision.cause === 'completion' ? this.carryOutCompletionNudge(carry) : this.carryOutNoWaitNudge(carry, decision.text!),
  };

  /** Every park returns this once it is carried out, so a worker's park notice goes here whichever
   *  decision parked it (hearsay-tools/cezarion#1327). */
  private parkedOutcome(runId: string): TurnEndOutcome {
    this.noticeParkedWorker(runId);
    return { kind: 'park', keepsSlot: this.monitoring.has(runId) };
  }

  /** A refused autonomous nudge waits for readiness at this boundary, bounded by the idle timer. */
  private carryOutDefer({ state, session }: TurnEndCarry, decision: Extract<TurnEndDecision, { kind: 'defer' }>): TurnEndOutcome {
    return !decision.keepDone && session && state.autonomousNudgePending === session ? { kind: 'readiness' } : { kind: 'running' };
  }

  private carryOutDone({ runId, state, session }: TurnEndCarry): TurnEndOutcome {
    this.closeAsDone(runId, state, session);
    return { kind: 'done' };
  }

  /** A human wait is shown and parks for the user; CI and timer waits keep their slot. A question
   *  with no wait parks for the user, and the freed slot can start a queued run. */
  private carryOutPark({ runId, state, stepId }: TurnEndCarry): TurnEndOutcome {
    if (!this.parkOnWaits(runId, state)) this.parkForUser(runId, state, stepId);
    return this.parkedOutcome(runId);
  }

  /** One nudge per cycle: Cezar waits on the live workers for the agent, then parks as `park` does. */
  private carryOutCompletionWait(carry: TurnEndCarry): TurnEndOutcome {
    carry.noteRefusal();
    this.registerCompletionWait(carry.runId, carry.refused!.liveWorkerIds, carry.refused!.requestIds);
    return this.carryOutPark(carry);
  }

  /** The completion cause's human wait: the refusal is its note, and Cezar's own wait shows it. */
  private carryOutCompletionHumanWait({ runId, state, stepId, refused, noteRefusal }: TurnEndCarry): TurnEndOutcome {
    noteRefusal();
    const wait = this.openHumanAlias(runId, state, 'completion');
    if (wait?.source === 'cezar' && wait.askSeq === undefined) this.showCezarHumanWait(runId, state, wait, refused!.message);
    this.parkForUser(runId, state, stepId);
    return this.parkedOutcome(runId);
  }

  /** The no-wait and budget human waits. A refusal that settles the turn end opens the budget wait. */
  private carryOutHumanWait({ runId, state, stepId, noteRefusal, settlesRefusal }: TurnEndCarry, via: 'no-wait' | 'budget'): TurnEndOutcome {
    const capNote = state.autonomous ? `autonomous — safety cap reached (${MAX_AUTO_CONTINUES}); automatic continuation paused`
      : `automatic-wake budget spent (${MAX_AUTO_CONTINUES}); waiting for you`;
    if (settlesRefusal) {
      noteRefusal();
      this.openTurnEndHumanWait(runId, state, stepId, 'budget', capNote);
      return this.parkedOutcome(runId);
    }
    // Stopping, finishing, parent completion and owed input keep today's plain park.
    if (!this.canAutoContinue(runId, state)) this.parkForUser(runId, state, stepId);
    else this.openTurnEndHumanWait(runId, state, stepId, via, via === 'no-wait' ? NO_WAIT_NOTE : capNote, true);
    return this.parkedOutcome(runId);
  }

  /** Send the refusal nudge, or park retaining DONE for transport readiness when permitted. */
  private carryOutCompletionNudge({ runId, state, session, stepId, refused, noteRefusal }: TurnEndCarry): TurnEndOutcome {
    const text = refused!.liveWorkerIds.length ? `${refused!.message} ${COMPLETION_WILL_WAIT}` : refused!.message;
    state.noWaitNudgeSawContent = false;
    if (!session || !this.canAutoContinue(runId, state) || !this.submitAgentInput(runId, state, [{ type: 'text', text }])) {
      if (session && this.canAutoContinue(runId, state)) state.doneAtBoundary = session;
      noteRefusal();
      this.parkForUser(runId, state, stepId);
      return this.parkedOutcome(runId);
    }
    this.awaitCompletionNudgeReply(runId, state, session);
    const spent = this.chargeAutomaticWake(runId);
    this.store.appendEvent(runId, { type: 'note', ...(stepId ? { stepId } : {}), message: `${COMPLETION_NUDGE_NOTE} (${spent}/${MAX_AUTO_CONTINUES}): ${refused!.code}` });
    return { kind: 'nudge', cause: 'completion', autonomous: !!state.autonomous };
  }

  /** The no-wait cause's nudge. One the wire refuses waits for input readiness when it is
   *  autonomous, else opens Cezar's no-wait human wait. */
  private carryOutNoWaitNudge({ runId, state, session, stepId }: TurnEndCarry, text: string): TurnEndOutcome {
    const sent = openCompletionRequests(this.store, runId).sent;
    if (sent.length) text += ` ${sentRequestInstructions(sent)}`;
    if (this.sendTurnEndNudge(runId, state, stepId, text)) return { kind: 'nudge', cause: 'no-wait', autonomous: !!state.autonomous };
    if (session && state.autonomousNudgePending === session) return { kind: 'readiness' };
    if (!this.canAutoContinue(runId, state)) this.parkForUser(runId, state, stepId);
    else this.openTurnEndHumanWait(runId, state, stepId, 'no-wait', NO_WAIT_NOTE, true);
    return this.parkedOutcome(runId);
  }

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
  private sendTurnEndNudge(runId: string, state: ActiveRun, stepId: string | undefined, text: string): boolean {
    if (state.autonomous) return !!stepId && this.tryAutonomousNudge(runId, state, stepId, null, text);
    if (!this.canAutoContinue(runId, state)) return false;
    state.noWaitNudgeSawContent = false;
    if (!this.submitAgentInput(runId, state, [{ type: 'text', text }])) return false;
    state.noWaitNudged = state.session;
    this.clearIdleTimer(state);
    this.armNoWaitNudgeReplyTimer(runId, state);
    const spent = this.chargeAutomaticWake(runId);
    this.store.appendEvent(runId, { type: 'note', ...(stepId ? { stepId } : {}), message: `${NO_WAIT_NUDGE_NOTE} (${spent}/${MAX_AUTO_CONTINUES})` });
    return true;
  }

  /** Cezar's own human wait at a turn end (hearsay-tools/cezarion#1234): the cause as a note, the
   *  wait shown as Needs you, and the run parked for the user. A worker's `no-wait` fallback at its
   *  turn end (`turnEnd`) asks its parent instead (`askParentForWorker`, hearsay-tools/cezarion#1301);
   *  any other worker fallback stays a plain park. */
  private openTurnEndHumanWait(runId: string, state: ActiveRun, stepId: string | undefined, via: 'no-wait' | 'budget', note: string, turnEnd = false): void {
    const worker = this.store.getRun(runId)?.delegation?.role === 'worker';
    if (worker && via === 'no-wait' && turnEnd) { this.askParentForWorker(runId, state, stepId); return; }
    const wait = worker ? undefined : this.openHumanAlias(runId, state, via);
    if (wait?.source === 'cezar' && wait.askSeq === undefined) this.showCezarHumanWait(runId, state, wait, note);
    else {
      this.store.appendEvent(runId, { type: 'note', ...(stepId ? { stepId } : {}), message: note });
      if (wait) this.surfaceHumanWait(runId, state, wait);
    }
    this.parkForUser(runId, state, stepId);
  }

  /**
   * A worker that ended a second turn with no wait or done after its no-wait nudge
   * (hearsay-tools/cezarion#1301): Cezar's `no-wait` human wait carries one open question, raised
   * as `ask.requested` so `routeWorkerQuestion` takes it to the parent as a request. The parent's
   * reply resumes the worker through the answer seam, charged to the worker's budget; a parent that
   * cannot receive leaves it with the human (`worker-question-fallback`). A full wait list opens
   * none and the worker parks as before.
   */
  private askParentForWorker(runId: string, state: ActiveRun, stepId: string | undefined): void {
    const questions = [{ header: WORKER_FALLBACK_HEADER, question: WORKER_FALLBACK_QUESTION(runId) }];
    this.store.appendEvent(runId, { type: 'note', ...(stepId ? { stepId } : {}), message: WORKER_FALLBACK_NOTE });
    const wait = this.openHumanAlias(runId, state, 'no-wait', { questions });
    if (wait && wait.askSeq === undefined && this.pendingHumanAskSeq(runId) === undefined) {
      this.store.appendEvent(runId, { type: 'ask.requested', requestId: randomUUID(), questions, ...(stepId ? { stepId } : {}) });
      this.prepareHumanAsk(state);
      this.markHumanWaitSurfaced(runId, wait, { questions });
      this.routeWorkerQuestion(runId);
    }
    this.parkForUser(runId, state, stepId);
  }

  /** The worker's pending question is the one `askParentForWorker` raised. */
  private isWorkerFallbackAsk(runId: string, askSeq: number): boolean {
    const ask = this.store.transcriptFacts(runId).pendingAsk;
    const questions = ask?.seq === askSeq ? askRequestOf({ questions: ask.questions })?.questions : undefined;
    return questions?.length === 1 && questions[0]!.header === WORKER_FALLBACK_HEADER && questions[0]!.question === WORKER_FALLBACK_QUESTION(runId);
  }

  /** The worker's pending question is Cezar's fallback question. */
  private pendingWorkerFallback(runId: string): boolean {
    const ask = this.store.transcriptFacts(runId).pendingAsk;
    return this.store.getRun(runId)?.delegation?.role === 'worker' && !!ask && this.isWorkerFallbackAsk(runId, ask.seq);
  }

  /** The parent's reply to a worker's fallback question resumed it: one automatic wake, so a
   *  parent and worker cannot go back and forth past the budget (hearsay-tools/cezarion#1301). */
  private chargeWorkerFallbackReply(runId: string, beforeHumanReset?: HumanAnswerBudget): void {
    const spent = beforeHumanReset === undefined ? this.chargeAutomaticWake(runId) : beforeHumanReset.spent + 1;
    if (beforeHumanReset) beforeHumanReset.spent = spent;
    this.store.appendEvent(runId, { type: 'note', message: `${WORKER_FALLBACK_REPLY_NOTE} (${spent}/${MAX_AUTO_CONTINUES})` });
  }

  /**
   * Cezar's fallback question is Cezar's, not the worker's (hearsay-tools/cezarion#1301): what the
   * plain park it replaced let through still goes through. A parent's input, a Continue or a closed
   * session supersedes it: its routed request gets an outcome, so it no longer holds the parent's
   * done, the parent's unread copy is retired, and only then does the question close unanswered
   * (`human-ask-closed`, `superseded`) and Cezar's wait go. Each step is idempotent and the close
   * comes last, so a failed write leaves the question pending and the next supersession, or
   * recovery, finishes it. A question the worker asked itself is never superseded. True when it
   * closed.
   */
  private supersedeWorkerFallback(runId: string): boolean {
    const run = this.store.getRun(runId);
    const ask = this.store.transcriptFacts(runId).pendingAsk;
    if (run?.delegation?.role !== 'worker' || !ask || !this.isWorkerFallbackAsk(runId, ask.seq)) return false;
    const root = this.store.getRun(run.delegation.parentRunId);
    const requestId = ask.routedMessageId;
    if (root?.delegation?.role === 'root' && requestId !== undefined) {
      try {
        const conversation = root.delegation.conversation;
        if (conversation?.messages.some(message => message.id === requestId) && !conversation.outcomes.some(outcome => outcome.requestId === requestId)) {
          this.store.commitConversation(root.id, { ...conversation, outcomes: [...conversation.outcomes,
            { requestId, status: 'completed-without-reply', observedAt: new Date().toISOString() }] });
          projectConversationEvents(this.store, this.store.getRun(root.id)!);
        }
        this.retireUnreadParentQuestion(root.id, requestId);
      } catch (error) {
        console.warn(`[cez] fallback question not superseded: ${error instanceof Error ? error.message : String(error)}`);
        return false;
      }
    }
    this.store.appendEvent(runId, { type: 'human-ask-closed', askSeq: ask.seq, reason: 'superseded' });
    this.withdrawCezarHumanWaits(runId);
    const state = this.active.get(runId);
    if (state) state.pendingHumanAsk = this.hasPendingHumanAsk(runId);
    return true;
  }

  /** The parent no longer owes an answer to a superseded fallback question: one it has not read is
   *  retired, so neither a wake nor a restart's replay of unread input delivers it. One a provider
   *  or an inbox read already holds is left to them. */
  private retireUnreadParentQuestion(parentId: string, requestId: string): void {
    const input = this.store.getRun(parentId)?.agentInputs?.find(entry => entry.id === requestId);
    if (!input || input.consumedAt || hasLiveInboxClaim(input) || this.providerOwnsInboxInput(parentId, requestId)) return;
    this.active.get(parentId)?.unreadInputIds?.delete(requestId);
    if (input.deliveredAt) this.store.commitAgentInputsUnconfirmed(parentId, [requestId]);
    else this.store.commitAgentInputs(parentId, (this.store.getRun(parentId)?.agentInputs ?? []).filter(entry => entry.id !== requestId));
  }

  /** Heartbeats and nested subagent items are not a reply. A `turn.started` counts only while the
   *  reply timer runs or after it expired on this session: OpenCode and Cursor emit a synthetic one
   *  inside `sendAgentMessage`, and a later send goes through `submitAgentInput`, which resumes. */
  private isNoWaitNudgeReply(state: ActiveRun, event: { type: string; item?: { parentItemId?: string } }): boolean {
    if (event.type === 'turn.started') return state.noWaitNudgeReplyTimer !== undefined || state.noWaitNudgeParked === state.session;
    if (event.type === 'text' || event.type === 'tool-call' || event.type === 'tool-result') return true;
    if (event.type === 'item.delta' || !event.type.startsWith('item.')) return false;
    return event.item?.parentItemId === undefined;
  }

  /** A reply to the nudge clears its bound. One that arrives after the bound parked the run resumes
   *  it, as the final-message nudge's did (#544); its turn end then decides, and a run still on
   *  Cezar's no-wait wait parks on it again. */
  private noteNoWaitNudgeContent(runId: string, state: ActiveRun, event: { type: string; item?: { parentItemId?: string } }): void {
    if (!this.isNoWaitNudgeReply(state, event)) return;
    state.noWaitNudgeSawContent = true;
    clearNoWaitNudgeReplyTimer(state);
    if (state.noWaitNudgeParked !== state.session || !this.waiting.has(runId)) return;
    if (state.pendingHumanAsk || this.hasPendingHumanAsk(runId)) return;
    this.resumeParkedRun(runId, state);
    state.noWaitNudgeParked = undefined;
  }

  /** A no-wait nudge the harness acknowledged but never answered (an OpenCode heartbeat keeps the
   *  session alive without a turn): at the bound Cezar opens the no-wait human wait and the run
   *  waits for the user. A reply that arrives after it runs, and the run stays on that question. */
  private armNoWaitNudgeReplyTimer(runId: string, state: ActiveRun): void {
    clearNoWaitNudgeReplyTimer(state);
    if (state.noWaitNudgeSawContent) return;
    const session = state.session;
    if (!session?.open) return;
    const timer = setTimeout(() => {
      state.noWaitNudgeReplyTimer = undefined;
      if (this.disposed || this.active.get(runId) !== state || state.session !== session || !session.open ||
        state.cancelled || state.finishRequested || this.waiting.has(runId)) return;
      state.noWaitNudgeParked = session;
      // The note names the nudge left unanswered (hearsay-tools/cezarion#1301).
      this.openTurnEndHumanWait(runId, state, state.currentStepId, 'no-wait', state.completionNudged === session ? COMPLETION_NO_REPLY_NOTE : NO_WAIT_NO_REPLY_NOTE);
      this.settledTurnOutcome(runId, 'reply-timer', { kind: 'park', keepsSlot: false });
    }, this.noWaitNudgeReplyMs);
    timer.unref?.();
    state.noWaitNudgeReplyTimer = timer;
  }

  /** Every run status `run.ts` writes comes from the run state table (hearsay-tools/cezarion#1804). */
  private move(runId: string, exit: RunExitId, patch: Omit<Parameters<RunStore['updateRun']>[1], 'status'> = {}): RunRecord | undefined {
    const status = transition(exit, () => this.store.getRun(runId));
    return this.store.updateRun(runId, { ...patch, ...(status === 'failed' ? settledRootFinishPatch(this.store, runId) : {}), status });
  }

  private armIdleTimer(runId: string, state: ActiveRun): void {
    this.clearIdleTimer(state);
    state.idleClosed = false;
    state.idleTimer = setTimeout(() => {
      if (state.session?.open && !state.cancelled) {
        state.idleClosed = true;
        this.store.appendEvent(runId, {
          type: 'lifecycle',
          message: `session closed after ${Math.round(IDLE_TIMEOUT_MS / 60_000)}m of inactivity`,
        });
        state.session.end();
      }
    }, IDLE_TIMEOUT_MS);
    state.idleTimer.unref?.();
  }

  private clearIdleTimer(state: ActiveRun): void {
    clearIdleTimer(state);
  }


  /** The turn-end tail's park for the user: `waiting` with the idle timer, no slot. A result
   *  already in (a pending question beside a resolved wait) still queues its wake. */
  private parkForUser(runId: string, state: ActiveRun, stepId: string | undefined): void {
    this.move(runId, 'park');
    if (stepId) this.store.updateStep(runId, stepId, { status: 'waiting' });
    this.store.flush();
    this.waiting.add(runId);
    this.leaveMonitoringPool(runId);
    this.armIdleTimer(runId, state);
    this.releaseSlot();
    this.queueWaitWake(runId);
  }

  /**
   * The monitoring line and Claude's `ScheduleWakeup` open a timer in the wait list
   * (hearsay-tools/cezarion#1233): the line for the configured interval, `ScheduleWakeup` for its
   * `delaySeconds` clamped to 60–3,600 (the interval without one). Idempotent per `via`: while one
   * is open the alias registers nothing and the timer keeps its deadline. The line is only a
   * fallback: any open non-human wait suppresses its registration (hearsay-tools/cezarion#1268),
   * including the off/budget human fallback. With timers off and no such wait it opens
   * a `monitoring-line` human wait instead, and with the automatic-wake budget spent a `budget` one
   * (hearsay-tools/cezarion#1234); the park shows it. An autonomous run's nudge keeps precedence
   * over the line.
   */
  private openTimerAlias(runId: string, state: ActiveRun, scheduleWakeup: number | null | undefined): void {
    const run = this.store.getRun(runId);
    if (!this.canProceedWithRun(runId, run)) return;
    if (state.autonomous && this.automaticWakes(runId) < MAX_AUTO_CONTINUES && this.canAutoContinue(runId, state)) return;
    const via: WaitVia = scheduleWakeup === undefined ? 'monitoring-line' : 'schedule-wakeup';
    const open = openWaits(run);
    // The line is a fallback, not another poll beside a wait that already supplies its wake
    // (hearsay-tools/cezarion#1268). Keep explicit ScheduleWakeup requests and existing timers.
    if (via === 'monitoring-line' && open.some(wait => wait.kind !== 'human')) return;
    if (open.some(wait => wait.kind === 'timer' && wait.via === via)) return;
    const minutes = this.semaphore.monitoringWakeIntervalMinutes();
    if (minutes === null) {
      this.store.appendEvent(runId, { type: 'note', message: 'automatic re-checks are off; waiting for you' });
      this.openHumanAlias(runId, state, 'monitoring-line');
      return;
    }
    if (this.automaticWakes(runId) >= MAX_AUTO_CONTINUES) {
      if (!state.monitoringCapNoted) {
        state.monitoringCapNoted = true;
        this.store.appendEvent(runId, {
          type: 'note',
          message: `automatic monitoring wake-up cap reached (${MAX_AUTO_CONTINUES}); session remains parked`,
        });
      }
      this.openHumanAlias(runId, state, 'budget');
      return;
    }
    if (openWaits(run).length >= WAIT_LIMIT) return;
    const delay = typeof scheduleWakeup === 'number' ? Math.min(SCHEDULE_WAKEUP_MAX_SECONDS, Math.max(TIMER_MIN_SECONDS, Math.round(scheduleWakeup))) : undefined;
    const now = Date.now();
    // `seconds` is the record's bound; the line's deadline is the interval itself (tests run it sub-minute).
    const wait: TimerWaitEntry = { id: randomUUID(), kind: 'timer', source: 'agent', via, registeredAt: new Date(now).toISOString(),
      deadline: new Date(now + (delay === undefined ? minutes * 60_000 : delay * 1000)).toISOString(), phase: 'open', turnId: state.ciTurnId ?? 'monitoring',
      seconds: delay ?? Math.min(TIMER_MAX_SECONDS, Math.max(TIMER_MIN_SECONDS, Math.round(minutes * 60))),
      ...(via === 'monitoring-line' ? { note: 'Opened by CEZ:MONITORING.' } : {}) };
    this.withdrawCezarHumanWaits(runId);
    try { this.store.commitWait(runId, wait); }
    catch (error) { console.warn(`[cez] monitoring timer checkpoint failed: ${error instanceof Error ? error.message : String(error)}`); return; }
    this.armWait(runId, wait);
  }

  /** The save may finish execution while its strict writer proof remains pending. */
  private readonly autosaveTasks = new Map<string, { settlement: Promise<void>; blocker?: string }>();

  /** Cleanup evidence survives manager disposal and store close/reopen. */
  autosaveCleanupBlocker(runId: string): string | undefined {
    return this.autosaveTasks.get(runId)?.blocker ?? autosaveCleanupBlocker(this.dataDir, runId);
  }

  /** Keep a separate maintenance hold until autosave proves all its processes exited.
   *  Commits only while HEAD is the run's recorded branch (hearsay-tools/cezarion#1004), and
   *  records a commit or a skip in the run store, shown in the handoff's records block, and as a
   *  note; a periodic save records only a commit, with no note, merged with the
   *  periodic commits right before it. A run with no recorded branch keeps committing on
   *  whatever HEAD is. */
  private async saveWorktree(runId: string, state: ActiveRun, reason: AutosaveReason): Promise<void> {
    if (state.cwd === this.repoRoot) return;
    for (;;) {
      const previous = this.autosaveTasks.get(runId);
      if (!previous) break;
      await previous.settlement;
      // A blocked save still owns the tree. Do not queue another writer behind it.
      if (previous.blocker) return;
    }
    const note = (message: string) => {
      try { this.store.appendEvent(runId, { type: 'note', message }); }
      catch { /* Cleanup may outlive the store or its history; reporting cannot interrupt it. */ }
    };
    let settle!: () => void;
    const entry: { settlement: Promise<void>; blocker?: string } = { settlement: new Promise(resolve => { settle = resolve; }) };
    this.autosaveTasks.set(runId, entry);
    let release: (() => void) | undefined;
    let retained = false;
    let cleanupConfirmed = false;
    let taskBranch: string | undefined;
    try { taskBranch = this.store.getRun(runId)?.branch; } catch { /* A closed store keeps the old rule. */ }
    let outcome: AutosaveOutcome | undefined;
    const task = autosaveCommit(state.cwd, reason, {
      ...(taskBranch ? { taskBranch } : {}),
      onOutcome: reported => { outcome = reported; },
      onWarning: note,
      onBlocked: (message, proof) => {
        retainAutosaveCleanup(this.dataDir, runId, state.cwd, message, proof);
        retained = true;
        if (!release) {
          const hold = this.holdForMaintenance([runId]);
          if (!hold) return; // Never release execution without a replacement writer guard.
          release = hold;
          note(`${reason} autosave unsuccessful; run can settle, working files remain in ${state.cwd}`);
        }
        entry.blocker = message;
        settle();
      },
    });
    void task.then(result => {
      cleanupConfirmed = true;
      if (result === 'failed') note(`${reason} autosave failed; working files remain in ${state.cwd}`);
      else if (result === 'refused') note(`${reason} autosave refused: unresolved conflicts or an unfinished merge, cherry-pick or revert; working files remain in ${state.cwd}`);
      else if (outcome && reason === 'periodic') {
        // The timer reports its commits too, since a clean closing flush reports nothing
        // (review on hearsay-tools/cezarion#1111): one coalesced handoff line per run of
        // periodic commits and no note, as a note every 90 s would flood the timeline. A
        // periodic skip stays silent; the closing flush reports one with the final count.
        if (outcome.result === 'committed') {
          recordHandoffPeriodicAutosave(this.store, this.dataDir, runId, outcome);
        }
      } else if (outcome) {
        const message = autosaveReportLine(reason, outcome, taskBranch);
        note(message);
        recordHandoffAutosave(this.store, this.dataDir, runId, message);
      }
    }, error => note(`${reason} autosave failed: ${String(error)}; working files remain in ${state.cwd}`)).finally(() => {
      if (this.autosaveTasks.get(runId) === entry) this.autosaveTasks.delete(runId);
      if (retained && cleanupConfirmed) {
        try { clearAutosaveCleanup(this.dataDir, runId); }
        catch { note('autosave cleanup confirmed but retained evidence could not be cleared; worktree reuse remains blocked'); }
      }
      try { release?.(); } catch { /* The store may already be closed; durable evidence is independent. */ }
      if (entry.blocker) {
        note(this.autosaveCleanupBlocker(runId) ? 'autosave cleanup confirmed; retained evidence still blocks worktree reuse' : 'autosave cleanup confirmed; worktree reuse is available again');
        if (!this.disposed) this.reapTerminalScratch(runId);
        if (!this.disposed) this.releaseSlot();
      }
      settle();
    });
    await entry.settlement;
  }

  /** Autosave-commit the worktree every 90 s while the run lives (spec 006).
   *  Opt-in via CEZ_AUTOSAVE=1 (#471) — see periodicAutosaveEnabled. */
  private armAutosave(runId: string, state: ActiveRun): void {
    if (!periodicAutosaveEnabled()) return;
    if (state.cwd === this.repoRoot || state.autosaveTimer) return;
    state.autosaveTimer = setInterval(() => {
      const task = this.saveWorktree(runId, state, 'periodic');
      const turns = this.executions.get(runId)?.turns;
      turns?.add(task);
      void task.catch(() => undefined).finally(() => turns?.delete(task));
    }, AUTOSAVE_INTERVAL_MS);
    state.autosaveTimer.unref?.();
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
