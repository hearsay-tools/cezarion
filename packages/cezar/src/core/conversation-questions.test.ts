import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import type { AgentInput, ConversationMessage } from '@open-mercato/cezar-contract';
import { RUNNER_IDS } from './agent-runner.ts';
import { waitFor, withOwnedInputRun } from './harness-parity.testkit.ts';

// #505 on every real runner wire: the worker's ask (native or CEZ:ASK) travels to its
// parent as a routed request, and the parent's reply answers it through the same seam a
// human answer uses. The root here is a parked record, so the reply is committed directly.
for (const backend of RUNNER_IDS) {
  it(`${backend} worker question reaches the parent and the parent's reply answers it`, async () => {
    await withOwnedInputRun(backend, 'ask', async ({ runId, parentRunId, store, manager }) => {
      const root = store.getRun(parentRunId)!.delegation!;
      if (root.role !== 'root') throw Error('missing root');
      store.commitDelegation([{ id: parentRunId, delegation: { ...root, permissions: [...root.permissions, 'steer'] } }]);
      manager.enqueueOwnedRun(runId);
      await waitFor(() => store.readEvents(runId).some(event => event.type === 'worker-question-routed'));
      const ask = store.readEvents(runId).find(event => event.type === 'ask.requested')!;
      const routed = store.readEvents(runId).find(event => event.type === 'worker-question-routed')!;
      expect(routed).toMatchObject({ askSeq: ask.seq, parentRunId });
      const conversation = () => { const d = store.getRun(parentRunId)!.delegation!; return d.role === 'root' ? d.conversation! : undefined; };
      const question = conversation()!.messages.find(message => message.id === routed.messageId)!;
      expect(question).toMatchObject({ kind: 'request', senderRunId: runId, recipientRunId: parentRunId, question: { questions: ask.questions } });
      expect(store.getRun(parentRunId)?.agentInputs?.some(input => input.id === question.id)).toBe(true);
      await waitFor(() => store.getRun(runId)?.status === 'waiting');

      const now = new Date().toISOString();
      const id = randomUUID();
      const attribution = { senderRunId: parentRunId, recipientRunId: runId, kind: 'reply' as const, requestId: question.id };
      const input: AgentInput = { id, source: 'agent', parentRunId, text: 'Vitest', createdAt: now, conversation: attribution };
      const reply: ConversationMessage = { id, ...attribution, text: input.text, createdAt: now, requestHash: 'b'.repeat(64), state: 'accepted' };
      const state = conversation()!;
      store.commitConversation(parentRunId, { messages: [...state.messages, reply],
        outcomes: [...state.outcomes, { requestId: question.id, status: 'replied', observedAt: now, replyId: id }] }, { recipientRunId: runId, input });
      manager.deliverConversationInput(runId);

      await waitFor(() => store.readEvents(runId).some(event => event.type === 'human-input-delivered'));
      expect(store.readEvents(runId).filter(event => event.type === 'human-input-delivered')).toEqual([expect.objectContaining({ askSeq: ask.seq, source: 'parent' })]);
      await waitFor(() => !!store.getRun(runId)?.agentInputs?.find(entry => entry.id === id)?.deliveredAt);
      // The parent's answer is its conversation reply, never a human message.
      expect(store.readEvents(runId).filter(event => event.type === 'user-message')).toEqual([]);
      await waitFor(() => store.getRun(runId)?.status === 'waiting');
    });
  }, 60_000);
}
