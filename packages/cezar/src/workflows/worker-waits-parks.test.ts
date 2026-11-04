import { runInternals } from './run-internals.testkit.ts';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RUN_STATUS, WAIT_KIND, WAIT_PHASE, WORKER_OUTCOME_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import type { AgentSession } from '../core/agent-runner.ts';
import { CiWatcherSupervisor } from '../ci-wait/supervisor.ts';
import { readPersistedRuns } from '../runs/run-store.testkit.ts';
import { HARNESS_ADAPTERS } from '../core/harness-parity.testkit.ts';
import { IDLE_TIMEOUT_MS } from './run.ts';
import { gatedProviderFailure } from './waits-parity.testkit.ts';
import { fixtureUpdateRun, manager, parent, restart, root, semaphore, store, until, useWorkerWaitFixture, worker } from './worker-wait.testkit.ts';

import { pr, identity, handlers, entryOf, settledOf, inputOf, heldParent } from './worker-waits-shared.testkit.ts';

/**
 * Parks, slots, idle close, failure and recovery (hearsay-tools/cezarion#1235 phase 3a): a park
 * whose top wait is `workers` holds no slot and arms the idle timer, as a human park does; a
 * session that fails or closes cleanly with a worker wait open leaves the run `waiting` and the
 * next resolution reopens it; a restart re-arms deadlines and re-observes outcomes.
 */
describe('worker parks, slots and session close', { timeout: 45_000 }, () => {
  useWorkerWaitFixture();
  afterEach(() => vi.restoreAllMocks());

  type Internals = {
    active: Map<string, { session: AgentSession; idleTimer?: unknown; sessionEverOpened?: boolean }>;
  };
  const internals = () => manager as unknown as Internals;
  const parkedOn = (runId: string, waitId: string) =>
    store.getRun(runId)?.status === 'waiting' && entryOf(runId, waitId)?.phase === 'open' && internals().active.get(runId)?.session.open !== false;

  it('a worker park holds no slot at maxParallel 1 and its worker runs', async () => {
    const { run: p, release } = await heldParent();
    const w = await worker(p.id);
    const entry = manager.registerWorkerListWait(p.id, { workerIds: [w.id], timeoutSeconds: 600 }, 'cezar_wait');
    release();
    await until(() => parkedOn(p.id, entry.id));
    expect(runInternals(manager).line.monitoring.has(p.id)).toBe(false);
    expect(semaphore.busy()).toBe(0);
    // The parked parent's idle timer bounds its open session.
    expect(internals().active.get(p.id)?.idleTimer).toBeDefined();
    manager.enqueueOwnedRun(w.id);
    await until(() => internals().active.get(w.id)?.sessionEverOpened === true);
    expect(semaphore.busy()).toBe(1);
    expect(store.getRun(p.id)?.status).toBe('waiting');
    expect(entryOf(p.id, entry.id)?.phase).toBe('open');
  });

  it('a worker park idle-closes after IDLE_TIMEOUT_MS and a resolution reopens it', async () => {
    const { run: p, release } = await heldParent();
    const w = await worker(p.id);
    // A deadline past the idle window, so only the idle timer fires.
    const entry = manager.registerWorkerListWait(p.id, { workerIds: [w.id], timeoutSeconds: 1800 }, 'cezar_wait');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    release();
    await until(() => parkedOn(p.id, entry.id));
    await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS - 1_000);
    expect(manager.isActive(p.id)).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);
    vi.useRealTimers();
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
    internals().active.get(p.id)!.session.end();
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
    const p = await parent(HARNESS_ADAPTERS.claude.scenarios['provider-error']!);
    await until(wire.held);
    const w = await worker(p.id);
    const entry = manager.registerWorkerListWait(p.id, { workerIds: [w.id], timeoutSeconds: 600 }, 'cezar_wait');
    const failed = internals().active.get(p.id);
    wire.release();
    await until(() => store.readEvents(p.id).some(event => event.type === 'error'));
    await until(() => internals().active.get(p.id) !== failed);
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
    await restart(true, disk);
    expect(entryOf(p.id, deadline.id)).toMatchObject({ phase: WAIT_PHASE.open, deadline: deadline.deadline });
    expect(runInternals(manager).waitWatches.waitTimers.has(deadline.id)).toBe(true);
    await until(() => settledOf(p.id, observed.id)?.phase === 'delivered');
    expect(settledOf(p.id, observed.id)).toMatchObject({ result: { reason: 'outcome' }, outcomes: [{ workerId: settles.id, status: WORKER_OUTCOME_STATUS.done }] });
    await until(() => store.getRun(p.id)?.status === 'waiting');
    // The deadline of the wait still open is armed again; its expiry wakes the parent.
    await vi.advanceTimersByTimeAsync(Date.parse(deadline.deadline) - Date.now());
    vi.useRealTimers();
    await until(() => settledOf(p.id, deadline.id)?.phase === 'delivered');
    expect(settledOf(p.id, deadline.id)).toMatchObject({ result: { reason: 'timeout' } });
  });

  it('ci + worker open: top wait workers holds no slot; after the worker wait resolves and is delivered, the ci park keeps a monitoring slot', async () => {
    vi.spyOn(CiWatcherSupervisor.prototype, 'resolve').mockResolvedValue(identity);
    vi.spyOn(CiWatcherSupervisor.prototype, 'watch').mockReturnValue(new Promise(() => {}));
    const { run: p, release } = await heldParent();
    const w = await worker(p.id);
    const tools = handlers(p.id);
    const ci = (await tools.registerWait({ kind: WAIT_KIND.pr, pr, timeout_seconds: 600 }, 'cezar_wait', new AbortController().signal)).answer;
    const workers = (await tools.registerWait({ kind: WAIT_KIND.worker, worker_ids: [w.id], timeout_seconds: 600 }, 'cezar_wait', new AbortController().signal)).answer;
    if (!ci.ok || !workers.ok) throw Error('refused');
    release();
    await until(() => parkedOn(p.id, workers.wait_id));
    expect(runInternals(manager).line.monitoring.has(p.id)).toBe(false);
    expect(semaphore.busy()).toBe(0);
    expect(internals().active.get(p.id)?.idleTimer).toBeDefined();
    fixtureUpdateRun(w.id, { status: RUN_STATUS.done });
    await until(() => settledOf(p.id, workers.wait_id)?.phase === 'delivered' && store.getRun(p.id)?.status === 'waiting');
    expect(entryOf(p.id, ci.wait_id)?.phase).toBe('open');
    expect(runInternals(manager).line.monitoring.has(p.id)).toBe(true);
    // A CI park needs no idle timer: its slot is the monitoring pool's.
    expect(internals().active.get(p.id)?.idleTimer).toBeUndefined();
  });
});
