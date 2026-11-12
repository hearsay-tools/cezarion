import { agentInputSchema } from '@open-mercato/cezar-contract/delegation';

import { randomUUID } from 'node:crypto';

import { expect, it } from 'vitest';
import { withHeldAck } from './owned-input-delivery.testkit.ts';

import { waitFor } from './harness-parity.testkit.ts';
import { withOwnedInputRun } from './workflow-parity.testkit.ts';


it.each(['unresponsive', 'cancel', 'finish'] as const)('opencode provider failure with %s ACK terminates without inventing delivery', async stop => {
  await withHeldAck('opencode', async () => {
    await withOwnedInputRun('opencode', 'baseline', async ({ store, manager, runId, parentRunId }) => {
      manager.enqueueOwnedRun(runId);
      await waitFor(() => store.getRun(runId)?.status === 'waiting');
      const input = { id: randomUUID(), source: agentInputSchema.shape.source.enum.agent, parentRunId,
        text: 'mock:provider-error', createdAt: new Date().toISOString() };
      expect(manager.steerWorker(runId, input)).toBe('queued');
      await waitFor(() => store.readEvents(runId).some(event => event.type === 'session.error'));
      if (stop !== 'unresponsive') manager[stop](runId);
      await waitFor(() => !manager.isActive(runId));
      expect(store.getRun(runId)?.agentInputs).toEqual([input]);
      expect(store.readEvents(runId).filter(event => event.type === 'agent-input')).toEqual([expect.objectContaining({ input })]);
      if (stop === 'unresponsive') {
        expect(store.getRun(runId)?.status).toBe('failed');
        const errors = store.readEvents(runId).filter(event => event.type === 'error').map(event => event.message);
        expect(errors).toEqual([expect.stringContaining('(HTTP 400)')]);
      } else {
        expect(stop === 'cancel' ? ['cancelled'] : ['done', 'review']).toContain(store.getRun(runId)?.status);
      }
    });
  }, 'mock:provider-error');
}, 60_000);
