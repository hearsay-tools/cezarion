import { waitPartDescribers, inputsFor, retryClock, nativeWire, askPrompt, pendingQuestion, asks, answered, expectAdmissionRetryCleared, settled, prompted, fireTimer, flushMicrotasks, humanOpen, answerOf, retryAtOnce, observeAdmissionRetries, timerWaits, sessionOf, agentWaits, turnEnds, parkedOn, waitOfKind, blockedDone, liveRefusal, expectPoolCapacity, github, pr } from './waits-parity-fixture.testkit.ts';
import { MAX_WAKE_DELIVERY_ATTEMPTS, WAKE_DELIVERY_CAP_NOTE, MAX_AUTO_CONTINUES, WAKE_SESSION_CLOSED_ERROR, WAITS_DISCARDED_NOTE, COMPLETION_NUDGE_NOTE } from './run.ts';
import { join } from 'node:path';
import { expect, it as registerTest } from 'vitest';
import { deriveAttention } from '@open-mercato/cezar-contract/attention';
import { WAIT_KIND, STEP_STATUS, WAIT_PHASE } from '@open-mercato/cezar-contract/test-factories.testkit';
import type { Wait } from '@open-mercato/cezar-contract';
import type { RunnerId } from '../core/agent-runner.ts';
import { HARNESS_ADAPTERS, exemptionFor } from '../core/harness-parity-core.testkit.ts';
import { store, manager, until, toolGenerationOf, semaphore, terminal, root, parent, worker, waitOf } from './worker-wait-core.testkit.ts';
import { timed } from './waits.testkit.ts';
import { QUICK_TASK_WORKFLOW } from './types.ts';
import { hasPendingAsk, muteLockedDatabaseLogs, blockRunWrites } from '../runs/run-store.testkit.ts';
import { recordCommits } from '../runs/outcome-crash.testkit.ts';
import { withHeldAck, withRejectedInput } from '../core/owned-input-delivery.testkit.ts';
import { persistentWakeFailure, TIMER_WAKE_OPENING, toolCall, gatedProviderFailure } from './waits-parity.testkit.ts';

// The delivery part of the wait parity cells (`WAIT_PARITY_PARTS` in `waits-parity-catalog.testkit.ts`).
// A wait parity file imports this module first, so it loads no other part's cells (hearsay-tools/cezarion#3242).
export const { describeWaitParity } = waitPartDescribers('delivery', deliveryCells);

const failedSteps = (id: string) => store.getRun(id)?.steps.filter(step => step.status === 'failed').length;

/** The run settled `failed` at the delivery bound and still holds the result: resolved, its input
 *  undelivered, with the cap note, the last error, and no automatic wake left. */
function expectHeldAtTheBound(id: string, waitId: string, { error = /^continue failed: /, failed = MAX_WAKE_DELIVERY_ATTEMPTS }: { error?: RegExp | string; failed?: number } = {}) {
  const run = store.getRun(id)!;
  expect(run.status).toBe('failed');
  expect(run.error).toMatch(error);
  expect(run.waits?.find(wait => wait.id === waitId)?.phase).toBe('resolved');
  expect(run.lastWaits?.find(wait => wait.id === waitId)).toBeUndefined();
  expect(inputsFor(id, waitId).map(input => input.deliveredAt)).toEqual([undefined]);
  expect(store.readEvents(id).filter(event => event.type === 'note' && event.message === WAKE_DELIVERY_CAP_NOTE)).toHaveLength(1);
  expect(failedSteps(id)).toBe(failed);
  expect(manager.isActive(id)).toBe(false);
  expect(retryClock.pending).toBe(0);
}

/** A cezar_ask question parked, then a timer whose note carries a native mock's ACK marker. */
async function timerBesideQuestion(runner: RunnerId, note: string) {
  nativeWire(runner);
  const run = manager.startRun(QUICK_TASK_WORKFLOW, { task: HARNESS_ADAPTERS[runner].scenarios.baseline!, runner });
  await until(() => store.getRun(run.id)?.status === 'waiting');
  expect(manager.sendMessage(run.id, [{ type: 'text', text: askPrompt() }])).toBe(true);
  await until(() => pendingQuestion(run.id) && asks(run.id).length === 1);
  const tools = manager.squawkToolHandlers(run.id, toolGenerationOf(run.id));
  const registered = await tools.registerWait({ kind: WAIT_KIND.timer, seconds: 60, note }, 'cezar_wait', new AbortController().signal);
  if (!('wait' in registered)) throw Error('registration refused');
  return { run, timer: registered.wait, askSeq: asks(run.id)[0]!.seq };
}

/** The question is still the one the human answers: its card stays, and the answer keeps its askSeq. */
async function answerQuestion(id: string, askSeq: number) {
  await until(() => pendingQuestion(id));
  expect(deriveAttention(store.getRun(id)!).label).toBe('needs you');
  expect(asks(id)[0]!.seq).toBe(askSeq);
  expect(manager.sendMessage(id, [{ type: 'text', text: 'Parser' }])).toBe(true);
  await until(() => answered(id, asks(id).at(-1)!.seq));
}

// A failed run cannot wake itself. Its absence shows at once, and no admission retry or backoff is left to start one later.
const expectNoWakeFor = async (runner: RunnerId, id: string) => {
  await semaphore.release();
  expect(store.getRun(id)?.status).toBe('failed');
  expect(manager.isActive(id)).toBe(false);
  expect(retryClock.pending).toBe(0);
  await expectAdmissionRetryCleared(runner, id);
};
/** Continue delivers every held result once, and the run parks and finishes as usual. */
async function continueDelivers(runner: RunnerId, id: string, timer: Wait, later: Wait) {
  expect(manager.continueRun(id, { text: 'go on' })).toEqual({ ok: true });
  // The store marks a wake delivered before the mock records the prompt it read; wait for both.
  await until(() => settled(id, timer.id)?.phase === 'delivered' && settled(id, later.id)?.phase === 'delivered'
    && prompted(runner, `Timer ${timer.id} fired`).length > 0 && prompted(runner, `Timer ${later.id} fired`).length > 0);
  expect(prompted(runner, `Timer ${timer.id} fired`)).toHaveLength(1);
  expect(prompted(runner, `Timer ${later.id} fired`)).toHaveLength(1);
  expect(inputsFor(id, timer.id)).toHaveLength(1);
  await until(() => store.getRun(id)?.status === 'waiting');
  expect(manager.finish(id)).toBe(true);
  await until(() => terminal.includes(store.getRun(id)?.status ?? ''));
}

export function deliveryCells(runners: RunnerId[], it: typeof registerTest = registerTest): void {
  for (const runner of runners) {
    it(`${runner} U12 a wait result beside a pending portable question is checkpointed only on its delayed provider acknowledgement, and the question stays answerable`, async () => {
      if (exemptionFor('U12', runner)) {
        expect(exemptionFor('U12', runner)?.kind).toBe('capability-absent');
        return;
      }
      const exercise = async (release: () => void) => {
        const { run, timer, askSeq } = await timerBesideQuestion(runner, 'mock:agent-echo delay-owned-ack');
        fireTimer(timer.id);
        await until(() => prompted(runner, `Timer ${timer.id} fired`).length > 0);
        await flushMicrotasks();
        // On the wire, acknowledgement withheld: the result is not delivered yet.
        expect(store.getRun(run.id)?.waits?.find(wait => wait.id === timer.id)?.phase).toBe('resolved');
        expect(inputsFor(run.id, timer.id).map(input => input.deliveredAt)).toEqual([undefined]);
        expect(hasPendingAsk(store, run.id)).toBe(true);
        release();
        await until(() => settled(run.id, timer.id)?.phase === 'delivered');
        // An acknowledgement after the wake turn ended still leaves the run in the question's park.
        await answerQuestion(run.id, askSeq);
      };
      // Cursor print acknowledges on its first model work, which the control holds after init.
      await withHeldAck(runner as 'codex' | 'opencode' | 'pi' | 'omp' | 'cursor', exercise);
    });

    it(`${runner} U12 a human answer resets the budget while a timer acknowledgement keeps its reserved charge`, async () => {
      if (exemptionFor('U12', runner)) {
        expect(exemptionFor('U12', runner)?.kind).toBe('capability-absent');
        return;
      }
      await withHeldAck(runner as 'codex' | 'opencode' | 'pi' | 'omp' | 'cursor', async release => {
        const { run, timer, askSeq } = await timerBesideQuestion(runner, 'mock:agent-echo delay-owned-ack');
        store.updateRun(run.id, { automaticWakes: MAX_AUTO_CONTINUES - 1 });
        fireTimer(timer.id);
        await until(() => prompted(runner, `Timer ${timer.id} fired`).length > 0);
        expect(settled(run.id, timer.id)).toBeUndefined();
        const human = humanOpen(run.id)[0]!;
        store.updateRun(run.id, { waitDeliveryFailures: 2 });
        const commits = recordCommits(join(root, '.ai/cezar'));
        expect(manager.sendMessage(run.id, [{ type: 'text', text: answerOf(run.id) }])).toBe(true);
        commits.stop();
        expect(store.getRun(run.id)?.automaticWakes).toBe(0);
        expect(store.getRun(run.id)?.waitDeliveryFailures).toBeUndefined();
        commits.expectEveryCommit(run.id, row => !row.lastWaits?.some(wait => wait.id === human.id && wait.phase === 'delivered') ||
          (row.automaticWakes === 0 && row.waitDeliveryFailures === undefined), 'an answer beside an in-flight timer and its reset wake budget');
        release();
        await until(() => settled(run.id, timer.id)?.phase === 'delivered' && answered(run.id, askSeq));
        // The timer spends one reserved unit on the restarted budget. The answer's own no-wait
        // turn may already have spent the next unit on its nudge by the time this ACK is observed.
        expect(store.readEvents(run.id).filter(event => event.type === 'note' && String(event.message).startsWith('automatic timer wake-up (')).map(event => event.message))
          .toEqual(['automatic timer wake-up (1/40)']);
        expect(manager.finish(run.id)).toBe(true);
        await until(() => terminal.includes(store.getRun(run.id)?.status ?? ''));
      });
    });

    it(`${runner} U13 a wait result beside a pending portable question whose acknowledgement is rejected stays resolved, is retried, and the question stays answerable`, async () => {
      if (exemptionFor('U13', runner)) {
        expect(exemptionFor('U13', runner)?.kind).toBe('capability-absent');
        return;
      }
      await withRejectedInput(runner as 'codex' | 'opencode' | 'pi' | 'omp', async () => {
        retryAtOnce();
        const { run, timer, askSeq } = await timerBesideQuestion(runner, `reject-owned-turn${runner === 'opencode' ? ' mock:reject-agent-post' : ''}`);
        fireTimer(timer.id);
        await until(() => settled(run.id, timer.id)?.phase === 'delivered');
        // The acknowledged delivery ends the run of failed attempts.
        expect(store.getRun(run.id)?.waitDeliveryFailures).toBeUndefined();
        // The rejection failed the session, not the run: a continuation sent the result again, and
        // only that accepted submission delivered it.
        expect(prompted(runner, `Timer ${timer.id} fired`).length).toBeGreaterThanOrEqual(2);
        expect(inputsFor(run.id, timer.id)).toHaveLength(1);
        expect(store.getRun(run.id)?.status).not.toBe('failed');
        await answerQuestion(run.id, askSeq);
      });
    });

    it(`${runner} U13 a persistently rejected wait result beside a pending portable question stops after the delivery bound, the run fails keeping the result and the question, and Continue delivers it once`, async () => {
      if (exemptionFor('U13', runner)) {
        expect(exemptionFor('U13', runner)?.kind).toBe('capability-absent');
        return;
      }
      await withRejectedInput(runner as 'codex' | 'opencode' | 'pi' | 'omp', async lift => {
        retryAtOnce();
        const { run, timer, askSeq } = await timerBesideQuestion(runner, `reject-owned-turn${runner === 'opencode' ? ' mock:reject-agent-post' : ''}`);
        fireTimer(timer.id);
        // The failure is recorded before the failing session is dropped.
        await until(() => store.getRun(run.id)?.status === 'failed' && !manager.isActive(run.id));
        // One rejected submission per attempt, each in its own session, then nothing.
        expect(prompted(runner, `Timer ${timer.id} fired`)).toHaveLength(MAX_WAKE_DELIVERY_ATTEMPTS);
        expectHeldAtTheBound(run.id, timer.id);
        expect(hasPendingAsk(store, run.id)).toBe(true);
        expect(asks(run.id).map(ask => ask.seq)).toEqual([askSeq]);
        lift();
        // The answer opens the turn that also delivers the result.
        expect(manager.continueRun(run.id, { text: 'Parser' })).toEqual({ ok: true });
        await until(() => settled(run.id, timer.id)?.phase === 'delivered' && answered(run.id, askSeq));
        expect(inputsFor(run.id, timer.id)).toHaveLength(1);
        expect(prompted(runner, `Timer ${timer.id} fired`)).toHaveLength(MAX_WAKE_DELIVERY_ATTEMPTS + 1);
      }, { persistent: true });
    });

    // A held result wakes nothing: the wake is queued synchronously inside the resolution, so its
    it(`${runner} U9c with a delivery-failure count on the record and the store refusing writes, Finish still stops the run`, async () => {
      nativeWire(runner);
      const run = manager.startRun(QUICK_TASK_WORKFLOW, { runner, task: HARNESS_ADAPTERS[runner].scenarios.baseline! });
      await until(() => store.getRun(run.id)?.status === 'waiting');
      store.updateRun(run.id, { waitDeliveryFailures: 2 });
      store.flush();
      const unmute = muteLockedDatabaseLogs();
      const unblock = blockRunWrites(join(root, '.ai/cezar'));
      try {
        expect(manager.finish(run.id)).toBe(true);
        await until(() => !manager.isActive(run.id));
      } finally { unblock(); unmute(); }
      await until(() => terminal.includes(store.getRun(run.id)?.status ?? ''));
    });

    it(`${runner} U14 a wait-wake continuation that fails persistently stops at the delivery bound, the run fails keeping its result, and Continue delivers it once`, async () => {
      observeAdmissionRetries();
      nativeWire(runner);
      const failure = persistentWakeFailure(root, runner);
      retryAtOnce();
      const run = manager.startRun(QUICK_TASK_WORKFLOW, { runner, task: HARNESS_ADAPTERS[runner].scenarios.baseline! });
      await until(() => store.getRun(run.id)?.status === 'waiting');
      const { timer, later } = await timerWaits(run.id);
      sessionOf(run.id).end();
      await until(() => !manager.isActive(run.id));
      fireTimer(timer.id);
      await until(() => store.getRun(run.id)?.status === 'failed' && !manager.isActive(run.id));
      // Each attempt is a scheduler continuation whose opening prompt the provider fails.
      expect(prompted(runner, TIMER_WAKE_OPENING)).toHaveLength(MAX_WAKE_DELIVERY_ATTEMPTS);
      expectHeldAtTheBound(run.id, timer.id);
      // A wait that resolves on the failed run stays resolved and wakes nothing.
      fireTimer(later.id);
      expect(store.getRun(run.id)?.waits?.find(wait => wait.id === later.id)?.phase).toBe('resolved');
      await expectNoWakeFor(runner, run.id);
      failure.lift();
      await continueDelivers(runner, run.id, timer, later);
    });

    it(`${runner} U14 a session that keeps closing cleanly before its wait result is delivered stops at the delivery bound, the run fails keeping its result, and Continue delivers it once`, async () => {
      observeAdmissionRetries();
      nativeWire(runner);
      retryAtOnce();
      const run = manager.startRun(QUICK_TASK_WORKFLOW, { runner, task: HARNESS_ADAPTERS[runner].scenarios.baseline! });
      await until(() => store.getRun(run.id)?.status === 'waiting');
      const { timer, later } = await timerWaits(run.id);
      // Every session closes cleanly at a turn end while the result is owed, before Cezar can
      // submit it, as U9's clean close does at a boundary. The first is the original session: the
      // timer resolves as its human turn ends. The others are the continuations that retry.
      let closing = true, resolving = true;
      const closeAtTurnEnd = ({ runId, event }: { runId: string; event: { type: string } }) => {
        if (runId !== run.id || event.type !== 'turn-end' || !closing) return;
        if (resolving) { resolving = false; fireTimer(timer.id); }
        if (store.getRun(run.id)?.waits?.find(wait => wait.id === timer.id)?.phase === 'resolved') sessionOf(run.id).end();
      };
      store.on('event', closeAtTurnEnd);
      try {
        expect(manager.sendMessage(run.id, [{ type: 'text', text: 'Check the deploy.' }])).toBe(true);
        await until(() => store.getRun(run.id)?.status === 'failed' && !manager.isActive(run.id));
        // The original session and two continuations, none of which received the result.
        expect(prompted(runner, TIMER_WAKE_OPENING)).toHaveLength(MAX_WAKE_DELIVERY_ATTEMPTS - 1);
        expect(prompted(runner, `Timer ${timer.id} fired`)).toEqual([]);
        expectHeldAtTheBound(run.id, timer.id, { error: `continue failed: ${WAKE_SESSION_CLOSED_ERROR}`, failed: 1 });
        expect(store.getRun(run.id)?.steps.at(-1)).toMatchObject({ status: STEP_STATUS.failed, error: WAKE_SESSION_CLOSED_ERROR });
        fireTimer(later.id);
        expect(store.getRun(run.id)?.waits?.find(wait => wait.id === later.id)?.phase).toBe('resolved');
        await expectNoWakeFor(runner, run.id);
        closing = false;
        await continueDelivers(runner, run.id, timer, later);
      } finally {
        store.off('event', closeAtTurnEnd);
      }
    });

    it(`${runner} U14 Stop on a failed run holding wait results at the delivery bound discards every wait, starts nothing, leaves the run failed, and a later Continue delivers none of them`, async () => {
      observeAdmissionRetries();
      nativeWire(runner);
      const failure = persistentWakeFailure(root, runner);
      retryAtOnce();
      const run = manager.startRun(QUICK_TASK_WORKFLOW, { runner, task: HARNESS_ADAPTERS[runner].scenarios.baseline! });
      await until(() => store.getRun(run.id)?.status === 'waiting');
      const { timer, later } = await timerWaits(run.id);
      sessionOf(run.id).end();
      await until(() => !manager.isActive(run.id));
      fireTimer(timer.id);
      await until(() => store.getRun(run.id)?.status === 'failed' && !manager.isActive(run.id));
      expectHeldAtTheBound(run.id, timer.id);
      expect(store.getRun(run.id)?.waits?.find(wait => wait.id === later.id)?.phase).toBe('open');
      // Stop before any Continue: the resolved result and the open wait both go, the run stays failed.
      expect(manager.cancel(run.id)).toBe(true);
      expect(store.getRun(run.id)?.waits ?? []).toEqual([]);
      expect(settled(run.id, timer.id)?.phase).toBe('cancelled');
      expect(settled(run.id, later.id)?.phase).toBe('cancelled');
      expect(inputsFor(run.id, timer.id)).toEqual([]);
      fireTimer(later.id);
      await flushMicrotasks();
      expect(inputsFor(run.id, later.id)).toEqual([]);
      expect(store.getRun(run.id)?.waitDeliveryFailures).toBeUndefined();
      await expectNoWakeFor(runner, run.id);
      expect(store.readEvents(run.id).filter(event => event.type === 'note' && event.message === WAITS_DISCARDED_NOTE)).toHaveLength(1);
      expect(prompted(runner, TIMER_WAKE_OPENING)).toHaveLength(MAX_WAKE_DELIVERY_ATTEMPTS);
      // Continue is a plain continuation: nothing from the discarded waits reaches the agent.
      failure.lift();
      expect(manager.continueRun(run.id, { text: 'carry on without them' })).toEqual({ ok: true });
      await until(() => store.getRun(run.id)?.status === 'waiting' && prompted(runner, 'carry on without them').length > 0);
      expect(prompted(runner, `Timer ${timer.id} fired`)).toEqual([]);
      expect(prompted(runner, `Timer ${later.id} fired`)).toEqual([]);
      expect(prompted(runner, 'carry on without them').at(-1)).not.toContain('Still open');
      expect(agentWaits(run.id)).toEqual([]);
      expect(manager.finish(run.id)).toBe(true);
      await until(() => terminal.includes(store.getRun(run.id)?.status ?? ''));
    });

    it(`${runner} U11 a timer open at a blocked done keeps its deadline, the run parks on it with the refusal as a note and no nudge, and its result is delivered`, async () => {
      nativeWire(runner);
      // Workers run on the Claude wire whatever the parent's runner is.
      process.env.CEZ_CLAUDE_BIN = HARNESS_ADAPTERS.claude.mockBin;
      const p = await parent(HARNESS_ADAPTERS[runner].scenarios.baseline!, runner);
      await until(() => store.getRun(p.id)?.status === 'waiting');
      let turns = turnEnds(p.id);
      expect(manager.sendMessage(p.id, [{ type: 'text', text: toolCall('cezar_wait', { kind: WAIT_KIND.timer, seconds: 600, note: 'u11' }) }])).toBe(true);
      await until(() => turnEnds(p.id) > turns && parkedOn(p.id, waitOfKind(p.id, WAIT_KIND.timer)));
      const timer = timed(waitOfKind(p.id, WAIT_KIND.timer)!);
      turns = turnEnds(p.id);
      // hearsay-tools/cezarion#1301: a refused done is not a done and cancels no wait. With the timer
      // open there is no nudge: the run parks on the timer, and the refusal is a note.
      const w = await blockedDone(p.id, () => worker(p.id));
      const refusal = liveRefusal(w);
      await until(() => turnEnds(p.id) > turns && parkedOn(p.id, waitOfKind(p.id, WAIT_KIND.timer)) &&
        store.readEvents(p.id).some(event => event.type === 'note' && String(event.message).includes(refusal)));
      expect(store.getRun(p.id)?.waits).toEqual([expect.objectContaining({ id: timer.id, phase: WAIT_PHASE.open, deadline: timer.deadline })]);
      expect(waitOf(store.getRun(p.id))).toBeUndefined();
      expect(store.getRun(p.id)?.delegation).not.toHaveProperty('completion');
      expect(store.readEvents(p.id).some(event => event.type === 'note' && String(event.message).startsWith(COMPLETION_NUDGE_NOTE))).toBe(false);
      expect(prompted(runner, refusal)).toEqual([]);
      // A timer park keeps its slot, and the timer's result wakes the agent.
      await expectPoolCapacity(runner, p.id, true);
      fireTimer(timer.id);
      await until(() => settled(p.id, timer.id)?.phase === 'delivered' && inputsFor(p.id, timer.id).length > 0
        && prompted(runner, inputsFor(p.id, timer.id)[0]!.text).length > 0);
      expect(inputsFor(p.id, timer.id)).toHaveLength(1);
      expect(prompted(runner, inputsFor(p.id, timer.id)[0]!.text)).toHaveLength(1);
      await until(() => store.getRun(p.id)?.status === 'waiting');
    });

    for (const kind of ['pr', 'timer'] as const) {
      it(`${runner} U9 provider failure with a ${kind} wait open leaves the run recoverable and the next wake delivers`, async () => {
        const external = github();
        const wire = gatedProviderFailure(root, runner);
        const run = manager.startRun(QUICK_TASK_WORKFLOW, { runner, task: HARNESS_ADAPTERS[runner].scenarios['provider-error-controlled']! });
        await until(wire.held);
        const tools = manager.squawkToolHandlers(run.id, toolGenerationOf(run.id));
        const request = kind === 'pr' ? { kind, pr, timeout_seconds: 30 } as const : { kind, seconds: 60, note: 'u9' } as const;
        const registered = await tools.registerWait(request, 'cezar_wait', new AbortController().signal);
        expect(registered.answer).toMatchObject({ ok: true, kind });
        if (!('wait' in registered)) throw Error('registration refused');
        const wait = registered.wait;
        wire.release();
        await until(() => store.readEvents(run.id).some(event => event.type === 'error'));
        await until(() => !manager.isActive(run.id));
        expect(store.getRun(run.id)?.waits?.find(entry => entry.id === wait.id)?.phase).toBe('open');
        expect(store.getRun(run.id)?.status).not.toBe('failed');
        if (kind === 'pr') external.settle(); else fireTimer(wait.id);
        await until(() => settled(run.id, wait.id)?.phase === 'delivered');
        expect(inputsFor(run.id, wait.id)).toHaveLength(1);
        await until(() => store.getRun(run.id)?.status === 'waiting');
        expect(manager.finish(run.id)).toBe(true);
        await until(() => store.getRun(run.id)?.status === 'done');
      });

      it(`${runner} U9 clean close with a ${kind} wait open leaves the run recoverable and the next wake delivers`, async () => {
        const external = github();
        nativeWire(runner);
        const run = manager.startRun(QUICK_TASK_WORKFLOW, { runner, task: HARNESS_ADAPTERS[runner].scenarios.baseline! });
        await until(() => store.getRun(run.id)?.status === 'waiting');
        const tools = manager.squawkToolHandlers(run.id, toolGenerationOf(run.id));
        const request = kind === 'pr' ? { kind, pr, timeout_seconds: 30 } as const : { kind, seconds: 60, note: 'u9' } as const;
        const registered = await tools.registerWait(request, 'cezar_wait', new AbortController().signal);
        if (!('wait' in registered)) throw Error('registration refused');
        const wait = registered.wait;
        sessionOf(run.id).end();
        await until(() => !manager.isActive(run.id));
        // A clean close is not a failure: the park and its wait survive it.
        expect(store.getRun(run.id)?.status).toBe('waiting');
        expect(store.getRun(run.id)?.error).toBeUndefined();
        expect(store.getRun(run.id)?.waits?.find(entry => entry.id === wait.id)?.phase).toBe('open');
        if (kind === 'pr') external.settle(); else fireTimer(wait.id);
        await until(() => settled(run.id, wait.id)?.phase === 'delivered');
        expect(inputsFor(run.id, wait.id)).toHaveLength(1);
        await until(() => store.getRun(run.id)?.status === 'waiting');
      });
    }

  }
}
