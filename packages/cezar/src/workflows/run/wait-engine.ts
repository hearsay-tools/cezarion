import { logPrefix } from '../../home/display.ts';
import type { AgentInput } from '@open-mercato/cezar-contract/delegation';
import { ciWaitResultSchema, type CiWaitResult } from '@open-mercato/cezar-contract/ci-wait';
import type { Wait, WaitErrorCode, AskErrorCode, WorkerWaitEntry, PrWaitEntry, ProcessWaitEntry, ProcessWaitResult, PeerWaitEntry } from '@open-mercato/cezar-contract/waits';
import type { ActiveRun } from '../active-run.ts';
import type { RunModuleContext } from './types.ts';
import type { RunRecord } from '../../runs/store.ts';
import type { CiWatcherSupervisor } from '../../ci-wait/supervisor.ts';
import { assertWaitCapacity, WaitCapacityError } from '../../runs/wait-capacity.ts';
import { waitErrorMessage } from '../../ci-wait/errors.ts';
import { ProcessWaitSupervisor } from '../../process-wait/supervisor.ts';
import type { ExitFileRoots } from '../../process-wait/exit-file.ts';
import { agentTmpDirEnabled, resolveAgentTmpDir } from '../../runs/agent-tmpdir.ts';
import { peerWaitResult } from '../wait-scope.ts';
import { chargesBudget, openWaits, waitInputId, waitResultText, settledWaitEntry, ciWatchRequest, type WaitResult } from '../waits.ts';
import { familyOf } from './run-guards.ts';
import { WAIT_KINDS, type WaitKindRow } from './wait-kinds.ts';
import { registrationReceipt, type RegistrationIdentity } from './wait-registration.ts';
import { watchDeadline } from './wait-watches.ts';

export function warnRegistrationRefused(code: WaitErrorCode | AskErrorCode): void {
  console.warn(`${logPrefix()} wait registration refused: ${code}`);
}

// Deadline timers stop through clearTimeout on waitTimers (disarm and dispose); this signal never fires.
const deadlineSignal = new AbortController().signal;

/** What the engine asks the rest of the run manager (ADR 0053): wake admission, the run line,
 *  the family reconcile, human waits and the subagent session. */
interface WaitEngineHost {
  active(id: string): ActiveRun | undefined;
  canProceedWithRun(id: string, run: RunRecord | undefined): run is RunRecord;
  ciSupervisor(): Pick<CiWatcherSupervisor, 'resolve' | 'watch' | 'close'>;
  reconcileWorkerWaits(family?: string): void;
  noticeParkedWorkers(id: string): void;
  withdrawSquawkHumanWaits(id: string): void;
  /** The session that holds a subagent wait's children is live (hearsay-tools/cezarion#2431). */
  subagentSessionLive(id: string): boolean;
  /** Resolve a subagent wait whose session is gone `interrupted`, ending its running children in the transcript (hearsay-tools/cezarion#2431). */
  interruptSubagentWait(id: string, waitId: string): void;
  countAutomaticWakes(id: string): number;
  /** Cancel these waits at the wake cap, then repark the session or wait on the user without one. */
  wakeCapReached(id: string, waits: readonly Wait[], state: ActiveRun | undefined): void;
  queueWaitWake(id: string): void;
  retryWaitAdmission(id: string): void;
  isParked(id: string): boolean;
  parkOnWaits(id: string, state: ActiveRun): void;
  abortRegistrations(id: string): void;
  /** Forget the run's wake retries, wake delivery, queued wake and admission, in that order. */
  forgetWakes(id: string): void;
}

/** The steps a registration path chooses; the row decides the arm, the park guard and the entry returned. */
interface OpenOptions {
  /** Withdraw Cezar's human waits after the compare, before the commit. */
  withdraw: boolean;
  receipt?: RegistrationIdentity | undefined;
  onCommitFailure?: CommitFailure;
  /** Park when the run is at its turn boundary or parked. */
  park: boolean;
  /** Present: the caller already holds the result (undefined takes the row's default), so the
   *  wait arms nothing and resolves with it at once. */
  result?: WaitResult | undefined;
}
/** Absent: the commit error escapes as it is. `persistence`: the tool's coded `capacity` or
 *  `persistence` error. `log`: warn and refuse. `capacity`: a full list throws the path's own error. */
type CommitFailure = 'persistence' | { log: string } | { capacity: () => Error };
export type OpenResult<W extends Wait> = { status: 'opened'; wait: W } | { status: 'refused'; wait?: undefined };

type Watch = WaitKindRow<Wait['kind']>['watch'];
interface CancelWaitsOptions { onCommitFailure?: 'throw' | 'skip'; superseded?: true; log?: string }

/** Executes the wait-kind rows behind the run facade: open, arm, resolve, re-arm, cancel and forget. */
export class WaitEngine {
  /** One CI watch per open CI wait, keyed by wait id. */
  private readonly ciWatches = new Map<string, { runId: string; abort: AbortController }>();
  /** A resolution whose checkpoint failed, retried by wait id. */
  private readonly ciRetries = new Map<string, { runId: string; timer: NodeJS.Timeout }>();
  /** Process waits' watches (hearsay-tools/cezarion#1446), by wait id. */
  private readonly processWatches = new Map<string, { runId: string; abort: AbortController }>();
  private readonly workerResolveRetries = new Set<string>();
  /** One timer per open timer wait, keyed by wait id. */
  private readonly waitTimers = new Map<string, { runId: string; timer: NodeJS.Timeout }>();

  /** The watch adapter each row names. */
  private readonly watches: { readonly [W in Watch]: (runId: string, wait: Wait) => void } = {
    ci: (runId, wait) => this.startCiWatch(runId, wait as PrWaitEntry),
    process: (runId, wait) => this.startProcessWatch(runId, wait as ProcessWaitEntry),
    // Only the user's answer, or a cancel, ends a human wait: nothing to arm.
    none: () => {},
    worker: (runId, wait) => { if (!this.waitTimers.has(wait.id)) this.armWorkerDeadline(runId, wait as WorkerWaitEntry); },
    timer: (runId, wait) => this.armDeadline(runId, wait, false),
    // A peer that already wrote or settled resolves it first, at registration and recovery alike.
    peer: (runId, wait) => { if (!this.waitTimers.has(wait.id) && !this.resolvePeerWait(runId, wait as PeerWaitEntry)) this.armDeadline(runId, wait, false); },
    subagent: (runId, wait) => this.armDeadline(runId, wait, true),
  };

  constructor(private readonly context: RunModuleContext, private readonly host: WaitEngineHost, private readonly maxAutoContinues: number,
    private readonly processSupervisor: Pick<ProcessWaitSupervisor, 'watch' | 'close'> = new ProcessWaitSupervisor()) {}

  /** Whether the run's open-wait list has room. Each caller keeps its own refusal shape. */
  hasRoom(run: Pick<RunRecord, 'waits'>): boolean {
    try { assertWaitCapacity(run); return true; }
    catch (error) {
      if (error instanceof WaitCapacityError) return false;
      throw error;
    }
  }

  /** Commit, arm and (at a boundary) park on a newly registered wait. A wait opened with the
   *  result its caller already holds arms nothing and resolves with it after the park. */
  open<W extends Wait>(runId: string, state: ActiveRun | undefined, wait: W, options: OpenOptions): OpenResult<W> {
    if (options.withdraw) this.host.withdrawSquawkHumanWaits(runId);
    if (!this.commitOpened(runId, wait, options.onCommitFailure, options.receipt)) return { status: 'refused' };
    const settled = 'result' in options;
    if (!settled) this.armOpened(runId, wait);
    if (options.park) this.park(runId, state, wait);
    // The answer is the wait as opened, even when the result resolves it at once.
    const opened = this.openedEntry(runId, wait);
    if (settled) this.settleWait(runId, wait.id, options.result);
    return { status: 'opened', wait: opened };
  }

  private armOpened(runId: string, wait: Wait): void {
    if (WAIT_KINDS[wait.kind].watch !== 'worker') { this.armWait(runId, wait); return; }
    const run = this.context.store.getRun(runId)!;
    // Outcomes already in resolve it now (or, with every worker destroyed, cancel it); the rest arm it.
    this.host.reconcileWorkerWaits(familyOf(run));
    // A worker that parked before this wait opened tells the parent now (hearsay-tools/cezarion#1327).
    // Cezar's completion wait tells its own workers; an agent's wait tells its family.
    this.host.noticeParkedWorkers(wait.source === 'cezar' ? runId : familyOf(run));
  }

  /**
   * Commit a changed open wait, then arm it. A moved deadline disarms the old one first; an
   * unchanged one keeps what is armed, including a checkpoint retry. False when the commit failed
   * under a `log` policy: the saved wait and what is armed stay as they were.
   */
  refresh(runId: string, previous: Wait, next: Wait, onCommitFailure?: { log: string }): boolean {
    if (next !== previous && !this.commitOpened(runId, next, onCommitFailure)) return false;
    const deadline = (wait: Wait) => 'deadline' in wait ? wait.deadline : undefined;
    if (deadline(next) !== deadline(previous)) this.disarmWait(previous.id);
    this.armWait(runId, next);
    return true;
  }

  private commitOpened(runId: string, wait: Wait, policy: CommitFailure | undefined, receipt?: RegistrationIdentity): boolean {
    try {
      if (receipt) this.context.store.commitWait(runId, wait, undefined, registrationReceipt(receipt, wait));
      else this.context.store.commitWait(runId, wait);
      return true;
    } catch (error) {
      if (typeof policy === 'object' && 'capacity' in policy) throw error instanceof WaitCapacityError ? policy.capacity() : error;
      if (typeof policy === 'object') {
        console.warn(`${policy.log}: ${error instanceof Error ? error.message : String(error)}`);
        return false;
      }
      if (policy !== 'persistence') throw error;
      if (error instanceof WaitCapacityError) {
        warnRegistrationRefused('capacity');
        throw Object.assign(new Error(waitErrorMessage('capacity')), { code: 'capacity' });
      }
      throw Object.assign(new Error(waitErrorMessage('persistence')), { code: 'persistence' });
    }
  }

  /** A worker wait the family reconcile already resolved is no longer listed, and parks nothing. */
  private park(runId: string, state: ActiveRun | undefined, wait: Wait): void {
    if (!state) return;
    if (WAIT_KINDS[wait.kind].watch === 'worker' && !this.context.store.getRun(runId)?.waits?.some(entry => entry.id === wait.id)) return;
    if (state.boundary.atTurnBoundary === state.liveSession.session || this.host.isParked(runId)) this.host.parkOnWaits(runId, state);
  }

  /** The entry as recorded now: the store keeps the entry it was given, and only its phase can
   *  have moved since. A worker wait with a deadline may already be settled by the reconcile. */
  private openedEntry<W extends Wait>(runId: string, wait: W): W {
    const latest = this.context.store.getRun(runId);
    if (WAIT_KINDS[wait.kind].watch === 'worker') {
      return (WAIT_KINDS.worker.select([...latest?.waits ?? [], ...latest?.lastWaits ?? []])
        .find(entry => entry.id === wait.id && WAIT_KINDS.worker.hasDeadline(entry)) as W | undefined) ?? wait;
    }
    return (latest?.waits?.find(entry => entry.id === wait.id) as W | undefined) ?? wait;
  }

  /** Where a process wait's exit file may sit: the run's worktree (the checkout for a run without
   *  one) and, unless turned off, the Cezar temp directory its agent gets as `TMPDIR`. */
  exitFileRoots(runId: string, run = this.context.store.getRun(runId)): ExitFileRoots {
    return { worktree: run?.worktreePath ?? this.context.repoRoot, ...(agentTmpDirEnabled() ? { tmpDir: resolveAgentTmpDir(this.context.dataDir, runId) } : {}) };
  }

  /** Start what resolves an open wait: the watch adapter its row names. An overdue deadline
   *  (restart) resolves at once. */
  private armWait(runId: string, wait: Wait): void {
    if (this.context.disposed() || wait.phase !== 'open') return;
    this.watches[WAIT_KINDS[wait.kind].watch](runId, wait);
  }

  /** A timer, peer or subagent deadline. Native subagents live only in their session: with none,
   *  as at a restart, they stopped (hearsay-tools/cezarion#2431). At its deadline a lost session
   *  reads the same. */
  private armDeadline(runId: string, wait: Wait, subagent: boolean): void {
    if (this.waitTimers.has(wait.id)) return;
    const interrupted = () => subagent && !this.host.subagentSessionLive(runId);
    if (interrupted()) { this.host.interruptSubagentWait(runId, wait.id); return; }
    // A stopping, stopped or finishing run takes no self-generated wake: the timer stays open
    // for that transition to cancel, as the monitoring timer did before it was a wait.
    const fire = () => {
      const run = this.context.store.getRun(runId);
      if (!this.host.canProceedWithRun(runId, run)) return;
      if (interrupted()) this.host.interruptSubagentWait(runId, wait.id);
      else this.settleWait(runId, wait.id);
    };
    const deadline = (wait as Exclude<Wait, { kind: 'human' | 'worker' }>).deadline;
    const due = Date.parse(deadline) - Date.now();
    if (due <= 0) { fire(); return; }
    const timer = watchDeadline({ deadline, delay: due }, deadlineSignal, () => {
      if (this.waitTimers.get(wait.id)?.timer !== timer) return;
      this.waitTimers.delete(wait.id);
      fire();
    });
    this.waitTimers.set(wait.id, { runId, timer });
  }

  /**
   * A worker wait's deadline re-observes its family (hearsay-tools/cezarion#1235): the reconcile
   * resolves it with `timeout`, keeping any outcome observed by then. A failed checkpoint is
   * retried every second while the wait is still open, never dropped as an uncaught error. An
   * outcome whose resolution failed to commit arms the same retry with `firstDelay` 1 second.
   */
  private armWorkerDeadline(runId: string, wait: WorkerWaitEntry, firstDelay?: number): void {
    // A deadline-less (Cezar completion) wait ends only when its workers settle (hearsay-tools/cezarion#1301).
    if (firstDelay === undefined && wait.deadline === undefined) return;
    const run = this.context.store.getRun(runId);
    if (!run) return;
    const family = familyOf(run);
    let warned = false;
    const arm = (delay: number) => {
      const timer = watchDeadline({ deadline: wait.deadline, delay }, deadlineSignal, () => {
        if (this.waitTimers.get(wait.id)?.timer !== timer) return;
        this.waitTimers.delete(wait.id);
        try { this.host.reconcileWorkerWaits(family); }
        catch {
          if (!warned) console.warn(`${logPrefix()} worker wait checkpoint failed; retrying in 1 second`);
          warned = true;
          if (!this.context.disposed() && this.context.store.getRun(runId)?.waits?.some(entry => entry.id === wait.id && entry.phase === 'open')) arm(1_000);
        }
      });
      this.waitTimers.set(wait.id, { runId, timer });
    };
    arm(Math.max(0, firstDelay ?? Date.parse(wait.deadline!) - Date.now()));
  }

  /** Stop everything that could still resolve this wait. */
  private disarmWait(waitId: string): void {
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
    if (this.processWatches.has(wait.id)) return;
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
    if (this.ciWatches.has(wait.id)) return;
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
      console.warn(`${logPrefix()} wait checkpoint unavailable; retaining result for retry.`);
      const timer = setTimeout(() => { this.ciRetries.delete(waitId); this.settleWait(runId, waitId, result); }, 1000);
      timer.unref(); this.ciRetries.set(waitId, { runId, timer });
    }
  }

  private disarmRun(runId: string): void {
    for (const [id, watch] of this.ciWatches) if (watch.runId === runId) this.disarmWait(id);
    for (const [id, entry] of this.waitTimers) if (entry.runId === runId) this.disarmWait(id);
    for (const [id, retry] of this.ciRetries) if (retry.runId === runId) this.disarmWait(id);
    for (const [id, watch] of this.processWatches) if (watch.runId === runId) this.disarmWait(id);
  }

  /** Re-arm the caller's recovery snapshot. Do not re-read between waits: an overdue
   *  deadline can resolve synchronously, but the remaining snapshot entries still arm. */
  rearm(run: RunRecord): void {
    for (const wait of openWaits(run)) this.armWait(run.id, wait);
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
  private resolvePeerWait(runId: string, wait: PeerWaitEntry): boolean {
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
    // The count includes a batch still awaiting acknowledgement. The kind row reads the durable
    // result so an empty dependency deadline is free, including at a spent budget.
    if (chargesBudget(settled) && this.host.countAutomaticWakes(runId) >= this.maxAutoContinues) {
      this.host.wakeCapReached(runId, [latest], state);
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
      if (!this.workerResolveRetries.has(entry.id)) console.warn(`${logPrefix()} worker wait checkpoint failed; retrying in 1 second`);
      this.disarmWait(entry.id);
      this.workerResolveRetries.add(entry.id);
      this.armWorkerDeadline(runId, entry, 1_000);
      return false;
    }
    this.disarmWait(entry.id);
    return true;
  }

  /** Keep watches armed until cancellation is durable. A skipped write disarms nothing. */
  cancel(runId: string, ids: readonly string[], opts: CancelWaitsOptions = {}): Wait[] {
    let settled: Wait[];
    try {
      ({ settled } = this.context.store.commitOutcome(runId, { kind: 'cancelled', waitIds: ids, ...(opts.superseded ? { superseded: true } : {}) }));
    } catch (error) {
      if (opts.onCommitFailure !== 'skip') throw error;
      console.warn(`${opts.log ?? `${logPrefix()} wait cancellation failed`}: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
    for (const id of ids) this.disarmWait(id);
    return settled;
  }

  /**
   * Cancel every open or resolved wait of a run without waking the agent: stop, Finish, cancel,
   * deletion, DONE and any terminal status. Human input cancels none (hearsay-tools/cezarion#1233).
   * A failed commit leaves the record as a crash would and never stops the disarm, so Stop still
   * reaches the session when the store is closed or broken (hearsay-tools/cezarion#1234).
   */
  cancelAll(runId: string): void {
    const before = this.context.store.getRun(runId)?.waits ?? [];
    const remaining = (this.context.store.getRun(runId)?.waits ?? []).map(wait => wait.id);
    try { if (remaining.length) this.context.store.commitOutcome(runId, { kind: 'cancelled', waitIds: remaining }); }
    catch (error) { console.warn(`${logPrefix()} wait cancellation failed: ${error instanceof Error ? error.message : String(error)}`); }
    for (const wait of before) this.disarmWait(wait.id);
    this.forgetRun(runId);
  }

  /** Stop every watch, timer, retry and queued wake a run's waits hold in memory. */
  forgetRun(runId: string): void {
    this.host.abortRegistrations(runId);
    this.disarmRun(runId);
    this.host.forgetWakes(runId);
  }
}
