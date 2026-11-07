import { agentInputSchema } from '@open-mercato/cezar-contract/delegation';

import { randomUUID } from 'node:crypto';

import { expect, it } from 'vitest';

import { promptFor, waitFor } from './harness-parity.testkit.ts';
import { withOwnedInputRun } from './workflow-parity.testkit.ts';

const delivered = (input: object, stored: { consumedAt?: string | undefined; awaitingRead?: true | undefined } | undefined) =>
  ({ ...input, deliveredAt: expect.any(String), ...(stored?.consumedAt ? { consumedAt: expect.any(String) } : {}),
    ...(stored?.awaitingRead ? { awaitingRead: true } : {}) });
for (const backend of ['claude', 'codex', 'opencode', 'pi', 'omp'] as const) {
  it(`${backend} transport acceptance remains delivered when the accepted turn subsequently reports a provider failure`, async () => {
    await withOwnedInputRun(backend, 'baseline', async ({ store, manager, runId, parentRunId }) => {
      manager.enqueueOwnedRun(runId);
      await waitFor(() => store.getRun(runId)?.status === 'waiting');
      const input = { id: randomUUID(), source: agentInputSchema.shape.source.enum.agent, parentRunId,
        text: promptFor(backend, 'provider-error'), createdAt: new Date().toISOString() };
      expect(manager.steerWorker(runId, input)).toBe('queued');
      await waitFor(() => !manager.isActive(runId));
      expect(store.getRun(runId)?.status).toBe('failed');
      // hearsay-tools/cezarion#505: an observable harness may also have reported reading it before the failure.
      expect(store.getRun(runId)?.agentInputs).toEqual([delivered(input, store.getRun(runId)?.agentInputs?.[0])]);
      expect(store.readEvents(runId).filter(event => event.type === 'agent-input')).toHaveLength(1);
    });
  }, 60_000);
}
