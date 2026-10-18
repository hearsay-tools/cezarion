import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { deriveAttention, toRunSummary, type CiWaitResult, type HumanWaitEntry, type Wait } from '@open-mercato/cezar-contract';
import { RUNNER_IDS, type AgentSession, type RunnerId } from '../core/agent-runner.ts';
import { exemptionFor, HARNESS_ADAPTERS } from '../core/harness-parity.testkit.ts';
import { CiWatcherSupervisor } from '../ci-wait/supervisor.ts';
import { manager, parent, register, root, semaphore, store, terminal, until, useWorkerWaitFixture, waitOf, worker } from './worker-wait.testkit.ts';
import { timed, type TimedWait } from './waits.testkit.ts';
import { QUICK_TASK_WORKFLOW } from './types.ts';
import { claudeScheduleWakeupDelay, MAX_WAKE_DELIVERY_ATTEMPTS, WAITS_DISCARDED_NOTE, WAKE_DELIVERY_CAP_NOTE, WAKE_SESSION_CLOSED_ERROR } from './run.ts';
import type { Backoff } from '../delegation/retry-backoff.ts';
import { ASK_TEXT, messagesPrompt } from './monitoring-turn.testkit.ts';
import { withDelayedCommand, withHeldPrintResponse, withRejectedCommand } from '../core/owned-input-delivery.testkit.ts';
import { ciNativeMessages, gatedProviderFailure, persistentWakeFailure, TIMER_WAKE_OPENING, toolCall, WAIT_CRITERIA } from './waits-parity.testkit.ts';

// hearsay-tools/cezarion#1233: every runner opens, cancels and survives CI and timer waits on its
// own native wire. The production tool controller, bundled tool, runner, store and scheduler stay
// real; only GitHub (metadata and the watch) is controlled.

const pr = 'https://github.com/acme/repo/pull/12';
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

function nativeWire(runner: RunnerId) {
  process.env.CEZ_DRY_RUN = '0';
  process.env[HARNESS_ADAPTERS[runner].binEnv] = HARNESS_ADAPTERS[runner].mockBin;
  // The prompts each native mock admitted, read back by `ciNativeMessages`.
  process.env.CEZ_MOCK_ARGS_FILE = join(root, 'args');
  process.env.CEZ_MOCK_STDIN_FILE = join(root, 'stdin');
}

const waitOfKind = (id: string, kind: Wait['kind']) => store.getRun(id)?.waits?.find(wait => wait.kind === kind);
const settled = (id: string, waitId: string) => store.getRun(id)?.lastWaits?.find(wait => wait.id === waitId);
const inputsFor = (id: string, waitId: string) => store.getRun(id)?.agentInputs?.filter(input => input.id === waitId) ?? [];
const engine = () => manager as unknown as {
  active: Map<string, { session: AgentSession & { end(): void }; ciGeneration: string }>;
  waitTimers: Map<string, { timer: NodeJS.Timeout & { _onTimeout(): void } }>;
  monitoring: Set<string>;
  wakeRetryBackoff: Backoff;
  wakeBackoffs: Map<string, NodeJS.Timeout>;
  wakeRetries: Map<string, NodeJS.Timeout>;
  queue: string[];
};
// The delivery bound, not the backoff, is what these cells pin: retries start at once.
const retryAtOnce = () => { engine().wakeRetryBackoff = { fastMs: 0, fastCount: MAX_WAKE_DELIVERY_ATTEMPTS, capMs: 0 }; };
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
const pendingQuestion = (id: string) => store.getRun(id)?.hasPendingHumanAsk === true && store.getRun(id)?.status === 'waiting';

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
const humanOpen = (id: string) => store.getRun(id)?.waits?.filter((wait): wait is HumanWaitEntry => wait.kind === 'human') ?? [];
/** `Header: label` per question of the newest card: the line every native answer seam parses. */
const answerOf = (id: string) => (asks(id).at(-1) as unknown as { questions: Array<{ header: string; options: Array<{ label: string }> }> })
  .questions.map(question => `${question.header}: ${question.options[0]!.label}`).join('\n');

/** The run waits on exactly one human wait, surfaced as its one card, and reads Needs you; the
 *  answer moves the wait to `lastWaits` as delivered, with the card's askSeq. */
async function expectHumanWaitAnswered(id: string, via: Wait['via']) {
  await until(() => pendingQuestion(id) && humanOpen(id)[0]?.askSeq !== undefined);
  const [wait, ...more] = humanOpen(id);
  expect(more).toEqual([]);
  expect(wait).toMatchObject({ kind: 'human', via, phase: 'open' });
  expect(asks(id)).toHaveLength(1);
  expect(wait!.askSeq).toBe(asks(id)[0]!.seq);
  expect(toRunSummary(store.getRun(id)!).waitingOn).toEqual({ kind: 'human' });
  expect(deriveAttention(store.getRun(id)!).label).toBe('needs you');
  expect(manager.sendMessage(id, [{ type: 'text', text: answerOf(id) }])).toBe(true);
  await until(() => settled(id, wait!.id)?.phase === 'delivered' && answered(id, wait!.askSeq!));
  expect(humanOpen(id)).toEqual([]);
  return wait!;
}

const timerText = (wait: Wait, note: string) => `Timer ${wait.id} fired: ${note}. Continue toward the task goal; register another wait if you are still waiting.`;

describe('wait list on every native runner wire (hearsay-tools/cezarion#1233)', { timeout: 45_000 }, () => {
  useWorkerWaitFixture();
  afterEach(() => vi.restoreAllMocks());

  it('registers every criterion', () => {
    expect(WAIT_CRITERIA.map(row => row.id)).toEqual(['U1', 'U4', 'U9', 'U2', 'U3', 'U7', 'U8', 'U10', 'U11', 'U12', 'U13', 'U14', 'U16', 'U7h', 'U9h']);
    for (const runner of RUNNER_IDS) for (const row of WAIT_CRITERIA) expect(HARNESS_ADAPTERS[runner].scenarios[row.scenario]).toBeDefined();
  });

  for (const runner of RUNNER_IDS) {
    it(`${runner} U1 ci and timer register through cezar_wait on the native wire, park, and wake with their result`, async () => {
      const external = github();
      nativeWire(runner);
      const run = manager.startRun(QUICK_TASK_WORKFLOW, { task: toolCall('cezar_wait', { kind: 'ci', pr }), runner });
      await until(() => parkedOn(run.id, waitOfKind(run.id, 'ci')));
      const ci = waitOfKind(run.id, 'ci')!;
      expect(store.getRun(run.id)?.activity).toBeUndefined();
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
      expect(store.getRun(run.id)?.waits ?? []).toEqual([]);
    });

    it(`${runner} U4 cezar_cancel_wait cancels and no observation is delivered`, async () => {
      const external = github();
      nativeWire(runner);
      const opened = toolCall('cezar_wait', { kind: 'ci', pr }), cancelled = toolCall('cezar_cancel_wait', { wait_id: 'last' });
      const run = manager.startRun(QUICK_TASK_WORKFLOW, { task: `${opened} ${cancelled}`, runner });
      await until(() => store.getRun(run.id)?.lastWaits?.some(wait => wait.kind === 'ci') === true && store.getRun(run.id)?.status === 'waiting');
      const ci = store.getRun(run.id)!.lastWaits!.find(wait => wait.kind === 'ci')!;
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
      expect(store.getRun(run.id)?.waits ?? []).toEqual([]);
    });

    it(`${runner} U2 ci and timer open: the timer wakes, ci stays open and is in the footer, the turn end re-parks without re-registering, the later ci result is delivered`, async () => {
      const external = github();
      nativeWire(runner);
      const opened = `${toolCall('cezar_wait', { kind: 'ci', pr })} ${toolCall('cezar_wait', { kind: 'timer', seconds: 60, note: 'u2' })}`;
      const run = manager.startRun(QUICK_TASK_WORKFLOW, { task: opened, runner });
      await until(() => parkedOn(run.id, waitOfKind(run.id, 'ci')) && waitOfKind(run.id, 'timer')?.phase === 'open');
      const ci = waitOfKind(run.id, 'ci')!, timer = waitOfKind(run.id, 'timer')!;
      const turns = turnEnds(run.id);
      fireTimer(timer.id);
      await until(() => settled(run.id, timer.id)?.phase === 'delivered' && prompted(runner, timerText(timer, 'u2')).length > 0);
      const wake = prompted(runner, timerText(timer, 'u2')).at(-1)!;
      expect(wake).toContain(`Still open: CI wait ${ci.id} for acme/repo#12`);
      expect(wake).not.toContain(`timer ${timer.id}`);
      await until(() => turnEnds(run.id) > turns && parkedOn(run.id, waitOfKind(run.id, 'ci')));
      expect(store.getRun(run.id)?.waits).toEqual([expect.objectContaining({ id: ci.id, phase: 'open' })]);
      external.settle();
      await until(() => settled(run.id, ci.id)?.phase === 'delivered' && prompted(runner, `CI wait observation ${ci.id}`).length > 0);
      expect(prompted(runner, `CI wait observation ${ci.id}`).at(-1)).not.toContain('Still open');
      await until(() => store.getRun(run.id)?.status === 'waiting' && !store.getRun(run.id)?.waits?.length);
    });

    it(`${runner} U3 a human message during a ci wait is delivered, the wait stays open, and its result arrives in a later turn`, async () => {
      const external = github();
      nativeWire(runner);
      const run = manager.startRun(QUICK_TASK_WORKFLOW, { task: toolCall('cezar_wait', { kind: 'ci', pr }), runner });
      await until(() => parkedOn(run.id, waitOfKind(run.id, 'ci')));
      const ci = waitOfKind(run.id, 'ci')!;
      const turns = turnEnds(run.id);
      const text = `${HARNESS_ADAPTERS[runner].scenarios.hold!}\nPlease also update the docs`;
      expect(manager.sendMessage(run.id, [{ type: 'text', text }])).toBe(true);
      await until(() => prompted(runner, 'Please also update the docs').length > 0);
      expect(prompted(runner, 'Please also update the docs').at(-1)).toContain(`Still open: CI wait ${ci.id} for acme/repo#12`);
      expect(waitOfKind(run.id, 'ci')).toMatchObject({ id: ci.id, phase: 'open' });
      expect(external.aborted()).toBe(false);
      await until(() => turnEnds(run.id) > turns && parkedOn(run.id, waitOfKind(run.id, 'ci')));
      expect(waitOfKind(run.id, 'ci')?.id).toBe(ci.id);
      external.settle();
      await until(() => settled(run.id, ci.id)?.phase === 'delivered' && prompted(runner, `CI wait observation ${ci.id}`).length > 0);
      expect(prompted(runner, `CI wait observation ${ci.id}`).at(-1)).not.toContain('Please also update the docs');
      expect(inputsFor(run.id, ci.id)).toHaveLength(1);
      expect(store.readEvents(run.id).filter(event => event.type === 'user-message').map(event => event.text)).toContain(text);
    });

    it(`${runner} U7 cezar_wait_for_ci, the monitoring line and ScheduleWakeup land in the same wait list`, async () => {
      github();
      nativeWire(runner);
      const run = manager.startRun(QUICK_TASK_WORKFLOW, { task: toolCall('cezar_wait_for_ci', { pr }), runner });
      await until(() => parkedOn(run.id, viaOf(run.id, 'cezar_wait_for_ci')));
      expect(viaOf(run.id, 'cezar_wait_for_ci')).toMatchObject({ kind: 'ci', prUrl: pr });
      let turns = turnEnds(run.id);
      expect(manager.sendMessage(run.id, [{ type: 'text', text: messagesPrompt(runner, ['Still waiting for CI.\nCEZ:MONITORING']) }])).toBe(true);
      await until(() => turnEnds(run.id) > turns && parkedOn(run.id, viaOf(run.id, 'monitoring-line')));
      // The default five-minute interval, beside the CI wait it does not replace.
      expect(viaOf(run.id, 'monitoring-line')).toMatchObject({ kind: 'timer', seconds: 300 });
      expect(viaOf(run.id, 'cezar_wait_for_ci')?.phase).toBe('open');
      const scheduler = { type: 'tool-call', id: 'toolu_1', tool: 'ScheduleWakeup', input: { delaySeconds: 120 } } as const;
      if (exemptionFor('U7', runner)) {
        // capability-absent: the same tool name on this wire is not a scheduler.
        expect(exemptionFor('U7', runner)?.reason).toBe('native scheduler tool exists only on the Claude wire');
        expect(claudeScheduleWakeupDelay(scheduler, runner)).toBeUndefined();
        expect(store.getRun(run.id)?.waits?.map(wait => wait.via).sort()).toEqual(['cezar_wait_for_ci', 'monitoring-line']);
        return;
      }
      expect(claudeScheduleWakeupDelay(scheduler, runner)).toBe(120);
      turns = turnEnds(run.id);
      expect(manager.sendMessage(run.id, [{ type: 'text', text: 'mock:schedule-wakeup:120' }])).toBe(true);
      await until(() => turnEnds(run.id) > turns && parkedOn(run.id, viaOf(run.id, 'schedule-wakeup')));
      expect(viaOf(run.id, 'schedule-wakeup')).toMatchObject({ kind: 'timer', seconds: 120 });
      expect(store.getRun(run.id)?.waits?.map(wait => wait.via).sort()).toEqual(['cezar_wait_for_ci', 'monitoring-line', 'schedule-wakeup']);
    });

    for (const kind of ['ci', 'timer'] as const) {
      it(`${runner} U8 a ${kind} park keeps its slot and wakes without queueing at maxParallel 1`, async () => {
        const external = github();
        nativeWire(runner);
        expect(semaphore.maxParallel()).toBe(1);
        const request = kind === 'ci' ? { kind, pr } : { kind, seconds: 60, note: 'u8' };
        const parked = manager.startRun(QUICK_TASK_WORKFLOW, { task: toolCall('cezar_wait', request), runner });
        await until(() => parkedOn(parked.id, waitOfKind(parked.id, kind)));
        const wait = waitOfKind(parked.id, kind)!;
        // The only regular slot goes to a turn held open until this test releases it.
        const release = join(root, 'u8-release');
        process.env.CEZ_MOCK_RELEASE_FILE = release;
        const blocker = manager.startRun(QUICK_TASK_WORKFLOW, { task: HARNESS_ADAPTERS[runner].scenarios['hold-gated']!, runner });
        try {
          await until(() => store.readEvents(blocker.id).some(event => event.type === 'turn.started'));
          const queue = (manager as unknown as { queue: string[] }).queue;
          const push = vi.spyOn(queue, 'push');
          if (kind === 'ci') external.settle(); else fireTimer(wait.id);
          await until(() => settled(parked.id, wait.id)?.phase === 'delivered');
          expect(store.getRun(blocker.id)?.status).toBe('running');
          expect(push.mock.calls.flat()).not.toContain(parked.id);
        } finally { writeFileSync(release, ''); }
        await until(() => store.getRun(blocker.id)?.status === 'waiting');
        await until(() => store.getRun(parked.id)?.status === 'waiting' && !store.getRun(parked.id)?.waits?.length);
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
      store.updateRun(run.id, { automaticWakes: 39 });
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
      const ci = await open({ kind: 'ci', pr, timeout_seconds: 600 });
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
      await until(() => parkedOn(run.id, waitOfKind(run.id, 'ci')));
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
        expect(store.getRun(run.id)?.hasPendingHumanAsk).toBe(true);
        release();
        await until(() => settled(run.id, timer.id)?.phase === 'delivered');
        // An acknowledgement after the wake turn ended still leaves the run in the question's park.
        await answerQuestion(run.id, askSeq);
      };
      if (runner === 'cursor') await withHeldPrintResponse(exercise);
      else await withDelayedCommand(runner as 'codex' | 'opencode' | 'pi' | 'omp', exercise);
    });

    it(`${runner} U13 a wait result beside a pending portable question whose acknowledgement is rejected stays resolved, is retried, and the question stays answerable`, async () => {
      if (exemptionFor('U13', runner)) {
        expect(exemptionFor('U13', runner)?.kind).toBe('capability-absent');
        return;
      }
      await withRejectedCommand(runner as 'codex' | 'opencode' | 'pi' | 'omp', async () => {
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
      await withRejectedCommand(runner as 'codex' | 'opencode' | 'pi' | 'omp', async lift => {
        retryAtOnce();
        const { run, timer, askSeq } = await timerBesideQuestion(runner, `reject-owned-turn${runner === 'opencode' ? ' mock:reject-agent-post' : ''}`);
        fireTimer(timer.id);
        // The failure is recorded before the failing session is dropped.
        await until(() => store.getRun(run.id)?.status === 'failed' && !manager.isActive(run.id));
        // One rejected submission per attempt, each in its own session, then nothing.
        expect(prompted(runner, `Timer ${timer.id} fired`)).toHaveLength(MAX_WAKE_DELIVERY_ATTEMPTS);
        expectHeldAtTheBound(run.id, timer.id);
        expect(store.getRun(run.id)?.hasPendingHumanAsk).toBe(true);
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
      await until(() => settled(id, timer.id)?.phase === 'delivered' && settled(id, later.id)?.phase === 'delivered');
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
      expect(store.getRun(run.id)?.waits ?? []).toEqual([]);
      expect(manager.finish(run.id)).toBe(true);
      await until(() => terminal.includes(store.getRun(run.id)?.status ?? ''));
    });

    it(`${runner} U11 an alias timer survives a later worker park with its deadline, is held while the workers outrank it, and is delivered after the worker wake`, async () => {
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
      expect(manager.sendMessage(p.id, [{ type: 'text', text: messagesPrompt(runner, ['Waiting on my worker.']) }])).toBe(true);
      const workerWait = register(p.id, [w.id]);
      await until(() => turnEnds(p.id) > turns && waitOf(store.getRun(p.id))?.phase === 'parked');
      // The worker park cancels nothing: the timer keeps its deadline, and the workers outrank it.
      expect(store.getRun(p.id)?.waits).toEqual([expect.objectContaining({ id: timer.id, phase: 'open', deadline: timer.deadline })]);
      expect(deriveAttention(store.getRun(p.id)!).label).toBe('waiting on 1 worker');
      expect(engine().monitoring.has(p.id)).toBe(false);
      fireTimer(timer.id);
      await until(() => store.getRun(p.id)?.waits?.[0]?.phase === 'resolved');
      await flushMicrotasks();
      // Held behind the worker park: nothing is delivered, and attention still follows the workers.
      expect(inputsFor(p.id, timer.id).map(input => input.deliveredAt)).toEqual([undefined]);
      const result = inputsFor(p.id, timer.id)[0]!.text;
      expect(prompted(runner, result)).toEqual([]);
      expect(deriveAttention(store.getRun(p.id)!).label).toBe('waiting on 1 worker');
      manager.enqueueOwnedRun(w.id);
      await until(() => store.getRun(w.id)?.status === 'waiting');
      expect(manager.finish(w.id)).toBe(true);
      await until(() => terminal.includes(store.getRun(w.id)?.status ?? ''));
      await until(() => settled(p.id, timer.id)?.phase === 'delivered' && !waitOf(store.getRun(p.id)));
      expect(inputsFor(p.id, timer.id)).toHaveLength(1);
      // After the worker wake's own prompt, never inside the parked worker turn.
      const prompts = ciNativeMessages(runner, root);
      const wake = prompts.findIndex(prompt => prompt.includes(`Worker wait ${workerWait.id}`));
      expect(wake).toBeGreaterThanOrEqual(0);
      expect(prompts.findIndex(prompt => prompt.includes(result))).toBeGreaterThanOrEqual(wake);
      await until(() => store.getRun(p.id)?.status === 'waiting');
    });

    for (const kind of ['ci', 'timer'] as const) {
      it(`${runner} U9 provider failure with a ${kind} wait open leaves the run recoverable and the next wake delivers`, async () => {
        const external = github();
        const wire = gatedProviderFailure(root, runner);
        const run = manager.startRun(QUICK_TASK_WORKFLOW, { runner, task: HARNESS_ADAPTERS[runner].scenarios['provider-error']! });
        await until(wire.held);
        const tools = manager.cezarToolHandlers(run.id, engine().active.get(run.id)!.ciGeneration);
        const request = kind === 'ci' ? { kind, pr, timeout_seconds: 30 } as const : { kind, seconds: 60, note: 'u9' } as const;
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
        if (kind === 'ci') external.settle(); else fireTimer(wait.id);
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
        const request = kind === 'ci' ? { kind, pr, timeout_seconds: 30 } as const : { kind, seconds: 60, note: 'u9' } as const;
        const registered = await tools.registerWait(request, 'cezar_wait', new AbortController().signal);
        if (!('wait' in registered)) throw Error('registration refused');
        const wait = registered.wait;
        engine().active.get(run.id)!.session.end();
        await until(() => !manager.isActive(run.id));
        // A clean close is not a failure: the park and its wait survive it.
        expect(store.getRun(run.id)?.status).toBe('waiting');
        expect(store.getRun(run.id)?.activity).toBeUndefined();
        expect(store.getRun(run.id)?.error).toBeUndefined();
        expect(store.getRun(run.id)?.waits?.find(entry => entry.id === wait.id)?.phase).toBe('open');
        if (kind === 'ci') external.settle(); else fireTimer(wait.id);
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

    it(`${runner} U7h cezar_wait human opens a human wait in the same wait list`, async () => {
      nativeWire(runner);
      const run = manager.startRun(QUICK_TASK_WORKFLOW, { task: toolCall('cezar_wait', { kind: 'human', questions }), runner });
      const wait = await expectHumanWaitAnswered(run.id, 'cezar_wait');
      expect(wait).toMatchObject({ source: 'agent', questions });
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

    it(`${runner} U9h provider failure with a human wait open leaves the run recoverable`, async () => {
      const wire = gatedProviderFailure(root, runner);
      const run = manager.startRun(QUICK_TASK_WORKFLOW, { runner, task: HARNESS_ADAPTERS[runner].scenarios['provider-error']! });
      await until(wire.held);
      const tools = manager.cezarToolHandlers(run.id, engine().active.get(run.id)!.ciGeneration);
      const registered = await tools.registerWait({ kind: 'human', questions }, 'cezar_wait', new AbortController().signal);
      expect(registered.answer).toMatchObject({ ok: true, kind: 'human' });
      if (!('wait' in registered)) throw Error('registration refused');
      // Registered mid-turn, so nothing is shown before the turn ends.
      expect(asks(run.id)).toEqual([]);
      const failedState = engine().active.get(run.id);
      wire.release();
      await until(() => store.readEvents(run.id).some(event => event.type === 'error'));
      await until(() => engine().active.get(run.id) !== failedState && pendingQuestion(run.id));
      expect(asks(run.id)).toHaveLength(1);
      expect(humanOpen(run.id)).toMatchObject([{ id: registered.wait.id, askSeq: asks(run.id)[0]!.seq }]);
      expect(deriveAttention(store.getRun(run.id)!).label).toBe('needs you');
      expect(manager.continueRun(run.id, { text: answerOf(run.id) }).ok).toBe(true);
      await until(() => settled(run.id, registered.wait.id)?.phase === 'delivered' && answered(run.id, asks(run.id)[0]!.seq));
    });

    it(`${runner} U9h clean close with a human wait open leaves the run recoverable`, async () => {
      nativeWire(runner);
      const run = manager.startRun(QUICK_TASK_WORKFLOW, { runner, task: HARNESS_ADAPTERS[runner].scenarios.baseline! });
      await until(() => store.getRun(run.id)?.status === 'waiting');
      const tools = manager.cezarToolHandlers(run.id, engine().active.get(run.id)!.ciGeneration);
      const registered = await tools.registerWait({ kind: 'human', questions }, 'cezar_wait', new AbortController().signal);
      if (!('wait' in registered)) throw Error('registration refused');
      // Registered at a boundary: the card is shown at once.
      await until(() => pendingQuestion(run.id) && asks(run.id).length === 1);
      engine().active.get(run.id)!.session.end();
      await until(() => !manager.isActive(run.id));
      expect(store.getRun(run.id)).toMatchObject({ status: 'waiting', hasPendingHumanAsk: true });
      expect(store.getRun(run.id)?.error).toBeUndefined();
      expect(humanOpen(run.id)).toMatchObject([{ id: registered.wait.id, askSeq: asks(run.id)[0]!.seq }]);
      expect(deriveAttention(store.getRun(run.id)!).label).toBe('needs you');
      expect(manager.continueRun(run.id, { text: answerOf(run.id) }).ok).toBe(true);
      await until(() => settled(run.id, registered.wait.id)?.phase === 'delivered' && answered(run.id, asks(run.id)[0]!.seq));
    });
  }
});
