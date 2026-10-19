import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { workerCancelWaitResultSchema, workerWaitResultSchema } from '@open-mercato/cezar-contract/delegation';
import type { Wait } from '@open-mercato/cezar-contract/waits';
import { CiWatcherSupervisor } from '../ci-wait/supervisor.ts';
import {
  collect, controlledWire, fixtureUpdateRun, manager, parent, root, store, until, useWorkerWaitFixture, worker,
} from './worker-wait.testkit.ts';

/**
 * Worker waits in the wait list (hearsay-tools/cezarion#1235 phase 3a): `cezar_wait({ kind:
 * 'worker' })` and `cez worker wait` open one `worker` entry each, beside CI, timer and human
 * waits; it resolves through `resolveWait`, is cancelled through the list, and answers the legacy
 * `WorkerWait` shape to the CLI.
 */

const pr = 'https://github.com/acme/repo/pull/12';
const identity = { prUrl: pr, repository: 'acme/repo', prNumber: 12, headSha: 'a'.repeat(40) };

type Engine = { active: Map<string, { ciGeneration?: string }> };
const engine = () => manager as unknown as Engine;
const handlers = (runId: string) => manager.cezarToolHandlers(runId, engine().active.get(runId)!.ciGeneration!);
const entryOf = (runId: string, waitId: string): Wait | undefined => store.getRun(runId)?.waits?.find(wait => wait.id === waitId);
const settledOf = (runId: string, waitId: string): Wait | undefined => store.getRun(runId)?.lastWaits?.find(wait => wait.id === waitId);
const inputOf = (runId: string, id: string) => store.getRun(runId)?.agentInputs?.find(input => input.id === id);

/** A parent whose first turn is held until `release()`: registrations happen mid-turn. */
async function heldParent() {
  const gate = join(root, `release-${randomUUID()}`);
  const wire = controlledWire({ firstResultGate: gate });
  const run = await parent(); await until(wire.initialReceived);
  return { run, release: () => writeFileSync(gate, 'release') };
}

/** A stopped and collected worker: settled, so it blocks no finish, and a wait on it resolves at once. */
async function settledWorker(parentId: string) {
  const w = await worker(parentId);
  manager.requestWorkerStop(w.id);
  // bound: real process termination, the same budget the worker-wait suites use.
  expect(await manager.awaitRunTermination(w.id, 15_000)).toBe(true);
  await collect(w.id);
  return w;
}

function destroyed(workerId: string) {
  const delegation = store.getRun(workerId)!.delegation;
  if (delegation?.role !== 'worker') throw Error('worker fixture');
  store.commitDelegation([{ id: workerId, delegation: { ...delegation, destroy: { requestedAt: new Date().toISOString(), phase: 'complete', remaining: [] } } }]);
}

describe('worker waits in the wait list', { timeout: 30_000 }, () => {
  useWorkerWaitFixture();
  afterEach(() => vi.restoreAllMocks());

  it('cezar_wait worker registers an entry beside an open ci wait', async () => {
    vi.spyOn(CiWatcherSupervisor.prototype, 'resolve').mockResolvedValue(identity);
    vi.spyOn(CiWatcherSupervisor.prototype, 'watch').mockReturnValue(new Promise(() => {}));
    const { run: p, release } = await heldParent();
    try {
      const w = await worker(p.id);
      const tools = handlers(p.id);
      const ci = await tools.registerWait({ kind: 'ci', pr, timeout_seconds: 600 }, 'cezar_wait');
      expect(ci.answer).toMatchObject({ ok: true, kind: 'ci' });
      const answer = (await tools.registerWait({ kind: 'worker', worker_ids: [w.id], timeout_seconds: 600 }, 'cezar_wait')).answer;
      expect(answer).toMatchObject({ ok: true, kind: 'worker' });
      if (!answer.ok) throw Error('refused');
      expect(answer.open_waits.map(wait => wait.kind).sort()).toEqual(['ci', 'worker']);
      expect(entryOf(p.id, answer.wait_id)).toMatchObject({ kind: 'worker', via: 'cezar_wait', phase: 'open', workerIds: [w.id], outcomes: [], revisions: [{ workerId: w.id, revision: 0 }] });
      const delegation = store.getRun(p.id)?.delegation;
      expect(delegation?.role === 'root' ? delegation.wait : undefined).toBeUndefined();
    } finally { release(); }
  });

  it('same workers and mode return the same wait id', async () => {
    const { run: p, release } = await heldParent();
    try {
      const a = await worker(p.id); const b = await worker(p.id);
      const first = manager.registerWorkerListWait(p.id, { workerIds: [a.id, b.id], timeoutSeconds: 600 }, 'cez-worker-wait');
      const again = manager.registerWorkerListWait(p.id, { workerIds: [b.id, a.id], mode: 'any', timeoutSeconds: 30 }, 'cezar_wait');
      expect(again.id).toBe(first.id);
      const all = manager.registerWorkerListWait(p.id, { workerIds: [a.id, b.id], mode: 'all', timeoutSeconds: 600 }, 'cezar_wait');
      expect(all.id).not.toBe(first.id);
      expect(store.getRun(p.id)?.waits?.filter(wait => wait.kind === 'worker')).toHaveLength(2);
    } finally { release(); }
  });

  it('a 17th wait is refused with capacity', async () => {
    const { run: p, release } = await heldParent();
    try {
      const ids: string[] = [];
      for (let i = 0; i < 5; i++) ids.push((await worker(p.id)).id);
      // Sixteen distinct subsets of five workers: sixteen different waits.
      const subsets = Array.from({ length: 31 }, (_, mask) => ids.filter((_, bit) => (mask + 1) & (1 << bit)));
      for (const subset of subsets.slice(0, 16)) manager.registerWorkerListWait(p.id, { workerIds: subset, timeoutSeconds: 600 }, 'cezar_wait');
      expect(store.getRun(p.id)?.waits?.filter(wait => wait.phase === 'open')).toHaveLength(16);
      expect(() => manager.registerWorkerListWait(p.id, { workerIds: subsets[16]!, timeoutSeconds: 600 }, 'cezar_wait'))
        .toThrow(expect.objectContaining({ code: 'capacity_limit' }));
      const answer = (await handlers(p.id).registerWait({ kind: 'worker', worker_ids: subsets[17]!, timeout_seconds: 600 }, 'cezar_wait')).answer;
      expect(answer).toMatchObject({ ok: false, code: 'capacity' });
      // A repeat of an open wait is not a new one, and is still answered at capacity.
      expect(manager.registerWorkerListWait(p.id, { workerIds: subsets[0]!, timeoutSeconds: 600 }, 'cezar_wait').phase).toBe('open');
    } finally { release(); }
  });

  it('resolves mid-turn and delivers at the boundary', async () => {
    const { run: p, release } = await heldParent();
    const w = await worker(p.id);
    const entry = manager.registerWorkerListWait(p.id, { workerIds: [w.id], timeoutSeconds: 600 }, 'cezar_wait');
    fixtureUpdateRun(w.id, { status: 'done' });
    manager.reconcileWorkerWaits();
    expect(entryOf(p.id, entry.id)).toMatchObject({ phase: 'resolved', result: { reason: 'outcome' }, outcomes: [{ workerId: w.id, status: 'done' }] });
    // Owed, not delivered: the turn in progress takes nothing until its own end.
    expect(inputOf(p.id, entry.id)).toMatchObject({ source: 'lifecycle' });
    expect(inputOf(p.id, entry.id)?.text).toContain(`Worker wait ${entry.id} (terminal outcome)`);
    expect(inputOf(p.id, entry.id)?.deliveredAt).toBeUndefined();
    release();
    await until(() => settledOf(p.id, entry.id)?.phase === 'delivered');
    expect(inputOf(p.id, entry.id)?.deliveredAt).toBeDefined();
    expect(store.readEvents(p.id).filter(event => event.type === 'worker-outcome')).toHaveLength(1);
  });

  it('a destroyed worker resolves a parked wait and cancels a live-turn wait', async () => {
    const { run: p, release } = await heldParent();
    const live = await worker(p.id);
    const during = manager.registerWorkerListWait(p.id, { workerIds: [live.id], timeoutSeconds: 600 }, 'cezar_wait');
    // Settled first, so its result is owed, then destroyed while the turn still runs.
    fixtureUpdateRun(live.id, { status: 'done' });
    expect(entryOf(p.id, during.id)?.phase).toBe('resolved');
    destroyed(live.id);
    manager.reconcileWorkerWaits();
    // The executing turn can move on: nothing is left to await, and no wake is owed.
    expect(entryOf(p.id, during.id)).toBeUndefined();
    expect(settledOf(p.id, during.id)?.phase).toBe('cancelled');
    expect(inputOf(p.id, during.id)).toBeUndefined();
    release();
    await until(() => store.getRun(p.id)?.status === 'waiting');
    const parked = await worker(p.id);
    const later = manager.registerWorkerListWait(p.id, { workerIds: [parked.id], timeoutSeconds: 600 }, 'cezar_wait');
    await until(() => store.getRun(p.id)?.status === 'waiting');
    fixtureUpdateRun(parked.id, { status: 'done' }); destroyed(parked.id);
    manager.reconcileWorkerWaits();
    // A parked parent still wakes for it.
    await until(() => settledOf(p.id, later.id)?.phase === 'delivered');
    expect(inputOf(p.id, later.id)?.deliveredAt).toBeDefined();
  });

  it('root finish pending refuses registration and cancels on settle', async () => {
    const { run: p, release } = await heldParent();
    try {
      // A settled, collected worker: nothing blocks the finish, and its wait resolves at once (owed).
      const w = await settledWorker(p.id);
      const entry = manager.registerWorkerListWait(p.id, { workerIds: [w.id], timeoutSeconds: 600 }, 'cezar_wait');
      expect(entryOf(p.id, entry.id)?.phase).toBe('resolved');
      // The intent a Finish on the parked root commits (`commitRootFinishIntent`), written mid-turn.
      const delegation = store.getRun(p.id)!.delegation;
      if (delegation?.role !== 'root') throw Error('root fixture');
      store.commitDelegation([{ id: p.id, delegation: { ...delegation, finishRequestedAt: new Date().toISOString() } }]);
      expect(() => manager.registerWorkerListWait(p.id, { workerIds: [w.id], mode: 'all', timeoutSeconds: 600 }, 'cezar_wait'))
        .toThrow(expect.objectContaining({ code: 'incompatible_state', message: expect.stringContaining('finish is pending') }));
      // The finish settles the root (`settleRequestedRootFinish` → `settleSuccess`); its terminal
      // status is what cancels every wait it still holds.
      store.updateRun(p.id, { status: 'done' });
      expect(entryOf(p.id, entry.id)).toBeUndefined();
      expect(settledOf(p.id, entry.id)?.phase).toBe('cancelled');
      expect(inputOf(p.id, entry.id)).toBeUndefined();
    } finally { release(); }
  });

  it('cez worker wait answers the legacy shape', async () => {
    const { run: p, release } = await heldParent();
    try {
      const w = await worker(p.id);
      const wait = manager.registerWorkerWait(p.id, { workerIds: [w.id], timeoutSeconds: 600 });
      expect(workerWaitResultSchema.parse({ wait, instruction: 'End your turn.' }).wait)
        .toEqual({ id: wait.id, workerIds: [w.id], revisions: [{ workerId: w.id, revision: 0 }], deadline: wait.deadline, phase: 'registered', outcomes: [], wakeId: wait.id });
      expect(entryOf(p.id, wait.id)).toMatchObject({ kind: 'worker', via: 'cez-worker-wait', phase: 'open', timeoutSeconds: 600 });
      // `cez worker wait` and `cezar_wait` land in the same list.
      expect(manager.registerWorkerListWait(p.id, { workerIds: [w.id], timeoutSeconds: 600 }, 'cezar_wait').id).toBe(wait.id);
    } finally { release(); }
  });

  it('cez worker cancel-wait cancels the entry into lastWaits and answers the legacy shape', async () => {
    const { run: p, release } = await heldParent();
    try {
      const w = await worker(p.id);
      const wait = manager.registerWorkerWait(p.id, { workerIds: [w.id], timeoutSeconds: 600 });
      const cancelled = workerCancelWaitResultSchema.parse({ wait: manager.cancelWorkerWait(p.id, wait.id) }).wait;
      expect(cancelled).toMatchObject({ id: wait.id, phase: 'wake-pending', reason: 'cancelled', wakeId: wait.id });
      expect(entryOf(p.id, wait.id)).toBeUndefined();
      expect(settledOf(p.id, wait.id)?.phase).toBe('cancelled');
      // A cancelled wait wakes nothing.
      expect(store.getRun(p.id)?.agentInputs ?? []).toEqual([]);
      expect(manager.cancelWorkerWait(p.id, wait.id)).toEqual(cancelled);
      expect(() => manager.cancelWorkerWait(p.id, randomUUID())).toThrow(expect.objectContaining({ code: 'incompatible_state' }));
    } finally { release(); }
  });

  it('deadline resolves with timeout and the lifecycle text says deadline reached', async () => {
    const { run: p, release } = await heldParent();
    const w = await worker(p.id);
    const entry = manager.registerWorkerListWait(p.id, { workerIds: [w.id], timeoutSeconds: 1 }, 'cezar_wait');
    release();
    await until(() => settledOf(p.id, entry.id)?.phase === 'delivered');
    expect(settledOf(p.id, entry.id)).toMatchObject({ result: { reason: 'timeout' } });
    expect(inputOf(p.id, entry.id)?.text).toContain(`Worker wait ${entry.id} (deadline reached)`);
    expect(store.getRun(w.id)?.status).toBe('queued');
  });

  it('a timer resolving beside an agent worker wait wakes the run and the worker wait stays open', async () => {
    const { run: p, release } = await heldParent();
    const w = await worker(p.id);
    const tools = handlers(p.id);
    const workers = (await tools.registerWait({ kind: 'worker', worker_ids: [w.id], timeout_seconds: 600 }, 'cezar_wait')).answer;
    const timer = (await tools.registerWait({ kind: 'timer', seconds: 60, note: 'beside workers' }, 'cezar_wait')).answer;
    if (!workers.ok || !timer.ok) throw Error('refused');
    release();
    await until(() => store.getRun(p.id)?.status === 'waiting');
    (manager as unknown as { waitTimers: Map<string, { timer: { _onTimeout(): void } }> }).waitTimers.get(timer.wait_id)!.timer._onTimeout();
    await until(() => settledOf(p.id, timer.wait_id)?.phase === 'delivered' && store.getRun(p.id)?.status === 'waiting');
    expect(inputOf(p.id, timer.wait_id)?.deliveredAt).toBeDefined();
    expect(entryOf(p.id, workers.wait_id)).toMatchObject({ kind: 'worker', phase: 'open', workerIds: [w.id] });
    expect(inputOf(p.id, workers.wait_id)).toBeUndefined();
    expect(store.getRun(w.id)?.status).toBe('queued');
  });

  it('cezar_done is not refused by an agent worker wait and cancels it', async () => {
    const { run: p, release } = await heldParent();
    // A reviewing, collected worker blocks no finish; a request to it stays unanswered, so the wait
    // on its reply stays open.
    const w = await worker(p.id);
    fixtureUpdateRun(w.id, { status: 'review' });
    await collect(w.id);
    const request = { id: randomUUID(), senderRunId: p.id, recipientRunId: w.id, kind: 'request' as const, text: 'one more thing?',
      createdAt: new Date().toISOString(), requestHash: 'a'.repeat(64), state: 'accepted' as const };
    store.commitConversation(p.id, { messages: [request], outcomes: [] });
    const entry = manager.registerWorkerListWait(p.id, { requestIds: [request.id], timeoutSeconds: 600 }, 'cezar_wait');
    expect(entryOf(p.id, entry.id)?.phase).toBe('open');
    expect(await handlers(p.id).finishTurn({})).toMatchObject({ ok: true, finishes: 'at_turn_end' });
    release();
    await until(() => !manager.isActive(p.id));
    expect(store.getRun(p.id)?.waits ?? []).toEqual([]);
    expect(settledOf(p.id, entry.id)?.phase).toBe('cancelled');
    expect(inputOf(p.id, entry.id)).toBeUndefined();
  });
});
