import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RunStatus } from '@open-mercato/cezar-contract';
import { RUN_STATUS, STEP_KIND } from '@open-mercato/cezar-contract/test-factories.testkit';

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
