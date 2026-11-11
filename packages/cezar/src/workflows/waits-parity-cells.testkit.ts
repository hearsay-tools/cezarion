import { pr, github, processes, nativeWire, waitOfKind, delivered, agentWaits, settled, listed, inputsFor, runnerBoundary, sessionOf, idleClock, retryClock, observeAdmissionRetries, retryAtOnce, stepStatus, fireTimer, flushMicrotasks, asks, turnEnds, viaOf, parkedOn, prompted, answered, pendingQuestion, questions, ASK_CONTEXT, askPrompt, humanOpen, gated, answerOf, workerWaits, workerWake, conversationOf, parkNotices, parentOn, parentWithWorker, workerParent, blockedDone, parentTurn, blockingWorker, liveRefusal, uncollectedRefusal, repliesDoneAgain, replyBlockedAgain, ignoreRefusal, nudgeNotes, noReplyNotes, silenceRefusals, conversingParent, messenger, expectPoolCapacity, timerText, expectAdmissionRetryCleared, describeWaitCells, waitPartDescribers, waitFoldDescriber } from './waits-parity-fixture.testkit.ts';
import { registrationGroups } from '../core/registration-coverage.testkit.ts';
import { agentInputSchema } from '@open-mercato/cezar-contract/delegation';
import { spawn } from 'node:child_process';
import { WAKE_RETRY_BACKOFF } from '../delegation/retry-backoff.ts';
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it as registerTest, onTestFinished, vi } from 'vitest';
import { deriveAttention } from '@open-mercato/cezar-contract/attention';
import { RUN_STATUS, WAIT_KIND, WAIT_PHASE, WAIT_SOURCE, WAIT_VIA } from '@open-mercato/cezar-contract/test-factories.testkit';
import { toRunSummary } from '@open-mercato/cezar-contract/runs';
import type { AgentInput, RunRecord, Wait, WorkerWaitEntry } from '@open-mercato/cezar-contract';
import { RUNNER_IDS, type AgentSession, type RunnerId } from '../core/agent-runner.ts';
import { exemptionFor, HARNESS_ADAPTERS } from '../core/harness-parity-core.testkit.ts';
import { familyCells } from '../core/parity-classes.testkit.ts';
import { parkNoticeId } from '../delegation/park-notice.ts';
import { checkpoint, collect, delegatingParent, eventCheckpoint, fixtureUpdateRun, manager, parent, restart, root, semaphore, spendWorkerBudget, store, terminal, timeline, toolGenerationOf, until, waitOf, worker } from './worker-wait-core.testkit.ts';
import { timed, type TimedWait } from './waits.testkit.ts';
import { QUICK_TASK_WORKFLOW, workflowDefSchema } from './types.ts';
import { pendingAskOf } from '@open-mercato/cezar-contract/pending-ask';
import { handoffPath } from '../handoff.ts';
import { COMPLETION_NUDGE_NOTE, COMPLETION_WILL_WAIT, MAX_AUTO_CONTINUES, MAX_WAKE_DELIVERY_ATTEMPTS, NO_WAIT_NOTE, NO_WAIT_NUDGE_NOTE, REFUSAL_DISCARDED_NOTE, WAKE_DELIVERY_CAP_NOTE, WAKE_SESSION_CLOSED_ERROR, WORKER_FALLBACK_HEADER, WORKER_FALLBACK_QUESTION, WORKER_FALLBACK_REPLY_NOTE } from './run.ts';
import { AUTONOMOUS_NUDGE, NO_WAIT_NUDGE } from './turn-end.ts';
import { expectNoWaitNudgeKinds } from './turn-end.testkit.ts';
import { messagesPrompt } from './monitoring-turn.testkit.ts';
import { setRunStatus, blockRunWrites, readPersistedRuns, hasPendingAsk } from '../runs/run-store.testkit.ts';
import { recordCommits } from '../runs/outcome-crash.testkit.ts';
import { PROSE_HUMAN_GATE } from '../runs/transcript-facts.ts';
import { withHeldAck } from '../core/owned-input-delivery.testkit.ts';
import { ciNativeMessages, ciNativeSteers, gatedProviderFailure, MESSAGE_WAKE_OPENING, persistentWakeFailure, thenSay, toolCall, WAIT_CRITERIA } from './waits-parity.testkit.ts';
import { registrationCells } from './waits-parity-registration-cells.testkit.ts';
import { inputCells } from './waits-parity-input-cells.testkit.ts';
import { deliveryCells } from './waits-parity-delivery-cells.testkit.ts';
import { type WaitParityPart, type WaitCells, type WaitFold, foldCells, splitPart, folded, WAIT_PARITY_FILES, WAIT_PARITY_FAMILIES, ROW_FAMILIES, type FamilyPart, familyTest, WAIT_FOLDS, foldedWaitFile, FOLDED_WAIT_RUNNERS, type WaitParityFamily, type WaitPartScope, type WaitFoldScope } from './waits-parity-catalog.testkit.ts';

// The registry of the wait parity cells. `waits-parity.test.ts` imports it: it guards the catalog and
// runs the single-runner cells. A per-runner file imports its part's module once that part has its
// own (`waits-parity-<part>-cells.testkit.ts`); until then it still imports this registry
// (hearsay-tools/cezarion#3242).
const it = registerTest;

/** A live process of this test's own to wait on, killed when the test ends. */
function sleeper(): number {
  const child = spawn('sleep', ['120'], { stdio: 'ignore' });
  onTestFinished(() => { child.kill('SIGKILL'); });
  return child.pid!;
}
const processText = (wait: Wait, rest: string) => `Process wait ${wait.id} for PID ${(wait as { pid: number }).pid}${rest}`;

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

/** Claude U22c/k/x cross several real process launches. Keep the shared 15 s guard per
 *  signal, rather than charging every delivery attempt to one window (hearsay-tools/cezarion#1450). */
const refusalStep = (runner: RunnerId, id: string, step: string, predicate: () => boolean) =>
  until(predicate, runner === 'claude' ? () => `${runner} ${step}\n${timeline(id)}` : undefined);

async function refusalDeliveryBound(runner: RunnerId, id: string, cell: string, closed: () => number) {
  const failed = () => store.getRun(id)?.status === 'failed' && !manager.isActive(id);
  if (runner !== 'claude') { await until(failed); return; }
  // bound: each existing 15 s guard covers one durable queue write, native admission, close,
  // or retry checkpoint. Three fresh mock processes no longer share one launch budget.
  await refusalStep(runner, id, `${cell}: refusal queued`, () =>
    store.getRun(id)?.agentInputs?.some(input => input.purpose === 'completion-refusal') === true);
  for (let attempt = 1; attempt <= MAX_WAKE_DELIVERY_ATTEMPTS; attempt++) {
    await refusalStep(runner, id, `${cell}: retry ${attempt} native admission`, () => prompted(runner, MESSAGE_WAKE_OPENING).length >= attempt);
    await refusalStep(runner, id, `${cell}: retry ${attempt} session close`, () => closed() >= attempt);
    if (attempt < MAX_WAKE_DELIVERY_ATTEMPTS) {
      // The counter clears at the cap. A later native admission also proves this retry was admitted.
      await refusalStep(runner, id, `${cell}: retry ${attempt} delivery checkpoint`, () =>
        (store.getRun(id)?.waitDeliveryFailures ?? 0) >= attempt || prompted(runner, MESSAGE_WAKE_OPENING).length > attempt || failed());
    }
  }
  await refusalStep(runner, id, `${cell}: delivery cap and inactive`, failed);
}

/** A nudge reply whose cezar_done the tool refuses while the blocker stays: no done at its turn
 *  end, so a live worker's turn end opens the implicit re-check timer (`parkedOnWorkersTimer`). */
const refusedDoneReply = () => `${toolCall('cezar_done', {})} ${thenSay('Still done.')}`;
/** Where a refused reply's turn end leaves the run: parked on the timer a turn end opens while
 *  workers run (`monitoring-line`), or, once that turn spent the run's wake budget or its nudge, on
 *  Cezar's human wait. Never on the completion wait: the tool refused the done. */
const parkedOnWorkersTimer = (id: string) => workerWaits(id).length === 0 && (parkedOn(id, viaOf(id, WAIT_VIA['monitoring-line'])) || gated(id));

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

function asksCells(runners: RunnerId[], it: typeof registerTest = registerTest): void {
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
      const tools = manager.cezarToolHandlers(run.id, toolGenerationOf(run.id));
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
      const tools = manager.cezarToolHandlers(run.id, toolGenerationOf(run.id));
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
      const tools = manager.cezarToolHandlers(run.id, toolGenerationOf(run.id));
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

function doneCells(runners: RunnerId[], it: typeof registerTest = registerTest): void {
  for (const runner of runners) {
    it(`${runner} U6 cezar_done is refused with live workers and with settled but uncollected workers, accepted once collected, and open waits are cancelled`, async () => {
      const external = github();
      nativeWire(runner);
      const answers = join(root, 'done-answers');
      process.env.CEZ_MOCK_CI_RESULT = answers;
      const p = await parent(HARNESS_ADAPTERS[runner].scenarios.baseline!, runner);
      await until(() => store.getRun(p.id)?.status === 'waiting');
      const w = await worker(p.id);
      /** One turn through the native wire; the answer of its last cezar tool call. */
      const turn = async (text: string) => {
        const turns = turnEnds(p.id);
        rmSync(answers, { force: true });
        expect(manager.sendMessage(p.id, [{ type: 'text', text }])).toBe(true);
        await until(() => turnEnds(p.id) > turns && existsSync(answers) && store.getRun(p.id)?.status !== 'running');
        return JSON.parse(JSON.parse(readFileSync(answers, 'utf8')).response.content[0].text.split('\n')[0]);
      };
      const outstanding = await turn(toolCall('cezar_done', {}));
      expect(outstanding).toMatchObject({ ok: false, code: 'workers_outstanding', workers: [{ worker_id: w.id, reason: 'outstanding' }] });
      expect(outstanding.message).toContain('worker wait');
      expect(outstanding.message).toContain(`worker stop ${w.id}`);
      expect(manager.isActive(p.id)).toBe(true);
      manager.requestWorkerStop(w.id);
      expect(await manager.awaitRunTermination(w.id, 15_000)).toBe(true);
      const uncollected = await turn(toolCall('cezar_done', {}));
      expect(uncollected).toMatchObject({ ok: false, code: 'workers_uncollected', workers: [{ worker_id: w.id, reason: 'uncollected' }] });
      expect(uncollected.message).toContain(`worker collect ${w.id}`);
      await collect(w.id);
      const accepted = await turn(`${toolCall('cezar_wait', { kind: WAIT_KIND.pr, pr })} ${toolCall('cezar_done', {})}`);
      const ci = store.getRun(p.id)?.lastWaits?.find(wait => wait.kind === 'pr');
      expect(accepted).toMatchObject({ ok: true, finishes: 'at_turn_end' });
      expect(accepted.open_waits).toEqual(expect.arrayContaining([expect.objectContaining({ wait_id: ci?.id, kind: WAIT_KIND.pr })]));
      await until(() => terminal.includes(store.getRun(p.id)?.status ?? '') && !manager.isActive(p.id));
      expect(ci).toMatchObject({ phase: WAIT_PHASE.cancelled, via: WAIT_VIA.cezar_wait });
      expect(store.getRun(p.id)?.waits ?? []).toEqual([]);
      expect(external.aborted()).toBe(true);
      const closed = store.readEvents(p.id).filter(event => event.type === 'lifecycle' && event.message === 'goal achieved — session closed');
      expect(closed).toEqual([expect.objectContaining({ via: 'cezar_done' })]);
    });

    // hearsay-tools/cezarion#1620: every agent step accepts the done. In a step that is not the
    // last, it completes that step, says which step starts, and the next step runs.
    it(`${runner} U6s cezar_done in a workflow step that is not the last completes that step, and the next step runs`, async () => {
      nativeWire(runner);
      const answers = join(root, 'done-answers');
      process.env.CEZ_MOCK_CI_RESULT = answers;
      const chain = workflowDefSchema.parse({ name: 'done-chain', source: 'file', steps: [
        { id: 'implement', prompt: '{{task}}' },
        { id: 'review', name: 'Review', prompt: HARNESS_ADAPTERS[runner].scenarios.baseline! },
      ] });
      const run = manager.startRun(chain, { task: toolCall('cezar_done', { summary: 'step shipped' }), runner });
      await until(() => stepStatus(run.id, 'review') === 'waiting' && existsSync(answers));
      const answer = JSON.parse(JSON.parse(readFileSync(answers, 'utf8')).response.content[0].text.split('\n')[0]);
      expect(answer).toMatchObject({ ok: true, finishes: 'at_turn_end', completes: 'step', next_step: 'Review' });
      expect(store.getRun(run.id)!.steps.map(step => [step.id, step.status])).toEqual([['implement', 'done'], ['review', 'waiting']]);
      const closings = store.readEvents(run.id).filter(event => event.type === 'lifecycle' && String(event.message).endsWith('session closed'));
      expect(closings).toEqual([expect.objectContaining({ message: 'step complete — session closed', via: 'cezar_done' })]);
      expect(store.readEvents(run.id).some(event => event.type === 'note' && event.message === 'step shipped')).toBe(true);
      // The step that signalled done is never nudged; only the next step's quiet turn end is.
      const noWaitNudges = store.readEvents(run.id).filter(event => event.type === 'note' && String(event.message).startsWith(NO_WAIT_NUDGE_NOTE));
      expect(noWaitNudges.map(event => event.stepId)).toEqual(['review']);
    });

    it(`${runner} U7d cezar_done finishes through the done path in a message turn and in a Continue`, async () => {
      nativeWire(runner);
      const closings = (id: string) => store.readEvents(id).filter(event => event.type === 'lifecycle' && event.message === 'goal achieved — session closed');
      const finished = (id: string) => terminal.includes(store.getRun(id)?.status ?? '') && !manager.isActive(id);
      const run = manager.startRun(QUICK_TASK_WORKFLOW, { task: HARNESS_ADAPTERS[runner].scenarios.baseline!, runner });
      await until(() => store.getRun(run.id)?.status === 'waiting');
      // A turn that ends on an accepted done gets no no-wait nudge, fresh or continued.
      const nudged = prompted(runner, NO_WAIT_NUDGE).length;
      expect(manager.sendMessage(run.id, [{ type: 'text', text: toolCall('cezar_done', { summary: 'u7d shipped' }) }])).toBe(true);
      await until(() => finished(run.id));
      const status = store.getRun(run.id)!.status;
      expect(closings(run.id)).toEqual([expect.objectContaining({ via: 'cezar_done' })]);
      expect(prompted(runner, NO_WAIT_NUDGE)).toHaveLength(nudged);
      // The summary is the note right before the closing event.
      const events = store.readEvents(run.id);
      expect(events[events.findIndex(event => event.seq === closings(run.id)[0]!.seq) - 1]).toMatchObject({ type: 'note', message: 'u7d shipped' });
      // A Continue turn finishes through the same path on its own handler.
      expect(manager.continueRun(run.id, { text: toolCall('cezar_done', {}) }).ok).toBe(true);
      await until(() => closings(run.id).length === 2 && finished(run.id));
      expect(closings(run.id).map(event => event.via)).toEqual(['cezar_done', 'cezar_done']);
      expect(store.getRun(run.id)!.status).toBe(status);
      expect(prompted(runner, NO_WAIT_NUDGE)).toHaveLength(nudged);
      expect(store.readEvents(run.id).filter(event => event.type === 'note' && String(event.message).startsWith(NO_WAIT_NUDGE_NOTE))).toHaveLength(nudged);
    });

    // The answer a Continue opens with is no longer a pending question to cezar_done.
    it(`${runner} U7d a Continue that answers the question finishes through cezar_done`, async () => {
      nativeWire(runner);
      const answers = join(root, 'done-answers');
      process.env.CEZ_MOCK_CI_RESULT = answers;
      const run = manager.startRun(QUICK_TASK_WORKFLOW, { task: toolCall('cezar_ask', { context: ASK_CONTEXT, questions }), runner });
      await until(() => pendingQuestion(run.id) && humanOpen(run.id)[0]?.askSeq !== undefined);
      const [wait] = humanOpen(run.id);
      sessionOf(run.id).end();
      await until(() => !manager.isActive(run.id));
      rmSync(answers, { force: true });
      store.updateRun(run.id, { automaticWakes: MAX_AUTO_CONTINUES, waitDeliveryFailures: 2 });
      // What a crash after any commit would leave (hearsay-tools/cezarion#1805): every committed row.
      const commits = recordCommits(join(root, '.ai/cezar'));
      const answer = toolCall('cezar_done', { summary: 'answered and shipped' });
      expect(manager.continueRun(run.id, { text: answer }).ok).toBe(true);
      commits.stop();
      commits.expectEveryCommit(run.id, row => !row.lastWaits?.some(entry => entry.id === wait!.id && entry.phase === 'delivered') ||
        (row.automaticWakes === 0 && row.waitDeliveryFailures === undefined), 'an answered wait and its reset wake budget');
      // The wait is never delivered in a row that lost the answer it was delivered with: until the
      // Continue's step starts, a row with the wait delivered holds the answer.
      commits.expectEveryCommit(run.id, row => !row.lastWaits?.some(entry => entry.id === wait!.id && entry.phase === 'delivered') ||
        row.continuationMessage?.text === answer.trim() || row.steps.some(step => step.id === 'continue-1' && step.status !== 'pending'), 'an answered wait and its answer');
      expect(commits.rows(run.id).some(row => row?.lastWaits?.some(entry => entry.id === wait!.id && entry.phase === 'delivered') && row.continuationMessage?.text === answer.trim())).toBe(true);
      // File creation precedes write completion in the mock child. Read its response only
      // after the native turn has finished, when the child has completed the write.
      await until(() => terminal.includes(store.getRun(run.id)?.status ?? '') && !manager.isActive(run.id));
      expect(JSON.parse(JSON.parse(readFileSync(answers, 'utf8')).response.content[0].text.split('\n')[0])).toMatchObject({ ok: true, finishes: 'at_turn_end' });
      expect(store.readEvents(run.id).filter(event => event.type === 'lifecycle' && event.message === 'goal achieved — session closed'))
        .toEqual([expect.objectContaining({ via: 'cezar_done' })]);
      expect(settled(run.id, wait!.id)?.phase).toBe('delivered');
    });

    // hearsay-tools/cezarion#1234 phase 2b: one turn-end rule. Nothing reads the turn's prose.
    it(`${runner} U5 a turn end with no wait gets one nudge, then a second no-wait turn end opens a no-wait human wait and reads needs you`, async () => {
      nativeWire(runner);
      const run = manager.startRun(QUICK_TASK_WORKFLOW, { runner, task: HARNESS_ADAPTERS[runner].scenarios.baseline! });
      await until(() => gated(run.id));
      expect(prompted(runner, NO_WAIT_NUDGE)).toHaveLength(1);
      expectNoWaitNudgeKinds(prompted(runner, NO_WAIT_NUDGE)[0]!);
      const [wait, ...more] = humanOpen(run.id);
      expect(more).toEqual([]);
      expect(wait).toMatchObject({ kind: WAIT_KIND.human, via: WAIT_VIA['no-wait'], source: WAIT_SOURCE.cezar, phase: WAIT_PHASE.open });
      expect(wait!.questions).toBeUndefined();
      expect(store.getRun(run.id)?.automaticWakes).toBe(1);
      expect(store.readEvents(run.id).filter(event => event.type === 'note' && event.message === NO_WAIT_NOTE)).toHaveLength(1);
      expect(toRunSummary(store.getRun(run.id)!).waitingOn).toEqual({ kind: WAIT_KIND.human, shown: true });
      expect(deriveAttention(store.getRun(run.id)!).label).toBe('needs you');
      // The user's reply answers it and restarts the budget; the reply's own turn is nudged again.
      expect(manager.sendMessage(run.id, [{ type: 'text', text: 'carry on' }])).toBe(true);
      await until(() => settled(run.id, wait!.id)?.phase === 'delivered');
      await until(() => prompted(runner, NO_WAIT_NUDGE).length === 2 && gated(run.id));
      for (const nudge of prompted(runner, NO_WAIT_NUDGE)) expectNoWaitNudgeKinds(nudge);
      expect(store.getRun(run.id)?.automaticWakes).toBe(1);
      expect(manager.finish(run.id)).toBe(true);
      await until(() => terminal.includes(store.getRun(run.id)?.status ?? ''));
    });

    // hearsay-tools/cezarion#1805: a message deferred while its session started up
    // (open-mercato/cezar#472) is queued beside the waits. When it answers the question, the answered
    // wait and the removed queue entry are one commit: a reopened store never replays an answer it
    // shows delivered, nor shows the question open after dropping the answer.
  }
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

function mixedCells(runners: RunnerId[], it: typeof registerTest = registerTest): void {
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
      await until(() => delivered(p.id, notice!.id) && prompted(runner, `Cezar notice: your worker ${w.id}`).length > 0);
      expect(prompted(runner, `Cezar notice: your worker ${w.id}`).at(-1)).toContain(`Still open: worker wait ${workers.id} on 1 worker`);
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
      await until(() => !!notice && delivered(p.id, notice.id) && reached(`Cezar notice: your worker ${w.id}`) && parkedOn(p.id, workerWaits(p.id)[0]), () => timeline(p.id));
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
      expect(prompted(runner, 'Cezar notice:')).toEqual([]);
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

function recoveryCells(runners: RunnerId[], it: typeof registerTest = registerTest): void {
  for (const runner of runners) {
    it(`${runner} U9w provider failure with a worker wait open leaves the run recoverable and the next resolution delivers`, async () => {
      const wire = gatedProviderFailure(root, runner);
      const run = manager.startRun(QUICK_TASK_WORKFLOW, { runner, task: HARNESS_ADAPTERS[runner].scenarios['provider-error-controlled']! });
      store.commitDelegation([{ id: run.id, delegation: { role: 'root', permissions: ['spawn', 'wait'], receipts: [] } }]);
      await until(wire.held);
      const w = await worker(run.id);
      const tools = manager.cezarToolHandlers(run.id, toolGenerationOf(run.id));
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
      const tools = manager.cezarToolHandlers(p.id, toolGenerationOf(p.id));
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

function conversationsCells(runners: RunnerId[], it: typeof registerTest = registerTest): void {
  for (const runner of runners) {
    it(`${runner} U19 a worker message beside a pending portable question is delivered and the question stays answerable`, async () => {
      const f = await conversingParent(runner);
      expect(manager.sendMessage(f.p.id, [{ type: 'text', text: askPrompt() }])).toBe(true);
      await until(() => pendingQuestion(f.p.id) && asks(f.p.id).length === 1);
      const askSeq = asks(f.p.id)[0]!.seq;
      const turns = turnEnds(f.p.id);
      const id = await f.progress('Worker progress u19');
      await until(() => delivered(f.p.id, id) && prompted(runner, 'Worker progress u19').length > 0);
      // Delivered beside the card, which no message answers or replaces: after the beside turn the
      // pending question is still the original one, with its askSeq.
      await until(() => turnEnds(f.p.id) > turns && pendingQuestion(f.p.id));
      expect(answered(f.p.id, askSeq)).toBe(false);
      expect(asks(f.p.id).map(event => event.seq)).toEqual([askSeq]);
      expect(humanOpen(f.p.id)).toEqual([expect.objectContaining({ phase: WAIT_PHASE.open, askSeq })]);
      expect(store.transcriptFacts(f.p.id).pendingAsk?.seq).toBe(askSeq);
      expect(deriveAttention(store.getRun(f.p.id)!).label).toBe('needs you');
      // The human's answer checkpoints that same question.
      expect(manager.sendMessage(f.p.id, [{ type: 'text', text: 'Parser' }])).toBe(true);
      await until(() => answered(f.p.id, askSeq));
    });

    /** Another root task of the project (hearsay-tools/cezarion#1990): a record with no session,
     *  whose authenticated caller sends to `to` through the conversing parent's service. */
    function peerOf(f: Awaited<ReturnType<typeof conversingParent>>, to: string) {
      const peer = store.createRun({ title: 'peer', task: 'peer', workflow: 'quick-task', runner: 'claude', steps: [] });
      setRunStatus(store, peer.id, RUN_STATUS.running, { delegation: { role: 'root', permissions: ['spawn', 'wait', 'steer', 'inspect'], receipts: [] } });
      const progress = async (text: string) => {
        const id = randomUUID();
        await f.service.send(f.callerFor(peer.id), { id, recipientRunId: to, kind: 'progress', text, timeoutSeconds: 600 });
        return id;
      };
      return { id: peer.id, progress };
    }
    const peerWakeNotes = (id: string) => store.readEvents(id).filter(event => event.type === 'note' && String(event.message).startsWith('automatic peer message wake-up'));

    it(`${runner} U19p a peer message beside a pending portable question is delivered with its peer attribution and the question stays answerable`, async () => {
      const f = await conversingParent(runner);
      const peer = peerOf(f, f.p.id);
      expect(manager.sendMessage(f.p.id, [{ type: 'text', text: askPrompt() }])).toBe(true);
      await until(() => pendingQuestion(f.p.id) && asks(f.p.id).length === 1);
      const askSeq = asks(f.p.id)[0]!.seq;
      const turns = turnEnds(f.p.id);
      const users = store.readEvents(f.p.id).filter(event => event.type === 'user-message').length;
      const id = await peer.progress('Peer progress u19p');
      await until(() => delivered(f.p.id, id) && prompted(runner, 'Peer progress u19p').length > 0);
      // The agent reads who sent it: the peer task, as a peer, never the user.
      const [prompt] = prompted(runner, 'Peer progress u19p');
      expect(prompt).toContain(`"senderRunId":"${peer.id}"`);
      expect(prompt).toContain('"relationship":"peer"');
      await until(() => turnEnds(f.p.id) > turns && pendingQuestion(f.p.id));
      expect(store.readEvents(f.p.id).filter(event => event.type === 'user-message')).toHaveLength(users);
      expect(answered(f.p.id, askSeq)).toBe(false);
      expect(asks(f.p.id).map(event => event.seq)).toEqual([askSeq]);
      expect(humanOpen(f.p.id)).toEqual([expect.objectContaining({ phase: WAIT_PHASE.open, askSeq })]);
      expect(store.transcriptFacts(f.p.id).pendingAsk?.seq).toBe(askSeq);
      expect(deriveAttention(store.getRun(f.p.id)!).label).toBe('needs you');
      expect(manager.sendMessage(f.p.id, [{ type: 'text', text: 'Parser' }])).toBe(true);
      await until(() => answered(f.p.id, askSeq));
    });

    it(`${runner} U19q a peer message that wakes a parked run spends one unit of the automatic-wake budget, a family message spends none, and past the budget a peer message stays queued until a human message`, async () => {
      const f = await conversingParent(runner);
      const peer = peerOf(f, f.p.id);
      // A family message wakes the parked parent and charges nothing.
      let turns = turnEnds(f.p.id);
      const family = await f.progress('Worker progress u19q');
      await until(() => delivered(f.p.id, family) && turnEnds(f.p.id) > turns && store.getRun(f.p.id)?.status === 'waiting');
      expect(peerWakeNotes(f.p.id)).toEqual([]);
      // A peer message that opens the wake turn spends the budget's last unit.
      fixtureUpdateRun(f.p.id, { automaticWakes: MAX_AUTO_CONTINUES - 1 });
      turns = turnEnds(f.p.id);
      const first = await peer.progress('Peer progress u19q one');
      await until(() => delivered(f.p.id, first) && peerWakeNotes(f.p.id).length === 1);
      expect(peerWakeNotes(f.p.id)).toEqual([expect.objectContaining({ message: `automatic peer message wake-up (${MAX_AUTO_CONTINUES}/${MAX_AUTO_CONTINUES})` })]);
      await until(() => turnEnds(f.p.id) > turns && store.getRun(f.p.id)?.status === 'waiting');
      // Past the budget the next peer message wakes nothing: it stays queued and Cezar's human wait opens.
      fixtureUpdateRun(f.p.id, { automaticWakes: MAX_AUTO_CONTINUES });
      const held = await peer.progress('Peer progress u19q held');
      expect(delivered(f.p.id, held)).toBe(false);
      expect(prompted(runner, 'Peer progress u19q held')).toEqual([]);
      expect(humanOpen(f.p.id)).toEqual([expect.objectContaining({ phase: WAIT_PHASE.open, source: WAIT_SOURCE.cezar })]);
      expect(deriveAttention(store.getRun(f.p.id)!).label).toBe('needs you');
      // A human message restarts the budget, and its turn takes the held message.
      expect(manager.sendMessage(f.p.id, [{ type: 'text', text: 'Carry on' }])).toBe(true);
      await until(() => delivered(f.p.id, held) && prompted(runner, 'Peer progress u19q held').length > 0);
      expect(store.getRun(f.p.id)?.automaticWakes ?? 0).toBeLessThan(MAX_AUTO_CONTINUES);
      expect(peerWakeNotes(f.p.id)).toHaveLength(1);
    });

    // hearsay-tools/cezarion#1995 (R9, R11): the peer wait, the one wait a message closes, and only
    // a named peer's message.
    it(`${runner} U19w a peer wait parks a root that reads waiting on 1 task; a family message wakes it and the wait stays open; the named peer's message resolves it and is delivered with its result`, async () => {
      const f = await conversingParent(runner);
      const peer = peerOf(f, f.p.id);
      const wait = manager.registerPeerWait(f.p.id, { peerIds: [peer.id], timeoutSeconds: 600 }, 'cez-message-wait');
      await until(() => store.getRun(f.p.id)?.status === RUN_STATUS.waiting && listed(f.p.id, wait.id) !== undefined && semaphore.busy() === 0);
      expect(deriveAttention(store.getRun(f.p.id)!)).toMatchObject({ bucket: 'none', label: 'waiting on 1 task' });
      const turns = turnEnds(f.p.id);
      const family = await f.progress('Worker progress u19w');
      await until(() => delivered(f.p.id, family) && turnEnds(f.p.id) > turns && store.getRun(f.p.id)?.status === RUN_STATUS.waiting);
      expect(listed(f.p.id, wait.id)).toMatchObject({ phase: WAIT_PHASE.open });
      const id = await peer.progress('Peer progress u19w');
      await until(() => delivered(f.p.id, id) && settled(f.p.id, wait.id)?.phase === WAIT_PHASE.delivered);
      expect(settled(f.p.id, wait.id)).toMatchObject({ result: { reason: 'message', peerRunId: peer.id, messageId: id } });
      await until(() => prompted(runner, 'Peer progress u19w').length > 0 && prompted(runner, `Peer wait ${wait.id}`).length > 0);
      expect(prompted(runner, `Peer wait ${wait.id}`)[0]).toContain(`task ${peer.id} sent message ${id}`);
    });

    // hearsay-tools/cezarion#1301: a blocked done at the turn end is answered with the refusal
    // `cezar_done` gives mid-turn, as one automatic turn, and Cezar opens no wait.
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

function completionRepliesCells(runners: RunnerId[], it: typeof registerTest = registerTest): void {
  for (const runner of runners) {
    it(`${runner} U21h an ignored refusal with only uncollected results parks on Cezar's human wait`, async () => {
      const reply = repliesDoneAgain();
      const p = await workerParent(runner);
      const { second: w } = await ignoreRefusal(runner, p.id, reply, () => gated(p.id), { uncollected: true });
      const refusal = `${uncollectedRefusal(w)}, then call cezar_done again.`;
      expect(humanOpen(p.id)).toEqual([expect.objectContaining({ kind: WAIT_KIND.human, source: WAIT_SOURCE.cezar, via: WAIT_VIA.completion, phase: WAIT_PHASE.open })]);
      expect(workerWaits(p.id)).toEqual([]);
      const shown = store.readEvents(p.id).find(event => event.seq === humanOpen(p.id)[0]!.askSeq);
      expect(shown).toMatchObject({ type: 'note', message: refusal });
      expect(asks(p.id)).toEqual([]);
      expect(deriveAttention(store.getRun(p.id)!).label).toBe('needs you');
      expect(semaphore.busy()).toBe(0);
    });

    it(`${runner} U21a an autonomous parent's ignored refusal is nudged again until the budget`, async () => {
      const reply = repliesDoneAgain();
      nativeWire(runner);
      process.env.CEZ_CLAUDE_BIN = HARNESS_ADAPTERS.claude.mockBin;
      const run = manager.startRun(QUICK_TASK_WORKFLOW, { runner, task: HARNESS_ADAPTERS[runner].scenarios['autonomous-cap']!, autonomous: true });
      store.commitDelegation([{ id: run.id, delegation: { role: 'root', permissions: ['spawn', 'wait'], receipts: [] } }]);
      // The opening turn spends what is left and parks on the budget; the workers come after it.
      store.updateRun(run.id, { automaticWakes: MAX_AUTO_CONTINUES });
      await until(() => gated(run.id));
      const atNudges: Wait[][] = [];
      const append = store.appendEvent.bind(store);
      vi.spyOn(store, 'appendEvent').mockImplementation((id, event) => {
        if (id === run.id && event.type === 'note' && String(event.message).startsWith(COMPLETION_NUDGE_NOTE)) atNudges.push(store.getRun(run.id)?.waits ?? []);
        return append(id, event);
      });
      // The human message restarted the budget; two units are left for the nudges.
      const w = await blockedDone(run.id, async () => {
        store.updateRun(run.id, { automaticWakes: MAX_AUTO_CONTINUES - 2 });
        return blockingWorker(run.id);
      });
      await until(() => prompted(runner, liveRefusal(w)).length > 0, () => timeline(run.id));
      // The first reply's done is blocked again: the second nudge. The second reply's done, which the
      // tool refuses while that worker is live, ends a turn at the spent budget.
      const next = await replyBlockedAgain(run.id, reply, w, () => blockingWorker(run.id));
      await until(() => humanOpen(run.id)[0]?.via === 'budget' && gated(run.id));
      expect(prompted(runner, liveRefusal(w))).toHaveLength(1);
      expect(prompted(runner, liveRefusal(next))).toHaveLength(1);
      expect(atNudges).toEqual([[], []]);
      expect(humanOpen(run.id)).toEqual([expect.objectContaining({ kind: WAIT_KIND.human, source: WAIT_SOURCE.cezar, via: WAIT_VIA.budget, phase: WAIT_PHASE.open })]);
      expect(workerWaits(run.id)).toEqual([]);
      expect(store.getRun(run.id)?.automaticWakes).toBe(MAX_AUTO_CONTINUES);
      expect(deriveAttention(store.getRun(run.id)!).label).toBe('needs you');
    });

    // hearsay-tools/cezarion#1301: a blocked done found after the session closed is queued as a
    // lifecycle wake; the scheduler continuation reopens the session and delivers it as the nudge.
    it(`${runner} U22 a done blocked after the session closed reopens it and delivers the refusal`, async () => {
      // The reply turn ends on done again: the refusal's turn is the nudge's, so it takes the second step.
      const reply = repliesDoneAgain();
      const { p, w } = await parentWithWorker(runner);
      const wakes = store.getRun(p.id)?.automaticWakes ?? 0;
      const commits = recordCommits(join(root, '.ai/cezar'));
      sessionOf(p.id).end();
      const refusal = liveRefusal(w);
      await until(() => prompted(runner, refusal).length > 0, () => timeline(p.id));
      const next = await replyBlockedAgain(p.id, reply, w, () => blockingWorker(p.id));
      await until(() => workerWaits(p.id)[0]?.phase === 'open' && store.getRun(p.id)?.status === 'waiting', () => timeline(p.id));
      // hearsay-tools/cezarion#1805: the refusal is queued with its charge, so no reopened store
      // delivers it uncharged.
      commits.expectEveryCommit(p.id, row => !row.agentInputs?.some(input => input.text.includes(refusal)) || row.automaticWakes === wakes + 1, 'a queued refusal and its charge');
      expect(store.getRun(p.id)?.steps.some(step => step.id === 'continue-1')).toBe(true);
      expect(prompted(runner, refusal)).toEqual([expect.stringContaining(COMPLETION_WILL_WAIT)]);
      const inputs = store.getRun(p.id)?.agentInputs?.filter(input => input.text.includes(refusal)) ?? [];
      expect(inputs).toEqual([expect.objectContaining({ source: 'lifecycle', deliveredAt: expect.any(String) })]);
      expect(store.getRun(p.id)?.automaticWakes).toBe(wakes + 1);
      expect(store.readEvents(p.id).filter(event => event.type === 'note' && String(event.message).startsWith(COMPLETION_NUDGE_NOTE)))
        .toEqual([expect.objectContaining({ message: `${COMPLETION_NUDGE_NOTE} (${wakes + 1}/${MAX_AUTO_CONTINUES}): workers_outstanding` })]);
      expect(workerWaits(p.id)).toEqual([expect.objectContaining({ source: WAIT_SOURCE.cezar, via: WAIT_VIA.completion, workerIds: [next.id] })]);
      expect(store.getRun(p.id)?.delegation).not.toHaveProperty('wait');
      expect(store.getRun(p.id)?.delegation).not.toHaveProperty('completion');
    });

    // hearsay-tools/cezarion#1301: a reopened session that acknowledges the refusal and never answers
    // it is bounded as the live nudge is: at the reply bound the run parks on Cezar's human wait and
    // gives up its slot, whether or not its harness reports the input read.
    it(`${runner} U22s a refusal reopened into a session that acknowledges it and never answers parks on Cezar's human wait at the nudge's reply bound`, async () => {
      if (exemptionFor('U22s', runner)) {
        expect(exemptionFor('U22s', runner)?.kind).toBe('capability-absent');
        return;
      }
      const silence = silenceRefusals();
      const { p, w } = await parentWithWorker(runner);
      const refusal = `Workers are still live: ${w.id}.`;
      sessionOf(p.id).end();
      await silence(runner, refusal);
      await until(() => noReplyNotes(p.id).length === 1 && gated(p.id));
      expect(prompted(runner, refusal)).toHaveLength(1);
      expect(store.getRun(p.id)?.agentInputs?.filter(input => input.text.includes(refusal)))
        .toEqual([expect.objectContaining({ source: 'lifecycle', deliveredAt: expect.any(String) })]);
      expect(humanOpen(p.id)).toEqual([expect.objectContaining({ source: WAIT_SOURCE.cezar, via: WAIT_VIA['no-wait'] })]);
      expect(nudgeNotes(p.id)).toHaveLength(1);
      expect(workerWaits(p.id)).toEqual([]);
      expect(semaphore.busy()).toBe(0);
    });

    // hearsay-tools/cezarion#1301: a queued refusal is owed input, and a reopened session that closes
    // before Cezar submits it is a failed delivery, as U14's: one copy, the delivery bound, and the
    // run fails keeping it. A legacy accepted Finish takes the same path.
  }
}

function closedCells(runners: RunnerId[], it: typeof registerTest = registerTest): void {
  for (const runner of runners) {
    for (const legacy of [false, true]) {
      it(`${runner} U22c a refusal whose reopened sessions keep closing cleanly is queued once, stops at the delivery bound, and Continue delivers it once${legacy ? ' (legacy Finish)' : ''}`, async () => {
        retryAtOnce();
        const { p, w } = await parentWithWorker(runner, runner === 'claude' ? 'U22c' : undefined);
        const refusal = `Workers are still live: ${w.id}.`;
        const refusals = () => store.getRun(p.id)?.agentInputs?.filter(input => input.text.includes(refusal)) ?? [];
        const wakes = store.getRun(p.id)?.automaticWakes ?? 0;
        if (legacy) {
          const delegation = store.getRun(p.id)!.delegation!;
          if (delegation.role !== 'root') throw Error('root fixture');
          store.commitDelegation([{ id: p.id, delegation: { ...delegation, finishRequestedAt: new Date().toISOString() } }]);
        }
        let closing = true;
        let closed = 0;
        const closeAtTurnEnd = ({ runId, event }: { runId: string; event: { type: string } }) => {
          if (runId === p.id && event.type === 'turn-end' && closing && refusals().some(input => !input.deliveredAt)) {
            closed++;
            sessionOf(p.id).end();
          }
        };
        store.on('event', closeAtTurnEnd);
        try {
          sessionOf(p.id).end();
          await refusalDeliveryBound(runner, p.id, 'U22c', () => closed);
          // Each attempt is a scheduler continuation that closed before the refusal reached it.
          expect(prompted(runner, MESSAGE_WAKE_OPENING)).toHaveLength(MAX_WAKE_DELIVERY_ATTEMPTS);
          expect(prompted(runner, refusal)).toEqual([]);
          expect(refusals()).toEqual([expect.objectContaining({ source: 'lifecycle' })]);
          expect(refusals()[0]!.deliveredAt).toBeUndefined();
          expect(nudgeNotes(p.id)).toHaveLength(1);
          expect(store.getRun(p.id)?.automaticWakes).toBe(wakes + 1);
          expect(store.getRun(p.id)?.error).toBe(`continue failed: ${WAKE_SESSION_CLOSED_ERROR}`);
          expect(store.readEvents(p.id).filter(event => event.type === 'note' && event.message === WAKE_DELIVERY_CAP_NOTE)).toHaveLength(1);
          expect(retryClock.pending).toBe(0);
          expect(store.getRun(p.id)?.delegation).not.toHaveProperty('finishRequestedAt');
          closing = false;
          expect(manager.continueRun(p.id, { text: 'go on' })).toEqual({ ok: true });
          if (runner === 'claude') {
            await refusalStep(runner, p.id, 'U22c: Continue native refusal receipt', () => prompted(runner, refusal).length > 0);
            await refusalStep(runner, p.id, 'U22c: Continue delivery checkpoint', () => refusals()[0]?.deliveredAt !== undefined);
          } else await until(() => refusals()[0]?.deliveredAt !== undefined && prompted(runner, refusal).length > 0);
          expect(prompted(runner, refusal)).toHaveLength(1);
          expect(refusals()).toHaveLength(1);
          await refusalStep(runner, p.id, 'U22c: Continue final park', () => store.getRun(p.id)?.status === 'waiting');
        } finally {
          store.off('event', closeAtTurnEnd);
        }
      });
    }

    it(`${runner} U22f a refusal whose reopened session closes once counts the failure, and its delivery clears it`, async () => {
      retryAtOnce();
      process.env.CEZ_MOCK_COMPLETION_REPLY = refusedDoneReply();
      const { p, w } = await parentWithWorker(runner);
      const refusal = `Workers are still live: ${w.id}.`;
      const refusals = () => store.getRun(p.id)?.agentInputs?.filter(input => input.text.includes(refusal)) ?? [];
      let closes = 1;
      const closeOnce = ({ runId, event }: { runId: string; event: { type: string } }) => {
        if (runId !== p.id || event.type !== 'turn-end' || !closes || !refusals().some(input => !input.deliveredAt)) return;
        closes--;
        sessionOf(p.id).end();
      };
      // With no backoff the retry delivers at once and clears the count, so a poll can miss it: the
      // store's own writes record that it was counted.
      let counted = false;
      const countOnce = (run: RunRecord) => { if (run.id === p.id && run.waitDeliveryFailures === 1) counted = true; };
      store.on('event', closeOnce);
      store.on('run', countOnce);
      try {
        sessionOf(p.id).end();
        await until(() => counted);
        await until(() => prompted(runner, refusal).length > 0 && parkedOnWorkersTimer(p.id));
        expect(refusals()).toEqual([expect.objectContaining({ deliveredAt: expect.any(String) })]);
        expect(prompted(runner, MESSAGE_WAKE_OPENING)).toHaveLength(2);
        expect(store.getRun(p.id)?.waitDeliveryFailures).toBeUndefined();
      } finally {
        store.off('event', closeOnce);
        store.off('run', countOnce);
      }
    });

    // hearsay-tools/cezarion#1301: a refusal is known by its persisted input, so both bounds that
    // hold it, the nudge's reply bound and the delivery retry of sessions that close before it, last
    // past a run that failed at the delivery bound (U22k: Continue delivers it) and a restart (U22r).
    // The silent harness is not constructible on Cursor print (U22s's exemption).
    for (const variant of ['silent', 'closing'] as const) {
      const how = variant === 'silent' ? 'as the nudge: a harness that never answers parks at the reply bound'
        : 'with the delivery retry: a session that closes before it counts a failure, and one copy is delivered';
      it(`${runner} U22k after a refusal failed at the delivery bound, Continue delivers it ${how}`, async () => {
        if (variant === 'silent' && exemptionFor('U22s', runner)) {
          expect(exemptionFor('U22s', runner)?.kind).toBe('capability-absent');
          return;
        }
        retryAtOnce();
        const silence = variant === 'silent' ? silenceRefusals() : undefined;
        if (variant === 'closing') process.env.CEZ_MOCK_COMPLETION_REPLY = refusedDoneReply();
        const { p, w } = await parentWithWorker(runner, runner === 'claude' ? 'U22k' : undefined);
        const refusal = `Workers are still live: ${w.id}.`;
        const refusals = () => store.getRun(p.id)?.agentInputs?.filter(input => input.text.includes(refusal)) ?? [];
        let closes = MAX_WAKE_DELIVERY_ATTEMPTS;
        const closeAtTurnEnd = ({ runId, event }: { runId: string; event: { type: string } }) => {
          if (runId !== p.id || event.type !== 'turn-end' || !closes || !refusals().some(input => !input.deliveredAt)) return;
          closes--;
          sessionOf(p.id).end();
        };
        store.on('event', closeAtTurnEnd);
        onTestFinished(() => { store.off('event', closeAtTurnEnd); });
        sessionOf(p.id).end();
        await refusalDeliveryBound(runner, p.id, 'U22k', () => MAX_WAKE_DELIVERY_ATTEMPTS - closes);
        expect(prompted(runner, MESSAGE_WAKE_OPENING)).toHaveLength(MAX_WAKE_DELIVERY_ATTEMPTS);
        expect(refusals()).toHaveLength(1);
        expect(refusals()[0]!.deliveredAt).toBeUndefined();
        if (variant === 'closing') closes = 1;
        expect(manager.continueRun(p.id, { text: 'go on' })).toEqual({ ok: true });
        if (runner === 'claude') {
          if (variant === 'closing') {
            await refusalStep(runner, p.id, 'U22k: Continue session close', () => closes === 0);
            await refusalStep(runner, p.id, 'U22k: Continue retry native admission', () => prompted(runner, MESSAGE_WAKE_OPENING).length > MAX_WAKE_DELIVERY_ATTEMPTS);
          }
          await refusalStep(runner, p.id, 'U22k: Continue native refusal receipt', () => prompted(runner, refusal).length > 0);
          await refusalStep(runner, p.id, 'U22k: Continue delivery checkpoint', () => refusals()[0]?.deliveredAt !== undefined);
        }
        if (variant === 'silent') {
          await silence!(runner, refusal);
          await refusalStep(runner, p.id, 'U22k: Continue no-reply final park', () => noReplyNotes(p.id).length === 1 && gated(p.id));
          expect(humanOpen(p.id)).toEqual([expect.objectContaining({ source: WAIT_SOURCE.cezar, via: WAIT_VIA['no-wait'] })]);
          expect(semaphore.busy()).toBe(0);
        } else {
          // The reply's done is refused by the tool, and its turn end parks on the live workers' timer.
          await refusalStep(runner, p.id, 'U22k: Continue final park', () => prompted(runner, refusal).length > 0 && parkedOnWorkersTimer(p.id));
          expect(closes).toBe(0);
          // The Continue's session closed first: one more scheduler continuation delivered it.
          expect(prompted(runner, MESSAGE_WAKE_OPENING)).toHaveLength(MAX_WAKE_DELIVERY_ATTEMPTS + 1);
          expect(store.getRun(p.id)?.waitDeliveryFailures).toBeUndefined();
        }
        expect(prompted(runner, refusal)).toHaveLength(1);
        expect(refusals()).toEqual([expect.objectContaining({ deliveredAt: expect.any(String) })]);
        expect(nudgeNotes(p.id)).toHaveLength(1);
      });

      it(`${runner} U22r after a restart, a refusal queued for a closed session is delivered ${how}`, async () => {
        const exercise = async (releaseAck: () => void) => {
          if (variant === 'silent' && exemptionFor('U22s', runner)) {
            expect(exemptionFor('U22s', runner)?.kind).toBe('capability-absent');
            return;
          }
          let silence = variant === 'silent' ? silenceRefusals() : undefined;
          if (variant === 'closing') process.env.CEZ_MOCK_COMPLETION_REPLY = refusedDoneReply();
          const { p, w } = await parentWithWorker(runner);
          const refusal = `Workers are still live: ${w.id}.`;
          const refusals = () => store.getRun(p.id)?.agentInputs?.filter(input => input.text.includes(refusal)) ?? [];
          // The disk as the refusal was queued and charged, before any session took it: a crash there.
          let disk: ReturnType<typeof readPersistedRuns> | undefined, events: Map<string, string> | undefined;
          const capture = ({ runId, event }: { runId: string; event: { type: string; message?: unknown } }) => {
            if (runId !== p.id || disk || event.type !== 'note' || !String(event.message).startsWith(COMPLETION_NUDGE_NOTE)) return;
            events = eventCheckpoint();
            disk = readPersistedRuns(join(root, '.ai/cezar'));
          };
          store.on('event', capture);
          sessionOf(p.id).end();
          await until(() => disk !== undefined);
          store.off('event', capture);
          let closes = variant === 'closing' ? 1 : 0;
          const closeOnce = ({ runId, event }: { runId: string; event: { type: string } }) => {
            if (runId !== p.id || event.type !== 'turn-end' || !closes || !refusals().some(input => !input.deliveredAt)) return;
            closes--;
            sessionOf(p.id).end();
          };
          await restart(false, disk, events);
          // The old manager may have reached a mock before it stopped: count from here.
          const before = prompted(runner, refusal).length;
          // Recovery reopens the run through the scheduler; its first turn end is a mock round trip away.
          store.on('event', closeOnce);
          onTestFinished(() => { store.off('event', closeOnce); });
          if (variant === 'silent') silence = silenceRefusals();
          else retryAtOnce();
          expect(refusals()).toEqual([expect.objectContaining({ source: 'lifecycle' })]);
          if (variant === 'silent') {
            await silence!(runner, refusal, { after: before });
            await until(() => noReplyNotes(p.id).length === 1 && gated(p.id));
            if (runner === 'opencode') expect(refusals()[0]!.deliveredAt).toBeUndefined();
            expect(humanOpen(p.id)).toEqual([expect.objectContaining({ source: WAIT_SOURCE.cezar, via: WAIT_VIA['no-wait'] })]);
            expect(semaphore.busy()).toBe(0);
            releaseAck();
            if (runner === 'opencode') {
              await until(() => refusals().some(input => !!input.deliveredAt));
              await silence!(runner, refusal, { after: before });
            }
            // The reply bound can beat the native ACK. Its human gate alone does not prove
            // delivery committed; the late ACK resumes wake bookkeeping and re-arms that bound.
            checkpoint('u22r-refusal-delivered-and-reparked');
            await until(() => refusals().some(input => !!input.deliveredAt) && gated(p.id));
            expect(humanOpen(p.id)).toEqual([expect.objectContaining({ source: WAIT_SOURCE.cezar, via: WAIT_VIA['no-wait'] })]);
            expect(semaphore.busy()).toBe(0);
          } else {
            await until(() => prompted(runner, refusal).length > before && parkedOnWorkersTimer(p.id));
            expect(closes).toBe(0);
            expect(store.getRun(p.id)?.waitDeliveryFailures).toBeUndefined();
          }
          expect(prompted(runner, refusal).length - before).toBe(1);
          expect(refusals()).toEqual([expect.objectContaining({ deliveredAt: expect.any(String) })]);
          expect(nudgeNotes(p.id)).toHaveLength(1);
        };
        if (runner === 'opencode' && variant === 'silent') {
          await withHeldAck('opencode', exercise, 'mock:ack-only');
        } else await exercise(() => {});
      });
    }

    // hearsay-tools/cezarion#1301: Stop discards a refusal a closed session still owes, as it
    // discards the run's waits, so a Continue after it never delivers a stale refusal.
    it(`${runner} U22x Stop retires a refusal a closed session still owes, and Continue does not deliver it`, async () => {
      retryAtOnce();
      const { p, w } = await parentWithWorker(runner, runner === 'claude' ? 'U22x' : undefined);
      const refusal = `Workers are still live: ${w.id}.`;
      const refusals = () => store.getRun(p.id)?.agentInputs?.filter(input => input.text.includes(refusal)) ?? [];
      let closes = MAX_WAKE_DELIVERY_ATTEMPTS;
      const closeAtTurnEnd = ({ runId, event }: { runId: string; event: { type: string } }) => {
        if (runId !== p.id || event.type !== 'turn-end' || !closes || !refusals().some(input => !input.deliveredAt)) return;
        closes--;
        sessionOf(p.id).end();
      };
      store.on('event', closeAtTurnEnd);
      onTestFinished(() => { store.off('event', closeAtTurnEnd); });
      sessionOf(p.id).end();
      await refusalDeliveryBound(runner, p.id, 'U22x', () => MAX_WAKE_DELIVERY_ATTEMPTS - closes);
      expect(refusals()).toEqual([expect.objectContaining({ purpose: 'completion-refusal' })]);
      expect(refusals()[0]!.deliveredAt).toBeUndefined();
      expect(manager.cancel(p.id)).toBe(true);
      expect(refusals()).toEqual([]);
      expect(store.getRun(p.id)?.status).toBe('failed');
      expect(store.readEvents(p.id).filter(event => event.type === 'note' && event.message === REFUSAL_DISCARDED_NOTE)).toHaveLength(1);
      expect(manager.continueRun(p.id, { text: 'go on' })).toEqual({ ok: true });
      if (runner === 'claude') await refusalStep(runner, p.id, 'U22x: Continue native receipt', () => prompted(runner, 'go on').length > 0);
      await refusalStep(runner, p.id, 'U22x: Continue final park', () => prompted(runner, 'go on').length > 0 && store.getRun(p.id)?.status === 'waiting');
      expect(prompted(runner, refusal)).toHaveLength(0);
      expect(nudgeNotes(p.id)).toHaveLength(1);
    });

    // hearsay-tools/cezarion#1301: a worker keeps its one no-wait nudge; the next turn end with no
    // wait or done asks its parent, and the parent's reply resumes it, charged to its budget.
    it(`${runner} U24 a worker's second no-wait turn end asks its parent, and the reply resumes it`, async () => {
      nativeWire(runner);
      const { p, service, callerFor } = await delegatingParent({ task: HARNESS_ADAPTERS[runner].scenarios.baseline!, runner, permissions: ['spawn', 'wait', 'steer'] });
      await until(() => store.getRun(p.id)?.status === 'waiting');
      const w = await worker(p.id, HARNESS_ADAPTERS[runner].scenarios.baseline!, runner);
      manager.enqueueOwnedRun(w.id);
      const routed = () => store.readEvents(w.id).find(event => event.type === 'worker-question-routed');
      await until(() => routed() !== undefined && store.getRun(w.id)?.status === 'waiting');
      const question = WORKER_FALLBACK_QUESTION(w.id);
      expect(store.readEvents(w.id).filter(event => event.type === 'note' && String(event.message).startsWith(NO_WAIT_NUDGE_NOTE))).toHaveLength(1);
      expect(asks(w.id)).toEqual([expect.objectContaining({ questions: [{ header: WORKER_FALLBACK_HEADER, question }] })]);
      expect(humanOpen(w.id)).toEqual([expect.objectContaining({ source: WAIT_SOURCE.cezar, via: WAIT_VIA['no-wait'], askSeq: asks(w.id)[0]!.seq })]);
      expect(routed()).toMatchObject({ askSeq: asks(w.id)[0]!.seq, parentRunId: p.id });
      // The request is in the parent's conversation, and it wakes the parent.
      const requestId = String(routed()!.messageId);
      const conversation = store.getRun(p.id)?.delegation?.role === 'root' ? (store.getRun(p.id)!.delegation as { conversation?: { messages: Array<{ id: string; kind: string; senderRunId: string }> } }).conversation : undefined;
      expect(conversation?.messages.find(message => message.id === requestId)).toMatchObject({ kind: 'request', senderRunId: w.id });
      await until(() => delivered(p.id, requestId) && prompted(runner, question).length > 0);
      const wakes = store.getRun(w.id)?.automaticWakes ?? 0;
      const parentCaller = callerFor(p.id);
      const fallback = humanOpen(w.id)[0]!.id;
      const commits = recordCommits(join(root, '.ai/cezar'));
      const replyId = randomUUID();
      await service.send(parentCaller, { id: replyId, recipientRunId: w.id, kind: 'reply', requestId, text: `${WORKER_FALLBACK_HEADER}: cez-dev`, timeoutSeconds: 600 });
      await until(() => store.readEvents(w.id).some(event => event.type === 'human-input-delivered' && event.source === 'parent' && event.askSeq === asks(w.id)[0]!.seq));
      expect(store.readEvents(w.id).filter(event => event.type === 'note' && String(event.message).startsWith(WORKER_FALLBACK_REPLY_NOTE)))
        .toEqual([expect.objectContaining({ message: `${WORKER_FALLBACK_REPLY_NOTE} (${wakes + 1}/${MAX_AUTO_CONTINUES})` })]);
      await until(() => prompted(runner, `${WORKER_FALLBACK_HEADER}: cez-dev`).length > 0);
      // hearsay-tools/cezarion#1805: whichever way the reply reaches the worker (its live session, or a
      // continuation that opens with it), a reopened store never reads the charge or the answered
      // question without the reply delivered or owed, nor the reply read with the question still open.
      const reply = (row: RunRecord) => row.agentInputs?.find(input => input.id === replyId);
      const owed = (row: RunRecord) => !!reply(row)?.deliveredAt || row.continuationMessage?.agentInputId === replyId;
      commits.expectEveryCommit(w.id, row => row.automaticWakes !== wakes + 1 || owed(row), 'the reply\'s charge and its delivery');
      commits.expectEveryCommit(w.id, row => !row.lastWaits?.some(wait => wait.id === fallback && wait.phase === 'delivered') || owed(row), 'the answered question and its reply');
      commits.expectEveryCommit(w.id, row => !reply(row)?.consumedAt || !row.waits?.some(wait => wait.id === fallback), 'the read reply and its question');
    });

    // hearsay-tools/cezarion#1805: the reply opens a continuation, and the opening turn's
    // acknowledgement reads the reply and answers the worker's question in one commit, so a reopened
    // store never reads the reply consumed with the question still open.
    it(`${runner} U24r a parent's reply to a worker question whose session closed opens a continuation that answers it in one commit`, async () => {
      nativeWire(runner);
      const { p, service, callerFor } = await delegatingParent({ task: HARNESS_ADAPTERS[runner].scenarios.baseline!, runner, permissions: ['spawn', 'wait', 'steer'] });
      await until(() => store.getRun(p.id)?.status === 'waiting');
      const w = await worker(p.id, toolCall('cezar_ask', { context: ASK_CONTEXT, questions }), runner);
      manager.enqueueOwnedRun(w.id);
      const routed = () => store.readEvents(w.id).find(event => event.type === 'worker-question-routed');
      await until(() => routed() !== undefined && humanOpen(w.id)[0]?.askSeq !== undefined && store.getRun(w.id)?.status === 'waiting');
      const [question] = humanOpen(w.id);
      sessionOf(w.id).end();
      await until(() => !manager.isActive(w.id) && store.getRun(w.id)?.status === 'waiting');
      expect(humanOpen(w.id).map(wait => wait.id)).toEqual([question!.id]);
      const commits = recordCommits(join(root, '.ai/cezar'));
      const replyId = randomUUID();
      await service.send(callerFor(p.id), { id: replyId, recipientRunId: w.id, kind: 'reply', requestId: String(routed()!.messageId), text: 'Choice: Parser', timeoutSeconds: 600 });
      await until(() => store.readEvents(w.id).some(event => event.type === 'human-input-delivered' && event.source === 'parent'));
      await until(() => !!store.getRun(w.id)?.agentInputs?.find(input => input.id === replyId)?.consumedAt && humanOpen(w.id).every(wait => wait.id !== question!.id));
      expect(settled(w.id, question!.id)?.phase).toBe('delivered');
      const reply = (row: RunRecord) => row.agentInputs?.find(input => input.id === replyId);
      commits.expectEveryCommit(w.id, row => !reply(row)?.consumedAt || !row.waits?.some(wait => wait.id === question!.id), 'the read reply and its question');
      commits.expectEveryCommit(w.id, row => !row.lastWaits?.some(wait => wait.id === question!.id && wait.phase === 'delivered') || !!reply(row)?.deliveredAt ||
        row.continuationMessage?.agentInputId === replyId, 'the answered question and its reply');
    });

    // hearsay-tools/cezarion#1301: an automatic message to a worker supersedes Cezar's pending fallback
    // question, as the plain park it replaced let it through: it reaches the wire, the routed request
    // gets an outcome, and the parent's done is no longer blocked by the question.
    it(`${runner} U25 an automatic message supersedes a worker's fallback question`, async () => {
      nativeWire(runner);
      const p = await parent(HARNESS_ADAPTERS[runner].scenarios.baseline!, runner);
      await until(() => store.getRun(p.id)?.status === 'waiting');
      const delegation = store.getRun(p.id)!.delegation!;
      if (delegation.role !== 'root') throw Error('root fixture');
      store.commitDelegation([{ id: p.id, delegation: { ...delegation, permissions: [...delegation.permissions, 'steer'] } }]);
      const w = await worker(p.id, HARNESS_ADAPTERS[runner].scenarios.baseline!, runner);
      manager.enqueueOwnedRun(w.id);
      const routed = () => store.readEvents(w.id).find(event => event.type === 'worker-question-routed');
      await until(() => routed() !== undefined && store.getRun(w.id)?.status === 'waiting');
      const askSeq = asks(w.id)[0]!.seq;
      const requestId = String(routed()!.messageId);
      const conversation = () => {
        const delegation = store.getRun(p.id)!.delegation!;
        if (delegation.role !== 'root') throw Error('root fixture');
        return delegation.conversation;
      };
      expect(conversation()?.messages.find(message => message.id === requestId)).toMatchObject({ kind: 'request', senderRunId: w.id });
      expect(conversation()?.outcomes.filter(outcome => outcome.requestId === requestId)).toEqual([]);
      const text = 'automatic steer U25';
      const input = { id: randomUUID(), source: agentInputSchema.shape.source.enum.agent, parentRunId: p.id, text, createdAt: new Date().toISOString() };
      expect(manager.steerWorker(w.id, input)).toBe('queued');
      await until(() => prompted(runner, text).length > 0);
      expect(store.readEvents(w.id).filter(event => event.type === 'human-ask-closed'))
        .toEqual([expect.objectContaining({ askSeq, reason: 'superseded' })]);
      expect(conversation()?.outcomes.filter(outcome => outcome.requestId === requestId)).toHaveLength(1);
      expect(store.getRun(w.id)?.agentInputs?.find(entry => entry.id === input.id)).toMatchObject(input);
      // The steer's own turn may end without a wait and route a fresh fallback question before
      // these reads: only the superseded question is checked (hearsay-tools/cezarion#1301).
      expect(humanOpen(w.id).filter(wait => wait.askSeq === askSeq)).toEqual([]);
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

function processCells(runners: RunnerId[], it: typeof registerTest = registerTest): void {
  for (const runner of runners) {
    it(`${runner} U1p a process wait registers through cezar_wait on the native wire, parks keeping its slot, and wakes with its exit code`, async () => {
      const external = processes();
      nativeWire(runner);
      const pid = sleeper();
      const run = manager.startRun(QUICK_TASK_WORKFLOW, { task: toolCall('cezar_wait', { kind: WAIT_KIND.process, pid, exit_file: 'u1p.exit', note: 'u1p' }), runner });
      await until(() => parkedOn(run.id, waitOfKind(run.id, 'process')));
      const wait = waitOfKind(run.id, 'process')!;
      expect(wait).toMatchObject({ via: WAIT_VIA.cezar_wait, source: WAIT_SOURCE.agent, pid, note: 'u1p', startToken: expect.any(String),
        exitFile: join(store.getRun(run.id)!.worktreePath!, 'u1p.exit') });
      await expectPoolCapacity(runner, run.id, true);
      expect(deriveAttention(store.getRun(run.id)!).label).toBe('waiting for a command');
      external.settle({ outcome: 'exit_file', exitCode: 0 });
      await until(() => settled(run.id, wait.id)?.phase === 'delivered' && prompted(runner, processText(wait, ' (u1p): exited with code 0')).length > 0);
      expect(inputsFor(run.id, wait.id)).toHaveLength(1);
      await until(() => store.getRun(run.id)?.status === 'waiting');

      const other = sleeper();
      expect(manager.sendMessage(run.id, [{ type: 'text', text: toolCall('cezar_wait', { kind: WAIT_KIND.process, pid: other }) }])).toBe(true);
      await until(() => parkedOn(run.id, waitOfKind(run.id, 'process')));
      const second = waitOfKind(run.id, 'process')!;
      expect(second).toMatchObject({ pid: other });
      external.settle({ outcome: 'exited' });
      await until(() => settled(run.id, second.id)?.phase === 'delivered' && prompted(runner, processText(second, ': exited, code unknown')).length > 0);
      await until(() => store.getRun(run.id)?.status === 'waiting');
      expect(agentWaits(run.id)).toEqual([]);
    });

    it(`${runner} U2p process and timer open: the timer wakes, the process wait stays open and is in the footer, the later process result is delivered`, async () => {
      const external = processes();
      nativeWire(runner);
      const pid = sleeper();
      const opened = `${toolCall('cezar_wait', { kind: WAIT_KIND.process, pid })} ${toolCall('cezar_wait', { kind: WAIT_KIND.timer, seconds: 60, note: 'u2p' })}`;
      const run = manager.startRun(QUICK_TASK_WORKFLOW, { task: opened, runner });
      await until(() => parkedOn(run.id, waitOfKind(run.id, 'process')) && waitOfKind(run.id, 'timer')?.phase === 'open');
      const wait = waitOfKind(run.id, 'process')!, timer = waitOfKind(run.id, 'timer')!;
      const turns = turnEnds(run.id);
      fireTimer(timer.id);
      await until(() => settled(run.id, timer.id)?.phase === 'delivered' && prompted(runner, timerText(timer, 'u2p')).length > 0);
      expect(prompted(runner, timerText(timer, 'u2p')).at(-1)).toContain(`\n\nStill open: process wait ${wait.id} on PID ${pid}`);
      await until(() => turnEnds(run.id) > turns && parkedOn(run.id, waitOfKind(run.id, 'process')));
      expect(store.getRun(run.id)?.waits).toEqual([expect.objectContaining({ id: wait.id, phase: WAIT_PHASE.open })]);
      expect(external.watches()).toBe(1);
      external.settle({ outcome: 'exited' });
      await until(() => settled(run.id, wait.id)?.phase === 'delivered' && prompted(runner, processText(wait, ': exited, code unknown')).length > 0);
      expect(prompted(runner, processText(wait, ': exited, code unknown')).at(-1)).not.toContain('Still open');
      await until(() => store.getRun(run.id)?.status === 'waiting' && !agentWaits(run.id).length);
    });

    it(`${runner} U4p cezar_cancel_wait cancels a process wait, aborts its watch, and no result is delivered`, async () => {
      const external = processes();
      nativeWire(runner);
      const pid = sleeper();
      const run = manager.startRun(QUICK_TASK_WORKFLOW, { task: `${toolCall('cezar_wait', { kind: WAIT_KIND.process, pid })} ${toolCall('cezar_cancel_wait', { wait_id: 'last' })}`, runner });
      await until(() => store.getRun(run.id)?.lastWaits?.some(wait => wait.kind === 'process') === true && store.getRun(run.id)?.status === 'waiting');
      const wait = store.getRun(run.id)!.lastWaits!.find(entry => entry.kind === 'process')!;
      expect(wait).toMatchObject({ phase: WAIT_PHASE.cancelled, via: WAIT_VIA.cezar_wait });
      expect(external.aborted()).toBe(true);
      external.settle({ outcome: 'exited' });
      await flushMicrotasks();
      expect(inputsFor(run.id, wait.id)).toEqual([]);
      // Cancelling stops the watch; the process itself is the agent's.
      expect(() => process.kill(pid, 0)).not.toThrow();
    });

    it(`${runner} U9p provider failure with a process wait open leaves the run recoverable and the next result delivers`, async () => {
      const external = processes();
      const wire = gatedProviderFailure(root, runner);
      const run = manager.startRun(QUICK_TASK_WORKFLOW, { runner, task: HARNESS_ADAPTERS[runner].scenarios['provider-error-controlled']! });
      await until(wire.held);
      const tools = manager.cezarToolHandlers(run.id, toolGenerationOf(run.id));
      const registered = await tools.registerWait({ kind: WAIT_KIND.process, pid: sleeper(), timeout_seconds: 60 }, 'cezar_wait', new AbortController().signal);
      expect(registered.answer).toMatchObject({ ok: true, kind: WAIT_KIND.process });
      if (!('wait' in registered)) throw Error('registration refused');
      const wait = registered.wait;
      wire.release();
      await until(() => store.readEvents(run.id).some(event => event.type === 'error'));
      await until(() => !manager.isActive(run.id));
      expect(store.getRun(run.id)?.waits?.find(entry => entry.id === wait.id)?.phase).toBe('open');
      expect(store.getRun(run.id)?.status).not.toBe('failed');
      external.settle({ outcome: 'exit_file', exitCode: 2 });
      await until(() => settled(run.id, wait.id)?.phase === 'delivered');
      expect(inputsFor(run.id, wait.id).map(input => input.text)).toEqual([expect.stringContaining('exited with code 2')]);
      await until(() => store.getRun(run.id)?.status === 'waiting');
    });

    it(`${runner} U9p clean close with a process wait open leaves the run recoverable and the next result delivers`, async () => {
      const external = processes();
      nativeWire(runner);
      const run = manager.startRun(QUICK_TASK_WORKFLOW, { runner, task: HARNESS_ADAPTERS[runner].scenarios.baseline! });
      await until(() => store.getRun(run.id)?.status === 'waiting');
      const tools = manager.cezarToolHandlers(run.id, toolGenerationOf(run.id));
      const registered = await tools.registerWait({ kind: WAIT_KIND.process, pid: sleeper(), timeout_seconds: 60 }, 'cezar_wait', new AbortController().signal);
      if (!('wait' in registered)) throw Error('registration refused');
      const wait = registered.wait;
      sessionOf(run.id).end();
      await until(() => !manager.isActive(run.id));
      expect(store.getRun(run.id)?.status).toBe('waiting');
      expect(store.getRun(run.id)?.waits?.find(entry => entry.id === wait.id)?.phase).toBe('open');
      external.settle({ outcome: 'deadline' });
      await until(() => settled(run.id, wait.id)?.phase === 'delivered' && prompted(runner, processText(wait, ': still running at the deadline')).length > 0);
      await until(() => store.getRun(run.id)?.status === 'waiting');
    });

    it(`${runner} U9pr after a restart with no live session a process wait is watched again and its result delivers through the continuation`, async () => {
      const external = processes();
      nativeWire(runner);
      const pid = sleeper();
      const run = manager.startRun(QUICK_TASK_WORKFLOW, { task: toolCall('cezar_wait', { kind: WAIT_KIND.process, pid, note: 'u9pr' }), runner });
      await until(() => parkedOn(run.id, waitOfKind(run.id, 'process')));
      const wait = waitOfKind(run.id, 'process')!;
      await restart();
      expect(manager.isActive(run.id)).toBe(false);
      await until(() => external.watches() === 2);
      expect(waitOfKind(run.id, 'process')).toMatchObject({ id: wait.id, phase: WAIT_PHASE.open });
      external.settle({ outcome: 'exited' });
      await until(() => settled(run.id, wait.id)?.phase === 'delivered' && prompted(runner, processText(wait, ' (u9pr): exited, code unknown')).length > 0);
      await until(() => store.getRun(run.id)?.status === 'waiting');
    });
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
