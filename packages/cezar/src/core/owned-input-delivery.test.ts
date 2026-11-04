import { agentInputSchema } from '@open-mercato/cezar-contract/delegation';
import { runInternals } from '../workflows/run-internals.testkit.ts';
import { randomUUID } from 'node:crypto';

import { expect, it } from 'vitest';
import { withHeldAck } from './owned-input-delivery.testkit.ts';

import { waitFor, withOwnedInputRun } from './harness-parity.testkit.ts';
import { thenSay, toolCall } from '../workflows/waits-parity.testkit.ts';
const delivered = (input: object, stored: { consumedAt?: string | undefined; awaitingRead?: true | undefined } | undefined) =>
  ({ ...input, deliveredAt: expect.any(String), ...(stored?.consumedAt ? { consumedAt: expect.any(String) } : {}),
    ...(stored?.awaitingRead ? { awaitingRead: true } : {}) });
for (const backend of ['codex', 'opencode', 'pi', 'omp'] as const) {
  it(`${backend} delayed ACK keeps the in-flight input in the 32 cap and merges concurrent queue writes exactly once`, async () => {
    await withHeldAck(backend, async release => {
      await withOwnedInputRun(backend, 'baseline', async ({ store, manager, runId, parentRunId }) => {
        manager.enqueueOwnedRun(runId);
        await waitFor(() => store.getRun(runId)?.status === 'waiting');
        const makeInput = (text: string) => ({ id: randomUUID(), source: agentInputSchema.shape.source.enum.agent, parentRunId, text, createdAt: new Date().toISOString() });
        const first = makeInput('mock:agent-echo delay-owned-ack first');
        expect(manager.steerWorker(runId, first)).toBe('queued');
        await waitFor(() => store.readEvents(runId).some(e => e.type === 'text' && String(e.text).includes('delay-owned-ack first')));
        const rest = Array.from({ length: 31 }, (_, i) => makeInput(`mock:agent-echo next ${i}`));
        for (const input of rest) expect(manager.steerWorker(runId, input)).toBe('queued');
        expect(() => manager.steerWorker(runId, makeInput('over cap'))).toThrow(/capacity/i);
        expect(store.getRun(runId)?.agentInputs).toEqual([first, ...rest]);
        expect(store.readEvents(runId).filter(e => e.type === 'text' && String(e.text).includes('mock:agent-echo next'))).toHaveLength(0);
        release();
        await waitFor(() => store.getRun(runId)?.agentInputs?.every(input => !!input.deliveredAt) === true);
        await waitFor(() => store.getRun(runId)?.status === 'waiting');
        expect(store.getRun(runId)?.agentInputs?.map(input => input.id)).toEqual([first, ...rest].map(input => input.id));
        expect(store.readEvents(runId).filter(e => e.type === 'agent-input')).toHaveLength(32);
        expect(store.readEvents(runId).filter(e => e.type === 'text' && String(e.text).includes('delay-owned-ack first'))).toHaveLength(1);
      });
    });
  }, 60_000);

  it.each(['owned', 'scheduler'] as const)(`${backend} %s DONE before ACK closes only after acceptance without needing a phantom turn`, async origin => {
    await withHeldAck(backend, async release => {
      await withOwnedInputRun(backend, 'baseline', async ({ store, manager, runId, parentRunId }) => {
        manager.enqueueOwnedRun(runId);
        await waitFor(() => store.getRun(runId)?.status === 'waiting');
        // An accepted cezar_done in the turn whose input ACK the fixture holds ('delay-owned-ack').
        const input = { id: randomUUID(), source: agentInputSchema.shape.source.enum.agent, parentRunId,
          text: `delay-owned-ack ${toolCall('cezar_done', {})} ${thenSay('delay-owned-ack finished')}`, createdAt: new Date().toISOString() };
        const session = (manager as unknown as { active: Map<string, { session: import('./agent-runner.ts').AgentSession }> }).active.get(runId)!.session;
        if (origin === 'owned') expect(manager.steerWorker(runId, input)).toBe('queued');
        else expect(runInternals(manager).inputDelivery.deliverMessage(runId, [{ type: 'text', text: input.text }], false)).toBe(true);
        await waitFor(() => store.readEvents(runId).some(e => e.type === 'text' && String(e.text).includes('delay-owned-ack')));
        expect(manager.isActive(runId)).toBe(true);
        expect(session.open).toBe(true);
        expect(store.getRun(runId)?.agentInputs ?? []).toEqual(origin === 'owned' ? [input] : []);
        release();
        await waitFor(() => !manager.isActive(runId));
        expect(['done', 'review']).toContain(store.getRun(runId)?.status);
        expect(store.getRun(runId)?.agentInputs ?? []).toEqual(origin === 'owned' ? [delivered(input, store.getRun(runId)?.agentInputs?.[0])] : []);
      });
    });
  }, 60_000);
}
