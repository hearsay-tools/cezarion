import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CiPrIdentity, CiWait } from '@open-mercato/cezar-contract';
import { CiGithubError, GithubCiClient, type GithubCheck, type GithubPrMetadata } from './github.ts';
import { CiProgressRegistry } from './progress.ts';
import { CI_PROBE_MS, CiWatcherSupervisor } from './supervisor.ts';

/**
 * The CI watcher feeds the activity view's check progress (spec 2026-11-05-live-activity-view,
 * CI check progress): one test for each row of the spec's probe case table. A progress read never
 * changes the wait's outcome, the `--watch` process or the head probe.
 */

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
const wait = (): CiWait => ({...identity, id: crypto.randomUUID(), generation: 'g', turnId: 't', timeoutSeconds: 1800, until: 'checks', wakeOnConflict: true,
  registeredAt: new Date().toISOString(), deadline: new Date(Date.now() + 1_800_000).toISOString(), phase: 'registered'});
const row = (name: string, bucket: GithubCheck['bucket']): GithubCheck => ({name, state: bucket === 'pass' ? 'SUCCESS' : 'PENDING', link: '', bucket});
const pending = [row('build', 'pending')];
const passed = [row('build', 'pass')];

/** A GitHub that answers from scripts and logs each call. The last script entry repeats. */
class ScriptedGithub extends GithubCiClient {
  calls: string[] = [];
  heads: string[] = [identity.headSha];
  active: boolean[] = [false];
  /** Each checks read, in order: rows, an error to throw, or a read held until `releaseHeld`. A
   *  held read rejects on abort, as gh does, unless it is `held-ignoring-abort`. */
  reads: Array<GithubCheck[] | Error | 'held' | 'held-ignoring-abort'> = [pending];
  private finish: (() => void) | undefined;
  private held: ((rows: GithubCheck[]) => void) | undefined;
  private next<T>(script: T[], name: string): T { const count = this.calls.filter(call => call === name).length; return script[Math.min(count - 1, script.length - 1)]!; }
  override async metadata(): Promise<GithubPrMetadata> {
    this.calls.push('metadata');
    return {headSha: this.next(this.heads, 'metadata'), mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN'};
  }
  override async hasActiveRuns(): Promise<boolean> { this.calls.push('active'); return this.next(this.active, 'active'); }
  override async checks(_pr: CiPrIdentity, signal: AbortSignal): Promise<GithubCheck[]> {
    this.calls.push('checks');
    const read = this.next(this.reads, 'checks');
    if (read instanceof Error) throw read;
    if (read === 'held' || read === 'held-ignoring-abort') {
      return new Promise((resolve, reject) => {
        this.held = resolve;
        if (read === 'held') signal.addEventListener('abort', () => reject(signal.reason), {once: true});
      });
    }
    return read;
  }
  // The test drives every read itself; the permit rule has its own tests (supervisor-permits).
  override tryChecks(pr: CiPrIdentity, signal: AbortSignal): Promise<GithubCheck[]> {
    return this.checks(pr, signal);
  }
  /** The held checks read answers. */
  releaseHeld(rows: GithubCheck[]): void { this.held!(rows); }
  override watch(_pr: CiPrIdentity, signal: AbortSignal): Promise<void> {
    this.calls.push('watch');
    return new Promise((resolve, reject) => {
      this.finish = resolve;
      signal.addEventListener('abort', () => reject(signal.reason), {once: true});
    });
  }
  /** `gh pr checks --watch` exits. */
  finishWatch(): void { this.finish!(); }
  count(name: string): number { return this.calls.filter(call => call === name).length; }
}

const services: CiWatcherSupervisor[] = [];
const controllers: AbortController[] = [];
function start(github: ScriptedGithub, demand = false) {
  const progress = new CiProgressRegistry();
  progress.useDemand({has: projectId => demand && projectId === 'shop'});
  const service = new CiWatcherSupervisor({github, progress}); services.push(service);
  const controller = new AbortController(); controllers.push(controller);
  const request = wait();
  const result = service.watch(request, controller.signal);
  const state = {settled: false};
  void result.then(() => { state.settled = true; });
  return {service, controller, request, result, state, progress};
}
afterEach(() => { for (const s of services.splice(0)) s.close(); for (const c of controllers.splice(0)) c.abort(); vi.useRealTimers(); vi.restoreAllMocks(); });
// One tick past a timer, so the async steps it starts finish on the fake clock.
const tick = () => vi.advanceTimersByTimeAsync(1);
const probe = () => vi.advanceTimersByTimeAsync(CI_PROBE_MS);

describe('the check progress of a CI wait', () => {
  it('--watch phase, no demand: the head probe runs every 30 s and reads no checks', async () => {
    vi.useFakeTimers(); const github = new ScriptedGithub();
    const {request, progress, state} = start(github);
    await tick();
    expect(github.calls).toEqual(['metadata', 'active', 'checks', 'metadata', 'watch']);
    // A snapshot has read the wait, but nobody watches its project.
    progress.read(request.id, 'shop');
    await probe(); await probe();
    expect(github.calls.slice(5)).toEqual(['metadata', 'metadata']);
    expect(github.count('watch')).toBe(1);
    expect(state.settled).toBe(false);
  });

  it('snapshot step at the start, with an active workflow and no checks yet: its rows are published', async () => {
    vi.useFakeTimers(); const github = new ScriptedGithub();
    github.active = [true, true, false]; github.reads = [[], pending, passed];
    const {request, progress, result} = start(github);
    await tick();
    expect(progress.read(request.id, 'shop')).toEqual({checks: [], counts: {pass: 0, fail: 0, pending: 0, skipping: 0, cancel: 0}});
    await probe();
    // A check moves from pending to pass between two snapshots.
    expect(progress.read(request.id, 'shop')?.checks).toEqual([{name: 'build', bucket: 'pending'}]);
    await probe();
    expect(await result).toMatchObject({outcome: 'passed', totalChecks: 1});
    expect(github.count('watch')).toBe(0);
  });

  it('snapshot step while no check exists yet and no workflow runs: the empty read, then the first checks', async () => {
    vi.useFakeTimers(); const github = new ScriptedGithub();
    github.reads = [[], pending];
    const {request, progress} = start(github);
    await tick();
    expect(progress.read(request.id, 'shop')?.counts.pending).toBe(0);
    await probe();
    expect(progress.read(request.id, 'shop')?.counts.pending).toBe(1);
    expect(github.count('watch')).toBe(1);
  });

  it('--watch phase, demand present: the head probe, then one checks read; the result only updates progress', async () => {
    vi.useFakeTimers(); const github = new ScriptedGithub();
    github.reads = [pending, [row('build', 'pass'), row('lint', 'pass')]];
    const deadline = new AbortController();
    vi.spyOn(AbortSignal, 'timeout').mockReturnValueOnce(deadline.signal);
    const {request, progress, result, state} = start(github, true);
    await tick();
    progress.read(request.id, 'shop');
    await probe();
    expect(github.calls.slice(5)).toEqual(['metadata', 'checks']);
    // Every check passed in that read, and no workflow runs: the wait still waits for the watch.
    expect(progress.read(request.id, 'shop')?.counts).toEqual({pass: 2, fail: 0, pending: 0, skipping: 0, cancel: 0});
    expect(state.settled).toBe(false);
    expect(github.count('watch')).toBe(1);
    // The wait's own observation keeps the snapshot step's rows.
    deadline.abort();
    expect(await result).toMatchObject({outcome: 'deadline', totalChecks: 1, checks: [{name: 'build', state: 'PENDING'}]});
  });

  it('--watch phase, demand present: a head change at the probe reads no checks', async () => {
    vi.useFakeTimers(); const github = new ScriptedGithub();
    github.heads = [identity.headSha, identity.headSha, 'b'.repeat(40)];
    const {request, progress, result} = start(github, true);
    await tick();
    progress.read(request.id, 'shop');
    await probe();
    expect(await result).toMatchObject({outcome: 'head_changed', observedHeadSha: 'b'.repeat(40)});
    expect(github.count('checks')).toBe(1);
  });

  // The red proof: a version that lets this read's failure reach the loop resolves the wait as an
  // error, or restarts the snapshot step and its --watch process.
  it.each([
    ['a GitHub error', new CiGithubError('malformed_data', 'GitHub returned malformed checks.')],
    ['a transient query failure', new CiGithubError('command_failed', 'GitHub query failed; check connectivity and GitHub availability, then retry.', true)],
    ['an unexpected error', new Error('boom')],
  ])('checks read fails with %s: progress keeps its last value and the wait continues', async (_name, failure) => {
    vi.useFakeTimers(); const github = new ScriptedGithub();
    github.reads = [pending, failure, passed];
    const {request, progress, result, state} = start(github, true);
    await tick();
    progress.read(request.id, 'shop');
    await probe();
    expect(github.calls.slice(5)).toEqual(['metadata', 'checks']);
    expect(state.settled).toBe(false);
    expect(progress.read(request.id, 'shop')?.checks).toEqual([{name: 'build', bucket: 'pending'}]);
    // The next probe reads again.
    await probe();
    expect(state.settled).toBe(false);
    expect(progress.read(request.id, 'shop')?.checks).toEqual([{name: 'build', bucket: 'pass'}]);
    expect(github.count('watch')).toBe(1);
    github.finishWatch();
    await tick();
    expect(await result).toMatchObject({outcome: 'passed', totalChecks: 1});
  });

  it('wait resolves: the result has its checks and totalChecks, and the progress entry is removed', async () => {
    vi.useFakeTimers(); const github = new ScriptedGithub();
    github.reads = [pending, passed];
    const {request, progress, result} = start(github);
    await tick();
    github.finishWatch();
    expect(await result).toMatchObject({outcome: 'passed', totalChecks: 1, checks: [{name: 'build', state: 'SUCCESS'}]});
    expect(progress.read(request.id, 'shop')).toBeUndefined();
  });

  it.each([
    ['the wait is cancelled', ({controller}: ReturnType<typeof start>) => controller.abort()],
    ['the service closes', ({service}: ReturnType<typeof start>) => service.close()],
  ])('%s: the progress entry is removed', async (_name, stop) => {
    vi.useFakeTimers(); const github = new ScriptedGithub();
    const watch = start(github, true);
    await tick();
    expect(watch.progress.read(watch.request.id, 'shop')).toBeDefined();
    stop(watch);
    expect(await watch.result).toMatchObject({outcome: 'cancelled'});
    expect(watch.progress.read(watch.request.id, 'shop')).toBeUndefined();
    expect(watch.progress.wanted(watch.request.id)).toBe(false);
  });

  // A held extra read never delays the wait (pre-PR review of S3). Before S3 the --watch
  // completion at 31 s settled the wait; the read held from the 30 s probe must not change that.
  it('--watch completes while an extra read is held: the wait settles then, with the outcome it had before S3', async () => {
    vi.useFakeTimers(); const github = new ScriptedGithub();
    github.reads = [pending, 'held', passed];
    const deadline = new AbortController();
    vi.spyOn(AbortSignal, 'timeout').mockReturnValueOnce(deadline.signal);
    const started = Date.now();
    const {request, progress, result} = start(github, true);
    let settledAt: number | undefined;
    void result.then(() => { settledAt = Date.now() - started; });
    setTimeout(() => deadline.abort(), 35_000);
    await tick();
    progress.read(request.id, 'shop');
    await probe();
    expect(github.calls.slice(5)).toEqual(['metadata', 'checks']);
    // The clock is at 30 001 ms: --watch completes at 31 s.
    await vi.advanceTimersByTimeAsync(999);
    github.finishWatch();
    await vi.advanceTimersByTimeAsync(0);
    expect(settledAt).toBe(31_000);
    expect(await result).toMatchObject({outcome: 'passed', totalChecks: 1, checks: [{name: 'build', state: 'SUCCESS'}]});
  });

  it('a held extra read keeps the head probe at its 30 s cadence, and the next probe starts no second read', async () => {
    vi.useFakeTimers(); const github = new ScriptedGithub();
    github.reads = [pending, 'held', passed];
    const {request, progress, state} = start(github, true);
    await tick();
    progress.read(request.id, 'shop');
    await probe();
    expect(github.calls.slice(5)).toEqual(['metadata', 'checks']);
    await probe();
    // One read at a time: the 60 s probe checks the head and skips the read still in flight.
    expect(github.calls.slice(7)).toEqual(['metadata']);
    github.releaseHeld(passed);
    await tick();
    expect(progress.read(request.id, 'shop')?.checks).toEqual([{name: 'build', bucket: 'pass'}]);
    expect(state.settled).toBe(false);
    await probe();
    expect(github.calls.slice(8)).toEqual(['metadata', 'checks']);
    expect(github.count('watch')).toBe(1);
  });

  it('a held extra read released after the wait settled publishes nothing and changes nothing', async () => {
    vi.useFakeTimers(); const github = new ScriptedGithub();
    github.reads = [pending, 'held-ignoring-abort', passed];
    const {request, progress, result} = start(github, true);
    await tick();
    progress.read(request.id, 'shop');
    await probe();
    github.finishWatch();
    const outcome = await result;
    expect(outcome).toMatchObject({outcome: 'passed', totalChecks: 1});
    github.releaseHeld([row('build', 'pass'), row('lint', 'pass')]);
    await tick();
    expect(progress.read(request.id, 'shop')).toBeUndefined();
    expect(progress.wanted(request.id)).toBe(false);
    expect(await result).toBe(outcome);
  });
});
