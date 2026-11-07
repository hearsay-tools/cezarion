import { agentInputSchema } from '@open-mercato/cezar-contract/delegation';

import { randomUUID } from 'node:crypto';

import { expect, it } from 'vitest';
import { withHeldAck } from './owned-input-delivery.testkit.ts';

import { waitFor } from './harness-parity.testkit.ts';
import { withOwnedInputRun } from './workflow-parity.testkit.ts';

const delivered = (input: object, stored: { consumedAt?: string | undefined; awaitingRead?: true | undefined } | undefined) =>
  ({ ...input, deliveredAt: expect.any(String), ...(stored?.consumedAt ? { consumedAt: expect.any(String) } : {}),
    ...(stored?.awaitingRead ? { awaitingRead: true } : {}) });
it.each(['fresh', 'continuation'] as const)('opencode %s provider failure before HTTP ACK retains the accepted input receipt', async mode => {
  await withHeldAck('opencode', async release => {
    await withOwnedInputRun('opencode', 'baseline', async ({ store, manager, runId, parentRunId }) => {
      manager.enqueueOwnedRun(runId);
      await waitFor(() => store.getRun(runId)?.status === 'waiting');
      if (mode === 'continuation') {
        manager.finish(runId);
        await waitFor(() => !manager.isActive(runId));
        expect(manager.continueRun(runId, { text: 'baseline continuation' }).ok).toBe(true);
        await waitFor(() => manager.isActive(runId) && store.getRun(runId)?.status === 'waiting');
      }
      const input = { id: randomUUID(), source: agentInputSchema.shape.source.enum.agent, parentRunId,
        text: 'mock:provider-error', createdAt: new Date().toISOString() };
      expect(manager.steerWorker(runId, input)).toBe('queued');
      await waitFor(() => store.readEvents(runId).some(event => event.type === 'session.error'));
      release();
      await waitFor(() => !manager.isActive(runId));
      expect(store.getRun(runId)?.status).toBe('failed');
      expect(store.getRun(runId)?.agentInputs).toEqual([delivered(input, store.getRun(runId)?.agentInputs?.[0])]);
      expect(store.readEvents(runId).filter(event => event.type === 'agent-input')).toHaveLength(1);
    });
  }, 'mock:provider-error');
}, 60_000);
