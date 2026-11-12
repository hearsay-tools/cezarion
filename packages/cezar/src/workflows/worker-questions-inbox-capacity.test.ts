import { agentInputSchema } from '@open-mercato/cezar-contract/delegation';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DelegationPolicyError } from '../delegation/policy.ts';
import { fixtureUpdateRun, manager, root, store, until, worker } from './worker-wait-claude.testkit.ts';
import { readPersistedRuns } from '../runs/run-store.testkit.ts';
import { eventsOf, squawkAnswered, noHumanCard, steeringParent, askedPair, answered, said, fillConversation, useWorkerQuestionsFixture } from './worker-questions.testkit.ts';

describe("worker questions route to the parent (hearsay-tools/cezarion#505)", { timeout: 45_000 }, () => {
  useWorkerQuestionsFixture();

it('answers the worker for the parent when the conversation has no room for its reply', async () => {
    const p = await steeringParent(); await until(() => store.getRun(p.id)?.status === 'waiting');
    const w = await worker(p.id, 'mock:cezar-ask');
    fillConversation(p.id, w.id, 1023);
    manager.enqueueOwnedRun(w.id);
    await until(() => squawkAnswered(w.id).length === 1);
    expect(eventsOf(w.id, 'worker-question-undelivered')).toEqual([expect.objectContaining({ reason: 'the parent conversation is at capacity' })]);
    expect(eventsOf(w.id, 'worker-question-routed')).toEqual([]);
    noHumanCard(w.id);
  });

it("keeps room for an open question's reply in the conversation and the worker's inbox", async () => {
    const f = await askedPair();
    try {
      const progress = () => f.service.send(f.parentCaller, { id: randomUUID(), recipientRunId: f.w.id, kind: 'progress', text: 'mock:agent-echo more', timeoutSeconds: 600 });
      const capacity = (error: unknown) => error instanceof DelegationPolicyError && error.code === 'capacity_limit';
      // Inbox: 32 held inputs from any producer; ordinary messages are refused, the reply is not.
      // These fill capacity, not 32 extra reply turns with Git bookkeeping. The native mock
      // reads ack-only input but leaves it silent; the correlated reply still completes a turn.
      const now = new Date().toISOString();
      const held = Array.from({ length: 32 }, () => ({ id: randomUUID(), source: 'lifecycle' as const, parentRunId: f.p.id, text: 'mock:ack-only held', createdAt: now }));
      fixtureUpdateRun(f.w.id, { agentInputs: [...(store.getRun(f.w.id)?.agentInputs ?? []), ...held] });
      expect(store.getRun(f.w.id)?.agentInputs?.filter(input => !input.deliveredAt)).toHaveLength(32);
      await expect(progress()).rejects.toSatisfy(capacity);
      // Conversation: 1,023 messages plus the reply's reserved slot fill the 1,024.
      fillConversation(f.p.id, f.w.id, 1023);
      await expect(progress()).rejects.toSatisfy(capacity);
      const reply = await f.reply('mock:agent-echo Use the parser');
      await until(() => answered(f.w.id).length === 1);
      await until(() => said(f.w.id, 'Use the parser'));
      // Observe native consumption, so teardown does not race input still in the mock's pipe.
      await until(() => held.every(entry => !!store.getRun(f.w.id)?.agentInputs?.find(input => input.id === entry.id)?.consumedAt));
      const disk = readPersistedRuns(join(root, '.ai/cezar')) as Array<typeof f.p>;
      const persistedParent = disk.find(run => run.id === f.p.id)!;
      const conversation = persistedParent.delegation?.role === 'root' ? persistedParent.delegation.conversation : undefined;
      expect(conversation?.messages).toHaveLength(1024);
      expect(conversation?.messages.filter(message => message.id === reply.message.id)).toHaveLength(1);
      expect(conversation?.outcomes.filter(outcome => outcome.requestId === f.questionId)).toEqual([
        expect.objectContaining({ status: 'replied', replyId: reply.message.id }),
      ]);
      const persistedReply = disk.find(run => run.id === f.w.id)?.agentInputs?.find(input => input.id === reply.message.id);
      expect(persistedReply).toMatchObject({ deliveredAt: expect.any(String), consumedAt: expect.any(String) });
      expect(answered(f.w.id)).toHaveLength(1);
    } finally { f.close(); }
  });

it('admits the reply even when steering filled the worker inbox', async () => {
    const f = await askedPair();
    try {
      const steer = () => manager.steerWorker(f.w.id, { id: randomUUID(), source: agentInputSchema.shape.source.enum.agent, parentRunId: f.p.id, text: 'mock:agent-echo steer', createdAt: new Date().toISOString() });
      for (let i = 0; i < 32; i++) steer();
      expect(() => steer()).toThrow(expect.objectContaining({ code: 'capacity_limit' }));
      await f.reply('mock:agent-echo Use the parser');
      await until(() => answered(f.w.id).length === 1);
    } finally { f.close(); }
  });
});
