import { agentEnvForStep } from './run/launch-context.ts';
import { InputDelivery } from './run/input-delivery.ts';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { agentInputSchema } from '@open-mercato/cezar-contract/delegation';
import { RunStore } from '../runs/store.ts';
import { controlledWire, fixtureUpdateRun, manager, parent, queuedWake, register, restart, root, semaphore, store, until, useWorkerWaitFixture, waitOf, lastWaitOf, worker } from './worker-wait-claude.testkit.ts';
import { blockRunWrites, readPersistedRuns, readPersistedText } from '../runs/run-store.testkit.ts';
import { RUN_STATUS, WORKER_OUTCOME_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';

vi.mock('./run/launch-context.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('./run/launch-context.ts')>();
  return { ...actual, agentEnvForStep: vi.fn(actual.agentEnvForStep) };
});

// Real Git, durable fsync checkpoints and process shutdown share this outer budget.
// Keep the separate 15s state/termination assertions and actual runner timers intact.

describe('worker waits through RunManager', { timeout: 30_000 }, () => {
  useWorkerWaitFixture();
  it('restart delivers a destroyed worker wake instead of stranding a parked parent', async () => {
    const p = await parent();
    await until(() => store.getRun(p.id)?.status === 'waiting');
    const w = await worker(p.id);
    const wait = register(p.id, [w.id]);
    await until(() => waitOf(store.getRun(p.id))?.phase === 'parked');
    fixtureUpdateRun(w.id, { status: RUN_STATUS.done });
    const delegation = store.getRun(w.id)!.delegation;
    if (delegation?.role !== 'worker') throw Error('worker fixture');
    store.commitDelegation([{ id: w.id, delegation: { ...delegation,
      destroy: { requestedAt: new Date().toISOString(), phase: 'complete', remaining: [] } } }]);
    store.flush();
    const disk = readPersistedRuns(join(root, '.ai/cezar'));
    await restart(false, disk);
    await until(() => store.getRun(p.id)?.agentInputs?.some(input => input.id === wait.id && !!input.deliveredAt) === true);
    expect(waitOf(store.getRun(p.id))).toBeUndefined();
    expect(lastWaitOf(store.getRun(p.id))).toMatchObject({ id: wait.id,
      outcomes: [{ workerId: w.id, status: WORKER_OUTCOME_STATUS.done }] });
  });

  it('a recovered worker wait whose wake input is a queued reply delivers the reply body and the receipt once', async () => {
    // A legacy full-inbox wait took an accepted reply's id as its wake id; the upgrade keeps it as
    // `wakeInputId` (hearsay-tools/cezarion#1235). The reply is still the worker's message.
    const p = await parent();
    await until(() => store.getRun(p.id)?.status === 'waiting');
    const w = await worker(p.id);
    const wait = register(p.id, [w.id]);
    await until(() => waitOf(store.getRun(p.id))?.phase === 'parked');
    store.flush();
    const replyId = randomUUID(); const body = 'The parser module, reply body marker';
    const disk = readPersistedRuns(join(root, '.ai/cezar')).map(row => {
      if (row.id !== p.id) return row;
      const entry = row.waits.find((found: { id: string }) => found.id === wait.id);
      return { ...row, waits: row.waits.filter((found: { id: string }) => found.id !== wait.id),
        delegation: { ...row.delegation, wait: { id: wait.id, workerIds: [w.id], revisions: entry.revisions, deadline: entry.deadline,
          phase: 'wake-pending', reason: 'outcome', outcomes: [{ workerId: w.id, status: WORKER_OUTCOME_STATUS.done, observedAt: new Date().toISOString() }], wakeId: replyId } },
        agentInputs: [...row.agentInputs ?? [], { id: replyId, source: agentInputSchema.shape.source.enum.agent, parentRunId: p.id, text: body, createdAt: new Date().toISOString(),
          conversation: { senderRunId: w.id, recipientRunId: p.id, kind: 'reply', requestId: randomUUID() } }] };
    });
    const submit = vi.spyOn(InputDelivery.prototype, 'submitAgentInput');
    await restart(false, disk);
    await until(() => store.getRun(p.id)?.lastWaits?.some(found => found.id === wait.id && found.phase === 'delivered') === true);
    const sent = submit.mock.calls.map(([, , content]) => (content as Array<{ text: string }>).map(part => part.text).join('\n'));
    const carrying = sent.filter(text => text.includes(body));
    expect(carrying).toHaveLength(1);
    expect(carrying[0]!.split(body)).toHaveLength(2);
    expect(carrying[0]).toContain(`Worker wait ${wait.id} (terminal outcome)`);
    expect(sent.filter(text => text.includes(`Worker wait ${wait.id}`))).toHaveLength(1);
    expect(store.getRun(p.id)?.agentInputs?.filter(input => input.id === replyId && input.deliveredAt)).toHaveLength(1);
  });

  it('a deadline write failure is contained and retried without losing intent or capacity', async () => {
    // This fault exercises only deadline persistence, never an unrelated live turn.
    const release = join(root, 'release-deadline-turn'); const wire = controlledWire({ firstResultGate: release });
    const p = await parent(); await until(wire.initialReceived); const w = await worker(p.id);
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const wait = register(p.id, [w.id], 1); // registered: still counts as an executing turn
    const busy = semaphore.busy(); const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    store.flush(); const dataDir = join(root, '.ai/cezar'); const disk = readPersistedText(dataDir);
    const unblock = blockRunWrites(dataDir);
    try {
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.advanceTimersByTimeAsync(3_000);
      expect(waitOf(store.getRun(p.id))?.phase).toBe('registered');
      expect(readPersistedText(dataDir)).toBe(disk);
      expect(store.getRun(p.id)?.agentInputs ?? []).toEqual([]);
      expect(semaphore.busy()).toBe(busy);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally { unblock(); }
    await vi.advanceTimersByTimeAsync(1_000);
    expect(waitOf(store.getRun(p.id))).toMatchObject({ id: wait.id, phase: 'wake-pending' });
    expect(store.getRun(p.id)?.agentInputs?.[0]).toMatchObject({ id: wait.id });
    expect(store.getRun(p.id)?.agentInputs?.[0]?.deliveredAt).toBeUndefined();
    expect(semaphore.busy()).toBe(busy); warn.mockRestore();
  });

  // hearsay-tools/cezarion#1235: a human message withdraws no list wait; it is accepted beside it.
  it('a queued human message preserves admission, FIFO, attachments and the owed wait without answering an ask on acceptance', async () => {
    const { p, w, wait } = await queuedWake();
    // Earlier human amendments and a current ask must not disappear when the
    // lifecycle opening is superseded. Acceptance alone is not answer delivery.
    store.updateRun(p.id, { queuedMessages: [{ id: randomUUID(), text: 'earlier human update', createdAt: new Date().toISOString() }] });
    store.appendEvent(p.id, { type: 'ask.requested', requestId: randomUUID(), questions: [{
      header: 'Choice', question: 'Which option?', options: [{ label: 'One' }, { label: 'Two' }],
    }] });
    const queued = manager.enqueueMessage(p.id, [{ type: 'text', text: 'new human update' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'YQ==' } },
      { type: 'file', mediaType: 'application/pdf', data: 'Yg==' }]);
    expect(queued?.images).toHaveLength(2);
    expect(waitOf(store.getRun(p.id))).toMatchObject({ id: wait.id, phase: 'wake-pending' });
    expect(store.getRun(p.id)?.agentInputs?.map(input => [input.id, input.deliveredAt])).toEqual([[wait.id, undefined]]);
    expect(store.getRun(p.id)?.continuationMessage?.origin).toBe('human');
    expect(store.getRun(p.id)?.status).toBe('queued'); expect(semaphore.busy()).toBe(1);
    expect(store.readEvents(p.id).filter(event => event.type === 'human-input-delivered')).toEqual([]);
    store.flush();
    const reopened = RunStore.open(join(root, '.ai/cezar'), { keepLive: true });
    expect(reopened.getRun(p.id)?.continuationMessage?.origin).toBe('human'); reopened.flush();
    manager.cancel(w.id);
    await until(() => store.getRun(p.id)?.status === 'waiting');
    const opening = store.readEvents(p.id).find(event => event.type === 'user-message');
    expect(String(opening?.text).match(/new human update/g)).toHaveLength(1);
    expect(String(opening?.text).indexOf('earlier human update')).toBeLessThan(String(opening?.text).indexOf('new human update'));
    expect(opening?.images).toEqual(queued?.images);
    expect(store.readEvents(p.id).filter(event => event.type === 'human-input-delivered')).toHaveLength(1);
  });

  it('a failed queued human message checkpoint publishes no wait, wake, message or admission changes', async () => {
    const { p } = await queuedWake(); store.flush();
    const snapshot = JSON.stringify(store.getRun(p.id));
    const release = blockRunWrites(join(root, '.ai/cezar'));
    try {
      expect(() => manager.enqueueMessage(p.id, [{ type: 'text', text: 'must not be accepted' }])).toThrow();
      expect(JSON.stringify(store.getRun(p.id))).toBe(snapshot);
      expect(semaphore.busy()).toBe(1);
    } finally { release(); }
  });

  for (const crash of ['before-delivery', 'after-delivery', 'checkpoint-failure'] as const) {
    // hearsay-tools/cezarion#1235: accepted durably beside the owed wait, which it no longer withdraws.
    it(`startup human message ${crash}: ${crash === 'checkpoint-failure' ? 'stops delivery and preserves the replay ID' : 'survives restart without double folding or lost input'}`, async () => {
      const { p, w, wait } = await queuedWake();
      const real = await vi.importActual<typeof import('./run/launch-context.ts')>('./run/launch-context.ts');
      let release!: () => void; let entered = false;
      const gate = new Promise<void>(resolve => { release = resolve; });
      vi.mocked(agentEnvForStep).mockImplementation(async (...args) => {
        if (args[2] === p.id) { entered = true; await gate; }
        return real.agentEnvForStep(...args);
      });
      manager.cancel(w.id); await until(() => entered);
      let checkpoint: unknown[];
      try {
        expect(manager.deferMessage(p.id, [{ type: 'text', text: 'startup human update' },
          { type: 'file', mediaType: 'application/pdf', data: 'YQ==' }])).toBe(true);
        expect(waitOf(store.getRun(p.id))).toMatchObject({ id: wait.id, phase: 'wake-pending' });
        expect(store.getRun(p.id)?.queuedMessages?.at(-1)?.text).toBe('startup human update');
        store.flush(); checkpoint = readPersistedRuns(join(root, '.ai/cezar'));
        if (crash === 'checkpoint-failure') {
          const commit = store.commitOutcome.bind(store);
          store.commitOutcome = (...args) => {
            if (![args[1]].flat().some(outcome => outcome.kind === 'message-delivered')) return commit(...args);
            const unblock = blockRunWrites(join(root, '.ai/cezar'));
            try { return commit(...args); } finally { unblock(); }
          };
        }
      } finally { release(); }
      await until(() => store.readEvents(p.id).some(event => event.type === 'user-message' && String(event.text).includes('startup human update')));
      if (crash === 'checkpoint-failure') {
        // hearsay-tools/cezarion#1233/#1235: the result is still owed, so the failed session counts a
        // failed wake delivery and the run waits for the retry instead of settling `failed`.
        await until(() => store.getRun(p.id)?.error?.includes('human input delivery checkpoint failed') === true);
        expect(store.getRun(p.id)).toMatchObject({ status: RUN_STATUS.waiting, waitDeliveryFailures: 1 });
        expect(store.getRun(p.id)?.queuedMessages?.at(-1)?.text).toBe('startup human update');
        expect(store.readEvents(p.id).filter(event => event.type === 'user-message' && String(event.text).includes('startup human update'))).toHaveLength(1);
        return;
      }
      if (crash === 'after-delivery') {
        expect(store.getRun(p.id)?.queuedMessages?.some(message => message.text === 'startup human update')).not.toBe(true);
        store.flush(); checkpoint = readPersistedRuns(join(root, '.ai/cezar'));
      }
      const eventStart = store.readEvents(p.id).length;
      await restart(false, checkpoint!);
      await until(() => store.getRun(p.id)?.status === 'waiting');
      const afterRestart = store.readEvents(p.id).slice(eventStart).filter(event => event.type === 'user-message');
      const mentions = afterRestart.flatMap(event => String(event.text).match(/startup human update/g) ?? []);
      expect(mentions).toHaveLength(crash === 'before-delivery' ? 1 : 0);
      if (crash === 'before-delivery') expect(afterRestart.find(event => String(event.text).includes('startup human update'))?.images).toHaveLength(1);
      // The owed result reached the agent: the wait is delivered, not withdrawn.
      expect(waitOf(store.getRun(p.id))).toBeUndefined();
      expect(lastWaitOf(store.getRun(p.id))).toMatchObject({ id: wait.id });
    });
  }

});
