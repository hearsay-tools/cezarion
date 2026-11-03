import { runInternals } from './run-internals.testkit.ts';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { eventCheckpoint, manager, restart, root, store, until } from './worker-wait.testkit.ts';
import { readPersistedRuns } from '../runs/run-store.testkit.ts';
import { agentInputSchema } from '@open-mercato/cezar-contract/delegation';
import { conversationOf, eventsOf, cezarAnswered, noHumanCard, askedPair, said, useWorkerQuestionsFixture } from './worker-questions.testkit.ts';

describe("worker questions route to the parent (#505)", { timeout: 45_000 }, () => {
  useWorkerQuestionsFixture();

// The worker's own routing marker keeps the question the parent's when the parent's ledger cannot
  // be read; recovery cannot route it there again, so Cezar answers it and no human does.
  it('answers a routed question for the parent when the parent record cannot be read after a restart', async () => {
    const f = await askedPair();
    f.close();
    const askSeq = eventsOf(f.w.id, 'ask.requested')[0]!.seq;
    const events = eventCheckpoint();
    const disk = readPersistedRuns(join(root, '.ai/cezar')) as Array<{ id: string; status: string }>;
    for (const run of disk) if (run.id === f.p.id) run.status = 'unknown-status';
    await restart(false, disk, events);
    expect(store.isUnreadable(f.p.id)).toBe(true);
    // The mock asks again after the answer; each question it raises gets Cezar's answer.
    await until(() => cezarAnswered(f.w.id).length >= 1);
    expect(eventsOf(f.w.id, 'worker-question-undelivered')[0]).toMatchObject({ askSeq, reason: 'the parent record cannot be read' });
    expect(cezarAnswered(f.w.id)[0]).toMatchObject({ askSeq });
    expect(eventsOf(f.w.id, 'human-input-delivered').filter(event => event.source !== 'cezar')).toEqual([]);
    noHumanCard(f.w.id);
  });

// A reply the parent sent before its record became unreadable is retired before Cezar answers, so
  // the worker takes one answer: neither bundled with Cezar's nor replayed after it.
  it('retires an accepted parent reply before answering for a parent whose record cannot be read', async () => {
    const f = await askedPair();
    f.close();
    const id = randomUUID(); const now = new Date().toISOString();
    const attribution = { senderRunId: f.p.id, recipientRunId: f.w.id, kind: 'reply' as const, requestId: f.questionId };
    const state = conversationOf(f.p.id)!;
    store.commitConversation(f.p.id, { messages: [...state.messages, { id, ...attribution, text: 'mock:agent-echo Use the parser', createdAt: now, requestHash: 'c'.repeat(64), state: 'accepted' }],
      outcomes: [...state.outcomes, { requestId: f.questionId, status: 'replied', observedAt: now, replyId: id }] },
    { recipientRunId: f.w.id, input: { id, source: agentInputSchema.shape.source.enum.agent, parentRunId: f.p.id, text: 'mock:agent-echo Use the parser', createdAt: now, conversation: attribution } });
    const events = eventCheckpoint();
    const disk = readPersistedRuns(join(root, '.ai/cezar')) as Array<{ id: string; status: string }>;
    for (const run of disk) if (run.id === f.p.id) run.status = 'unknown-status';
    await restart(false, disk, events);
    await until(() => cezarAnswered(f.w.id).length >= 1);
    expect(store.getRun(f.w.id)?.agentInputs?.some(input => input.id === id) ?? false).toBe(false);
    expect(said(f.w.id, 'Use the parser')).toBe(false);
    expect(eventsOf(f.w.id, 'human-input-delivered').filter(event => event.source === 'parent')).toEqual([]);
    noHumanCard(f.w.id);
  });

// A reply a live inbox claim holds cannot be retired; Cezar does not answer beside it.
  it('does not answer for an unreadable parent while a claimed parent reply stays queued', async () => {
    const f = await askedPair();
    try {
      const reply = await f.reply('mock:hold');
      const routing = runInternals(manager).workerQuestions;
      vi.spyOn(store, 'isUnreadable').mockImplementation(id => id === f.p.id);
      // The claim keeps the reply where it is, as `retireUnreadParentQuestion` leaves a claimed input.
      const retire = vi.spyOn(routing, 'retireUnreadParentQuestion').mockImplementation(() => {});
      runInternals(manager).workerQuestions.routeWorkerQuestion(f.w.id);
      expect(retire).toHaveBeenCalledWith(f.w.id, reply.message.id);
      expect(store.getRun(f.w.id)?.agentInputs?.some(input => input.purpose === 'undelivered-question') ?? false).toBe(false);
      expect(eventsOf(f.w.id, 'worker-question-undelivered')).toEqual([]);
    } finally { vi.restoreAllMocks(); f.close(); }
  });

it('refuses human input on a routed question whose parent record cannot be read', () => {
    const routing = runInternals(manager).workerQuestions;
    const ask = { seq: 3, requestId: 'r', questions: [], routedMessageId: randomUUID() };
    const worker = { id: randomUUID(), delegation: { role: 'worker' as const } };
    vi.spyOn(store, 'getRun').mockImplementation(id => { return (id === worker.id ? worker : undefined) as never; });
    vi.spyOn(store, 'transcriptFacts').mockReturnValue({ pendingAsk: ask } as never);
    // routedAsk cannot load the parent's message, yet the question stays the parent's.
    expect(routing.routedAsk(worker.id)).toBeUndefined();
    expect(routing.answeredElsewhere(worker.id)).toBe(true);
  });

// Cezar's answer queued for a routed question still answers it once the parent's ledger reads
  // again (here it always reads): the parent-reply lookup must not hide it.
  it("delivers Cezar's queued answer to a routed question whose parent reads", async () => {
    const f = await askedPair();
    try {
      const askSeq = eventsOf(f.w.id, 'ask.requested')[0]!.seq;
      runInternals(manager).workerQuestions.answerUndelivered(f.w.id, askSeq, 'the parent record cannot be read');
      await until(() => cezarAnswered(f.w.id).length === 1);
      expect(cezarAnswered(f.w.id)[0]).toMatchObject({ askSeq });
      noHumanCard(f.w.id);
    } finally { f.close(); }
  });
});
