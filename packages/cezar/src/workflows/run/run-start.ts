import { agentModelsLocked } from '../../core/agent-model-policy.ts';
import { delegationStateSchema } from '@open-mercato/cezar-contract/delegation';
import { workerIdentity, ownedWorkflow } from '../../delegation/execution-identity.ts';
import { DelegationPolicyError } from '../../delegation/policy.ts';
import { makeRunTitle } from '../../runs/run-title.ts';
import { extractTaskRefs, refineTaskRefs } from '../../runs/task-refs.ts';
import type { RunRecord, RunStore } from '../../runs/store.ts';
import type { RunnerId, ContentBlock } from '../../core/agent-runner.ts';
import type { ActiveRun } from '../active-run.ts';
import type { PastedContent, PersistedAttachment } from '../pasted-content.ts';
import { queuedRecoveryInput } from '../run-scheduling.ts';
import type { RunExitId } from '../run-states.ts';
import { QUICK_TASK_WORKFLOW, stepKind, type WorkflowDef } from '../types.ts';
import { clearIdleTimer, clearAutosaveTimer } from './input-timers.ts';
import type { PendingJob, RunLine } from './run-line.ts';
import type { RunModuleContext, StartRunInput, PendingContinuation } from './types.ts';
import type { AttachmentWriter } from './attachment-writer.ts';
import type { TurnBookkeeper } from './turn-bookkeeping.ts';
import type { QueuedInput } from './queued-input.ts';
import type { ContinuationAcceptance } from './continuation-acceptance.ts';
import type { WorkerExecutions } from './worker-executions.ts';

interface RunStartHost {
  active: Map<string, ActiveRun>;
  startRun(workflow: WorkflowDef, input: StartRunInput, request?: { id: string; hash: string }): RunRecord;
  execute(runId: string, workflow: WorkflowDef, input: StartRunInput, startAt?: number): Promise<void>;
  runContinuation(runId: string, stepId: string, sessionId: string | undefined, backend: RunnerId, prompt: string,
    images?: PastedContent[], persistedImages?: ContentBlock[], persistedAttachments?: PersistedAttachment[]): Promise<void>;
  move(runId: string, exit: RunExitId, patch?: Omit<Parameters<RunStore['updateRun']>[1], 'status'>): RunRecord | undefined;
  dropActive(runId: string): void;
  historyDeletionPending(runId: string): boolean;
}

/** Creates runs and launches jobs at the head of the scheduler's line. */
export class RunStart {
  constructor(private readonly context: RunModuleContext, private readonly host: RunStartHost,
    private readonly line: RunLine, private readonly attachments: AttachmentWriter,
    private readonly turnBookkeeper: TurnBookkeeper, private readonly queuedInput: QueuedInput,
    private readonly continuationAcceptance: ContinuationAcceptance, private readonly workerExecutions: WorkerExecutions) {}

  /**
   * Idempotent start (hearsay-tools/cezarion#504, spec 2026-09-24-cez-task-cli). Lookup and create share one
   * synchronous path, so the event loop serialises concurrent retries: the first creates, every
   * later one with the same hash gets that run back, and a different hash is a conflict.
   */
  startRunIdempotent(
    workflow: WorkflowDef,
    input: StartRunInput,
    request: { id: string; hash: string },
  ): { run: RunRecord; created: boolean } | { conflict: true } {
    const existing = this.context.store.findRunByClientRequestId(request.id);
    if (existing) {
      return existing.clientRequestHash === request.hash ? { run: existing, created: false } : { conflict: true };
    }
    return { run: this.host.startRun(workflow, input, request), created: true };
  }

  startRun(
    workflow: WorkflowDef,
    input: StartRunInput,
    clientRequest?: { id: string; hash: string },
  ): RunRecord {
    // Sanitize at the manager boundary so CLI runs, workflows, and
    // direct callers cannot bypass the HTTP policy.
    const effectiveInput = agentModelsLocked(this.context.repoRoot)
      ? { ...input, model: undefined, effort: undefined }
      : input;
    const run = this.context.store.createRun({
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
      this.context.store.updateRun(run.id, { workflowDef: workflow });
      // Initial pasted attachments must be visible while the run is still queued (#612),
      // and must survive a restart before a slot opens. Persist them before the job
      // enters `pendingJobs`; `hydrateQueuedInput` reconstructs their content blocks
      // from these URLs when a recovered run eventually starts — and for a file (#950)
      // this write is the ONLY copy, since it never had a block to be rebuilt from.
      if (input.images?.length) {
        const persisted = this.attachments.persistPastedAttachments(run.id, input.images);
        if (persisted.length) {
          this.context.store.updateRun(run.id, { taskImages: persisted.map((saved) => saved.url) });
        }
      }
      // Step-0 reference extraction (task auto-naming spec): the regex layer's
      // numbers persist immediately; the namer may add the kind it verified later.
      const skillHint = workflow.steps.find((s) => stepKind(s) === 'agent' && s.skill)?.skill?.trim();
      const refs = refineTaskRefs(extractTaskRefs(input.task), skillHint);
      if (refs.prNumber !== undefined || refs.issueNumber !== undefined) {
        this.context.store.updateRun(run.id, {
          ...(refs.prNumber !== undefined ? { prNumber: refs.prNumber } : {}),
          ...(refs.issueNumber !== undefined ? { issueNumber: refs.issueNumber } : {}),
        });
      }
      // Fire-and-forget LLM naming (task auto-naming spec): the heuristic title
      // above shows instantly; the namer's short title replaces it when (and if)
      // the model answers. Never awaited, never fails the run.
      void this.turnBookkeeper.autoNameRun(run.id, skillHint, input.task);
    } finally {
      this.line.enqueueJob(run.id, { workflow, input: effectiveInput });
      void this.line.pump();
    }
    return run;
  }

  /** Accept only the store's already-durable owned creation, never caller-supplied paths/workflows. */
  enqueueOwnedRun(runId: string): void {
    const run = this.context.store.getRun(runId);
    if (!run) throw new DelegationPolicyError('incompatible_state', 'Owned queued run not found');
    const job = this.ownedJob(run);
    if (this.line.hasQueued(runId) || this.line.hasStarting(runId) || this.host.active.has(runId)) return;
    this.line.enqueueJob(runId, job);
    void this.line.pump();
  }

  ownedJob(run: RunRecord): { workflow: WorkflowDef; input: StartRunInput } {
    const delegation = delegationStateSchema.safeParse(run.delegation);
    if (this.host.historyDeletionPending(run.id) || run.status !== 'queued' || !delegation.success || delegation.data.role !== 'worker' ||
        delegation.data.workspace.ownerRunId !== run.id || delegation.data.destroy) {
      throw new DelegationPolicyError('incompatible_state', 'Run is not an executable owned creation');
    }
    // Accepted permissions are private immutable evidence. Only explicit internal
    // primitive records retain the public-definition compatibility path.
    const grants = workerIdentity(this.context.store, this.context.repoRoot, run.id)?.grants
      ?? run.workflowDef?.steps.find(step => step.id === QUICK_TASK_WORKFLOW.steps[0]!.id);
    return {
      workflow: ownedWorkflow(run, this.context.store.readWorkerIdentity(run.id)) ?? { ...QUICK_TASK_WORKFLOW, steps: [{ ...QUICK_TASK_WORKFLOW.steps[0]!,
        ...(grants?.allowedTools === undefined ? {} : { allowedTools: [...grants.allowedTools] }),
        ...(grants?.bashAllowlist === undefined ? {} : { bashAllowlist: [...grants.bashAllowlist] }),
      }] },
      input: { ...queuedRecoveryInput(run), worktree: true },
    };
  }

  /** Read and hydrate mutable queued input in the same synchronous tick as dequeue. */
  launchQueuedRun(runId: string, job: PendingJob | undefined, continuation: PendingContinuation | undefined): void {
    if (continuation) {
      void (async () => {
        const hydrated = this.queuedInput.hydrateQueuedContinuation(runId, continuation);
        await this.context.work.track('runContinuation', this.host.runContinuation(
          runId,
          hydrated.stepId,
          hydrated.sessionId,
          hydrated.backend,
          hydrated.prompt,
          hydrated.images,
          hydrated.persistedImages,
          hydrated.persistedAttachments,
        ));
      })().catch((err: unknown) => this.continuationAcceptance.failCrashedContinuation(runId, err))
        .finally(() => this.workerExecutions.finishWorkerExecution(runId));
      return;
    }
    if (!job) return;
    // Rebuild the prompt from the store at the last instant (open-mercato/cezar#472), so an edit
    // or a stacked message that landed while the run waited is honored. Entered
    // in the same synchronous tick as the `pendingJobs.delete` above, so no
    // handler can observe a half-dequeued run.
    void (async () => {
      const input = this.queuedInput.hydrateQueuedInput(runId, job.input);
      await this.context.work.track('execute', this.host.execute(runId, job.workflow, input, job.startAt));
    })().catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      this.host.move(runId, 'fail-crash', {
        error: `engine crashed: ${message}`,
        finishedAt: new Date().toISOString(),
      });
      const state = this.host.active.get(runId);
      if (state) {
        clearIdleTimer(state);
        clearAutosaveTimer(state);
      }
      this.line.unmarkStarting(runId);
      this.host.dropActive(runId);
    }).finally(() => this.workerExecutions.finishWorkerExecution(runId));
  }

}
