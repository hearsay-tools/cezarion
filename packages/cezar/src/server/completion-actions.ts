import type { RunRecord, RunStore } from '../runs/store.ts';
import { archivePullRequests, pullRequestKey } from '../runs/pull-requests.ts';
import type { ArchiveProject } from './archive-on-merge.ts';
import type { ForgeDriver, ForgePrMergeState } from './forge/types.ts';

export interface CompletionActionDeps {
  projects(): Promise<readonly ArchiveProject[]>;
  withStore<T>(project: ArchiveProject, work: (store: RunStore, current: () => boolean) => Promise<T>): Promise<T | undefined>;
  forge(project: ArchiveProject): Promise<{ driver: ForgeDriver; repository: string } | undefined>;
  head(project: ArchiveProject, branch: string): Promise<string | undefined>;
}

/** Durable task intent drives bounded background work. No browser, agent, or recovery is needed. */
export class CompletionActionCoordinator {
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private busy = false;
  private projectCursor = 0;
  private readonly cursors = new Map<string, number>();
  private readonly retries = new Map<string, { attempts: number; nextAt: number }>();

  constructor(private readonly deps: CompletionActionDeps, private readonly interval = 15_000) {}

  start(): void {
    if (this.timer || this.busy) return;
    this.stopped = false;
    const poll = async () => {
      await this.tick();
      if (!this.stopped) { this.timer = setTimeout(poll, this.interval); this.timer.unref?.(); }
    };
    this.timer = setTimeout(poll, 0); this.timer.unref?.();
  }

  stop(): void { this.stopped = true; if (this.timer) clearTimeout(this.timer); this.timer = undefined; }

  async tick(): Promise<void> {
    if (this.busy || this.stopped) return;
    this.busy = true;
    try {
      const projects = (await this.deps.projects()).filter(project => project.status !== 'missing');
      const ids = new Set(projects.map(project => project.id));
      for (const id of this.cursors.keys()) if (!ids.has(id)) this.cursors.delete(id);
      // Four projects and four tasks per project. Keyset cursors keep blocked tasks fair.
      for (let i = 0; i < Math.min(4, projects.length) && !this.stopped; i++) {
        const project = projects[this.projectCursor++ % projects.length]!;
        await this.deps.withStore(project, async (store, valid) => {
          if (!valid() || this.stopped) return;
          const page = store.listCompletionCandidates(this.cursors.get(project.id) ?? 0, 16);
          this.cursors.set(project.id, page.length === 16 ? page.at(-1)!.seq : 0);
          let admitted = 0;
          for (const item of page) {
            if (!valid() || this.stopped) break;
            const saved = store.getRun(item.id), run = saved ? { ...saved } : undefined, token = run?.completionAction?.id;
            if (!run || !token) continue;
            const key = `${project.id}:${run.id}:${token}`;
            if ((this.retries.get(key)?.nextAt ?? 0) > Date.now()) continue;
            const current = () => {
              if (this.stopped || !valid()) return false;
              const latest = store.getRun(item.id);
              return store.canCompleteAction(item.id, token) && latest?.branch === run.branch;
            };
            try {
              if (!current()) continue;
              store.pin(run.id, 'maintenance');
              if (!store.claimCompletionAction(run.id, token)) continue;
              await store.prepareArchiveOnMerge(run.id);
              if (!current()) continue;
              const result = await this.process(project, run, current);
              if (result === undefined || !current()) continue;
              store.completeAction(run.id, token, result ? 'blocked' : 'complete', result);
              if (result) this.backoff(key); else this.retries.delete(key);
            } catch {
              if (current()) {
                store.completeAction(run.id, token, 'blocked', 'PR auto-merge is unavailable. Check GitHub, retry later, or turn it off.');
                this.backoff(key);
              }
            } finally { store.unpin(run.id, 'maintenance'); }
            if (++admitted === 4) { this.cursors.set(project.id, item.seq); break; }
          }
        }).catch(() => undefined); // An unavailable project cannot stop the other projects.
      }
      while (this.retries.size > 1024) this.retries.delete(this.retries.keys().next().value!);
    } finally { this.busy = false; }
  }

  private backoff(key: string): void {
    const attempts = Math.min(6, (this.retries.get(key)?.attempts ?? 0) + 1);
    this.retries.delete(key);
    this.retries.set(key, { attempts, nextAt: Date.now() + Math.min(300_000, this.interval * 2 ** (attempts - 1)) });
  }

  /** undefined means intent changed; empty string means all verified work is complete. */
  private async process(project: ArchiveProject, run: RunRecord, current: () => boolean): Promise<string | undefined> {
    if (!run.autoMergePr) return '';
    const created = run.pullRequests?.filter(pr => pr.source === 'created') ?? [];
    if (run.pullRequestUrl && !created.some(pr => pr.url === run.pullRequestUrl)) {
      const number = Number(/\/pull\/([1-9][0-9]*)\/?$/.exec(run.pullRequestUrl)?.[1]);
      if (number) created.push({ number, url: run.pullRequestUrl, source: 'created' });
    }
    if (!created.length) {
      if (run.pullRequests?.length || run.referencedPullRequestUrl || run.prNumber || run.markerRefs?.pr)
        return 'No PR is verified as created by this task. Check its PR association, merge manually, or turn off Auto-merge PR.';
      return '';
    }
    if (!run.branch || (!run.worktreePath && run.delegation?.role !== 'worker'))
      return 'The task has no owned branch. Merge its PR manually or turn off Auto-merge PR.';
    if (created.length > 16) return 'Too many created PRs to merge automatically. Review and merge them manually.';
    const resolved = await this.deps.forge(project);
    if (!current()) return;
    if (!resolved) return 'PR auto-merge is unavailable for this repository. Merge manually or turn it off.';
    const { driver, repository } = resolved;
    if (!driver.prMergeState || !driver.mergePR) return 'PR auto-merge is unavailable for this repository. Merge manually or turn it off.';
    const local = archivePullRequests([{ pullRequests: created.map(pr => ({ ...pr, url: pr.url ?? '' })) }], repository);
    const own = archivePullRequests([{ pullRequestUrl: `${repository}/pull/1` }], repository)?.[0];
    if (!local || !own || local.some(pr => pr.owner !== own.owner || pr.repo !== own.repo))
      return 'A created PR has an unknown or different repository. Check its association or merge manually.';
    const head = await this.deps.head(project, run.branch);
    if (!current()) return;
    if (!head) return 'The task branch is unavailable. Restore it or merge the PR manually.';
    for (const identity of local) {
      let result = await driver.prMergeState(identity.number, { refresh: true });
      if (!current()) return;
      if (!result.available) return result.reason;
      let state = result.mergeState;
      const ownership = () => state.headRef === run.branch && state.headSha === head &&
        archivePullRequests([{ pullRequestUrl: state.url }], repository)?.some(pr => pullRequestKey(pr) === pullRequestKey(identity));
      if (!ownership()) return 'The PR branch or head differs from this task. Review and push the task branch before retrying.';
      if (state.state === 'merged') continue; // Reconcile a successful mutation whose response was lost.
      if (state.state !== 'open') return 'The task PR is closed without a merge. Reopen it or turn off Auto-merge PR.';
      if (state.isDraft) {
        if (!driver.readyPR) return 'The task PR is a draft. Mark it ready or turn off Auto-merge PR.';
        result = await driver.readyPR(identity.number, { expectedHeadSha: head, expectedHeadRef: run.branch, canProceed: current });
        if (!current()) return;
        if (!result.available) return result.reason;
        state = result.mergeState;
        if (!ownership()) return 'The PR changed while it was marked ready. Review its branch and head.';
      }
      const blocker = mergeBlocker(state);
      if (blocker) return blocker;
      // Re-read local branch before the mutation; the forge re-reads remote state and intent.
      if (await this.deps.head(project, run.branch) !== head || !current()) return current() ? 'The task branch changed. Wait for CI on the new head.' : undefined;
      const merged = await driver.mergePR(identity.number, { method: state.defaultMethod!, expectedHeadSha: head,
        expectedHeadRef: run.branch, requirePassingChecks: true, canProceed: current });
      if (!current()) return;
      if (!merged.merged) return merged.error;
    }
    return '';
  }
}

function mergeBlocker(state: ForgePrMergeState): string | undefined {
  if (state.isDraft) return 'The PR is still a draft. Mark it ready or merge manually.';
  if (!state.checks.length) return 'Waiting for CI checks on the current PR head.';
  if (state.checks.some(check => check.state !== 'passing')) return 'Waiting for all CI checks on the current PR head to pass.';
  if (!state.canMerge) return state.blockers.map(blocker => blocker.message).join(' ') || 'Waiting for GitHub review and branch requirements.';
  if (!state.defaultMethod || !state.methods.includes(state.defaultMethod)) return 'The repository has no permitted merge method. Merge manually.';
  return undefined;
}
