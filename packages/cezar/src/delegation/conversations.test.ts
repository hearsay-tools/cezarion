import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ConversationMessage } from '@open-mercato/cezar-contract';
import type { RunRecord } from '../runs/store.ts';
import { reconcileConversationState } from './conversations.ts';
const now = '2026-09-08T20:00:00.000Z';
function records() {
  const root = { id: randomUUID(), status: 'running', delegation: { role: 'root', permissions: [], receipts: [], conversation: { messages: [], outcomes: [] } } } as unknown as RunRecord;
  const worker = { id: randomUUID(), status: 'running', delegation: { role: 'worker' } } as unknown as RunRecord;
  const request: ConversationMessage = { id: randomUUID(), senderRunId: root.id, recipientRunId: worker.id, kind: 'request', text: 'question', createdAt: now, deadline: '2026-09-08T20:10:00.000Z', requestHash: 'a'.repeat(64), state: 'accepted' };
  if (root.delegation?.role !== 'root') throw Error('fixture'); root.delegation.conversation!.messages.push(request);
  return { root, worker, request };
}
describe('conversation settlement', () => {
  it.each([['done', 'completed-without-reply'], ['failed', 'failed'], ['cancelled', 'cancelled']] as const)('settles %s only after lifecycle proof', (status, expected) => {
    const { root, worker, request } = records(); worker.status = status;
    expect(reconcileConversationState(root, [root, worker], now, () => false)?.outcomes).toEqual([]);
    expect(reconcileConversationState(root, [root, worker], now, () => true)?.outcomes).toEqual([{ requestId: request.id, status: expected, observedAt: now }]);
  });
  it('review does not settle; deadline does, and the first recorded result survives later lifecycle changes', () => {
    const { root, worker } = records(); worker.status = 'review';
    expect(reconcileConversationState(root, [root, worker], now, () => true)?.outcomes).toEqual([]);
    const timedOut = reconcileConversationState(root, [root, worker], '2026-09-08T20:11:00.000Z', () => true)!;
    expect(timedOut.outcomes[0]?.status).toBe('timed-out');
    if (root.delegation?.role !== 'root') throw Error('fixture'); root.delegation.conversation = timedOut; worker.status = 'done';
    expect(reconcileConversationState(root, [root, worker], '2026-09-08T20:12:00.000Z', () => true)).toBe(timedOut);
  });
  it('recipient root completion settles without reply only after finalization', () => {
    const { root, worker, request } = records(); root.status = 'done'; request.senderRunId = worker.id; request.recipientRunId = root.id;
    expect(reconcileConversationState(root, [root, worker], now, () => false)?.outcomes).toEqual([]);
    expect(reconcileConversationState(root, [root, worker], now, () => true)?.outcomes[0]?.status).toBe('completed-without-reply');
  });
  it('settles a missing recipient only from completed owned deletion proof', () => {
    const { root, worker, request } = records();
    if (root.delegation?.role !== 'root') throw Error('fixture');
    const deletion = { phase: 'pending' as 'pending' | 'complete', revision: 0, resourceId: randomUUID(), generation: randomUUID() };
    root.delegation.receipts.push({ workerId: worker.id, requestId: randomUUID(), requestHash: 'b'.repeat(64), deletion });
    expect(reconcileConversationState(root, [root], now, () => true)?.outcomes).toEqual([]);
    deletion.phase = 'complete';
    expect(reconcileConversationState(root, [root], now, () => false)?.outcomes).toEqual([{ requestId: request.id, status: 'destroyed', observedAt: now }]);
  });


  it('projects a consumed message once, above its delivered projection (#505)', async () => {
    const { projectConversationEvents } = await import('./conversations.ts');
    const { root, worker, request } = records();
    const byRun = new Map<string, Array<Record<string, unknown>>>();
    const eventsOf = (id: string) => { if (!byRun.has(id)) byRun.set(id, []); return byRun.get(id)!; };
    worker.agentInputs = [{ id: request.id, source: 'agent', parentRunId: root.id, text: request.text, createdAt: now,
      deliveredAt: '2026-09-08T20:00:01.000Z', consumedAt: '2026-09-08T20:00:05.000Z' }];
    const store = { getRun: (id: string) => [root, worker].find(run => run.id === id), readEvents: (id: string) => eventsOf(id),
      appendEvent: (id: string, event: Record<string, unknown>) => { eventsOf(id).push(event); } } as unknown as import('../runs/store.ts').RunStore;
    projectConversationEvents(store, root); projectConversationEvents(store, root);
    const consumed = [...byRun.values()].flat().filter(event => event.type === 'conversation-message' && event.delivery === 'consumed');
    expect(consumed).toHaveLength(2); // one per participant
    const delivered = [...byRun.values()].flat().filter(event => event.type === 'conversation-message' && event.delivery === 'delivered');
    expect(delivered).toHaveLength(2); // the delivered step is never skipped
    expect(consumed[0]).toMatchObject({ consumedAt: '2026-09-08T20:00:05.000Z', deliveredAt: '2026-09-08T20:00:01.000Z' });
  });
});
