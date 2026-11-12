import { setImmediate } from 'node:timers/promises';
import { setRunStatus } from '../runs/run-store.testkit.ts';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { RUN_STATUS, STEP_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { COMPLETION_NUDGE_NOTE, COMPLETION_WILL_WAIT, MAX_AUTO_CONTINUES } from './run.ts';
import { HARNESS_ADAPTERS } from '../core/harness-parity.testkit.ts';
import { withHeldAck } from '../core/owned-input-delivery.testkit.ts';
import { QUICK_TASK_WORKFLOW } from './types.ts';
import { checkpoint, collect, manager, parent, semaphore, store, until, useWorkerWaitFixture, waitOf, worker } from './worker-wait.testkit.ts';
import { completionNudges, sentTexts, recordAgentInput, blockedDone, sessionOf } from './worker-wait-readiness.testkit.ts';

// Real Git, durable fsync checkpoints and process shutdown share this outer budget.
// Keep the separate 15s state/termination assertions and actual runner timers intact.

// Real Git, durable checkpoints and native process shutdown retain their original budgets.
describe('worker Finish and completion nudges', { timeout: 30_000 }, () => {
  useWorkerWaitFixture();

for (const mode of ['fresh', 'continuation'] as const) {
    it(`readiness ${mode}: a DONE blocked by live workers gets the refusal nudge, opens no wait, and Finish stays refused`, async () => {
      const p = await parent();
      await until(() => store.getRun(p.id)?.status === 'waiting');
      if (mode === 'continuation') {
        expect(manager.finish(p.id)).toBe(true); await until(() => !manager.isActive(p.id));
        expect(manager.continueRun(p.id, { text: 'mock:hold' }).ok).toBe(true);
        await until(() => store.getRun(p.id)?.status === 'waiting');
      }
      const sent = recordAgentInput(p.id);
      const w = await blockedDone(p.id, () => worker(p.id));
      // hearsay-tools/cezarion#1301: the turn end's refusal, as one automatic turn.
      await until(() => completionNudges(p.id).length === 1 && store.getRun(p.id)?.status === 'waiting');
      expect(sentTexts(sent, `Workers are still live: ${w.id}.`)).toEqual([expect.stringContaining(COMPLETION_WILL_WAIT)]);
      expect(waitOf(store.getRun(p.id))).toBeUndefined();
      expect(store.getRun(p.id)?.delegation).not.toHaveProperty('completion');
      expect(store.getRun(p.id)?.waits?.filter(wait => wait.kind === 'worker') ?? []).toEqual([]);
      expect(manager.finish(p.id)).toBe(false);
      expect(store.getRun(p.id)?.delegation).not.toHaveProperty('finishRequestedAt');
      expect(store.getRun(w.id)?.status).toBe('queued');
      expect(semaphore.busy()).toBe(0);
    });
  }
// hearsay-tools/squawk#3337: a failed parent leaves its workers running, so their Continue (a human's,
// a provider-error retry's, recovery's) is admitted beside it.
it('a worker of a failed parent continues', async () => {
    const p = await parent(); const w = await worker(p.id);
    await until(() => store.getRun(p.id)?.status === RUN_STATUS.waiting);
    setRunStatus(store, w.id, RUN_STATUS.done);
    store.updateStep(w.id, 'task', { status: STEP_STATUS.done, sessionId: randomUUID(), backend: 'claude' });
    const generation = store.commitWorkerExecutionStart(w.id); store.commitWorkerExecutionComplete(w.id, generation);
    setRunStatus(store, p.id, RUN_STATUS.failed);
    expect(manager.continueRun(w.id, { text: 'mock:agent-echo more' }, true)).toEqual({ ok: true });
    expect(store.getRun(w.id)?.status).toBe(RUN_STATUS.queued);
    setRunStatus(store, p.id, RUN_STATUS.waiting);
    manager.requestWorkerStop(w.id); await manager.awaitRunTermination(w.id, 15_000);
  });
it.each(['review', 'done'] as const)('readiness worker Continue requires continuing a %s parent first', async status => {
    const p = await parent(); const w = await worker(p.id);
    await until(() => store.getRun(p.id)?.status === RUN_STATUS.waiting);
    setRunStatus(store, w.id, RUN_STATUS.done);
    store.updateStep(w.id, 'task', { status: STEP_STATUS.done, sessionId: randomUUID(), backend: 'claude' });
    const generation = store.commitWorkerExecutionStart(w.id); store.commitWorkerExecutionComplete(w.id, generation);
    setRunStatus(store, p.id, RUN_STATUS[status]);
    const before = JSON.stringify(store.getRun(w.id));
    expect(manager.continueRun(w.id, { text: 'more' })).toEqual({ ok: false, error: `Parent task ${p.id} is ${status}; continue the parent before its worker.` });
    expect(JSON.stringify(store.getRun(w.id))).toBe(before);
    // Its session is still live, which a reviewing parent never has: back to its park before
    // teardown stops it (hearsay-tools/cezarion#1804).
    setRunStatus(store, p.id, RUN_STATUS.waiting);
  });
it.each(['review', 'failed', 'cancelled'] as const)('readiness requires settled collection of %s and accepts partial failures', async status => {
    const p = await parent();
    await until(() => store.getRun(p.id)?.status === 'waiting');
    const w = await worker(p.id);
    const generation = store.commitWorkerExecutionStart(w.id);
    setRunStatus(store, w.id, status);
    await collect(w.id); // Same status/revision, but the process is still unproven.
    expect(manager.finish(p.id)).toBe(false);
    expect(store.commitWorkerExecutionComplete(w.id, generation)).toBe(true);
    expect(manager.finish(p.id)).toBe(false); // A formerly partial observation is not fresh evidence.
    const result = await collect(w.id);
    expect(result.settled).toBe(true);
    expect(manager.finish(p.id)).toBe(true);
    await until(() => !manager.isActive(p.id));
    expect(store.getRun(p.id)?.status).toBe('done');
  });
for (const mode of ['fresh', 'continuation'] as const) {
    for (const delayedAck of [false, true]) {
      it(`completion nudge ${mode} is sent and charged once with delayed ACK=${delayedAck}`, async () => {
        const exercise = async (release: () => void) => {
          const backend = delayedAck ? 'opencode' : 'claude';
          process.env.CEZ_DRY_RUN = '0'; process.env[HARNESS_ADAPTERS[backend].binEnv] = HARNESS_ADAPTERS[backend].mockBin;
          const p = manager.startRun(QUICK_TASK_WORKFLOW, { task: 'mock:hold', runner: backend });
          store.commitDelegation([{ id: p.id, delegation: { role: 'root', permissions: ['spawn', 'wait'], receipts: [] } }]);
          checkpoint('parent parked'); await until(() => store.getRun(p.id)?.status === 'waiting');
          if (mode === 'continuation') {
            expect(manager.finish(p.id)).toBe(true);
            checkpoint('parent finished'); await until(() => !manager.isActive(p.id));
            expect(manager.continueRun(p.id, { text: 'mock:hold' }).ok).toBe(true);
            checkpoint('continuation parked'); await until(() => store.getRun(p.id)?.status === 'waiting');
          }
          const sent = recordAgentInput(p.id);
          let acknowledgement: false | Promise<void> = false;
          const session = sessionOf(p.id);
          const send = session.sendAgentMessage.bind(session);
          session.sendAgentMessage = (...args) => {
            const result = send(...args);
            if (args[0].some(block => block.type === 'text' && block.text.includes('Workers are still live'))) acknowledgement = result;
            return result;
          };
          checkpoint('worker spawned'); const w = await blockedDone(p.id, () => worker(p.id));
          checkpoint('completion nudge note'); await until(() => completionNudges(p.id).length === 1);
          if (delayedAck) {
            // The nudge's own turn ends before its acknowledgement. The note is written inside that
            // turn, so its turn-end is the first one after the note; a count read after the note
            // misses it when the turn ends first (hearsay-tools/cezarion#1355).
            const note = completionNudges(p.id)[0]!.seq;
            checkpoint('nudge turn-end');
            await until(() => store.readEvents(p.id).some(event => event.type === 'turn-end' && event.seq > note));
            expect(acknowledgement).toBeInstanceOf(Promise);
            checkpoint('acknowledgement settled'); release(); await acknowledgement;
          }
          if (!delayedAck) {
            const note = completionNudges(p.id)[0]!.seq;
            await until(() => store.readEvents(p.id).some(event => event.type === 'turn-end' && event.seq > note));
            expect(acknowledgement).toBeInstanceOf(Promise);
            await acknowledgement;
          }
          // The runner ACK precedes Squawk's chained delivery bookkeeping. Drain its
          // promise reactions before reading the row; this does not wait for a park.
          await setImmediate();
          checkpoint('parent parked after nudge');
          expect(store.getRun(p.id)?.status).toBe('waiting');
          expect(sentTexts(sent, `Workers are still live: ${w.id}.`)).toHaveLength(1);
          expect(completionNudges(p.id)).toEqual([expect.objectContaining({ message: `${COMPLETION_NUDGE_NOTE} (1/${MAX_AUTO_CONTINUES}): workers_outstanding` })]);
          expect(waitOf(store.getRun(p.id))).toBeUndefined();
          expect(store.getRun(p.id)?.delegation).not.toHaveProperty('completion');
          expect(store.getRun(w.id)?.status).toBe('queued');
          expect(semaphore.busy()).toBe(0);
        };
        if (delayedAck) await withHeldAck('opencode', exercise, 'Workers are still live');
        else await exercise(() => {});
      });
    }
  }
});
