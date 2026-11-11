import { nativeWire, waitOfKind, delivered, agentWaits, settled, listed, inputsFor, runnerBoundary, sessionOf, idleClock, retryClock, fireTimer, flushMicrotasks, turnEnds, viaOf, parkedOn, prompted, answered, pendingQuestion, questions, ASK_CONTEXT, humanOpen, gated, answerOf, workerWaits, workerWake, parkNotices, parentOn, parentWithWorker, workerParent, blockedDone, blockingWorker, liveRefusal, uncollectedRefusal, repliesDoneAgain, replyBlockedAgain, ignoreRefusal, nudgeNotes, noReplyNotes, silenceRefusals, messenger, expectPoolCapacity, describeWaitCells, waitPartDescribers, waitFoldDescriber } from './waits-parity-fixture.testkit.ts';
import { registrationGroups } from '../core/registration-coverage.testkit.ts';
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it as registerTest, onTestFinished, vi } from 'vitest';
import { RUN_STATUS, WAIT_KIND, WAIT_PHASE, WAIT_SOURCE, WAIT_VIA } from '@open-mercato/cezar-contract/test-factories.testkit';
import { toRunSummary } from '@open-mercato/cezar-contract/runs';
import type { AgentInput, RunRecord, Wait } from '@open-mercato/cezar-contract';
import { RUNNER_IDS, type AgentSession, type RunnerId } from '../core/agent-runner.ts';
import { exemptionFor, HARNESS_ADAPTERS } from '../core/harness-parity-core.testkit.ts';
import { familyCells } from '../core/parity-classes.testkit.ts';
import { checkpoint, collect, delegatingParent, fixtureUpdateRun, manager, restart, root, semaphore, spendWorkerBudget, store, terminal, timeline, toolGenerationOf, until, waitOf } from './worker-wait-core.testkit.ts';
import { timed } from './waits.testkit.ts';
import { QUICK_TASK_WORKFLOW } from './types.ts';
import { handoffPath } from '../handoff.ts';
import { COMPLETION_NUDGE_NOTE, COMPLETION_WILL_WAIT, MAX_AUTO_CONTINUES, NO_WAIT_NUDGE_NOTE } from './run.ts';
import { NO_WAIT_NUDGE } from './turn-end.ts';
import { blockRunWrites, readPersistedRuns } from '../runs/run-store.testkit.ts';
import { recordCommits } from '../runs/outcome-crash.testkit.ts';
import { withHeldAck } from '../core/owned-input-delivery.testkit.ts';
import { ciNativeSteers, gatedProviderFailure, thenSay, toolCall, WAIT_CRITERIA } from './waits-parity.testkit.ts';
import { registrationCells } from './waits-parity-registration-cells.testkit.ts';
import { inputCells } from './waits-parity-input-cells.testkit.ts';
import { deliveryCells } from './waits-parity-delivery-cells.testkit.ts';
import { asksCells } from './waits-parity-asks-cells.testkit.ts';
import { doneCells } from './waits-parity-done-cells.testkit.ts';
import { mixedCells } from './waits-parity-mixed-cells.testkit.ts';
import { recoveryCells } from './waits-parity-recovery-cells.testkit.ts';
import { conversationsCells } from './waits-parity-conversations-cells.testkit.ts';
import { completionRepliesCells } from './waits-parity-completion-replies-cells.testkit.ts';
import { closedCells } from './waits-parity-closed-cells.testkit.ts';
import { processCells } from './waits-parity-process-cells.testkit.ts';
import { type WaitParityPart, type WaitCells, type WaitFold, foldCells, splitPart, folded, WAIT_PARITY_FILES, WAIT_PARITY_FAMILIES, ROW_FAMILIES, type FamilyPart, familyTest, WAIT_FOLDS, foldedWaitFile, FOLDED_WAIT_RUNNERS, type WaitParityFamily, type WaitPartScope, type WaitFoldScope } from './waits-parity-catalog.testkit.ts';

// The registry of the wait parity cells. `waits-parity.test.ts` imports it: it guards the catalog and
// runs the single-runner cells. A per-runner file imports its part's module once that part has its
// own (`waits-parity-<part>-cells.testkit.ts`); until then it still imports this registry
// (hearsay-tools/cezarion#3242).
const it = registerTest;

/** Seed an accepted peer obligation without an unread input: the native turn tests the gate. */
function seedCompletionRequest(senderRunId: string, recipientRunId: string) {
  const request = { id: randomUUID(), senderRunId, recipientRunId, kind: 'request' as const, relationship: 'peer' as const,
    text: 'Please check the result', createdAt: new Date().toISOString(), deadline: new Date(Date.now() + 600_000).toISOString(), requestHash: 'a'.repeat(64), state: 'accepted' as const };
  store.commitConversation(senderRunId, { messages: [request], outcomes: [] });
  return request;
}

/** A delegating parent parked on Cezar's completion wait (`ignoreRefusal`) on worker `w`, which
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

const WAIT_PARITY_CELLS = {
  registration: registrationCells,
  input: inputCells,
  delivery: deliveryCells,
  asks: asksCells,
  done: doneCells,
  answers: answersCells,
  mixed: mixedCells,
  recovery: recoveryCells,
  conversations: conversationsCells,
  refusal: refusalCells,
  completion: completionCells,
  'completion-replies': completionRepliesCells,
  closed: closedCells,
  process: processCells,
  entries: entriesCells,
} satisfies Record<WaitParityPart, WaitCells>;

/** The titles a folded runner's group registers. */
function foldTitles(runner: RunnerId, fold: WaitFold): string[] {
  const titles: string[] = [];
  foldCells(runner, fold, WAIT_PARITY_CELLS, ((title: string) => { titles.push(title); }) as typeof registerTest);
  return titles;
}

/** Whether a runner runs any cell of a part, after the wait family's class (hearsay-tools/cezarion#2991)
 *  drops the shared rows outside the derived runner set. A part with none has no file. */
export function partRuns(runner: RunnerId, part: WaitParityPart): boolean {
  let any = false;
  WAIT_PARITY_CELLS[part]([runner], familyCells('waits', runner, (() => { any = true; }) as unknown as typeof registerTest));
  return any;
}

function expectPartLeaf(runner: RunnerId, part: WaitParityPart): void {
  if (splitPart(runner, part)) return; // Full-title family coverage is checked separately below.
  if (folded(runner)) return; // Its one file is checked below.
  if (!partRuns(runner, part)) return;
  const file = WAIT_PARITY_FILES[part](runner);
  const source = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8');
  expect(source.match(/describeWaitParity\([^;]+\)/g), file).toEqual([`describeWaitParity({ runner: '${runner}', part: '${part}' })`]);
}

function familyCalls(): Array<{ file: string; family: keyof typeof WAIT_PARITY_FAMILIES }> {
  return readdirSync(new URL('.', import.meta.url)).filter(file => file.endsWith('.test.ts')).flatMap(file =>
    registrationGroups(readFileSync(new URL(`./${file}`, import.meta.url), 'utf8'), file,
      'describeWaitParityFamily', 'WAIT_PARITY_FAMILIES', Object.keys(WAIT_PARITY_FAMILIES))
      .map(family => ({ file, family: family as keyof typeof WAIT_PARITY_FAMILIES })));
}

function expectWaitParityFamilies(): void {
  const found = familyCalls();
  const calls = found.map(call => call.family);
  expect(calls.slice().sort()).toEqual(Object.keys(WAIT_PARITY_FAMILIES).sort());
  for (const runner of RUNNER_IDS) {
    for (const part of Object.keys(ROW_FAMILIES) as FamilyPart[]) {
      if (!splitPart(runner, part)) continue;
      const expected: string[] = [], actual: string[] = [];
      const collect = (names: string[]) => ((title: string) => { names.push(title); }) as typeof registerTest;
      WAIT_PARITY_CELLS[part]([runner], collect(expected));
      for (const name of calls) {
        const scope = WAIT_PARITY_FAMILIES[name];
        if (scope.runner === runner && scope.part === part) WAIT_PARITY_CELLS[part]([runner], familyTest(scope, collect(actual)));
      }
      expect(actual.sort(), `${runner} ${part}: each full row exactly once`).toEqual(expected.sort());
    }
  }
}

/** Register a strict catalog reference, so the coverage scanner can prove every leaf call. */
export function describeWaitParityFamily(scope: WaitParityFamily): void {
  describeWaitParity(scope);
}

/** The matrix guards and the single-runner cells, from `waits-parity.test.ts`; a part's or a fold's
 *  cells, from a per-runner file that still imports this registry. */
export function describeWaitParity(scope: WaitPartScope | WaitFoldScope | 'once'): void {
  if (scope !== 'once' && scope.part === 'every-runner') return waitFoldDescriber(scope.fold, WAIT_PARITY_CELLS)(scope);
  if (scope !== 'once') return waitPartDescribers(scope.part, WAIT_PARITY_CELLS[scope.part]).describeWaitParity(scope);
  describeWaitCells(() => {
    it('runs every runner\'s cells from its own file', () => {
      const files = readdirSync(new URL('.', import.meta.url)).filter(file =>
        /^waits-.*-parity\.test\.ts$/.test(file) && readFileSync(new URL(`./${file}`, import.meta.url), 'utf8').includes('describeWaitParity('));
      const parts = Object.keys(WAIT_PARITY_FILES) as WaitParityPart[];
      expect(files.sort()).toEqual(RUNNER_IDS.flatMap(runner => {
        if (folded(runner)) return (Object.keys(WAIT_FOLDS) as WaitFold[]).filter(fold => foldTitles(runner, fold).length > 0).map(fold => foldedWaitFile(runner, fold));
        return parts.filter(part => !splitPart(runner, part) && partRuns(runner, part)).map(part => WAIT_PARITY_FILES[part](runner));
      }).sort());
      for (const runner of RUNNER_IDS) for (const [part, file] of Object.entries(WAIT_PARITY_FILES) as Array<[WaitParityPart, (runner: RunnerId) => string]>) {
        expect(existsSync(new URL(`./${file(runner)}`, import.meta.url)), file(runner)).toBe(!folded(runner) && (partRuns(runner, part) || splitPart(runner, part)));
      }
      for (const runner of FOLDED_WAIT_RUNNERS) {
        // A folded runner splits no part by WAIT_PARITY_FAMILIES, its groups register each of its
        // cells exactly once, and each group with cells runs from its own file.
        expect(parts.filter(part => splitPart(runner, part)), runner).toEqual([]);
        const all: string[] = [];
        for (const part of parts) WAIT_PARITY_CELLS[part]([runner], familyCells('waits', runner, ((title: string) => { all.push(title); }) as typeof registerTest));
        const grouped = (Object.keys(WAIT_FOLDS) as WaitFold[]).flatMap(fold => foldTitles(runner, fold));
        expect(grouped.slice().sort(), `${runner}: each cell in exactly one group`).toEqual(all.slice().sort());
        for (const fold of Object.keys(WAIT_FOLDS) as WaitFold[]) {
          if (foldTitles(runner, fold).length === 0) continue;
          const source = readFileSync(new URL(`./${foldedWaitFile(runner, fold)}`, import.meta.url), 'utf8');
          expect(source.match(/describeWaitParity\([^;]+\)/g), foldedWaitFile(runner, fold)).toEqual([`describeWaitParity({ runner: '${runner}', part: 'every-runner', fold: '${fold}' })`]);
        }
      }
    });

    it('registers every criterion and runner in exactly one part', () => {
      for (const runner of RUNNER_IDS) {
        const owners = new Map<string, string[]>();
        for (const part of Object.keys(WAIT_PARITY_CELLS) as WaitParityPart[]) {
          const criteria = new Set<string>();
          const collect = ((title: string) => { criteria.add(title.split(' ')[1]!); }) as typeof registerTest;
          WAIT_PARITY_CELLS[part]([runner], collect);
          for (const criterion of criteria) owners.set(criterion, [...(owners.get(criterion) ?? []), part]);
          expectPartLeaf(runner, part);
        }
        expect([...owners.keys()].sort()).toEqual(WAIT_CRITERIA.map(row => row.id).sort());
        for (const [criterion, parts] of owners) expect(parts, `${runner} ${criterion}`).toHaveLength(1);
      }
    });

    it('registers every criterion', () => {
      expect(WAIT_CRITERIA.map(row => row.id)).toEqual(['U1', 'U4', 'U9', 'U2', 'U3', 'U7', 'U8', 'U8l', 'U8h', 'U10', 'U11', 'U12', 'U13', 'U14', 'U16', 'U16b', 'U9c', 'U7h', 'U7k', 'U7a', 'U9h', 'U6', 'U7d', 'U7q', 'U6s', 'U5', 'U5a', 'U5c', 'U5d', 'U18', 'U17', 'U15', 'U2w', 'U2t', 'U2c', 'U3w', 'U3n', 'U3r', 'U3d', 'U7w', 'U9w', 'U14m', 'U9u', 'U9v', 'U19', 'U19p', 'U19q', 'U19w', 'U20', 'U20u', 'U20h', 'U21', 'U21r', 'U21m', 'U21t', 'U21h', 'U21a', 'U22', 'U22s', 'U22c', 'U22f', 'U22k', 'U22r', 'U22x', 'U24', 'U24r', 'U26', 'U25', 'U1p', 'U2p', 'U4p', 'U9p', 'U9pr', 'U27', 'R13', 'R18', 'R17']);
      for (const runner of RUNNER_IDS) for (const row of WAIT_CRITERIA) expect(HARNESS_ADAPTERS[runner].scenarios[row.scenario]).toBeDefined();
    });

    it('registers every split row exactly once', expectWaitParityFamilies);

    singleRunnerCells();
  });
}

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

function answersCells(runners: RunnerId[], it: typeof registerTest = registerTest): void {
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
      const tools = manager.cezarToolHandlers(run.id, toolGenerationOf(run.id));
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

function refusalCells(runners: RunnerId[], it: typeof registerTest = registerTest): void {
  for (const runner of runners) {
    for (const settledWorker of [false, true]) {
      it(`${runner} ${settledWorker ? 'U20u a done blocked by a settled, uncollected worker gets the uncollected refusal nudge without the will-wait sentence' : 'U20 a done blocked by live workers at the turn end gets one refusal nudge with the will-wait sentence and opens no wait'}`, async () => {
        const p = await workerParent(runner);
        // The human message below restarts the automatic-wake budget: the nudge spends its first unit.
        const wakes = 0;
        // The run as the nudge note is written: the note follows the submission and the charge.
        let atNudge: { status?: string; waits?: Wait[]; automaticWakes?: number | undefined; delegation?: unknown } | undefined;
        const publicationFailures: unknown[] = [];
        const append = store.appendEvent.bind(store);
        vi.spyOn(store, 'appendEvent').mockImplementation((id, event) => {
          if (id === p.id && event.type === 'note' && String(event.message).startsWith(COMPLETION_NUDGE_NOTE) && !atNudge) {
            const run = store.getRun(p.id)!;
            try {
              expect(run).toMatchObject({ status: RUN_STATUS.running, automaticWakes: wakes + 1 });
              expect(run.waits ?? []).toEqual([]);
            } catch (error) { publicationFailures.push(error); }
            atNudge = structuredClone({ status: run.status, waits: run.waits ?? [], automaticWakes: run.automaticWakes, delegation: run.delegation });
          }
          return append(id, event);
        });
        const turns = turnEnds(p.id);
        const w = await blockedDone(p.id, () => blockingWorker(p.id, { uncollected: settledWorker }));
        const refusal = settledWorker ? uncollectedRefusal(w) : liveRefusal(w);
        await until(() => turnEnds(p.id) > turns + 1 && store.getRun(p.id)?.status === RUN_STATUS.waiting);
        const [nudge, ...more] = prompted(runner, refusal);
        expect(more).toEqual([]);
        if (settledWorker) expect(nudge).not.toContain(COMPLETION_WILL_WAIT);
        else expect(nudge).toContain(COMPLETION_WILL_WAIT);
        expect(atNudge).toMatchObject({ status: RUN_STATUS.running, waits: [], automaticWakes: wakes + 1 });
        expect(publicationFailures).toEqual([]);
        expect(atNudge!.delegation).not.toHaveProperty('wait');
        expect(atNudge!.delegation).not.toHaveProperty('completion');
        expect(store.readEvents(p.id).filter(event => event.type === 'note' && String(event.message).startsWith(COMPLETION_NUDGE_NOTE)))
          .toEqual([expect.objectContaining({ message: `${COMPLETION_NUDGE_NOTE} (${wakes + 1}/${MAX_AUTO_CONTINUES}): ${settledWorker ? 'workers_uncollected' : 'workers_outstanding'}` })]);
        // The turn end writes nothing to the handoff file (hearsay-tools/cezarion#1809).
        expect(readFileSync(handoffPath(join(root, '.ai/cezar'), p.id), 'utf8')).not.toMatch(/turn complete|status=/);
        // The nudge turn's own end follows the ordinary rule; the run still finishes nothing.
        await until(() => store.getRun(p.id)?.status === 'waiting');
        expect(waitOf(store.getRun(p.id))).toBeUndefined();
        expect(workerWaits(p.id)).toEqual([]);
      });
    }

    // hearsay-tools/cezarion#1301: a human message starts a fresh cycle (U20h). A refusal nudge the
    // harness acknowledges on its native wire and never answers parks on Cezar's human wait; the next
    // message then ends on a blocked done again, and that done gets a fresh nudge rather than the
    // second step. Each turn-end handler: the opening session's and a continuation's.
    for (const path of ['opening session', 'continuation'] as const) {
      it(`${runner} U20h a human message after an unanswered refusal nudge starts a fresh cycle (${path})`, async () => {
        if (exemptionFor('U20h', runner)) {
          expect(exemptionFor('U20h', runner)?.kind).toBe('capability-absent');
          return;
        }
        const silence = silenceRefusals();
        const p = await workerParent(runner);
        if (path === 'continuation') {
          // An idle close leaves the run waiting; the human's Continue reopens it as a continuation.
          idleClock.fire(idleClock.captured - 1);
          await until(() => !manager.isActive(p.id) && store.getRun(p.id)?.status === 'waiting');
        }
        const continued = (prompt: string) => expect(manager.continueRun(p.id, { text: prompt }).ok).toBe(true);
        const w = await blockedDone(p.id, () => blockingWorker(p.id), path === 'continuation' ? continued : undefined);
        await silence(runner, liveRefusal(w));
        await until(() => noReplyNotes(p.id).length === 1 && gated(p.id));
        if (path === 'continuation') expect(store.getRun(p.id)?.steps.some(step => step.id === 'continue-1')).toBe(true);
        expect(nudgeNotes(p.id)).toHaveLength(1);
        expect(prompted(runner, liveRefusal(w))).toHaveLength(1);
        expect(workerWaits(p.id)).toEqual([]);
        expect(humanOpen(p.id)).toEqual([expect.objectContaining({ source: WAIT_SOURCE.cezar, via: WAIT_VIA['no-wait'] })]);
        // The next turn ends on a blocked done: a fresh cycle, so a second nudge and no wait. The
        // tool accepts that done only once the first worker settled and was collected.
        manager.requestWorkerStop(w.id);
        expect(await manager.awaitRunTermination(w.id, 15_000)).toBe(true);
        await collect(w.id);
        const turns = turnEnds(p.id);
        const next = await blockedDone(p.id, () => blockingWorker(p.id));
        await until(() => turnEnds(p.id) > turns && (nudgeNotes(p.id).length === 2 || workerWaits(p.id).length > 0 || humanOpen(p.id).some(wait => wait.via === 'completion')));
        expect(workerWaits(p.id)).toEqual([]);
        expect(nudgeNotes(p.id)).toHaveLength(2);
        await until(() => prompted(runner, liveRefusal(next)).length > 0);
        expect(prompted(runner, liveRefusal(next))).toHaveLength(1);
        await silence(runner, liveRefusal(next));
        await until(() => noReplyNotes(p.id).length === 2 && gated(p.id));
        expect(workerWaits(p.id)).toEqual([]);
      });
    }

    it(`${runner} R18 Finish followed by a provider error retires its intent before restart`, async () => {
      const peer = await parentOn(runner);
      const wire = gatedProviderFailure(root, runner);
      const run = manager.startRun(QUICK_TASK_WORKFLOW, { runner, task: HARNESS_ADAPTERS[runner].scenarios['provider-error-controlled']! });
      store.commitDelegation([{ id: run.id, delegation: { role: 'root', permissions: ['wait'], receipts: [] } }]);
      await until(wire.held);
      const request = seedCompletionRequest(run.id, peer.id);
      // Hold graceful shutdown until the queued native provider error wins.
      const close = vi.spyOn(sessionOf(run.id), 'end').mockImplementationOnce(() => {});
      expect(manager.finish(run.id)).toBe(true);
      close.mockRestore();
      wire.release();
      await until(() => store.getRun(run.id)?.status === RUN_STATUS.failed && !manager.isActive(run.id));
      expect(store.getRun(run.id)?.delegation).not.toHaveProperty('finishRequestedAt');
      const delegation = store.getRun(run.id)?.delegation;
      expect(delegation?.role === 'root' && delegation.conversation?.outcomes).toEqual([
        expect.objectContaining({ requestId: request.id, status: 'sender-closed' }),
      ]);
      await restart();
      expect(store.getRun(run.id)?.status).toBe(RUN_STATUS.failed);
      expect(store.getRun(run.id)?.delegation).not.toHaveProperty('finishRequestedAt');
      expect(manager.continueRun(run.id, { text: 'Try again.' })).toEqual({ ok: true });
      await until(() => store.getRun(run.id)?.status === RUN_STATUS.waiting);
    });

    it(`${runner} R13 repeated cezar_done tool refusals park on sent requests`, async () => {
      const p = await parentOn(runner); const peer = await parentOn(runner);
      const request = seedCompletionRequest(p.id, peer.id);
      const answers = vi.spyOn(manager, 'acceptDone');
      expect(manager.sendMessage(p.id, [{ type: 'text', text: `${toolCall('cezar_done', {})} ${toolCall('cezar_done', {})}` }])).toBe(true);
      await until(() => workerWaits(p.id)[0]?.phase === 'open' && store.getRun(p.id)?.status === 'waiting');
      expect(workerWaits(p.id)[0]).toMatchObject({ source: WAIT_SOURCE.cezar, via: WAIT_VIA.completion, requestIds: [request.id] });
      expect(answers.mock.results.map(result => result.value)).toEqual([
        expect.objectContaining({ ok: false, code: 'requests_outstanding', message: expect.stringContaining(request.id) }),
        expect.objectContaining({ ok: false, code: 'requests_outstanding' }),
      ]);
    });

    it(`${runner} R17 a second cezar_done tool call passes after the incoming refusal`, async () => {
      const p = await parentOn(runner); const peer = await parentOn(runner);
      const request = seedCompletionRequest(peer.id, p.id);
      const answers = vi.spyOn(manager, 'acceptDone');
      expect(manager.sendMessage(p.id, [{ type: 'text', text: `${toolCall('cezar_done', {})} ${toolCall('cezar_done', {})}` }])).toBe(true);
      await until(() => store.getRun(p.id)?.status === 'done' && !manager.isActive(p.id));
      expect(answers.mock.results.map(result => result.value)).toEqual([
        expect.objectContaining({ ok: false, code: 'requests_unanswered', message: expect.stringContaining(request.id) }),
        expect.objectContaining({ ok: true, finishes: 'at_turn_end' }),
      ]);
    });

    it(`${runner} R13 open sent requests refuse done, park without a wait deadline, and a reply wakes the root`, async () => {
      // The reply's cezar_done is refused by the tool again; a second refusal while requests are
      // outstanding is a done its turn end takes to the second step (recordRequestRefusal).
      process.env.CEZ_MOCK_COMPLETION_REPLY = `${toolCall('cezar_done', {})} ${thenSay('Still done.')}`;
      const p = await parentOn(runner);
      const peer = await parentOn(runner);
      const request = await blockedDone(p.id, () => seedCompletionRequest(p.id, peer.id));
      await until(() => prompted(runner, 'Requests are still open:').length > 0, () => timeline(p.id));
      await until(() => store.getRun(p.id)?.status === 'waiting' && workerWaits(p.id)[0]?.phase === 'open', () => timeline(p.id));
      expect(prompted(runner, 'Requests are still open:')).toHaveLength(1);
      expect(nudgeNotes(p.id)).toHaveLength(1);
      const entry = workerWaits(p.id)[0]!;
      expect(prompted(runner, request.id)).not.toHaveLength(0);
      expect(prompted(runner, 'hsq message wait --request')).not.toHaveLength(0);
      expect(prompted(runner, 'hsq message cancel-request')).not.toHaveLength(0);
      expect(entry).toMatchObject({ source: WAIT_SOURCE.cezar, via: WAIT_VIA.completion, requestIds: [request.id], phase: WAIT_PHASE.open });
      expect(entry).not.toHaveProperty('deadline');
      expect(entry).not.toHaveProperty('timeoutSeconds');
      const current = store.getRun(p.id)!.delegation;
      if (current?.role !== 'root') throw Error('missing ledger');
      store.commitConversation(p.id, { ...current.conversation!, outcomes: [{ requestId: request.id, status: 'replied', observedAt: new Date().toISOString() }] });
      manager.reconcileWorkerWaits(p.id);
      await until(() => settled(p.id, entry.id)?.phase === 'delivered');
      await until(() => store.getRun(p.id)?.status === 'waiting');
      expect(manager.sendMessage(p.id, [{ type: 'text', text: toolCall('cezar_done', {}) }])).toBe(true);
      await until(() => store.getRun(p.id)?.status === 'done');
    });

    it(`${runner} R17 incoming requests refuse once then complete and settle the requester obligation`, async () => {
      // The reply's cezar_done is accepted: an incoming request refuses a done once per cycle.
      process.env.CEZ_MOCK_COMPLETION_REPLY = `${toolCall('cezar_done', {})} ${thenSay('Finish without replying.')}`;
      const p = await parentOn(runner);
      const peer = await parentOn(runner);
      const request = await blockedDone(p.id, () => seedCompletionRequest(peer.id, p.id));
      await until(() => prompted(runner, 'Requests are unanswered:').length === 1);
      expect(prompted(runner, `${request.id} from ${peer.id}`)).toHaveLength(1);
      await until(() => store.getRun(p.id)?.status === 'done' && !manager.isActive(p.id));
      await until(() => {
        const root = store.getRun(peer.id)?.delegation;
        return root?.role === 'root' && !!root.conversation?.outcomes.some(outcome => outcome.requestId === request.id && outcome.status === 'completed-without-reply');
      });
      expect(nudgeNotes(p.id)).toHaveLength(1);
    });

    // hearsay-tools/cezarion#1301: the turn that answers the refusal nudge ends on done again.
  }
}

function completionCells(runners: RunnerId[], it: typeof registerTest = registerTest): void {
  for (const runner of runners) {
    it(`${runner} U21 an ignored refusal with live workers parks on a Cezar worker wait that settlement wakes`, async () => {
      const reply = repliesDoneAgain();
      const p = await workerParent(runner);
      const { second: w, entry } = await ignoreRefusal(runner, p.id, reply, () => workerWaits(p.id)[0]?.phase === 'open');
      // Only Cezar's completion wait is open: no implicit live-worker re-check timer beside it.
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

function entriesCells(runners: RunnerId[], it: typeof registerTest = registerTest): void {
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

// hearsay-tools/cezarion#1531: the single-runner cells run once, on the claude wire, from
// `waits-parity.test.ts`. They take no runner: a cell for every runner goes in its part's cell group
// (the semantic row families in `WAIT_PARITY_CELLS`), which the per-runner files run.
function singleRunnerCells(): void {
  // The first failure and its durable refusal remain a public native-wire case. Repeated
  // closed-session gate effects use real-manager recovery in turn-nudges-decisions.test.ts.
  it('a closed session leaves one charged refusal owed through its first delivery failure', async () => {
    const { p, w } = await parentWithWorker('claude');
    const refusal = `Workers are still live: ${w.id}.`;
    const refusals = () => store.getRun(p.id)?.agentInputs?.filter(input => input.text.includes(refusal)) ?? [];
    let closing = true;
    const closeAtTurnEnd = ({ runId, event }: { runId: string; event: { type: string } }) => {
      if (runId === p.id && event.type === 'turn-end' && closing && refusals().some(input => !input.deliveredAt)) sessionOf(p.id).end();
    };
    store.on('event', closeAtTurnEnd);
    try {
      const wakes = store.getRun(p.id)?.automaticWakes ?? 0;
      sessionOf(p.id).end();
      await until(() => store.getRun(p.id)?.waitDeliveryFailures === 1 && !manager.isActive(p.id) && retryClock.pending > 0);
      closing = false;
      expect(refusals()).toHaveLength(1);
      expect(refusals()[0]!.deliveredAt).toBeUndefined();
      expect(nudgeNotes(p.id)).toHaveLength(1);
      expect(store.getRun(p.id)?.automaticWakes).toBe(wakes + 1);
    } finally {
      store.off('event', closeAtTurnEnd);
    }
  });

  // hearsay-tools/cezarion#1301: a wait's lifecycle input is that wait's. Once the wait is
  // delivered, the same input undelivered again (a replay) is not a fresh wake.
  it('a delivered wait\'s lifecycle input is never owed again', async () => {
    nativeWire('claude');
    const run = manager.startRun(QUICK_TASK_WORKFLOW, { task: toolCall('cezar_wait', { kind: WAIT_KIND.timer, seconds: 60, note: 'reowed' }), runner: 'claude' });
    await until(() => parkedOn(run.id, waitOfKind(run.id, 'timer')));
    const timer = waitOfKind(run.id, 'timer')!;
    fireTimer(timer.id);
    await until(() => settled(run.id, timer.id)?.phase === 'delivered' && store.getRun(run.id)?.status === 'waiting');
    const input = store.getRun(run.id)!.agentInputs!.find(input => input.id === timer.id)!;
    const nativeBefore = prompted('claude', input.text).length;
    const wakesBefore = store.getRun(run.id)?.automaticWakes;
    store.commitOutcome(run.id, { kind: 'requeued', inputIds: [timer.id] });
    const replayed = structuredClone(store.getRun(run.id)!.agentInputs!);
    await manager.recover();
    await semaphore.release();
    expect(prompted('claude', input.text)).toHaveLength(nativeBefore);
    expect(store.getRun(run.id)?.automaticWakes).toBe(wakesBefore);
    expect(inputsFor(run.id, timer.id).map(input => input.deliveredAt)).toEqual([undefined]);
    // A lifecycle input no wait names is still owed and wakes this same parked session.
    const orphan: AgentInput = { id: randomUUID(), parentRunId: run.id, source: 'lifecycle', text: 'orphan', createdAt: new Date().toISOString() };
    store.commitAgentInputs(run.id, [...replayed, orphan]);
    await manager.recover();
    await semaphore.release();
    await until(() => inputsFor(run.id, orphan.id).some(input => !!input.deliveredAt) && prompted('claude', orphan.text).length > 0);
    expect(prompted('claude', orphan.text)).toHaveLength(1);
    // The orphan supplies the wake; a replay may ride along after another input wakes it.

  });

  // hearsay-tools/cezarion#1301: a refused done is not a done and cancels no wait. With a wait open
  // at that turn end there is no nudge: the run parks on the wait, and the refusal is a note.
  it('a blocked done with an open wait parks on that wait without a nudge', async () => {
    const p = await workerParent('claude');
    const turns = turnEnds(p.id);
    const timerThen = (prompt: string) => expect(manager.sendMessage(p.id, [{ type: 'text', text: `${toolCall('cezar_wait', { kind: WAIT_KIND.timer, seconds: 60, note: 'u20 timer' })} ${prompt}` }])).toBe(true);
    const w = await blockedDone(p.id, () => blockingWorker(p.id), timerThen);
    await until(() => turnEnds(p.id) > turns && parkedOn(p.id, waitOfKind(p.id, 'timer')));
    const refusal = liveRefusal(w);
    expect(store.readEvents(p.id).filter(event => event.type === 'note' && String(event.message).includes(refusal))).toHaveLength(1);
    expect(store.readEvents(p.id).some(event => event.type === 'note' && String(event.message).startsWith(COMPLETION_NUDGE_NOTE))).toBe(false);
    expect(prompted('claude', refusal)).toEqual([]);
    expect(waitOf(store.getRun(p.id))).toBeUndefined();
    expect(store.getRun(p.id)?.delegation).not.toHaveProperty('completion');
    expect(agentWaits(p.id)).toEqual([expect.objectContaining({ kind: WAIT_KIND.timer, phase: WAIT_PHASE.open })]);
  });

  // hearsay-tools/cezarion#1301: only an accepted cezar_done in the nudge's reply turn takes the
  // second step. A cezar_done refused mid-turn is no done: the turn ended with no wait.
  it('a tool-refused done in the nudge\'s reply turn takes the no-wait rule', async () => {
    process.env.CEZ_MOCK_COMPLETION_REPLY = `${toolCall('cezar_done', {})} ${thenSay('I will collect it next.')}`;
    const p = await workerParent('claude');
    // Uncollected only: with live workers the ordinary rule would open the implicit re-check timer.
    const w = await blockedDone(p.id, () => blockingWorker(p.id, { uncollected: true }));
    await until(() => prompted('claude', NO_WAIT_NUDGE).length > 0 && humanOpen(p.id)[0]?.via === 'no-wait' && gated(p.id));
    expect(prompted('claude', `Collect each (\`worker collect ${w.id}\`)`)).toHaveLength(1);
    expect(workerWaits(p.id)).toEqual([]);
    expect(humanOpen(p.id)).toEqual([expect.objectContaining({ source: WAIT_SOURCE.cezar, via: WAIT_VIA['no-wait'] })]);
  });

  it('workers settled during the nudge turn let the done finish', async () => {
    const release = join(root, 'release-u21');
    process.env.CEZ_MOCK_RELEASE_FILE = release;
    process.env.CEZ_MOCK_COMPLETION_REPLY = 'mock:hold-cezar-done';
    const p = await workerParent('claude');
    const w = await blockedDone(p.id, () => blockingWorker(p.id));
    await until(() => prompted('claude', liveRefusal(w)).length > 0);
    // While the reply turn is held, the worker settles and its result is collected.
    manager.requestWorkerStop(w.id);
    expect(await manager.awaitRunTermination(w.id, 15_000)).toBe(true);
    await collect(w.id);
    writeFileSync(release, '');
    await until(() => terminal.includes(store.getRun(p.id)?.status ?? ''));
    expect(store.getRun(p.id)?.status).not.toBe('failed');
    expect(workerWaits(p.id)).toEqual([]);
    expect([...store.getRun(p.id)?.waits ?? [], ...store.getRun(p.id)?.lastWaits ?? []].filter(wait => wait.via === 'completion')).toEqual([]);
  });

  it('the completion wait names only live workers', async () => {
    const reply = repliesDoneAgain();
    const p = await workerParent('claude');
    const first = await blockedDone(p.id, () => blockingWorker(p.id));
    await until(() => prompted('claude', liveRefusal(first)).length > 0);
    // The reply's done is blocked by a live worker and a settled, uncollected one.
    const live = await replyBlockedAgain(p.id, reply, first, async () => {
      await blockingWorker(p.id, { uncollected: true });
      return blockingWorker(p.id);
    });
    await until(() => store.getRun(p.id)?.status === 'waiting' && workerWaits(p.id)[0]?.phase === 'open');
    const entry = workerWaits(p.id)[0]!;
    expect(entry.workerIds).toEqual([live.id]);
    expect(entry.revisions).toEqual([{ workerId: live.id, revision: expect.any(Number) }]);
  });
}
