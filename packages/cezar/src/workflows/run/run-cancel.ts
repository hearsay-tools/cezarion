import type { WaitEngine } from './wait-engine.ts';
import { WAIT_KINDS } from './wait-kinds.ts';
import type { WorkerStopResult, WorkerWait } from '@open-mercato/cezar-contract/delegation';
import { workerWaitEntryToLegacy, isUsageLimitHold, type DeadlinedWorkerWaitEntry } from '@open-mercato/cezar-contract/waits';
import { DelegationPolicyError } from '../../delegation/policy.ts';
import type { RunRecord, RunStore } from '../../runs/store.ts';
import type { ActiveRun } from '../active-run.ts';
import type { RunExitId } from '../../runs/run-exits.ts';
import { clearIdleTimer } from './input-timers.ts';
import { WAITS_DISCARDED_NOTE, REFUSAL_DISCARDED_NOTE } from './constants.ts';
import type { RunModuleContext } from './types.ts';
import type { RunLine } from './run-line.ts';
import type { WorkerExecutions } from './worker-executions.ts';
import type { TurnNudges } from './turn-nudges.ts';

interface RunCancelHost {
  waitEngine: WaitEngine;
  active: Map<string, ActiveRun>;
  cancel(id: string): boolean;
  isActive(id: string): boolean;
  cancelAutoResume(id: string): boolean;
  rootFinishRequested(id: string): boolean;
  historyDeletionPending(id: string): boolean;
  move(id: string, exit: RunExitId, patch?: Omit<Parameters<RunStore['updateRun']>[1], 'status'>): RunRecord | undefined;
}

/** The cancellation event of a run Stop takes out of the line. */
const CANCELLED_WHILE_QUEUED = 'cancelled while queued';

export class RunCancel {
  constructor(private readonly context: RunModuleContext, private readonly line: RunLine,
    private readonly workerExecutions: WorkerExecutions, private readonly waitEngine: WaitEngine,
    private readonly turnNudges: TurnNudges, private readonly host: RunCancelHost) {}

  cancel(runId: string): boolean {
    // Another process's run (#779, plan step 3): only its owner can stop it.
    if (this.context.store.writeRefusal(runId)) return false;
    this.cancelWorkerExecution(runId);
    const hadWaits = !!this.context.store.getRun(runId)?.waits?.length;
    this.waitEngine.cancelAll(runId);
    const retiredRefusal = this.turnNudges.retireCompletionRefusal(runId);
    const cancelledFinish = !!this.context.store.move(runId, 'cancel-root');
    // Still waiting in the queue: just drop it there.
    const queuedAt = this.line.indexOf(runId);
    if (queuedAt >= 0) {
      this.cancelQueuedRun(runId, queuedAt);
      return true;
    }
    const state = this.host.active.get(runId);
    if (!state) return this.cancelRunWithoutSession(runId, hadWaits, retiredRefusal, cancelledFinish);
    this.cancelActiveRun(runId, state);
    return true;
  }

  private cancelActiveRun(runId: string, state: ActiveRun): void {
    state.liveSession.cancel();
    this.context.store.updateRun(runId, { stopping: true });
    this.context.store.flush();
    state.liveSession.revokeCiTools?.(); state.liveSession.clearCiRevoker();
    state.liveSession.revokeDelegation?.(); state.liveSession.clearDelegationRevoker();
    clearIdleTimer(state);
    state.liveSession.interrupt();
  }

  private cancelWorkerExecution(runId: string): void {
    if (this.context.store.getRun(runId)?.delegation?.role === 'worker') {
      const proof = this.context.store.readWorkerExecution(runId);
      // The first cancel write names the cancellation's one event, a queued worker's too (B12).
      this.context.store.move(runId, 'stop-worker', {}, this.line.indexOf(runId) >= 0 ? { event: CANCELLED_WHILE_QUEUED } : {});
      this.workerExecutions.markStopped(runId);
      if (!this.workerExecutions.has(runId) && !this.host.active.has(runId) && !this.line.hasStarting(runId) && proof?.phase === 'queued') {
        this.context.store.commitWorkerExecutionComplete(runId, proof.generation);
      }
    }
  }

  private cancelQueuedRun(runId: string, queuedAt: number): void {
    this.line.takeAt(queuedAt);
    this.line.takePending(runId);
    // The exit writes the cancellation's one lifecycle event; a queued run's says so (B12).
    this.context.store.move(runId, 'cancel', {}, { event: CANCELLED_WHILE_QUEUED });
    this.context.store.flush();
    if (this.workerExecutions.admitted(runId) === false) void this.workerExecutions.finishWorkerExecution(runId);
  }

  private cancelRunWithoutSession(runId: string, hadWaits: boolean, retiredRefusal: boolean, cancelledFinish: boolean): boolean {
    if (this.line.hasStarting(runId)) {
      this.context.store.updateRun(runId, { stopping: true });
      this.context.store.flush();
      return true;
    }
    if (cancelledFinish) return true;
    const run = this.context.store.getRun(runId);
    // Stop on a failed run that held wait results discards them, and the automatic resume that
    // would start a session on it later; the run stays failed. A usage-limit hold is that failed
    // run waiting for its resume (hearsay-tools/cezarion#1236), and settles failed the same way.
    // A failed or held root keeps its live workers (hearsay-tools/squawk#3337) until a human stops it.
    const liveWorkers = run?.delegation?.role === 'root'
      ? this.context.store.listWorkersOf(runId).filter(child => ['queued', 'running', 'waiting'].includes(child.status)) : [];
    if ((hadWaits || retiredRefusal || liveWorkers.length) && (run?.status === 'failed' || isUsageLimitHold(run ?? {}))) {
      if (hadWaits || retiredRefusal) this.context.store.appendEvent(runId, { type: 'note', message: hadWaits ? WAITS_DISCARDED_NOTE : REFUSAL_DISCARDED_NOTE });
      this.host.cancelAutoResume(runId);
      for (const child of liveWorkers) this.cancel(child.id);
      this.context.store.flush();
      return true;
    }
    if (run && (run.delegation || hadWaits) && ['queued', 'running', 'waiting'].includes(run.status)) {
      this.host.move(runId, 'cancel');
      return true;
    }
    return false;
  }

  requestWorkerStop(runId: string): WorkerStopResult {
    if (this.context.store.getRun(runId)?.delegation?.role !== 'worker') throw new Error('Worker not found');
    if (!this.workerExecutions.has(runId) && !this.host.isActive(runId) && ['done', 'failed', 'cancelled', 'review'].includes(this.context.store.getRun(runId)!.status) && this.context.store.readWorkerExecution(runId)?.phase === 'complete') return { workerId: runId, state: 'terminated' };
    this.host.cancel(runId);
    return { workerId: runId, state: !this.workerExecutions.has(runId) && this.context.store.readWorkerExecution(runId)?.phase === 'complete' ? 'terminated' : 'stopping' };
  }

  cancelWorkerWait(parentId: string, waitId: string): WorkerWait {
    const run = this.context.store.getRun(parentId);
    if (!run?.delegation || run.delegation.role === 'invalid') throw new DelegationPolicyError('denied_scope', 'Worker scope denied');
    const entry = WAIT_KINDS.worker.select(run.waits ?? []).find((wait): wait is DeadlinedWorkerWaitEntry => wait.id === waitId && WAIT_KINDS.worker.hasDeadline(wait));
    if (!entry) {
      const settled = WAIT_KINDS.worker.select(run.lastWaits ?? []).filter((wait): wait is DeadlinedWorkerWaitEntry => wait.id === waitId && WAIT_KINDS.worker.hasDeadline(wait)).at(-1);
      if (settled) return workerWaitEntryToLegacy(settled);
      throw new DelegationPolicyError('incompatible_state', 'Worker wait is no longer current');
    }
    if (entry.phase !== 'open') return workerWaitEntryToLegacy(entry);
    if (this.context.disposed() || !['queued', 'running', 'waiting'].includes(run.status) || this.host.rootFinishRequested(parentId) || this.host.historyDeletionPending(parentId)) {
      throw new DelegationPolicyError('incompatible_state', 'Parent cannot cancel a worker wait');
    }
    const settled = this.host.waitEngine.cancel(parentId, [waitId]);
    const cancelled = WAIT_KINDS.worker.select(settled).find((wait): wait is DeadlinedWorkerWaitEntry => wait.id === waitId && WAIT_KINDS.worker.hasDeadline(wait));
    if (!cancelled) throw new DelegationPolicyError('incompatible_state', 'Worker wait is no longer current');
    return workerWaitEntryToLegacy(cancelled);
  }
}
