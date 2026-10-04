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
 * --out-dir (a new /tmp directory) --quick (sizes 100,1000, 2 processes, 10 samples, 10 s budget,
 * 3 s simulation). Results land in <out-dir>/results.{md,json}; the Markdown also goes to stdout.
 *
 * Method:
 * - Fixtures come from `benchmark-run-store-fixture.ts` (seeded, two profiles; see its header for
 *   how #778 is modeled) and are generated before any timer starts. `seedRunStore` is the ONLY
 *   place that knows the storage format; swap it for a store-level seeder after the migration.
 * - The parent spawns one fresh process per size x profile x process index, in shuffled order,
 *   one at a time. Each process measures every operation after 3 untimed warm-up calls, taking up
 *   to --samples samples and stopping early once it has 20 and --budget-seconds have passed.
 *   The table pools every process's samples per cell (median, p95, n).
 * - Everything goes through public APIs: `RunStore.open`, `updateRun` + `flush`, `updateStep`,
 *   `commitDelegation`, `readRunIndexFromDisk`, and the Hono app from `createApp`.
 * - Synchronous calls are timed with `performance.now()` around the call.
 * - "save (flush)" is `updateRun` + `flush()`: `flush` runs the same `saveNow` the 300 ms debounce
 *   timer calls, synchronously, so it is the debounced write without the timer.
 * - "save (debounced)" is the real path: `updateRun`, then the timer fires on its own. It is
 *   measured as the longest gap a `setImmediate` loop sees while waiting for the save (stop after
 *   a gap of at least half the flush median once 300 ms have passed, or at a timeout).
 * - "commit (1 row)" / "commit (10 rows)" are `commitDelegation` with each row's own delegation,
 *   the durable `commitIndex` path.
 * - The list routes run in-process through `app.request` (no socket), against a second store
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
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { cpus, totalmem, tmpdir, type as osType, release, arch } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import type { RunRecord, RunStore as RunStoreInstance } from '../src/runs/store.ts';
import { DEFAULT_FIXTURE_SEED, FIXTURE_PROFILES, generateRunFixture, type FixtureProfile } from './benchmark-run-store-fixture.ts';

const SCRIPT = fileURLToPath(import.meta.url);
const WARM_UP = 3;
const MIN_SAMPLES = 20;
const DEBOUNCE_MS = 300;
const TOUCH_EVERY_MS = 5;
const MULTI_ROWS = 10;

const SYNC_OPS = ['open', 'cold read', 'save (flush)', 'save (debounced)', 'commit (1 row)', 'commit (10 rows)'] as const;
const ROUTES = ['GET /runs', 'GET /workspace/runs-index'] as const;
type SyncOp = typeof SYNC_OPS[number];
type Route = typeof ROUTES[number];

interface ChildOptions { size: number; profile: FixtureProfile; process: number; samples: number; budgetSeconds: number; duration: number; seed: number }
interface ChildResult {
  size: number; profile: FixtureProfile; process: number; fixtureBytes: number; records: number;
  sync: Record<SyncOp, number[]>;
  routes: Record<Route, { wall: number[]; block: number[]; responseBytes: number }>;
  loop: { p50: number; p99: number; max: number; mean: number; touches: number; expectedTouches: number };
}

// ---- fixture seeding: the one storage-format-specific step --------------------------------

/**
 * Put `records` where `RunStore.open(dataDir)` finds them, exactly as `writeIndex` would write
 * them, and return the bytes stored. Replace with a store-level seeder after the migration.
 */
function seedRunStore(dataDir: string, records: readonly RunRecord[]): number {
  mkdirSync(join(dataDir, 'runs'), { recursive: true });
  const path = join(dataDir, 'runs.json');
  writeFileSync(path, JSON.stringify(records, null, 2), 'utf8');
  return statSync(path).size;
}

// ---- measurement helpers ------------------------------------------------------------------

async function sampleSync(options: ChildOptions, fn: (iteration: number) => void): Promise<number[]> {
  for (let i = 0; i < WARM_UP; i++) { fn(-1 - i); await yieldLoop(); }
  const samples: number[] = [];
  const started = performance.now();
  while (samples.length < options.samples &&
    !(samples.length >= Math.min(MIN_SAMPLES, options.samples) && performance.now() - started > options.budgetSeconds * 1000)) {
    const t0 = performance.now();
    fn(samples.length);
    samples.push(performance.now() - t0);
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

    // Targets are picked from the fixture data, never from store internals.
    const roots = records.filter((run) => run.delegation?.role === 'root');
    const singleTarget = roots.find((run) => run.delegation?.role === 'root' && run.delegation.conversation)?.id ?? roots[0]!.id;
    const multiTargets = records.filter((run) => run.delegation && run.delegation.role !== 'invalid').slice(0, MULTI_ROWS).map((run) => run.id);
    const active = records.find((run) => !run.archived)!;
    const saveTarget = records[Math.floor(records.length / 2)]!.id;

    const sync = {} as Record<SyncOp, number[]>;
    let store!: RunStoreInstance;
    gc();
    sync.open = await sampleSync(options, () => { store = RunStore.open(bootDir); });
    gc();
    sync['cold read'] = await sampleSync(options, () => { readRunIndexFromDisk(join(coldRoot, '.ai/cezar')); });
    gc();
    sync['save (flush)'] = await sampleSync(options, (iteration) => {
      store.updateRun(saveTarget, { seenAt: isoAt(iteration) });
      store.flush();
    });
    gc();
    const flushMedian = quantile(sync['save (flush)'], 0.5);
    const flushP95 = quantile(sync['save (flush)'], 0.95);
    const debounced: number[] = [];
    await sampleAsync(options, async (iteration) => {
      const { block } = await watchBlocking(async () => { store.updateRun(saveTarget, { seenAt: isoAt(iteration) }); },
        (elapsed, maxGap) => (elapsed > DEBOUNCE_MS && maxGap >= Math.max(2, flushMedian / 2)) ||
          elapsed > DEBOUNCE_MS + 3 * flushP95 + 200);
      if (iteration >= 0) debounced.push(block);
      await sleep(20);
    });
    sync['save (debounced)'] = debounced;
    gc();
    const commit = (ids: readonly string[]) => store.commitDelegation(ids.map((id) => ({ id, delegation: store.getRun(id)!.delegation! })));
    sync['commit (1 row)'] = await sampleSync(options, () => commit([singleTarget]));
    gc();
    sync['commit (10 rows)'] = await sampleSync(options, () => commit(multiTargets));
    gc();

    const routeStore = RunStore.open(bootDir);
    const app = createApp({
      repoRoot: join(root, 'boot'), store: routeStore, version: '0.0.0-bench',
      manager: { finishBlockedReason: () => null } as unknown as Parameters<typeof createApp>[0]['manager'],
    });
    const routes = {} as ChildResult['routes'];
    for (const [route, path] of [['GET /runs', '/api/v1/runs'], ['GET /workspace/runs-index', '/api/v1/workspace/runs-index']] as const) {
      const wall: number[] = [];
      const block: number[] = [];
      let responseBytes = 0;
      await sampleAsync(options, async (iteration) => {
        const measured = await watchBlocking(async () => {
          const response = await app.request(path, { headers: { host: '127.0.0.1:4321' } });
          if (response.status !== 200) throw new Error(`${route} answered ${response.status}`);
          responseBytes = (await response.text()).length;
        });
        if (iteration >= 0) { wall.push(measured.wall); block.push(measured.block); }
      });
      routes[route] = { wall, block, responseBytes };
      gc();
    }

    const histogram = monitorEventLoopDelay({ resolution: 1 });
    let touches = 0;
    histogram.enable();
    const timer = setInterval(() => {
      store.updateStep(active.id, 'task', { tokensUsed: 100_000 + (touches++ % 900_000) });
    }, TOUCH_EVERY_MS);
    await sleep(options.duration * 1000);
    clearInterval(timer);
    histogram.disable();
    store.flush();
    const ms = (ns: number) => ns / 1e6;
    const loop = {
      p50: ms(histogram.percentile(50)), p99: ms(histogram.percentile(99)), max: ms(histogram.max), mean: ms(histogram.mean),
      touches, expectedTouches: Math.floor((options.duration * 1000) / TOUCH_EVERY_MS),
    };

    const result: ChildResult = { size: options.size, profile: options.profile, process: options.process, fixtureBytes, records: records.length, sync, routes, loop };
    writeFileSync(resultPath, JSON.stringify(result));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ---- parent: orchestrate, aggregate, report -------------------------------------------------

interface ParentOptions { sizes: number[]; profiles: FixtureProfile[]; processes: number; samples: number; budgetSeconds: number; duration: number; seed: number; outDir: string }

function runChildProcess(options: ChildOptions, resultPath: string): Promise<void> {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('CEZ_')) delete env[key];
  const args = [...process.execArgv, '--expose-gc', '--max-old-space-size=8192', SCRIPT, '--child',
    '--size', String(options.size), '--profile', options.profile, '--process', String(options.process),
    '--samples', String(options.samples), '--budget-seconds', String(options.budgetSeconds),
    '--duration', String(options.duration), '--seed', String(options.seed), '--result', resultPath];
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

function aggregate(results: ChildResult[], options: ParentOptions) {
  const out: Record<string, Record<number, { metrics: Record<string, Cell>; fixtureBytes: number; responseBytes: Record<Route, number>; loop: Record<'p50' | 'p99' | 'max' | 'touchRate', Cell> }>> = {};
  for (const profile of options.profiles) {
    out[profile] = {};
    for (const size of options.sizes) {
      const group = results.filter((result) => result.profile === profile && result.size === size);
      if (group.length === 0) continue;
      const metrics: Record<string, Cell> = {};
      for (const op of SYNC_OPS) metrics[op] = cell(group.map((result) => result.sync[op]));
      for (const route of ROUTES) {
        metrics[`${route} block`] = cell(group.map((result) => result.routes[route].block));
        metrics[`${route} wall`] = cell(group.map((result) => result.routes[route].wall));
      }
      out[profile]![size] = {
        metrics,
        fixtureBytes: group[0]!.fixtureBytes,
        responseBytes: Object.fromEntries(ROUTES.map((route) => [route, group[0]!.routes[route].responseBytes])) as Record<Route, number>,
        loop: {
          p50: cell(group.map((result) => [result.loop.p50])), p99: cell(group.map((result) => [result.loop.p99])),
          max: cell(group.map((result) => [result.loop.max])),
          touchRate: cell(group.map((result) => [result.loop.touches / result.loop.expectedTouches])),
        },
      };
    }
  }
  return out;
}

const fmt = (value: number) => value >= 100 ? value.toFixed(0) : value >= 10 ? value.toFixed(1) : value.toFixed(2);
const mb = (bytes: number) => `${(bytes / 1e6).toFixed(1)} MB`;
const SAVE_METRICS = ['save (flush)', 'save (debounced)', 'commit (1 row)', 'commit (10 rows)'];
const BLOCKING_METRICS = [...SYNC_OPS, ...ROUTES.map((route) => `${route} block`)];

function report(aggregated: ReturnType<typeof aggregate>, options: ParentOptions, env: ReturnType<typeof environment>, order: string[]): { markdown: string; gate: unknown } {
  const lines: string[] = ['# Run-store benchmark (#779)', ''];
  lines.push(`- Revision: \`${env.revision}\`${env.dirty ? ' (uncommitted changes)' : ''}`, `- Node ${env.node}, ${env.os}, ${env.cpu}, ${env.memoryGb} GB RAM`,
    `- Date: ${env.date}`,
    `- ${options.processes} fresh processes per size x profile, shuffled; up to ${options.samples} samples per operation after ${WARM_UP} warm-ups, stopping after ${options.budgetSeconds} s once ${MIN_SAMPLES} are taken; ${options.duration} s active simulation; fixture seed ${options.seed}`,
    '- Cells: median / p95 in ms over all processes\' samples; `n` when the time budget cut sampling short', '');
  const expectedN = options.processes * options.samples;
  for (const [profile, bySize] of Object.entries(aggregated)) {
    const sizes = Object.keys(bySize).map(Number);
    lines.push(`## ${profile}`, '', `| Metric | ${sizes.map((size) => `${size} runs`).join(' | ')} |`, `| --- | ${sizes.map(() => '---:').join(' | ')} |`);
    lines.push(`| Fixture bytes | ${sizes.map((size) => mb(bySize[size]!.fixtureBytes)).join(' | ')} |`);
    const row = (label: string, key: string) => lines.push(`| ${label} | ${sizes.map((size) => {
      const value = bySize[size]!.metrics[key]!;
      return `${fmt(value.median)} / ${fmt(value.p95)}${value.n < expectedN ? ` (n=${value.n})` : ''}`;
    }).join(' | ')} |`);
    row('Open, sync', 'open');
    row('Cold read (`readRunIndexFromDisk`), sync', 'cold read');
    row('Save (`updateRun` + `flush`), sync', 'save (flush)');
    row('Save (real 300 ms debounce), longest block', 'save (debounced)');
    row('Commit 1 row (`commitDelegation`), sync', 'commit (1 row)');
    row(`Commit ${MULTI_ROWS} rows (\`commitDelegation\`), sync`, 'commit (10 rows)');
    for (const route of ROUTES) {
      row(`${route}, longest block`, `${route} block`);
      row(`${route}, wall (in-process)`, `${route} wall`);
    }
    lines.push(`| GET /runs response | ${sizes.map((size) => mb(bySize[size]!.responseBytes['GET /runs'])).join(' | ')} |`);
    lines.push(`| Active run: loop delay p50 / p99 / max | ${sizes.map((size) => {
      const loop = bySize[size]!.loop;
      return `${fmt(loop.p50.median)} / ${fmt(loop.p99.median)} / ${fmt(loop.max.median)}`;
    }).join(' | ')} |`);
    lines.push(`| Active run: touches done / scheduled | ${sizes.map((size) => `${(bySize[size]!.loop.touchRate.median * 100).toFixed(0)}%`).join(' | ')} |`, '');
  }
  lines.push('Loop-delay cells are the median across processes of each process\'s p50, p99 and max.', '');

  // Gate: does single-run save blocking grow with run count beyond noise, and is it the largest?
  const gate: Record<string, unknown> = {};
  lines.push('## Gate', '');
  for (const [profile, bySize] of Object.entries(aggregated)) {
    const sizes = Object.keys(bySize).map(Number).sort((a, b) => a - b);
    if (sizes.length < 2) { lines.push(`- ${profile}: needs at least two sizes.`); continue; }
    const small = sizes[0]!;
    const large = sizes[sizes.length - 1]!;
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
  lines.push('## Run order', '', order.join(', '), '');
  return { markdown: lines.join('\n'), gate };
}

async function runParent(options: ParentOptions): Promise<void> {
  mkdirSync(options.outDir, { recursive: true });
  const jobs: ChildOptions[] = [];
  for (const size of options.sizes) for (const profile of options.profiles) for (let p = 0; p < options.processes; p++) {
    jobs.push({ size, profile, process: p, samples: options.samples, budgetSeconds: options.budgetSeconds, duration: options.duration, seed: options.seed });
  }
  for (let i = jobs.length - 1; i > 0; i--) { const j = randomInt(i + 1); [jobs[i], jobs[j]] = [jobs[j]!, jobs[i]!]; }
  const env = environment();
  const results: ChildResult[] = [];
  const started = performance.now();
  for (const [index, job] of jobs.entries()) {
    const resultPath = join(options.outDir, `child-${job.size}-${job.profile}-${job.process}.json`);
    process.stderr.write(`[bench] ${index + 1}/${jobs.length} size=${job.size} profile=${job.profile} process=${job.process} (${((performance.now() - started) / 60_000).toFixed(1)} min elapsed)\n`);
    await runChildProcess(job, resultPath);
    results.push(JSON.parse(readFileSync(resultPath, 'utf8')) as ChildResult);
  }
  const aggregated = aggregate(results, options);
  const order = jobs.map((job) => `${job.size}/${job.profile}/${job.process}`);
  const { markdown, gate } = report(aggregated, options, env, order);
  writeFileSync(join(options.outDir, 'results.md'), markdown);
  writeFileSync(join(options.outDir, 'results.json'), JSON.stringify({ environment: env, options, order, aggregated, gate, results }, null, 2));
  process.stdout.write(`${markdown}\n`);
  process.stderr.write(`[bench] wrote ${join(options.outDir, 'results.md')} and results.json\n`);
}

// ---- entry ------------------------------------------------------------------------------------

const { values } = parseArgs({
  options: {
    child: { type: 'boolean', default: false }, quick: { type: 'boolean', default: false },
    sizes: { type: 'string' }, profiles: { type: 'string' }, processes: { type: 'string' }, samples: { type: 'string' },
    'budget-seconds': { type: 'string' }, duration: { type: 'string' }, seed: { type: 'string' }, 'out-dir': { type: 'string' },
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
const quick = values.quick;
const shared = {
  samples: positive(values.samples, quick ? 10 : 100, 'samples'),
  budgetSeconds: positive(values['budget-seconds'], quick ? 10 : 60, 'budget-seconds'),
  duration: positive(values.duration, quick ? 3 : 30, 'duration'),
  seed: positive(values.seed, DEFAULT_FIXTURE_SEED, 'seed'),
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
  });
}
