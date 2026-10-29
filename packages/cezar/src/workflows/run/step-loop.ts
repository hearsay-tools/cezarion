import type { RunnerId } from '../../core/agent-runner.ts';
import type { RunRecord, RunStore } from '../../runs/store.ts';
import type { ActiveRun } from '../active-run.ts';
import type { WorkflowDef } from '../types.ts';
import type { RunExitId } from '../run-states.ts';
import { transition } from '../run-states.ts';
import { accountHeldFor } from '../run-scheduling.ts';
import { loadConfig } from '../../config.ts';
import { getHeadCommit, getRepoInfo } from '../../server/git.ts';
import { seedAgentConfigLocalLayer } from '../../agent-config/seed.ts';
import { AgentTempDirError, agentTmpEnv } from '../../runs/agent-tmpdir.ts';
import { resolveWorktreeSetup, runWorktreeSetup, worktreeSetupAgentNote, worktreeSetupEndNote, worktreeSetupEnv, worktreeSetupRecordError, worktreeSetupStartNote, type WorktreeSetupOutcome } from '../../worktree-setup.ts';
import { taskModelIdentity } from './launch-settings.ts';
import { resolveExtraSystemPrompt } from './prompts.ts';
import { executionBaseRef, openExecutionWorktree, executionSeedFiles } from './run-workspace.ts';
import { clearAutosaveTimer } from './input-timers.ts';
import type { RunLine } from './run-line.ts';
import type { WorktreeAutosave } from './worktree-autosave.ts';
import type { Execution, ExecutionLaunch, RunModuleContext, StartRunInput } from './types.ts';

import type { ContentBlock } from '../../core/agent-runner.ts';
import type { StepState } from '../../runs/store.ts';
import type { WorkflowStepDef } from '../types.ts';
import { chainStepNote, stepKind } from '../types.ts';
import type { PersistedAttachment } from '../pasted-content.ts';
import { openWaits } from '../waits.ts';
import { runGroupedCommand } from '../grouped-command.ts';
import * as stepDecisions from './step-decisions.ts';
import { preserveRunAfterDisposal } from './run-guards.ts';
import { holdsClosingWakes, type CompletionGateHost } from './completion-gate.ts';
import type { HumanWaits } from './human-waits.ts';
import type { RunSettlement } from './run-settlement.ts';
import type { StepSession } from './step-session.ts';
import type { StepLoop as StepLoopOutcome } from './types.ts';

const CHECK_OUTPUT_CAP = 20_000;

interface StepLoopHost {
  active: Map<string, ActiveRun>;
  closingWakeDecision(id: string, holds: boolean, cancelled: boolean, error: string | undefined): 'park' | 'settle' | 'capped';
  owesDelivery(id: string): boolean;
  move(id: string, exit: RunExitId, patch?: Omit<Parameters<RunStore['updateRun']>[1], 'status'>): RunRecord | undefined;
  dropActive(id: string): void;
  workerExecutionStopped(id: string): boolean;
  executionBlockedByRootFinish(run: RunRecord): boolean;
}

/** Owns fresh workflow launch, worktree setup and step execution. */
export class StepLoop {
  constructor(private readonly context: RunModuleContext, private readonly host: StepLoopHost,
    private readonly line: RunLine, private readonly worktreeAutosave: WorktreeAutosave,
    private readonly humanWaits: HumanWaits, private readonly runSettlement: RunSettlement,
    private readonly stepSession: StepSession, private readonly completionGateHost: CompletionGateHost,
    private readonly wakeSessionClosedError: string) {}

  /**
   * The launch half of `execute`: the backend, extra system prompt and model identity the run
   * starts with, recorded on the run as it starts. Undefined when the run was cancelled or went
   * back to the queue first.
   */
  async startExecution(execution: Execution): Promise<ExecutionLaunch | undefined> {
    const { runId, workflow, input, startAt, state, emit } = execution;
    // Resolve the agent backend for this run: the task choice (GUI) wins over
    // the config default. Per-step `runner` can still override it at the step.
    const config = await loadConfig(this.context.repoRoot);
    if (state.cancelled || this.context.store.getRun(runId)?.stopping) {
      this.host.move(runId, 'cancel', { finishedAt: new Date().toISOString() });
      this.host.dropActive(runId);
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
    const extraSystemPrompt = this.context.store.getRun(runId)?.delegation?.role === 'worker'
      ? input.systemPrompt
      : resolveExtraSystemPrompt(input.systemPrompt, config.systemPrompt);
    const modelIdentity = await taskModelIdentity(this.context.repoRoot, taskBackend, input);
    if (state.cancelled) {
      this.host.move(runId, 'cancel', { finishedAt: new Date().toISOString() });
      this.host.dropActive(runId);
      return undefined;
    }
    const ownedRun = this.context.store.getRun(runId);
    const owned = ownedRun?.delegation?.role === 'worker' ? ownedRun.delegation.workspace : undefined;
    this.context.store.updateRun(runId, {
      // A resumed workflow stays durably queued until its next step is actually
      // entered. If setup crashes, recovery can replay from `startAt` instead
      // of treating the previous continuation as the interrupted step.
      status: transition(startAt > 0 ? 'start-held' : 'start', () => this.context.store.getRun(runId)),
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
  async prepareExecutionWorktree(execution: Execution, launch: ExecutionLaunch): Promise<boolean> {
    const { runId, input, emit } = execution;
    const repo = await getRepoInfo(this.context.repoRoot);
    if (repo && input.worktree === false && !launch.owned) {
      // Composer opt-out: run in the repo working tree, no branch/worktree. The
      // repository-root lease serializes these runs by default; the explicit
      // CEZ_DISABLE_REPO_LOCK=1 escape hatch allows unsafe overlap.
      // Pin the starting commit: the session's Changes and Commits views use it
      // as their stable lower bound while reading the current working copy.
      const startingCommit = await getHeadCommit(repo.root);
      if (startingCommit && !launch.ownedRun?.baseBranch) this.context.store.updateRun(runId, { baseBranch: startingCommit });
      emit({ type: 'note', message: 'worktree off — running in the repo working tree' });
    } else if (repo || launch.owned) {
      emit({
        type: 'note',
        message: `worktree on — using an isolated task worktree (${input.worktree === true ? 'explicit request' : 'default'})`,
      });
      const base = await executionBaseRef(this.context.store, this.context.repoRoot, execution, repo, launch);
      return this.createExecutionWorktree(execution, launch, base);
    } else {
      emit({ type: 'note', message: 'not a git repository — running in place, one task at a time' });
    }
    return true;
  }

  /** Opens the task's worktree and prepares it for the first step. False when the worker stopped
   *  first, or when the worktree could not be established, which fails the run. */
  async createExecutionWorktree(execution: Execution, launch: ExecutionLaunch, base: string): Promise<boolean> {
    const { runId, state, emit } = execution;
    const { owned, ownedRun } = launch;
    try {
      if (this.host.workerExecutionStopped(runId)) { this.host.dropActive(runId); return false; }
      const wt = await openExecutionWorktree(this.context.store, this.context.repoRoot, this.context.dataDir, execution, launch, base);
      state.cwd = wt.path;
      this.context.store.updateRun(runId, {
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
      const seededConfig = await seedAgentConfigLocalLayer(this.context.repoRoot, state.cwd, process.env, attached).catch(() => []);
      if (seededConfig.length > 0) {
        emit({ type: 'note', message: `seeded personal agent config: ${seededConfig.join(', ')}` });
      }
      this.worktreeAutosave.armAutosave(runId, state);
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const error = `worktree creation failed: ${message}`;
      emit({ type: 'note', message: `${error} — task stopped before workflow execution` });
      this.host.move(runId, 'fail-start', {
        error,
        finishedAt: new Date().toISOString(),
        currentStepId: undefined,
      });
      emit({ type: 'lifecycle', message: `run failed — ${error}` });
      this.host.dropActive(runId);
      return false;
    }
  }

  /**
   * Worktree setup (#917, spec `.ai/specs/2026-10-07-worktree-setup.md`): run the project's
   * `worktreeSetup` commands in this run's isolated worktree when it needs them, and return the
   * paragraph for the agent's opening message. `start` is a new task or worker, `rematerialized`
   * a Continue that rebuilt a reclaimed directory, and `resume` any other Continue, which only
   * finishes a setup a restart interrupted. In-place and non-Git runs never get setup: that tree
   * is the user's own checkout.
   */
  async prepareWorktree(
    runId: string,
    state: ActiveRun,
    raw: unknown,
    emit: (event: { type: string; [k: string]: unknown }) => void,
    trigger: 'start' | 'rematerialized' | 'resume',
  ): Promise<string | undefined> {
    const record = this.context.store.getRun(runId);
    if (!record || state.cwd === this.context.repoRoot) return undefined;
    const plan = resolveWorktreeSetup(raw);
    const interrupted = record.worktreeSetup?.status === 'running';
    if (plan.kind === 'none') {
      // A restart interrupted setup the project has since removed: nothing is left to finish.
      if (interrupted) this.context.store.updateRun(runId, { worktreeSetup: undefined });
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
      this.context.store.updateRun(runId, { worktreeSetup: { status: 'running', startedAt } });
      this.context.store.flush();
      emit({ type: 'note', message: worktreeSetupStartNote(plan.commands.length) });
      let tmpEnv: Record<string, string> = {};
      try {
        tmpEnv = agentTmpEnv(this.context.dataDir, runId);
      } catch (err) {
        if (!(err instanceof AgentTempDirError)) throw err;
      }
      outcome = await runWorktreeSetup({
        plan,
        cwd: state.cwd,
        env: worktreeSetupEnv({ projectRoot: this.context.repoRoot, runId, tmpEnv }),
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
    this.context.store.updateRun(runId, {
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
  requeueWhileHeld(
    runId: string,
    workflow: WorkflowDef,
    input: StartRunInput,
    runner: RunnerId,
    state?: ActiveRun,
    startAt?: number,
  ): boolean {
    const run = this.context.store.getRun(runId);
    if (!run || run.status === 'cancelled' || state?.cancelled) return false;
    // The watchdog sent this one through. Checked, never consumed: the spawn path asks this
    // question TWICE — here at the top of `execute`, and again after the exclusive repo-root
    // lease is granted — so a one-shot flag would clear at the first gate and let the second one
    // hand an in-place run straight back, re-wedging the queue the rescue had just freed.
    // `dropActive` retires the entry on every terminal path, so the set still cleans itself up.
    const finishHeld = this.host.executionBlockedByRootFinish(run);
    if (!finishHeld && (this.line.isForced(runId) ||
      !accountHeldFor({ ...run, runner }, this.context.semaphore.accountHolds(), runner))) return false;
    state?.releaseRepoRoot?.();
    if (state) { state.releaseRepoRoot = undefined; clearAutosaveTimer(state); }
    this.line.enqueueJob(runId, { workflow, input, startAt });
    this.host.move(runId, 'requeue', {
      ...(startAt !== undefined && startAt > 0 ? {} : { startedAt: undefined }),
      currentStepId: undefined,
    });
    this.context.store.appendEvent(runId, {
      type: 'note',
      message: finishHeld ? 'held in the queue — parent finish is pending' : 'held in the queue — this agent account is waiting out a usage limit',
    });
    this.host.dropActive(runId);
    return true;
  }
  /**
   * The step loop of `execute`, from `startAt`. Returns its outcome for `settleExecution`, or
   * undefined when the run left this execution: parked, back in the queue, or held by another
   * owner.
   */
  async runWorkflowSteps(
    execution: Execution,
    launch: ExecutionLaunch,
    opening: { attachments: PersistedAttachment[]; images: ContentBlock[] | undefined; setupNote: string | undefined },
  ): Promise<StepLoopOutcome | undefined> {
    const { runId, workflow, input, startAt, state, emit } = execution;
    const loop: StepLoopOutcome = { checkFailure: null, runError: null, deliveryCapped: false };
    let startImages = opening.images;
    let startAttachments = opening.attachments;
    let startSetupNote = opening.setupNote;

    let i = startAt;
    while (i < workflow.steps.length) {
      if (state.cancelled || this.host.workerExecutionStopped(runId)) { state.cancelled = true; break; }
      const step = workflow.steps[i] as WorkflowStepDef;
      const kind = stepKind(step);
      const record = this.context.store.getRun(runId)?.steps.find((s) => s.id === step.id);
      const iteration = (record?.iterations ?? 0) + 1;

      this.host.move(runId, 'start', { currentStepId: step.id });
      this.context.store.updateStep(runId, step.id, {
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
        const failure = await this.stepSession.runAgentStep(
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
      if (state.cancelled || preserveRunAfterDisposal(this.context.store, this.context.disposed, runId, state)) break;
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
  nextAfterAgentStep(
    execution: Execution,
    launch: ExecutionLaunch,
    loop: StepLoopOutcome,
    attempt: { index: number; step: WorkflowStepDef; nextStep: WorkflowStepDef | undefined; failure: string | null; startedAt: number },
  ): 'next' | 'settle' | 'handed-off' {
    const { runId, workflow, input, state, emit } = execution;
    const { step, failure } = attempt;
    // Stale setup cannot finalize a replacement owner. Disposal also clears
    // active, but must still honor a previously accepted Stop/Finish intent.
    if (this.host.active.get(runId) !== state &&
      !(this.context.disposed() && (state.cancelled || state.finishRequested))) return 'handed-off';
    if (state.cancelled || preserveRunAfterDisposal(this.context.store, this.context.disposed, runId, state)) return 'settle';
    this.humanWaits.withdrawCezarHumanWaits(runId);
    this.expireStepDeadlineWaits(runId, step, failure, attempt.startedAt);
    const current = this.context.store.getRun(runId);
    if (current && this.host.executionBlockedByRootFinish(current) && !state.sessionEverOpened) {
      this.context.store.updateStep(runId, step.id, { status: 'pending' });
      this.requeueWhileHeld(runId, workflow, input, launch.taskBackend, state, attempt.index);
      return 'handed-off';
    }
    if (this.settleAgentStepWakes(execution, step.id, failure, loop)) return 'handed-off';
    if (failure || loop.deliveryCapped) return 'settle';
    // A session that closed without a done leaves its step resumable; the tail never starts.
    const incomplete = this.runSettlement.stepLeftOpen(state, step.id, attempt.nextStep);
    state.completedStepId = undefined;
    if (incomplete) { loop.incompleteStepId = step.id; return 'settle'; }
    if (state.idleClosed || this.runSettlement.supersedeFallbackThenWorkflowAsk(runId, state)) return 'settle';
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
  expireStepDeadlineWaits(runId: string, step: WorkflowStepDef, failure: string | null, attemptStartedAt: number): void {
    if (failure && step.timeoutMs && Date.now() - attemptStartedAt >= step.timeoutMs) {
      const human = openWaits(this.context.store.getRun(runId) ?? {}).filter(wait => wait.kind === 'human').map(wait => wait.id);
      if (human.length) this.context.store.commitOutcome(runId, { kind: 'cancelled', waitIds: human });
    }
  }

  /**
   * Records a failed agent step, then settles what the run's closing wakes need. True when the
   * run parked to deliver them; a capped delivery fails the step and marks the loop capped.
   */
  settleAgentStepWakes(execution: Execution, stepId: string, failure: string | null, loop: StepLoopOutcome): boolean {
    const { runId, state, emit } = execution;
    // runAgentStep already emitted session.ended(error). Record the failed
    // attempt before parking so later successful CI recovery cannot erase it.
    if (failure) {
      if (holdsClosingWakes(this.context, this.completionGateHost, runId)) this.context.store.updateRun(runId, { workflowResumeStepId: stepId });
      this.finishStep(runId, stepId, 'failed', failure, emit);
      loop.runError = `step "${stepId}" failed: ${failure}`;
    }
    // A clean close that leaves results undelivered is a failed delivery too.
    const undelivered = failure ?? (this.host.owesDelivery(runId) ? this.wakeSessionClosedError : undefined);
    const delivery = this.host.closingWakeDecision(runId, holdsClosingWakes(this.context, this.completionGateHost, runId), state.cancelled, undelivered || undefined);
    if (delivery === 'capped') {
      loop.deliveryCapped = true;
      if (!failure) {
        this.finishStep(runId, stepId, 'failed', this.wakeSessionClosedError, emit);
        loop.runError = `step "${stepId}" failed: ${this.wakeSessionClosedError}`;
      }
    }
    if (delivery !== 'park') return false;
    this.humanWaits.surfaceHumanWait(runId, state);
    this.host.move(runId, 'park', {
      ...(failure ? { error: loop.runError! } : {}) });
    this.context.store.flush(); // checkpoint the failed attempt and its recoverable workflow cursor before parking
    this.host.dropActive(runId);
    return true;
  }

  /**
   * A check step's result: a pass goes on to the next step, a failure loops back to its
   * `onFail.retry` step while retries remain, and otherwise fails the run. Returns the index the
   * step loop continues from, or undefined when the run fails.
   */
  settleCheckStep(
    execution: Execution,
    index: number,
    record: StepState | undefined,
    check: { ok: boolean; output: string },
    loop: StepLoopOutcome,
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
        this.context.store.updateStep(runId, s.id, { status: 'pending' });
      }
      this.context.store.updateStep(runId, step.id, { retriesUsed: outcome.used + 1 });
      this.host.move(runId, 'requeue', { currentStepId: undefined });
      // The retry target and its consumed budget form one crash boundary: a
      // restart must observe the queued target, budget, and cursor together.
      this.context.store.flush();
      return outcome.retryIndex;
    }

    this.finishStep(runId, step.id, 'failed', outcome.error, emit);
    loop.runError = outcome.runError;
    return undefined;
  }

  async runCheckStep(
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

  finishStep(
    runId: string,
    stepId: string,
    status: 'done' | 'failed',
    error: string | undefined,
    emit: (event: { type: string; stepId?: string; [k: string]: unknown }) => void,
  ): void {
    this.context.store.updateStep(runId, stepId, {
      status,
      error,
      finishedAt: new Date().toISOString(),
    });
    emit({ type: 'step-end', stepId, status, ...(error ? { error } : {}) });
  }
}
