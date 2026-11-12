import { setTimeout as nativeTimeout, clearTimeout as clearNativeTimeout } from 'node:timers';
import { observationClock } from '../core/observation-clock.testkit.ts';
import { WAKE_RETRY_BACKOFF } from '../delegation/retry-backoff.ts';
import { COMPLETION_NUDGE_NOTE, COMPLETION_NO_REPLY_NOTE, NO_WAIT_NUDGE_REPLY_MS, IDLE_TIMEOUT_MS } from './run.ts';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { vi, expect, onTestFinished, describe, beforeEach, afterEach, it as registerTest } from 'vitest';
import { WAIT_PHASE, WAIT_KIND } from '@open-mercato/cezar-contract/test-factories.testkit';
import type { CiWaitResult, ProcessWaitResult, Wait, HumanWaitEntry, WorkerWaitEntry, ConversationMessage, RunRecord } from '@open-mercato/cezar-contract';
import type { RunnerId, RunnerFactory } from '../core/agent-runner.ts';
import { useRunners, runnersUnderTest } from '../core/runners-under-test.testkit.ts';
import { ClaudeCliRunner } from '../core/claude-cli-runner.ts';
import { HARNESS_ADAPTERS } from '../core/harness-parity-core.testkit.ts';
import { familyCells } from '../core/parity-classes.testkit.ts';
import { CiWatcherSupervisor } from '../ci-wait/supervisor.ts';
import { ProcessWaitSupervisor } from '../process-wait/supervisor.ts';
import { root, store, parent, until, timeline, worker, checkpoint, manager, terminal, collect, delegatingParent, spendWorkerBudget, semaphore, toolGenerationOf, useWorkerWaitFixture } from './worker-wait-core.testkit.ts';
import { fireCapturedTimer, type TimedWait } from './waits.testkit.ts';
import { QUICK_TASK_WORKFLOW } from './types.ts';
import { hasPendingAsk } from '../runs/run-store.testkit.ts';
import { ciNativeMessages, toolCall, gate, thenSay } from './waits-parity.testkit.ts';
import { type WaitParityPart, type WaitCells, type WaitPartScope, waitPartModule, familyTest, type WaitParityFamily, type WaitFold, type WaitFoldScope, waitFoldModule, foldCells } from './waits-parity-catalog.testkit.ts';

// hearsay-tools/cezarion#1233: every runner opens, cancels and survives CI and timer waits on its
// own native wire. The production tool controller, bundled tool, runner, store and scheduler stay
// real; only GitHub (metadata and the watch) is controlled.

export const pr = 'https://github.com/acme/repo/pull/12';
const identity = { prUrl: pr, repository: 'acme/repo', prNumber: 12, headSha: 'a'.repeat(40) };
const passed = (): CiWaitResult => ({ outcome: 'passed', headSha: identity.headSha, observedAt: new Date().toISOString(), checks: [], totalChecks: 1, truncated: false });

export function github() {
  let settle!: (result: CiWaitResult) => void;
  let signal: AbortSignal | undefined;
  const result = new Promise<CiWaitResult>(resolve => { settle = resolve; });
  vi.spyOn(CiWatcherSupervisor.prototype, 'resolve').mockResolvedValue(identity);
  vi.spyOn(CiWatcherSupervisor.prototype, 'watch').mockImplementation((_wait, abort) => { signal = abort; return result; });
  return { settle: () => settle(passed()), aborted: () => signal?.aborted };
}

// hearsay-tools/cezarion#1446: only the process watch is controlled; registration, the park and the
// delivery cross the runner's own wire.
export function processes() {
  const watches: Array<{ signal: AbortSignal; settle: (result: ProcessWaitResult) => void }> = [];
  vi.spyOn(ProcessWaitSupervisor.prototype, 'watch').mockImplementation((_request, signal) =>
    new Promise<ProcessWaitResult>(resolve => { watches.push({ signal, settle: resolve }); }));
  return {
    watches: () => watches.length,
    settle: (result: Omit<ProcessWaitResult, 'observedAt'>, index = watches.length - 1) => watches[index]!.settle({ observedAt: new Date().toISOString(), ...result }),
    aborted: () => watches.at(-1)?.signal.aborted,
  };
}

export function nativeWire(runner: RunnerId) {
  process.env.CEZ_DRY_RUN = '0';
  process.env[HARNESS_ADAPTERS[runner].binEnv] = HARNESS_ADAPTERS[runner].mockBin;
  // The prompts each native mock admitted, read back by `ciNativeMessages`.
  process.env.CEZ_MOCK_ARGS_FILE = join(root, 'args');
  process.env.CEZ_MOCK_STDIN_FILE = join(root, 'stdin');
}

export const waitOfKind = (id: string, kind: Wait['kind']) => store.getRun(id)?.waits?.find(wait => wait.kind === kind);
/** The agent's waits. A delivered turn that ends with none takes the no-wait nudge, and the mock's
 *  plain reply leaves Cezar's own no-wait wait open (hearsay-tools/cezarion#1234). */
export const agentWaits = (id: string) => (store.getRun(id)?.waits ?? []).filter(wait => wait.source !== 'cezar');
export const settled = (id: string, waitId: string) => store.getRun(id)?.lastWaits?.find(wait => wait.id === waitId);
export const listed = (id: string, waitId: string) => store.getRun(id)?.waits?.find(wait => wait.id === waitId && wait.phase === WAIT_PHASE.open);
export const inputsFor = (id: string, waitId: string) => store.getRun(id)?.agentInputs?.filter(input => input.id === waitId) ?? [];
const toolResources = vi.hoisted(() => ({ current: undefined as { controller(): Promise<unknown> } | undefined }));
vi.mock('../ci-wait/resources.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('../ci-wait/resources.ts')>();
  return { ...actual, acquireCiResources: (...args: Parameters<typeof actual.acquireCiResources>) => {
    const resource = actual.acquireCiResources(...args); toolResources.current = resource; return resource;
  } };
});
const runnerBoundary = vi.hoisted(() => ({
  sessions: new Map<string, import('../core/agent-runner.ts').AgentSession>(),
  beforeReturn: undefined as ((runId: string) => void) | undefined,
  sessionFiles: new Map<string, string>(),
}));
/** The test file's runner for its parents, and the Claude runner for the workers this kit runs on
 *  the Claude wire whatever the parent's runner is (hearsay-tools/cezarion#2939). */
function withClaudeWorkers(inner: RunnerFactory): RunnerFactory {
  return (backend, options) => backend === 'claude' || backend === 'claude-cli' ? new ClaudeCliRunner() : inner(backend, options);
}

/** The test file's runners, with each session recorded at its boundary. */
function boundaryRunners(inner: RunnerFactory): RunnerFactory {
  return (...args) => {
    const runner = inner(...args);
    const start = runner.startSession.bind(runner);
    runner.startSession = (spec, ...rest) => {
      const runId = spec.env!.CEZ_TASK_ID!;
      const sessionsFile = runner.backend === 'opencode' ? runnerBoundary.sessionFiles.get(runId) : undefined;
      const previousSessionsFile = process.env.CEZ_MOCK_OPENCODE_SESSIONS_FILE;
      try {
        if (sessionsFile) process.env.CEZ_MOCK_OPENCODE_SESSIONS_FILE = sessionsFile;
        const session = start(spec, ...rest);
        runnerBoundary.sessions.set(runId, session);
        runnerBoundary.beforeReturn?.(runId);
        return session;
      } finally {
        if (sessionsFile) {
          if (previousSessionsFile === undefined) delete process.env.CEZ_MOCK_OPENCODE_SESSIONS_FILE;
          else process.env.CEZ_MOCK_OPENCODE_SESSIONS_FILE = previousSessionsFile;
        }
      }
    };
    return runner;
  };
}
export const sessionOf = (id: string) => runnerBoundary.sessions.get(id)!;
export let idleClock: ReturnType<typeof observationClock>;
export let retryClock: ReturnType<typeof observationClock>;
let admissionClock: ReturnType<typeof observationClock>;
// No exported admission interval exists; match its one-second timer and exact owner.
export function observeAdmissionRetries() {
  admissionClock = observationClock(delay => delay === 1000 && /\bat WakeRetries\.retryWaitAdmission \(/.test(new Error().stack ?? ''));
}
let accelerateRetries = false;
// Only retry backoffs use fake time; child-process and drain timers stay native.
export function retryAtOnce() { accelerateRetries = true; }
function observeBackoffs() {
  let index = 0;
  const clock = observationClock(delay => {
    const owned = delay !== undefined && delay >= WAKE_RETRY_BACKOFF.fastMs && delay <= WAKE_RETRY_BACKOFF.capMs &&
      /\bat WakeRetries\.backoff \(/.test(new Error().stack ?? '');
    if (owned && accelerateRetries) { const captured = index++; nativeTimeout(() => clock.fire(captured), 0); }
    else if (owned) index++;
    return owned;
  });
  return clock;
}
export const stepStatus = (id: string, stepId: string) => store.getRun(id)?.steps.find(step => step.id === stepId)?.status;
export const fireTimer = (waitId: string) => fireCapturedTimer(waitId);
export const flushMicrotasks = async () => { for (let n = 0; n < 5; n++) await Promise.resolve(); };
export const turnEnds = (id: string) => store.readEvents(id).filter(event => event.type === 'turn-end').length;
export const viaOf = (id: string, via: Wait['via']) => store.getRun(id)?.waits?.find((wait): wait is TimedWait => wait.via === via && wait.kind !== 'human');
export const parkedOn = (id: string, wait: Wait | undefined) => wait?.phase === 'open' && store.getRun(id)?.status === 'waiting';
export const prompted = (runner: RunnerId, text: string) => ciNativeMessages(runner, root).filter(prompt => prompt.includes(text));
export const asks = (id: string) => store.readEvents(id).filter(event => event.type === 'ask.requested');
export const answered = (id: string, askSeq: number) => store.readEvents(id).some(event => event.type === 'human-input-delivered' && event.askSeq === askSeq);
export const pendingQuestion = (id: string) => hasPendingAsk(store, id) === true && store.getRun(id)?.status === 'waiting';

// hearsay-tools/cezarion#1234: one human wait per run, shown as one card.
export const questions = [{ header: 'Choice', question: 'Which module?', options: [{ label: 'Parser' }, { label: 'Runner' }] }];
/** hearsay-tools/cezarion#1458: cezar_ask requires the Markdown the user reads above the card. */
export const ASK_CONTEXT = '## Draft\n\n- first finding\n- second finding';
/** A turn that asks `questions` through cezar_ask. */
export const askPrompt = () => toolCall('cezar_ask', { context: ASK_CONTEXT, questions });
export const humanOpen = (id: string) => store.getRun(id)?.waits?.filter((wait): wait is HumanWaitEntry => wait.kind === 'human') ?? [];
/** The run waits on an open human wait it has shown: as a card, or as the gate a wait without one raises. */
export const gated = (id: string) => store.getRun(id)?.status === 'waiting' && humanOpen(id)[0]?.askSeq !== undefined;
/** `Header: label` per question of the newest card: the line every native answer seam parses. An
 *  open question takes typed words, as the card sends them. */
export const answerOf = (id: string) => (asks(id).at(-1) as unknown as { questions: Array<{ header: string; options?: Array<{ label: string }> }> })
  .questions.map(question => `${question.header}: ${question.options?.[0]!.label ?? 'cez-dev'}`).join('\n');

// hearsay-tools/cezarion#1235 phase 3a: worker waits in the list.
export const workerWaits = (id: string) => (store.getRun(id)?.waits ?? []).filter((wait): wait is WorkerWaitEntry => wait.kind === 'worker');
export const workerWake = (wait: Wait) => `Worker wait ${wait.id} (terminal outcome)`;
export const delivered = (id: string, inputId: string) => !!store.getRun(id)?.agentInputs?.find(input => input.id === inputId)?.deliveredAt;
export const conversationOf = (id: string): ConversationMessage[] => {
  const delegation = store.getRun(id)?.delegation;
  return delegation?.role === 'root' ? delegation.conversation?.messages ?? [] : [];
};
/** Cezar's park notices from a worker to its parent (hearsay-tools/cezarion#1327): progress the worker never sent itself. */
export const parkNotices = (parentId: string, workerId: string) => conversationOf(parentId).filter(message =>
  message.senderRunId === workerId && message.kind === 'progress' && message.text.startsWith('Cezar notice: '));
/** A root parent on `runner`'s native wire, parked after its opening turn. */
export async function parentOn(runner: RunnerId) {
  nativeWire(runner);
  const p = await parent(HARNESS_ADAPTERS[runner].scenarios.baseline!, runner);
  await until(() => store.getRun(p.id)?.status === 'waiting', () => timeline(p.id));
  return p;
}

/** A root parent on `runner`'s native wire, parked after its opening turn, and one worker it owns
 *  that never starts: `fixtureUpdateRun` settles it. Workers run on the Claude wire. A restart
 *  starts the worker, so a cell that restarts gives it a `task` that settles on its own. */
export async function parentWithWorker(runner: RunnerId, step?: string, task?: string) {
  const p = await workerParent(runner, step);
  return { p, w: await worker(p.id, task) };
}
/** `parentWithWorker`'s parent, with no worker yet: a done the tool accepts (`blockedDone`). */
export async function workerParent(runner: RunnerId, step?: string) {
  nativeWire(runner);
  process.env.CEZ_CLAUDE_BIN = HARNESS_ADAPTERS.claude.mockBin;
  const p = await parent(HARNESS_ADAPTERS[runner].scenarios.baseline!, runner);
  checkpoint('parent-opening-repark');
  await until(() => store.getRun(p.id)?.status === 'waiting', () => step ? `${step}: opening park\n${timeline(p.id)}` : timeline(p.id));
  return p;
}

/** One parent turn through the native wire: `text`'s tool calls run, and the turn ends parked. */
export async function parentTurn(id: string, text: string, parked: () => boolean) {
  const turns = turnEnds(id);
  expect(manager.sendMessage(id, [{ type: 'text', text }])).toBe(true);
  await until(() => turnEnds(id) > turns && store.getRun(id)?.status === 'waiting' && parked());
}

/** A file the mock's `mock:gate` holds its turn on until `open` writes it (hearsay-tools/cezarion#2397). */
function turnGate(name: string) {
  const path = join(root, `gate-${name}-${randomUUID()}`);
  return { token: gate(path), open: () => writeFileSync(path, '') };
}
/** The live session's cezar_done was accepted this turn: the turn end takes it to the completion gate. */
const doneOffsets = new Map<string, number>();
function observeDone(id: string): void {
  if (!vi.isMockFunction(manager.acceptDone)) vi.spyOn(manager, 'acceptDone');
  doneOffsets.set(id, vi.mocked(manager.acceptDone).mock.calls.length);
}
const doneAccepted = (id: string) => vi.mocked(manager.acceptDone).mock.calls.some(([runId], index) =>
  index >= (doneOffsets.get(id) ?? 0) && runId === id && vi.mocked(manager.acceptDone).mock.results[index]?.value?.ok === true);

/** hearsay-tools/cezarion#2397: the tool refuses a done that a worker or request blocks, and that
 *  answer is the agent's (the turn end takes the no-wait rule). The turn end's completion refusal
 *  is reached when the tool accepts the done and `block` then adds the blocker before the turn
 *  ends, as an agent that spawns a worker after its done does. `send` opens the turn with the
 *  prompt: a human message unless the cell opens it otherwise. Returns what `block` returned. */
export async function blockedDone<T>(id: string, block: () => T | Promise<T>, send?: (prompt: string) => unknown, extra = ''): Promise<T> {
  observeDone(id);
  const after = turnGate('block');
  const prompt = `${toolCall('cezar_done', {})} ${after.token} ${thenSay('All done.')}${extra}`;
  if (send) await send(prompt);
  else expect(manager.sendMessage(id, [{ type: 'text', text: prompt }])).toBe(true);
  await until(() => doneAccepted(id), () => timeline(id));
  const blocker = await block();
  after.open();
  return blocker;
}

/** A worker of `parentId` that never starts, created now; `uncollected` settles it without collecting it. */
export async function blockingWorker(parentId: string, { uncollected = false, task }: { uncollected?: boolean; task?: string } = {}) {
  const w = await worker(parentId, task);
  if (uncollected) {
    manager.requestWorkerStop(w.id);
    expect(await manager.awaitRunTermination(w.id, 15_000)).toBe(true);
  }
  return w;
}
export const liveRefusal = (w: { id: string }) => `Workers are still live: ${w.id}.`;
export const uncollectedRefusal = (w: { id: string }) => `Settled worker results are not collected yet. Collect each (\`worker collect ${w.id}\`)`;

/** The nudge's reply turn (`CEZ_MOCK_COMPLETION_REPLY`) ends on a done its turn end refuses again:
 *  the second step (hearsay-tools/cezarion#1301). The tool refuses a done the first blocker still
 *  blocks, so the reply holds at `clear` until the test settled and collected that blocker, its
 *  cezar_done is accepted, and it holds at `block` until the test added the next blocker. A mock
 *  reads its environment when it is spawned: call it before the parent starts. */
export function repliesDoneAgain() {
  const clear = turnGate('reply-clear'), block = turnGate('reply-block');
  process.env.CEZ_MOCK_COMPLETION_REPLY = `${clear.token} ${toolCall('cezar_done', {})} ${block.token} ${thenSay('Still done.')}`;
  return { clear, block };
}
type DoneReply = ReturnType<typeof repliesDoneAgain>;

/** The reply turn of `repliesDoneAgain`: `first` settles and is collected, then `next` blocks. */
export async function replyBlockedAgain<T>(id: string, reply: DoneReply, first: { id: string }, next: () => T | Promise<T>): Promise<T> {
  if (!terminal.includes(store.getRun(first.id)?.status ?? '')) {
    manager.requestWorkerStop(first.id);
    expect(await manager.awaitRunTermination(first.id, 15_000)).toBe(true);
  }
  await collect(first.id);
  observeDone(id);
  reply.clear.open();
  await until(() => doneAccepted(id), () => timeline(id));
  const blocker = await next();
  reply.block.open();
  return blocker;
}

/** The parent's done is refused at the turn end (`blockedDone`, worker `first`), and the nudge's
 *  reply turn ends on done again, which worker `second` blocks (`replyBlockedAgain`): one refusal
 *  prompt, then `parked`. Returns both workers and the parent's open worker entry, if any. */
export async function ignoreRefusal(runner: RunnerId, id: string, reply: DoneReply, parked: () => boolean,
  { uncollected = false, send, task }: { uncollected?: boolean; send?: (prompt: string) => unknown; task?: string } = {}) {
  const first = await blockedDone(id, () => blockingWorker(id, { uncollected }), send);
  const refusal = uncollected ? uncollectedRefusal(first) : liveRefusal(first);
  checkpoint('completion-refusal-native-prompt');
  await until(() => prompted(runner, refusal).length > 0, () => timeline(id));
  const second = await replyBlockedAgain(id, reply, first, () => blockingWorker(id, { uncollected, ...(task ? { task } : {}) }));
  checkpoint('completion-refusal-repark');
  await until(() => store.getRun(id)?.status === 'waiting' && parked(), () => timeline(id));
  expect(prompted(runner, refusal)).toHaveLength(1);
  expect(store.readEvents(id).filter(event => event.type === 'note' && String(event.message).startsWith(COMPLETION_NUDGE_NOTE))).toHaveLength(1);
  return { first, second, refusal, entry: workerWaits(id)[0]! };
}

export const nudgeNotes = (id: string) => store.readEvents(id).filter(event => event.type === 'note' && String(event.message).startsWith(COMPLETION_NUDGE_NOTE));
export const noReplyNotes = (id: string) => store.readEvents(id).filter(event => event.type === 'note' && event.message === COMPLETION_NO_REPLY_NOTE);

/** A harness that acknowledges Cezar's completion refusal on its own native wire and never
 *  answers it (hearsay-tools/cezarion#1301): the mocks' `mock:ack-only` reply accepts the prompt,
 *  reports it read where the wire can, and starts no turn, as an OpenCode heartbeat keeps a session
 *  alive without one. Call it before the session starts: a mock reads its environment when spawned.
 *  After each delivery, call the returned function with that refusal. It waits for the native mock
 *  record before starting the shortened 300 ms reply window, including after a late ACK rearms it. */
export function silenceRefusals() {
  const clock = observationClock(delay => delay === NO_WAIT_NUDGE_REPLY_MS && /\bat TurnNudges\./.test(new Error().stack ?? ''));
  process.env.CEZ_MOCK_COMPLETION_REPLY = 'mock:ack-only';
  return async (runner: RunnerId, refusal: string, { after = 0 }: { after?: number } = {}) => {
    // bound: until's 15 s guards a missing mock record or a reply timer that never arms.
    await until(() => prompted(runner, refusal).length > after && clock.pending > 0);
    // A native ACK may rearm the same reply bound after the mock recorded the prompt.
    const timer = nativeTimeout(() => { if (clock.pending) clock.fire(clock.captured - 1); }, 300);
    onTestFinished(() => clearNativeTimeout(timer));
  };
}

/** A steering parent on `runner`'s native wire and a worker running on the Claude wire, parked,
 *  with each one's credential on a delegation service, as `cez worker send` reaches them. */
export async function conversingParent(runner: RunnerId) {
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
  return { p, w, ...messenger(service, callerFor, p, w), service, callerFor };
}

/** Worker `w`'s progress messages to its parent `p`, and the parent's inspection of it, through the
 *  delegation service with each one's credential. */
export function messenger(service: DelegationFixture['service'], callerFor: DelegationFixture['callerFor'], p: { id: string }, w: { id: string }) {
  const workerCaller = callerFor(w.id), parentCaller = callerFor(p.id);
  const inspect = () => service.inspect(parentCaller, { workerId: w.id });
  const progress = async (text: string) => {
    const id = randomUUID();
    await service.send(workerCaller, { id, recipientRunId: p.id, kind: 'progress', text, timeoutSeconds: 600 });
    return id;
  };
  return { progress, inspect };
}
type DelegationFixture = Awaited<ReturnType<typeof delegatingParent>>;

/** One competing monitor uses the exemption; membership of this park then costs a slot. */
export async function expectPoolCapacity(runner: RunnerId, id: string, member: boolean) {
  const limit = vi.spyOn(semaphore, 'maxMonitoringSessions').mockReturnValue(1);
  const previousSessionsFile = process.env.CEZ_MOCK_OPENCODE_SESSIONS_FILE;
  let competitor: RunRecord | undefined;
  try {
    // Each mock server inherits its own environment; the parked server keeps its original file.
    if (runner === 'opencode') process.env.CEZ_MOCK_OPENCODE_SESSIONS_FILE = join(root, `pool-competitor-${randomUUID()}.json`);
    competitor = manager.startRun(QUICK_TASK_WORKFLOW, { runner,
      task: toolCall('cezar_wait', { kind: WAIT_KIND.timer, seconds: 7200, note: 'pool capacity competitor' }) });
    const competitorId = competitor.id;
    await until(() => manager.isActive(competitorId) && parkedOn(competitorId, waitOfKind(competitorId, WAIT_KIND.timer)));
    expect(semaphore.busy(), `monitoring capacity for ${id}`).toBe(member ? 1 : 0);
  } finally {
    try {
      if (competitor) {
        const competitorId = competitor.id;
        manager.cancel(competitorId);
        await until(() => !manager.isActive(competitorId));
      }
    } finally {
      if (runner === 'opencode') {
        if (previousSessionsFile === undefined) delete process.env.CEZ_MOCK_OPENCODE_SESSIONS_FILE;
        else process.env.CEZ_MOCK_OPENCODE_SESSIONS_FILE = previousSessionsFile;
      }
      limit.mockRestore();
    }
  }
}

export const timerText = (wait: Wait, note: string) => `Timer ${wait.id} fired: ${note}. Continue toward the task goal; register another wait if you are still waiting.`;

/** Cleanup cancels the admission timer, and crossing its deadline produces no wake effects. */
export async function expectAdmissionRetryCleared(runner: RunnerId, id: string) {
  expect(admissionClock.captured).toBeGreaterThan(0);
  expect(admissionClock.pending).toBe(0);
  const before = structuredClone({ inputs: store.getRun(id)?.agentInputs, events: store.readEvents(id),
    failures: store.getRun(id)?.waitDeliveryFailures, attempts: ciNativeMessages(runner, root) });
  await admissionClock.advance(1001);
  await semaphore.release();
  expect({ inputs: store.getRun(id)?.agentInputs, events: store.readEvents(id),
    failures: store.getRun(id)?.waitDeliveryFailures, attempts: ciNativeMessages(runner, root) }).toEqual(before);
}
export async function timerWaits(id: string) {
  const tools = manager.squawkToolHandlers(id, toolGenerationOf(id));
  const timerWait = async (seconds: number, note: string) => {
    const registered = await tools.registerWait({ kind: WAIT_KIND.timer, seconds, note }, 'cezar_wait', new AbortController().signal);
    if (!('wait' in registered)) throw Error('registration refused');
    return registered.wait;
  };
  return { timer: await timerWait(60, 'u14'), later: await timerWait(7200, 'u14 later') };
}

/** The suite each wait parity file registers its cells in: the runners recorded at their boundary,
 *  the worker-wait fixture, and this kit's clocks reset before each cell. */
export function describeWaitCells(register: () => void): void {
  useRunners(boundaryRunners(withClaudeWorkers(runnersUnderTest())));
  describe('wait list on every native runner wire (hearsay-tools/cezarion#1233)', { timeout: 45_000 }, () => {
    useWorkerWaitFixture();
    beforeEach(() => {
      doneOffsets.clear();
      runnerBoundary.sessions.clear(); runnerBoundary.beforeReturn = undefined; accelerateRetries = false; retryClock = observeBackoffs();
      idleClock = observationClock(delay => delay === IDLE_TIMEOUT_MS && /\bat TurnSettler\.armIdleTimer \(/.test(new Error().stack ?? ''));
    });
    afterEach(() => vi.restoreAllMocks());
    register();
  });
}

/** The describers of a part's module. A file's runner runs the part's cells where the wait family's
 *  class runs them (core/parity-classes.testkit.ts); a family file runs one row family of them. */
export function waitPartDescribers(part: WaitParityPart, cells: WaitCells) {
  const describeWaitParity = (scope: WaitPartScope): void => {
    if (scope.part !== part) throw Error(`The ${part} cells cannot run the ${scope.part} part: import ${waitPartModule(scope.part)}`);
    const register = familyCells('waits', scope.runner, registerTest);
    describeWaitCells(() => cells([scope.runner], scope.family ? familyTest(scope as WaitParityFamily, register) : register));
  };
  /** Register a strict catalog reference, so the coverage scanner can prove every leaf call. */
  const describeWaitParityFamily = (scope: WaitParityFamily): void => describeWaitParity(scope);
  return { describeWaitParity, describeWaitParityFamily };
}

/** The describer of a fold's module: a folded runner's file registers that fold's cells. */
export function waitFoldDescriber(fold: WaitFold, cells: Partial<Record<WaitParityPart, WaitCells>>) {
  return (scope: WaitFoldScope): void => {
    if (scope.fold !== fold) throw Error(`The ${fold} fold cannot run the ${scope.fold} fold: import ${waitFoldModule(scope.fold)}`);
    // Each row runs on the runners its class names (core/parity-classes.testkit.ts).
    describeWaitCells(() => foldCells(scope.runner, fold, cells, registerTest));
  };
}

export { toolResources, runnerBoundary };
