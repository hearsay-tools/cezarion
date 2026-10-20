import { describe, expect, it } from 'vitest';
import { RUNNER_IDS } from './agent-runner.ts';
import { exemptionFor, HARNESS_ADAPTERS, waitFor, withOwnedInputRun } from './harness-parity.testkit.ts';

/** P1 restart extension: native permission waits are unfinished turns, including owned workers. */
describe('native permission recovery (hearsay-tools/cezarion#1049)', () => {
  for (const backend of RUNNER_IDS) {
    const exemption = exemptionFor('P1', backend);
    if (exemption) {
      it(`${backend} P1 recovery exemption — ${exemption.reason}`, () => {
        expect(exemption.kind).toBe('scenario-unconstructible');
        expect(HARNESS_ADAPTERS[backend].scenarios.approval).toBeUndefined();
      });
      continue;
    }
    it(`${backend} P1 recovers an owned permission wait without reporting unfinished work as done`, async () => {
      await withOwnedInputRun(backend, 'approval', async fixture => {
        // The backend receives this prompt on resume too, so its native mock requests
        // a fresh approval instead of treating recovery as the baseline scenario.
        fixture.store.updateRun(fixture.runId, { systemPrompt: 'mock:approval' });
        fixture.manager.enqueueOwnedRun(fixture.runId);
        await waitFor(() => fixture.store.readEvents(fixture.runId).some(event => event.type === 'permission.requested'));
        const original = fixture.store.readEvents(fixture.runId).find(event => event.type === 'permission.requested')!;
        const originalOption = (original.options as Array<{ id: string }>)[0]!;
        expect(fixture.store.getRun(fixture.runId)).toMatchObject({ status: 'waiting', hasPendingPermission: true });

        const recovered = await fixture.restart();
        expect(recovered.store.getRun(fixture.runId)?.status).not.toBe('done');
        expect(recovered.store.getRun(fixture.runId)?.status).not.toBe('review');
        expect(recovered.manager.respondPermission(fixture.runId, original.requestId as string, originalOption.id)).toBe(false);
        await waitFor(() => recovered.store.readEvents(fixture.runId).filter(event => event.type === 'permission.requested').length === 2);
        const next = recovered.store.readEvents(fixture.runId).filter(event => event.type === 'permission.requested')[1]!;
        expect(next.requestId).not.toBe(original.requestId);
        expect(recovered.store.getRun(fixture.runId)).toMatchObject({ status: 'waiting', hasPendingPermission: true });
        const { pick } = HARNESS_ADAPTERS[backend].approvalDecisions![0]!;
        const decline = (next.options as Array<{ id: string; label: string }>).find(option => option.label.toLowerCase().includes(pick))!;
        expect(recovered.manager.respondPermission(fixture.runId, next.requestId as string, decline.id)).toBe(true);
        await waitFor(() => !recovered.manager.isActive(fixture.runId));
        expect(recovered.store.getRun(fixture.runId)?.status).toBe('done');
      });
    }, 45_000);
  }
});
