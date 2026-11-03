import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RUN_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';

import { takeRunExitViolations } from './run-exits.ts';
import { readPersistedRuns } from './run-store.testkit.ts';
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
  return { store, created, committed };
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
