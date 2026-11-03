import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RUN_STATUS, STEP_KIND, STEP_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';

import { takeRunExitViolations } from './run-exits.ts';
import { blockRunWrites, readPersistedRuns } from './run-store.testkit.ts';
import { RunStore } from './store.ts';

/**
 * `RunStore.move` applies a run exit (ADR 0056, slice S2 of
 * .ai/specs/2026-11-03-run-store-owns-exits.md): it checks the exit against the status of the
 * record its write changes, then writes the exit's status and the extras in one `updateRun` write.
 */

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'cez-store-move-'));
  const store = RunStore.open(dir, { keepLive: true });
  cleanups.push(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const created = () => store.createRun({ title: 'move', task: 'move', workflow: 'quick-task', steps: [] }).id;
  const committed = (id: string) => readPersistedRuns(dir).find((row) => row.id === id);
  return { dir, store, created, committed };
}

describe('RunStore.move', () => {
  it('writes the exit status and the extras, and returns the record updateRun returns', () => {
    const { store, created } = setup();
    const id = created();
    const moved = store.move(id, 'start', { runner: 'claude', startedAt: '2026-11-03T10:00:00.000Z' });
    expect(moved).toBe(store.getRun(id));
    expect(moved).toMatchObject({ status: RUN_STATUS.running, runner: 'claude', startedAt: '2026-11-03T10:00:00.000Z' });
    expect(takeRunExitViolations()).toEqual([]);
  });

  it('writes an undeclared transition and records it against the stored status', () => {
    const { store, created } = setup();
    const id = created();
    expect(store.move(id, 'accept-review', { error: 'kept' })).toMatchObject({ status: RUN_STATUS.done, error: 'kept' });
    expect(takeRunExitViolations()).toEqual(['undeclared run transition: exit accept-review from queued (declare it in runs/run-exits.ts)']);
  });

  it('writes nothing and checks nothing for a run the store does not hold', () => {
    const { store } = setup();
    const id = randomUUID();
    expect(store.move(id, 'accept-review')).toBeUndefined();
    expect(store.getRun(id)).toBeUndefined();
    expect(takeRunExitViolations()).toEqual([]);
  });

  it('keeps updateRun\'s durable choice: an opted-in Done commits at once, a plain Finish waits for the save', () => {
    const { store, created, committed } = setup();
    const optedIn = created();
    store.updateRun(optedIn, { archiveWhenDone: true });
    store.move(optedIn, 'start');
    store.flush();
    store.move(optedIn, 'succeed');
    expect(committed(optedIn)?.status).toBe(RUN_STATUS.done);
    const plain = created();
    store.move(plain, 'start');
    store.flush();
    store.move(plain, 'succeed');
    expect(committed(plain)?.status).toBe(RUN_STATUS.running);
    store.flush();
    expect(committed(plain)?.status).toBe(RUN_STATUS.done);
  });

  it('applies the exit inside commitOutcome\'s one commit, checked against the stored status', () => {
    const { store, created } = setup();
    const id = created();
    expect(store.commitOutcome(id, [], { exit: 'resume' }).committed).toBe(true);
    expect(store.getRun(id)?.status).toBe(RUN_STATUS.running);
    expect(takeRunExitViolations()).toEqual(['undeclared run transition: exit resume from queued (declare it in runs/run-exits.ts)']);
  });

  it('refuses a status beside an exit, in every write that applies one', () => {
    const { store, created } = setup();
    const id = created();
    const refused = () => {
      // @ts-expect-error The exit writes the status; its extras cannot.
      store.move(id, 'start', { status: RUN_STATUS.done });
      // @ts-expect-error commitOutcome takes the status from `exit`, never from its patch.
      store.commitOutcome(id, [], { patch: { status: RUN_STATUS.done } });
      // @ts-expect-error commitWorkerContinuation takes the status from its exit argument.
      store.commitWorkerContinuation(id, 'continue-line', { status: RUN_STATUS.done });
    };
    expect(refused).toBeTypeOf('function');
  });
});

/**
 * Guarded exits (Decision 5, slice S3) replace the store commits that wrote a status themselves.
 * Each case pins what the removed commit did, in one commit at once: commitRootFinishSuccess,
 * commitRootFinishCancellation, commitWorkerCancellation, commitAutoResumeWithdrawal, commitParked.
 */
describe('RunStore.move with a guarded exit', () => {
  const EARLIER = '2026-11-01T10:00:00.000Z';
  const HOLD_AT = '2099-01-01T00:00:00.000Z';
  const ROOT = { role: 'root' as const, permissions: [], receipts: [] };

  function guarded() {
    const base = setup();
    const { store } = base;
    const withSteps = () => store.createRun({ title: 'move', task: 'move', workflow: 'quick-task', steps: [
      { id: 'a', name: 'a', kind: STEP_KIND.agent }, { id: 'b', name: 'b', kind: STEP_KIND.agent }, { id: 'c', name: 'c', kind: STEP_KIND.agent }] }).id;
    const finishing = (patch: Parameters<RunStore['updateRun']>[1] = {}) => {
      const id = withSteps();
      store.updateRun(id, { status: RUN_STATUS.waiting, delegation: ROOT, ...patch });
      store.commitRootFinishIntent(id);
      return id;
    };
    // `activity` is a legacy key (LEGACY_WAIT_KEYS) no patch type takes; an older row can carry it.
    const withActivity = (id: string) => { Object.assign(store.getRun(id)!, { activity: 'monitoring' }); };
    return { ...base, withSteps, finishing, withActivity };
  }

  it.each([['succeed-root', RUN_STATUS.done], ['succeed-root-review', RUN_STATUS.review]] as const)(
    '%s settles a root Finish in one commit: intent retired, fields cleared, live steps done', (exit, status) => {
      const { store, finishing, withActivity, committed } = guarded();
      const id = finishing({ currentStepId: 'b', autoResumeAttempts: 2, finishedAt: EARLIER });
      withActivity(id);
      store.updateStep(id, 'a', { status: STEP_STATUS.running, finishedAt: EARLIER });
      store.updateStep(id, 'b', { status: STEP_STATUS.waiting });
      store.updateStep(id, 'c', { status: STEP_STATUS.failed });
      expect(store.move(id, exit)).toBe(store.getRun(id));
      const row = committed(id);
      expect(row).toMatchObject({ status, delegation: ROOT });
      expect(row.finishedAt).not.toBe(EARLIER);
      for (const key of ['currentStepId', 'autoResumeAttempts', 'activity']) expect(row).not.toHaveProperty(key);
      expect(row.delegation).not.toHaveProperty('finishRequestedAt');
      expect(row.steps.map((step: { status: string; finishedAt?: string }) => [step.status, step.finishedAt])).toEqual([
        ['done', EARLIER], ['done', row.finishedAt], ['failed', undefined]]);
      expect(takeRunExitViolations()).toEqual([]);
    });

  it('a failed root Finish guard writes nothing: not waiting, not a root, or no intent', () => {
    const { store, created, finishing } = guarded();
    const cancelled = finishing();
    store.updateRun(cancelled, { status: RUN_STATUS.cancelled });
    const plain = created();
    store.updateRun(plain, { status: RUN_STATUS.waiting });
    const noIntent = created();
    store.updateRun(noIntent, { status: RUN_STATUS.waiting, delegation: ROOT });
    for (const id of [cancelled, plain, noIntent]) {
      const before = structuredClone(store.getRun(id));
      expect(store.move(id, 'succeed-root')).toBeUndefined();
      expect(store.getRun(id)).toEqual(before);
    }
    expect(store.move(randomUUID(), 'succeed-root')).toBeUndefined();
    expect(takeRunExitViolations()).toEqual([]);
  });

  it('cancel-root retires the intent and keeps an existing finishedAt, from waiting and from cancelled', () => {
    const { store, finishing, committed } = guarded();
    const waiting = finishing();
    expect(store.move(waiting, 'cancel-root')).toBeDefined();
    expect(committed(waiting)).toMatchObject({ status: RUN_STATUS.cancelled, finishedAt: expect.any(String) });
    expect(committed(waiting).delegation).not.toHaveProperty('finishRequestedAt');
    const repaired = finishing();
    store.updateRun(repaired, { status: RUN_STATUS.cancelled, finishedAt: EARLIER });
    expect(store.move(repaired, 'cancel-root')).toBeDefined();
    expect(committed(repaired)).toMatchObject({ status: RUN_STATUS.cancelled, finishedAt: EARLIER });
    expect(committed(repaired).delegation).not.toHaveProperty('finishRequestedAt');
    expect(store.move(repaired, 'cancel-root')).toBeUndefined();
    expect(takeRunExitViolations()).toEqual([]);
  });

  it('stop-worker throws for a run that is not a worker and writes nothing', () => {
    const { store, created } = guarded();
    const id = created();
    expect(() => store.move(id, 'stop-worker')).toThrow('Worker not found');
    expect(() => store.move(randomUUID(), 'stop-worker')).toThrow('Worker not found');
    expect(store.getRun(id)?.status).toBe(RUN_STATUS.queued);
  });

  it('withdraw-hold settles a usage-limit hold failed at once, and commitAutoResumeWithdrawal leaves any other run\'s status', () => {
    const { store, created, committed } = guarded();
    const held = created();
    store.updateRun(held, { status: RUN_STATUS.waiting, autoResumeAt: HOLD_AT, autoResumeAttempts: 2, finishedAt: EARLIER });
    store.flush();
    store.commitAutoResumeWithdrawal(held);
    expect(committed(held)).toMatchObject({ status: RUN_STATUS.failed });
    expect(committed(held).finishedAt).not.toBe(EARLIER);
    for (const key of ['autoResumeAt', 'autoResumeAttempts']) expect(committed(held)).not.toHaveProperty(key);
    const attemptsOnly = created();
    store.updateRun(attemptsOnly, { status: RUN_STATUS.waiting, autoResumeAttempts: 2 });
    store.flush();
    store.commitAutoResumeWithdrawal(attemptsOnly);
    expect(committed(attemptsOnly)).toMatchObject({ status: RUN_STATUS.waiting });
    expect(committed(attemptsOnly)).not.toHaveProperty('autoResumeAttempts');
    expect(store.move(attemptsOnly, 'withdraw-hold')).toBeUndefined();
    expect(takeRunExitViolations()).toEqual([]);
  });

  it('park-release commits waiting, clears activity and parks the named step; a refused write throws with nothing changed', () => {
    const { dir, store, withSteps, withActivity, committed } = guarded();
    const id = withSteps();
    store.updateRun(id, { status: RUN_STATUS.running });
    withActivity(id);
    store.updateStep(id, 'b', { status: STEP_STATUS.running });
    store.flush();
    const before = structuredClone(store.getRun(id));
    const release = blockRunWrites(dir);
    try { expect(() => store.move(id, 'park-release', {}, 'b')).toThrow(); } finally { release(); }
    expect(store.getRun(id)).toEqual(before);
    store.move(id, 'park-release', {}, 'b');
    expect(committed(id)).toMatchObject({ status: RUN_STATUS.waiting });
    expect(committed(id)).not.toHaveProperty('activity');
    expect(committed(id).steps.map((step: { status: string }) => step.status)).toEqual(['pending', 'waiting', 'pending']);
    expect(takeRunExitViolations()).toEqual([]);
  });
});
