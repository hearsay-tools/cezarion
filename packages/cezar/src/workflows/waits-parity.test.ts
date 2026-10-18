import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CiWaitResult, Wait } from '@open-mercato/cezar-contract';
import { RUNNER_IDS, type AgentSession, type RunnerId } from '../core/agent-runner.ts';
import { exemptionFor, HARNESS_ADAPTERS } from '../core/harness-parity.testkit.ts';
import { CiWatcherSupervisor } from '../ci-wait/supervisor.ts';
import { manager, root, semaphore, store, until, useWorkerWaitFixture } from './worker-wait.testkit.ts';
import { QUICK_TASK_WORKFLOW } from './types.ts';
import { claudeScheduleWakeupDelay } from './run.ts';
import { messagesPrompt } from './monitoring-turn.testkit.ts';
import { ciNativeMessages, gatedProviderFailure, toolCall, WAIT_CRITERIA } from './waits-parity.testkit.ts';

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
};
const fireTimer = (waitId: string) => engine().waitTimers.get(waitId)!.timer._onTimeout();
const flushMicrotasks = async () => { for (let n = 0; n < 5; n++) await Promise.resolve(); };
const turnEnds = (id: string) => store.readEvents(id).filter(event => event.type === 'turn-end').length;
const viaOf = (id: string, via: Wait['via']) => store.getRun(id)?.waits?.find(wait => wait.via === via);
const parkedOn = (id: string, wait: Wait | undefined) => wait?.phase === 'open' && store.getRun(id)?.status === 'waiting';
const prompted = (runner: RunnerId, text: string) => ciNativeMessages(runner, root).filter(prompt => prompt.includes(text));
const timerText = (wait: Wait, note: string) => `Timer ${wait.id} fired: ${note}. Continue toward the task goal; register another wait if you are still waiting.`;

describe('wait list on every native runner wire (hearsay-tools/cezarion#1233)', { timeout: 45_000 }, () => {
  useWorkerWaitFixture();
  afterEach(() => vi.restoreAllMocks());

  it('registers every criterion', () => {
    expect(WAIT_CRITERIA.map(row => row.id)).toEqual(['U1', 'U4', 'U9', 'U2', 'U3', 'U7', 'U8']);
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
  }
});
