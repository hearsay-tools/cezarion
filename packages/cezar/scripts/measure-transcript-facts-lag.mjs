/** Dedicated server-free regression (intentionally outside parallel Vitest discovery).
 * node --expose-gc --import tsx packages/cezar/scripts/measure-transcript-facts-lag.mjs
 * Built runtime: pass an absolute dist directory. Baseline source: pass its src directory and ts.
 * A separate process removes test-runner loop work, NOT unrelated host CPU scheduling.
 * Keep every sample and the strict wall-time ceiling; investigate load instead of retrying here.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { seedColdHistories, verifyFacts } from './transcript-facts-fixture.mjs';

const runtime = { url: process.argv[2] ? pathToFileURL(process.argv[2] + '/') : new URL('../src/', import.meta.url), ext: process.argv[3] ?? (process.argv[2] ? 'js' : 'ts') };
const { RunStore } = await import(new URL('runs/store.' + runtime.ext, runtime.url));
const dir = mkdtempSync(join(tmpdir(), 'cez-facts-lag-'));
let store;
let timer;
try {
  const fixtures = await seedColdHistories(dir, runtime);
  // Fixture allocation/collection belongs to setup, not the measured warm path.
  global.gc?.();
  const periodMs = 20;
  const ticks = [];
  let previous = performance.now();
  let previousCpu = process.threadCpuUsage();
  timer = setInterval(() => {
    const at = performance.now();
    const cpu = process.threadCpuUsage();
    ticks.push({ at, lagMs: Math.max(0, at - previous - periodMs),
      mainThreadCpuMs: (cpu.user + cpu.system - previousCpu.user - previousCpu.system) / 1000 });
    previousCpu = cpu;
    previous = at;
  }, periodMs);
  // Establish a real interval before starting; retain the first tick after completion too.
  await delay(periodMs * 2);
  const start = performance.now();
  store = RunStore.open(dir);
  await store.factsWarmIdle();
  const end = performance.now();
  while (!ticks.some(tick => tick.at > end)) await delay(periodMs);
  clearInterval(timer);
  const overlapping = ticks.filter(tick => tick.at >= start && tick.at <= end);
  const result = { kind: 'transcript-facts-lag', runtime: runtime.url.href, periodMs,
    ...verifyFacts(dir, fixtures, store), durationMs: end - start, ticks: ticks.length,
    beforeTicks: ticks.filter(tick => tick.at < start).length,
    trailingTicks: ticks.filter(tick => tick.at > end).length,
    overlappingTicks: overlapping.length, maxLagMs: Math.max(...ticks.map(tick => tick.lagMs)),
    samples: ticks.map(tick => ({ offsetMs: tick.at - start, lagMs: tick.lagMs, mainThreadCpuMs: tick.mainThreadCpuMs })) };
  console.log(JSON.stringify(result));
  assert.equal(result.histories, 700);
  assert.equal(result.sidecars, 700);
  assert.equal(result.plain, 350);
  assert.equal(result.brotli, 350);
  assert.equal(result.events, 105_592);
  assert.ok(result.largestBytes > 40_000_000);
  assert.equal(result.coldSidecars, 0);
  assert.ok(result.beforeTicks > 0, 'must establish the interval before warming');
  assert.ok(result.trailingTicks > 0, 'must retain a trailing tick after warming');
  assert.ok(overlapping.length > 0, 'must sample during cold warm-up');
  assert.ok(result.durationMs > 0);
  assert.ok(result.maxLagMs < 20, `max extra interval lag ${result.maxLagMs.toFixed(3)}ms must be <20ms`);
} finally {
  clearInterval(timer);
  store?.close();
  rmSync(dir, { recursive: true, force: true });
}
