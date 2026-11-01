import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import type { AgentInput, ConversationMessage } from '@open-mercato/cezar-contract';
import { projectConversationEvents } from '../delegation/conversations.ts';
import { WORKER_FALLBACK_HEADER } from '../workflows/run.ts';
import { RUNNER_IDS } from './agent-runner.ts';
import { waitFor, withOwnedInputRun, withoutTaskScenario } from './harness-parity.testkit.ts';

// R6/R7 already pin native/portable answer routing and queue recovery. This
// integration adds the conversation-specific seam: durable structured identity
// survives projections/restart and reaches each real wire as attributed text.
// Beside a pending portable question the messages are delivered at once and the card stays
// answerable; a pending native question takes nothing until its answer's turn end, and a restart
// does not reopen it for them (hearsay-tools/cezarion#1235 phase 3a, § Messages beside a pending
// question).
for (const backend of RUNNER_IDS) {
  it(`${backend} conversation correlation survives ask recovery without projection-driven delivery`, async () => {
    await withOwnedInputRun(backend, 'ask', async fixture => {
      const { runId, parentRunId } = fixture;
      let { store, manager } = fixture;
      manager.enqueueOwnedRun(runId);
      await waitFor(() => store.readEvents(runId).some(event => event.type === 'ask.requested'));
      const ask = store.readEvents(runId).find(event => event.type === 'ask.requested')!;
      const requestId = randomUUID();
      // The worker's question is routed to the parent first: its message stays in the ledger.
      await waitFor(() => store.transcriptFacts(runId).pendingAsk?.routedMessageId !== undefined);
      const existing = (() => { const d = store.getRun(parentRunId)!.delegation!; return d.role === 'root' ? d.conversation ?? { messages: [], outcomes: [] } : { messages: [], outcomes: [] }; })();
      const messages: ConversationMessage[] = [...existing.messages];
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
        store.commitConversation(parentRunId, { messages: [...messages], outcomes: existing.outcomes }, { recipientRunId: runId, input });
      }
      const replay = () => {
        projectConversationEvents(store, store.getRun(parentRunId)!);
        manager.deliverConversationInput(runId);
      };
      replay(); replay();
      const question = () => store.getRun(runId)?.waits?.find(wait => wait.kind === 'human' && wait.phase === 'open');
      const portable = question()?.via !== 'native-ask';
      if (portable) {
        await waitFor(() => store.getRun(runId)?.agentInputs?.every(input => !!input.deliveredAt) === true);
        // The beside turn ends and parks for the question again before the restart.
        await waitFor(() => inputs.every(input => store.readEvents(runId).some(event => event.type === 'text' && String(event.text).includes(input.text))));
        await waitFor(() => store.getRun(runId)?.status === 'waiting');
      }
      // Delivered beside a portable question (one submission), held behind a native one.
      const beforeAnswer = portable ? store.getRun(runId)!.agentInputs! : inputs;
      expect(beforeAnswer.map(({ deliveredAt: _d, consumedAt: _c, ...input }) => input)).toEqual(inputs);
      if (portable) expect(new Set(beforeAnswer.map(input => input.deliveredAt)).size).toBe(1);
      expect(store.getRun(runId)?.agentInputs).toEqual(beforeAnswer);
      // The card stays answerable either way.
      expect(question()).toMatchObject({ askSeq: ask.seq });
      expect(store.readEvents(runId).filter(event => event.type === 'human-input-delivered')).toEqual([]);
      expect(store.readEvents(runId).filter(event => event.type === 'user-message')).toEqual([]);

      ({ store, manager } = await fixture.restart());
      replay(); replay();
      expect(manager.continueRun(runId).ok).toBe(false);
      expect(store.getRun(runId)?.agentInputs).toEqual(beforeAnswer);
      expect(question()).toMatchObject({ askSeq: ask.seq });
      expect(store.readEvents(runId).filter(event => event.type === 'ask.requested')).toEqual([ask]);
      expect(store.readEvents(runId).filter(event => event.type === 'human-input-delivered')).toEqual([]);

      // The worker's own question is its parent's to answer (hearsay-tools/cezarion#2410).
      expect(manager.continueRun(runId, { text: 'Vitest' }).ok).toBe(false);
      withoutTaskScenario(store, runId);
      await fixture.answer('Vitest');
      await waitFor(() => store.getRun(runId)?.agentInputs?.every(input => !!input.deliveredAt) === true);
      await waitFor(() => store.getRun(runId)?.status === 'waiting');
      for (const input of inputs) {
        const echoed = store.readEvents(runId).filter(event => event.type === 'text' && String(event.text).includes(input.text));
        expect(echoed).toHaveLength(1);
        expect(String(echoed[0]!.text)).toContain(JSON.stringify({ id: input.id, ...input.conversation }));
      }
      const checkpoints = store.getRun(runId)!.agentInputs;
      // The parent's two messages go in one submission; its reply is the answer, delivered on its own.
      expect(new Set(checkpoints!.filter(entry => inputs.some(input => input.id === entry.id)).map(input => input.deliveredAt)).size).toBe(1);
      expect(store.readEvents(runId).filter(event => event.type === 'text' &&
        inputs.every(input => String(event.text).includes(input.text)))).toHaveLength(1);
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
      const projections = store.readEvents(runId).filter(event => event.type === 'conversation-message' &&
        inputs.some(input => input.id === (event.message as ConversationMessage).id));
      // The worker's own ask is routed to its parent (hearsay-tools/cezarion#505); a routed
      // question projects here too, so only the parent's two messages are counted. The echo turns
      // end with no wait or done, so after their nudge Cezar asks the parent too: every other
      // routed question is that fallback (hearsay-tools/cezarion#1301, § A worker's no-wait fallback).
      const routing = store.readEvents(runId).filter(event => event.type === 'worker-question-routed');
      const fallbackAsks = new Set(store.readEvents(runId).filter(event => event.type === 'ask.requested' &&
        (event.questions as { header?: string }[])[0]?.header === WORKER_FALLBACK_HEADER).map(event => event.seq));
      expect(routing.filter(event => event.askSeq === ask.seq)).toHaveLength(1);
      expect(routing.every(event => event.askSeq === ask.seq || fallbackAsks.has(event.askSeq as number))).toBe(true);
      // One queued and one delivered projection per message; an observable harness adds
      // at most one consumed projection per message (#505).
      expect(projections.filter(event => event.delivery !== 'consumed')).toHaveLength(4);
      expect(projections.filter(event => event.delivery === 'consumed').length).toBeLessThanOrEqual(2);
      expect(new Set(projections.map(event => event.projectionId)).size).toBe(projections.length);
      // The parent's 'Vitest' answers the worker's own question; the barrier supersedes Cezar's
      // fallback one, which no human answers (hearsay-tools/cezarion#2410).
      expect(store.readEvents(runId).filter(event => event.type === 'human-input-delivered' && event.askSeq === ask.seq)).toEqual([expect.objectContaining({ source: 'parent' })]);
      expect(store.readEvents(runId).filter(event => event.type === 'user-message').map(event => event.text))
        .toEqual(['mock:agent-echo human barrier']);
    });
  }, 60_000);
}
