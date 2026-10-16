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
interface PendingMergeSet { token: string; offset: number; merged: Map<string, MergedPullRequest> }

/** One browser-independent workspace poller. Never builds a manager or recovers a run. */
export class ArchiveOnMergeCoordinator {
  private timer?: ReturnType<typeof setTimeout>;
  private busy = false;
  private stopped = false;
  private generation = 0;
  private abort?: AbortController;
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
      if (!projects.length || !current()) return;
      // One project, at most 64 indexed roots and four merge sets per tick.
      const project = projects[this.projectCursor++ % projects.length]!;
      if ((this.failures.get(project.id)?.nextAt ?? 0) > Date.now() || !await this.deps.enabled(project) || !current()) return;
      const repoBase = await this.deps.repository(project);
      const snapshots = await this.deps.withStore(project, async (store, isActive, valid) => {
        if (!current() || !valid()) return [];
        const page = store.listArchiveOnMergeCandidates(this.cursors.get(project.id) ?? 0, 64);
        this.cursors.set(project.id, page.length === 64 ? page.at(-1)!.seq : 0);
        const out: ArchiveOnMergeSnapshot[] = [];
        for (const candidate of page) {
          if (!store.hasArchiveOnMergeAssociations(candidate.id)) continue;
          await store.prepareArchiveOnMerge(candidate.id);
          if (!current() || !valid()) break;
          const snapshot = store.archiveOnMergeSnapshot(candidate.id, repoBase, isActive);
          if (snapshot) out.push(snapshot);
          if (out.length === 4) { this.cursors.set(project.id, candidate.seq); break; }
        }
        return out;
      });
      if (!snapshots?.length || !current()) return;
      const requests = new Map<string, ArchivePullRequestIdentity>();
      for (const snapshot of snapshots) {
        const key = `${project.id}:${snapshot.rootId}`;
        let state = this.pending.get(key);
        if (!state || state.token !== snapshot.token) {
          state = { token: snapshot.token, offset: 0, merged: new Map() }; this.pending.set(key, state);
        }
        // Large merge sets progress across ticks; never truncate a set into archive authority.
        for (const pr of snapshot.pullRequests.slice(state.offset, state.offset + 64)) requests.set(pullRequestKey(pr), pr);
      }
      while (this.pending.size > 32) this.pending.delete(this.pending.keys().next().value!);
      const observed = await this.deps.lookup(project.root, [...requests.values()], abort.signal);
      if (!current()) return;
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
        state.offset = 0;
        if (state.merged.size !== snapshot.pullRequests.length) continue;
        await this.deps.withStore(project, async (store, isActive, valid) => {
          if (!await this.deps.enabled(project) || !current() || !valid()) return;
          const registered = (await this.deps.projects()).some(p => p.id === project.id && p.root === project.root && p.status !== 'missing');
          if (!registered || !current() || !valid()) return;
          if (await this.deps.repository(project) !== repoBase || !current() || !valid()) return;
          await store.prepareArchiveOnMerge(snapshot.rootId);
          if (!current() || !valid()) return;
          store.archiveAfterMerge(snapshot, [...state.merged.values()], repoBase, isActive);
        });
        this.pending.delete(key);
      }
      this.failures.delete(project.id);
    } catch {
      // Network/store errors leave tasks visible. Repeated outages back off, capped at 15 min.
      if (current()) {
        const projects = await this.deps.projects().catch(() => []);
        const project = projects.length ? projects[(this.projectCursor - 1) % projects.length] : undefined;
        if (project) {
          const count = Math.min(5, (this.failures.get(project.id)?.count ?? 0) + 1);
          this.failures.set(project.id, { count, nextAt: Date.now() + Math.min(900_000, this.interval * 2 ** (count - 1)) });
        }
      }
    } finally {
      clearTimeout(timeout); this.abort = undefined; this.busy = false;
    }
  }
}
