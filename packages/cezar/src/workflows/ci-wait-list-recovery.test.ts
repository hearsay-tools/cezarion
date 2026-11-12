// Register the external CI mock before loading RunManager.
import { success, registerPr, registerTimer, waitById, settledById, inputsFor, fireTimer, flushMicrotasks, githubByPr, waitingParent, expectNoWaitHumanWait, acquireExternalCiResources } from './ci-wait-fixture.testkit.ts';
import { WAIT_PHASE, RUN_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { QUICK_TASK_WORKFLOW } from './types.ts';
import { type Wait } from '@open-mercato/cezar-contract/waits';

import { controlledWire, manager, parent, root, restart, store, until, useWorkerWaitFixture, work } from './worker-wait-claude.testkit.ts';

import { readPersistedRuns } from '../runs/run-store.testkit.ts';
import { ciWatchRequest, waitResultText } from './waits.ts';


describe('Wait list recovery and cancellation', { timeout: 30_000 }, () => {
  useWorkerWaitFixture({ acquireCiResources: acquireExternalCiResources });
  afterEach(() => vi.restoreAllMocks());

  it('restart: an open timer re-arms from its stored deadline and resolves through a continuation', async () => {
    const run = await waitingParent();
    const wait = await registerTimer(run.id, 600);
    await restart();
    expect(manager.isActive(run.id)).toBe(false);
    expect(store.getRun(run.id)?.status).toBe('waiting');
    expect(waitById(run.id, wait.id)).toMatchObject({ phase: WAIT_PHASE.open, deadline: wait.deadline });
    expect(inputsFor(run.id, wait.id)).toEqual([]);
    fireTimer(wait.id);
    await until(() => settledById(run.id, wait.id)?.phase === 'delivered');
    expect(inputsFor(run.id, wait.id)).toHaveLength(1);
  });

  it('restart: an overdue timer resolves at once and is delivered exactly once', async () => {
    const run = await waitingParent();
    const wait = await registerTimer(run.id, 600);
    store.flush();
    const disk = readPersistedRuns(join(root, '.ai/cezar')) as Array<{ id: string; waits?: Wait[] }>;
    const row = disk.find(entry => entry.id === run.id)!;
    row.waits = row.waits!.map(entry => ({ ...entry, deadline: new Date(Date.now() - 1_000).toISOString() }));
    await restart(false, disk);
    await until(() => settledById(run.id, wait.id)?.phase === 'delivered');
    expect(inputsFor(run.id, wait.id)).toHaveLength(1);
    await expectNoWaitHumanWait(run.id);
  });

  it('restart: a resolved v3-upgraded CI wait is delivered exactly once', async () => {
    githubByPr();
    const run = await waitingParent();
    const wait = await registerPr(run.id, 12);
    if (wait.kind !== 'pr') throw Error('expected a CI wait');
    store.flush();
    const disk = readPersistedRuns(join(root, '.ai/cezar')) as Array<Record<string, unknown> & { id: string }>;
    const row = disk.find(entry => entry.id === run.id)!;
    const result = success();
    const resolved = { ...wait, phase: WAIT_PHASE.resolved, resolvedAt: result.observedAt, result };
    // A schema-3 row: `ciWait` wake-pending, its observation queued under the wait id.
    delete row.waits;
    Object.assign(row, { status: RUN_STATUS.running, activity: 'monitoring', ciWait: { ...ciWatchRequest(wait), phase: 'wake-pending', result, wakeId: wait.id },
      agentInputs: [{ id: wait.id, parentRunId: run.id, source: 'lifecycle', createdAt: result.observedAt, text: waitResultText(resolved) }] });
    await restart(false, disk);
    await until(() => settledById(run.id, wait.id)?.phase === 'delivered');
    expect(inputsFor(run.id, wait.id)).toMatchObject([{ deliveredAt: expect.any(String) }]);
    expect(store.getRun(run.id)?.lastWaits?.filter(entry => entry.id === wait.id)).toHaveLength(1);
    await expectNoWaitHumanWait(run.id);
  });

  it('restart: recovery cancels the waits of a terminal row without arming them', async () => {
    githubByPr();
    const run = await waitingParent();
    const ci = await registerPr(run.id, 12);
    const timer = await registerTimer(run.id, 600);
    store.flush();
    const disk = readPersistedRuns(join(root, '.ai/cezar')) as Array<Record<string, unknown> & { id: string }>;
    Object.assign(disk.find(entry => entry.id === run.id)!, { status: RUN_STATUS.review });
    await restart(false, disk);
    await until(() => {
      return (store.getRun(run.id)?.waits ?? []).length === 0;
    });
    expect([settledById(run.id, ci.id)?.phase, settledById(run.id, timer.id)?.phase]).toEqual(['cancelled', 'cancelled']);
    const settled = structuredClone(store.getRun(run.id));
    fireTimer(timer.id);
    await flushMicrotasks();
    expect(store.getRun(run.id)).toEqual(settled);
    expect(store.getRun(run.id)?.agentInputs ?? []).toEqual([]);
  });

  it.each(['cancel', 'finish', 'delete'] as const)('%s cancels open waits without waking the agent', async action => {
    const external = githubByPr();
    const run = manager.startRun(QUICK_TASK_WORKFLOW, { task: 'mock:hold', runner: 'claude' });
    await until(() => store.getRun(run.id)?.status === 'waiting');
    const ci = await registerPr(run.id, 12);
    const timer = await registerTimer(run.id, 600);
    const turns = () => store.readEvents(run.id).filter(event => event.type === 'turn-end').length;
    const before = turns();
    if (action === 'cancel') expect(manager.cancel(run.id)).toBe(true);
    else if (action === 'finish') expect(manager.finish(run.id)).toBe(true);
    else {
      // Deletion takes an inactive run: a closed session keeps its waits (R72).
      expect(work.liveSessions.size).toBe(1);
      const [session] = work.liveSessions;
      session!.end();
      await until(() => !manager.isActive(run.id));
      expect(store.deleteRun(run.id)).toBe(true);
    }
    expect(external.aborted(12)).toBe(true);
    const settled = structuredClone(store.getRun(run.id));
    fireTimer(timer.id);
    await flushMicrotasks();
    expect(store.getRun(run.id)).toEqual(settled);
    if (action !== 'delete') {
      expect(store.getRun(run.id)?.waits ?? []).toEqual([]);
      expect([settledById(run.id, ci.id)?.phase, settledById(run.id, timer.id)?.phase]).toEqual(['cancelled', 'cancelled']);
      await until(() => !manager.isActive(run.id));
      external.settle(12);
      await flushMicrotasks();
      expect(store.getRun(run.id)?.agentInputs ?? []).toEqual([]);
      expect(turns()).toBe(before);
    }
  });

  it('the wait delivery outcome runs on the provider ACK of a batch containing several resolved waits', async () => {
    const external = githubByPr();
    const gate = join(root, 'turn-boundary');
    const wire = controlledWire({ firstResultGate: gate });
    const run = await parent(); await until(wire.initialReceived);
    const first = await registerPr(run.id, 12);
    const second = await registerPr(run.id, 13);
    const timer = await registerTimer(run.id, 60);
    // Resolutions are ordered by their millisecond `resolvedAt`; each waits for the clock to move on
    // so the three never tie and fall back to registration order.
    const resolve = async (id: string, act: () => void) => {
      act(); await until(() => waitById(run.id, id)?.phase === 'resolved');
      const at = Date.parse(waitById(run.id, id)!.resolvedAt!); await until(() => Date.now() > at);
    };
    await resolve(first.id, () => external.settle(12));
    await resolve(timer.id, () => fireTimer(timer.id));
    await resolve(second.id, () => external.settle(13));
    expect(work.liveSessions.size).toBe(1);
    const [session] = work.liveSessions;
    const send = vi.spyOn(session!, 'sendAgentMessage');
    writeFileSync(gate, 'end');
    const ids = [first.id, timer.id, second.id];
    await until(() => ids.every(id => settledById(run.id, id)?.phase === 'delivered'));
    // The no-wait nudge after the batch's turn is a send of its own (hearsay-tools/cezarion#1234).
    const accepted = send.mock.calls.filter((call, i) => send.mock.results[i]?.value !== false && ids.some(id => JSON.stringify(call).includes(id)));
    expect(accepted).toHaveLength(1);
    const batch = JSON.stringify(accepted[0]);
    // Oldest resolution first.
    expect(ids.map(id => batch.indexOf(id))).toEqual([...ids.map(id => batch.indexOf(id))].sort((a, b) => a - b));
    expect(ids.every(id => batch.includes(id))).toBe(true);
    expect(new Set(ids.map(id => inputsFor(run.id, id)[0]?.deliveredAt)).size).toBe(1);
  });
});
