import type { WorkerStopResult, WorkerWait } from '@open-mercato/cezar-contract/delegation';
import { hasWorkerDeadline, workerWaitEntryToLegacy, isUsageLimitHold, type DeadlinedWorkerWaitEntry } from '@open-mercato/cezar-contract/waits';
import { DelegationPolicyError } from '../../delegation/policy.ts';
import type { RunRecord, RunStore } from '../../runs/store.ts';
import type { ActiveRun } from '../active-run.ts';
import { transitionVia, type RunExitId } from '../run-states.ts';
import { clearIdleTimer } from './input-timers.ts';
import { WAITS_DISCARDED_NOTE, REFUSAL_DISCARDED_NOTE } from './constants.ts';
import type { RunModuleContext } from './types.ts';
import type { RunLine } from './run-line.ts';
import type { WorkerExecutions } from './worker-executions.ts';
import type { WakeAdmission } from './wake-admission.ts';
import type { TurnNudges } from './turn-nudges.ts';

interface RunCancelHost {
  active: Map<string, ActiveRun>;
  cancel(id: string): boolean;
  isActive(id: string): boolean;
  cancelAutoResume(id: string): boolean;
  rootFinishRequested(id: string): boolean;
  historyDeletionPending(id: string): boolean;
  disarmWait(id: string): void;
  move(id: string, exit: RunExitId, patch?: Omit<Parameters<RunStore['updateRun']>[1], 'status'>): RunRecord | undefined;
}

export class RunCancel {
  constructor(private readonly context: RunModuleContext, private readonly line: RunLine,
    private readonly workerExecutions: WorkerExecutions, private readonly wakeAdmission: WakeAdmission,
    private readonly turnNudges: TurnNudges, private readonly host: RunCancelHost) {}

  cancel(runId: string): boolean {
    // Another process's run (#779, plan step 3): only its owner can stop it.
    if (this.context.store.writeRefusal(runId)) return false;
    this.cancelWorkerExecution(runId);
    const hadWaits = !!this.context.store.getRun(runId)?.waits?.length;
    this.wakeAdmission.cancelOpenWaits(runId);
    const retiredRefusal = this.turnNudges.retireCompletionRefusal(runId);
    const cancelledFinish = transitionVia('cancel', () => this.context.store.getRun(runId), () => this.context.store.commitRootFinishCancellation(runId));
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
    state.cancelled = true;
    this.context.store.updateRun(runId, { stopping: true });
    this.context.store.flush();
    state.revokeCiTools?.(); state.revokeCiTools = undefined;
    state.revokeDelegation?.(); state.revokeDelegation = undefined;
    clearIdleTimer(state);
    state.interrupt();
  }

  private cancelWorkerExecution(runId: string): void {
    if (this.context.store.getRun(runId)?.delegation?.role === 'worker') {
      const proof = this.context.store.readWorkerExecution(runId);
      transitionVia('stop-worker', () => this.context.store.getRun(runId), () => this.context.store.commitWorkerCancellation(runId));
      this.workerExecutions.markStopped(runId);
      if (!this.workerExecutions.has(runId) && !this.host.active.has(runId) && !this.line.hasStarting(runId) && proof?.phase === 'queued') {
        this.context.store.commitWorkerExecutionComplete(runId, proof.generation);
      }
    }
  }

  private cancelQueuedRun(runId: string, queuedAt: number): void {
    this.line.takeAt(queuedAt);
    this.line.takePending(runId);
    this.host.move(runId, 'cancel', { finishedAt: new Date().toISOString() });
    this.context.store.appendEvent(runId, { type: 'lifecycle', message: 'cancelled while queued' });
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
    if ((hadWaits || retiredRefusal) && (run?.status === 'failed' || isUsageLimitHold(run ?? {}))) {
      this.context.store.appendEvent(runId, { type: 'note', message: hadWaits ? WAITS_DISCARDED_NOTE : REFUSAL_DISCARDED_NOTE });
      this.host.cancelAutoResume(runId);
      this.context.store.flush();
      return true;
    }
    if (run && (run.delegation || hadWaits) && ['queued', 'running', 'waiting'].includes(run.status)) {
      this.host.move(runId, 'cancel', { finishedAt: new Date().toISOString() });
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
    const entry = run.waits?.find((wait): wait is DeadlinedWorkerWaitEntry => wait.id === waitId && wait.kind === 'worker' && hasWorkerDeadline(wait));
    if (!entry) {
      const settled = run.lastWaits?.filter((wait): wait is DeadlinedWorkerWaitEntry => wait.id === waitId && wait.kind === 'worker' && hasWorkerDeadline(wait)).at(-1);
      if (settled) return workerWaitEntryToLegacy(settled);
      throw new DelegationPolicyError('incompatible_state', 'Worker wait is no longer current');
    }
    if (entry.phase !== 'open') return workerWaitEntryToLegacy(entry);
    if (this.context.disposed() || !['queued', 'running', 'waiting'].includes(run.status) || this.host.rootFinishRequested(parentId) || this.host.historyDeletionPending(parentId)) {
      throw new DelegationPolicyError('incompatible_state', 'Parent cannot cancel a worker wait');
    }
    this.context.store.commitOutcome(parentId, { kind: 'cancelled', waitIds: [waitId] });
    this.host.disarmWait(waitId);
    const cancelled = this.context.store.getRun(parentId)?.lastWaits?.filter((wait): wait is DeadlinedWorkerWaitEntry => wait.id === waitId && wait.kind === 'worker' && hasWorkerDeadline(wait)).at(-1);
    return workerWaitEntryToLegacy(cancelled ?? { ...entry, phase: 'cancelled', cancelledAt: new Date().toISOString() });
  }
}
