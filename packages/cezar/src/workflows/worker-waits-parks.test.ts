import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RUN_STATUS, WAIT_KIND, WAIT_PHASE, WORKER_OUTCOME_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { observationClock } from '../core/observation-clock.testkit.ts';
import { CiWatcherSupervisor } from '../ci-wait/supervisor.ts';
import { acquireCiResources } from '../ci-wait/resources.ts';
import { readPersistedRuns } from '../runs/run-store.testkit.ts';
import { HARNESS_ADAPTERS } from '../core/harness-parity.testkit.ts';
import { IDLE_TIMEOUT_MS } from './run.ts';
import { gatedProviderFailure } from './waits-parity.testkit.ts';
import { fixtureUpdateRun, manager, parent, restart, root, semaphore, store, until, useWorkerWaitFixture, worker, work, toolGenerationOf, controlledWire } from './worker-wait.testkit.ts';

import { pr, identity, entryOf, settledOf, inputOf, heldParent } from './worker-waits-shared.testkit.ts';

/**
 * Parks, slots, idle close, failure and recovery (hearsay-tools/cezarion#1235 phase 3a): a park
 * whose top wait is `workers` holds no slot and arms the idle timer, as a human park does; a
 * session that fails or closes cleanly with a worker wait open leaves the run `waiting` and the
 * next resolution reopens it; a restart re-arms deadlines and re-observes outcomes.
 */
describe('worker parks, slots and session close', { timeout: 45_000 }, () => {
  useWorkerWaitFixture({ acquireCiResources });
  afterEach(() => vi.restoreAllMocks());

  const parkedOn = (runId: string, waitId: string) =>
    store.getRun(runId)?.status === 'waiting' && entryOf(runId, waitId)?.phase === 'open' && manager.isActive(runId);
  const idleClock = () => observationClock(delay => delay === IDLE_TIMEOUT_MS &&
    /\bat (?:[^ (\n]+\.)?armIdleTimer \(/.test(new Error().stack ?? ''));

  // A competing timer park consumes the sole monitoring exemption.
  async function expectPoolCapacity(id: string, member: boolean) {
    const limit = vi.spyOn(semaphore, 'maxMonitoringSessions').mockReturnValue(1);
    const competitor = await parent('mock:cezar-wait');
    try {
      await until(() => store.getRun(competitor.id)?.status === 'waiting' &&
        store.getRun(competitor.id)?.waits?.some(wait => wait.kind === WAIT_KIND.timer && wait.phase === WAIT_PHASE.open) === true);
      expect(semaphore.busy(), `monitoring capacity for ${id}`).toBe(member ? 1 : 0);
    } finally {
      manager.cancel(competitor.id);
      await until(() => !manager.isActive(competitor.id));
      limit.mockRestore();
    }
  }

  it('a worker park holds no slot at maxParallel 1 and its worker runs', async () => {
    const clock = idleClock();
    const { run: p, release } = await heldParent();
    const w = await worker(p.id);
    const entry = manager.registerWorkerListWait(p.id, { workerIds: [w.id], timeoutSeconds: 600 }, 'cezar_wait');
    release();
    await until(() => parkedOn(p.id, entry.id));
    await expectPoolCapacity(p.id, false);
    const wire = controlledWire({ firstResultGate: join(root, 'worker-release') });
    manager.enqueueOwnedRun(w.id);
    await until(wire.initialReceived);
    await until(() => store.readEvents(w.id).some(event => event.type === 'turn.started'));
    expect(semaphore.busy()).toBe(1);
    expect(store.getRun(p.id)?.status).toBe('waiting');
    expect(entryOf(p.id, entry.id)?.phase).toBe('open');
    // The parked parent's idle timer bounds its open session.
    await clock.advance(IDLE_TIMEOUT_MS);
    await until(() => !manager.isActive(p.id));
    expect(store.readEvents(p.id).some(event => event.type === 'lifecycle' && String(event.message).includes('of inactivity'))).toBe(true);
  });

  it('a worker park idle-closes after IDLE_TIMEOUT_MS and a resolution reopens it', async () => {
    const { run: p, release } = await heldParent();
    const w = await worker(p.id);
    // A deadline past the idle window, so only the idle timer fires.
    const entry = manager.registerWorkerListWait(p.id, { workerIds: [w.id], timeoutSeconds: 1800 }, 'cezar_wait');
    const clock = idleClock();
    release();
    await until(() => parkedOn(p.id, entry.id));
    await clock.advance(IDLE_TIMEOUT_MS - 1_000);
    expect(manager.isActive(p.id)).toBe(true);
    await clock.advance(1_000);
    await until(() => !manager.isActive(p.id));
    expect(store.readEvents(p.id).some(event => event.type === 'lifecycle' && String(event.message).includes('of inactivity'))).toBe(true);
    expect(store.getRun(p.id)).toMatchObject({ status: RUN_STATUS.waiting });
    expect(store.getRun(p.id)?.error).toBeUndefined();
    expect(entryOf(p.id, entry.id)?.phase).toBe('open');
    const resumed = vi.spyOn(manager, 'continueRun');
    fixtureUpdateRun(w.id, { status: RUN_STATUS.done });
    await until(() => settledOf(p.id, entry.id)?.phase === 'delivered');
    expect(resumed).toHaveBeenCalledWith(p.id, { text: 'Resume to receive the queued worker wait result. End this opening turn so Cezar can deliver it.', waitWake: true }, true);
    expect(inputOf(p.id, entry.id)?.deliveredAt).toBeDefined();
  });

  it('clean close with a worker wait open parks waiting with no error', async () => {
    const { run: p, release } = await heldParent();
    const w = await worker(p.id);
    const entry = manager.registerWorkerListWait(p.id, { workerIds: [w.id], timeoutSeconds: 600 }, 'cezar_wait');
    release();
    await until(() => parkedOn(p.id, entry.id));
    expect(work.liveSessions.size).toBe(1);
    [...work.liveSessions][0]!.end();
    await until(() => !manager.isActive(p.id));
    expect(store.getRun(p.id)).toMatchObject({ status: RUN_STATUS.waiting });
    expect(store.getRun(p.id)?.error).toBeUndefined();
    expect(store.getRun(p.id)?.steps.at(-1)?.error).toBeUndefined();
    expect(entryOf(p.id, entry.id)?.phase).toBe('open');
    fixtureUpdateRun(w.id, { status: RUN_STATUS.done });
    await until(() => settledOf(p.id, entry.id)?.phase === 'delivered');
    expect(inputOf(p.id, entry.id)?.deliveredAt).toBeDefined();
  });

  it('provider failure with a worker wait open parks and the next resolution delivers', async () => {
    const wire = gatedProviderFailure(root, 'claude');
    const p = await parent(HARNESS_ADAPTERS.claude.scenarios['provider-error-controlled']!);
    await until(wire.held);
    const w = await worker(p.id);
    const entry = manager.registerWorkerListWait(p.id, { workerIds: [w.id], timeoutSeconds: 600 }, 'cezar_wait');
    wire.release();
    await until(() => store.readEvents(p.id).some(event => event.type === 'error'));
    await until(() => !manager.isActive(p.id));
    expect(store.getRun(p.id)?.status).toBe('waiting');
    expect(entryOf(p.id, entry.id)?.phase).toBe('open');
    fixtureUpdateRun(w.id, { status: RUN_STATUS.done });
    await until(() => settledOf(p.id, entry.id)?.phase === 'delivered');
    expect(inputOf(p.id, entry.id)?.deliveredAt).toBeDefined();
    await until(() => store.getRun(p.id)?.status === 'waiting');
  });

  it('restart re-arms worker deadlines and re-observes outcomes', async () => {
    const { run: p, release } = await heldParent();
    const settles = await worker(p.id); const idle = await worker(p.id);
    const observed = manager.registerWorkerListWait(p.id, { workerIds: [settles.id], timeoutSeconds: 600 }, 'cezar_wait');
    const deadline = manager.registerWorkerListWait(p.id, { workerIds: [idle.id], timeoutSeconds: 600 }, 'cezar_wait');
    release();
    await until(() => parkedOn(p.id, observed.id));
    store.flush();
    const before = readPersistedRuns(join(root, '.ai/cezar')) as Array<{ id: string }>;
    // The worker settles durably, and the process dies before the parent observes it.
    fixtureUpdateRun(settles.id, { status: RUN_STATUS.done });
    store.flush();
    const after = readPersistedRuns(join(root, '.ai/cezar')) as Array<{ id: string }>;
    // bound: the registered 600 s deadline exceeds the 45 s row guard; fake timers drive expiry.
    const disk = before.map(record => record.id === settles.id ? after.find(next => next.id === settles.id)! : record);
    expect(disk.find(record => record.id === p.id)).toMatchObject({ waits: expect.arrayContaining([expect.objectContaining({ id: observed.id, phase: WAIT_PHASE.open })]) });
    const deadlineClock = observationClock(delay => delay !== undefined && delay > 0 &&
      /\bat (?:[^ (\n]+\.)?armWorkerDeadline \(/.test(new Error().stack ?? ''));
    await restart(false, disk);
    expect(entryOf(p.id, deadline.id)).toMatchObject({ phase: WAIT_PHASE.open, deadline: deadline.deadline });
    await until(() => settledOf(p.id, observed.id)?.phase === 'delivered');
    expect(settledOf(p.id, observed.id)).toMatchObject({ result: { reason: 'outcome' }, outcomes: [{ workerId: settles.id, status: WORKER_OUTCOME_STATUS.done }] });
    await until(() => store.getRun(p.id)?.status === 'waiting');
    // The deadline of the wait still open is armed again; its expiry wakes the parent.
    const clockDate = vi.spyOn(Date.prototype, 'toISOString').mockReturnValue(deadline.deadline);
    try { deadlineClock.fire(deadlineClock.captured - 1); } finally { clockDate.mockRestore(); }
    await until(() => settledOf(p.id, deadline.id)?.phase === 'delivered');
    expect(settledOf(p.id, deadline.id)).toMatchObject({ result: { reason: 'timeout' } });
  });

  it('ci + worker open: top wait workers holds no slot; after the worker wait resolves and is delivered, the ci park keeps a monitoring slot', async () => {
    vi.spyOn(CiWatcherSupervisor.prototype, 'resolve').mockResolvedValue(identity);
    vi.spyOn(CiWatcherSupervisor.prototype, 'watch').mockReturnValue(new Promise(() => {}));
    const clock = idleClock();
    const { run: p, release } = await heldParent();
    const w = await worker(p.id);
    const tools = manager.squawkToolHandlers(p.id, toolGenerationOf(p.id));
    const ci = (await tools.registerWait({ kind: WAIT_KIND.pr, pr, timeout_seconds: 600 }, 'cezar_wait', new AbortController().signal)).answer;
    const workers = (await tools.registerWait({ kind: WAIT_KIND.worker, worker_ids: [w.id], timeout_seconds: 600 }, 'cezar_wait', new AbortController().signal)).answer;
    if (!ci.ok || !workers.ok) throw Error('refused');
    release();
    await until(() => parkedOn(p.id, workers.wait_id));
    await expectPoolCapacity(p.id, false);
    expect(manager.isActive(p.id)).toBe(true);
    fixtureUpdateRun(w.id, { status: RUN_STATUS.done });
    await until(() => settledOf(p.id, workers.wait_id)?.phase === 'delivered' && store.getRun(p.id)?.status === 'waiting');
    expect(entryOf(p.id, ci.wait_id)?.phase).toBe('open');
    await expectPoolCapacity(p.id, true);
    // A CI park needs no idle timer: its slot is the monitoring pool's.
    await clock.advance(IDLE_TIMEOUT_MS);
    expect(manager.isActive(p.id)).toBe(true);
    expect(entryOf(p.id, ci.wait_id)?.phase).toBe('open');
  });
});
