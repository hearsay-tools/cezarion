import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DelegationPolicyError } from '../delegation/policy.ts';
import { manager, store, until, waitOf, worker } from './worker-wait-claude.testkit.ts';
import { hasPendingAsk } from '../runs/run-store.testkit.ts';
import { eventsOf, steeringParent, askedPair, answered, said, useWorkerQuestionsFixture } from './worker-questions.testkit.ts';

describe("worker questions route to the parent (hearsay-tools/cezarion#505)", { timeout: 45_000 }, () => {
  useWorkerQuestionsFixture();

it('a correlated parent reply unblocks the worker without human input', async () => {
    const f = await askedPair();
    try {
      const reply = randomUUID();
      await f.reply('mock:agent-echo Use the parser', reply);
      await until(() => answered(f.w.id).length === 1);
      expect(answered(f.w.id)[0]).toMatchObject({ askSeq: eventsOf(f.w.id, 'ask.requested')[0]!.seq });
      await until(() => said(f.w.id, 'Use the parser'));
      expect(store.getRun(f.w.id)?.agentInputs?.find(input => input.id === reply)?.deliveredAt).toBeDefined();
      expect(eventsOf(f.w.id, 'user-message').some(event => String(event.text).includes('Use the parser'))).toBe(false);
    } finally { f.close(); }
  });

it("retires the answer's wake so later messages still reach the worker", async () => {
    const f = await askedPair();
    try {
      // The answer's turn runs ~25 s, so anything sent now must steer it, not wait it out.
      await f.reply('mock:slow Use the parser');
      await until(() => answered(f.w.id).length === 1);
      expect(waitOf(store.getRun(f.w.id))).toBeUndefined();
      const later = randomUUID();
      await f.service.send(f.parentCaller, { id: later, recipientRunId: f.w.id, kind: 'progress', text: 'mock:agent-echo Also lint', timeoutSeconds: 600 });
      await until(() => !!store.getRun(f.w.id)?.agentInputs?.find(input => input.id === later)?.deliveredAt);
    } finally { f.close(); }
  });

it('progress and follow-ups never answer a pending worker question', async () => {
    const f = await askedPair();
    try {
      const request = randomUUID(); const progress = randomUUID(); const followUp = randomUUID();
      await f.service.send(f.parentCaller, { id: request, recipientRunId: f.w.id, kind: 'request', text: 'mock:agent-echo Also check lint', timeoutSeconds: 600 });
      await f.service.send(f.parentCaller, { id: progress, recipientRunId: f.w.id, kind: 'progress', text: 'mock:agent-echo Still thinking', timeoutSeconds: 600 });
      await f.service.send(f.parentCaller, { id: followUp, recipientRunId: f.w.id, kind: 'follow-up', requestId: request, text: 'mock:agent-echo Only src', timeoutSeconds: 600 });
      manager.deliverConversationInput(f.w.id);
      // hearsay-tools/cezarion#1235: a pending question no longer holds them; they reach the
      // worker beside it, and none of them answers it.
      const beside = () => store.getRun(f.w.id)?.agentInputs?.filter(input => [request, progress, followUp].some(id => id === input.id)) ?? [];
      await until(() => beside().length === 3 && beside().every(input => !!input.deliveredAt));
      await until(() => said(f.w.id, 'Only src'));
      expect(answered(f.w.id)).toEqual([]);
      await until(() => store.getRun(f.w.id)?.status === 'waiting' && hasPendingAsk(store, f.w.id) === true);
      await f.reply('mock:agent-echo Use the parser');
      await until(() => answered(f.w.id).length === 1);
    } finally { f.close(); }
  });

// hearsay-tools/cezarion#1235: the worker's question reaches the parent beside the parent's own
  // pending question, which stays the human's to answer.
  it('delivers a worker question beside the parent\'s own pending question, which stays answerable', async () => {
    const p = await steeringParent('mock:cezar-ask'); await until(() => eventsOf(p.id, 'ask.requested').length === 1 && store.getRun(p.id)?.status === 'waiting');
    const w = await worker(p.id, 'mock:cezar-ask'); manager.enqueueOwnedRun(w.id);
    await until(() => eventsOf(w.id, 'worker-question-routed').length === 1);
    const questionId = String(eventsOf(w.id, 'worker-question-routed')[0]!.messageId);
    const question = () => store.getRun(p.id)?.agentInputs?.find(input => input.id === questionId);
    expect(question()).toBeDefined();
    await until(() => !!question()?.deliveredAt);
    expect(eventsOf(p.id, 'human-input-delivered')).toEqual([]);
    await until(() => store.getRun(p.id)?.status === 'waiting' && hasPendingAsk(store, p.id) === true);
    expect(manager.sendMessage(p.id, [{ type: 'text', text: 'Vitest' }])).toBe(true);
    await until(() => eventsOf(p.id, 'human-input-delivered').length === 1);
    const human = eventsOf(p.id, 'human-input-delivered');
    expect(human).toHaveLength(1);
    expect(human[0]!.source).toBeUndefined();
  });

it('refuses a second reply to an answered question', async () => {
    const f = await askedPair();
    try {
      await f.reply('mock:agent-echo Use the parser');
      await until(() => answered(f.w.id).length === 1);
      await expect(f.reply('mock:agent-echo Use the lexer')).rejects.toSatisfy(error =>
        error instanceof DelegationPolicyError && error.message === 'This question was already answered');
      expect(answered(f.w.id)).toHaveLength(1);
    } finally { f.close(); }
  });
});
