import { waitPartDescribers, settled, inputsFor, parentWithWorker, sessionOf, prompted, workerWake, conversingParent, parentTurn, parkedOn, workerWaits, observeAdmissionRetries, retryAtOnce, delivered, retryClock, expectAdmissionRetryCleared } from './waits-parity-fixture.testkit.ts';
import { agentInputSchema } from '@open-mercato/cezar-contract/delegation';
import { WAKE_RETRY_BACKOFF } from '../delegation/retry-backoff.ts';
import { MAX_WAKE_DELIVERY_ATTEMPTS, WAKE_DELIVERY_CAP_NOTE } from './run.ts';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { it as registerTest, expect } from 'vitest';
import { WAIT_KIND, RUN_STATUS, WAIT_PHASE, WAIT_SOURCE, WAIT_VIA } from '@open-mercato/cezar-contract/test-factories.testkit';
import type { WorkerWaitEntry } from '@open-mercato/cezar-contract';
import type { RunnerId } from '../core/agent-runner.ts';
import { HARNESS_ADAPTERS } from '../core/harness-parity-core.testkit.ts';
import { root, manager, store, until, worker, toolGenerationOf, fixtureUpdateRun, restart, terminal } from './worker-wait-core.testkit.ts';
import { QUICK_TASK_WORKFLOW } from './types.ts';
import { readPersistedRuns } from '../runs/run-store.testkit.ts';
import { recordCommits } from '../runs/outcome-crash.testkit.ts';
import { gatedProviderFailure, persistentWakeFailure, MESSAGE_WAKE_OPENING, toolCall } from './waits-parity.testkit.ts';

// The recovery part of the wait parity cells (`WAIT_PARITY_PARTS` in `waits-parity-catalog.testkit.ts`).
// A wait parity file imports this module first, so it loads no other part's cells (hearsay-tools/cezarion#3242).
export const { describeWaitParity } = waitPartDescribers('recovery', recoveryCells);

export function recoveryCells(runners: RunnerId[], it: typeof registerTest = registerTest): void {
  for (const runner of runners) {
    it(`${runner} U9w provider failure with a worker wait open leaves the run recoverable and the next resolution delivers`, async () => {
      const wire = gatedProviderFailure(root, runner);
      const run = manager.startRun(QUICK_TASK_WORKFLOW, { runner, task: HARNESS_ADAPTERS[runner].scenarios['provider-error-controlled']! });
      store.commitDelegation([{ id: run.id, delegation: { role: 'root', permissions: ['spawn', 'wait'], receipts: [] } }]);
      await until(wire.held);
      const w = await worker(run.id);
      const tools = manager.squawkToolHandlers(run.id, toolGenerationOf(run.id));
      const registered = await tools.registerWait({ kind: WAIT_KIND.worker, worker_ids: [w.id], timeout_seconds: 600 }, 'cezar_wait', new AbortController().signal);
      expect(registered.answer).toMatchObject({ ok: true, kind: WAIT_KIND.worker });
      if (!('wait' in registered)) throw Error('registration refused');
      const wait = registered.wait;
      wire.release();
      await until(() => store.readEvents(run.id).some(event => event.type === 'error'));
      await until(() => !manager.isActive(run.id));
      expect(store.getRun(run.id)?.waits?.find(entry => entry.id === wait.id)?.phase).toBe('open');
      expect(store.getRun(run.id)?.status).not.toBe('failed');
      fixtureUpdateRun(w.id, { status: RUN_STATUS.done });
      await until(() => settled(run.id, wait.id)?.phase === 'delivered');
      expect(inputsFor(run.id, wait.id)).toHaveLength(1);
      await until(() => store.getRun(run.id)?.status === 'waiting');
    });

    it(`${runner} U9w clean close with a worker wait open leaves the run recoverable and the next resolution delivers`, async () => {
      const { p, w } = await parentWithWorker(runner);
      const tools = manager.squawkToolHandlers(p.id, toolGenerationOf(p.id));
      const registered = await tools.registerWait({ kind: WAIT_KIND.worker, worker_ids: [w.id], timeout_seconds: 600 }, 'cezar_wait', new AbortController().signal);
      if (!('wait' in registered)) throw Error('registration refused');
      const wait = registered.wait;
      sessionOf(p.id).end();
      await until(() => !manager.isActive(p.id));
      // A clean close is not a failure: the park and its wait survive it (it was an error before 3a).
      expect(store.getRun(p.id)?.status).toBe('waiting');
      expect(store.getRun(p.id)?.error).toBeUndefined();
      expect(store.getRun(p.id)?.steps.at(-1)?.error).toBeUndefined();
      expect(store.getRun(p.id)?.waits?.find(entry => entry.id === wait.id)?.phase).toBe('open');
      fixtureUpdateRun(w.id, { status: RUN_STATUS.done });
      await until(() => settled(p.id, wait.id)?.phase === 'delivered' && prompted(runner, workerWake(wait)).length > 0);
      expect(inputsFor(p.id, wait.id)).toHaveLength(1);
      await until(() => store.getRun(p.id)?.status === 'waiting');
    });

    /** A parent parked on a worker wait whose session has closed, so a worker message wakes it
     *  through a scheduler continuation whose opening prompt the provider fails until lifted. */
    async function messageWakeWithoutSession() {
      const f = await conversingParent(runner);
      const failure = persistentWakeFailure(root, runner, { opening: MESSAGE_WAKE_OPENING, unread: true });
      await parentTurn(f.p.id, toolCall('cezar_wait', { kind: WAIT_KIND.worker, worker_ids: [f.w.id], timeout_seconds: 600 }), () => parkedOn(f.p.id, workerWaits(f.p.id)[0]));
      sessionOf(f.p.id).end();
      await until(() => !manager.isActive(f.p.id));
      return { ...f, failure };
    }

    it(`${runner} U14m a message-only wake beside a worker wait whose sessions persistently fail stops at the delivery bound, the run fails keeping the message, and Continue delivers it once`, async () => {
      observeAdmissionRetries();
      retryAtOnce();
      const f = await messageWakeWithoutSession();
      const id = await f.progress('Worker progress u14m');
      // Without the bound the attempts never stop: one attempt past it is enough to fail on.
      await until(() => {
        return (store.getRun(f.p.id)?.status === 'failed' && !manager.isActive(f.p.id)) ||
          prompted(runner, MESSAGE_WAKE_OPENING).length > MAX_WAKE_DELIVERY_ATTEMPTS;
      });
      expect(prompted(runner, MESSAGE_WAKE_OPENING)).toHaveLength(MAX_WAKE_DELIVERY_ATTEMPTS);
      const run = store.getRun(f.p.id)!;
      expect(run.status).toBe('failed');
      expect(run.error).toMatch(/^continue failed: /);
      expect(delivered(f.p.id, id)).toBe(false);
      expect(store.readEvents(f.p.id).filter(event => event.type === 'note' && event.message === WAKE_DELIVERY_CAP_NOTE)).toHaveLength(1);
      expect(retryClock.pending).toBe(0);
      await expectAdmissionRetryCleared(runner, f.p.id);

      // A steering wire took the message into each failed opening turn; none of them read it.
      const attempts = prompted(runner, 'Worker progress u14m').length;
      f.failure.lift();
      expect(manager.continueRun(f.p.id, { text: 'go on' })).toEqual({ ok: true });
      await until(() => delivered(f.p.id, id) && prompted(runner, 'Worker progress u14m').length > attempts);
      expect(store.getRun(f.p.id)?.agentInputs?.filter(input => input.id === id)).toHaveLength(1);
      await until(() => store.getRun(f.p.id)?.status === 'waiting');
    });

    it(`${runner} U14m a message-only wake that fails once counts the failure, and the delivered message clears it`, async () => {
      // The retry waits on its backoff, which the test fires once the provider is lifted.
      // Hold the product backoff until the provider is repaired.
      const f = await messageWakeWithoutSession();
      const id = await f.progress('Worker progress u14m once');
      await until(() => store.getRun(f.p.id)?.waitDeliveryFailures === 1 && retryClock.pending > 0 && !manager.isActive(f.p.id));
      expect(store.getRun(f.p.id)?.status).toBe('waiting');
      f.failure.lift();
      const commits = recordCommits(join(root, '.ai/cezar'));
      await retryClock.advance(WAKE_RETRY_BACKOFF.fastMs);
      await until(() => delivered(f.p.id, id) && store.getRun(f.p.id)?.agentInputs?.find(input => input.id === id)?.awaitingRead !== true);
      expect(store.getRun(f.p.id)?.waitDeliveryFailures).toBeUndefined();
      // hearsay-tools/cezarion#1805: the receipt or the read that ends the failures clears them in its commit.
      commits.expectEveryCommit(f.p.id, row => { const message = row.agentInputs?.find(input => input.id === id); return !message?.deliveredAt || !!message.awaitingRead || row.waitDeliveryFailures === undefined; },
        'a received message and its cleared failure count');
      await until(() => store.getRun(f.p.id)?.status === 'waiting');
      expect(store.getRun(f.p.id)?.waitDeliveryFailures).toBeUndefined();
    });

    /** A parent on `runner`'s wire parked on a worker wait, written back to disk as an older build
     *  left it (the wait in `delegation.wait`, the list empty, `inputs` its only agent inputs), and
     *  restarted: upgrade-on-read and recovery decide what wakes it. */
    async function restartLegacyParked(legacy: (wait: WorkerWaitEntry) => Record<string, unknown>, inputs: (parentId: string, workerId: string, wait: WorkerWaitEntry) => unknown[], completion = false) {
      const { p, w } = await parentWithWorker(runner);
      await parentTurn(p.id, toolCall('cezar_wait', { kind: WAIT_KIND.worker, worker_ids: [w.id], timeout_seconds: 600 }), () => parkedOn(p.id, workerWaits(p.id)[0]));
      const wait = workerWaits(p.id)[0]!;
      store.flush();
      const disk = readPersistedRuns(join(root, '.ai/cezar')).map(row => {
        if (row.id !== p.id) return row;
        const { waits: _waits, ...rest } = row;
        return { ...rest, delegation: { ...row.delegation, wait: legacy(wait), ...(completion ? { completion: { phase: 'waiting', waitId: wait.id } } : {}) }, agentInputs: inputs(p.id, w.id, wait) };
      });
      await restart(false, disk);
      return { p, wait };
    }
    const legacyOf = (wait: WorkerWaitEntry) => ({ id: wait.id, workerIds: wait.workerIds, revisions: wait.revisions, deadline: wait.deadline, outcomes: [] });

    it(`${runner} U9u after an upgrade, a cancelled worker wait's queued wake is delivered as ordinary input and the wait stays cancelled`, async () => {
      const text = 'Worker wait cancelled, u9u marker';
      const { p, wait } = await restartLegacyParked(wait => ({ ...legacyOf(wait), phase: 'wake-pending', reason: 'cancelled', wakeId: wait.id }),
        (parentId, _workerId, wait) => [{ id: wait.id, parentRunId: parentId, source: 'lifecycle', text, createdAt: new Date().toISOString() }]);
      await until(() => delivered(p.id, wait.id) && prompted(runner, text).length > 0);
      expect(settled(p.id, wait.id)).toMatchObject({ kind: WAIT_KIND.worker, phase: WAIT_PHASE.cancelled });
      expect(workerWaits(p.id)).toEqual([]);
      await until(() => store.getRun(p.id)?.status === 'waiting');
    });

    it(`${runner} U9u after an upgrade, a parent whose message stand-in a provider took before the crash resumes`, async () => {
      const messageId = randomUUID(), now = new Date().toISOString();
      const { p } = await restartLegacyParked(wait => ({ id: randomUUID(), workerIds: [], outcomes: [], deadline: wait.deadline, phase: 'wake-pending', reason: 'message', wakeId: messageId }),
        (parentId, workerId) => [{ id: messageId, parentRunId: parentId, source: agentInputSchema.shape.source.enum.agent, text: 'Worker progress u9u', createdAt: now, deliveredAt: now,
          conversation: { senderRunId: workerId, recipientRunId: parentId, kind: 'progress' } }]);
      await until(() => store.getRun(p.id)?.steps.some(step => step.id === 'continue-1') === true || terminal.includes(store.getRun(p.id)?.status ?? ''));
      expect(store.getRun(p.id)?.steps.some(step => step.id === 'continue-1')).toBe(true);
      expect(store.getRun(p.id)?.agentInputs?.filter(input => input.id === messageId)).toEqual([expect.objectContaining({ deliveredAt: now })]);
      await until(() => store.getRun(p.id)?.status === 'waiting');
    });

    it(`${runner} U9v an upgraded completion wait wakes once through the list`, async () => {
      // The queued wake is the list engine's to deliver, in its own words for the entry.
      let text = '';
      const { p, wait } = await restartLegacyParked(wait => ({ ...legacyOf(wait), mode: 'all', phase: 'wake-pending', reason: 'outcome', wakeId: wait.id }),
        (parentId, _workerId, wait) => [{ id: wait.id, parentRunId: parentId, source: 'lifecycle', text: (text = workerWake(wait)), createdAt: new Date().toISOString() }], true);
      await until(() => delivered(p.id, wait.id) && prompted(runner, text).length > 0);
      expect(settled(p.id, wait.id)).toMatchObject({ kind: WAIT_KIND.worker, source: WAIT_SOURCE.cezar, via: WAIT_VIA.completion, phase: WAIT_PHASE.delivered });
      expect(workerWaits(p.id)).toEqual([]);
      expect(store.getRun(p.id)?.delegation).not.toHaveProperty('completion');
      expect(store.getRun(p.id)?.delegation).not.toHaveProperty('wait');
      expect(inputsFor(p.id, wait.id)).toHaveLength(1);
      expect(prompted(runner, text)).toHaveLength(1);
      await until(() => store.getRun(p.id)?.status === 'waiting');
    });

  }
}
