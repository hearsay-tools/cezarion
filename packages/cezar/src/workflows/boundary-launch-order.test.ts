import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useBoundaryRunner } from './boundary-runner.testkit.ts';
import { setupMonitoringFixture, waitForProduct } from './run-fixture.testkit.ts';
import { traceBoundary } from './run/boundary-order.testkit.ts';
import type { ActiveRun } from './active-run.ts';
import * as sessionEvents from './run/session-events.ts';
import * as receipts from './run/input-receipts.ts';

const f = setupMonitoringFixture();
const log: string[] = [];
const runner = useBoundaryRunner(log);
const { sessions } = runner;
const states: ActiveRun[] = [];
let observeRetirement: () => void = () => {};
beforeEach(() => {
  log.length = 0; sessions.length = 0; states.length = 0;
  observeRetirement = () => {};
  traceBoundary(log, (state, event) => {
    if (event.kind === 'session-open' && event.phase === 'scope-step') {
      expect(state.liveSession.session).toBe(event.session);
      expect(state.liveSession.sessionEverOpened).not.toBe(true);
      states.push(state);
    }
    if (event.kind === 'session-retired') expect(state.liveSession.session).toBe(event.session);
  }, (_state, event) => { if (event.kind === 'session-retired') observeRetirement(); });
  const preamble = sessionEvents.launchPreamble;
  vi.spyOn(sessionEvents, 'launchPreamble').mockImplementation((...args) => { log.push('preamble'); return preamble(...args); });
  const result = receipts.sessionResultWithReceipts;
  vi.spyOn(receipts, 'sessionResultWithReceipts').mockImplementation((...args) => { log.push('receipt-setup'); return result(...args); });

});

it('retirement releases pool membership and unpark before resetting the boundary', async () => {
  const row = f.manager.startRun(f.SINGLE_STEP, { task: 'monitor', runner: 'claude', worktree: false });
  f.currentId = row.id;
  await waitForProduct(f.manager, f.store, () => sessions.length === 1);
  runner.emitAgent({ type: 'tool-call', id: 'schedule', tool: 'ScheduleWakeup', input: { delaySeconds: 3600 } });
  runner.emitAgent({ type: 'turn-end' });
  expect(f.store.getRun(row.id)?.status).toBe('waiting');
  expect(f.semaphore.busy()).toBe(0);
  const limit = vi.spyOn(f.semaphore, 'maxMonitoringSessions').mockReturnValue(0);
  expect(f.semaphore.busy()).toBe(1); // A pool member keeps its regular slot without an exemption.
  const atReset: number[][] = [];
  observeRetirement = () => {
    limit.mockReturnValue(0);
    const withoutExemption = f.semaphore.busy();
    limit.mockReturnValue(1);
    atReset.push([withoutExemption, f.semaphore.busy()]);
  };
  sessions[0]!.end();
  await waitForProduct(f.manager, f.store, () => !f.manager.isActive(row.id));
  // Before unpark, a nonmember costs zero. Before leavePool, changing the exemption changes the count.
  expect(atReset).toEqual([[1, 1]]);
  expect(f.semaphore.busy()).toBe(0);
});
afterEach(() => vi.restoreAllMocks());

it('fresh and continued attach and retire keep boundary reset order', async () => {
  const row = f.manager.startRun(f.SINGLE_STEP, { task: 'work', runner: 'claude', worktree: false });
  f.currentId = row.id;
  await waitForProduct(f.manager, f.store, () => sessions.length === 1);
  expect(log).toEqual(['boundary:session-open/reset-step', 'preamble', 'launch', 'boundary:session-open/scope-step', 'receipt-setup']);
  sessions[0]!.end();
  await waitForProduct(f.manager, f.store, () => !f.manager.isActive(row.id));
  expect(log.indexOf('close')).toBeLessThan(log.indexOf('boundary:session-retired/reset'));
  expect(states[0]!.liveSession.session).toBeUndefined();
  expect(states[0]!.boundary.nextStep).toBeUndefined();
  log.length = 0;
  expect(f.manager.continueRun(row.id, { text: 'Continue' })).toEqual({ ok: true });
  await waitForProduct(f.manager, f.store, () => sessions.length === 2);
  expect(log).toEqual(['boundary:session-open/restore-question', 'preamble', 'launch', 'boundary:session-open/scope-step', 'receipt-setup']);
  sessions[1]!.end();
  await waitForProduct(f.manager, f.store, () => !f.manager.isActive(row.id));
  expect(log).toContain('boundary:done-step-consumed/consumed');
  expect(states[1]!.liveSession.session?.open).toBe(false);
  expect(sessions[1]!.open).toBe(false);
});
