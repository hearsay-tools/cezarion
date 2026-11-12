import { setRunStatus } from '../runs/run-store.testkit.ts';
import { describe, expect, it, vi } from 'vitest';
import { uuidFrom } from '../delegation/questions.ts';
import { delegatingParent, manager, store, until, worker } from './worker-wait-claude.testkit.ts';
import { RUN_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { conversationOf, eventsOf, squawkAnswered, noHumanCard, steeringParent, parentAtLastSlot, useWorkerQuestionsFixture } from './worker-questions.testkit.ts';

describe("worker questions route to the parent (hearsay-tools/cezarion#505)", { timeout: 45_000 }, () => {
  useWorkerQuestionsFixture();

it("sends a worker's cezar_ask question to its active parent as a request", async () => {
    const p = await steeringParent(); await until(() => store.getRun(p.id)?.status === 'waiting');
    const w = await worker(p.id, 'mock:cezar-ask'); manager.enqueueOwnedRun(w.id);
    await until(() => eventsOf(w.id, 'worker-question-routed').length === 1);
    const ask = eventsOf(w.id, 'ask.requested')[0]!;
    const routed = eventsOf(w.id, 'worker-question-routed')[0]!;
    expect(routed).toMatchObject({ askSeq: ask.seq, parentRunId: p.id });
    const message = conversationOf(p.id)?.messages.find(m => m.id === routed.messageId);
    expect(message).toMatchObject({ kind: 'request', senderRunId: w.id, recipientRunId: p.id, question: { questions: expect.any(Array) } });
    // hearsay-tools/cezarion#1808: the request carries the ask as the worker's event stored it, field for field.
    expect(message?.question).toStrictEqual({ questions: ask.questions, ...(ask.context === undefined ? {} : { context: ask.context }) });
    expect(message?.deadline).toBeUndefined();
    expect(store.getRun(p.id)?.agentInputs?.some(input => input.id === message!.id)).toBe(true);
    await until(() => store.getRun(w.id)?.status === 'waiting');
  });

// hearsay-tools/cezarion#2410: a live parent that cannot take the question does not pass it to a
  // human. Cezar answers the worker with the reason.
  it("answers the worker for the parent when an open peer request holds the parent's last inbox slot, and the reply still fits", async () => {
    const { p, service, callerFor } = await delegatingParent({ permissions: ['spawn', 'wait', 'steer'] });
    await until(() => store.getRun(p.id)?.status === 'waiting');
    const slot = await parentAtLastSlot(service, callerFor, p.id);
    const w = await worker(p.id, 'mock:cezar-ask'); manager.enqueueOwnedRun(w.id);
    await until(() => squawkAnswered(w.id).length === 1);
    const askSeq = eventsOf(w.id, 'ask.requested')[0]!.seq;
    expect(eventsOf(w.id, 'worker-question-undelivered')).toEqual([expect.objectContaining({ askSeq, reason: 'the parent conversation is at capacity' })]);
    expect(squawkAnswered(w.id)[0]).toMatchObject({ askSeq });
    noHumanCard(w.id);
    expect(eventsOf(w.id, 'worker-question-routed')).toEqual([]);
    expect(slot.undelivered()).toBe(31);
    expect((await slot.reply()).outcome).toMatchObject({ status: 'replied' });
    expect(slot.undelivered()).toBe(32);
  });

// hearsay-tools/cezarion#1990 review: a peer that sends first under the question's deterministic ID
  // keeps its ID and its sender; Cezar answers the worker (hearsay-tools/cezarion#2410).
  it('answers the worker for the parent when a peer message took its ID first', async () => {
    const { p, service, callerFor } = await delegatingParent({ permissions: ['spawn', 'wait', 'steer'] });
    await until(() => store.getRun(p.id)?.status === 'waiting');
    const w = await worker(p.id, 'mock:cezar-ask');
    const facts = store.transcriptFacts.bind(store);
    const route = vi.spyOn(store, 'transcriptFacts').mockImplementation(id => {
      const value = facts(id);
      const { pendingAsk: _pendingAsk, ...withoutAsk } = value;
      return id === w.id ? withoutAsk : value;
    });
    manager.enqueueOwnedRun(w.id);
    await until(() => eventsOf(w.id, 'ask.requested').length === 1);
    const askSeq = eventsOf(w.id, 'ask.requested')[0]!.seq;
    const id = uuidFrom(`worker-question:${w.id}:${askSeq}`);
    const peer = store.createRun({ title: 'peer', task: 'peer', workflow: 'quick-task', runner: 'claude', steps: [] });
    setRunStatus(store, peer.id, RUN_STATUS.running, { delegation: { role: 'root', permissions: ['spawn'], receipts: [] } });
    await service.send(callerFor(peer.id), { id, recipientRunId: p.id, kind: 'progress', text: 'Peer progress first', timeoutSeconds: 600 });
    expect(eventsOf(w.id, 'worker-question-routed')).toEqual([]);
    route.mockRestore();
    await manager.recover(p.id);
    expect(eventsOf(w.id, 'worker-question-routed')).toEqual([]);
    expect(eventsOf(w.id, 'worker-question-undelivered')).toEqual([expect.objectContaining({ askSeq, reason: expect.stringContaining('already in use') })]);
    await until(() => squawkAnswered(w.id).length === 1);
    noHumanCard(w.id);
    expect(conversationOf(p.id)?.messages.some(message => message.question) ?? false).toBe(false);
    expect(store.getRun(p.id)?.agentInputs?.filter(input => input.id === id)).toEqual([
      expect.objectContaining({ text: 'Peer progress first', conversation: expect.objectContaining({ senderRunId: peer.id, relationship: 'peer' }) })]);
  });
});
