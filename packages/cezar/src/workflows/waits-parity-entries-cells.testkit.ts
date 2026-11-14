import { waitPartDescribers, runnerBoundary, sessionOf, flushMicrotasks, prompted, nudgeNotes, idleClock, turnEnds, nativeWire, gated, humanOpen, repliesDoneAgain, workerParent, ignoreRefusal, workerWaits, blockedDone, blockingWorker, liveRefusal, replyBlockedAgain, parkedOn, viaOf, expectPoolCapacity, parentWithWorker, uncollectedRefusal } from './waits-parity-fixture.testkit.ts';
import { NO_WAIT_NUDGE_NOTE, COMPLETION_WILL_WAIT } from './run.ts';
import { onTestFinished, expect, vi, it as registerTest } from 'vitest';
import { WAIT_PHASE, WAIT_VIA, WAIT_SOURCE, RUN_STATUS, WAIT_KIND } from '@open-mercato/cezar-contract/test-factories.testkit';
import type { Wait, RunRecord } from '@open-mercato/cezar-contract';
import type { RunnerId } from '../core/agent-runner.ts';
import { exemptionFor, HARNESS_ADAPTERS } from '../core/harness-parity-core.testkit.ts';
import { store, semaphore, until, manager, timeline, collect, fixtureUpdateRun, terminal } from './worker-wait-core.testkit.ts';
import { QUICK_TASK_WORKFLOW } from './types.ts';
import { NO_WAIT_NUDGE } from './turn-end.ts';
import { withHeldAck } from '../core/owned-input-delivery.testkit.ts';
import { toolCall } from './waits-parity.testkit.ts';

// The entries part of the wait parity cells (`WAIT_PARITY_PARTS` in `waits-parity-catalog.testkit.ts`).
// A wait parity file imports this module first, so it loads no other part's cells (hearsay-tools/cezarion#3242).
export const { describeWaitParity } = waitPartDescribers('entries', entriesCells);

/** Assert at publication, before a later nudge can hide a wait that opened too early. */
function observeWaitPublication(id: string, via: Wait['via'], assertNudge: () => void): () => void {
  const seen = new Set((store.getRun(id)?.waits ?? []).map(wait => wait.id));
  const failures: unknown[] = [];
  let publications = 0;
  const onRun = (run: RunRecord) => {
    if (run.id !== id) return;
    for (const wait of run.waits ?? []) {
      if (wait.phase !== WAIT_PHASE.open || wait.via !== via || seen.has(wait.id)) continue;
      seen.add(wait.id);
      publications++;
      try { assertNudge(); } catch (error) { failures.push(error); }
    }
  };
  store.on('run', onRun);
  onTestFinished(() => { store.off('run', onRun); });
  return () => {
    store.off('run', onRun);
    expect(publications).toBe(1);
    expect(failures).toEqual([]);
  };
}

function expectReleasedCapacity(): void {
  const limit = vi.spyOn(semaphore, 'maxMonitoringSessions').mockReturnValue(0);
  try { expect(semaphore.busy()).toBe(0); }
  finally { limit.mockRestore(); }
}

/** The transport ACK completes even when its deferred turn settlement is broken. */
function observeNudgeAcknowledgement(id: string, text: string): () => Promise<void> {
  let acknowledgement: Promise<void> | undefined;
  const observe = (runId: string) => {
    if (runId !== id) return;
    runnerBoundary.beforeReturn = undefined;
    const session = sessionOf(id);
    const send = session.sendAgentMessage.bind(session);
    const spy = vi.spyOn(session, 'sendAgentMessage').mockImplementation((content, inputIds) => {
      const ack = send(content, inputIds);
      if (ack && content.some(block => block.type === 'text' && block.text.includes(text))) acknowledgement = ack;
      return ack;
    });
    onTestFinished(() => { spy.mockRestore(); });
  };
  if (sessionOf(id)) observe(id);
  else runnerBoundary.beforeReturn = observe;
  return async () => {
    await until(() => acknowledgement !== undefined);
    await acknowledgement;
    // The product attaches its checkpoint and settlement reactions to this same ACK.
    await flushMicrotasks();
  };
}

export function entriesCells(runners: RunnerId[], it: typeof registerTest = registerTest): void {
  for (const runner of runners) {
    const noWaitNudges = (id: string) => store.readEvents(id).filter(event =>
      event.type === 'note' && String(event.message).startsWith(NO_WAIT_NUDGE_NOTE));
    const noWaitOrder = (id: string, count: number) => observeWaitPublication(id, WAIT_VIA['no-wait'], () => {
      expect(prompted(runner, NO_WAIT_NUDGE)).toHaveLength(count);
      expect(noWaitNudges(id)).toHaveLength(count);
    });
    const completionOrder = (id: string) => observeWaitPublication(id, WAIT_VIA.completion, () => {
      expect(nudgeNotes(id)).toHaveLength(1);
      expect(prompted(runner, 'Workers are still live:')).toHaveLength(1);
    });
    const idleClose = async (id: string) => {
      idleClock.fire(idleClock.captured - 1);
      await until(() => !manager.isActive(id) && store.getRun(id)?.status === 'waiting');
    };
    const continued = (id: string) => (prompt: string) => expect(manager.continueRun(id, { text: prompt }).ok).toBe(true);
    /** A late acknowledgement needs a wire whose turn can end before its input is acknowledged. */
    const lateAck = (body: (release: () => void) => Promise<void>, match?: string) => {
      if (exemptionFor('U27', runner)) {
        expect(exemptionFor('U27', runner)?.kind).toBe('capability-absent');
        return Promise.resolve();
      }
      return withHeldAck(runner as 'codex' | 'opencode' | 'pi' | 'omp', body, match);
    };
    /** The acknowledgement is held: the turn ended, and nothing settled it yet. */
    const heldAfterTurnEnd = async (id: string, turns: number, unsettled: () => boolean) => {
      await until(() => turnEnds(id) > turns);
      await flushMicrotasks();
      expect(unsettled()).toBe(true);
    };

    it(`${runner} U27 U5 a fresh step's no-wait turn end gets the nudge, then the no-wait human wait`, async () => {
      nativeWire(runner);
      const run = manager.startRun(QUICK_TASK_WORKFLOW, { runner, task: HARNESS_ADAPTERS[runner].scenarios.baseline! });
      const firstOrder = noWaitOrder(run.id, 1);
      await until(() => gated(run.id));
      expect(humanOpen(run.id)).toEqual([expect.objectContaining({ via: WAIT_VIA['no-wait'], source: WAIT_SOURCE.cezar })]);
      firstOrder();
      expect(store.getRun(run.id)?.status).toBe(RUN_STATUS.waiting);
      expectReleasedCapacity();
    });

    it(`${runner} U27 U5 a Continue's no-wait turn end gets the nudge, then the no-wait human wait`, async () => {
      nativeWire(runner);
      const run = manager.startRun(QUICK_TASK_WORKFLOW, { runner, task: HARNESS_ADAPTERS[runner].scenarios.baseline! });
      const firstOrder = noWaitOrder(run.id, 1);
      await until(() => gated(run.id));
      firstOrder();
      expectReleasedCapacity();
      await idleClose(run.id);
      const secondOrder = noWaitOrder(run.id, 2);
      expect(manager.continueRun(run.id, { text: 'carry on' }).ok).toBe(true);
      await until(() => prompted(runner, NO_WAIT_NUDGE).length === 2 && gated(run.id));
      expect(store.getRun(run.id)?.steps.some(step => step.id === 'continue-1')).toBe(true);
      expect(humanOpen(run.id)).toEqual([expect.objectContaining({ via: WAIT_VIA['no-wait'], source: WAIT_SOURCE.cezar })]);
      secondOrder();
      expect(store.getRun(run.id)?.status).toBe(RUN_STATUS.waiting);
      expectReleasedCapacity();
    });

    it(`${runner} U27 U5 a no-wait turn end an acknowledgement settles late opens the no-wait human wait and settles waiting`, async () => {
      // The nudge's acknowledgement is held, so the turn that answers it ends first.
      await lateAck(async release => {
        nativeWire(runner);
        const run = manager.startRun(QUICK_TASK_WORKFLOW, { runner, task: HARNESS_ADAPTERS[runner].scenarios.baseline! });
        const published = noWaitOrder(run.id, 1);
        const acknowledged = observeNudgeAcknowledgement(run.id, NO_WAIT_NUDGE);
        await until(() => prompted(runner, NO_WAIT_NUDGE).length === 1 && turnEnds(run.id) >= 1);
        await heldAfterTurnEnd(run.id, 1, () => humanOpen(run.id).length === 0 && store.getRun(run.id)?.status === 'running');
        expect(noWaitNudges(run.id)).toHaveLength(1);
        expect(semaphore.busy()).toBe(1);
        release();
        await acknowledged();
        expect(humanOpen(run.id)).toEqual([expect.objectContaining({ via: WAIT_VIA['no-wait'], source: WAIT_SOURCE.cezar })]);
        published();
        expect(store.getRun(run.id)?.status).toBe(RUN_STATUS.waiting);
        expectReleasedCapacity();
      }, 'Your turn ended without a wait or done.');
    });

    // The turn that answers the refusal nudge ends on done again: the second step, a completion wait.
    it(`${runner} U27 U6 a fresh step's second refused done with live workers parks on the completion wait and settles waiting`, async () => {
      const reply = repliesDoneAgain();
      const p = await workerParent(runner);
      const published = completionOrder(p.id);
      const { second } = await ignoreRefusal(runner, p.id, reply, () => workerWaits(p.id)[0]?.phase === 'open');
      expect(workerWaits(p.id)).toEqual([expect.objectContaining({ source: WAIT_SOURCE.cezar, via: WAIT_VIA.completion, workerIds: [second.id] })]);
      published();
      expect(store.getRun(p.id)?.status).toBe(RUN_STATUS.waiting);
      expectReleasedCapacity();
    });

    it(`${runner} U27 U6 a Continue's second refused done with live workers parks on the completion wait and settles waiting`, async () => {
      const reply = repliesDoneAgain();
      const p = await workerParent(runner);
      await idleClose(p.id);
      const published = completionOrder(p.id);
      const { second, refusal } = await ignoreRefusal(runner, p.id, reply, () => workerWaits(p.id)[0]?.phase === 'open', { send: continued(p.id) });
      expect(prompted(runner, refusal)).toHaveLength(1);
      expect(store.getRun(p.id)?.steps.some(step => step.id === 'continue-1')).toBe(true);
      expect(workerWaits(p.id)).toEqual([expect.objectContaining({ source: WAIT_SOURCE.cezar, via: WAIT_VIA.completion, workerIds: [second.id] })]);
      published();
      expect(store.getRun(p.id)?.status).toBe(RUN_STATUS.waiting);
      expectReleasedCapacity();
    });

    it(`${runner} U27 U6 a second refused done an acknowledgement settles late parks on the completion wait and settles waiting`, async () => {
      // The refusal nudge's acknowledgement is held, so the turn that answers it ends on done first.
      await lateAck(async release => {
        const reply = repliesDoneAgain();
        const p = await workerParent(runner);
        const published = completionOrder(p.id);
        const acknowledged = observeNudgeAcknowledgement(p.id, 'Workers are still live');
        const turns = turnEnds(p.id);
        const w = await blockedDone(p.id, () => blockingWorker(p.id));
        const refusal = liveRefusal(w);
        await until(() => prompted(runner, refusal).length === 1 && turnEnds(p.id) > turns);
        const second = await replyBlockedAgain(p.id, reply, w, () => blockingWorker(p.id));
        await heldAfterTurnEnd(p.id, turns + 1, () => workerWaits(p.id).length === 0 && store.getRun(p.id)?.status === 'running');
        expect(semaphore.busy()).toBe(1);
        release();
        await acknowledged();
        expect(workerWaits(p.id)).toEqual([expect.objectContaining({ source: WAIT_SOURCE.cezar, via: WAIT_VIA.completion, workerIds: [second.id] })]);
        expect(store.getRun(p.id)?.status).toBe(RUN_STATUS.waiting);
        expect(prompted(runner, refusal)).toHaveLength(1);
        published();
        expect(nudgeNotes(p.id)).toHaveLength(1);
        expectReleasedCapacity();
      }, 'Workers are still live');
    });

    // A refused done beside an open timer parks on the timer, which keeps its slot.
    const timerPark = async (id: string) => {
      const turns = turnEnds(id);
      expect(manager.sendMessage(id, [{ type: 'text', text: toolCall('cezar_wait', { kind: WAIT_KIND.timer, seconds: 600, note: 'u27 u11' }) }])).toBe(true);
      await until(() => turnEnds(id) > turns && parkedOn(id, viaOf(id, WAIT_VIA.cezar_wait)));
      return viaOf(id, WAIT_VIA.cezar_wait)!;
    };
    const refusalNoted = (id: string, refusal: string) => store.readEvents(id).some(event => event.type === 'note' && String(event.message).includes(refusal));
    const expectTimerPark = async (id: string, timer: Wait, refusal: string) => {
      expect(store.getRun(id)?.waits).toEqual([expect.objectContaining({ id: timer.id, phase: WAIT_PHASE.open })]);
      expect(nudgeNotes(id)).toEqual([]);
      expect(prompted(runner, refusal)).toEqual([]);
      await expectPoolCapacity(runner, id, true);
      expect(store.getRun(id)?.status).toBe(RUN_STATUS.waiting);
    };

    it(`${runner} U27 U11 a fresh step's refused done beside an open timer parks on it and settles monitoring`, async () => {
      const p = await workerParent(runner);
      const timer = await timerPark(p.id);
      const turns = turnEnds(p.id);
      const refusal = liveRefusal(await blockedDone(p.id, () => blockingWorker(p.id)));
      await until(() => turnEnds(p.id) > turns && parkedOn(p.id, viaOf(p.id, WAIT_VIA.cezar_wait)) && refusalNoted(p.id, refusal));
      await expectTimerPark(p.id, timer, refusal);
    });

    it(`${runner} U27 U11 a Continue's refused done beside an open timer parks on it and settles monitoring`, async () => {
      const p = await workerParent(runner);
      const timer = await timerPark(p.id);
      sessionOf(p.id).end();
      await until(() => !manager.isActive(p.id));
      const refusal = liveRefusal(await blockedDone(p.id, () => blockingWorker(p.id), continued(p.id)));
      await until(() => store.getRun(p.id)?.steps.some(step => step.id === 'continue-1') === true &&
        parkedOn(p.id, viaOf(p.id, WAIT_VIA.cezar_wait)) && refusalNoted(p.id, refusal) && manager.isActive(p.id));
      await expectTimerPark(p.id, timer, refusal);
    });

    // A human message's acknowledgement held past its turn end (hearsay-tools/cezarion#2022), as the
    // U20 row's. A worker message cannot open this turn: its live sender would make the tool refuse
    // the done.
    it(`${runner} U27 U11 a refused done beside an open timer that an acknowledgement settles late parks on it and settles monitoring`, async () => {
      await lateAck(async release => {
        const p = await workerParent(runner);
        const timer = await timerPark(p.id);
        const turns = turnEnds(p.id);
        const refusal = liveRefusal(await blockedDone(p.id, () => blockingWorker(p.id), undefined, ' delay-human-ack'));
        // The open timer settles the turn end at once: the held acknowledgement defers nothing here.
        await until(() => turnEnds(p.id) > turns, () => timeline(p.id));
        release();
        await until(() => parkedOn(p.id, viaOf(p.id, WAIT_VIA.cezar_wait)) && refusalNoted(p.id, refusal) && store.getRun(p.id)?.status === RUN_STATUS.waiting);
        await expectTimerPark(p.id, timer, refusal);
      }, 'delay-human-ack');
    });

    it(`${runner} U27 accepted done retains its summary when a worker resumes before turn end and clears before human acknowledgement`, async () => {
      await lateAck(async release => {
        const { p, w } = await parentWithWorker(runner);
        manager.requestWorkerStop(w.id);
        expect(await manager.awaitRunTermination(w.id, 15_000)).toBe(true);
        await collect(w.id);
        const accept = manager.acceptDone.bind(manager);
        const accepted = vi.spyOn(manager, 'acceptDone').mockImplementation((...args) => {
          const answer = accept(...args);
          // A concurrent worker resume after tool acceptance, before the native turn ends.
          if (args[0] === p.id && answer.ok) fixtureUpdateRun(w.id, { status: RUN_STATUS.queued });
          return answer;
        });
        const before = turnEnds(p.id), summary = 'held done summary shipped';
        const text = `${toolCall('cezar_done', { summary })} delay-human-ack`;
        expect(manager.sendMessage(p.id, [{ type: 'text', text }])).toBe(true);
        const refused = () => store.readEvents(p.id).some(event => event.type === 'note' && String(event.message).startsWith('Completion blocked:'));
        await until(() => turnEnds(p.id) > before && (refused() || nudgeNotes(p.id).length === 1), () => timeline(p.id));
        expect(accepted.mock.results.some(result => result.type === 'return' && result.value.ok)).toBe(true);
        // Codex/Pi tool activity confirms the input before its held transport ACK: their
        // executable wire gap sends the nudge already, rather than retaining a DONE boundary.
        if (!refused()) {
          expect(['codex', 'pi']).toContain(runner);
          expect(nudgeNotes(p.id)).toHaveLength(1);
          release();
          expect(store.readEvents(p.id).filter(event => event.type === 'note' && event.message === summary)).toEqual([]);
          expect(manager.isActive(p.id)).toBe(true);
          return;
        }
        manager.requestWorkerStop(w.id);
        expect(await manager.awaitRunTermination(w.id, 15_000)).toBe(true);
        await collect(w.id);
        release();
        await until(() => !manager.isActive(p.id) && terminal.includes(store.getRun(p.id)?.status ?? ''), () => timeline(p.id));
        expect(store.readEvents(p.id).filter(event => event.type === 'note' && event.message === summary)).toHaveLength(1);
        expect(store.readEvents(p.id).filter(event => event.type === 'lifecycle' && event.message === 'goal achieved — session closed'))
          .toEqual([expect.objectContaining({ via: 'cezar_done' })]);
      }, 'delay-human-ack');
    });

    // One refusal nudge and no wait: the nudge's own word.
    for (const settledWorker of [false, true]) {
      const row = settledWorker ? 'U20u' : 'U20';
      const blocker = (id: string) => () => blockingWorker(id, { uncollected: settledWorker });
      const refusalFor = (w: { id: string }) => settledWorker ? uncollectedRefusal(w) : liveRefusal(w);
      const expectOneNudge = (id: string, refusal: string) => {
        const [nudge, ...more] = prompted(runner, refusal);
        expect(more).toEqual([]);
        if (settledWorker) expect(nudge).not.toContain(COMPLETION_WILL_WAIT);
        else expect(nudge).toContain(COMPLETION_WILL_WAIT);
        expect(nudgeNotes(id)).toHaveLength(1);
        expect(workerWaits(id)).toEqual([]);
        expect(store.getRun(id)?.status).toBe(RUN_STATUS.waiting);
      };

      it(`${runner} U27 ${row} a fresh step's refused done gets one refusal nudge`, async () => {
        const p = await workerParent(runner);
        const turns = turnEnds(p.id);
        const refusal = refusalFor(await blockedDone(p.id, blocker(p.id)));
        await until(() => turnEnds(p.id) > turns + 1 && store.getRun(p.id)?.status === 'waiting');
        expectOneNudge(p.id, refusal);
      });

      // hearsay-tools/cezarion#2022: a human POST can finish its SSE turn before its HTTP
      // acknowledgement. U27's named wire exemptions also apply to this ordering. A worker message
      // cannot open this turn: its live sender would make the tool refuse the done.
      it(`${runner} U27 ${row} a human acknowledgement after its turn end still gets one refusal nudge`, async () => {
        await lateAck(async release => {
          const p = await workerParent(runner);
          const before = turnEnds(p.id);
          const refusal = refusalFor(await blockedDone(p.id, blocker(p.id), undefined, ' delay-human-ack'));
          await until(() => turnEnds(p.id) > before, () => timeline(p.id));
          release();
          await until(() => turnEnds(p.id) > before + 1 && store.getRun(p.id)?.status === 'waiting', () => timeline(p.id));
          expectOneNudge(p.id, refusal);
        }, 'delay-human-ack');
      });

      it(`${runner} U27 ${row} a Continue's refused done gets one refusal nudge`, async () => {
        const p = await workerParent(runner);
        await idleClose(p.id);
        const turns = turnEnds(p.id);
        const refusal = refusalFor(await blockedDone(p.id, blocker(p.id), continued(p.id)));
        await until(() => turnEnds(p.id) > turns + 1 && store.getRun(p.id)?.status === 'waiting' &&
          store.getRun(p.id)?.steps.some(step => step.id === 'continue-1') === true);
        expectOneNudge(p.id, refusal);
      });
    }
  }
}
