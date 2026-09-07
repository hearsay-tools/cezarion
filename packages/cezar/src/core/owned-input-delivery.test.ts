import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { withDelayedCommand, withRejectedCommand } from './owned-input-delivery.testkit.ts';
import { driveSeam, promptFor, waitFor, withOwnedInputRun } from './harness-parity.testkit.ts';

for (const backend of ['codex', 'opencode', 'pi'] as const) {
  it.each(['fresh', 'continuation'] as const)(`${backend} %s rejected transport remains queued and replays the same input after reopening`, async mode => {
    await withRejectedCommand(backend, async () => {
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
        const input = { id: randomUUID(), source: 'agent' as const, parentRunId,
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
        expect(recovered.store.getRun(runId)?.agentInputs).toEqual([{ ...input, deliveredAt: expect.any(String) }]);
        expect(recovered.store.readEvents(runId).filter(event => event.type === 'agent-input')).toHaveLength(1);
      });
    });
  }, 60_000);
}

for (const backend of ['codex', 'opencode', 'pi'] as const) {
  it(`${backend} delayed ACK keeps the in-flight input in the 32 cap and merges concurrent queue writes exactly once`, async () => {
    await withDelayedCommand(backend, async release => {
      await withOwnedInputRun(backend, 'baseline', async ({ store, manager, runId, parentRunId }) => {
        manager.enqueueOwnedRun(runId);
        await waitFor(() => store.getRun(runId)?.status === 'waiting');
        const makeInput = (text: string) => ({ id: randomUUID(), source: 'agent' as const, parentRunId, text, createdAt: new Date().toISOString() });
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
    await withDelayedCommand(backend, async release => {
      await withOwnedInputRun(backend, 'baseline', async ({ store, manager, runId, parentRunId }) => {
        manager.enqueueOwnedRun(runId);
        await waitFor(() => store.getRun(runId)?.status === 'waiting');
        const input = { id: randomUUID(), source: 'agent' as const, parentRunId,
          text: 'mock:agent-echo delay-owned-ack\nCEZ:DONE', createdAt: new Date().toISOString() };
        const session = (manager as unknown as { active: Map<string, { session: import('./agent-runner.ts').AgentSession }> }).active.get(runId)!.session;
        if (origin === 'owned') expect(manager.steerWorker(runId, input)).toBe('queued');
        else expect((manager as unknown as { deliverMessage(id: string, content: unknown[], human: boolean): boolean })
          .deliverMessage(runId, [{ type: 'text', text: input.text }], false)).toBe(true);
        await waitFor(() => store.readEvents(runId).some(e => e.type === 'text' && String(e.text).includes('delay-owned-ack')));
        expect(manager.isActive(runId)).toBe(true);
        expect(session.open).toBe(true);
        expect(store.getRun(runId)?.agentInputs ?? []).toEqual(origin === 'owned' ? [input] : []);
        release();
        await waitFor(() => !manager.isActive(runId));
        expect(['done', 'review']).toContain(store.getRun(runId)?.status);
        expect(store.getRun(runId)?.agentInputs ?? []).toEqual(origin === 'owned' ? [{ ...input, deliveredAt: expect.any(String) }] : []);
      });
    });
  }, 60_000);
}

for (const backend of ['codex', 'opencode', 'pi'] as const) {
  it(`${backend} a completed turn with a delayed ACK holds auto-end and resumes it after acceptance`, async () => {
    await withDelayedCommand(backend, async release => {
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
          await new Promise(resolve => setTimeout(resolve, 400));
          expect(accepted).toBe(false); expect(session.open).toBe(true);
          expect(session.sendAgentMessage([{ type: 'text', text: 'duplicate' }])).toBe(false);
          release(); await ack; await session.result;
          expect(session.open).toBe(false);
        },
      });
    });
  }, 60_000);

  it.each(['finish', 'cancel', 'dispose'] as const)(`${backend} pending ACK settles without a delivery receipt or reopened lifecycle after %s`, async stop => {
    await withDelayedCommand(backend, async release => {
      await withOwnedInputRun(backend, 'baseline', async ({ store, manager, runId, parentRunId }) => {
        manager.enqueueOwnedRun(runId);
        await waitFor(() => store.getRun(runId)?.status === 'waiting');
        const input = { id: randomUUID(), source: 'agent' as const, parentRunId,
          text: 'mock:agent-echo delay-owned-ack stopped', createdAt: new Date().toISOString() };
        expect(manager.steerWorker(runId, input)).toBe('queued');
        await waitFor(() => store.readEvents(runId).some(event => event.type === 'text' && String(event.text).includes('stopped')));
        const internals = manager as unknown as { active: Map<string, { session: import('./agent-runner.ts').AgentSession; agentInputFlight?: { settled?: Promise<void> } }>; executions: Map<string, unknown> };
        const state = internals.active.get(runId)!;
        const session = state.session;
        const settled = state.agentInputFlight?.settled;
        expect(settled).toBeInstanceOf(Promise);
        try {
          if (stop === 'dispose') manager.dispose();
          else manager[stop](runId);
          release(); await settled;
          expect(store.getRun(runId)?.agentInputs).toEqual([input]);
          if (stop === 'dispose') {
            expect(internals.active.has(runId)).toBe(false);
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
          await waitFor(() => !internals.executions.has(runId));
        }
      });
    });
  }, 60_000);
}

for (const backend of ['claude', 'codex', 'opencode', 'pi'] as const) {
  it(`${backend} transport acceptance remains delivered when the accepted turn subsequently reports a provider failure`, async () => {
    await withOwnedInputRun(backend, 'baseline', async ({ store, manager, runId, parentRunId }) => {
      manager.enqueueOwnedRun(runId);
      await waitFor(() => store.getRun(runId)?.status === 'waiting');
      const input = { id: randomUUID(), source: 'agent' as const, parentRunId,
        text: promptFor(backend, 'provider-error'), createdAt: new Date().toISOString() };
      expect(manager.steerWorker(runId, input)).toBe('queued');
      await waitFor(() => !manager.isActive(runId));
      expect(store.getRun(runId)?.status).toBe('failed');
      expect(store.getRun(runId)?.agentInputs).toEqual([{ ...input, deliveredAt: expect.any(String) }]);
      expect(store.readEvents(runId).filter(event => event.type === 'agent-input')).toHaveLength(1);
    });
  }, 60_000);
}
