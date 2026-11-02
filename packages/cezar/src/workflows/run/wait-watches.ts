import type { RunModuleContext } from './types.ts';
import type { RunRecord } from '../../runs/store.ts';
import { familyOf } from './run-guards.ts';
import { ciWatchRequest, type WaitResult } from '../waits.ts';
import { ciWaitResultSchema, type CiWaitResult } from '@open-mercato/cezar-contract/ci-wait';
import type { Wait, WorkerWaitEntry, PrWaitEntry, ProcessWaitEntry, ProcessWaitResult, PeerWaitEntry, PeerWaitResult } from '@open-mercato/cezar-contract/waits';
import type { CiWatcherSupervisor } from '../../ci-wait/supervisor.ts';
import { ProcessWaitSupervisor } from '../../process-wait/supervisor.ts';
import type { ExitFileRoots } from '../../process-wait/exit-file.ts';
import { agentTmpDirEnabled, resolveAgentTmpDir } from '../../runs/agent-tmpdir.ts';

interface WaitWatchesHost {
  canProceedWithRun(id: string, run: RunRecord | undefined): boolean;
  ciSupervisor(): Pick<CiWatcherSupervisor, 'resolve' | 'watch' | 'close'>;
  resolveWait(id: string, waitId: string, result?: WaitResult): void;
  reconcileWorkerWaits(family: string): void;
  resolvePeerWait(id: string, wait: PeerWaitEntry): boolean;
  disarmWait(id: string): void;
  armWorkerDeadline(id: string, wait: WorkerWaitEntry, firstDelay?: number): void;
  settleWait(id: string, waitId: string, result?: WaitResult): void;
  exitFileRoots(id: string): ExitFileRoots;
  /** The session that holds a subagent wait's children is live (hearsay-tools/cezarion#2431). */
  subagentSessionLive(id: string): boolean;
  /** Resolve a subagent wait whose session is gone `interrupted`, ending its running children in the transcript (hearsay-tools/cezarion#2431). */
  interruptSubagentWait(id: string, waitId: string): void;
}

export class WaitWatches {
  /** One CI watch per open CI wait, keyed by wait id. */
  readonly ciWatches = new Map<string, { runId: string; abort: AbortController }>();
  /** A resolution whose checkpoint failed, retried by wait id. */
  private readonly ciRetries = new Map<string, { runId: string; timer: NodeJS.Timeout }>();
  /** Process waits' watches (hearsay-tools/cezarion#1446), by wait id. */
  private readonly processWatches = new Map<string, { runId: string; abort: AbortController }>();
  private readonly processSupervisor = new ProcessWaitSupervisor();
  /** One timer per open timer wait, keyed by wait id. */
  readonly waitTimers = new Map<string, { runId: string; timer: NodeJS.Timeout }>();
  constructor(private readonly context: RunModuleContext, private readonly host: WaitWatchesHost) {}

  /** Where a process wait's exit file may sit: the run's worktree (the checkout for a run without
   *  one) and, unless turned off, the Cezar temp directory its agent gets as `TMPDIR`. */
  exitFileRoots(runId: string, run = this.context.store.getRun(runId)): ExitFileRoots {
    return { worktree: run?.worktreePath ?? this.context.repoRoot, ...(agentTmpDirEnabled() ? { tmpDir: resolveAgentTmpDir(this.context.dataDir, runId) } : {}) };
  }

  /** Start what resolves an open wait: its CI watch, or its timer from the stored deadline. An
   *  overdue timer (restart) resolves at once. */
  armWait(runId: string, wait: Wait): void {
    if (this.context.disposed() || wait.phase !== 'open') return;
    if (wait.kind === 'pr') { this.startCiWatch(runId, wait); return; }
    if (wait.kind === 'process') { this.startProcessWatch(runId, wait); return; }
    // Only the user's answer, or a cancel, ends a human wait: nothing to arm.
    if (wait.kind === 'human') return;
    if (this.waitTimers.has(wait.id)) return;
    if (wait.kind === 'worker') { this.host.armWorkerDeadline(runId, wait); return; }
    // A peer that already wrote or settled resolves it first, at registration and recovery alike.
    if (wait.kind === 'peer' && this.host.resolvePeerWait(runId, wait)) return;
    // Native subagents live only in their session: with none, as at a restart, they stopped
    // (hearsay-tools/cezarion#2431). At its deadline a lost session reads the same.
    const interrupted = () => wait.kind === 'subagent' && !this.host.subagentSessionLive(runId);
    if (interrupted()) { this.host.interruptSubagentWait(runId, wait.id); return; }
    // A stopping, stopped or finishing run takes no self-generated wake: the timer stays open
    // for that transition to cancel, as the monitoring timer did before it was a wait.
    const fire = () => {
      const run = this.context.store.getRun(runId);
      if (!this.host.canProceedWithRun(runId, run)) return;
      if (interrupted()) this.host.interruptSubagentWait(runId, wait.id);
      else this.host.settleWait(runId, wait.id);
    };
    const due = Date.parse(wait.deadline) - Date.now();
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

  /** Stop everything that could still resolve this wait. */
  disarmWait(waitId: string): void {
    this.ciWatches.get(waitId)?.abort.abort(); this.ciWatches.delete(waitId);
    const timer = this.waitTimers.get(waitId); if (timer) clearTimeout(timer.timer); this.waitTimers.delete(waitId);
    const retry = this.ciRetries.get(waitId); if (retry) clearTimeout(retry.timer); this.ciRetries.delete(waitId);
  }

  disarmProcessWatch(waitId: string): void {
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
      this.host.settleWait(runId, wait.id, result);
    };
    const request = { pid: wait.pid, deadline: wait.deadline, roots: this.host.exitFileRoots(runId),
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
      this.host.settleWait(runId, wait.id, validated);
    };
    void this.host.ciSupervisor().watch(ciWatchRequest(wait), abort.signal).then(settle, () => settle({ outcome: 'error', headSha: wait.headSha,
      observedAt: new Date().toISOString(), checks: [], totalChecks: 0, truncated: false,
      diagnostic: 'CI watcher unavailable; inspect the pull request and retry the wait.' }));
  }

  /** `resolveWait`, retried while its durable checkpoint is unavailable: a failed write may not
   *  drop the accepted intent or publish a false result. */
  settleWait(runId: string, waitId: string, result?: WaitResult): void {
    if (this.context.disposed()) return;
    try { this.host.resolveWait(runId, waitId, result); }
    catch {
      if (this.ciRetries.has(waitId)) return;
      console.warn('[cez] wait checkpoint unavailable; retaining result for retry.');
      const timer = setTimeout(() => { this.ciRetries.delete(waitId); this.host.settleWait(runId, waitId, result); }, 1000);
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
}
