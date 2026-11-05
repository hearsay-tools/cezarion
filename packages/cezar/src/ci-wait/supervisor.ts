import { setTimeout as delay } from 'node:timers/promises';
import { ciWaitSchema, ciWaitResultSchema, type CiPrIdentity, type CiWait, type CiWaitResult } from '@open-mercato/cezar-contract/ci-wait';
import { CiGithubError, CiSemaphore, GithubCiClient, type GithubCheck, type GithubPrMergeState, type GithubPrMetadata } from './github.ts';
import type { GithubMergeRequest } from './merge-progress.ts';
import { CiProgressRegistry } from './progress.ts';
import { stripTerminal } from './text.ts';

export const CI_WATCHER_LIMIT = 4;
/** PR-head probes, absent-check rechecks, and stale-watch rechecks. Not the discovery deadline. */
export const CI_PROBE_MS = 30_000;
export const CI_DISCOVERY_MS = 60_000;
export const CI_RETRY_MS = [1_000, 5_000, 15_000] as const;
export const CI_RESULT_LIMIT = 32 * 1024;

function clean(value: string, max: number): string {
  return stripTerminal(value).slice(0, max);
}
function safeLink(value: string): string {
  if (value.length > 2048 || /[\x00-\x20\x7f]/.test(value)) return '';
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return '';
    return url.href.length <= 2048 ? url.href : '';
  } catch { return ''; }
}
function transientQuery(error: unknown): error is CiGithubError {
  return error instanceof CiGithubError && (error.code === 'command_failed' || error.code === 'query_timeout');
}
function failureDiagnostic(error: unknown): string {
  return error instanceof CiGithubError ? `${error.code}: ${error.message}` : 'unavailable: CI watcher failed; register a new wait.';
}
function outcome(checks: GithubCheck[]): CiWaitResult['outcome'] | undefined {
  if (!checks.length || checks.some(c => c.bucket === 'pending')) return undefined;
  if (checks.some(c => c.bucket === 'fail')) return 'failed';
  if (checks.some(c => c.bucket === 'cancel')) return 'cancelled';
  if (checks.some(c => c.bucket === 'pass')) return 'passed';
  return 'skipped';
}
type ObservationExtra = Partial<Pick<CiWaitResult, 'observedHeadSha' | 'diagnostic' | 'mergeable' | 'mergeStateStatus' | 'mergedAt' | 'mergeCommitSha' | 'mergeBlock'>>;
function blockedMerge(state: GithubPrMergeState, request: GithubMergeRequest): ObservationExtra | undefined {
  const conflict = state.mergeable === 'CONFLICTING';
  if (!conflict && (request.isInMergeQueue || request.autoMergeEnabled)) return undefined;
  return { mergeBlock: { ...request, reason: conflict ? 'conflict' : 'no_pending_merge' },
    diagnostic: conflict ? 'The initiated merge conflicts with its base. Inspect the PR before taking action.'
      : 'No merge is pending: the PR is neither queued nor scheduled for auto-merge. Inspect the external evidence before taking action.' };
}
function observation(wait: CiWait, result: CiWaitResult['outcome'], rows: GithubCheck[], extra: ObservationExtra = {}): CiWaitResult {
  const checks = rows.slice(0, 100).map(row => ({name:clean(row.name,256),state:clean(row.state,256),link:safeLink(row.link)}));
  const value: CiWaitResult = { outcome: result, headSha: wait.headSha, observedAt: new Date().toISOString(), checks, totalChecks: rows.length, truncated: rows.length > checks.length || rows.some((row,i) => i < checks.length && (row.name !== checks[i]!.name || row.state !== checks[i]!.state || row.link !== checks[i]!.link)), ...extra };
  while (Buffer.byteLength(JSON.stringify(value)) > CI_RESULT_LIMIT && checks.length) { checks.pop(); value.truncated = true; }
  return ciWaitResultSchema.parse(value);
}

/** One shared instance per workspace; queues watchers FIFO without extending their deadlines. */
export class CiWatcherSupervisor {
  private readonly lifetime = new AbortController();
  private readonly slots = new CiSemaphore(CI_WATCHER_LIMIT);
  private readonly github: GithubCiClient;
  private readonly current = new Map<string, Promise<CiWaitResult>>();
  /** The check progress of each watched wait, for the activity view. It never decides an outcome. */
  private readonly progress: CiProgressRegistry;
  /** The one extra checks read in flight across the supervisor, and its wait. */
  private progressRead: { waitId: string; abort: AbortController } | undefined;
  constructor(options: { github?: GithubCiClient; progress?: CiProgressRegistry } = {}) {
    this.github = options.github ?? new GithubCiClient();
    this.progress = options.progress ?? new CiProgressRegistry();
  }

  async resolve(pr: string, signal?: AbortSignal): Promise<CiPrIdentity> {
    const bounded = AbortSignal.any([this.lifetime.signal, ...(signal ? [signal] : []), AbortSignal.timeout(10_000)]);
    try { return await this.github.resolve(pr, bounded); }
    catch (error) { if (bounded.aborted && !this.lifetime.signal.aborted && !signal?.aborted) throw new CiGithubError('query_timeout', 'PR registration exceeded ten seconds; retry when GitHub is available.'); throw error; }
  }
  watch(wait: CiWait, signal: AbortSignal): Promise<CiWaitResult> {
    const existing = this.current.get(wait.id);
    if (existing) return existing;
    const task = this.run(wait, signal).finally(() => {
      this.current.delete(wait.id);
      if (this.progressRead?.waitId === wait.id) {
        this.progressRead.abort.abort();
        this.progressRead = undefined;
      }
      this.progress.remove(wait.id);
    });
    this.current.set(wait.id, task);
    return task;
  }
  close(): void { this.lifetime.abort(); }

  /**
   * Poll a merge wait every `CI_PROBE_MS`, the first read at once, taking the client's query permit
   * per read and never a watcher slot. `MERGED` → `merged`, `CLOSED` → `closed`, a conflict →
   * `conflicting` when the wait wakes on one; a head change and green checks keep it open.
   * Transient failures retry inside the deadline, which then names the last one.
   */
  private async runMerge(wait: CiWait, caller: AbortSignal, signal: AbortSignal): Promise<CiWaitResult> {
    let last: GithubPrMergeState | undefined;
    let lastQueryError: CiGithubError | undefined;
    let retry = 0;
    const observe = (result: CiWaitResult['outcome'], extra: ObservationExtra = {}) => observation(wait, result, [], {
      ...(last ? { mergeable: last.mergeable, mergeStateStatus: last.mergeStateStatus } : {}),
      ...(last && last.headSha !== wait.headSha ? { observedHeadSha: last.headSha } : {}),
      ...extra,
    });
    const failed = (error: unknown) => observe('error', {diagnostic: failureDiagnostic(error)});
    const stopped = () => {
      const cancelled = caller.aborted || this.lifetime.signal.aborted;
      return observe(cancelled ? 'cancelled' : 'deadline', !cancelled && lastQueryError ? { diagnostic: `${lastQueryError.code}: ${lastQueryError.message}` } : {});
    };
    while (!signal.aborted) {
      try {
        const progress = wait.until === 'merge_or_blocked' ? await this.github.mergeProgress(wait, signal) : undefined;
        last = progress ?? await this.github.mergeState(wait, signal);
        signal.throwIfAborted();
        retry = 0; lastQueryError = undefined;
        if (last.state === 'MERGED') return observe('merged', { ...(last.mergedAt ? { mergedAt: last.mergedAt } : {}), ...(last.mergeCommitSha ? { mergeCommitSha: last.mergeCommitSha } : {}) });
        if (last.state === 'CLOSED') return observe('closed', {diagnostic: 'The pull request was closed without merging.'});
        const blocked = progress && blockedMerge(last, progress.mergeRequest);
        if (blocked) return observe('blocked', blocked);
        if (wait.wakeOnConflict && last.mergeable === 'CONFLICTING') {
          return observe('conflicting', {diagnostic: 'The pull request conflicts with its base and cannot merge until someone resolves it.'});
        }
        await delay(CI_PROBE_MS, undefined, { signal });
      } catch (error) {
        if (signal.aborted) return stopped();
        if (transientQuery(error)) {
          lastQueryError = error;
          const retryMs = CI_RETRY_MS[retry] ?? CI_PROBE_MS;
          retry = Math.min(retry + 1, CI_RETRY_MS.length);
          try { await delay(retryMs, undefined, { signal }); } catch { return stopped(); }
          continue;
        }
        return failed(error);
      }
    }
    return stopped();
  }

  /**
   * The `--watch` phase's extra checks read (spec 2026-11-05-live-activity-view), only while someone
   * watches the wait's project. It updates the progress and nothing else: its rows never reach
   * `observe`, and a failed read keeps the last progress and is not an error. The loop never awaits
   * it, so a slow read delays neither a --watch completion nor the next head probe. It takes none of
   * the client's query permits (`progressChecks`), which stay with the outcome queries; one read runs
   * across the supervisor, so a probe that finds one in flight skips its own. The end of the watch
   * aborts it, and an aborted read publishes nothing.
   */
  private startProgressRead(wait: CiWait, signal: AbortSignal): void {
    if (this.progressRead || !this.progress.wanted(wait.id)) return;
    const own = new AbortController();
    const readSignal = AbortSignal.any([signal, own.signal]);
    const read = this.github.progressChecks(wait, readSignal);
    const entry = { waitId: wait.id, abort: own };
    this.progressRead = entry;
    void read.then(rows => {
      if (!readSignal.aborted) this.progress.publish(wait.id, rows);
    }, () => {
      // The wait continues on the head probe and the --watch process.
    }).finally(() => {
      if (this.progressRead === entry) this.progressRead = undefined;
    });
  }

  /** Own one gh checks watcher until it exits, including abort cleanup, while probing PR changes. */
  private async watchChecks(wait: CiWait, signal: AbortSignal, snapshot: () => Promise<CiWaitResult | undefined>,
    probe: () => Promise<CiWaitResult | undefined>): Promise<CiWaitResult | undefined> {
    const watchAbort = new AbortController();
    const watchSignal = AbortSignal.any([signal, watchAbort.signal]);
    // Attach a rejection handler immediately; the watcher may finish during a head probe.
    const watcher = this.github.watch(wait, watchSignal).then(() => ({ done: true as const }), error => ({ done: true as const, error }));
    try {
      while (!signal.aborted) {
        const tick = new AbortController();
        const next = await Promise.race([watcher, delay(CI_PROBE_MS, { done: false as const },
          { signal: AbortSignal.any([signal, tick.signal]) }).catch(() => ({ done: false as const }))]);
        tick.abort();
        signal.throwIfAborted();
        if (next.done) {
          if ('error' in next) throw next.error;
          const final = await snapshot();
          if (final) return final;
          // A stale CLI watch completion never turns a pending snapshot into success.
          await delay(CI_PROBE_MS, undefined, { signal });
          break;
        }
        const changed = await probe();
        if (changed) return changed;
      }
      return undefined;
    } finally {
      watchAbort.abort();
      // Capacity is retained until the owned child (including forced termination) exits.
      await watcher;
    }
  }

  private async run(wait: CiWait, caller: AbortSignal): Promise<CiWaitResult> {
    const remaining = Date.parse(wait.deadline) - Date.now();
    if (!ciWaitSchema.safeParse(wait).success) return observation({ ...wait, headSha: /^[0-9a-f]{40}$/i.test(wait.headSha ?? '') ? wait.headSha : '0'.repeat(40) }, 'error', [], { diagnostic: 'malformed_data: Persisted CI wait is invalid; an all-zero head denotes an unavailable original identity. Register a new wait.' });
    const deadline = AbortSignal.timeout(Math.max(0, Math.min(remaining, 7_200_000)));
    const signal = AbortSignal.any([caller, this.lifetime.signal, deadline]);
    let rows: GithubCheck[] = [];
    let workflowActive = false;
    let release: (() => void) | undefined;
    let retry = 0;
    let lastQueryError: CiGithubError | undefined;
    const discoveryDeadline = Math.min(Date.parse(wait.deadline), Date.now() + CI_DISCOVERY_MS);
    let metadata: GithubPrMetadata | undefined;
    const observe = (result: CiWaitResult['outcome'], extra: Partial<Pick<CiWaitResult, 'observedHeadSha' | 'diagnostic'>> = {}) =>
      observation(wait, result, rows, { ...(metadata ? { mergeable: metadata.mergeable, mergeStateStatus: metadata.mergeStateStatus } : {}), ...extra });
    const readMetadata = async () => {
      const value = await this.github.metadata(wait, signal);
      signal.throwIfAborted();
      metadata = value;
      return value;
    };
    // A PR the agent does not own may conflict without ending its wait (hearsay-tools/cezarion#1425).
    const conflict = () => wait.wakeOnConflict !== false && metadata?.mergeable === 'CONFLICTING'
      ? observe('conflicting', {diagnostic: 'The pull request conflicts with its base. Inspect the PR; this observation does not authorize a repair or merge.'})
      : undefined;
    const stopped = () => {
      const cancelled = caller.aborted || this.lifetime.signal.aborted;
      return observe(cancelled ? 'cancelled' : 'deadline', !cancelled && lastQueryError
        ? { diagnostic: `${lastQueryError.code}: ${lastQueryError.message}` } : {});
    };
    if (remaining <= 0 || signal.aborted) return stopped();
    // A merge wait polls the PR's state and holds no watcher slot (hearsay-tools/cezarion#1425).
    if (wait.until !== 'checks') return this.runMerge(wait, caller, signal);
    const snapshot = async (): Promise<CiWaitResult | undefined> => {
      const before = (await readMetadata()).headSha;
      if (before !== wait.headSha) return observe('head_changed', { observedHeadSha: before });
      workflowActive = await this.github.hasActiveRuns(wait, signal);
      const observed = await this.github.checks(wait, signal);
      const after = (await readMetadata()).headSha;
      if (after !== wait.headSha) return observe('head_changed', { observedHeadSha: after });
      rows = observed;
      this.progress.publish(wait.id, observed);
      const conflicting = conflict();
      if (conflicting) return conflicting;
      const settled = workflowActive ? undefined : outcome(rows);
      return settled ? observe(settled) : undefined;
    };
    try {
      release = await this.slots.acquire(signal);
      while (!signal.aborted) {
        try {
          const settled = await snapshot();
          retry = 0; lastQueryError = undefined;
          if (settled) return settled;
          // A rerun may hide all its checks, making gh --watch exit immediately.
          // Probe the workflow itself without spinning or spending model turns.
          if (workflowActive) {
            await delay(CI_PROBE_MS, undefined, { signal });
            continue;
          }
          if (!rows.length) {
            if (Date.now() >= discoveryDeadline) return observe('no_checks');
            await delay(Math.min(CI_PROBE_MS, discoveryDeadline - Date.now()), undefined, { signal });
            continue;
          }
          const final = await this.watchChecks(wait, signal, snapshot, async () => {
            const head = (await readMetadata()).headSha;
            if (head !== wait.headSha) return observe('head_changed', { observedHeadSha: head });
            const conflicting = conflict();
            if (!conflicting) this.startProgressRead(wait, signal);
            return conflicting;
          });
          if (final) return final;
        } catch (error) {
          if (signal.aborted) return stopped();
          if (transientQuery(error)) {
            lastQueryError = error;
            // Retain the initial backoff, then use the normal probe interval.
            // The original deadline and cancellation signal bound every retry.
            const retryMs = CI_RETRY_MS[retry] ?? CI_PROBE_MS;
            retry = Math.min(retry + 1, CI_RETRY_MS.length);
            await delay(retryMs, undefined, {signal});
            continue;
          }
          return observe('error', {diagnostic:failureDiagnostic(error)});
        }
      }
      return stopped();
    } catch (error) {
      if (signal.aborted) return stopped();
      return observe('error', {diagnostic:failureDiagnostic(error)});
    } finally { release?.(); }
  }
}
