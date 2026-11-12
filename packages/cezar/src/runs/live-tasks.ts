import { isUsageLimitHold } from '@open-mercato/cezar-contract/waits';
import type { LiveProjectTask } from '../server/cockpit-ownership.ts';
import { isLiveRecord } from './run-row.ts';
import type { RunRecord, RunStore } from './store.ts';

/** The state a live-task list shows: the status, and what an idle-looking task still waits for. */
function liveState(run: RunRecord): string {
  if (isUsageLimitHold(run)) return `${run.status}, usage-limit auto-resume`;
  const waits = run.waits?.filter((wait) => wait.phase === 'open' || wait.phase === 'resolved').map((wait) => wait.kind) ?? [];
  return waits.length ? `${run.status}, waiting on ${[...new Set(waits)].join(', ')}` : run.status;
}

/**
 * Every task of a project that is not terminal (`isLiveRecord`): queued, running, waiting on a
 * human, a usage-limit auto-resume, a timer, a PR or a worker, held by this store or persisted
 * in either project directory. Plus the runs of every family another live process (a headless
 * `cez run`, another binary) claims in the same database.
 * The migration fence's live-task check uses this one notion of live.
 */
export function projectLiveTasks(store: Pick<RunStore, 'listRuns' | 'persistedLiveRunIds' | 'getRun'>): LiveProjectTask[] {
  const tasks = new Map(store.listRuns().filter(isLiveRecord).map((run) => [run.id, run]));
  // Rows another process left live, whose owner may since have gone, are in the database only.
  const { live, foreign } = store.persistedLiveRunIds();
  for (const id of live) {
    const run = tasks.has(id) ? undefined : store.getRun(id);
    if (run && isLiveRecord(run)) tasks.set(id, run);
  }
  for (const id of foreign) {
    const run = tasks.has(id) ? undefined : store.getRun(id);
    if (run) tasks.set(id, run);
  }
  return [...tasks.values()].map((run) => ({ id: run.id, title: run.title, state: liveState(run) }));
}
