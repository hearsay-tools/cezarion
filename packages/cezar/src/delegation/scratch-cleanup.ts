import { agentTmpDirMayExist, removeAgentTmpDir, sweepAgentTmpDirs } from '../runs/agent-tmpdir.ts';
import { workerEvidenceRunIds } from '../runs/worker-execution.ts';
import type { RunStore } from '../runs/store.ts';

/** Terminal intent lives in the generation checkpoint as well as the run index. Unknown
 * evidence is retained and reprobed, including when the index cannot load the worker. */
export class WorkerScratchCleanup {
  private timers = new Map<string, NodeJS.Timeout>();
  private recoveryTimer?: NodeJS.Timeout;
  private enabled = true;
  constructor(private store: RunStore, private dataDir: string, private busy: (id: string) => boolean) {}

  pause(): void {
    this.enabled = false;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    clearTimeout(this.recoveryTimer); this.recoveryTimer = undefined;
  }
  recover(): void {
    this.enabled = true;
    clearTimeout(this.recoveryTimer); this.recoveryTimer = undefined;
    const retained = workerEvidenceRunIds(this.dataDir);
    // Only runs that can own scratch matter: the live set, and every worker or quarantined run
    // by id (indexed, nothing decoded, #779). Other finished runs were reaped when they ended.
    const live = this.store.listRuns();
    const owners = [...this.store.listWorkerIds(), ...this.store.listQuarantinedRunIds()];
    for (const id of new Set([...live.map(run => run.id), ...owners, ...(retained ?? [])])) this.schedule(id);
    // The sweep independently reserves every private-evidence id, even if the index lost it.
    sweepAgentTmpDirs(this.dataDir, [...new Set([...live.filter(run =>
      this.busy(run.id) || ['queued', 'running', 'waiting'].includes(run.status)).map(run => run.id), ...owners])]);
    if (!retained) { // failed enumeration must not permanently lose a wake source
      this.recoveryTimer = setTimeout(() => this.recover(), 60_000); this.recoveryTimer.unref?.();
    }
  }
  schedule(id: string, delay = 0): void {
    if (!this.enabled || this.timers.has(id)) return;
    // The scratch check first: most ids have none, and a finished record is decoded to ask (#779).
    if (!agentTmpDirMayExist(this.dataDir, id)) return;
    const run = this.store.getRun(id);
    if (run && (['queued', 'running', 'waiting'].includes(run.status) ||
      (run.delegation?.role !== 'worker' && run.delegation?.role !== 'invalid'))) return;
    // Reconstruct older complete checkpoints while the valid terminal index still exists.
    try { this.store.retainWorkerScratchCleanup(id); } catch { /* retry unreadable evidence */ }
    const proof = this.store.readWorkerExecution(id);
    if (run?.delegation?.role === 'worker' && proof && proof.phase !== 'complete') return;
    const generation = proof?.generation, resourceId = proof?.scratchCleanup?.resourceId;
    const timer = setTimeout(() => {
      this.timers.delete(id);
      if (!this.enabled) return;
      const execution = this.store.readWorkerExecution(id);
      // No await between ownership/generation + holder proof and rm. Admission is synchronous
      // too, so a queued stale callback can never touch the next generation's scratch.
      try {
        if (generation && resourceId && execution?.generation === generation && !this.busy(id) &&
          this.store.workerScratchResourcesSafe(id, generation, resourceId)) removeAgentTmpDir(this.dataDir, id);
      } catch { /* Transient evidence/read failures retain the durable intent for another wake. */ }
      this.schedule(id, 60_000); // uncertainty has no age limit or force-delete exit
    }, delay);
    timer.unref?.(); this.timers.set(id, timer);
  }
}
