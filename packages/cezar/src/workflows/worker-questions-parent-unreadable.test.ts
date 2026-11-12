import { randomUUID } from 'node:crypto';
import { uuidFrom } from '../delegation/questions.ts';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { eventCheckpoint, manager, restart, root, store, until } from './worker-wait-claude.testkit.ts';
import { readPersistedRuns } from '../runs/run-store.testkit.ts';
import { agentInputSchema } from '@open-mercato/cezar-contract/delegation';
import { conversationOf, eventsOf, squawkAnswered, noHumanCard, askedPair, said, useWorkerQuestionsFixture } from './worker-questions.testkit.ts';

describe("worker questions route to the parent (hearsay-tools/cezarion#505)", { timeout: 45_000 }, () => {
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
    await until(() => squawkAnswered(f.w.id).length >= 1);
    expect(eventsOf(f.w.id, 'worker-question-undelivered')[0]).toMatchObject({ askSeq, reason: 'the parent record cannot be read' });
    expect(squawkAnswered(f.w.id)[0]).toMatchObject({ askSeq });
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
    await until(() => squawkAnswered(f.w.id).length >= 1);
    expect(store.getRun(f.w.id)?.agentInputs?.some(input => input.id === id) ?? false).toBe(false);
    expect(said(f.w.id, 'Use the parser')).toBe(false);
    expect(eventsOf(f.w.id, 'human-input-delivered').filter(event => event.source === 'parent')).toEqual([]);
    noHumanCard(f.w.id);
  });

// A reply a live inbox claim holds cannot be retired; Cezar does not answer beside it.
  it('does not answer for an unreadable parent while a claimed parent reply stays queued', async () => {
    const f = await askedPair();
    try {
      const deliver = vi.spyOn(manager, 'deliverConversationInput').mockImplementation(() => {});
      const reply = await f.reply('mock:hold');
      store.claimInboxInputs(f.w.id, [reply.message.id], { receiptId: randomUUID(), generation: randomUUID(), expiresAt: new Date(Date.now() + 120_000).toISOString() });
      deliver.mockRestore();
      vi.spyOn(store, 'isUnreadable').mockImplementation(id => id === f.p.id);
      await manager.recover(f.p.id);
      expect(store.getRun(f.w.id)?.agentInputs?.find(input => input.id === reply.message.id)?.inboxClaim).toBeDefined();
      expect(store.getRun(f.w.id)?.agentInputs?.some(input => input.purpose === 'undelivered-question') ?? false).toBe(false);
      expect(eventsOf(f.w.id, 'worker-question-undelivered')).toEqual([]);
    } finally { vi.restoreAllMocks(); f.close(); }
  });

it('refuses human input on a routed question whose parent record cannot be read', async () => {
    const f = await askedPair();
    try {
      const getRun = store.getRun.bind(store);
      vi.spyOn(store, 'getRun').mockImplementation(id => id === f.p.id ? undefined : getRun(id));
      vi.spyOn(store, 'isUnreadable').mockImplementation(id => id === f.p.id);
      expect(manager.sendMessage(f.w.id, [{ type: 'text', text: 'human answer' }])).toBe(false);
      expect(eventsOf(f.w.id, 'human-input-delivered')).toEqual([]);
      expect(eventsOf(f.w.id, 'note')).toContainEqual(expect.objectContaining({ message: expect.stringContaining('parent') }));
    } finally { vi.restoreAllMocks(); f.close(); }
  });

// Cezar's answer queued for a routed question still answers it once the parent's ledger reads
  // again (here it always reads): the parent-reply lookup must not hide it.
  it("delivers Cezar's queued answer to a routed question whose parent reads", async () => {
    const f = await askedPair();
    try {
      const askSeq = eventsOf(f.w.id, 'ask.requested')[0]!.seq;
      // The lifecycle answer was committed before the parent became readable again.
      store.commitOutcome(f.w.id, { kind: 'charged', automaticWakes: 1 }, { enqueue: [{
        id: uuidFrom(`undelivered-question:${f.w.id}:${askSeq}`), source: 'lifecycle', purpose: 'undelivered-question',
        parentRunId: f.w.id, text: 'Choice: mock:hold', createdAt: new Date().toISOString(),
      }] });
      expect(store.getRun(f.w.id)?.agentInputs?.some(input => input.purpose === 'undelivered-question' && !input.deliveredAt)).toBe(true);
      manager.deliverConversationInput(f.w.id);
      await until(() => squawkAnswered(f.w.id).length === 1);
      expect(squawkAnswered(f.w.id)[0]).toMatchObject({ askSeq });
      noHumanCard(f.w.id);
    } finally { f.close(); }
  });
});
