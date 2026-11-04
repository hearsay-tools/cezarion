import { agentInputSchema } from '@open-mercato/cezar-contract/delegation';

import { randomUUID } from 'node:crypto';

import { expect, it } from 'vitest';
import { withRejectedInput } from './owned-input-delivery.testkit.ts';

import { waitFor, withOwnedInputRun } from './harness-parity.testkit.ts';

const delivered = (input: object, stored: { consumedAt?: string | undefined; awaitingRead?: true | undefined } | undefined) =>
  ({ ...input, deliveredAt: expect.any(String), ...(stored?.consumedAt ? { consumedAt: expect.any(String) } : {}),
    ...(stored?.awaitingRead ? { awaitingRead: true } : {}) });
for (const backend of ['codex', 'opencode', 'pi', 'omp'] as const) {
  it.each(['fresh', 'continuation'] as const)(`${backend} %s rejected transport remains queued and replays the same input after reopening`, async mode => {
    await withRejectedInput(backend, async () => {
      await withOwnedInputRun(backend, 'baseline', async fixture => {
        const { store, manager, runId, parentRunId } = fixture;
        manager.enqueueOwnedRun(runId);
        await waitFor(() => store.getRun(runId)?.status === 'waiting');
        if (mode === 'continuation') {
          manager.finish(runId);
          await waitFor(() => !manager.isActive(runId));
          expect(manager.continueRun(runId, { text: 'baseline continuation' }).ok).toBe(true);
          await waitFor(() => manager.isActive(runId) && store.getRun(runId)?.status === 'waiting');
        }
        const input = { id: randomUUID(), source: agentInputSchema.shape.source.enum.agent, parentRunId,
          text: `mock:agent-echo reject-owned-turn ${backend === 'opencode' ? 'mock:reject-agent-post' : ''}`, createdAt: new Date().toISOString() };
        expect.soft(manager.steerWorker(runId, input)).toBe('queued');
        await waitFor(() => !manager.isActive(runId));
        expect(store.getRun(runId)?.status).toBe('failed');
        expect.soft(store.getRun(runId)?.agentInputs).toEqual([input]);
        const recovered = await fixture.restart();
        expect(recovered.manager.continueRun(runId, { text: 'baseline retry' }).ok).toBe(true);
        await waitFor(() => recovered.store.getRun(runId)?.status === 'waiting');
        const texts = recovered.store.readEvents(runId).filter(event => event.type === 'text').map(event => event.text);
        expect(texts.some(text => typeof text === 'string' && text.includes('reject-owned-turn'))).toBe(true);
        expect(recovered.store.getRun(runId)?.agentInputs).toEqual([delivered(input, recovered.store.getRun(runId)?.agentInputs?.[0])]);
        expect(recovered.store.readEvents(runId).filter(event => event.type === 'agent-input')).toHaveLength(1);
      });
    });
  }, 60_000);
}
