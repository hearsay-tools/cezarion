import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunRecord, RunStatus } from '@open-mercato/cezar-contract';
import { applyExit, RUN_EXITS, type ExitRead, type RunExitId, type RunPatch } from './run-exits.ts';

/**
 * Slice S5 of .ai/specs/2026-11-03-run-store-owns-exits.md: each exit settles the fields all its
 * sites wrote alike, and each site passes only the rest. Every row is one call site: the patch it
 * wrote before the slice, and the extras it passes now. The fields `applyExit` writes from the new
 * extras must be the fields the old patch wrote, key for key, explicit `undefined` included.
 */

const NOW = '2026-11-03T12:00:00.000Z';
/** A time the site shares with another write (its steps' `finishedAt`), so it still passes it. */
const SHARED = '2026-11-03T11:59:59.000Z';
const INTENT = '2026-11-03T11:00:00.000Z';
const u = undefined;

/** `RunManager.move` before S5: it added the root's Finish retirement to every exit to failed. */
function oldManagerPatch(run: ExitRead, exit: RunExitId, patch: RunPatch): RunPatch {
  if (RUN_EXITS[exit].to !== 'failed') return patch;
  const root = run.delegation;
  if (root?.role !== 'root' || !root.finishRequestedAt) return patch;
  const { finishRequestedAt: _intent, ...delegation } = root;
  return { ...patch, delegation };
}

type Site = {
  site: string;
  exit: RunExitId;
  from: RunStatus;
  /** The site's patch before S5. */
  before: (run: ExitRead) => RunPatch;
  /** The site's extras now. */
  after: (run: ExitRead) => RunPatch;
  /** Whether the site wrote through `RunManager.move` (true) or straight to the store. */
  manager: boolean;
};

const retired = (run: ExitRead): RunPatch => oldManagerPatch(run, 'fail', {});
const accepted = { continuationMessage: { text: 'go', at: NOW } as unknown as RunRecord['continuationMessage'], invalidAsk: u, archived: false, archivedAt: u };

const SITES: Site[] = [
  // requeue
  { site: 'requeueInterruptedRun (both)', exit: 'requeue', from: 'failed', manager: true,
    before: () => ({ error: u, finishedAt: u, currentStepId: u }), after: () => ({ error: u, finishedAt: u }) },
  { site: 'holdContinuationForRootFinish', exit: 'requeue', from: 'running', manager: true, before: () => ({ currentStepId: u }), after: () => ({}) },
  { site: 'settleResumedWorkflowStep', exit: 'requeue', from: 'running', manager: true,
    before: () => ({ currentStepId: u, workflowResumeStepId: u }), after: () => ({ workflowResumeStepId: u }) },
  { site: 'requeueWhileHeld, resumed workflow', exit: 'requeue', from: 'running', manager: true, before: () => ({ currentStepId: u }), after: () => ({}) },
  { site: 'requeueWhileHeld, first step', exit: 'requeue', from: 'queued', manager: true,
    before: () => ({ startedAt: u, currentStepId: u }), after: () => ({ startedAt: u }) },
  { site: 'check step retry', exit: 'requeue', from: 'running', manager: true, before: () => ({ currentStepId: u }), after: () => ({}) },
  // continue-line, continue-now
  { site: 'acceptUntouchedContinuation', exit: 'continue-line', from: 'done', manager: true,
    before: () => ({ stopping: u, error: u, finishedAt: u, currentStepId: u, queuedMessages: [] }), after: () => ({ stopping: u, queuedMessages: [] }) },
  { site: 'checkpointContinuation, to the line', exit: 'continue-line', from: 'failed', manager: false,
    before: () => ({ ...accepted, error: u, finishedAt: u, currentStepId: u }), after: () => accepted },
  { site: 'checkpointContinuation, now', exit: 'continue-now', from: 'review', manager: false,
    before: () => ({ ...accepted, error: u, finishedAt: u, currentStepId: 'step-2' }), after: () => ({ ...accepted, currentStepId: 'step-2' }) },
  { site: 'dispatchAcceptedContinuation', exit: 'continue-line', from: 'queued', manager: true,
    before: () => ({ error: u, finishedAt: u, currentStepId: u }), after: () => ({}) },
  // hold
  { site: 'auto-resume hold', exit: 'hold', from: 'waiting', manager: true,
    before: () => ({ finishedAt: u, autoResumeAt: NOW }), after: () => ({ autoResumeAt: NOW }) },
  { site: 'restoreLoadedUsageLimitHold', exit: 'hold', from: 'failed', manager: false, before: () => ({ finishedAt: u }), after: () => ({}) },
  // succeed, succeed-review, accept-review
  ...(['succeed', 'succeed-review'] as const).map((exit): Site => ({ site: `commitOrdinarySuccess (${exit})`, exit, from: 'running', manager: false,
    before: run => ({ ...retired(run), finishedAt: SHARED, currentStepId: u, autoResumeAttempts: u }), after: () => ({ finishedAt: SHARED }) })),
  { site: 'finish at review', exit: 'accept-review', from: 'review', manager: true, before: run => retired(run), after: () => ({}) },
  // fail-start
  { site: 'checkpointQueuedWorker', exit: 'fail-start', from: 'queued', manager: true,
    before: () => ({ error: 'e', finishedAt: NOW }), after: () => ({ error: 'e' }) },
  { site: 'ownedContinuationWorkspace, failContinuationBeforeSpawn, reviveQueuedContinuation', exit: 'fail-start', from: 'running', manager: true,
    before: () => ({ error: 'e', finishedAt: SHARED, currentStepId: u }), after: () => ({ error: 'e', finishedAt: SHARED, currentStepId: u }) },
  { site: 'reviveQueuedRun, reviveQueuedWorker', exit: 'fail-start', from: 'queued', manager: true,
    before: () => ({ error: 'e', finishedAt: NOW }), after: () => ({ error: 'e' }) },
  { site: 'worktree creation failed', exit: 'fail-start', from: 'running', manager: true,
    before: () => ({ error: 'e', finishedAt: NOW, currentStepId: u }), after: () => ({ error: 'e', currentStepId: u }) },
  // fail, fail-continue
  { site: 'settleClosingWakes, settleFailedRun', exit: 'fail', from: 'running', manager: true,
    before: () => ({ error: 'e', finishedAt: NOW, currentStepId: u }), after: () => ({ error: 'e' }) },
  { site: 'settleIdleClosedWorker, failRecoveredInvalidAsk', exit: 'fail', from: 'waiting', manager: true,
    before: () => ({ error: 'e', finishedAt: SHARED, currentStepId: u }), after: () => ({ error: 'e', finishedAt: SHARED }) },
  ...(['running', 'cancelled'] as const).map((from): Site => ({ site: `settleFailedContinuation from ${from}`, exit: 'fail-continue', from, manager: true,
    before: () => ({ error: 'e', finishedAt: NOW, currentStepId: u }), after: () => ({ error: 'e' }) })),
  // fail-crash
  { site: 'launchQueuedRun, failCrashedContinuation', exit: 'fail-crash', from: 'running', manager: true,
    before: () => ({ error: 'e', finishedAt: NOW }), after: () => ({ error: 'e' }) },
  // fail-interrupted
  { site: 'recoverInterruptedRun', exit: 'fail-interrupted', from: 'running', manager: true,
    before: () => ({ error: 'interrupted — cezar process exited during the run', finishedAt: SHARED, currentStepId: u }),
    after: run => ({ finishedAt: SHARED, currentStepId: u, ...retired(run) }) },
  { site: 'failLoadedInterruptedRun', exit: 'fail-interrupted', from: 'waiting', manager: false,
    before: () => ({ error: 'interrupted — cezar process exited during the run', finishedAt: SHARED }), after: () => ({ finishedAt: SHARED }) },
];

const plainRun = (status: RunStatus): ExitRead => ({ status, delegation: undefined });
const rootWithIntent = (status: RunStatus): ExitRead => ({ status,
  delegation: { role: 'root', permissions: [], receipts: [], finishRequestedAt: INTENT } as unknown as RunRecord['delegation'] });

describe('run exits settle the fields all their sites agree on (S5)', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date(NOW)); });
  afterEach(() => { vi.useRealTimers(); });

  for (const row of SITES) {
    for (const [kind, make] of [['a plain run', plainRun], ['a root with a pending Finish', rootWithIntent]] as const) {
      it(`${row.site} (${row.exit}) writes the record it wrote before, for ${kind}`, () => {
        const run = make(row.from);
        const old = row.manager ? oldManagerPatch(run, row.exit, row.before(run)) : row.before(run);
        expect(applyExit(run, row.exit, row.after(run))).toStrictEqual({ ...old, status: RUN_EXITS[row.exit].to });
      });
    }
  }

  it('leaves the exits whose sites disagree, or that settle through their guard, without fields', () => {
    const fieldless = Object.entries(RUN_EXITS).filter(([, spec]) => !('fields' in spec)).map(([id]) => id);
    expect(fieldless.sort()).toEqual(['cancel', 'cancel-late', 'cancel-root', 'draft-pr', 'park', 'park-for-wake', 'park-release',
      'resume', 'start', 'start-held', 'stop-worker', 'succeed-root', 'succeed-root-review', 'withdraw-hold']);
    for (const id of fieldless as RunExitId[]) {
      const run = rootWithIntent(RUN_EXITS[id].from[0]!);
      expect(applyExit(run, id, { finishedAt: SHARED })).toStrictEqual({ finishedAt: SHARED, status: RUN_EXITS[id].to });
    }
  });
});
