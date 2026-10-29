import type { AgentSession, RunnerId } from '../../core/agent-runner.ts';
import type { WorkerStepIdentity } from '../../delegation/execution-identity.ts';
import { continuationDefStep } from '../../delegation/execution-identity.ts';
import { seedHandoffFile } from '../../handoff.ts';
import { loadConfig } from '../../config.ts';
import type { ActiveRun } from '../active-run.ts';
import { openWaits } from '../waits.ts';
import type { RunOutcome } from '../../runs/outcome-commit.ts';
import type { UiEventSink } from '../../runs/ui-event-sink.ts';
import { stepToolGrant, toolGrantLists, type WorkflowStepDef } from '../types.ts';
import type { Skill } from '../../skills.ts';
import { waitForCachedTeamSkills, waitForTeamSkills } from '../../skills-remote.ts';
import { continuationModel, continuationEffort } from './launch-settings.ts';
import { leadingSlashSkillName, skillSystemPrompt } from './prompts.ts';
import { pendingHumanAskSeq } from './pending-ask-facts.ts';
import { clearAutosaveTimer } from './input-timers.ts';
import { REPOSITORY_ROOT_LOCK_DISABLED_NOTE } from './run-workspace.ts';
import type { RepoRootLease } from './repo-root-lease.ts';
import type { WorktreeAutosave } from './worktree-autosave.ts';
import type { RunSkills } from './run-skills.ts';
import * as sessionEvents from './session-events.ts';
import type { PendingContinuation, ContinuationOpening, OpeningAnswer, ContinuationSettings, ContinuationSkills } from './types.ts';
import { existsSync } from 'node:fs';
import type { RunRecord } from '../../runs/store.ts';
import { rematerializeReclaimedWorktree } from '../../runs/retention.ts';
import { ownedContinuationWorkspace } from './run-workspace.ts';
import type { RunExitId } from '../run-states.ts';
import type { RunLine } from './run-line.ts';
import type { RunModuleContext, WorkerDelegationRecord } from './types.ts';

export interface ContinuationSessionHost {
  move(runId: string, exit: RunExitId, patch?: Partial<RunRecord>): void;
  dropActive(runId: string): void;
  repositoryRootLockDisabled(): boolean;
  prepareWorktree(runId: string, state: ActiveRun, config: Awaited<ReturnType<typeof loadConfig>>['worktreeSetup'], emit: (event: { type: string; [key: string]: unknown }) => void, reason: 'rematerialized' | 'resume'): Promise<string | undefined>;
  workerStep(runId: string, stepId: string | undefined): WorkerStepIdentity | undefined;
  latchAgentInputError(runId: string, state: ActiveRun, session: AgentSession, message: string): void;
  reconcileWorkerWaits(): void;
  holdContinuationForRootFinish(runId: string, item: PendingContinuation, state?: ActiveRun): boolean;
}

/** Owns the Continue workspace and launch session. */
export class ContinuationSession {
  constructor(
    private readonly context: RunModuleContext,
    private readonly host: ContinuationSessionHost,
    private readonly line: RunLine,
    private readonly sharedHost: sessionEvents.SessionHelperHost,
    private readonly repoRootLease: RepoRootLease,
    private readonly autosave: WorktreeAutosave,
    private readonly runSkills: RunSkills,
  ) {}

  /** Where a Continue runs: an owned worker's verified workspace, or the task's worktree, which
   *  retention may have reclaimed (#483), else the repository root. Returns undefined after an
   *  unavailable owned workspace failed the run. */
  async continuationWorkspace(
    runId: string,
    stepId: string,
    record: RunRecord | undefined,
  ): Promise<{ cwd: string; rematerialized: boolean } | undefined> {
    if (record?.delegation?.role === 'worker') {
      const cwd = await this.ownedContinuationWorkspace(runId, stepId, record, record.delegation);
      return cwd === undefined ? undefined : { cwd, rematerialized: false };
    }
    // Retention (#483) rebuilt a reclaimed directory: a bare checkout that needs setup again (#917).
    const rematerialized = await rematerializeReclaimedWorktree(this.context.repoRoot, this.context.store, runId);
    const cwd = record?.worktreePath && existsSync(record.worktreePath) ? record.worktreePath : this.context.repoRoot;
    return { cwd, rematerialized };
  }


  /** An owned worker's workspace for a Continue, verified with its parent's context. Returns
   *  undefined after it failed the run: owned workers never adopt or recreate an unverified resource. */
  async ownedContinuationWorkspace(
    runId: string,
    stepId: string,
    record: RunRecord,
    delegation: WorkerDelegationRecord,
  ): Promise<string | undefined> {
    try {
      return await ownedContinuationWorkspace(this.context.store, this.context.repoRoot, this.context.dataDir, record, delegation);
    } catch (error) {
      const message = `owned workspace unavailable: ${error instanceof Error ? error.message : String(error)}`;
      const finishedAt = new Date().toISOString();
      this.context.store.updateStep(runId, stepId, { status: 'failed', error: message, finishedAt });
      this.host.move(runId, 'fail-start', { error: message, finishedAt, currentStepId: undefined });
      this.context.store.appendEvent(runId, { type: 'lifecycle', message });
      this.line.unmarkStarting(runId);
      this.host.dropActive(runId);
      return undefined;
    }
  }


  /** A Stop that arrived while the Continue resolved its workspace cancels the run before it
   *  becomes active. */
  settleStoppedContinuation(runId: string): boolean {
    if (!this.context.store.getRun(runId)?.stopping) return false;
    this.host.move(runId, 'cancel', { finishedAt: new Date().toISOString() });
    this.line.unmarkStarting(runId);
    this.host.dropActive(runId);
    return true;
  }


  /** The repository-root lease of a Continue that runs in the repository root. Returns undefined
   *  when no lease is needed, so that path does not yield, else whether the lease was granted. */
  continuationRepoRootLease(runId: string, state: ActiveRun): Promise<boolean> | undefined {
    if (state.cwd !== this.context.repoRoot) return undefined;
    if (this.host.repositoryRootLockDisabled()) {
      this.context.store.appendEvent(runId, {
        type: 'note',
        message: REPOSITORY_ROOT_LOCK_DISABLED_NOTE,
      });
      return undefined;
    }
    this.context.store.appendEvent(runId, {
      type: 'note',
      message: 'waiting for exclusive access to the repository working tree',
    });
    return this.acquireContinuationRepoRoot(runId, state);
  }


  /** Wait for the repository-root lease; a Stop during the wait cancels the run. */
  async acquireContinuationRepoRoot(runId: string, state: ActiveRun): Promise<boolean> {
    if (await this.repoRootLease.acquireRepoRoot(runId, state)) return true;
    this.host.move(runId, 'cancel', {
      finishedAt: new Date().toISOString(),
      currentStepId: undefined,
    });
    this.context.store.appendEvent(runId, { type: 'lifecycle', message: 'run cancelled' });
    this.host.dropActive(runId);
    return false;
  }


  /** Arm autosave, seed the handoff file, and run worktree setup. Returns setup's note for the
   *  opening message. */
  async prepareContinuationWorktree(
    runId: string,
    state: ActiveRun,
    record: RunRecord | undefined,
    rematerialized: boolean,
  ): Promise<string | undefined> {
    this.autosave.armAutosave(runId, state);
    if (record) seedHandoffFile(this.context.dataDir, record); // idempotent — normally already there
    // Worktree setup (#917) for a directory retention rebuilt, or one a restart interrupted.
    return this.host.prepareWorktree(
      runId,
      state,
      (await loadConfig(this.context.repoRoot)).worktreeSetup,
      (event) => this.context.store.appendEvent(runId, event),
      rematerialized ? 'rematerialized' : 'resume',
    );
  }


  /** Mark the run and the Continue's step as running, then open the step. A Cursor session resumes
   *  on the transport it was opened with. */
  startContinuationStep(
    runId: string,
    stepId: string,
    record: RunRecord | undefined,
    sessionId: string | undefined,
    backend: RunnerId,
  ): void {
    this.host.move(runId, 'start', {
      error: undefined,
      finishedAt: undefined,
      currentStepId: stepId,
    });
    this.context.store.updateStep(runId, stepId, {
      status: 'running',
      iterations: 1,
      startedAt: new Date().toISOString(),
      sessionId,
      backend,
      ...(sessionId && backend === 'cursor' ? {
        sessionTransport: record?.steps.find((step) => step.sessionId === sessionId)?.sessionTransport ?? 'cursor-acp',
      } : {}),
    });
    this.context.store.appendEvent(runId, { type: 'step-start', stepId, name: 'Continue', kind: 'agent', iteration: 1 });
  }


  /** The human ask a human Continue answers, and the human waits that answer settles. */
  openingAnswer(runId: string, state: ActiveRun, opening: ContinuationOpening): OpeningAnswer {
    const askSeq = opening.checkpoint?.origin === 'human' ? pendingHumanAskSeq(this.context.store, runId) : undefined;
    state.openingAnswerAskSeq = askSeq;
    // The human waits this answer answers; one the opening turn opens is its next question.
    const waits = askSeq === undefined ? []
      : openWaits(this.context.store.getRun(runId) ?? {}).filter(wait => wait.kind === 'human').map(wait => wait.id);
    return { askSeq, waits, parentAnswer: opening.parentAnswer };
  }


  /**
   * A completed turn acknowledges the opening payload. Until then a restart
   * must replay it, including a crash after startSession but before delivery.
   * Returns false when the opening input's checkpoint failed, and the turn end stops there.
   */
  acknowledgeOpeningTurn(runId: string, state: ActiveRun, answer: OpeningAnswer): boolean {
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
    try { this.context.store.commitOutcome(runId, outcomes, { patch: { continuationMessage: undefined } }, { bestEffort: !opening }); }
    catch (error) { this.host.latchAgentInputError(runId, state, session!, `agent input delivery checkpoint failed: ${error instanceof Error ? error.message : String(error)}`); return false; }
    if (opening) { state.openingAgentInputId = undefined; this.host.reconcileWorkerWaits(); }
    if (askSeq !== undefined) {
      this.context.store.appendEvent(runId, { type: 'human-input-delivered', askSeq, ...(answer.parentAnswer ? { source: 'parent' } : {}) });
      answer.askSeq = undefined;
      state.openingAnswerAskSeq = undefined;
    }
    return true;
  }


  /**
   * What a Continue runs with. Backend + model come off the record: the run's current backend by
   * default, or the follow-up override that `continueRun` persisted before scheduling (#401).
   * Returns undefined after a pre-spawn gate failed the turn.
   */
  async continuationLaunchSettings(
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
    const toolsStep = continuationDefStep(this.context.store, record, sessionId);
    const stepIdentity = this.host.workerStep(runId, toolsStep?.id);
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
    const model = await continuationModel(this.context.store, this.context.repoRoot, runId, state, record, toolsStep, stepIdentity, backend);
    if (typeof model === 'string') { this.failContinuationBeforeSpawn(runId, stepId, sink, model); return undefined; }
    const effort = continuationEffort(this.context.repoRoot, record, toolsStep, stepIdentity);
    if (typeof effort === 'string') { this.failContinuationBeforeSpawn(runId, stepId, sink, effort); return undefined; }
    // The temp-directory preflight (#785) rides along with the account resolution: a resumed
    // turn hits the same broken `/tmp` a fresh one would, and an agent whose shell silently
    // returns nothing is worse than a turn that refuses to start and says why. So does an account
    // that would open another folder than the one its session lives in (#1283).
    const profile = await sessionEvents.stepProfileFor(this.context, this.sharedHost, runId, backend, {
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
  failContinuationBeforeSpawn(runId: string, stepId: string, sink: UiEventSink, message: string): void {
    const failedAt = new Date().toISOString();
    sink.sessionEnded('error', message);
    this.context.store.updateStep(runId, stepId, {
      status: 'failed',
      error: message,
      finishedAt: failedAt,
    });
    this.host.move(runId, 'fail-start', {
      error: `continue failed: ${message}`,
      finishedAt: failedAt,
      currentStepId: undefined,
    });
    this.context.store.appendEvent(runId, {
      type: 'lifecycle',
      message: `continue failed — ${message}`,
    });
    this.host.dropActive(runId);
  }


  /** Record the Continue's account on its step and the settings its workers inherit. */
  applyContinuationSettings(
    runId: string,
    stepId: string,
    state: ActiveRun,
    backend: RunnerId,
    settings: ContinuationSettings,
  ): void {
    this.context.store.updateStep(runId, stepId, { profileId: settings.profile.profileId });
    state.delegationSettings = { cwd: state.cwd, runner: backend, model: settings.backendModel,
      effort: settings.effort, agentProfile: settings.profile.profileId, accountBinding: settings.profile.accountBinding,
      systemPrompt: settings.extraSystemPrompt, ...toolGrantLists(settings.toolGrant) };
  }


  /** The continued step's skill files and playbook, when the step names a skill or the prompt
   *  starts with a `/name`. Returns undefined otherwise, so that path does not yield. */
  continuationSkills(
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
  async provisionContinuationSkills(
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
      let skill = this.runSkills.enabledSkills(state).find((candidate) => candidate.name === continuedSkillName);
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
        this.context.store.appendEvent(runId, {
          type: 'lifecycle',
          message: `skill /${continuedSkillName} is not in the skill registry — its instructions were not re-sent to the continued session`,
        });
      }
    }
    if (!continuedSkillName || !this.runSkills.enabledSkills(state).some((candidate) => candidate.name === continuedSkillName)) {
      if (continuationSlash) files = (await this.runSkills.provisionRunSkills(runId, state, { slash: continuationSlash })).filesDir;
    }
    return { skillPrompt, fallbackSkillPrompt, files };
  }


  /** The continued step's skill when the registry did not list it yet. */
  async awaitContinuedSkill(state: ActiveRun, continuedSkillName: string): Promise<Skill | undefined> {
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
        waitForTeamSkills(this.context.repoRoot).then(settle, settle);
        waitForCachedTeamSkills(this.context.repoRoot).then((cached) => {
          if (cached.some((candidate) => candidate.name === continuedSkillName)) settle();
        }, () => undefined);
      });
      await this.runSkills.loadRunSkills(state, 'ignore');
      return this.runSkills.enabledSkills(state).find((candidate) => candidate.name === continuedSkillName);
    } catch {
      // Best-effort — a slow or failing team-skills load must not fail Continue.
      return undefined;
    }
  }


  /** A Stop before the Continue's session spawned: cancel the step and the run. */
  settleContinuationPrelaunchCancel(runId: string, stepId: string, state: ActiveRun): void {
    this.context.store.updateStep(runId, stepId, { status: 'cancelled' });
    this.host.move(runId, 'cancel', { finishedAt: new Date().toISOString(), currentStepId: undefined });
    clearAutosaveTimer(state); this.host.dropActive(runId);
  }


  /** A Continue's launch went stale while it provisioned (`launchStale`). A replaced active run
   *  needs nothing more; a Stop cancels the run; a root Finish holds the Continue in the queue. */
  settleStaleContinuationLaunch(
    runId: string,
    stepId: string,
    state: ActiveRun,
    held: Omit<PendingContinuation, 'lineJoinedAt'>,
  ): void {
    if (this.sharedHost.active.get(runId) !== state) return;
    if (state.cancelled || this.sharedHost.workerExecutionStopped(runId)) {
      state.cancelled = true;
      this.settleContinuationPrelaunchCancel(runId, stepId, state);
    } else {
      this.host.holdContinuationForRootFinish(runId, { ...held, lineJoinedAt: Date.now() }, state);
    }
  }

}
