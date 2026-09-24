import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { AgentInput, ConversationMessage } from '@open-mercato/cezar-contract';
import type { AgentSession } from '../core/agent-runner.ts';
import { manager, parent, store, until, useWorkerWaitFixture, worker } from './worker-wait.testkit.ts';

/** One accumulating conversation per root, committed the way the delegation service does. */
function conversation(rootId: string) {
  const messages: ConversationMessage[] = [];
  return (senderRunId: string, recipientRunId: string, kind: 'request' | 'progress', text: string): AgentInput => {
    const id = randomUUID(); const createdAt = new Date().toISOString();
    messages.push({ id, senderRunId, recipientRunId, kind, text, createdAt, requestHash: 'a'.repeat(64), state: 'accepted',
      ...(kind === 'request' ? { deadline: new Date(Date.now() + 600_000).toISOString() } : {}) });
    const input: AgentInput = { id, source: 'agent', parentRunId: rootId, text, createdAt, conversation: { senderRunId, recipientRunId, kind } };
    store.commitConversation(rootId, { messages: [...messages], outcomes: [] }, { recipientRunId, input });
    return input;
  };
}
const inputOf = (runId: string, id: string) => store.getRun(runId)?.agentInputs?.find(input => input.id === id);
const turnEnds = (runId: string) => store.readEvents(runId).filter(event => event.type === 'turn-end').length;
const sessionOf = (runId: string) => (manager as unknown as { active: Map<string, { session: AgentSession }> }).active.get(runId)!.session;

describe('immediate conversation delivery (#505)', { timeout: 45_000 }, () => {
  useWorkerWaitFixture();

  it("delivers a parent message into a worker's long first turn and records when it is read", async () => {
    vi.stubEnv('CEZ_MOCK_STEER_MS', '4000');
    const p = await parent(); await until(() => store.getRun(p.id)?.status === 'waiting');
    const w = await worker(p.id, 'mock:steer-tool'); manager.enqueueOwnedRun(w.id);
    await until(() => store.readEvents(w.id).some(event => event.type === 'tool-call'));
    const input = conversation(p.id)(p.id, w.id, 'progress', 'API correction: use v2');
    manager.deliverConversationInput(w.id);
    await until(() => !!inputOf(w.id, input.id)?.deliveredAt);
    expect(inputOf(w.id, input.id)?.consumedAt).toBeUndefined();
    expect(turnEnds(w.id)).toBe(0); // still the first turn
    await until(() => !!inputOf(w.id, input.id)?.consumedAt);
    await until(() => turnEnds(w.id) === 1);
    expect(store.readEvents(w.id).filter(event => event.type === 'text' && String(event.text).includes('API correction'))).toHaveLength(1);
  });

  it("delivers a worker message into the parent's running turn", async () => {
    vi.stubEnv('CEZ_MOCK_STEER_MS', '4000');
    const p = await parent('mock:steer-tool');
    const w = await worker(p.id);
    await until(() => store.readEvents(p.id).some(event => event.type === 'tool-call'));
    const input = conversation(p.id)(w.id, p.id, 'progress', 'Worker progress: tests pass');
    manager.deliverConversationInput(p.id);
    await until(() => !!inputOf(p.id, input.id)?.deliveredAt);
    expect(turnEnds(p.id)).toBe(0);
    await until(() => !!inputOf(p.id, input.id)?.consumedAt);
    await until(() => turnEnds(p.id) === 1);
  });

  it('steers later input into a resumed opening turn', async () => {
    vi.stubEnv('CEZ_MOCK_STEER_MS', '4000');
    const p = await parent(); await until(() => store.getRun(p.id)?.status === 'waiting');
    const w = await worker(p.id); manager.enqueueOwnedRun(w.id);
    await until(() => store.getRun(w.id)?.status === 'waiting');
    manager.finish(w.id); await until(() => !manager.isActive(w.id));
    // The service's --resume path: the opening message rides continueRun, not the queue.
    const now = new Date().toISOString();
    const opening: ConversationMessage = { id: randomUUID(), senderRunId: p.id, recipientRunId: w.id, kind: 'request',
      text: 'mock:steer-tool resume with a new instruction', createdAt: now, deadline: new Date(Date.now() + 600_000).toISOString(),
      requestHash: 'a'.repeat(64), state: 'accepted', resumed: true };
    const openingInput: AgentInput = { id: opening.id, source: 'agent', parentRunId: p.id, text: opening.text, createdAt: now,
      conversation: { senderRunId: p.id, recipientRunId: w.id, kind: 'request' } };
    const seq = store.readEvents(w.id).at(-1)!.seq;
    expect(manager.continueRun(w.id, { text: opening.text }, true, { rootId: p.id, state: { messages: [opening], outcomes: [] }, input: openingInput }).ok).toBe(true);
    await until(() => store.readEvents(w.id).some(event => event.seq > seq && event.type === 'tool-call'));
    // The opening prompt was accepted; its replay checkpoint still waits for the turn to end.
    expect(inputOf(w.id, opening.id)?.deliveredAt).toBeTruthy();
    expect(store.getRun(w.id)?.continuationMessage).toBeDefined();
    const laterId = randomUUID();
    const later: ConversationMessage = { ...opening, id: laterId, kind: 'progress', text: 'Later scope guidance', deadline: undefined, resumed: undefined };
    const { deadline: _d, resumed: _r, ...laterMessage } = later;
    store.commitConversation(p.id, { messages: [opening, laterMessage], outcomes: [] }, { recipientRunId: w.id,
      input: { ...openingInput, id: laterId, text: later.text, conversation: { senderRunId: p.id, recipientRunId: w.id, kind: 'progress' } } });
    manager.deliverConversationInput(w.id);
    await until(() => !!inputOf(w.id, laterId)?.consumedAt);
    await until(() => store.readEvents(w.id).some(event => event.seq > seq && event.type === 'turn-end'));
    // Read inside the opening turn: no later than that turn's end, and in its one turn.
    const openingEnd = store.readEvents(w.id).find(event => event.seq > seq && event.type === 'turn-end')!;
    expect(Date.parse(inputOf(w.id, laterId)!.consumedAt!)).toBeLessThanOrEqual(Date.parse(openingEnd.ts));
    expect(store.readEvents(w.id).filter(event => event.seq > seq && event.type === 'turn-end')).toHaveLength(1);
    await until(() => store.getRun(w.id)?.continuationMessage === undefined);
    // The opening instruction was handled by that successful turn: its sender sees it read.
    expect(inputOf(w.id, opening.id)?.consumedAt).toBeTruthy();
  });

  it('drains a 40-message burst as FIFO submissions of 32 and 8', async () => {
    vi.stubEnv('CEZ_MOCK_STEER_MS', '2500');
    const p = await parent(); await until(() => store.getRun(p.id)?.status === 'waiting');
    const w = await worker(p.id, 'mock:steer-tool'); manager.enqueueOwnedRun(w.id);
    await until(() => store.readEvents(w.id).some(event => event.type === 'tool-call'));
    const spy = vi.spyOn(sessionOf(w.id), 'sendAgentMessage');
    const send = conversation(p.id);
    const inputs = Array.from({ length: 40 }, (_, i) => send(p.id, w.id, 'progress', `burst ${String(i).padStart(2, '0')}`));
    manager.deliverConversationInput(w.id);
    await until(() => inputs.every(input => !!inputOf(w.id, input.id)?.deliveredAt));
    const accepted = spy.mock.calls.filter((_, i) => spy.mock.results[i]?.value !== false).map(call => call[1] ?? []);
    expect(accepted.map(ids => ids.length)).toEqual([32, 8]);
    expect(accepted.flat()).toEqual(inputs.map(input => input.id));
  });

  it('delivers held messages right behind a human answer, in the same submission, never as the answer', async () => {
    const p = await parent('mock:ask');
    await until(() => store.readEvents(p.id).some(event => event.type === 'ask.requested'));
    await until(() => store.getRun(p.id)?.status === 'waiting');
    const w = await worker(p.id);
    const send = conversation(p.id);
    const held = ['first finding', 'second finding', 'third finding'].map(text => send(w.id, p.id, 'progress', text));
    manager.deliverConversationInput(p.id);
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(held.every(input => !inputOf(p.id, input.id)?.deliveredAt)).toBe(true); // the human question holds them
    const write = vi.spyOn(sessionOf(p.id), 'sendMessage');
    expect(manager.sendMessage(p.id, [{ type: 'text', text: 'mock:agent-echo use Vitest' }])).toBe(true);
    expect(write).toHaveBeenCalledTimes(1);
    const content = JSON.stringify(write.mock.calls[0]![0]);
    const at = (needle: string) => content.indexOf(needle);
    expect(at('use Vitest')).toBeGreaterThan(-1);
    for (const input of held) expect(at(input.id)).toBeGreaterThan(at('use Vitest'));
    expect(new Set(held.map(input => inputOf(p.id, input.id)?.deliveredAt)).size).toBe(1);
    expect(store.readEvents(p.id).filter(event => event.type === 'human-input-delivered')).toHaveLength(1);
    await until(() => held.every(input => !!inputOf(p.id, input.id)?.consumedAt));
  });

  it('returns bundled messages to the queue when the answer turn fails (#505 review)', async () => {
    const p = await parent('mock:ask');
    await until(() => store.readEvents(p.id).some(event => event.type === 'ask.requested'));
    await until(() => store.getRun(p.id)?.status === 'waiting');
    const w = await worker(p.id);
    const held = conversation(p.id)(w.id, p.id, 'progress', 'finding held behind the question');
    manager.deliverConversationInput(p.id);
    expect(manager.sendMessage(p.id, [{ type: 'text', text: 'mock:auth-error answer' }])).toBe(true);
    await until(() => !manager.isActive(p.id));
    expect(inputOf(p.id, held.id)?.deliveredAt).toBeUndefined();
    expect(inputOf(p.id, held.id)?.awaitingRead).toBeUndefined();
  });

  it('returns a resumed opening input to the queue when its opening turn fails (#505 review)', async () => {
    const p = await parent(); await until(() => store.getRun(p.id)?.status === 'waiting');
    const w = await worker(p.id, 'inspect the working tree'); manager.enqueueOwnedRun(w.id);
    await until(() => store.getRun(w.id)?.status === 'waiting');
    manager.finish(w.id); await until(() => !manager.isActive(w.id));
    const now = new Date().toISOString();
    const opening: ConversationMessage = { id: randomUUID(), senderRunId: p.id, recipientRunId: w.id, kind: 'request',
      text: 'mock:auth-error resume instruction', createdAt: now, deadline: new Date(Date.now() + 600_000).toISOString(),
      requestHash: 'a'.repeat(64), state: 'accepted', resumed: true };
    const openingInput: AgentInput = { id: opening.id, source: 'agent', parentRunId: p.id, text: opening.text, createdAt: now,
      conversation: { senderRunId: p.id, recipientRunId: w.id, kind: 'request' } };
    expect(manager.continueRun(w.id, { text: opening.text }, true, { rootId: p.id, state: { messages: [opening], outcomes: [] }, input: openingInput }).ok).toBe(true);
    await until(() => store.readEvents(w.id).some(event => event.type === 'error'));
    await until(() => !manager.isActive(w.id));
    expect(inputOf(w.id, opening.id)?.deliveredAt).toBeUndefined();
  });
});
