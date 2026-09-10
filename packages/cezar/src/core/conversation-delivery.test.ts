import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import type { AgentInput, ConversationMessage } from '@open-mercato/cezar-contract';
import { projectConversationEvents } from '../delegation/conversations.ts';
import { RUNNER_IDS } from './agent-runner.ts';
import { waitFor, withOwnedInputRun } from './harness-parity.testkit.ts';

// R6/R7 already pin native/portable answer routing and queue recovery. This
// integration adds the conversation-specific seam: durable structured identity
// survives projections/restart and reaches each real wire as attributed text.
for (const backend of RUNNER_IDS) {
  it(`${backend} conversation correlation survives ask recovery without projection-driven delivery`, async () => {
    await withOwnedInputRun(backend, 'ask', async fixture => {
      const { runId, parentRunId } = fixture;
      let { store, manager } = fixture;
      manager.enqueueOwnedRun(runId);
      await waitFor(() => store.readEvents(runId).some(event => event.type === 'ask.requested'));
      const ask = store.readEvents(runId).find(event => event.type === 'ask.requested')!;
      const requestId = randomUUID();
      const messages: ConversationMessage[] = [];
      const inputs: AgentInput[] = [];
      for (const kind of ['request', 'follow-up'] as const) {
        const id = kind === 'request' ? requestId : randomUUID();
        const attribution = { senderRunId: parentRunId, recipientRunId: runId, kind,
          ...(kind === 'follow-up' ? { requestId } : {}) };
        const input: AgentInput = { id, source: 'agent', parentRunId,
          text: `mock:agent-echo conversation payload ${id}`, createdAt: new Date().toISOString(), conversation: attribution };
        inputs.push(input);
        messages.push({ id, ...attribution, text: input.text, createdAt: input.createdAt,
          requestHash: 'a'.repeat(64), state: 'accepted',
          ...(kind === 'request' ? { deadline: new Date(Date.now() + 600_000).toISOString() } : {}) });
        store.commitConversation(parentRunId, { messages: [...messages], outcomes: [] }, { recipientRunId: runId, input });
      }
      const replay = () => {
        projectConversationEvents(store, store.getRun(parentRunId)!);
        manager.deliverConversationInput(runId);
      };
      replay(); replay();
      expect(store.getRun(runId)?.agentInputs).toEqual(inputs);
      expect(store.readEvents(runId).filter(event => event.type === 'human-input-delivered')).toEqual([]);
      expect(store.readEvents(runId).filter(event => event.type === 'user-message')).toEqual([]);

      ({ store, manager } = await fixture.restart());
      replay(); replay();
      expect(manager.continueRun(runId).ok).toBe(false);
      expect(store.getRun(runId)?.agentInputs).toEqual(inputs);
      expect(store.readEvents(runId).filter(event => event.type === 'ask.requested')).toEqual([ask]);
      expect(store.readEvents(runId).filter(event => event.type === 'human-input-delivered')).toEqual([]);

      expect(manager.continueRun(runId, { text: 'Vitest' }).ok).toBe(true);
      await waitFor(() => store.getRun(runId)?.agentInputs?.every(input => !!input.deliveredAt) === true);
      await waitFor(() => store.getRun(runId)?.status === 'waiting');
      for (const input of inputs) {
        const echoed = store.readEvents(runId).filter(event => event.type === 'text' && String(event.text).includes(input.text));
        expect(echoed).toHaveLength(1);
        expect(String(echoed[0]!.text)).toContain(JSON.stringify({ id: input.id, ...input.conversation }));
      }
      const checkpoints = store.getRun(runId)!.agentInputs;
      replay(); replay();
      // A genuine human follow-up is a transport barrier after repeated replay:
      // no correlated turn should have been re-enqueued by observing the ledger.
      expect(manager.sendMessage(runId, [{ type: 'text', text: 'mock:agent-echo human barrier' }])).toBe(true);
      await waitFor(() => store.readEvents(runId).some(event => event.type === 'text' && String(event.text).includes('human barrier')));
      await waitFor(() => store.getRun(runId)?.status === 'waiting');
      expect(store.getRun(runId)?.agentInputs).toEqual(checkpoints);
      for (const input of inputs) {
        expect(store.readEvents(runId).filter(event => event.type === 'text' && String(event.text).includes(input.text))).toHaveLength(1);
      }
      const projections = store.readEvents(runId).filter(event => event.type === 'conversation-message');
      expect(projections).toHaveLength(4); // One queued and one delivered projection per message.
      expect(new Set(projections.map(event => event.projectionId)).size).toBe(4);
      expect(store.readEvents(runId).filter(event => event.type === 'human-input-delivered')).toHaveLength(1);
      expect(store.readEvents(runId).filter(event => event.type === 'user-message').map(event => event.text))
        .toEqual(['Vitest', 'mock:agent-echo human barrier']);
    });
  }, 60_000);
}
