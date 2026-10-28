import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { deriveAttention } from '@open-mercato/cezar-contract/attention';
import { RUN_STATUS, WAIT_PHASE, WAIT_SOURCE, WAIT_VIA } from '@open-mercato/cezar-contract/test-factories.testkit';
import { toRunSummary } from '@open-mercato/cezar-contract/runs';
import type { AgentInput, CiWaitResult, ConversationMessage, HumanWaitEntry, ProcessWaitResult, RunRecord, Wait, WorkerWaitEntry } from '@open-mercato/cezar-contract';
import { RUNNER_IDS, type AgentSession, type RunnerId } from '../core/agent-runner.ts';
import { exemptionFor, HARNESS_ADAPTERS } from '../core/harness-parity.testkit.ts';
import { CiWatcherSupervisor } from '../ci-wait/supervisor.ts';
import { ProcessWaitSupervisor } from '../process-wait/supervisor.ts';
import { parkNoticeId } from '../delegation/park-notice.ts';
import { checkpoint, collect, delegatingParent, eventCheckpoint, fixtureUpdateRun, manager, parent, restart, root, semaphore, spendWorkerBudget, store, terminal, timeline, until, useWorkerWaitFixture, waitOf, worker } from './worker-wait.testkit.ts';
import { timed, type TimedWait } from './waits.testkit.ts';
import { QUICK_TASK_WORKFLOW, workflowDefSchema } from './types.ts';
import { pendingAskOf } from '@open-mercato/cezar-contract/pending-ask';
import { handoffPath } from '../handoff.ts';
import { claudeScheduleWakeupDelay, COMPLETION_NO_REPLY_NOTE, COMPLETION_NUDGE_NOTE, COMPLETION_WILL_WAIT, MAX_AUTO_CONTINUES, MAX_WAKE_DELIVERY_ATTEMPTS, NO_WAIT_NOTE, NO_WAIT_NUDGE_NOTE, REFUSAL_DISCARDED_NOTE, WAITS_DISCARDED_NOTE, WAKE_DELIVERY_CAP_NOTE, WAKE_SESSION_CLOSED_ERROR, WORKER_FALLBACK_HEADER, WORKER_FALLBACK_QUESTION, WORKER_FALLBACK_REPLY_NOTE } from './run.ts';
import { AUTONOMOUS_NUDGE, NO_WAIT_NUDGE } from './turn-end.ts';
import { expectNoWaitNudgeKinds } from './turn-end.testkit.ts';
import { watchTurnOutcomes, type TurnOutcomes } from './turn-outcomes.testkit.ts';
import type { Backoff } from '../delegation/retry-backoff.ts';
import { ASK_TEXT, messagesPrompt, MONITORING_TEXT } from './monitoring-turn.testkit.ts';
import { blockRunWrites, muteLockedDatabaseLogs, readPersistedRuns, hasPendingAsk } from '../runs/run-store.testkit.ts';
import { recordCommits } from '../runs/outcome-crash.testkit.ts';
import { PROSE_HUMAN_GATE } from '../runs/transcript-facts.ts';
import { withHeldAck, withRejectedInput } from '../core/owned-input-delivery.testkit.ts';
import { ciNativeMessages, ciNativeSteers, gatedProviderFailure, MESSAGE_WAKE_OPENING, persistentWakeFailure, thenSay, TIMER_WAKE_OPENING, toolCall, WAIT_CRITERIA } from './waits-parity.testkit.ts';

// hearsay-tools/cezarion#1233: every runner opens, cancels and survives CI and timer waits on its
// own native wire. The production tool controller, bundled tool, runner, store and scheduler stay
// real; only GitHub (metadata and the watch) is controlled.

const pr = 'https://github.com/acme/repo/pull/12';
/** Each settled turn's outcome in the current cell (hearsay-tools/cezarion#1809). */
let turns: TurnOutcomes;
const identity = { prUrl: pr, repository: 'acme/repo', prNumber: 12, headSha: 'a'.repeat(40) };
const passed = (): CiWaitResult => ({ outcome: 'passed', headSha: identity.headSha, observedAt: new Date().toISOString(), checks: [], totalChecks: 1, truncated: false });

function github() {
  let settle!: (result: CiWaitResult) => void;
  let signal: AbortSignal | undefined;
  const result = new Promise<CiWaitResult>(resolve => { settle = resolve; });
  vi.spyOn(CiWatcherSupervisor.prototype, 'resolve').mockResolvedValue(identity);
  vi.spyOn(CiWatcherSupervisor.prototype, 'watch').mockImplementation((_wait, abort) => { signal = abort; return result; });
  return { settle: () => settle(passed()), aborted: () => signal?.aborted };
}

// hearsay-tools/cezarion#1446: only the process watch is controlled; registration, the park and the
// delivery cross the runner's own wire.
function processes() {
  const watches: Array<{ signal: AbortSignal; settle: (result: ProcessWaitResult) => void }> = [];
  vi.spyOn(ProcessWaitSupervisor.prototype, 'watch').mockImplementation((_request, signal) =>
    new Promise<ProcessWaitResult>(resolve => { watches.push({ signal, settle: resolve }); }));
  return {
    watches: () => watches.length,
    settle: (result: Omit<ProcessWaitResult, 'observedAt'>) => watches.at(-1)!.settle({ observedAt: new Date().toISOString(), ...result }),
    aborted: () => watches.at(-1)?.signal.aborted,
  };
}
/** A live process of this test's own to wait on, killed when the test ends. */
function sleeper(): number {
  const child = spawn('sleep', ['120'], { stdio: 'ignore' });
  onTestFinished(() => { child.kill('SIGKILL'); });
  return child.pid!;
}
const processText = (wait: Wait, rest: string) => `Process wait ${wait.id} for PID ${(wait as { pid: number }).pid}${rest}`;

function nativeWire(runner: RunnerId) {
  process.env.CEZ_DRY_RUN = '0';
  process.env[HARNESS_ADAPTERS[runner].binEnv] = HARNESS_ADAPTERS[runner].mockBin;
  // The prompts each native mock admitted, read back by `ciNativeMessages`.
  process.env.CEZ_MOCK_ARGS_FILE = join(root, 'args');
  process.env.CEZ_MOCK_STDIN_FILE = join(root, 'stdin');
}

const waitOfKind = (id: string, kind: Wait['kind']) => store.getRun(id)?.waits?.find(wait => wait.kind === kind);
/** The agent's waits. A delivered turn that ends with none takes the no-wait nudge, and the mock's
 *  plain reply leaves Cezar's own no-wait wait open (hearsay-tools/cezarion#1234). */
const agentWaits = (id: string) => (store.getRun(id)?.waits ?? []).filter(wait => wait.source !== 'cezar');
const settled = (id: string, waitId: string) => store.getRun(id)?.lastWaits?.find(wait => wait.id === waitId);
const inputsFor = (id: string, waitId: string) => store.getRun(id)?.agentInputs?.filter(input => input.id === waitId) ?? [];
function engine() {
  return manager as unknown as {
    active: Map<string, { session: AgentSession & { end(): void }; ciGeneration: string }>;
    waitTimers: Map<string, { timer: NodeJS.Timeout & { _onTimeout(): void } }>;
    monitoring: Set<string>;
    wakeRetryBackoff: Backoff;
    wakeBackoffs: Map<string, NodeJS.Timeout>;
    wakeRetries: Map<string, NodeJS.Timeout>;
    queue: string[];
    deferredMessages: Map<string, Array<{ content: Array<{ type: 'text'; text: string }>; messageId?: string }>>;
    flushDeferred(id: string): void;
  };
}
// The delivery bound, not the backoff, is what these cells pin: retries start at once.
const retryAtOnce = () => { engine().wakeRetryBackoff = { fastMs: 0, fastCount: MAX_WAKE_DELIVERY_ATTEMPTS, capMs: 0 }; };
const stepStatus = (id: string, stepId: string) => store.getRun(id)?.steps.find(step => step.id === stepId)?.status;
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
  expect(engine().wakeBackoffs.has(id)).toBe(false);
}
const fireTimer = (waitId: string) => engine().waitTimers.get(waitId)!.timer._onTimeout();
const flushMicrotasks = async () => { for (let n = 0; n < 5; n++) await Promise.resolve(); };
const turnEnds = (id: string) => store.readEvents(id).filter(event => event.type === 'turn-end').length;
const viaOf = (id: string, via: Wait['via']) => store.getRun(id)?.waits?.find((wait): wait is TimedWait => wait.via === via && wait.kind !== 'human');
const parkedOn = (id: string, wait: Wait | undefined) => wait?.phase === 'open' && store.getRun(id)?.status === 'waiting';
const prompted = (runner: RunnerId, text: string) => ciNativeMessages(runner, root).filter(prompt => prompt.includes(text));
const asks = (id: string) => store.readEvents(id).filter(event => event.type === 'ask.requested');
const answered = (id: string, askSeq: number) => store.readEvents(id).some(event => event.type === 'human-input-delivered' && event.askSeq === askSeq);
const pendingQuestion = (id: string) => hasPendingAsk(store, id) === true && store.getRun(id)?.status === 'waiting';

/** A portable question parked, then a timer whose note carries a native mock's ACK marker. */
async function timerBesideQuestion(runner: RunnerId, note: string) {
  nativeWire(runner);
  const run = manager.startRun(QUICK_TASK_WORKFLOW, { task: HARNESS_ADAPTERS[runner].scenarios.baseline!, runner });
  await until(() => store.getRun(run.id)?.status === 'waiting');
  expect(manager.sendMessage(run.id, [{ type: 'text', text: messagesPrompt(runner, [ASK_TEXT]) }])).toBe(true);
  await until(() => pendingQuestion(run.id) && asks(run.id).length === 1);
  const tools = manager.cezarToolHandlers(run.id, engine().active.get(run.id)!.ciGeneration);
  const registered = await tools.registerWait({ kind: 'timer', seconds: 60, note }, 'cezar_wait', new AbortController().signal);
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

// hearsay-tools/cezarion#1234: one human wait per run, shown as one card.
const questions = [{ header: 'Choice', question: 'Which module?', options: [{ label: 'Parser' }, { label: 'Runner' }] }];
/** hearsay-tools/cezarion#1458: cezar_ask requires the Markdown the user reads above the card. */
const ASK_CONTEXT = '## Draft\n\n- first finding\n- second finding';
const humanOpen = (id: string) => store.getRun(id)?.waits?.filter((wait): wait is HumanWaitEntry => wait.kind === 'human') ?? [];
/** The run waits on an open human wait it has shown: as a card, or as the gate a wait without one raises. */
const gated = (id: string) => store.getRun(id)?.status === 'waiting' && humanOpen(id)[0]?.askSeq !== undefined;
/** `Header: label` per question of the newest card: the line every native answer seam parses. An
 *  open question takes typed words, as the card sends them. */
const answerOf = (id: string) => (asks(id).at(-1) as unknown as { questions: Array<{ header: string; options?: Array<{ label: string }> }> })
  .questions.map(question => `${question.header}: ${question.options?.[0]!.label ?? 'cez-dev'}`).join('\n');

/** The run waits on exactly one human wait, surfaced as its one card, and reads Needs you; the
 *  answer moves the wait to `lastWaits` as delivered, with the card's askSeq. */
async function expectHumanWaitAnswered(id: string, via: Wait['via']) {
  await until(() => pendingQuestion(id) && humanOpen(id)[0]?.askSeq !== undefined);
  const [wait, ...more] = humanOpen(id);
  expect(more).toEqual([]);
  expect(wait).toMatchObject({ kind: 'human', via, phase: 'open' });
  expect(asks(id)).toHaveLength(1);
  expect(wait!.askSeq).toBe(asks(id)[0]!.seq);
  expect(toRunSummary(store.getRun(id)!).waitingOn).toEqual({ kind: 'human', shown: true });
  expect(deriveAttention(store.getRun(id)!).label).toBe('needs you');
  expect(manager.sendMessage(id, [{ type: 'text', text: answerOf(id) }])).toBe(true);
  await until(() => settled(id, wait!.id)?.phase === 'delivered' && answered(id, wait!.askSeq!));
  expect(humanOpen(id)).toEqual([]);
  return wait!;
}

// hearsay-tools/cezarion#1235 phase 3a: worker waits in the list.
const workerWaits = (id: string) => (store.getRun(id)?.waits ?? []).filter((wait): wait is WorkerWaitEntry => wait.kind === 'worker');
const workerWake = (wait: Wait) => `Worker wait ${wait.id} (terminal outcome)`;
const delivered = (id: string, inputId: string) => !!store.getRun(id)?.agentInputs?.find(input => input.id === inputId)?.deliveredAt;
const conversationOf = (id: string): ConversationMessage[] => {
  const delegation = store.getRun(id)?.delegation;
  return delegation?.role === 'root' ? delegation.conversation?.messages ?? [] : [];
};
/** Cezar's park notices from a worker to its parent (hearsay-tools/cezarion#1327): progress the worker never sent itself. */
const parkNotices = (parentId: string, workerId: string) => conversationOf(parentId).filter(message =>
  message.senderRunId === workerId && message.kind === 'progress' && message.text.startsWith('Cezar notice: '));
/** A root parent on `runner`'s native wire, parked after its opening turn. */
async function parentOn(runner: RunnerId) {
  nativeWire(runner);
  const p = await parent(HARNESS_ADAPTERS[runner].scenarios.baseline!, runner);
  await until(() => store.getRun(p.id)?.status === 'waiting', () => timeline(p.id));
  return p;
}

/** A root parent on `runner`'s native wire, parked after its opening turn, and one worker it owns
 *  that never starts: `fixtureUpdateRun` settles it. Workers run on the Claude wire. A restart
 *  starts the worker, so a cell that restarts gives it a `task` that settles on its own. */
async function parentWithWorker(runner: RunnerId, step?: string, task?: string) {
  nativeWire(runner);
  process.env.CEZ_CLAUDE_BIN = HARNESS_ADAPTERS.claude.mockBin;
  const p = await parent(HARNESS_ADAPTERS[runner].scenarios.baseline!, runner);
  checkpoint('parent-opening-repark');
  await until(() => store.getRun(p.id)?.status === 'waiting', () => step ? `${step}: opening park\n${timeline(p.id)}` : timeline(p.id));
  return { p, w: await worker(p.id, task) };
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

/** One parent turn through the native wire: `text`'s tool calls run, and the turn ends parked. */
async function parentTurn(id: string, text: string, parked: () => boolean) {
  const turns = turnEnds(id);
  expect(manager.sendMessage(id, [{ type: 'text', text }])).toBe(true);
  await until(() => turnEnds(id) > turns && store.getRun(id)?.status === 'waiting' && parked());
}

/** The parent's done is refused at the turn end, and the nudge's reply turn (the mock's
 *  `CEZ_MOCK_COMPLETION_REPLY`) ends on done again (hearsay-tools/cezarion#1301): one refusal
 *  prompt, then `parked`. Returns the parent's open worker entry, if any. */
async function ignoreRefusal(runner: RunnerId, id: string, refusal: string, parked: () => boolean) {
  expect(manager.sendMessage(id, [{ type: 'text', text: messagesPrompt(runner, ['All done.\nCEZ:DONE']) }])).toBe(true);
  checkpoint('completion-refusal-native-prompt');
  await until(() => prompted(runner, refusal).length > 0, () => timeline(id));
  checkpoint('completion-refusal-repark');
  await until(() => store.getRun(id)?.status === 'waiting' && parked(), () => timeline(id));
  expect(prompted(runner, refusal)).toHaveLength(1);
  expect(store.readEvents(id).filter(event => event.type === 'note' && String(event.message).startsWith(COMPLETION_NUDGE_NOTE))).toHaveLength(1);
  return workerWaits(id)[0]!;
}

/** Seed an accepted peer obligation without an unread input: the native turn tests the gate. */
function seedCompletionRequest(senderRunId: string, recipientRunId: string) {
  const request = { id: randomUUID(), senderRunId, recipientRunId, kind: 'request' as const, relationship: 'peer' as const,
    text: 'Please check the result', createdAt: new Date().toISOString(), deadline: new Date(Date.now() + 600_000).toISOString(), requestHash: 'a'.repeat(64), state: 'accepted' as const };
  store.commitConversation(senderRunId, { messages: [request], outcomes: [] });
  return request;
}

const nudgeNotes = (id: string) => store.readEvents(id).filter(event => event.type === 'note' && String(event.message).startsWith(COMPLETION_NUDGE_NOTE));
const noReplyNotes = (id: string) => store.readEvents(id).filter(event => event.type === 'note' && event.message === COMPLETION_NO_REPLY_NOTE);

/** A harness that acknowledges Cezar's completion refusal on its own native wire and never
 *  answers it (hearsay-tools/cezarion#1301): the mocks' `mock:ack-only` reply accepts the prompt,
 *  reports it read where the wire can, and starts no turn, as an OpenCode heartbeat keeps a session
 *  alive without one. The nudge's reply bound is shortened so its no-reply park comes at once.
 *  Call it before the session starts: a mock reads its environment when it is spawned. */
function silenceRefusals() {
  (manager as unknown as { noWaitNudgeReplyMs: number }).noWaitNudgeReplyMs = 300;
  process.env.CEZ_MOCK_COMPLETION_REPLY = 'mock:ack-only';
}

/** A steering parent on `runner`'s native wire and a worker running on the Claude wire, parked,
 *  with each one's credential on a delegation service, as `cez worker send` reaches them. */
async function conversingParent(runner: RunnerId) {
  nativeWire(runner);
  process.env.CEZ_CLAUDE_BIN = HARNESS_ADAPTERS.claude.mockBin;
  const { p, service, callerFor } = await delegatingParent({ task: HARNESS_ADAPTERS[runner].scenarios.baseline!, runner, permissions: ['spawn', 'wait', 'steer', 'inspect'] });
  checkpoint('parent-opening-repark');
  await until(() => store.getRun(p.id)?.status === 'waiting', () => timeline(p.id));
  const w = await worker(p.id);
  // An idle worker that only talks: it plain-parks rather than ask its parent (hearsay-tools/cezarion#1301).
  spendWorkerBudget(w.id);
  manager.enqueueOwnedRun(w.id);
  checkpoint('conversing-worker-repark');
  await until(() => store.getRun(w.id)?.status === 'waiting', () => timeline(w.id));
  const workerCaller = callerFor(w.id), parentCaller = callerFor(p.id);
  const inspect = () => service.inspect(parentCaller, { workerId: w.id });
  const progress = async (text: string) => {
    const id = randomUUID();
    await service.send(workerCaller, { id, recipientRunId: p.id, kind: 'progress', text, timeoutSeconds: 600 });
    return id;
  };
  return { p, w, progress, inspect, service, callerFor };
}

const timerText = (wait: Wait, note: string) => `Timer ${wait.id} fired: ${note}. Continue toward the task goal; register another wait if you are still waiting.`;

// Each runner's cells run from their own files: one file runs serially, and every runner's cells in
// one file outgrew a CI shard's time limit (hearsay-tools/cezarion#1301). One runner's cells in one
// file then outgrew Squeal's 600 s per-file cap on a loaded host, so each runner has two files:
// `waits-<runner>-parity.test.ts` runs the `base` rows and `waits-<runner>-workers-parity.test.ts`
// the `workers` rows (hearsay-tools/cezarion#1288). `waits-<runner>-process-parity.test.ts` runs the
// process-wait rows, and `waits-<runner>-entries-parity.test.ts` the U27 turn-end entry axis
// (hearsay-tools/cezarion#1525), so those rows grow neither file. `waits-parity.test.ts` runs the
// criteria guard and the single-runner cells.
export type WaitParityPart = 'base' | 'workers' | 'process' | 'entries';
export const WAIT_PARITY_FILES: Readonly<Record<WaitParityPart, (runner: RunnerId) => string>> = {
  base: runner => `waits-${runner}-parity.test.ts`,
  workers: runner => `waits-${runner}-workers-parity.test.ts`,
  process: runner => `waits-${runner}-process-parity.test.ts`,
  entries: runner => `waits-${runner}-entries-parity.test.ts`,
};

export function describeWaitParity(scope: { runner: RunnerId; part: WaitParityPart } | 'once'): void {
  const runnersFor = (part: WaitParityPart): RunnerId[] => scope !== 'once' && scope.part === part ? [scope.runner] : [];
  describe('wait list on every native runner wire (hearsay-tools/cezarion#1233)', { timeout: 45_000 }, () => {
    useWorkerWaitFixture();
    beforeEach(() => { turns = watchTurnOutcomes(); });
    afterEach(() => vi.restoreAllMocks());

    if (scope === 'once') {
      it('runs every runner\'s cells from its own file', () => {
        for (const runner of RUNNER_IDS) for (const file of Object.values(WAIT_PARITY_FILES)) {
          expect(existsSync(new URL(`./${file(runner)}`, import.meta.url)), file(runner)).toBe(true);
        }
      });

      it('registers every criterion', () => {
        expect(WAIT_CRITERIA.map(row => row.id)).toEqual(['U1', 'U4', 'U9', 'U2', 'U3', 'U7', 'U7m', 'U7f', 'U8', 'U8l', 'U8h', 'U10', 'U11', 'U12', 'U13', 'U14', 'U16', 'U16b', 'U9c', 'U7h', 'U7k', 'U9h', 'U6', 'U7d', 'U7q', 'U6s', 'U5', 'U5a', 'U5c', 'U5d', 'U18', 'U17', 'U15', 'U2w', 'U2t', 'U2c', 'U3w', 'U3n', 'U3r', 'U3d', 'U7w', 'U9w', 'U14m', 'U9u', 'U9v', 'U19', 'U19p', 'U19q', 'U20', 'U20u', 'U20h', 'U20m', 'U20a', 'U21', 'U21r', 'U21m', 'U21t', 'U21h', 'U21a', 'U22', 'U22s', 'U22c', 'U22f', 'U22k', 'U22r', 'U22x', 'U24', 'U24r', 'U26', 'U25', 'U1p', 'U2p', 'U4p', 'U9p', 'U9pr', 'U27', 'R13', 'R17']);
        for (const runner of RUNNER_IDS) for (const row of WAIT_CRITERIA) expect(HARNESS_ADAPTERS[runner].scenarios[row.scenario]).toBeDefined();
      });

      singleRunnerCells();
    }

    baseCells(runnersFor('base'));
    workersCells(runnersFor('workers'));
    entriesCells(runnersFor('entries'));
    processCells(runnersFor('process'));
  });
}

// Each part's cells, one group per `WaitParityPart`, registered for each runner in `runners`.
// `describeWaitParity` passes a file's own runner to its part's group and no runner to the others.
function baseCells(runners: RunnerId[]): void {
  for (const runner of runners) {
    for (const tools of [false, true]) {
      it(`${runner} U26 footer capability follows provisioning on opening, live delivery, Continue and no-session recovery (${tools ? 'tools' : 'markers'})`, async () => {
        nativeWire(runner);
        // Only tool availability is controlled; every prompt crosses the real native runner.
        const capability = () => {
          if (!tools) vi.spyOn((manager as unknown as { ciResources: { controller(): Promise<unknown> } }).ciResources, 'controller').mockResolvedValue(undefined);
        };
        capability();
        const task = `${HARNESS_ADAPTERS[runner].scenarios.baseline!} footer-opening`;
        const run = manager.startRun(QUICK_TASK_WORKFLOW, { runner, task });
        const timer: Wait = { id: randomUUID(), kind: 'timer', source: 'agent', via: 'monitoring-line', phase: 'open',
          turnId: 'seed', seconds: 7200, registeredAt: new Date().toISOString(), deadline: new Date(Date.now() + 7_200_000).toISOString() };
        // Persist before the asynchronous opening launch, as recovery/queued work can leave it.
        store.updateRun(run.id, { waits: [timer] });
        const footerOf = (text: string) => {
          const footer = text.slice(text.lastIndexOf('Still open:'));
          expect(footer).toContain(`Still open: timer ${timer.id} at ${timer.deadline}.`);
          if (tools) expect(footer).toContain('Call cezar_cancel_wait for any you no longer need.');
          else expect(footer).not.toMatch(/cezar_\w+/);
        };
        await until(() => parkedOn(run.id, waitOfKind(run.id, 'timer')));
        footerOf(prompted(runner, 'footer-opening').at(-1)!);
        const turns = turnEnds(run.id);
        expect(manager.sendMessage(run.id, [{ type: 'text', text: 'footer-human-message' }])).toBe(true);
        await until(() => prompted(runner, 'footer-human-message').length > 0 && turnEnds(run.id) > turns && store.getRun(run.id)?.status === 'waiting');
        footerOf(prompted(runner, 'footer-human-message').at(-1)!);
        const handlers = manager.cezarToolHandlers(run.id, engine().active.get(run.id)!.ciGeneration);
        const registered = await handlers.registerWait({ kind: 'timer', seconds: 60, note: 'footer-agent-wake' }, 'cezar_wait', new AbortController().signal);
        if (!('wait' in registered)) throw Error('registration refused');
        fireTimer(registered.wait.id);
        await until(() => settled(run.id, registered.wait.id)?.phase === 'delivered' && prompted(runner, 'footer-agent-wake').length > 0 && store.getRun(run.id)?.status === 'waiting');
        footerOf(prompted(runner, 'footer-agent-wake').at(-1)!);
        engine().active.get(run.id)!.session.end();
        await until(() => !manager.isActive(run.id));
        expect(manager.continueRun(run.id, { text: 'footer-continue' }).ok).toBe(true);
        await until(() => prompted(runner, 'footer-continue').length > 0 && store.getRun(run.id)?.status === 'waiting');
        footerOf(prompted(runner, 'footer-continue').at(-1)!);
        await restart();
        capability();
        expect(manager.isActive(run.id)).toBe(false);
        expect(manager.continueRun(run.id, { text: 'footer-after-recovery' }).ok).toBe(true);
        await until(() => prompted(runner, 'footer-after-recovery').length > 0 && store.getRun(run.id)?.status === 'waiting');
        footerOf(prompted(runner, 'footer-after-recovery').at(-1)!);
        expect(store.getRun(run.id)?.waits).toEqual([timer]);
      });
    }

    it(`${runner} U1 ci and timer register through cezar_wait on the native wire, park, and wake with their result`, async () => {
      const external = github();
      nativeWire(runner);
      const run = manager.startRun(QUICK_TASK_WORKFLOW, { task: toolCall('cezar_wait', { kind: 'pr', pr }), runner });
      await until(() => parkedOn(run.id, waitOfKind(run.id, 'pr')));
      const ci = waitOfKind(run.id, 'pr')!;
      expect(ci).toMatchObject({ via: 'cezar_wait', source: 'agent', prUrl: pr });
      expect(manager.isActive(run.id)).toBe(true);
      external.settle();
      await until(() => settled(run.id, ci.id)?.phase === 'delivered');
      expect(inputsFor(run.id, ci.id).map(input => input.text)).toEqual([expect.stringContaining(`CI wait observation ${ci.id} for ${pr}`)]);
      await until(() => store.getRun(run.id)?.status === 'waiting');

      expect(manager.sendMessage(run.id, [{ type: 'text', text: toolCall('cezar_wait', { kind: 'timer', seconds: 60, note: 'u1' }) }])).toBe(true);
      await until(() => parkedOn(run.id, waitOfKind(run.id, 'timer')));
      const timer = waitOfKind(run.id, 'timer')!;
      expect(timer).toMatchObject({ via: 'cezar_wait', seconds: 60, note: 'u1' });
      fireTimer(timer.id);
      await until(() => settled(run.id, timer.id)?.phase === 'delivered');
      expect(inputsFor(run.id, timer.id).map(input => input.text)).toEqual([timerText(timer, 'u1')]);
      await until(() => store.getRun(run.id)?.status === 'waiting');
      expect(agentWaits(run.id)).toEqual([]);
    });

    it(`${runner} U4 cezar_cancel_wait cancels and no observation is delivered`, async () => {
      const external = github();
      nativeWire(runner);
      const opened = toolCall('cezar_wait', { kind: 'pr', pr }), cancelled = toolCall('cezar_cancel_wait', { wait_id: 'last' });
      const run = manager.startRun(QUICK_TASK_WORKFLOW, { task: `${opened} ${cancelled}`, runner });
      await until(() => store.getRun(run.id)?.lastWaits?.some(wait => wait.kind === 'pr') === true && store.getRun(run.id)?.status === 'waiting');
      const ci = store.getRun(run.id)!.lastWaits!.find(wait => wait.kind === 'pr')!;
      expect(ci).toMatchObject({ phase: 'cancelled', via: 'cezar_wait' });
      expect(external.aborted()).toBe(true);
      const turns = store.readEvents(run.id).filter(event => event.type === 'turn-end').length;
      external.settle();
      await flushMicrotasks();
      expect(inputsFor(run.id, ci.id)).toEqual([]);

      const timerOpened = toolCall('cezar_wait', { kind: 'timer', seconds: 60, note: 'u4' });
      expect(manager.sendMessage(run.id, [{ type: 'text', text: `${timerOpened} ${cancelled}` }])).toBe(true);
      await until(() => store.getRun(run.id)?.lastWaits?.some(wait => wait.kind === 'timer') === true
        && store.readEvents(run.id).filter(event => event.type === 'turn-end').length > turns);
      const timer = store.getRun(run.id)!.lastWaits!.find(wait => wait.kind === 'timer')!;
      expect(timer).toMatchObject({ phase: 'cancelled', note: 'u4' });
      expect(engine().waitTimers.has(timer.id)).toBe(false);
      await until(() => store.getRun(run.id)?.status === 'waiting');
      expect(inputsFor(run.id, timer.id)).toEqual([]);
      expect(agentWaits(run.id)).toEqual([]);
    });

    it(`${runner} U2 ci and timer open: the timer wakes, ci stays open and is in the footer, the turn end re-parks without re-registering, the later ci result is delivered`, async () => {
      const external = github();
      nativeWire(runner);
      const opened = `${toolCall('cezar_wait', { kind: 'pr', pr })} ${toolCall('cezar_wait', { kind: 'timer', seconds: 60, note: 'u2' })}`;
      const run = manager.startRun(QUICK_TASK_WORKFLOW, { task: opened, runner });
      await until(() => parkedOn(run.id, waitOfKind(run.id, 'pr')) && waitOfKind(run.id, 'timer')?.phase === 'open');
      const ci = waitOfKind(run.id, 'pr')!, timer = waitOfKind(run.id, 'timer')!;
      const turns = turnEnds(run.id);
      fireTimer(timer.id);
      await until(() => settled(run.id, timer.id)?.phase === 'delivered' && prompted(runner, timerText(timer, 'u2')).length > 0);
      const wake = prompted(runner, timerText(timer, 'u2')).at(-1)!;
      expect(wake).toContain(`\n\nStill open: CI wait ${ci.id} for acme/repo#12`);
      expect(wake).not.toContain(`timer ${timer.id}`);
      await until(() => turnEnds(run.id) > turns && parkedOn(run.id, waitOfKind(run.id, 'pr')));
      expect(store.getRun(run.id)?.waits).toEqual([expect.objectContaining({ id: ci.id, phase: 'open' })]);
      external.settle();
      await until(() => settled(run.id, ci.id)?.phase === 'delivered' && prompted(runner, `CI wait observation ${ci.id}`).length > 0);
      expect(prompted(runner, `CI wait observation ${ci.id}`).at(-1)).not.toContain('Still open');
      await until(() => store.getRun(run.id)?.status === 'waiting' && !agentWaits(run.id).length);
    });

    it(`${runner} U3 a human message during a ci wait is delivered, the wait stays open, and its result arrives in a later turn`, async () => {
      const external = github();
      nativeWire(runner);
      const run = manager.startRun(QUICK_TASK_WORKFLOW, { task: toolCall('cezar_wait', { kind: 'pr', pr }), runner });
      await until(() => parkedOn(run.id, waitOfKind(run.id, 'pr')));
      const ci = waitOfKind(run.id, 'pr')!;
      const turns = turnEnds(run.id);
      const text = `${HARNESS_ADAPTERS[runner].scenarios.hold!}\nPlease also update the docs`;
      expect(manager.sendMessage(run.id, [{ type: 'text', text }])).toBe(true);
      await until(() => prompted(runner, 'Please also update the docs').length > 0);
      expect(prompted(runner, 'Please also update the docs').at(-1)).toContain(`\n\nStill open: CI wait ${ci.id} for acme/repo#12`);
      expect(waitOfKind(run.id, 'pr')).toMatchObject({ id: ci.id, phase: 'open' });
      expect(external.aborted()).toBe(false);
      await until(() => turnEnds(run.id) > turns && parkedOn(run.id, waitOfKind(run.id, 'pr')));
      expect(waitOfKind(run.id, 'pr')?.id).toBe(ci.id);
      external.settle();
      await until(() => settled(run.id, ci.id)?.phase === 'delivered' && prompted(runner, `CI wait observation ${ci.id}`).length > 0);
      expect(prompted(runner, `CI wait observation ${ci.id}`).at(-1)).not.toContain('Please also update the docs');
      expect(inputsFor(run.id, ci.id)).toHaveLength(1);
      expect(store.readEvents(run.id).filter(event => event.type === 'user-message').map(event => event.text)).toContain(text);
    });

    it(`${runner} U7 cezar_wait, the monitoring line and ScheduleWakeup land in the same wait list`, async () => {
      github();
      nativeWire(runner);
      const run = manager.startRun(QUICK_TASK_WORKFLOW, { task: toolCall('cezar_wait', { kind: 'pr', pr }), runner });
      await until(() => parkedOn(run.id, viaOf(run.id, 'cezar_wait')));
      expect(viaOf(run.id, 'cezar_wait')).toMatchObject({ kind: 'pr', prUrl: pr });
      let turns = turnEnds(run.id);
      expect(manager.sendMessage(run.id, [{ type: 'text', text: messagesPrompt(runner, ['Still waiting for CI.\nCEZ:MONITORING']) }])).toBe(true);
      await until(() => turnEnds(run.id) > turns && parkedOn(run.id, viaOf(run.id, 'cezar_wait')));
      expect(viaOf(run.id, 'monitoring-line')).toBeUndefined();
      expect(viaOf(run.id, 'cezar_wait')?.phase).toBe('open');
      const scheduler = { type: 'tool-call', id: 'toolu_1', tool: 'ScheduleWakeup', input: { delaySeconds: 120 } } as const;
      if (exemptionFor('U7', runner)) {
        // capability-absent: the same tool name on this wire is not a scheduler.
        expect(exemptionFor('U7', runner)?.reason).toBe('native scheduler tool exists only on the Claude wire');
        expect(claudeScheduleWakeupDelay(scheduler, runner)).toBeUndefined();
        expect(store.getRun(run.id)?.waits?.map(wait => wait.via).sort()).toEqual(['cezar_wait']);
        return;
      }
      expect(claudeScheduleWakeupDelay(scheduler, runner)).toBe(120);
      turns = turnEnds(run.id);
      expect(manager.sendMessage(run.id, [{ type: 'text', text: 'mock:schedule-wakeup:120' }])).toBe(true);
      await until(() => turnEnds(run.id) > turns && parkedOn(run.id, viaOf(run.id, 'schedule-wakeup')));
      expect(viaOf(run.id, 'schedule-wakeup')).toMatchObject({ kind: 'timer', seconds: 120 });
      expect(store.getRun(run.id)?.waits?.map(wait => wait.via).sort()).toEqual(['cezar_wait', 'schedule-wakeup']);
    });

    // hearsay-tools/cezarion#1268: exercise the marker on each runner's native wire.
    for (const kind of ['pr', 'timer', 'worker'] as const) {
      it(`${runner} U7m the monitoring line adds no timer beside an open ${kind} wait`, async () => {
        const external = github();
        nativeWire(runner);
        const family = kind === 'worker' ? await parentWithWorker(runner) : undefined;
        const run = family?.p ?? manager.startRun(QUICK_TASK_WORKFLOW, {
          task: toolCall('cezar_wait', kind === 'pr' ? { kind, pr } : { kind: 'timer', seconds: 600, note: 'u7m' }), runner,
        });
        if (family) await parentTurn(run.id, toolCall('cezar_wait', { kind: 'worker', worker_ids: [family.w.id], timeout_seconds: 600 }), () => workerWaits(run.id).length === 1);
        await until(() => parkedOn(run.id, waitOfKind(run.id, kind)));
        const wait = structuredClone(waitOfKind(run.id, kind)!);
        const marker = messagesPrompt(runner, ['Still checking.\nCEZ:MONITORING']);
        await parentTurn(run.id, marker, () => parkedOn(run.id, waitOfKind(run.id, kind)) === true);
        expect(store.getRun(run.id)?.waits).toEqual([wait]);
        expect(readPersistedRuns(join(root, '.ai/cezar')).find(row => row.id === run.id)?.waits).toEqual([wait]);
        // An existing wait is still sufficient when automatic re-checks are disabled.
        const interval = vi.spyOn(semaphore, 'monitoringWakeIntervalMinutes').mockReturnValue(null);
        await parentTurn(run.id, marker, () => parkedOn(run.id, waitOfKind(run.id, kind)) === true);
        expect(store.getRun(run.id)?.waits).toEqual([wait]);
        expect(humanOpen(run.id)).toEqual([]);
        interval.mockRestore();
        const budget = vi.spyOn(manager as unknown as { automaticWakes(id: string): number }, 'automaticWakes').mockReturnValue(MAX_AUTO_CONTINUES);
        await parentTurn(run.id, marker, () => parkedOn(run.id, waitOfKind(run.id, kind)) === true);
        expect(store.getRun(run.id)?.waits).toEqual([wait]);
        expect(humanOpen(run.id)).toEqual([]);
        budget.mockRestore();
        if (kind === 'timer') {
          await restart();
          expect(manager.isActive(run.id)).toBe(false);
          expect(store.getRun(run.id)?.waits).toEqual([wait]);
          fireTimer(wait.id);
        } else if (family) fixtureUpdateRun(family.w.id, { status: 'done' });
        else external.settle();
        await until(() => settled(run.id, wait.id)?.phase === 'delivered');
        expect(inputsFor(run.id, wait.id)).toHaveLength(1);
        await until(() => store.getRun(run.id)?.status === 'waiting');
      });
    }

    it(`${runner} U7f the monitoring line alone opens an identifiable timer and keeps its deadline`, async () => {
      nativeWire(runner);
      const marker = messagesPrompt(runner, ['Still checking.\nCEZ:MONITORING']);
      const run = manager.startRun(QUICK_TASK_WORKFLOW, { task: marker, runner });
      await until(() => parkedOn(run.id, viaOf(run.id, 'monitoring-line')));
      const timer = structuredClone(viaOf(run.id, 'monitoring-line')!);
      expect(timer).toMatchObject({ kind: 'timer', seconds: 300, note: 'Opened by CEZ:MONITORING.' });
      await parentTurn(run.id, marker, () => parkedOn(run.id, viaOf(run.id, 'monitoring-line')) === true);
      expect(store.getRun(run.id)?.waits).toEqual([timer]);
      expect(readPersistedRuns(join(root, '.ai/cezar')).find(row => row.id === run.id)?.waits).toEqual([timer]);
      fireTimer(timer.id);
      await until(() => settled(run.id, timer.id)?.phase === 'delivered');
      expect(inputsFor(run.id, timer.id)).toHaveLength(1);
      await until(() => store.getRun(run.id)?.status === 'waiting');
    });

    for (const kind of ['pr', 'timer'] as const) {
      it(`${runner} U8 a ${kind} park keeps its slot and wakes without queueing at maxParallel 1`, async () => {
        const external = github();
        nativeWire(runner);
        expect(semaphore.maxParallel()).toBe(1);
        const request = kind === 'pr' ? { kind, pr } : { kind, seconds: 60, note: 'u8' };
        // These live mock servers must not overwrite each other's session JSON. U8 never
        // restarts either server; keep their shared args file for native prompt assertions.
        if (runner === 'opencode') process.env.CEZ_MOCK_OPENCODE_SESSIONS_FILE = join(root, 'u8-parked-sessions.json');
        const task = toolCall('cezar_wait', request);
        const parked = manager.startRun(QUICK_TASK_WORKFLOW, { task, runner });
        // bound: Keep the fixture's 15s native-wire hang guard per stage. The six-burner
        // Node floor reproduction exceeded it across server and tool startup combined
        // (hearsay-tools/cezarion#1298); native prompt receipt separates those stages.
        checkpoint(`u8-parked-native-prompt:${parked.id}`);
        await until(() => prompted(runner, task).length > 0, () => timeline(parked.id));
        checkpoint(`u8-parked-waiting:${parked.id}`);
        await until(() => parkedOn(parked.id, waitOfKind(parked.id, kind)), () => timeline(parked.id));
        const wait = waitOfKind(parked.id, kind)!;
        // The only regular slot goes to a turn held open until this test releases it.
        const release = join(root, 'u8-release');
        process.env.CEZ_MOCK_RELEASE_FILE = release;
        // parkedOn above proves the first child already inherited its own store path.
        if (runner === 'opencode') process.env.CEZ_MOCK_OPENCODE_SESSIONS_FILE = join(root, 'u8-blocker-sessions.json');
        const blocker = manager.startRun(QUICK_TASK_WORKFLOW, { task: HARNESS_ADAPTERS[runner].scenarios['hold-gated']!, runner });
        try {
          checkpoint(`u8-blocker-started:${blocker.id}`);
          await until(() => store.readEvents(blocker.id).some(event => event.type === 'turn.started'));
          const queue = (manager as unknown as { queue: string[] }).queue;
          const push = vi.spyOn(queue, 'push');
          checkpoint('u8-wake-delivered');
          if (kind === 'pr') external.settle(); else fireTimer(wait.id);
          await until(() => settled(parked.id, wait.id)?.phase === 'delivered');
          expect(store.getRun(blocker.id)?.status).toBe('running');
          expect(push.mock.calls.flat()).not.toContain(parked.id);
        } finally { writeFileSync(release, ''); }
        checkpoint('u8-blocker-waiting');
        await until(() => store.getRun(blocker.id)?.status === 'waiting');
        checkpoint('u8-parked-waiting-after-wake');
        await until(() => store.getRun(parked.id)?.status === 'waiting' && !agentWaits(parked.id).length);
      });
    }

    it(`${runner} U8l a wake of a started run takes the slot before an unstarted task that queued earlier, at maxParallel 1`, async () => {
      nativeWire(runner);
      expect(semaphore.maxParallel()).toBe(1);
      if (runner === 'opencode') process.env.CEZ_MOCK_OPENCODE_SESSIONS_FILE = join(root, 'u8l-parked-sessions.json');
      const parked = manager.startRun(QUICK_TASK_WORKFLOW, { task: toolCall('cezar_wait', { kind: 'timer', seconds: 60, note: 'u8l' }), runner });
      await until(() => parkedOn(parked.id, waitOfKind(parked.id, 'timer')));
      const wait = waitOfKind(parked.id, 'timer')!;
      // A closed session: its wake is a scheduler continuation, which needs a regular slot.
      engine().active.get(parked.id)!.session.end();
      await until(() => !manager.isActive(parked.id) && store.getRun(parked.id)?.status === 'waiting');
      const release = join(root, 'u8l-release');
      process.env.CEZ_MOCK_RELEASE_FILE = release;
      if (runner === 'opencode') process.env.CEZ_MOCK_OPENCODE_SESSIONS_FILE = join(root, 'u8l-blocker-sessions.json');
      const blocker = manager.startRun(QUICK_TASK_WORKFLOW, { task: HARNESS_ADAPTERS[runner].scenarios['hold-gated']!, runner });
      let task: { id: string } | undefined;
      try {
        await until(() => store.readEvents(blocker.id).some(event => event.type === 'turn.started'));
        // Queued before the wake joins the line.
        task = manager.startRun(QUICK_TASK_WORKFLOW, { task: HARNESS_ADAPTERS[runner].scenarios.baseline!, runner });
        expect(store.getRun(task.id)?.status).toBe('queued');
        fireTimer(wait.id);
        await until(() => engine().queue.includes(parked.id));
        expect(engine().queue.indexOf(task.id)).toBeLessThan(engine().queue.indexOf(parked.id));
      } finally { writeFileSync(release, ''); }
      await until(() => settled(parked.id, wait.id)?.phase === 'delivered');
      const deliveredAt = Date.parse(settled(parked.id, wait.id)!.deliveredAt!);
      await until(() => store.readEvents(task!.id).some(event => event.type === 'turn.started'));
      const taskStarted = Date.parse(store.readEvents(task.id).find(event => event.type === 'turn.started')!.ts);
      expect(taskStarted).toBeGreaterThanOrEqual(deliveredAt);
      await until(() => terminal.includes(store.getRun(task!.id)?.status ?? '') || store.getRun(task!.id)?.status === 'waiting');
    });

    for (const hold of ['deadline', 'in-flight'] as const) {
      it(`${runner} U8h a ci result for a park on a held account waits in the line and is delivered once the hold lifts (${hold})`, async () => {
        const external = github();
        nativeWire(runner);
        if (runner === 'opencode') process.env.CEZ_MOCK_OPENCODE_SESSIONS_FILE = join(root, 'u8h-sessions.json');
        const parked = manager.startRun(QUICK_TASK_WORKFLOW, { task: toolCall('cezar_wait', { kind: 'pr', pr }), runner });
        await until(() => parkedOn(parked.id, waitOfKind(parked.id, 'pr')));
        const wait = waitOfKind(parked.id, 'pr')!;
        expect(engine().monitoring.has(parked.id)).toBe(true);
        // Another task on the same account waits out a usage limit, or its resume is testing the
        // window (hearsay-tools/cezarion#1236).
        const { agentProfile } = store.getRun(parked.id)!;
        const holder = store.createRun({ title: 'held', workflow: 'quick-task', task: 'held', steps: [] });
        store.updateRun(holder.id, hold === 'deadline'
          ? { status: 'waiting', runner, agentProfile, autoResumeAt: new Date(Date.now() + 600_000).toISOString() }
          : { status: 'running', runner, agentProfile, autoResumeAttempts: 1 });
        expect([...manager.accountHolds()[hold === 'deadline' ? 'deadline' : 'inFlight']]).toContain(`${runner}:${agentProfile ?? 'default'}`);
        external.settle();
        // The result waits in the line, undelivered, while the account is held.
        await until(() => store.getRun(parked.id)?.waits?.find(entry => entry.id === wait.id)?.phase === 'resolved' && engine().queue.includes(parked.id));
        expect(settled(parked.id, wait.id)).toBeUndefined();
        if (hold === 'deadline') manager.cancelAutoResume(holder.id);
        else { store.updateRun(holder.id, { status: 'failed', autoResumeAttempts: undefined }); manager.cancelAutoResume(holder.id); }
        await until(() => settled(parked.id, wait.id)?.phase === 'delivered');
        await until(() => store.getRun(parked.id)?.status === 'waiting' && !agentWaits(parked.id).length);
      });
    }

    it(`${runner} U10 timer wakes stop at the automatic-wake budget; one admitted turn is charged once`, async () => {
      nativeWire(runner);
      const release = join(root, 'u10-release');
      process.env.CEZ_MOCK_RELEASE_FILE = release;
      const run = manager.startRun(QUICK_TASK_WORKFLOW, { task: HARNESS_ADAPTERS[runner].scenarios['hold-gated']!, runner });
      await until(() => store.readEvents(run.id).some(event => event.type === 'turn.started'));
      const tools = manager.cezarToolHandlers(run.id, engine().active.get(run.id)!.ciGeneration);
      const open = async (seconds: number, note: string) => {
        const registered = await tools.registerWait({ kind: 'timer', seconds, note }, 'cezar_wait', new AbortController().signal);
        if (!('wait' in registered)) throw Error('registration refused');
        return registered.wait;
      };
      const first = await open(60, 'u10 first'), second = await open(61, 'u10 second'), last = await open(62, 'u10 last');
      store.updateRun(run.id, { automaticWakes: 39, waitDeliveryFailures: 2 });
      // What a crash after any commit would leave (hearsay-tools/cezarion#1805): every committed row.
      const commits = recordCommits(join(root, '.ai/cezar'));
      // Two timers resolve before one boundary: one admitted turn carries both and spends one wake.
      fireTimer(first.id); fireTimer(second.id);
      await until(() => store.getRun(run.id)?.waits?.filter(wait => wait.phase === 'resolved').length === 2);
      writeFileSync(release, '');
      await until(() => settled(run.id, first.id)?.phase === 'delivered' && settled(run.id, second.id)?.phase === 'delivered');
      await until(() => prompted(runner, timerText(first, 'u10 first')).length > 0);
      expect(prompted(runner, timerText(first, 'u10 first')).at(-1)).toContain(timerText(second, 'u10 second'));
      expect(store.getRun(run.id)?.automaticWakes).toBe(40);
      const charged = store.readEvents(run.id).filter(event => event.type === 'note' && String(event.message).startsWith('automatic timer wake-up ('));
      expect(charged.map(event => event.message)).toEqual(['automatic timer wake-up (40/40)']);
      // The delivery, its charge and the cleared failure count are one commit: no committed row
      // holds a delivered timer without its charge.
      commits.expectEveryCommit(run.id, row => !row.lastWaits?.some(wait => [first.id, second.id].includes(wait.id) && wait.phase === 'delivered') ||
        (row.automaticWakes === 40 && row.waitDeliveryFailures === undefined && row.lastWaits.filter(wait => wait.phase === 'delivered').length === 2), 'a delivered timer and its charge');
      expect(commits.rows(run.id).some(row => row?.lastWaits?.some(wait => wait.id === first.id && wait.phase === 'delivered'))).toBe(true);
      await until(() => parkedOn(run.id, store.getRun(run.id)?.waits?.find(wait => wait.id === last.id)));
      const turns = turnEnds(run.id);
      // The budget is spent: the next timer to come due is cancelled and wakes nothing.
      fireTimer(last.id);
      await until(() => settled(run.id, last.id)?.phase === 'cancelled');
      await flushMicrotasks();
      expect(inputsFor(run.id, last.id)).toEqual([]);
      expect(prompted(runner, `Timer ${last.id} fired`)).toEqual([]);
      expect(turnEnds(run.id)).toBe(turns);
      expect(store.readEvents(run.id).some(event => event.type === 'note' && event.message === `automatic timer wake-up cap reached (40); timer ${last.id} cancelled`)).toBe(true);
      // hearsay-tools/cezarion#1234: the spent budget leaves a cezar human wait, so the run waits on the user.
      expect(store.getRun(run.id)?.waits ?? []).toMatchObject([{ kind: 'human', via: 'budget', source: 'cezar', phase: 'open' }]);
      expect(deriveAttention(store.getRun(run.id)!).label).toBe('needs you');
      expect(engine().monitoring.has(run.id)).toBe(false);
    });

    it(`${runner} U10 a timer due while a charged batch awaits its acknowledgement is cancelled at the cap, and CI still wakes`, async () => {
      const external = github();
      nativeWire(runner);
      const run = manager.startRun(QUICK_TASK_WORKFLOW, { task: HARNESS_ADAPTERS[runner].scenarios.baseline!, runner });
      await until(() => store.getRun(run.id)?.status === 'waiting');
      const tools = manager.cezarToolHandlers(run.id, engine().active.get(run.id)!.ciGeneration);
      const open = async (request: Parameters<typeof tools.registerWait>[0]) => {
        const registered = await tools.registerWait(request, 'cezar_wait', new AbortController().signal);
        if (!('wait' in registered)) throw Error('registration refused');
        return registered.wait;
      };
      const first = await open({ kind: 'timer', seconds: 60, note: 'u10 first' });
      const second = await open({ kind: 'timer', seconds: 61, note: 'u10 second' });
      const ci = await open({ kind: 'pr', pr, timeout_seconds: 600 });
      const state = engine().active.get(run.id)!;
      store.updateRun(run.id, { automaticWakes: 39 });
      // The first wake reaches the native wire; its provider acknowledgement is held.
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const send = state.session.sendAgentMessage.bind(state.session);
      vi.spyOn(state.session, 'sendAgentMessage').mockImplementation((content, ids) => {
        const ack = send(content, ids);
        return ack && ack.then(() => gate);
      });
      fireTimer(first.id);
      await until(() => prompted(runner, timerText(first, 'u10 first')).length > 0);
      expect(settled(run.id, first.id)).toBeUndefined();
      // The pending batch already holds the last wake of the budget.
      fireTimer(second.id);
      await until(() => settled(run.id, second.id)?.phase === 'cancelled');
      expect(inputsFor(run.id, second.id)).toEqual([]);
      release();
      await until(() => settled(run.id, first.id)?.phase === 'delivered');
      expect(store.getRun(run.id)?.automaticWakes).toBe(40);
      const notes = () => store.readEvents(run.id).filter(event => event.type === 'note').map(event => String(event.message));
      expect(notes().filter(note => note.startsWith('automatic timer wake-up ('))).toEqual(['automatic timer wake-up (40/40)']);
      expect(notes()).toContain(`automatic timer wake-up cap reached (40); timer ${second.id} cancelled`);
      expect(prompted(runner, `Timer ${second.id} fired`)).toEqual([]);
      // A CI result is an external event: it still wakes the agent at the cap and is not charged.
      await until(() => parkedOn(run.id, waitOfKind(run.id, 'pr')));
      external.settle();
      await until(() => settled(run.id, ci.id)?.phase === 'delivered' && prompted(runner, `CI wait observation ${ci.id}`).length > 0);
      expect(store.getRun(run.id)?.automaticWakes).toBe(40);
    });

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
    // absence shows at once, and no admission retry or backoff is left to start one later.
    const expectNoWakeFor = (id: string) => {
      expect(store.getRun(id)?.status).toBe('failed');
      expect(manager.isActive(id)).toBe(false);
      expect(engine().queue).not.toContain(id);
      expect(engine().wakeRetries.has(id)).toBe(false);
      expect(engine().wakeBackoffs.has(id)).toBe(false);
    };
    async function timerWaits(id: string) {
      const tools = manager.cezarToolHandlers(id, engine().active.get(id)!.ciGeneration);
      const timerWait = async (seconds: number, note: string) => {
        const registered = await tools.registerWait({ kind: 'timer', seconds, note }, 'cezar_wait', new AbortController().signal);
        if (!('wait' in registered)) throw Error('registration refused');
        return registered.wait;
      };
      return { timer: await timerWait(60, 'u14'), later: await timerWait(7200, 'u14 later') };
    }
    /** Continue delivers every held result once, and the run parks and finishes as usual. */
    async function continueDelivers(id: string, timer: Wait, later: Wait) {
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

    // hearsay-tools/cezarion#1234: the budget is on the record, so a new session does not refill it.
    it(`${runner} U16 a scheduler continuation keeps the automatic-wake budget and a human Continue resets it`, async () => {
      nativeWire(runner);
      const run = manager.startRun(QUICK_TASK_WORKFLOW, { runner, task: HARNESS_ADAPTERS[runner].scenarios.baseline! });
      await until(() => store.getRun(run.id)?.status === 'waiting');
      const { timer } = await timerWaits(run.id);
      store.updateRun(run.id, { automaticWakes: 39 });
      engine().active.get(run.id)!.session.end();
      await until(() => !manager.isActive(run.id));
      fireTimer(timer.id);
      await until(() => settled(run.id, timer.id)?.phase === 'delivered');
      expect(store.getRun(run.id)?.automaticWakes).toBe(40);
      expect(store.readEvents(run.id).filter(event => event.type === 'note' && String(event.message).startsWith('automatic timer wake-up ('))
        .map(event => event.message)).toEqual(['automatic timer wake-up (40/40)']);
      await until(() => store.getRun(run.id)?.status === 'waiting' && manager.isActive(run.id));
      const tools = manager.cezarToolHandlers(run.id, engine().active.get(run.id)!.ciGeneration);
      const refused = await tools.registerWait({ kind: 'timer', seconds: 60 }, 'cezar_wait', new AbortController().signal);
      expect(refused.answer).toMatchObject({ ok: false, code: 'wake_budget_spent' });
      engine().active.get(run.id)!.session.end();
      await until(() => !manager.isActive(run.id));
      expect(manager.continueRun(run.id, { text: 'carry on' }).ok).toBe(true);
      expect(store.getRun(run.id)?.automaticWakes).toBe(0);
      await until(() => store.getRun(run.id)?.status === 'waiting');
      expect(manager.finish(run.id)).toBe(true);
      await until(() => terminal.includes(store.getRun(run.id)?.status ?? ''));
    });

    // Recovery fires an overdue timer before any session exists. At the spent budget it wakes
    // nothing, and once no wait is left the run must still wait on the user through a wait.
    it(`${runner} U16b timers due at the spent budget with no live session are cancelled, and the last one opens a budget human wait the user answers`, async () => {
      nativeWire(runner);
      const run = manager.startRun(QUICK_TASK_WORKFLOW, { runner, task: HARNESS_ADAPTERS[runner].scenarios.baseline! });
      await until(() => store.getRun(run.id)?.status === 'waiting');
      const { timer, later } = await timerWaits(run.id);
      store.updateRun(run.id, { automaticWakes: MAX_AUTO_CONTINUES });
      engine().active.get(run.id)!.session.end();
      await until(() => !manager.isActive(run.id));
      fireTimer(timer.id);
      await until(() => settled(run.id, timer.id)?.phase === 'cancelled');
      // The other timer is still open: the run waits on it, not on the user.
      expect(humanOpen(run.id)).toEqual([]);
      fireTimer(later.id);
      await until(() => settled(run.id, later.id)?.phase === 'cancelled' && humanOpen(run.id)[0]?.askSeq !== undefined);
      expect(humanOpen(run.id)).toMatchObject([{ via: 'budget', source: 'cezar', phase: 'open' }]);
      expect(store.getRun(run.id)?.status).toBe('waiting');
      expect(deriveAttention(store.getRun(run.id)!).label).toBe('needs you');
      expect(manager.isActive(run.id)).toBe(false);
      const [budget] = humanOpen(run.id);
      const commits = recordCommits(join(root, '.ai/cezar'));
      expect(manager.continueRun(run.id, { text: 'carry on' }).ok).toBe(true);
      await until(() => settled(run.id, budget!.id)?.phase === 'delivered');
      expect(store.getRun(run.id)?.automaticWakes ?? 0).toBe(0);
      // hearsay-tools/cezarion#1805: the restarted budget and the answered wait are committed with
      // the Continue they come from, never before it.
      const step = store.getRun(run.id)!.steps.at(-1)!.id;
      commits.expectEveryCommit(run.id, row => {
        return (row.automaticWakes === MAX_AUTO_CONTINUES && !row.lastWaits?.some(wait => wait.id === budget!.id && wait.phase === 'delivered')) ||
          row.continuationMessage?.text === 'carry on' || row.steps.some(entry => entry.id === step && entry.status !== 'pending');
      }, 'a restarted budget and its Continue');
      await until(() => store.getRun(run.id)?.status === 'waiting' && manager.isActive(run.id));
      expect(manager.finish(run.id)).toBe(true);
      await until(() => terminal.includes(store.getRun(run.id)?.status ?? ''));
    });

    // Clearing the wake counters is bookkeeping: a refused write may not stop a cleanup from
    // stopping the run.
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
      nativeWire(runner);
      const failure = persistentWakeFailure(root, runner);
      retryAtOnce();
      const run = manager.startRun(QUICK_TASK_WORKFLOW, { runner, task: HARNESS_ADAPTERS[runner].scenarios.baseline! });
      await until(() => store.getRun(run.id)?.status === 'waiting');
      const { timer, later } = await timerWaits(run.id);
      engine().active.get(run.id)!.session.end();
      await until(() => !manager.isActive(run.id));
      fireTimer(timer.id);
      await until(() => store.getRun(run.id)?.status === 'failed' && !manager.isActive(run.id));
      // Each attempt is a scheduler continuation whose opening prompt the provider fails.
      expect(prompted(runner, TIMER_WAKE_OPENING)).toHaveLength(MAX_WAKE_DELIVERY_ATTEMPTS);
      expectHeldAtTheBound(run.id, timer.id);
      // A wait that resolves on the failed run stays resolved and wakes nothing.
      fireTimer(later.id);
      expect(store.getRun(run.id)?.waits?.find(wait => wait.id === later.id)?.phase).toBe('resolved');
      expectNoWakeFor(run.id);
      failure.lift();
      await continueDelivers(run.id, timer, later);
    });

    it(`${runner} U14 a session that keeps closing cleanly before its wait result is delivered stops at the delivery bound, the run fails keeping its result, and Continue delivers it once`, async () => {
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
        if (store.getRun(run.id)?.waits?.find(wait => wait.id === timer.id)?.phase === 'resolved') engine().active.get(run.id)?.session.end();
      };
      store.on('event', closeAtTurnEnd);
      try {
        expect(manager.sendMessage(run.id, [{ type: 'text', text: 'Check the deploy.' }])).toBe(true);
        await until(() => store.getRun(run.id)?.status === 'failed' && !manager.isActive(run.id));
        // The original session and two continuations, none of which received the result.
        expect(prompted(runner, TIMER_WAKE_OPENING)).toHaveLength(MAX_WAKE_DELIVERY_ATTEMPTS - 1);
        expect(prompted(runner, `Timer ${timer.id} fired`)).toEqual([]);
        expectHeldAtTheBound(run.id, timer.id, { error: `continue failed: ${WAKE_SESSION_CLOSED_ERROR}`, failed: 1 });
        expect(store.getRun(run.id)?.steps.at(-1)).toMatchObject({ status: 'failed', error: WAKE_SESSION_CLOSED_ERROR });
        fireTimer(later.id);
        expect(store.getRun(run.id)?.waits?.find(wait => wait.id === later.id)?.phase).toBe('resolved');
        expectNoWakeFor(run.id);
        closing = false;
        await continueDelivers(run.id, timer, later);
      } finally {
        store.off('event', closeAtTurnEnd);
      }
    });

    it(`${runner} U14 Stop on a failed run holding wait results at the delivery bound discards every wait, starts nothing, leaves the run failed, and a later Continue delivers none of them`, async () => {
      nativeWire(runner);
      const failure = persistentWakeFailure(root, runner);
      retryAtOnce();
      const run = manager.startRun(QUICK_TASK_WORKFLOW, { runner, task: HARNESS_ADAPTERS[runner].scenarios.baseline! });
      await until(() => store.getRun(run.id)?.status === 'waiting');
      const { timer, later } = await timerWaits(run.id);
      engine().active.get(run.id)!.session.end();
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
      expect(engine().waitTimers.has(later.id)).toBe(false);
      expect(store.getRun(run.id)?.waitDeliveryFailures).toBeUndefined();
      expectNoWakeFor(run.id);
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

    it(`${runner} U11 an alias timer open at a blocked done keeps its deadline, the run parks on it with the refusal as a note and no nudge, and its result is delivered`, async () => {
      nativeWire(runner);
      // Workers run on the Claude wire whatever the parent's runner is.
      process.env.CEZ_CLAUDE_BIN = HARNESS_ADAPTERS.claude.mockBin;
      const p = await parent(HARNESS_ADAPTERS[runner].scenarios.baseline!, runner);
      await until(() => store.getRun(p.id)?.status === 'waiting');
      let turns = turnEnds(p.id);
      expect(manager.sendMessage(p.id, [{ type: 'text', text: messagesPrompt(runner, ['Still checking.\nCEZ:MONITORING']) }])).toBe(true);
      await until(() => turnEnds(p.id) > turns && parkedOn(p.id, viaOf(p.id, 'monitoring-line')));
      const timer = viaOf(p.id, 'monitoring-line')!;
      const w = await worker(p.id);
      turns = turnEnds(p.id);
      // hearsay-tools/cezarion#1301: a refused done is not a done and cancels no wait. With the timer
      // open there is no nudge: the run parks on the timer, and the refusal is a note.
      expect(manager.sendMessage(p.id, [{ type: 'text', text: messagesPrompt(runner, ['All done.\nCEZ:DONE']) }])).toBe(true);
      const refusal = `Workers are still live: ${w.id}.`;
      await until(() => turnEnds(p.id) > turns && parkedOn(p.id, viaOf(p.id, 'monitoring-line')) &&
        store.readEvents(p.id).some(event => event.type === 'note' && String(event.message).includes(refusal)));
      expect(store.getRun(p.id)?.waits).toEqual([expect.objectContaining({ id: timer.id, phase: 'open', deadline: timer.deadline })]);
      expect(waitOf(store.getRun(p.id))).toBeUndefined();
      expect(store.getRun(p.id)?.delegation).not.toHaveProperty('completion');
      expect(store.readEvents(p.id).some(event => event.type === 'note' && String(event.message).startsWith(COMPLETION_NUDGE_NOTE))).toBe(false);
      expect(prompted(runner, refusal)).toEqual([]);
      // A timer park keeps its slot, and the timer's result wakes the agent.
      expect(engine().monitoring.has(p.id)).toBe(true);
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
        const run = manager.startRun(QUICK_TASK_WORKFLOW, { runner, task: HARNESS_ADAPTERS[runner].scenarios['provider-error']! });
        await until(wire.held);
        const tools = manager.cezarToolHandlers(run.id, engine().active.get(run.id)!.ciGeneration);
        const request = kind === 'pr' ? { kind, pr, timeout_seconds: 30 } as const : { kind, seconds: 60, note: 'u9' } as const;
        const registered = await tools.registerWait(request, 'cezar_wait', new AbortController().signal);
        expect(registered.answer).toMatchObject({ ok: true, kind });
        if (!('wait' in registered)) throw Error('registration refused');
        const wait = registered.wait;
        const failedState = engine().active.get(run.id);
        wire.release();
        await until(() => store.readEvents(run.id).some(event => event.type === 'error'));
        await until(() => engine().active.get(run.id) !== failedState);
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
        const tools = manager.cezarToolHandlers(run.id, engine().active.get(run.id)!.ciGeneration);
        const request = kind === 'pr' ? { kind, pr, timeout_seconds: 30 } as const : { kind, seconds: 60, note: 'u9' } as const;
        const registered = await tools.registerWait(request, 'cezar_wait', new AbortController().signal);
        if (!('wait' in registered)) throw Error('registration refused');
        const wait = registered.wait;
        engine().active.get(run.id)!.session.end();
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

    it(`${runner} U7h the ask line opens a human wait in the same wait list`, async () => {
      nativeWire(runner);
      const run = manager.startRun(QUICK_TASK_WORKFLOW, { task: HARNESS_ADAPTERS[runner].scenarios.baseline!, runner });
      await until(() => store.getRun(run.id)?.status === 'waiting');
      expect(manager.sendMessage(run.id, [{ type: 'text', text: messagesPrompt(runner, [ASK_TEXT]) }])).toBe(true);
      const wait = await expectHumanWaitAnswered(run.id, 'ask-line');
      expect(wait.questions).toMatchObject(questions);
    });

    it(`${runner} U7h cezar_ask, an open question included, opens a human wait in the same wait list`, async () => {
      nativeWire(runner);
      // The open question has no options: the card crosses this runner's wire without them.
      const card = [...questions, { header: 'Name', question: 'What should the command be called?' }];
      const run = manager.startRun(QUICK_TASK_WORKFLOW, { task: toolCall('cezar_ask', { context: ASK_CONTEXT, questions: card }), runner });
      const wait = await expectHumanWaitAnswered(run.id, 'cezar_ask');
      expect(wait).toMatchObject({ source: 'agent', questions: card });
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

    it(`${runner} U7h a native ask opens a human wait in the same wait list`, async () => {
      nativeWire(runner);
      const run = manager.startRun(QUICK_TASK_WORKFLOW, { task: HARNESS_ADAPTERS[runner].scenarios.ask!, runner });
      if (exemptionFor('U7h', runner)) {
        // capability-absent: this wire's ask scenario is the portable line, so the alias opens it.
        expect(exemptionFor('U7h', runner)?.reason).toBe('native ask arrives as the portable marker on this wire');
        await expectHumanWaitAnswered(run.id, 'ask-line');
        return;
      }
      await expectHumanWaitAnswered(run.id, 'native-ask');
    });

    // A valid ask line later in the turn replaces the card; a boundary the turn end re-enters
    // (Cursor print's discardQueuedMessages) must show the later card too.
    it(`${runner} U7h a later ask line in the same turn replaces the cezar_ask card`, async () => {
      nativeWire(runner);
      const first = [{ header: 'Parser', question: 'Which parser?', options: [{ label: 'Peg' }, { label: 'Lalr' }] }];
      const run = manager.startRun(QUICK_TASK_WORKFLOW, { task: `${toolCall('cezar_ask', { context: ASK_CONTEXT, questions: first })} ${thenSay(ASK_TEXT)}`, runner });
      const wait = await expectHumanWaitAnswered(run.id, 'cezar_ask');
      expect(wait.questions).toMatchObject(questions);
      expect(asks(run.id)[0]).toMatchObject({ questions });
      // The ask line carries no context, so the replaced card's context goes with it (#1458).
      expect(wait).not.toHaveProperty('context');
      expect(asks(run.id)[0]).not.toHaveProperty('context');
    });

    // The Continue's answer settles the question it answers, never one its own turn asks.
    it(`${runner} U7h a Continue that answers one question and asks the next keeps the next one open`, async () => {
      nativeWire(runner);
      const run = manager.startRun(QUICK_TASK_WORKFLOW, { task: toolCall('cezar_ask', { context: ASK_CONTEXT, questions }), runner });
      await until(() => pendingQuestion(run.id) && humanOpen(run.id)[0]?.askSeq !== undefined);
      const [first] = humanOpen(run.id);
      engine().active.get(run.id)!.session.end();
      await until(() => !manager.isActive(run.id));
      const next = [{ header: 'Runner', question: 'Which runner next?', options: [{ label: 'Codex' }, { label: 'Pi' }] }];
      expect(manager.continueRun(run.id, { text: toolCall('cezar_ask', { context: ASK_CONTEXT, questions: next }) }).ok).toBe(true);
      await until(() => settled(run.id, first!.id)?.phase === 'delivered' && turnEnds(run.id) > 1 && store.getRun(run.id)?.status === 'waiting');
      const [second, ...more] = humanOpen(run.id);
      expect(more).toEqual([]);
      expect(second).toMatchObject({ phase: 'open', questions: next });
      expect(second!.id).not.toBe(first!.id);
      expect(asks(run.id)).toHaveLength(2);
      expect(second!.askSeq).toBe(asks(run.id)[1]!.seq);
      expect(deriveAttention(store.getRun(run.id)!).label).toBe('needs you');
    });

    it(`${runner} U9h provider failure with a human wait open leaves the run recoverable`, async () => {
      const wire = gatedProviderFailure(root, runner);
      const run = manager.startRun(QUICK_TASK_WORKFLOW, { runner, task: HARNESS_ADAPTERS[runner].scenarios['provider-error']! });
      await until(wire.held);
      const tools = manager.cezarToolHandlers(run.id, engine().active.get(run.id)!.ciGeneration);
      const registered = await tools.ask({ context: ASK_CONTEXT, questions }, new AbortController().signal);
      if (!registered.ok) throw Error('registration refused');
      // Registered mid-turn, so nothing is shown before the turn ends.
      expect(asks(run.id)).toEqual([]);
      const failedState = engine().active.get(run.id);
      wire.release();
      await until(() => store.readEvents(run.id).some(event => event.type === 'error'));
      await until(() => engine().active.get(run.id) !== failedState && pendingQuestion(run.id));
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
      const tools = manager.cezarToolHandlers(run.id, engine().active.get(run.id)!.ciGeneration);
      const registered = await tools.ask({ context: ASK_CONTEXT, questions }, new AbortController().signal);
      if (!registered.ok) throw Error('registration refused');
      // Registered at a boundary: the card is shown at once.
      await until(() => pendingQuestion(run.id) && asks(run.id).length === 1);
      engine().active.get(run.id)!.session.end();
      await until(() => !manager.isActive(run.id));
      expect(store.getRun(run.id)).toMatchObject({ status: 'waiting' });
      expect(hasPendingAsk(store, run.id)).toBe(true);
      expect(store.getRun(run.id)?.error).toBeUndefined();
      expect(humanOpen(run.id)).toMatchObject([{ id: registered.wait_id, askSeq: asks(run.id)[0]!.seq }]);
      expect(deriveAttention(store.getRun(run.id)!).label).toBe('needs you');
      expect(manager.continueRun(run.id, { text: answerOf(run.id) }).ok).toBe(true);
      await until(() => settled(run.id, registered.wait_id)?.phase === 'delivered' && answered(run.id, asks(run.id)[0]!.seq));
    });

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
      const accepted = await turn(`${toolCall('cezar_wait', { kind: 'pr', pr })} ${toolCall('cezar_done', {})}`);
      const ci = store.getRun(p.id)?.lastWaits?.find(wait => wait.kind === 'pr');
      expect(accepted).toMatchObject({ ok: true, finishes: 'at_turn_end' });
      expect(accepted.open_waits).toEqual(expect.arrayContaining([expect.objectContaining({ wait_id: ci?.id, kind: 'pr' })]));
      await until(() => terminal.includes(store.getRun(p.id)?.status ?? '') && !manager.isActive(p.id));
      expect(ci).toMatchObject({ phase: 'cancelled', via: 'cezar_wait' });
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
      const closings = store.readEvents(run.id).filter(event => event.type === 'lifecycle' && /session closed$/.test(String(event.message)));
      expect(closings).toEqual([expect.objectContaining({ message: 'step complete — session closed', via: 'cezar_done' })]);
      expect(store.readEvents(run.id).some(event => event.type === 'note' && event.message === 'step shipped')).toBe(true);
    });

    it(`${runner} U7d the done line and cezar_done finish through the same path`, async () => {
      nativeWire(runner);
      const closings = (id: string) => store.readEvents(id).filter(event => event.type === 'lifecycle' && event.message === 'goal achieved — session closed');
      const finished = (id: string) => terminal.includes(store.getRun(id)?.status ?? '') && !manager.isActive(id);
      const finish = async (text: string) => {
        const run = manager.startRun(QUICK_TASK_WORKFLOW, { task: HARNESS_ADAPTERS[runner].scenarios.baseline!, runner });
        await until(() => store.getRun(run.id)?.status === 'waiting');
        expect(manager.sendMessage(run.id, [{ type: 'text', text }])).toBe(true);
        await until(() => finished(run.id));
        return run.id;
      };
      const line = await finish(messagesPrompt(runner, ['All done.\nCEZ:DONE']));
      const tool = await finish(toolCall('cezar_done', { summary: 'u7d shipped' }));
      expect(store.getRun(tool)!.status).toBe(store.getRun(line)!.status);
      expect(closings(line)).toEqual([expect.objectContaining({ via: 'done-line' })]);
      expect(closings(tool)).toEqual([expect.objectContaining({ via: 'cezar_done' })]);
      // The summary is the note right before the closing event; the done line has none.
      const events = store.readEvents(tool);
      expect(events[events.findIndex(event => event.seq === closings(tool)[0]!.seq) - 1]).toMatchObject({ type: 'note', message: 'u7d shipped' });
      expect(store.readEvents(line).some(event => event.type === 'note' && event.message === 'u7d shipped')).toBe(false);
      // A Continue turn finishes through the same path on its own handler.
      expect(manager.continueRun(tool, { text: toolCall('cezar_done', {}) }).ok).toBe(true);
      await until(() => closings(tool).length === 2 && finished(tool));
      expect(closings(tool).map(event => event.via)).toEqual(['cezar_done', 'cezar_done']);
      expect(store.getRun(tool)!.status).toBe(store.getRun(line)!.status);
    });

    // The answer a Continue opens with is no longer a pending question to cezar_done.
    it(`${runner} U7d a Continue that answers the question finishes through cezar_done`, async () => {
      nativeWire(runner);
      const answers = join(root, 'done-answers');
      process.env.CEZ_MOCK_CI_RESULT = answers;
      const run = manager.startRun(QUICK_TASK_WORKFLOW, { task: toolCall('cezar_ask', { context: ASK_CONTEXT, questions }), runner });
      await until(() => pendingQuestion(run.id) && humanOpen(run.id)[0]?.askSeq !== undefined);
      const [wait] = humanOpen(run.id);
      engine().active.get(run.id)!.session.end();
      await until(() => !manager.isActive(run.id));
      rmSync(answers, { force: true });
      // What a crash after any commit would leave (hearsay-tools/cezarion#1805): every committed row.
      const commits = recordCommits(join(root, '.ai/cezar'));
      const answer = toolCall('cezar_done', { summary: 'answered and shipped' });
      expect(manager.continueRun(run.id, { text: answer }).ok).toBe(true);
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
      expect(wait).toMatchObject({ kind: 'human', via: 'no-wait', source: 'cezar', phase: 'open' });
      expect(wait!.questions).toBeUndefined();
      expect(store.getRun(run.id)?.automaticWakes).toBe(1);
      expect(store.readEvents(run.id).filter(event => event.type === 'note' && event.message === NO_WAIT_NOTE)).toHaveLength(1);
      expect(toRunSummary(store.getRun(run.id)!).waitingOn).toEqual({ kind: 'human', shown: true });
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
    it(`${runner} U7q a deferred message that answers the question removes its queue entry in the answer's commit`, async () => {
      nativeWire(runner);
      const run = manager.startRun(QUICK_TASK_WORKFLOW, { task: toolCall('cezar_ask', { context: ASK_CONTEXT, questions }), runner });
      await until(() => pendingQuestion(run.id) && humanOpen(run.id)[0]?.askSeq !== undefined && store.getRun(run.id)?.status === 'waiting');
      const [wait] = humanOpen(run.id);
      const message = { id: randomUUID(), text: answerOf(run.id), createdAt: new Date().toISOString() };
      store.commitHumanMessageBesideWaits(run.id, message);
      engine().deferredMessages.set(run.id, [{ content: [{ type: 'text', text: message.text }], messageId: message.id }]);
      const commits = recordCommits(join(root, '.ai/cezar'));
      engine().flushDeferred(run.id);
      await until(() => settled(run.id, wait!.id)?.phase === 'delivered' && answered(run.id, wait!.askSeq!));
      expect(store.getRun(run.id)?.queuedMessages ?? []).toEqual([]);
      expect(engine().deferredMessages.has(run.id)).toBe(false);
      commits.expectEveryCommit(run.id, row => !!row.lastWaits?.some(entry => entry.id === wait!.id && entry.phase === 'delivered') === !row.queuedMessages?.some(entry => entry.id === message.id),
        'a deferred answer and its queue entry');
      expect(manager.finish(run.id)).toBe(true);
      await until(() => terminal.includes(store.getRun(run.id)?.status ?? ''));
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
      expect(wait).toMatchObject({ source: 'agent', questions: [expect.objectContaining({ header: 'Next step' })] });
      expect(manager.finish(run.id)).toBe(true);
      await until(() => terminal.includes(store.getRun(run.id)?.status ?? ''));
    });

    // Finish answers Cezar's own human wait; it keeps the agent's question (the #151 guard).
    it(`${runner} U5c a root parked on its no-wait human wait is finished by the user, and an agent question still blocks it`, async () => {
      nativeWire(runner);
      const asRoot = (task: string) => {
        const run = manager.startRun(QUICK_TASK_WORKFLOW, { runner, task });
        store.commitDelegation([{ id: run.id, delegation: { role: 'root', permissions: ['spawn', 'wait'], receipts: [] } }]);
        return run;
      };
      const plain = asRoot(HARNESS_ADAPTERS[runner].scenarios.baseline!);
      await until(() => gated(plain.id));
      expect(humanOpen(plain.id)).toMatchObject([{ via: 'no-wait', source: 'cezar' }]);
      expect(manager.finishBlockedReason(plain.id)).toBeUndefined();
      expect(manager.finish(plain.id)).toBe(true);
      await until(() => store.getRun(plain.id)?.status === 'done' && !manager.isActive(plain.id));
      delete process.env.CEZ_MOCK_NUDGE_REPLY;
      const asked = asRoot(HARNESS_ADAPTERS[runner].scenarios.baseline!);
      await until(() => pendingQuestion(asked.id));
      expect(humanOpen(asked.id)).toMatchObject([{ via: 'cezar_ask', source: 'agent' }]);
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
      expect(noWait).toMatchObject({ via: 'no-wait', source: 'cezar' });
      expect(store.readEvents(run.id).find(event => event.seq === noWait.askSeq)).toMatchObject({ type: 'note', message: NO_WAIT_NOTE });
      expect(store.transcriptFacts(run.id).pendingGateSeq).toBeUndefined();
      expect(hasPendingAsk(store, run.id)).toBeFalsy();
      expect(deriveAttention(store.getRun(run.id)!).label).toBe('needs you');
      const tools = manager.cezarToolHandlers(run.id, engine().active.get(run.id)!.ciGeneration);
      const registered = await tools.registerWait({ kind: 'timer', seconds: 60, note: 'u5d' }, 'cezar_wait', new AbortController().signal);
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
      const finishParked = async (closeFirst: boolean) => {
        const run = manager.startRun(QUICK_TASK_WORKFLOW, { runner, task: HARNESS_ADAPTERS[runner].scenarios.baseline! });
        await until(() => pendingQuestion(run.id) && humanOpen(run.id)[0]?.askSeq !== undefined);
        const askSeq = store.transcriptFacts(run.id).pendingAsk!.seq;
        if (closeFirst) {
          engine().active.get(run.id)!.session.end();
          await until(() => !manager.isActive(run.id));
          expect(pendingQuestion(run.id)).toBe(true);
        }
        expect(manager.finish(run.id)).toBe(true);
        await until(() => terminal.includes(store.getRun(run.id)?.status ?? '') && !manager.isActive(run.id));
        const events = store.readEvents(run.id);
        expect(events.filter(event => event.type === 'human-ask-closed')).toEqual([expect.objectContaining({ askSeq, reason: 'finish' })]);
        expect(events.filter(event => event.type === 'human-input-delivered')).toEqual([]);
        expect(pendingAskOf(events)).toBeUndefined();
        expect(store.transcriptFacts(run.id).pendingGateSeq).toBeUndefined();
        expect(hasPendingAsk(store, run.id)).toBeFalsy();
      };
      await finishParked(false);
      await finishParked(true);
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
      expect(humanOpen(run.id)).toMatchObject([{ via: 'no-wait', source: 'cezar' }]);
      // Beside the monitoring line it raises no gate either: the run parks on the line's timer.
      expect(manager.sendMessage(run.id, [{ type: 'text', text: messagesPrompt(runner, [MONITORING_TEXT, 'Should I use Vitest?']) }])).toBe(true);
      await until(() => parkedOn(run.id, viaOf(run.id, 'monitoring-line')) || proseGates().length > 0);
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
      expect(humanOpen(run.id)).toMatchObject([{ kind: 'human', via: 'budget', source: 'cezar', phase: 'open' }]);
      expect(store.getRun(run.id)?.automaticWakes).toBe(MAX_AUTO_CONTINUES);
      expect(deriveAttention(store.getRun(run.id)!).label).toBe('needs you');
      expect(manager.finish(run.id)).toBe(true);
      await until(() => terminal.includes(store.getRun(run.id)?.status ?? ''));
    });
  }
}

function workersCells(runners: RunnerId[]): void {
  for (const runner of runners) {
    it(`${runner} U2w ci and worker open: the worker resolving wakes the agent with ci still open and in the footer, and the later ci result is delivered`, async () => {
      const external = github();
      const { p, w } = await parentWithWorker(runner);
      const opened = `${toolCall('cezar_wait', { kind: 'pr', pr })} ${toolCall('cezar_wait', { kind: 'worker', worker_ids: [w.id], timeout_seconds: 600 })}`;
      await parentTurn(p.id, opened, () => waitOfKind(p.id, 'pr')?.phase === 'open' && workerWaits(p.id)[0]?.phase === 'open');
      const ci = waitOfKind(p.id, 'pr')!, workers = workerWaits(p.id)[0]!;
      expect(workers).toMatchObject({ via: 'cezar_wait', source: 'agent', workerIds: [w.id] });
      const turns = turnEnds(p.id);
      fixtureUpdateRun(w.id, { status: 'done' });
      await until(() => settled(p.id, workers.id)?.phase === 'delivered' && prompted(runner, workerWake(workers)).length > 0);
      const wake = prompted(runner, workerWake(workers)).at(-1)!;
      expect(wake).toContain(`Still open: CI wait ${ci.id} for acme/repo#12`);
      expect(wake).not.toContain(`worker wait ${workers.id}`);
      expect(external.aborted()).toBe(false);
      await until(() => turnEnds(p.id) > turns && parkedOn(p.id, waitOfKind(p.id, 'pr')));
      expect(agentWaits(p.id)).toEqual([expect.objectContaining({ id: ci.id, phase: 'open' })]);
      external.settle();
      await until(() => settled(p.id, ci.id)?.phase === 'delivered' && prompted(runner, `CI wait observation ${ci.id}`).length > 0);
      expect(prompted(runner, `CI wait observation ${ci.id}`).at(-1)).not.toContain('Still open');
      expect(inputsFor(p.id, workers.id)).toHaveLength(1);
      await until(() => store.getRun(p.id)?.status === 'waiting' && !agentWaits(p.id).length);
    });

    it(`${runner} U2t timer and worker open: the timer resolving wakes the agent with the worker wait still open and in the footer, and the later worker result is delivered`, async () => {
      const { p, w } = await parentWithWorker(runner);
      const opened = `${toolCall('cezar_wait', { kind: 'worker', worker_ids: [w.id], timeout_seconds: 600 })} ${toolCall('cezar_wait', { kind: 'timer', seconds: 60, note: 'u2t' })}`;
      await parentTurn(p.id, opened, () => waitOfKind(p.id, 'timer')?.phase === 'open' && workerWaits(p.id)[0]?.phase === 'open');
      const timer = waitOfKind(p.id, 'timer')!, workers = workerWaits(p.id)[0]!;
      const turns = turnEnds(p.id);
      fireTimer(timer.id);
      await until(() => settled(p.id, timer.id)?.phase === 'delivered' && prompted(runner, timerText(timer, 'u2t')).length > 0);
      expect(prompted(runner, timerText(timer, 'u2t')).at(-1)).toContain(`Still open: worker wait ${workers.id} on 1 worker`);
      await until(() => turnEnds(p.id) > turns && parkedOn(p.id, workerWaits(p.id)[0]));
      // The turn end re-parks on the same entry: nothing re-registered it, nothing delivered it.
      expect(agentWaits(p.id)).toEqual([expect.objectContaining({ id: workers.id, phase: 'open', deadline: workers.deadline })]);
      expect(inputsFor(p.id, workers.id)).toEqual([]);
      fixtureUpdateRun(w.id, { status: 'done' });
      await until(() => settled(p.id, workers.id)?.phase === 'delivered' && prompted(runner, workerWake(workers)).length > 0);
      expect(prompted(runner, workerWake(workers)).at(-1)).not.toContain('Still open');
      await until(() => store.getRun(p.id)?.status === 'waiting' && !agentWaits(p.id).length);
    });

    it(`${runner} U2c ci and worker open: the ci result wakes the agent with the worker wait still open and in the footer, and the later worker result is delivered`, async () => {
      const external = github();
      const { p, w } = await parentWithWorker(runner);
      const opened = `${toolCall('cezar_wait', { kind: 'worker', worker_ids: [w.id], timeout_seconds: 600 })} ${toolCall('cezar_wait', { kind: 'pr', pr })}`;
      await parentTurn(p.id, opened, () => waitOfKind(p.id, 'pr')?.phase === 'open' && workerWaits(p.id)[0]?.phase === 'open');
      const ci = waitOfKind(p.id, 'pr')!, workers = workerWaits(p.id)[0]!;
      const turns = turnEnds(p.id);
      external.settle();
      await until(() => settled(p.id, ci.id)?.phase === 'delivered' && prompted(runner, `CI wait observation ${ci.id}`).length > 0);
      expect(prompted(runner, `CI wait observation ${ci.id}`).at(-1)).toContain(`Still open: worker wait ${workers.id} on 1 worker`);
      await until(() => turnEnds(p.id) > turns && parkedOn(p.id, workerWaits(p.id)[0]));
      // The turn end re-parks on the same entry: nothing re-registered it, nothing delivered it.
      expect(agentWaits(p.id)).toEqual([expect.objectContaining({ id: workers.id, phase: 'open', deadline: workers.deadline })]);
      expect(inputsFor(p.id, workers.id)).toEqual([]);
      fixtureUpdateRun(w.id, { status: 'done' });
      await until(() => settled(p.id, workers.id)?.phase === 'delivered' && prompted(runner, workerWake(workers)).length > 0);
      expect(prompted(runner, workerWake(workers)).at(-1)).not.toContain('Still open');
      expect(inputsFor(p.id, ci.id)).toHaveLength(1);
      await until(() => store.getRun(p.id)?.status === 'waiting' && !agentWaits(p.id).length);
    });

    // Ticket criterion 2: messages are not waits.
    it(`${runner} U3w a worker message during a worker wait wakes the parent and the worker wait stays open`, async () => {
      const f = await conversingParent(runner);
      await parentTurn(f.p.id, toolCall('cezar_wait', { kind: 'worker', worker_ids: [f.w.id], timeout_seconds: 600 }), () => parkedOn(f.p.id, workerWaits(f.p.id)[0]));
      const workers = workerWaits(f.p.id)[0]!;
      const turns = turnEnds(f.p.id);
      const id = await f.progress('Worker progress u3w');
      await until(() => delivered(f.p.id, id) && prompted(runner, 'Worker progress u3w').length > 0);
      expect(prompted(runner, 'Worker progress u3w').at(-1)).toContain(`Still open: worker wait ${workers.id} on 1 worker`);
      await until(() => turnEnds(f.p.id) > turns && parkedOn(f.p.id, workerWaits(f.p.id)[0]));
      expect(workerWaits(f.p.id)).toEqual([expect.objectContaining({ id: workers.id, phase: 'open', deadline: workers.deadline })]);
      expect(inputsFor(f.p.id, workers.id)).toEqual([]);
      // The wait still ends on its own event, once.
      expect(manager.finish(f.w.id)).toBe(true);
      await until(() => settled(f.p.id, workers.id)?.phase === 'delivered' && prompted(runner, workerWake(workers)).length > 0);
      expect(settled(f.p.id, workers.id)).toMatchObject({ result: { reason: 'outcome' } });
      expect(inputsFor(f.p.id, workers.id)).toHaveLength(1);
      await until(() => store.getRun(f.p.id)?.status === 'waiting');
    });

    // hearsay-tools/cezarion#1327: the worker runs on this runner's wire too, since its turn end parks.
    it(`${runner} U3n a worker that parks on the monitoring line while its parent waits on it wakes the parent with one notice naming its timer, the wait stays open, a second park sends none, and settlement resolves the wait`, async () => {
      const p = await parentOn(runner);
      const w = await worker(p.id, messagesPrompt(runner, ['Squeal is still pending u3n.\nCEZ:MONITORING']), runner);
      await parentTurn(p.id, toolCall('cezar_wait', { kind: 'worker', worker_ids: [w.id], timeout_seconds: 600 }), () => parkedOn(p.id, workerWaits(p.id)[0]));
      const workers = workerWaits(p.id)[0]!;
      // A worker that has not parked yet sends nothing when the wait opens.
      expect(parkNotices(p.id, w.id)).toEqual([]);
      manager.enqueueOwnedRun(w.id);
      await until(() => parkedOn(w.id, viaOf(w.id, 'monitoring-line')) && parkNotices(p.id, w.id).length > 0, () => timeline(w.id));
      const timer = viaOf(w.id, 'monitoring-line')!;
      const [notice, ...more] = parkNotices(p.id, w.id);
      expect(more).toEqual([]);
      expect(notice).toMatchObject({ id: parkNoticeId(w.id, workers.id), kind: 'progress', senderRunId: w.id, recipientRunId: p.id, state: 'accepted' });
      expect(notice!.text).toContain(`It waits on: timer ${timer.id} at ${timer.deadline}`);
      expect(notice!.text).toContain('Its last message:\nSqueal is still pending u3n.');
      // The notice reaches the parent on its own wire, and the parent's wait stays open.
      await until(() => delivered(p.id, notice!.id) && prompted(runner, `Cezar notice: your worker ${w.id}`).length > 0);
      expect(prompted(runner, `Cezar notice: your worker ${w.id}`).at(-1)).toContain(`Still open: worker wait ${workers.id} on 1 worker`);
      await until(() => parkedOn(p.id, workerWaits(p.id)[0]));
      expect(workerWaits(p.id)).toEqual([expect.objectContaining({ id: workers.id, phase: 'open', deadline: workers.deadline })]);
      expect(inputsFor(p.id, workers.id)).toEqual([]);
      // A second park during the same wait sends no second notice.
      const turns = turnEnds(w.id);
      expect(manager.sendMessage(w.id, [{ type: 'text', text: messagesPrompt(runner, ['Still pending u3n.\nCEZ:MONITORING']) }])).toBe(true);
      await until(() => turnEnds(w.id) > turns && parkedOn(w.id, viaOf(w.id, 'monitoring-line')), () => timeline(w.id));
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
      await parentTurn(p.id, toolCall('cezar_wait', { kind: 'worker', worker_ids: [w.id], timeout_seconds: 600 }), () => workerWaits(p.id)[0]?.phase === 'open');
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
      expect(workerWaits(p.id)).toEqual([expect.objectContaining({ id: workers.id, phase: 'open', deadline: workers.deadline })]);
      expect(inputsFor(p.id, workers.id)).toEqual([]);
    });

    it(`${runner} U3d a worker that finishes while its parent waits on it sends no notice`, async () => {
      const p = await parentOn(runner);
      const w = await worker(p.id, messagesPrompt(runner, ['Finished u3d.\nCEZ:DONE']), runner);
      await parentTurn(p.id, toolCall('cezar_wait', { kind: 'worker', worker_ids: [w.id], timeout_seconds: 600 }), () => parkedOn(p.id, workerWaits(p.id)[0]));
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
      await parentTurn(p.id, toolCall('cezar_wait', { kind: 'worker', worker_ids: [other.id], timeout_seconds: 600 }), () => workerWaits(p.id).length === 2);
      expect(workerWaits(p.id).map(wait => [wait.via, wait.workerIds]).sort()).toEqual([['cez-worker-wait', [w.id]], ['cezar_wait', [other.id]]]);
      expect(workerWaits(p.id).find(wait => wait.via === 'cez-worker-wait')).toMatchObject({ id: alias.id, phase: 'open', source: 'agent', deadline: alias.deadline });
      // One engine resolves both, each on its own worker.
      fixtureUpdateRun(w.id, { status: 'done' });
      await until(() => settled(p.id, alias.id)?.phase === 'delivered' && prompted(runner, `Worker wait ${alias.id}`).length > 0);
      expect(workerWaits(p.id)).toEqual([expect.objectContaining({ via: 'cezar_wait', phase: 'open' })]);
      const tool = workerWaits(p.id)[0]!;
      await until(() => store.getRun(p.id)?.status === 'waiting');
      fixtureUpdateRun(other.id, { status: 'done' });
      await until(() => settled(p.id, tool.id)?.phase === 'delivered' && prompted(runner, workerWake(tool)).length > 0);
      expect(store.getRun(p.id)?.lastWaits?.filter(wait => wait.kind === 'worker').map(wait => wait.via).sort()).toEqual(['cez-worker-wait', 'cezar_wait']);
      await until(() => store.getRun(p.id)?.status === 'waiting');
    });

    it(`${runner} U9w provider failure with a worker wait open leaves the run recoverable and the next resolution delivers`, async () => {
      const wire = gatedProviderFailure(root, runner);
      const run = manager.startRun(QUICK_TASK_WORKFLOW, { runner, task: HARNESS_ADAPTERS[runner].scenarios['provider-error']! });
      store.commitDelegation([{ id: run.id, delegation: { role: 'root', permissions: ['spawn', 'wait'], receipts: [] } }]);
      await until(wire.held);
      const w = await worker(run.id);
      const tools = manager.cezarToolHandlers(run.id, engine().active.get(run.id)!.ciGeneration);
      const registered = await tools.registerWait({ kind: 'worker', worker_ids: [w.id], timeout_seconds: 600 }, 'cezar_wait', new AbortController().signal);
      expect(registered.answer).toMatchObject({ ok: true, kind: 'worker' });
      if (!('wait' in registered)) throw Error('registration refused');
      const wait = registered.wait;
      const failedState = engine().active.get(run.id);
      wire.release();
      await until(() => store.readEvents(run.id).some(event => event.type === 'error'));
      await until(() => engine().active.get(run.id) !== failedState);
      expect(store.getRun(run.id)?.waits?.find(entry => entry.id === wait.id)?.phase).toBe('open');
      expect(store.getRun(run.id)?.status).not.toBe('failed');
      fixtureUpdateRun(w.id, { status: 'done' });
      await until(() => settled(run.id, wait.id)?.phase === 'delivered');
      expect(inputsFor(run.id, wait.id)).toHaveLength(1);
      await until(() => store.getRun(run.id)?.status === 'waiting');
    });

    it(`${runner} U9w clean close with a worker wait open leaves the run recoverable and the next resolution delivers`, async () => {
      const { p, w } = await parentWithWorker(runner);
      const tools = manager.cezarToolHandlers(p.id, engine().active.get(p.id)!.ciGeneration);
      const registered = await tools.registerWait({ kind: 'worker', worker_ids: [w.id], timeout_seconds: 600 }, 'cezar_wait', new AbortController().signal);
      if (!('wait' in registered)) throw Error('registration refused');
      const wait = registered.wait;
      engine().active.get(p.id)!.session.end();
      await until(() => !manager.isActive(p.id));
      // A clean close is not a failure: the park and its wait survive it (it was an error before 3a).
      expect(store.getRun(p.id)?.status).toBe('waiting');
      expect(store.getRun(p.id)?.error).toBeUndefined();
      expect(store.getRun(p.id)?.steps.at(-1)?.error).toBeUndefined();
      expect(store.getRun(p.id)?.waits?.find(entry => entry.id === wait.id)?.phase).toBe('open');
      fixtureUpdateRun(w.id, { status: 'done' });
      await until(() => settled(p.id, wait.id)?.phase === 'delivered' && prompted(runner, workerWake(wait)).length > 0);
      expect(inputsFor(p.id, wait.id)).toHaveLength(1);
      await until(() => store.getRun(p.id)?.status === 'waiting');
    });

    /** A parent parked on a worker wait whose session has closed, so a worker message wakes it
     *  through a scheduler continuation whose opening prompt the provider fails until lifted. */
    async function messageWakeWithoutSession() {
      const f = await conversingParent(runner);
      const failure = persistentWakeFailure(root, runner, { opening: MESSAGE_WAKE_OPENING, unread: true });
      await parentTurn(f.p.id, toolCall('cezar_wait', { kind: 'worker', worker_ids: [f.w.id], timeout_seconds: 600 }), () => parkedOn(f.p.id, workerWaits(f.p.id)[0]));
      engine().active.get(f.p.id)!.session.end();
      await until(() => !manager.isActive(f.p.id));
      return { ...f, failure };
    }

    it(`${runner} U14m a message-only wake beside a worker wait whose sessions persistently fail stops at the delivery bound, the run fails keeping the message, and Continue delivers it once`, async () => {
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
      expect(engine().wakeBackoffs.has(f.p.id)).toBe(false);
      expect(engine().wakeRetries.has(f.p.id)).toBe(false);
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
      engine().wakeRetryBackoff = { fastMs: 60_000, fastCount: MAX_WAKE_DELIVERY_ATTEMPTS, capMs: 60_000 };
      const f = await messageWakeWithoutSession();
      const id = await f.progress('Worker progress u14m once');
      await until(() => store.getRun(f.p.id)?.waitDeliveryFailures === 1 && engine().wakeBackoffs.has(f.p.id) && !manager.isActive(f.p.id));
      expect(store.getRun(f.p.id)?.status).toBe('waiting');
      f.failure.lift();
      const commits = recordCommits(join(root, '.ai/cezar'));
      const backoff = engine().wakeBackoffs.get(f.p.id) as NodeJS.Timeout & { _onTimeout(): void };
      backoff._onTimeout(); clearTimeout(backoff);
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
      await parentTurn(p.id, toolCall('cezar_wait', { kind: 'worker', worker_ids: [w.id], timeout_seconds: 600 }), () => parkedOn(p.id, workerWaits(p.id)[0]));
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
      expect(settled(p.id, wait.id)).toMatchObject({ kind: 'worker', phase: 'cancelled' });
      expect(workerWaits(p.id)).toEqual([]);
      await until(() => store.getRun(p.id)?.status === 'waiting');
    });

    it(`${runner} U9u after an upgrade, a parent whose message stand-in a provider took before the crash resumes`, async () => {
      const messageId = randomUUID(), now = new Date().toISOString();
      const { p } = await restartLegacyParked(wait => ({ id: randomUUID(), workerIds: [], outcomes: [], deadline: wait.deadline, phase: 'wake-pending', reason: 'message', wakeId: messageId }),
        (parentId, workerId) => [{ id: messageId, parentRunId: parentId, source: 'agent', text: 'Worker progress u9u', createdAt: now, deliveredAt: now,
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
      expect(settled(p.id, wait.id)).toMatchObject({ kind: 'worker', source: 'cezar', via: 'completion', phase: 'delivered' });
      expect(workerWaits(p.id)).toEqual([]);
      expect(store.getRun(p.id)?.delegation).not.toHaveProperty('completion');
      expect(store.getRun(p.id)?.delegation).not.toHaveProperty('wait');
      expect(inputsFor(p.id, wait.id)).toHaveLength(1);
      expect(prompted(runner, text)).toHaveLength(1);
      await until(() => store.getRun(p.id)?.status === 'waiting');
    });

    it(`${runner} U19 a worker message beside a pending portable question is delivered and the question stays answerable`, async () => {
      const f = await conversingParent(runner);
      expect(manager.sendMessage(f.p.id, [{ type: 'text', text: messagesPrompt(runner, [ASK_TEXT]) }])).toBe(true);
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
      expect(humanOpen(f.p.id)).toEqual([expect.objectContaining({ phase: 'open', askSeq })]);
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
      store.updateRun(peer.id, { status: RUN_STATUS.running, delegation: { role: 'root', permissions: ['spawn', 'wait', 'steer', 'inspect'], receipts: [] } });
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
      expect(manager.sendMessage(f.p.id, [{ type: 'text', text: messagesPrompt(runner, [ASK_TEXT]) }])).toBe(true);
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
      expect((manager as unknown as { owesWake(run: RunRecord): boolean }).owesWake(store.getRun(f.p.id)!)).toBe(false);
      expect(humanOpen(f.p.id)).toEqual([expect.objectContaining({ phase: WAIT_PHASE.open, source: WAIT_SOURCE.cezar })]);
      expect(deriveAttention(store.getRun(f.p.id)!).label).toBe('needs you');
      // A human message restarts the budget, and its turn takes the held message.
      expect(manager.sendMessage(f.p.id, [{ type: 'text', text: 'Carry on' }])).toBe(true);
      await until(() => delivered(f.p.id, held) && prompted(runner, 'Peer progress u19q held').length > 0);
      expect(store.getRun(f.p.id)?.automaticWakes ?? 0).toBeLessThan(MAX_AUTO_CONTINUES);
      expect(peerWakeNotes(f.p.id)).toHaveLength(1);
    });

    // hearsay-tools/cezarion#1301: a blocked done at the turn end is answered with the refusal
    // `cezar_done` gives mid-turn, as one automatic turn, and Cezar opens no wait.
    for (const settledWorker of [false, true]) {
      it(`${runner} ${settledWorker ? 'U20u a done blocked by a settled, uncollected worker gets the uncollected refusal nudge without the will-wait sentence' : 'U20 a done blocked by live workers at the turn end gets one refusal nudge with the will-wait sentence and opens no wait'}`, async () => {
        const { p, w } = await parentWithWorker(runner);
        if (settledWorker) {
          manager.requestWorkerStop(w.id);
          expect(await manager.awaitRunTermination(w.id, 15_000)).toBe(true);
        }
        // The human message below restarts the automatic-wake budget: the nudge spends its first unit.
        const wakes = 0;
        // The run as the nudge note is written: the note follows the submission and the charge.
        let atNudge: { status?: string; waits?: Wait[]; automaticWakes?: number | undefined; delegation?: unknown } | undefined;
        const append = store.appendEvent.bind(store);
        vi.spyOn(store, 'appendEvent').mockImplementation((id, event) => {
          if (id === p.id && event.type === 'note' && String(event.message).startsWith(COMPLETION_NUDGE_NOTE) && !atNudge) {
            const run = store.getRun(p.id)!;
            atNudge = { status: run.status, waits: run.waits ?? [], automaticWakes: run.automaticWakes, delegation: run.delegation };
          }
          return append(id, event);
        });
        expect(manager.sendMessage(p.id, [{ type: 'text', text: messagesPrompt(runner, ['All done.\nCEZ:DONE']) }])).toBe(true);
        const refusal = settledWorker ? `Settled worker results are not collected yet. Collect each (\`worker collect ${w.id}\`)` : `Workers are still live: ${w.id}.`;
        await until(() => prompted(runner, refusal).length > 0 && atNudge !== undefined);
        const [nudge, ...more] = prompted(runner, refusal);
        expect(more).toEqual([]);
        if (settledWorker) expect(nudge).not.toContain(COMPLETION_WILL_WAIT);
        else expect(nudge).toContain(COMPLETION_WILL_WAIT);
        expect(atNudge).toMatchObject({ status: 'running', waits: [], automaticWakes: wakes + 1 });
        expect(atNudge!.delegation).not.toHaveProperty('wait');
        expect(atNudge!.delegation).not.toHaveProperty('completion');
        expect(store.readEvents(p.id).filter(event => event.type === 'note' && String(event.message).startsWith(COMPLETION_NUDGE_NOTE)))
          .toEqual([expect.objectContaining({ message: `${COMPLETION_NUDGE_NOTE} (${wakes + 1}/${MAX_AUTO_CONTINUES}): ${settledWorker ? 'workers_uncollected' : 'workers_outstanding'}` })]);
        expect(turns.words(p.id)).toContain('running (completion nudge)');
        // The turn end writes nothing to the handoff file (hearsay-tools/cezarion#1809).
        expect(readFileSync(handoffPath(join(root, '.ai/cezar'), p.id), 'utf8')).not.toMatch(/turn complete|status=/);
        // The nudge turn's own end follows the ordinary rule; the run still finishes nothing.
        await until(() => store.getRun(p.id)?.status === 'waiting');
        expect(waitOf(store.getRun(p.id))).toBeUndefined();
        expect(workerWaits(p.id)).toEqual([]);
      });
    }

    // hearsay-tools/cezarion#1301: a human message (U20h) or a worker message (U20m) starts a fresh
    // cycle. A refusal nudge the harness acknowledges on its native wire and never answers parks on
    // Cezar's human wait; the next message then ends on done again, and that done gets a fresh nudge
    // rather than the second step. Each turn-end handler: the opening session's and a continuation's.
    for (const path of ['opening session', 'continuation', 'worker message'] as const) {
      const criterion = path === 'worker message' ? 'U20m' : 'U20h';
      it(`${runner} ${criterion} a ${path === 'worker message' ? 'worker message' : 'human message'} after an unanswered refusal nudge starts a fresh cycle (${path})`, async () => {
        if (exemptionFor(criterion, runner)) {
          expect(exemptionFor(criterion, runner)?.kind).toBe('capability-absent');
          return;
        }
        silenceRefusals();
        const f = path === 'worker message' ? await conversingParent(runner) : { ...await parentWithWorker(runner), progress: undefined };
        const { p, w } = f;
        const refusal = `Workers are still live: ${w.id}.`;
        if (path === 'continuation') {
          // An idle close leaves the run waiting; the human's Continue reopens it as a continuation.
          (engine().active.get(p.id) as unknown as { idleTimer: NodeJS.Timeout & { _onTimeout(): void } }).idleTimer._onTimeout();
          await until(() => !manager.isActive(p.id) && store.getRun(p.id)?.status === 'waiting');
        }
        const done = messagesPrompt(runner, ['All done.\nCEZ:DONE']);
        if (path === 'continuation') expect(manager.continueRun(p.id, { text: done }).ok).toBe(true);
        else expect(manager.sendMessage(p.id, [{ type: 'text', text: done }])).toBe(true);
        await until(() => noReplyNotes(p.id).length === 1 && gated(p.id));
        if (path === 'continuation') expect(store.getRun(p.id)?.steps.some(step => step.id === 'continue-1')).toBe(true);
        expect(nudgeNotes(p.id)).toHaveLength(1);
        expect(prompted(runner, refusal)).toHaveLength(1);
        expect(workerWaits(p.id)).toEqual([]);
        expect(humanOpen(p.id)).toEqual([expect.objectContaining({ source: 'cezar', via: 'no-wait' })]);
        // The next turn ends on a blocked done: a fresh cycle, so a second nudge and no wait.
        const turns = turnEnds(p.id);
        const again = messagesPrompt(runner, ['Done now.\nCEZ:DONE']);
        if (f.progress) await f.progress(again);
        else expect(manager.sendMessage(p.id, [{ type: 'text', text: again }])).toBe(true);
        await until(() => turnEnds(p.id) > turns && (nudgeNotes(p.id).length === 2 || workerWaits(p.id).length > 0 || humanOpen(p.id).some(wait => wait.via === 'completion')));
        expect(workerWaits(p.id)).toEqual([]);
        expect(nudgeNotes(p.id)).toHaveLength(2);
        await until(() => noReplyNotes(p.id).length === 2 && gated(p.id));
        expect(workerWaits(p.id)).toEqual([]);
      });
    }

    // hearsay-tools/cezarion#1301: OpenCode can end the turn that answers an input before its
    // HTTP acknowledgement lands. A done in that turn is still refused with the nudge once the
    // acknowledgement settles, never parked on an implicit re-check timer.
    it(`${runner} U20a a done blocked in the turn that answers a worker message acknowledged after that turn ended still gets the refusal nudge`, async () => {
      if (exemptionFor('U20a', runner)) {
        expect(exemptionFor('U20a', runner)?.kind).toBe('capability-absent');
        return;
      }
      await withHeldAck(runner as 'codex' | 'opencode' | 'pi' | 'omp', async release => {
        const { p, w, progress } = await conversingParent(runner);
        const refusal = `Workers are still live: ${w.id}.`;
        const turns = turnEnds(p.id);
        const id = await progress(`${messagesPrompt(runner, ['All done.\nCEZ:DONE'])} delay-owned-ack`);
        await until(() => turnEnds(p.id) > turns);
        await flushMicrotasks();
        // On the wire, acknowledgement withheld: the turn ended on done, and nothing is decided yet.
        expect(delivered(p.id, id)).toBe(false);
        expect(nudgeNotes(p.id)).toEqual([]);
        release();
        await until(() => delivered(p.id, id) && nudgeNotes(p.id).length === 1 && prompted(runner, refusal).length === 1);
      });
    });

    it(`${runner} R18 Finish followed by a provider error retires its intent before restart`, async () => {
      const peer = await parentOn(runner);
      const wire = gatedProviderFailure(root, runner);
      const run = manager.startRun(QUICK_TASK_WORKFLOW, { runner, task: HARNESS_ADAPTERS[runner].scenarios['provider-error']! });
      store.commitDelegation([{ id: run.id, delegation: { role: 'root', permissions: ['wait'], receipts: [] } }]);
      await until(wire.held);
      const request = seedCompletionRequest(run.id, peer.id);
      // Hold graceful shutdown until the queued native provider error wins.
      const close = vi.spyOn(engine().active.get(run.id)!.session, 'end').mockImplementationOnce(() => {});
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
      process.env.CEZ_MOCK_COMPLETION_REPLY = messagesPrompt(runner, ['Still done.\nCEZ:DONE']);
      const p = await parentOn(runner);
      const peer = await parentOn(runner);
      const request = seedCompletionRequest(p.id, peer.id);
      const entry = await ignoreRefusal(runner, p.id, 'Requests are still open:', () => workerWaits(p.id)[0]?.phase === 'open');
      expect(prompted(runner, request.id)).not.toHaveLength(0);
      expect(prompted(runner, 'cez message wait --request')).not.toHaveLength(0);
      expect(prompted(runner, 'cez message cancel-request')).not.toHaveLength(0);
      expect(entry).toMatchObject({ source: WAIT_SOURCE.cezar, via: WAIT_VIA.completion, requestIds: [request.id], phase: WAIT_PHASE.open });
      expect(entry).not.toHaveProperty('deadline');
      expect(entry).not.toHaveProperty('timeoutSeconds');
      const current = store.getRun(p.id)!.delegation;
      if (current?.role !== 'root') throw Error('missing ledger');
      store.commitConversation(p.id, { ...current.conversation!, outcomes: [{ requestId: request.id, status: 'replied', observedAt: new Date().toISOString() }] });
      manager.reconcileWorkerWaits(p.id);
      await until(() => settled(p.id, entry.id)?.phase === 'delivered');
      await until(() => store.getRun(p.id)?.status === 'waiting');
      expect(manager.sendMessage(p.id, [{ type: 'text', text: messagesPrompt(runner, ['Done.\nCEZ:DONE']) }])).toBe(true);
      await until(() => store.getRun(p.id)?.status === 'done');
    });

    it(`${runner} R17 incoming requests refuse once then complete and settle the requester obligation`, async () => {
      process.env.CEZ_MOCK_COMPLETION_REPLY = messagesPrompt(runner, ['Finish without replying.\nCEZ:DONE']);
      const p = await parentOn(runner);
      const peer = await parentOn(runner);
      const request = seedCompletionRequest(peer.id, p.id);
      expect(manager.sendMessage(p.id, [{ type: 'text', text: messagesPrompt(runner, ['Done.\nCEZ:DONE']) }])).toBe(true);
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
    it(`${runner} U21 an ignored refusal with live workers parks on a Cezar worker wait that settlement wakes`, async () => {
      process.env.CEZ_MOCK_COMPLETION_REPLY = messagesPrompt(runner, ['Still done.\nCEZ:DONE']);
      const { p, w } = await parentWithWorker(runner);
      const entry = await ignoreRefusal(runner, p.id, `Workers are still live: ${w.id}.`, () => workerWaits(p.id)[0]?.phase === 'open');
      // Only Cezar's completion wait is open: no implicit live-worker re-check timer beside it.
      expect(store.getRun(p.id)?.waits).toEqual([entry]);
      expect(entry).toMatchObject({ kind: 'worker', source: 'cezar', via: 'completion', mode: 'all', workerIds: [w.id], phase: 'open' });
      expect(entry).not.toHaveProperty('deadline');
      expect(entry).not.toHaveProperty('timeoutSeconds');
      expect(engine().waitTimers.has(entry.id)).toBe(false);
      expect(engine().monitoring.has(p.id)).toBe(false);
      expect(semaphore.busy()).toBe(0);
      expect(store.getRun(p.id)?.delegation).not.toHaveProperty('wait');
      expect(store.getRun(p.id)?.delegation).not.toHaveProperty('completion');
      expect(toRunSummary(store.getRun(p.id)!).waitingOn).toEqual({ kind: 'workers', count: 1 });
      fixtureUpdateRun(w.id, { status: 'done' });
      await until(() => settled(p.id, entry.id)?.phase === 'delivered' && prompted(runner, workerWake(entry)).length > 0);
      expect(settled(p.id, entry.id)).toMatchObject({ result: { reason: 'outcome' } });
      expect(inputsFor(p.id, entry.id)).toHaveLength(1);
      expect(prompted(runner, workerWake(entry))).toHaveLength(1);
      await until(() => store.getRun(p.id)?.status === 'waiting');
    });

    it(`${runner} U21r after a restart, a deadline-less completion wait resolves on the worker's settlement and wakes the parent once`, async () => {
      process.env.CEZ_MOCK_COMPLETION_REPLY = messagesPrompt(runner, ['Still done.\nCEZ:DONE']);
      // Recovery re-queues the worker (`reviveQueuedRun`), which then runs its task and settles
      // done: a store write cannot settle a queued run the scheduler starts (hearsay-tools/cezarion#1804).
      const { p, w } = await parentWithWorker(runner, undefined, 'mock:done');
      const entry = await ignoreRefusal(runner, p.id, `Workers are still live: ${w.id}.`, () => workerWaits(p.id)[0]?.phase === 'open');
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
      process.env.CEZ_MOCK_COMPLETION_REPLY = messagesPrompt(runner, ['Still done.\nCEZ:DONE']);
      const f = await conversingParent(runner);
      const entry = await ignoreRefusal(runner, f.p.id, `Workers are still live: ${f.w.id}.`, () => workerWaits(f.p.id)[0]?.phase === 'open');
      // Inspection shows the parked parent's completion wait, without a deadline (hearsay-tools/cezarion#1301).
      const inspected = await f.inspect();
      expect(inspected).not.toHaveProperty('wait');
      expect(inspected.completionWait).toEqual({ id: entry.id, via: 'completion', workerIds: [f.w.id], mode: 'all', phase: 'parked',
        outcomes: [], revisions: entry.revisions, wakeId: entry.id });
      const turns = turnEnds(f.p.id);
      const id = await f.progress('Worker progress u21m');
      await until(() => delivered(f.p.id, id) && prompted(runner, 'Worker progress u21m').length > 0);
      // The wake's footer names the open completion wait, which has no deadline.
      expect(prompted(runner, 'Worker progress u21m')).toEqual([expect.stringContaining(`Still open: worker wait ${entry.id} on 1 worker, no deadline.`)]);
      await until(() => turnEnds(f.p.id) > turns && parkedOn(f.p.id, workerWaits(f.p.id)[0]));
      expect(store.getRun(f.p.id)?.waits).toEqual([expect.objectContaining({ id: entry.id, via: 'completion', phase: 'open' })]);
      expect(inputsFor(f.p.id, entry.id)).toEqual([]);
      expect(engine().monitoring.has(f.p.id)).toBe(false);
      // The wait still ends on its own event, once.
      expect(manager.finish(f.w.id)).toBe(true);
      await until(() => settled(f.p.id, entry.id)?.phase === 'delivered' && prompted(runner, workerWake(entry)).length > 0);
      expect(inputsFor(f.p.id, entry.id)).toHaveLength(1);
      await until(() => store.getRun(f.p.id)?.status === 'waiting');
    });

    // Review round 1 (hearsay-tools/cezarion#1301): a blocked done never opens the completion wait
    // beside an open timer (U11), but the reverse order is reachable. A worker message wakes a parent
    // parked on its completion wait (U21m). The marker adds no redundant timer
    // (hearsay-tools/cezarion#1268), but an explicit cezar_wait still opens the agent's timer.
    it(`${runner} U21t an agent timer registered beside a completion-wait park keeps its deadline and wakes beside it`, async () => {
      const marker = messagesPrompt(runner, ['Still checking.\nCEZ:MONITORING']);
      const exercise = async (releaseAck?: () => void) => {
        process.env.CEZ_MOCK_COMPLETION_REPLY = messagesPrompt(runner, ['Still done.\nCEZ:DONE']);
        checkpoint('u21t-conversing-parent');
        const f = await conversingParent(runner);
        const waitAt = async (phase: string, predicate: () => boolean) => {
          checkpoint(`u21t-${phase}`);
          await until(predicate, () => timeline(f.p.id));
        };
        checkpoint('u21t-completion-refusal');
        const entry = await ignoreRefusal(runner, f.p.id, `Workers are still live: ${f.w.id}.`, () => workerWaits(f.p.id)[0]?.phase === 'open');
        let turns = turnEnds(f.p.id);
        checkpoint('u21t-marker-admission');
        const markerId = await f.progress(marker);
        await waitAt('marker-native-prompt', () => prompted(runner, marker).length > 0);
        if (releaseAck) {
          // hearsay-tools/cezarion#1298: the historical failure ended this native turn before
          // its HTTP ACK. The marker must leave only the existing completion wait in either order.
          await waitAt('marker-turn-end-before-ack', () => turnEnds(f.p.id) > turns);
          expect(delivered(f.p.id, markerId)).toBe(false);
          expect(store.getRun(f.p.id)?.waits).toEqual([expect.objectContaining({ id: entry.id, via: WAIT_VIA.completion, phase: WAIT_PHASE.open })]);
          releaseAck();
        }
        await waitAt('marker-delivery', () => delivered(f.p.id, markerId));
        await waitAt('marker-turn-end', () => turnEnds(f.p.id) > turns);
        await waitAt('marker-repark', () => parkedOn(f.p.id, workerWaits(f.p.id)[0]));
        expect(store.getRun(f.p.id)?.waits).toEqual([expect.objectContaining({ id: entry.id, via: 'completion', phase: 'open' })]);
        turns = turnEnds(f.p.id);
        const timerPrompt = toolCall('cezar_wait', { kind: 'timer', seconds: 600, note: 'u21t explicit timer' });
        checkpoint('u21t-timer-admission');
        const id = await f.progress(timerPrompt);
        await waitAt('timer-native-prompt', () => prompted(runner, timerPrompt).length > 0);
        await waitAt('timer-delivery', () => delivered(f.p.id, id));
        await waitAt('timer-turn-end', () => turnEnds(f.p.id) > turns);
        await waitAt('timer-repark', () => parkedOn(f.p.id, waitOfKind(f.p.id, 'timer')));
        const timer = timed(waitOfKind(f.p.id, 'timer')!);
        expect(timer).toMatchObject({ via: 'cezar_wait', note: 'u21t explicit timer' });
        expect(store.getRun(f.p.id)?.waits).toEqual([
          expect.objectContaining({ id: entry.id, via: 'completion', phase: 'open' }),
          expect.objectContaining({ id: timer.id, source: 'agent', phase: 'open', deadline: timer.deadline }),
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
        expect(store.getRun(f.p.id)?.waits).toEqual([expect.objectContaining({ id: entry.id, via: 'completion', phase: 'open' })]);
        expect(workerWaits(f.p.id)[0]).not.toHaveProperty('deadline');
        expect(inputsFor(f.p.id, entry.id)).toEqual([]);
        // The worker's settlement still resolves the completion wait, and it wakes the parent once.
        expect(manager.finish(f.w.id)).toBe(true);
        await waitAt('completion-wake-delivery', () => settled(f.p.id, entry.id)?.phase === 'delivered');
        await waitAt('completion-wake-native-prompt', () => prompted(runner, workerWake(entry)).length > 0);
        expect(inputsFor(f.p.id, entry.id)).toHaveLength(1);
        expect(prompted(runner, workerWake(entry))).toHaveLength(1);
        await waitAt('completion-wake-repark', () => store.getRun(f.p.id)?.status === 'waiting');
      };
      // The control must be inherited by the native mock when conversingParent starts it.
      if (runner === 'opencode') await withHeldAck(runner, exercise, marker);
      else await exercise();
    });

    it(`${runner} U21h an ignored refusal with only uncollected results parks on Cezar's human wait`, async () => {
      process.env.CEZ_MOCK_COMPLETION_REPLY = messagesPrompt(runner, ['Still done.\nCEZ:DONE']);
      const { p, w } = await parentWithWorker(runner);
      manager.requestWorkerStop(w.id);
      expect(await manager.awaitRunTermination(w.id, 15_000)).toBe(true);
      const refusal = `Settled worker results are not collected yet. Collect each (\`worker collect ${w.id}\`), then call cezar_done again.`;
      await ignoreRefusal(runner, p.id, refusal, () => gated(p.id));
      expect(humanOpen(p.id)).toEqual([expect.objectContaining({ kind: 'human', source: 'cezar', via: 'completion', phase: 'open' })]);
      expect(workerWaits(p.id)).toEqual([]);
      const shown = store.readEvents(p.id).find(event => event.seq === humanOpen(p.id)[0]!.askSeq);
      expect(shown).toMatchObject({ type: 'note', message: refusal });
      expect(asks(p.id)).toEqual([]);
      expect(deriveAttention(store.getRun(p.id)!).label).toBe('needs you');
      expect(semaphore.busy()).toBe(0);
    });

    it(`${runner} U21a an autonomous parent's ignored refusal is nudged again until the budget`, async () => {
      process.env.CEZ_MOCK_COMPLETION_REPLY = messagesPrompt(runner, ['Still done.\nCEZ:DONE']);
      nativeWire(runner);
      process.env.CEZ_CLAUDE_BIN = HARNESS_ADAPTERS.claude.mockBin;
      const run = manager.startRun(QUICK_TASK_WORKFLOW, { runner, task: HARNESS_ADAPTERS[runner].scenarios['autonomous-cap']!, autonomous: true });
      store.commitDelegation([{ id: run.id, delegation: { role: 'root', permissions: ['spawn', 'wait'], receipts: [] } }]);
      // The opening turn spends what is left and parks on the budget; the worker comes after it.
      store.updateRun(run.id, { automaticWakes: MAX_AUTO_CONTINUES });
      await until(() => gated(run.id));
      const w = await worker(run.id);
      const atNudges: Wait[][] = [];
      const append = store.appendEvent.bind(store);
      vi.spyOn(store, 'appendEvent').mockImplementation((id, event) => {
        if (id === run.id && event.type === 'note' && String(event.message).startsWith(COMPLETION_NUDGE_NOTE)) atNudges.push(store.getRun(run.id)?.waits ?? []);
        return append(id, event);
      });
      expect(manager.sendMessage(run.id, [{ type: 'text', text: messagesPrompt(runner, ['All done.\nCEZ:DONE']) }])).toBe(true);
      // The human message restarted the budget; two units are left for the nudges.
      store.updateRun(run.id, { automaticWakes: MAX_AUTO_CONTINUES - 2 });
      await until(() => humanOpen(run.id)[0]?.via === 'budget' && gated(run.id));
      expect(prompted(runner, `Workers are still live: ${w.id}.`)).toHaveLength(2);
      expect(atNudges).toEqual([[], []]);
      expect(humanOpen(run.id)).toEqual([expect.objectContaining({ kind: 'human', source: 'cezar', via: 'budget', phase: 'open' })]);
      expect(workerWaits(run.id)).toEqual([]);
      expect(store.getRun(run.id)?.automaticWakes).toBe(MAX_AUTO_CONTINUES);
      expect(deriveAttention(store.getRun(run.id)!).label).toBe('needs you');
    });

    // hearsay-tools/cezarion#1301: a blocked done found after the session closed is queued as a
    // lifecycle wake; the scheduler continuation reopens the session and delivers it as the nudge.
    it(`${runner} U22 a done blocked after the session closed reopens it and delivers the refusal`, async () => {
      // The reply turn ends on done again: the refusal's turn is the nudge's, so it takes the second step.
      process.env.CEZ_MOCK_COMPLETION_REPLY = messagesPrompt(runner, ['Still done.\nCEZ:DONE']);
      const { p, w } = await parentWithWorker(runner);
      const wakes = store.getRun(p.id)?.automaticWakes ?? 0;
      const commits = recordCommits(join(root, '.ai/cezar'));
      engine().active.get(p.id)!.session.end();
      const refusal = `Workers are still live: ${w.id}.`;
      await until(() => prompted(runner, refusal).length > 0 && workerWaits(p.id)[0]?.phase === 'open' && store.getRun(p.id)?.status === 'waiting');
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
      expect(workerWaits(p.id)).toEqual([expect.objectContaining({ source: 'cezar', via: 'completion', workerIds: [w.id] })]);
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
      silenceRefusals();
      const { p, w } = await parentWithWorker(runner);
      const refusal = `Workers are still live: ${w.id}.`;
      engine().active.get(p.id)!.session.end();
      await until(() => noReplyNotes(p.id).length === 1 && gated(p.id));
      expect(prompted(runner, refusal)).toHaveLength(1);
      expect(store.getRun(p.id)?.agentInputs?.filter(input => input.text.includes(refusal)))
        .toEqual([expect.objectContaining({ source: 'lifecycle', deliveredAt: expect.any(String) })]);
      expect(humanOpen(p.id)).toEqual([expect.objectContaining({ source: 'cezar', via: 'no-wait' })]);
      expect(nudgeNotes(p.id)).toHaveLength(1);
      expect(workerWaits(p.id)).toEqual([]);
      expect(semaphore.busy()).toBe(0);
    });

    // hearsay-tools/cezarion#1301: a queued refusal is owed input, and a reopened session that closes
    // before Cezar submits it is a failed delivery, as U14's: one copy, the delivery bound, and the
    // run fails keeping it. A legacy accepted Finish takes the same path.
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
            engine().active.get(p.id)?.session.end();
          }
        };
        store.on('event', closeAtTurnEnd);
        try {
          engine().active.get(p.id)!.session.end();
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
          expect(engine().wakeBackoffs.has(p.id)).toBe(false);
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
      process.env.CEZ_MOCK_COMPLETION_REPLY = messagesPrompt(runner, ['Still done.\nCEZ:DONE']);
      const { p, w } = await parentWithWorker(runner);
      const refusal = `Workers are still live: ${w.id}.`;
      const refusals = () => store.getRun(p.id)?.agentInputs?.filter(input => input.text.includes(refusal)) ?? [];
      let closes = 1;
      const closeOnce = ({ runId, event }: { runId: string; event: { type: string } }) => {
        if (runId !== p.id || event.type !== 'turn-end' || !closes || !refusals().some(input => !input.deliveredAt)) return;
        closes--;
        engine().active.get(p.id)?.session.end();
      };
      // With no backoff the retry delivers at once and clears the count, so a poll can miss it: the
      // store's own writes record that it was counted.
      let counted = false;
      const countOnce = (run: RunRecord) => { if (run.id === p.id && run.waitDeliveryFailures === 1) counted = true; };
      store.on('event', closeOnce);
      store.on('run', countOnce);
      try {
        engine().active.get(p.id)!.session.end();
        await until(() => counted);
        await until(() => prompted(runner, refusal).length > 0 && workerWaits(p.id)[0]?.phase === 'open' && store.getRun(p.id)?.status === 'waiting');
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
        if (variant === 'silent') silenceRefusals();
        else process.env.CEZ_MOCK_COMPLETION_REPLY = messagesPrompt(runner, ['Still done.\nCEZ:DONE']);
        const { p, w } = await parentWithWorker(runner, runner === 'claude' ? 'U22k' : undefined);
        const refusal = `Workers are still live: ${w.id}.`;
        const refusals = () => store.getRun(p.id)?.agentInputs?.filter(input => input.text.includes(refusal)) ?? [];
        let closes = MAX_WAKE_DELIVERY_ATTEMPTS;
        const closeAtTurnEnd = ({ runId, event }: { runId: string; event: { type: string } }) => {
          if (runId !== p.id || event.type !== 'turn-end' || !closes || !refusals().some(input => !input.deliveredAt)) return;
          closes--;
          engine().active.get(p.id)?.session.end();
        };
        store.on('event', closeAtTurnEnd);
        onTestFinished(() => { store.off('event', closeAtTurnEnd); });
        engine().active.get(p.id)!.session.end();
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
          await refusalStep(runner, p.id, 'U22k: Continue no-reply final park', () => noReplyNotes(p.id).length === 1 && gated(p.id));
          expect(humanOpen(p.id)).toEqual([expect.objectContaining({ source: 'cezar', via: 'no-wait' })]);
          expect(semaphore.busy()).toBe(0);
        } else {
          // The reply ends on done again, and the second step parks on the workers or, once they
          // settled, on Cezar's completion human wait.
          await refusalStep(runner, p.id, 'U22k: Continue final park', () => prompted(runner, refusal).length > 0 && store.getRun(p.id)?.status === 'waiting' &&
            (workerWaits(p.id)[0]?.phase === 'open' || humanOpen(p.id).some(wait => wait.via === 'completion')));
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
          if (variant === 'silent') silenceRefusals();
          else process.env.CEZ_MOCK_COMPLETION_REPLY = messagesPrompt(runner, ['Still done.\nCEZ:DONE']);
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
          engine().active.get(p.id)!.session.end();
          await until(() => disk !== undefined);
          store.off('event', capture);
          let closes = variant === 'closing' ? 1 : 0;
          const closeOnce = ({ runId, event }: { runId: string; event: { type: string } }) => {
            if (runId !== p.id || event.type !== 'turn-end' || !closes || !refusals().some(input => !input.deliveredAt)) return;
            closes--;
            engine().active.get(p.id)?.session.end();
          };
          await restart(false, disk, events);
          // The old manager may have reached a mock before it stopped: count from here.
          const before = prompted(runner, refusal).length;
          // Recovery reopens the run through the scheduler; its first turn end is a mock round trip away.
          store.on('event', closeOnce);
          onTestFinished(() => { store.off('event', closeOnce); });
          if (variant === 'silent') silenceRefusals();
          else retryAtOnce();
          expect(refusals()).toEqual([expect.objectContaining({ source: 'lifecycle' })]);
          if (variant === 'silent') {
            await until(() => noReplyNotes(p.id).length === 1 && gated(p.id));
            if (runner === 'opencode') expect(refusals()[0]!.deliveredAt).toBeUndefined();
            expect(humanOpen(p.id)).toEqual([expect.objectContaining({ source: 'cezar', via: 'no-wait' })]);
            expect(semaphore.busy()).toBe(0);
            releaseAck();
            // The reply bound can beat the native ACK. Its human gate alone does not prove
            // delivery committed; the late ACK resumes wake bookkeeping and re-arms that bound.
            checkpoint('u22r-refusal-delivered-and-reparked');
            await until(() => refusals().some(input => !!input.deliveredAt) && gated(p.id));
            expect(humanOpen(p.id)).toEqual([expect.objectContaining({ source: 'cezar', via: 'no-wait' })]);
            expect(semaphore.busy()).toBe(0);
          } else {
            await until(() => prompted(runner, refusal).length > before && store.getRun(p.id)?.status === 'waiting' &&
              (workerWaits(p.id)[0]?.phase === 'open' || humanOpen(p.id).some(wait => wait.via === 'completion')));
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
        engine().active.get(p.id)?.session.end();
      };
      store.on('event', closeAtTurnEnd);
      onTestFinished(() => { store.off('event', closeAtTurnEnd); });
      engine().active.get(p.id)!.session.end();
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
      expect(humanOpen(w.id)).toEqual([expect.objectContaining({ source: 'cezar', via: 'no-wait', askSeq: asks(w.id)[0]!.seq })]);
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
      engine().active.get(w.id)!.session.end();
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
      process.env.CEZ_DELEGATION = '1';
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
      const unanswered = () => {
        return (manager as unknown as { unansweredQuestions(id: string): { workerId: string; messageId: string }[] }).unansweredQuestions(p.id);
      };
      expect(unanswered()).toEqual([expect.objectContaining({ workerId: w.id })]);
      const text = 'automatic steer U25';
      expect((manager as unknown as { deliverMessage(id: string, content: unknown[], userAuthored: boolean): boolean })
        .deliverMessage(w.id, [{ type: 'text', text }], false)).toBe(true);
      await until(() => prompted(runner, text).length > 0);
      expect(store.readEvents(w.id).filter(event => event.type === 'human-ask-closed'))
        .toEqual([expect.objectContaining({ askSeq, reason: 'superseded' })]);
      const conversation = (store.getRun(p.id)!.delegation as { conversation?: { outcomes: Array<{ requestId: string }> } }).conversation;
      expect(conversation?.outcomes.filter(outcome => outcome.requestId === requestId)).toHaveLength(1);
      // The steer's own turn may end without a wait and route a fresh fallback question before
      // these reads: only the superseded question is checked (hearsay-tools/cezarion#1301).
      expect(unanswered().filter(question => question.messageId === requestId)).toEqual([]);
      expect(humanOpen(w.id).filter(wait => wait.askSeq === askSeq)).toEqual([]);
    });
  }
}

// hearsay-tools/cezarion#1525: every turn end settles through one method. Each of U5, U6, U11, U20
// and U20u is settled from each entry: the fresh step's turn end, a Continue's, and an
// acknowledgement that lands after its turn ended. Each cell checks the settled outcome's word
// (`turn-outcomes.testkit.ts`) besides the status and the waits.
function entriesCells(runners: RunnerId[]): void {
  for (const runner of runners) {
    /** The settled outcomes' words, oldest first. */
    const words = (id: string) => turns.words(id);
    /** The words that settle something. A nudged turn can end before its acknowledgement on its own
     *  (OpenCode HTTP/SSE), which settles a plain `running` before the acknowledgement settles it. */
    const settledWords = (id: string) => words(id).filter(word => word !== 'running');
    const idleClose = async (id: string) => {
      (engine().active.get(id) as unknown as { idleTimer: NodeJS.Timeout & { _onTimeout(): void } }).idleTimer._onTimeout();
      await until(() => !manager.isActive(id) && store.getRun(id)?.status === 'waiting');
    };
    const done = messagesPrompt(runner, ['All done.\nCEZ:DONE']);
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
      await until(() => gated(run.id));
      expect(humanOpen(run.id)).toEqual([expect.objectContaining({ via: 'no-wait', source: 'cezar' })]);
      expect(settledWords(run.id)).toEqual(['running (no-wait nudge)', 'waiting']);
    });

    it(`${runner} U27 U5 a Continue's no-wait turn end gets the nudge, then the no-wait human wait`, async () => {
      nativeWire(runner);
      const run = manager.startRun(QUICK_TASK_WORKFLOW, { runner, task: HARNESS_ADAPTERS[runner].scenarios.baseline! });
      await until(() => gated(run.id));
      await idleClose(run.id);
      expect(manager.continueRun(run.id, { text: 'carry on' }).ok).toBe(true);
      await until(() => prompted(runner, NO_WAIT_NUDGE).length === 2 && gated(run.id));
      expect(store.getRun(run.id)?.steps.some(step => step.id === 'continue-1')).toBe(true);
      expect(humanOpen(run.id)).toEqual([expect.objectContaining({ via: 'no-wait', source: 'cezar' })]);
      expect(settledWords(run.id)).toEqual(['running (no-wait nudge)', 'waiting', 'running (no-wait nudge)', 'waiting']);
    });

    it(`${runner} U27 U5 a no-wait turn end an acknowledgement settles late opens the no-wait human wait and settles waiting`, async () => {
      // The nudge's acknowledgement is held, so the turn that answers it ends first.
      await lateAck(async release => {
        nativeWire(runner);
        const run = manager.startRun(QUICK_TASK_WORKFLOW, { runner, task: HARNESS_ADAPTERS[runner].scenarios.baseline! });
        await until(() => prompted(runner, NO_WAIT_NUDGE).length === 1 && turnEnds(run.id) >= 1);
        await heldAfterTurnEnd(run.id, 1, () => humanOpen(run.id).length === 0 && store.getRun(run.id)?.status === 'running');
        expect(words(run.id)).toEqual(['running (no-wait nudge)', 'running']);
        release();
        await until(() => gated(run.id));
        expect(humanOpen(run.id)).toEqual([expect.objectContaining({ via: 'no-wait', source: 'cezar' })]);
        expect(words(run.id)).toEqual(['running (no-wait nudge)', 'running', 'waiting']);
      }, 'Your turn ended without a wait or done.');
    });

    // The turn that answers the refusal nudge ends on done again: the second step, a completion wait.
    it(`${runner} U27 U6 a fresh step's second refused done with live workers parks on the completion wait and settles waiting`, async () => {
      process.env.CEZ_MOCK_COMPLETION_REPLY = messagesPrompt(runner, ['Still done.\nCEZ:DONE']);
      const { p, w } = await parentWithWorker(runner);
      await ignoreRefusal(runner, p.id, `Workers are still live: ${w.id}.`, () => workerWaits(p.id)[0]?.phase === 'open');
      expect(workerWaits(p.id)).toEqual([expect.objectContaining({ source: 'cezar', via: 'completion', workerIds: [w.id] })]);
      expect(settledWords(p.id).slice(-2)).toEqual(['running (completion nudge)', 'waiting']);
    });

    it(`${runner} U27 U6 a Continue's second refused done with live workers parks on the completion wait and settles waiting`, async () => {
      process.env.CEZ_MOCK_COMPLETION_REPLY = messagesPrompt(runner, ['Still done.\nCEZ:DONE']);
      const { p, w } = await parentWithWorker(runner);
      await idleClose(p.id);
      const refusal = `Workers are still live: ${w.id}.`;
      expect(manager.continueRun(p.id, { text: done }).ok).toBe(true);
      await until(() => prompted(runner, refusal).length > 0 && store.getRun(p.id)?.status === 'waiting' && workerWaits(p.id)[0]?.phase === 'open');
      expect(prompted(runner, refusal)).toHaveLength(1);
      expect(store.getRun(p.id)?.steps.some(step => step.id === 'continue-1')).toBe(true);
      expect(workerWaits(p.id)).toEqual([expect.objectContaining({ source: 'cezar', via: 'completion', workerIds: [w.id] })]);
      expect(settledWords(p.id).slice(-2)).toEqual(['running (completion nudge)', 'waiting']);
    });

    it(`${runner} U27 U6 a second refused done an acknowledgement settles late parks on the completion wait and settles waiting`, async () => {
      // The refusal nudge's acknowledgement is held, so the turn that answers it ends on done first.
      await lateAck(async release => {
        process.env.CEZ_MOCK_COMPLETION_REPLY = messagesPrompt(runner, ['Still done.\nCEZ:DONE']);
        const { p, w } = await parentWithWorker(runner);
        const refusal = `Workers are still live: ${w.id}.`;
        const turns = turnEnds(p.id);
        expect(manager.sendMessage(p.id, [{ type: 'text', text: done }])).toBe(true);
        await until(() => prompted(runner, refusal).length === 1 && turnEnds(p.id) > turns);
        await heldAfterTurnEnd(p.id, turns + 1, () => workerWaits(p.id).length === 0 && store.getRun(p.id)?.status === 'running');
        release();
        await until(() => workerWaits(p.id)[0]?.phase === 'open' && store.getRun(p.id)?.status === 'waiting');
        expect(prompted(runner, refusal)).toHaveLength(1);
        expect(words(p.id).slice(-1)).toEqual(['waiting']);
        expect(words(p.id)).toContain('running (completion nudge)');
      }, 'Workers are still live');
    });

    // A refused done beside an open timer parks on the timer, which keeps its slot.
    const timerPark = async (id: string) => {
      const turns = turnEnds(id);
      expect(manager.sendMessage(id, [{ type: 'text', text: messagesPrompt(runner, ['Still checking.\nCEZ:MONITORING']) }])).toBe(true);
      await until(() => turnEnds(id) > turns && parkedOn(id, viaOf(id, 'monitoring-line')));
      return viaOf(id, 'monitoring-line')!;
    };
    const refusalNoted = (id: string, refusal: string) => store.readEvents(id).some(event => event.type === 'note' && String(event.message).includes(refusal));
    const expectTimerPark = (id: string, timer: Wait, refusal: string) => {
      expect(store.getRun(id)?.waits).toEqual([expect.objectContaining({ id: timer.id, phase: 'open' })]);
      expect(nudgeNotes(id)).toEqual([]);
      expect(prompted(runner, refusal)).toEqual([]);
      expect(engine().monitoring.has(id)).toBe(true);
      expect(words(id).slice(-1)).toEqual(['monitoring']);
    };

    it(`${runner} U27 U11 a fresh step's refused done beside an open timer parks on it and settles monitoring`, async () => {
      const { p, w } = await parentWithWorker(runner);
      const timer = await timerPark(p.id);
      const refusal = `Workers are still live: ${w.id}.`;
      const turns = turnEnds(p.id);
      expect(manager.sendMessage(p.id, [{ type: 'text', text: done }])).toBe(true);
      await until(() => turnEnds(p.id) > turns && parkedOn(p.id, viaOf(p.id, 'monitoring-line')) && refusalNoted(p.id, refusal));
      expectTimerPark(p.id, timer, refusal);
    });

    it(`${runner} U27 U11 a Continue's refused done beside an open timer parks on it and settles monitoring`, async () => {
      const { p, w } = await parentWithWorker(runner);
      const timer = await timerPark(p.id);
      const refusal = `Workers are still live: ${w.id}.`;
      engine().active.get(p.id)!.session.end();
      await until(() => !manager.isActive(p.id));
      expect(manager.continueRun(p.id, { text: done }).ok).toBe(true);
      await until(() => store.getRun(p.id)?.steps.some(step => step.id === 'continue-1') === true &&
        parkedOn(p.id, viaOf(p.id, 'monitoring-line')) && refusalNoted(p.id, refusal) && manager.isActive(p.id));
      expectTimerPark(p.id, timer, refusal);
    });

    it(`${runner} U27 U11 a refused done beside an open timer that an acknowledgement settles late parks on it and settles monitoring`, async () => {
      await lateAck(async release => {
        const { p, w, progress } = await conversingParent(runner);
        const timer = await timerPark(p.id);
        const refusal = `Workers are still live: ${w.id}.`;
        const turns = turnEnds(p.id);
        const id = await progress(`${done} delay-owned-ack`);
        await heldAfterTurnEnd(p.id, turns, () => !delivered(p.id, id));
        release();
        await until(() => delivered(p.id, id) && parkedOn(p.id, viaOf(p.id, 'monitoring-line')) && refusalNoted(p.id, refusal) &&
          words(p.id).at(-1) === 'monitoring');
        expectTimerPark(p.id, timer, refusal);
      });
    });

    // One refusal nudge and no wait: the nudge's own word.
    for (const settledWorker of [false, true]) {
      const row = settledWorker ? 'U20u' : 'U20';
      const blocked = async (w: { id: string }) => {
        if (!settledWorker) return `Workers are still live: ${w.id}.`;
        manager.requestWorkerStop(w.id);
        expect(await manager.awaitRunTermination(w.id, 15_000)).toBe(true);
        return `Settled worker results are not collected yet. Collect each (\`worker collect ${w.id}\`)`;
      };
      const expectOneNudge = (id: string, refusal: string) => {
        const [nudge, ...more] = prompted(runner, refusal);
        expect(more).toEqual([]);
        if (settledWorker) expect(nudge).not.toContain(COMPLETION_WILL_WAIT);
        else expect(nudge).toContain(COMPLETION_WILL_WAIT);
        expect(nudgeNotes(id)).toHaveLength(1);
        expect(workerWaits(id)).toEqual([]);
        expect(words(id)).toContain('running (completion nudge)');
      };

      it(`${runner} U27 ${row} a fresh step's refused done gets one refusal nudge`, async () => {
        const { p, w } = await parentWithWorker(runner);
        const refusal = await blocked(w);
        expect(manager.sendMessage(p.id, [{ type: 'text', text: done }])).toBe(true);
        await until(() => prompted(runner, refusal).length > 0 && nudgeNotes(p.id).length === 1 && store.getRun(p.id)?.status === 'waiting');
        expectOneNudge(p.id, refusal);
      });

      it(`${runner} U27 ${row} a Continue's refused done gets one refusal nudge`, async () => {
        const { p, w } = await parentWithWorker(runner);
        const refusal = await blocked(w);
        await idleClose(p.id);
        expect(manager.continueRun(p.id, { text: done }).ok).toBe(true);
        await until(() => prompted(runner, refusal).length > 0 && nudgeNotes(p.id).length === 1 && store.getRun(p.id)?.status === 'waiting' &&
          store.getRun(p.id)?.steps.some(step => step.id === 'continue-1') === true);
        expectOneNudge(p.id, refusal);
      });

      // U20u has no late-acknowledgement cell: only a worker message is input with no wait behind it
      // (U20a), and a settled worker sends none. A wait's wake keeps its resolved wait open until its
      // acknowledgement, so the refusal beside it is a note, not a nudge.
      if (settledWorker) continue;
      it(`${runner} U27 ${row} a refused done an acknowledgement settles late gets one refusal nudge`, async () => {
        await lateAck(async release => {
          const { p, w, progress } = await conversingParent(runner);
          const refusal = await blocked(w);
          const turns = turnEnds(p.id);
          const id = await progress(`${done} delay-owned-ack`);
          await heldAfterTurnEnd(p.id, turns, () => !delivered(p.id, id) && nudgeNotes(p.id).length === 0);
          release();
          await until(() => delivered(p.id, id) && nudgeNotes(p.id).length === 1 && prompted(runner, refusal).length === 1);
          expectOneNudge(p.id, refusal);
        });
      });
    }
  }
}

function processCells(runners: RunnerId[]): void {
  for (const runner of runners) {
    it(`${runner} U1p a process wait registers through cezar_wait on the native wire, parks keeping its slot, and wakes with its exit code`, async () => {
      const external = processes();
      nativeWire(runner);
      const pid = sleeper();
      const run = manager.startRun(QUICK_TASK_WORKFLOW, { task: toolCall('cezar_wait', { kind: 'process', pid, exit_file: 'u1p.exit', note: 'u1p' }), runner });
      await until(() => parkedOn(run.id, waitOfKind(run.id, 'process')));
      const wait = waitOfKind(run.id, 'process')!;
      expect(wait).toMatchObject({ via: 'cezar_wait', source: 'agent', pid, note: 'u1p', startToken: expect.any(String),
        exitFile: join(store.getRun(run.id)!.worktreePath!, 'u1p.exit') });
      expect(engine().monitoring.has(run.id)).toBe(true);
      expect(deriveAttention(store.getRun(run.id)!).label).toBe('waiting for a command');
      external.settle({ outcome: 'exit_file', exitCode: 0 });
      await until(() => settled(run.id, wait.id)?.phase === 'delivered' && prompted(runner, processText(wait, ' (u1p): exited with code 0')).length > 0);
      expect(inputsFor(run.id, wait.id)).toHaveLength(1);
      await until(() => store.getRun(run.id)?.status === 'waiting');

      const other = sleeper();
      expect(manager.sendMessage(run.id, [{ type: 'text', text: toolCall('cezar_wait', { kind: 'process', pid: other }) }])).toBe(true);
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
      const opened = `${toolCall('cezar_wait', { kind: 'process', pid })} ${toolCall('cezar_wait', { kind: 'timer', seconds: 60, note: 'u2p' })}`;
      const run = manager.startRun(QUICK_TASK_WORKFLOW, { task: opened, runner });
      await until(() => parkedOn(run.id, waitOfKind(run.id, 'process')) && waitOfKind(run.id, 'timer')?.phase === 'open');
      const wait = waitOfKind(run.id, 'process')!, timer = waitOfKind(run.id, 'timer')!;
      const turns = turnEnds(run.id);
      fireTimer(timer.id);
      await until(() => settled(run.id, timer.id)?.phase === 'delivered' && prompted(runner, timerText(timer, 'u2p')).length > 0);
      expect(prompted(runner, timerText(timer, 'u2p')).at(-1)).toContain(`\n\nStill open: process wait ${wait.id} on PID ${pid}`);
      await until(() => turnEnds(run.id) > turns && parkedOn(run.id, waitOfKind(run.id, 'process')));
      expect(store.getRun(run.id)?.waits).toEqual([expect.objectContaining({ id: wait.id, phase: 'open' })]);
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
      const run = manager.startRun(QUICK_TASK_WORKFLOW, { task: `${toolCall('cezar_wait', { kind: 'process', pid })} ${toolCall('cezar_cancel_wait', { wait_id: 'last' })}`, runner });
      await until(() => store.getRun(run.id)?.lastWaits?.some(wait => wait.kind === 'process') === true && store.getRun(run.id)?.status === 'waiting');
      const wait = store.getRun(run.id)!.lastWaits!.find(entry => entry.kind === 'process')!;
      expect(wait).toMatchObject({ phase: 'cancelled', via: 'cezar_wait' });
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
      const run = manager.startRun(QUICK_TASK_WORKFLOW, { runner, task: HARNESS_ADAPTERS[runner].scenarios['provider-error']! });
      await until(wire.held);
      const tools = manager.cezarToolHandlers(run.id, engine().active.get(run.id)!.ciGeneration);
      const registered = await tools.registerWait({ kind: 'process', pid: sleeper(), timeout_seconds: 60 }, 'cezar_wait', new AbortController().signal);
      expect(registered.answer).toMatchObject({ ok: true, kind: 'process' });
      if (!('wait' in registered)) throw Error('registration refused');
      const wait = registered.wait;
      const failedState = engine().active.get(run.id);
      wire.release();
      await until(() => store.readEvents(run.id).some(event => event.type === 'error'));
      await until(() => engine().active.get(run.id) !== failedState);
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
      const tools = manager.cezarToolHandlers(run.id, engine().active.get(run.id)!.ciGeneration);
      const registered = await tools.registerWait({ kind: 'process', pid: sleeper(), timeout_seconds: 60 }, 'cezar_wait', new AbortController().signal);
      if (!('wait' in registered)) throw Error('registration refused');
      const wait = registered.wait;
      engine().active.get(run.id)!.session.end();
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
      const run = manager.startRun(QUICK_TASK_WORKFLOW, { task: toolCall('cezar_wait', { kind: 'process', pid, note: 'u9pr' }), runner });
      await until(() => parkedOn(run.id, waitOfKind(run.id, 'process')));
      const wait = waitOfKind(run.id, 'process')!;
      await restart();
      expect(manager.isActive(run.id)).toBe(false);
      await until(() => external.watches() === 2);
      expect(waitOfKind(run.id, 'process')).toMatchObject({ id: wait.id, phase: 'open' });
      external.settle({ outcome: 'exited' });
      await until(() => settled(run.id, wait.id)?.phase === 'delivered' && prompted(runner, processText(wait, ' (u9pr): exited, code unknown')).length > 0);
      await until(() => store.getRun(run.id)?.status === 'waiting');
    });
  }
}

// hearsay-tools/cezarion#1531: the single-runner cells run once, on the claude wire, from
// `waits-parity.test.ts`. They take no runner: a cell for every runner goes in its part's cell group
// (`baseCells`, `workersCells`, `entriesCells` or `processCells`), which the per-runner files run.
function singleRunnerCells(): void {
  // hearsay-tools/cezarion#1301: a run owes at most one refusal. A gate that refuses the done again
  // while the queued copy waits out a failed delivery's backoff adds no second copy and no charge.
  it('a done blocked again while its queued refusal is owed queues no second copy', async () => {
    const { p, w } = await parentWithWorker('claude');
    const refusal = `Workers are still live: ${w.id}.`;
    const refusals = () => store.getRun(p.id)?.agentInputs?.filter(input => input.text.includes(refusal)) ?? [];
    let closing = true;
    const closeAtTurnEnd = ({ runId, event }: { runId: string; event: { type: string } }) => {
      if (runId === p.id && event.type === 'turn-end' && closing && refusals().some(input => !input.deliveredAt)) engine().active.get(p.id)?.session.end();
    };
    store.on('event', closeAtTurnEnd);
    try {
      engine().active.get(p.id)!.session.end();
      await until(() => store.getRun(p.id)?.waitDeliveryFailures === 1 && !manager.isActive(p.id) && engine().wakeBackoffs.has(p.id));
      closing = false;
      const wakes = store.getRun(p.id)?.automaticWakes;
      expect((manager as unknown as { deferParentCompletion(id: string): boolean }).deferParentCompletion(p.id)).toBe(true);
      expect(refusals()).toHaveLength(1);
      expect(refusals()[0]!.deliveredAt).toBeUndefined();
      expect(nudgeNotes(p.id)).toHaveLength(1);
      expect(store.getRun(p.id)?.automaticWakes).toBe(wakes);
    } finally {
      store.off('event', closeAtTurnEnd);
    }
  });

  // hearsay-tools/cezarion#1301: a wait's lifecycle input is that wait's. Once the wait is
  // delivered, the same input undelivered again (a replay) is not a fresh wake.
  it('a delivered wait\'s lifecycle input is never owed again', async () => {
    nativeWire('claude');
    const run = manager.startRun(QUICK_TASK_WORKFLOW, { task: toolCall('cezar_wait', { kind: 'timer', seconds: 60, note: 'reowed' }), runner: 'claude' });
    await until(() => parkedOn(run.id, waitOfKind(run.id, 'timer')));
    const timer = waitOfKind(run.id, 'timer')!;
    fireTimer(timer.id);
    await until(() => settled(run.id, timer.id)?.phase === 'delivered' && store.getRun(run.id)?.status === 'waiting');
    const owes = (record: RunRecord) => {
      return (manager as unknown as { owesWake(run: RunRecord): boolean }).owesWake(record);
    };
    const replayed = { ...store.getRun(run.id)!, agentInputs: store.getRun(run.id)!.agentInputs!.map(input => input.id === timer.id ? { ...input, deliveredAt: undefined } : input) };
    expect(owes(replayed)).toBe(false);
    // A lifecycle input no wait names is still owed.
    const orphan: AgentInput = { id: randomUUID(), parentRunId: run.id, source: 'lifecycle', text: 'orphan', createdAt: new Date().toISOString() };
    expect(owes({ ...replayed, agentInputs: [...replayed.agentInputs, orphan] })).toBe(true);
  });

  // hearsay-tools/cezarion#1301: a refused done is not a done and cancels no wait. With a wait open
  // at that turn end there is no nudge: the run parks on the wait, and the refusal is a note.
  it('a blocked done with an open wait parks on that wait without a nudge', async () => {
    const { p, w } = await parentWithWorker('claude');
    const turns = turnEnds(p.id);
    expect(manager.sendMessage(p.id, [{ type: 'text', text: `${toolCall('cezar_wait', { kind: 'timer', seconds: 60, note: 'u20 timer' })} ${thenSay('All done.\nCEZ:DONE')}` }])).toBe(true);
    await until(() => turnEnds(p.id) > turns && parkedOn(p.id, waitOfKind(p.id, 'timer')));
    const refusal = `Workers are still live: ${w.id}.`;
    expect(store.readEvents(p.id).filter(event => event.type === 'note' && String(event.message).includes(refusal))).toHaveLength(1);
    expect(store.readEvents(p.id).some(event => event.type === 'note' && String(event.message).startsWith(COMPLETION_NUDGE_NOTE))).toBe(false);
    expect(prompted('claude', refusal)).toEqual([]);
    expect(waitOf(store.getRun(p.id))).toBeUndefined();
    expect(store.getRun(p.id)?.delegation).not.toHaveProperty('completion');
    expect(agentWaits(p.id)).toEqual([expect.objectContaining({ kind: 'timer', phase: 'open' })]);
  });

  // hearsay-tools/cezarion#1301: only a done line or an accepted cezar_done in the nudge's reply turn
  // takes the second step. A cezar_done refused mid-turn is no done: the turn ended with no wait.
  it('a tool-refused done in the nudge\'s reply turn takes the no-wait rule', async () => {
    process.env.CEZ_MOCK_COMPLETION_REPLY = `${toolCall('cezar_done', {})} ${thenSay('I will collect it next.')}`;
    const { p, w } = await parentWithWorker('claude');
    // Uncollected only: with live workers the ordinary rule would open the implicit re-check timer.
    manager.requestWorkerStop(w.id);
    expect(await manager.awaitRunTermination(w.id, 15_000)).toBe(true);
    expect(manager.sendMessage(p.id, [{ type: 'text', text: messagesPrompt('claude', ['All done.\nCEZ:DONE']) }])).toBe(true);
    await until(() => prompted('claude', NO_WAIT_NUDGE).length > 0 && humanOpen(p.id)[0]?.via === 'no-wait' && gated(p.id));
    expect(prompted('claude', `Collect each (\`worker collect ${w.id}\`)`)).toHaveLength(1);
    expect(workerWaits(p.id)).toEqual([]);
    expect(humanOpen(p.id)).toEqual([expect.objectContaining({ source: 'cezar', via: 'no-wait' })]);
  });

  it('workers settled during the nudge turn let the done finish', async () => {
    const release = join(root, 'release-u21');
    process.env.CEZ_MOCK_RELEASE_FILE = release;
    process.env.CEZ_MOCK_COMPLETION_REPLY = 'mock:hold-done';
    const { p, w } = await parentWithWorker('claude');
    expect(manager.sendMessage(p.id, [{ type: 'text', text: messagesPrompt('claude', ['All done.\nCEZ:DONE']) }])).toBe(true);
    await until(() => prompted('claude', `Workers are still live: ${w.id}.`).length > 0);
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
    process.env.CEZ_MOCK_COMPLETION_REPLY = messagesPrompt('claude', ['Still done.\nCEZ:DONE']);
    const { p, w: live } = await parentWithWorker('claude');
    const stopped = await worker(p.id);
    manager.requestWorkerStop(stopped.id);
    expect(await manager.awaitRunTermination(stopped.id, 15_000)).toBe(true);
    const entry = await ignoreRefusal('claude', p.id, `Workers are still live: ${live.id}.`, () => workerWaits(p.id)[0]?.phase === 'open');
    expect(entry.workerIds).toEqual([live.id]);
    expect(entry.revisions).toEqual([{ workerId: live.id, revision: expect.any(Number) }]);
  });
}
