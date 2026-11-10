import type { ActiveRun } from '../active-run.ts';
import type { AgentInput } from '@open-mercato/cezar-contract/delegation';
import { peerWaitResult } from '../wait-scope.ts';
import { WAIT_KINDS } from './wait-kinds.ts';
import type { RunModuleContext } from './types.ts';
import type { RunRecord } from '../../runs/store.ts';
import { familyOf } from './run-guards.ts';
import { chargesBudget, openWaits, waitInputId, waitResultText, settledWaitEntry, ciWatchRequest, type WaitResult } from '../waits.ts';
import { ciWaitResultSchema, type CiWaitResult } from '@open-mercato/cezar-contract/ci-wait';
import type { Wait, WorkerWaitEntry, PrWaitEntry, ProcessWaitEntry, ProcessWaitResult, PeerWaitEntry } from '@open-mercato/cezar-contract/waits';
import type { CiWatcherSupervisor } from '../../ci-wait/supervisor.ts';
import { ProcessWaitSupervisor } from '../../process-wait/supervisor.ts';
import type { ExitFileRoots } from '../../process-wait/exit-file.ts';
import { agentTmpDirEnabled, resolveAgentTmpDir } from '../../runs/agent-tmpdir.ts';

interface WaitResolveHost {
  active(id: string): ActiveRun | undefined;
  countAutomaticWakes(id: string): number;
  cancelAutomaticAtCap(id: string, waits: readonly Wait[]): void;
  reparkWithoutWaits(id: string, state: ActiveRun): void;
  waitOnUserWithoutSession(id: string): void;
  queueWaitWake(id: string): void;
  retryWaitAdmission(id: string): void;
  canProceedWithRun(id: string, run: RunRecord | undefined): run is RunRecord;
  ciSupervisor(): Pick<CiWatcherSupervisor, 'resolve' | 'watch' | 'close'>;
  reconcileWorkerWaits(family: string): void;
  disarmWait(id: string): void;
  /** The session that holds a subagent wait's children is live (hearsay-tools/cezarion#2431). */
  subagentSessionLive(id: string): boolean;
  /** Resolve a subagent wait whose session is gone `interrupted`, ending its running children in the transcript (hearsay-tools/cezarion#2431). */
  interruptSubagentWait(id: string, waitId: string): void;
}

export class WaitResolve {
  /** One CI watch per open CI wait, keyed by wait id. */
  readonly ciWatches = new Map<string, { runId: string; abort: AbortController }>();
  /** A resolution whose checkpoint failed, retried by wait id. */
  private readonly ciRetries = new Map<string, { runId: string; timer: NodeJS.Timeout }>();
  /** Process waits' watches (hearsay-tools/cezarion#1446), by wait id. */
  private readonly processWatches = new Map<string, { runId: string; abort: AbortController }>();
  private readonly workerResolveRetries = new Set<string>();
  private readonly processSupervisor = new ProcessWaitSupervisor();
  /** One timer per open timer wait, keyed by wait id. */
  readonly waitTimers = new Map<string, { runId: string; timer: NodeJS.Timeout }>();
  constructor(private readonly context: RunModuleContext, private readonly host: WaitResolveHost, private readonly maxAutoContinues: number) {}

  /** Where a process wait's exit file may sit: the run's worktree (the checkout for a run without
   *  one) and, unless turned off, the Cezar temp directory its agent gets as `TMPDIR`. */
  exitFileRoots(runId: string, run = this.context.store.getRun(runId)): ExitFileRoots {
    return { worktree: run?.worktreePath ?? this.context.repoRoot, ...(agentTmpDirEnabled() ? { tmpDir: resolveAgentTmpDir(this.context.dataDir, runId) } : {}) };
  }

  /** Start what resolves an open wait: its CI watch, or its timer from the stored deadline. An
   *  overdue timer (restart) resolves at once. */
  armWait(runId: string, wait: Wait): void {
    if (this.context.disposed() || wait.phase !== 'open') return;
    const watch = WAIT_KINDS[wait.kind].watch;
    if (watch === 'ci') { this.startCiWatch(runId, wait as PrWaitEntry); return; }
    if (watch === 'process') { this.startProcessWatch(runId, wait as ProcessWaitEntry); return; }
    // Only the user's answer, or a cancel, ends a human wait: nothing to arm.
    if (watch === 'none') return;
    if (this.waitTimers.has(wait.id)) return;
    if (watch === 'worker') { this.armWorkerDeadline(runId, wait as WorkerWaitEntry); return; }
    // A peer that already wrote or settled resolves it first, at registration and recovery alike.
    if (watch === 'peer' && this.resolvePeerWait(runId, wait as PeerWaitEntry)) return;
    // Native subagents live only in their session: with none, as at a restart, they stopped
    // (hearsay-tools/cezarion#2431). At its deadline a lost session reads the same.
    const interrupted = () => watch === 'subagent' && !this.host.subagentSessionLive(runId);
    if (interrupted()) { this.host.interruptSubagentWait(runId, wait.id); return; }
    // A stopping, stopped or finishing run takes no self-generated wake: the timer stays open
    // for that transition to cancel, as the monitoring timer did before it was a wait.
    const fire = () => {
      const run = this.context.store.getRun(runId);
      if (!this.host.canProceedWithRun(runId, run)) return;
      if (interrupted()) this.host.interruptSubagentWait(runId, wait.id);
      else this.settleWait(runId, wait.id);
    };
    const due = Date.parse((wait as Exclude<Wait, { kind: 'human' | 'worker' }>).deadline) - Date.now();
    if (due <= 0) { fire(); return; }
    const timer = setTimeout(() => {
      if (this.waitTimers.get(wait.id)?.timer !== timer) return;
      this.waitTimers.delete(wait.id);
      fire();
    }, due);
    timer.unref?.();
    this.waitTimers.set(wait.id, { runId, timer });
  }

  /**
   * A worker wait's deadline re-observes its family (hearsay-tools/cezarion#1235): the reconcile
   * resolves it with `timeout`, keeping any outcome observed by then. A failed checkpoint is
   * retried every second while the wait is still open, never dropped as an uncaught error. An
   * outcome whose resolution failed to commit arms the same retry with `firstDelay` 1 second.
   */
  armWorkerDeadline(runId: string, wait: WorkerWaitEntry, firstDelay?: number): void {
    // A deadline-less (Cezar completion) wait ends only when its workers settle (hearsay-tools/cezarion#1301).
    if (firstDelay === undefined && wait.deadline === undefined) return;
    const run = this.context.store.getRun(runId);
    if (!run) return;
    const family = familyOf(run);
    let warned = false;
    const arm = (delay: number) => {
      const timer = setTimeout(() => {
        if (this.waitTimers.get(wait.id)?.timer !== timer) return;
        this.waitTimers.delete(wait.id);
        try { this.host.reconcileWorkerWaits(family); }
        catch {
          if (!warned) console.warn('[cez] worker wait checkpoint failed; retrying in 1 second');
          warned = true;
          if (!this.context.disposed() && this.context.store.getRun(runId)?.waits?.some(entry => entry.id === wait.id && entry.phase === 'open')) arm(1_000);
        }
      }, delay);
      timer.unref?.();
      this.waitTimers.set(wait.id, { runId, timer });
    };
    arm(Math.max(0, firstDelay ?? Date.parse(wait.deadline!) - Date.now()));
  }

  hasWorkerResolveRetry(waitId: string): boolean { return this.workerResolveRetries.has(waitId); }
  recordWorkerResolveRetry(waitId: string): void { this.workerResolveRetries.add(waitId); }

  /** Stop everything that could still resolve this wait. */
  disarmWait(waitId: string): void {
    this.ciWatches.get(waitId)?.abort.abort(); this.ciWatches.delete(waitId);
    const timer = this.waitTimers.get(waitId); if (timer) clearTimeout(timer.timer); this.waitTimers.delete(waitId);
    const retry = this.ciRetries.get(waitId); if (retry) clearTimeout(retry.timer); this.ciRetries.delete(waitId);
    this.workerResolveRetries.delete(waitId);
    this.processWatches.get(waitId)?.abort.abort(); this.processWatches.delete(waitId);
  }

  /**
   * Watch a process wait's command (hearsay-tools/cezarion#1446). Like a timer, its wake is the
   * agent's own arrangement: a stopping, stopped or finishing run takes none, and the wait stays
   * open for that transition to cancel.
   */
  private startProcessWatch(runId: string, wait: ProcessWaitEntry): void {
    if (this.context.disposed() || this.processWatches.has(wait.id) || wait.phase !== 'open') return;
    const abort = new AbortController();
    const watch = { runId, abort };
    this.processWatches.set(wait.id, watch);
    const settle = (result: ProcessWaitResult) => {
      if (this.context.disposed() || abort.signal.aborted || this.processWatches.get(wait.id) !== watch) return;
      this.processWatches.delete(wait.id);
      const run = this.context.store.getRun(runId);
      if (!this.host.canProceedWithRun(runId, run)) return;
      this.settleWait(runId, wait.id, result);
    };
    const request = { pid: wait.pid, deadline: wait.deadline, roots: this.exitFileRoots(runId),
      ...(wait.startToken === undefined ? {} : { startToken: wait.startToken }), ...(wait.exitFile === undefined ? {} : { exitFile: wait.exitFile }) };
    void this.processSupervisor.watch(request, abort.signal).then(settle, (error: unknown) => settle({ outcome: 'error', observedAt: new Date().toISOString(),
      diagnostic: (error instanceof Error ? error.message : String(error)).slice(0, 512) }));
  }

  private startCiWatch(runId: string, wait: PrWaitEntry): void {
    if (this.context.disposed() || this.ciWatches.has(wait.id) || wait.phase !== 'open') return;
    const abort = new AbortController();
    const watch = { runId, abort };
    this.ciWatches.set(wait.id, watch);
    const current = () => !this.context.disposed() && !abort.signal.aborted && this.ciWatches.get(wait.id) === watch;
    const settle = (result: CiWaitResult) => {
      if (!current()) return;
      const parsed = ciWaitResultSchema.safeParse(result);
      const validated: CiWaitResult = parsed.success ? parsed.data : { outcome: 'error', headSha: wait.headSha,
        observedAt: new Date().toISOString(), checks: [], totalChecks: 0, truncated: false,
        diagnostic: 'CI watcher returned an invalid observation; inspect the PR and register a new wait.' };
      this.ciWatches.delete(wait.id);
      this.settleWait(runId, wait.id, validated);
    };
    void this.host.ciSupervisor().watch(ciWatchRequest(wait), abort.signal).then(settle, () => settle({ outcome: 'error', headSha: wait.headSha,
      observedAt: new Date().toISOString(), checks: [], totalChecks: 0, truncated: false,
      diagnostic: 'CI watcher unavailable; inspect the pull request and retry the wait.' }));
  }

  /** `resolveWait`, retried while its durable checkpoint is unavailable: a failed write may not
   *  drop the accepted intent or publish a false result. */
  settleWait(runId: string, waitId: string, result?: WaitResult): void {
    if (this.context.disposed()) return;
    try { this.resolveWait(runId, waitId, result); }
    catch {
      if (this.ciRetries.has(waitId)) return;
      console.warn('[cez] wait checkpoint unavailable; retaining result for retry.');
      const timer = setTimeout(() => { this.ciRetries.delete(waitId); this.settleWait(runId, waitId, result); }, 1000);
      timer.unref(); this.ciRetries.set(waitId, { runId, timer });
    }
  }

  disarmRun(runId: string): void {
    for (const [id, watch] of this.ciWatches) if (watch.runId === runId) this.host.disarmWait(id);
    for (const [id, entry] of this.waitTimers) if (entry.runId === runId) this.host.disarmWait(id);
    for (const [id, retry] of this.ciRetries) if (retry.runId === runId) this.host.disarmWait(id);
    for (const [id, watch] of this.processWatches) if (watch.runId === runId) this.host.disarmWait(id);
  }

  disposeWatches(): void {
    for (const task of this.ciWatches.values()) task.abort.abort();
    this.processSupervisor.close();
    this.ciWatches.clear();
  }
  disposeRetries(): void {
    for (const retry of this.ciRetries.values()) clearTimeout(retry.timer);
    this.ciRetries.clear();
  }
  dispose(): void {
    for (const entry of this.waitTimers.values()) clearTimeout(entry.timer);
    this.waitTimers.clear();
  }
  /** The open peer waits of these runs whose named peer already wrote, settled or was deleted resolve now. */
  resolvePeerWaits(runIds: readonly string[]): void {
    for (const id of runIds) for (const wait of WAIT_KINDS.peer.select(openWaits(this.context.store.getRun(id) ?? {}))) this.resolvePeerWait(id, wait);
  }

  /** Like a timer, the wake is the agent's own arrangement: a stopping or finishing run takes none,
   *  and the wait stays for that transition to cancel. True when the wait is no longer open. */
  resolvePeerWait(runId: string, wait: PeerWaitEntry): boolean {
    const run = this.context.store.getRun(runId);
    if (this.context.disposed() || !this.host.canProceedWithRun(runId, run)) return false;
    const result = peerWaitResult(run, wait, this.context.store);
    if (result) this.settleWait(runId, wait.id, result);
    return !!result && this.context.store.getRun(runId)?.waits?.find(entry => entry.id === wait.id)?.phase !== 'open';
  }

  /** Commit an open wait as resolved together with its lifecycle input (id = wait id, or an
   *  upgraded worker wait's `wakeInputId`), then queue the run's wake. A worker wait passes the
   *  entry as reconciled, with its outcomes and `result`. Throws when the checkpoint fails; a wait
   *  no longer open is ignored. */
  resolveWait(runId: string, waitId: string, result?: WaitResult, observed?: WorkerWaitEntry): void {
    const latest = this.context.store.getRun(runId)?.waits?.find(wait => wait.id === waitId);
    if (!latest || latest.phase !== 'open') return;
    const state = this.host.active(runId);
    const resolvedAt = new Date().toISOString();
    const settled = settledWaitEntry(latest, result, observed, resolvedAt);
    // The count includes a timer batch still awaiting its acknowledgement. A subagent wait charges
    // by how it resolved, so the resolved entry is what this reads (hearsay-tools/cezarion#2431).
    if (chargesBudget(settled) && this.host.countAutomaticWakes(runId) >= this.maxAutoContinues) {
      this.host.cancelAutomaticAtCap(runId, [latest]);
      if (state) this.host.reparkWithoutWaits(runId, state);
      else this.host.waitOnUserWithoutSession(runId);
      return;
    }
    const input: AgentInput = { id: waitInputId(settled), parentRunId: runId, source: 'lifecycle', createdAt: resolvedAt,
      text: waitResultText(settled, { workerStatus: this.workerStatus }) };
    this.context.store.commitWait(runId, settled, input);
    try { this.host.queueWaitWake(runId); }
    catch { this.host.retryWaitAdmission(runId); }
  }

  /** A worker's current status, as a worker wait's result names it. */
  readonly workerStatus = (workerId: string): string => this.context.store.getRun(workerId)?.status ?? 'unavailable';

  resolveWorkerWait(runId: string, entry: WorkerWaitEntry, observed: WorkerWaitEntry): boolean {
    // The deadline stays armed until the resolution is durable. A failed write is retried in a
    // second, since nothing else may touch this family again before the deadline.
    try { this.resolveWait(runId, entry.id, undefined, observed); }
    catch {
      if (!this.hasWorkerResolveRetry(entry.id)) console.warn('[cez] worker wait checkpoint failed; retrying in 1 second');
      this.host.disarmWait(entry.id);
      this.recordWorkerResolveRetry(entry.id);
      this.armWorkerDeadline(runId, entry, 1_000);
      return false;
    }
    this.host.disarmWait(entry.id);
    return true;
  }
}
