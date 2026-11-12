import { idleClose, observeIdleClose } from './worker-wait-readiness.testkit.ts';
import { setupMonitoringFixture } from './run-fixture.testkit.ts';
import { createFixtureManager } from './fixture-cleanup.testkit.ts';
import { describe, expect, it, vi } from 'vitest';
import { type RunRecord } from '../runs/store.ts';
import type { WorkflowDef } from './types.ts';
import { RUN_STATUS, STEP_KIND, STEP_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
describe('RunManager workflow remainder resume', () => {
  const fixture = setupMonitoringFixture();
  const { SINGLE_STEP, waitFor } = fixture;
  it.each(['workflow definition', 'legacy persisted steps'].flatMap(shape =>
    ['zero-config', 'delegated root'].map(delegation => ({ shape, delegation }))))(
  'does not let an inactive $delegation skip later workflow steps using $shape', async ({ shape, delegation }) => {
    const clock = observeIdleClose(fixture.store);
    const record = fixture.manager.startRun(SINGLE_STEP, { task: 'mock:cezar-ask choose', worktree: false });
    if (delegation === 'delegated root') {
      fixture.store.commitDelegation([{
        id: record.id,
        delegation: { role: 'root', permissions: ['spawn', 'wait'], receipts: [] },
      }]);
    }
    fixture.currentId = record.id;
    await waitFor(record.id, (candidate) => candidate?.status === 'waiting');
    fixture.store.addStep(record.id, { id: 'later', name: 'Later', kind: STEP_KIND.agent });
    if (shape === 'workflow definition') {
      fixture.store.updateRun(record.id, { workflowDef: {
        name: 'ask-then-later',
        source: 'file',
        steps: [SINGLE_STEP.steps[0]!, { id: 'later', name: 'Later', prompt: 'mock:cezar-done later' }],
      } });
    } else {
      fixture.store.updateRun(record.id, { workflowDef: undefined });
    }
    await idleClose(clock, record.id, fixture.manager, fixture.store, predicate => waitFor(record.id, predicate));

    fixture.manager.dispose();
    fixture.manager = createFixtureManager(fixture.store, fixture.repoRoot);
    await fixture.manager.recover();
    expect(fixture.manager.finish(record.id)).toBe(false);
    if (shape === 'workflow definition') {
      expect(fixture.manager.continueRun(record.id, { text: 'mock:cezar-done answer' })).toEqual({ ok: true });
      await waitFor(record.id, (candidate) => candidate?.status === 'done' || candidate?.status === 'review');
      expect(fixture.store.getRun(record.id)?.steps).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'task', status: STEP_STATUS.done }),
        expect.objectContaining({ id: 'later', status: STEP_STATUS.done }),
      ]));
      return;
    }
    expect(fixture.manager.continueRun(record.id, { text: 'answer' })).toEqual({
      ok: false,
      error: 'cannot continue a waiting run before its final workflow step',
    });
    expect(fixture.store.getRun(record.id)).toMatchObject({
      status: RUN_STATUS.waiting,
      currentStepId: 'task',
      steps: [
        expect.objectContaining({ id: 'task', status: STEP_STATUS.waiting }),
        expect.objectContaining({ id: 'later', status: STEP_STATUS.pending }),
      ],
    });
  }, 30_000);

  it('resumes the remaining workflow after an inactive delegated root answers a non-final ask', async () => {
    const workflow: WorkflowDef = {
      name: 'ask-then-later',
      source: 'file',
      steps: [
        { id: 'task', name: 'Task', prompt: '{{task}}' },
        { id: 'later', name: 'Later', prompt: 'mock:cezar-done later' },
      ],
    };
    const clock = observeIdleClose(fixture.store);
    const record = fixture.manager.startRun(SINGLE_STEP, { task: 'mock:cezar-ask choose', worktree: false });
    fixture.store.commitDelegation([{
      id: record.id,
      delegation: { role: 'root', permissions: ['spawn', 'wait'], receipts: [] },
    }]);
    fixture.currentId = record.id;
    await waitFor(record.id, (candidate) => candidate?.status === 'waiting');
    fixture.store.addStep(record.id, { id: 'later', name: 'Later', kind: STEP_KIND.agent });
    fixture.store.updateRun(record.id, { workflowDef: workflow });
    await idleClose(clock, record.id, fixture.manager, fixture.store, predicate => waitFor(record.id, predicate));

    fixture.manager.dispose();
    fixture.manager = createFixtureManager(fixture.store, fixture.repoRoot);
    await fixture.manager.recover();
    const originalStartedAt = '2026-09-01T00:00:00.000Z';
    const originalBaseBranch = 'original-diff-baseline';
    fixture.store.updateRun(record.id, { startedAt: originalStartedAt, baseBranch: originalBaseBranch });
    const flushed: RunRecord[] = [];
    const originalFlush = fixture.store.flush.bind(fixture.store);
    vi.spyOn(fixture.store, 'flush').mockImplementation(() => {
      flushed.push(structuredClone(fixture.store.getRun(record.id)!));
      originalFlush();
    });
    expect(fixture.manager.continueRun(record.id, { text: 'mock:cezar-done answer' })).toEqual({ ok: true });
    await waitFor(record.id, (candidate) => candidate?.status === 'done' || candidate?.status === 'review');
    expect(flushed).toEqual(expect.arrayContaining([
      expect.objectContaining({
        status: RUN_STATUS.queued,
        steps: expect.arrayContaining([
          expect.objectContaining({ id: 'task', status: STEP_STATUS.done }),
          expect.objectContaining({ id: 'later', status: STEP_STATUS.pending }),
        ]),
      }),
    ]));
    expect(fixture.store.getRun(record.id)?.steps).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'task', status: STEP_STATUS.done }),
      expect.objectContaining({ id: 'later', status: STEP_STATUS.done }),
    ]));
    expect(fixture.store.getRun(record.id)).toMatchObject({
      startedAt: originalStartedAt,
      baseBranch: originalBaseBranch,
    });
  }, 30_000);

  it('does not launch a prepared workflow remainder when cancellation wins during continuation teardown', async () => {
    const workflow: WorkflowDef = { name: 'cancel-remainder', source: 'file', steps: [
      { id: 'task', name: 'Task', prompt: '{{task}}' },
      { id: 'later', name: 'Later', command: 'true' },
    ] };
    const clock = observeIdleClose(fixture.store);
    const record = fixture.manager.startRun(SINGLE_STEP, { task: 'plain markerless turn', worktree: false });
    fixture.currentId = record.id;
    await waitFor(record.id, candidate => candidate?.status === 'waiting');
    fixture.store.addStep(record.id, { id: 'later', name: 'Later', kind: STEP_KIND.check });
    fixture.store.updateRun(record.id, { workflowDef: workflow });
    await idleClose(clock, record.id, fixture.manager, fixture.store, predicate => waitFor(record.id, predicate));

    let cancelled = false;
    let cancelAttempted = false;
    fixture.store.on('run', candidate => {
      if (!cancelAttempted && candidate.id === record.id && candidate.status === 'queued') {
        cancelAttempted = true;
        cancelled = fixture.manager.cancel(record.id);
      }
    });
    expect(fixture.manager.continueRun(record.id, { text: 'mock:cezar-done answer' })).toEqual({ ok: true });
    await waitFor(record.id, candidate => candidate?.status === 'cancelled');

    expect(cancelled).toBe(true);
    expect(fixture.store.getRun(record.id)?.steps).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'later', status: STEP_STATUS.pending, iterations: 0 }),
    ]));
  }, 30_000);

  it('records a Stop accepted while a failed Continue saves its worktree as cancelled', async () => {
    const record = fixture.manager.startRun(SINGLE_STEP, { task: 'mock:cezar-done', worktree: false });
    fixture.currentId = record.id;
    await waitFor(record.id, candidate => candidate?.status === 'done' || candidate?.status === 'review');
    await waitFor(record.id, () => !fixture.manager.isActive(record.id));
    let cancelled = false;
    let cancelAttempted = false;
    fixture.store.on('run', candidate => {
      if (!cancelAttempted && candidate.id === record.id && candidate.status === 'failed') {
        cancelAttempted = true;
        cancelled = fixture.manager.cancel(record.id);
      }
    });
    expect(fixture.manager.continueRun(record.id, { text: 'mock:request-error answer' })).toEqual({ ok: true });
    await waitFor(record.id, candidate => candidate?.status === 'cancelled');
    expect(cancelled).toBe(true);
  }, 30_000);
});
