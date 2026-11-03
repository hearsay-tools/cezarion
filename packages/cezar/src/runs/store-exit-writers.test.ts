import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RunStatus } from '@open-mercato/cezar-contract';
import { makeRunRecord, makeStepState, RUN_STATUS, STEP_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';

import { applyExit, takeRunExitViolations } from './run-exits.ts';
import { reconcileLoadedRun, RunStore, settleOrphanedRun, upgradeLegacyWaits } from './store.ts';

/**
 * The store's own status writers apply a run exit to the record in hand (slice S4a of
 * .ai/specs/2026-11-03-run-store-owns-exits.md, Table C): each writes the same record it wrote
 * before, and none records a violation on a status it meets.
 */

const FINISHED_AT = '2026-11-01T10:00:00.000Z';
const steps = () => [
  makeStepState({ id: 'a', status: STEP_STATUS.done }),
  makeStepState({ id: 'b', status: STEP_STATUS.running }),
  makeStepState({ id: 'c', status: STEP_STATUS.waiting }),
  makeStepState({ id: 'd', status: STEP_STATUS.pending }),
];
const stepStatuses = (run: { steps: Array<{ status: string }> }) => run.steps.map((step) => step.status);

afterEach(() => { expect(takeRunExitViolations()).toEqual([]); });

describe('applyExit', () => {
  it('returns the extras and the exit status, and leaves the record alone', () => {
    const run = makeRunRecord({ status: RUN_STATUS.running });
    expect(applyExit(run, 'cancel', { finishedAt: FINISHED_AT })).toEqual({ finishedAt: FINISHED_AT, status: RUN_STATUS.cancelled });
    expect(run.status).toBe(RUN_STATUS.running);
  });

  it('records an exit that does not leave from the record\'s status', () => {
    expect(applyExit(makeRunRecord({ status: RUN_STATUS.queued }), 'accept-review')).toEqual({ status: RUN_STATUS.done });
    expect(takeRunExitViolations()).toEqual(['undeclared run transition: exit accept-review from queued (declare it in runs/run-exits.ts)']);
  });
});

describe('settleLoadedStop (live.stopping, settled.stopping)', () => {
  const statuses: RunStatus[] = ['queued', 'running', 'waiting', 'review', 'done', 'failed', 'cancelled'];
  it.each(statuses)('settles a stopping %s row cancelled, its live steps cancelled and the Stop cleared', (status) => {
    const run = reconcileLoadedRun(makeRunRecord({ status, stopping: true, steps: steps() }), { keepLive: true });
    expect(run).toMatchObject({ status: RUN_STATUS.cancelled, stopping: undefined, finishedAt: expect.any(String) });
    expect(stepStatuses(run)).toEqual(['done', 'cancelled', 'cancelled', 'pending']);
  });

  it('keeps a finishedAt the row already has', () => {
    const run = reconcileLoadedRun(makeRunRecord({ status: RUN_STATUS.done, stopping: true, finishedAt: FINISHED_AT }), { keepLive: true });
    expect(run).toMatchObject({ status: RUN_STATUS.cancelled, finishedAt: FINISHED_AT });
  });

  it('leaves a row without a Stop as it was', () => {
    const run = reconcileLoadedRun(makeRunRecord({ status: RUN_STATUS.done, finishedAt: FINISHED_AT, steps: steps() }), { keepLive: true });
    expect(run).toMatchObject({ status: RUN_STATUS.done, finishedAt: FINISHED_AT });
    expect(stepStatuses(run)).toEqual(['done', 'running', 'waiting', 'pending']);
  });
});

describe('restoreLoadedUsageLimitHold (failed.legacy-hold)', () => {
  it('reads a schema-7 failed row with an appointment as the waiting hold, its finishedAt cleared', () => {
    const autoResumeAt = '2026-11-04T10:00:00.000Z';
    const run = reconcileLoadedRun(makeRunRecord({ status: RUN_STATUS.failed, autoResumeAt, finishedAt: FINISHED_AT, error: 'usage limit' }), { keepLive: true });
    expect(run).toMatchObject({ status: RUN_STATUS.waiting, autoResumeAt, finishedAt: undefined, error: 'usage limit' });
    expect('finishedAt' in run).toBe(true);
  });
});

describe('failLoadedInterruptedRun (live.read-only)', () => {
  it.each(['queued', 'running', 'waiting'] as const)('fails a %s row a read-only store meets, with the fixed error and its live steps failed', (status) => {
    const run = reconcileLoadedRun(makeRunRecord({ status, steps: steps() }));
    expect(run).toMatchObject({ status: RUN_STATUS.failed, error: 'interrupted — cezar process exited during the run', finishedAt: expect.any(String) });
    expect(stepStatuses(run)).toEqual(['done', 'failed', 'failed', 'pending']);
  });

  it('keeps a finishedAt the row already has, and leaves a usage-limit hold alone', () => {
    expect(reconcileLoadedRun(makeRunRecord({ status: RUN_STATUS.running, finishedAt: FINISHED_AT }))).toMatchObject({ status: RUN_STATUS.failed, finishedAt: FINISHED_AT });
    const autoResumeAt = '2026-11-04T10:00:00.000Z';
    expect(reconcileLoadedRun(makeRunRecord({ status: RUN_STATUS.waiting, autoResumeAt }))).toMatchObject({ status: RUN_STATUS.waiting, autoResumeAt });
  });
});

describe('settleOrphanedRun (queued.orphaned)', () => {
  const untouched = () => makeRunRecord({ status: RUN_STATUS.queued, workflowDef: { name: 'quick-task', steps: [] } as never,
    steps: [makeStepState({ id: 'a', status: STEP_STATUS.pending })] });

  it('cancels an untouched queued run, its steps left pending', () => {
    const run = settleOrphanedRun(untouched());
    expect(run).toMatchObject({ status: RUN_STATUS.cancelled, finishedAt: expect.any(String) });
    expect(stepStatuses(run)).toEqual(['pending']);
  });

  it('keeps a finishedAt the row already has, and a Stop settles the same way', () => {
    expect(settleOrphanedRun({ ...untouched(), finishedAt: FINISHED_AT }, { stop: true })).toMatchObject({ status: RUN_STATUS.cancelled, finishedAt: FINISHED_AT, stopping: undefined });
  });

  it('fails a started queued run as interrupted instead', () => {
    expect(settleOrphanedRun({ ...untouched(), startedAt: FINISHED_AT })).toMatchObject({ status: RUN_STATUS.failed, error: 'interrupted — cezar process exited during the run' });
  });
});

describe('setLiveStatus in upgradeLegacyWaits (running.legacy, plain.legacy)', () => {
  it('parks a running monitoring row with its running step', () => {
    const row: Record<string, unknown> = { ...makeRunRecord({ status: RUN_STATUS.running, steps: steps() }), activity: 'monitoring' };
    upgradeLegacyWaits(row);
    expect(row.status).toBe(RUN_STATUS.waiting);
    expect(stepStatuses(row as { steps: Array<{ status: string }> })).toEqual(['done', 'waiting', 'waiting', 'pending']);
  });

  it('resumes a waiting row whose current wait\'s wake a provider took, with its waiting step', () => {
    // The `message` stand-in: a message woke the wait, and a provider took it before the resume.
    const wakeId = randomUUID();
    const row: Record<string, unknown> = {
      ...makeRunRecord({ status: RUN_STATUS.waiting, steps: steps() }),
      delegation: { role: 'root', wait: { id: wakeId, workerIds: [], deadline: '2026-11-04T10:00:00.000Z', phase: 'wake-pending', reason: 'message', outcomes: [] } },
      agentInputs: [{ id: wakeId, deliveredAt: FINISHED_AT }],
    };
    upgradeLegacyWaits(row);
    expect(row.status).toBe(RUN_STATUS.running);
    expect(stepStatuses(row as { steps: Array<{ status: string }> })).toEqual(['done', 'running', 'running', 'pending']);
  });
});

describe('withdrawHold on archive (hold.archive)', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
  const open = () => {
    const dir = mkdtempSync(join(tmpdir(), 'cez-store-exit-writers-'));
    const store = RunStore.open(dir, { keepLive: true });
    cleanups.push(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
    return store;
  };

  it('settles an archived usage-limit hold failed, its appointment and error kept as before', () => {
    const store = open();
    const id = store.createRun({ title: 'hold', task: 'hold', workflow: 'quick-task', steps: [] }).id;
    store.updateRun(id, { status: RUN_STATUS.failed, error: 'usage limit', finishedAt: FINISHED_AT });
    store.move(id, 'hold', { finishedAt: undefined, autoResumeAt: '2026-11-04T10:00:00.000Z', autoResumeAttempts: 1 });
    store.updateRun(id, { archived: true });
    expect(store.getRun(id)).toMatchObject({ status: RUN_STATUS.failed, error: 'usage limit', finishedAt: expect.any(String),
      autoResumeAt: undefined, autoResumeAttempts: undefined, archived: true });
  });

  it('keeps the finishedAt of an archived hold that has one', () => {
    const store = open();
    const id = store.createRun({ title: 'hold', task: 'hold', workflow: 'quick-task', steps: [] }).id;
    store.updateRun(id, { status: RUN_STATUS.failed });
    store.move(id, 'hold', { finishedAt: FINISHED_AT, autoResumeAt: '2026-11-04T10:00:00.000Z' });
    store.updateRun(id, { archived: true });
    expect(store.getRun(id)).toMatchObject({ status: RUN_STATUS.failed, finishedAt: FINISHED_AT, autoResumeAt: undefined });
  });
});
