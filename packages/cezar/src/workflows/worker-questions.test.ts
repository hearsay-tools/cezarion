import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { fixtureUpdateRun, manager, parent, store, until, useWorkerWaitFixture, worker } from './worker-wait.testkit.ts';

/** #505 PR B: a worker's question goes to its owning parent, not to the human. */
describe('worker questions route to the parent (#505)', { timeout: 45_000 }, () => {
  useWorkerWaitFixture();
  const conversationOf = (rootId: string) => { const d = store.getRun(rootId)?.delegation; return d?.role === 'root' ? d.conversation : undefined; };
  const eventsOf = (runId: string, type: string) => store.readEvents(runId).filter(event => event.type === type);

  it("sends a worker's CEZ:ASK question to its active parent as a request", async () => {
    const p = await parent(); await until(() => store.getRun(p.id)?.status === 'waiting');
    const w = await worker(p.id, 'mock:ask'); manager.enqueueOwnedRun(w.id);
    await until(() => eventsOf(w.id, 'worker-question-routed').length === 1);
    const ask = eventsOf(w.id, 'ask.requested')[0]!;
    const routed = eventsOf(w.id, 'worker-question-routed')[0]!;
    expect(routed).toMatchObject({ askSeq: ask.seq, parentRunId: p.id });
    const message = conversationOf(p.id)?.messages.find(m => m.id === routed.messageId);
    expect(message).toMatchObject({ kind: 'request', senderRunId: w.id, recipientRunId: p.id, question: { questions: expect.any(Array) } });
    expect(message?.deadline).toBeUndefined();
    expect(store.getRun(p.id)?.agentInputs?.some(input => input.id === message!.id)).toBe(true);
    await until(() => store.getRun(w.id)?.status === 'waiting');
  });

  it('leaves the question with the human when the parent cannot take another message', async () => {
    const p = await parent(); await until(() => store.getRun(p.id)?.status === 'waiting');
    // 32 undelivered inputs fill the parent's inbox (plain input, so nothing wakes it).
    const now = new Date().toISOString();
    fixtureUpdateRun(p.id, { agentInputs: Array.from({ length: 32 }, () => ({ id: randomUUID(), source: 'agent' as const, parentRunId: p.id, text: 'queued', createdAt: now })) });
    const w = await worker(p.id, 'mock:ask'); manager.enqueueOwnedRun(w.id);
    await until(() => eventsOf(w.id, 'worker-question-fallback').length === 1);
    expect(eventsOf(w.id, 'worker-question-fallback')[0]).toMatchObject({ askSeq: eventsOf(w.id, 'ask.requested')[0]!.seq });
    expect(eventsOf(w.id, 'worker-question-routed')).toEqual([]);
    expect(conversationOf(p.id)?.messages.some(m => m.question) ?? false).toBe(false);
    await until(() => store.getRun(w.id)?.status === 'waiting');
  });
});
