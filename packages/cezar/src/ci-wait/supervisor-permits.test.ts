import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CiPrIdentity, CiWait } from '@open-mercato/cezar-contract';
import { CI_QUERY_LIMIT, CiSemaphore, GithubCiClient, type CiCommandResult, type GithubCheck } from './github.ts';
import { CiProgressRegistry } from './progress.ts';
import { CI_PROBE_MS, CiWatcherSupervisor } from './supervisor.ts';

/**
 * The activity view's progress reads share the GitHub client's query permits with the reads that
 * decide a wait's outcome (spec 2026-11-05-live-activity-view, CI check progress). They never wait
 * for a permit, never take one while fewer than two are free, and one runs at a time, so no
 * progress read delays an outcome query. These tests drive the client's real semaphore and query
 * path; only the gh process is replaced.
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

const head = 'a'.repeat(40);
const identity = (prNumber: number): CiPrIdentity => ({prUrl: `https://github.com/org/repo/pull/${prNumber}`, repository: 'org/repo', prNumber, headSha: head});
const wait = (prNumber: number): CiWait => ({...identity(prNumber), id: crypto.randomUUID(), generation: 'g', turnId: 't', timeoutSeconds: 1800, until: 'checks',
  wakeOnConflict: true, registeredAt: new Date().toISOString(), deadline: new Date(Date.now() + 1_800_000).toISOString(), phase: 'registered'});
const OCCUPIER = 99;
const answer = (stdout: unknown, code = 0): CiCommandResult => ({code, stdout: typeof stdout === 'string' ? stdout : JSON.stringify(stdout), stderr: ''});
const rows = (bucket: GithubCheck['bucket']): GithubCheck[] => [{name: 'build', state: bucket === 'pass' ? 'SUCCESS' : 'PENDING', link: '', bucket}];

/**
 * gh, answered in process. A checks read while the PR's --watch still runs (a progress read) is
 * held until `releaseHeld`, and rejects on abort as the real process does. The first checks read
 * of a PR is pending; one after its --watch exits passes.
 */
class FakeGh extends GithubCiClient {
  readonly held: Array<{ prNumber: number; release: () => void }> = [];
  private readonly checksReads = new Map<number, number>();
  private readonly watches = new Map<number, () => void>();
  private readonly finished = new Set<number>();
  protected override runCommand(args: string[], signal: AbortSignal): Promise<CiCommandResult> {
    if (args[0] === 'api') return Promise.resolve(answer({total_count: 0, workflow_runs: []}));
    if (args[1] === 'view') {
      const prNumber = Number(args[2]!.split('/').pop());
      return Promise.resolve(answer({url: identity(prNumber).prUrl, number: prNumber, headRefOid: head, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN'}));
    }
    const prNumber = Number(args[2]);
    // PR 99 belongs to no wait: `occupy` holds query permits with it.
    if (prNumber === OCCUPIER) return this.hold(OCCUPIER, signal, answer('[]'));
    const read = (this.checksReads.get(prNumber) ?? 0) + 1;
    this.checksReads.set(prNumber, read);
    if (read === 1) return Promise.resolve(answer(rows('pending'), 8));
    if (this.finished.has(prNumber)) return Promise.resolve(answer(rows('pass')));
    return this.hold(prNumber, signal, answer(rows('pass')));
  }
  private hold(prNumber: number, signal: AbortSignal, result: CiCommandResult): Promise<CiCommandResult> {
    return new Promise((resolve, reject) => {
      const forget = () => { const index = this.held.indexOf(entry); if (index >= 0) this.held.splice(index, 1); };
      const entry = {prNumber, release: () => { forget(); resolve(result); }};
      this.held.push(entry);
      signal.addEventListener('abort', () => { forget(); reject(signal.reason); }, {once: true});
    });
  }
  override watch(pr: CiPrIdentity, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      this.watches.set(pr.prNumber, () => { this.finished.add(pr.prNumber); resolve(); });
      signal.addEventListener('abort', () => reject(signal.reason), {once: true});
    });
  }
  /** `gh pr checks --watch` of this PR exits. */
  finishWatch(prNumber: number): void { this.watches.get(prNumber)!(); }
  progressReads(): number { return this.held.filter(entry => entry.prNumber !== OCCUPIER).length; }
  /** Occupy `count` query permits with held checks reads that belong to no wait. */
  occupy(count: number): void {
    for (let index = 0; index < count; index++) void this.checks(identity(OCCUPIER), new AbortController().signal).catch(() => {});
  }
  releaseOccupied(): void { for (const entry of this.held.filter(held => held.prNumber === OCCUPIER)) entry.release(); }
}

const services: CiWatcherSupervisor[] = [];
const controllers: AbortController[] = [];
afterEach(() => { for (const s of services.splice(0)) s.close(); for (const c of controllers.splice(0)) c.abort(); vi.useRealTimers(); vi.restoreAllMocks(); });
const tick = () => vi.advanceTimersByTimeAsync(1);

function supervisor(github: FakeGh) {
  const progress = new CiProgressRegistry();
  progress.useDemand({has: projectId => projectId === 'shop'});
  const service = new CiWatcherSupervisor({github, progress}); services.push(service);
  const start = (prNumber: number, deadline?: AbortSignal) => {
    if (deadline) vi.spyOn(AbortSignal, 'timeout').mockReturnValueOnce(deadline);
    const controller = new AbortController(); controllers.push(controller);
    const request = wait(prNumber);
    // run() reads its deadline signal synchronously; later calls reach the real AbortSignal.timeout.
    const result = service.watch(request, controller.signal);
    const state = {settled: false};
    void result.then(() => { state.settled = true; });
    return {request, result, state};
  };
  return {progress, start};
}

describe('progress reads and the query permits', () => {
  it('four waits in --watch hold at most one progress read, and a --watch completion settles at once', async () => {
    vi.useFakeTimers();
    const github = new FakeGh();
    const {progress, start} = supervisor(github);
    const deadline = new AbortController();
    const waits = [1, 2, 3].map(prNumber => start(prNumber));
    const last = start(4, deadline.signal);
    await tick();
    for (const watched of [...waits, last]) progress.read(watched.request.id, 'shop');
    // Two probe rounds: every wait asked for a progress read at least once.
    await vi.advanceTimersByTimeAsync(CI_PROBE_MS);
    await vi.advanceTimersByTimeAsync(CI_PROBE_MS);
    // --watch of PR 4 completes while a progress read is still held; its deadline comes after.
    github.finishWatch(4);
    await tick();
    expect(last.state.settled).toBe(true);
    deadline.abort();
    expect(await last.result).toMatchObject({outcome: 'passed', totalChecks: 1});
    // One progress read in flight across the supervisor: PR 1's, from the first probe round.
    expect(github.held.map(entry => entry.prNumber)).toEqual([1]);
  });

  it('skips a progress read while fewer than two permits are free, and starts it once two are', async () => {
    vi.useFakeTimers();
    const github = new FakeGh();
    const {progress, start} = supervisor(github);
    const watched = start(1);
    await tick();
    progress.read(watched.request.id, 'shop');
    github.occupy(CI_QUERY_LIMIT - 1);
    await tick();
    await vi.advanceTimersByTimeAsync(CI_PROBE_MS);
    // The head probe took the last permit and returned it; one permit stays free: no read.
    expect(github.progressReads()).toBe(0);
    expect(watched.state.settled).toBe(false);
    github.releaseOccupied();
    await tick();
    await vi.advanceTimersByTimeAsync(CI_PROBE_MS);
    expect(github.progressReads()).toBe(1);
    expect(watched.state.settled).toBe(false);
  });
});

describe('a non-blocking query permit', () => {
  it('is taken only while enough permits are free and nobody queues, and never waits', async () => {
    const semaphore = new CiSemaphore(4);
    const signal = new AbortController().signal;
    const first = await semaphore.acquire(signal);
    const second = await semaphore.acquire(signal);
    const tried = semaphore.tryAcquire(2);
    expect(tried).toBeDefined();
    // Three taken, one free.
    expect(semaphore.tryAcquire(2)).toBeUndefined();
    const fourth = await semaphore.acquire(signal);
    expect(semaphore.tryAcquire(1)).toBeUndefined();
    const queued = semaphore.acquire(signal);
    // A released permit goes to the queued request, never to a later try.
    first();
    const fifth = await queued;
    expect(semaphore.tryAcquire(1)).toBeUndefined();
    second();
    tried!();
    const sixth = semaphore.tryAcquire(2);
    expect(sixth).toBeDefined();
    for (const release of [fourth, fifth, sixth!]) release();
  });
});
