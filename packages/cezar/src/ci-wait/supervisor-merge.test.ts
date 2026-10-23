import { afterEach, expect, it, vi } from 'vitest';
import type { CiWait, CiPrIdentity } from '@open-mercato/cezar-contract';
import { CiWatcherSupervisor } from './supervisor.ts';
import { CiGithubError, GithubCiClient, type GithubCheck, type GithubPrMergeState } from './github.ts';

/** A PR wait with `until: 'merge'` (hearsay-tools/cezarion#1425): it polls the PR's state and ends
 *  only on GitHub's merge or close, a conflict it was asked to wake on, an error, its deadline or
 *  cancellation. Passing checks never end it. */

// Vitest does not virtualize node:timers/promises; keep AbortSignal semantics on the fake clock.
vi.mock('node:timers/promises', () => ({setTimeout: (ms: number, value: unknown, options: {signal: AbortSignal}) => new Promise((resolve, reject) => {
  const signal = options.signal;
  if (signal.aborted) { reject(signal.reason); return; }
  const done = () => { signal.removeEventListener('abort', abort); resolve(value); };
  const timer = setTimeout(done, ms);
  const abort = () => { clearTimeout(timer); reject(signal.reason); };
  signal.addEventListener('abort', abort, {once: true});
})}));

const identity: CiPrIdentity = {prUrl: 'https://github.com/org/repo/pull/12', repository: 'org/repo', prNumber: 12, headSha: 'a'.repeat(40)};
const wait = (over: Partial<CiWait> = {}): CiWait => ({...identity, id: crypto.randomUUID(), generation: 'g', turnId: 't', timeoutSeconds: 1800,
  until: 'merge', wakeOnConflict: true, registeredAt: new Date().toISOString(), deadline: new Date(Date.now() + 1_800_000).toISOString(), phase: 'registered', ...over});

class ScriptedGithub extends GithubCiClient {
  reads = 0; checksCalls = 0; watchCalls = 0; failures = 0;
  fatal: CiGithubError | undefined;
  /** The state each read returns, by read number; the last one repeats. */
  states: Array<Partial<GithubPrMergeState>> = [{}];
  override async mergeState(): Promise<GithubPrMergeState> {
    this.reads++;
    if (this.fatal) throw this.fatal;
    if (this.failures-- > 0) throw new CiGithubError('command_failed', 'GitHub query failed; check connectivity and GitHub availability, then retry.', true);
    const step = this.states[Math.min(this.reads - 1, this.states.length - 1)]!;
    return {headSha: identity.headSha, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', state: 'OPEN', ...step};
  }
  override async metadata() { return {headSha: identity.headSha, mergeable: 'MERGEABLE' as const, mergeStateStatus: 'CLEAN'}; }
  override async checks(): Promise<GithubCheck[]> { this.checksCalls++; return [{name: 'build', state: 'SUCCESS', bucket: 'pass', link: ''}]; }
  override async hasActiveRuns(): Promise<boolean> { return false; }
  override async watch(): Promise<void> { this.watchCalls++; }
}

const services: CiWatcherSupervisor[] = [];
const controllers: AbortController[] = [];
function start(github: GithubCiClient, over: Partial<CiWait> = {}, supervisor?: CiWatcherSupervisor) {
  const service = supervisor ?? new CiWatcherSupervisor({github});
  if (!supervisor) services.push(service);
  const controller = new AbortController(); controllers.push(controller);
  return {service, controller, result: service.watch(wait(over), controller.signal)};
}
afterEach(() => { for (const s of services.splice(0)) s.close(); for (const c of controllers.splice(0)) c.abort(); vi.useRealTimers(); });

const merged = {state: 'MERGED' as const, mergedAt: '2026-10-23T09:00:00Z', mergeCommitSha: 'b'.repeat(40)};

it('resolves an already merged PR on the first read', async () => {
  const github = new ScriptedGithub(); github.states = [merged];
  expect(await start(github).result).toMatchObject({outcome: 'merged', mergedAt: '2026-10-23T09:00:00Z', mergeCommitSha: 'b'.repeat(40), checks: [], totalChecks: 0});
  expect(github.reads).toBe(1);
});

it('polls every thirty seconds until GitHub reports the merge, never reading checks', async () => {
  vi.useFakeTimers(); const github = new ScriptedGithub(); github.states = [{}, {}, merged];
  const {result} = start(github); let settled = false; void result.then(() => { settled = true; });
  await vi.advanceTimersByTimeAsync(1); expect(github.reads).toBe(1);
  await vi.advanceTimersByTimeAsync(30_000); expect(github.reads).toBe(2); expect(settled).toBe(false);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(await result).toMatchObject({outcome: 'merged'});
  expect(github.checksCalls).toBe(0); expect(github.watchCalls).toBe(0);
});

it('resolves merged without merge facts when GitHub leaves them null', async () => {
  const github = new ScriptedGithub(); github.states = [{state: 'MERGED'}];
  const result = await start(github).result;
  expect(result.outcome).toBe('merged'); expect(result).not.toHaveProperty('mergedAt'); expect(result).not.toHaveProperty('mergeCommitSha');
});

it('reports a PR closed without merge as closed', async () => {
  const github = new ScriptedGithub(); github.states = [{state: 'CLOSED'}];
  expect((await start(github).result).outcome).toBe('closed');
});

it('wakes on a conflict by default, and keeps waiting through one when told not to', async () => {
  const conflicting = {mergeable: 'CONFLICTING' as const, mergeStateStatus: 'DIRTY'};
  const woken = new ScriptedGithub(); woken.states = [conflicting];
  expect(await start(woken).result).toMatchObject({outcome: 'conflicting', mergeable: 'CONFLICTING'});
  vi.useFakeTimers(); const github = new ScriptedGithub(); github.states = [conflicting, conflicting, merged];
  const {result} = start(github, {wakeOnConflict: false});
  await vi.advanceTimersByTimeAsync(60_000);
  expect(await result).toMatchObject({outcome: 'merged'});
});

it('ranks merged above a conflict seen in the same read', async () => {
  const github = new ScriptedGithub(); github.states = [{...merged, mergeable: 'CONFLICTING'}];
  expect((await start(github).result).outcome).toBe('merged');
});

it('keeps waiting through a head change and reports the last head seen', async () => {
  vi.useFakeTimers(); const github = new ScriptedGithub(); github.states = [{headSha: 'c'.repeat(40)}, {...merged, headSha: 'c'.repeat(40)}];
  const {result} = start(github);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(await result).toMatchObject({outcome: 'merged', headSha: identity.headSha, observedHeadSha: 'c'.repeat(40)});
});

it('retries a transient failure and names it when the deadline passes', async () => {
  vi.useFakeTimers(); const github = new ScriptedGithub(); github.failures = Infinity;
  const deadline = new AbortController(); const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValueOnce(deadline.signal);
  const {result} = start(github); timeout.mockRestore();
  await vi.advanceTimersByTimeAsync(21_000); expect(github.reads).toBeGreaterThan(2);
  deadline.abort();
  expect(await result).toMatchObject({outcome: 'deadline', diagnostic: expect.stringMatching(/^command_failed: /)});
});

it('ends with error on a fatal query failure', async () => {
  const github = new ScriptedGithub(); github.fatal = new CiGithubError('authentication', 'GitHub authentication failed');
  expect(await start(github).result).toMatchObject({outcome: 'error', diagnostic: 'authentication: GitHub authentication failed'});
});

it('reports cancellation when the caller aborts', async () => {
  vi.useFakeTimers(); const github = new ScriptedGithub();
  const {result, controller} = start(github);
  await vi.advanceTimersByTimeAsync(1); controller.abort();
  expect((await result).outcome).toBe('cancelled');
});

it('holds no watcher slot, so a checks wait settles beside many open merge waits', async () => {
  vi.useFakeTimers(); const github = new ScriptedGithub();
  const supervisor = new CiWatcherSupervisor({github}); services.push(supervisor);
  const merges = Array.from({length: 5}, () => start(github, {}, supervisor));
  await vi.advanceTimersByTimeAsync(1);
  const checks = start(github, {until: 'checks'}, supervisor);
  await vi.advanceTimersByTimeAsync(1);
  expect((await checks.result).outcome).toBe('passed');
  for (const merge of merges) merge.controller.abort();
  for (const merge of merges) expect((await merge.result).outcome).toBe('cancelled');
});
