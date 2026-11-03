import { createFixtureManager } from './fixture-cleanup.testkit.ts';
import { describe, expect, it, vi } from 'vitest';
import { type RunRecord } from '../runs/store.ts';
import type { WorkflowDef } from './types.ts';
import { RUN_STATUS, STEP_KIND, STEP_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { setupMonitoringFixture } from './run-fixture.testkit.ts';
describe('RunManager check retry recovery', () => {
  const fixture = setupMonitoringFixture();
  const { SINGLE_STEP, waitFor } = fixture;
  it('keeps a check retry budget bounded across a recovered workflow remainder', async () => {
    const workflow: WorkflowDef = {
      name: 'bounded-retry', source: 'file',
      steps: [
        { id: 'task', name: 'Task', prompt: '{{task}}' },
        { id: 'verify', name: 'Verify', command: 'node -e "process.exit(1)"', onFail: { retry: 'task', max: 1 } },
      ],
    };
    const record = fixture.store.createRun({
      title: 'bounded retry', task: 'mock:cezar-done', workflow: workflow.name,
      steps: [
        { id: 'task', name: 'Task', kind: STEP_KIND.agent },
        { id: 'verify', name: 'Verify', kind: STEP_KIND.check },
      ],
    });
    fixture.currentId = record.id;
    fixture.store.updateStep(record.id, 'task', { status: STEP_STATUS.done, iterations: 1 });
    fixture.store.updateStep(record.id, 'verify', { status: STEP_STATUS.failed, iterations: 1, retriesUsed: 1 });
    fixture.store.updateRun(record.id, { status: RUN_STATUS.queued, workflowDef: workflow });

    await (fixture.manager as unknown as {
      execute(id: string, workflow: WorkflowDef, input: { task: string; worktree: boolean }, startAt: number): Promise<void>;
    }).execute(record.id, workflow, { task: 'mock:cezar-done', worktree: false }, 1);

    expect(fixture.store.getRun(record.id)).toMatchObject({ status: RUN_STATUS.failed });
    expect(fixture.store.getRun(record.id)?.steps).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'task', status: STEP_STATUS.done, iterations: 1 }),
      expect.objectContaining({ id: 'verify', status: STEP_STATUS.failed, iterations: 2 }),
    ]));
  }, 30_000);

  it('does not spend a check retry merely because another loop executed it before', async () => {
    const workflow: WorkflowDef = {
      name: 'distinct-retry-budget', source: 'file',
      steps: [
        { id: 'task', name: 'Task', prompt: '{{task}}' },
        { id: 'gate', name: 'Gate', command: 'node -e "process.exit(1)"', onFail: { retry: 'task', max: 1 } },
      ],
    };
    const record = fixture.store.createRun({
      title: 'distinct retry', task: 'mock:cezar-done', workflow: workflow.name,
      steps: [
        { id: 'task', name: 'Task', kind: STEP_KIND.agent },
        { id: 'gate', name: 'Gate', kind: STEP_KIND.check },
      ],
    });
    fixture.currentId = record.id;
    fixture.store.updateStep(record.id, 'task', { status: STEP_STATUS.done, iterations: 1 });
    fixture.store.updateStep(record.id, 'gate', { status: STEP_STATUS.done, iterations: 1 });
    fixture.store.updateRun(record.id, { status: RUN_STATUS.queued, workflowDef: workflow });

    const flushes: RunRecord[] = [];
    const originalFlush = fixture.store.flush.bind(fixture.store);
    vi.spyOn(fixture.store, 'flush').mockImplementation(() => {
      flushes.push(structuredClone(fixture.store.getRun(record.id)!));
      originalFlush();
    });
    await (fixture.manager as unknown as {
      execute(id: string, workflow: WorkflowDef, input: { task: string; worktree: boolean }, startAt: number): Promise<void>;
    }).execute(record.id, workflow, { task: 'mock:cezar-done', worktree: false }, 1);

    expect(fixture.store.getRun(record.id)?.steps).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'task', iterations: 2 }),
      expect.objectContaining({ id: 'gate', status: STEP_STATUS.failed, iterations: 3, retriesUsed: 1 }),
    ]));
    expect(flushes.some(snapshot =>
      snapshot.status === 'queued' && snapshot.currentStepId === undefined &&
      snapshot.steps.some(step => step.id === 'task' && step.status === 'pending') &&
      snapshot.steps.some(step => step.id === 'gate' && step.status === 'pending' && step.retriesUsed === 1),
    )).toBe(true);
  }, 30_000);

  it('does not treat an unrelated failed check as a continuation workflow source', async () => {
    const record = fixture.manager.startRun(SINGLE_STEP, { task: 'plain markerless turn', worktree: false });
    fixture.currentId = record.id;
    await waitFor(record.id, (candidate) => candidate?.status === 'waiting');
    const state = (fixture.manager as unknown as { active: Map<string, { idleTimer?: NodeJS.Timeout }> }).active.get(record.id);
    const idleTimer = state?.idleTimer as (NodeJS.Timeout & { _onTimeout?: () => void }) | undefined;
    if (!idleTimer?._onTimeout) throw new Error('waiting session did not arm an idle timer');
    idleTimer._onTimeout();
    await waitFor(record.id, () => !(fixture.manager as unknown as { active: Map<string, unknown> }).active.has(record.id));
    const workflow: WorkflowDef = {
      name: 'failed-check', source: 'file',
      steps: [
        SINGLE_STEP.steps[0]!,
        { id: 'verify', name: 'Verify', command: 'false' },
        { id: 'later', name: 'Later', command: 'true' },
      ],
    };
    fixture.store.updateStep(record.id, 'task', { status: STEP_STATUS.done });
    fixture.store.addStep(record.id, { id: 'verify', name: 'Verify', kind: STEP_KIND.check });
    fixture.store.updateStep(record.id, 'verify', { status: STEP_STATUS.failed, iterations: 1 });
    fixture.store.addStep(record.id, { id: 'later', name: 'Later', kind: STEP_KIND.check });
    fixture.store.updateRun(record.id, { status: RUN_STATUS.failed, currentStepId: undefined, workflowDef: workflow });

    expect(fixture.manager.continueRun(record.id, { text: 'mock:cezar-done inspect failure' })).toEqual({ ok: true });
    await waitFor(record.id, (candidate) => candidate?.status === 'done' || candidate?.status === 'review');
    expect(fixture.store.getRun(record.id)?.steps).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'verify', status: STEP_STATUS.failed, iterations: 1 }),
      expect.objectContaining({ id: 'later', status: STEP_STATUS.pending, iterations: 0 }),
    ]));
  }, 30_000);

  it('restart reruns an interrupted check instead of completing it as a continuation source', async () => {
    const record = fixture.manager.startRun(SINGLE_STEP, { task: 'plain markerless turn', worktree: false });
    fixture.currentId = record.id;
    await waitFor(record.id, candidate => candidate?.status === 'waiting');
    const state = (fixture.manager as unknown as { active: Map<string, { idleTimer?: NodeJS.Timeout }> }).active.get(record.id);
    const idleTimer = state?.idleTimer as (NodeJS.Timeout & { _onTimeout?: () => void }) | undefined;
    if (!idleTimer?._onTimeout) throw new Error('waiting session did not arm an idle timer');
    idleTimer._onTimeout();
    await waitFor(record.id, () => !(fixture.manager as unknown as { active: Map<string, unknown> }).active.has(record.id));
    fixture.manager.dispose();
    const workflow: WorkflowDef = { name: 'interrupted-check', source: 'file', steps: [
      SINGLE_STEP.steps[0]!,
      { id: 'verify', name: 'Verify', command: 'true' },
      { id: 'later', name: 'Later', command: 'true' },
    ] };
    fixture.store.updateStep(record.id, 'task', { status: STEP_STATUS.done });
    fixture.store.addStep(record.id, { id: 'verify', name: 'Verify', kind: STEP_KIND.check });
    fixture.store.updateStep(record.id, 'verify', { status: STEP_STATUS.running, iterations: 1 });
    fixture.store.addStep(record.id, { id: 'later', name: 'Later', kind: STEP_KIND.check });
    fixture.store.updateRun(record.id, { status: RUN_STATUS.running, currentStepId: 'verify', workflowDef: workflow });
    fixture.store.flush();

    fixture.manager = createFixtureManager(fixture.store, fixture.repoRoot);
    await fixture.manager.recover();
    await waitFor(record.id, candidate => candidate?.status === 'done' || candidate?.status === 'review');
    expect(fixture.store.getRun(record.id)?.steps).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'verify', status: STEP_STATUS.done, iterations: 2 }),
      expect.objectContaining({ id: 'later', status: STEP_STATUS.done, iterations: 1 }),
    ]));
  }, 30_000);
});
