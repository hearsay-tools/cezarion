import { waitPartDescribers, processes, nativeWire, parkedOn, waitOfKind, expectPoolCapacity, settled, prompted, inputsFor, agentWaits, turnEnds, fireTimer, timerText, flushMicrotasks, sessionOf } from './waits-parity-fixture.testkit.ts';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { onTestFinished, it as registerTest, expect } from 'vitest';
import { deriveAttention } from '@open-mercato/cezar-contract/attention';
import { WAIT_KIND, WAIT_VIA, WAIT_SOURCE, WAIT_PHASE } from '@open-mercato/cezar-contract/test-factories.testkit';
import type { Wait } from '@open-mercato/cezar-contract';
import type { RunnerId } from '../core/agent-runner.ts';
import { HARNESS_ADAPTERS } from '../core/harness-parity-core.testkit.ts';
import { manager, until, store, root, toolGenerationOf, restart } from './worker-wait-core.testkit.ts';
import { QUICK_TASK_WORKFLOW } from './types.ts';
import { toolCall, gatedProviderFailure } from './waits-parity.testkit.ts';

// The process part of the wait parity cells (`WAIT_PARITY_PARTS` in `waits-parity-catalog.testkit.ts`).
// A wait parity file imports this module first, so it loads no other part's cells (hearsay-tools/cezarion#3242).
export const { describeWaitParity } = waitPartDescribers('process', processCells);

/** A live process of this test's own to wait on, killed when the test ends. */
function sleeper(): number {
  const child = spawn('sleep', ['120'], { stdio: 'ignore' });
  onTestFinished(() => { child.kill('SIGKILL'); });
  return child.pid!;
}
const processText = (wait: Wait, rest: string) => `Process wait ${wait.id} for PID ${(wait as { pid: number }).pid}${rest}`;

export function processCells(runners: RunnerId[], it: typeof registerTest = registerTest): void {
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
      const tools = manager.squawkToolHandlers(run.id, toolGenerationOf(run.id));
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
      const tools = manager.squawkToolHandlers(run.id, toolGenerationOf(run.id));
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
