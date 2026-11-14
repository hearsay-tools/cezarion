import { waitPartDescribers, github, parentWithWorker, pr, parentTurn, waitOfKind, workerWaits, turnEnds, settled, prompted, workerWake, parkedOn, agentWaits, inputsFor, fireTimer, timerText, conversingParent, delivered, parentOn, parkNotices, conversationOf } from './waits-parity-fixture.testkit.ts';
import { it as registerTest, expect } from 'vitest';
import { WAIT_KIND, WAIT_VIA, WAIT_SOURCE, RUN_STATUS, WAIT_PHASE } from '@open-mercato/cezar-contract/test-factories.testkit';
import type { RunnerId } from '../core/agent-runner.ts';
import { parkNoticeId } from '../delegation/park-notice.ts';
import { fixtureUpdateRun, until, store, manager, worker, timeline, spendWorkerBudget, root, terminal } from './worker-wait-core.testkit.ts';
import type { TimedWait } from './waits.testkit.ts';
import { messagesPrompt } from './monitoring-turn.testkit.ts';
import { toolCall, thenSay, ciNativeMessages, ciNativeSteers } from './waits-parity.testkit.ts';
import { productName } from '../home/display.ts';

// The mixed part of the wait parity cells (`WAIT_PARITY_PARTS` in `waits-parity-catalog.testkit.ts`).
// A wait parity file imports this module first, so it loads no other part's cells (hearsay-tools/cezarion#3242).
export const { describeWaitParity } = waitPartDescribers('mixed', mixedCells);

export function mixedCells(runners: RunnerId[], it: typeof registerTest = registerTest): void {
  for (const runner of runners) {
    it(`${runner} U2w ci and worker open: the worker resolving wakes the agent with ci still open and in the footer, and the later ci result is delivered`, async () => {
      const external = github();
      const { p, w } = await parentWithWorker(runner);
      const opened = `${toolCall('cezar_wait', { kind: WAIT_KIND.pr, pr })} ${toolCall('cezar_wait', { kind: WAIT_KIND.worker, worker_ids: [w.id], timeout_seconds: 600 })}`;
      await parentTurn(p.id, opened, () => waitOfKind(p.id, 'pr')?.phase === 'open' && workerWaits(p.id)[0]?.phase === 'open');
      const ci = waitOfKind(p.id, 'pr')!, workers = workerWaits(p.id)[0]!;
      expect(workers).toMatchObject({ via: WAIT_VIA.cezar_wait, source: WAIT_SOURCE.agent, workerIds: [w.id] });
      const turns = turnEnds(p.id);
      fixtureUpdateRun(w.id, { status: RUN_STATUS.done });
      await until(() => settled(p.id, workers.id)?.phase === 'delivered' && prompted(runner, workerWake(workers)).length > 0);
      const wake = prompted(runner, workerWake(workers)).at(-1)!;
      expect(wake).toContain(`Still open: CI wait ${ci.id} for acme/repo#12`);
      expect(wake).not.toContain(`worker wait ${workers.id}`);
      expect(external.aborted()).toBe(false);
      await until(() => turnEnds(p.id) > turns && parkedOn(p.id, waitOfKind(p.id, 'pr')));
      expect(agentWaits(p.id)).toEqual([expect.objectContaining({ id: ci.id, phase: WAIT_PHASE.open })]);
      external.settle();
      await until(() => settled(p.id, ci.id)?.phase === 'delivered' && prompted(runner, `CI wait observation ${ci.id}`).length > 0);
      expect(prompted(runner, `CI wait observation ${ci.id}`).at(-1)).not.toContain('Still open');
      expect(inputsFor(p.id, workers.id)).toHaveLength(1);
      await until(() => store.getRun(p.id)?.status === 'waiting' && !agentWaits(p.id).length);
    });

    it(`${runner} U2t timer and worker open: the timer resolving wakes the agent with the worker wait still open and in the footer, and the later worker result is delivered`, async () => {
      const { p, w } = await parentWithWorker(runner);
      const opened = `${toolCall('cezar_wait', { kind: WAIT_KIND.worker, worker_ids: [w.id], timeout_seconds: 600 })} ${toolCall('cezar_wait', { kind: WAIT_KIND.timer, seconds: 60, note: 'u2t' })}`;
      await parentTurn(p.id, opened, () => waitOfKind(p.id, 'timer')?.phase === 'open' && workerWaits(p.id)[0]?.phase === 'open');
      const timer = waitOfKind(p.id, 'timer')!, workers = workerWaits(p.id)[0]!;
      const turns = turnEnds(p.id);
      fireTimer(timer.id);
      await until(() => settled(p.id, timer.id)?.phase === 'delivered' && prompted(runner, timerText(timer, 'u2t')).length > 0);
      expect(prompted(runner, timerText(timer, 'u2t')).at(-1)).toContain(`Still open: worker wait ${workers.id} on 1 worker`);
      await until(() => turnEnds(p.id) > turns && parkedOn(p.id, workerWaits(p.id)[0]));
      // The turn end re-parks on the same entry: nothing re-registered it, nothing delivered it.
      expect(agentWaits(p.id)).toEqual([expect.objectContaining({ id: workers.id, phase: WAIT_PHASE.open, deadline: workers.deadline })]);
      expect(inputsFor(p.id, workers.id)).toEqual([]);
      fixtureUpdateRun(w.id, { status: RUN_STATUS.done });
      await until(() => settled(p.id, workers.id)?.phase === 'delivered' && prompted(runner, workerWake(workers)).length > 0);
      expect(prompted(runner, workerWake(workers)).at(-1)).not.toContain('Still open');
      await until(() => store.getRun(p.id)?.status === 'waiting' && !agentWaits(p.id).length);
    });

    it(`${runner} U2c ci and worker open: the ci result wakes the agent with the worker wait still open and in the footer, and the later worker result is delivered`, async () => {
      const external = github();
      const { p, w } = await parentWithWorker(runner);
      const opened = `${toolCall('cezar_wait', { kind: WAIT_KIND.worker, worker_ids: [w.id], timeout_seconds: 600 })} ${toolCall('cezar_wait', { kind: WAIT_KIND.pr, pr })}`;
      await parentTurn(p.id, opened, () => waitOfKind(p.id, 'pr')?.phase === 'open' && workerWaits(p.id)[0]?.phase === 'open');
      const ci = waitOfKind(p.id, 'pr')!, workers = workerWaits(p.id)[0]!;
      const turns = turnEnds(p.id);
      external.settle();
      await until(() => settled(p.id, ci.id)?.phase === 'delivered' && prompted(runner, `CI wait observation ${ci.id}`).length > 0);
      expect(prompted(runner, `CI wait observation ${ci.id}`).at(-1)).toContain(`Still open: worker wait ${workers.id} on 1 worker`);
      await until(() => turnEnds(p.id) > turns && parkedOn(p.id, workerWaits(p.id)[0]));
      // The turn end re-parks on the same entry: nothing re-registered it, nothing delivered it.
      expect(agentWaits(p.id)).toEqual([expect.objectContaining({ id: workers.id, phase: WAIT_PHASE.open, deadline: workers.deadline })]);
      expect(inputsFor(p.id, workers.id)).toEqual([]);
      fixtureUpdateRun(w.id, { status: RUN_STATUS.done });
      await until(() => settled(p.id, workers.id)?.phase === 'delivered' && prompted(runner, workerWake(workers)).length > 0);
      expect(prompted(runner, workerWake(workers)).at(-1)).not.toContain('Still open');
      expect(inputsFor(p.id, ci.id)).toHaveLength(1);
      await until(() => store.getRun(p.id)?.status === 'waiting' && !agentWaits(p.id).length);
    });

    // Ticket criterion 2: messages are not waits.
    it(`${runner} U3w a worker message during a worker wait wakes the parent and the worker wait stays open`, async () => {
      const f = await conversingParent(runner);
      await parentTurn(f.p.id, toolCall('cezar_wait', { kind: WAIT_KIND.worker, worker_ids: [f.w.id], timeout_seconds: 600 }), () => parkedOn(f.p.id, workerWaits(f.p.id)[0]));
      const workers = workerWaits(f.p.id)[0]!;
      const turns = turnEnds(f.p.id);
      const id = await f.progress('Worker progress u3w');
      await until(() => delivered(f.p.id, id) && prompted(runner, 'Worker progress u3w').length > 0);
      expect(prompted(runner, 'Worker progress u3w').at(-1)).toContain(`Still open: worker wait ${workers.id} on 1 worker`);
      await until(() => turnEnds(f.p.id) > turns && parkedOn(f.p.id, workerWaits(f.p.id)[0]));
      expect(workerWaits(f.p.id)).toEqual([expect.objectContaining({ id: workers.id, phase: WAIT_PHASE.open, deadline: workers.deadline })]);
      expect(inputsFor(f.p.id, workers.id)).toEqual([]);
      // The wait still ends on its own event, once.
      expect(manager.finish(f.w.id)).toBe(true);
      await until(() => settled(f.p.id, workers.id)?.phase === 'delivered' && prompted(runner, workerWake(workers)).length > 0);
      expect(settled(f.p.id, workers.id)).toMatchObject({ result: { reason: 'outcome' } });
      expect(inputsFor(f.p.id, workers.id)).toHaveLength(1);
      await until(() => store.getRun(f.p.id)?.status === 'waiting');
    });

    // hearsay-tools/cezarion#1327: the worker runs on this runner's wire too, since its turn end parks.
    it(`${runner} U3n a worker that parks on a timer while its parent waits on it wakes the parent with one notice naming its timer, the wait stays open, a second park sends none, and settlement resolves the wait`, async () => {
      const p = await parentOn(runner);
      const parkOnTimer = (text: string) => `${toolCall('cezar_wait', { kind: WAIT_KIND.timer, seconds: 600, note: 'u3n' })} ${thenSay(text)}`;
      const timerOf = () => store.getRun(w.id)?.waits?.filter((wait): wait is TimedWait => wait.kind === WAIT_KIND.timer && wait.phase === WAIT_PHASE.open) ?? [];
      const w = await worker(p.id, parkOnTimer('Squeal is still pending u3n.'), runner);
      await parentTurn(p.id, toolCall('cezar_wait', { kind: WAIT_KIND.worker, worker_ids: [w.id], timeout_seconds: 600 }), () => parkedOn(p.id, workerWaits(p.id)[0]));
      const workers = workerWaits(p.id)[0]!;
      // A worker that has not parked yet sends nothing when the wait opens.
      expect(parkNotices(p.id, w.id)).toEqual([]);
      manager.enqueueOwnedRun(w.id);
      await until(() => parkedOn(w.id, timerOf()[0]) && parkNotices(p.id, w.id).length > 0, () => timeline(w.id));
      const [timer] = timerOf();
      const [notice, ...more] = parkNotices(p.id, w.id);
      expect(more).toEqual([]);
      expect(notice).toMatchObject({ id: parkNoticeId(w.id, workers.id), kind: 'progress', senderRunId: w.id, recipientRunId: p.id, state: 'accepted' });
      expect(notice!.text).toContain(`It waits on: timer ${timer!.id} at ${timer!.deadline}`);
      expect(notice!.text).toContain('Squeal is still pending u3n.');
      // The notice reaches the parent on its own wire, and the parent's wait stays open.
      await until(() => delivered(p.id, notice!.id) && prompted(runner, `${productName('Cezar')} notice: your worker ${w.id}`).length > 0);
      expect(prompted(runner, `${productName('Cezar')} notice: your worker ${w.id}`).at(-1)).toContain(`Still open: worker wait ${workers.id} on 1 worker`);
      await until(() => parkedOn(p.id, workerWaits(p.id)[0]));
      expect(workerWaits(p.id)).toEqual([expect.objectContaining({ id: workers.id, phase: WAIT_PHASE.open, deadline: workers.deadline })]);
      expect(inputsFor(p.id, workers.id)).toEqual([]);
      // A second park during the same wait sends no second notice.
      const turns = turnEnds(w.id);
      expect(manager.sendMessage(w.id, [{ type: 'text', text: parkOnTimer('Still pending u3n.') }])).toBe(true);
      await until(() => turnEnds(w.id) > turns && timerOf().length === 2 && parkedOn(w.id, timerOf()[1]), () => timeline(w.id));
      expect(parkNotices(p.id, w.id)).toHaveLength(1);
      // The wait still ends on the worker's outcome, once.
      expect(manager.finish(w.id)).toBe(true);
      await until(() => settled(p.id, workers.id)?.phase === 'delivered' && prompted(runner, workerWake(workers)).length > 0);
      expect(settled(p.id, workers.id)).toMatchObject({ result: { reason: 'outcome' } });
      expect(parkNotices(p.id, w.id)).toHaveLength(1);
    });

    it(`${runner} U3r a worker parked before its parent waits on it sends its notice when the wait opens`, async () => {
      const p = await parentOn(runner);
      const w = await worker(p.id, messagesPrompt(runner, ['Waiting for input u3r.']), runner);
      // A spent budget plain-parks the opening turn end instead of asking the parent.
      spendWorkerBudget(w.id);
      manager.enqueueOwnedRun(w.id);
      await until(() => store.getRun(w.id)?.status === 'waiting' && turnEnds(w.id) > 0, () => timeline(w.id));
      // No wait is open on the worker yet, so its park sends nothing.
      expect(parkNotices(p.id, w.id)).toEqual([]);
      await parentTurn(p.id, toolCall('cezar_wait', { kind: WAIT_KIND.worker, worker_ids: [w.id], timeout_seconds: 600 }), () => workerWaits(p.id)[0]?.phase === 'open');
      const workers = workerWaits(p.id)[0]!;
      // The wait opens inside the parent's turn, so the notice reaches that open turn: Codex
      // takes it as a steer, every other wire as a prompt.
      const [notice, ...more] = parkNotices(p.id, w.id);
      const reached = (text: string) => [...ciNativeMessages(runner, root), ...ciNativeSteers(runner, root)].some(input => input.includes(text));
      await until(() => !!notice && delivered(p.id, notice.id) && reached(`${productName('Cezar')} notice: your worker ${w.id}`) && parkedOn(p.id, workerWaits(p.id)[0]), () => timeline(p.id));
      expect(more).toEqual([]);
      expect(notice).toMatchObject({ id: parkNoticeId(w.id, workers.id), senderRunId: w.id, recipientRunId: p.id });
      expect(notice!.text).toContain('It has no open wait: it waits for a message from you.');
      expect(notice!.text).toContain('Its last message:\nWaiting for input u3r.');
      expect(workerWaits(p.id)).toEqual([expect.objectContaining({ id: workers.id, phase: WAIT_PHASE.open, deadline: workers.deadline })]);
      expect(inputsFor(p.id, workers.id)).toEqual([]);
    });

    it(`${runner} U3d a worker that finishes while its parent waits on it sends no notice`, async () => {
      const p = await parentOn(runner);
      const w = await worker(p.id, `${toolCall('cezar_done', {})} ${thenSay('Finished u3d.')}`, runner);
      await parentTurn(p.id, toolCall('cezar_wait', { kind: WAIT_KIND.worker, worker_ids: [w.id], timeout_seconds: 600 }), () => parkedOn(p.id, workerWaits(p.id)[0]));
      const workers = workerWaits(p.id)[0]!;
      manager.enqueueOwnedRun(w.id);
      await until(() => settled(p.id, workers.id)?.phase === 'delivered' && prompted(runner, workerWake(workers)).length > 0, () => timeline(w.id));
      expect(terminal).toContain(store.getRun(w.id)?.status);
      expect(store.readEvents(w.id).some(event => event.type === 'turn-end')).toBe(true);
      expect(conversationOf(p.id).filter(message => message.senderRunId === w.id)).toEqual([]);
      expect(prompted(runner, `${productName('Cezar')} notice:`)).toEqual([]);
    });

    it(`${runner} U7w cez worker wait and cezar_wait kind worker land in the same wait list`, async () => {
      const { p, w } = await parentWithWorker(runner);
      const other = await worker(p.id);
      const alias = manager.registerWorkerWait(p.id, { workerIds: [w.id], timeoutSeconds: 600 });
      await parentTurn(p.id, toolCall('cezar_wait', { kind: WAIT_KIND.worker, worker_ids: [other.id], timeout_seconds: 600 }), () => workerWaits(p.id).length === 2);
      expect(workerWaits(p.id).map(wait => [wait.via, wait.workerIds]).sort()).toEqual([['cez-worker-wait', [w.id]], ['cezar_wait', [other.id]]]);
      expect(workerWaits(p.id).find(wait => wait.via === 'cez-worker-wait')).toMatchObject({ id: alias.id, phase: WAIT_PHASE.open, source: WAIT_SOURCE.agent, deadline: alias.deadline });
      // One engine resolves both, each on its own worker.
      fixtureUpdateRun(w.id, { status: RUN_STATUS.done });
      await until(() => settled(p.id, alias.id)?.phase === 'delivered' && prompted(runner, `Worker wait ${alias.id}`).length > 0);
      expect(workerWaits(p.id)).toEqual([expect.objectContaining({ via: WAIT_VIA.cezar_wait, phase: WAIT_PHASE.open })]);
      const tool = workerWaits(p.id)[0]!;
      await until(() => store.getRun(p.id)?.status === 'waiting');
      fixtureUpdateRun(other.id, { status: RUN_STATUS.done });
      await until(() => settled(p.id, tool.id)?.phase === 'delivered' && prompted(runner, workerWake(tool)).length > 0);
      expect(store.getRun(p.id)?.lastWaits?.filter(wait => wait.kind === 'worker').map(wait => wait.via).sort()).toEqual(['cez-worker-wait', 'cezar_wait']);
      await until(() => store.getRun(p.id)?.status === 'waiting');
    });

  }
}
