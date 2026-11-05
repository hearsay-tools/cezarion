import { RUN_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { afterEach, expect, it, vi } from 'vitest';
import { observationClock } from '../core/observation-clock.testkit.ts';
import { useBoundaryRunner } from './boundary-runner.testkit.ts';
import { setupMonitoringFixture, waitForProduct } from './run-fixture.testkit.ts';

const f = setupMonitoringFixture();
const runner = useBoundaryRunner();
afterEach(() => vi.restoreAllMocks());

async function readyRelease() {
  const release = vi.spyOn(f.semaphore, 'release');
  const run = f.manager.startRun(f.SINGLE_STEP, { task: 'slot holder', runner: 'claude', worktree: false });
  f.currentId = run.id;
  await waitForProduct(f.manager, f.store, () => runner.sessions.length === 1);
  await f.semaphore.release();
  await Promise.all(release.mock.results.map(result => result.value));
  return () => runner.emitUi({ type: 'permission.requested', requestId: 'permission', title: 'shell', options: [] });
}

function hold(offset: number) {
  const row = f.store.createRun({ title: 'hold', task: 'work', workflow: 'quick-task', runner: 'claude', steps: [] });
  const deadline = new Date(Date.now() + offset).toISOString();
  f.store.move(row.id, 'start');
  f.store.move(row.id, 'fail', { error: 'provider usage limit' });
  f.store.move(row.id, 'hold', { autoResumeAt: deadline, error: 'provider usage limit' });
  return { id: row.id, deadline };
}

function observeAutoResume() {
  const delays: Array<number | undefined> = [];
  const clock = observationClock(delay => {
    if (!/\bAutoResumeScheduler\.armAutoResume\b/.test(new Error().stack ?? '')) return false;
    delays.push(delay);
    return true;
  });
  return { clock, delays };
}

it('release arms future hold timer before return', async () => {
  const release = await readyRelease();
  const { id, deadline } = hold(3_600_000);
  const { clock, delays } = observeAutoResume();
  release();
  // No await: reconciliation is part of release's synchronous prefix.
  const atReturn = structuredClone(f.store.getRun(id));
  expect(clock.pending).toBe(1);
  expect(delays[0]).toBeGreaterThan(0);
  expect(delays[0]).toBeLessThanOrEqual(3_600_000);
  expect(atReturn).toMatchObject({ status: RUN_STATUS.waiting, autoResumeAt: deadline });
  expect(f.manager.isActive(id)).toBe(false);
});

it('release arms due-now timer before return', async () => {
  const release = await readyRelease();
  const { id, deadline } = hold(-1);
  const { clock, delays } = observeAutoResume();
  release();
  const atReturn = structuredClone(f.store.getRun(id));
  expect(clock.pending).toBe(1);
  expect(delays).toEqual([0]);
  expect(atReturn).toMatchObject({ status: RUN_STATUS.waiting, autoResumeAt: deadline });
  // This seeded hold has no session to continue. The ordinary admission refuses it.
  clock.fire(0);
  expect(f.store.getRun(id)?.status).toBe('failed');
  expect(f.store.getRun(id)?.autoResumeAt).toBeUndefined();
  expect(f.store.readEvents(id)).toEqual(expect.arrayContaining([
    expect.objectContaining({ type: 'note', message: expect.stringContaining('automatic resume could not start') }),
  ]));
});

it('release withdraws missed hold before return', async () => {
  const release = await readyRelease();
  const { id } = hold(-25 * 60 * 60_000);
  const { clock, delays } = observeAutoResume();
  release();
  const atReturn = structuredClone(f.store.getRun(id));
  expect(atReturn?.status).toBe('failed');
  expect(atReturn?.autoResumeAt).toBeUndefined();
  expect(clock.pending).toBe(0);
  expect(delays).toEqual([]);
  expect(f.store.readEvents(id)).toEqual(expect.arrayContaining([
    expect.objectContaining({ type: 'note', message: expect.stringContaining('automatic resume expired') }),
  ]));
});
