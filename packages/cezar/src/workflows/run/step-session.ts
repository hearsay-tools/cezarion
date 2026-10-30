import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { AgentEvent, AgentSession, ContentBlock, RunnerId } from '../../core/agent-runner.ts';
import { inputDeliveryOf } from '../../core/agent-runner.ts';
import { createRunner } from '../../core/runner-factory.ts';
import { startManagedSession } from '../../core/managed-session.ts';
import type { WorkerStepIdentity } from '../../delegation/execution-identity.ts';
import type { RunRecord } from '../../runs/store.ts';
import type { UiEventSink } from '../../runs/ui-event-sink.ts';
import type { ActiveRun } from '../active-run.ts';
import { pastedAttachmentsText, type PersistedAttachment } from '../pasted-content.ts';
import { stepToolGrant, toolGrantLists, type WorkflowStepDef } from '../types.ts';
import { agentDirectories, applyTemplate, composeSystemPrompt, expandRegistrySlashSkillText, leadingSlashSkillName, skillSystemPrompt } from './prompts.ts';
import { stepModel } from './launch-settings.ts';
import { stepScope } from './steps.ts';
import { isDisposedDelegatedRun } from './run-guards.ts';
import { clearIdleTimer } from './input-timers.ts';
import * as sessionEvents from './session-events.ts';
import * as inputReceipts from './input-receipts.ts';
import type { RunLine } from './run-line.ts';
import type { RunSkills } from './run-skills.ts';
import type { HumanWaits } from './human-waits.ts';
import type { ExecutionEmit, RunModuleContext, SessionTurn, StartRunInput, StepSessionLaunch, LaunchDelegation, LaunchCiTools } from './types.ts';

export interface StepSessionHost {
  workerExecutionStopped(runId: string): boolean;
  executionBlockedByRootFinish(run: RunRecord): boolean;
  trackWorkerSessionResult(runId: string, session: AgentSession): Promise<void>;
  workerStep(runId: string, stepId: string | undefined): WorkerStepIdentity | undefined;
  beginUsageInvocation(runId: string, state: ActiveRun, stepId: string): void;
  recordUsagePeaks(runId: string): void;
}

/** Owns the fresh agent step's opening, session, result and ordered release. */
export class StepSession {
  constructor(
    private readonly context: RunModuleContext,
    private readonly host: StepSessionHost,
    private readonly sessionEventHost: sessionEvents.SessionEventHost,
    private readonly launchPreambleHost: sessionEvents.LaunchPreambleHost,
    private readonly sharedHost: sessionEvents.SessionHelperHost,
    private readonly line: RunLine,
    private readonly runSkills: RunSkills,
    private readonly humanWaits: HumanWaits,
    private readonly inputReceiptHost: inputReceipts.InputReceiptsHost,
    private readonly inputReceiptSteps: inputReceipts.InputReceiptSteps,
  ) {}

  /** Returns an error message, or null on success. */
  async runAgentStep(
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
    this.context.store.updateStep(runId, step.id, { sessionId, backend });

    const stepRecord = this.context.store.getRun(runId)?.steps.find((s) => s.id === step.id);
    const startTokens = stepRecord?.tokensUsed ?? 0;
    const turn: SessionTurn = { text: '', completedText: '', tail: 'none', scheduleWakeup: undefined, sessionError: undefined };
    const sink = sessionEvents.makeUiSink(this.context, this.sharedHost, runId, step.id);
    const onEvent = sessionEvents.createSessionEventHandler(this.context, this.sessionEventHost, {
      runId, state, turn, stepId: step.id, backend, sink, tokenBase: startTokens, emit,
      acknowledge: () => true,
    });

    const stepBackend = step.runner ?? taskBackend;
    // An owned worker's step runs under what its identity pinned for it (#452): model, effort,
    // account and grants alike. The bound `workflowDef` carries the same values; the private
    // evidence is the authority.
    const stepIdentity = this.host.workerStep(runId, step.id);
    const model = await stepModel(this.context.store, this.context.repoRoot, runId, state, step, input, stepBackend, stepIdentity);
    if (typeof model === 'string') return model;
    // Which agent account this step spawns under, and — recorded on the step before the spawn —
    // which one its session belongs to. `sessionId` and `profileId` are a pair: a resume that
    // reads the wrong account's config dir finds no session and silently starts a fresh one.
    const stepProfile = await sessionEvents.stepProfileFor(this.context, this.sharedHost, runId, stepBackend, { stepId: step.id });
    if (typeof stepProfile === 'string') return stepProfile;
    const beforeSpawn = this.context.store.getRun(runId);
    if (state.cancelled || (beforeSpawn && this.host.executionBlockedByRootFinish(beforeSpawn))) return null;
    this.context.store.updateStep(runId, step.id, { profileId: stepProfile.profileId });

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
    this.host.beginUsageInvocation(runId, state, step.id);
    const launch = await sessionEvents.launchPreamble(this.launchPreambleHost, runId, state);
    const { delegation, webhooksPart, ciTools } = launch;
    // Revalidate after provisioning, then let execute settle cancellation or
    // requeue a Finish-held step through its existing no-session paths.
    if (launch.stale) {
      if (this.host.workerExecutionStopped(runId)) state.cancelled = true;
      state.currentStepId = undefined;
      return null;
    }
    state.inputDelivery = inputDeliveryOf(runner); state.unreadInputIds = new Set(); state.consumedBeforeAck = new Set();
    const launchOpening = sessionEvents.launchOpening(this.context, this.sharedHost, runId, state, step.id, { body: opening.userPrompt, ciTools });
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
      const skill = this.runSkills.enabledSkills(state).find((s) => s.name === step.skill);
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
    let userPrompt = expandRegistrySlashSkillText(rawPrompt, this.runSkills.enabledSkills(state), provisioned.filesDir);
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
          systemPrompt: composeSystemPrompt(launch.skillPrompt, sessionEvents.launchSystemTail(this.context, this.sharedHost, {
            extraSystemPrompt: launch.extraSystemPrompt, delegation, webhooksPart: launch.webhooksPart,
            env: profile.env, ciTools, handoffInjected: launch.opening.handoffInjected,
          })),
          userPrompt: launch.opening.userPrompt,
          images: launch.images,
          cwd: state.cwd,
          toolGrant: launch.toolGrant,
          // The handoff file lives outside the worktree — grant access.
          additionalDirectories: agentDirectories(join(this.context.dataDir, 'runs'), profile.env),
          env: { ...profile.env, ...delegation?.env, ...ciTools?.env },
          ...(ciTools ? { cezarTools: ciTools.descriptor } : {}),
          ...(delegation ? { restrictCrossSessionMessaging: delegation.restrictCrossSessionMessaging } : {}),
          model: launch.model.backendModel,
          effort: launch.model.effectiveEffort,
          sessionId: launch.sessionId,
          // Managed work has no default wall clock, including non-final steps.
          // Only an authored step opts in; turn completion still advances the chain.
          timeoutMs: launch.step.timeoutMs ?? 0,
        },
        onEvent,
        inputReceipts.inputReceiptCallbacks(this.context, this.inputReceiptHost, this.inputReceiptSteps, runId, state, () => session, turn, sink, false),
      );
    } catch (err) {
      ciTools?.revoke(); state.revokeCiTools = undefined;
      delegation?.revoke(); state.revokeDelegation = undefined;
      state.currentStepId = undefined;
      return err instanceof Error ? err.message : String(err);
    }
    return session;
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
    const sessionClosed = this.host.trackWorkerSessionResult(runId, session);
    state.session = session;
    state.nextStep = stepScope(session, launch.nextStep);
    state.sessionEverOpened = true;
    state.currentStepId = stepId;
    state.interrupt = () => session.interrupt();
    let setupComplete = false;
    try {
      const result = await inputReceipts.sessionResultWithReceipts(this.context, this.inputReceiptHost, this.inputReceiptSteps, runId, state, session, () => { setupComplete = true; });
      if (isDisposedDelegatedRun(this.context.store, this.context.disposed, runId)) return null;
      sessionEvents.persistWorkerAssistantResult(this.context, this.sharedHost, runId, stepId, result.text);
      const inputOrSessionError = turn.sessionError ?? state.agentInputError;
      if (inputOrSessionError) {
        sink.sessionEnded('error', inputOrSessionError);
        return inputOrSessionError;
      }
      // v2 counterpart of v1's `done` (spec: the mappers leave session-close
      // events to the RunManager — only it knows how the session settled).
      sink.sessionEnded(state.cancelled ? 'cancelled' : 'end_turn');
      this.context.store.updateStep(runId, stepId, { tokensUsed: launch.startTokens + result.tokensUsed });
      return null;
    } catch (err) {
      if (!setupComplete) {
        try { session.interrupt(); } catch { /* Still wait for actual termination. */ }
        await sessionClosed;
      }
      if (isDisposedDelegatedRun(this.context.store, this.context.disposed, runId)) return null;
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
    this.host.recordUsagePeaks(runId);
    clearIdleTimer(state);
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
}
