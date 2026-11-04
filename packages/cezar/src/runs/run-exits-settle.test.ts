import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RunStatus } from '@open-mercato/cezar-contract';
import { RUN_STATUS, STEP_KIND, STEP_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';

import { RUN_EXITS, takeRunExitViolations, type RunExitId } from './run-exits.ts';
import { readPersistedRuns } from './run-store.testkit.ts';
import { RunStore } from './store.ts';

/**
 * Slice S7 of .ai/specs/2026-11-03-run-store-owns-exits.md: the rows of Table B, normalized. Each
 * case moves a run through `RunStore.move` and reads what the exit wrote, so a site cannot make
 * it pass by writing the field itself.
 */

const EARLIER = '2026-11-01T10:00:00.000Z';
const ROOT = { role: 'root' as const, permissions: [], receipts: [] };
const SETTLED: readonly RunStatus[] = [RUN_STATUS.done, RUN_STATUS.review, RUN_STATUS.failed, RUN_STATUS.cancelled];
/** Every exit that settles a run: it writes done, review, failed or cancelled. */
const SETTLING = (Object.keys(RUN_EXITS) as RunExitId[]).filter(exit => SETTLED.includes(RUN_EXITS[exit].to));

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  expect(takeRunExitViolations()).toEqual([]);
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'cez-exit-settle-'));
  const store = RunStore.open(dir, { keepLive: true });
  cleanups.push(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const committed = (id: string) => readPersistedRuns(dir).find((row) => row.id === id);
  const steps = [{ id: 'a', name: 'a', kind: STEP_KIND.agent }, { id: 'b', name: 'b', kind: STEP_KIND.agent }, { id: 'c', name: 'c', kind: STEP_KIND.agent }];
  /** A root with a pending Finish intent on step b, at the first status `exit` leaves from (a
   *  usage-limit hold for `withdraw-hold`). */
  const root = (exit: RunExitId, patch: Parameters<RunStore['updateRun']>[1] = {}) => {
    const { id } = store.createRun({ title: 'settle', task: 'settle', workflow: 'quick-task', steps });
    store.updateRun(id, { status: RUN_STATUS.waiting, delegation: ROOT });
    store.commitRootFinishIntent(id);
    const from = exit === 'withdraw-hold' ? RUN_STATUS.waiting : RUN_EXITS[exit].from[0]!;
    store.updateRun(id, { status: from, currentStepId: 'b', ...(exit === 'withdraw-hold' ? { autoResumeAt: '2099-01-01T00:00:00.000Z' } : {}), ...patch });
    return id;
  };
  /** An owned worker on step b, at the first status `exit` leaves from. */
  const worker = (exit: RunExitId, patch: Parameters<RunStore['updateRun']>[1] = {}) => {
    const parentId = store.createRun({ title: 'parent', task: 'parent', workflow: 'quick-task', steps: [] }).id;
    store.updateRun(parentId, { status: RUN_STATUS.waiting, delegation: { role: 'root', permissions: ['spawn'], receipts: [] } });
    const workerId = randomUUID();
    const { id } = store.createOwnedRun({ title: 'worker', task: 'worker', workflow: 'quick-task', runner: 'claude', steps }, parentId, randomUUID(), {
      role: 'worker', permissions: [], parentRunId: parentId,
      workspace: { ownerRunId: workerId, resourceId: randomUUID(), kind: 'owned-isolated', path: join(dir, 'absent-worktree'), branch: `cez/${workerId.slice(0, 8)}`, baselineSha: 'a'.repeat(40) },
    }, 'a'.repeat(64));
    store.updateRun(id, { status: RUN_EXITS[exit].from[0]!, currentStepId: 'b', ...patch });
    return id;
  };
  /** Move `id` by `exit`, then read the record the save wrote. */
  const settle = (id: string, exit: RunExitId) => {
    store.move(id, exit);
    store.flush();
    return committed(id);
  };
  return { dir, store, committed, root, worker, settle };
}

// B1, B2, B3: a settled run points at no step, and a Finish intent means nothing once it settled.
describe('B1-B3: every settling exit clears currentStepId and retires the root\'s Finish intent', () => {
  it('names the settling exits', () => {
    expect([...SETTLING].sort()).toEqual(['accept-review', 'cancel', 'cancel-late', 'cancel-root', 'draft-pr', 'fail', 'fail-continue', 'fail-crash',
      'fail-interrupted', 'fail-start', 'stop-worker', 'succeed', 'succeed-review', 'succeed-root', 'succeed-root-review', 'withdraw-hold']);
  });

  it.each(SETTLING.filter(exit => exit !== 'stop-worker'))('%s on a root with a pending Finish', (exit) => {
    const { root, settle } = setup();
    const row = settle(root(exit), exit);
    expect(row.status).toBe(RUN_EXITS[exit].to);
    expect(row).not.toHaveProperty('currentStepId');
    expect(row.delegation).toEqual(ROOT);
  });

  it('stop-worker on a worker', () => {
    const { worker, settle } = setup();
    const row = settle(worker('stop-worker'), 'stop-worker');
    expect(row.status).toBe(RUN_STATUS.cancelled);
    expect(row).not.toHaveProperty('currentStepId');
  });

  it('a site\'s extras cannot keep the step or the intent the exit retires', () => {
    const { store, root, committed } = setup();
    const id = root('cancel');
    store.move(id, 'cancel', { currentStepId: 'b' });
    store.flush();
    expect(committed(id)).not.toHaveProperty('currentStepId');
  });

  it('leaves the family reconciler\'s cancel-root repair nothing to repair', () => {
    const { store, root } = setup();
    const id = root('cancel');
    store.move(id, 'cancel');
    expect(store.move(id, 'cancel-root')).toBeUndefined();
  });
});

// B6: as B3 and B4, for the two exits a human takes on a run at review or settled.
describe('B6: accept-review and draft-pr set finishedAt ??= now and retire the Finish intent', () => {
  it.each(['accept-review', 'draft-pr'] as const)('%s sets finishedAt on a run without one and retires the intent', (exit) => {
    const { root, settle } = setup();
    const row = settle(root(exit), exit);
    expect(row.finishedAt).toEqual(expect.any(String));
    expect(row.delegation).toEqual(ROOT);
  });

  it.each(['accept-review', 'draft-pr'] as const)('%s keeps the finishedAt the run already has', (exit) => {
    const { root, settle } = setup();
    expect(settle(root(exit, { finishedAt: EARLIER }), exit).finishedAt).toBe(EARLIER);
  });
});

// B4: the first settlement time is the fact; a later writer on a settled run only repairs.
describe('B4: a settling exit keeps an existing finishedAt; continue-* and hold clear it', () => {
  const B4 = SETTLING.filter(exit => exit !== 'accept-review' && exit !== 'draft-pr');
  it.each(B4)('%s keeps the finishedAt the run already has, over the site\'s own time', (exit) => {
    const { store, root, worker, committed } = setup();
    const id = exit === 'stop-worker' ? worker(exit, { finishedAt: EARLIER }) : root(exit, { finishedAt: EARLIER });
    store.move(id, exit, RUN_EXITS[exit].durability === 'committed' ? {} : { finishedAt: new Date().toISOString() });
    store.flush();
    expect(committed(id)).toMatchObject({ status: RUN_EXITS[exit].to, finishedAt: EARLIER });
  });

  it.each(B4)('%s sets finishedAt on a run without one', (exit) => {
    const { root, worker, settle } = setup();
    const id = exit === 'stop-worker' ? worker(exit) : root(exit);
    expect(settle(id, exit).finishedAt).toEqual(expect.any(String));
  });

  it.each(['continue-line', 'continue-now', 'hold'] as const)('%s clears it', (exit) => {
    const { store, committed } = setup();
    const { id } = store.createRun({ title: 'settle', task: 'settle', workflow: 'quick-task', steps: [] });
    store.updateRun(id, { status: RUN_STATUS.failed, finishedAt: EARLIER });
    store.move(id, exit);
    store.flush();
    expect(committed(id)).not.toHaveProperty('finishedAt');
  });
});

// B5: one exit, one result. Both success paths settle the run and its live steps in one write.
describe('B5: both success paths clear activity and settle running or waiting steps in the same write', () => {
  const statuses = (run: { steps: Array<{ status: string }> }) => run.steps.map(step => step.status);

  it.each(['succeed', 'succeed-review', 'succeed-root', 'succeed-root-review'] as const)('%s', (exit) => {
    const { store, root } = setup();
    const id = root(exit);
    Object.assign(store.getRun(id)!, { activity: 'monitoring' });
    store.updateStep(id, 'a', { status: STEP_STATUS.running, finishedAt: EARLIER });
    store.updateStep(id, 'b', { status: STEP_STATUS.waiting });
    store.updateStep(id, 'c', { status: STEP_STATUS.failed });
    const moved = store.move(id, exit)!;
    expect(statuses(moved)).toEqual([STEP_STATUS.done, STEP_STATUS.done, STEP_STATUS.failed]);
    expect(moved.steps.map(step => step.finishedAt)).toEqual([EARLIER, moved.finishedAt, undefined]);
    expect(moved).not.toHaveProperty('activity', expect.anything());
  });

  it('keeps the step a worker re-enters waiting (hearsay-tools/cezarion#1620)', () => {
    const { store, worker } = setup();
    const id = worker('succeed');
    store.updateStep(id, 'a', { status: STEP_STATUS.waiting });
    store.updateStep(id, 'b', { status: STEP_STATUS.running });
    const moved = store.move(id, 'succeed', {}, { stepId: 'a' })!;
    expect(statuses(moved)).toEqual([STEP_STATUS.waiting, STEP_STATUS.done, STEP_STATUS.pending]);
  });
});

// B8: as B5. A park settles the step it parks in the same write, not by a side call after it.
describe('B8: park settles the current step to waiting in the same write', () => {
  const statuses = (run: { steps: Array<{ status: string }> }) => run.steps.map(step => step.status);

  it.each(['park', 'park-release'] as const)('%s parks the run\'s current step', (exit) => {
    const { store, root } = setup();
    const id = root('park', { status: RUN_STATUS.running });
    store.updateStep(id, 'a', { status: STEP_STATUS.done });
    store.updateStep(id, 'b', { status: STEP_STATUS.running });
    expect(statuses(store.move(id, exit)!)).toEqual([STEP_STATUS.done, STEP_STATUS.waiting, STEP_STATUS.pending]);
  });

  it('parks the step the caller names', () => {
    const { store, root } = setup();
    const id = root('park', { status: RUN_STATUS.running });
    store.updateStep(id, 'c', { status: STEP_STATUS.running });
    expect(statuses(store.move(id, 'park', {}, { stepId: 'c' })!)).toEqual([STEP_STATUS.pending, STEP_STATUS.pending, STEP_STATUS.waiting]);
  });

  it('leaves a current step that already ended', () => {
    const { store, root } = setup();
    const id = root('park', { status: RUN_STATUS.running });
    store.updateStep(id, 'b', { status: STEP_STATUS.failed });
    expect(statuses(store.move(id, 'park')!)).toEqual([STEP_STATUS.pending, STEP_STATUS.failed, STEP_STATUS.pending]);
  });
});

// B10: a cancelled run has no live step (hearsay-tools/cezarion#2590 reuses this rule at load).
describe('B10: every exit to cancelled settles running and waiting steps to cancelled, finishedAt ??= its time', () => {
  const CANCELLING = SETTLING.filter(exit => RUN_EXITS[exit].to === RUN_STATUS.cancelled);

  it.each(CANCELLING)('%s', (exit) => {
    const { store, root, worker } = setup();
    const id = exit === 'stop-worker' ? worker(exit) : root(exit);
    store.updateStep(id, 'a', { status: STEP_STATUS.running, finishedAt: EARLIER });
    store.updateStep(id, 'b', { status: STEP_STATUS.waiting });
    store.move(id, exit);
    const run = store.getRun(id)!;
    expect(run.steps.map(step => [step.status, step.finishedAt])).toEqual([
      [STEP_STATUS.cancelled, EARLIER], [STEP_STATUS.cancelled, run.finishedAt], [STEP_STATUS.pending, undefined]]);
  });

  it('the store\'s load-time Stop settles them too, at the run\'s first finish time', () => {
    const { dir, store, root } = setup();
    const stopped = root('cancel', { status: RUN_STATUS.running, stopping: true, finishedAt: EARLIER });
    store.updateStep(stopped, 'b', { status: STEP_STATUS.running });
    store.flush();
    store.close();
    const reopened = RunStore.open(dir, { keepLive: true });
    try {
      expect(reopened.getRun(stopped)?.steps.map(step => [step.status, step.finishedAt])).toEqual([
        [STEP_STATUS.pending, undefined], [STEP_STATUS.cancelled, EARLIER], [STEP_STATUS.pending, undefined]]);
    } finally { reopened.close(); }
  });
});

// B11: a failed run has no live step. A waiting step is the cursor a Continue resumes, a root's
// (settleIncompleteStep) and an owned worker's (hearsay-tools/cezarion#1620) alike, so it stays.
describe('B11: every exit to failed settles running steps to failed and keeps a waiting step', () => {
  const FAILING = SETTLING.filter(exit => RUN_EXITS[exit].to === RUN_STATUS.failed);
  const steps = (run: { steps: Array<{ status: string; finishedAt?: string | undefined; error?: string | undefined }> }) =>
    run.steps.map(step => [step.status, step.finishedAt, step.error]);

  it.each(FAILING)('%s on a root', (exit) => {
    const { store, root } = setup();
    const id = root(exit, { error: 'kept' });
    store.updateStep(id, 'a', { status: STEP_STATUS.running, finishedAt: EARLIER, error: 'own' });
    store.updateStep(id, 'b', { status: STEP_STATUS.running });
    store.updateStep(id, 'c', { status: STEP_STATUS.waiting });
    store.move(id, exit);
    const run = store.getRun(id)!;
    expect(steps(run)).toEqual([[STEP_STATUS.failed, EARLIER, 'own'], [STEP_STATUS.failed, run.finishedAt, run.error], [STEP_STATUS.waiting, undefined, undefined]]);
  });

  it.each(FAILING.filter(exit => exit !== 'withdraw-hold'))('%s on a worker', (exit) => {
    const { store, worker } = setup();
    const id = worker(exit, { error: 'kept' });
    store.updateStep(id, 'a', { status: STEP_STATUS.waiting });
    store.updateStep(id, 'b', { status: STEP_STATUS.running });
    store.move(id, exit);
    const run = store.getRun(id)!;
    expect(steps(run)).toEqual([[STEP_STATUS.waiting, undefined, undefined], [STEP_STATUS.failed, run.finishedAt, run.error], [STEP_STATUS.pending, undefined, undefined]]);
  });

  it('the store\'s load-time interrupted run settles them too', () => {
    const { dir, store, root } = setup();
    const id = root('fail-interrupted', { status: RUN_STATUS.running });
    store.updateStep(id, 'a', { status: STEP_STATUS.waiting });
    store.updateStep(id, 'b', { status: STEP_STATUS.running });
    store.flush();
    store.close();
    const reopened = RunStore.open(dir);
    try {
      const run = reopened.getRun(id)!;
      expect(steps(run).slice(0, 2)).toEqual([[STEP_STATUS.waiting, undefined, undefined],
        [STEP_STATUS.failed, run.finishedAt, 'interrupted — cezar process exited during the run']]);
    } finally { reopened.close(); }
  });
});

// B12: the web header (hearsay-tools/cezarion#2589) and the timeline read one event for one
// cancellation.
describe('B12: the cancel exits write the run cancelled event once, at every site', () => {
  const CANCELLING = SETTLING.filter(exit => RUN_EXITS[exit].to === RUN_STATUS.cancelled);
  const cancelled = (store: RunStore, id: string) => store.readEvents(id)
    .filter(event => event.type === 'lifecycle' && /cancelled/.test(String(event.message))).map(event => event.message);

  it.each(CANCELLING)('%s writes it when it cancels the run, and not again on a cancelled run', (exit) => {
    const { store, root, worker } = setup();
    const id = exit === 'stop-worker' ? worker(exit) : root(exit);
    store.move(id, exit);
    expect(cancelled(store, id)).toEqual(['run cancelled']);
    store.move(id, 'cancel');
    expect(cancelled(store, id)).toEqual(['run cancelled']);
  });

  it('a caller may name the event, as a queued cancellation does', () => {
    const { store, root } = setup();
    const id = root('cancel');
    store.move(id, 'cancel', {}, { event: 'cancelled while queued' });
    expect(cancelled(store, id)).toEqual(['cancelled while queued']);
  });

  it('the store\'s load-time Stop writes it once', () => {
    const { dir, store, root } = setup();
    const id = root('cancel', { status: RUN_STATUS.running, stopping: true });
    store.flush();
    store.close();
    const reopened = RunStore.open(dir, { keepLive: true });
    try {
      expect(cancelled(reopened, id)).toEqual(['run cancelled']);
    } finally { reopened.close(); }
    const again = RunStore.open(dir, { keepLive: true });
    try {
      expect(cancelled(again, id)).toEqual(['run cancelled']);
    } finally { again.close(); }
  });
});
