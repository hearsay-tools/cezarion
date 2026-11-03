import { handleRunnerUiEvent, makeUiSink } from './run/session-events.ts';
import { runInternals } from './run-internals.testkit.ts';
import { createFixtureManager } from './fixture-cleanup.testkit.ts';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { UiEvent } from '../core/ui-events.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { RUN_STATUS, WAIT_KIND, WAIT_PHASE } from '@open-mercato/cezar-contract/test-factories.testkit';
import { monitoringTimerOf, monitoringWakeOf } from './waits.testkit.ts';
import { setupMonitoringFixture } from './run-fixture.testkit.ts';
describe('RunManager monitoring turns', () => {
  const fixture = setupMonitoringFixture();
  const { SINGLE_STEP, waitFor } = fixture;
  it('nested Codex subagent items after park do not unpark monitoring (#121)', async () => {
    fixture.manager.dispose();
    const semaphore = new WorkspaceSemaphore({ initial: { monitoringWakeIntervalMinutes: 0.01 } });
    fixture.manager = createFixtureManager(fixture.store, fixture.repoRoot, { semaphore });
    const record = fixture.manager.startRun(SINGLE_STEP, { task: 'mock:schedule-wakeup keep going', runner: 'claude', worktree: false });
    fixture.currentId = record.id;
    await waitFor(record.id, (r) => r?.status === 'waiting' && Boolean(monitoringWakeOf(r)));

    const internals = runInternals(fixture.manager);
    const state = internals.active.get(record.id);
    if (!state) throw new Error('active run state missing');
    const wakeTimer = monitoringTimerOf(fixture.manager, record.id);
    const deadline = monitoringWakeOf(fixture.store.getRun(record.id));
    const sink = makeUiSink(internals.context, internals.sessionHelperHost, record.id, 'task');
    const inject = (event: UiEvent) => handleRunnerUiEvent(internals.context, internals.sessionHelperHost, record.id, state, sink, event);

    inject({
      type: 'item.completed',
      item: { kind: 'message', id: 'compact-1', role: 'assistant', text: 'Compacted context' },
    });
    inject({
      type: 'item.started',
      item: {
        kind: 'tool',
        id: 'child-bash',
        name: 'commandExecution',
        toolKind: 'execute',
        title: 'Ran ls',
        status: RUN_STATUS.running,
        parentItemId: 'task6',
      },
    });
    inject({
      type: 'item.completed',
      item: {
        kind: 'tool',
        id: 'child-bash',
        name: 'commandExecution',
        toolKind: 'execute',
        title: 'Ran ls',
        status: 'completed',
        parentItemId: 'task6',
      },
    });
    inject({
      type: 'item.started',
      item: { kind: 'reasoning', id: 'child-think', text: 'working', parentItemId: 'task6' },
    });
    inject({
      type: 'item.completed',
      item: {
        kind: 'tool',
        id: 'task6',
        name: 'subAgentActivity',
        toolKind: 'task',
        title: 'task6',
        status: 'completed',
      },
    });

    expect(fixture.store.getRun(record.id)).toMatchObject({ status: RUN_STATUS.waiting });
    expect(monitoringWakeOf(fixture.store.getRun(record.id))).toBe(deadline);
    expect(monitoringTimerOf(fixture.manager, record.id)).toBe(wakeTimer);
    expect(runInternals(fixture.manager).line.waiting.has(record.id)).toBe(true);
    expect(runInternals(fixture.manager).line.monitoring.has(record.id)).toBe(true);
    expect(runInternals(fixture.manager).line.busySlots()).toBe(0);
    expect(semaphore.busy()).toBe(0);

    await waitFor(record.id, () => {
      const events = readFileSync(join(fixture.repoRoot, '.ai/cezar/runs', `${record.id}.ndjson`), 'utf8');
      return events.includes('automatic monitoring wake-up (1/40)');
    });
  }, 30_000);

  it('parent turn.started after park still unparks monitoring (#61, #121)', async () => {
    fixture.manager.dispose();
    const semaphore = new WorkspaceSemaphore({ initial: { monitoringWakeIntervalMinutes: 0.02 } });
    fixture.manager = createFixtureManager(fixture.store, fixture.repoRoot, { semaphore });
    const record = fixture.manager.startRun(SINGLE_STEP, { task: 'mock:schedule-wakeup keep going', runner: 'claude', worktree: false });
    fixture.currentId = record.id;
    await waitFor(record.id, (r) => r?.status === 'waiting' && Boolean(monitoringWakeOf(r)));

    const internals = runInternals(fixture.manager);
    const state = internals.active.get(record.id);
    if (!state) throw new Error('active run state missing');
    handleRunnerUiEvent(internals.context, internals.sessionHelperHost, 
      record.id,
      state,
      makeUiSink(internals.context, internals.sessionHelperHost, record.id, 'task'),
      { type: 'turn.started', turnId: 'turn_parent_resume' },
    );

    // hearsay-tools/cezarion#1233: the resumed turn keeps its pool slot until its own turn end.
    // hearsay-tools/cezarion#2431 (owner decision 4): a parent turn the runner starts itself closes
    // every open timer, so the timer cannot wake a second turn after it. The turn's own end decides
    // what it waits on next: a new monitoring line or wait, else the no-wait nudge.
    expect(fixture.store.getRun(record.id)).toMatchObject({ status: RUN_STATUS.running });
    expect(monitoringWakeOf(fixture.store.getRun(record.id))).toBeUndefined();
    expect(monitoringTimerOf(fixture.manager, record.id)).toBeUndefined();
    expect(fixture.store.getRun(record.id)?.lastWaits?.filter(wait => wait.kind === WAIT_KIND.timer).map(wait => wait.phase)).toEqual([WAIT_PHASE.cancelled]);
    expect(runInternals(fixture.manager).line.waiting.has(record.id)).toBe(false);
    expect(runInternals(fixture.manager).line.monitoring.has(record.id)).toBe(true);
    expect(runInternals(fixture.manager).line.busySlots()).toBe(0);
    expect(semaphore.busy()).toBe(0);
  }, 30_000);

  it('a markerless turn-end still parks as waiting with no activity', async () => {
    const record = fixture.manager.startRun(SINGLE_STEP, { task: 'just do the thing', worktree: false });
    fixture.currentId = record.id;
    await waitFor(record.id, (r) => r?.status === 'waiting');
    const state = (fixture.manager as unknown as {
      active: Map<string, { idleTimer?: NodeJS.Timeout }>;
    }).active.get(record.id);
    expect(state?.idleTimer).toBeDefined(); // genuine user waits still expire after IDLE_TIMEOUT_MS
    expect(monitoringTimerOf(fixture.manager, record.id)).toBeUndefined();
  }, 30_000);
});
