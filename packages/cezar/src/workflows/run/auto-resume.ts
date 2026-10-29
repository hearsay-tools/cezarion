import { isUsageLimitHold } from '@open-mercato/cezar-contract/waits';
import { parseUsageLimit } from '../../core/usage-limit.ts';
import type { RunRecord, RunStore } from '../../runs/store.ts';
import type { ContinueRunOptions } from '../continuation-admission.ts';
import { formatWakeInstant } from '../run-scheduling.ts';
import { transitionVia, type RunExitId } from '../run-states.ts';
import type { RunModuleContext } from './types.ts';

interface AutoResumeHost {
  move(runId: string, exit: RunExitId, patch: Omit<Parameters<RunStore['updateRun']>[1], 'status'>): RunRecord | undefined;
  continueRun(runId: string, opts: ContinueRunOptions, deferForCapacity: boolean): { ok: boolean; error?: string };
  pump(): Promise<void>;
}

/**
 * Auto-resume after a provider usage limit (spec 2026-08-03-auto-resume-after-usage-limit).
 *
 * The wait is the provider's own reset instant plus this grace: resuming AT the boundary races the
 * provider's clock (and its rounding), and one failed resume costs the whole window over again.
 * Thirty seconds is cheap next to five hours and long enough to be past any sane skew.
 */
export const AUTO_RESUME_GRACE_MS = 30_000;

/**
 * Consecutive automatic resumes allowed without a human turn. A resume can only fire after a real
 * reset instant, so this is not a throttle — it is the backstop for the pathological case (a
 * provider that answers "limit reached, retry now" in a loop), and it is deliberately generous
 * enough to sit through a couple of days of five-hour windows.
 */
export const MAX_AUTO_RESUMES = 12;

/**
 * How long a missed deadline stays worth acting on. The promise is "we pick this up when the
 * window reopens" — kept across a restart or an overnight close, which is the case the feature
 * exists for. A day later it is no longer that promise: the user has moved on, and a task
 * springing back to life is a surprise rather than a service. Such a deadline is retired with a
 * note instead of fired, so the only tasks a sweep can revive are ones someone is still waiting on.
 */
export const AUTO_RESUME_MISSED_WINDOW_MS = 24 * 60 * 60_000;

const AUTO_RESUME_PROMPT =
  'The provider usage limit that interrupted this task has reset. Read the handoff file (CEZ_HANDOFF_FILE) to recover context, then continue the task from where you left off.';

export class AutoResumeScheduler {
  /** Armed usage-limit resumes, keyed by run id (spec
   *  2026-08-03-auto-resume-after-usage-limit). The DEADLINE itself lives on the record
   *  (`autoResumeAt`) — this map holds only the process-local timer, so a restart rebuilds it
   *  from the record rather than losing the wait. Runs here are `failed` and therefore NOT in
   *  `active`, which is why the timer cannot live on an `ActiveRun` like the monitoring one. */
  readonly autoResumeTimers = new Map<string, NodeJS.Timeout>();

  constructor(private readonly context: RunModuleContext, private readonly host: AutoResumeHost) {}

  dispose(): void {
    for (const timer of this.autoResumeTimers.values()) clearTimeout(timer);
    this.autoResumeTimers.clear();
  }

  /**
   * A run just failed: if the provider said "usage limit, back at T", promise to resume it at
   * `T + AUTO_RESUME_GRACE_MS` instead of leaving the task dead until someone notices.
   *
   * Every refusal below is silent-but-honest — the run stays `failed` with its Continue button,
   * which is exactly the pre-feature behavior — except the safety cap, which says so on the
   * transcript, because a run that stops resuming itself needs to explain why.
   */
  scheduleAutoResumeIfLimited(runId: string): void {
    if (this.autoResumeTimers.has(runId)) return; // already promised
    const run = this.context.store.getRun(runId);
    if (!run || run.status !== 'failed') return;
    // Archiving IS resigning from a task. Reviving one because a window happened to reopen would
    // be the feature working against the clearest signal the user can give it.
    if (run.archived) return;
    const limit = parseUsageLimit(run.error);
    if (!limit) return;
    if (!this.context.semaphore.autoResumeOnUsageLimit()) return;
    // No session to resume = nothing this feature can do; `continueRun` would refuse anyway.
    if (!run.steps.some((step) => step.sessionId)) return;
    const attempts = run.autoResumeAttempts ?? 0;
    if (attempts >= MAX_AUTO_RESUMES) {
      this.context.store.appendEvent(runId, {
        type: 'note',
        message: `automatic resume cap reached (${MAX_AUTO_RESUMES}) — continue this task manually`,
      });
      return;
    }
    const wakeAt = new Date(limit.resetAt.getTime() + AUTO_RESUME_GRACE_MS);
    this.armAutoResume(runId, wakeAt.getTime());
    this.context.store.appendEvent(runId, {
      type: 'lifecycle',
      message: `usage limit reached — resuming automatically at ${formatWakeInstant(wakeAt)}`,
    });
  }

  /** Publish the deadline on the record (the cockpit's only source) and arm the timer for it. The
   *  run waits for it (hearsay-tools/cezarion#1236): `waiting`, its error kept for a withdrawal. */
  private armAutoResume(runId: string, deadline: number): void {
    this.host.move(runId, 'hold', { finishedAt: undefined, autoResumeAt: new Date(deadline).toISOString() });
    const timer = setTimeout(() => this.fireAutoResume(runId), Math.max(0, deadline - Date.now()));
    timer.unref?.();
    this.autoResumeTimers.set(runId, timer);
  }

  /**
   * The window has reopened. Re-check the record synchronously — hours may have passed, and the
   * user may have continued, deleted or cancelled the run in them — then hand the resume to the
   * ordinary queued-continuation path so it obeys both concurrency caps like any other work.
   */
  private fireAutoResume(runId: string): void {
    this.autoResumeTimers.delete(runId);
    const run = this.context.store.getRun(runId);
    if (!run || !isUsageLimitHold(run)) return;
    // Belt and braces against the one gap `reconcileAutoResumes` cannot close: the setting going
    // off in the window between the last pump and this tick.
    if (!this.context.semaphore.autoResumeOnUsageLimit()) {
      this.withdrawAutoResume(runId, 'automatic resume cancelled — auto-resume is switched off');
      return;
    }
    const attempts = (run.autoResumeAttempts ?? 0) + 1;
    // `continueRun` retires the pending resume (timer + record fields) on the way in — this is a
    // resume, not a user turn, so the counter is put back straight after.
    const resumed = this.host.continueRun(runId, { text: AUTO_RESUME_PROMPT }, true);
    if (!resumed.ok) {
      // Refusals happen before `continueRun` retires anything, so the deadline is still on the
      // record — and a deadline in the past is a promise the cockpit keeps displaying and the
      // engine will never keep. Retire it here instead, and say why.
      this.withdrawAutoResume(runId, `automatic resume could not start — ${resumed.error ?? 'unknown'}`);
      return;
    }
    this.context.store.updateRun(runId, { autoResumeAttempts: attempts });
    this.context.store.appendEvent(runId, {
      type: 'lifecycle',
      message: `usage limit reset — resuming automatically (${attempts}/${MAX_AUTO_RESUMES})`,
    });
    // A deferred continuation only ENQUEUES itself; the queue moves when something pumps it, and
    // `recover()` — the other deferring caller — pumps once after its whole bulk sweep. A timer
    // firing on its own has no such follow-up, so without this the resumed run sits at `queued`
    // until some unrelated run happens to finish. This is the pump for it.
    void this.host.pump();
  }

  /**
   * Reconcile process-local resume timers from durable records on pump and recovery. Retire
   * appointments when disabled or invalid; do not leave a deadline with no wake source.
   */
  reconcileAutoResumes(): void {
    if (!this.context.semaphore.autoResumeOnUsageLimit()) {
      // Sweep the RECORDS, not the timer map. A record promising a resume that no timer is
      // holding is the exact population this method exists for, and it is also the one the
      // setting can be switched off in front of: cezar restarted while it was off, the config
      // was hand-edited, or the project context was disposed mid-wait. Retiring only the armed
      // timers leaves such a record with a live `autoResumeAt`, which `accountHolds()` reads as
      // a deadline hold — so nothing new starts on that account, `rescueStalledQueue` treats the
      // phantom appointment as a legitimate reason to sit still, and the cockpit shows a
      // `scheduled` row for a resume that will never come. `clearAutoResume` covers the armed
      // ones too, so this one loop is the whole cancellation. It reads any resume time, not
      // `isUsageLimitHold`, so a stale one is retired too.
      const pending = new Set([
        ...this.autoResumeTimers.keys(),
        ...this.context.store.listRuns().filter((run) => run.autoResumeAt !== undefined).map((run) => run.id),
      ]);
      for (const runId of pending) this.withdrawAutoResume(runId, 'automatic resume cancelled — auto-resume is switched off');
      return;
    }
    for (const run of this.context.store.listRuns()) {
      if (!isUsageLimitHold(run)) continue;
      if (this.autoResumeTimers.has(run.id)) continue;
      const deadline = Date.parse(run.autoResumeAt);
      // A deadline that is unreadable, belongs to a run that has spent its cap, or belongs to a
      // task the user has archived is retired rather than re-armed: it can only mislead. One
      // that has just passed arms at zero — the window is open, which is the point.
      if (
        run.archived
        || !Number.isFinite(deadline)
        || (run.autoResumeAttempts ?? 0) >= MAX_AUTO_RESUMES
      ) {
        this.withdrawAutoResume(run.id);
        continue;
      }
      // …and one missed by more than a day is retired loudly: reviving a task from another era
      // is a surprise, not a service, and this is what keeps a sweep from resurrecting every
      // limit-stopped task a user has long since walked away from.
      if (Date.now() - deadline > AUTO_RESUME_MISSED_WINDOW_MS) {
        this.withdrawAutoResume(run.id, 'automatic resume expired — its window reopened over a day ago; continue this task manually');
        continue;
      }
      this.armAutoResume(run.id, deadline);
    }
  }

  /**
   * The PER-TASK off switch (`DELETE /api/v1/runs/:id/auto-resume`, and the archive route):
   * stop resuming THIS task, without touching the workspace setting or any other task.
   *
   * Idempotent — a run with nothing pending answers the same way, because "this task will not
   * resume itself" is equally true either way. Returns false only when the run does not exist,
   * which is the route's 404.
   */
  cancelAutoResume(runId: string): boolean {
    const run = this.context.store.getRun(runId);
    if (!run) return false;
    // Any resume time, not `isUsageLimitHold`: a withdrawal also retires one a record kept by mistake.
    const pending = run.autoResumeAt !== undefined || this.autoResumeTimers.has(runId);
    this.withdrawAutoResume(runId, pending ? 'automatic resume cancelled for this task' : undefined);
    if (pending) {
      // This run may have been the last thing holding its account's queue — nothing else will
      // notice, since the hold is derived and its release is not an event.
      void this.host.pump();
    }
    return true;
  }

  /** Retire a pending resume — timer, deadline and counter. The counter goes too because every
   *  caller is a fresh epoch: a human Continue, or a resume that re-stamps its own count. */
  clearAutoResume(runId: string): void {
    const timer = this.autoResumeTimers.get(runId);
    if (timer) clearTimeout(timer);
    this.autoResumeTimers.delete(runId);
    const run = this.context.store.getRun(runId);
    if (!run) return;
    // A continuation's own status write retires the appointment of a run on hold
    // (hearsay-tools/cezarion#1236): clearing it first would show a waiting run with no
    // appointment, which reads as Needs you, for the moment between the two writes.
    if (isUsageLimitHold(run)) {
      if (run.autoResumeAttempts !== undefined) this.context.store.updateRun(runId, { autoResumeAttempts: undefined });
      return;
    }
    // Any resume time, not `isUsageLimitHold`: it retires a stale one too.
    if (run.autoResumeAt !== undefined || run.autoResumeAttempts !== undefined) {
      this.context.store.updateRun(runId, { autoResumeAt: undefined, autoResumeAttempts: undefined });
    }
  }

  /**
   * Withdraw a pending resume without continuing the run: a per-task cancel, the setting switched
   * off, a missed window, the cap, or a resume that could not start. A run on hold settles
   * `failed` with the error it kept, the state it was in before it waited (owner,
   * 2026-10-21). Its waits stay as a failed run's do: open ones armed, resolved ones owed to the
   * next Continue.
   */
  private withdrawAutoResume(runId: string, note?: string): void {
    // Committed first: a store that cannot write throws here with the timer still armed, and the
    // note is written only once the withdrawal is on disk (hearsay-tools/cezarion#1236).
    if (this.context.store.getRun(runId)) transitionVia('withdraw-hold', () => this.context.store.getRun(runId), () => this.context.store.commitAutoResumeWithdrawal(runId));
    const timer = this.autoResumeTimers.get(runId);
    if (timer) clearTimeout(timer);
    this.autoResumeTimers.delete(runId);
    if (note && this.context.store.getRun(runId)) this.context.store.appendEvent(runId, { type: 'note', message: note });
  }
}
