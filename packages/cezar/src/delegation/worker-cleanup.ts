import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { WorkerDestroy, WorkerDestroyResult } from '@open-mercato/cezar-contract/delegation';
import type { RunRecord } from '../runs/store.ts';
import { releaseThenRemoveOwnedWorkspace } from '../git-worktree-release.ts';
import { collectWorkerEvidence } from './results.ts';
import { DelegationPolicyError } from './policy.ts';
import { gitCommonDir, WorkspaceHeldError } from './workspace.ts';
import { holdersStillHold, observeDestroy, recordHolders, type DestroyObservation } from './destroy-observation.ts';
import { DESTROY_ATTENTION_ATTEMPTS, DESTROY_BACKOFF, retryDelayMs, type Backoff } from './retry-backoff.ts';
import type { DelegationProject } from './service.ts';

/** Tests pass shorter cadences and termination waits through these constructor options. */
export type WorkerCleanupOptions = {
  now?: () => number;
  backoff?: Backoff;
  attentionAttempts?: number;
  terminationTimeoutMs?: number;
};

type Serialize = <T>(key: string, operation: () => Promise<T>) => Promise<T>;

/** One registered project's destroy state and retry lifecycle. */
export class WorkerCleanup {
  private detached = false;
  private readonly projects: Pick<Map<string, DelegationProject>, 'get'>;
  private readonly now: () => number;

  constructor(private readonly project: DelegationProject, isAttached: () => boolean,
    private readonly serialized: Serialize, options: WorkerCleanupOptions = {}) {
    this.projects = { get: id => !this.detached && id === project.id && isAttached() ? project : undefined };
    this.now = options.now ?? Date.now;
    this.destroyBackoff = options.backoff ?? DESTROY_BACKOFF;
    this.destroyAttentionAttempts = options.attentionAttempts ?? DESTROY_ATTENTION_ATTEMPTS;
    this.terminationTimeoutMs = options.terminationTimeoutMs ?? 30_000;
  }

  request(workerId: string, check: () => RunRecord): Promise<WorkerDestroyResult> {
    return this.destroySerialized(this.project, workerId, check);
  }

  armAfterRecovery(): void { this.armDestroyRetries(this.project.id); }

  detach(): void {
    this.clearDestroyRetries(this.project.id);
    this.detached = true;
  }

  private destroyRetryTimers = new Map<string, Map<string, NodeJS.Timeout>>();
  private destroyRetryInFlight = new Map<string, Set<string>>();
  /** What each pending destroy's last full attempt observed (hearsay-tools/cezarion#879). */
  private destroyObservations = new Map<string, Map<string, DestroyObservation>>();
  /** Each project's common Git dir, resolved once per registration for the change check. */
  private commonDirs = new Map<string, Promise<string | undefined>>();
  private readonly destroyBackoff: Backoff;
  private readonly destroyAttentionAttempts: number;
  private readonly terminationTimeoutMs: number;
  private clearDestroyRetries(projectId: string): void {
    for (const timer of this.destroyRetryTimers.get(projectId)?.values() ?? []) clearTimeout(timer);
    this.destroyRetryTimers.delete(projectId);
    this.destroyRetryInFlight.delete(projectId);
    this.destroyObservations.delete(projectId);
    this.commonDirs.delete(projectId);
  }
  /** Called only after manager recovery, when persisted destroy intents may be retried. */
  private armDestroyRetries(projectId: string): void {
    const project = this.projects.get(projectId);
    if (!project) return;
    project.manager.recoverWorkerCleanup();
    // A pending destroy keeps its worker in the live set (`isLiveRecord`), so this is every one.
    for (const run of project.store.listRuns()) this.scheduleDestroyRetry(project, run.id);
  }
  /** Arms the next automatic attempt of a pending destroy. A retry state written before a restart
   * resumes where it was; the fast cadence is the floor, and a little over the cap the ceiling, so
   * a clock that jumped cannot park a destroy for days (hearsay-tools/cezarion#879). */
  private scheduleDestroyRetry(project: DelegationProject, workerId: string): void {
    if (this.projects.get(project.id) !== project) return;
    const run = project.store.getRun(workerId);
    if (run?.delegation?.role !== 'worker' || !run.delegation.destroy || run.delegation.destroy.phase === 'complete') return;
    let timers = this.destroyRetryTimers.get(project.id);
    if (!timers) { timers = new Map(); this.destroyRetryTimers.set(project.id, timers); }
    if (timers.has(workerId) || this.destroyRetryInFlight.get(project.id)?.has(workerId)) return;
    const { fastMs, capMs } = this.destroyBackoff;
    const nextAt = run.destroyRetry ? Date.parse(run.destroyRetry.nextAt) - this.now() : 0;
    const delay = Math.min(Math.max(fastMs, nextAt), capMs * 1.1);
    const timer = setTimeout(() => {
      timers.delete(workerId);
      if (this.projects.get(project.id) !== project) return;
      let inFlight = this.destroyRetryInFlight.get(project.id);
      if (!inFlight) { inFlight = new Set(); this.destroyRetryInFlight.set(project.id, inFlight); }
      inFlight.add(workerId);
      void this.destroyTick(project, workerId).catch(() => undefined).finally(() => {
        inFlight.delete(workerId);
        this.scheduleDestroyRetry(project, workerId);
      });
    }, delay);
    timer.unref?.();
    timers.set(workerId, timer);
  }
  /** One automatic attempt. It runs in full only when something its last full attempt observed has
   * changed, or a holder it named has exited; either way it records the attempt and when the next
   * is due, and from the attention threshold on the cockpit says the cleanup needs attention. */
  private destroyTick(project: DelegationProject, workerId: string) {
    return this.serialized(`worker:${project.id}:${workerId}`, async () => {
      const check = () => {
        if (this.projects.get(project.id) !== project) throw new DelegationPolicyError('denied_scope', 'Worker scope denied');
        const current = project.store.getRun(workerId);
        if (current?.delegation?.role !== 'worker' || current.delegation.workspace.ownerRunId !== workerId || !current.delegation.destroy || current.delegation.destroy.phase === 'complete') {
          throw new DelegationPolicyError('incompatible_state', 'Worker destroy is no longer pending');
        }
        return current;
      };
      check();
      const seen = this.destroyObservations.get(project.id)?.get(workerId);
      const dataDir = join(project.root, '.ai/cezar');
      const unchanged = !!seen && holdersStillHold({ store: project.store, dataDir, workerId, holders: seen.holders }) &&
        seen.key === observeDestroy({ store: project.store, dataDir, commonDir: await this.commonDir(project), workerId });
      // One automatic full attempt at a time per project: attempts that coincide (every pending destroy after a
      // restart) would otherwise contend for the worktree mutation lock and come back lock-busy, never skipped.
      if (!unchanged) await this.serialized(`destroy-retries:${project.id}`, () => this.destroyAttempt(project, workerId, check, 'scheduled')).catch(() => undefined);
      if (this.projects.get(project.id) !== project) return;
      const current = project.store.getRun(workerId);
      if (current?.delegation?.role !== 'worker' || !current.delegation.destroy || current.delegation.destroy.phase === 'complete') return;
      const attempts = (current.destroyRetry?.attempts ?? 0) + 1;
      const retry = { attempts, nextAt: new Date(this.now() + retryDelayMs(attempts, this.destroyBackoff)).toISOString(),
        ...(attempts >= this.destroyAttentionAttempts ? { needsAttention: true as const } : {}) };
      project.store.commitDestroyRetry(workerId, retry);
    });
  }
  private commonDir(project: DelegationProject): Promise<string | undefined> {
    let dir = this.commonDirs.get(project.id);
    if (!dir) {
      // A failure is not cached: the next attempt asks again, and until then the check is record-only.
      dir = gitCommonDir(project.root).catch(() => { this.commonDirs.delete(project.id); return undefined; });
      this.commonDirs.set(project.id, dir);
    }
    return dir;
  }
  private observeAttempt(project: DelegationProject, workerId: string, seen?: DestroyObservation): void {
    if (this.projects.get(project.id) !== project) return;
    let observations = this.destroyObservations.get(project.id);
    if (!seen) { observations?.delete(workerId); return; }
    if (!observations) { observations = new Map(); this.destroyObservations.set(project.id, observations); }
    observations.set(workerId, seen);
  }
  /** An explicit destroy (Clean up, `cez worker destroy`): always a full attempt, and it restarts the
   * backoff, so a timer armed for a later automatic attempt is dropped and re-armed at the fast cadence. */
  private destroySerialized(project: DelegationProject, workerId: string, check: () => RunRecord) {
    return this.serialized(`worker:${project.id}:${workerId}`, () => this.destroyAttempt(project, workerId, check, 'manual')).finally(() => {
      // A replaced registration owns its own timers under the same project id: leave them alone.
      if (this.projects.get(project.id) !== project) return;
      const timers = this.destroyRetryTimers.get(project.id);
      clearTimeout(timers?.get(workerId)); timers?.delete(workerId);
      this.scheduleDestroyRetry(project, workerId);
    });
  }
  /** One full destroy attempt; the caller holds the worker's serialization key. A manual attempt
   * clears the run's `destroyRetry`, which resets the backoff; a completed destroy drops it. */
  private async destroyAttempt(project: DelegationProject, workerId: string, check: () => RunRecord, mode: 'manual' | 'scheduled'): Promise<WorkerDestroyResult> {
    const assertAttached = () => {
      if (this.projects.get(project.id) !== project) throw new DelegationPolicyError('denied_scope', 'Worker scope denied');
    };
    assertAttached();
    let worker = check();
    if (worker.delegation?.role !== 'worker') throw new DelegationPolicyError('denied_scope', 'Worker scope denied');
    const parent = project.store.getRun(worker.delegation.parentRunId);
    if (parent?.delegation?.role === 'root' && parent.delegation.receipts.some(receipt => receipt.workerId === workerId && receipt.deletion)) {
      throw new DelegationPolicyError('incompatible_state', 'Worker history deletion has begun; retry history deletion');
    }
    const commonDir = await this.commonDir(project);
    assertAttached();
    worker = check();
    if (worker.delegation?.role !== 'worker') throw new DelegationPolicyError('denied_scope', 'Worker scope denied');
    // What this attempt decided on (hearsay-tools/cezarion#879): a later tick that would see the same skips its
    // work. Retaken where the attempt decides (after termination, at each holder proof), so its own writes up
    // to there (stopping the worker, the removal's checkpoint) are not a change, and anything later is.
    const observe = () => observeDestroy({ store: project.store, dataDir: join(project.root, '.ai/cezar'), commonDir, workerId });
    let key = observe();
    const workspace = worker.delegation.workspace;
    const requestedAt = worker.delegation.destroy?.requestedAt ?? new Date().toISOString();
    const resources = (worker.delegation.destroy?.remaining ?? ['worktree', 'branch']).filter((resource): resource is 'worktree' | 'branch' => resource !== 'process');
    const persist = (phase: WorkerDestroy['phase'], remaining: WorkerDestroy['remaining'], error?: string) => {
      assertAttached();
      worker = project.store.getRun(workerId)!;
      if (worker.delegation?.role !== 'worker') throw new DelegationPolicyError('denied_scope', 'Worker scope denied');
      project.store.commitDelegation([{ id: workerId, delegation: { ...worker.delegation, destroy: { requestedAt, phase, remaining,
        ...(error ? { error: error.slice(0, 2_000) } : {}) } } }]);
      // The retry state lives beside the delegation: an explicit destroy and a completed one both drop it.
      if (worker.destroyRetry && (phase === 'complete' || (mode === 'manual' && phase === 'requested'))) project.store.commitDestroyRetry(workerId, undefined);
    };
    /** What the attempt decided on, and the holders it ran into, kept only when that explains the
     * failure. A complete destroy keeps nothing, and neither does a failure no key input or named
     * holder accounts for (lock contention, a failed Git step, an unnamed blocker): it can clear
     * without changing anything a tick could see, so the next tick attempts in full. */
    const observed = (result: WorkerDestroyResult, holders: readonly number[], explained: boolean) => {
      this.observeAttempt(project, workerId, result.state === 'complete' || !explained ? undefined : { key, holders: recordHolders(holders) });
      return result;
    };
    const terminationFailure = (): WorkerDestroyResult => {
      // #469: name what blocks a crashed generation; other causes keep the generic message.
      const taken = project.manager.takeWorkerTerminationBlocker(workerId);
      const reason = taken && (taken.blocker.kind === 'unreadable' ? 'worker process record is unreadable; termination cannot be proven'
        : taken.blocker.kind === 'controller' ? `the worker is still controlled by a live cezar (pid ${taken.blocker.pid})`
        : `${taken.blocker.pids.length === 1 ? 'process' : 'processes'} ${taken.blocker.pids.join(', ')} still ${taken.blocker.pids.length === 1 ? 'holds' : 'hold'} the worker's worktree or scratch`);
      if (taken?.changed) project.store.appendEvent(workerId, { type: 'lifecycle', message: `destroy blocked: ${reason}` });
      const result: WorkerDestroyResult = { workerId, state: 'incomplete', remaining: ['process', ...resources], error: !taken ? 'Worker termination is not proven; retry cleanup later'
        : taken.blocker.kind === 'unreadable' ? reason! : `Worker termination is not proven: ${reason}; retry cleanup later` };
      persist(result.state, result.remaining, result.error);
      return observed(result, taken?.blocker.kind === 'processes' ? taken.blocker.pids : taken?.blocker.kind === 'controller' ? [taken.blocker.pid] : [], !!taken);
    };
    const cleanWorkspace = async (): Promise<WorkerDestroyResult> => {
      persist('cleaning', resources);
      let result: WorkerDestroyResult;
      const snapshot = structuredClone(check());
      const proof = project.store.readWorkerExecution(workerId);
      const evidence = await collectWorkerEvidence(project.root, project.store, snapshot);
      assertAttached();
      const current = check();
      if (proof?.phase !== 'complete' || project.store.readWorkerExecution(workerId)?.generation !== proof.generation ||
        project.store.readWorkerExecution(workerId)?.phase !== 'complete' || current.status !== snapshot.status ||
        JSON.stringify(current.delegation) !== JSON.stringify(snapshot.delegation)) throw new Error('Worker changed before cleanup checkpoint');
      // This immutable parent payload must be durable before the first destructive operation. A
      // payload already on disk is durable, whatever cleanup phase it names (hearsay-tools/cezarion#879).
      project.store.commitWorkerResult(evidence.result.parentRunId, evidence.result, evidence.diffSnapshot, { ignoreCleanup: true });
      assertAttached();
      check();
      const release = project.manager.claimWorkerCleanup(workerId);
      const assertCurrent = () => {
        assertAttached();
        const current = check();
        if (!release || current.delegation?.role !== 'worker' ||
          JSON.stringify(current.delegation.workspace) !== JSON.stringify(workspace) ||
          project.store.readWorkerExecution(workerId)?.generation !== proof.generation ||
          project.store.readWorkerExecution(workerId)?.phase !== 'complete') {
          throw new Error('Worker resource ownership changed');
        }
      };
      const assertSafe = () => {
        assertCurrent();
        key = observe();
        const holders = project.store.workerResourceHolders(workerId, proof.generation, workspace.resourceId);
        if (holders === 'safe') return;
        throw holders.length ? new WorkspaceHeldError(holders) : new Error('Worker resources may still be held; cleanup will retry');
      };
      // The removal turns being held into an incomplete result; it reports the holders either of its
      // checks named, or that it stopped for a reason no key input explains, an unnamed holder
      // included (hearsay-tools/cezarion#879).
      let holders: readonly number[] = [];
      let explained = true;
      try {
        assertCurrent();
        // #781: release preview before the final fresh proof immediately preceding removal.
        result = await releaseThenRemoveOwnedWorkspace({ previewHost: project.manager.previewHost }, project.root, workspace,
          assertCurrent, assertSafe, { held: pids => { holders = pids; }, unexplained: () => { explained = false; } });
      } catch {
        explained = false;
        result = { workerId, state: 'incomplete', remaining: resources, error: 'Worker resources may still be held; cleanup will retry' };
      } finally { release?.(); }
      // An already-started checked Git operation may finish after detach. Its
      // checkpoint makes a new controller's retry safe; the old store must not
      // publish a result after ownership of the project has moved.
      assertAttached();
      persist(result.state, result.remaining, result.error);
      // Preserve the captured bytes even if Git removal was only partially successful.
      const removed = !result.remaining.includes('worktree');
      project.store.commitWorkerResult(evidence.result.parentRunId, { ...evidence.result, observedAt: new Date().toISOString(),
        cleanup: result.state, outcome: result.state === 'complete' ? 'destroyed' : evidence.result.lastExecutionOutcome,
        workspace: { ...workspace, state: removed ? 'deleted' : evidence.result.workspace.state },
        head: removed ? { state: 'deleted', reason: 'missing', ...('sha' in evidence.result.head ? { sha: evidence.result.head.sha } : {}) } : evidence.result.head,
        diff: evidence.result.diff.state === 'available' ? { ...evidence.result.diff, snapshotId: randomUUID() } : evidence.result.diff,
      }, evidence.diffSnapshot);
      project.manager.reconcileWorkerWaits(evidence.result.parentRunId);
      return observed(result, holders, explained);
    };
    const recordFailure = (error: unknown) => {
      // hearsay-tools/cezarion#879: an attempt that throws says why, instead of leaving an
      // in-progress phase with no error, as long as this is still the same pending destroy. A
      // throw explains nothing a tick could see clear, so the next tick attempts in full.
      this.observeAttempt(project, workerId, undefined);
      try {
        const current = this.projects.get(project.id) === project ? project.store.getRun(workerId) : undefined;
        if (current?.delegation?.role === 'worker' && current.delegation.destroy?.requestedAt === requestedAt && current.delegation.destroy.phase !== 'complete') {
          persist('incomplete', current.delegation.destroy.remaining, error instanceof Error ? error.message : String(error));
        }
      } catch { /* the attempt's own error is the one to report */ }
    };
    persist('requested', worker.delegation.destroy?.remaining ?? ['process', 'worktree', 'branch']);
    try {
      persist('terminating', ['process', ...resources]);
      project.manager.requestWorkerStop(workerId);
      const terminated = await project.manager.awaitRunTermination(workerId, this.terminationTimeoutMs, { reapOrphans: true });
      assertAttached();
      key = observe();
      if (!terminated) return terminationFailure();
      return await cleanWorkspace();
    } catch (error) {
      recordFailure(error);
      throw error;
    }
  }
}
