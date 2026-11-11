import { waitPartDescribers, github, nativeWire, pr, parkedOn, waitOfKind, turnEnds, fireTimer, settled, prompted, timerText, agentWaits, inputsFor, viaOf, sessionOf, runnerBoundary, expectPoolCapacity } from './waits-parity-fixture.testkit.ts';
import { nativeTimerDelay } from './run.ts';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { it as registerTest, expect, onTestFinished } from 'vitest';
import { WAIT_KIND, WAIT_PHASE, RUN_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import type { RunnerId } from '../core/agent-runner.ts';
import { HARNESS_ADAPTERS, exemptionFor } from '../core/harness-parity-core.testkit.ts';
import { manager, until, store, semaphore, root, checkpoint, timeline, terminal } from './worker-wait-core.testkit.ts';
import { QUICK_TASK_WORKFLOW } from './types.ts';
import { setRunStatus } from '../runs/run-store.testkit.ts';
import { toolCall } from './waits-parity.testkit.ts';

// The input part of the wait parity cells (`WAIT_PARITY_PARTS` in `waits-parity-catalog.testkit.ts`).
// A wait parity file imports this module first, so it loads no other part's cells (hearsay-tools/cezarion#3242).
export const { describeWaitParity } = waitPartDescribers('input', inputCells);

export function inputCells(runners: RunnerId[], it: typeof registerTest = registerTest): void {
  for (const runner of runners) {
    it(`${runner} U2 ci and timer open: the timer wakes, ci stays open and is in the footer, the turn end re-parks without re-registering, the later ci result is delivered`, async () => {
      const external = github();
      nativeWire(runner);
      const opened = `${toolCall('cezar_wait', { kind: WAIT_KIND.pr, pr })} ${toolCall('cezar_wait', { kind: WAIT_KIND.timer, seconds: 60, note: 'u2' })}`;
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
      expect(store.getRun(run.id)?.waits).toEqual([expect.objectContaining({ id: ci.id, phase: WAIT_PHASE.open })]);
      external.settle();
      await until(() => settled(run.id, ci.id)?.phase === 'delivered' && prompted(runner, `CI wait observation ${ci.id}`).length > 0);
      expect(prompted(runner, `CI wait observation ${ci.id}`).at(-1)).not.toContain('Still open');
      await until(() => store.getRun(run.id)?.status === 'waiting' && !agentWaits(run.id).length);
    });

    it(`${runner} U3 a human message during a ci wait is delivered, the wait stays open, and its result arrives in a later turn`, async () => {
      const external = github();
      nativeWire(runner);
      const run = manager.startRun(QUICK_TASK_WORKFLOW, { task: toolCall('cezar_wait', { kind: WAIT_KIND.pr, pr }), runner });
      await until(() => parkedOn(run.id, waitOfKind(run.id, 'pr')));
      const ci = waitOfKind(run.id, 'pr')!;
      const turns = turnEnds(run.id);
      const text = `${HARNESS_ADAPTERS[runner].scenarios.hold!}\nPlease also update the docs`;
      expect(manager.sendMessage(run.id, [{ type: 'text', text }])).toBe(true);
      await until(() => prompted(runner, 'Please also update the docs').length > 0);
      expect(prompted(runner, 'Please also update the docs').at(-1)).toContain(`\n\nStill open: CI wait ${ci.id} for acme/repo#12`);
      expect(waitOfKind(run.id, 'pr')).toMatchObject({ id: ci.id, phase: WAIT_PHASE.open });
      expect(external.aborted()).toBe(false);
      await until(() => turnEnds(run.id) > turns && parkedOn(run.id, waitOfKind(run.id, 'pr')));
      expect(waitOfKind(run.id, 'pr')?.id).toBe(ci.id);
      external.settle();
      await until(() => settled(run.id, ci.id)?.phase === 'delivered' && prompted(runner, `CI wait observation ${ci.id}`).length > 0);
      expect(prompted(runner, `CI wait observation ${ci.id}`).at(-1)).not.toContain('Please also update the docs');
      expect(inputsFor(run.id, ci.id)).toHaveLength(1);
      expect(store.readEvents(run.id).filter(event => event.type === 'user-message').map(event => event.text)).toContain(text);
    });

    it(`${runner} U7 cezar_wait and ScheduleWakeup land in the same wait list`, async () => {
      github();
      nativeWire(runner);
      const run = manager.startRun(QUICK_TASK_WORKFLOW, { task: toolCall('cezar_wait', { kind: WAIT_KIND.pr, pr }), runner });
      await until(() => parkedOn(run.id, viaOf(run.id, 'cezar_wait')));
      expect(viaOf(run.id, 'cezar_wait')).toMatchObject({ kind: WAIT_KIND.pr, prUrl: pr });
      const scheduler = { type: 'tool-call', id: 'toolu_1', tool: 'ScheduleWakeup', input: { delaySeconds: 120 } } as const;
      if (exemptionFor('U7', runner)) {
        // capability-absent: the same tool name on this wire is not a scheduler.
        expect(exemptionFor('U7', runner)?.reason).toBe('native scheduler tool exists only on the Claude wire');
        expect(nativeTimerDelay(scheduler, runner)).toBeUndefined();
        expect(store.getRun(run.id)?.waits?.map(wait => wait.via).sort()).toEqual(['cezar_wait']);
        return;
      }
      expect(nativeTimerDelay(scheduler, runner)).toBe(120);
      const turns = turnEnds(run.id);
      expect(manager.sendMessage(run.id, [{ type: 'text', text: 'mock:schedule-wakeup:120' }])).toBe(true);
      await until(() => turnEnds(run.id) > turns && parkedOn(run.id, viaOf(run.id, 'schedule-wakeup')));
      expect(viaOf(run.id, 'schedule-wakeup')).toMatchObject({ kind: WAIT_KIND.timer, seconds: 120 });
      expect(store.getRun(run.id)?.waits?.map(wait => wait.via).sort()).toEqual(['cezar_wait', 'schedule-wakeup']);
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
          const parkedSession = sessionOf(parked.id);
          checkpoint('u8-wake-delivered');
          if (kind === 'pr') external.settle(); else fireTimer(wait.id);
          await until(() => settled(parked.id, wait.id)?.phase === 'delivered');
          expect(store.getRun(blocker.id)?.status).toBe('running');
          expect(sessionOf(parked.id)).toBe(parkedSession);
          expect(inputsFor(parked.id, wait.id)).toHaveLength(1);
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
      const parked = manager.startRun(QUICK_TASK_WORKFLOW, { task: toolCall('cezar_wait', { kind: WAIT_KIND.timer, seconds: 60, note: 'u8l' }), runner });
      await until(() => parkedOn(parked.id, waitOfKind(parked.id, 'timer')));
      const wait = waitOfKind(parked.id, 'timer')!;
      // A closed session: its wake is a scheduler continuation, which needs a regular slot.
      sessionOf(parked.id).end();
      await until(() => !manager.isActive(parked.id) && store.getRun(parked.id)?.status === 'waiting');
      const release = join(root, 'u8l-release');
      process.env.CEZ_MOCK_RELEASE_FILE = release;
      let task: { id: string } | undefined;
      try {
        const previousSessionsFile = process.env.CEZ_MOCK_OPENCODE_SESSIONS_FILE;
        try {
          if (runner === 'opencode') process.env.CEZ_MOCK_OPENCODE_SESSIONS_FILE = join(root, 'u8l-blocker-sessions.json');
          const blocker = manager.startRun(QUICK_TASK_WORKFLOW, { task: HARNESS_ADAPTERS[runner].scenarios['hold-gated']!, runner });
          await until(() => store.readEvents(blocker.id).some(event => event.type === 'turn.started'));
        } finally {
          if (runner === 'opencode') {
            if (previousSessionsFile === undefined) delete process.env.CEZ_MOCK_OPENCODE_SESSIONS_FILE;
            else process.env.CEZ_MOCK_OPENCODE_SESSIONS_FILE = previousSessionsFile;
          }
        }
        // Queued before the wake joins the line.
        task = manager.startRun(QUICK_TASK_WORKFLOW, { task: HARNESS_ADAPTERS[runner].scenarios.baseline!, runner });
        expect(store.getRun(task.id)?.status).toBe('queued');
        if (runner === 'opencode') {
          const taskId = task.id;
          runnerBoundary.sessionFiles.set(taskId, join(root, `u8l-task-${randomUUID()}.json`));
          onTestFinished(() => { runnerBoundary.sessionFiles.delete(taskId); });
        }
        fireTimer(wait.id);
        await until(() => store.getRun(parked.id)?.waits?.find(entry => entry.id === wait.id)?.phase === 'resolved');
        expect(store.readEvents(task.id).some(event => event.type === 'turn.started')).toBe(false);
        expect(inputsFor(parked.id, wait.id).every(input => !input.deliveredAt)).toBe(true);
      } finally { writeFileSync(release, ''); }
      await until(() => settled(parked.id, wait.id)?.phase === 'delivered');
      const deliveredAt = Date.parse(settled(parked.id, wait.id)!.deliveredAt!);
      await until(() => store.readEvents(task!.id).some(event => event.type === 'turn.started'));
      if (runner === 'opencode') expect(sessionOf(parked.id).open).toBe(true);
      const taskStarted = Date.parse(store.readEvents(task.id).find(event => event.type === 'turn.started')!.ts);
      expect(taskStarted).toBeGreaterThanOrEqual(deliveredAt);
      await until(() => terminal.includes(store.getRun(task!.id)?.status ?? '') || store.getRun(task!.id)?.status === 'waiting');
    });

    for (const hold of ['deadline', 'in-flight'] as const) {
      it(`${runner} U8h a ci result for a park on a held account waits in the line and is delivered once the hold lifts (${hold})`, async () => {
        const external = github();
        nativeWire(runner);
        if (runner === 'opencode') process.env.CEZ_MOCK_OPENCODE_SESSIONS_FILE = join(root, 'u8h-sessions.json');
        const parked = manager.startRun(QUICK_TASK_WORKFLOW, { task: toolCall('cezar_wait', { kind: WAIT_KIND.pr, pr }), runner });
        await until(() => parkedOn(parked.id, waitOfKind(parked.id, 'pr')));
        const wait = waitOfKind(parked.id, 'pr')!;
        await expectPoolCapacity(runner, parked.id, true);
        // Another task on the same account waits out a usage limit, or its resume is testing the
        // window (hearsay-tools/cezarion#1236).
        const { agentProfile } = store.getRun(parked.id)!;
        const holder = store.createRun({ title: 'held', workflow: 'quick-task', task: 'held', steps: [] });
        setRunStatus(store, holder.id, hold === 'deadline' ? RUN_STATUS.waiting : RUN_STATUS.running, hold === 'deadline'
          ? { runner, agentProfile, autoResumeAt: new Date(Date.now() + 600_000).toISOString() }
          : { runner, agentProfile, autoResumeAttempts: 1 });
        expect([...manager.accountHolds()[hold === 'deadline' ? 'deadline' : 'inFlight']]).toContain(`${runner}:${agentProfile ?? 'default'}`);
        external.settle();
        // The result waits in the line, undelivered, while the account is held.
        await until(() => store.getRun(parked.id)?.waits?.find(entry => entry.id === wait.id)?.phase === 'resolved' && inputsFor(parked.id, wait.id).some(input => !input.deliveredAt));
        expect(settled(parked.id, wait.id)).toBeUndefined();
        if (hold === 'deadline') manager.cancelAutoResume(holder.id);
        else { setRunStatus(store, holder.id, RUN_STATUS.failed, { autoResumeAttempts: undefined }); manager.cancelAutoResume(holder.id); }
        await until(() => settled(parked.id, wait.id)?.phase === 'delivered');
        await until(() => store.getRun(parked.id)?.status === 'waiting' && !agentWaits(parked.id).length);
      });
    }

  }
}
