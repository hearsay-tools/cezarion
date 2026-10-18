import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { deriveAttention, type CezarWaitRequest, type CiWait, type CiWaitResult, type Wait } from '@open-mercato/cezar-contract';
import type { AgentSession, RunnerId } from '../core/agent-runner.ts';
import { HARNESS_ADAPTERS } from '../core/harness-parity.testkit.ts';
import { CiWatcherSupervisor } from '../ci-wait/supervisor.ts';
import { manager, root, semaphore, store, until, useWorkerWaitFixture } from './worker-wait.testkit.ts';
import { QUICK_TASK_WORKFLOW } from './types.ts';
import { ciNativeMessages, toolCall } from './waits-parity.testkit.ts';

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
  active: Map<string, { session?: AgentSession; ciGeneration: string; idleTimer?: NodeJS.Timeout & { _onTimeout(): void }; monitoringWakeups?: number }>;
  waitTimers: Map<string, { timer: NodeJS.Timeout & { _onTimeout(): void } }>;
  monitoring: Set<string>;
  pump(): Promise<void>;
};
async function openWait(id: string, request: CezarWaitRequest): Promise<Wait> {
  const tools = manager.cezarToolHandlers(id, engine().active.get(id)!.ciGeneration);
  const registered = await tools.registerWait(request, 'cezar_wait', new AbortController().signal);
  if (!('wait' in registered)) throw Error('registration refused');
  return registered.wait;
}
const fireTimer = (waitId: string) => engine().waitTimers.get(waitId)!.timer._onTimeout();
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
  const ci = await openWait(run.id, { kind: 'ci', pr, timeout_seconds: 600 });
  writeFileSync(release, '');
  await until(() => asks(run.id).length === 1 && store.getRun(run.id)?.status === 'waiting');
  expect(waitById(run.id, ci.id)?.phase).toBe('open');
  expect(label(run.id)).toBe('needs you');
  return { run, ci, askSeq: asks(run.id)[0]!.seq };
}

describe('wakes beside questions, footers and slots (hearsay-tools/cezarion#1233)', { timeout: 45_000 }, () => {
  useWorkerWaitFixture();
  afterEach(() => vi.restoreAllMocks());

  for (const runner of ['claude', 'codex'] as const) {
    it(`${runner} U3b a CI result beside a pending portable question is delivered, the card stays answerable, and the answer keeps its askSeq`, async () => {
      const external = github();
      const { run, ci, askSeq } = await questionBesideCi(runner);
      const turns = turnEnds(run.id);
      external.settle();
      await until(() => settled(run.id, ci.id)?.phase === 'delivered' && prompted(runner, `CI wait observation ${ci.id}`).length > 0);
      await until(() => turnEnds(run.id) > turns && store.getRun(run.id)?.status === 'waiting');
      expect(store.getRun(run.id)?.hasPendingHumanAsk).toBe(true);
      expect(label(run.id)).toBe('needs you');
      expect(store.readEvents(run.id).filter(event => event.type === 'human-input-delivered')).toEqual([]);
      expect(manager.sendMessage(run.id, [{ type: 'text', text: 'Vitest' }])).toBe(true);
      await until(() => answered(run.id, askSeq));
      await until(() => store.getRun(run.id)?.status === 'waiting');
      expect(store.getRun(run.id)?.hasPendingHumanAsk).not.toBe(true);
    });
  }

  it('codex a CI result during a native question waits for the answer and its turn end', async () => {
    const external = github();
    nativeWire('codex');
    const run = manager.startRun(QUICK_TASK_WORKFLOW, { task: 'mock:native-codex-ask', runner: 'codex' });
    await until(() => asks(run.id).length === 1 && store.getRun(run.id)?.status === 'waiting');
    const ci = await openWait(run.id, { kind: 'ci', pr, timeout_seconds: 600 });
    external.settle();
    await until(() => waitById(run.id, ci.id)?.phase === 'resolved');
    // The question holds its turn open: nothing may reach the wire, however often the line is pumped.
    await engine().pump();
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
    expect(store.getRun(run.id)).toMatchObject({ status: 'waiting', hasPendingHumanAsk: true });
    expect(waitById(run.id, ci.id)?.phase).toBe('open');
    external.settle();
    await until(() => settled(run.id, ci.id)?.phase === 'delivered' && prompted('claude', `CI wait observation ${ci.id}`).length > 0);
    await until(() => manager.isActive(run.id) && store.getRun(run.id)?.status === 'waiting');
    expect(store.getRun(run.id)?.hasPendingHumanAsk).toBe(true);
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
    await until(() => settled(run.id, first.id)?.phase === 'delivered' && settled(run.id, second.id)?.phase === 'delivered');
    const wakes = prompted('claude', `Timer ${first.id} fired`);
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toContain(`Timer ${second.id} fired`);
    expect(wakes[0]!.indexOf(first.id)).toBeLessThan(wakes[0]!.indexOf(second.id));
    // One admitted automatic turn spends one wake of the budget, however many timers it carries.
    expect(engine().active.get(run.id)?.monitoringWakeups).toBe(1);
    expect(notes(run.id, 'automatic timer wake-up (').map(event => event.message)).toEqual(['automatic timer wake-up (1/40)']);
  });

  it('claude staggered timers at 39 spent wakes: the first wakes at 40, the second is cancelled with the cap note and wakes nothing', async () => {
    nativeWire('claude');
    const run = manager.startRun(QUICK_TASK_WORKFLOW, { task: HARNESS_ADAPTERS.claude.scenarios.baseline!, runner: 'claude' });
    await until(() => store.getRun(run.id)?.status === 'waiting');
    const first = await openWait(run.id, { kind: 'timer', seconds: 60, note: 'first' });
    const second = await openWait(run.id, { kind: 'timer', seconds: 120, note: 'second' });
    engine().active.get(run.id)!.monitoringWakeups = 39;
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
    expect(engine().active.get(run.id)?.monitoringWakeups).toBe(40);
    // Nothing open or resolved: a plain park that needs the user and holds no slot.
    expect(store.getRun(run.id)?.waits ?? []).toEqual([]);
    expect(label(run.id)).toBe('needs you');
    expect(engine().monitoring.has(run.id)).toBe(false);
    expect(semaphore.busy()).toBe(0);
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
    const ci = await openWait(run.id, { kind: 'ci', pr, timeout_seconds: 600 });
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
      const run = manager.startRun(QUICK_TASK_WORKFLOW, { task: toolCall('cezar_wait', { kind: 'ci', pr: prUrl(n) }), runner: 'claude' });
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
});
