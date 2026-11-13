import { setupMonitoringFixture } from './run-fixture.testkit.ts';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { deriveAttention } from '@open-mercato/cezar-contract/attention';
import { WAIT_KIND, WAIT_VIA } from '@open-mercato/cezar-contract/test-factories.testkit';
import { monitoringTimerWait, monitoringWakeOf } from './waits.testkit.ts';
describe('RunManager schedule wakeup', () => {
  const fixture = setupMonitoringFixture();
  const { SINGLE_STEP, waitFor, openTimer } = fixture;
  it('a cezar_wait timer turn-end parks the run on an open timer', async () => {
    const idle = fixture.observeIdleTimers();
    const wakes = fixture.observeWakeTimers();
    const record = fixture.manager.startRun(SINGLE_STEP, { task: 'mock:cezar-wait keep going', worktree: false });
    fixture.currentId = record.id;
    await waitFor(record.id, (r) => r?.status === 'waiting' && Boolean(openTimer(r)));
    const parked = fixture.store.getRun(record.id);
    expect(parked?.waits?.find(wait => wait.phase === 'open')).toMatchObject({ kind: WAIT_KIND.timer, via: WAIT_VIA.cezar_wait });
    expect(deriveAttention(parked!).label).toBe('monitoring');
    const timer = openTimer(fixture.store.getRun(record.id))!;
    expect(wakes.captured).toBe(1);
    wakes.fire(0);
    await waitFor(record.id, run => run?.lastWaits?.some(wait => wait.id === timer.id && wait.phase === 'delivered') === true);
    expect(fixture.store.getRun(record.id)?.agentInputs?.filter(input => input.id === timer.id)).toHaveLength(1);
    expect(idle.pending).toBe(0); // durable monitors do not inherit the 15-minute user-wait timer
  }, 30_000);

  it('a Claude ScheduleWakeup turn-end parks on a schedule-wakeup timer', async () => {
    const idle = fixture.observeIdleTimers();
    const wakes = fixture.observeWakeTimers();
    const record = fixture.manager.startRun(SINGLE_STEP, {
      task: 'mock:schedule-wakeup keep going',
      runner: 'claude',
      worktree: false,
    });
    fixture.currentId = record.id;
    await waitFor(record.id, (r) => r?.status === 'waiting');

    const events = readFileSync(join(fixture.repoRoot, '.ai/cezar/runs', `${record.id}.ndjson`), 'utf8');
    expect(events).toContain('"tool":"ScheduleWakeup"');
    const timer = fixture.store.getRun(record.id)?.waits?.find(wait => wait.phase === 'open');
    expect(timer).toMatchObject({ kind: WAIT_KIND.timer, via: WAIT_VIA['schedule-wakeup'] });
    expect(idle.pending).toBe(0);
    expect(monitoringTimerWait(fixture.store.getRun(record.id))).toBeDefined();

    // hearsay-tools/cezarion#1233: a human message withdraws no timer, so the markerless turn
    // re-parks on the same one instead of becoming a plain wait.
    const boundaries = () => readFileSync(join(fixture.repoRoot, '.ai/cezar/runs', `${record.id}.ndjson`), 'utf8').split('"type":"turn-end"').length;
    const before = boundaries();
    expect(fixture.manager.sendMessage(record.id, [{ type: 'text', text: 'the next turn keeps the timer' }])).toBe(true);
    await waitFor(record.id, (r) => r?.status === 'waiting' && boundaries() > before);
    expect(fixture.store.getRun(record.id)?.waits?.find(wait => wait.phase === 'open')?.id).toBe(timer!.id);
    expect(idle.pending).toBe(0);
    expect(monitoringTimerWait(fixture.store.getRun(record.id))).toBeDefined();
    const wake = openTimer(fixture.store.getRun(record.id))!;
    expect(wakes.captured).toBe(1);
    wakes.fire(0);
    await waitFor(record.id, run => run?.lastWaits?.some(wait => wait.id === wake.id && wait.phase === 'delivered') === true);
    expect(fixture.store.getRun(record.id)?.agentInputs?.filter(input => input.id === wake.id)).toHaveLength(1);
  }, 30_000);

  it('recognizes Claude ScheduleWakeup on a reopened continuation too', async () => {
    const idle = fixture.observeIdleTimers();
    const wakes = fixture.observeWakeTimers();
    const record = fixture.manager.startRun(SINGLE_STEP, { task: 'finish the first turn', worktree: false });
    fixture.currentId = record.id;
    await waitFor(record.id, (r) => r?.status === 'waiting');
    expect(fixture.manager.finish(record.id)).toBe(true);
    await waitFor(record.id, (r) => r?.status === 'done' || r?.status === 'review');

    expect(fixture.manager.continueRun(record.id, { text: 'mock:schedule-wakeup check later' })).toEqual({ ok: true });
    await waitFor(record.id, (r) => r?.status === 'waiting' && Boolean(monitoringWakeOf(r)));
    expect(fixture.store.getRun(record.id)?.waits?.find(wait => wait.phase === 'open')).toMatchObject({ kind: WAIT_KIND.timer, via: WAIT_VIA['schedule-wakeup'] });
    expect(idle.pending).toBe(0);
    expect(monitoringTimerWait(fixture.store.getRun(record.id))).toBeDefined();
    const wake = openTimer(fixture.store.getRun(record.id))!;
    expect(wakes.captured).toBe(1);
    wakes.fire(0);
    await waitFor(record.id, run => run?.lastWaits?.some(wait => wait.id === wake.id && wait.phase === 'delivered') === true);
    expect(fixture.store.getRun(record.id)?.agentInputs?.filter(input => input.id === wake.id)).toHaveLength(1);
  }, 40_000);

  it('keeps cezar_done ahead of Claude ScheduleWakeup', async () => {
    const record = fixture.manager.startRun(SINGLE_STEP, {
      task: 'mock:schedule-wakeup mock:cezar-done finish now',
      runner: 'claude',
      worktree: false,
    });
    fixture.currentId = record.id;
    await waitFor(record.id, (r) => r?.status === 'done' || r?.status === 'review');
    expect(fixture.store.getRun(record.id)?.waits ?? []).toEqual([]);
  }, 30_000);

  it('keeps cezar_ask ahead of Claude ScheduleWakeup', async () => {
    const idle = fixture.observeIdleTimers();
    const record = fixture.manager.startRun(SINGLE_STEP, {
      task: 'mock:schedule-wakeup mock:cezar-ask choose',
      runner: 'claude',
      worktree: false,
    });
    fixture.currentId = record.id;
    await waitFor(record.id, (r) => r?.status === 'waiting');
    expect(deriveAttention(fixture.store.getRun(record.id)!).label).toBe('needs you');
    expect(fixture.store.getRun(record.id)?.waits?.some(wait => wait.kind === 'timer' && wait.phase === 'open')).toBe(false);
    expect(idle.pending).toBeGreaterThan(0);
  }, 30_000);
});
