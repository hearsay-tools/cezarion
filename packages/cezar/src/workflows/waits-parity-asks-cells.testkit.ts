import { waitPartDescribers, pendingQuestion, humanOpen, asks, answerOf, settled, answered, nativeWire, questions, ASK_CONTEXT, sessionOf, turnEnds, prompted, gated, parkedOn, waitOfKind, stepStatus, viaOf } from './waits-parity-fixture.testkit.ts';
import { NO_WAIT_NUDGE_NOTE, NO_WAIT_NOTE, MAX_AUTO_CONTINUES } from './run.ts';
import { randomUUID } from 'node:crypto';
import { expect, it as registerTest } from 'vitest';
import { deriveAttention } from '@open-mercato/cezar-contract/attention';
import { WAIT_KIND, WAIT_PHASE, WAIT_SOURCE, WAIT_VIA, RUN_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { toRunSummary } from '@open-mercato/cezar-contract/runs';
import type { Wait } from '@open-mercato/cezar-contract';
import type { RunnerId } from '../core/agent-runner.ts';
import { HARNESS_ADAPTERS, exemptionFor } from '../core/harness-parity-core.testkit.ts';
import { until, store, manager, root, toolGenerationOf, terminal, semaphore } from './worker-wait-core.testkit.ts';
import { QUICK_TASK_WORKFLOW, workflowDefSchema } from './types.ts';
import { pendingAskOf } from '@open-mercato/cezar-contract/pending-ask';
import { NO_WAIT_NUDGE, AUTONOMOUS_NUDGE } from './turn-end.ts';
import { messagesPrompt } from './monitoring-turn.testkit.ts';
import { hasPendingAsk } from '../runs/run-store.testkit.ts';
import { PROSE_HUMAN_GATE } from '../runs/transcript-facts.ts';
import { toolCall, thenSay, gatedProviderFailure } from './waits-parity.testkit.ts';

// The asks part of the wait parity cells (`WAIT_PARITY_PARTS` in `waits-parity-catalog.testkit.ts`).
// A wait parity file imports this module first, so it loads no other part's cells (hearsay-tools/cezarion#3242).
export const { describeWaitParity, describeWaitParityFamily } = waitPartDescribers('asks', asksCells);

/** The run waits on exactly one human wait, surfaced as its one card, and reads Needs you; the
 *  answer moves the wait to `lastWaits` as delivered, with the card's askSeq. */
async function expectHumanWaitAnswered(id: string, via: Wait['via']) {
  await until(() => pendingQuestion(id) && humanOpen(id)[0]?.askSeq !== undefined);
  const [wait, ...more] = humanOpen(id);
  expect(more).toEqual([]);
  expect(wait).toMatchObject({ kind: WAIT_KIND.human, via, phase: WAIT_PHASE.open });
  expect(asks(id)).toHaveLength(1);
  expect(wait!.askSeq).toBe(asks(id)[0]!.seq);
  expect(toRunSummary(store.getRun(id)!).waitingOn).toEqual({ kind: WAIT_KIND.human, shown: true });
  expect(deriveAttention(store.getRun(id)!).label).toBe('needs you');
  expect(manager.sendMessage(id, [{ type: 'text', text: answerOf(id) }])).toBe(true);
  await until(() => settled(id, wait!.id)?.phase === 'delivered' && answered(id, wait!.askSeq!));
  expect(humanOpen(id)).toEqual([]);
  return wait!;
}

export function asksCells(runners: RunnerId[], it: typeof registerTest = registerTest): void {
  for (const runner of runners) {
    it(`${runner} U7h cezar_ask, an open question included, opens a human wait in the same wait list`, async () => {
      nativeWire(runner);
      // The open question has no options: the card crosses this runner's wire without them.
      const card = [...questions, { header: 'Name', question: 'What should the command be called?' }];
      const run = manager.startRun(QUICK_TASK_WORKFLOW, { task: toolCall('cezar_ask', { context: ASK_CONTEXT, questions: card }), runner });
      const wait = await expectHumanWaitAnswered(run.id, 'cezar_ask');
      expect(wait).toMatchObject({ source: WAIT_SOURCE.agent, questions: card });
      expect(wait.questions?.[1]).not.toHaveProperty('options');
    });

    // hearsay-tools/cezarion#1458: on Claude, prose between tool calls can reach Cezar only as a
    // summary, so the content rides in the call. Every runner's wire must deliver it whole.
    it(`${runner} U7k cezar_ask delivers its context to the human wait and the card`, async () => {
      nativeWire(runner);
      const run = manager.startRun(QUICK_TASK_WORKFLOW, { task: toolCall('cezar_ask', { context: ASK_CONTEXT, questions }), runner });
      const wait = await expectHumanWaitAnswered(run.id, 'cezar_ask');
      expect(wait).toMatchObject({ context: ASK_CONTEXT, questions });
      expect(asks(run.id).at(-1)).toMatchObject({ context: ASK_CONTEXT, questions });
    });

    // hearsay-tools/cezarion#2442: a question asked earlier in the same turn is pending, so the
    // done is refused and the task waits for the answer.
    it(`${runner} U7a cezar_done after cezar_ask in the same turn is refused and the question stays pending`, async () => {
      nativeWire(runner);
      const task = `${toolCall('cezar_ask', { context: ASK_CONTEXT, questions })} ${toolCall('cezar_done', {})} ${thenSay('u7a asked, then tried to finish')}`;
      const run = manager.startRun(QUICK_TASK_WORKFLOW, { task, runner });
      await until(() => pendingQuestion(run.id) && humanOpen(run.id)[0]?.askSeq !== undefined);
      expect(humanOpen(run.id)).toMatchObject([{ via: WAIT_VIA.cezar_ask, questions }]);
      expect(asks(run.id)).toHaveLength(1);
      expect(store.readEvents(run.id).some(event => event.type === 'lifecycle' && event.message === 'goal achieved — session closed')).toBe(false);
      expect(JSON.stringify(store.readEvents(run.id))).toContain('human_question_pending');
      expect(deriveAttention(store.getRun(run.id)!).label).toBe('needs you');
    });

    it(`${runner} U7h a native ask opens a human wait in the same wait list`, async () => {
      nativeWire(runner);
      const run = manager.startRun(QUICK_TASK_WORKFLOW, { task: HARNESS_ADAPTERS[runner].scenarios.ask!, runner });
      if (exemptionFor('U7h', runner)) {
        // capability-absent: this wire has no native ask; its ask scenario calls cezar_ask.
        expect(exemptionFor('U7h', runner)?.kind).toBe('capability-absent');
        await expectHumanWaitAnswered(run.id, WAIT_VIA.cezar_ask);
        return;
      }
      await expectHumanWaitAnswered(run.id, 'native-ask');
    });

    // The Continue's answer settles the question it answers, never one its own turn asks.
    it(`${runner} U7h a Continue that answers one question and asks the next keeps the next one open`, async () => {
      nativeWire(runner);
      const run = manager.startRun(QUICK_TASK_WORKFLOW, { task: toolCall('cezar_ask', { context: ASK_CONTEXT, questions }), runner });
      await until(() => pendingQuestion(run.id) && humanOpen(run.id)[0]?.askSeq !== undefined);
      const [first] = humanOpen(run.id);
      sessionOf(run.id).end();
      await until(() => !manager.isActive(run.id));
      const next = [{ header: 'Runner', question: 'Which runner next?', options: [{ label: 'Codex' }, { label: 'Pi' }] }];
      expect(manager.continueRun(run.id, { text: toolCall('cezar_ask', { context: ASK_CONTEXT, questions: next }) }).ok).toBe(true);
      await until(() => settled(run.id, first!.id)?.phase === 'delivered' && turnEnds(run.id) > 1 && store.getRun(run.id)?.status === 'waiting');
      const [second, ...more] = humanOpen(run.id);
      expect(more).toEqual([]);
      expect(second).toMatchObject({ phase: WAIT_PHASE.open, questions: next });
      expect(second!.id).not.toBe(first!.id);
      expect(asks(run.id)).toHaveLength(2);
      expect(second!.askSeq).toBe(asks(run.id)[1]!.seq);
      expect(deriveAttention(store.getRun(run.id)!).label).toBe('needs you');
    });

    it(`${runner} U9h provider failure with a human wait open leaves the run recoverable`, async () => {
      const wire = gatedProviderFailure(root, runner);
      const run = manager.startRun(QUICK_TASK_WORKFLOW, { runner, task: HARNESS_ADAPTERS[runner].scenarios['provider-error-controlled']! });
      await until(wire.held);
      const tools = manager.squawkToolHandlers(run.id, toolGenerationOf(run.id));
      const registered = await tools.ask({ context: ASK_CONTEXT, questions }, new AbortController().signal);
      if (!registered.ok) throw Error('registration refused');
      // Registered mid-turn, so nothing is shown before the turn ends.
      expect(asks(run.id)).toEqual([]);
      wire.release();
      await until(() => store.readEvents(run.id).some(event => event.type === 'error'));
      await until(() => !manager.isActive(run.id) && pendingQuestion(run.id));
      expect(asks(run.id)).toHaveLength(1);
      expect(humanOpen(run.id)).toMatchObject([{ id: registered.wait_id, askSeq: asks(run.id)[0]!.seq }]);
      expect(deriveAttention(store.getRun(run.id)!).label).toBe('needs you');
      expect(manager.continueRun(run.id, { text: answerOf(run.id) }).ok).toBe(true);
      await until(() => settled(run.id, registered.wait_id)?.phase === 'delivered' && answered(run.id, asks(run.id)[0]!.seq));
    });

    it(`${runner} U9h clean close with a human wait open leaves the run recoverable`, async () => {
      nativeWire(runner);
      const run = manager.startRun(QUICK_TASK_WORKFLOW, { runner, task: HARNESS_ADAPTERS[runner].scenarios.baseline! });
      await until(() => store.getRun(run.id)?.status === 'waiting');
      const tools = manager.squawkToolHandlers(run.id, toolGenerationOf(run.id));
      const registered = await tools.ask({ context: ASK_CONTEXT, questions }, new AbortController().signal);
      if (!registered.ok) throw Error('registration refused');
      // Registered at a boundary: the card is shown at once.
      await until(() => pendingQuestion(run.id) && asks(run.id).length === 1);
      sessionOf(run.id).end();
      await until(() => !manager.isActive(run.id));
      expect(store.getRun(run.id)).toMatchObject({ status: RUN_STATUS.waiting });
      expect(hasPendingAsk(store, run.id)).toBe(true);
      expect(store.getRun(run.id)?.error).toBeUndefined();
      expect(humanOpen(run.id)).toMatchObject([{ id: registered.wait_id, askSeq: asks(run.id)[0]!.seq }]);
      expect(deriveAttention(store.getRun(run.id)!).label).toBe('needs you');
      expect(manager.continueRun(run.id, { text: answerOf(run.id) }).ok).toBe(true);
      await until(() => settled(run.id, registered.wait_id)?.phase === 'delivered' && answered(run.id, asks(run.id)[0]!.seq));
    });

    it(`${runner} U5a a nudge the agent answers with cezar_ask parks on that question after one extra turn`, async () => {
      nativeWire(runner);
      delete process.env.CEZ_MOCK_NUDGE_REPLY;
      const run = manager.startRun(QUICK_TASK_WORKFLOW, { runner, task: HARNESS_ADAPTERS[runner].scenarios.baseline! });
      await until(() => pendingQuestion(run.id) && humanOpen(run.id)[0]?.askSeq !== undefined);
      expect(prompted(runner, NO_WAIT_NUDGE)).toHaveLength(1);
      expect(turnEnds(run.id)).toBe(2);
      expect(store.readEvents(run.id).filter(event => event.type === 'note' && String(event.message).startsWith(NO_WAIT_NUDGE_NOTE))).toHaveLength(1);
      const wait = await expectHumanWaitAnswered(run.id, 'cezar_ask');
      expect(wait).toMatchObject({ source: WAIT_SOURCE.agent, questions: [expect.objectContaining({ header: 'Next step' })] });
      expect(manager.finish(run.id)).toBe(true);
      await until(() => terminal.includes(store.getRun(run.id)?.status ?? ''));
    });

    // Finish answers Cezar's own human wait; it keeps the agent's question (the #151 guard).
    it(`${runner} U5c a root parked on its no-wait human wait is finished by the user, and an agent question still blocks a root with workers`, async () => {
      nativeWire(runner);
      // Only a root with workers keeps its question through Finish (hearsay-tools/cezarion#2784).
      const asRoot = (task: string, withWorker = false) => {
        const run = manager.startRun(QUICK_TASK_WORKFLOW, { runner, task });
        const receipts = withWorker ? [{ requestId: randomUUID(), workerId: randomUUID(), requestHash: 'b'.repeat(64) }] : [];
        store.commitDelegation([{ id: run.id, delegation: { role: 'root', permissions: ['spawn', 'wait'], receipts } }]);
        return run;
      };
      const plain = asRoot(HARNESS_ADAPTERS[runner].scenarios.baseline!);
      await until(() => gated(plain.id));
      expect(humanOpen(plain.id)).toMatchObject([{ via: WAIT_VIA['no-wait'], source: WAIT_SOURCE.cezar }]);
      expect(manager.finishBlockedReason(plain.id)).toBeUndefined();
      expect(manager.finish(plain.id)).toBe(true);
      await until(() => store.getRun(plain.id)?.status === 'done' && !manager.isActive(plain.id));
      delete process.env.CEZ_MOCK_NUDGE_REPLY;
      const asked = asRoot(HARNESS_ADAPTERS[runner].scenarios.baseline!, true);
      await until(() => pendingQuestion(asked.id));
      expect(humanOpen(asked.id)).toMatchObject([{ via: WAIT_VIA.cezar_ask, source: WAIT_SOURCE.agent }]);
      expect(manager.finishBlockedReason(asked.id)).toBe('Answer the pending human question before finishing.');
      expect(manager.finish(asked.id)).toBe(false);
      expect(manager.cancel(asked.id)).toBe(true);
      await until(() => !manager.isActive(asked.id));
    });

    // Cezar's own wait is no question (hearsay-tools/cezarion#1234): it raises no human gate, so the
    // run takes what a plain park took before it, and a wait the agent registers replaces it.
    it(`${runner} U5d the no-wait human wait raises no question, and the agent's own wait replaces it`, async () => {
      nativeWire(runner);
      const run = manager.startRun(QUICK_TASK_WORKFLOW, { runner, task: HARNESS_ADAPTERS[runner].scenarios.baseline! });
      await until(() => gated(run.id));
      const noWait = humanOpen(run.id)[0]!;
      expect(noWait).toMatchObject({ via: WAIT_VIA['no-wait'], source: WAIT_SOURCE.cezar });
      expect(store.readEvents(run.id).find(event => event.seq === noWait.askSeq)).toMatchObject({ type: 'note', message: NO_WAIT_NOTE });
      expect(store.transcriptFacts(run.id).pendingGateSeq).toBeUndefined();
      expect(hasPendingAsk(store, run.id)).toBeFalsy();
      expect(deriveAttention(store.getRun(run.id)!).label).toBe('needs you');
      const tools = manager.squawkToolHandlers(run.id, toolGenerationOf(run.id));
      const registered = await tools.registerWait({ kind: WAIT_KIND.timer, seconds: 60, note: 'u5d' }, 'cezar_wait', new AbortController().signal);
      if (!('wait' in registered)) throw Error('registration refused');
      expect(store.getRun(run.id)?.lastWaits?.find(wait => wait.id === noWait.id)?.phase).toBe('cancelled');
      expect(humanOpen(run.id)).toEqual([]);
      await until(() => parkedOn(run.id, waitOfKind(run.id, 'timer')));
      expect(deriveAttention(store.getRun(run.id)!).label).toBe('monitoring');
    });

    // hearsay-tools/cezarion#1260: Finish ends the task, so it closes the agent's unanswered question
    // instead of leaving an answerable card that hides the one-click Continue, with or without a session.
    it(`${runner} U18 Finish on a run parked on an agent question closes the question without answering it`, async () => {
      nativeWire(runner);
      delete process.env.CEZ_MOCK_NUDGE_REPLY;
      // With a live session, fresh or continued, Finish ends the task at the parked step and a later
      // step stays pending. Without one, Finish before the last step is refused, so that pass runs
      // the one-step task.
      const chain = workflowDefSchema.parse({ name: 'finish-chain', source: 'file', steps: [
        { id: 'implement', prompt: '{{task}}' }, { id: 'verify', command: 'true' },
      ] });
      const finishParked = async (mode: 'live' | 'continued' | 'closed') => {
        const run = manager.startRun(mode === 'closed' ? QUICK_TASK_WORKFLOW : chain, { runner, task: HARNESS_ADAPTERS[runner].scenarios.baseline! });
        await until(() => pendingQuestion(run.id) && humanOpen(run.id)[0]?.askSeq !== undefined);
        if (mode !== 'live') {
          sessionOf(run.id).end();
          await until(() => !manager.isActive(run.id));
          expect(pendingQuestion(run.id)).toBe(true);
        }
        // The Continue answers the first question and asks the next one in a live session.
        if (mode === 'continued') {
          expect(manager.continueRun(run.id, { text: toolCall('cezar_ask', { context: ASK_CONTEXT, questions }) }).ok).toBe(true);
          await until(() => asks(run.id).length === 2 && pendingQuestion(run.id) && humanOpen(run.id)[0]?.askSeq === asks(run.id)[1]!.seq);
          expect(manager.isActive(run.id)).toBe(true);
        }
        const answeredBefore = asks(run.id).slice(0, -1).map(ask => ask.seq);
        const askSeq = store.transcriptFacts(run.id).pendingAsk!.seq;
        expect(manager.finish(run.id)).toBe(true);
        await until(() => terminal.includes(store.getRun(run.id)?.status ?? '') && !manager.isActive(run.id));
        // Finish is a successful end that frees the run's slot.
        expect(store.getRun(run.id)?.status).toBe('done');
        expect(semaphore.busy()).toBe(0);
        const events = store.readEvents(run.id);
        expect(events.filter(event => event.type === 'human-ask-closed')).toEqual([expect.objectContaining({ askSeq, reason: 'finish' })]);
        expect(events.filter(event => event.type === 'human-input-delivered').map(event => event.askSeq)).toEqual(answeredBefore);
        expect(pendingAskOf(events)).toBeUndefined();
        expect(store.transcriptFacts(run.id).pendingGateSeq).toBeUndefined();
        expect(hasPendingAsk(store, run.id)).toBeFalsy();
        if (mode !== 'closed') {
          expect(stepStatus(run.id, 'verify')).toBe('pending');
          expect(events.filter(event => event.type === 'check-output')).toEqual([]);
        }
      };
      await finishParked('live');
      await finishParked('continued');
      await finishParked('closed');
    });

    // No prose classification (hearsay-tools/cezarion#1234): a question the agent only wrote gets
    // the nudge, like any turn end with no wait.
    it(`${runner} U17 a question in prose without a wait no longer parks the run by itself`, async () => {
      nativeWire(runner);
      const run = manager.startRun(QUICK_TASK_WORKFLOW, { runner, task: messagesPrompt(runner, ['Should I use Vitest?']) });
      const proseGates = () => store.readEvents(run.id).filter(event => event.type === 'note' && event.code === PROSE_HUMAN_GATE);
      await until(() => gated(run.id) || proseGates().length > 0);
      expect(proseGates()).toEqual([]);
      expect(prompted(runner, NO_WAIT_NUDGE)).toHaveLength(1);
      expect(humanOpen(run.id)).toMatchObject([{ via: WAIT_VIA['no-wait'], source: WAIT_SOURCE.cezar }]);
      // Beside a timer it raises no gate either: the run parks on the agent's timer.
      expect(manager.sendMessage(run.id, [{ type: 'text', text: `${toolCall('cezar_wait', { kind: WAIT_KIND.timer, seconds: 60, note: 'u17' })} ${thenSay('Should I use Vitest?')}` }])).toBe(true);
      await until(() => parkedOn(run.id, viaOf(run.id, WAIT_VIA.cezar_wait)) || proseGates().length > 0);
      expect(proseGates()).toEqual([]);
      expect(humanOpen(run.id)).toEqual([]);
      expect(deriveAttention(store.getRun(run.id)!).label).toBe('monitoring');
      expect(manager.finish(run.id)).toBe(true);
      await until(() => terminal.includes(store.getRun(run.id)?.status ?? ''));
    });

    it(`${runner} U15 an autonomous run is nudged with the autonomous wording until the budget, then opens a budget human wait`, async () => {
      nativeWire(runner);
      const run = manager.startRun(QUICK_TASK_WORKFLOW, { runner, task: HARNESS_ADAPTERS[runner].scenarios['autonomous-cap']!, autonomous: true });
      store.updateRun(run.id, { automaticWakes: MAX_AUTO_CONTINUES - 2 });
      await until(() => gated(run.id));
      expect(prompted(runner, AUTONOMOUS_NUDGE)).toHaveLength(2);
      expect(prompted(runner, NO_WAIT_NUDGE)).toEqual([]);
      expect(humanOpen(run.id)).toMatchObject([{ kind: WAIT_KIND.human, via: WAIT_VIA.budget, source: WAIT_SOURCE.cezar, phase: WAIT_PHASE.open }]);
      expect(store.getRun(run.id)?.automaticWakes).toBe(MAX_AUTO_CONTINUES);
      expect(deriveAttention(store.getRun(run.id)!).label).toBe('needs you');
      expect(manager.finish(run.id)).toBe(true);
      await until(() => terminal.includes(store.getRun(run.id)?.status ?? ''));
    });
  }
}
