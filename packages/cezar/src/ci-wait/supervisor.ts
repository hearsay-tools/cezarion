import { setTimeout as delay } from 'node:timers/promises';
import { ciWaitSchema, ciWaitResultSchema, type CiPrIdentity, type CiWait, type CiWaitResult } from '@open-mercato/cezar-contract/ci-wait';
import { CiGithubError, CiSemaphore, GithubCiClient, type GithubCheck, type GithubPrMetadata } from './github.ts';

export const CI_WATCHER_LIMIT = 4;
/** PR-head probes, absent-check rechecks, and stale-watch rechecks. Not the discovery deadline. */
export const CI_PROBE_MS = 30_000;
export const CI_DISCOVERY_MS = 60_000;
export const CI_RETRY_MS = [1_000, 5_000, 15_000] as const;
export const CI_RESULT_LIMIT = 32 * 1024;

function clean(value: string, max: number): string {
  return value.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x1f\x7f-\x9f]/g, '').slice(0, max);
}
function safeLink(value: string): string {
  if (value.length > 2048 || /[\x00-\x20\x7f]/.test(value)) return '';
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return '';
    return url.href.length <= 2048 ? url.href : '';
  } catch { return ''; }
}
function outcome(checks: GithubCheck[]): CiWaitResult['outcome'] | undefined {
  if (!checks.length || checks.some(c => c.bucket === 'pending')) return undefined;
  if (checks.some(c => c.bucket === 'fail')) return 'failed';
  if (checks.some(c => c.bucket === 'cancel')) return 'cancelled';
  if (checks.some(c => c.bucket === 'pass')) return 'passed';
  return 'skipped';
}
function observation(wait: CiWait, result: CiWaitResult['outcome'], rows: GithubCheck[], extra: Partial<Pick<CiWaitResult, 'observedHeadSha' | 'diagnostic'>> = {}): CiWaitResult {
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
  constructor(options: { github?: GithubCiClient } = {}) { this.github = options.github ?? new GithubCiClient(); }

  async resolve(pr: string, signal?: AbortSignal): Promise<CiPrIdentity> {
    const bounded = AbortSignal.any([this.lifetime.signal, ...(signal ? [signal] : []), AbortSignal.timeout(10_000)]);
    try { return await this.github.resolve(pr, bounded); }
    catch (error) { if (bounded.aborted && !this.lifetime.signal.aborted && !signal?.aborted) throw new CiGithubError('query_timeout', 'PR registration exceeded ten seconds; retry when GitHub is available.'); throw error; }
  }
  watch(wait: CiWait, signal: AbortSignal): Promise<CiWaitResult> {
    const existing = this.current.get(wait.id);
    if (existing) return existing;
    const task = this.run(wait, signal).finally(() => { this.current.delete(wait.id); });
    this.current.set(wait.id, task);
    return task;
  }
  close(): void { this.lifetime.abort(); }

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
    const conflict = () => metadata?.mergeable === 'CONFLICTING'
      ? observe('conflicting', {diagnostic: 'The pull request conflicts with its base. Inspect the PR; this observation does not authorize a repair or merge.'})
      : undefined;
    const stopped = () => {
      const cancelled = caller.aborted || this.lifetime.signal.aborted;
      return observe(cancelled ? 'cancelled' : 'deadline', !cancelled && lastQueryError
        ? { diagnostic: `${lastQueryError.code}: ${lastQueryError.message}` } : {});
    };
    if (remaining <= 0 || signal.aborted) return stopped();
    const snapshot = async (): Promise<CiWaitResult | undefined> => {
      const before = (await readMetadata()).headSha;
      if (before !== wait.headSha) return observe('head_changed', { observedHeadSha: before });
      workflowActive = await this.github.hasActiveRuns(wait, signal);
      const observed = await this.github.checks(wait, signal);
      const after = (await readMetadata()).headSha;
      if (after !== wait.headSha) return observe('head_changed', { observedHeadSha: after });
      rows = observed;
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
          const watchAbort = new AbortController();
          const watchSignal = AbortSignal.any([signal, watchAbort.signal]);
          // Attach a rejection handler immediately; the watcher may finish during a head probe.
          const watcher = this.github.watch(wait, watchSignal).then(() => ({done:true as const}), error => ({done:true as const,error}));
          try {
            while (!signal.aborted) {
              const tick = new AbortController();
              const next = await Promise.race([watcher, delay(CI_PROBE_MS, {done:false as const}, {signal:AbortSignal.any([signal,tick.signal])}).catch(() => ({done:false as const}))]);
              tick.abort();
              signal.throwIfAborted();
              if (next.done) {
                if ('error' in next) throw next.error;
                const final = await snapshot();
                if (final) return final;
                // A stale CLI watch completion never turns a pending snapshot into success.
                await delay(CI_PROBE_MS, undefined, {signal});
                break;
              }
              const head = (await readMetadata()).headSha;
              if (head !== wait.headSha) return observe('head_changed', {observedHeadSha:head});
              const conflicting = conflict();
              if (conflicting) return conflicting;
            }
          } finally {
            watchAbort.abort();
            // Capacity is retained until the owned child (including forced termination) exits.
            await watcher;
          }
        } catch (error) {
          if (signal.aborted) return stopped();
          if (error instanceof CiGithubError && (error.code === 'command_failed' || error.code === 'query_timeout')) {
            lastQueryError = error;
            // Retain the initial backoff, then use the normal probe interval.
            // The original deadline and cancellation signal bound every retry.
            const retryMs = CI_RETRY_MS[retry] ?? CI_PROBE_MS;
            retry = Math.min(retry + 1, CI_RETRY_MS.length);
            await delay(retryMs, undefined, {signal});
            continue;
          }
          return observe('error', {diagnostic:error instanceof CiGithubError ? `${error.code}: ${error.message}` : 'unavailable: CI watcher failed; register a new wait.'});
        }
      }
      return stopped();
    } catch (error) {
      if (signal.aborted) return stopped();
      return observe('error', {diagnostic:error instanceof CiGithubError ? `${error.code}: ${error.message}` : 'unavailable: CI watcher failed; register a new wait.'});
    } finally { release?.(); }
  }
}
