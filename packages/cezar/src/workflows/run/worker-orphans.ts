import type { RunModuleContext, WorkerTerminationBlocker } from './types.ts';
import { agentTmpDirLocationEvidence } from '../../runs/agent-tmpdir.ts';
import { processGroupAlive, processGroupOf, signalProcessGroup } from '../../core/session-process.ts';
import { noJitter, retryDelayMs, type Backoff } from '../../delegation/retry-backoff.ts';
import { inspectExecutionGeneration, isCurrentProcess, processesWithCwdUnder, processStartToken, recordedGroupSignalable, recordedProcessLive, sharedCwdScan, type CwdSource, type GenerationProbe, type RecordedProcess, type WorkerProcessRecord } from '../../delegation/process-liveness.ts';

/** How long a non-gone orphan probe stands before the next scan. */
const ORPHAN_PROBE_CACHE_MS = 2_000;

type OrphanOptions = { admitting?: boolean; fresh?: boolean; cwds?: CwdSource };
interface WorkerOrphansHost {
  holds(runId: string, admitting: boolean): boolean;
  reapTerminalScratch(runId: string): void;
  settleOrphanedWorkerExecution(runId: string, opts?: OrphanOptions): boolean;
  orphanBackoff(): Backoff;
  orphanTermGraceMs(): number;
}

export class WorkerOrphans {
  constructor(private readonly context: RunModuleContext, private readonly host: WorkerOrphansHost) {}

  forgetBlockers(runId: string): void {
    this.orphanBlockers.delete(runId); this.reportedOrphanBlockers.delete(runId);
  }

  dispose(): void {
    this.orphanDue.clear(); clearTimeout(this.orphanTimer); this.orphanTimer = undefined;
    this.orphanProbes.clear(); this.orphanBlockers.clear(); this.reportedOrphanBlockers.clear();
  }

  /** #469: the generation a dead controller left `starting`, if this manager may judge it. A
   * generation this process controls is never judged here: the in-memory execution map owns it,
   * and a disposed manager's still-running sessions look like orphans. `busy` is transient (this
   * manager holds the run); `unknown` is a present record that proves nothing. */
  private orphanState(runId: string, admitting = false):
    | { state: 'none' | 'busy' | 'unknown' }
    | { state: 'orphan'; generation: string; record?: WorkerProcessRecord; paths: string[]; pathsComplete: boolean } {
    const run = this.context.store.getRun(runId);
    if (run?.delegation?.role !== 'worker' || this.context.disposed()) return { state: 'none' };
    if (this.host.holds(runId, admitting)) return { state: 'busy' };
    const proof = this.context.store.readWorkerExecution(runId);
    if (proof?.phase !== 'starting') return { state: 'none' };
    const record = this.context.store.readWorkerProcesses(runId, proof.generation);
    // A present record that proves nothing (unreadable, malformed, another generation) blocks both
    // finalization and reaping; only an absent one is legacy, scan-only evidence.
    if (record === 'unknown') return { state: 'unknown' };
    if (record !== 'absent' && isCurrentProcess(record.controller)) return { state: 'none' };
    // Legacy execution proof also considers scratch holders; cleanup uses a separate strict proof.
    const locations = agentTmpDirLocationEvidence(this.context.dataDir, runId);
    return { state: 'orphan', generation: proof.generation, ...(record === 'absent' ? {} : { record }),
      paths: [run.delegation.workspace.path, ...locations.paths], pathsComplete: locations.complete };
  }

  orphanedWorkerGeneration(runId: string, admitting = false) {
    const orphan = this.orphanState(runId, admitting);
    return orphan.state === 'orphan' ? orphan : undefined;
  }

  /** Settles a crashed generation after exit proof. Sync and signal-free; recovery, resume,
   * delivery, collect and destroy then take their normal paths.
   * A non-gone probe is cached briefly: on darwin the scan is a synchronous `lsof` on the event loop. */
  settleOrphanedWorkerExecution(runId: string, opts: { admitting?: boolean; fresh?: boolean; cwds?: CwdSource } = {}): boolean {
    const orphan = this.orphanedWorkerGeneration(runId, opts.admitting);
    if (!orphan) return false;
    const cached = this.orphanProbes.get(runId);
    if (!opts.fresh && cached?.generation === orphan.generation && Date.now() - cached.at < ORPHAN_PROBE_CACHE_MS) return false;
    const probe = inspectExecutionGeneration({ ...orphan, cwds: opts.cwds });
    if (probe.liveness !== 'gone') { this.orphanProbes.set(runId, { generation: orphan.generation, at: Date.now(), probe }); return false; }
    // A stale `alive` must not outlive a `gone` probe, even when the commit below fails.
    this.orphanProbes.delete(runId);
    try {
      if (!this.context.store.commitWorkerExecutionComplete(runId, orphan.generation)) return false;
    } catch { return false; }
    this.orphanProbes.delete(runId); this.orphanBlockers.delete(runId); this.reportedOrphanBlockers.delete(runId); this.clearOrphanReprobe(runId);
    this.context.store.appendEvent(runId, { type: 'lifecycle', message: "the interrupted worker's processes are gone; its execution was finalized" });
    this.host.reapTerminalScratch(runId);
    return true;
  }

  private readonly orphanProbes = new Map<string, { generation: string; at: number; probe: GenerationProbe }>();
  /** Pending orphan reprobes by run id. One timer serves them all (hearsay-tools/cezarion#879). */
  readonly orphanDue = new Map<string, { generation: string; at: number; attempts: number }>();
  private orphanTimer?: NodeJS.Timeout | undefined;
  /** The `at` the timer was armed for; with the clock, it decides what a tick takes. */
  private orphanArmedFor = 0;
  private readonly orphanBlockers = new Map<string, WorkerTerminationBlocker>();
  private readonly reportedOrphanBlockers = new Map<string, string>();

  /** #469: a survivor that dies after recovery has no other wake source (no exit callback for a
   * process another cezar spawned). Unref'd; finalization's `run` event then lets worker waits and
   * outcomes observe it. Every 15 s for the first 15 minutes, then backing off to hourly
   * (hearsay-tools/cezarion#879), so a long-lived survivor is still noticed when it exits. One
   * timer serves every orphan, and a tick shares one `/proc` scan across them. A tick while this
   * manager holds the run is skipped; only terminal reasons (proof settled, generation changed,
   * run gone, unknown record, dispose) stop it. */
  armOrphanReprobe(runId: string): void {
    const armed = this.orphanedWorkerGeneration(runId);
    if (this.context.disposed() || this.orphanDue.has(runId) || !armed) return;
    this.orphanDue.set(runId, { generation: armed.generation, at: Date.now() + retryDelayMs(0, this.host.orphanBackoff(), noJitter), attempts: 0 });
    this.wakeOrphanReprobes();
  }

  private wakeOrphanReprobes(): void {
    clearTimeout(this.orphanTimer); this.orphanTimer = undefined;
    if (this.context.disposed() || !this.orphanDue.size) return;
    let next = Infinity;
    for (const { at } of this.orphanDue.values()) next = Math.min(next, at);
    this.orphanArmedFor = next;
    this.orphanTimer = setTimeout(() => this.orphanReprobeTick(), Math.max(0, next - Date.now()));
    this.orphanTimer.unref?.();
  }

  private orphanReprobeTick(): void {
    this.orphanTimer = undefined;
    if (this.context.disposed()) return;
    // Orphans due within 5 % of the fast cadence ride along, so near neighbours share the scan, and
    // every orphan this tick keeps is re-armed from the same instant, so they stay together.
    const now = Date.now();
    const dueBy = Math.max(this.orphanArmedFor, now) + this.host.orphanBackoff().fastMs / 20;
    const cwds = sharedCwdScan();
    for (const [runId, pending] of [...this.orphanDue]) {
      if (pending.at > dueBy) continue;
      this.orphanDue.delete(runId);
      const orphan = this.orphanState(runId);
      let attempts = pending.attempts;
      if (orphan.state !== 'busy') {
        // Ticks are seconds apart, so the brief probe cache would only skip them: probe fresh.
        if (orphan.state !== 'orphan' || orphan.generation !== pending.generation ||
          this.host.settleOrphanedWorkerExecution(runId, { fresh: true, cwds })) continue;
        attempts++;
      }
      this.orphanDue.set(runId, { ...pending, attempts, at: now + retryDelayMs(attempts, this.host.orphanBackoff(), noJitter) });
    }
    this.wakeOrphanReprobes();
  }

  private clearOrphanReprobe(runId: string): void {
    this.orphanDue.delete(runId);
  }

  /** Why the last destroy could not prove termination (#469), and whether that differs from the
   * reason last reported, so a retry loop appends one lifecycle event per distinct blocker set. */
  takeWorkerTerminationBlocker(runId: string): { blocker: WorkerTerminationBlocker; changed: boolean } | undefined {
    const blocker = this.orphanBlockers.get(runId);
    if (!blocker) return undefined;
    const key = JSON.stringify(blocker);
    const changed = this.reportedOrphanBlockers.get(runId) !== key;
    this.reportedOrphanBlockers.set(runId, key);
    return { blocker, changed };
  }

  /** Continue over a live orphan names what still runs; other refusals keep the generic text. */
  orphanAdmissionRefusal(runId: string): string | undefined {
    const orphan = this.orphanedWorkerGeneration(runId, true);
    const probe = orphan && this.orphanProbes.get(runId);
    if (!probe || probe.generation !== orphan.generation) return undefined;
    if (probe.probe.controller !== undefined) return `the worker is still controlled by a live cezar (pid ${probe.probe.controller})`;
    const pid = probe.probe.pids[0];
    return pid === undefined ? undefined : `a process of the previous execution is still running (pid ${pid})`;
  }

  /** Destroy only (#469): signal the recorded, token-verified survivors of a generation whose
   * controller is proven dead, then finalize on `gone`. Scan-only processes are never signalled. */
  async reapOrphanedWorker(runId: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + Math.min(30_000, Math.max(0, Number.isFinite(timeoutMs) ? timeoutMs : 0));
    this.orphanBlockers.delete(runId);
    const initial = this.orphanState(runId);
    if (initial.state === 'unknown') { this.orphanBlockers.set(runId, { kind: 'unreadable' }); return; }
    const orphan = this.orphanedWorkerGeneration(runId);
    if (!orphan || this.host.settleOrphanedWorkerExecution(runId, { fresh: true })) return;
    const same = () => this.orphanedWorkerGeneration(runId)?.generation === orphan.generation;
    // >= 500 ms: every probe may be a synchronous darwin `lsof`.
    const pause = () => new Promise(resolve => setTimeout(resolve, Math.max(0, Math.min(500, deadline - Date.now()))));
    // A live controller is another cezar's: nothing to signal or wait for. Otherwise signal only
    // recorded, token-verified survivors and recorded session groups (none for a legacy
    // record-less generation), then wait for readable cwd holders until the deadline.
    if (!orphan.record || !recordedProcessLive(orphan.record.controller)) {
      if (orphan.record) {
        const { processes } = orphan.record;
        await this.terminateRecorded({
          pids: processes.filter(entry => entry.pgid === undefined && entry.startToken !== undefined && recordedProcessLive(entry)),
          groups: processes.filter(entry => entry.pgid !== undefined),
          paths: orphan.paths,
        }, deadline, pause, same);
      }
      while (!this.host.settleOrphanedWorkerExecution(runId, { fresh: true }) && Date.now() < deadline && same()) await pause();
    }
    if (!same()) return;
    const probe = this.orphanProbes.get(runId)?.probe;
    if (probe?.controller !== undefined) this.orphanBlockers.set(runId, { kind: 'controller', pid: probe.controller });
    else if (probe?.pids.length) this.orphanBlockers.set(runId, { kind: 'processes', pids: probe.pids });
  }

  /** Destroy only: SIGTERM recorded survivors, then SIGKILL what outlives `orphanTermGraceMs`.
   * `pids` are signalled by token-verified pid; `groups` are session leaders whose whole process
   * group is signalled (hearsay-tools/cezarion#890), so what an agent left behind exits with it. A
   * dead leader's group counts only while a process holding `paths` is in it. Every signal
   * re-verifies first: a reused PID or group number is never touched. */
  private async terminateRecorded(targets: { pids: RecordedProcess[]; groups: RecordedProcess[]; paths: readonly string[] }, deadline: number,
    pause: () => Promise<unknown>, current: () => boolean = () => true): Promise<void> {
    const holders = processesWithCwdUnder(targets.paths);
    const holderGroups = () => { return (holders === 'unknown' ? [] : holders).map(processGroupOf).filter((pgid): pgid is number => pgid !== undefined); };
    const groups = targets.groups.filter(entry => recordedGroupSignalable(entry, holderGroups()) && processGroupAlive(entry.pgid!));
    const living = () => targets.pids.some(recordedProcessLive) || groups.some(entry => processGroupAlive(entry.pgid!));
    const signal = (name: NodeJS.Signals) => {
      for (const entry of targets.pids) {
        if (!current()) return;
        if (processStartToken(entry.pid) === entry.startToken) try { process.kill(entry.pid, name); } catch { /* already gone */ }
      }
      const evidence = holderGroups();
      for (const entry of groups) {
        if (!current()) return;
        if (recordedGroupSignalable(entry, evidence)) signalProcessGroup(entry.pgid!, name);
      }
    };
    if (!living()) return;
    signal('SIGTERM');
    const killAt = Math.min(deadline, Date.now() + this.host.orphanTermGraceMs());
    while (Date.now() < killAt && living()) await pause();
    if (living()) signal('SIGKILL');
  }

  /** Destroy of a finished generation (hearsay-tools/cezarion#890): a dev server or watcher its
   * agent left in its process group holds the worktree, and nothing else ties it to the worker.
   * A record whose controller is another live cezar is not ours to act on. */
  async terminateFinishedWorkerGroups(runId: string, timeoutMs: number): Promise<void> {
    const proof = this.context.store.readWorkerExecution(runId);
    if (proof?.phase !== 'complete') return;
    const record = this.context.store.readWorkerProcesses(runId, proof.generation);
    const run = this.context.store.getRun(runId);
    if (typeof record === 'string' || run?.delegation?.role !== 'worker' ||
      (recordedProcessLive(record.controller) && !isCurrentProcess(record.controller))) return;
    const groups = record.processes.filter(entry => entry.pgid !== undefined);
    if (!groups.length) return;
    const deadline = Date.now() + Math.min(30_000, Math.max(0, Number.isFinite(timeoutMs) ? timeoutMs : 0));
    const pause = () => new Promise(resolve => setTimeout(resolve, Math.max(0, Math.min(100, deadline - Date.now()))));
    const paths = [run.delegation.workspace.path, ...agentTmpDirLocationEvidence(this.context.dataDir, runId).paths];
    await this.terminateRecorded({ pids: [], groups, paths }, deadline, pause);
  }

}

/** #469: admission refused because a process of the previous generation still runs. */
export class WorkerOrphanAliveError extends Error {}
export const admissionError = (error: unknown, fallback: string) => error instanceof WorkerOrphanAliveError ? error.message : fallback;
