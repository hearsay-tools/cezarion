import { onTestFinished, vi } from 'vitest';

import { RunDatabase } from './run-database.ts';
import { readPersistedRuns } from './run-store.testkit.ts';
import type { RunRecord } from './store.ts';

/**
 * Crash injection for outcome writes (hearsay-tools/cezarion#1805). After every run-store
 * transaction, `recordCommits` reads the committed rows through a new connection: what a store
 * reopened after a crash at that point loads. An outcome committed apart from what it depends on
 * shows up as one snapshot that holds the outcome without it, however the test ends; the final
 * state and the in-memory record never show that (AGENTS.md § Commit an outcome with what it
 * depends on, or after it).
 */
export interface CommitRecorder {
  /** The run as each transaction since `recordCommits` left it, in commit order (absent: no row). */
  rows(runId: string): Array<RunRecord | undefined>;
  /** Fails, naming the first commit, when a committed row of `runId` breaks `invariant`. */
  expectEveryCommit(runId: string, invariant: (row: RunRecord) => boolean, what: string): void;
  stop(): void;
}

export function recordCommits(dataDir: string): CommitRecorder {
  const snapshots: Array<Map<string, RunRecord>> = [];
  const transaction = RunDatabase.prototype.transaction;
  const spy = vi.spyOn(RunDatabase.prototype, 'transaction').mockImplementation(function (this: RunDatabase, changes) {
    const commit = transaction.call(this, changes);
    snapshots.push(new Map((readPersistedRuns(dataDir) as RunRecord[]).map(row => [row.id, row])));
    return commit;
  });
  const stop = () => spy.mockRestore();
  onTestFinished(stop);
  const rows = (runId: string) => snapshots.map(snapshot => snapshot.get(runId));
  return {
    rows,
    expectEveryCommit(runId, invariant, what) {
      const broken = rows(runId).findIndex(row => row !== undefined && !invariant(row));
      if (broken >= 0) throw new Error(`commit ${broken + 1} of ${snapshots.length} leaves ${what} broken for a store reopened there`);
    },
    stop,
  };
}
