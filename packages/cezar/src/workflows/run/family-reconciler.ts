import { holdsOwedResults } from '../waits.ts';
import { runsAwaitingPeer } from '../wait-scope.ts';
import type { RunModuleContext } from './types.ts';
import type { ActiveRun } from '../active-run.ts';
import type { CommitSource, RunRecord } from '../../runs/store.ts';
import type { Wait, WorkerWaitEntry } from '@open-mercato/cezar-contract/waits';
import { historyDeletionPending, executionBlockedByRootFinish } from './run-guards.ts';
import { repairFailedRootFinish } from '../completion-policy.ts';
import { transitionVia } from '../run-states.ts';
import { reconcileConversationState, projectConversationEvents, settledRunFamilies } from '../../delegation/conversations.ts';
import { reconcileWorkerEntry } from '../../delegation/wait.ts';
import { workerOutcome } from '../../runs/delegation-state.ts';
import { workerOutcomeKey } from '../../runs/transcript-facts.ts';

interface FamilyReconcilerHost {
  reapTerminalScratch(id: string): void;
  cancelOpenWaits(id: string): void;
  resolvePeerWaits(runs: readonly string[]): void;
  active(id: string): ActiveRun | undefined;
  isActive(id: string): boolean;
  recoveringRun(run: RunRecord | string | undefined): boolean;
  cancel(id: string): void;
  armWait(id: string, wait: Wait): void;
  armWorkerDeadline(id: string, wait: WorkerWaitEntry, delay?: number): void;
  disarmWait(id: string): void;
  resolveWait(id: string, waitId: string, result: undefined, observed: WorkerWaitEntry): void;
  retireSettledQuestions(id: string): void;
  fallbackRoutedQuestions(id: string, reason: string): void;
  reconcileWorkerWaits(id?: string): void;
}

type WorkerObservations = ReturnType<FamilyReconciler['workerObservations']>;

export class FamilyReconciler {
  readonly onDelegationRun = (run: RunRecord, source?: CommitSource): void => {
    // Delegation metadata checkpoints do not change task status.
    // A republish changed nothing durable: there is nothing to reap, cancel or reconcile.
    if (source === 'live-release') return;
    if (!this.context.disposed() && source === undefined) this.host.reapTerminalScratch(run.id);
    if (!this.context.disposed() && !['queued', 'running', 'waiting'].includes(run.status) && !holdsOwedResults(run)) this.host.cancelOpenWaits(run.id);
    if (run.delegation && !['queued', 'running', 'waiting'].includes(run.status)) this.host.active(run.id)?.revokeDelegation?.();
    // Cleanup checkpoints emit terminal records too. With delegation disabled,
    // these observations must not replay the project's conversation histories.
    if (this.context.disposed() || this.host.recoveringRun(run) || (source === 'delegation-checkpoint' && process.env.CEZ_DELEGATION !== '1')) return;
    // A destroy retry changes nothing the family reconcile reads (#880).
    if (source === 'delegation-destroy-progress') return;
    if (run.delegation && run.delegation.role !== 'invalid' && !['queued', 'running', 'waiting'].includes(run.status)) {
      for (const id of settledRunFamilies(this.context.store, run)) this.host.reconcileWorkerWaits(id);
    }
    this.host.resolvePeerWaits(runsAwaitingPeer(run, () => this.context.store.listRuns())); // never in recovery: an interrupted peer fails, then continues
  };

  private readonly workerResolveRetries = new Set<string>();
  private readonly requestDeadlineTimers = new Map<string, NodeJS.Timeout>();
  private reconcilingWorkers = false;
  private reconcilingFamily: string | undefined;
  private readonly pendingReconciliations = new Set<string | undefined>();
  recoveryFactsPending = false;
  constructor(private readonly context: RunModuleContext, private readonly host: FamilyReconcilerHost) {}
  forgetRetry(waitId: string): void { this.workerResolveRetries.delete(waitId); }
  setRecoveryFactsPending(value: boolean): void { this.recoveryFactsPending = value; }
  dispose(): void {
    for (const timer of this.requestDeadlineTimers.values()) clearTimeout(timer);
    this.requestDeadlineTimers.clear();
  }

  /** A turn of this run is executing now: a recovered run's is not, whatever it last recorded. */
  private isExecutingWorkerWaitTurn(runId: string): boolean {
    const state = this.host.active(runId);
    return !!state?.session?.open && !state.cancelled && !this.host.recoveringRun(runId) && state.atTurnBoundary !== state.session;
  }

  /** Request deadlines share the existing reconciliation timer registry, never a polling loop. */
  private reconcileConversations(family: readonly RunRecord[]): void {
    const now = new Date().toISOString();
    for (const root of family) {
      if (root.delegation?.role !== 'root' || !root.delegation.conversation) continue;
      const next = reconcileConversationState(root, (id) => this.context.store.getRun(id), now, run =>
        run.delegation?.role === 'worker' ? this.context.store.readWorkerExecution(run.id)?.phase === 'complete' : !this.host.isActive(run.id), id => this.context.store.isUnreadable(id));
      if (next && next !== root.delegation.conversation) this.context.store.commitConversation(root.id, next);
      projectConversationEvents(this.context.store, this.context.store.getRun(root.id)!);
      this.host.retireSettledQuestions(root.id);
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
            try { this.host.reconcileWorkerWaits(root.id); this.host.reconcileWorkerWaits(); }
            catch {
              // A failed disk checkpoint retains the obligation; a bounded retry follows the
              // same failure policy as worker wait deadlines, never drops an unhandled error.
              if (!this.context.disposed()) arm(1_000);
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
  familyMembers(rootId: string): RunRecord[] {
    const root = this.context.store.getRun(rootId);
    return [...(root ? [root] : []), ...this.context.store.listWorkersOf(rootId)];
  }

  /** Every member of every family with a live member, each once: the families the store holds
   *  in memory (#779), which is where every delegation sweep that is not about one family looks. */
  liveFamilyMembers(): RunRecord[] {
    const roots = new Set<string>();
    for (const run of this.context.store.listRuns()) {
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
  async reconcileRecoveryWorkerFamilies(): Promise<void> {
    for (const rootId of this.context.store.listConversationRootIds()) {
      if (this.context.store.writeRefusal(rootId)) continue;
      this.recoveryFactsPending = true;
      await this.context.store.prepareRecoveryFacts(rootId);
      if (this.context.disposed()) return;
      this.recoveryFactsPending = false;
      this.host.reconcileWorkerWaits(rootId);
    }
  }

  reconcileAllWorkerFamilies(): void {
    // Another process's families are its own to repair (#779, plan step 3).
    for (const rootId of this.context.store.listConversationRootIds()) if (!this.context.store.writeRefusal(rootId)) this.host.reconcileWorkerWaits(rootId);
    this.host.reconcileWorkerWaits();
  }

  /** Authority and wait live on disk; these collections are admission/timer caches only. One
   *  family by its root's id, or (no id) every family with a live member. */
  reconcileWorkerWaits(familyRootId?: string): void {
    if (this.context.disposed()) return;
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
      if (this.context.disposed()) break;
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
        .filter(run => !this.recoveryFactsPending || !this.host.recoveringRun(run));
      this.reconcileConversations(family);
      for (const parent of family) {
        if (!parent.delegation || parent.delegation.role === 'invalid' || historyDeletionPending(this.context.store, parent.id)) continue;
        repairFailedRootFinish(this.context.store, parent);
        if (parent.status === 'cancelled' && parent.delegation.role === 'root' && parent.delegation.finishRequestedAt) {
          transitionVia('cancel', () => this.context.store.getRun(parent.id), () => this.context.store.commitRootFinishCancellation(parent.id));
        }
        if (!['queued', 'running', 'waiting'].includes(parent.status)) {
          if (!this.host.recoveringRun(parent)) {
            // A settled parent waits on nobody: its worker waits are cancelled, which also lets a
            // stored wait upgraded onto a finished root go (hearsay-tools/cezarion#1301).
            const stale = (parent.waits ?? []).filter(wait => wait.kind === 'worker' && (wait.phase === 'open' || wait.phase === 'resolved')).map(wait => wait.id);
            if (stale.length) { this.context.store.commitOutcome(parent.id, { kind: 'cancelled', waitIds: stale }); for (const id of stale) this.host.disarmWait(id); }
            this.host.fallbackRoutedQuestions(parent.id, `parent-${parent.status}`);
            for (const child of parent.delegation.role === 'root' && parent.status !== 'review' ? this.context.store.listWorkersOf(parent.id) : []) {
              if (['queued', 'running', 'waiting'].includes(child.status)) this.host.cancel(child.id);
            }
          }
          continue;
        }
        if (executionBlockedByRootFinish(this.context.store, parent)) continue;
        const observed = (now: string) => this.workerObservations(parent, now);
        this.reconcileWorkerEntries(parent, observed);
      }
    } finally { this.reconcilingWorkers = false; this.reconcilingFamily = undefined; }
  }

  /** The settled outcomes a run's worker waits can observe now: each owned worker whose execution
   *  is provably complete, and each deleted worker's retained result. */
  private workerObservations(parent: RunRecord, now: string) {
    const outcomes = this.context.store.listWorkersOf(parent.id).flatMap(child => {
      const outcome = workerOutcome(child, now);
      return outcome && this.context.store.readWorkerExecution(child.id)?.phase === 'complete' ? [outcome] : [];
    });
    // Explicit history deletion replaces the live execution proof with a completed
    // parent receipt. Keep its acknowledged outcome while other all-wait workers run.
    const deletedResults = new Map((parent.delegation?.role === 'root' ? parent.delegation.receipts : []).flatMap(receipt => {
      const result = this.context.store.readDeletedWorkerResult(parent.id, receipt.workerId);
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
    const root = run.delegation?.role === 'root' ? run : run.delegation?.role === 'worker' ? this.context.store.getRun(run.delegation.parentRunId) : undefined;
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
  private reconcileWorkerEntries(parent: RunRecord, observe: (now: string) => WorkerObservations): void {
    const entries = (parent.waits ?? []).filter((wait): wait is WorkerWaitEntry => wait.kind === 'worker');
    if (!entries.length) return;
    const now = new Date().toISOString();
    const { outcomes, deletedResults } = observe(now);
    const requests = this.requestOutcomesOf(parent);
    const destroyed = (entry: WorkerWaitEntry) => !!entry.workerIds?.length && this.isExecutingWorkerWaitTurn(parent.id) && entry.workerIds.every(id => {
      const child = this.context.store.getRun(id)?.delegation;
      return child?.role === 'worker' ? child.destroy?.phase === 'complete' : deletedResults.get(id)?.cleanup === 'complete';
    });
    // A result still owed for workers the executing turn has since destroyed is no longer news.
    const retired = entries.filter(entry => entry.phase === 'resolved' && destroyed(entry)).map(entry => entry.id);
    if (retired.length) this.context.store.commitOutcome(parent.id, { kind: 'cancelled', waitIds: retired });
    for (const entry of entries.filter(wait => wait.phase === 'open')) {
      let selected = entry;
      if (entry.workerIds) {
        const revisions = entry.workerIds.map(workerId => {
          const metadata = this.context.store.getRun(workerId)?.delegation;
          return { workerId, revision: metadata?.role === 'worker' ? metadata.executionRevision ?? 0 : deletedResults.get(workerId)?.revision ?? 0 };
        });
        if (JSON.stringify(entry.revisions) !== JSON.stringify(revisions)) selected = { ...selected, revisions };
        const proven = (selected.outcomes ?? []).filter(previous => outcomes.some(current =>
          current.workerId === previous.workerId && (current.revision ?? 0) === (previous.revision ?? 0)));
        if (proven.length !== (selected.outcomes ?? []).length) selected = { ...selected, outcomes: proven };
      }
      const { entry: next, reason } = reconcileWorkerEntry(selected, outcomes, now, requests);
      if (reason && destroyed(next)) {
        this.context.store.commitOutcome(parent.id, { kind: 'cancelled', waitIds: [entry.id] });
        this.host.disarmWait(entry.id);
      } else if (reason) {
        // The deadline stays armed until the resolution is durable. A failed write is retried in a
        // second, since nothing else may touch this family again before the deadline.
        try { this.host.resolveWait(parent.id, entry.id, undefined, { ...next, result: { reason } }); }
        catch {
          if (!this.workerResolveRetries.has(entry.id)) console.warn('[cez] worker wait checkpoint failed; retrying in 1 second');
          this.host.disarmWait(entry.id);
          this.workerResolveRetries.add(entry.id);
          this.host.armWorkerDeadline(parent.id, entry, 1_000);
          continue;
        }
        this.host.disarmWait(entry.id);
      } else {
        if (next !== entry) this.context.store.commitWait(parent.id, next);
        this.host.armWait(parent.id, next);
      }
      const recorded = this.context.store.transcriptFacts(parent.id).workerOutcomeKeys;
      for (const outcome of next.outcomes ?? []) {
        if (!recorded.includes(workerOutcomeKey(entry.id, outcome.workerId, outcome.revision ?? 0))) {
          this.context.store.appendEvent(parent.id, { type: 'worker-outcome', waitId: entry.id, outcome });
        }
      }
    }
  }

}
