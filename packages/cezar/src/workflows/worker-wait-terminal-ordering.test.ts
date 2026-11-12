import type { AgentEvent } from '../core/agent-runner.ts';
import type { UiEvent } from '../core/ui-events.ts';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { type WorkerWait } from '@open-mercato/cezar-contract/delegation';
import { RunStore } from '../runs/store.ts';
import { captureState, controlledWire, fixtureUpdateRun, manager, parent, register, restart, root, semaphore, store, timeline, until, useWorkerWaitFixture, waitOf, workerEntryOf, worker } from './worker-wait.testkit.ts';
import { setRunStatus, blockRunWrites } from '../runs/run-store.testkit.ts';
import { RUN_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';

const runnerEvents = vi.hoisted(() => new Map<string, (event: UiEvent) => void>());
const runnerTurnEvents = vi.hoisted(() => new Map<string, (event: AgentEvent) => void>());
vi.mock('../core/runner-factory.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('../core/runner-factory.ts')>();
  return { ...actual, createRunner: (...args: Parameters<typeof actual.createRunner>) => {
    const runner = actual.createRunner(...args);
    const start = runner.startSession.bind(runner);
    runner.startSession = (spec, ...rest) => {
      if (rest[0]) runnerTurnEvents.set(spec.cwd, rest[0]);
      const onUiEvent = rest[1]?.onUiEvent;
      if (onUiEvent) runnerEvents.set(spec.cwd, onUiEvent);
      return start(spec, ...rest);
    };
    return runner;
  } };
});

// Real Git, durable fsync checkpoints and process shutdown share this outer budget.
// Keep the separate 15s state/termination assertions and actual runner timers intact.

describe('worker waits through RunManager', { timeout: 30_000 }, () => {
  useWorkerWaitFixture();
  it('preserves a delegated parent ask across restart and never uses a lifecycle prompt as its answer', async () => {
    const p = await parent('mock:cezar-ask'); const w = await worker(p.id);
    await until(() => store.readEvents(p.id).some(e => e.type === 'ask.requested'));
    const delegation = store.getRun(p.id)!.delegation!;
    if (delegation.role !== 'root') throw Error('fixture');
    // hearsay-tools/cezarion#1235: upgraded into a list entry, an overdue wait would wake beside the
    // question; one still running keeps this case about the ask.
    const wait: WorkerWait = { id: randomUUID(), workerIds: [w.id], phase: 'parked', deadline: new Date(Date.now() + 600_000).toISOString(), outcomes: [] };
    store.commitDelegation([{ id: p.id, delegation: { ...delegation, wait } }]);
    await restart(); await manager.recover();
    expect(store.getRun(p.id)?.status).toBe('waiting');
    expect(manager.isActive(p.id)).toBe(false);
    expect(manager.continueRun(p.id).ok).toBe(false);
    expect(store.readEvents(p.id).filter(e => e.type === 'human-input-delivered')).toEqual([]);
    expect(manager.continueRun(p.id, { text: 'Vitest' }).ok).toBe(true);
    // hearsay-tools/cezarion#1235: the answer withdraws nothing; the answered turn parks on the wait.
    await until(() => store.getRun(p.id)?.status === 'waiting' && waitOf(store.getRun(p.id))?.phase === 'parked' &&
      store.readEvents(p.id).some(e => e.type === 'human-input-delivered'));
    expect(waitOf(store.getRun(p.id))).toMatchObject({ id: wait.id, workerIds: [w.id] });
    expect(store.readEvents(p.id).filter(e => e.type === 'human-input-delivered')).toHaveLength(1);
  });
  // hearsay-tools/squawk#3337: a failed parent clears its wait but leaves unfinished children running.
  it('parent failed clears wait and keeps unfinished children, preserving terminal artifacts', async () => {
    const p = await parent(); const w = await worker(p.id); const done = await worker(p.id);
    fixtureUpdateRun(done.id, { status: RUN_STATUS.review }); register(p.id, [w.id]);
    setRunStatus(store, p.id, RUN_STATUS.failed);
    await until(() => waitOf(store.getRun(p.id)) === undefined);
    manager.reconcileWorkerWaits();
    expect(store.getRun(w.id)?.status).not.toBe('cancelled'); expect(store.getRun(done.id)?.status).toBe('review');
    // Its session is still live, which a settled parent never has: back to running before
    // teardown stops it (hearsay-tools/cezarion#1804).
    setRunStatus(store, p.id, RUN_STATUS.running);
  });
  for (const status of ['done', 'cancelled'] as const) {
    it(`parent ${status} clears wait and cancels unfinished children, preserving terminal artifacts`, async () => {
      const p = await parent(); const w = await worker(p.id); const done = await worker(p.id);
      fixtureUpdateRun(done.id, { status: RUN_STATUS.review }); register(p.id, [w.id]);
      setRunStatus(store, p.id, status);
      await until(() => store.getRun(w.id)?.status === 'cancelled');
      expect(waitOf(store.getRun(p.id))).toBeUndefined(); expect(store.getRun(done.id)?.status).toBe('review');
      expect(store.getRun(w.id)?.delegation?.role).toBe('worker');
      // Its session is still live, which a settled parent never has: back to running before
      // teardown stops it (hearsay-tools/cezarion#1804).
      setRunStatus(store, p.id, RUN_STATUS.running);
    });
  }
  it('persists lifecycle continuation origin through a queued restart', async () => {
    const p = await parent();
    await until(() => store.getRun(p.id)?.status === 'waiting');
    manager.finish(p.id); await until(() => !manager.isActive(p.id));
    const blocker = await parent('mock:slow');
    expect(manager.continueRun(p.id, { text: 'internal restart' }, true).ok).toBe(true);
    expect(store.getRun(p.id)?.continuationMessage).toMatchObject({ origin: 'lifecycle' });
    store.flush();
    const reopened = RunStore.open(join(root, '.ai/cezar'), { keepLive: true });
    expect(reopened.getRun(p.id)?.continuationMessage).toMatchObject({ origin: 'lifecycle' });
    reopened.flush();
    manager.cancel(blocker.id);
    await until(() => store.getRun(p.id)?.status === 'waiting');
    expect(store.readEvents(p.id).filter(e => e.type === 'user-message')).toEqual([]);
  });
  it('backend activity restores an executing parent slot without withdrawing its durable wait', async () => {
    const p = await parent(); const w = await worker(p.id);
    const wait = register(p.id, [w.id]);
    await until(() => waitOf(store.getRun(p.id))?.phase === 'parked');
    const emit = runnerEvents.get(store.getRun(p.id)!.worktreePath!);
    if (!emit) throw Error('parent runner channel missing');
    emit({ type: 'turn.started', turnId: randomUUID() });
    expect(store.getRun(p.id)?.status).toBe('running');
    expect(semaphore.busy()).toBe(1);
    expect(waitOf(store.getRun(p.id))?.id).toBe(wait.id);
  });

  it('does not release capacity before the parked intent reaches disk', async () => {
    const gate = join(root, 'park-turn-boundary');
    const wire = controlledWire({ firstResultGate: gate });
    const p = await parent(); const w = await worker(p.id);
    await until(wire.initialReceived);
    register(p.id, [w.id]); store.flush();
    const emit = runnerTurnEvents.get(store.getRun(p.id)!.worktreePath!);
    if (!emit) throw Error('parent runner turn channel missing');
    const release = blockRunWrites(join(root, '.ai/cezar'));
    try {
      expect(() => emit({ type: 'turn-end' })).toThrow();
      // Check after the entire turn handler unwinds: a caller must not catch the
      // refused checkpoint and release the parent's slot anyway.
      expect(waitOf(store.getRun(p.id))?.phase).toBe('registered');
      expect(semaphore.busy()).toBe(1);
    } finally { release(); writeFileSync(gate, 'end'); }

  });

  it('recovery admits an older queued child before an expired parent wake', async () => {
    const p = await parent(); const w = await worker(p.id, 'mock:slow');
    const explain = (stage: string) => {
      return `${stage}\n${JSON.stringify({ ...captureState(), workerExecution: store.readWorkerExecution(w.id) })}\n${timeline(p.id)}\n${timeline(w.id)}`;
    };
    // Expire the deadline only after the parent parks; mock startup must not race a 1 s budget.
    register(p.id, [w.id]);
    await until(() => waitOf(store.getRun(p.id))?.phase === 'parked', () => explain('parent wait parks before restart'));
    const entry = workerEntryOf(store.getRun(p.id));
    if (!entry) throw Error('fixture');
    store.commitWait(p.id, { ...entry, deadline: new Date().toISOString() });
    await restart();
    await until(() => store.getRun(w.id)?.status === 'running' || store.getRun(p.id)?.status === 'running',
      () => explain('recovery admits the queued child or parent wake'));
    expect(store.getRun(w.id)?.status).toBe('running');
    expect(store.getRun(p.id)?.status).toBe('queued');
    expect(store.getRun(p.id)?.agentInputs?.some(input => input.deliveredAt)).not.toBe(true);
  });

});
