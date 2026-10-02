import { nextOccurrence, occurrencesBetween } from '@open-mercato/cezar-contract';
import type { AutomationLease, AutomationStore } from './store.ts';
import type { AutomationReceipt, ScheduleAutomationDefinition } from './types.ts';

/**
 * The schedule kind's evaluator (spec 2026-10-02-scheduled-automations § Lifecycle): what fires
 * when a scheduled automation's occurrence comes due, by the timer or by hand.
 *
 * The one rule that matters is the AGE rule in `fire`: how late the occurrence is decides what
 * happens — on time (within the grace window) it is `launched`; late but within a day, the
 * LATEST missed occurrence fires once as `catch-up`; older, nothing fires and the log says how
 * many were skipped. The same rule applies whether the timer fired on time, the laptop slept, or
 * cezar just booted, and `nextRunAt` always advances from `max(occurrence, now)` — which is what
 * makes a burst impossible: a daily that slept three days fires one catch-up, not three.
 *
 * Everything runs under the #651 project lease. A held (or lost) lease is the one case that
 * must NOT advance `nextRunAt`: the state file is shared, so the loser moving it on would make
 * the winner — firing from the same on-disk state — skip the occurrence entirely. The loser logs
 * `skipped` and throws `ScheduleLeaseHeldError`, so the workspace floor retries it; by then the
 * winner's receipt turns the retry into a `duplicate`, never a second launch. Held leases and
 * duplicates are not failures and do not count towards the three-strike auto-pause.
 */

export const SCHEDULE_GRACE_MS = 10 * 60_000;
export const SCHEDULE_CATCH_UP_MS = 24 * 60 * 60_000;
export const SCHEDULE_AUTO_PAUSE_AFTER = 3;

export type ScheduleTrigger = 'schedule' | 'catch-up' | 'manual';

export interface ScheduleOccurrence {
  /** The scheduled wall-time instant (UTC ISO); for `manual`, the launch time. */
  at: string;
  trigger: ScheduleTrigger;
}

export type ScheduleLauncher = (
  definition: ScheduleAutomationDefinition,
  occurrence: ScheduleOccurrence,
  receiptId: string,
) => Promise<{ runId: string }>;

export interface ScheduleRunnerHandle {
  projectId: string;
  store: AutomationStore;
  /** The zone every schedule is evaluated in — the server's own. */
  timeZone: string;
  /** Absent = detection only (tests, or a cockpit that cannot launch): nothing is launched. */
  launch?: ScheduleLauncher;
  onChange?: (automationId: string, revision: number) => void;
  now?: () => number;
}

export type ScheduleFireOutcome =
  | { result: 'launched' | 'catch-up' | 'manual'; runId: string; occurrenceAt: string }
  | { result: 'skipped' | 'duplicate' | 'lease-held' | 'failed' | 'detection-only'; occurrenceAt?: string };

export const SCHEDULE_LEASE_HELD_REASON = 'automation lease is held by another process; retrying shortly';

/** `fire` met a held or non-current lease; the workspace timer re-arms it at the retry floor. */
export class ScheduleLeaseHeldError extends Error {
  constructor() { super(SCHEDULE_LEASE_HELD_REASON); }
}

export class ScheduleRunner {
  constructor(private readonly handle: ScheduleRunnerHandle) {}

  private now(): number {
    return this.handle.now?.() ?? Date.now();
  }

  /**
   * When the timer should next fire this definition: the stored `nextRunAt`, or — for a
   * definition never armed, or whose schedule was edited (the PUT clears `nextRunAt`) — the next
   * occurrence after now, which is then persisted so every process agrees on it.
   */
  dueAt(definition: ScheduleAutomationDefinition): number | null {
    const state = this.handle.store.state(definition.id) ?? {};
    if (state.nextRunAt) return Date.parse(state.nextRunAt);
    const next = nextOccurrence(definition.schedule, this.now(), this.handle.timeZone);
    if (next === null) return null;
    this.handle.store.setState(definition.id, (current) => ({ ...current, revision: definition.revision, nextRunAt: new Date(next).toISOString() }));
    return next;
  }

  /** The timer fired (or boot found a past-due occurrence): apply the age rule and launch. */
  async fire(definition: ScheduleAutomationDefinition): Promise<ScheduleFireOutcome> {
    const outcome = await this.underLease(async () => {
      const now = this.now();
      const due = this.dueAt(definition);
      if (due === null) return { result: 'skipped' } as const;
      // Not due yet: another cockpit (or a PUT) moved `nextRunAt` after this fire was armed.
      if (due > now) return { result: 'skipped', occurrenceAt: new Date(due).toISOString() } as const;
      if (now - due <= SCHEDULE_GRACE_MS) {
        return this.launch(definition, { at: new Date(due).toISOString(), trigger: 'schedule' }, now, true);
      }
      // Late. Every occurrence from the due one up to now was missed; the newest may catch up.
      const missed = occurrencesBetween(definition.schedule, due, now + 1, this.handle.timeZone);
      const latest = missed.at(-1) ?? due;
      if (now - latest <= SCHEDULE_CATCH_UP_MS) {
        if (missed.length > 1) await this.logSkipped(definition, missed.length - 1, true);
        return this.launch(definition, { at: new Date(latest).toISOString(), trigger: 'catch-up' }, now, true);
      }
      await this.logSkipped(definition, missed.length, false);
      this.advance(definition, now, now);
      return { result: 'skipped', occurrenceAt: new Date(latest).toISOString() } as const;
    });
    if (outcome) return outcome;
    await this.handle.store.appendLog({ automationId: definition.id, revision: definition.revision, result: 'skipped', reason: SCHEDULE_LEASE_HELD_REASON });
    this.handle.onChange?.(definition.id, definition.revision);
    throw new ScheduleLeaseHeldError();
  }

  /** `POST /automations/:id/run`: fire now, by hand, paused or not; `nextRunAt` is untouched. */
  async runNow(definition: ScheduleAutomationDefinition): Promise<ScheduleFireOutcome> {
    const outcome = await this.underLease(() => {
      const now = this.now();
      return this.launch(definition, { at: new Date(now).toISOString(), trigger: 'manual' }, now, false);
    });
    return outcome ?? { result: 'lease-held' };
  }

  /** Retry a `launch-error` receipt of this kind: the same receipt, fired again by hand. */
  async retry(definition: ScheduleAutomationDefinition, receipt: AutomationReceipt): Promise<ScheduleFireOutcome> {
    const occurrenceAt = receipt.occurrenceAt ?? new Date(this.now()).toISOString();
    const outcome = await this.underLease(async () => {
      const now = this.now();
      // Re-checked under the lease: another retry may have relaunched it since the caller read it.
      if (this.handle.store.latestReceipts().get(receipt.receiptKey)?.status !== 'launch-error') {
        return { result: 'duplicate', occurrenceAt } as const;
      }
      const reserved: AutomationReceipt = { ...receipt, status: 'reserved', error: undefined, updatedAt: new Date(now).toISOString() };
      this.handle.store.appendReceipt(reserved);
      return this.launchReserved(definition, { at: occurrenceAt, trigger: 'manual' }, reserved, now, false);
    });
    return outcome ?? { result: 'lease-held', occurrenceAt };
  }

  /** Runs `operation` under the project lease; `undefined` when the lease is held or not current. */
  private async underLease(operation: () => Promise<ScheduleFireOutcome>): Promise<ScheduleFireOutcome | undefined> {
    const { store } = this.handle;
    let lease: AutomationLease | undefined = store.acquireLease();
    if (lease && !lease.isCurrent()) {
      lease.release();
      lease = undefined;
    }
    if (!lease) return undefined;
    try {
      return await operation();
    } finally {
      try { await store.maybeCompact(); } catch { /* append-only state remains readable; next fire retries */ }
      lease.release();
    }
  }

  private async launch(
    definition: ScheduleAutomationDefinition,
    occurrence: ScheduleOccurrence,
    now: number,
    advance: boolean,
  ): Promise<ScheduleFireOutcome> {
    const { store } = this.handle;
    const eventId = occurrence.trigger === 'manual' ? `manual:${occurrence.at}` : `schedule:${occurrence.at}`;
    const receipt = store.reserveReceipt({ automationId: definition.id, revision: definition.revision, eventId, occurrenceAt: occurrence.at });
    if (!receipt) {
      await store.appendLog({ automationId: definition.id, revision: definition.revision, result: 'duplicate', reason: `A durable receipt already exists for the ${occurrence.at} occurrence.` });
      if (advance) this.advance(definition, Date.parse(occurrence.at), now);
      return { result: 'duplicate', occurrenceAt: occurrence.at };
    }
    return this.launchReserved(definition, occurrence, receipt, now, advance);
  }

  private async launchReserved(
    definition: ScheduleAutomationDefinition,
    occurrence: ScheduleOccurrence,
    receipt: AutomationReceipt,
    now: number,
    advance: boolean,
  ): Promise<ScheduleFireOutcome> {
    const { store } = this.handle;
    if (!this.handle.launch) {
      store.appendReceipt({ ...receipt, status: 'launch-error', error: 'This cockpit cannot launch tasks.', updatedAt: new Date(now).toISOString() });
      if (advance) this.advance(definition, Date.parse(occurrence.at), now);
      return { result: 'detection-only', occurrenceAt: occurrence.at };
    }
    const started = Date.now();
    const result: 'launched' | 'catch-up' | 'manual' = occurrence.trigger === 'schedule' ? 'launched' : occurrence.trigger;
    let runId: string;
    try {
      ({ runId } = await this.handle.launch(definition, occurrence, receipt.receiptId));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      store.appendReceipt({ ...receipt, status: 'launch-error', error: message, updatedAt: new Date(this.now()).toISOString() });
      await store.appendLog({ automationId: definition.id, revision: definition.revision, result: 'failed', reason: message, receiptId: receipt.receiptId, durationMs: Date.now() - started });
      // Only the timer counts towards the auto-pause: Run now and Retry leave `enabled` alone.
      if (advance) await this.recordFailure(definition, occurrence, now);
      else this.handle.onChange?.(definition.id, definition.revision);
      return { result: 'failed', occurrenceAt: occurrence.at };
    }
    store.appendReceipt({ ...receipt, status: 'launched', runId, updatedAt: new Date(this.now()).toISOString() });
    await store.appendLog({
      automationId: definition.id, revision: definition.revision, result,
      reason: reasonFor(occurrence, this.handle.timeZone),
      receiptId: receipt.receiptId, runId, durationMs: Date.now() - started,
    });
    store.setState(definition.id, (current) => ({
      ...current,
      revision: definition.revision,
      ...(advance ? { nextRunAt: nextIso(definition, Math.max(Date.parse(occurrence.at), now), this.handle.timeZone), lastRunAt: occurrence.at } : {}),
      lastSuccessAt: new Date(this.now()).toISOString(),
      consecutiveFailures: 0,
    }));
    this.handle.onChange?.(definition.id, definition.revision);
    return { result, runId, occurrenceAt: occurrence.at };
  }

  private async recordFailure(definition: ScheduleAutomationDefinition, occurrence: ScheduleOccurrence, now: number): Promise<void> {
    const { store } = this.handle;
    const next = store.setState(definition.id, (current) => ({
      ...current,
      revision: definition.revision,
      consecutiveFailures: (current.consecutiveFailures ?? 0) + 1,
      nextRunAt: nextIso(definition, Math.max(Date.parse(occurrence.at), now), this.handle.timeZone),
    }));
    if ((next.consecutiveFailures ?? 0) >= SCHEDULE_AUTO_PAUSE_AFTER) {
      const paused = this.pause(definition.id);
      if (paused) {
        await store.appendLog({ automationId: paused.id, revision: paused.revision, result: 'failed', reason: `Paused after ${SCHEDULE_AUTO_PAUSE_AFTER} consecutive launch failures; fix the task and enable it again.` });
        this.handle.onChange?.(paused.id, paused.revision);
        return;
      }
    }
    this.handle.onChange?.(definition.id, definition.revision);
  }

  /**
   * Pauses the CURRENT revision, not the one this fire started with: the definition may have been
   * edited while the launch ran, and pausing the stale copy would either conflict or revert the
   * edit. Already paused (or deleted) by then: nothing to do.
   */
  private pause(id: string): ScheduleAutomationDefinition | undefined {
    const current = this.handle.store.get(id);
    if (!current?.enabled) return undefined;
    const { revision, createdAt: _c, updatedAt: _u, id: _id, ...editable } = current;
    try {
      return this.handle.store.update(id, revision, { ...editable, enabled: false }) as ScheduleAutomationDefinition;
    } catch {
      // Edited or deleted in between; the next failure pauses whatever is current then.
      return undefined;
    }
  }

  private advance(definition: ScheduleAutomationDefinition, fromMs: number, now: number): void {
    this.handle.store.setState(definition.id, (current) => ({
      ...current,
      revision: definition.revision,
      nextRunAt: nextIso(definition, Math.max(fromMs, now), this.handle.timeZone),
    }));
    this.handle.onChange?.(definition.id, definition.revision);
  }

  private async logSkipped(definition: ScheduleAutomationDefinition, count: number, latestCaughtUp: boolean): Promise<void> {
    const plural = count === 1 ? '' : 's';
    await this.handle.store.appendLog({
      automationId: definition.id,
      revision: definition.revision,
      result: 'skipped',
      reason: latestCaughtUp
        ? `Missed ${count} older occurrence${plural} while cezar was not running; only the latest one caught up.`
        : `Missed ${count} occurrence${plural} while cezar was not running; nothing was launched for them.`,
    });
  }
}

function nextIso(definition: ScheduleAutomationDefinition, afterMs: number, timeZone: string): string | undefined {
  const next = nextOccurrence(definition.schedule, afterMs, timeZone);
  return next === null ? undefined : new Date(next).toISOString();
}

function reasonFor(occurrence: ScheduleOccurrence, timeZone: string): string {
  const when = new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(occurrence.at));
  switch (occurrence.trigger) {
    case 'schedule': return `Scheduled run at ${when}.`;
    case 'catch-up': return `Caught up the ${when} occurrence missed while cezar was not running.`;
    case 'manual': return `Started by hand at ${when}.`;
  }
}
