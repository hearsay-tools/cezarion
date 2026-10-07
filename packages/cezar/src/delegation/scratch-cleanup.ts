import { agentTmpDirMayExist, removeAgentTmpDir, sweepAgentTmpDirs } from '../runs/agent-tmpdir.ts';
import { workerEvidenceRunIds } from '../runs/worker-execution.ts';
import type { RunStore } from '../runs/store.ts';
import { sharedCwdScan, type CwdSource } from './process-liveness.ts';
import { noJitter, retryDelayMs, SCRATCH_BACKOFF, type Backoff } from './retry-backoff.ts';

type Pending = { at: number; attempts: number; generation?: string; resourceId?: string };

/** Terminal intent lives in the generation checkpoint as well as the run index. Unknown
 * evidence is retained and reprobed, including when the index cannot load the worker.
 * One timer serves every pending id, and a tick shares one `/proc` scan across every id it
 * probes; a retained id backs off to hourly (hearsay-tools/cezarion#879). The batch does not
 * jitter: ids that probe together should keep probing together. */
export class WorkerScratchCleanup {
  private due = new Map<string, Pending>();
  private timer?: NodeJS.Timeout;
  /** The `at` the timer was armed for; with the clock, it decides what a tick takes. */
  private armedFor = 0;
  private ticking = false;
  private recoveryTimer?: NodeJS.Timeout;
  private enabled = true;
  // Private and overridable so tests need not wait out production cadence.
  private backoff: Backoff = SCRATCH_BACKOFF;
  constructor(private store: RunStore, private dataDir: string, private busy: (id: string) => boolean) {}

  pause(): void {
    this.enabled = false;
    clearTimeout(this.timer); this.timer = undefined;
    this.due.clear();
    clearTimeout(this.recoveryTimer); this.recoveryTimer = undefined;
  }
  recover(): void {
    // A store that could not open (#779) knows none of its runs: every scratch dir would look orphaned.
    if (this.store.unavailable) return;
    this.enabled = true;
    clearTimeout(this.recoveryTimer); this.recoveryTimer = undefined;
    const retained = workerEvidenceRunIds(this.dataDir);
    // Only runs that can own scratch matter: the live set, and every worker or quarantined run
    // by id (indexed, nothing decoded, #779). Other finished runs were reaped when they ended.
    const live = this.store.listRuns();
    const owners = [...this.store.listWorkerIds(), ...this.store.listQuarantinedRunIds()];
    for (const id of new Set([...live.map(run => run.id), ...owners, ...(retained ?? [])])) this.schedule(id);
    // The sweep independently reserves every private-evidence id, even if the index lost it, and
    // every run another process claims (#779): its live runs are not in this store's live set, and
    // their scratch is theirs.
    sweepAgentTmpDirs(this.dataDir, [...new Set([...live.filter(run =>
      this.busy(run.id) || ['queued', 'running', 'waiting'].includes(run.status)).map(run => run.id), ...owners,
      ...this.store.listForeignClaimedRunIds()])]);
    if (!retained) { // failed enumeration must not permanently lose a wake source
      this.recoveryTimer = setTimeout(() => this.recover(), 60_000); this.recoveryTimer.unref?.();
    }
  }
  /** A cleanup intent: probe now. An id already pending for the same generation keeps its place
   * in the backoff, so a repeated terminal `run` event cannot reset it; a new generation starts over. */
  schedule(id: string): void {
    const pending = this.due.get(id);
    if (pending && this.store.readWorkerExecution(id)?.generation === pending.generation) return;
    this.arm(id, 0, 0);
  }

  private arm(id: string, attempts: number, delay: number, from = Date.now()): void {
    this.due.delete(id);
    if (!this.enabled || this.store.unavailable) return;
    // The scratch check first: most ids have none, and a finished record is decoded to ask (#779).
    if (!agentTmpDirMayExist(this.dataDir, id)) return;
    // Another process's run (#779, plan step 3): cleaning up after it is its owner's job, or the
    // job of whoever adopts it once that owner is gone.
    if (this.store.writeRefusal(id)) return;
    const run = this.store.getRun(id);
    if (run && (['queued', 'running', 'waiting'].includes(run.status) ||
      (run.delegation?.role !== 'worker' && run.delegation?.role !== 'invalid'))) return;
    // Reconstruct older complete checkpoints while the valid terminal index still exists.
    try { this.store.retainWorkerScratchCleanup(id); } catch { /* retry unreadable evidence */ }
    const proof = this.store.readWorkerExecution(id);
    if (run?.delegation?.role === 'worker' && proof && proof.phase !== 'complete') return;
    this.due.set(id, { at: from + delay, attempts, generation: proof?.generation, resourceId: proof?.scratchCleanup?.resourceId });
    if (!this.ticking) this.wake();
  }

  private wake(): void {
    clearTimeout(this.timer); this.timer = undefined;
    if (!this.enabled || !this.due.size) return;
    let next = Infinity;
    for (const { at } of this.due.values()) next = Math.min(next, at);
    this.armedFor = next;
    this.timer = setTimeout(() => this.tick(), Math.max(0, next - Date.now()));
    this.timer.unref?.();
  }

  private tick(): void {
    this.timer = undefined;
    if (!this.enabled) return;
    // Ids due within 5 % of the fast cadence ride along, so near neighbours share the scan, and
    // every id this tick retains is re-armed from the same instant, so they stay together.
    const now = Date.now();
    const dueBy = Math.max(this.armedFor, now) + this.backoff.fastMs / 20;
    const cwds = sharedCwdScan();
    this.ticking = true;
    try {
      for (const [id, pending] of [...this.due]) if (pending.at <= dueBy) this.probe(id, pending, cwds, now);
    } finally { this.ticking = false; }
    this.wake();
  }

  private probe(id: string, { attempts, generation, resourceId }: Pending, cwds: CwdSource, now: number): void {
    this.due.delete(id);
    const execution = this.store.readWorkerExecution(id);
    // No await between ownership/generation + holder proof and rm. Admission is synchronous
    // too, so a queued stale callback can never touch the next generation's scratch. The
    // shared snapshot is this synchronous tick's: it never outlives a yield.
    try {
      if (generation && resourceId && execution?.generation === generation && !this.busy(id) &&
        this.store.workerScratchResourcesSafe(id, generation, resourceId, cwds)) removeAgentTmpDir(this.dataDir, id);
    } catch { /* Transient evidence/read failures retain the durable intent for another wake. */ }
    // Uncertainty has no age limit or force-delete exit; it backs off instead.
    this.arm(id, attempts + 1, retryDelayMs(attempts, this.backoff, noJitter), now);
  }
}
