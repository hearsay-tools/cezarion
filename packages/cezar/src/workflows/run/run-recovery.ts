import type { RunRecord } from '../../runs/store.ts';
import type { RunModuleContext } from './types.ts';
import { familyOf } from './run-guards.ts';
import type { FamilyReconciler } from './family-reconciler.ts';
import type { WorkerQuestions } from './worker-questions.ts';
import type { AutoResumeScheduler } from './auto-resume.ts';

interface RunRecoveryHost {
  collectOrphanWorkerGenerations(family: string | undefined, inScope: (run: RunRecord) => boolean): { orphanWorkerIds: string[]; orphanFactIds: Set<string> };
  recoverUnreadInputs(inScope: (run: RunRecord) => boolean): void;
  settleOrphanWorkerGenerations(ids: string[], inScope: (run: RunRecord) => boolean): void;
  recoverWorkerScratch(family: string | undefined): void;
  recoverLiveRun(run: RunRecord): Promise<void> | undefined;
  answerRecoveredRoutedQuestions(inScope: (run: RunRecord) => boolean): void;
  rearmRecoveredWakes(): void;
  recover(family?: string): Promise<void>;
  pump(): Promise<void>;
  reconcileWorkerWaits(family?: string): void;
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
    private readonly host: RunRecoveryHost) {}

  get recovering(): boolean {
    return this.recoveryScope !== undefined;
  }

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
    const { orphanWorkerIds, orphanFactIds } = this.host.collectOrphanWorkerGenerations(familyRootId, inScope);
    await this.context.store.prepareTranscriptFacts(orphanFactIds);
    if (this.context.disposed()) return;
    this.familyReconciler.setRecoveryFactsPending(false);
    // Recovery reads the live set (#779): `listRuns()` is the runs `open` loaded by the `live`
    // column, and finished runs have nothing to recover. The worker passes below go through
    // indexed queries instead.
    this.host.recoverUnreadInputs(inScope);
    // #469: a generation whose processes died with the old controller is finalized first, so it
    // re-launches through the ordinary Continue path; live task scratch is retained.
    // Any worker, finished or not, may hold a generation a dead controller left `starting`. Its
    // private proof is read first, so only those workers' records are decoded: settling and
    // re-probing are no-ops for every other proof phase.
    // Another process's workers are its own to settle.
    this.host.settleOrphanWorkerGenerations(orphanWorkerIds, inScope);
    this.host.reconcileWorkerWaits(familyRootId);
    const live = this.context.store
      .listRuns()
      .filter((r) => inScope(r) && ['queued', 'waiting', 'running'].includes(r.status))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    // Scratch cleanup discovers private evidence independently of the salvageable run index.
    // Terminal worker cleanup/retries and the generic orphan sweep share this boundary. An
    // adopted family only schedules its own members: the sweep belongs to restart.
    this.host.recoverWorkerScratch(familyRootId);
    for (const run of live) {
      // Await only what the run hands back, so a run that settles nothing recovers without
      // yielding to the work an earlier run started.
      const settling = this.host.recoverLiveRun(run);
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
    this.host.answerRecoveredRoutedQuestions(inScope);
    // The rest re-arms wakes from durable state and is idempotent, so it runs for every live run
    // even after one adopted family: anything the recovery window held back goes out now.
    this.host.rearmRecoveredWakes();
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
}
