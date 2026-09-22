import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import type { AgentInput, ConversationMessage } from '@open-mercato/cezar-contract';
import { waitFor, withOwnedInputRun } from './harness-parity.testkit.ts';
import { withDelayedCommand } from './owned-input-delivery.testkit.ts';

for (const backend of ['codex', 'opencode', 'pi'] as const) {
  it.each(['acknowledged', 'cancelled'] as const)(`${backend}: %s batch keeps independent receipts and concurrent arrivals`, async mode => {
    await withDelayedCommand(backend, async release => {
      await withOwnedInputRun(backend, 'baseline', async ({ store, manager, runId, parentRunId }) => {
        manager.enqueueOwnedRun(runId);
        await waitFor(() => store.getRun(runId)?.status === 'waiting');
        const messages: ConversationMessage[] = [];
        const enqueue = (text: string): AgentInput => {
          const input: AgentInput = { id: randomUUID(), source: 'agent', parentRunId, text, createdAt: new Date().toISOString(),
            conversation: { senderRunId: parentRunId, recipientRunId: runId, kind: 'progress' } };
          messages.push({ id: input.id, ...input.conversation!, text, createdAt: input.createdAt, requestHash: 'a'.repeat(64), state: 'accepted' });
          store.commitConversation(parentRunId, { messages: [...messages], outcomes: [] }, { recipientRunId: runId, input });
          return input;
        };
        const first = enqueue('mock:agent-echo delay-owned-ack first');
        const second = enqueue('mock:agent-echo second in same batch');
        manager.deliverConversationInput(runId);
        await waitFor(() => store.readEvents(runId).some(event => event.type === 'text' && String(event.text).includes(second.text)));
        const third = enqueue('mock:agent-echo arrived during acknowledgement');
        manager.deliverConversationInput(runId);
        expect(store.getRun(runId)?.agentInputs).toEqual([first, second, third]);
        if (mode === 'cancelled') manager.cancel(runId);
        release();
        if (mode === 'cancelled') {
          await waitFor(() => !manager.isActive(runId));
          expect(store.getRun(runId)?.agentInputs).toEqual([first, second, third]);
        } else {
          await waitFor(() => store.getRun(runId)?.agentInputs?.every(input => !!input.deliveredAt) === true);
          const inputs = store.getRun(runId)!.agentInputs!;
          expect(inputs.map(input => input.id)).toEqual([first.id, second.id, third.id]);
          expect(inputs[0]!.deliveredAt).toBe(inputs[1]!.deliveredAt);
          const turns = store.readEvents(runId).filter(event => event.type === 'text' && String(event.text).includes('Agent conversation'));
          expect(turns).toHaveLength(2);
          expect(String(turns[0]!.text)).toContain(first.text);
          expect(String(turns[0]!.text)).toContain(second.text);
          expect(String(turns[0]!.text)).not.toContain(third.text);
          expect(String(turns[1]!.text)).toContain(third.text);
        }
      });
    });
  }, 60_000);
}
