import { setRunStatus } from '../runs/run-store.testkit.ts';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { RUN_STATUS, STEP_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { manager, parent, restart, store, until, useWorkerWaitFixture, worker } from './worker-wait-claude.testkit.ts';

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

// hearsay-tools/squawk#868: a worker that runs mid-turn when the server stops is resumed by recovery
// (`RunRecovery.recoverInterruptedRun`), and its uncommitted worktree changes stay.
describe('restart recovery of a running worker', { timeout: 30_000 }, () => {
  useWorkerWaitFixture();

  it('resumes an owned worker interrupted mid-turn, keeping its uncommitted worktree changes', async () => {
    const p = await parent(); const w = await worker(p.id, 'mock:slow'); manager.enqueueOwnedRun(w.id);
    await until(() => store.getRun(w.id)?.status === RUN_STATUS.running && !!store.getRun(w.id)?.steps[0]?.sessionId);
    const delegation = store.getRun(w.id)!.delegation;
    if (delegation?.role !== 'worker') throw new Error('expected a worker');
    const cwd = delegation.workspace.path; const edit = join(cwd, 'work.txt');
    writeFileSync(edit, 'committed');
    execFileSync('git', ['add', 'work.txt'], { cwd });
    execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@local', 'commit', '-qm', 'work'], { cwd });
    // The test restart stops the old manager first, and its final autosave commits the worktree.
    // A crash runs no autosave: edit the tracked file after the stop, as the new store opens.
    const open = RunStore.open.bind(RunStore);
    vi.spyOn(RunStore, 'open').mockImplementationOnce((...args) => {
      writeFileSync(edit, 'uncommitted edit');
      return open(...args);
    });
    await restart();
    await until(() => store.readEvents(w.id).some(event => event.type === 'lifecycle' && event.message === 'cezar restarted — resuming the interrupted task from its last session'));
    await until(() => store.getRun(w.id)?.status === RUN_STATUS.running && manager.isActive(w.id));
    expect(store.getRun(w.id)?.delegation).toMatchObject({ executionRevision: 1 });
    expect(readFileSync(edit, 'utf8')).toBe('uncommitted edit');
  });
});
