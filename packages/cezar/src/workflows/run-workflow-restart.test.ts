import { setRunStatus } from '../runs/run-store.testkit.ts';
import { setupMonitoringFixture } from './run-fixture.testkit.ts';
import { createFixtureManager } from './fixture-cleanup.testkit.ts';
import { describe, expect, it } from 'vitest';
import type { WorkflowDef } from './types.ts';
import { RUN_STATUS, STEP_KIND, STEP_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
describe('RunManager workflow restart', () => {
  const fixture = setupMonitoringFixture();
  const { SINGLE_STEP, waitFor } = fixture;
  it('restart resumes a durably queued workflow after its completed waiting step', async () => {
    const workflow: WorkflowDef = {
      name: 'ask-then-later',
      source: 'file',
      steps: [
        { id: 'task', name: 'Task', prompt: '{{task}}' },
        { id: 'continue-1', name: 'Real numeric step', command: 'node -e "process.exit(0)"' },
        { id: 'later', name: 'Later', command: 'node -e "process.exit(0)"' },
      ],
    };
    const record = fixture.manager.startRun(SINGLE_STEP, { task: 'mock:cezar-ask choose', worktree: false });
    fixture.currentId = record.id;
    await waitFor(record.id, (candidate) => candidate?.status === 'waiting');
    const state = (fixture.manager as unknown as {
      active: Map<string, { idleTimer?: NodeJS.Timeout }>;
    }).active.get(record.id);
    const idleTimer = state?.idleTimer as (NodeJS.Timeout & { _onTimeout?: () => void }) | undefined;
    if (!idleTimer?._onTimeout) throw new Error('waiting session did not arm an idle timer');
    idleTimer._onTimeout();
    await waitFor(record.id, () => !(fixture.manager as unknown as { active: Map<string, unknown> }).active.has(record.id));
    fixture.manager.dispose();
    fixture.store.addStep(record.id, { id: 'continue-1', name: 'Real numeric step', kind: STEP_KIND.check });
    fixture.store.addStep(record.id, { id: 'later', name: 'Later', kind: STEP_KIND.check });
    fixture.store.updateStep(record.id, 'task', { status: STEP_STATUS.done, finishedAt: new Date().toISOString() });
    setRunStatus(fixture.store, record.id, RUN_STATUS.queued, { currentStepId: undefined, workflowDef: workflow });
    fixture.store.flush();

    fixture.manager = createFixtureManager(fixture.store, fixture.repoRoot);
    await fixture.manager.recover();
    await waitFor(record.id, (candidate) => candidate?.status === 'done' || candidate?.status === 'review');
    expect(fixture.store.getRun(record.id)?.steps).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'task', status: STEP_STATUS.done, iterations: 1 }),
      expect.objectContaining({ id: 'continue-1', status: STEP_STATUS.done, iterations: 1 }),
      expect.objectContaining({ id: 'later', status: STEP_STATUS.done, iterations: 1 }),
    ]));
  }, 30_000);

  it('restart resumes the remaining workflow after interrupting a non-final agent step', async () => {
    const workflow: WorkflowDef = {
      name: 'interrupted-then-later', source: 'file',
      steps: [
        { id: 'task', name: 'Task', prompt: '{{task}}' },
        { id: 'previously-failed', name: 'Previously failed', command: 'node -e "process.exit(0)"' },
        { id: 'later', name: 'Later', command: 'node -e "process.exit(0)"' },
      ],
    };
    const record = fixture.manager.startRun(SINGLE_STEP, { task: 'just do the thing', worktree: false });
    fixture.currentId = record.id;
    await waitFor(record.id, (candidate) => candidate?.status === 'waiting');
    const state = (fixture.manager as unknown as {
      active: Map<string, { idleTimer?: NodeJS.Timeout }>;
    }).active.get(record.id);
    const idleTimer = state?.idleTimer as (NodeJS.Timeout & { _onTimeout?: () => void }) | undefined;
    if (!idleTimer?._onTimeout) throw new Error('waiting session did not arm an idle timer');
    idleTimer._onTimeout();
    await waitFor(record.id, () => !(fixture.manager as unknown as { active: Map<string, unknown> }).active.has(record.id));
    fixture.manager.dispose();
    fixture.store.addStep(record.id, { id: 'previously-failed', name: 'Previously failed', kind: STEP_KIND.check });
    fixture.store.updateStep(record.id, 'previously-failed', { status: STEP_STATUS.failed, finishedAt: new Date().toISOString() });
    fixture.store.addStep(record.id, { id: 'later', name: 'Later', kind: STEP_KIND.check });
    fixture.store.updateStep(record.id, 'task', { status: STEP_STATUS.running, finishedAt: undefined });
    setRunStatus(fixture.store, record.id, RUN_STATUS.running, { currentStepId: 'task', workflowDef: workflow, continuationMessage: {
        id: 'restart-task', text: 'mock:cezar-done recover', origin: 'lifecycle', createdAt: new Date().toISOString(),
      } });
    fixture.store.flush();

    fixture.manager = createFixtureManager(fixture.store, fixture.repoRoot);
    await fixture.manager.recover();
    await waitFor(record.id, (candidate) => candidate?.status === 'done' || candidate?.status === 'review');
    expect(fixture.store.getRun(record.id)?.steps).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'task', status: STEP_STATUS.done }),
      expect.objectContaining({ id: 'previously-failed', status: STEP_STATUS.done, iterations: 1 }),
      expect.objectContaining({ id: 'later', status: STEP_STATUS.done, iterations: 1 }),
    ]));
  }, 30_000);

  it('does not mistake a legacy workflow step named continue-1 for a synthetic continuation', async () => {
    const record = fixture.manager.startRun(SINGLE_STEP, { task: 'mock:cezar-ask choose', worktree: false });
    fixture.currentId = record.id;
    await waitFor(record.id, (candidate) => candidate?.status === 'waiting');
    const state = (fixture.manager as unknown as { active: Map<string, { idleTimer?: NodeJS.Timeout }> }).active.get(record.id);
    const idleTimer = state?.idleTimer as (NodeJS.Timeout & { _onTimeout?: () => void }) | undefined;
    if (!idleTimer?._onTimeout) throw new Error('waiting session did not arm an idle timer');
    idleTimer._onTimeout();
    await waitFor(record.id, () => !(fixture.manager as unknown as { active: Map<string, unknown> }).active.has(record.id));
    const persisted = fixture.store.getRun(record.id)!;
    persisted.steps[0]!.id = 'continue-1';
    fixture.store.addStep(record.id, { id: 'later', name: 'Later', kind: STEP_KIND.check });
    fixture.store.updateRun(record.id, { currentStepId: 'continue-1', workflowDef: undefined });

    expect(fixture.manager.finish(record.id)).toBe(false);
    expect(fixture.manager.continueRun(record.id, { text: 'answer' })).toEqual({
      ok: false,
      error: 'cannot continue a waiting run before its final workflow step',
    });
  }, 30_000);
});
