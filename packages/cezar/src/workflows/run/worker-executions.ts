import type { AgentSession } from '../../core/claude-cli-runner.ts';
import { sessionGroupOf } from '../../core/session-process.ts';
import { transitionVia } from '../run-states.ts';
import type { RunModuleContext } from './types.ts';
import type { WorkerOrphans } from './worker-orphans.ts';

interface WorkerExecutionsHost {
  maintenance(id: string): boolean;
  admissionError(message: string): Error;
  settleOrphanedWorkerExecution(id: string, opts?: { admitting?: boolean; fresh?: boolean }): boolean;
  reapTerminalScratch(id: string): void;
  queueWaitWake(id: string): void;
  retryWaitAdmission(id: string): void;
  releaseSlot(): void;
}

export class WorkerExecutions {
  constructor(private readonly context: RunModuleContext, private readonly orphans: WorkerOrphans, private readonly host: WorkerExecutionsHost) {}
  readonly executions = new Map<string, { generation: string; admitted: boolean; promise: Promise<void>; resolve: () => void; sessions: Set<Promise<void>>; turns: Set<Promise<void>>; deliveries: Set<Promise<void>> }>();
  private readonly finalizedWorkers = new Map<string, string>();
  private readonly stoppedWorkers = new Set<string>();
  private readonly terminationWaiters = new Set<() => void>();

  beginWorkerExecution(runId: string, admitted = true): void {
    if (this.context.store.getRun(runId)?.delegation?.role !== 'worker') return;
    if (this.host.maintenance(runId)) throw new Error('Worker resources are being cleaned up');
    // #469: one site for Continue, --resume, parent replies and queued revival after a crash.
    // Fresh: admission is one-shot, so a cached "alive" must not refuse an orphan that has since died.
    if (!this.executions.has(runId)) this.host.settleOrphanedWorkerExecution(runId, { admitting: true, fresh: true });
    const refusal = this.executions.has(runId) ? undefined : this.orphans.orphanAdmissionRefusal(runId);
    if (refusal) throw this.host.admissionError(refusal);
    const existing = this.executions.get(runId);
    if (existing) {
      const proof = this.context.store.readWorkerExecution(runId);
      if (!existing.admitted && admitted && proof?.generation === existing.generation && proof.phase === 'starting') {
        existing.admitted = true; return;
      }
      throw new Error('Worker execution is still finalizing');
    }
    const generation = this.context.store.commitWorkerExecutionStart(runId);
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    this.executions.set(runId, { generation, admitted, promise, resolve, sessions: new Set(), turns: new Set(), deliveries: new Set() });
    this.finalizedWorkers.delete(runId);
    // #469: an earlier generation's destroy blocker never describes this one.
    this.orphans.forgetBlockers(runId);
    this.stoppedWorkers.delete(runId);
  }

  async finishWorkerExecution(runId: string): Promise<void> {
    return this.context.work.track('finishWorkerExecution', this.finishWorkerExecutionWork(runId));
  }

  private async finishWorkerExecutionWork(runId: string): Promise<void> {
    const execution = this.executions.get(runId);
    if (!execution) return;
    await Promise.allSettled([...execution.sessions]);
    await Promise.allSettled([...execution.turns]);
    await Promise.allSettled([...execution.deliveries]);
    // Every wrapper settles after runner result, workflow and final filesystem work.
    // A disposed manager cannot attest to the recovered generation's state.
    if (!this.context.disposed()) {
      this.finalizedWorkers.set(runId, execution.generation);
      this.persistWorkerCompletion(runId, execution.generation);
    }
    if (this.executions.get(runId) === execution) this.executions.delete(runId);
    execution.resolve();
    if (!this.context.disposed()) {
      try { this.host.queueWaitWake(runId); } catch { this.host.retryWaitAdmission(runId); }
    }
    if (!this.context.disposed() && this.context.store.getRun(runId)?.stopping) this.context.store.updateRun(runId, { stopping: undefined });
    if (!this.context.disposed()) this.host.releaseSlot();
  }

  /** Capture every returned process result before setup can throw. A setup
   * exception or an interrupt request cannot stand in for session termination. */
  trackWorkerSessionResult(runId: string, session: AgentSession): Promise<void> {
    const closed = session.result.then(() => undefined, () => undefined);
    this.executions.get(runId)?.sessions.add(closed);
    return this.context.work.trackSession(session, closed);
  }

  private persistWorkerCompletion(runId: string, generation: string): void {
    try {
      if (this.stoppedWorkers.has(runId)) transitionVia('stop-worker', () => this.context.store.getRun(runId), () => this.context.store.commitWorkerCancellation(runId));
      if (this.context.store.commitWorkerExecutionComplete(runId, generation)) {
        this.finalizedWorkers.delete(runId);
        this.host.reapTerminalScratch(runId);
      }
    } catch { /* Finalized in this process; preserve exact generation for an explicit retry. */ }
  }

  /** Best effort: a failed write leaves the working-directory scan as this process's evidence. */
  recordWorkerProcess(runId: string, pid: number): void {
    const generation = this.executions.get(runId)?.generation;
    if (!generation) return;
    try { if (!this.context.store.appendWorkerProcess(runId, generation, pid, sessionGroupOf(pid))) console.warn(`[cez] worker ${runId} process record unavailable; relying on the working-directory scan`); }
    catch { console.warn(`[cez] worker ${runId} process record write failed; relying on the working-directory scan`); }
  }

  async proveRunTermination(runId: string, timeoutMs: number, opts: { reapOrphans?: boolean }): Promise<boolean> {
    const execution = this.executions.get(runId);
    if (!execution) {
      const generation = this.finalizedWorkers.get(runId);
      if (!this.context.disposed() && generation) this.persistWorkerCompletion(runId, generation);
      else if (!generation && opts.reapOrphans) await this.orphans.reapOrphanedWorker(runId, timeoutMs);
      else if (!generation) this.host.settleOrphanedWorkerExecution(runId);
      return this.context.store.readWorkerExecution(runId)?.phase === 'complete';
    }
    if (this.context.disposed()) return false;
    await new Promise<void>(resolve => {
      const settle = () => { clearTimeout(timer); this.terminationWaiters.delete(settle); resolve(); };
      const timer = setTimeout(settle, Math.min(30_000, Math.max(0, Number.isFinite(timeoutMs) ? timeoutMs : 0)));
      this.terminationWaiters.add(settle);
      void execution.promise.then(settle);
    });
    return !this.executions.has(runId) && this.context.store.readWorkerExecution(runId)?.phase === 'complete';
  }

  has(id: string) { return this.executions.has(id); }
  admitted(id: string) { return this.executions.get(id)?.admitted; }
  generation(id: string) { return this.executions.get(id)?.generation; }
  markStopped(id: string) { this.stoppedWorkers.add(id); }
  isStopped(id: string) { return this.stoppedWorkers.has(id); }
  trackTurn(id: string, task: Promise<void>) {
    const turns = this.executions.get(id)?.turns;
    turns?.add(task);
    void task.catch(() => undefined).finally(() => turns?.delete(task));
  }
  trackDelivery(id: string, task: Promise<void>) {
    const deliveries = this.executions.get(id)?.deliveries;
    deliveries?.add(task);
    void task.then(() => deliveries?.delete(task));
  }
  dispose() { this.finalizedWorkers.clear(); for (const settle of this.terminationWaiters) settle(); }
}
