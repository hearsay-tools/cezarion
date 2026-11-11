import { setRunStatus } from '../runs/run-store.testkit.ts';
import { describe, expect, it } from 'vitest';
import { RUN_STATUS, STEP_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { parent, restart, store, until, useWorkerWaitFixture, worker } from './worker-wait-claude.testkit.ts';

/**
 * A restart finds an owned worker `waiting` with no ask and no wait: its session closed, and a
 * worker cannot take an ordinary inactive Continue, so recovery settles it
 * (`RunRecovery.recoverClosedWaitingRun`). Slice S7, Table B row B11
 * (.ai/specs/2026-11-03-run-store-owns-exits.md): a worker that fails on an ask it cannot show
 * keeps its waiting step, the step a parent resume re-enters (hearsay-tools/cezarion#1620).
 */
// Real Git, durable checkpoints and the restart share this budget.
describe('restart recovery of a closed waiting worker', { timeout: 30_000 }, () => {
  useWorkerWaitFixture();

  async function closedWorker(invalidAsk: boolean): Promise<string> {
    const p = await parent();
    await until(() => store.getRun(p.id)?.status === RUN_STATUS.waiting);
    const w = await worker(p.id);
    {
      const { status: fixtureStatus, ...fixtureExtras }: NonNullable<Parameters<typeof setRunStatus>[3]> & { status: Parameters<typeof setRunStatus>[2] } = { status: RUN_STATUS.waiting, currentStepId: 'task', ...(invalidAsk ? { invalidAsk: true } : {}) };
      setRunStatus(store, w.id, fixtureStatus, fixtureExtras);
    }
    store.updateStep(w.id, 'task', { status: STEP_STATUS.waiting, iterations: 1 });
    store.flush();
    return w.id;
  }

  it('fails a worker whose ask cannot be shown, and keeps its waiting step', async () => {
    const id = await closedWorker(true);
    await restart();
    const run = store.getRun(id)!;
    expect(run).toMatchObject({ status: RUN_STATUS.failed, error: 'invalid structured question', finishedAt: expect.any(String) });
    expect(run.currentStepId).toBeUndefined();
    expect(run.steps.map(step => step.status)).toEqual([STEP_STATUS.waiting]);
  });

  it('settles any other closed worker done, its step with it', async () => {
    const id = await closedWorker(false);
    await restart();
    await until(() => store.getRun(id)?.status === RUN_STATUS.done);
    expect(store.getRun(id)?.steps.map(step => step.status)).toEqual([STEP_STATUS.done]);
    expect(store.readEvents(id).some(event => event.type === 'lifecycle' && event.message === 'cezar restarted — the open worker session was settled')).toBe(true);
  });
});
