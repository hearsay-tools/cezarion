import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RUN_STATUS, makeWorkerWait } from '@open-mercato/cezar-contract/test-factories.testkit';
import { type RunRecord } from '../runs/store.ts';
import { collect, fixtureUpdateRun, manager, parent, register, restart, root, store, until, useWorkerWaitFixture, waitOf, lastWaitOf, worker } from './worker-wait-claude.testkit.ts';
import { setRunStatus, readPersistedRuns } from '../runs/run-store.testkit.ts';

// Real Git, durable fsync checkpoints and process shutdown share this outer budget.
// Keep the separate 15s state/termination assertions and actual runner timers intact.

// Real Git, durable checkpoints and native process shutdown retain their original budgets.
describe('worker waits: settlement', { timeout: 30_000 }, () => {
  useWorkerWaitFixture();

it('readiness accepted worker revision invalidates a previously collected settled result', async () => {
    const p = await parent();
    await until(() => store.getRun(p.id)?.status === 'waiting');
    const w = await worker(p.id);
    manager.requestWorkerStop(w.id); expect(await manager.awaitRunTermination(w.id, 15000)).toBe(true); await collect(w.id);
    store.commitWorkerContinuation(w.id, 'continue-line');
    expect(manager.finish(p.id)).toBe(false);
    fixtureUpdateRun(w.id, { status: RUN_STATUS.done });
    expect(manager.finish(p.id)).toBe(false);
    await collect(w.id);
    expect(manager.finish(p.id)).toBe(true);
    await until(() => !manager.isActive(p.id));
  });
it('readiness closed-session refusal still queued at a crash is delivered after recovery', async () => {
    const p = await parent(); const w = await worker(p.id);
    await until(() => store.getRun(p.id)?.status === 'waiting');
    const events = new Map();
    const disk = readPersistedRuns(join(root, '.ai/cezar')) as Array<RunRecord>;
    const text = `Workers are still live: ${w.id}. u-crash`;
    const input = { id: randomUUID(), parentRunId: p.id, source: 'lifecycle' as const, text, createdAt: new Date().toISOString() };
    for (const run of disk) if (run.id === p.id) Object.assign(run, { agentInputs: [...run.agentInputs ?? [], input] });
    await restart(false, disk, events);
    await until(() => !!store.getRun(p.id)?.agentInputs?.find(entry => entry.id === input.id)?.deliveredAt);
    expect(store.getRun(p.id)?.status).not.toBe('done');
    expect(waitOf(store.getRun(p.id))).toBeUndefined();
  });
it('readiness ready human Finish retires an accepted wait before closing its session', async () => {
    const p = await parent('mock:slow'); const w = await worker(p.id);
    manager.requestWorkerStop(w.id); expect(await manager.awaitRunTermination(w.id, 15000)).toBe(true); await collect(w.id);
    register(p.id, [w.id]);
    expect(manager.finish(p.id)).toBe(true);
    await until(() => !manager.isActive(p.id));
    expect(store.getRun(p.id)?.status).toBe('done');
    expect(waitOf(store.getRun(p.id))).toBeUndefined();
  });
it('readiness discards cached unsettled observations lacking current private proof', async () => {
    const p = await parent(); const first = await worker(p.id); const second = await worker(p.id);
    const generation = store.commitWorkerExecutionStart(first.id);
    setRunStatus(store, first.id, RUN_STATUS.cancelled);
    // An agent's worker wait is a list entry (hearsay-tools/cezarion#1301).
    const now = Date.now();
    store.commitWait(p.id, makeWorkerWait({ registeredAt: new Date(now).toISOString(),
      deadline: new Date(now + 600000).toISOString(), mode: 'all',
      workerIds: [first.id, second.id], revisions: [{ workerId: first.id, revision: 0 }, { workerId: second.id, revision: 0 }],
      outcomes: [{ workerId: first.id, revision: 0, status: RUN_STATUS.cancelled, observedAt: new Date(now).toISOString() }] }));
    manager.reconcileWorkerWaits();
    expect(waitOf(store.getRun(p.id))?.outcomes).toEqual([]);
    expect(store.commitWorkerExecutionComplete(first.id, generation)).toBe(true);
    expect(waitOf(store.getRun(p.id))?.outcomes).toHaveLength(1);
  });
it('readiness Finish preserves pending parent human questions', async () => {
    const p = await parent('mock:cezar-ask'); await until(() => store.getRun(p.id)?.status === 'waiting');
    // Only a parent with workers keeps its question through Finish (hearsay-tools/cezarion#2784).
    await worker(p.id);
    expect(manager.finish(p.id)).toBe(false);
    expect(store.getRun(p.id)?.status).toBe('waiting');
    expect(store.readEvents(p.id).filter(event => event.type === 'human-input-delivered')).toEqual([]);
  });
it('all-mode replaces old observations when a selected worker accepts another execution', async () => {
    const p = await parent(); const first = await worker(p.id); const second = await worker(p.id);
    manager.registerWorkerWait(p.id, { workerIds: [first.id, second.id], timeoutSeconds: 600, mode: 'all' });
    await until(() => waitOf(store.getRun(p.id))?.phase === 'parked');
    fixtureUpdateRun(first.id, { status: RUN_STATUS.review }); manager.reconcileWorkerWaits();
    expect(waitOf(store.getRun(p.id))?.outcomes).toHaveLength(1);
    store.commitWorkerContinuation(first.id, 'continue-line');
    fixtureUpdateRun(second.id, { status: RUN_STATUS.done }); manager.reconcileWorkerWaits();
    expect(waitOf(store.getRun(p.id))).toMatchObject({ phase: 'parked', outcomes: [{ workerId: second.id }] });
    expect(waitOf(store.getRun(p.id))?.revisions).toContainEqual({ workerId: first.id, revision: 1 });
    fixtureUpdateRun(first.id, { status: RUN_STATUS.review }); manager.reconcileWorkerWaits();
    await until(() => !waitOf(store.getRun(p.id)));
    expect(lastWaitOf(store.getRun(p.id))).toMatchObject({ outcomes: expect.arrayContaining([{ workerId: first.id, revision: 1, status: RUN_STATUS.review, observedAt: expect.any(String) }]) });
    expect(store.readEvents(p.id)).toContainEqual(expect.objectContaining({ type: 'worker-outcome', outcome: expect.objectContaining({ workerId: first.id, revision: 1 }) }));
  });
it('all-mode stays parked after one outcome and wakes exactly once after both', async () => {
    const p = await parent(); const first = await worker(p.id); const second = await worker(p.id);
    const wait = manager.registerWorkerWait(p.id, { workerIds: [first.id, second.id], timeoutSeconds: 600, mode: 'all' });
    await until(() => waitOf(store.getRun(p.id))?.phase === 'parked');
    fixtureUpdateRun(first.id, { status: RUN_STATUS.done }); manager.reconcileWorkerWaits();
    expect(waitOf(store.getRun(p.id))).toMatchObject({ phase: 'parked', mode: 'all', outcomes: [{ workerId: first.id }] });
    expect(store.getRun(p.id)?.agentInputs).toBeUndefined();
    fixtureUpdateRun(second.id, { status: RUN_STATUS.done }); manager.reconcileWorkerWaits();
    await until(() => !waitOf(store.getRun(p.id)));
    expect(store.getRun(p.id)?.agentInputs?.filter(input => input.id === wait.id)).toHaveLength(1);
    expect(lastWaitOf(store.getRun(p.id))).toMatchObject({ id: wait.id, reason: 'outcome' });
  });
});
