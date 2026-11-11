import { Home } from '../src/home/home.ts';
/**
 * Workspace stream benchmark (hearsay-tools/cezarion#2730): what one large delegation family costs
 * on `GET /api/v1/workspace/events`, full records versus summary rows, with a task detail open or
 * closed.
 *
 *   npm run bench:workspace-events -w @wjarka/cezarion -- --out /tmp/run-1.json
 *   taskset -c 3 node --import tsx packages/cezar/scripts/benchmark-workspace-events.ts --children 6
 *
 * Flags: --children (6 active workers) --events (300 run updates per phase) --rate (40 updates/s)
 * --connections (1 stream per phase) --parent-kb (256, padding in the parent's task) --child-kb (16)
 * --warmup (40 updates per unreported warmup phase) --out (write the JSON there as well as to stdout).
 *
 * The script runs unchanged on a cezar without the summary mode: that server ignores `?runs=summary`
 * and sends full records, so its "summary" phases measure the full stream again.
 *
 * Method:
 * - One process, one in-process app over a fresh store, no agents and no tests. One delegation root
 *   with a large task owns --children workers. Updates go round robin: every eighth one is the
 *   parent's own (token count and current step), the rest are worker token ticks.
 * - Two unreported warmup phases, then `none` (no stream, the store cost alone), then `full` and
 *   `summary`, each with the detail closed and open. A phase opens --connections streams, sends
 *   --events updates at --rate, then waits 600 ms for trailing work.
 * - Server: each update's synchronous dispatch time (store write, frame projection, stringify and
 *   enqueue on every connection), with `performance.now()`. Process CPU over the phase includes the
 *   in-process reader, so it is reported but not compared alone.
 * - Event bytes: every run frame one connection received, as written on the wire.
 * - Client: per frame, the work the cockpit does before it touches a cache. A full record: parse,
 *   then `toRunSummary` (the cockpit projected every record). A summary: parse, then the contract's
 *   zod schema.
 * - Detail open: the parent's detail is observed. A full stream patches it from the frame and
 *   refetches 400 ms after the parent goes quiet. A summary stream fetches it at once, then at most
 *   once per 400 ms for the parent's own events, and 400 ms after quiet for its workers' events
 *   (plan D1). Each fetch is a real `GET /runs/:id` against the app.
 * - API latency: `GET /workspace/runs-index` every 250 ms during the phase.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, loadavg, tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { installWindowsIdentityStore } from '../src/delegation/windows-identity-store.ts';

// Workspace receipts and markers use the host's identity store (ADR 0032).
installWindowsIdentityStore();

type RunManager = import('../src/workflows/run.ts').RunManager;
type RunRecord = import('../src/runs/store.ts').RunRecord;
interface Frame { event: string; data: string; bytes: number }

const BENCH_ENV = ['DRY_RUN', 'AUTONAME', 'PROJECT_WARMUP', 'REMOTE', 'HOME']
  .flatMap(suffix => [`CEZ_${suffix}`, `HSQ_${suffix}`]);

/** One run of the workload with these CLI arguments; returns the result the CLI prints. */
export async function runWorkspaceEventsBenchmark(argv: string[]): Promise<unknown> {
  const savedEnv = Object.fromEntries(BENCH_ENV.map((name) => [name, process.env[name]]));
  // What the run opened, newest last: released whether it finishes or throws.
  const cleanups: Array<() => unknown> = [];
  try {
    return await benchmark(argv, cleanups);
  } finally {
    for (const cleanup of cleanups.reverse()) await Promise.resolve().then(cleanup).catch(() => undefined);
    for (const name of BENCH_ENV) {
      if (savedEnv[name] === undefined) delete process.env[name];
      else process.env[name] = savedEnv[name];
    }
  }
}

async function benchmark(argv: string[], cleanups: Array<() => unknown>): Promise<unknown> {
  // Pin both names so operator aliases cannot change this isolated workload.
  process.env.HSQ_DRY_RUN = process.env.CEZ_DRY_RUN = '1';
  process.env.HSQ_AUTONAME = process.env.CEZ_AUTONAME = '0';
  process.env.HSQ_PROJECT_WARMUP = process.env.CEZ_PROJECT_WARMUP = '0';
  delete process.env.CEZ_REMOTE;
  delete process.env.HSQ_REMOTE;
  const home = mkdtempSync(join(tmpdir(), 'cez-bench-wsev-home-'));
  const repoRoot = mkdtempSync(join(tmpdir(), 'cez-bench-wsev-repo-'));
  cleanups.push(() => { for (const dir of [home, repoRoot]) rmSync(dir, { recursive: true, force: true }); });
  process.env.HSQ_HOME = process.env.CEZ_HOME = home;
  const selectedHome = Home.sandbox(home);
  mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });

  const { values } = parseArgs({ args: argv, options: {
    children: { type: 'string', default: '6' },
    events: { type: 'string', default: '300' },
    rate: { type: 'string', default: '40' },
    connections: { type: 'string', default: '1' },
    'parent-kb': { type: 'string', default: '256' },
    'child-kb': { type: 'string', default: '16' },
    warmup: { type: 'string', default: '40' },
    out: { type: 'string' },
  } });
  const childCount = Number(values.children), eventCount = Number(values.events), rate = Number(values.rate);
  const connectionCount = Number(values.connections), warmupCount = Number(values.warmup);
  const parentPad = 'p'.repeat(Number(values['parent-kb']) * 1024), childPad = 'c'.repeat(Number(values['child-kb']) * 1024);
  if (![childCount, eventCount, rate, connectionCount].every((n) => Number.isInteger(n) && n > 0)) {
    throw new Error('--children, --events, --rate and --connections take whole numbers > 0');
  }

  const { RunStore } = await import('../src/runs/store.ts');
  const { ProjectContexts } = await import('../src/server/project-context.ts');
  const { createRunner } = await import('../src/core/runner-factory.ts');
  const { listProjects, registerProject, clearProjectProbeCache } = await import('../src/workspace/projects.ts');
  const { WorkspaceEventBus, createApp } = await import('../src/server/server.ts');
  const { apiRequest } = await import('../src/server/loopback-request.testkit.ts');
  const { toRunSummary } = await import('@open-mercato/cezar-contract/runs');
  // Present only on a cezar with the summary mode; a full stream never needs it.
  let summarySchema: { safeParse(value: unknown): { success: boolean } } | undefined;
  try {
    summarySchema = (await import('@open-mercato/cezar-contract/workspace-events') as { workspaceRunSummaryEventSchema?: typeof summarySchema }).workspaceRunSummaryEventSchema;
  } catch {
    summarySchema = undefined;
  }

  clearProjectProbeCache();
  const store = RunStore.open(join(repoRoot, '.ai/cezar'), { keepLive: true });
  const contexts = new ProjectContexts({ createRunner, home: selectedHome, listProjects: () => listProjects(undefined, selectedHome) });
  cleanups.push(() => { contexts.disposeAll(); store.flush(); });
  await registerProject(repoRoot, undefined, selectedHome);
  const app = createApp({
    home: selectedHome, repoRoot, store, version: '0.0.0-bench', contexts, workspaceEvents: new WorkspaceEventBus(),
    manager: { isActive: () => false, finishBlockedReason: () => undefined } as unknown as RunManager,
  });

  // ---- the family ------------------------------------------------------------------------------
  const steps = Array.from({ length: 12 }, (_, i) => ({ id: `step-${i}`, name: `Step ${i}`, kind: 'agent' as const }));
  const parent = store.createRun({ title: 'Large delegation parent', workflow: 'quick-task', task: parentPad, steps });
  const workers: RunRecord[] = [];
  for (let i = 0; i < childCount; i++) {
    const worker = store.createRun({ title: `Worker ${i}`, workflow: 'quick-task', task: childPad, steps: steps.slice(0, 4) });
    store.updateRun(worker.id, {
      delegation: {
        role: 'worker', parentRunId: parent.id, permissions: [],
        workspace: { ownerRunId: worker.id, resourceId: randomUUID(), kind: 'owned-isolated', path: `/tmp/worker-${i}`, branch: `cez/worker-${i}`, baselineSha: 'a'.repeat(40) },
      },
    });
    workers.push(worker);
  }
  store.updateRun(parent.id, {
    delegation: {
      role: 'root', permissions: [],
      receipts: workers.map((worker) => ({ requestId: randomUUID(), workerId: worker.id, requestHash: 'b'.repeat(64) })),
    },
  });
  store.flush();
  const workerIds = new Set(workers.map((worker) => worker.id));

  // ---- helpers ---------------------------------------------------------------------------------
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const quantile = (values: number[], q: number): number | null => {
    if (values.length === 0) return null;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
  };
  const stats = (values: number[]) => ({ n: values.length, p50: quantile(values, 0.5), p95: quantile(values, 0.95),
    total: values.reduce((sum, value) => sum + value, 0) });
  const round = (value: unknown): unknown => {
    if (typeof value === 'number') return Math.round(value * 1000) / 1000;
    if (Array.isArray(value)) return value.map(round);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, round(inner)]));
    return value;
  };


  /** One SSE connection, read into frames until closed. */
  async function openStream(url: string, onFrame: (frame: Frame) => void) {
    const response = await apiRequest(app, url);
    if (response.status !== 200 || !response.body) throw new Error(`${url} answered ${response.status}`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let resolveReady!: () => void;
    const ready = new Promise<void>((resolve) => { resolveReady = resolve; });
    const pump = (async () => {
      for (;;) {
        const next = await reader.read().catch(() => ({ done: true, value: undefined }));
        if (next.done || !next.value) return;
        buffer += decoder.decode(next.value, { stream: true });
        let end: number;
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const event = /^event: (.*)$/m.exec(block)?.[1] ?? 'message';
          const data = [...block.matchAll(/^data: ?(.*)$/gm)].map((match) => match[1]).join('\n');
          if (event === 'ping') resolveReady();
          onFrame({ event, data, bytes: Buffer.byteLength(`${block}\n\n`) });
        }
      }
    })();
    await ready;
    return { close: async () => { await reader.cancel().catch(() => undefined); await pump; } };
  }

  /** The parent detail's fetches under one stream mode's rule (see the header). */
  function detailPolicy(mode: 'full' | 'summary', fetches: Array<Promise<void>>, latencies: number[], bytes: number[]) {
    let lastStart = -Infinity;
    let inFlight = false;
    let owed = false;
    let throttle: ReturnType<typeof setTimeout> | undefined;
    let quiet: ReturnType<typeof setTimeout> | undefined;
    const fetchNow = () => {
      inFlight = true;
      lastStart = performance.now();
      const started = performance.now();
      fetches.push(apiRequest(app, `/api/v1/runs/${parent.id}`).then(async (response) => {
        bytes.push(Buffer.byteLength(await response.text()));
        latencies.push(performance.now() - started);
      }).finally(() => { inFlight = false; pumpOwn(); }));
    };
    const pumpOwn = () => {
      if (!owed || throttle !== undefined || inFlight) return;
      const wait = lastStart + 400 - performance.now();
      if (wait > 0) { throttle = setTimeout(() => { throttle = undefined; pumpOwn(); }, wait); return; }
      owed = false;
      fetchNow();
    };
    const afterQuiet = () => {
      clearTimeout(quiet);
      quiet = setTimeout(() => { quiet = undefined; fetchNow(); }, 400);
    };
    return {
      onRun(id: string, parentRunId: string | undefined) {
        if (id === parent.id) {
          if (mode === 'full') afterQuiet();
          else { owed = true; pumpOwn(); }
        } else if (parentRunId === parent.id) {
          afterQuiet();
        }
      },
      stop() { clearTimeout(throttle); clearTimeout(quiet); },
    };
  }

  /** The cockpit's per-frame work before a cache write, timed. */
  function clientCost(frame: Frame): number {
    const started = performance.now();
    const payload = JSON.parse(frame.data) as Record<string, unknown>;
    if (frame.event === 'run') toRunSummary(payload as unknown as RunRecord);
    else if (frame.event === 'run-summary') summarySchema?.safeParse(payload);
    return performance.now() - started;
  }

  async function phase(name: string, url: string | undefined, detailOpen: boolean, events = eventCount) {
    const frames: Frame[] = [];
    const fetches: Array<Promise<void>> = [];
    const detailLatency: number[] = [], detailBytes: number[] = [];
    let policy: ReturnType<typeof detailPolicy> | undefined;
    const streams: Array<{ close: () => Promise<void> }> = [];
    let probing = true;
    cleanups.push(() => { probing = false; policy?.stop(); return Promise.all(streams.map((stream) => stream.close())); });
    if (url) {
      for (let i = 0; i < connectionCount; i++) {
        streams.push(await openStream(url, i > 0 ? () => undefined : (frame) => {
          if (frame.event !== 'run' && frame.event !== 'run-summary' && frame.event !== 'run-deleted') return;
          frames.push(frame);
          if (!policy || frame.event === 'run-deleted') return;
          const payload = JSON.parse(frame.data) as { id?: string; run?: { id: string; delegation?: { parentRunId?: string } }; delegation?: { parentRunId?: string } };
          const run = frame.event === 'run-summary' ? payload.run : payload;
          if (run?.id) policy.onRun(run.id, run.delegation?.parentRunId);
        }));
      }
      if (detailOpen) policy = detailPolicy(url.includes('runs=summary') && summarySchema ? 'summary' : 'full', fetches, detailLatency, detailBytes);
    }
    const indexLatency: number[] = [];
    const prober = (async () => {
      while (probing) {
        const started = performance.now();
        await (await apiRequest(app, '/api/v1/workspace/runs-index')).text();
        indexLatency.push(performance.now() - started);
        await sleep(250);
      }
    })();

    const loadBefore = loadavg();
    const cpuBefore = process.cpuUsage();
    const dispatch: number[] = [];
    const started = performance.now();
    for (let i = 0; i < events; i++) {
      const target = i % 8 === 0 ? parent : workers[i % workers.length]!;
      const patch = target === parent ? { tokensUsed: i, currentStepId: `step-${i % steps.length}` } : { tokensUsed: i };
      const t0 = performance.now();
      store.updateRun(target.id, patch);
      dispatch.push(performance.now() - t0);
      const next = started + ((i + 1) * 1000) / rate;
      const wait = next - performance.now();
      if (wait > 0) await sleep(wait);
    }
    await sleep(600);
    probing = false;
    await prober;
    policy?.stop();
    await Promise.all(fetches);
    const cpu = process.cpuUsage(cpuBefore);
    const loadAfter = loadavg();
    for (const stream of streams) await stream.close();

    const frameBytes = frames.map((frame) => frame.bytes);
    const client = frames.map(clientCost);
    const kinds = [...new Set(frames.map((frame) => frame.event))];
    return {
      name, url: url ?? null, detailOpen, events, connections: url ? connectionCount : 0, frameKinds: kinds,
      loadavgBefore: loadBefore, loadavgAfter: loadAfter,
      serverDispatchMs: stats(dispatch),
      processCpuMs: (cpu.user + cpu.system) / 1000,
      eventBytes: stats(frameBytes),
      clientParseMs: stats(client),
      detailFetches: { count: detailLatency.length, bytes: detailBytes.reduce((sum, value) => sum + value, 0), latencyMs: stats(detailLatency) },
      totalBytes: frameBytes.reduce((sum, value) => sum + value, 0) + detailBytes.reduce((sum, value) => sum + value, 0),
      runsIndexLatencyMs: stats(indexLatency),
    };
  }

  const sizes = {
    parentRecordBytes: Buffer.byteLength(JSON.stringify(store.getRun(parent.id))),
    workerRecordBytes: Buffer.byteLength(JSON.stringify(store.getRun(workers[0]!.id))),
    parentSummaryBytes: Buffer.byteLength(JSON.stringify(toRunSummary(store.getRun(parent.id)!))),
  };
  // Warm the JIT and the store on every path first; these phases are not reported.
  await phase('warmup', '/api/v1/workspace/events', true, warmupCount);
  await phase('warmup', '/api/v1/workspace/events?runs=summary', true, warmupCount);
  const phases = [];
  phases.push(await phase('none', undefined, false));
  for (const [mode, url] of [['full', '/api/v1/workspace/events'], ['summary', '/api/v1/workspace/events?runs=summary']] as const) {
    for (const detailOpen of [false, true]) phases.push(await phase(`${mode}/${detailOpen ? 'detail-open' : 'detail-closed'}`, url, detailOpen));
  }

  const result = round({
    benchmark: 'workspace-events', at: new Date().toISOString(), node: process.version, cpus: cpus().length,
    cpuModel: cpus()[0]?.model, summaryModeSupported: summarySchema !== undefined && workerIds.size === childCount,
    options: { children: childCount, events: eventCount, rate, connections: connectionCount, parentKb: Number(values['parent-kb']), childKb: Number(values['child-kb']) },
    sizes, phases,
  });
  if (values.out) writeFileSync(values.out, `${JSON.stringify(result, null, 2)}\n`);
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdout.write(`${JSON.stringify(await runWorkspaceEventsBenchmark(process.argv.slice(2)), null, 2)}\n`);
  process.exit(0);
}
