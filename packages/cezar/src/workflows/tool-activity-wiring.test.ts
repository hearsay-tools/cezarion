// The fixture's runner mock must load before anything that imports the run manager.
import { runnerHook, setupMonitoringFixture } from './run-fixture.testkit.ts';
import { describe, expect, it } from 'vitest';
import { activityToolSchema } from '@open-mercato/cezar-contract/activity';
import { ToolActivityTracker } from '../activity/tool-activity.ts';
import { createFixtureManager } from './fixture-cleanup.testkit.ts';

const TOOL_STATUS = activityToolSchema.shape.status.enum;

/** The run manager feeds the process's tool activity tracker from each session's UI event sink,
 *  and drops a run from it when the run leaves the live set (spec 2026-11-05-live-activity-view). */
describe('RunManager tool activity', () => {
  const fixture = setupMonitoringFixture();

  it('feeds a live session’s tool items to the tracker, and drops the run when it is cancelled', async () => {
    fixture.manager.dispose();
    const toolActivity = new ToolActivityTracker();
    fixture.manager = createFixtureManager(fixture.store, fixture.repoRoot, { semaphore: fixture.semaphore, toolActivity });
    const record = fixture.manager.startRun(fixture.SINGLE_STEP, { task: 'mock:schedule-wakeup keep going', runner: 'claude', worktree: false });
    fixture.currentId = record.id;
    await fixture.waitFor(record.id, (run) => run?.status === 'waiting');

    runnerHook.uiEvent({ type: 'item.started', item: { kind: 'tool', id: 'tool-1', name: 'Bash', toolKind: 'execute', title: 'Ran npm test', status: TOOL_STATUS.running } });
    expect(toolActivity.read(record.id, Date.now())?.tool).toMatchObject({ title: 'Ran npm test', status: TOOL_STATUS.running });

    fixture.manager.cancel(record.id);
    await fixture.waitFor(record.id, (run) => run?.status === 'cancelled');
    expect(toolActivity.read(record.id, Date.now())).toBeUndefined();
  }, 30_000);
});
