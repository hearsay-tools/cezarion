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

interface StepLoopHost {
  move(id: string, exit: RunExitId, patch?: Omit<Parameters<RunStore['updateRun']>[1], 'status'>): RunRecord | undefined;
  dropActive(id: string): void;
  workerExecutionStopped(id: string): boolean;
  executionBlockedByRootFinish(run: RunRecord): boolean;
}

/** Owns fresh workflow launch, worktree setup and step execution. */
export class StepLoop {
  constructor(private readonly context: RunModuleContext, private readonly host: StepLoopHost,
    private readonly line: RunLine, private readonly worktreeAutosave: WorktreeAutosave) {}

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
}
