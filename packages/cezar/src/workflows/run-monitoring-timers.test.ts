import { testHome } from '../home/test-home.testkit.ts';
import { setupMonitoringFixture, runnerHook } from './run-fixture.testkit.ts';
import { createFixtureManager } from './fixture-cleanup.testkit.ts';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { RUN_STATUS, WAIT_KIND, WAIT_PHASE, WAIT_VIA, WAIT_SOURCE } from '@open-mercato/cezar-contract/test-factories.testkit';
import { monitoringTimerWait, monitoringWakeOf } from './waits.testkit.ts';
describe('RunManager monitoring timers', () => {
  const fixture = setupMonitoringFixture();
  const { SINGLE_STEP, waitFor, openTimer } = fixture;
  it('a parked monitor schedules its own re-check under the zero-config default (#810)', async () => {
    const idle = fixture.observeIdleTimers();
    const record = fixture.manager.startRun(SINGLE_STEP, { task: 'mock:schedule-wakeup keep going', runner: 'claude', worktree: false });
    fixture.currentId = record.id;
    await waitFor(record.id, (r) => r?.status === 'waiting' && Boolean(monitoringWakeOf(r)));
    const parked = fixture.store.getRun(record.id);
    const deadline = Date.parse(String(monitoringWakeOf(parked)));
    expect(Number.isNaN(deadline)).toBe(false);
    expect(deadline).toBeGreaterThan(Date.now()); // a real future re-check, not a stale stamp
    expect(monitoringTimerWait(fixture.store.getRun(record.id))).toBeDefined();
    expect(fixture.store.getRun(record.id)?.status).toBe('waiting');
    expect(idle.pending).toBe(0);
  }, 30_000);

  it('park mode remains reachable as an explicit operator choice (#810)', async () => {
    fixture.manager.dispose();
    fixture.manager = createFixtureManager(fixture.store, fixture.repoRoot, { home: testHome(),
      semaphore: new WorkspaceSemaphore({ home: testHome(), initial: { monitoringWakeIntervalMinutes: null } }),
    });
    const record = fixture.manager.startRun(SINGLE_STEP, { task: 'mock:schedule-wakeup keep going', runner: 'claude', worktree: false });
    fixture.currentId = record.id;
    // hearsay-tools/cezarion#1233: with re-checks off no timer is registered; the run parks and
    // says why. hearsay-tools/cezarion#1234: it parks on a human wait, not a plain one.
    await waitFor(record.id, (r) => r?.status === 'waiting');
    await waitFor(record.id, () => readFileSync(join(fixture.repoRoot, '.ai/cezar/runs', `${record.id}.ndjson`), 'utf8').includes('automatic re-checks are off; waiting for you'));
    expect(fixture.store.getRun(record.id)?.waits ?? []).toMatchObject([{ kind: WAIT_KIND.human, via: WAIT_VIA['monitoring-line'], source: WAIT_SOURCE.agent, phase: WAIT_PHASE.open }]);
    expect(monitoringWakeOf(fixture.store.getRun(record.id))).toBeUndefined();
    expect(monitoringTimerWait(fixture.store.getRun(record.id))).toBeUndefined();
  }, 30_000);

  it('optionally wakes a parked monitor without fabricating a user message', async () => {
    fixture.manager.dispose();
    const semaphore = new WorkspaceSemaphore({ home: testHome(), initial: { monitoringWakeIntervalMinutes: 0.001 } });
    fixture.manager = createFixtureManager(fixture.store, fixture.repoRoot, { home: testHome(), semaphore });
    const record = fixture.manager.startRun(SINGLE_STEP, { task: 'mock:schedule-wakeup keep going', runner: 'claude', worktree: false });
    fixture.currentId = record.id;
    await waitFor(record.id, () => {
      const path = join(fixture.repoRoot, '.ai/cezar/runs', `${record.id}.ndjson`);
      if (!existsSync(path)) return false;
      const ndjson = readFileSync(path, 'utf8');
      return ndjson.includes('automatic monitoring wake-up (1/40)');
    });
    const events = readFileSync(join(fixture.repoRoot, '.ai/cezar/runs', `${record.id}.ndjson`), 'utf8')
      .trim().split('\n').map((line) => JSON.parse(line) as { type: string; message?: string });
    expect(events.some((event) => event.type === 'note' && event.message?.includes('(1/40)'))).toBe(true);
    expect(events.some((event) => event.type === 'user-message')).toBe(false);
  }, 30_000);

  it.each([
    { activity: 'tool', trigger: 'mock:backend-resume', eventNeedle: 'pi-autonomous-edit' },
    { activity: 'message', trigger: 'mock:backend-resume-text', eventNeedle: 'Pi resumed without a prompt' },
  ])('backend $activity activity resumes a parked monitor before its wake deadline and closes its timer (#59, hearsay-tools/cezarion#2431)', async ({ trigger, eventNeedle }) => {
    // Pi has no ScheduleWakeup: its turn parks on a cezar_wait timer, which the test fires.
    const semaphore = fixture.semaphore;
    const monitoringLimit = vi.spyOn(semaphore, 'maxMonitoringSessions').mockReturnValue(0);
    const record = fixture.manager.startRun(SINGLE_STEP, {
      task: `mock:cezar-wait ${trigger} keep going`,
      runner: 'pi',
      worktree: false,
    });
    fixture.currentId = record.id;
    await waitFor(record.id, (r) => r?.status === 'waiting' && Boolean(openTimer(r)));

    const wait = openTimer(fixture.store.getRun(record.id))!;
    expect(fixture.store.getRun(record.id)?.status).toBe('waiting');
    // A parked pool member costs one; a parked nonmember costs zero.
    expect(semaphore.busy()).toBe(1);
    monitoringLimit.mockRestore();

    await waitFor(record.id, () => {
      const events = readFileSync(join(fixture.repoRoot, '.ai/cezar/runs', `${record.id}.ndjson`), 'utf8');
      return events.includes(eventNeedle);
    });

    // hearsay-tools/cezarion#1233: the backend's own turn runs on the pool slot it parked with.
    // hearsay-tools/cezarion#2431 (owner decision 4): a parent turn the runner starts itself closes
    // every open timer, so the timer cannot wake a second turn after it; the turn's own end decides
    // what it waits on next.
    expect(fixture.store.getRun(record.id)).toMatchObject({ status: RUN_STATUS.running });
    expect(openTimer(fixture.store.getRun(record.id))).toBeUndefined();
    expect(openTimer(fixture.store.getRun(record.id))).toBeUndefined();
    expect(fixture.store.getRun(record.id)?.lastWaits?.filter(entry => entry.id === wait.id).map(entry => entry.phase)).toEqual([WAIT_PHASE.cancelled]);
    expect(fixture.store.getRun(record.id)?.status).toBe('running');
    expect(semaphore.busy()).toBe(0);
    expect(fixture.manager.isActive(record.id)).toBe(true);

    // The closed timer owes no wake: it never resolves and nothing is delivered.
    expect(fixture.store.getRun(record.id)?.waits?.some(entry => entry.id === wait.id)).not.toBe(true);
    expect(fixture.store.getRun(record.id)?.lastWaits?.some(entry => entry.phase === 'delivered')).not.toBe(true);
    const events = readFileSync(join(fixture.repoRoot, '.ai/cezar/runs', `${record.id}.ndjson`), 'utf8');
    expect(events.includes(eventNeedle)).toBe(true);
    expect(fixture.manager.isActive(record.id)).toBe(true);
  }, 30_000);

  it('a passive backend diagnostic keeps a parked monitor wakeable', async () => {
    fixture.manager.dispose();
    const semaphore = new WorkspaceSemaphore({ home: testHome(), initial: { monitoringWakeIntervalMinutes: 0.01, maxMonitoringSessions: 0 } });
    fixture.manager = createFixtureManager(fixture.store, fixture.repoRoot, { home: testHome(), semaphore });
    const record = fixture.manager.startRun(SINGLE_STEP, { task: 'mock:schedule-wakeup keep going', runner: 'claude', worktree: false });
    fixture.currentId = record.id;
    await waitFor(record.id, (r) => r?.status === 'waiting' && Boolean(monitoringWakeOf(r)));

    const wakeTimer = monitoringTimerWait(fixture.store.getRun(record.id));
    runnerHook.uiEvent({ type: 'session.error', message: 'late non-fatal diagnostic', fatal: false });

    expect(fixture.store.getRun(record.id)?.status).toBe('waiting');
    expect(monitoringTimerWait(fixture.store.getRun(record.id))).toEqual(wakeTimer);
    expect(fixture.store.getRun(record.id)?.status).toBe('waiting');
    expect(semaphore.busy()).toBe(1);
    await waitFor(record.id, () => {
      const events = readFileSync(join(fixture.repoRoot, '.ai/cezar/runs', `${record.id}.ndjson`), 'utf8');
      return events.includes('automatic monitoring wake-up (1/40)');
    });
  }, 30_000);
});
