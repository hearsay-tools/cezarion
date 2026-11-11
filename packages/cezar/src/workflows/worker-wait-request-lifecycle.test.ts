import { WAIT_PHASE } from '@open-mercato/cezar-contract/test-factories.testkit';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { checkpoint, manager, restart, semaphore, store, until, useWorkerWaitFixture, waitOf, lastWaitOf, workerEntryOf, worker } from './worker-wait-claude.testkit.ts';
import { conversationPair, turnEnds, parentHandledRequest } from './worker-wait-conversations.testkit.ts';

describe('parent and worker conversation waits through RunManager', { timeout: 30_000 }, () => {
  useWorkerWaitFixture();
  it('conversation: worker request wait releases capacity and explicit parent reply wakes exactly once', async () => {
    const f = await conversationPair();
    try {
      const id = randomUUID();
      const boundaries = turnEnds(f.p.id);
      await f.service.send(f.workerCaller, { id, recipientRunId: f.p.id, kind: 'request', text: 'Which module? mock:hold', timeoutSeconds: 600 });
      const wait = manager.registerRequestWait(f.w.id, { requestIds: [id], timeoutSeconds: 600 });
      await until(() => waitOf(store.getRun(f.w.id))?.phase === 'parked');
      await parentHandledRequest(f.p.id, id, boundaries);
      expect(semaphore.busy()).toBe(0);
      const reply = { id: randomUUID(), recipientRunId: f.w.id, kind: 'reply' as const, requestId: id, text: 'The parser. mock:hold', timeoutSeconds: 600 };
      await f.service.send(f.parentCaller, reply);
      await until(() => !waitOf(store.getRun(f.w.id)));
      await f.service.send(f.parentCaller, reply);
      manager.reconcileWorkerWaits(); manager.reconcileWorkerWaits();
      expect(store.getRun(f.w.id)?.agentInputs?.filter(input => input.id === wait.id && input.deliveredAt)).toHaveLength(1);
      expect(store.getRun(f.w.id)?.agentInputs?.filter(input => input.id === reply.id)).toHaveLength(1);
      const rootState = store.getRun(f.p.id)?.delegation;
      expect(rootState?.role === 'root' && rootState.conversation?.outcomes).toEqual([expect.objectContaining({ requestId: id, status: 'replied', replyId: reply.id })]);
    } finally { f.close(); }
  });

  it('conversation: reply before registration satisfies request wait and is retained after retirement', async () => {
    const f = await conversationPair();
    try {
      const id = randomUUID();
      const boundaries = turnEnds(f.p.id);
      await f.service.send(f.workerCaller, { id, recipientRunId: f.p.id, kind: 'request', text: 'Early question mock:hold', timeoutSeconds: 600 });
      await parentHandledRequest(f.p.id, id, boundaries);
      await f.service.send(f.parentCaller, { id: randomUUID(), recipientRunId: f.w.id, kind: 'reply', requestId: id, text: 'Early reply mock:hold', timeoutSeconds: 600 });
      await until(() => store.getRun(f.w.id)?.status === 'waiting' && !waitOf(store.getRun(f.w.id)) && !!store.getRun(f.w.id)?.agentInputs?.every(input => input.deliveredAt));
      const wait = manager.registerRequestWait(f.w.id, { requestIds: [id], timeoutSeconds: 600 });
      expect(wait.reason).toBe('outcome');
      await until(() => !waitOf(store.getRun(f.w.id)));
      expect(lastWaitOf(store.getRun(f.w.id))?.requestOutcomes).toEqual([expect.objectContaining({ requestId: id, status: 'replied' })]);
    } finally { f.close(); }
  });

  // hearsay-tools/cezarion#1235: the question wakes the worker; its wait and the obligation stay open.
  it('conversation: an incoming question wakes a parked worker without ending its wait or settling its obligation', async () => {
    const f = await conversationPair();
    try {
      const first = randomUUID();
      const boundaries = turnEnds(f.p.id);
      await f.service.send(f.workerCaller, { id: first, recipientRunId: f.p.id, kind: 'request', text: 'Need module mock:hold', timeoutSeconds: 600 });
      const wait = manager.registerRequestWait(f.w.id, { requestIds: [first], timeoutSeconds: 600 });
      await until(() => waitOf(store.getRun(f.w.id))?.phase === 'parked');
      await parentHandledRequest(f.p.id, first, boundaries);
      const second = randomUUID();
      await f.service.send(f.parentCaller, { id: second, recipientRunId: f.w.id, kind: 'request', text: 'Which options? mock:hold', timeoutSeconds: 600 });
      await until(() => !!store.getRun(f.w.id)?.agentInputs?.find(input => input.id === second)?.deliveredAt);
      expect(workerEntryOf(store.getRun(f.w.id))).toMatchObject({ id: wait.id, phase: WAIT_PHASE.open, requestIds: [first] });
      expect(lastWaitOf(store.getRun(f.w.id))).toBeUndefined();
      const rootState = store.getRun(f.p.id)?.delegation;
      expect(rootState?.role === 'root' && rootState.conversation?.outcomes).toEqual([]);
      expect(store.getRun(f.w.id)?.agentInputs?.find(input => input.id === second)?.deliveredAt).toBeTruthy();
    } finally { f.close(); }
  });

  it('conversation: request deadlines settle without registering a wait or polling', async () => {
    const f = await conversationPair();
    try {
      const id = randomUUID();
      await f.service.send(f.workerCaller, { id, recipientRunId: f.p.id, kind: 'request', text: 'Deadline question mock:hold', timeoutSeconds: 1 });
      await until(() => {
        const rootState = store.getRun(f.p.id)?.delegation;
        return rootState?.role === 'root' && rootState.conversation?.outcomes.some(outcome => outcome.requestId === id && outcome.status === 'timed-out') === true;
      });
      expect(store.getRun(f.w.id)?.status).toBe('waiting');
      expect(store.getRun(f.p.id)?.status).not.toBe('cancelled');
    } finally { f.close(); }
  });

  it('conversation: restart restores a worker request wait and deadline, and cancelling it leaves a receipt and no wake', async () => {
    const f = await conversationPair();
    try {
      const id = randomUUID();
      await f.service.send(f.workerCaller, { id, recipientRunId: f.p.id, kind: 'request', text: 'Recovery question mock:hold', timeoutSeconds: 600 });
      await until(() => !waitOf(store.getRun(f.p.id)) && !!store.getRun(f.p.id)?.agentInputs?.find(input => input.id === id)?.deliveredAt);
      const wait = manager.registerRequestWait(f.w.id, { requestIds: [id], timeoutSeconds: 600 });
      await until(() => waitOf(store.getRun(f.w.id))?.phase === 'parked');
      await restart();
      expect(store.getRun(f.w.id)?.status).toBe('waiting');
      expect(waitOf(store.getRun(f.w.id))).toMatchObject({ id: wait.id, requestIds: [id], deadline: wait.deadline, phase: 'parked' });
      manager.cancelWorkerWait(f.w.id, wait.id);
      checkpoint('conversation-cancel-wait');
      await until(() => !waitOf(store.getRun(f.w.id)));
      checkpoint('conversation-wait-cancelled');
      // hearsay-tools/cezarion#1235: a cancelled wait moves to lastWaits and queues no wake.
      expect(lastWaitOf(store.getRun(f.w.id))).toMatchObject({ id: wait.id, reason: 'cancelled' });
      manager.reconcileWorkerWaits(); manager.reconcileWorkerWaits();
      expect(store.getRun(f.w.id)?.agentInputs?.filter(input => input.id === wait.id) ?? []).toEqual([]);
    checkpoint('conversation-test-complete');
    } finally { f.close(); }
  });

  // hearsay-tools/cezarion#1235: the first reply settles its request in the open entry, which
  // waits on for the second; the reply itself reaches the parent as a message.
  it('conversation: parent waits for replies from two workers and the first reply leaves the wait open', async () => {
    const f = await conversationPair();
    try {
      const secondWorker = await worker(f.p.id);
      manager.enqueueOwnedRun(secondWorker.id);
      await until(() => store.getRun(secondWorker.id)?.status === 'waiting');
      const secondCaller = f.callerFor(secondWorker.id);
      const first = randomUUID(); const second = randomUUID();
      await f.service.send(f.parentCaller, { id: first, recipientRunId: f.w.id, kind: 'request', text: 'First check mock:hold', timeoutSeconds: 600 });
      await f.service.send(f.parentCaller, { id: second, recipientRunId: secondWorker.id, kind: 'request', text: 'Second check mock:hold', timeoutSeconds: 600 });
      const wait = manager.registerRequestWait(f.p.id, { requestIds: [first, second], mode: 'all', timeoutSeconds: 600 });
      await until(() => waitOf(store.getRun(f.p.id))?.phase === 'parked');
      await f.service.send(f.workerCaller, { id: randomUUID(), recipientRunId: f.p.id, kind: 'reply', requestId: first, text: 'First result mock:hold', timeoutSeconds: 600 });
      expect(workerEntryOf(store.getRun(f.p.id))).toMatchObject({ id: wait.id, phase: WAIT_PHASE.open, requestOutcomes: [expect.objectContaining({ requestId: first, status: 'replied' })] });
      await f.service.send(secondCaller, { id: randomUUID(), recipientRunId: f.p.id, kind: 'reply', requestId: second, text: 'Second result mock:hold', timeoutSeconds: 600 });
      await until(() => lastWaitOf(store.getRun(f.p.id))?.id === wait.id && !waitOf(store.getRun(f.p.id)));
      expect(lastWaitOf(store.getRun(f.p.id))).toMatchObject({ id: wait.id, reason: 'outcome', requestOutcomes: [expect.objectContaining({ requestId: first }), expect.objectContaining({ requestId: second })] });
      expect(store.getRun(f.p.id)?.agentInputs?.filter(input => input.id === wait.id && input.deliveredAt)).toHaveLength(1);
    } finally { f.close(); }
  });

});
