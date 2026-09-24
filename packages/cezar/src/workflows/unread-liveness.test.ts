import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { AgentInput } from '@open-mercato/cezar-contract';
import { manager, parent, store, until, useWorkerWaitFixture, worker } from './worker-wait.testkit.ts';

/** #505 review: accepted input a harness never reads must not hold the run forever. */
describe('unread input liveness bound (#505)', { timeout: 45_000 }, () => {
  useWorkerWaitFixture();
  async function sendDropped(text: string) {
    // The line lands while the parent's turn runs; the harness then never runs it.
    const p = await parent('mock:hold');
    (manager as unknown as { unreadInputGraceMs: number }).unreadInputGraceMs = 300;
    const w = await worker(p.id);
    const id = randomUUID(); const createdAt = new Date().toISOString();
    const input: AgentInput = { id, source: 'agent', parentRunId: p.id, text, createdAt, conversation: { senderRunId: w.id, recipientRunId: p.id, kind: 'progress' } };
    store.commitConversation(p.id, { messages: [{ id, senderRunId: w.id, recipientRunId: p.id, kind: 'progress', text, createdAt, requestHash: 'a'.repeat(64), state: 'accepted' }], outcomes: [] },
      { recipientRunId: p.id, input });
    manager.deliverConversationInput(p.id);
    return { p, id };
  }
  const inputOf = (runId: string, id: string) => store.getRun(runId)?.agentInputs?.find(input => input.id === id);
  // A parent with a live worker parks as monitoring; without one, as waiting.
  const parked = (runId: string) => store.getRun(runId)?.status === 'waiting' || store.getRun(runId)?.activity === 'monitoring';

  it('resubmits input the harness accepted and silently dropped, then it is read', async () => {
    vi.stubEnv('CEZ_MOCK_DROP_LINES', 'drop-me'); vi.stubEnv('CEZ_MOCK_DROP_ONCE', '1');
    const { p, id } = await sendDropped('drop-me once');
    await until(() => !!inputOf(p.id, id)?.consumedAt);
    expect(store.readEvents(p.id).some(event => event.type === 'note' && String(event.message).includes('did not read'))).toBe(true);
    await until(() => parked(p.id));
  });

  it('stops tracking input the harness never reads, and the run parks normally', async () => {
    vi.stubEnv('CEZ_MOCK_DROP_LINES', 'drop-me');
    const { p, id } = await sendDropped('drop-me always');
    await until(() => store.readEvents(p.id).some(event => event.type === 'note' && String(event.message).includes('did not confirm')));
    expect(inputOf(p.id, id)).toMatchObject({ deliveredAt: expect.any(String) });
    expect(inputOf(p.id, id)?.awaitingRead).toBeUndefined();
    await until(() => parked(p.id));
  });
});
