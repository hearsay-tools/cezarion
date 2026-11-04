import { runInternals } from './run-internals.testkit.ts';
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { manager, store, useWorkerWaitFixture, waitOf, lastWaitOf } from './worker-wait.testkit.ts';
import { conversationPair } from './worker-wait-conversations.testkit.ts';

describe('parent and worker conversation waits through RunManager', { timeout: 30_000 }, () => {
  useWorkerWaitFixture();
  it('conversation: a full queue of 32 replies can admit an all-request wake without losing a message', async () => {
    const f = await conversationPair();
    const pump = vi.spyOn(runInternals(manager).line, 'pump').mockResolvedValue();
    const submissions = vi.spyOn(runInternals(manager).inputDelivery, 'submitAgentInput');
    try {
      const requestIds = Array.from({ length: 32 }, () => randomUUID());
      for (const id of requestIds) await f.service.send(f.parentCaller, { id, recipientRunId: f.w.id, kind: 'request', text: 'Batch question mock:hold', timeoutSeconds: 600 });
      const wait = manager.registerRequestWait(f.p.id, { requestIds, mode: 'all', timeoutSeconds: 600 });
      const replyIds: string[] = [];
      for (const requestId of requestIds) {
        const id = randomUUID(); replyIds.push(id);
        await f.service.send(f.workerCaller, { id, recipientRunId: f.p.id, kind: 'reply', requestId, text: 'Batch answer mock:hold', timeoutSeconds: 600 });
      }
      // hearsay-tools/cezarion#1235: the wait resolves in the list with its own lifecycle input
      // beside the 32 replies, which stay queued as messages.
      const queued = store.getRun(f.p.id)?.agentInputs ?? [];
      expect(queued.filter(input => !input.deliveredAt)).toHaveLength(33);
      expect(queued.map(input => input.id)).toEqual([...replyIds, wait.id]);
      expect(waitOf(store.getRun(f.p.id))).toMatchObject({ id: wait.id, phase: 'wake-pending', reason: 'outcome' });
      expect(pump).toHaveBeenCalled(); pump.mockRestore();
      await runInternals(manager).line.pump();
      await vi.waitFor(() => {
        expect(store.getRun(f.p.id)?.agentInputs?.filter(input => input.deliveredAt).map(input => input.id)).toEqual([...replyIds, wait.id]);
        expect(waitOf(store.getRun(f.p.id))).toBeUndefined();
      }, { timeout: 60_000, interval: 20 }); // bound: 33 real deliveries on a loaded host, as before
      expect(lastWaitOf(store.getRun(f.p.id))).toMatchObject({ id: wait.id, reason: 'outcome', requestOutcomes: expect.arrayContaining(requestIds.map(requestId => expect.objectContaining({ requestId, status: 'replied' }))) });
      // One submission: the result, then every reply, each once.
      const delivered = submissions.mock.calls.filter((call, index) => call[0] === f.p.id && submissions.mock.results[index]?.value === true);
      expect(delivered).toHaveLength(1);
      expect(delivered.flatMap(call => call[3])).toEqual([wait.id, ...replyIds]);
      expect((delivered.at(-1)?.[2][0] as { text: string })?.text).toContain(`Request wait ${wait.id} (outcome). Request outcomes:`);
      expect((delivered.at(-1)?.[2][0] as { text: string })?.text.match(/Batch answer mock:hold/g)).toHaveLength(32);
    } finally { pump.mockRestore(); submissions.mockRestore(); f.close(); }
  }, 90_000);

});
