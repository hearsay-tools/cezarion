import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RunStatus } from '@open-mercato/cezar-contract';
import { RUN_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { exitStatus, strictRunExits, takeRunExitViolations, throwRunExitViolations, transitionVia } from './run-exits.ts';
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

  it('runs a store commit and checks it against its exit after it ran', () => {
    previous = strictRunExits(true);
    let status: RunStatus = RUN_STATUS.running;
    const read = () => { return { status }; };
    expect(transitionVia('cancel', read, () => { status = RUN_STATUS.waiting; return 'drifted'; })).toBe('drifted');
    expect(status).toBe(RUN_STATUS.waiting);
    status = RUN_STATUS.done;
    expect(transitionVia('cancel', read, () => { status = RUN_STATUS.cancelled; return 'undeclared'; })).toBe('undeclared');
    expect(status).toBe(RUN_STATUS.cancelled);
    expect(takeRunExitViolations()).toEqual([
      'store commit drifted from its exit: exit cancel wrote waiting, not cancelled',
      'undeclared run transition: exit cancel from done (declare it in runs/run-exits.ts)',
    ]);
    status = RUN_STATUS.waiting;
    expect(transitionVia('park', read, () => 'refused')).toBe('refused');
    expect(transitionVia('withdraw-hold', read, () => { status = RUN_STATUS.failed; return true; })).toBe(true);
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
    let status: RunStatus = RUN_STATUS.done;
    let commits = 0;
    expect(transitionVia('cancel', () => { return { status }; }, () => { status = RUN_STATUS.cancelled; return ++commits; })).toBe(1);
    expect(warn).toHaveBeenCalledTimes(2);
    for (let i = 0; i < 1000; i++) exitStatus('accept-review', RUN_STATUS.running);
    expect(warn).toHaveBeenCalledTimes(1002);
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
