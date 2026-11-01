import { randomUUID } from 'node:crypto';
import type { HumanWaitEntry } from '@open-mercato/cezar-contract/waits';
import { isUsageLimitHold } from '@open-mercato/cezar-contract/waits';
import { hasLiveInboxClaim } from '../../delegation/input.ts';
import { transition, type RunExitId } from '../run-states.ts';
import { holdsOwedResults, isCezarHumanWait, openWaits } from '../waits.ts';
import type { ContinueRunOptions } from '../continuation-admission.ts';
import type { WorkerScratchCleanup } from '../../delegation/scratch-cleanup.ts';
import type { HumanWaits } from './human-waits.ts';
import type { WaitWatches } from './wait-watches.ts';
import type { InboxClaims } from './inbox-claims.ts';
import type { WorkerOrphans } from './worker-orphans.ts';
import { hasPendingHumanAsk, pendingHumanAskSeq } from './pending-ask-facts.ts';
import { ciWorkflowResumeStepIndex } from './workflow-position.ts';
import type { RunRecord, RunStore } from '../../runs/store.ts';
import type { RunModuleContext } from './types.ts';
import { familyOf, rootFinishRequested } from './run-guards.ts';
import type { FamilyReconciler } from './family-reconciler.ts';
import type { WorkerQuestions } from './worker-questions.ts';
import type { AutoResumeScheduler } from './auto-resume.ts';

interface RunRecoveryHost {
  workerScratchCleanup: WorkerScratchCleanup; humanWaits: HumanWaits; waitWatches: WaitWatches;
  inboxClaims: InboxClaims; orphans: WorkerOrphans;
  isActive(id: string): boolean; workerExecutionStopped(id: string): boolean;
  move(id: string, exit: RunExitId, patch?: Omit<Parameters<RunStore['updateRun']>[1], 'status'>): unknown;
  cancel(id: string): unknown;
  continueRun(id: string, opts: ContinueRunOptions, defer: boolean): { ok: boolean; error?: string };
  reviveQueuedRun(run: RunRecord, reason: string): Promise<void>;
  requeueInterruptedRun(run: RunRecord, step: RunRecord['currentStepId']): boolean;
  checkpointRestartContext(run: RunRecord): RunRecord;
  deliverConversationInput(id: string): void; answerRoutedQuestion(id: string): void;
  queueWaitWake(id: string): void; owesWake(run: RunRecord): boolean; cancelOpenWaits(id: string): void;
  settleOrphanedWorkerExecution(id: string): boolean; settleRequestedRootFinish(id: string): Promise<void>;
  settleSuccess(id: string): Promise<void>; reconcileWorkerWaits(family?: string): void;
  pump(): Promise<void>; recover(family?: string): Promise<void>;
}

export class RunRecovery {
  /** What the recovery in progress covers: every run at boot (`family` undefined), or the one
   *  family an adoption hands it (#779, plan step 3). Undefined: no recovery in progress. */
  private recoveryScope: { family?: string } | undefined;
  /** Settles when the recovery in progress (if any) has finished. */
  private recoveryInFlight: Promise<void> | undefined;
  /** Adoptions of dead processes' runs, one at a time (`adoptOrphanedRun`). */
  private adoptionTail: Promise<unknown> = Promise.resolve();

  constructor(private readonly context: RunModuleContext, private readonly familyReconciler: FamilyReconciler,
    private readonly workerQuestions: WorkerQuestions, private readonly autoResumeScheduler: AutoResumeScheduler,
    private readonly host: RunRecoveryHost, private readonly restartContinuationPrompt: string) {}

  /** Whether any recovery is in progress: one at a time (`recover`), and `pump` waits for it. */
  get recovering(): boolean {
    return this.recoveryScope !== undefined;
  }

  /**
   * Whether a recovery in progress holds this run, so its wakes, input flushes and delegation
   * reconciles wait for that recovery's own passes: every run during boot recovery, and only the
   * adopted family's during a recovery scoped to one. The rest of a running project stays live: a
   * wake held back for an unrelated family would be lost, since the scoped passes never revisit it.
   */
  recoveringRun(run: RunRecord | string | undefined): boolean {
    const scope = this.recoveryScope;
    if (!scope) return false;
    if (scope.family === undefined) return true;
    const record = typeof run === 'string' ? this.context.store.getRun(run) : run;
    return record !== undefined && familyOf(record) === scope.family;
  }

  async recover(familyRootId?: string): Promise<void> {
    // A store that could not open (#779) knows none of its runs: recovering it would read "none".
    if (this.context.disposed() || this.recovering || this.context.store.unavailable) return;
    this.recoveryScope = { ...(familyRootId === undefined ? {} : { family: familyRootId }) };
    let settled!: () => void;
    this.recoveryInFlight = new Promise<void>((resolve) => { settled = resolve; });
    const inScope = (run: RunRecord) => familyRootId === undefined || familyOf(run) === familyRootId;
    try {
    this.familyReconciler.setRecoveryFactsPending(true);
    await this.context.store.prepareRecoveryFacts(familyRootId);
    if (this.context.disposed()) return;
    // Public terminal state can precede the private completion checkpoint. Such a family
    // has no live/deferred anchor, but orphan settlement still appends its lifecycle event.
    // Prepare only eligible starting generations' families before any repair mutation;
    // retain IDs, never an ownership or execution snapshot, across readiness.
    const { orphanWorkerIds, orphanFactIds } = this.collectOrphanWorkerGenerations(familyRootId, inScope);
    await this.context.store.prepareTranscriptFacts(orphanFactIds);
    if (this.context.disposed()) return;
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
    this.host.reconcileWorkerWaits(familyRootId);
    const live = this.context.store
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
    if (this.context.disposed()) return;
    } finally {
      this.familyReconciler.setRecoveryFactsPending(false);
      this.recoveryScope = undefined;
      this.recoveryInFlight = undefined;
      settled();
    }
    // Only a family with a live member has anyone left to route to or fall back from.
    this.workerQuestions.recoverWorkerMessages(familyRootId === undefined ? this.familyReconciler.liveFamilyMembers() : this.familyReconciler.familyMembers(familyRootId), familyRootId);
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
    this.autoResumeScheduler.reconcileAutoResumes();
    void this.host.pump();
  }

  adoptOrphanedRun(runId: string, opts: { stop?: boolean } = {}): Promise<boolean> {
    const adoption = this.adoptionTail.then(async () => {
      while (this.recovering && this.recoveryInFlight) await this.recoveryInFlight;
      if (this.context.disposed()) return false;
      const family = this.context.store.adoptFamily(runId, opts);
      if (family === undefined) return false;
      await this.host.recover(family);
      return true;
    });
    this.adoptionTail = adoption.catch(() => undefined);
    return adoption;
  }

  /** The workers in scope whose generation a dead controller left `starting`, and the members of
   *  their families, whose transcript facts recovery prepares before it settles them. */
  private collectOrphanWorkerGenerations(
    familyRootId: string | undefined,
    inScope: (run: RunRecord) => boolean,
  ): { orphanWorkerIds: string[]; orphanFactIds: Set<string> } {
    const workerIds = familyRootId === undefined ? this.context.store.listWorkerIds() : this.context.store.listWorkersOf(familyRootId).map((run) => run.id);
    const orphanWorkerIds: string[] = [];
    const orphanFactIds = new Set<string>();
    for (const id of workerIds) {
      if (this.context.store.readWorkerExecution(id)?.phase !== 'starting' || this.context.store.writeRefusal(id)) continue;
      const run = this.context.store.getRun(id);
      if (run?.delegation?.role !== 'worker' || !inScope(run)) continue;
      orphanWorkerIds.push(id);
      for (const member of this.context.store.listFamilyRunIds(run.delegation.parentRunId)) orphanFactIds.add(member);
    }
    return { orphanWorkerIds, orphanFactIds };
  }

  /** Recovery's first pass over the live set: the input state a dead controller left behind. */
  private recoverUnreadInputs(inScope: (run: RunRecord) => boolean): void {
    for (const run of this.context.store.listRuns().filter(inScope)) {
      // A restarted controller cannot answer an old transport's permission RPC.
      if (!this.host.isActive(run.id) && run.hasPendingPermission) {
        // A permission wait interrupted an unfinished native turn. Route it
        // through interrupted-turn recovery, never the settled-worker fallback.
        this.context.store.updateRun(run.id, { hasPendingPermission: false,
          ...(run.status === 'waiting' && !run.stopping && !this.host.workerExecutionStopped(run.id) ? { status: transition('resume', () => this.context.store.getRun(run.id)) } : {}) });
      }
      this.context.store.clearExpiredInboxClaims(run.id, new Date().toISOString());
      this.host.inboxClaims.armInboxClaimExpiry(run.id);
      // #505: the session that accepted this input died before the model read it.
      // Delivery is at-least-once: the replay keeps the input's ID in its text.
      if (['queued', 'running', 'waiting'].includes(run.status) && !this.host.isActive(run.id)) {
        const replayed = this.context.store.requeueAwaitingReadInputs(run.id);
        if (replayed.length) this.context.store.appendEvent(run.id, { type: 'note', message: `replaying ${replayed.length} message${replayed.length === 1 ? '' : 's'} accepted before the restart but not read` });
      }
    }
  }

  /** Settles each orphaned `starting` generation, or re-probes it when its proof does not settle. */
  private settleOrphanWorkerGenerations(orphanWorkerIds: string[], inScope: (run: RunRecord) => boolean): void {
    for (const id of orphanWorkerIds) {
      const run = this.context.store.getRun(id);
      if (!run || !inScope(run)) continue;
      if (this.context.store.readWorkerExecution(id)?.phase === 'starting' && !this.context.store.writeRefusal(id) &&
        !this.host.settleOrphanedWorkerExecution(id)) this.host.orphans.armOrphanReprobe(id);
    }
  }

  /** Restart sweeps every worker's scratch; an adopted family schedules only its own members. */
  private recoverWorkerScratch(familyRootId: string | undefined): void {
    if (familyRootId === undefined) this.host.workerScratchCleanup.recover();
    else for (const run of this.familyReconciler.familyMembers(familyRootId)) this.host.workerScratchCleanup.schedule(run.id);
  }

  /**
   * One live run of the restart loop. Returns the promise the loop must await (a root finish, a
   * re-queue or a settlement), else `undefined`.
   */
  private recoverLiveRun(found: RunRecord): Promise<void> | undefined {
    if (this.host.isActive(found.id)) return undefined;
    if (this.host.workerExecutionStopped(found.id)) return undefined;
    if (this.recoveryLeavesWorkerToRoot(found)) return undefined;
    if (rootFinishRequested(this.context.store, found.id)) return this.host.settleRequestedRootFinish(found.id);
    // A usage-limit hold ran no process, so nothing was interrupted: its waits re-arm and resolve,
    // and `reconcileAutoResumes` re-arms the resume that delivers them (hearsay-tools/cezarion#1236).
    if (isUsageLimitHold(found)) {
      for (const wait of openWaits(found)) this.host.waitWatches.armWait(found.id, wait);
      return undefined;
    }
    const run = this.reconcileRecoveredAsk(found);
    if (this.parkRecoveredRun(run)) return undefined;
    // A pending question or a queued message leaves the waits open: they re-arm, and a result
    // still wakes the run.
    for (const wait of openWaits(run)) this.host.waitWatches.armWait(run.id, wait);
    if (run.status === 'queued') return this.host.reviveQueuedRun(run, 'cezar restarted');
    this.host.deliverConversationInput(run.id);
    if (run.status === 'waiting') return this.recoverClosedWaitingRun(run);
    this.recoverInterruptedRun(run);
    return undefined;
  }

  /** True when a worker's root takes no more work from it: a settled root cancels the worker
   *  (hearsay-tools/cezarion#2410), and a finishing root leaves it as it is. */
  private recoveryLeavesWorkerToRoot(run: RunRecord): boolean {
    if (run.delegation?.role !== 'worker') return false;
    const parent = this.context.store.getRun(run.delegation.parentRunId);
    if (parent?.delegation?.role !== 'root') return false;
    if (['done', 'review', 'failed', 'cancelled'].includes(parent.status)) {
      this.host.cancel(run.id);
      return true;
    }
    return Boolean(parent.delegation.finishRequestedAt);
  }

  /** An unanswered `ask.requested` with no open human wait (a row written before every ask opened
   *  one) gets an open agent wait shown as that ask. Answer delivery still reads the transcript.
   *  Cezar's own wait not shown as that ask is replaced, as the live ask does: a crash between
   *  saving the ask and replacing it leaves that wait open (review of #1437). */
  private adoptTranscriptAsk(runId: string): boolean {
    const askSeq = pendingHumanAskSeq(this.context.store, runId);
    const human = openWaits(this.context.store.getRun(runId) ?? {}).filter((wait): wait is HumanWaitEntry => wait.kind === 'human');
    if (askSeq === undefined || !this.context.store.getRun(runId) || human.some(wait => !isCezarHumanWait(wait) || wait.askSeq === askSeq)) return false;
    this.host.humanWaits.withdrawCezarHumanWaits(runId);
    if (openWaits(this.context.store.getRun(runId) ?? {}).some(wait => wait.kind === 'human')) return false;
    try {
      this.context.store.commitWait(runId, { id: randomUUID(), kind: 'human', source: 'agent', via: 'ask-line', registeredAt: new Date().toISOString(), phase: 'open', turnId: 'recovered', askSeq });
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
    const legacy = this.context.store.getRun(runId)?.waits?.filter(wait => wait.kind === 'human' && wait.phase === 'open' && wait.turnId === 'legacy' && wait.askSeq === undefined) ?? [];
    // Only facts read from a non-empty transcript are evidence of the answer (review of #1437).
    const facts = this.context.store.knownTranscriptFacts(runId);
    if (!legacy.length || !facts || facts.bytes === 0 || facts.pendingGateSeq !== undefined) return false;
    try {
      return this.context.store.commitOutcome(runId, { kind: 'answered', waitIds: legacy.map(wait => wait.id) }).answered.length > 0;
    } catch (error) {
      console.warn(`[cez] human wait checkpoint failed: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  /** The run as recovery reads it after it reconciles the run's question state. */
  private reconcileRecoveredAsk(found: RunRecord): RunRecord {
    let run = found;
    // A worker no process survived for is a closed session: Cezar's fallback question goes as at an
    // idle close, and the worker recovers as its plain park did (hearsay-tools/cezarion#1301).
    if (run.delegation?.role === 'worker' && run.status === 'waiting' && this.workerQuestions.supersedeWorkerFallback(run.id)) run = this.context.store.getRun(run.id)!;
    // Phase 4b (hearsay-tools/cezarion#1236): attention reads the human wait, so an unanswered ask
    // an older cezar left without one gets one now, attached to that ask.
    if (this.adoptTranscriptAsk(run.id)) run = this.context.store.getRun(run.id)!;
    // A stored pending-question flag can be stale: the answer's receipt reached the transcript and
    // the row's save did not. The wait read from it is answered (review of #1437).
    if (this.settleAnsweredLegacyAsk(run.id)) run = this.context.store.getRun(run.id)!;
    return run;
  }

  /** True when the recovered run stays parked: on a human wait, a pending question or its waits. */
  private parkRecoveredRun(run: RunRecord): boolean {
    // hearsay-tools/cezarion#1234: a crash after a human wait's registration and before its turn
    // end shows the question now. The run waits on the user, its other waits re-armed.
    if (this.host.humanWaits.unsurfacedHumanWait(run.id)) {
      this.host.humanWaits.surfaceHumanWait(run.id, undefined);
      this.parkOnOpenWaits(run);
      return true;
    }
    if (run.delegation && run.delegation.role !== 'invalid' && hasPendingHumanAsk(run.id, id => pendingHumanAskSeq(this.context.store, id))) {
      // A pending question leaves its waits open: they re-arm, and a result still wakes the run.
      this.parkOnOpenWaits(run);
      // Only the durable, explicitly human payload may resume an unanswered
      // question. A refused recovery leaves attention, not terminal failure.
      if (run.continuationMessage?.origin === 'human') {
        const restarted = this.host.checkpointRestartContext(run);
        this.host.continueRun(restarted.id, {}, true);
      }
      return true;
    }
    // No process survived. Open waits re-arm from their stored deadlines (an overdue timer
    // resolves now); resolved ones wake through a scheduler-owned continuation after recovery.
    // A human message no longer withdraws a wait, so an interrupted or queued run with queued
    // messages still owes their delivery: it recovers as below, with its waits armed
    // (hearsay-tools/cezarion#1233). A parked one stays parked; its wake folds them in.
    if (run.waits?.length && !hasPendingHumanAsk(run.id, id => pendingHumanAskSeq(this.context.store, id)) && (run.status === 'waiting' || !run.queuedMessages?.length)) {
      this.parkOnOpenWaits(run);
      return true;
    }
    return false;
  }

  /** Parks a recovered run: `waiting`, with each of its open waits re-armed. */
  private parkOnOpenWaits(run: RunRecord): void {
    this.host.move(run.id, 'park');
    for (const wait of openWaits(run)) this.host.waitWatches.armWait(run.id, wait);
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
    if (ciWorkflowResumeStepIndex(run) >= 0) {
      // CI ACK retires the wait, but not the failed workflow source. A closed
      // worker at this boundary must resume before its remaining checks run.
      const resumed = this.host.continueRun(run.id, { text: this.restartContinuationPrompt }, true);
      this.context.store.appendEvent(run.id, { type: 'lifecycle', message: resumed.ok
        ? 'cezar restarted — resuming the worker CI recovery from its last session'
        : `cezar restarted — could not resume worker CI recovery (${resumed.error ?? 'unknown'})` });
      return undefined;
    }
    for (const step of run.steps) {
      if (step.status === 'waiting' || step.status === 'running') {
        this.context.store.updateStep(run.id, step.id, { status: 'done', finishedAt });
      }
    }
    this.context.store.appendEvent(run.id, {
      type: 'lifecycle',
      message: 'cezar restarted — the open worker session was settled',
    });
    return this.host.settleSuccess(run.id);
  }

  /** A recovered run whose structured question cannot be answered fails with its open steps. */
  private failRecoveredInvalidAsk(run: RunRecord, finishedAt: string): void {
    for (const step of run.steps) if (step.status === 'waiting' || step.status === 'running') {
      this.context.store.updateStep(run.id, step.id, { status: 'failed', error: 'invalid structured question', finishedAt });
    }
    this.host.move(run.id, 'fail', { error: 'invalid structured question', finishedAt, currentStepId: undefined });
  }

  /** A `running` run whose process died mid-turn. */
  private recoverInterruptedRun(found: RunRecord): void {
    // `running`: the process died mid-turn. Mark it interrupted (the state
    // continueRun expects), then pick the work back up from the last session.
    const run = this.host.checkpointRestartContext(found);
    const interruptedStepId = run.currentStepId;
    const finishedAt = new Date().toISOString();
    for (const step of run.steps) {
      if (step.status === 'running' || step.status === 'waiting') {
        this.context.store.updateStep(run.id, step.id, {
          status: 'failed',
          error: 'interrupted — cezar process exited during the run',
          finishedAt,
        });
      }
    }
    this.host.move(run.id, 'fail-interrupted', {
      error: 'interrupted — cezar process exited during the run',
      finishedAt,
      currentStepId: undefined,
    });
    if (this.host.requeueInterruptedRun(run, interruptedStepId)) return;
    const resumed = this.host.continueRun(
      run.id,
      {
        text: run.continuationMessage?.text ?? this.restartContinuationPrompt,
      },
      true,
    );
    this.context.store.appendEvent(run.id, {
      type: 'lifecycle',
      message: resumed.ok
        ? 'cezar restarted — resuming the interrupted task from its last session'
        : `cezar restarted — could not resume the interrupted task (${resumed.error ?? 'unknown'})`,
    });
  }

  /** Delivers the parent replies routed to each worker in scope. */
  private answerRecoveredRoutedQuestions(inScope: (run: RunRecord) => boolean): void {
    for (const run of this.context.store.listRuns().filter(inScope)) if (run.delegation?.role === 'worker') this.host.answerRoutedQuestion(run.id);
  }

  /** Re-arms each live run's waits, or queues the wake it owes. */
  private rearmRecoveredWakes(): void {
    for (const run of this.context.store.listRuns()) {
      // A terminal row keeps its waits (and stays live) until something cancels them. A failed run
      // that owes results keeps them for a human, and its open waits still resolve without a wake.
      if (run.waits?.length && holdsOwedResults(run)) for (const wait of openWaits(run)) this.host.waitWatches.armWait(run.id, wait);
      else if (run.waits?.length && !['running', 'waiting', 'queued'].includes(run.status)) this.host.cancelOpenWaits(run.id);
      else if (run.waits?.length) this.host.queueWaitWake(run.id);
      // A message the recovery window held back is a wake of its own (hearsay-tools/cezarion#1235).
      else if (['running', 'waiting', 'queued'].includes(run.status) && this.host.owesWake(run)) this.host.queueWaitWake(run.id);
    }
  }
}
