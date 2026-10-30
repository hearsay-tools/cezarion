import { isUsageLimitHold } from '@open-mercato/cezar-contract/waits';
import type { RunnerId } from '../../core/agent-runner.ts';
import { loadConfig } from '../../config.ts';
import type { RunRecord } from '../../runs/store.ts';
import { getRepoInfo } from '../../server/git.ts';
import type { AccountHolds } from '../../workspace/semaphore.ts';
import { nextLineEntry } from '../line-order.ts';
import { accountHeldFor } from '../run-scheduling.ts';
import { executionBlockedByRootFinish, historyDeletionPending } from './run-guards.ts';
import type { RunModuleContext } from './types.ts';
import type { WorkflowDef } from '../types.ts';
import type { PendingContinuation, StartRunInput } from './types.ts';

export type PendingJob = { workflow: WorkflowDef; input: StartRunInput; startAt?: number | undefined };


/** Shared empty holds for the common "nothing is held" pump — avoids allocating per sweep. */
const NO_HOLDS: AccountHolds = { deadline: new Set(), inFlight: new Set() };

interface RunLineHost {
  activeSize(): number; activeHas(id: string): boolean;
  withExecutionAccount(run: RunRecord): RunRecord;
  maintenance(id: string): boolean; admitted(id: string): boolean | undefined; workerExecutionStopped(id: string): boolean;
  recovering(): boolean | undefined; recoveringRun(run: RunRecord): boolean; reconcileAutoResumes(): void;
  cancel(id: string): boolean;
  move(id: string, patch: { error: string; finishedAt: string }): unknown;
  beginWorkerExecution(id: string): void; admissionError(error: unknown, fallback: string): string;
  admitQueuedWaitWake(id: string): 'none' | 'handled' | 'deferred';
  launchQueuedRun(id: string, job: PendingJob | undefined, continuation: PendingContinuation | undefined): void;
  reviveQueuedRun(run: RunRecord, reason: string): Promise<void>; pump(): Promise<void>; busySlots(): number;
}

/** Owns the scheduler's line and its in-memory admission state. */
export class RunLine {
  private readonly context: RunModuleContext;
  private readonly host: RunLineHost;
  constructor(context?: RunModuleContext, host?: RunLineHost) {
    this.context = context!; this.host = host!;
  }
  /** The configured default runner as `pump()` last read it, so the sync `oldestWakeAt()` resolves
   *  a runnerless record's account the same way (hearsay-tools/cezarion#1236). */
  private configuredDefaultRunner: RunnerId | undefined;
  private pumping = false;
  /** The scheduler only needs repo presence. Cache the promise (including null) so every sweep
   * doesn't spawn Git (hearsay-tools/cezarion#364); only `rediscoverRepo()` drops a null result.
   * execute() still reads fresh branch/remote metadata for each run. */
  private pumpRepoInfo?: ReturnType<typeof getRepoInfo> | undefined;
  /** The cached probe found no usable repository: the one-task fallback applies. */
  private repoMissing = false;
  /** A pump that arrived while one was in flight — replayed by `pump()`'s own
   *  loop so a slot freed mid-sweep is never a lost wakeup. */
  private pumpAgain = false;

  readonly queue: string[] = [];
  readonly pendingJobs = new Map<string, PendingJob>();
  /** Interrupted agent turns recovered after a process restart. Unlike an
   *  explicit user Continue, these are bulk scheduler work and must re-enter
   *  through `pump()` so both workspace and per-project caps are honored. */
  readonly pendingContinuations = new Map<string, PendingContinuation>();
  // Queue + `starting` set (spec 006, janitor's pump() pattern): `starting`
  // covers the window between shifting a run off the queue and the run
  // registering in `active`, so parallel-slot counting is never racy.
  readonly starting = new Set<string>();
  // Runs parked at `waiting` (open session, ball in the user's court). They
  // don't consume a `maxParallel` slot (open-mercato/cezar#347) — an idle claude process costs
  // memory but no tokens, queued work progressing matters more, and the idle
  // timeout already bounds how long a session can sit open. Invariant:
  // `waiting ⊆ active` — always cleared together via dropActive().
  readonly waiting = new Set<string>();
  /** Durable monitoring subset. Only the configured number receives the waiting-slot exemption. */
  readonly monitoring = new Set<string>();
  /** A run whose resolved waits wait for a wake (hearsay-tools/cezarion#1233). Separate from
   *  human waiting: these resumes MUST reacquire scheduler capacity. Keyed by run id. */
  readonly waitWakeQueuedAt = new Map<string, number>();
  readonly waitWakeAdmitted = new Set<string>();
  /** The watchdog ignores the usage hold for one pump sweep. */
  private forceNextPump = false;
  /** Forced starts keep bypassing the spawn-time gate until dropActive. */
  private readonly forceStarted = new Set<string>();

  /** A monitoring-pool member's wake waiting in the line: it already holds its slot, so it needs
   *  no regular one to leave (hearsay-tools/cezarion#1236). */
  private poolWakeQueued(runId: string): boolean {
    return this.inPool(runId) && this.hasWake(runId) && this.host.activeHas(runId);
  }

  /**
   * Slots this manager holds against the workspace-wide cap. `waiting` runs
   * don't hold a slot (#347): an idle claude process costs memory but no
   * tokens, queued work progressing matters more, and the idle timeout already
   * bounds how long a session can sit open. Because the exemption lives HERE —
   * in the count, not in any acquire path — a message into a `waiting` run
   * (sendMessage) resumes it immediately even when that momentarily exceeds
   * `maxParallel`, including when other projects saturate the cap.
   */
  busySlots(): number {
    // A CI or timer park keeps its slot (hearsay-tools/cezarion#1233): up to
    // `maxMonitoringSessions` of them hold a monitoring slot instead of a regular one, and the
    // rest keep their regular slot. Every other park holds none: a park whose top wait is human
    // or workers (hearsay-tools/cezarion#1235) is in `waiting` and outside the pool.
    const parkedWithoutSlot = [...this.parked()].filter(id => !this.inPool(id)).length;
    const pool = Math.min(this.poolSize(), this.context.semaphore.maxMonitoringSessions());
    return this.host.activeSize() + this.startingCount() - parkedWithoutSlot - pool;
  }

  /** Epoch ms of this manager's oldest queued run (the semaphore's fairness
   *  key when a freed slot is broadcast), or null when nothing is queued.
   *  `queue` is FIFO — `startRun` pushes and `recover()` re-queues by
   *  `createdAt` — so the head is the oldest. */
  oldestQueuedAt(): number | null {
    const head = this.entries()[0];
    if (!head) return null;
    const wakeQueuedAt = this.wakeJoinedAt(head);
    if (wakeQueuedAt !== undefined) return wakeQueuedAt;
    const createdAt = this.context.store.getRun(head)?.createdAt;
    const ms = createdAt ? Date.parse(createdAt) : Number.NaN;
    return Number.isNaN(ms) ? null : ms;
  }

  /** When a queued entry joined the line as a wake of a run already in progress, or undefined for
   *  a run that has not started (hearsay-tools/cezarion#1236, `nextLineEntry`). */
  private wakeJoinedAt(runId: string): number | undefined {
    const wake = this.wakeAt(runId) ?? this.continuation(runId)?.lineJoinedAt;
    if (wake !== undefined || !this.hasJob(runId)) return wake;
    // An owned worker is its family's work in progress, not a new task: it joins the wakes at its
    // creation, so its parent's later wake (a worker wait that timed out, say) does not take the
    // slot before the worker it waits on has run.
    const run = this.context.store.getRun(runId);
    if (run?.delegation?.role !== 'worker') return undefined;
    const created = Date.parse(run.createdAt);
    return Number.isFinite(created) ? created : undefined;
  }

  /** The oldest wake in this manager's line that an account hold does not keep there, or null:
   *  the semaphore gives a freed slot to the project holding the oldest such wake before any
   *  project's unstarted runs. A held wake is left out, or its project would take the slot and
   *  start a new task ahead of another project's started run (hearsay-tools/cezarion#1236). */
  oldestWakeAt(): number | null {
    let oldest: number | null = null;
    let holds: AccountHolds | undefined;
    for (const id of this.entries()) {
      const at = this.wakeJoinedAt(id);
      if (at === undefined || (oldest !== null && at >= oldest)) continue;
      holds ??= this.context.semaphore.accountHolds();
      // The same blockers `pump()` applies, capacity aside: a wake that cannot leave for any of
      // them must not win the slot for its project's unstarted work. A runnerless record runs on
      // the configured default, which only `pump()` reads (async); until it has, such a wake is
      // not advertised while anything is held.
      const runnerless = holds.deadline.size + holds.inFlight.size > 0 && this.context.store.getRun(id)?.runner === undefined;
      if (runnerless && this.configuredDefaultRunner === undefined) continue;
      if (!this.canLeaveLine(id, holds, this.configuredDefaultRunner ?? 'claude')) continue;
      oldest = at;
    }
    return oldest;
  }

  /** Can this queued entry leave the line now, capacity aside? No worktree cleanup, no
   *  autosave cleanup, no pending root finish, no account hold, and not already admitted
   *  elsewhere. `pump()` and `oldestWakeAt()` share it, so the workspace order and the project
   *  order agree (hearsay-tools/cezarion#1236). */
  private canLeaveLine(id: string, holds: AccountHolds, fallbackRunner: RunnerId): boolean {
    if (this.host.maintenance(id)) return false;
    const queued = this.context.store.getRun(id);
    if (!queued || historyDeletionPending(this.context.store, id)) return true;
    if (this.host.admitted(id) && !this.host.activeHas(id)) return false;
    if (executionBlockedByRootFinish(this.context.store, queued)) return false;
    return !accountHeldFor(this.host.withExecutionAccount(queued), holds, fallbackRunner);
  }

  /**
   * A slot this manager held just came free. Pump the whole WORKSPACE, not
   * just this manager: `maxParallel` is counted across every project, so the
   * run that should take the slot is the workspace's oldest queued one — which
   * usually sits in another project's queue. Pumping only `this` is what left
   * a queued run in project B stuck at `queued` while project A's runs came
   * and went. `release()` pumps this manager too, so it replaces the local
   * `pump()` at every slot-freeing transition.
   */
  releaseSlot(): void {
    void this.context.semaphore.release();
  }

  /**
   * Start queued runs while parallel slots are free. A run starts only under
   * BOTH ceilings: the WORKSPACE `resources.maxParallel` (default 2, counted
   * across every manager — spec 2026-07-20, step 2.5) AND this project's own
   * per-project `maxParallel` when the registry sets one (spec 2026-07-22,
   * inherits the workspace cap when unset). Legacy per-repo `maxParallel` keys
   * are ignored. A non-git directory degrades to 1 sequential run in the repo
   * root (spec 006 degradation rule), which is always the tighter bound.
   */
  async pump(): Promise<void> {
    return this.context.work.track('pump', this.pumpWork());
  }

  private async pumpWork(): Promise<void> {
    // Any recovery, scoped or not: each ends with a pump of its own, so nothing waits for long.
    if (this.context.disposed() || this.host.recovering()) return;
    this.host.reconcileAutoResumes();
    // A pump requested while one is in flight can't just be dropped: the
    // in-flight pass may already have read capacity (it awaits `getRepoInfo`
    // before the first check), so a slot freed in that window would be lost
    // until the next unrelated event. Re-run the sweep instead.
    if (this.pumping) {
      this.pumpAgain = true;
      return;
    }
    this.pumping = true;
    try {
      do {
        this.pumpAgain = false;
        const repo = await (this.pumpRepoInfo ??= getRepoInfo(this.context.repoRoot));
        this.repoMissing = repo === null;
        const maxParallel = this.context.semaphore.maxParallel();
        // Per-project ceiling (spec 2026-07-22-per-project-concurrency): this
        // project never runs more than its own configured `maxParallel`; absent
        // an override it equals the workspace cap, so behavior is unchanged.
        const projectMax = this.context.semaphore.projectMaxParallel(this.context.repoRoot);
        // `waiting` runs don't hold a slot (#347) — see busySlots(). The check
        // below is the only slot gate: resumes never pass through it. A run
        // starts only under BOTH the workspace cap and this project's ceiling.
        const capacity = () =>
          this.context.semaphore.busy() < maxParallel &&
          this.host.busySlots() < projectMax &&
          (repo !== null || this.host.busySlots() < 1);
        // The usage-limit hold (spec 2026-08-03-auto-resume-after-usage-limit).
        //
        // A limit closes an ACCOUNT, not a run — so starting the next queued task walks it into
        // the same wall. Measured before this gate existed: eight tasks under `maxParallel: 2`
        // all failed within 517 ms, each spawning a CLI (and, outside worktree-opt-out mode, a
        // worktree and a branch) only to be marked `scheduled`. The cap was respected at every
        // instant and was no brake at all, because a doomed run lives ~200 ms.
        //
        // So: while any run on an account is waiting out a limit, nothing new starts on THAT
        // account. Other accounts (a second login, a different backend) keep running — the hold
        // is keyed, not global. The set is derived from the durable records rather than tracked
        // separately, which is what makes it survive a restart, expire on its own, and lift the
        // instant a user cancels a resume.
        // The watchdog's one-shot override — read and cleared here, so a forced sweep never
        // leaks into the next ordinary one.
        const forced = this.takeForced();
        const holds = this.entries().length > 0 && !forced ? this.context.semaphore.accountHolds() : NO_HOLDS;
        const anyHold = holds.deadline.size > 0 || holds.inFlight.size > 0;
        // Only pay for the config read when something is actually held: a queued record may name
        // no runner, and then the account it would use is the configured default.
        const defaultRunner = anyHold ? (await loadConfig(this.context.repoRoot)).defaultRunner : undefined;
        if (defaultRunner !== undefined) this.configuredDefaultRunner = defaultRunner;
        while (this.entries().length > 0) {
          // Recovery may have begun while this pump awaited repository/config discovery.
          if (this.context.disposed() || this.host.recovering()) return;
          // Wakes first, then unstarted runs, each FIFO among the entries that CAN start
          // (hearsay-tools/cezarion#1236); a held one keeps its place in the queue rather than
          // being dequeued and re-queued (which would churn its position and its record).
          const next = nextLineEntry(this.entries(), (id) => this.wakeJoinedAt(id),
            (id) => (capacity() || this.poolWakeQueued(id)) && this.canLeaveLine(id, anyHold ? holds : NO_HOLDS, defaultRunner ?? 'claude'));
          if (next === -1) break; // every queued run has a durable reason to remain held
          const candidate = this.entries()[next]!;
          if (this.host.workerExecutionStopped(candidate)) { this.host.cancel(candidate); continue; }
          if (!this.checkpointQueuedWorker(candidate, next)) continue;
          const runId = this.takeAt(next);
          if (!runId) break;
          const wake = this.host.admitQueuedWaitWake(runId);
          if (wake === 'deferred') break;
          if (wake === 'handled') continue;
          this.launchQueuedRun(runId, forced);
        }
      } while (this.pumpAgain);
    } finally {
      this.pumping = false;
    }
  }

  /**
   * Probe Git again when queued work waits only behind the one-task fallback, so a project opened
   * before its first commit gets normal scheduling without a restart (hearsay-tools/cezarion#2257).
   * Every other case spawns no Git: a found repository stays cached, as hearsay-tools/cezarion#364 needs.
   */
  rediscoverRepo(): void {
    if (this.context.disposed() || !this.repoMissing || this.entries().length === 0) return;
    const busy = this.host.busySlots();
    if (busy < 1 || busy >= this.context.semaphore.projectMaxParallel(this.context.repoRoot)) return;
    if (this.context.semaphore.busy() >= this.context.semaphore.maxParallel()) return;
    this.pumpRepoInfo = undefined;
    this.repoMissing = false;
    void this.host.pump();
  }

  /** Checkpoint before dequeue, while worker cancellation can still find the queued entry. */
  private checkpointQueuedWorker(candidate: string, next: number): boolean {
    if (!this.host.activeHas(candidate) && (this.hasJob(candidate) || this.hasContinuation(candidate))) {
      try { this.host.beginWorkerExecution(candidate); }
      catch (error) {
        this.takeAt(next); this.takePending(candidate);
        this.host.move(candidate, { error: this.host.admissionError(error, 'worker execution checkpoint unavailable'), finishedAt: new Date().toISOString() });
        return false;
      }
    }
    return true;
  }

  private launchQueuedRun(runId: string, forced: boolean): void {
    if (this.removeWake(runId, false)) this.admitWake(runId);
    // A forced sweep has to reach the spawn: the gate inside `execute` asks the same
    // question and would send this run straight back to the queue.
    if (forced) this.markForced(runId);
    const { job, continuation } = this.takePending(runId);
    if (!job && !continuation) return;
    this.markStarting(runId);
    this.host.launchQueuedRun(runId, job, continuation);
  }

  /**
   * Repair queued records missing executable state. Rescue an idle queue only when no running work
   * or future appointment explains it; start through ordinary caps. Public for direct tests.
   */
  async rescueStalledQueue(now = Date.now()): Promise<void> {
    return this.context.work.track('rescueStalledQueue', this.rescueStalledQueueWork(now));
  }

  private async rescueStalledQueueWork(now = Date.now()): Promise<void> {
    if (this.context.disposed()) return;
    // First, the worst shape: a record that says `queued` while the engine holds no job, no
    // continuation and no queue entry for it. `pump()` cannot see such a run — it iterates the
    // queue, and this one is not in it — so nothing will ever start it. Re-adopt it through the
    // same path boot recovery uses.
    for (const run of this.context.store.listRuns()) {
      if (run.status !== 'queued' || this.host.recoveringRun(run)) continue;
      if (this.host.activeHas(run.id) || this.hasStarting(run.id)) continue;
      if (this.hasJob(run.id) || this.hasContinuation(run.id)) continue;
      if (this.hasQueued(run.id)) continue;
      console.warn(`[cez] queue watchdog: re-adopting queued run ${run.id} the engine had lost`);
      await this.host.reviveQueuedRun(run, 'queue watchdog');
    }
    if (this.entries().length === 0) return;
    if (this.host.busySlots() > 0 || this.startingCount() > 0) return;
    if (this.context.semaphore.busy() > 0) return;
    // A future deadline is a real reason to sit still: that timer will fire and pump.
    for (const run of this.context.store.listRuns()) {
      if (!isUsageLimitHold(run)) continue;
      const deadline = Date.parse(run.autoResumeAt);
      if (Number.isFinite(deadline) && deadline > now) return;
    }
    if (this.context.semaphore.accountHolds().inFlight.size === 0) {
      // Not the hold, then — some other wakeup went missing. An ordinary pump is the whole fix,
      // and it is idempotent, so this stays quiet.
      void this.host.pump();
      return;
    }
    console.warn(
      '[cez] queue watchdog: work is queued, nothing is running, and the usage-limit hold has no'
      + ' deadline behind it — starting the next task anyway',
    );
    this.forceNext();
    void this.host.pump();
  }

  entries(): readonly string[] { return this.queue; }
  indexOf(id: string): number { return this.queue.indexOf(id); }
  hasQueued(id: string): boolean { return this.queue.includes(id); }
  hasStarting(id: string): boolean { return this.starting.has(id); }
  startingCount(): number { return this.starting.size; }
  parked(): ReadonlySet<string> { return this.waiting; }
  isParked(id: string): boolean { return this.waiting.has(id); }
  inPool(id: string): boolean { return this.monitoring.has(id); }
  poolSize(): number { return this.monitoring.size; }
  wakeAt(id: string): number | undefined { return this.waitWakeQueuedAt.get(id); }
  hasWake(id: string): boolean { return this.waitWakeQueuedAt.has(id); }
  isAdmitted(id: string): boolean { return this.waitWakeAdmitted.has(id); }
  admissions(): ReadonlySet<string> { return this.waitWakeAdmitted; }
  hasJob(id: string): boolean { return this.pendingJobs.has(id); }
  job(id: string): PendingJob | undefined { return this.pendingJobs.get(id); }
  hasContinuation(id: string): boolean { return this.pendingContinuations.has(id); }
  continuation(id: string): PendingContinuation | undefined { return this.pendingContinuations.get(id); }

  enqueueJob(id: string, job: PendingJob): void { this.pendingJobs.set(id, job); this.queue.push(id); }
  enqueueContinuation(id: string, continuation: PendingContinuation, onlyIfAbsent = false): void {
    this.pendingContinuations.set(id, continuation);
    if (!onlyIfAbsent || !this.queue.includes(id)) this.queue.push(id);
  }
  enqueueWake(id: string, at: number, onlyIfAbsent = true): void {
    this.waitWakeQueuedAt.set(id, at);
    if (!onlyIfAbsent || !this.queue.includes(id)) this.queue.push(id);
  }
  markWake(id: string, at: number): void { this.waitWakeQueuedAt.set(id, at); }
  removeWake(id: string, removeEntry = true): boolean {
    const removed = this.waitWakeQueuedAt.delete(id);
    if (removed && removeEntry) { const index = this.queue.indexOf(id); if (index >= 0) this.queue.splice(index, 1); }
    return removed;
  }
  takeAt(index: number): string | undefined { return this.queue.splice(index, 1)[0]; }
  takePending(id: string): { job: PendingJob | undefined; continuation: PendingContinuation | undefined } {
    const job = this.pendingJobs.get(id); const continuation = this.pendingContinuations.get(id);
    this.pendingJobs.delete(id); this.pendingContinuations.delete(id);
    return { job, continuation };
  }
  markStarting(id: string): void { this.starting.add(id); }
  unmarkStarting(id: string): void { this.starting.delete(id); }
  park(id: string): void { this.waiting.add(id); }
  unpark(id: string): void { this.waiting.delete(id); }
  joinPool(id: string): void { this.monitoring.add(id); }
  leavePool(id: string): boolean { return this.monitoring.delete(id); }
  admitWake(id: string): void { this.waitWakeAdmitted.add(id); }
  retireAdmission(id: string): boolean { return this.waitWakeAdmitted.delete(id); }
  forceNext(): void { this.forceNextPump = true; }
  takeForced(): boolean { const forced = this.forceNextPump; this.forceNextPump = false; return forced; }
  markForced(id: string): void { this.forceStarted.add(id); }
  clearForced(id: string): void { this.forceStarted.delete(id); }
  isForced(id: string): boolean { return this.forceStarted.has(id); }
  forget(id: string): void {
    this.waiting.delete(id); this.monitoring.delete(id); this.waitWakeAdmitted.delete(id); this.removeWake(id);
  }
  dispose(): void {
    this.waiting.clear(); this.starting.clear(); this.queue.length = 0;
    this.pendingJobs.clear(); this.pendingContinuations.clear();
  }
}
