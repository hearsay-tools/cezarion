/** Integration-only: npm run build:server && node packages/cezar/scripts/measure-transcript-facts-health.mjs
 * Boots the actual loopback server; deliberately never imported by the fast tests.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { seedColdHistories, verifyFacts } from './transcript-facts-fixture.mjs';

const root = mkdtempSync(join(process.platform === 'win32' ? tmpdir() : '/tmp', 'cez-facts-health-'));
// The experiment has no external peers, credentials, background updater, or real home.
for (const key of Object.keys(process.env)) if (key.startsWith('CEZ_')) delete process.env[key];
process.env.CEZ_HOME = join(root, 'home');
process.env.CEZ_SKILLS_AUTO_UPDATE = '0';
process.env.CEZ_DRY_RUN = '1';
const runtime = { url: new URL('../dist/', import.meta.url), ext: 'js' };
const dataDir = join(root, 'cold-project', '.ai/cezar');
let store;
let bootStore;
let server;
const watchdog = setTimeout(() => { console.error('health measurement exceeded 30s'); process.exitCode = 1; server?.closeAllConnections(); server?.close(); store?.close(); bootStore?.close(); }, 30_000);
try {
  const { RunStore } = await import(new URL('runs/store.js', runtime.url));
  const { startServer } = await import(new URL('server/server.js', runtime.url));
  // Keep git discovery away from the user's parent repository, even if TMPDIR
  // was set inside a cezar worktree. This repo contains only the experiment.
  execFileSync('git', ['init', '--initial-branch=main'], { cwd: root, stdio: 'ignore' });
  const fixtures = await seedColdHistories(dataDir, runtime);
  global.gc?.();
  // Project-open scenario: establish the real HTTP/client path before opening a
  // second cold store on this same event loop. No transcript sidecar is primed.
  bootStore = RunStore.open(join(root, '.ai/cezar'));
  await bootStore.factsWarmIdle();
  server = startServer({ repoRoot: root, store: bootStore, manager: {}, version: 'task4-measurement', bindHost: '127.0.0.1' }, 0);
  if (!server.listening) await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const endpoint = `http://127.0.0.1:${address.port}/api/v1/health`;
  const primingStart = performance.now();
  const prime = await fetch(endpoint, { signal: AbortSignal.timeout(2_000) });
  assert.equal(prime.status, 200);
  assert.equal((await prime.json()).version, 'task4-measurement');
  const primingLatencyMs = performance.now() - primingStart;
  assert.equal(readdirSync(join(dataDir, 'runs')).filter(name => name.endsWith('.facts.json')).length, 0);
  const start = performance.now();
  store = RunStore.open(dataDir);
  let end;
  const warming = store.factsWarmIdle().then(() => { end = performance.now(); });
  const samples = [];
  while (end === undefined) {
    const requestStart = performance.now();
    const cpuStart = process.threadCpuUsage();
    const response = await fetch(endpoint, { signal: AbortSignal.timeout(2_000) });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).version, 'task4-measurement');
    const requestEnd = performance.now();
    // Include EVERY request begun while cold warm-up was active, even one ending after it.
    const cpu = process.threadCpuUsage(cpuStart);
    samples.push({ startMs: requestStart - start, endMs: requestEnd - start, latencyMs: requestEnd - requestStart,
      mainThreadCpuMs: (cpu.user + cpu.system) / 1000 });
    await delay(5);
  }
  await warming;
  assert.ok(samples.length > 0, 'health requests must overlap cold warming');
  assert.ok(samples.every(sample => sample.startMs < end - start && sample.endMs > 0));
  const result = { kind: 'transcript-facts-http-health', runtime: runtime.url.href,
    endpoint: '/api/v1/health', scenario: 'already-listening server during cold project open', primingLatencyMs,
    ...verifyFacts(dataDir, fixtures, store), durationMs: end - start,
    sampleCount: samples.length, maxLatencyMs: Math.max(...samples.map(sample => sample.latencyMs)), samples };
  console.log(JSON.stringify(result));
  assert.ok(result.maxLatencyMs < 50, `max health latency ${result.maxLatencyMs.toFixed(3)}ms must be <50ms`);
} finally {
  clearTimeout(watchdog);
  let cleanupTimer;
  try {
    if (server) await Promise.race([server.shutdownForRestart(), new Promise((_, reject) => {
      cleanupTimer = setTimeout(() => reject(new Error('server cleanup timed out')), 5_000);
    })]);
  } finally {
    clearTimeout(cleanupTimer);
    store?.close();
    bootStore?.close();
    rmSync(root, { recursive: true, force: true });
  }
}
