import { randomUUID } from 'node:crypto';
import { uuidFrom } from '../delegation/questions.ts';
import { describe, expect, it, vi } from 'vitest';
import { WORKER_FALLBACK_HEADER, WORKER_FALLBACK_QUESTION } from './run.ts';
import { manager, spendWorkerBudget, store, until, worker } from './worker-wait-claude.testkit.ts';
import { hasPendingAsk } from '../runs/run-store.testkit.ts';
import { conversationOf, eventsOf, squawkAnswered, closedAs, noHumanCard, steeringParent, fillInbox, useWorkerQuestionsFixture } from './worker-questions.testkit.ts';

describe("worker questions route to the parent (hearsay-tools/cezarion#505)", { timeout: 45_000 }, () => {
  useWorkerQuestionsFixture();

it('answers the worker for the parent when the parent cannot take another message, once', async () => {
    const p = await steeringParent(); await until(() => store.getRun(p.id)?.status === 'waiting');
    fillInbox(p.id);
    const w = await worker(p.id, 'mock:cezar-ask'); manager.enqueueOwnedRun(w.id);
    await until(() => squawkAnswered(w.id).length === 1);
    const askSeq = eventsOf(w.id, 'ask.requested')[0]!.seq;
    const answer = store.getRun(w.id)?.agentInputs?.filter(input => input.purpose === 'undelivered-question');
    expect(answer).toEqual([expect.objectContaining({ source: 'lifecycle', deliveredAt: expect.any(String), text: expect.stringContaining(`Not delivered to your parent task ${p.id}: the parent conversation is at capacity.`) })]);
    // The answer carries its automatic-wake charge, so asking again cannot loop past the budget.
    expect(store.getRun(w.id)?.automaticWakes).toBeGreaterThanOrEqual(1);
    // Routing again finds the queued answer: no second answer and no second event.
    await manager.recover(p.id);
    expect(store.getRun(w.id)?.agentInputs?.filter(input => input.purpose === 'undelivered-question')).toHaveLength(1);
    expect(eventsOf(w.id, 'worker-question-undelivered')).toEqual([expect.objectContaining({ askSeq })]);
    expect(eventsOf(w.id, 'worker-question-routed')).toEqual([]);
    expect(conversationOf(p.id)?.messages.some(m => m.question) ?? false).toBe(false);
    noHumanCard(w.id);
  });

// A worker that stops with Squawk's answer still queued: recovery closes its question and retires
  // the answer, so neither stays behind to refuse a human Continue.
  it("closes a stopped worker's question when Squawk's answer is still queued", async () => {
    const p = await steeringParent(); await until(() => store.getRun(p.id)?.status === 'waiting');
    fillInbox(p.id);
    const w = await worker(p.id, 'mock:cezar-ask');
    const facts = store.transcriptFacts.bind(store);
    const route = vi.spyOn(store, 'transcriptFacts').mockImplementation(id => {
      const value = facts(id);
      const { pendingAsk: _pendingAsk, ...withoutAsk } = value;
      return id === w.id ? withoutAsk : value;
    });
    manager.enqueueOwnedRun(w.id);
    await until(() => eventsOf(w.id, 'ask.requested').length === 1 && store.getRun(w.id)?.status === 'waiting');
    const askSeq = eventsOf(w.id, 'ask.requested')[0]!.seq;
    const answer = uuidFrom(`undelivered-question:${w.id}:${askSeq}`);
    // A crash checkpoint after Squawk queued its answer, before it reached the provider.
    store.commitOutcome(w.id, { kind: 'charged', automaticWakes: 1 }, { enqueue: [{
      id: answer, source: 'lifecycle', purpose: 'undelivered-question', parentRunId: w.id,
      text: 'Choice: parent conversation at capacity', createdAt: new Date().toISOString(),
    }] });
    expect(store.getRun(w.id)?.agentInputs?.some(input => input.id === answer)).toBe(true);
    manager.cancel(w.id);
    await until(() => store.getRun(w.id)?.status === 'cancelled' && !manager.isActive(w.id));
    route.mockRestore();
    await manager.recover(p.id);
    expect(closedAs(w.id)).toContain('worker-stopped');
    expect(hasPendingAsk(store, w.id)).toBe(false);
    expect(store.getRun(w.id)?.agentInputs?.some(input => input.id === answer && !input.deliveredAt) ?? false).toBe(false);
  });

it('closes the question without an answer when the worker spent its automatic-wake budget', async () => {
    const p = await steeringParent(); await until(() => store.getRun(p.id)?.status === 'waiting');
    fillInbox(p.id);
    const w = await worker(p.id, 'mock:cezar-ask'); spendWorkerBudget(w.id); manager.enqueueOwnedRun(w.id);
    await until(() => closedAs(w.id).length === 1);
    expect(closedAs(w.id)).toEqual(['undeliverable']);
    expect(squawkAnswered(w.id)).toEqual([]);
    expect(store.getRun(w.id)?.agentInputs?.some(input => input.purpose === 'undelivered-question') ?? false).toBe(false);
    noHumanCard(w.id);
  });

// The guard for an ask no request can carry: every writer validates the ask today, so the event
  // is seeded here to pin that the guard answers the worker and never asks a human.
  it('answers the worker when its question is not a valid request', async () => {
    const p = await steeringParent(); await until(() => store.getRun(p.id)?.status === 'waiting');
    const w = await worker(p.id, 'mock:cezar-ask');
    const facts = store.transcriptFacts.bind(store);
    const route = vi.spyOn(store, 'transcriptFacts').mockImplementation(id => {
      const value = facts(id);
      const { pendingAsk: _pendingAsk, ...withoutAsk } = value;
      return id === w.id ? withoutAsk : value;
    });
    manager.enqueueOwnedRun(w.id);
    await until(() => eventsOf(w.id, 'ask.requested').length === 1 && store.getRun(w.id)?.status === 'waiting');
    const asked = eventsOf(w.id, 'ask.requested')[0]!;
    store.appendEvent(w.id, { type: 'ask.requested', requestId: randomUUID(), questions: asked.questions, context: 'x'.repeat(20_001) });
    route.mockRestore();
    await manager.recover(p.id);
    expect(eventsOf(w.id, 'worker-question-undelivered')).toEqual([expect.objectContaining({ reason: 'the question is not a valid request' })]);
    await until(() => squawkAnswered(w.id).length === 1);
    noHumanCard(w.id);
  });

// hearsay-tools/cezarion#1301: a worker's second turn end with no wait or done asks its parent. A
  // parent that cannot take Squawk's own question closes it, with no answer that would wake the worker
  // again, and the worker parks (hearsay-tools/cezarion#2410).
  it("closes Squawk's idle question when the parent cannot take it, and the worker parks", async () => {
    const p = await steeringParent(); await until(() => store.getRun(p.id)?.status === 'waiting');
    fillInbox(p.id);
    const w = await worker(p.id); manager.enqueueOwnedRun(w.id);
    await until(() => closedAs(w.id).length === 1 && store.getRun(w.id)?.status === 'waiting');
    const ask = eventsOf(w.id, 'ask.requested');
    expect(ask).toEqual([expect.objectContaining({ questions: [{ header: WORKER_FALLBACK_HEADER, question: WORKER_FALLBACK_QUESTION(w.id) }] })]);
    expect(eventsOf(w.id, 'human-ask-closed')).toEqual([expect.objectContaining({ askSeq: ask[0]!.seq, reason: 'undeliverable' })]);
    expect(squawkAnswered(w.id)).toEqual([]);
    expect(eventsOf(w.id, 'worker-question-routed')).toEqual([]);
    expect(conversationOf(p.id)?.messages.some(m => m.question) ?? false).toBe(false);
    noHumanCard(w.id);
  });

it('a budget-spent worker plain-parks without routing', async () => {
    const p = await steeringParent(); await until(() => store.getRun(p.id)?.status === 'waiting');
    const w = await worker(p.id); spendWorkerBudget(w.id); manager.enqueueOwnedRun(w.id);
    await until(() => eventsOf(w.id, 'turn-end').length > 0 && store.getRun(w.id)?.status === 'waiting');
    expect(eventsOf(w.id, 'ask.requested')).toEqual([]);
    expect(eventsOf(w.id, 'worker-question-routed')).toEqual([]);
    expect(conversationOf(p.id)?.messages ?? []).toEqual([]);
    expect(store.getRun(w.id)?.waits ?? []).toEqual([]);
  });
});
