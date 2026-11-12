// Register the external CI mock before loading RunManager.
import { pr, identity, externalResource, success, ciWaitOf, lastCiWaitOf, parked, github, register, acquireExternalCiResources } from './ci-wait-fixture.testkit.ts';
import { WAIT_KIND, WAIT_PHASE } from '@open-mercato/cezar-contract/test-factories.testkit';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { type Wait } from '@open-mercato/cezar-contract/waits';

import { controlledWire, manager, parent, root, restart, semaphore, store, until, useWorkerWaitFixture } from './worker-wait-claude.testkit.ts';
import { readPersistedRuns } from '../runs/run-store.testkit.ts';



describe('CI wait registration', { timeout: 30_000 }, () => {
  useWorkerWaitFixture({ acquireCiResources: acquireExternalCiResources });
  afterEach(() => vi.restoreAllMocks());

  it('rejects registration outside an active run without writing a receipt', async () => {
    github();
    await expect(Promise.resolve().then(() => manager.registerWait('absent', { kind: WAIT_KIND.pr, pr, timeout_seconds: 30 }, 'cezar_wait', 'old')))
      .rejects.toMatchObject({ code: 'run_missing' });
    expect(store.listRuns()).toEqual([]);
  });

  it('persists registration while executing, then parks marker-free without nudges or timed wakes', async () => {
    const external = github();
    // A parked pool member must retain its regular slot when no exemption is available.
    vi.spyOn(semaphore, 'maxMonitoringSessions').mockReturnValue(0);
    const gate = join(root, 'turn-boundary');
    const wire = controlledWire({ firstResultGate: gate });
    const run = await parent();
    await until(wire.initialReceived);
    const receipt = await register(run.id);
    expect(receipt.phase).toBe('open');
    const persisted = readPersistedRuns(join(root, '.ai/cezar')) as Array<{ id: string; waits?: Wait[] }>;
    expect(persisted.find(row => row.id === run.id)?.waits?.find(entry => entry.kind === 'pr')?.id).toBe(receipt.id);
    writeFileSync(gate, 'end');
    await until(() => parked(run.id));
    expect(store.getRun(run.id)?.waits?.some(entry => entry.kind === 'timer')).toBeFalsy();
    expect(semaphore.busy()).toBe(1); // a nonmember park would cost zero
    expect(store.getRun(run.id)?.waits).toEqual([expect.objectContaining({ id: receipt.id, kind: WAIT_KIND.pr, phase: WAIT_PHASE.open })]);
    expect(external.aborted()).toBe(false);
  });

  it('queues early completion until turn boundary and acknowledges exactly one lifecycle input', async () => {
    const external = github();
    const gate = join(root, 'turn-boundary');
    const wire = controlledWire({ firstResultGate: gate });
    const run = await parent(); await until(wire.initialReceived);
    const receipt = await register(run.id);
    external.settle(success());
    await until(() => ciWaitOf(run.id)?.phase === 'resolved');
    expect(store.getRun(run.id)?.agentInputs?.find(input => input.id === receipt.id)?.deliveredAt).toBeUndefined();
    writeFileSync(gate, 'end');
    await until(() => !!lastCiWaitOf(run.id)?.deliveredAt);
    expect(ciWaitOf(run.id)).toBeUndefined();
    expect(store.getRun(run.id)?.agentInputs?.filter(input => input.id === receipt.id)).toHaveLength(1);
    expect(store.getRun(run.id)?.status).not.toBe('done');
  });

  it('deduplicates matching registrations without extending the deadline', async () => {
    github();
    const gate = join(root, 'turn-boundary'); controlledWire({ firstResultGate: gate });
    const run = await parent();
    const first = await register(run.id); const second = await register(run.id);
    expect(second.id).toBe(first.id); expect(second.deadline).toBe(first.deadline);
    writeFileSync(gate, 'end');
  });

  it('does not require worker delegation permissions', async () => {
    github();
    const run = await parent(); await until(() => store.getRun(run.id)?.status === 'waiting');
    store.updateRun(run.id, { delegation: undefined });
    const receipt = await register(run.id);
    expect(receipt.phase).toBe('open');
    expect(parked(run.id)).toBe(true);
    expect(store.getRun(run.id)?.delegation).toBeUndefined();
  });

  // hearsay-tools/cezarion#1233: a human message aborts nothing; a lookup that outlives its turn
  // is still refused.
  it('keeps a registration whose lookup resolves after a human message in the same turn', async () => {
    github();
    const run = await parent(); await until(() => store.getRun(run.id)?.status === 'waiting');
    let resolve!: (value: typeof identity) => void;
    const deferred = new Promise<typeof identity>(done => { resolve = done; });
    vi.spyOn(externalResource.supervisor as { resolve: () => Promise<typeof identity> }, 'resolve').mockReturnValue(deferred);
    const registration = register(run.id);
    expect(manager.sendMessage(run.id, [{ type: 'text', text: 'mock:hold new instruction' }])).toBe(true);
    resolve(identity);
    await expect(registration).resolves.toMatchObject({ phase: WAIT_PHASE.open });
    expect(ciWaitOf(run.id)?.phase).toBe('open');
  });

  it('coalesces concurrent identical registration requests', async () => {
    github();
    const run = await parent(); await until(() => store.getRun(run.id)?.status === 'waiting');
    const [first, second] = await Promise.all([register(run.id), register(run.id)]);
    expect(first.id).toBe(second.id);
    expect(first.deadline).toBe(second.deadline);
  });

  // hearsay-tools/cezarion#1233 drops the human-ask refusals: a newer ask no longer refuses CI.
  it('accepts CI during an executing approval and after a newer human ask', async () => {
    github(); const release = join(root, 'ci-answer');
    const wire = controlledWire({ humanAnswerGate: release });
    const p = await parent('mock:cezar-ask');
    await until(() => store.readEvents(p.id).some(event => event.type === 'ask.requested'));
    await restart();
    expect(manager.continueRun(p.id, { text: 'human answer mock:hold' }).ok).toBe(true);
    await until(() => wire.received() === 1);
    try {
      const wait = await register(p.id);
      expect(wait.phase).toBe('open');
      expect(store.readEvents(p.id).filter(event => event.type === 'human-input-delivered')).toEqual([]);
      store.appendEvent(p.id, { type: 'ask.requested', requestId: randomUUID(), questions: [{ header: 'New', question: 'Approve?', options: [{ label: 'Yes' }, { label: 'No' }] }] });
      await expect(register(p.id)).resolves.toMatchObject({ id: wait.id });
    } finally { writeFileSync(release, 'go'); }
  });
});
