import type { ActivityCheckBucket, ActivityPrProgress } from '@open-mercato/cezar-contract';
import { ACTIVITY_CHECK_NAME_MAX, ACTIVITY_CHECKS_MAX } from '@open-mercato/cezar-contract/activity';
import type { CiProgressSource } from '../activity/read-model.ts';
import { clampText } from '../activity/text.ts';
import type { GithubCheck } from './github.ts';
import { stripTerminal } from './text.ts';

const BUCKETS: readonly ActivityCheckBucket[] = ['pass', 'fail', 'pending', 'skipping', 'cancel'];
const byName = (a: GithubCheck, b: GithubCheck) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

/**
 * The bucket count of one checks read (spec 2026-11-05-live-activity-view, Data): `counts` covers
 * every row; `checks` lists the first `ACTIVITY_CHECKS_MAX` in name order, each name cleaned and
 * clamped, and `truncated` says the list was cut.
 */
export function checkProgress(rows: readonly GithubCheck[]): ActivityPrProgress {
  const counts = Object.fromEntries(BUCKETS.map((bucket) => [bucket, 0])) as ActivityPrProgress['counts'];
  for (const row of rows) counts[row.bucket]++;
  const checks = [...rows].sort(byName).slice(0, ACTIVITY_CHECKS_MAX)
    .map((row) => ({ name: clampText(stripTerminal(row.name), ACTIVITY_CHECK_NAME_MAX), bucket: row.bucket }));
  return { checks, counts, ...(rows.length > checks.length ? { truncated: true as const } : {}) };
}

/** Who watches a project in the activity view. */
export interface ProgressDemand {
  has(projectId: string): boolean;
}

/**
 * The demand of the cockpit that reads the registry. A `RunManager` builds the CI watchers,
 * outside any cockpit and often before it, so the cockpit plugs its demand in later. With none
 * plugged in, nobody watches. The last demand plugged in wins.
 */
export class DemandSlot implements ProgressDemand {
  private current: ProgressDemand | undefined;

  /** Returns the release; it clears the slot only while this demand still holds it. */
  use(demand: ProgressDemand): () => void {
    this.current = demand;
    return () => { if (this.current === demand) this.current = undefined; };
  }

  has(projectId: string): boolean {
    return this.current?.has(projectId) ?? false;
  }
}

/**
 * The check progress of the open PR waits a workspace watches, in memory and keyed by wait id
 * (spec 2026-11-05-live-activity-view, CI check progress; D6: never written to a run, empty after
 * a restart). The shared CI resource (`acquireCiResources`) holds one next to its supervisor: the
 * supervisor publishes every checks read and removes the entry when the watch ends; the activity
 * read model reads it.
 *
 * A wait does not name its project, and one supervisor serves every project of the workspace. So
 * the registry learns a wait's project from the snapshot that reads it: the same project ids the
 * activity route marks as watched. A project is read before anyone can watch it, so every wait a
 * reader sees has its project by the time its demand matters.
 */
export class CiProgressRegistry implements CiProgressSource {
  private readonly entries = new Map<string, { progress: ActivityPrProgress; projectId?: string }>();

  constructor(private readonly demand: DemandSlot = new DemandSlot()) {}

  /** Plug in the activity view's demand. Returns the release. */
  useDemand(demand: ProgressDemand): () => void {
    return this.demand.use(demand);
  }

  /** A checks read of an open wait. */
  publish(waitId: string, rows: readonly GithubCheck[]): void {
    const entry = this.entries.get(waitId);
    const progress = checkProgress(rows);
    if (entry) entry.progress = progress;
    else this.entries.set(waitId, { progress });
  }

  /** The wait resolved or was cancelled. */
  remove(waitId: string): void {
    this.entries.delete(waitId);
  }

  /** A snapshot of `projectId` reads the wait. A wait this process does not watch records nothing. */
  read(waitId: string, projectId: string): ActivityPrProgress | undefined {
    const entry = this.entries.get(waitId);
    if (!entry) return undefined;
    entry.projectId = projectId;
    return entry.progress;
  }

  /** Someone watches the project of this wait: the `--watch` phase may read its checks once more. */
  wanted(waitId: string): boolean {
    const projectId = this.entries.get(waitId)?.projectId;
    return projectId !== undefined && this.demand.has(projectId);
  }
}
