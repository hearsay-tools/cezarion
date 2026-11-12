import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { eventCheckpoint, manager, restart, root, store, until } from './worker-wait-claude.testkit.ts';
import { readPersistedRuns } from '../runs/run-store.testkit.ts';
import { agentInputSchema } from '@open-mercato/cezar-contract/delegation';
import { requestOutcomeSchema } from '@open-mercato/cezar-contract/conversations';
import { conversationOf, closedAs, noHumanCard, askedPair, answered, said, expectSettledParentRefusal, useWorkerQuestionsFixture } from './worker-questions.testkit.ts';

describe("worker questions route to the parent (hearsay-tools/cezarion#505)", { timeout: 45_000 }, () => {
  useWorkerQuestionsFixture();

// A crash after the parent's cancellation committed, before the family pass that ends its workers.
  it('closes a routed question on recovery when the parent was cancelled before the crash', async () => {
    const f = await askedPair();
    f.close();
    const events = eventCheckpoint();
    const disk = readPersistedRuns(join(root, '.ai/cezar')) as Array<{ id: string; status: string }>;
    for (const run of disk) if (run.id === f.p.id) run.status = 'cancelled';
    await restart(false, disk, events);
    await until(() => closedAs(f.w.id).length === 1 && store.getRun(f.w.id)?.status === 'cancelled' && !manager.isActive(f.w.id));
    expect(closedAs(f.w.id)).toEqual(['parent-stopped']);
    expect(conversationOf(f.p.id)?.outcomes).toEqual([expect.objectContaining({ requestId: f.questionId, status: requestOutcomeSchema.shape.status.enum.cancelled })]);
    noHumanCard(f.w.id);
    expectSettledParentRefusal(f.w.id, f.p.id, 'cancelled');
  });

// hearsay-tools/squawk#3337: a failed parent closes its workers' questions but leaves them running.
  it('closes a routed question on recovery when the parent failed, and keeps the worker', async () => {
    const f = await askedPair();
    f.close();
    const events = eventCheckpoint();
    const disk = readPersistedRuns(join(root, '.ai/cezar')) as Array<{ id: string; status: string }>;
    for (const run of disk) if (run.id === f.p.id) run.status = 'failed';
    await restart(false, disk, events);
    await until(() => closedAs(f.w.id).length === 1);
    expect(closedAs(f.w.id)).toEqual(['parent-stopped']);
    noHumanCard(f.w.id);
    expect(store.getRun(f.w.id)?.status).not.toBe('cancelled');
  });

it('answers the worker after a crash between accepting the reply and delivering it', async () => {
    const f = await askedPair();
    f.close();
    // The accepted reply, committed exactly as the service does, before any delivery attempt.
    const id = randomUUID(); const now = new Date().toISOString();
    const attribution = { senderRunId: f.p.id, recipientRunId: f.w.id, kind: 'reply' as const, requestId: f.questionId };
    const state = conversationOf(f.p.id)!;
    store.commitConversation(f.p.id, { messages: [...state.messages, { id, ...attribution, text: 'mock:agent-echo Use the parser', createdAt: now, requestHash: 'c'.repeat(64), state: 'accepted' }],
      outcomes: [...state.outcomes, { requestId: f.questionId, status: 'replied', observedAt: now, replyId: id }] },
    { recipientRunId: f.w.id, input: { id, source: agentInputSchema.shape.source.enum.agent, parentRunId: f.p.id, text: 'mock:agent-echo Use the parser', createdAt: now, conversation: attribution } });
    await restart(false, undefined, eventCheckpoint());
    await until(() => answered(f.w.id).length === 1);
    await until(() => said(f.w.id, 'Use the parser'));
  });

// A reply accepted before the parent's cancellation, then a crash before the family pass: recovery
  // closes the question with its parent and the reply never reaches the worker.
  it('closes a routed question on recovery when an accepted reply waited and the parent was cancelled', async () => {
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
    for (const run of disk) if (run.id === f.p.id) run.status = 'cancelled';
    await restart(false, disk, events);
    await until(() => closedAs(f.w.id).length === 1 && store.getRun(f.w.id)?.status === 'cancelled' && !manager.isActive(f.w.id));
    expect(closedAs(f.w.id)).toEqual(['parent-stopped']);
    expect(answered(f.w.id)).toEqual([]);
    expect(said(f.w.id, 'Use the parser')).toBe(false);
    expect(store.getRun(f.w.id)?.agentInputs?.some(input => input.id === id) ?? false).toBe(false);
    noHumanCard(f.w.id);
  });
});
