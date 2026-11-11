import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type WorkerWait, agentInputSchema } from '@open-mercato/cezar-contract/delegation';
import { type RunRecord } from '../runs/store.ts';
import { fixtureUpdateRun, manager, parent, register, restart, root, store, terminal, until, useWorkerWaitFixture, waitOf, worker } from './worker-wait-claude.testkit.ts';
import { readPersistedRuns } from '../runs/run-store.testkit.ts';
import { RUN_STATUS, WAIT_KIND, WAIT_PHASE } from '@open-mercato/cezar-contract/test-factories.testkit';

// Real Git, durable fsync checkpoints and process shutdown share this outer budget.
// Keep the separate 15s state/termination assertions and actual runner timers intact.

describe('worker waits through RunManager', { timeout: 30_000 }, () => {
  useWorkerWaitFixture();
  it('retiring a delivered wait durably records the resumed status in the same snapshot', async () => {
    const p = await parent(); const w = await worker(p.id);
    fixtureUpdateRun(w.id, { status: RUN_STATUS.done });
    // hearsay-tools/cezarion#1235: a worker entry retires through the wait list's delivery checkpoint.
    const commit = store.commitOutcome.bind(store);
    let retiredStatus: string | undefined;
    store.commitOutcome = (...args) => {
      const committed = commit(...args);
      if (args[0] === p.id && retiredStatus === undefined && [args[1]].flat().some(outcome => outcome.kind === 'delivered') &&
        store.getRun(p.id)?.lastWaits?.some(wait => wait.kind === 'worker' && wait.phase === 'delivered')) {
        const records = readPersistedRuns(join(root, '.ai/cezar')) as RunRecord[];
        retiredStatus = records.find(run => run.id === p.id)?.status;
      }
      return committed;
    };
    register(p.id, [w.id]);
    await until(() => retiredStatus !== undefined);
    expect(retiredStatus).toBe('running');
  });

  it('restart after the delivery checkpoint resumes the parent instead of settling the parked snapshot', async () => {
    const p = await parent(); const w = await worker(p.id);
    const wait = register(p.id, [w.id]);
    await until(() => waitOf(store.getRun(p.id))?.phase === 'parked');
    // The old engine's exact crash window, as an older build left it on disk: backend accepted,
    // input receipt committed, but wait retirement and resumeParkedRun's status update had not
    // happened yet. hearsay-tools/cezarion#1235: the wait is `delegation.wait`, not a list entry,
    // and upgrade-on-read reads the run as resumed.
    store.flush();
    const now = new Date().toISOString();
    const disk = (readPersistedRuns(join(root, '.ai/cezar')) as RunRecord[]).map(run => {
      if (run.id !== p.id || run.delegation?.role !== 'root') return run;
      const { waits: _waits, ...legacy } = run;
      return { ...legacy, delegation: { ...run.delegation, wait: { ...wait, phase: 'wake-pending', reason: 'timeout', wakeId: wait.id } },
        agentInputs: [{ id: wait.id, parentRunId: p.id, source: 'lifecycle', text: 'Worker deadline reached', createdAt: now, deliveredAt: now }] };
    });
    expect(disk.find(run => run.id === p.id)).toMatchObject({ status: RUN_STATUS.waiting });
    await restart(false, disk);
    await until(() => store.getRun(p.id)?.steps.some(step => step.id === 'continue-1') === true || terminal.includes(store.getRun(p.id)?.status ?? ''));
    expect(store.getRun(p.id)?.steps.some(step => step.id === 'continue-1')).toBe(true);
    expect(store.getRun(w.id)?.status).not.toBe('cancelled');
    expect(store.getRun(p.id)?.agentInputs).toHaveLength(1);
    expect(store.getRun(p.id)?.agentInputs?.[0]?.deliveredAt).toBeDefined();
    expect(waitOf(store.getRun(p.id))).toBeUndefined();
    expect(store.readEvents(p.id).filter(event => event.type === 'user-message')).toEqual([]);
  });

  /** A parked parent as an older build left it on disk: its agent worker wait in `delegation.wait`
   *  as `wait`, the list emptied, and `inputs` as its only agent inputs. */
  async function legacyParked(legacyWait: (wait: WorkerWait) => WorkerWait, inputs: (p: RunRecord, w: RunRecord, wait: WorkerWait) => unknown[]) {
    const p = await parent(); const w = await worker(p.id);
    const wait = register(p.id, [w.id]);
    await until(() => waitOf(store.getRun(p.id))?.phase === 'parked');
    store.flush();
    const disk = (readPersistedRuns(join(root, '.ai/cezar')) as RunRecord[]).map(run => {
      if (run.id !== p.id || run.delegation?.role !== 'root') return run;
      const { waits: _waits, ...legacy } = run;
      return { ...legacy, delegation: { ...run.delegation, wait: legacyWait(wait) }, agentInputs: inputs(p, w, wait) };
    });
    expect(disk.find(run => run.id === p.id)).toMatchObject({ status: RUN_STATUS.waiting });
    return { p, w, wait, disk };
  }

  it('restart delivers the queued wake an upgraded cancelled worker wait left, without reopening the wait', async () => {
    // hearsay-tools/cezarion#1235: an older build cancelled the wait into a `wake-pending` receipt
    // and queued its wake; the parent was still parked, with no session, when it stopped.
    const text = 'Worker wait cancelled, upgraded receipt marker';
    const { p, wait, disk } = await legacyParked(wait => ({ ...wait, phase: 'wake-pending', reason: 'cancelled', wakeId: wait.id }),
      (p, _w, wait) => [{ id: wait.id, parentRunId: p.id, source: 'lifecycle', text, createdAt: new Date().toISOString() }]);
    await restart(false, disk);
    await until(() => !!store.getRun(p.id)?.agentInputs?.find(input => input.id === wait.id)?.deliveredAt);
    expect(store.getRun(p.id)?.agentInputs).toHaveLength(1);
    expect(store.getRun(p.id)?.lastWaits).toEqual([expect.objectContaining({ id: wait.id, kind: WAIT_KIND.worker, phase: WAIT_PHASE.cancelled })]);
    expect(store.getRun(p.id)?.waits?.filter(entry => entry.kind === 'worker') ?? []).toEqual([]);
    await until(() => store.getRun(p.id)?.status === 'waiting');
  });

  it('restart after a delivered message stand-in resumes the interrupted parent', async () => {
    // The old engine's crash window for a message wake: the provider accepted the message and its
    // delivery was committed, but the stand-in was not yet retired nor the parent resumed.
    const messageId = randomUUID(); const now = new Date().toISOString();
    const { p, disk } = await legacyParked(wait => ({ id: randomUUID(), workerIds: [], outcomes: [], deadline: wait.deadline, phase: 'wake-pending', reason: 'message', wakeId: messageId }),
      (p, w) => [{ id: messageId, parentRunId: p.id, source: agentInputSchema.shape.source.enum.agent, text: 'Worker progress, delivered before the crash', createdAt: now, deliveredAt: now,
        conversation: { senderRunId: w.id, recipientRunId: p.id, kind: 'progress' } }]);
    await restart(false, disk);
    await until(() => store.getRun(p.id)?.steps.some(step => step.id === 'continue-1') === true || terminal.includes(store.getRun(p.id)?.status ?? ''));
    expect(store.getRun(p.id)?.steps.some(step => step.id === 'continue-1')).toBe(true);
    expect(store.getRun(p.id)?.agentInputs?.filter(input => input.id === messageId)).toHaveLength(1);
    expect(store.getRun(p.id)?.agentInputs?.[0]?.deliveredAt).toBe(now);
    expect(store.getRun(p.id)?.delegation).not.toHaveProperty('wait');
    expect(store.readEvents(p.id).filter(event => event.type === 'user-message')).toEqual([]);
  });

  it('restart after a message stand-in an inbox read acknowledged leaves the parent parked', async () => {
    // An inbox acknowledgement starts no provider turn: there is no interrupted execution to resume.
    const messageId = randomUUID(); const now = new Date().toISOString();
    const claim = { receiptId: randomUUID(), generation: randomUUID(), expiresAt: now, acknowledgedAt: now };
    const { p, disk } = await legacyParked(wait => ({ id: randomUUID(), workerIds: [], outcomes: [], deadline: wait.deadline, phase: 'wake-pending', reason: 'message', wakeId: messageId }),
      (p, w) => [{ id: messageId, parentRunId: p.id, source: agentInputSchema.shape.source.enum.agent, text: 'Worker progress, read through the inbox', createdAt: now, deliveredAt: now,
        conversation: { senderRunId: w.id, recipientRunId: p.id, kind: 'progress' }, inboxClaim: claim }]);
    await restart(false, disk);
    expect(store.getRun(p.id)?.status).toBe('waiting');
    expect(store.getRun(p.id)?.steps.some(step => step.id === 'continue-1')).toBe(false);
    expect(manager.isActive(p.id)).toBe(false);
  });

  it('a crash right after the delivery checkpoint recovers a resumed parent that owes nothing', async () => {
    const p = await parent(); const w = await worker(p.id);
    const wait = register(p.id, [w.id]);
    await until(() => waitOf(store.getRun(p.id))?.phase === 'parked');
    // hearsay-tools/cezarion#1235: the delivery and the resume are one commit. The disk as that
    // commit left it is the crash image.
    const commit = store.commitOutcome.bind(store);
    let image: unknown[] | undefined;
    store.commitOutcome = (...args) => {
      const committed = commit(...args);
      if (args[0] === p.id && !image && [args[1]].flat().some(outcome => outcome.kind === 'delivered') &&
        store.getRun(p.id)?.lastWaits?.some(wait => wait.phase === 'delivered')) image = readPersistedRuns(join(root, '.ai/cezar'));
      return committed;
    };
    fixtureUpdateRun(w.id, { status: RUN_STATUS.done });
    await until(() => image !== undefined);
    const crashed = (image as RunRecord[]).find(run => run.id === p.id)!;
    expect(crashed).toMatchObject({ status: RUN_STATUS.running, lastWaits: [expect.objectContaining({ id: wait.id, phase: WAIT_PHASE.delivered })] });
    expect(crashed.agentInputs?.find(input => input.id === wait.id)?.deliveredAt).toBeDefined();
    await restart(false, image);
    await until(() => store.getRun(p.id)?.steps.some(step => step.id === 'continue-1') === true || terminal.includes(store.getRun(p.id)?.status ?? ''));
    expect(store.getRun(p.id)?.steps.some(step => step.id === 'continue-1')).toBe(true);
    expect(store.getRun(p.id)?.agentInputs?.filter(input => input.id === wait.id)).toHaveLength(1);
    expect(waitOf(store.getRun(p.id))).toBeUndefined();
    expect(store.readEvents(p.id).filter(event => event.type === 'user-message')).toEqual([]);
  });

});
