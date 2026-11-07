import type { ArchivePullRequestIdentity, MergedPullRequest } from '@open-mercato/cezar-contract';
import type { ArchiveOnMergeSnapshot, RunStore } from '../runs/store.ts';
import { pullRequestKey } from '../runs/pull-requests.ts';

export interface ArchiveProject { id: string; root: string; status?: string }
export interface ArchiveOnMergeDeps {
  projects(): Promise<readonly ArchiveProject[]>;
  enabled(project: ArchiveProject): Promise<boolean>;
  repository(project: ArchiveProject): Promise<string | undefined>;
  withStore<T>(project: ArchiveProject, work: (store: RunStore, isActive: (id: string) => boolean, current: () => boolean) => Promise<T>): Promise<T | undefined>;
  lookup(root: string, identities: ArchivePullRequestIdentity[], signal: AbortSignal): Promise<MergedPullRequest[]>;
}
interface PendingMergeSet { projectId: string; rootId: string; token: string; offset: number; merged: Map<string, MergedPullRequest> }

/** One browser-independent workspace poller. Never builds a manager or recovers a run. */
export class ArchiveOnMergeCoordinator {
  private timer?: ReturnType<typeof setTimeout> | undefined;
  private busy = false;
  private stopped = false;
  private generation = 0;
  private abort?: AbortController | undefined;
  private projectCursor = 0;
  private readonly cursors = new Map<string, number>();
  private readonly pending = new Map<string, PendingMergeSet>();
  private readonly failures = new Map<string, { count: number; nextAt: number }>();

  constructor(private readonly deps: ArchiveOnMergeDeps, private readonly interval = 60_000) {}

  start(): void {
    if (this.timer || this.busy) return;
    this.stopped = false;
    const poll = async () => {
      await this.tick();
      if (!this.stopped) { this.timer = setTimeout(poll, this.interval); this.timer.unref?.(); }
    };
    this.timer = setTimeout(poll, 0); this.timer.unref?.();
  }

  stop(): void {
    this.stopped = true; this.invalidate();
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** A saved preference invalidates lookups already in flight, even if changed back quickly. */
  invalidate(): void { this.generation++; this.abort?.abort(); this.pending.clear(); }

  async tick(): Promise<void> {
    if (this.busy || this.stopped) return;
    this.busy = true;
    const generation = this.generation;
    const abort = new AbortController(); this.abort = abort;
    const timeout = setTimeout(() => abort.abort(), 30_000); timeout.unref?.();
    const current = () => !this.stopped && generation === this.generation && !abort.signal.aborted;
    try {
      const projects = (await this.deps.projects()).filter(project => project.status !== 'missing');
      const ids = new Set(projects.map(project => project.id));
      for (const id of this.cursors.keys()) if (!ids.has(id)) { this.cursors.delete(id); this.failures.delete(id); }
      for (const [key, state] of this.pending) if (!ids.has(state.projectId)) this.pending.delete(key);
      if (!projects.length || !current()) return;
      // Four projects per tick avoids a minute per unopened project. Each project remains bounded.
      for (let i = 0; i < Math.min(4, projects.length) && current(); i++) {
        const project = projects[this.projectCursor++ % projects.length]!;
        await this.tickProject(project, abort.signal, current);
      }
    } catch {
      // A registry outage leaves tasks visible until the next bounded poll.
    } finally {
      clearTimeout(timeout); this.abort = undefined; this.busy = false;
    }
  }
  private async tickProject(project: ArchiveProject, signal: AbortSignal, current: () => boolean): Promise<void> {
    let roots: string[] = [];
    try {
      if ((this.failures.get(project.id)?.nextAt ?? 0) > Date.now() || !await this.deps.enabled(project) || !current()) return;
      const repoBase = await this.deps.repository(project);
      const snapshots = await this.collectArchiveSnapshots(project, repoBase, current);
      if (!snapshots?.length || !current()) return;
      roots = snapshots.map(snapshot => snapshot.rootId);
      const requests = this.queueMergeLookups(project, snapshots);
      if (!requests.size) return;
      const observed = await this.deps.lookup(project.root, [...requests.values()], signal);
      if (!current()) return;
      await this.applyMergeObservations(project, snapshots, observed, repoBase, current);
      this.failures.delete(project.id);
    } catch {
      await this.recordProjectFailure(project, roots, current);
    }
  }

  private async collectArchiveSnapshots(
    project: ArchiveProject, repoBase: string | undefined, current: () => boolean,
  ): Promise<ArchiveOnMergeSnapshot[] | undefined> {
    return this.deps.withStore(project, async (store, isActive, valid) => {
      if (!current() || !valid()) return [];
      const pending = await this.pendingArchiveSnapshots(project, store, repoBase, isActive, current, valid);
      if (!pending) return [];
      if (pending.length) return pending;
      return this.pageArchiveSnapshots(project, store, repoBase, isActive, current, valid);
    });
  }

  private async pendingArchiveSnapshots(
    project: ArchiveProject, store: RunStore, repoBase: string | undefined,
    isActive: (id: string) => boolean, current: () => boolean, valid: () => boolean,
  ): Promise<ArchiveOnMergeSnapshot[] | undefined> {
    const out: ArchiveOnMergeSnapshot[] = [];
    // Finish admitted large sets before moving the page cursor. Revalidate even when
    // a run stopped being a candidate so stale entries cannot hold capacity forever.
    for (const [key, state] of this.pending) {
      if (state.projectId !== project.id) continue;
      await store.prepareArchiveOnMerge(state.rootId);
      if (!current() || !valid()) return;
      const snapshot = store.archiveOnMergeSnapshot(state.rootId, repoBase, isActive);
      if (!snapshot) this.pending.delete(key);
      else out.push(snapshot);
      if (out.length === 4) return out;
    }
    return out;
  }

  private async pageArchiveSnapshots(
    project: ArchiveProject, store: RunStore, repoBase: string | undefined,
    isActive: (id: string) => boolean, current: () => boolean, valid: () => boolean,
  ): Promise<ArchiveOnMergeSnapshot[]> {
    const out: ArchiveOnMergeSnapshot[] = [];
    const page = store.listArchiveOnMergeCandidates(this.cursors.get(project.id) ?? 0, 64);
    this.cursors.set(project.id, page.length === 64 ? page.at(-1)!.seq : 0);
    for (const candidate of page) {
      if (!store.hasArchiveOnMergeAssociations(candidate.id)) continue;
      await store.prepareArchiveOnMerge(candidate.id);
      if (!current() || !valid()) break;
      const snapshot = store.archiveOnMergeSnapshot(candidate.id, repoBase, isActive);
      if (snapshot) out.push(snapshot);
      if (out.length === 4) { this.cursors.set(project.id, candidate.seq); break; }
    }
    return out;
  }

  private queueMergeLookups(
    project: ArchiveProject, snapshots: readonly ArchiveOnMergeSnapshot[],
  ): Map<string, ArchivePullRequestIdentity> {
    const requests = new Map<string, ArchivePullRequestIdentity>();
    for (const snapshot of snapshots) {
      const key = `${project.id}:${snapshot.rootId}`;
      let state = this.pending.get(key);
      if (!state || state.token !== snapshot.token) {
        if (!state && this.pending.size >= 32) continue;
        state = { projectId: project.id, rootId: snapshot.rootId, token: snapshot.token, offset: 0, merged: new Map() }; this.pending.set(key, state);
      }
      // Large merge sets progress across ticks; never truncate a set into archive authority.
      for (const pr of snapshot.pullRequests.slice(state.offset, state.offset + 64)) requests.set(pullRequestKey(pr), pr);
    }
    return requests;
  }

  private async applyMergeObservations(
    project: ArchiveProject, snapshots: readonly ArchiveOnMergeSnapshot[],
    observed: readonly MergedPullRequest[], repoBase: string | undefined, current: () => boolean,
  ): Promise<void> {
    const observedByKey = new Map(observed.map(pr => [pullRequestKey(pr), pr]));
    for (const snapshot of snapshots) {
      const key = `${project.id}:${snapshot.rootId}`, state = this.pending.get(key);
      if (!state) continue;
      for (const pr of snapshot.pullRequests.slice(state.offset, state.offset + 64)) {
        const observation = observedByKey.get(pullRequestKey(pr));
        if (observation) state.merged.set(pullRequestKey(pr), observation);
      }
      state.offset += 64;
      if (state.offset < snapshot.pullRequests.length) continue;
      await this.completePendingSnapshot(project, snapshot, state, key, repoBase, current);
    }
  }

  private async completePendingSnapshot(
    project: ArchiveProject, snapshot: ArchiveOnMergeSnapshot, state: PendingMergeSet,
    key: string, repoBase: string | undefined, current: () => boolean,
  ): Promise<void> {
    state.offset = 0;
    if (state.merged.size !== snapshot.pullRequests.length) {
      const missing = snapshot.pullRequests.find(pr => !state.merged.has(pullRequestKey(pr)));
      if (missing) await this.recordMissingMerge(project, snapshot, missing, repoBase, current);
      this.pending.delete(key); return;
    }
    await this.commitMergedSnapshot(project, snapshot, state, repoBase, current);
    this.pending.delete(key);
  }

  private async recordMissingMerge(
    project: ArchiveProject, snapshot: ArchiveOnMergeSnapshot, missing: ArchivePullRequestIdentity,
    repoBase: string | undefined, current: () => boolean,
  ): Promise<void> {
    await this.deps.withStore(project, async (store, _active, valid) => {
      if (current() && valid()) store.archiveMergeBlocker(snapshot, missing, repoBase);
    });
  }

  private async commitMergedSnapshot(
    project: ArchiveProject, snapshot: ArchiveOnMergeSnapshot, state: PendingMergeSet,
    repoBase: string | undefined, current: () => boolean,
  ): Promise<void> {
    await this.deps.withStore(project, async (store, isActive, valid) => {
      if (!await this.archiveSnapshotStillValid(project, repoBase, current, valid)) return;
      await store.prepareArchiveOnMerge(snapshot.rootId);
      if (!current() || !valid()) return;
      store.archiveAfterMerge(snapshot, [...state.merged.values()], repoBase, isActive);
    });
  }

  private async archiveSnapshotStillValid(
    project: ArchiveProject, repoBase: string | undefined, current: () => boolean, valid: () => boolean,
  ): Promise<boolean> {
    if (!await this.deps.enabled(project) || !current() || !valid()) return false;
    const registered = (await this.deps.projects()).some(p => p.id === project.id && p.root === project.root && p.status !== 'missing');
    if (!registered || !current() || !valid()) return false;
    if (await this.deps.repository(project) !== repoBase || !current() || !valid()) return false;
    return true;
  }

  private async recordProjectFailure(project: ArchiveProject, roots: readonly string[], current: () => boolean): Promise<void> {
    if (!current()) return;
    await this.deps.withStore(project, async (store, _active, valid) => {
      if (current() && valid()) for (const id of roots) store.setArchiveBlocker(id, { message: 'Could not confirm PR merge status. Check GitHub or archive manually.' });
    }).catch(() => undefined);
    const count = Math.min(5, (this.failures.get(project.id)?.count ?? 0) + 1);
    this.failures.set(project.id, { count, nextAt: Date.now() + Math.min(900_000, this.interval * 2 ** (count - 1)) });
  }

}
