import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RunStatus } from '@open-mercato/cezar-contract';
import { RUN_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { exitDurability, exitStatus, RUN_EXITS, strictRunExits, takeRunExitViolations, throwRunExitViolations, type RunExitId } from './run-exits.ts';
import { runThenCleanUp } from './run-exits.testkit.ts';

describe('run exits: an undeclared transition is written, then reported (ADR 0056)', () => {
  let previous: boolean;
  afterEach(() => {
    strictRunExits(previous);
    takeRunExitViolations();
    vi.restoreAllMocks();
  });
  it('writes an undeclared transition in strict mode and reports it after the write', () => {
    previous = strictRunExits(true);
    const run = { status: RUN_STATUS.running as RunStatus };
    run.status = exitStatus('accept-review', run.status);
    expect(run.status).toBe(RUN_STATUS.done);
    expect(() => throwRunExitViolations()).toThrow('undeclared run transition: exit accept-review from running (declare it in runs/run-exits.ts)');
    expect(() => throwRunExitViolations()).not.toThrow();
  });

  it('accepts a declared exit and a repeated write', () => {
    previous = strictRunExits(true);
    expect(exitStatus('cancel', RUN_STATUS.running)).toBe(RUN_STATUS.cancelled);
    expect(exitStatus('cancel', RUN_STATUS.cancelled)).toBe(RUN_STATUS.cancelled);
    expect(takeRunExitViolations()).toEqual([]);
  });

  it('throws every recorded violation once, for the test setup', () => {
    previous = strictRunExits(true);
    expect(() => throwRunExitViolations()).not.toThrow();
    expect(exitStatus('accept-review', RUN_STATUS.running)).toBe(RUN_STATUS.done);
    expect(exitStatus('accept-review', RUN_STATUS.queued)).toBe(RUN_STATUS.done);
    expect(() => throwRunExitViolations()).toThrow('exit accept-review from running (declare it in runs/run-exits.ts)\nundeclared run transition: exit accept-review from queued');
    expect(() => throwRunExitViolations()).not.toThrow();
  });

  it('outside strict mode, warns once per violation and records nothing', () => {
    previous = strictRunExits(false);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(exitStatus('accept-review', RUN_STATUS.running)).toBe(RUN_STATUS.done);
    expect(warn.mock.calls).toEqual([['undeclared run transition: exit accept-review from running (declare it in runs/run-exits.ts)']]);
    for (let i = 0; i < 1000; i++) exitStatus('accept-review', RUN_STATUS.running);
    expect(warn).toHaveBeenCalledTimes(1001);
    expect(takeRunExitViolations()).toEqual([]);
  });

  it('outside strict mode, a declared exit warns nothing', () => {
    previous = strictRunExits(false);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(exitStatus('cancel', RUN_STATUS.running)).toBe(RUN_STATUS.cancelled);
    expect(warn).not.toHaveBeenCalled();
  });

  it('fails a passing body on a violation its cleanup recorded', async () => {
    previous = strictRunExits(true);
    await expect(runThenCleanUp(async () => {}, async () => { exitStatus('accept-review', RUN_STATUS.running); }))
      .rejects.toThrow('undeclared run transition: exit accept-review from running');
    expect(takeRunExitViolations()).toEqual([]);
  });

  it('keeps a failed body\'s own error and drops its violations', async () => {
    previous = strictRunExits(true);
    await expect(runThenCleanUp(async () => {
      exitStatus('accept-review', RUN_STATUS.running);
      throw new Error('the model failed');
    }, async () => {})).rejects.toThrow('the model failed');
    expect(takeRunExitViolations()).toEqual([]);
  });

  it('reports a cleanup error with the cleanup violations after a passing body, and drains them', async () => {
    previous = strictRunExits(true);
    await expect(runThenCleanUp(async () => {}, async () => {
      exitStatus('accept-review', RUN_STATUS.running);
      throw new Error('still active');
    })).rejects.toThrow('cleanup failed: still active\nundeclared run transition: exit accept-review from running');
    expect(takeRunExitViolations()).toEqual([]);
  });

  it('keeps a failed body\'s error over a cleanup error, and drains the violations', async () => {
    previous = strictRunExits(true);
    await expect(runThenCleanUp(async () => {
      exitStatus('accept-review', RUN_STATUS.running);
      throw new Error('the model failed');
    }, async () => {
      exitStatus('accept-review', RUN_STATUS.queued);
      throw new Error('still active');
    })).rejects.toThrow('the model failed');
    expect(takeRunExitViolations()).toEqual([]);
  });
});

// Decision 4: durability belongs to the exit. Today's call-site choices are their own exits, and
// a plain Finish stays debounced so a locked database cannot stop cleanup.
describe('run exits: each exit declares how its write persists', () => {
  const COMMITTED = ['park-release', 'succeed-root', 'succeed-root-review', 'withdraw-hold', 'cancel-root', 'stop-worker'];

  it('commits only the exits the call sites committed; every other exit is debounced', () => {
    const declared = Object.fromEntries(Object.entries(RUN_EXITS).map(([id, spec]) => [id, spec.durability]));
    expect(declared).toEqual(Object.fromEntries(Object.keys(RUN_EXITS).map(id => [id, COMMITTED.includes(id) ? 'committed' : 'debounced'])));
  });

  it('commits every guarded exit, which writes in its own commit', () => {
    const guarded = Object.entries(RUN_EXITS).filter(([, spec]) => 'settle' in spec).map(([id]) => id);
    expect(guarded.sort()).toEqual([...COMMITTED].sort());
  });

  it('raises an exit to done to committed on a run with a completion option, and lowers nothing', () => {
    const exits = Object.keys(RUN_EXITS) as RunExitId[];
    for (const option of [{}, { archiveWhenDone: true }, { autoMergePr: true }, { archiveWhenDone: false, autoMergePr: false }]) {
      const optedIn = Boolean(Object.values(option).some(Boolean));
      for (const exit of exits) {
        const expected = RUN_EXITS[exit].durability === 'committed' || (optedIn && RUN_EXITS[exit].to === RUN_STATUS.done) ? 'committed' : 'debounced';
        expect(exitDurability(exit, option), `${exit} with ${JSON.stringify(option)}`).toBe(expected);
      }
    }
    expect(exitDurability('succeed-review', { archiveWhenDone: true })).toBe('debounced');
    expect(exitDurability('accept-review', { autoMergePr: true })).toBe('committed');
  });
});
