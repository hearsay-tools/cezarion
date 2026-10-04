import { agentTmpDirMayExist, removeAgentTmpDir } from '../runs/agent-tmpdir.ts';
import type { RunStore } from '../runs/store.ts';

/** The durable cleanup intent is the terminal run + completed execution generation + owned
 * resource, retained until explicit history deletion. Reconstruct it on recovery/reattach.
 * No new journal can be lost between completing the execution and queuing its cleanup. */
export class WorkerScratchCleanup {
  private timers = new Map<string, NodeJS.Timeout>();
  private enabled = true;
  constructor(private store: RunStore, private dataDir: string, private busy: (id: string) => boolean) {}

  pause(): void {
    this.enabled = false;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }
  recover(): void {
    this.enabled = true;
    for (const run of this.store.listRuns()) this.schedule(run.id);
  }
  schedule(id: string, delay = 0): void {
    const run = this.store.getRun(id);
    if (!this.enabled || this.timers.has(id) || run?.delegation?.role !== 'worker') return;
    const proof = this.store.readWorkerExecution(id);
    if ((proof && proof.phase !== 'complete') ||
      ['queued', 'running', 'waiting'].includes(run.status) || !agentTmpDirMayExist(this.dataDir, id)) return;
    const generation = proof?.generation, resourceId = run.delegation.workspace.resourceId;
    const timer = setTimeout(() => {
      this.timers.delete(id);
      if (!this.enabled) return;
      const current = this.store.getRun(id), execution = this.store.readWorkerExecution(id);
      if (current?.delegation?.role !== 'worker' || current.delegation.workspace.resourceId !== resourceId ||
        !execution || execution.generation !== generation || execution.phase !== 'complete' || ['queued', 'running', 'waiting'].includes(current.status)) {
        this.schedule(id, 60_000); return;
      }
      // No await between ownership/generation + holder proof and rm. Admission is synchronous
      // too, so a queued stale callback can never touch the next generation's scratch.
      try {
        if (!this.busy(id) && this.store.workerResourcesSafe(id, execution.generation, resourceId)) removeAgentTmpDir(this.dataDir, id);
      } catch { /* Transient evidence/read failures retain the durable intent for another wake. */ }
      this.schedule(id, 60_000); // uncertainty has no age limit or force-delete exit
    }, delay);
    timer.unref?.(); this.timers.set(id, timer);
  }
}
