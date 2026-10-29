import type { WorkflowDef } from '../types.ts';
import type { PendingContinuation, StartRunInput } from './types.ts';

type PendingJob = { workflow: WorkflowDef; input: StartRunInput; startAt?: number | undefined };

/** Owns the scheduler's line and its in-memory admission state. */
export class RunLine {
  readonly queue: string[] = [];
  readonly pendingJobs = new Map<string, PendingJob>();
  readonly pendingContinuations = new Map<string, PendingContinuation>();
  readonly starting = new Set<string>();
  readonly waiting = new Set<string>();
  readonly monitoring = new Set<string>();
  readonly waitWakeQueuedAt = new Map<string, number>();
  readonly waitWakeAdmitted = new Set<string>();
  /** The watchdog ignores the usage hold for one pump sweep. */
  private forceNextPump = false;
  /** Forced starts keep bypassing the spawn-time gate until dropActive. */
  private readonly forceStarted = new Set<string>();

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
