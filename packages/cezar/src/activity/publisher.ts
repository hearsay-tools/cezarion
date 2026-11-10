import type { ActivityRun, ActivitySnapshot, ActivityWorker } from '@open-mercato/cezar-contract';
import type { RunStore } from '../runs/store.ts';
import type { TopicPublisher } from '../server/ws.ts';
import { buildActivityProject, type ActivityDeps, type ActivityProjectSource, type ActivityStore, type CiProgressSource } from './read-model.ts';
import { projectAdmissionRefusal } from '../server/cockpit-ownership.ts';

/** At most one snapshot in this window (spec 2026-11-05-live-activity-view, Live transport). */
export const ACTIVITY_COALESCE_MS = 500;
/** While a watched run has a nonzero rate bucket, its heartbeat moves once a second. */
export const ACTIVITY_DRAIN_TICK_MS = 1_000;
/** No cross-process change signal exists: a subscribed publisher reads the foreign claims this often. */
export const ACTIVITY_FOREIGN_CHECK_MS = 5_000;

/** A loaded project's store as the publisher needs it: the read model's reads plus its change events. */
export type LiveActivityStore = ActivityStore & Pick<RunStore, 'on' | 'off'>;

export interface LiveActivitySource extends ActivityProjectSource {
  loaded?: { store: LiveActivityStore; isActive: (runId: string) => boolean; ci?: CiProgressSource | undefined; dataDir?: string | undefined } | undefined;
}

/** What one topic watches: a project, or every project of the workspace. */
export interface ActivityScope {
  /** The projects in scope now. The workspace scope re-lists them on every build. */
  sources(): Promise<LiveActivitySource[]>;
  /** The scope itself changed: a project was added, removed or loaded. */
  onScopeChange?(listener: () => void): () => void;
  /** Hold demand for the scope's projects (`ActivityDemand.watch`); returns the release. */
  watch(): () => void;
}

/** An in-memory tracker the snapshot reads (tool activity, CI progress): it says when it changed. */
export interface ActivityChangeSource {
  onChange(listener: () => void): () => void;
}

export interface ActivityPublisherDeps extends ActivityDeps {
  /** The trackers' change signals. Each change schedules a rebuild. */
  changes?: readonly ActivityChangeSource[];
  /** A build that failed; the next change retries it. */
  onBuildError?: (error: unknown) => void;
}

interface Running {
  publish: (data: unknown) => void;
  /** The projects of the last snapshot sent, serialized: a frame goes out only when this changes. */
  last: string | undefined;
  /** Something changed since the last build started. */
  dirty: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
  building: boolean;
  lastBuildAt: number;
  drain: ReturnType<typeof setInterval> | undefined;
  foreign: ReturnType<typeof setInterval>;
  foreignSeen: Map<string, string>;
  stores: Map<LiveActivityStore, { projectId: string; dataDir: string | undefined; off: () => void }>;
  release: Array<() => void>;
}

const claimsKey = (ids: readonly string[]): string => [...ids].sort().join('\n');
const beats = (run: ActivityRun | ActivityWorker): boolean => run.rate.some((count) => count > 0);
const nonzero = (run: ActivityRun): boolean => beats(run) || run.workers.some(beats);

/**
 * The publisher of one activity topic (spec 2026-11-05-live-activity-view, Live transport). It
 * runs only between the hub's first subscriber and its last. A store run change, a tracker change
 * or a scope change schedules a rebuild; rebuilds coalesce to one every `ACTIVITY_COALESCE_MS`,
 * and a frame goes out only when the snapshot's projects changed. While a watched run has a
 * nonzero rate bucket it rebuilds every second, so a heartbeat drains to flat after its task
 * parks. Every 5 s it reads the foreign claims, because another process's writes emit no event
 * here. Each build re-reads, once, the roots that held an open request in the previous one.
 */
export function createActivityPublisher(scope: ActivityScope, deps: ActivityPublisherDeps = {}): TopicPublisher {
  let running: Running | undefined;
  let carryOver = new Map<string, Set<string>>();

  /** A broadcast build advances the carry-over to the ledgers open now. A subscriber's private
   *  snapshot only adds to it: replacing it would drop a ledger the next broadcast still owes a
   *  reply (a sender that left the held set after its reply landed). */
  const build = async (run: Running | undefined, broadcast: boolean): Promise<ActivitySnapshot> => {
    const sources = await scope.sources();
    if (run && running === run) listen(run, sources);
    const now = (deps.now ?? Date.now)();
    const next = new Map<string, Set<string>>();
    const projects = sources.map((source) => {
      const built = buildActivityProject(source, deps, { now, ...(carryOver.has(source.projectId) ? { carryOver: carryOver.get(source.projectId)! } : {}) });
      next.set(source.projectId, built.openLedgers);
      return built.project;
    });
    if (broadcast) carryOver = next;
    else for (const [projectId, ledgers] of next) carryOver.set(projectId, new Set([...(carryOver.get(projectId) ?? []), ...ledgers]));
    return { generatedAt: new Date(now).toISOString(), projects };
  };

  /** Follow the run changes of exactly the stores in scope. */
  const listen = (run: Running, sources: readonly LiveActivitySource[]): void => {
    const wanted = new Map<LiveActivityStore, { projectId: string; dataDir: string | undefined }>();
    for (const source of sources) if (source.loaded) wanted.set(source.loaded.store, { projectId: source.projectId, dataDir: source.loaded.dataDir });
    for (const [store, entry] of run.stores) if (!wanted.has(store)) { entry.off(); run.stores.delete(store); }
    for (const [store, { projectId, dataDir }] of wanted) {
      if (run.stores.has(store)) continue;
      // The claims as this build reads them: a foreign owner that settles and exits before the
      // first check empties the list, and that change must count.
      run.foreignSeen.set(projectId, claimsKey(store.listForeignClaimedRunIds()));
      const onChange = () => schedule(run);
      store.on('run', onChange);
      store.on('deleted', onChange);
      run.stores.set(store, { projectId, dataDir, off: () => { store.off('run', onChange); store.off('deleted', onChange); } });
    }
  };

  /** Keep the drain tick exactly while some watched run has a nonzero bucket. */
  const drain = (run: Running, snapshot: ActivitySnapshot): void => {
    const hot = snapshot.projects.some((project) => project.tasks.some(nonzero));
    if (hot && !run.drain) {
      run.drain = setInterval(() => schedule(run), ACTIVITY_DRAIN_TICK_MS);
      run.drain.unref?.();
    }
    if (!hot && run.drain) { clearInterval(run.drain); run.drain = undefined; }
  };

  const emit = (run: Running, snapshot: ActivitySnapshot): void => {
    drain(run, snapshot);
    const body = JSON.stringify(snapshot.projects);
    if (body === run.last) return;
    run.last = body;
    run.publish(snapshot);
  };

  /** A subscriber's own snapshot goes to that subscriber only. The first one sets the baseline;
   *  a later one that differs tells the others through the coalescing gate, not at once. */
  const subscribed = (run: Running, snapshot: ActivitySnapshot): void => {
    drain(run, snapshot);
    const body = JSON.stringify(snapshot.projects);
    if (run.last === undefined) run.last = body;
    else if (body !== run.last) schedule(run);
  };

  const flush = (run: Running): void => {
    run.timer = undefined;
    if (running !== run) return;
    run.dirty = false;
    run.building = true;
    run.lastBuildAt = Date.now();
    void build(run, true)
      .then((snapshot) => { if (running === run) emit(run, snapshot); })
      .catch((error: unknown) => deps.onBuildError?.(error))
      .finally(() => {
        run.building = false;
        if (running === run && run.dirty) schedule(run);
      });
  };

  function schedule(run: Running): void {
    if (running !== run) return;
    run.dirty = true;
    if (run.timer !== undefined || run.building) return;
    run.timer = setTimeout(() => flush(run), Math.max(0, run.lastBuildAt + ACTIVITY_COALESCE_MS - Date.now()));
  }

  /** A foreign claim in scope, or a changed claim list, may hide a write this process never saw. */
  const checkForeign = (run: Running): void => {
    let changed = false;
    for (const [store, { projectId, dataDir }] of run.stores) {
      // A project under a migration fence is not read; its next snapshot answers it as unavailable.
      if (dataDir && projectAdmissionRefusal(dataDir)) continue;
      const ids = store.listForeignClaimedRunIds();
      const seen = claimsKey(ids);
      if (ids.length > 0 || seen !== (run.foreignSeen.get(projectId) ?? '')) changed = true;
      run.foreignSeen.set(projectId, seen);
    }
    if (changed) schedule(run);
  };

  return {
    async snapshot() {
      const run = running;
      const snapshot = await build(run, false);
      if (run && running === run) subscribed(run, snapshot);
      return snapshot;
    },
    start(publish) {
      const run: Running = {
        publish, last: undefined, dirty: false, timer: undefined, building: false, lastBuildAt: 0, drain: undefined,
        foreign: setInterval(() => checkForeign(run), ACTIVITY_FOREIGN_CHECK_MS), foreignSeen: new Map(), stores: new Map(), release: [],
      };
      run.foreign.unref?.();
      running = run;
      run.release.push(scope.watch());
      for (const source of deps.changes ?? []) run.release.push(source.onChange(() => schedule(run)));
      if (scope.onScopeChange) run.release.push(scope.onScopeChange(() => schedule(run)));
      return () => {
        if (running === run) running = undefined;
        clearTimeout(run.timer);
        clearInterval(run.drain);
        clearInterval(run.foreign);
        for (const { off } of run.stores.values()) off();
        run.stores.clear();
        for (const release of run.release) release();
        carryOver = new Map();
      };
    },
  };
}
