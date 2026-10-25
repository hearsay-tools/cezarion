import { describe, expect, it } from 'vitest';
import { deriveAttention } from './attention.ts';
import { engineOwnsRun, isSessionOpen, isSweepable } from './run-predicates.ts';
import type { ArchiveFinishedScope, RunStatus } from './runs.ts';
import { computeWaitingOn, isUsageLimitHold } from './waits.ts';

/**
 * The run predicates replaced copies in the store, the server and the cockpit
 * (hearsay-tools/cezarion#1496). Each table below keeps the deleted copy as its oracle, word for
 * word, and asserts the contract predicate gives the same answer at every status, with a resume
 * time set and unset.
 */

const ALL_STATUSES: readonly RunStatus[] = ['queued', 'running', 'waiting', 'review', 'done', 'failed', 'cancelled'];
const AT = '2026-10-25T23:00:00.000Z';
const records = ALL_STATUSES.flatMap((status) => [{ status }, { status, autoResumeAt: AT }]);
const name = (run: { status: RunStatus; autoResumeAt?: string }) => `${run.status}${run.autoResumeAt ? ' with a resume time' : ''}`;

/** The deleted copies, as they were on `main` at e10fcebb0. */
const old = {
  // packages/web/src/routes/task-thread/run-actions.ts `isRunActive`
  isRunActive(run: { status: RunStatus; autoResumeAt?: string | undefined }): boolean {
    if (run.status === 'waiting' && run.autoResumeAt !== undefined) return false;
    return run.status === 'running' || run.status === 'queued' || run.status === 'waiting';
  },
  // packages/web/src/routes/task-thread/run-actions.ts `isSessionOpen`
  isSessionOpen(run: { status: RunStatus; autoResumeAt?: string | undefined }): boolean {
    return (run.status === 'running' || run.status === 'waiting') && old.isRunActive(run);
  },
  // packages/cezar/src/server/server.ts, the CLI-target route's `engineOwnsSession`
  engineOwnsSession(run: { status: RunStatus; autoResumeAt?: string | undefined }): boolean {
    const usageLimitHold = run.status === 'waiting' && run.autoResumeAt !== undefined;
    return !usageLimitHold && (run.status === 'running' || run.status === 'queued' || run.status === 'waiting');
  },
  // packages/cezar/src/runs/store.ts `reconcileLoadedRun`, the restart check without `keepLive`
  interruptedOnRestart(run: { status: RunStatus; autoResumeAt?: string | undefined }): boolean {
    return (run.status === 'running' || run.status === 'queued' || run.status === 'waiting') &&
      !(run.status === 'waiting' && run.autoResumeAt !== undefined);
  },
  // packages/web/src/routes/task-thread/run-actions.ts `holdsWaitResults`, its hold clause
  // packages/web/src/lib/read-state.ts `isScheduledResume`, packages/cezar/src/workflows/run.ts `onUsageLimitHold`
  isUsageLimitHold(run: { status?: RunStatus | undefined; autoResumeAt?: string | undefined }): boolean {
    return run.status === 'waiting' && run.autoResumeAt !== undefined;
  },
};

describe('isUsageLimitHold', () => {
  it.each(records.map((run) => [name(run), run] as const))('agrees with the deleted copies for %s', (_name, run) => {
    expect(isUsageLimitHold(run)).toBe(old.isUsageLimitHold(run));
  });

  it('is a waiting run with a resume time and nothing else', () => {
    expect(records.filter((run) => isUsageLimitHold(run)).map(name)).toEqual(['waiting with a resume time']);
    expect(isUsageLimitHold({})).toBe(false);
    expect(isUsageLimitHold({ autoResumeAt: AT })).toBe(false);
  });

  // Rung 6 and `computeWaitingOn`'s usage-limit wait read the same fact (spec 2026-10-17-unified-waits).
  it.each(records.map((run) => [name(run), run] as const))('names the rung and the wait exactly when it holds, for %s', (_name, run) => {
    const held = isUsageLimitHold(run);
    expect(computeWaitingOn(run)?.kind === 'usage-limit').toBe(held);
    expect(deriveAttention(run).rung === 'usage-limit').toBe(held);
  });
});

describe('engineOwnsRun and isSessionOpen', () => {
  it.each(records.map((run) => [name(run), run] as const))('agree with the deleted copies for %s', (_name, run) => {
    expect(engineOwnsRun(run)).toBe(old.isRunActive(run));
    expect(engineOwnsRun(run)).toBe(old.engineOwnsSession(run));
    expect(engineOwnsRun(run)).toBe(old.interruptedOnRestart(run));
    expect(isSessionOpen(run)).toBe(old.isSessionOpen(run));
  });

  it('own queued, running and waiting runs, never a hold, and open a session only once out of the line', () => {
    expect(records.filter(engineOwnsRun).map(name)).toEqual(['queued', 'queued with a resume time', 'running', 'running with a resume time', 'waiting']);
    expect(records.filter(isSessionOpen).map(name)).toEqual(['running', 'running with a resume time', 'waiting']);
  });
});

describe('isSweepable', () => {
  type Input = Parameters<typeof isSweepable>[0];
  /** packages/cezar/src/runs/store.ts `isSweepable`, the copy the server swept with. */
  const storeCopy = (run: Input, scope?: ArchiveFinishedScope, automation?: boolean): boolean => {
    if (run.archived || !['done', 'failed', 'cancelled'].includes(run.status)) return false;
    if (run.delegation?.role === 'worker') return false;
    if (automation !== undefined && (run.automationId !== undefined) !== automation) return false;
    if (scope === 'unpinned') return !run.pinned;
    if (scope === 'pinned') return run.pinned === true;
    return true;
  };
  /** packages/web/src/lib/tasks-table.ts `isSweepable`, the cockpit copy, which took no `automation`. */
  const cockpitCopy = (run: Input, scope?: ArchiveFinishedScope): boolean => {
    const finished = run.status === 'done' || run.status === 'failed' || run.status === 'cancelled';
    if (run.archived || !finished) return false;
    if (run.status === 'waiting' && (run as { autoResumeAt?: string }).autoResumeAt !== undefined) return false;
    if (run.delegation?.role === 'worker') return false;
    if (scope === 'unpinned') return !run.pinned;
    if (scope === 'pinned') return run.pinned === true;
    return true;
  };
  const inputs: Input[] = records.flatMap((run) => [false, true].flatMap((archived) => [undefined, true, false].flatMap((pinned) =>
    [undefined, { role: 'root' }, { role: 'worker' }].flatMap((delegation) => [undefined, 'automation-1'].map((automationId) => ({
      ...run, archived,
      ...(pinned === undefined ? {} : { pinned }),
      ...(delegation === undefined ? {} : { delegation }),
      ...(automationId === undefined ? {} : { automationId }),
    }))))));
  const scopes = [undefined, 'unpinned', 'pinned'] as const;

  it('agrees with the store copy for every input, scope and tab', () => {
    for (const run of inputs) for (const scope of scopes) for (const automation of [undefined, true, false]) {
      expect(isSweepable(run, scope, automation), JSON.stringify({ run, scope, automation })).toBe(storeCopy(run, scope, automation));
    }
  });

  it('agrees with the cockpit copy, which passed no tab', () => {
    for (const run of inputs) for (const scope of scopes) {
      expect(isSweepable(run, scope), JSON.stringify({ run, scope })).toBe(cockpitCopy(run, scope));
    }
  });
});
