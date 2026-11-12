import { agentInputSchema } from '@open-mercato/cezar-contract/delegation';
import { fixtureWork } from '../workflows/fixture-cleanup.testkit.ts';
import { randomUUID } from 'node:crypto';

import { expect, it, vi } from 'vitest';
import { withHeldAck } from './owned-input-delivery.testkit.ts';
import { autoEndObservationClock } from './observation-clock.testkit.ts';
import { AUTO_END_DELAY_MS } from './runner-runtime.ts';

import { driveSeam, waitFor } from './harness-parity.testkit.ts';
import { withOwnedInputRun } from './workflow-parity.testkit.ts';


for (const backend of ['codex', 'opencode', 'pi', 'omp'] as const) {
  it(`${backend} a completed turn with a delayed ACK holds auto-end and resumes it after acceptance`, async () => {
    await withHeldAck(backend, async release => {
      const autoEnd = autoEndObservationClock();
      try {
        await driveSeam(backend, 'hold', {
          sessionOptions: { autoEndAfterFirstTurn: true },
          whileOpen: async (session, { v1 }) => {
            await waitFor(() => v1.some(event => event.type === 'turn-end'));
            const ack = session.sendAgentMessage([{ type: 'text', text: 'mock:agent-echo delay-owned-ack' }]);
            expect(ack).toBeInstanceOf(Promise);
            let accepted = false;
            if (!ack) throw new Error('expected reserved submission');
            void ack.then(() => { accepted = true; }, () => {});
            await waitFor(() => v1.filter(event => event.type === 'turn-end').length === 2);
            // The turn end arms its close window in the same handler: a held ACK arms none.
            expect(autoEnd.pending).toBe(0);
            await autoEnd.advance(AUTO_END_DELAY_MS);
            expect(accepted).toBe(false); expect(session.open).toBe(true);
            expect(session.sendAgentMessage([{ type: 'text', text: 'duplicate' }])).toBe(false);
            release(); await ack;
            // Acceptance resumes the close window.
            await waitFor(() => autoEnd.pending === 1);
            await autoEnd.advance(AUTO_END_DELAY_MS);
            await session.result;
            expect(session.open).toBe(false);
          },
        });
      } finally { autoEnd.restore(); }
    });
  }, 60_000);

  it.each(['finish', 'cancel', 'dispose'] as const)(`${backend} pending ACK settles without a delivery receipt or reopened lifecycle after %s`, async stop => {
    await withHeldAck(backend, async release => {
      await withOwnedInputRun(backend, 'baseline', async ({ store, manager, runId, parentRunId }) => {
        manager.enqueueOwnedRun(runId);
        await waitFor(() => store.getRun(runId)?.status === 'waiting');
        const input = { id: randomUUID(), source: agentInputSchema.shape.source.enum.agent, parentRunId,
          text: 'mock:agent-echo delay-owned-ack stopped', createdAt: new Date().toISOString() };
        const work = fixtureWork(manager);
        const session = [...work.liveSessions].find(session => session.open)!;
        const send = session.sendAgentMessage.bind(session);
        let accepted: Promise<void> | undefined;
        vi.spyOn(session, 'sendAgentMessage').mockImplementation((...args) => {
          const result = send(...args);
          if (result) accepted = result.then(() => undefined, () => undefined);
          return result;
        });
        expect(manager.steerWorker(runId, input)).toBe('queued');
        await waitFor(() => store.readEvents(runId).some(event => event.type === 'text' && String(event.text).includes('stopped')));
        expect(accepted).toBeInstanceOf(Promise);
        try {
          if (stop === 'dispose') manager.dispose();
          else manager[stop](runId);
          release(); await accepted;
          expect(store.getRun(runId)?.agentInputs).toEqual([input]);
          if (stop === 'dispose') {
            expect(session.open).toBe(true); // Disposal alone is no termination proof.
            expect(manager.isActive(runId)).toBe(true);
          }
          else {
            await waitFor(() => !manager.isActive(runId));
            expect(stop === 'cancel' ? ['cancelled'] : ['done', 'review']).toContain(store.getRun(runId)?.status);
          }
        } finally {
          session.interrupt();
          await session.result.catch(() => undefined);
          await waitFor(() => !work.liveSessions.has(session));
          await Promise.all([...work.pending].filter(([, label]) => label === 'finishWorkerExecution').map(([task]) => task));
          expect(store.getRun(runId)?.agentInputs).toEqual([input]);
        }
      });
    });
  }, 60_000);
}
