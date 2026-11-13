import { waitPartDescribers, repliesDoneAgain, nativeWire, ignoreRefusal, workerWaits, parkNotices, delivered, parkedOn, messenger, workerParent, listed, inputsFor, expectPoolCapacity, settled, prompted, workerWake, turnEnds, waitOfKind, fireTimer } from './waits-parity-fixture.testkit.ts';
import { join } from 'node:path';
import { expect, it as registerTest } from 'vitest';
import { WAIT_PHASE, WAIT_KIND, WAIT_SOURCE, WAIT_VIA, RUN_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { toRunSummary } from '@open-mercato/cezar-contract/runs';
import type { RunnerId } from '../core/agent-runner.ts';
import { HARNESS_ADAPTERS } from '../core/harness-parity-core.testkit.ts';
import { delegatingParent, checkpoint, until, store, timeline, spendWorkerBudget, manager, fixtureUpdateRun, restart, root } from './worker-wait-core.testkit.ts';
import { timed } from './waits.testkit.ts';
import { readPersistedRuns } from '../runs/run-store.testkit.ts';
import { toolCall } from './waits-parity.testkit.ts';

// The completion part of the wait parity cells (`WAIT_PARITY_PARTS` in `waits-parity-catalog.testkit.ts`).
// A wait parity file imports this module first, so it loads no other part's cells (hearsay-tools/cezarion#3242).
export const { describeWaitParity } = waitPartDescribers('completion', completionCells);

/** A delegating parent parked on Squawk's completion wait (`ignoreRefusal`) on worker `w`, which
 *  sends it messages with its own credential, as `cez worker send` does. `w` is created after the
 *  done its reply turn sends was accepted, then starts and plain-parks: an idle worker that only
 *  talks. Its park sends the parent one park notice (hearsay-tools/cezarion#1327), which wakes it
 *  once; the parent is parked on the completion wait again when this returns. */
async function completionParkOnMessenger(runner: RunnerId) {
  const reply = repliesDoneAgain();
  nativeWire(runner);
  process.env.CEZ_CLAUDE_BIN = HARNESS_ADAPTERS.claude.mockBin;
  const { p, service, callerFor } = await delegatingParent({ task: HARNESS_ADAPTERS[runner].scenarios.baseline!, runner, permissions: ['spawn', 'wait', 'steer', 'inspect'] });
  checkpoint('parent-opening-repark');
  await until(() => store.getRun(p.id)?.status === 'waiting', () => timeline(p.id));
  const { second: w, entry } = await ignoreRefusal(runner, p.id, reply, () => workerWaits(p.id)[0]?.phase === 'open');
  spendWorkerBudget(w.id);
  manager.enqueueOwnedRun(w.id);
  checkpoint('completion-messenger-park');
  await until(() => store.getRun(w.id)?.status === 'waiting' && parkNotices(p.id, w.id).length === 1, () => timeline(w.id));
  const notice = parkNotices(p.id, w.id)[0]!;
  await until(() => delivered(p.id, notice.id) && store.getRun(p.id)?.status === 'waiting' && parkedOn(p.id, workerWaits(p.id)[0]), () => timeline(p.id));
  expect(workerWaits(p.id)).toEqual([expect.objectContaining({ id: entry.id, phase: WAIT_PHASE.open })]);
  return { f: { p, w, ...messenger(service, callerFor, p, w) }, entry: workerWaits(p.id)[0]! };
}

export function completionCells(runners: RunnerId[], it: typeof registerTest = registerTest): void {
  for (const runner of runners) {
    it(`${runner} U21 an ignored refusal with live workers parks on a Squawk worker wait that settlement wakes`, async () => {
      const reply = repliesDoneAgain();
      const p = await workerParent(runner);
      const { second: w, entry } = await ignoreRefusal(runner, p.id, reply, () => workerWaits(p.id)[0]?.phase === 'open');
      // Only Squawk's completion wait is open: no implicit live-worker re-check timer beside it.
      expect(store.getRun(p.id)?.waits).toEqual([entry]);
      expect(entry).toMatchObject({ kind: WAIT_KIND.worker, source: WAIT_SOURCE.cezar, via: WAIT_VIA.completion, mode: 'all', workerIds: [w.id], phase: WAIT_PHASE.open });
      expect(entry).not.toHaveProperty('deadline');
      expect(entry).not.toHaveProperty('timeoutSeconds');
      expect(listed(p.id, entry.id)).toEqual(entry);
      expect(inputsFor(p.id, entry.id)).toEqual([]);
      await expectPoolCapacity(runner, p.id, false);
      expect(store.getRun(p.id)?.delegation).not.toHaveProperty('wait');
      expect(store.getRun(p.id)?.delegation).not.toHaveProperty('completion');
      expect(toRunSummary(store.getRun(p.id)!).waitingOn).toEqual({ kind: 'workers', count: 1 });
      fixtureUpdateRun(w.id, { status: RUN_STATUS.done });
      await until(() => settled(p.id, entry.id)?.phase === 'delivered' && prompted(runner, workerWake(entry)).length > 0);
      expect(settled(p.id, entry.id)).toMatchObject({ result: { reason: 'outcome' } });
      expect(inputsFor(p.id, entry.id)).toHaveLength(1);
      expect(prompted(runner, workerWake(entry))).toHaveLength(1);
      await until(() => store.getRun(p.id)?.status === 'waiting');
    });

    it(`${runner} U21r after a restart, a deadline-less completion wait resolves on the worker's settlement and wakes the parent once`, async () => {
      const reply = repliesDoneAgain();
      // Recovery re-queues the worker (`reviveQueuedRun`), which then runs its task and settles
      // done: a store write cannot settle a queued run the scheduler starts (hearsay-tools/cezarion#1804).
      const p = await workerParent(runner);
      const { entry } = await ignoreRefusal(runner, p.id, reply, () => workerWaits(p.id)[0]?.phase === 'open', { task: 'mock:cezar-done' });
      store.flush();
      await restart(false, readPersistedRuns(join(root, '.ai/cezar')));
      expect(workerWaits(p.id)).toEqual([entry]);
      await until(() => settled(p.id, entry.id)?.phase === 'delivered' && prompted(runner, workerWake(entry)).length > 0);
      expect(settled(p.id, entry.id)).toMatchObject({ result: { reason: 'outcome' } });
      expect(inputsFor(p.id, entry.id)).toHaveLength(1);
      expect(prompted(runner, workerWake(entry))).toHaveLength(1);
      await until(() => store.getRun(p.id)?.status === 'waiting');
    });

    it(`${runner} U21m a worker message wakes a parent parked on the completion wait and the wait stays open`, async () => {
      const { f, entry } = await completionParkOnMessenger(runner);
      // Inspection shows the parked parent's completion wait, without a deadline (hearsay-tools/cezarion#1301).
      const inspected = await f.inspect();
      expect(inspected).not.toHaveProperty('wait');
      expect(inspected.completionWait).toEqual({ id: entry.id, via: WAIT_VIA.completion, workerIds: [f.w.id], mode: 'all', phase: 'parked',
        outcomes: [], revisions: entry.revisions, wakeId: entry.id });
      const turns = turnEnds(f.p.id);
      const id = await f.progress('Worker progress u21m');
      await until(() => delivered(f.p.id, id) && prompted(runner, 'Worker progress u21m').length > 0);
      // The wake's footer names the open completion wait, which has no deadline.
      expect(prompted(runner, 'Worker progress u21m')).toEqual([expect.stringContaining(`Still open: worker wait ${entry.id} on 1 worker, no deadline.`)]);
      await until(() => turnEnds(f.p.id) > turns && parkedOn(f.p.id, workerWaits(f.p.id)[0]));
      expect(store.getRun(f.p.id)?.waits).toEqual([expect.objectContaining({ id: entry.id, via: WAIT_VIA.completion, phase: WAIT_PHASE.open })]);
      expect(inputsFor(f.p.id, entry.id)).toEqual([]);
      await expectPoolCapacity(runner, f.p.id, false);
      // The wait still ends on its own event, once.
      expect(manager.finish(f.w.id)).toBe(true);
      await until(() => settled(f.p.id, entry.id)?.phase === 'delivered' && prompted(runner, workerWake(entry)).length > 0);
      expect(inputsFor(f.p.id, entry.id)).toHaveLength(1);
      await until(() => store.getRun(f.p.id)?.status === 'waiting');
    });

    // Review round 1 (hearsay-tools/cezarion#1301): a blocked done never opens the completion wait
    // beside an open timer (U11), but the reverse order is reachable. A worker message wakes a parent
    // parked on its completion wait (U21m), and an explicit cezar_wait in that turn opens the
    // agent's timer beside it.
    it(`${runner} U21t an agent timer registered beside a completion-wait park keeps its deadline and wakes beside it`, async () => {
      checkpoint('u21t-completion-refusal');
      const { f, entry } = await completionParkOnMessenger(runner);
      const waitAt = async (phase: string, predicate: () => boolean) => {
        checkpoint(`u21t-${phase}`);
        await until(predicate, () => timeline(f.p.id));
      };
      let turns = turnEnds(f.p.id);
      const timerPrompt = toolCall('cezar_wait', { kind: WAIT_KIND.timer, seconds: 600, note: 'u21t explicit timer' });
      checkpoint('u21t-timer-admission');
      const id = await f.progress(timerPrompt);
      await waitAt('timer-native-prompt', () => prompted(runner, timerPrompt).length > 0);
      await waitAt('timer-delivery', () => delivered(f.p.id, id));
      await waitAt('timer-turn-end', () => turnEnds(f.p.id) > turns);
      await waitAt('timer-repark', () => parkedOn(f.p.id, waitOfKind(f.p.id, 'timer')));
      const timer = timed(waitOfKind(f.p.id, 'timer')!);
      expect(timer).toMatchObject({ via: WAIT_VIA.cezar_wait, note: 'u21t explicit timer' });
      expect(store.getRun(f.p.id)?.waits).toEqual([
        expect.objectContaining({ id: entry.id, via: WAIT_VIA.completion, phase: WAIT_PHASE.open }),
        expect.objectContaining({ id: timer.id, source: WAIT_SOURCE.agent, phase: WAIT_PHASE.open, deadline: timer.deadline }),
      ]);
      expect(workerWaits(f.p.id)[0]).not.toHaveProperty('deadline');
      // The timer wakes the parent once; the completion wait stays open, with no deadline.
      turns = turnEnds(f.p.id);
      fireTimer(timer.id);
      await waitAt('timer-wake-delivery', () => settled(f.p.id, timer.id)?.phase === 'delivered');
      await waitAt('timer-wake-native-prompt', () => prompted(runner, inputsFor(f.p.id, timer.id)[0]!.text).length > 0);
      await waitAt('timer-wake-turn-end', () => turnEnds(f.p.id) > turns);
      await waitAt('timer-wake-repark', () => parkedOn(f.p.id, workerWaits(f.p.id)[0]));
      expect(inputsFor(f.p.id, timer.id)).toHaveLength(1);
      expect(prompted(runner, inputsFor(f.p.id, timer.id)[0]!.text)).toEqual([expect.stringContaining(`Still open: worker wait ${entry.id} on 1 worker, no deadline.`)]);
      expect(store.getRun(f.p.id)?.waits).toEqual([expect.objectContaining({ id: entry.id, via: WAIT_VIA.completion, phase: WAIT_PHASE.open })]);
      expect(workerWaits(f.p.id)[0]).not.toHaveProperty('deadline');
      expect(inputsFor(f.p.id, entry.id)).toEqual([]);
      // The worker's settlement still resolves the completion wait, and it wakes the parent once.
      expect(manager.finish(f.w.id)).toBe(true);
      await waitAt('completion-wake-delivery', () => settled(f.p.id, entry.id)?.phase === 'delivered');
      await waitAt('completion-wake-native-prompt', () => prompted(runner, workerWake(entry)).length > 0);
      expect(inputsFor(f.p.id, entry.id)).toHaveLength(1);
      expect(prompted(runner, workerWake(entry))).toHaveLength(1);
      await waitAt('completion-wake-repark', () => store.getRun(f.p.id)?.status === 'waiting');
    });

  }
}
