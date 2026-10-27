import type { RunnerId } from '../core/agent-runner.ts';
import { AGENT_MODELS_LOCKED_ERROR, agentModelsLocked } from '../core/agent-model-policy.ts';
import { modelConflictsWithRunner } from '../core/model-presets.ts';
import type { WorkerStepIdentity } from '../delegation/execution-identity.ts';
import type { QueuedMessage, RunRecord, RunStore, StepState } from '../runs/store.ts';
import { DEFAULT_AGENT_ACCOUNT_ID } from '../workspace/agent-accounts.ts';
import type { PastedContent } from './run.ts';
import { hasRegisteredRunProcess } from '../core/process-usage.ts';
import { WorkerIdentityError } from '../delegation/execution-identity.ts';
import { isUsageLimitHold } from '@open-mercato/cezar-contract/waits';

/** What a Continue may carry (`RunManager.continueRun`). */
export type ContinueRunOptions = {
  text?: string | undefined;
  /** A scheduler-owned continuation may deliver waits beside a pending question. */
  waitWake?: true;
  images?: PastedContent[] | undefined;
  runner?: RunnerId | undefined;
  /** Configured fallback for an untouched workflow, resolved by the route. */
  originalRunner?: RunnerId;
  model?: string | undefined;
  /** Omitted keeps the pin; empty string clears it. */
  effort?: string | undefined;
  agentProfile?: string | undefined;
  /** The parent reply this continuation delivers as the answer to a routed question. */
  answerInputId?: string;
};

export type ContinuationRefusal = { ok: false; error: string };
export type ContinuationConversation = Parameters<RunStore['commitWorkerContinuation']>[3];

export function modelLockRefusal(repoRoot: string, opts: ContinueRunOptions): ContinuationRefusal | undefined {
  if (agentModelsLocked(repoRoot) && (opts.model?.trim() || opts.effort?.trim())) {
    return { ok: false, error: AGENT_MODELS_LOCKED_ERROR };
  }
}

export function parentMessageRefusal(run: RunRecord, defer: boolean, conversation: ContinuationConversation): ContinuationRefusal | undefined {
  if (conversation && (!defer || run.delegation?.role !== 'worker' || run.delegation.parentRunId !== conversation.rootId ||
    !['done', 'review', 'failed'].includes(run.status))) {
    return { ok: false, error: 'Only a settled owned worker can be resumed by its parent message' };
  }
}

export function stoppingRefusal(run: RunRecord): ContinuationRefusal | undefined {
  if (run.stopping) return { ok: false, error: 'run is still stopping' };
}

export function identityRefusal(identity: WorkerStepIdentity | undefined, opts: ContinueRunOptions): ContinuationRefusal | undefined {
  if (identity && ((opts.runner !== undefined && opts.runner !== identity.account.provider) ||
    (opts.agentProfile !== undefined && opts.agentProfile !== identity.account.profileId) ||
    (opts.model !== undefined && opts.model !== identity.model) ||
    (opts.effort !== undefined && opts.effort !== identity.effort))) {
    return { ok: false, error: 'Accepted worker execution identity cannot change' };
  }
}

export function workerRefusal(run: RunRecord): ContinuationRefusal | undefined {
  if (run.delegation?.role === 'invalid' || (run.delegation?.role === 'worker' && run.delegation.destroy)) {
    return { ok: false, error: 'worker cannot continue' };
  }
}

export function answerRefusal(run: RunRecord, opts: ContinueRunOptions, defer: boolean,
  conversation: ContinuationConversation, pendingHumanAsk: boolean): ContinuationRefusal | undefined {
  const answers = defer ? [run.continuationMessage, ...(run.queuedMessages ?? [])] : [opts];
  if (pendingHumanAsk && !opts.answerInputId && !(opts.waitWake && defer) && (conversation ||
    (defer && run.continuationMessage?.origin !== 'human') ||
    !answers.some(answer => answer?.text?.trim() || answer?.images?.length))) {
    return { ok: false, error: 'pending human question requires an explicit answer' };
  }
}

export function sessionRefusal(sessionStep: StepState | undefined, untouched: boolean): ContinuationRefusal | undefined {
  if (!sessionStep?.sessionId && !untouched) return { ok: false, error: 'no agent session to resume' };
}

/** Session ids belong to their provider and account, including mixed-chain worker steps. */
export function sessionAffinity(run: RunRecord, opts: ContinueRunOptions, identity: WorkerStepIdentity | undefined,
  sessionStep: StepState | undefined, untouched: boolean) {
  const originalRunner = identity?.account.provider ?? run.runner ?? (untouched ? opts.originalRunner : undefined) ?? 'claude';
  const targetRunner = opts.runner ?? originalRunner;
  // Legacy sessions without explicit affinity belong to the run's current runner/account.
  const sessionBackend = sessionStep?.backend ?? run.runner ?? 'claude';
  const sessionAccount = sessionStep?.profileId ?? DEFAULT_AGENT_ACCOUNT_ID;
  const accountSwitched = (opts.agentProfile ?? identity?.account.profileId ?? run.agentProfile ?? sessionAccount) !== sessionAccount;
  const resume = sessionBackend === targetRunner && !accountSwitched;
  return { originalRunner, targetRunner, resume };
}

export function cursorSessionRefusal(resume: boolean, sessionStep: StepState | undefined,
  resumeSessionId: string | undefined): ContinuationRefusal | undefined {
  if (resume && sessionStep?.sessionTransport === 'cursor-print' && !resumeSessionId) {
    return { ok: false, error: 'Cursor print session identity lacks a matching recorded session event' };
  }
}

export function hasOverrides(opts: ContinueRunOptions): boolean {
  return opts.runner !== undefined || opts.model !== undefined || opts.effort !== undefined || opts.agentProfile !== undefined;
}

export function modelRefusal(opts: ContinueRunOptions, targetRunner: RunnerId): ContinuationRefusal | undefined {
  if (opts.model && modelConflictsWithRunner(opts.model, targetRunner)) {
    return { ok: false, error: `model '${opts.model}' is not a ${targetRunner} model` };
  }
}

/** Clear foreign inherited presets/accounts on a switch; keep custom model ids and effort. */
export function overridePatch(run: RunRecord, opts: ContinueRunOptions, targetRunner: RunnerId, originalRunner: RunnerId) {
  const inheritedPinIsForeign = opts.model === undefined && run.model !== undefined && modelConflictsWithRunner(run.model, targetRunner);
  const inheritedAccountIsForeign = opts.agentProfile === undefined && run.agentProfile !== undefined && targetRunner !== originalRunner;
  return {
    ...(opts.runner !== undefined ? { runner: opts.runner } : {}),
    ...(opts.model !== undefined ? { model: opts.model === '' ? undefined : opts.model }
      : inheritedPinIsForeign ? { model: undefined } : {}),
    ...(opts.agentProfile !== undefined ? { agentProfile: opts.agentProfile }
      : inheritedAccountIsForeign ? { agentProfile: undefined } : {}),
    ...(opts.effort !== undefined ? { effort: opts.effort === '' ? undefined : opts.effort } : {}),
  };
}

export function content(opts: ContinueRunOptions): PastedContent[] {
  return [...(opts.text?.trim() ? [{ type: 'text' as const, text: opts.text.trim() }] : []), ...(opts.images ?? [])];
}

export function previousFailure(run: RunRecord) {
  const previousStep = [...run.steps].reverse().find(step => step.status !== 'pending');
  return previousStep?.status === 'failed' && previousStep.error
    ? { stepId: previousStep.id, error: previousStep.error }
    : run.error ? { error: run.error } : undefined;
}

export function nextStep(run: RunRecord) {
  let continuationNumber = 1;
  while (run.steps.some(step => step.id === `continue-${continuationNumber}`)) continuationNumber++;
  return { id: `continue-${continuationNumber}`, name: 'Continue', kind: 'agent' as const, synthetic: 'continuation' as const };
}

/** Generated restart text becomes evidence; identical human text stays verbatim. */
export function opening(message: QueuedMessage, recovered: RunRecord['continuationMessage'],
  defer: boolean, conversation: ContinuationConversation, opts: ContinueRunOptions,
  restartPrompt: string, failure: ReturnType<typeof previousFailure>) {
  const lifecycleRestart = message.text === restartPrompt
    && (recovered ? recovered.origin === 'lifecycle' : defer && !conversation && !opts.answerInputId);
  const prompt = lifecycleRestart ? 'Continue.' : message.text || 'Continue.';
  const resumeContext = lifecycleRestart ? { ...recovered?.resumeContext, restarted: true as const }
    : recovered?.resumeContext ?? (failure ? { failure } : undefined);
  return { prompt, resumeContext };
}

export function acceptedMessage(message: QueuedMessage, stepId: string, prompt: string,
  resumeContext: ReturnType<typeof opening>['resumeContext'],
  recovered: RunRecord['continuationMessage'], conversation: ContinuationConversation, opts: ContinueRunOptions, defer: boolean) {
  return { ...message, id: stepId, text: prompt,
    ...(resumeContext ? { resumeContext } : {}),
    ...(conversation ? { agentInputId: conversation.input.id } : opts.answerInputId ? { agentInputId: opts.answerInputId } : {}),
    // A parent's answer answers the ask exactly like a human's.
    origin: recovered ? recovered.origin : defer && !opts.answerInputId ? 'lifecycle' as const : 'human' as const };
}

/** Reads stay lazy: an earlier refusal must not run a later rule's lookup. */
export interface AdmissionReads {
  active(): boolean;
  autosaveBlocker(): string | undefined;
  reclaiming(): boolean;
  run(): RunRecord | undefined;
  historyDeletionPending(): boolean;
  parentInReview(parentId: string): boolean;
  answersFallback(): boolean;
  identity(run: RunRecord, session: string | undefined): WorkerStepIdentity | undefined;
  beforeFinalStep(run: RunRecord): boolean;
  waitingStepIndex(run: RunRecord): number;
  pendingFallback(): boolean;
  pendingAsk(): boolean;
  rootFinishing(run: RunRecord): boolean;
  routedAsk(): unknown;
  ciStepIndex(run: RunRecord): number;
  untouched(run: RunRecord): boolean;
  sessionId(step: StepState | undefined): string | undefined;
}

/** Read-only admission in the original order. RunManager owns every admission write. */
export class ContinuationChecks {
  constructor(private readonly runId: string, private readonly repoRoot: string,
    private readonly opts: ContinueRunOptions, private readonly defer: boolean,
    private readonly conversation: ContinuationConversation, private readonly reads: AdmissionReads,
    private readonly routedQuestionRefusal: string) {}

  prepare() {
    const unavailable = this.availabilityRefusal();
    if (unavailable) return unavailable;
    const run = this.reads.run();
    if (!run) return { ok: false as const, error: 'not found' };
    const ownership = this.ownershipRefusal(run);
    if (ownership) return ownership;
    const identity = this.checkIdentity(run);
    if (!identity.ok) return identity;
    const workflow = this.workflowRefusal(run);
    if (workflow) return workflow;
    // Treat a fallback as gone, but close it only after the continuation commits.
    const supersedes = !this.opts.answerInputId && this.reads.pendingFallback();
    const pendingHumanAsk = run.delegation?.role !== 'invalid' && this.reads.pendingAsk() && !supersedes;
    const question = this.questionRefusal(run, pendingHumanAsk);
    if (question) return question;
    const status = this.statusRefusal(run, pendingHumanAsk);
    if (status) return status;
    const session = this.checkSession(run, identity.value);
    if (!session.ok) return session;
    return { ok: true as const, run, supersedes, identity: identity.value, ...session.value };
  }

  private availabilityRefusal(): ContinuationRefusal | undefined {
    return modelLockRefusal(this.repoRoot, this.opts) || this.activeRefusal() ||
      this.autosaveRefusal() || this.reclaimingRefusal();
  }

  private activeRefusal(): ContinuationRefusal | undefined {
    if (this.reads.active()) return { ok: false, error: 'run is still active' };
  }

  private autosaveRefusal(): ContinuationRefusal | undefined {
    const blocker = this.reads.autosaveBlocker();
    if (blocker) return { ok: false, error: blocker };
  }

  private reclaimingRefusal(): ContinuationRefusal | undefined {
    if (this.reads.reclaiming()) return { ok: false, error: 'its worktree or branch is being cleaned up — retry in a moment' };
  }

  private ownershipRefusal(run: RunRecord): ContinuationRefusal | undefined {
    return parentMessageRefusal(run, this.defer, this.conversation) || stoppingRefusal(run) ||
      this.historyDeletionRefusal() || this.reviewingParentRefusal(run);
  }

  private historyDeletionRefusal(): ContinuationRefusal | undefined {
    if (this.reads.historyDeletionPending()) return { ok: false, error: 'Parent history deletion is pending; retry deletion' };
  }

  private reviewingParentRefusal(run: RunRecord): ContinuationRefusal | undefined {
    if (run.delegation?.role === 'worker' && this.reads.parentInReview(run.delegation.parentRunId) &&
      !this.opts.answerInputId && !this.reads.answersFallback()) {
      return { ok: false, error: 'Continue the reviewing parent before continuing its worker' };
    }
  }

  private checkIdentity(run: RunRecord) {
    try {
      const session = [...run.steps].reverse().find(s => s.sessionId)?.sessionId;
      const value = this.reads.identity(run, session);
      return identityRefusal(value, this.opts) ?? { ok: true as const, value };
    } catch (error) {
      if (error instanceof WorkerIdentityError) return { ok: false as const, error: error.message };
      throw error;
    }
  }

  private workflowRefusal(run: RunRecord): ContinuationRefusal | undefined {
    return this.activeRootRefusal(run) || this.waitingWorkflowRefusal(run);
  }

  private activeRootRefusal(run: RunRecord): ContinuationRefusal | undefined {
    if (run.delegation?.role === 'root') return this.activeRefusal();
  }

  private waitingWorkflowRefusal(run: RunRecord): ContinuationRefusal | undefined {
    if (run.status === 'waiting' && !isUsageLimitHold(run) && !hasRegisteredRunProcess(this.runId) &&
      (run.delegation === undefined || run.delegation.role === 'root') && !this.reads.active() &&
      this.reads.beforeFinalStep(run) && (!run.workflowDef || this.reads.waitingStepIndex(run) < 0)) {
      return { ok: false, error: 'cannot continue a waiting run before its final workflow step' };
    }
  }

  private questionRefusal(run: RunRecord, pending: boolean): ContinuationRefusal | undefined {
    return this.waitingProcessRefusal(run) || workerRefusal(run) || this.rootFinishRefusal(run) ||
      this.routedAskRefusal(pending) || answerRefusal(run, this.opts, this.defer, this.conversation, pending);
  }

  private waitingProcessRefusal(run: RunRecord): ContinuationRefusal | undefined {
    if (run.status === 'waiting' && hasRegisteredRunProcess(this.runId)) return { ok: false, error: 'cannot continue a waiting run' };
  }

  private rootFinishRefusal(run: RunRecord): ContinuationRefusal | undefined {
    if (this.reads.rootFinishing(run)) return { ok: false, error: 'parent finish is pending' };
  }

  private routedAskRefusal(pending: boolean): ContinuationRefusal | undefined {
    if (pending && !this.defer && !this.opts.answerInputId && this.reads.routedAsk()) {
      return { ok: false, error: this.routedQuestionRefusal };
    }
  }

  private statusRefusal(run: RunRecord, pending: boolean): ContinuationRefusal | undefined {
    // A disconnected wait has durable intent but no live session to receive input.
    const disconnectedCiWait = !!run.waits?.length && !this.reads.active() && !hasRegisteredRunProcess(this.runId);
    if (!disconnectedCiWait && !['done', 'failed', 'cancelled', 'review'].includes(run.status) && !isUsageLimitHold(run) &&
      !(pending && run.status === 'waiting') && !this.waitingRunCanContinue(run)) {
      return { ok: false, error: `cannot continue a ${run.status} run` };
    }
  }

  private waitingRunCanContinue(run: RunRecord): boolean {
    return run.status === 'waiting' && !this.reads.active() && ((!hasRegisteredRunProcess(this.runId) &&
      (run.delegation === undefined || run.delegation.role === 'root')) ||
      (this.defer && run.delegation?.role === 'worker' && (!!run.waits?.length || this.reads.ciStepIndex(run) >= 0)));
  }

  private checkSession(run: RunRecord, identity: WorkerStepIdentity | undefined) {
    const sessionStep = [...run.steps].reverse().find(s => s.sessionId);
    // Command/check steps may have changed the repo; only an untouched workflow can restart.
    const untouched = this.reads.untouched(run);
    const absent = sessionRefusal(sessionStep, untouched);
    if (absent) return absent;
    const affinity = sessionAffinity(run, this.opts, identity, sessionStep, untouched);
    const resumeSessionId = affinity.resume ? this.reads.sessionId(sessionStep) : undefined;
    const cursor = cursorSessionRefusal(affinity.resume, sessionStep, resumeSessionId);
    if (cursor) return cursor;
    return { ok: true as const, value: { untouched, ...affinity, resumeSessionId } };
  }
}

export type ContinuationAdmission = Extract<ReturnType<ContinuationChecks['prepare']>, { ok: true }>;
