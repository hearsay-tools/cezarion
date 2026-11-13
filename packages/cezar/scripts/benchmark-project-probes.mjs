/**
 * Isolated project-list HTTP workload for hearsay-tools/cezarion#2733.
 * Run unchanged on both refs: node --import tsx <script> --out <file.json>.
 * The fixture server measures its own CPU; the HTTP client runs in its parent.
 * Git CPU is reaped-child CPU from /proc/self/stat (Linux, CLK_TCK precision).
 * No agents, run stores, or live cockpit are involved. Setup is excluded.
 */
import childProcess, { fork } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { loadavg, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs, promisify } from 'node:util';
import { benchmarkHome } from './benchmark-home.ts';

const { values } = parseArgs({ options: {
  out: { type: 'string' }, repeats: { type: 'string', default: '5' },
  'fixture-server': { type: 'boolean' },
} });

async function serveFixture() {
  const originalExec = childProcess.execFile;
  let commands = {};
  function count(args) {
    if (args[0] !== 'git') return;
    const key = args[1].join(' ');
    commands[key] = (commands[key] ?? 0) + 1;
  }
  // execFile has a custom promisifier. Count it as well as callback calls.
  // A bound proxy target permits replacing the non-configurable custom symbol.
  childProcess.execFile = new Proxy(originalExec.bind(null), {
    apply(target, thisArg, args) { count(args); return Reflect.apply(target, thisArg, args); },
    get(target, key, receiver) {
      const value = Reflect.get(originalExec, key, receiver);
      if (key !== promisify.custom || typeof value !== 'function') return value;
      return (...args) => { count(args); return Reflect.apply(value, target, args); };
    },
  });
  syncBuiltinESMExports();
  const { listProjects, clearProjectProbeCache } = await import('../src/workspace/projects.ts');
  const { mergeWriteWorkspaceConfig } = await import('../src/workspace/config.ts');
  const { resolveHome } = await import('../src/home/resolve.ts');
  const home = benchmarkHome(resolveHome({ purpose: 'cli' }));
  const hz = Number(childProcess.execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }).trim());
  const gitCpuMs = () => {
    const fields = readFileSync('/proc/self/stat', 'utf8').split(') ')[1].split(' ');
    return (Number(fields[13]) + Number(fields[14])) * 1000 / hz;
  };
  const server = createServer((_request, response) => {
    listProjects(home).then((projects) => {
      response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(projects));
    }).catch((error) => { response.statusCode = 500; response.end(String(error)); });
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const url = `http://127.0.0.1:${server.address().port}/projects`;
  let cpu;
  let childCpu;
  async function handle(message) {
    if (message.kind === 'configure') {
      await mergeWriteWorkspaceConfig((config) => {
        config.projects = message.roots.map((root, i) => ({
          id: `project-${i}`, name: `Project ${i}`, root, source: 'local',
          addedAt: '2026-11-06T00:00:00Z', lastOpenedAt: '2026-11-06T00:00:00Z',
        }));
      }, home);
    }
    if (message.kind === 'clear') clearProjectProbeCache();
    if (message.kind === 'begin') { commands = {}; cpu = process.cpuUsage(); childCpu = gitCpuMs(); }
    if (message.kind !== 'end') return { url };
    const delta = process.cpuUsage(cpu);
    return { commands, serverCpuMs: (delta.user + delta.system) / 1000, gitChildCpuMs: gitCpuMs() - childCpu };
  }
  process.on('message', (message) => {
    handle(message).then((result) => process.send({ result })).catch((error) => process.send({ error: String(error) }));
  });
  const close = () => { server.closeAllConnections(); server.close(() => process.exit(0)); };
  process.on('disconnect', close);
  process.on('SIGTERM', close);
}

/** One sequential control message; HTTP requests use the fixture's loopback port. */
function control(child, message) {
  return new Promise((resolve, reject) => {
    const cleanup = () => { child.off('message', received); child.off('exit', exited); child.off('error', failed); };
    const received = (reply) => { cleanup(); if (reply.error) reject(new Error(reply.error)); else resolve(reply.result); };
    const exited = (code) => { cleanup(); reject(new Error(`Fixture exited (${code})`)); };
    const failed = (error) => { cleanup(); reject(error); };
    child.once('message', received); child.once('exit', exited); child.once('error', failed);
    child.send(message);
  });
}

async function benchmark() {
  const repeats = Number(values.repeats);
  if (!Number.isInteger(repeats) || repeats < 1) throw new Error('--repeats must be positive');
  const fixture = mkdtempSync(join(tmpdir(), 'cez-project-probes-'));
  let child;
  const rows = [];
  const git = (root, ...args) => childProcess.execFileSync('git', args, {
    cwd: root, stdio: 'ignore', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
  });
  try {
    const roots = [];
    for (let i = 0; i < 40; i++) {
      const root = join(fixture, `repo-${i}`); mkdirSync(root); roots.push(root);
      git(root, 'init', '-q', '-b', 'main');
      git(root, '-c', 'user.name=bench', '-c', 'user.email=bench@local', '-c', 'maintenance.auto=false', 'commit', '--allow-empty', '-qm', 'base');
      git(root, 'remote', 'add', 'origin', 'https://github.com/fixture/project.git');
    }
    const plain = join(fixture, 'plain'); mkdirSync(plain);
    child = fork(fileURLToPath(import.meta.url), ['--fixture-server'], {
      env: { ...process.env, CEZ_HOME: join(fixture, 'home'), HSQ_HOME: join(fixture, 'home') }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    });
    for (let repeat = 0; repeat < repeats; repeat++) {
      for (const count of [1, 10, 40]) {
        const { url } = await control(child, { kind: 'configure', roots: [...roots.slice(0, count), plain, join(fixture, 'missing')] });
        for (const concurrency of [1, 4, 16]) {
          for (const phase of ['cold', 'warm', 'expired', 'concurrent']) {
            if (phase === 'cold' || phase === 'concurrent') await control(child, { kind: 'clear' });
            // Use real expiry; never change the product's five-second TTL.
            if (phase === 'expired') await sleep(5001);
            const loadBefore = loadavg();
            await control(child, { kind: 'begin' });
            const latencies = await Promise.all(Array.from({ length: concurrency }, async () => {
              const start = performance.now();
              const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
              if (!response.ok) throw new Error(await response.text());
              const projects = await response.json();
              if (projects.at(-1)?.status !== 'missing' || projects.at(-2)?.status !== 'not-git') throw new Error('Incorrect project status');
              return performance.now() - start;
            }));
            const metrics = await control(child, { kind: 'end' });
            latencies.sort((a, b) => a - b);
            const percentile = (p) => latencies[Math.ceil(p * latencies.length) - 1];
            rows.push({ repeat, repos: count, concurrency, phase, ...metrics,
              requests: latencies.length, p50Ms: percentile(.5), p95Ms: percentile(.95), maxMs: latencies.at(-1),
              loadBefore, loadAfter: loadavg() });
          }
        }
      }
    }
    const result = { node: process.version, platform: process.platform,
      cpus: readFileSync('/proc/self/status', 'utf8').match(/^Cpus_allowed_list:\s*(.*)$/m)?.[1], rows };
    const json = JSON.stringify(result, null, 2) + '\n';
    if (values.out) writeFileSync(values.out, json); else process.stdout.write(json);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      await new Promise((done) => { child.once('exit', done); child.kill('SIGTERM'); });
    }
    rmSync(fixture, { recursive: true, force: true });
  }
}

if (values['fixture-server']) await serveFixture(); else await benchmark();
