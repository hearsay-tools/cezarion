/**
 * Run-store benchmark (#779): what the run index costs as it grows, and whether saving it is the
 * cost worth moving to SQLite. Rerun it unchanged after the migration.
 *
 *   npm run bench:run-store -w @wjarka/cezarion                      # full run, about 4 hours
 *   npm run bench:run-store -w @wjarka/cezarion -- --quick           # smoke, a few minutes
 *   node --import tsx packages/cezar/scripts/benchmark-run-store.ts --sizes 100,5000 --profiles legacy
 *
 * Flags: --sizes (100,500,1000,2000,5000) --profiles (legacy,post-778) --processes (5)
 * --samples (100) --budget-seconds (60) --duration (30, seconds of active simulation) --seed (779)
 * --metrics (all: open,coldRead,save,commit,runs,runsIndex,runSummaries,active,heap,getRun)
 * --out-dir (a new /tmp directory) --resume (reuse child results already in --out-dir, run the rest) --quick (sizes 100,1000, 2 processes, 10 samples, 10 s budget,
 * 3 s simulation). Results land in <out-dir>/results.{md,json}; the Markdown also goes to stdout.
 * `--metrics heap,getRun,runSummaries` is the pass #779's second amendment added; a plain run
 * measures everything.
 *
 * Method:
 * - Fixtures come from `benchmark-run-store-fixture.ts` (seeded, two profiles; see its header for
 *   how #778 is modeled, and the live share: max(3, 1% of runs) queued/running/waiting records on
 *   top of the finished ones, which keep the bytes the first table measured) and are generated
 *   before any timer starts. `seedRunStore` is the ONLY place that knows the storage format: since
 *   #779 it writes `runs.db` through the tests' shared seeder, so "open" reads the database and
 *   "cold read" reads its summaries, the way a migrated project does. Every store opens with
 *   `keepLive`, as `serve` does, so live records load as themselves.
 * - The parent spawns one fresh process per size x profile x process index, in shuffled order,
 *   one at a time. Each process measures every operation after 3 untimed warm-up calls, taking up
 *   to --samples samples and stopping early once it has 20 and --budget-seconds have passed.
 *   The table pools every process's samples per cell (median, p95, n). A failed child is
 *   reported and the rest still aggregate; the parent stops launching children when less than
 *   1 GB is free, and exits 1 after writing what it has. `--resume` reruns only missing children.
 * - Everything goes through public APIs: `RunStore.open`, `getRun`, `updateRun` + `flush`,
 *   `updateStep`, `commitDelegation`, `readRunIndexFromDisk`, and the Hono app from `createApp`.
 * - "heap after open" is `heapUsed` after `RunStore.open` and a forced gc, minus `heapUsed` after a
 *   forced gc just before it, in MB; 3 samples per process, measured first, before anything else
 *   has run in the process.
 * - "getRun" is per-call time in microseconds: each sample cycles `getRun` through a fixed id set
 *   until 2 ms have passed, then divides. "live" is every live record; "finished" is 49 evenly
 *   spaced finished records plus the largest one (50 ids, or 49 when the largest is among them).
 * - Synchronous calls are timed with `performance.now()` around the call.
 * - "save (flush)" is `updateRun` + `flush()`: `flush` runs the same `saveNow` the 300 ms debounce
 *   timer calls, synchronously, so it is the debounced write without the timer. Both save rows
 *   write the finished record closest to the median finished size (`pickSaveTarget`), and the
 *   results table prints that size per cell.
 * - "save (debounced)" is the real path: `updateRun`, then the timer fires on its own. It is
 *   measured as the longest gap a `setImmediate` loop sees while waiting for the save (stop after
 *   a gap of at least half the flush median once 300 ms have passed, or at a timeout).
 * - "commit (1 row)" / "commit (10 rows)" are `commitDelegation` with each row's own delegation,
 *   the durable `commitIndex` path.
 * - The list routes (`/runs`, `/run-summaries`, `/workspace/runs-index`) run in-process through
 *   `app.request` (no socket), against a second store
 *   opened on the same files, so app listeners never touch the store-under-test. "wall" is call
 *   to fully read body; "block" is the longest synchronous stretch inside it, from the same
 *   `setImmediate` gap detector. `/workspace/runs-index` reads a second, registered project cold
 *   from disk; the boot project is not registered, so the index measures the cold reader only.
 * - "open" and "cold read" repeat on the same files, so the OS page cache is warm: they measure
 *   parse and validation, not disk.
 * - The active simulation touches one unarchived run every 5 ms (`updateStep`, fixed-width token
 *   counts) for --duration seconds while `monitorEventLoopDelay` (1 ms resolution) records.
 */
import { spawn, execFileSync } from 'node:child_process';
import { randomInt } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, statfsSync, writeFileSync } from 'node:fs';
import { cpus, totalmem, tmpdir, type as osType, release, arch } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import type { RunRecord, RunStore as RunStoreInstance } from '../src/runs/store.ts';
import { DEFAULT_FIXTURE_SEED, FIXTURE_PROFILES, generateRunFixture, isLiveRun, pickSaveTarget, type FixtureProfile } from './benchmark-run-store-fixture.ts';

const SCRIPT = fileURLToPath(import.meta.url);
const WARM_UP = 3;
const MIN_SAMPLES = 20;
const DEBOUNCE_MS = 300;
const TOUCH_EVERY_MS = 5;
const MULTI_ROWS = 10;
const MIN_FREE_BYTES = 1e9;
const HEAP_SAMPLES = 3;
const GET_RUN_MIN_MS = 2;
const GET_RUN_FINISHED_IDS = 50;

const METRICS = ['open', 'coldRead', 'save', 'commit', 'runs', 'runsIndex', 'runSummaries', 'active', 'heap', 'getRun'] as const;
type Metric = typeof METRICS[number];
/** What a child result measured before `--metrics` existed. */
const FIRST_TABLE_METRICS: readonly Metric[] = ['open', 'coldRead', 'save', 'commit', 'runs', 'runsIndex', 'active'];
const SYNC_OPS = ['open', 'cold read', 'save (flush)', 'save (debounced)', 'commit (1 row)', 'commit (10 rows)', 'commit (held run)', 'commit (cold run)'] as const;
type SyncOp = typeof SYNC_OPS[number];
const SYNC_OP_METRIC: Record<SyncOp, Metric> = {
  open: 'open', 'cold read': 'coldRead', 'save (flush)': 'save', 'save (debounced)': 'save', 'commit (1 row)': 'commit', 'commit (10 rows)': 'commit',
  'commit (held run)': 'commit', 'commit (cold run)': 'commit',
};
/** The same one-row commit split by claim state (#779, plan step 3): on a run this store already
 *  holds and claims (the fence alone), and on a run it must claim first. Reported, never gated:
 *  `commit (1 row)` is the gate's commit and the first table's. */
const CLAIM_OPS: readonly SyncOp[] = ['commit (held run)', 'commit (cold run)'];
const ROUTE_PATHS = {
  'GET /runs': { metric: 'runs', path: '/api/v1/runs' },
  'GET /run-summaries': { metric: 'runSummaries', path: '/api/v1/run-summaries' },
  'GET /workspace/runs-index': { metric: 'runsIndex', path: '/api/v1/workspace/runs-index' },
} as const satisfies Record<string, { metric: Metric; path: string }>;
type Route = keyof typeof ROUTE_PATHS;
const ROUTES = Object.keys(ROUTE_PATHS) as Route[];

interface ChildOptions { size: number; profile: FixtureProfile; process: number; samples: number; budgetSeconds: number; duration: number; seed: number; metrics: Metric[] }
interface ChildResult {
  size: number; profile: FixtureProfile; process: number; fixtureBytes: number; records: number;
  /** Live records among `records`; absent on results written before the fixture had any. */
  liveRecords?: number;
  /** Serialized size of the record the save rows write; absent on results written before the target was a median-size record. */
  saveTargetBytes?: number;
  /** Absent on results written before `--metrics` existed: those measured `FIRST_TABLE_METRICS`. */
  metrics?: Metric[];
  /** Added by the parent; absent on results written before `--resume` existed. */
  revision?: string;
  sync: Partial<Record<SyncOp, number[]>>;
  routes: Partial<Record<Route, { wall: number[]; block: number[]; responseBytes: number }>>;
  loop?: { p50: number; p99: number; max: number; mean: number; touches: number; expectedTouches: number };
  /** MB per sample. */
  heap?: number[];
  /** Microseconds per call, per sample. */
  getRun?: { live: number[]; finished: number[]; liveIds: number; finishedIds: number };
}

// ---- measurement helpers ------------------------------------------------------------------

/** Times `fn` per sample; when `fn` returns a number, that number is the sample instead. */
async function sampleSync(options: ChildOptions, fn: (iteration: number) => number | void): Promise<number[]> {
  for (let i = 0; i < WARM_UP; i++) { fn(-1 - i); await yieldLoop(); }
  const samples: number[] = [];
  const started = performance.now();
  while (samples.length < options.samples &&
    !(samples.length >= Math.min(MIN_SAMPLES, options.samples) && performance.now() - started > options.budgetSeconds * 1000)) {
    const t0 = performance.now();
    const value = fn(samples.length);
    const elapsed = performance.now() - t0;
    samples.push(value ?? elapsed);
    await yieldLoop();
  }
  return samples;
}

async function sampleAsync(options: ChildOptions, fn: (iteration: number) => Promise<void>): Promise<void> {
  for (let i = 0; i < WARM_UP; i++) await fn(-1 - i);
  const started = performance.now();
  let taken = 0;
  while (taken < options.samples &&
    !(taken >= Math.min(MIN_SAMPLES, options.samples) && performance.now() - started > options.budgetSeconds * 1000)) {
    await fn(taken++);
  }
}

const yieldLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * The longest synchronous stretch while `body` runs: a `setImmediate` loop records the gap
 * between its turns, and a gap is time the loop could not run. Without `until` the window ends
 * when `body` resolves; with it, watching continues until `until` returns true.
 */
async function watchBlocking(body: () => Promise<unknown>, until?: (elapsed: number, maxGap: number) => boolean): Promise<{ wall: number; block: number }> {
  let last = performance.now();
  let maxGap = 0;
  let stop = false;
  const start = last;
  const tick = () => {
    const now = performance.now();
    maxGap = Math.max(maxGap, now - last);
    last = now;
    if (!stop) setImmediate(tick);
  };
  setImmediate(tick);
  await body();
  const end = performance.now();
  let block = Math.max(maxGap, end - last);
  if (until) {
    while (!until(performance.now() - start, maxGap)) await sleep(1);
    block = Math.max(maxGap, performance.now() - last);
  }
  stop = true;
  await yieldLoop();
  return { wall: end - start, block };
}

const isoAt = (iteration: number) => new Date(Date.UTC(2026, 9, 2) + (iteration + 10) * 1000).toISOString();

function quantile(values: readonly number[], q: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[index]!;
}

// ---- child: one size x profile in a fresh process --------------------------------------------

async function runChild(options: ChildOptions, resultPath: string): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'cez-bench-'));
  process.env.CEZ_HOME = join(root, 'home');
  process.env.CEZ_DRY_RUN = '1';
  try {
    const { RunStore } = await import('../src/runs/store.ts');
    const { seedRuns } = await import('../src/runs/run-store.testkit.ts');
    // ---- fixture seeding: the one storage-format-specific step ----
    /** Put `records` where `RunStore.open(dataDir)` finds them and return the bytes stored. */
    const seedRunStore = (dataDir: string, records: readonly RunRecord[]): number => {
      seedRuns(dataDir, records);
      return statSync(join(dataDir, 'runs.db')).size;
    };
    const { readRunIndexFromDisk } = await import('../src/runs/run-index.ts');
    const { createApp } = await import('../src/server/server.ts');
    const { registerProject } = await import('../src/workspace/projects.ts');
    const gc = (globalThis as { gc?: () => void }).gc ?? (() => {});

    const records = generateRunFixture({ runs: options.size, profile: options.profile, seed: options.seed });
    const bootDir = join(root, 'boot/.ai/cezar');
    const coldRoot = join(root, 'cold');
    const fixtureBytes = seedRunStore(bootDir, records);
    seedRunStore(join(coldRoot, '.ai/cezar'), records);
    await registerProject(coldRoot);
    const has = (metric: Metric) => options.metrics.includes(metric);
    // Each open stands for a freshly started process, so the store opened before it is closed
    // first, untimed: left open, its claims (#779, plan step 3) would keep the new one off every
    // live run.
    let opened: RunStoreInstance | undefined;
    const closePrevious = () => { opened?.close(); opened = undefined; };
    const open = () => (opened = RunStore.open(bootDir, { keepLive: true }));

    // Targets are picked from the fixture data, never from store internals. The first table's
    // targets come from the finished records, which are that table's whole fixture.
    const live = records.filter(isLiveRun);
    const finished = records.filter((run) => !isLiveRun(run));
    const roots = finished.filter((run) => run.delegation?.role === 'root');
    const singleTarget = roots.find((run) => run.delegation?.role === 'root' && run.delegation.conversation)?.id ?? roots[0]!.id;
    const multiTargets = finished.filter((run) => run.delegation && run.delegation.role !== 'invalid').slice(0, MULTI_ROWS).map((run) => run.id);
    const active = finished.find((run) => !run.archived)!;
    // A median-size record, not `finished[length / 2]` (see `pickSaveTarget`): save cost tracks the
    // changed record's size, and that position was 231 KB at 2,000 runs.
    const saveRecord = pickSaveTarget(finished);
    const saveTarget = saveRecord.id;
    const bytes = finished.map((run) => JSON.stringify(run).length);
    const largest = finished[bytes.indexOf(Math.max(...bytes))]!;
    const spaced = Math.min(finished.length, GET_RUN_FINISHED_IDS - 1);
    const finishedIds = [...new Set([largest.id,
      ...Array.from({ length: spaced }, (_, i) => finished[Math.floor((i * finished.length) / spaced)]!.id)])];

    const result: ChildResult = {
      size: options.size, profile: options.profile, process: options.process, fixtureBytes, records: records.length,
      liveRecords: live.length, saveTargetBytes: JSON.stringify(saveRecord).length, metrics: options.metrics, sync: {}, routes: {},
    };
    const sync = result.sync;
    let store: RunStoreInstance | undefined;
    if (has('heap')) {
      const heap: number[] = [];
      for (let i = 0; i < HEAP_SAMPLES; i++) {
        closePrevious();
        store = undefined;
        gc();
        const before = process.memoryUsage().heapUsed;
        store = open();
        gc();
        heap.push((process.memoryUsage().heapUsed - before) / 1e6);
      }
      result.heap = heap;
    }
    gc();
    if (has('open')) {
      sync.open = await sampleSync(options, () => {
        closePrevious();
        const t0 = performance.now();
        store = open();
        return performance.now() - t0;
      });
    }
    store ??= open();
    gc();
    if (has('getRun')) {
      const s = store;
      /** Microseconds per `getRun`, cycling through `ids` until GET_RUN_MIN_MS have passed. */
      const perCall = (ids: readonly string[]) => {
        let calls = 0;
        let found = 0;
        let elapsed = 0;
        const t0 = performance.now();
        do {
          for (const id of ids) if (s.getRun(id)) found++;
          calls += ids.length;
          elapsed = performance.now() - t0;
        } while (elapsed < GET_RUN_MIN_MS);
        if (found !== calls) throw new Error('getRun missed a fixture id');
        return (elapsed * 1000) / calls;
      };
      const liveIds = live.map((run) => run.id);
      const liveSamples = await sampleSync(options, () => perCall(liveIds));
      gc();
      const finishedSamples = await sampleSync(options, () => perCall(finishedIds));
      result.getRun = { live: liveSamples, finished: finishedSamples, liveIds: liveIds.length, finishedIds: finishedIds.length };
      gc();
    }
    if (has('coldRead')) {
      // The limit `/workspace/runs-index` reads with.
      sync['cold read'] = await sampleSync(options, () => { readRunIndexFromDisk(join(coldRoot, '.ai/cezar'), { archivedWindow: 200 }); });
      gc();
    }
    if (has('save')) {
      const s = store;
      sync['save (flush)'] = await sampleSync(options, (iteration) => {
        s.updateRun(saveTarget, { seenAt: isoAt(iteration) });
        s.flush();
      });
      gc();
      const flushMedian = quantile(sync['save (flush)'], 0.5);
      const flushP95 = quantile(sync['save (flush)'], 0.95);
      const debounced: number[] = [];
      await sampleAsync(options, async (iteration) => {
        const { block } = await watchBlocking(async () => { s.updateRun(saveTarget, { seenAt: isoAt(iteration) }); },
          (elapsed, maxGap) => (elapsed > DEBOUNCE_MS && maxGap >= Math.max(2, flushMedian / 2)) ||
            elapsed > DEBOUNCE_MS + 3 * flushP95 + 200);
        if (iteration >= 0) debounced.push(block);
        await sleep(20);
      });
      sync['save (debounced)'] = debounced;
      gc();
    }
    if (has('commit')) {
      const s = store;
      const commit = (ids: readonly string[]) => s.commitDelegation(ids.map((id) => ({ id, delegation: s.getRun(id)!.delegation! })));
      sync['commit (1 row)'] = await sampleSync(options, () => { commit([singleTarget]); });
      gc();
      sync['commit (10 rows)'] = await sampleSync(options, () => { commit(multiTargets); });
      gc();
      // #779 plan step 3: every durable commit is fenced (claim and revision checked in its
      // transaction). A run already held and claimed pays the fence alone; a run that left memory
      // is claimed first. Its claim is released when it leaves again — the untimed flush.
      s.pin(singleTarget, 'cleanup');
      sync['commit (held run)'] = await sampleSync(options, () => { commit([singleTarget]); });
      s.unpin(singleTarget, 'cleanup');
      gc();
      sync['commit (cold run)'] = await sampleSync(options, () => {
        s.flush();
        const t0 = performance.now();
        commit([singleTarget]);
        return performance.now() - t0;
      });
      gc();
    }

    const routes = ROUTES.filter((route) => has(ROUTE_PATHS[route].metric));
    if (routes.length > 0) {
      closePrevious();
      const routeStore = open();
      const app = createApp({
        repoRoot: join(root, 'boot'), store: routeStore, version: '0.0.0-bench',
        manager: { finishBlockedReason: () => null } as unknown as Parameters<typeof createApp>[0]['manager'],
      });
      for (const route of routes) {
        const wall: number[] = [];
        const block: number[] = [];
        let responseBytes = 0;
        await sampleAsync(options, async (iteration) => {
          const measured = await watchBlocking(async () => {
            const response = await app.request(ROUTE_PATHS[route].path, { headers: { host: '127.0.0.1:4321' } });
            if (response.status !== 200) throw new Error(`${route} answered ${response.status}`);
            responseBytes = (await response.text()).length;
          });
          if (iteration >= 0) { wall.push(measured.wall); block.push(measured.block); }
        });
        result.routes[route] = { wall, block, responseBytes };
        gc();
      }
    }

    if (has('active')) {
      if (opened !== store) { closePrevious(); store = open(); }
      const s = store;
      const histogram = monitorEventLoopDelay({ resolution: 1 });
      let touches = 0;
      histogram.enable();
      const timer = setInterval(() => {
        s.updateStep(active.id, 'task', { tokensUsed: 100_000 + (touches++ % 900_000) });
      }, TOUCH_EVERY_MS);
      await sleep(options.duration * 1000);
      clearInterval(timer);
      histogram.disable();
      s.flush();
      const ms = (ns: number) => ns / 1e6;
      result.loop = {
        p50: ms(histogram.percentile(50)), p99: ms(histogram.percentile(99)), max: ms(histogram.max), mean: ms(histogram.mean),
        touches, expectedTouches: Math.floor((options.duration * 1000) / TOUCH_EVERY_MS),
      };
    }

    writeFileSync(resultPath, JSON.stringify(result));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ---- parent: orchestrate, aggregate, report -------------------------------------------------

interface ParentOptions { sizes: number[]; profiles: FixtureProfile[]; processes: number; samples: number; budgetSeconds: number; duration: number; seed: number; metrics: Metric[]; outDir: string; resume: boolean }

function runChildProcess(options: ChildOptions, resultPath: string): Promise<void> {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('CEZ_')) delete env[key];
  const args = [...process.execArgv, '--expose-gc', '--max-old-space-size=8192', SCRIPT, '--child',
    '--size', String(options.size), '--profile', options.profile, '--process', String(options.process),
    '--samples', String(options.samples), '--budget-seconds', String(options.budgetSeconds),
    '--duration', String(options.duration), '--seed', String(options.seed),
    '--metrics', options.metrics.join(','), '--result', resultPath];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { env, stdio: ['ignore', 'inherit', 'inherit'] });
    child.on('error', reject);
    child.on('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`child ${options.size}/${options.profile}/${options.process} exited ${code ?? signal}`)));
  });
}

function environment() {
  const git = (...args: string[]) => { try { return execFileSync('git', args, { cwd: join(SCRIPT, '..'), encoding: 'utf8' }).trim(); } catch { return 'unknown'; } };
  const cpu = cpus();
  return {
    node: process.version, os: `${osType()} ${release()} ${arch()}`, cpu: `${cpu[0]?.model ?? 'unknown'} x${cpu.length}`,
    memoryGb: Math.round(totalmem() / 1e9), revision: git('rev-parse', 'HEAD'), dirty: git('status', '--porcelain', '--untracked-files=no') !== '',
    date: new Date().toISOString(),
  };
}

interface Cell { median: number; p95: number; n: number; spread: [number, number] }
const cell = (perProcess: number[][]): Cell => {
  const pooled = perProcess.flat();
  const medians = perProcess.map((values) => quantile(values, 0.5));
  return { median: quantile(pooled, 0.5), p95: quantile(pooled, 0.95), n: pooled.length, spread: [Math.min(...medians), Math.max(...medians)] };
};
/** A cell over the processes that measured `pick`, or nothing when none did. */
const cellOf = (group: readonly ChildResult[], pick: (result: ChildResult) => number[] | undefined): Cell | undefined => {
  const perProcess = group.map(pick).filter((values): values is number[] => values !== undefined);
  return perProcess.length > 0 ? cell(perProcess) : undefined;
};

interface SizeAggregate {
  metrics: Record<string, Cell>; fixtureBytes: number; records: number; liveRecords: number; saveTargetBytes?: number;
  responseBytes: Partial<Record<Route, number>>; getRunIds?: { live: number; finished: number };
  loop?: Record<'p50' | 'p99' | 'max' | 'touchRate', Cell>;
}

function aggregate(results: ChildResult[], options: ParentOptions) {
  const out: Record<string, Record<number, SizeAggregate>> = {};
  for (const profile of options.profiles) {
    out[profile] = {};
    for (const size of options.sizes) {
      const group = results.filter((result) => result.profile === profile && result.size === size);
      if (group.length === 0) continue;
      const metrics: Record<string, Cell> = {};
      const put = (key: string, value: Cell | undefined) => { if (value) metrics[key] = value; };
      const selected = (metric: Metric) => options.metrics.includes(metric);
      if (selected('heap')) put('heap', cellOf(group, (result) => result.heap));
      if (selected('getRun')) {
        put('getRun live', cellOf(group, (result) => result.getRun?.live));
        put('getRun finished', cellOf(group, (result) => result.getRun?.finished));
      }
      for (const op of SYNC_OPS) if (selected(SYNC_OP_METRIC[op])) put(op, cellOf(group, (result) => result.sync[op]));
      const responseBytes: SizeAggregate['responseBytes'] = {};
      for (const route of ROUTES.filter((route) => selected(ROUTE_PATHS[route].metric))) {
        put(`${route} block`, cellOf(group, (result) => result.routes[route]?.block));
        put(`${route} wall`, cellOf(group, (result) => result.routes[route]?.wall));
        const measured = group.find((result) => result.routes[route]);
        if (measured) responseBytes[route] = measured.routes[route]!.responseBytes;
      }
      const loops = selected('active') ? group.flatMap((result) => result.loop ? [result.loop] : []) : [];
      const withGetRun = group.find((result) => result.getRun);
      out[profile]![size] = {
        metrics,
        fixtureBytes: group[0]!.fixtureBytes,
        records: group[0]!.records,
        liveRecords: group[0]!.liveRecords ?? 0,
        ...(group[0]!.saveTargetBytes !== undefined ? { saveTargetBytes: group[0]!.saveTargetBytes } : {}),
        responseBytes,
        ...(withGetRun ? { getRunIds: { live: withGetRun.getRun!.liveIds, finished: withGetRun.getRun!.finishedIds } } : {}),
        ...(loops.length > 0 ? {
          loop: {
            p50: cell(loops.map((loop) => [loop.p50])), p99: cell(loops.map((loop) => [loop.p99])),
            max: cell(loops.map((loop) => [loop.max])),
            touchRate: cell(loops.map((loop) => [loop.touches / loop.expectedTouches])),
          },
        } : {}),
      };
    }
  }
  return out;
}

const fmt = (value: number) => value >= 100 ? value.toFixed(0) : value >= 10 ? value.toFixed(1) : value >= 0.01 ? value.toFixed(2) : value.toPrecision(2);
const mb = (bytes: number) => `${(bytes / 1e6).toFixed(1)} MB`;
const SAVE_METRICS = ['save (flush)', 'save (debounced)', 'commit (1 row)', 'commit (10 rows)'];
/** The gate's "largest block" candidates. `GET /runs` is left out: since #817 the cockpit lists
 *  through `GET /run-summaries`, and `GET /runs` serves only older clients. */
const BLOCKING_METRICS = [...SYNC_OPS.filter((op) => !CLAIM_OPS.includes(op)), 'GET /workspace/runs-index block', 'GET /run-summaries block'];
const BLOCKING_INPUTS: Record<string, Metric> = {
  ...SYNC_OP_METRIC, 'GET /workspace/runs-index block': 'runsIndex', 'GET /run-summaries block': 'runSummaries',
};

interface RunOutcome { failures: { job: string; error: string }[]; missing: string[]; stopped?: string }

function report(aggregated: ReturnType<typeof aggregate>, options: ParentOptions, env: ReturnType<typeof environment>, order: string[],
  results: readonly ChildResult[], outcome: RunOutcome): { markdown: string; gate: unknown } {
  const lines: string[] = ['# Run-store benchmark (#779)', ''];
  const revisions = new Map<string, number>();
  for (const result of results) revisions.set(result.revision ?? 'unrecorded', (revisions.get(result.revision ?? 'unrecorded') ?? 0) + 1);
  lines.push(`- Revision: \`${env.revision}\`${env.dirty ? ' (uncommitted changes)' : ''}`,
    `- Child results by revision: ${[...revisions].map(([revision, count]) => `\`${revision}\` x${count}`).join(', ')}`, `- Node ${env.node}, ${env.os}, ${env.cpu}, ${env.memoryGb} GB RAM`,
    `- Date: ${env.date}`,
    `- Metrics: ${options.metrics.length === METRICS.length ? 'all' : options.metrics.join(', ')}`,
    `- ${options.processes} fresh processes per size x profile, shuffled; up to ${options.samples} samples per operation after ${WARM_UP} warm-ups, stopping after ${options.budgetSeconds} s once ${MIN_SAMPLES} are taken; ${options.duration} s active simulation; fixture seed ${options.seed}`,
    '- Cells: median / p95 over all processes\' samples, in ms unless the row says otherwise; `n` when the time budget cut sampling short', '');
  for (const [profile, bySize] of Object.entries(aggregated)) {
    const sizes = Object.keys(bySize).map(Number);
    if (sizes.length === 0) continue;
    lines.push(`## ${profile}`, '', `| Metric | ${sizes.map((size) => `${size} runs`).join(' | ')} |`, `| --- | ${sizes.map(() => '---:').join(' | ')} |`);
    lines.push(`| Records (live) | ${sizes.map((size) => `${bySize[size]!.records} (${bySize[size]!.liveRecords})`).join(' | ')} |`);
    lines.push(`| Fixture bytes | ${sizes.map((size) => mb(bySize[size]!.fixtureBytes)).join(' | ')} |`);
    if (sizes.some((size) => bySize[size]!.saveTargetBytes !== undefined)) {
      lines.push(`| Save target bytes (median-size finished record) | ${sizes.map((size) => bySize[size]!.saveTargetBytes?.toLocaleString('en-US') ?? '-').join(' | ')} |`);
    }
    const row = (label: string, key: string, expectedN = options.processes * options.samples) => {
      if (!sizes.some((size) => bySize[size]!.metrics[key])) return;
      lines.push(`| ${label} | ${sizes.map((size) => {
        const value = bySize[size]!.metrics[key];
        if (!value) return '-';
        return `${fmt(value.median)} / ${fmt(value.p95)}${value.n < expectedN ? ` (n=${value.n})` : ''}`;
      }).join(' | ')} |`);
    };
    row('Heap after open (MB, `heapUsed` delta after gc)', 'heap', options.processes * HEAP_SAMPLES);
    row('`getRun`, live records (µs per call)', 'getRun live');
    row('`getRun`, finished records incl. the largest (µs per call)', 'getRun finished');
    row('Open, sync', 'open');
    row('Cold read (`readRunIndexFromDisk`), sync', 'cold read');
    row('Save (`updateRun` + `flush`), sync', 'save (flush)');
    row('Save (real 300 ms debounce), longest block', 'save (debounced)');
    row('Commit 1 row (`commitDelegation`), sync', 'commit (1 row)');
    row(`Commit ${MULTI_ROWS} rows (\`commitDelegation\`), sync`, 'commit (10 rows)');
    row('Commit 1 row, run held and claimed (fence only), sync', 'commit (held run)');
    row('Commit 1 row, run claimed first (claim + fence), sync', 'commit (cold run)');
    for (const route of ROUTES) {
      const label = route === 'GET /runs' ? 'GET /runs (older clients)' : route;
      row(`${label}, longest block`, `${route} block`);
      row(`${label}, wall (in-process)`, `${route} wall`);
    }
    for (const route of ['GET /runs', 'GET /run-summaries'] as const) {
      if (!sizes.some((size) => bySize[size]!.responseBytes[route] !== undefined)) continue;
      lines.push(`| ${route} response | ${sizes.map((size) => {
        const bytes = bySize[size]!.responseBytes[route];
        return bytes === undefined ? '-' : mb(bytes);
      }).join(' | ')} |`);
    }
    if (sizes.some((size) => bySize[size]!.loop)) {
      const loopCell = (size: number, render: (loop: NonNullable<SizeAggregate['loop']>) => string) => {
        const loop = bySize[size]!.loop;
        return loop ? render(loop) : '-';
      };
      lines.push(`| Active run: loop delay p50 / p99 / max | ${sizes.map((size) => loopCell(size, (loop) =>
        `${fmt(loop.p50.median)} / ${fmt(loop.p99.median)} / ${fmt(loop.max.median)}`)).join(' | ')} |`);
      lines.push(`| Active run: touches done / scheduled | ${sizes.map((size) => loopCell(size, (loop) =>
        `${(loop.touchRate.median * 100).toFixed(0)}%`)).join(' | ')} |`);
    }
    lines.push('');
  }
  if (options.metrics.includes('active')) lines.push('Loop-delay cells are the median across processes of each process\'s p50, p99 and max.', '');
  if (options.metrics.includes('getRun')) {
    lines.push(`\`getRun\` ids: every live record; finished = up to ${GET_RUN_FINISHED_IDS - 1} evenly spaced finished records plus the largest (${
      Object.values(aggregated).flatMap((bySize) => Object.entries(bySize)).filter(([, entry]) => entry.getRunIds)
        .map(([size, entry]) => `${size} runs: ${entry.getRunIds!.live} live, ${entry.getRunIds!.finished} finished`)
        .filter((value, index, all) => all.indexOf(value) === index).join('; ')}).`, '');
  }

  // Gate: does single-run save blocking grow with run count beyond noise, and is it the largest?
  const gate: Record<string, unknown> = {};
  lines.push('## Gate', '', '`GET /runs` is left out of the comparison: since #817 the cockpit lists through `GET /run-summaries`, and `GET /runs` serves older clients only.', '');
  const missingInputs = [...new Set(Object.values(BLOCKING_INPUTS))].filter((metric) => !options.metrics.includes(metric));
  for (const [profile, bySize] of Object.entries(aggregated)) {
    const sizes = Object.keys(bySize).map(Number).sort((a, b) => a - b);
    if (sizes.length < 2) { lines.push(`- ${profile}: needs at least two sizes.`); continue; }
    const small = sizes[0]!;
    const large = sizes[sizes.length - 1]!;
    const absent = [...new Set([...missingInputs.map((metric) => `\`${metric}\` (not selected)`),
      ...(missingInputs.includes('save') || bySize[small]!.metrics['save (flush)'] ? [] : [`save (flush) at ${small} runs`]),
      ...BLOCKING_METRICS.filter((metric) => !missingInputs.includes(BLOCKING_INPUTS[metric]!) && !bySize[large]!.metrics[metric])
        .map((metric) => `${metric} at ${large} runs`)])];
    if (absent.length > 0) {
      gate[profile] = { small, large, verdict: null, missingInputs: absent };
      lines.push(`### ${profile}`, '', `- No verdict: this pass is missing gate inputs: ${absent.join(', ')}. Rerun with every metric (the default) for one.`, '');
      continue;
    }
    const save = (size: number) => bySize[size]!.metrics['save (flush)']!;
    const grows = save(large).median > save(small).p95;
    const threshold = save(small).median + Math.max(0.25 * save(small).median, 1);
    const ranking = BLOCKING_METRICS.map((metric) => ({ metric, median: bySize[large]!.metrics[metric]!.median }))
      .sort((a, b) => b.median - a.median);
    const recurring = ranking.filter((entry) => entry.metric !== 'open');
    const saveLargest = SAVE_METRICS.includes(ranking[0]!.metric);
    const saveLargestRecurring = SAVE_METRICS.includes(recurring[0]!.metric);
    gate[profile] = { small, large, saveSmall: save(small), saveLarge: save(large), grows, threshold, ranking, saveLargest, saveLargestRecurring };
    lines.push(`### ${profile}`, '',
      `- Single-run save (\`updateRun\` + \`flush\`): median ${fmt(save(small).median)} ms (p95 ${fmt(save(small).p95)}) at ${small} runs, ${fmt(save(large).median)} ms (p95 ${fmt(save(large).p95)}) at ${large} runs. ` +
      (grows ? `**It grows beyond noise**: the ${large}-run median is above the ${small}-run p95.` : `**It does not grow beyond noise**: the ${large}-run median is within the ${small}-run p95.`),
      `- For reference, the post-migration criterion x_N <= x_${small} + max(0.25 x_${small}, 1 ms) allows ${fmt(threshold)} ms; today's ${large}-run median ${save(large).median <= threshold ? 'meets' : 'misses'} it.`,
      `- Largest synchronous block at ${large} runs: ${ranking.slice(0, 4).map((entry) => `${entry.metric} ${fmt(entry.median)} ms`).join(', ')}. ` +
      (saveLargest ? '**A save is the largest component.**' : `**A save is not the largest component**; ${ranking[0]!.metric} is.`) +
      (ranking[0]!.metric === 'open' ? ` Excluding open (once per boot), the largest is ${recurring[0]!.metric}${saveLargestRecurring ? ', a save' : ''}.` : ''),
      `- Verdict: ${grows && saveLargest ? 'the evidence gate passes' : grows && saveLargestRecurring ? 'save grows beyond noise and is the largest recurring block, but open is larger' : 'the evidence gate does not pass'} for ${profile}.`, '');
  }
  if (outcome.failures.length > 0 || outcome.missing.length > 0 || outcome.stopped) {
    lines.push('## Incomplete run', '', 'Cells aggregate the children that finished.', '');
    if (outcome.stopped) lines.push(`- ${outcome.stopped}`);
    for (const failure of outcome.failures) lines.push(`- ${failure.job} failed: ${failure.error}`);
    if (outcome.missing.length > 0) lines.push(`- Not run: ${outcome.missing.join(', ')}`);
    lines.push('');
  }
  lines.push('## Run order', '', order.join(', '), '');
  return { markdown: lines.join('\n'), gate };
}

/** Bytes free to this user on the file systems the children write to. */
function freeBytes(paths: readonly string[]): number {
  return Math.min(...paths.map((path) => { const fs = statfsSync(path); return fs.bavail * fs.bsize; }));
}

async function runParent(options: ParentOptions): Promise<void> {
  mkdirSync(options.outDir, { recursive: true });
  const jobs: ChildOptions[] = [];
  for (const size of options.sizes) for (const profile of options.profiles) for (let p = 0; p < options.processes; p++) {
    jobs.push({ size, profile, process: p, samples: options.samples, budgetSeconds: options.budgetSeconds, duration: options.duration, seed: options.seed, metrics: options.metrics });
  }
  for (let i = jobs.length - 1; i > 0; i--) { const j = randomInt(i + 1); [jobs[i], jobs[j]] = [jobs[j]!, jobs[i]!]; }
  const env = environment();
  const results: ChildResult[] = [];
  const outcome: RunOutcome = { failures: [], missing: [] };
  const status = new Map<ChildOptions, string>();
  const started = performance.now();
  for (const [index, job] of jobs.entries()) {
    const name = `${job.size}/${job.profile}/${job.process}`;
    const resultPath = join(options.outDir, `child-${job.size}-${job.profile}-${job.process}.json`);
    if (options.resume && existsSync(resultPath)) {
      try {
        const saved = JSON.parse(readFileSync(resultPath, 'utf8')) as ChildResult;
        const measured = saved.metrics ?? FIRST_TABLE_METRICS;
        const lacking = options.metrics.filter((metric) => !measured.includes(metric));
        if (lacking.length === 0) {
          results.push(saved);
          status.set(job, 'reused');
          process.stderr.write(`[bench] ${index + 1}/${jobs.length} ${name} reused\n`);
          continue;
        }
        process.stderr.write(`[bench] ${name}: saved result lacks ${lacking.join(', ')}, running it again\n`);
      } catch {
        process.stderr.write(`[bench] ${name}: saved result unreadable, running it again\n`);
      }
    }
    const free = freeBytes([options.outDir, tmpdir()]);
    if (free < MIN_FREE_BYTES) {
      outcome.stopped = `stopped before ${name}: ${(free / 1e9).toFixed(2)} GB free, ${MIN_FREE_BYTES / 1e9} GB required`;
      process.stderr.write(`[bench] ${outcome.stopped}\n`);
      break;
    }
    process.stderr.write(`[bench] ${index + 1}/${jobs.length} ${name} (${((performance.now() - started) / 60_000).toFixed(1)} min elapsed)\n`);
    try {
      await runChildProcess(job, resultPath);
      // Tag the result with the revision that produced it, so a resumed run can name every revision.
      const result = { ...(JSON.parse(readFileSync(resultPath, 'utf8')) as ChildResult), revision: env.revision };
      writeFileSync(resultPath, JSON.stringify(result));
      results.push(result);
      status.set(job, 'ran');
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      outcome.failures.push({ job: name, error });
      status.set(job, 'failed');
      process.stderr.write(`[bench] ${name} failed: ${error}\n`);
    }
  }
  outcome.missing = jobs.filter((job) => !status.has(job)).map((job) => `${job.size}/${job.profile}/${job.process}`);
  const aggregated = aggregate(results, options);
  const order = jobs.map((job) => `${job.size}/${job.profile}/${job.process}${status.get(job) === 'ran' ? '' : ` (${status.get(job) ?? 'not run'})`}`);
  const { markdown, gate } = report(aggregated, options, env, order, results, outcome);
  writeFileSync(join(options.outDir, 'results.md'), markdown);
  writeFileSync(join(options.outDir, 'results.json'), JSON.stringify({ environment: env, options, order, outcome, aggregated, gate, results }, null, 2));
  process.stdout.write(`${markdown}\n`);
  process.stderr.write(`[bench] wrote ${join(options.outDir, 'results.md')} and results.json\n`);
  if (outcome.failures.length > 0 || outcome.stopped) process.exitCode = 1;
}

// ---- entry ------------------------------------------------------------------------------------

const { values } = parseArgs({
  options: {
    child: { type: 'boolean', default: false }, quick: { type: 'boolean', default: false }, resume: { type: 'boolean', default: false },
    sizes: { type: 'string' }, profiles: { type: 'string' }, processes: { type: 'string' }, samples: { type: 'string' },
    'budget-seconds': { type: 'string' }, duration: { type: 'string' }, seed: { type: 'string' }, metrics: { type: 'string' }, 'out-dir': { type: 'string' },
    size: { type: 'string' }, profile: { type: 'string' }, process: { type: 'string' }, result: { type: 'string' },
  },
});
const positive = (raw: string | undefined, fallback: number, name: string) => {
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`--${name} must be a positive number`);
  return value;
};
const profileOf = (raw: string): FixtureProfile => {
  if (!(FIXTURE_PROFILES as readonly string[]).includes(raw)) throw new Error(`unknown profile ${raw}; use ${FIXTURE_PROFILES.join(', ')}`);
  return raw as FixtureProfile;
};
const metricOf = (raw: string): Metric => {
  if (!(METRICS as readonly string[]).includes(raw)) throw new Error(`unknown metric ${raw}; use ${METRICS.join(', ')}`);
  return raw as Metric;
};
const quick = values.quick;
const shared = {
  samples: positive(values.samples, quick ? 10 : 100, 'samples'),
  budgetSeconds: positive(values['budget-seconds'], quick ? 10 : 60, 'budget-seconds'),
  duration: positive(values.duration, quick ? 3 : 30, 'duration'),
  seed: positive(values.seed, DEFAULT_FIXTURE_SEED, 'seed'),
  // In METRICS order, so a child's list compares and prints the same however it was typed.
  metrics: (() => {
    const selected = new Set((values.metrics ?? METRICS.join(',')).split(',').map(metricOf));
    return METRICS.filter((metric) => selected.has(metric));
  })(),
};

if (values.child) {
  await runChild({ ...shared, size: positive(values.size, 0, 'size'), profile: profileOf(values.profile ?? ''), process: Number(values.process ?? 0) }, values.result!);
  process.exit(0);
} else {
  await runParent({
    ...shared,
    sizes: (values.sizes ?? (quick ? '100,1000' : '100,500,1000,2000,5000')).split(',').map((size) => positive(size, 0, 'sizes')),
    profiles: (values.profiles ?? FIXTURE_PROFILES.join(',')).split(',').map(profileOf),
    processes: positive(values.processes, quick ? 2 : 5, 'processes'),
    outDir: values['out-dir'] ?? mkdtempSync(join(tmpdir(), 'cezar-run-store-bench-')),
    resume: values.resume,
  });
}
