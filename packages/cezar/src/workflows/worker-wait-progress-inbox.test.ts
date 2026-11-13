import { WAIT_PHASE } from '@open-mercato/cezar-contract/test-factories.testkit';
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { parkNoticeId } from '../delegation/park-notice.ts';
import { manager, semaphore, store, until, useWorkerWaitFixture, waitOf, lastWaitOf, workerEntryOf, work } from './worker-wait-claude.testkit.ts';
import { conversationPair, turnEnds } from './worker-wait-conversations.testkit.ts';

describe('parent and worker conversation waits through RunManager', { timeout: 30_000 }, () => {
  useWorkerWaitFixture();
  it('inbox ACK of progress preserves a parked worker wait and its terminal wake', async () => {
    const f = await conversationPair();
    // The wait opens on a parked worker, which sends its park notice (hearsay-tools/cezarion#1327).
    // The parent takes it and parks again before the progress this test acknowledges.
    const turns = turnEnds(f.p.id);
    const wait = manager.registerWorkerWait(f.p.id, { workerIds: [f.w.id], timeoutSeconds: 600 });
    const notice = parkNoticeId(f.w.id, wait.id);
    await until(() => turnEnds(f.p.id) > turns && waitOf(store.getRun(f.p.id))?.phase === 'parked' &&
      !!store.getRun(f.p.id)?.agentInputs?.find(input => input.id === notice)?.deliveredAt);
    const capacity = vi.spyOn(semaphore, 'maxParallel').mockReturnValue(0);
    try {
      const id = randomUUID();
      await f.service.send(f.workerCaller, { id, recipientRunId: f.p.id, kind: 'progress', text: 'Still working mock:hold', timeoutSeconds: 600 });
      const generation = randomUUID();
      const claim = manager.reserveInboxInputs(f.p.id, generation, [id])!;
      expect(manager.acknowledgeInbox(f.p.id, generation, claim.receiptId)).toBe('acknowledged');
      expect(waitOf(store.getRun(f.p.id))).toMatchObject({ id: wait.id, phase: 'parked', deadline: wait.deadline });
      expect(store.getRun(f.p.id)?.agentInputs?.find(input => input.id === id)?.deliveredAt).toBeDefined();
      expect(semaphore.busy()).toBe(0);
      capacity.mockRestore(); await semaphore.release();
      expect(manager.finish(f.w.id)).toBe(true);
      await until(() => !!store.getRun(f.p.id)?.agentInputs?.find(input => input.id === wait.id)?.deliveredAt);
      expect(waitOf(store.getRun(f.p.id))).toBeUndefined();
      expect(store.getRun(f.p.id)?.agentInputs?.filter(input => input.id === wait.id)).toHaveLength(1);
    } finally { capacity.mockRestore(); f.close(); }
  });

  // hearsay-tools/cezarion#1235: messages are not waits; a request no longer interrupts the wait.
  it.each(['provider', 'inbox'] as const)('a mixed progress/request %s batch is delivered and the worker wait stays open', async mode => {
    const f = await conversationPair();
    const capacity = vi.spyOn(semaphore, 'maxParallel').mockReturnValue(0);
    try {
      const wait = manager.registerWorkerWait(f.p.id, { workerIds: [f.w.id], timeoutSeconds: 600 });
      const progressId = randomUUID(); const requestId = randomUUID();
      await f.service.send(f.workerCaller, { id: progressId, recipientRunId: f.p.id, kind: 'progress', text: 'Working mock:hold', timeoutSeconds: 600 });
      await f.service.send(f.workerCaller, { id: requestId, recipientRunId: f.p.id, kind: 'request', text: 'Need a decision mock:hold', timeoutSeconds: 600 });
      if (mode === 'inbox') {
        const generation = randomUUID();
        const claim = manager.reserveInboxInputs(f.p.id, generation, [progressId, requestId])!;
        expect(manager.acknowledgeInbox(f.p.id, generation, claim.receiptId)).toBe('acknowledged');
      } else {
        const send = vi.spyOn([...work.liveSessions][0]!, 'sendAgentMessage');
        capacity.mockRestore(); await semaphore.release();
        await until(() => [progressId, requestId].every(id => !!store.getRun(f.p.id)?.agentInputs?.find(input => input.id === id)?.deliveredAt));
        const submitted = JSON.stringify(send.mock.calls);
        expect(submitted).toContain(`Still open: worker wait ${wait.id}`);
      }
      expect(workerEntryOf(store.getRun(f.p.id))).toMatchObject({ id: wait.id, phase: WAIT_PHASE.open, workerIds: [f.w.id] });
      expect(lastWaitOf(store.getRun(f.p.id))).toBeUndefined();
      expect(store.getRun(f.p.id)?.delegation).toMatchObject({ conversation: { outcomes: [] } });
    } finally { capacity.mockRestore(); f.close(); }
  });

  // hearsay-tools/cezarion#1235: neither message ends the worker wait.
  it('a request-only inbox ACK beside a progress wake still awaiting provider ACK leaves the worker wait open', async () => {
    const f = await conversationPair();
    const capacity = vi.spyOn(semaphore, 'maxParallel').mockReturnValue(0);
    let acknowledge!: () => void;
    const pending = new Promise<void>(resolve => { acknowledge = resolve; });
    const send = vi.spyOn([...work.liveSessions][0]!, 'sendAgentMessage').mockReturnValue(pending);
    try {
      const wait = manager.registerWorkerWait(f.p.id, { workerIds: [f.w.id], timeoutSeconds: 600 });
      const progressId = randomUUID(); const requestId = randomUUID();
      await f.service.send(f.workerCaller, { id: progressId, recipientRunId: f.p.id, kind: 'progress', text: 'Working mock:hold', timeoutSeconds: 600 });
      capacity.mockRestore(); await semaphore.release();
      await until(() => send.mock.calls.some(call => call[1]?.includes(progressId)));
      expect(manager.canClaimInboxInput(f.p.id, progressId)).toBe(false);
      await f.service.send(f.workerCaller, { id: requestId, recipientRunId: f.p.id, kind: 'request', text: 'Need a decision mock:hold', timeoutSeconds: 600 });
      const generation = randomUUID();
      const claim = manager.reserveInboxInputs(f.p.id, generation, [requestId])!;
      expect(manager.acknowledgeInbox(f.p.id, generation, claim.receiptId)).toBe('acknowledged');
      expect(workerEntryOf(store.getRun(f.p.id))).toMatchObject({ id: wait.id, phase: WAIT_PHASE.open });
      acknowledge();
      await until(() => !!store.getRun(f.p.id)?.agentInputs?.find(input => input.id === progressId)?.deliveredAt);
      expect(workerEntryOf(store.getRun(f.p.id))).toMatchObject({ id: wait.id, phase: WAIT_PHASE.open });
      expect(lastWaitOf(store.getRun(f.p.id))).toBeUndefined();
    } finally { acknowledge(); send.mockRestore(); capacity.mockRestore(); f.close(); }
  });

});
