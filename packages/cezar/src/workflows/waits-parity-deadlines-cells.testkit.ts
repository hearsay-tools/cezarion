import { waitPartDescribers, processes, nativeWire, settled, sessionOf } from './waits-parity-fixture.testkit.ts';
import { observationClock } from '../core/observation-clock.testkit.ts';
import { setRunStatus } from '../runs/run-store.testkit.ts';
import { spawn } from 'node:child_process';
import { onTestFinished, it as registerTest, expect } from 'vitest';
import { WAIT_KIND, WAIT_PHASE, RUN_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import type { CezarWaitRequestInput, Wait } from '@open-mercato/cezar-contract';
import type { RunnerId } from '../core/agent-runner.ts';
import { HARNESS_ADAPTERS } from '../core/harness-parity-core.testkit.ts';
import { manager, until, store, toolGenerationOf } from './worker-wait-core.testkit.ts';
import { QUICK_TASK_WORKFLOW } from './types.ts';

// Deadline accounting is shared above the runner seam; this part runs on the derived shared set.
export const { describeWaitParity } = waitPartDescribers('deadlines', deadlineCells);

function sleeper(): number {
  const child = spawn('sleep', ['120'], { stdio: 'ignore' });
  onTestFinished(() => { child.kill('SIGKILL'); });
  return child.pid!;
}

export function deadlineCells(runners: RunnerId[], it: typeof registerTest = registerTest): void {
  for (const runner of runners) {
    for (const [kind, row] of [['process', 'U29p'], ['peer', 'U29q']] as const) {
      for (const budget of [7, 40]) {
        it(`${runner} ${row} three empty ${kind} deadlines preserve budget ${budget}, including without a live session at the cap`, async () => {
          const external = processes();
          const clock = observationClock(() => /\bWaitEngine.armDeadline\b/.test(new Error().stack ?? ''));
          nativeWire(runner);
          const run = manager.startRun(QUICK_TASK_WORKFLOW, { task: HARNESS_ADAPTERS[runner].scenarios.baseline!, runner });
          await until(() => store.getRun(run.id)?.status === 'waiting');
          const tools = manager.cezarToolHandlers(run.id, toolGenerationOf(run.id));
          if (kind === 'peer') store.updateRun(run.id, { delegation: { role: 'root', permissions: ['wait', 'steer'], receipts: [] } });
          const pid = kind === 'process' ? sleeper() : undefined;
          const waits: Wait[] = [];
          for (let index = 0; index < 4; index++) {
            const peer = kind === 'peer' ? store.createRun({ title: 'peer', task: 'peer', workflow: 'quick-task', runner: 'claude', steps: [] }) : undefined;
            if (peer) setRunStatus(store, peer.id, RUN_STATUS.running, { delegation: { role: 'root', permissions: ['wait', 'steer'], receipts: [] } });
            const request: CezarWaitRequestInput = kind === 'process'
              ? { kind, pid: pid!, exit_file: `u29-${index}.exit`, timeout_seconds: 600 + index }
              : { kind, peer_ids: [peer!.id], timeout_seconds: 600 + index };
            const registered = await tools.registerWait(request, 'cezar_wait', new AbortController().signal);
            if (!('wait' in registered)) throw Error('registration refused');
            waits.push(registered.wait);
          }
          store.updateRun(run.id, { automaticWakes: budget });
          if (budget === 40) {
            sessionOf(run.id).end();
            await until(() => !manager.isActive(run.id));
          }
          for (let index = 0; index < 3; index++) {
            const wait = waits[index]!;
            if (kind === 'process') external.settle({ outcome: 'deadline' }, index);
            else clock.fire(index);
            await until(() => settled(run.id, wait.id)?.phase === 'delivered');
            await until(() => store.getRun(run.id)?.status === 'waiting');
            expect(store.getRun(run.id)?.automaticWakes).toBe(budget);
            expect(store.getRun(run.id)?.waits).toContainEqual(expect.objectContaining({ id: waits[3]!.id, phase: WAIT_PHASE.open }));
          }
          expect(store.readEvents(run.id).filter(event => event.type === 'note' && String(event.message).includes('cap reached'))).toEqual([]);
        });
      }
    }

    it(`${runner} U29m an empty process deadline batched with a process exit charges one wake`, async () => {
      const external = processes();
      nativeWire(runner);
      const run = manager.startRun(QUICK_TASK_WORKFLOW, { task: HARNESS_ADAPTERS[runner].scenarios.baseline!, runner });
      await until(() => store.getRun(run.id)?.status === 'waiting');
      const tools = manager.cezarToolHandlers(run.id, toolGenerationOf(run.id));
      const pid = sleeper();
      const waits: Wait[] = [];
      for (const name of ['empty', 'exit', 'anchor']) {
        const registered = await tools.registerWait({ kind: WAIT_KIND.process, pid, exit_file: `u29m-${name}.exit` }, 'cezar_wait', new AbortController().signal);
        if (!('wait' in registered)) throw Error('registration refused');
        waits.push(registered.wait);
      }
      store.updateRun(run.id, { automaticWakes: 7 });
      external.settle({ outcome: 'deadline' }, 0);
      external.settle({ outcome: 'exited' }, 1);
      await until(() => waits.slice(0, 2).every(wait => settled(run.id, wait.id)?.phase === 'delivered'));
      expect(store.getRun(run.id)?.automaticWakes).toBe(8);
      expect(store.getRun(run.id)?.waits).toContainEqual(expect.objectContaining({ id: waits[2]!.id, phase: WAIT_PHASE.open }));
    });

  }
}
