import { runInternals } from './run-internals.testkit.ts';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { deriveAttention } from '@open-mercato/cezar-contract/attention';
import type { CezarWaitRequestInput, CiWait, CiWaitResult, Wait } from '@open-mercato/cezar-contract';
import type { AgentSession, RunnerId } from '../core/agent-runner.ts';
import { HARNESS_ADAPTERS } from '../core/harness-parity.testkit.ts';
import { CiWatcherSupervisor } from '../ci-wait/supervisor.ts';
import { manager, restart, root, semaphore, store, until, useWorkerWaitFixture } from './worker-wait.testkit.ts';
import { timed, type TimedWait } from './waits.testkit.ts';
import { readPersistedRuns, hasPendingAsk } from '../runs/run-store.testkit.ts';
import { MAX_WAKE_DELIVERY_ATTEMPTS, WAITS_DISCARDED_NOTE, WAKE_DELIVERY_CAP_NOTE } from './run.ts';
import { QUICK_TASK_WORKFLOW } from './types.ts';
import { ciNativeMessages, persistentWakeFailure, TIMER_WAKE_OPENING, toolCall } from './waits-parity.testkit.ts';

// hearsay-tools/cezarion#1233: how resolved waits wake a run beside a pending question, what every
// delivered turn ends with, and which parks hold a slot. The runner wires, store and scheduler are
// real; only GitHub is controlled.

const prUrl = (n: number) => `https://github.com/acme/repo/pull/${n}`;
const pr = prUrl(12);
const passed = (headSha: string): CiWaitResult => ({ outcome: 'passed', headSha, observedAt: new Date().toISOString(), checks: [], totalChecks: 1, truncated: false });

/** GitHub per PR number: each watch settles when the test says so. */
function github() {
  const watches = new Map<number, (result: CiWaitResult) => void>();
  vi.spyOn(CiWatcherSupervisor.prototype, 'resolve').mockImplementation(async (url: string) =>
    ({ prUrl: url, repository: 'acme/repo', prNumber: Number(url.split('/').pop()), headSha: 'a'.repeat(40) }));
  vi.spyOn(CiWatcherSupervisor.prototype, 'watch').mockImplementation((wait: CiWait) =>
    new Promise<CiWaitResult>(resolve => { watches.set(wait.prNumber, resolve); }));
  return { settle: (n = 12) => watches.get(n)!(passed('a'.repeat(40))) };
}

function nativeWire(runner: RunnerId) {
  process.env.CEZ_DRY_RUN = '0';
  process.env[HARNESS_ADAPTERS[runner].binEnv] = HARNESS_ADAPTERS[runner].mockBin;
  process.env.CEZ_MOCK_ARGS_FILE = join(root, 'args');
  process.env.CEZ_MOCK_STDIN_FILE = join(root, 'stdin');
}

const engine = () => manager as unknown as {
  active: Map<string, { session?: AgentSession; ciGeneration: string; idleTimer?: NodeJS.Timeout & { _onTimeout(): void };
    agentInputFlight?: { inputIds: string[] } }>;
};
async function openWait(id: string, request: CezarWaitRequestInput): Promise<TimedWait> {
  const tools = manager.cezarToolHandlers(id, engine().active.get(id)!.ciGeneration);
  const registered = await tools.registerWait(request, 'cezar_wait', new AbortController().signal);
  if (!('wait' in registered)) throw Error('registration refused');
  return timed(registered.wait);
}
/** A Claude run parked on the timers its first turn registered through `cezar_wait`, in order.
 *  Nothing human is open, so a baseline turn's no-wait nudge never interferes (hearsay-tools/cezarion#1234).
 *  Live sessions only: a scheduler continuation quotes the task, and the mock would call the tools again. */
async function parkedOnTimers<const T extends readonly { seconds: number; note: string }[]>(...timers: T) {
  const run = manager.startRun(QUICK_TASK_WORKFLOW, { task: timers.map(timer => toolCall('cezar_wait', { kind: 'timer', ...timer })).join(' '), runner: 'claude' });
  await until(() => store.getRun(run.id)?.status === 'waiting' && store.getRun(run.id)?.waits?.length === timers.length);
  const waits = timers.map(timer => store.getRun(run.id)!.waits!.find(wait => wait.kind === 'timer' && wait.note === timer.note)!) as { [K in keyof T]: Wait };
  return { run, waits };
}
const fireTimer = (waitId: string) => runInternals(manager).waitWatches.waitTimers.get(waitId)!.timer._onTimeout();
const turnStarted = (id: string) => store.readEvents(id).some(event => event.type === 'turn.started');
const turnEnds = (id: string) => store.readEvents(id).filter(event => event.type === 'turn-end').length;
const asks = (id: string) => store.readEvents(id).filter(event => event.type === 'ask.requested');
const waitById = (id: string, waitId: string) => store.getRun(id)?.waits?.find(wait => wait.id === waitId);
const settled = (id: string, waitId: string) => store.getRun(id)?.lastWaits?.find(wait => wait.id === waitId);
const prompted = (runner: RunnerId, text: string) => ciNativeMessages(runner, root).filter(prompt => prompt.includes(text));
const label = (id: string) => deriveAttention(store.getRun(id)!).label;
const answered = (id: string, askSeq: number) => store.readEvents(id).some(event => event.type === 'human-input-delivered' && event.askSeq === askSeq);
const flushMicrotasks = async () => { for (let n = 0; n < 5; n++) await Promise.resolve(); };
const FOOTER_END = 'Call cezar_cancel_wait for any you no longer need.';
const notes = (id: string, text: string) => store.readEvents(id).filter(event => event.type === 'note' && String(event.message).includes(text));

/** A portable question parked beside an open CI wait registered during its turn. */
async function questionBesideCi(runner: RunnerId) {
  nativeWire(runner);
  const release = join(root, 'ask-release');
  process.env.CEZ_MOCK_RELEASE_FILE = release;
  const run = manager.startRun(QUICK_TASK_WORKFLOW, { task: HARNESS_ADAPTERS[runner].scenarios['hold-ask']!, runner });
  await until(() => turnStarted(run.id));
  const ci = await openWait(run.id, { kind: 'pr', pr, timeout_seconds: 600 });
  writeFileSync(release, '');
  await until(() => asks(run.id).length === 1 && store.getRun(run.id)?.status === 'waiting');
  expect(waitById(run.id, ci.id)?.phase).toBe('open');
  expect(label(run.id)).toBe('needs you');
  return { run, ci, askSeq: asks(run.id)[0]!.seq };
}

describe('wakes beside questions, footers and slots (hearsay-tools/cezarion#1233)', { timeout: 45_000 }, () => {
  useWorkerWaitFixture({ nudgeReply: 'card' });
  afterEach(() => vi.restoreAllMocks());

  for (const runner of ['claude', 'codex'] as const) {
    it(`${runner} U3b a CI result beside a pending portable question is delivered, the card stays answerable, and the answer keeps its askSeq`, async () => {
      const external = github();
      const { run, ci, askSeq } = await questionBesideCi(runner);
      const turns = turnEnds(run.id);
      external.settle();
      await until(() => settled(run.id, ci.id)?.phase === 'delivered' && prompted(runner, `CI wait observation ${ci.id}`).length > 0);
      await until(() => turnEnds(run.id) > turns && store.getRun(run.id)?.status === 'waiting');
      expect(hasPendingAsk(store, run.id)).toBe(true);
      expect(label(run.id)).toBe('needs you');
      expect(store.readEvents(run.id).filter(event => event.type === 'human-input-delivered')).toEqual([]);
      expect(manager.sendMessage(run.id, [{ type: 'text', text: 'Vitest' }])).toBe(true);
      await until(() => answered(run.id, askSeq));
      // The answer's own turn end gets the no-wait nudge (hearsay-tools/cezarion#1234): the card
      // pending now is the one the mock answered it with, not the answered one.
      await until(() => asks(run.id).length === 2 && store.getRun(run.id)?.status === 'waiting');
      expect(asks(run.id)[1]).toMatchObject({ questions: [expect.objectContaining({ header: 'Next step' })] });
    });
  }

  it('codex a CI result during a native question waits for the answer and its turn end', async () => {
    const external = github();
    nativeWire('codex');
    const run = manager.startRun(QUICK_TASK_WORKFLOW, { task: 'mock:native-codex-ask', runner: 'codex' });
    await until(() => asks(run.id).length === 1 && store.getRun(run.id)?.status === 'waiting');
    const ci = await openWait(run.id, { kind: 'pr', pr, timeout_seconds: 600 });
    external.settle();
    await until(() => waitById(run.id, ci.id)?.phase === 'resolved');
    // The question holds its turn open: nothing may reach the wire, however often the line is pumped.
    await runInternals(manager).line.pump();
    await flushMicrotasks();
    expect(store.getRun(run.id)?.agentInputs?.find(input => input.id === ci.id)?.deliveredAt).toBeUndefined();
    expect(existsSync(join(root, 'args')) && readFileSync(join(root, 'args'), 'utf8').includes(ci.id)).toBe(false);
    expect(manager.sendMessage(run.id, [{ type: 'text', text: 'Library: Vitest' }])).toBe(true);
    await until(() => settled(run.id, ci.id)?.phase === 'delivered' && prompted('codex', `CI wait observation ${ci.id}`).length > 0);
    const events = store.readEvents(run.id);
    const answer = events.find(event => event.type === 'human-input-delivered')!;
    const answeredTurnEnd = events.find(event => event.type === 'turn-end' && event.seq > answer.seq)!;
    expect(answeredTurnEnd).toBeDefined();
    expect(prompted('codex', `CI wait observation ${ci.id}`)).toHaveLength(1);
    await until(() => store.getRun(run.id)?.status === 'waiting');
  });

  it('claude a CI result after a pending question idle-closed reopens through a scheduler continuation and re-parks as Needs you', async () => {
    const external = github();
    const { run, ci, askSeq } = await questionBesideCi('claude');
    const idle = engine().active.get(run.id)!.idleTimer!;
    const expire = idle._onTimeout; clearTimeout(idle); expire();
    await until(() => !manager.isActive(run.id));
    expect(store.getRun(run.id)).toMatchObject({ status: 'waiting', waits: expect.arrayContaining([expect.objectContaining({ kind: 'human', phase: 'open' })]) });
    expect(waitById(run.id, ci.id)?.phase).toBe('open');
    external.settle();
    await until(() => settled(run.id, ci.id)?.phase === 'delivered' && prompted('claude', `CI wait observation ${ci.id}`).length > 0);
    await until(() => manager.isActive(run.id) && store.getRun(run.id)?.status === 'waiting');
    expect(hasPendingAsk(store, run.id)).toBe(true);
    expect(label(run.id)).toBe('needs you');
    expect(manager.sendMessage(run.id, [{ type: 'text', text: 'Vitest' }])).toBe(true);
    // The continuation's opening prompt repeats the task, so the mock asks again; the answer goes to
    // the run's current question.
    await until(() => answered(run.id, asks(run.id).at(-1)!.seq));
    expect(asks(run.id)[0]!.seq).toBe(askSeq);
  });

  it('claude two waits resolved before one boundary are delivered in one submission and charged once', async () => {
    nativeWire('claude');
    const release = join(root, 'turn-release');
    process.env.CEZ_MOCK_RELEASE_FILE = release;
    const run = manager.startRun(QUICK_TASK_WORKFLOW, { task: HARNESS_ADAPTERS.claude.scenarios['hold-gated']!, runner: 'claude' });
    await until(() => turnStarted(run.id));
    const first = await openWait(run.id, { kind: 'timer', seconds: 60, note: 'first' });
    const second = await openWait(run.id, { kind: 'timer', seconds: 60, note: 'second' });
    fireTimer(first.id); fireTimer(second.id);
    await until(() => waitById(run.id, first.id)?.phase === 'resolved' && waitById(run.id, second.id)?.phase === 'resolved');
    writeFileSync(release, '');
    // The store marks the wake delivered before the mock records the prompt it read; wait for both.
    await until(() => settled(run.id, first.id)?.phase === 'delivered' && settled(run.id, second.id)?.phase === 'delivered'
      && prompted('claude', `Timer ${first.id} fired`).length > 0);
    const wakes = prompted('claude', `Timer ${first.id} fired`);
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toContain(`Timer ${second.id} fired`);
    expect(wakes[0]!.indexOf(first.id)).toBeLessThan(wakes[0]!.indexOf(second.id));
    // One admitted automatic turn spends one wake of the budget, however many timers it carries.
    expect(store.getRun(run.id)?.automaticWakes).toBe(1);
    expect(notes(run.id, 'automatic timer wake-up (').map(event => event.message)).toEqual(['automatic timer wake-up (1/40)']);
  });

  it('claude staggered timers at 39 spent wakes: the first wakes at 40, the second is cancelled with the cap note and wakes nothing', async () => {
    nativeWire('claude');
    const { run, waits: [first, second] } = await parkedOnTimers({ seconds: 60, note: 'first' }, { seconds: 120, note: 'second' });
    store.updateRun(run.id, { automaticWakes: 39 });
    const turns = turnEnds(run.id);
    fireTimer(first.id);
    await until(() => settled(run.id, first.id)?.phase === 'delivered');
    expect(notes(run.id, 'automatic timer wake-up (').map(event => event.message)).toEqual(['automatic timer wake-up (40/40)']);
    await until(() => turnEnds(run.id) > turns && store.getRun(run.id)?.status === 'waiting');
    expect(label(run.id)).toBe('monitoring');
    const parkedTurns = turnEnds(run.id);
    fireTimer(second.id);
    await until(() => settled(run.id, second.id)?.phase === 'cancelled');
    expect(notes(run.id, 'cap reached').map(event => event.message)).toEqual([`automatic timer wake-up cap reached (40); timer ${second.id} cancelled`]);
    await flushMicrotasks();
    expect(store.getRun(run.id)?.agentInputs?.some(input => input.id === second.id)).toBe(false);
    expect(prompted('claude', `Timer ${second.id} fired`)).toEqual([]);
    expect(turnEnds(run.id)).toBe(parkedTurns);
    expect(store.getRun(run.id)?.automaticWakes).toBe(40);
    // Nothing else open or resolved: the budget's human wait parks for the user and holds no slot
    // (hearsay-tools/cezarion#1234).
    expect(store.getRun(run.id)?.waits).toMatchObject([{ kind: 'human', via: 'budget', source: 'cezar', phase: 'open' }]);
    expect(label(run.id)).toBe('needs you');
    expect(runInternals(manager).line.monitoring.has(run.id)).toBe(false);
    expect(semaphore.busy()).toBe(0);
  });

  it('claude a timer result still owed when the budget is spent is cancelled before its batch is sent; the CI result beside it is delivered', async () => {
    const external = github();
    nativeWire('claude');
    const release = join(root, 'turn-release');
    process.env.CEZ_MOCK_RELEASE_FILE = release;
    const run = manager.startRun(QUICK_TASK_WORKFLOW, { task: HARNESS_ADAPTERS.claude.scenarios['hold-gated']!, runner: 'claude' });
    await until(() => turnStarted(run.id));
    const timer = await openWait(run.id, { kind: 'timer', seconds: 60, note: 'owed' });
    const ci = await openWait(run.id, { kind: 'pr', pr, timeout_seconds: 600 });
    fireTimer(timer.id); external.settle();
    await until(() => waitById(run.id, timer.id)?.phase === 'resolved' && waitById(run.id, ci.id)?.phase === 'resolved');
    // The budget runs out between the timer's resolution and the boundary that would send it.
    store.updateRun(run.id, { automaticWakes: 40 });
    writeFileSync(release, '');
    await until(() => settled(run.id, ci.id)?.phase === 'delivered' && prompted('claude', `CI wait observation ${ci.id}`).length > 0);
    expect(settled(run.id, timer.id)?.phase).toBe('cancelled');
    expect(notes(run.id, 'cap reached').map(event => event.message)).toEqual([`automatic timer wake-up cap reached (40); timer ${timer.id} cancelled`]);
    const wake = prompted('claude', `CI wait observation ${ci.id}`);
    expect(wake).toHaveLength(1);
    expect(wake[0]).not.toContain(`Timer ${timer.id} fired`);
    expect(store.getRun(run.id)?.automaticWakes).toBe(40);
    expect(notes(run.id, 'automatic timer wake-up (')).toEqual([]);
  });

  it('claude a refused timer batch gives its budget reservation back and is retried', async () => {
    nativeWire('claude');
    const { run, waits: [timer] } = await parkedOnTimers({ seconds: 60, note: 'refused' });
    const state = engine().active.get(run.id)!;
    store.updateRun(run.id, { automaticWakes: 39 });
    const send = state.session!.sendAgentMessage.bind(state.session);
    const reserved: (number | undefined)[] = [];
    let refusals = 0;
    vi.spyOn(state.session!, 'sendAgentMessage').mockImplementation((content, ids) => {
      reserved.push(runInternals(manager).wakeAdmission.automaticWakes(run.id));
      if (refusals++ === 0) return false;
      return send(content, ids);
    });
    fireTimer(timer.id);
    await until(() => settled(run.id, timer.id)?.phase === 'delivered');
    // Reserved for each attempt, given back after the refusal, charged to the record on the acknowledgement.
    expect(reserved).toEqual([40, 40]);
    expect(store.getRun(run.id)?.automaticWakes).toBe(40);
    expect(notes(run.id, 'automatic timer wake-up (').map(event => event.message)).toEqual(['automatic timer wake-up (40/40)']);
  });

  it('claude every delivered turn ends with the open-waits footer, and none when nothing is open', async () => {
    github();
    nativeWire('claude');
    const run = manager.startRun(QUICK_TASK_WORKFLOW, { task: HARNESS_ADAPTERS.claude.scenarios.baseline!, runner: 'claude' });
    await until(() => store.getRun(run.id)?.status === 'waiting');
    expect(manager.sendMessage(run.id, [{ type: 'text', text: 'first message' }])).toBe(true);
    await until(() => prompted('claude', 'first message').length > 0);
    expect(prompted('claude', 'first message')[0]).not.toContain('Still open');
    await until(() => store.getRun(run.id)?.status === 'waiting' && turnEnds(run.id) >= 2);
    const ci = await openWait(run.id, { kind: 'pr', pr, timeout_seconds: 600 });
    const footer = `Still open: CI wait ${ci.id} for acme/repo#12, deadline ${ci.deadline}. ${FOOTER_END}`;
    expect(manager.sendMessage(run.id, [{ type: 'text', text: 'second message' }])).toBe(true);
    await until(() => prompted('claude', 'second message').length > 0);
    expect(prompted('claude', 'second message')[0]!.trimEnd().endsWith(footer)).toBe(true);
    await until(() => store.getRun(run.id)?.status === 'waiting' && turnEnds(run.id) >= 3);
    // A continuation's opening prompt is a delivered turn too.
    engine().active.get(run.id)!.session!.end();
    await until(() => !manager.isActive(run.id));
    expect(manager.continueRun(run.id, { text: 'third message' }).ok).toBe(true);
    await until(() => prompted('claude', 'third message').length > 0);
    expect(prompted('claude', 'third message')[0]!.trimEnd().endsWith(footer)).toBe(true);
    expect(waitById(run.id, ci.id)?.phase).toBe('open');
  });

  it('pool members beyond maxMonitoringSessions hold regular slots; one leaving frees one and pumps', async () => {
    github();
    nativeWire('claude');
    vi.spyOn(semaphore, 'maxMonitoringSessions').mockReturnValue(1);
    expect(semaphore.maxParallel()).toBe(1);
    const parkOn = async (n: number) => {
      const run = manager.startRun(QUICK_TASK_WORKFLOW, { task: toolCall('cezar_wait', { kind: 'pr', pr: prUrl(n) }), runner: 'claude' });
      await until(() => store.getRun(run.id)?.waits?.[0]?.phase === 'open' && store.getRun(run.id)?.status === 'waiting');
      return run;
    };
    const first = await parkOn(12);
    expect(semaphore.busy()).toBe(0); // the pool slot
    const second = await parkOn(13);
    expect(semaphore.busy()).toBe(1); // past the pool: its regular slot
    const third = manager.startRun(QUICK_TASK_WORKFLOW, { task: HARNESS_ADAPTERS.claude.scenarios.baseline!, runner: 'claude' });
    expect(store.getRun(third.id)?.status).toBe('queued');
    expect(manager.cancel(first.id)).toBe(true);
    await until(() => store.getRun(third.id)?.status !== 'queued');
    expect(store.getRun(second.id)?.waits?.[0]?.phase).toBe('open');
  });

  /** A timer owed by a run whose session is closed: its wake is a scheduler continuation. The
   *  baseline task, quoted in that continuation's opening prompt, starts no scenario of its own. */
  async function timerOwedWithoutSession() {
    const run = manager.startRun(QUICK_TASK_WORKFLOW, { task: HARNESS_ADAPTERS.claude.scenarios.baseline!, runner: 'claude' });
    await until(() => store.getRun(run.id)?.status === 'waiting');
    const timer = await openWait(run.id, { kind: 'timer', seconds: 60, note: 'owed' });
    engine().active.get(run.id)!.session!.end();
    await until(() => !manager.isActive(run.id));
    return { run, timer };
  }

  it('claude a failed wake delivery retries after its backoff, not at once, and Continue resets the count', async () => {
    nativeWire('claude');
    persistentWakeFailure(root, 'claude');
    runInternals(manager).retries.wakeRetryBackoff = { fastMs: 60_000, fastCount: 1, capMs: 120_000 };
    const { run, timer } = await timerOwedWithoutSession();
    fireTimer(timer.id);
    // The backoff is armed before the failing session is dropped.
    await until(() => runInternals(manager).retries.wakeBackoffs.has(run.id) && !manager.isActive(run.id));
    // The failed attempt armed the backoff instead of the next continuation: nothing runs or queues.
    const first = runInternals(manager).retries.wakeBackoffs.get(run.id)!;
    expect((first as NodeJS.Timeout & { _idleTimeout: number })._idleTimeout).toBe(60_000);
    expect(prompted('claude', TIMER_WAKE_OPENING)).toHaveLength(1);
    expect(manager.isActive(run.id)).toBe(false);
    expect(runInternals(manager).line.queue).not.toContain(run.id);
    expect(store.getRun(run.id)?.status).toBe('waiting');
    expect(waitById(run.id, timer.id)?.phase).toBe('resolved');
    expect(store.getRun(run.id)?.waitDeliveryFailures).toBe(1);
    // The backoff owns the retry: when it fires, the second attempt starts and backs off further.
    first._onTimeout();
    await until(() => runInternals(manager).retries.wakeBackoffs.has(run.id) && runInternals(manager).retries.wakeBackoffs.get(run.id) !== first && !manager.isActive(run.id));
    expect(prompted('claude', TIMER_WAKE_OPENING)).toHaveLength(2);
    expect((runInternals(manager).retries.wakeBackoffs.get(run.id)! as NodeJS.Timeout & { _idleTimeout: number })._idleTimeout).toBe(120_000);
    expect(store.getRun(run.id)?.waitDeliveryFailures).toBe(2);
    // Continue is a human act: it clears the count and the pending backoff, and delivers the result.
    expect(manager.continueRun(run.id, { text: 'go on' }).ok).toBe(true);
    expect(runInternals(manager).retries.wakeBackoffs.has(run.id)).toBe(false);
    expect(store.getRun(run.id)?.waitDeliveryFailures).toBeUndefined();
    await until(() => settled(run.id, timer.id)?.phase === 'delivered' && prompted('claude', TIMER_WAKE_OPENING).length >= 2);
    expect(prompted('claude', TIMER_WAKE_OPENING)).toHaveLength(2);
  });

  // hearsay-tools/cezarion#1234: the budget and the failure count live on the run record.
  it('claude the automatic-wake budget survives a restart, a batch cut off by it is charged once, and a human message resets it', async () => {
    nativeWire('claude');
    // `later` stays open, so each delivered turn parks on it instead of taking the no-wait nudge.
    const { run, waits: [first, second] } = await parkedOnTimers({ seconds: 60, note: 'first' }, { seconds: 60, note: 'second' }, { seconds: 7200, note: 'later' });
    let turns = turnEnds(run.id);
    fireTimer(first.id);
    await until(() => settled(run.id, first.id)?.phase === 'delivered' && turnEnds(run.id) > turns && store.getRun(run.id)?.status === 'waiting');
    expect(store.getRun(run.id)?.automaticWakes).toBe(1);
    // The second wake reaches the wire; the process stops after the disk saw the batch and before
    // its acknowledgement did.
    const state = engine().active.get(run.id)!;
    const send = state.session!.sendAgentMessage.bind(state.session);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(state.session!, 'sendAgentMessage').mockImplementation((content, ids) => {
      const ack = send(content, ids);
      return ack && ack.then(() => gate);
    });
    fireTimer(second.id);
    await until(() => engine().active.get(run.id)?.agentInputFlight?.inputIds.includes(second.id) === true);
    store.flush();
    const beforeAck = readPersistedRuns(join(root, '.ai/cezar'));
    expect(beforeAck.find(row => row.id === run.id)?.automaticWakes).toBe(1);
    release();
    await restart(false, beforeAck);
    turns = turnEnds(run.id);
    expect(store.getRun(run.id)?.automaticWakes).toBe(1);
    expect(waitById(run.id, second.id)?.phase).toBe('resolved');
    // The continuation delivers the batch again and charges it once.
    await until(() => settled(run.id, second.id)?.phase === 'delivered');
    expect(store.getRun(run.id)?.automaticWakes).toBe(2);
    expect(notes(run.id, 'automatic timer wake-up (').map(event => event.message).at(-1)).toBe('automatic timer wake-up (2/40)');
    await until(() => turnEnds(run.id) > turns && store.getRun(run.id)?.status === 'waiting');
    expect(manager.sendMessage(run.id, [{ type: 'text', text: 'carry on' }])).toBe(true);
    expect(store.getRun(run.id)?.automaticWakes).toBe(0);
  });

  it('claude the delivery-failure count survives a restart', async () => {
    nativeWire('claude');
    persistentWakeFailure(root, 'claude');
    runInternals(manager).retries.wakeRetryBackoff = { fastMs: 60_000, fastCount: 1, capMs: 120_000 };
    const { run, timer } = await timerOwedWithoutSession();
    fireTimer(timer.id);
    await until(() => runInternals(manager).retries.wakeBackoffs.has(run.id) && !manager.isActive(run.id));
    const first = runInternals(manager).retries.wakeBackoffs.get(run.id)!;
    first._onTimeout();
    await until(() => runInternals(manager).retries.wakeBackoffs.has(run.id) && runInternals(manager).retries.wakeBackoffs.get(run.id) !== first && !manager.isActive(run.id));
    expect(store.getRun(run.id)?.waitDeliveryFailures).toBe(2);
    await restart();
    expect(store.getRun(run.id)?.waitDeliveryFailures).toBe(2);
    // The third failed attempt, the first after the restart, reaches the bound.
    await until(() => store.getRun(run.id)?.status === 'failed' && !manager.isActive(run.id));
    expect(prompted('claude', TIMER_WAKE_OPENING)).toHaveLength(MAX_WAKE_DELIVERY_ATTEMPTS);
    expect(notes(run.id, WAKE_DELIVERY_CAP_NOTE)).toHaveLength(1);
    expect(waitById(run.id, timer.id)?.phase).toBe('resolved');
    expect(store.getRun(run.id)?.waitDeliveryFailures).toBeUndefined();
  });

  it('claude a failed run holding a wait result keeps it and its armed open wait across a restart, and Stop discards them', async () => {
    nativeWire('claude');
    persistentWakeFailure(root, 'claude');
    runInternals(manager).retries.wakeRetryBackoff = { fastMs: 0, fastCount: MAX_WAKE_DELIVERY_ATTEMPTS, capMs: 0 };
    const run = manager.startRun(QUICK_TASK_WORKFLOW, { task: HARNESS_ADAPTERS.claude.scenarios.baseline!, runner: 'claude' });
    await until(() => store.getRun(run.id)?.status === 'waiting');
    const timer = await openWait(run.id, { kind: 'timer', seconds: 60, note: 'owed' });
    const later = await openWait(run.id, { kind: 'timer', seconds: 7200, note: 'later' });
    engine().active.get(run.id)!.session!.end();
    await until(() => !manager.isActive(run.id));
    fireTimer(timer.id);
    await until(() => store.getRun(run.id)?.status === 'failed' && !manager.isActive(run.id));
    await restart();
    // Recovery keeps the held result and re-arms the open wait, and nothing wakes the failed run.
    expect(store.getRun(run.id)?.status).toBe('failed');
    expect(waitById(run.id, timer.id)?.phase).toBe('resolved');
    expect(waitById(run.id, later.id)?.phase).toBe('open');
    expect(runInternals(manager).waitWatches.waitTimers.has(later.id)).toBe(true);
    expect(manager.isActive(run.id)).toBe(false);
    expect(prompted('claude', TIMER_WAKE_OPENING)).toHaveLength(MAX_WAKE_DELIVERY_ATTEMPTS);
    // Stop discards what the failed run held; the run stays failed.
    expect(manager.cancel(run.id)).toBe(true);
    expect(store.getRun(run.id)?.waits ?? []).toEqual([]);
    expect(store.getRun(run.id)?.status).toBe('failed');
    expect(runInternals(manager).waitWatches.waitTimers.has(later.id)).toBe(false);
  });

  it('claude a usage-limited wake continuation is not counted: the run waits for the usage-limit resume and keeps its result', async () => {
    nativeWire('claude');
    persistentWakeFailure(root, 'claude', { usageLimit: true });
    // Far out, so the resume never fires during the test.
    process.env.CEZ_MOCK_LIMIT_RESET_SECONDS = '3600';
    const { run, timer } = await timerOwedWithoutSession();
    fireTimer(timer.id);
    // The usage-limit resume is scheduled as the failed session is dropped; the run waits for it
    // (hearsay-tools/cezarion#1236).
    await until(() => store.getRun(run.id)?.status === 'waiting' && !!store.getRun(run.id)?.autoResumeAt && !manager.isActive(run.id));
    expect(prompted('claude', TIMER_WAKE_OPENING)).toHaveLength(1);
    expect(store.getRun(run.id)?.autoResumeAt).toBeDefined();
    expect(waitById(run.id, timer.id)?.phase).toBe('resolved');
    expect(store.getRun(run.id)?.waitDeliveryFailures).toBeUndefined();
    expect(runInternals(manager).retries.wakeBackoffs.has(run.id)).toBe(false);
    expect(notes(run.id, 'could not deliver wait results')).toEqual([]);
  });

  it('claude Stop on a usage-limited failed run holding a wait result discards it and cancels the automatic resume, so no session starts later', async () => {
    nativeWire('claude');
    persistentWakeFailure(root, 'claude', { usageLimit: true });
    process.env.CEZ_MOCK_LIMIT_RESET_SECONDS = '3600';
    const { run, timer } = await timerOwedWithoutSession();
    fireTimer(timer.id);
    await until(() => store.getRun(run.id)?.status === 'waiting' && !manager.isActive(run.id) && runInternals(manager).autoResumeScheduler.autoResumeTimers.has(run.id));
    expect(manager.cancel(run.id)).toBe(true);
    expect(store.getRun(run.id)?.waits ?? []).toEqual([]);
    expect(settled(run.id, timer.id)?.phase).toBe('cancelled');
    expect(store.getRun(run.id)?.status).toBe('failed');
    // The resume would have started a provider session on a run Stop just discarded.
    expect(runInternals(manager).autoResumeScheduler.autoResumeTimers.has(run.id)).toBe(false);
    expect(store.getRun(run.id)?.autoResumeAt).toBeUndefined();
    expect(notes(run.id, 'automatic resume cancelled for this task')).toHaveLength(1);
    expect(notes(run.id, WAITS_DISCARDED_NOTE)).toHaveLength(1);
    expect(manager.isActive(run.id)).toBe(false);
  });

  it('claude Stop on a usage-limited run without waits is refused and leaves its automatic resume armed', async () => {
    nativeWire('claude');
    process.env.CEZ_MOCK_LIMIT_RESET_SECONDS = '3600';
    // A usage-limited first turn fails the run without any wait.
    const run = manager.startRun(QUICK_TASK_WORKFLOW, { task: 'mock:limit ship it', runner: 'claude' });
    await until(() => store.getRun(run.id)?.status === 'waiting' && !manager.isActive(run.id) && runInternals(manager).autoResumeScheduler.autoResumeTimers.has(run.id));
    expect(store.getRun(run.id)?.waits ?? []).toEqual([]);
    expect(manager.cancel(run.id)).toBe(false);
    expect(runInternals(manager).autoResumeScheduler.autoResumeTimers.has(run.id)).toBe(true);
    expect(notes(run.id, WAITS_DISCARDED_NOTE)).toEqual([]);
  });
});
