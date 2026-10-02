import { readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AutomationStore } from './store.ts';
import { SCHEDULE_AUTO_PAUSE_AFTER, ScheduleLeaseHeldError, ScheduleRunner } from './schedule-runner.ts';
import type { ScheduleAutomationDefinition } from './types.ts';

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

const DAY = 86_400_000;
const HOUR = 3_600_000;
// A daily at 04:00 UTC. The clock starts on Monday 2026-09-14 at 03:59:30 UTC.
const T0 = Date.parse('2026-09-14T03:59:30Z');
const FIRST_RUN = Date.parse('2026-09-14T04:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString();

async function setup(options: { schedule?: ScheduleAutomationDefinition['schedule']; timeZone?: string; start?: number } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'cezar-schedule-runner-'));
  dirs.push(dir);
  let now = options.start ?? T0;
  const clock = { now: () => now, set: (ms: number) => { now = ms; } };
  const store = AutomationStore.open(dir, { now: () => new Date(now) });
  const schedule = options.schedule ?? { type: 'daily', hour: 4 };
  const definition = store.create({ name: 'Nightly', enabled: true, kind: 'schedule', schedule, task: { prompt: 'Bump deps' } }, 'nightly') as ScheduleAutomationDefinition;
  const launch = vi.fn(async () => ({ runId: `run-${launch.mock.calls.length}` }));
  const changes: string[] = [];
  const runner = new ScheduleRunner({ projectId: 'p', store, timeZone: options.timeZone ?? 'UTC', launch, now: clock.now, onChange: (id) => changes.push(id) });
  return { dir, store, definition, launch, runner, clock, changes };
}

describe('ScheduleRunner', () => {
  it('computes and persists the next occurrence on first sight', async () => {
    const { store, definition, runner } = await setup();
    expect(runner.dueAt(definition)).toBe(FIRST_RUN);
    expect(store.state('nightly')?.nextRunAt).toBe(iso(FIRST_RUN));
    expect(runner.dueAt(definition)).toBe(FIRST_RUN);
  });

  it('fires on time as launched and advances nextRunAt to the next day', async () => {
    const { store, definition, runner, launch, clock } = await setup();
    runner.dueAt(definition);
    clock.set(FIRST_RUN + 2_000);
    const outcome = await runner.fire(definition);
    expect(outcome).toMatchObject({ result: 'launched', runId: 'run-1', occurrenceAt: iso(FIRST_RUN) });
    expect(launch).toHaveBeenCalledWith(definition, { at: iso(FIRST_RUN), trigger: 'schedule' }, expect.any(String));
    expect(store.latestReceipts().get(`nightly:schedule:${iso(FIRST_RUN)}`)).toMatchObject({ status: 'launched', runId: 'run-1', occurrenceAt: iso(FIRST_RUN) });
    expect(store.logs({ automationId: 'nightly' })[0]).toMatchObject({ result: 'launched', runId: 'run-1', reason: expect.stringContaining('Scheduled run at') });
    expect(store.state('nightly')).toMatchObject({
      nextRunAt: iso(FIRST_RUN + DAY),
      lastRunAt: iso(FIRST_RUN),
      consecutiveFailures: 0,
    });
  });

  it('fires the latest missed occurrence once as catch-up when 2h late', async () => {
    const { store, definition, runner, launch, clock } = await setup();
    runner.dueAt(definition);
    clock.set(FIRST_RUN + 2 * HOUR);
    const outcome = await runner.fire(definition);
    expect(outcome).toMatchObject({ result: 'catch-up', runId: 'run-1', occurrenceAt: iso(FIRST_RUN) });
    expect(launch).toHaveBeenCalledTimes(1);
    expect(launch).toHaveBeenCalledWith(definition, { at: iso(FIRST_RUN), trigger: 'catch-up' }, expect.any(String));
    expect(store.logs({ automationId: 'nightly' }).map((row) => row.result)).toEqual(['catch-up']);
    // Late because cezar was down OR the machine slept: the reason must not claim only the first.
    expect(store.logs({ automationId: 'nightly' })[0]?.reason).toContain('missed while cezar was not running or the machine was asleep');
    expect(store.state('nightly')?.nextRunAt).toBe(iso(FIRST_RUN + DAY));
  });

  it('skips everything when the latest occurrence is older than 24h', async () => {
    // Every shape but a weekly recurs within 24 h, so its latest miss is always young enough
    // to catch up; a weekly asleep for 2 weeks and 3 days has three misses, the newest 3 days old.
    const { store, definition, runner, launch, clock } = await setup({ schedule: { type: 'weekly', day: 1, hour: 4 } });
    runner.dueAt(definition);
    clock.set(FIRST_RUN + 17 * DAY);
    const outcome = await runner.fire(definition);
    expect(outcome.result).toBe('skipped');
    expect(launch).not.toHaveBeenCalled();
    expect(store.logs({ automationId: 'nightly' })).toEqual([
      expect.objectContaining({ result: 'skipped', reason: expect.stringContaining('3 occurrences while cezar was not running or the machine was asleep') }),
    ]);
    expect(Date.parse(store.state('nightly')!.nextRunAt!)).toBeGreaterThan(clock.now());
    expect(store.state('nightly')?.nextRunAt).toBe(iso(FIRST_RUN + 21 * DAY));
  });

  it('a daily asleep for 3 days launches exactly one catch-up and advances from now', async () => {
    const { store, definition, runner, launch, clock } = await setup();
    runner.dueAt(definition);
    clock.set(FIRST_RUN + 3 * DAY + HOUR);
    const outcome = await runner.fire(definition);
    expect(outcome).toMatchObject({ result: 'catch-up', occurrenceAt: iso(FIRST_RUN + 3 * DAY) });
    expect(launch).toHaveBeenCalledTimes(1);
    const logs = store.logs({ automationId: 'nightly' });
    expect(logs.map((row) => row.result)).toEqual(['catch-up', 'skipped']);
    expect(logs[1]?.reason).toContain('Missed 3 older occurrences while cezar was not running or the machine was asleep');
    expect(store.state('nightly')?.nextRunAt).toBe(iso(FIRST_RUN + 4 * DAY));
  });

  it('an hourly schedule asleep for 3 days launches exactly one catch-up', async () => {
    const { store, definition, runner, launch, clock } = await setup({ schedule: { type: 'hours', every: 1 } });
    const due = runner.dueAt(definition)!;
    clock.set(due + 3 * DAY + 30 * 60_000);
    const outcome = await runner.fire(definition);
    expect(outcome.result).toBe('catch-up');
    expect(launch).toHaveBeenCalledTimes(1);
    expect(store.logs({ automationId: 'nightly' }).map((row) => row.result)).toEqual(['catch-up', 'skipped']);
    const next = Date.parse(store.state('nightly')!.nextRunAt!);
    expect(next).toBeGreaterThan(clock.now());
    expect(next - clock.now()).toBeLessThanOrEqual(HOUR);
  });

  it('an hourly schedule offline for 43 days catches up its latest occurrence, past the 1,000-occurrence cap', async () => {
    const { store, definition, runner, launch, clock } = await setup({ schedule: { type: 'hours', every: 1 } });
    const due = runner.dueAt(definition)!;
    // 43 × 24 = 1,032 missed hours: more than `occurrencesBetween` returns in one call.
    clock.set(due + 43 * DAY + 30 * 60_000);
    const outcome = await runner.fire(definition);
    expect(outcome).toMatchObject({ result: 'catch-up', occurrenceAt: iso(due + 43 * DAY) });
    expect(launch).toHaveBeenCalledTimes(1);
    expect(launch).toHaveBeenCalledWith(definition, { at: iso(due + 43 * DAY), trigger: 'catch-up' }, expect.any(String));
    const logs = store.logs({ automationId: 'nightly' });
    expect(logs.map((row) => row.result)).toEqual(['catch-up', 'skipped']);
    // The count past the cap is a lower bound, and the log says so rather than a wrong exact number.
    expect(logs[1]?.reason).toContain('Missed at least 1023 older occurrences');
    expect(store.state('nightly')?.nextRunAt).toBe(iso(due + 43 * DAY + HOUR));
  });

  it('counts older misses exactly while they stay under the cap', async () => {
    const { store, definition, runner, clock } = await setup({ schedule: { type: 'hours', every: 1 } });
    const due = runner.dueAt(definition)!;
    clock.set(due + 30 * DAY + 30 * 60_000);
    expect((await runner.fire(definition)).result).toBe('catch-up');
    expect(store.logs({ automationId: 'nightly' })[1]?.reason).toContain(`Missed ${30 * 24} older occurrences`);
  });

  it('DST: daily 02:30 Europe/Warsaw across 2026-03-29 fires once', async () => {
    // Armed on Friday evening 2026-03-27 (CET, UTC+1); 2026-03-29 springs forward 02:00 → 03:00,
    // so its 02:30 does not exist. The laptop sleeps from before Saturday's run until Sunday noon.
    const start = Date.parse('2026-03-27T20:00:00Z');
    const { store, definition, runner, launch, clock } = await setup({ schedule: { type: 'daily', hour: 2, minute: 30 }, timeZone: 'Europe/Warsaw', start });
    expect(runner.dueAt(definition)).toBe(Date.parse('2026-03-28T01:30:00Z'));
    clock.set(Date.parse('2026-03-29T10:00:00Z')); // Sunday 12:00 CEST
    const outcome = await runner.fire(definition);
    expect(outcome.result).toBe('catch-up');
    expect(launch).toHaveBeenCalledTimes(1);
    expect(store.logs({ automationId: 'nightly' }).filter((row) => row.result === 'catch-up')).toHaveLength(1);
    // The gap day's occurrence is the one that caught up, so Monday 02:30 CEST is next, and no
    // second launch for Sunday follows.
    const sunday = (launch.mock.calls[0] as unknown as [unknown, { at: string }])[1].at;
    expect(sunday.startsWith('2026-03-29')).toBe(true);
    expect(store.state('nightly')?.nextRunAt).toBe('2026-03-30T00:30:00.000Z');
    clock.set(Date.parse('2026-03-30T00:30:05Z'));
    expect(await runner.fire(definition)).toMatchObject({ result: 'launched', occurrenceAt: '2026-03-30T00:30:00.000Z' });
    expect(launch).toHaveBeenCalledTimes(2);
  });

  it('a duplicate receipt logs duplicate, advances, and launches nothing', async () => {
    const { store, definition, runner, launch, clock } = await setup();
    runner.dueAt(definition);
    clock.set(FIRST_RUN + 1_000);
    // Another cockpit on the same directory already reserved this occurrence.
    const other = AutomationStore.open(store.dataDir);
    other.reserveReceipt({ automationId: 'nightly', revision: 1, eventId: `schedule:${iso(FIRST_RUN)}`, occurrenceAt: iso(FIRST_RUN) });
    const outcome = await runner.fire(definition);
    expect(outcome.result).toBe('duplicate');
    expect(launch).not.toHaveBeenCalled();
    expect(store.logs({ automationId: 'nightly' })[0]).toMatchObject({ result: 'duplicate' });
    expect(store.state('nightly')?.nextRunAt).toBe(iso(FIRST_RUN + DAY));
    expect(store.state('nightly')?.consecutiveFailures).toBeUndefined();
  });

  it('a held lease logs skipped, leaves nextRunAt, does not count a failure and throws ScheduleLeaseHeldError', async () => {
    const { store, definition, runner, launch, clock } = await setup();
    runner.dueAt(definition);
    clock.set(FIRST_RUN + 1_000);
    const winnerStore = AutomationStore.open(store.dataDir, { now: () => new Date(clock.now()) });
    const lease = winnerStore.acquireLease()!;
    expect(lease).toBeDefined();
    try {
      await expect(runner.fire(definition)).rejects.toBeInstanceOf(ScheduleLeaseHeldError);
      expect(launch).not.toHaveBeenCalled();
      expect(store.logs({ automationId: 'nightly' })).toEqual([
        expect.objectContaining({ result: 'skipped', reason: 'automation lease is held by another process; retrying shortly' }),
      ]);
      expect(AutomationStore.open(store.dataDir).state('nightly')?.nextRunAt).toBe(iso(FIRST_RUN));
      expect(store.state('nightly')?.consecutiveFailures).toBeUndefined();
      expect(store.latestReceipts().size).toBe(0);
    } finally {
      lease.release();
    }
    // The winner still fires the very same occurrence, reading the shared on-disk state.
    const winnerLaunch = vi.fn(async () => ({ runId: 'winner-run' }));
    const winnerView = AutomationStore.open(store.dataDir, { now: () => new Date(clock.now()) });
    const winner = new ScheduleRunner({ projectId: 'p', store: winnerView, timeZone: 'UTC', launch: winnerLaunch, now: clock.now });
    expect(winner.dueAt(definition)).toBe(FIRST_RUN);
    expect(await winner.fire(definition)).toMatchObject({ result: 'launched', occurrenceAt: iso(FIRST_RUN) });
    expect(winnerLaunch).toHaveBeenCalledTimes(1);
  });

  it('three consecutive launch failures pause the definition and log the pause; a success resets the counter', async () => {
    const { store, definition, runner, launch, clock, changes } = await setup();
    let current = definition;
    const fireOnce = async () => {
      const due = runner.dueAt(current)!;
      clock.set(due + 1_000);
      const outcome = await runner.fire(current);
      current = store.get('nightly') as ScheduleAutomationDefinition;
      return outcome;
    };
    launch.mockRejectedValueOnce(new Error('unknown workflow: nope')).mockRejectedValueOnce(new Error('unknown workflow: nope'));
    expect((await fireOnce()).result).toBe('failed');
    expect((await fireOnce()).result).toBe('failed');
    expect(store.state('nightly')?.consecutiveFailures).toBe(2);
    expect((await fireOnce()).result).toBe('launched');
    expect(store.state('nightly')?.consecutiveFailures).toBe(0);

    launch.mockRejectedValue(new Error('unknown workflow: nope'));
    for (let attempt = 1; attempt <= SCHEDULE_AUTO_PAUSE_AFTER; attempt += 1) {
      expect(current.enabled).toBe(true);
      expect((await fireOnce()).result).toBe('failed');
    }
    expect(store.get('nightly')?.enabled).toBe(false);
    const logs = store.logs({ automationId: 'nightly' });
    expect(logs[0]).toMatchObject({ result: 'failed', reason: 'Paused after 3 consecutive launch failures; fix the task and enable it again.' });
    expect(logs.filter((row) => row.reason === 'unknown workflow: nope')).toHaveLength(5);
    expect([...store.latestReceipts().values()].filter((receipt) => receipt.status === 'launch-error')).toHaveLength(5);
    expect(changes.length).toBeGreaterThanOrEqual(6);
  });

  it('runNow launches as manual and leaves nextRunAt and enabled untouched, paused or not', async () => {
    const { store, definition, runner, launch, clock } = await setup();
    runner.dueAt(definition);
    const before = store.state('nightly')?.nextRunAt;
    clock.set(T0 + 5_000);
    expect(await runner.runNow(definition)).toMatchObject({ result: 'manual', runId: 'run-1' });
    expect(store.state('nightly')?.nextRunAt).toBe(before);
    expect(store.get('nightly')?.enabled).toBe(true);

    const paused = store.update('nightly', 1, { name: 'Nightly', enabled: false, kind: 'schedule', schedule: definition.schedule, task: definition.task }) as ScheduleAutomationDefinition;
    clock.set(T0 + 10_000);
    const outcome = await runner.runNow(paused);
    expect(outcome).toMatchObject({ result: 'manual', runId: 'run-2' });
    expect(launch).toHaveBeenLastCalledWith(paused, { at: iso(clock.now()), trigger: 'manual' }, expect.any(String));
    expect(store.latestReceipts().get(`nightly:manual:${iso(clock.now())}`)).toMatchObject({ status: 'launched', runId: 'run-2' });
    expect(store.logs({ automationId: 'nightly' })[0]).toMatchObject({ result: 'manual', runId: 'run-2', reason: expect.stringContaining('Started by hand') });
    expect(store.state('nightly')?.nextRunAt).toBe(before);
    expect(store.get('nightly')?.enabled).toBe(false);
  });

  it('runNow answers lease-held instead of throwing when another process holds the lease', async () => {
    const { store, definition, runner, launch } = await setup();
    const lease = AutomationStore.open(store.dataDir).acquireLease()!;
    try {
      expect(await runner.runNow(definition)).toMatchObject({ result: 'lease-held' });
      expect(launch).not.toHaveBeenCalled();
    } finally {
      lease.release();
    }
  });

  it('retry re-reserves the same receipt and fires it as manual', async () => {
    const { store, definition, runner, launch, clock } = await setup();
    launch.mockRejectedValueOnce(new Error('boom'));
    runner.dueAt(definition);
    clock.set(FIRST_RUN + 1_000);
    await runner.fire(definition);
    const failed = [...store.latestReceipts().values()][0]!;
    expect(failed.status).toBe('launch-error');
    const nextRunAt = store.state('nightly')?.nextRunAt;
    const outcome = await runner.retry(definition, failed);
    expect(outcome).toMatchObject({ result: 'manual', runId: 'run-2', occurrenceAt: failed.occurrenceAt });
    expect(store.latestReceipts().size).toBe(1);
    expect(store.latestReceipts().get(failed.receiptKey)).toMatchObject({ receiptId: failed.receiptId, status: 'launched', runId: 'run-2' });
    expect(launch).toHaveBeenLastCalledWith(definition, { at: failed.occurrenceAt, trigger: 'manual' }, failed.receiptId);
    expect(store.state('nightly')?.nextRunAt).toBe(nextRunAt);
  });

  it('a failed runNow or retry neither counts towards nor triggers the auto-pause', async () => {
    const { store, definition, runner, launch, clock } = await setup();
    runner.dueAt(definition);
    store.setState('nightly', (current) => ({ ...current, consecutiveFailures: 2 }));
    launch.mockRejectedValue(new Error('still broken'));
    clock.set(T0 + 5_000);
    expect(await runner.runNow(definition)).toMatchObject({ result: 'failed' });
    const failed = [...store.latestReceipts().values()][0]!;
    clock.set(T0 + 10_000);
    expect(await runner.retry(definition, failed)).toMatchObject({ result: 'failed' });
    expect(store.get('nightly')?.enabled).toBe(true);
    expect(store.get('nightly')?.revision).toBe(1);
    expect(store.state('nightly')?.consecutiveFailures).toBe(2);
    expect(store.logs({ automationId: 'nightly' }).some((row) => row.reason?.startsWith('Paused after'))).toBe(false);
  });

  it('fire before the due instant launches nothing and leaves nextRunAt', async () => {
    const { store, definition, runner, launch } = await setup();
    runner.dueAt(definition);
    // The clock is still T0, 30 s before FIRST_RUN.
    expect(await runner.fire(definition)).toEqual({ result: 'skipped', occurrenceAt: iso(FIRST_RUN) });
    expect(launch).not.toHaveBeenCalled();
    expect(store.latestReceipts().size).toBe(0);
    expect(store.state('nightly')?.nextRunAt).toBe(iso(FIRST_RUN));
  });

  it('the third failure does not resurrect a definition another process deleted during the launch', async () => {
    const { dir, store, definition, runner, launch, clock } = await setup();
    runner.dueAt(definition);
    store.setState('nightly', (current) => ({ ...current, consecutiveFailures: 2 }));
    launch.mockImplementationOnce(async () => {
      AutomationStore.open(dir, { now: () => new Date(clock.now()) }).delete('nightly');
      throw new Error('boom');
    });
    clock.set(FIRST_RUN + 1_000);
    expect(await runner.fire(definition)).toMatchObject({ result: 'failed' });
    const file = JSON.parse(readFileSync(join(dir, 'automations.json'), 'utf8'));
    expect(file.automations).toEqual([]);
    expect(store.get('nightly')).toBeUndefined();
    expect(store.logs({ automationId: 'nightly' }).some((row) => row.reason?.startsWith('Paused after'))).toBe(false);
  });

  it('the third failure pauses the current on-disk revision when another process edited it during the launch', async () => {
    const { dir, store, definition, runner, launch, clock } = await setup();
    runner.dueAt(definition);
    store.setState('nightly', (current) => ({ ...current, consecutiveFailures: 2 }));
    launch.mockImplementationOnce(async () => {
      AutomationStore.open(dir, { now: () => new Date(clock.now()) })
        .update('nightly', 1, { name: 'Nightly (edited elsewhere)', enabled: true, kind: 'schedule', schedule: definition.schedule, task: { prompt: 'Bump deps, then lint' } });
      throw new Error('boom');
    });
    clock.set(FIRST_RUN + 1_000);
    expect(await runner.fire(definition)).toMatchObject({ result: 'failed' });
    const file = JSON.parse(readFileSync(join(dir, 'automations.json'), 'utf8'));
    expect(file.automations).toEqual([expect.objectContaining({ id: 'nightly', name: 'Nightly (edited elsewhere)', task: { prompt: 'Bump deps, then lint' }, enabled: false, revision: 3 })]);
    expect(store.logs({ automationId: 'nightly' })[0]).toMatchObject({ result: 'failed', revision: 3, reason: expect.stringContaining('Paused after 3') });
  });

  it('the third failure leaves a definition another process paused during the launch alone', async () => {
    const { dir, store, definition, runner, launch, clock } = await setup();
    runner.dueAt(definition);
    store.setState('nightly', (current) => ({ ...current, consecutiveFailures: 2 }));
    launch.mockImplementationOnce(async () => {
      AutomationStore.open(dir, { now: () => new Date(clock.now()) })
        .update('nightly', 1, { name: 'Nightly', enabled: false, kind: 'schedule', schedule: definition.schedule, task: definition.task });
      throw new Error('boom');
    });
    clock.set(FIRST_RUN + 1_000);
    expect(await runner.fire(definition)).toMatchObject({ result: 'failed' });
    const file = JSON.parse(readFileSync(join(dir, 'automations.json'), 'utf8'));
    expect(file.automations).toEqual([expect.objectContaining({ id: 'nightly', enabled: false, revision: 2 })]);
    expect(store.logs({ automationId: 'nightly' }).some((row) => row.reason?.startsWith('Paused after'))).toBe(false);
  });

  it('the third failure pauses the current revision when the definition was edited during the launch', async () => {
    const { store, definition, runner, launch, clock, changes } = await setup();
    runner.dueAt(definition);
    store.setState('nightly', (current) => ({ ...current, consecutiveFailures: 2 }));
    launch.mockImplementationOnce(async () => {
      store.update('nightly', 1, { name: 'Nightly (edited)', enabled: true, kind: 'schedule', schedule: definition.schedule, task: definition.task });
      throw new Error('boom');
    });
    clock.set(FIRST_RUN + 1_000);
    expect(await runner.fire(definition)).toMatchObject({ result: 'failed' });
    expect(store.get('nightly')).toMatchObject({ name: 'Nightly (edited)', enabled: false, revision: 3 });
    expect(store.logs({ automationId: 'nightly' })[0]).toMatchObject({ result: 'failed', revision: 3, reason: expect.stringContaining('Paused after 3') });
    expect(changes.at(-1)).toBe('nightly');
  });

  // An edit during the launch is what the PUT route does: a new revision, then `nextRunAt`
  // re-armed from now for the new schedule. Completion must not overwrite it with an instant
  // computed from the definition this fire captured.
  const editDuringLaunch = (store: AutomationStore, definition: ScheduleAutomationDefinition, armed: number) => {
    const edited = store.update('nightly', definition.revision, { name: 'Nightly', enabled: true, kind: 'schedule', schedule: { type: 'daily', hour: 9 }, task: definition.task });
    store.setState('nightly', (current) => ({ ...current, revision: edited.revision, nextRunAt: iso(armed) }));
  };

  it('a success keeps the nextRunAt an edit armed while the launch ran', async () => {
    const { store, definition, runner, launch, clock } = await setup();
    runner.dueAt(definition);
    const armed = FIRST_RUN + 5 * HOUR;
    launch.mockImplementationOnce(async () => {
      editDuringLaunch(store, definition, armed);
      return { runId: 'run-edited' };
    });
    clock.set(FIRST_RUN + 1_000);
    expect(await runner.fire(definition)).toMatchObject({ result: 'launched', runId: 'run-edited' });
    expect(store.state('nightly')).toMatchObject({ revision: 2, nextRunAt: iso(armed), lastRunAt: iso(FIRST_RUN), consecutiveFailures: 0 });
  });

  it('a failure keeps the nextRunAt an edit armed while the launch ran', async () => {
    const { store, definition, runner, launch, clock } = await setup();
    runner.dueAt(definition);
    const armed = FIRST_RUN + 5 * HOUR;
    launch.mockImplementationOnce(async () => {
      editDuringLaunch(store, definition, armed);
      throw new Error('boom');
    });
    clock.set(FIRST_RUN + 1_000);
    expect(await runner.fire(definition)).toMatchObject({ result: 'failed' });
    expect(store.state('nightly')).toMatchObject({ revision: 2, nextRunAt: iso(armed), consecutiveFailures: 1 });
  });

  it('an edit that leaves the schedule alone still lets completion advance nextRunAt', async () => {
    const { store, definition, runner, launch, clock } = await setup();
    runner.dueAt(definition);
    launch.mockImplementationOnce(async () => {
      store.update('nightly', 1, { name: 'Nightly (renamed)', enabled: true, kind: 'schedule', schedule: definition.schedule, task: definition.task });
      return { runId: 'run-renamed' };
    });
    clock.set(FIRST_RUN + 1_000);
    expect(await runner.fire(definition)).toMatchObject({ result: 'launched' });
    expect(store.state('nightly')).toMatchObject({ revision: 2, nextRunAt: iso(FIRST_RUN + DAY), lastRunAt: iso(FIRST_RUN) });
  });

  it('the third failure skips the pause when the definition was paused elsewhere during the launch', async () => {
    const { store, definition, runner, launch, clock, changes } = await setup();
    runner.dueAt(definition);
    store.setState('nightly', (current) => ({ ...current, consecutiveFailures: 2 }));
    launch.mockImplementationOnce(async () => {
      store.update('nightly', 1, { name: 'Nightly', enabled: false, kind: 'schedule', schedule: definition.schedule, task: definition.task });
      throw new Error('boom');
    });
    clock.set(FIRST_RUN + 1_000);
    const before = changes.length;
    expect(await runner.fire(definition)).toMatchObject({ result: 'failed' });
    expect(store.get('nightly')).toMatchObject({ enabled: false, revision: 2 });
    expect(store.logs({ automationId: 'nightly' }).some((row) => row.reason?.startsWith('Paused after'))).toBe(false);
    expect(changes.length).toBeGreaterThan(before);
  });

  it('retry launches nothing when the receipt is no longer in launch-error', async () => {
    const { store, definition, runner, launch, clock } = await setup();
    launch.mockRejectedValueOnce(new Error('boom'));
    runner.dueAt(definition);
    clock.set(FIRST_RUN + 1_000);
    await runner.fire(definition);
    const stale = [...store.latestReceipts().values()][0]!;
    expect(stale.status).toBe('launch-error');
    // Another process retried it first.
    AutomationStore.open(store.dataDir).appendReceipt({ ...stale, status: 'launched', runId: 'elsewhere', updatedAt: iso(clock.now()) });
    expect(await runner.retry(definition, stale)).toEqual({ result: 'duplicate', occurrenceAt: stale.occurrenceAt });
    expect(launch).toHaveBeenCalledTimes(1);
    expect(store.latestReceipts().get(stale.receiptKey)).toMatchObject({ status: 'launched', runId: 'elsewhere' });
  });

  // A second cockpit on the same project edits the definitions file on disk; this process's
  // timer still holds the definition it captured when it armed. The lease serializes fires,
  // not views: the fire must re-read the definition under the lease and drop a stale one.
  describe('a definition changed by another process', () => {
    const editable = (definition: ScheduleAutomationDefinition) => {
      const { id: _id, revision: _r, createdAt: _c, updatedAt: _u, ...rest } = definition;
      return rest;
    };

    it('paused elsewhere: launches nothing, logs no failure, leaves the counter and nextRunAt, and refreshes this store', async () => {
      const { dir, store, definition, runner, launch, clock, changes } = await setup();
      runner.dueAt(definition);
      store.setState('nightly', (current) => ({ ...current, consecutiveFailures: 1 }));
      const other = AutomationStore.open(dir, { now: () => new Date(clock.now()) });
      other.update('nightly', definition.revision, { ...editable(definition), enabled: false });
      clock.set(FIRST_RUN + 1_000);
      expect(await runner.fire(definition)).toEqual({ result: 'skipped' });
      expect(launch).not.toHaveBeenCalled();
      expect(store.latestReceipts().size).toBe(0);
      expect(store.logs({ automationId: 'nightly' }).filter((row) => row.result === 'failed')).toEqual([]);
      expect(store.state('nightly')).toMatchObject({ consecutiveFailures: 1, nextRunAt: iso(FIRST_RUN) });
      expect(store.get('nightly')).toMatchObject({ enabled: false, revision: 2 });
      expect(store.list().filter((item) => item.enabled)).toEqual([]);
      expect(changes.at(-1)).toBe('nightly');
    });

    it('rescheduled elsewhere: launches nothing and adopts the on-disk definition and nextRunAt', async () => {
      const { dir, store, definition, runner, launch, clock } = await setup();
      runner.dueAt(definition);
      const other = AutomationStore.open(dir, { now: () => new Date(clock.now()) });
      const edited = other.update('nightly', definition.revision, { ...editable(definition), schedule: { type: 'daily', hour: 9 } });
      other.setState('nightly', (current) => ({ ...current, revision: edited.revision, nextRunAt: iso(FIRST_RUN + 5 * HOUR) }));
      clock.set(FIRST_RUN + 1_000);
      expect(await runner.fire(definition)).toEqual({ result: 'skipped' });
      expect(launch).not.toHaveBeenCalled();
      expect(store.get('nightly')).toMatchObject({ revision: 2, schedule: { type: 'daily', hour: 9 } });
      expect(store.state('nightly')?.nextRunAt).toBe(iso(FIRST_RUN + 5 * HOUR));
    });

    it('deleted elsewhere: launches nothing and drops the definition here too', async () => {
      const { dir, store, definition, runner, launch, clock } = await setup();
      runner.dueAt(definition);
      AutomationStore.open(dir, { now: () => new Date(clock.now()) }).delete('nightly');
      clock.set(FIRST_RUN + 1_000);
      expect(await runner.fire(definition)).toEqual({ result: 'skipped' });
      expect(launch).not.toHaveBeenCalled();
      expect(store.get('nightly')).toBeUndefined();
    });

    describe('Run now and Retry reload under the lease', () => {
      const failedReceipt = async () => {
        const ctx = await setup();
        ctx.launch.mockRejectedValueOnce(new Error('boom'));
        ctx.runner.dueAt(ctx.definition);
        ctx.clock.set(FIRST_RUN + 1_000);
        await ctx.runner.fire(ctx.definition);
        const failed = [...ctx.store.latestReceipts().values()][0]!;
        expect(failed.status).toBe('launch-error');
        ctx.launch.mockClear();
        return { ...ctx, failed };
      };

      it('runNow after a delete elsewhere launches nothing, writes no receipt or log row, and notifies', async () => {
        const { dir, store, definition, runner, launch, clock, changes } = await setup();
        const logsBefore = store.logs({ automationId: 'nightly' }).length;
        AutomationStore.open(dir, { now: () => new Date(clock.now()) }).delete('nightly');
        const before = changes.length;
        expect(await runner.runNow(definition)).toEqual({ result: 'skipped' });
        expect(launch).not.toHaveBeenCalled();
        expect(store.latestReceipts().size).toBe(0);
        expect(store.logs({ automationId: 'nightly' })).toHaveLength(logsBefore);
        expect(changes.length).toBeGreaterThan(before);
      });

      it('runNow after an edit elsewhere launches the edited definition', async () => {
        const { dir, store, definition, runner, launch, clock } = await setup();
        const edited = AutomationStore.open(dir, { now: () => new Date(clock.now()) })
          .update('nightly', definition.revision, { ...editable(definition), task: { prompt: 'Bump deps, then lint' } });
        expect(await runner.runNow(definition)).toMatchObject({ result: 'manual' });
        expect(launch).toHaveBeenCalledTimes(1);
        expect((launch.mock.calls as unknown[][])[0]![0]).toMatchObject({ revision: edited.revision, task: { prompt: 'Bump deps, then lint' } });
        expect(store.logs({ automationId: 'nightly' })[0]).toMatchObject({ result: 'manual', revision: edited.revision });
      });

      it('retry after a delete elsewhere launches nothing and leaves the receipt in launch-error', async () => {
        const { dir, store, definition, runner, launch, clock, failed } = await failedReceipt();
        AutomationStore.open(dir, { now: () => new Date(clock.now()) }).delete('nightly');
        expect(await runner.retry(definition, failed)).toEqual({ result: 'skipped', occurrenceAt: failed.occurrenceAt });
        expect(launch).not.toHaveBeenCalled();
        expect(store.latestReceipts().get(failed.receiptKey)?.status).toBe('launch-error');
      });

      it('retry after an edit elsewhere launches the edited definition', async () => {
        const { dir, definition, runner, launch, clock, failed } = await failedReceipt();
        const edited = AutomationStore.open(dir, { now: () => new Date(clock.now()) })
          .update('nightly', definition.revision, { ...editable(definition), task: { prompt: 'Bump deps, then lint' } });
        expect(await runner.retry(definition, failed)).toMatchObject({ result: 'manual', occurrenceAt: failed.occurrenceAt });
        expect(launch).toHaveBeenCalledTimes(1);
        expect((launch.mock.calls as unknown[][])[0]![0]).toMatchObject({ revision: edited.revision, task: { prompt: 'Bump deps, then lint' } });
      });
    });

    it('unchanged on disk: a second store opening the directory does not stop the fire', async () => {
      const { dir, store, definition, runner, launch, clock } = await setup();
      runner.dueAt(definition);
      AutomationStore.open(dir, { now: () => new Date(clock.now()) });
      clock.set(FIRST_RUN + 1_000);
      expect(await runner.fire(definition)).toMatchObject({ result: 'launched', occurrenceAt: iso(FIRST_RUN) });
      expect(launch).toHaveBeenCalledTimes(1);
      expect(store.state('nightly')?.nextRunAt).toBe(iso(FIRST_RUN + DAY));
    });

    it('an unreadable definitions file falls back to this process\'s view and still fires', async () => {
      const { dir, store, definition, runner, launch, clock } = await setup();
      runner.dueAt(definition);
      writeFileSync(join(dir, 'automations.json'), '{ not json');
      clock.set(FIRST_RUN + 1_000);
      expect(await runner.fire(definition)).toMatchObject({ result: 'launched' });
      expect(launch).toHaveBeenCalledTimes(1);
      expect(store.get('nightly')).toMatchObject({ enabled: true, revision: 1 });
    });
  });

  it('reports detection-only when the cockpit cannot launch', async () => {
    const { store, definition, clock } = await setup();
    const runner = new ScheduleRunner({ projectId: 'p', store, timeZone: 'UTC', now: clock.now });
    runner.dueAt(definition);
    clock.set(FIRST_RUN + 1_000);
    expect((await runner.fire(definition)).result).toBe('detection-only');
    expect(store.state('nightly')?.nextRunAt).toBe(iso(FIRST_RUN + DAY));
  });
});
