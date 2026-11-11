import { expect, it, onTestFinished, vi } from 'vitest';
import { QUICK_TASK_WORKFLOW } from './types.ts';
import '../core/no-runner.testkit.ts';
import { manager, semaphore, store, until, useWorkerWaitFixture } from './worker-wait-core.testkit.ts';

useWorkerWaitFixture();

it('cancels an unstarted queued run before onTestFinished checks its durable outcome', async () => {
  const capacity = vi.spyOn(semaphore, 'maxParallel').mockReturnValue(0);
  const run = manager.startRun(QUICK_TASK_WORKFLOW, { task: 'must stay queued', runner: 'claude', worktree: false });
  let status = store.getRun(run.id)?.status;
  store.on('run', () => { status = store.getRun(run.id)?.status; });
  onTestFinished(() => {
    expect(status).toBe('cancelled');
    expect(manager.isActive(run.id)).toBe(false);
  });
  await until(() => capacity.mock.calls.length > 0);
  expect(store.getRun(run.id)?.status).toBe('queued');
  expect(store.getRun(run.id)?.steps.every(step => !step.sessionId)).toBe(true);
  expect(manager.isActive(run.id)).toBe(true);
});
