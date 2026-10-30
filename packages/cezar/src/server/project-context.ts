import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import { AutomationStore } from '../automations/store.ts';
import { reconcileAutomationReceipts } from '../automations/task-template.ts';
import { DEFAULT_WORKTREE_RETENTION, resolveWorktreeRetention } from '../config.ts';
import { pruneOrphans } from '../git-worktree.ts';
import { sweepPreviewLeftovers } from '../preview/dev-server.ts';
import type { PreviewHost } from '../preview/host.ts';
import { reconcileAgentMarkers } from '../preview/agent-marker.ts';
import { armRepoHandle } from '../runs/arm-repo-handle.ts';
import { ensureDataGitignore } from '../data-gitignore.ts';
import { reclaimWorktrees } from '../runs/retention.ts';
import { SWEEP_MIN_INTERVAL_MS, sweepMergedBranches } from './repo-branch-sweep.ts';
import { RunStore } from '../runs/store.ts';
import { RunDatabase, RUNS_DB_FILE, RUNS_IMPORT_COMPLETE_KEY } from '../runs/run-database.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { RunManager } from '../workflows/run.ts';
import { ensureLaunchKey } from './launch-key.ts';
import { getRepoInfo } from './git.ts';
import { ownedByAnotherCockpit, CockpitOwnership } from './cockpit-ownership.ts';

/**
 * One store/manager/dataDir/launchKey context per project, built on demand or by post-listen
 * warm-up. Build includes retention and recovery. Missing roots yield a typed 409; unknown
 * projects yield 404.
 */

/** The per-project bundle the routes operate on. */
export interface ProjectContext {
  /** Registry project id (slug). */
  id: string;
  /** Realpath'd repo root the registry holds for this project. */
  root: string;
  /** `<root>/.ai/cezar` — all of this project's on-disk state. */
  dataDir: string;
  store: RunStore;
  manager: RunManager;
  automationStore: AutomationStore;
  /** Bookmarklet auto-start secret (spec 011), ensured at context build. */
  launchKey: string;
}

/** Minimal registry shape the context map needs — matches
 *  `workspace/projects.ts` `ProjectListEntry` structurally, but injected so
 *  tests stay hermetic (no `~/.cezar` reads). */
export interface ProjectContextSource {
  id: string;
  root: string;
  /** `missing` roots are never instantiated; `ok`/`not-git` both build. */
  status: 'ok' | 'missing' | 'not-git';
}

/** A registry row `warmAll` can order: `lastOpenedAt` is the registry's own ISO timestamp. */
export interface ProjectWarmCandidate extends ProjectContextSource {
  lastOpenedAt?: string;
}

/** The background warm-up (#667) is on unless `CEZ_PROJECT_WARMUP` is exactly `0`. */
export function projectWarmupEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CEZ_PROJECT_WARMUP !== '0';
}

export interface ProjectContextDeps {
  /** CLI process ownership, acquired before opening any secondary store. */
  ownership?: CockpitOwnership | undefined;
  /** Install controller session capabilities before recovery starts any backend. */
  prepareManager?: (project: Pick<ProjectContext, 'id' | 'root' | 'store' | 'manager'>) => (() => void) | void;
  /** Arm persisted cleanup only after recovered execution/process state is available. */
  afterRecover?: (project: Pick<ProjectContext, 'id' | 'root' | 'store' | 'manager'>) => void;
  /** Registry lookup — the workspace `listProjects()` in production. */
  listProjects: () => Promise<readonly ProjectContextSource[]>;
  /** Resolve the one automation store owned by this project. Production
   *  injects the workspace automation coordinator's cached store so API
   *  mutations and scheduler reads share the same in-memory state. */
  automationStore?: (projectId: string, root: string) => AutomationStore;
  /** Workspace-wide parallel-cap semaphore (spec 2026-07-20, step 2.5). Boot
   *  passes the ONE instance it already gave the boot manager, so every
   *  project's RunManager counts against the same `resources.maxParallel`.
   *  When omitted, the map still shares one private instance across the
   *  managers it builds (workspace defaults, never refreshed). */
  semaphore?: WorkspaceSemaphore | undefined;
  /** The ONE workspace preview host (#781, present under `CEZ_PREVIEW=1`): every project's
   *  manager registers against it, because ports are host-global. */
  preview?: PreviewHost | undefined;
  /** The cockpit's listening port, for the preview tool's `cezar_port` refusal. */
  cezarPort?: (() => number | undefined) | undefined;
}

/** Data dirs this process has swept: the sweep cleans up after a crashed cezar, never this one. */
const sweptPreviewDirs = new Set<string>();

/** One data dir's crash leftovers, once per process; whatever the live host runs is spared. */
function sweepPreviewOnce(dataDir: string, host: PreviewHost | undefined): Promise<number> {
  if (sweptPreviewDirs.has(dataDir)) return Promise.resolve(0);
  sweptPreviewDirs.add(dataDir);
  const keep = host
    ? (runId: string, what: number | 'browser') => (what === 'browser' ? host.ownsBrowser(runId) : host.ownsServer(runId, what))
    : undefined;
  return sweepPreviewLeftovers(dataDir, { keep }).catch(() => 0);
}

/**
 * A project's preview exits that the store drives (#781, spec 2026-10-02-live-preview-v1):
 * dev servers and browsers a crashed cezar left behind are swept once per data dir per process
 * (always, so turning the flag off after a crash still cleans up; a project removed and re-added
 * is not swept again, and what the live host runs is spared either way), and a deleted run's
 * preview is released with its profile.
 */
export function armPreview(store: RunStore, dataDir: string, host: PreviewHost | undefined): void {
  // Before the sweep's first await: a crash's agent state is reconciled before any agent can connect.
  reconcileAgentMarkers(dataDir, store, runId => host?.hasAgents(runId) ?? false);
  void sweepPreviewOnce(dataDir, host);
  if (host) store.on('deleted', (runId: string) => void host.release(runId, { deleteProfile: true, dataDir }).catch(() => undefined));
}

/**
 * Boot: the crash leftovers of every registered project, not only the boot project's, so a dev
 * server left in a project nobody opens this session does not hold its port all session. A data
 * dir another live cockpit owns holds that cockpit's servers, not a crash's: it is skipped and
 * left unswept, so this process's own context build (which takes ownership first) sweeps it if
 * that cockpit goes. Resolves with how many processes were killed.
 */
export async function sweepRegisteredPreviewLeftovers(
  projects: ReadonlyArray<{ root: string; status?: string }>,
  host: PreviewHost | undefined,
): Promise<number> {
  let killed = 0;
  for (const project of projects) {
    if (project.status === 'missing') continue;
    const dataDir = join(project.root, '.ai/cezar');
    if (sweptPreviewDirs.has(dataDir) || ownedByAnotherCockpit(dataDir)) continue;
    killed += await sweepPreviewOnce(dataDir, host);
  }
  return killed;
}

/** A build that finished after `disposeAll`: its context was torn down, never registered. */
export class ProjectContextsClosedError extends Error {
  constructor() {
    super('project contexts were disposed while this project was being built');
    this.name = 'ProjectContextsClosedError';
  }
}

export type ProjectContextFailure = 'unknown-project' | 'missing-root';

/** Typed failure so the route layer can map reasons to statuses (404/409)
 *  without string matching. */
export class ProjectContextError extends Error {
  constructor(
    readonly reason: ProjectContextFailure,
    readonly projectId: string,
  ) {
    super(
      reason === 'unknown-project'
        ? `unknown project: ${projectId}`
        : `project root is missing: ${projectId}`,
    );
    this.name = 'ProjectContextError';
  }
}

/**
 * Lazy `Map<projectId, ProjectContext>`. Nothing is instantiated at
 * construction — the boot project is built eagerly by the caller via
 * `context(bootId)`; every other project on first API touch. Concurrent
 * `context()` calls for the same id share one build (the in-flight promise is
 * cached), so recovery never runs twice for a project.
 */
export class ProjectContexts {
  private readonly contexts = new Map<string, ProjectContext>();
  private readonly managerCleanups = new WeakMap<RunManager, () => void>();
  private readonly building = new Map<string, Promise<ProjectContext>>();
  private readonly maintenance = new Map<string, Promise<unknown>>();
  private readonly repoHandleControllers = new WeakMap<RunStore, AbortController>();
  /** Live store-created subscribers; invoked before RunManager recovery. */
  private readonly storeListeners = new Set<(store: RunStore) => void>();
  /** Live `onContextBuilt` subscribers (workspace SSE, step 2.8). */
  private readonly builtListeners = new Set<(ctx: ProjectContext) => void>();
  /** One semaphore for every manager this map builds — injected by boot,
   *  private-but-shared otherwise. */
  private readonly semaphore: WorkspaceSemaphore;
  /** Bumped by `disposeAll`: a build that started before it is torn down, not registered. */
  private generation = 0;
  /** Bumped per project by `dispose(id)`, for the same reason: project removal runs `dispose`
   *  after the registry commit, and a build that read the registry before it must not land. */
  private readonly epochs = new Map<string, number>();
  /** Managers of builds still in flight. `dispose`/`disposeAll` stop them at once: `recover()`
   *  checks `disposed` between its steps, so a stale build never pumps a re-queued run. */
  private readonly buildingManagers = new Map<string, RunManager>();

  constructor(private readonly deps: ProjectContextDeps) {
    this.semaphore = deps.semaphore ?? new WorkspaceSemaphore();
  }

  /** The built context for `projectId`, building it on first access.
   *  Throws `ProjectContextError` for unknown ids and missing roots. */
  async context(projectId: string): Promise<ProjectContext> {
    const existing = this.contexts.get(projectId);
    if (existing) return existing;
    const inFlight = this.building.get(projectId);
    if (inFlight) return inFlight;
    const generation = this.generation;
    const epoch = this.epochs.get(projectId) ?? 0;
    const stale = () => generation !== this.generation || epoch !== (this.epochs.get(projectId) ?? 0);
    const build = (async () => {
      await this.maintenance.get(projectId)?.catch(() => undefined);
      if (stale()) throw new ProjectContextsClosedError();
      return this.build(projectId, stale);
    })();
    this.building.set(projectId, build);
    try {
      const ctx = await build;
      if (generation !== this.generation || epoch !== (this.epochs.get(projectId) ?? 0)) {
        // Shut down or removed while this build ran: nothing may outlive `dispose`.
        this.disposeBuilt(ctx);
        throw new ProjectContextsClosedError();
      }
      this.contexts.set(projectId, ctx);
      this.notifyBuilt(ctx);
      return ctx;
    } finally {
      this.building.delete(projectId);
    }
  }

  /** A short-lived writer lease for background maintenance; never creates/recover a manager.
   * Context construction waits for the lease, while disposal invalidates it synchronously. */
  async withMaintenanceStore<T>(projectId: string, work: (store: RunStore, current: () => boolean) => Promise<T>): Promise<T | undefined> {
    const generation = this.generation, epoch = this.epochs.get(projectId) ?? 0;
    let active = true;
    const current = () => active && generation === this.generation && epoch === (this.epochs.get(projectId) ?? 0);
    const built = this.peek(projectId);
    if (built) return work(built.store, current).finally(() => { active = false; });
    if (this.building.has(projectId) || this.maintenance.has(projectId)) return undefined;
    const lease = (async () => {
      const project = (await this.deps.listProjects()).find(project => project.id === projectId);
      if (!project || project.status === 'missing' || !current()) return undefined;
      const dataDir = join(project.root, '.ai/cezar');
      if (ownedByAnotherCockpit(dataDir)) return undefined;
      // Skip empty projects, but let the established fenced importer discover legacy-only
      // history. Maintenance mode never normalizes live rows or recovers a manager.
      const reader = RunDatabase.openReadOnly(join(dataDir, RUNS_DB_FILE));
      let imported = false;
      try { imported = reader?.getMeta(RUNS_IMPORT_COMPLETE_KEY) !== undefined; }
      finally { reader?.close(); }
      if (!imported && !existsSync(join(dataDir, 'runs.json'))) return undefined;
      const temporaryOwnership = new CockpitOwnership();
      let store: RunStore | undefined;
      try {
        // Existing process claims protect managers even after disposal. Borrow those;
        // otherwise maintenance owns only this lease, never the server's lifetime.
        if (!this.deps.ownership?.owns(dataDir)) await temporaryOwnership.acquire(dataDir);
        if (!current()) return undefined;
        ensureDataGitignore(project.root);
        store = RunStore.open(dataDir, { keepLive: true, maintenance: true });
        return await work(store, current);
      } finally {
        active = false;
        if (store) { await store.historyIdle(); store.close(); }
        temporaryOwnership.releaseAll();
      }
    })();
    this.maintenance.set(projectId, lease);
    try { return await lease; }
    finally { if (this.maintenance.get(projectId) === lease) this.maintenance.delete(projectId); }
  }

  /**
   * Build every project's context in the background (#667), so the first click on a project
   * finds it ready. A lazy build costs the store open, the worktree sweeps and `recover()`, which
   * resumes the runs a restart interrupted; paid on the click, that is seconds of a blank page.
   *
   * One project at a time, most recently opened first, yielding to the event loop between builds
   * so a request is never queued behind several. A click on a project being warmed shares its
   * build (`context()` caches the in-flight promise). Skipped: missing roots, built contexts, and
   * a project another live cockpit owns, whose lock would otherwise be waited on for 15 s and then
   * refused. A failed build is logged once and dropped; nothing is cached, so the next click
   * builds again exactly as before. `disposeAll` stops the loop. Resolves with the ids built here.
   */
  async warmAll(projects: readonly ProjectWarmCandidate[]): Promise<string[]> {
    const generation = this.generation;
    const ordered = [...projects].sort((a, b) => (b.lastOpenedAt ?? '').localeCompare(a.lastOpenedAt ?? ''));
    const warmed: string[] = [];
    for (const project of ordered) {
      await yieldToEventLoop();
      if (generation !== this.generation) break;
      if (project.status === 'missing' || this.contexts.has(project.id) || this.building.has(project.id)) continue;
      if (ownedByAnotherCockpit(join(project.root, '.ai/cezar'))) continue;
      try {
        await this.context(project.id);
        warmed.push(project.id);
      } catch (err) {
        if (err instanceof ProjectContextsClosedError) {
          // Shut down: stop. Removed mid-build: the next project.
          if (generation !== this.generation) break;
          continue;
        }
        // Removed from the registry after this list was read: nothing to prepare, nothing to say.
        if (err instanceof ProjectContextError && err.reason === 'unknown-project') continue;
        console.warn(`[cez] project ${project.id} could not be prepared in the background: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return warmed;
  }

  /**
   * Subscribe to future context builds (multi-project spec, step 2.8): the
   * workspace SSE stream attaches to every already-built context at connect
   * and uses this hook to pick up contexts built LATER — so subscribing never
   * force-instantiates a project, yet a project's first API touch makes its
   * events flow to already-open workspace streams. Returns an unsubscribe.
   */
  onContextBuilt(listener: (ctx: ProjectContext) => void): () => void {
    this.builtListeners.add(listener);
    return () => this.builtListeners.delete(listener);
  }

  /**
   * Subscribe at the earliest RunStore lifecycle point: immediately after a
   * lazy project's store opens and before its manager can recover runs. This
   * stays generic so backend-specific observers do not leak into the context
   * map. Returns an unsubscribe.
   */
  onStoreCreated(listener: (store: RunStore) => void): () => void {
    this.storeListeners.add(listener);
    return () => this.storeListeners.delete(listener);
  }

  /** A listener throwing must never fail the build (its store is usable). */
  private notifyStoreCreated(store: RunStore): void {
    for (const listener of [...this.storeListeners]) {
      try {
        listener(store);
      } catch {
        // subscriber's problem — context construction can continue
      }
    }
  }

  /** A listener throwing must never fail the build (its context is fine). */
  private notifyBuilt(ctx: ProjectContext): void {
    for (const listener of [...this.builtListeners]) {
      try {
        listener(ctx);
      } catch {
        // subscriber's problem — the build succeeded
      }
    }
  }

  /**
   * Wait for a build of `projectId` that is already running, never starting one; a failed build
   * resolves too. Project removal waits here (#667): the background warm-up makes a build in flight
   * likely, and a removal that ran past it would count no running tasks, dispose nothing, and let
   * the build register a removed project's store and manager afterwards.
   */
  async settle(projectId: string): Promise<void> {
    await this.building.get(projectId)?.catch(() => undefined);
    await this.maintenance.get(projectId)?.catch(() => undefined);
  }

  /** Already-built context, without triggering a build. */
  peek(projectId: string): ProjectContext | undefined {
    return this.contexts.get(projectId);
  }

  /** Ids of every built context (dispose bookkeeping, shutdown flush). */
  ids(): string[] {
    return [...this.contexts.keys()];
  }

  /**
   * Tear down one project's context (project removal): the manager stops
   * making moves on its own (`RunManager.dispose()` — usage-sampler
   * unsubscribe, timers, queued state) and the store is closed — pending
   * rows written, its database released, every event-bus subscriber detached. Returns false when
   * nothing was built for `projectId`.
   */
  dispose(projectId: string, opts: { releasePreviews?: boolean } = {}): boolean {
    // Also invalidates a build of this project still in flight (#667).
    this.epochs.set(projectId, (this.epochs.get(projectId) ?? 0) + 1);
    this.buildingManagers.get(projectId)?.dispose();
    const ctx = this.contexts.get(projectId);
    if (!ctx) return false;
    this.contexts.delete(projectId);
    this.disposeBuilt(ctx, opts);
    return true;
  }

  private disposeBuilt(ctx: ProjectContext, opts: { releasePreviews?: boolean } = {}): void {
    // The preview host is process-wide and outlives this context: a removed project's dev servers
    // and browsers go with it (#781). Shutdown leaves that to `PreviewHost.close()`.
    if (opts.releasePreviews !== false && this.deps.preview) {
      // Every run id, not only the held ones: a finished run's dev server may still be up. A run
      // without one is a no-op for the host.
      for (const id of ctx.store.listRunIds()) void this.deps.preview.release(id).catch(() => undefined);
    }
    this.repoHandleControllers.get(ctx.store)?.abort();
    this.repoHandleControllers.delete(ctx.store);
    this.managerCleanups.get(ctx.manager)?.();
    this.managerCleanups.delete(ctx.manager);
    teardown(ctx);
  }

  /** Tear down every built context (process shutdown), and every build still running. */
  disposeAll(): void {
    this.generation += 1;
    for (const manager of this.buildingManagers.values()) manager.dispose();
    for (const id of this.ids()) this.dispose(id, { releasePreviews: false });
  }

  /** `stale` turns true once `dispose(id)` or `disposeAll` overtook this build. Checked after
   *  each wait that comes before the manager exists, because until then nothing can stop it. */
  private async build(projectId: string, stale: () => boolean): Promise<ProjectContext> {
    const projects = await this.deps.listProjects();
    if (stale()) throw new ProjectContextsClosedError();
    const project = projects.find((p) => p.id === projectId);
    if (!project) throw new ProjectContextError('unknown-project', projectId);
    if (project.status === 'missing') throw new ProjectContextError('missing-root', projectId);

    const dataDir = join(project.root, '.ai/cezar');
    await this.deps.ownership?.acquire(dataDir);
    if (stale()) throw new ProjectContextsClosedError();
    // keepLive + recover() (#367), same as serveCommand: runs that were live
    // when this project's context last existed are re-queued or resumed.
    // A store that cannot open throws `RunStoreOpenError` (#779): nothing is
    // cached, the route answers 409 with why, and the next request opens again.
    // One attempt only: this runs on a live cockpit's event loop. The ignore file comes first: a
    // failed open may already have created the database and the history backups.
    ensureDataGitignore(project.root);
    const store = RunStore.open(dataDir, { keepLive: true });
    const automationStore = this.deps.automationStore?.(project.id, project.root)
      ?? AutomationStore.open(dataDir);
    reconcileAutomationReceipts(automationStore, store);
    this.notifyStoreCreated(store);
    armPreview(store, dataDir, this.deps.preview);
    const manager: RunManager = new RunManager(store, project.root, {
      semaphore: this.semaphore, preview: this.deps.preview, cezarPort: this.deps.cezarPort,
      sweepBranches: (keep) => void sweepMergedBranches({ root: project.root, store, manager }, { keep, minIntervalMs: SWEEP_MIN_INTERVAL_MS }),
    });
    this.buildingManagers.set(projectId, manager);
    try {
      const cleanup = this.deps.prepareManager?.({ id: project.id, root: project.root, store, manager });
      if (cleanup) this.managerCleanups.set(manager, cleanup);
      const launchKey = ensureLaunchKey(dataDir);
      // Startup reconcile (spec 006) + count-based retention (#483) — the same
      // best-effort sweeps serveCommand runs for the boot project, gated on the
      // root actually being a git repo.
      if (await getRepoInfo(project.root)) {
        await pruneOrphans(project.root, new Set(store.listRunIds())).catch(
          () => [] as string[],
        );
        const keep = await resolveWorktreeRetention(project.root).catch(
          () => DEFAULT_WORKTREE_RETENTION,
        );
        await reclaimWorktrees(project.root, store, keep, { previewHost: this.deps.preview }).catch(() => [] as string[]);
        // In the background: the sweep may ask GitHub (hearsay-tools/cezarion#2268). Never over a
        // store that could not open: its runs are unknown, and every branch would look ownerless.
        if (!store.unavailable) void sweepMergedBranches({ root: project.root, store, manager }, { keep });
      }
      await manager.recover();
      // Archived transcripts left plain (or both-present after a crash) — fire-and-forget,
      // never delays boot (#818).
      store.compressArchivedHistory();
      this.deps.afterRecover?.({ id: project.id, root: project.root, store, manager });
      // Which repository this project IS (#945), so the referenced tier stops adopting another
      // repo's PR/issue as a task's subject. Fire-and-forget on purpose — it costs a `gh` spawn
      // and building a context must not wait on the network. `project.root` is already realpath'd.
      //
      // Armed only once the build has SUCCEEDED. Arming beside `RunStore.open` would outlive a
      // failed build: the promise still resolves after `teardown` flushed the index and detached
      // every listener, and a healed record would then `touch()` a store whose lifecycle had
      // ended — scheduling a `runs.json` write from a context nobody owns any more.
      const repoHandleController = new AbortController();
      this.repoHandleControllers.set(store, repoHandleController);
      armRepoHandle(store, project.root, repoHandleController.signal);
      return { id: project.id, root: project.root, dataDir, store, manager, automationStore, launchKey };
    } catch (err) {
      // A failed build must not leak the half-built context's subscriptions.
      this.managerCleanups.get(manager)?.();
      this.managerCleanups.delete(manager);
      teardown({ store, manager });
      throw err;
    } finally {
      if (this.buildingManagers.get(projectId) === manager) this.buildingManagers.delete(projectId);
    }
  }
}

/** Shared teardown for built and half-built contexts. Closing the store writes what is pending
 *  and releases its database connection; a late write to it afterwards saves nothing. */
function teardown(ctx: { store: RunStore; manager: RunManager }): void {
  ctx.manager.dispose();
  ctx.store.close();
  ctx.store.removeAllListeners();
}
