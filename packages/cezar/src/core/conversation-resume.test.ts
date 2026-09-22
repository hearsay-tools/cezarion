import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { CredentialRegistry } from '../delegation/credentials.ts';
import { DelegationService } from '../delegation/service.ts';
import { RUNNER_IDS } from './agent-runner.ts';
import { waitFor, withOwnedInputRun } from './harness-parity.testkit.ts';

for (const backend of RUNNER_IDS) {
  it.each(['live', 'restart'] as const)(`${backend}: %s parent resume executes its message once without human input`, async mode => {
    await withOwnedInputRun(backend, 'baseline', async fixture => {
      const { repoRoot, runId, parentRunId } = fixture;
      let { store, manager } = fixture;
      manager.enqueueOwnedRun(runId);
      await waitFor(() => store.getRun(runId)?.status === 'waiting');
      manager.finish(runId);
      await waitFor(() => !manager.isActive(runId));
      expect(store.getRun(runId)?.status).toBe('done');
      const parent = store.getRun(parentRunId)!;
      if (parent.delegation?.role !== 'root') throw Error('fixture');
      store.commitDelegation([{ id: parentRunId, delegation: { ...parent.delegation, permissions: ['spawn', 'steer'] } }]);
      const credentials = new CredentialRegistry();
      const caller = credentials.authenticate(credentials.issue('project', parentRunId, randomUUID()))!;
      let service = new DelegationService();
      service.registerProject({ id: 'project', root: repoRoot, store, manager });
      const request = { id: randomUUID(), recipientRunId: runId, kind: 'request' as const, timeoutSeconds: 600,
        resume: true, text: 'mock:agent-echo Check the corrected result' };
      try {
        if (mode === 'restart') vi.spyOn(manager as unknown as { pump(): Promise<void> }, 'pump').mockResolvedValue();
        const first = await service.send(caller, request);
        expect(first.message).toMatchObject({ state: 'accepted', resumed: true });
        if (mode === 'restart') {
          expect(store.getRun(runId)?.status).toBe('queued');
          store.updateRun(runId, { task: 'Amended task before capacity admission', queuedMessages: [{ id: randomUUID(),
            text: 'Keep the later human context', createdAt: new Date().toISOString() }] });
          ({ store, manager } = await fixture.restart());
          service = new DelegationService();
          service.registerProject({ id: 'project', root: repoRoot, store, manager });
        }
        await waitFor(() => !!store.getRun(runId)?.agentInputs?.find(input => input.id === request.id)?.deliveredAt);
        await waitFor(() => store.getRun(runId)?.status === 'waiting');
        expect(store.getRun(runId)?.continuationMessage).toBeUndefined();
        const echoed = store.readEvents(runId).filter(event => event.type === 'text' && String(event.text).includes(request.text));
        expect(echoed)
          .toEqual([expect.objectContaining({ text: expect.stringContaining(request.id) })]);
        if (mode === 'restart') {
          expect(String(echoed[0]!.text)).toContain('Amended task before capacity admission');
          expect(String(echoed[0]!.text)).toContain('Keep the later human context');
        }
        expect(store.readEvents(runId).filter(event => event.type === 'human-input-delivered')).toEqual([]);
        expect(store.readEvents(runId).filter(event => event.type === 'user-message' && String(event.text).includes(request.text))).toEqual([]);
        manager.finish(runId);
        await waitFor(() => !manager.isActive(runId));
        const revision = store.getRun(runId)?.delegation;
        expect(await service.send(caller, request)).toMatchObject({ delivery: 'delivered', message: first.message });
        expect(store.getRun(runId)?.delegation).toEqual(revision);
        expect(store.getRun(runId)?.steps.filter(step => step.synthetic === 'continuation')).toHaveLength(1);
      } finally { credentials.close(); }
    });
  }, 60_000);
}
