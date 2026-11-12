import { waitPartDescribers, sessionOf, runnerBoundary, prompted, nativeWire, ASK_CONTEXT, questions, pendingQuestion, humanOpen, answerOf, settled, answered, inputsFor } from './waits-parity-fixture.testkit.ts';
import { MAX_AUTO_CONTINUES } from './run.ts';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { expect, it as registerTest, vi } from 'vitest';
import { WAIT_PHASE, RUN_STATUS, WAIT_KIND } from '@open-mercato/cezar-contract/test-factories.testkit';
import type { RunRecord } from '@open-mercato/cezar-contract';
import type { RunnerId, AgentSession } from '../core/agent-runner.ts';
import { until, manager, store, root, terminal, toolGenerationOf } from './worker-wait-core.testkit.ts';
import { QUICK_TASK_WORKFLOW } from './types.ts';
import { blockRunWrites } from '../runs/run-store.testkit.ts';
import { recordCommits } from '../runs/outcome-crash.testkit.ts';
import { ciNativeSteers, toolCall } from './waits-parity.testkit.ts';

// The answers part of the wait parity cells (`WAIT_PARITY_PARTS` in `waits-parity-catalog.testkit.ts`).
// A wait parity file imports this module first, so it loads no other part's cells (hearsay-tools/cezarion#3242).
export const { describeWaitParity } = waitPartDescribers('answers', answersCells);

/** A scheduler continuation keeps the question open while its next session starts. Buffer
 * the answer at the runner boundary, then let normal session setup flush it synchronously. */
async function deferredAnswerAtStartup(id: string, text: string, spent: number, beforeFlush: () => void) {
  sessionOf(id).end();
  await until(() => !manager.isActive(id));
  let message!: NonNullable<RunRecord['queuedMessages']>[number];
  let opened!: () => void;
  const flushed = new Promise<void>(resolve => { opened = resolve; });
  runnerBoundary.beforeReturn = runId => {
    if (runId !== id) return;
    runnerBoundary.beforeReturn = undefined;
    expect(manager.deferMessage(id, [{ type: 'text', text }])).toBe(true);
    message = structuredClone(store.getRun(id)!.queuedMessages!.at(-1)!);
    store.updateRun(id, { automaticWakes: spent, waitDeliveryFailures: 2 });
    beforeFlush();
    // Session setup flushes before this promise's continuation gets the next microtask.
    opened();
  };
  expect(manager.continueRun(id, { text: 'Resume to receive the deferred answer.', waitWake: true }, true).ok).toBe(true);
  await flushed;
  return message;
}

export function answersCells(runners: RunnerId[], it: typeof registerTest = registerTest): void {
  for (const runner of runners) {
    const receivedAnswer = (text: string) => [...prompted(runner, text),
      ...ciNativeSteers(runner, root).filter(prompt => prompt.includes(text))];
    it(`${runner} U7q a deferred message that answers the question removes its queue entry in the answer's commit`, async () => {
      nativeWire(runner);
      const run = manager.startRun(QUICK_TASK_WORKFLOW, { task: 'mock:hold', runner });
      await until(() => store.getRun(run.id)?.status === 'waiting');
      expect(manager.sendMessage(run.id, [{ type: 'text', text: toolCall('cezar_ask', { context: ASK_CONTEXT, questions }) }])).toBe(true);
      await until(() => pendingQuestion(run.id) && humanOpen(run.id)[0]?.askSeq !== undefined && store.getRun(run.id)?.status === 'waiting');
      const [wait] = humanOpen(run.id);
      let commits!: ReturnType<typeof recordCommits>;
      const message = await deferredAnswerAtStartup(run.id, answerOf(run.id), MAX_AUTO_CONTINUES, () => {
        commits = recordCommits(join(root, '.ai/cezar'));
      });
      commits.stop();
      commits.expectEveryCommit(run.id, row => !row.lastWaits?.some(entry => entry.id === wait!.id && entry.phase === 'delivered') ||
        (row.automaticWakes === 0 && row.waitDeliveryFailures === undefined), 'a deferred answer and its reset wake budget');
      expect(commits.rows(run.id).some(row => row?.lastWaits?.some(entry => entry.id === wait!.id && entry.phase === 'delivered'))).toBe(true);
      await until(() => settled(run.id, wait!.id)?.phase === 'delivered' && answered(run.id, wait!.askSeq!));
      expect(store.getRun(run.id)?.queuedMessages ?? []).toEqual([]);
      await until(() => receivedAnswer(message.text).length > 0);
      expect(receivedAnswer(message.text)).toHaveLength(1);
      commits.expectEveryCommit(run.id, row => !!row.lastWaits?.some(entry => entry.id === wait!.id && entry.phase === 'delivered') === !row.queuedMessages?.some(entry => entry.id === message.id),
        'a deferred answer and its queue entry');
      expect(manager.finish(run.id)).toBe(true);
      await until(() => terminal.includes(store.getRun(run.id)?.status ?? '') && !manager.isActive(run.id));
      // A later session must receive no second submission from the old deferred buffer.
      const replayed: Array<Parameters<AgentSession['sendMessage']>[0]> = [];
      let opened!: () => void;
      const nextSession = new Promise<void>(resolve => { opened = resolve; });
      runnerBoundary.beforeReturn = id => {
        if (id !== run.id) return;
        runnerBoundary.beforeReturn = undefined;
        const session = sessionOf(id);
        const send = session.sendMessage.bind(session);
        vi.spyOn(session, 'sendMessage').mockImplementation(content => { replayed.push(content); return send(content); });
        opened();
      };
      expect(manager.continueRun(run.id, { text: 'mock:hold' }).ok).toBe(true);
      await nextSession;
      expect(replayed).toEqual([]);
      await until(() => store.getRun(run.id)?.status === 'waiting');
      expect(receivedAnswer(message.text)).toHaveLength(1);
      expect(manager.finish(run.id)).toBe(true);
      await until(() => terminal.includes(store.getRun(run.id)?.status ?? ''));
    });

    for (const spent of [0, MAX_AUTO_CONTINUES]) for (const deferred of [false, true]) it(`${runner} U7q a refused ${deferred ? 'deferred' : 'live'} answer checkpoint clears failures at budget ${spent} and keeps its replay policy`, async () => {
      nativeWire(runner);
      const run = manager.startRun(QUICK_TASK_WORKFLOW, { task: 'mock:hold', runner });
      await until(() => store.getRun(run.id)?.status === 'waiting');
      expect(manager.sendMessage(run.id, [{ type: 'text', text: toolCall('cezar_ask', { context: ASK_CONTEXT, questions }) }])).toBe(true);
      await until(() => pendingQuestion(run.id) && humanOpen(run.id)[0]?.askSeq !== undefined && store.getRun(run.id)?.status === 'waiting');
      const [human] = humanOpen(run.id);
      store.updateRun(run.id, { automaticWakes: spent, waitDeliveryFailures: 2 });
      let message: { id: string; text: string; createdAt: string } = { id: randomUUID(), text: answerOf(run.id), createdAt: new Date().toISOString() };
      const commit = store.commitOutcome.bind(store);
      let refused = false;
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.spyOn(store, 'commitOutcome').mockImplementation((id, outcomes, deps, options) => {
        const batch = Array.isArray(outcomes) ? outcomes : [outcomes];
        if (id === run.id && !refused && batch.some(outcome => outcome.kind === 'answered')) {
          refused = true;
          throw Error('injected answer checkpoint failure');
        }
        return commit(id, outcomes, deps, options);
      });
      let commits!: ReturnType<typeof recordCommits>;
      if (deferred) message = await deferredAnswerAtStartup(run.id, message.text, spent, () => {
        commits = recordCommits(join(root, '.ai/cezar'));
      });
      else {
        commits = recordCommits(join(root, '.ai/cezar'));
        expect(manager.sendMessage(run.id, [{ type: 'text', text: message.text }])).toBe(true);
      }
      commits.stop();
      expect(refused).toBe(true);
      const retained = deferred && spent === 0;
      expect(settled(run.id, human!.id)?.phase).toBe(retained ? undefined : WAIT_PHASE.delivered);
      expect(store.getRun(run.id)?.queuedMessages?.some(entry => entry.id === message.id) ?? false).toBe(retained);
      if (retained) expect(humanOpen(run.id).some(wait => wait.id === human!.id)).toBe(true);
      expect(store.getRun(run.id)?.waitDeliveryFailures).toBeUndefined();
      commits.expectEveryCommit(run.id, row => !row.lastWaits?.some(wait => wait.id === human!.id && wait.phase === 'delivered') ||
        (row.automaticWakes === 0 && row.waitDeliveryFailures === undefined), 'a retried answer and its failure clear');
      if (retained) manager.cancel(run.id);
      else {
        expect(sessionOf(run.id).open).toBe(true);
        await until(() => answered(run.id, human!.askSeq!));
        expect(store.getRun(run.id)?.error).toBeUndefined();
        await until(() => receivedAnswer(message.text).length > 0);
        expect(receivedAnswer(message.text)).toHaveLength(1);
        expect(manager.finish(run.id)).toBe(true);
      }
      await until(() => terminal.includes(store.getRun(run.id)?.status ?? ''));
    });

    for (const spent of [0, MAX_AUTO_CONTINUES]) it(`${runner} U7q a persistently refused deferred answer at budget ${spent} keeps its replay ID and open question`, async () => {
      nativeWire(runner);
      const run = manager.startRun(QUICK_TASK_WORKFLOW, { task: 'mock:hold', runner });
      await until(() => store.getRun(run.id)?.status === 'waiting');
      expect(manager.sendMessage(run.id, [{ type: 'text', text: toolCall('cezar_ask', { context: ASK_CONTEXT, questions }) }])).toBe(true);
      await until(() => pendingQuestion(run.id) && humanOpen(run.id)[0]?.askSeq !== undefined && store.getRun(run.id)?.status === RUN_STATUS.waiting);
      const [human] = humanOpen(run.id);
      const answer = answerOf(run.id);
      const commit = store.commitOutcome.bind(store);
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.spyOn(store, 'commitOutcome').mockImplementation((id, outcomes, deps, options) => {
        if (!(Array.isArray(outcomes) ? outcomes : [outcomes]).some(outcome => outcome.kind === 'answered')) return commit(id, outcomes, deps, options);
        const unblock = blockRunWrites(join(root, '.ai/cezar'));
        try { return commit(id, outcomes, deps, options); } finally { unblock(); }
      });
      let commits!: ReturnType<typeof recordCommits>;
      const message = await deferredAnswerAtStartup(run.id, answer, spent, () => {
        commits = recordCommits(join(root, '.ai/cezar'));
      });
      commits.stop();
      expect(store.getRun(run.id)?.queuedMessages?.some(entry => entry.id === message.id)).toBe(true);
      expect(humanOpen(run.id).some(wait => wait.id === human!.id)).toBe(true);
      expect(store.getRun(run.id)?.automaticWakes).toBe(0);
      expect(store.getRun(run.id)?.waitDeliveryFailures).toBeUndefined();
      commits.expectEveryCommit(run.id, row => !row.lastWaits?.some(wait => wait.id === human!.id) &&
        !!row.queuedMessages?.some(entry => entry.id === message.id), 'a persistently refused answer keeps its replay dependency');
      manager.cancel(run.id);
      await until(() => terminal.includes(store.getRun(run.id)?.status ?? ''));
    });

    // hearsay-tools/cezarion#1906: the answer resets its accounting atomically, but its immediate
    // flush must still cancel an owed timer at the old cap. This guard passes on the old order too.
    it(`${runner} U7q a live answer at the cap resets counters atomically while an unadmitted timer stays owed`, async () => {
      nativeWire(runner);
      const run = manager.startRun(QUICK_TASK_WORKFLOW, { task: toolCall('cezar_ask', { context: ASK_CONTEXT, questions }), runner });
      await until(() => pendingQuestion(run.id) && humanOpen(run.id)[0]?.askSeq !== undefined && store.getRun(run.id)?.status === 'waiting');
      const [human] = humanOpen(run.id);
      const tools = manager.squawkToolHandlers(run.id, toolGenerationOf(run.id));
      const registered = await tools.registerWait({ kind: WAIT_KIND.timer, seconds: 60, note: 'answer cap guard' }, 'cezar_wait', new AbortController().signal);
      if (!('wait' in registered) || registered.wait.kind !== 'timer') throw Error('registration refused');
      // A result already resolved below the cap may still be owed when the budget reaches it.
      // Hold it at the parked boundary, without asking the scheduler to send it before the answer.
      const timer = { ...registered.wait, phase: WAIT_PHASE.resolved, resolvedAt: new Date().toISOString() };
      store.commitWait(run.id, timer, { id: timer.id, parentRunId: run.id, source: 'lifecycle', createdAt: timer.resolvedAt, text: 'answer cap guard' });
      store.updateRun(run.id, { automaticWakes: MAX_AUTO_CONTINUES, waitDeliveryFailures: 2 });
      const notesBefore = store.readEvents(run.id).filter(event => event.type === 'note').length;
      const commits = recordCommits(join(root, '.ai/cezar'));
      expect(manager.sendMessage(run.id, [{ type: 'text', text: answerOf(run.id) }])).toBe(true);
      commits.stop();
      // The admitted/mid-turn combinations are construction rows of cappedTimersBeforeFlush.
      // This public answer pins the atomic reset without injecting scheduler admission.
      expect(settled(run.id, timer.id)?.phase).toBeUndefined();
      expect(inputsFor(run.id, timer.id).map(input => input.deliveredAt)).toEqual([undefined]);
      expect(store.getRun(run.id)).toMatchObject({ automaticWakes: 0 });
      expect(store.getRun(run.id)?.waitDeliveryFailures).toBeUndefined();
      expect(store.readEvents(run.id).filter(event => event.type === 'note').slice(notesBefore)).toEqual([]);
      commits.expectEveryCommit(run.id, row => !row.lastWaits?.some(wait => wait.id === human!.id && wait.phase === 'delivered') ||
        (row.automaticWakes === 0 && row.waitDeliveryFailures === undefined), 'a live answer and its reset wake budget');
      await until(() => answered(run.id, human!.askSeq!));
      expect(manager.finish(run.id)).toBe(true);
      await until(() => terminal.includes(store.getRun(run.id)?.status ?? ''));
    });

  }
}
