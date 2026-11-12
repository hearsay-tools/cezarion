#!/usr/bin/env node
// Test a published package as a user gets it: install it from the registry into an empty
// prefix, boot it, and load the cockpit. With --upgrade-from, first boot the older version
// on the same home and project, then check the new version keeps that state.
// Used by .github/workflows/release-candidate-tests.yml and the Release promotion
// (docs/publishing.md § Stable releases).
//
//   node scripts/release-smoke.mjs --package <name> --version <version> [--upgrade-from <version>]
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { get } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const NAME = /^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 2) {
    const [flag, value] = [argv[i], argv[i + 1]];
    if (!['--package', '--version', '--upgrade-from'].includes(flag) || value === undefined) {
      throw new Error('Usage: release-smoke.mjs --package <name> --version <version> [--upgrade-from <version>]');
    }
    options[flag.slice(2)] = value;
  }
  if (!NAME.test(options.package ?? '')) throw new Error(`Invalid package name: ${options.package}`);
  for (const key of ['version', 'upgrade-from']) {
    if (options[key] !== undefined && !VERSION.test(options[key])) throw new Error(`Invalid ${key}: ${options[key]}`);
  }
  if (!options.version) throw new Error('--version is required');
  return { name: options.package, version: options.version, upgradeFrom: options['upgrade-from'] };
}

// The cockpit page loads one module script from /assets; a fallback hint page has none.
export function cockpitAsset(html) {
  const match = /<script[^>]*type="module"[^>]*src="(\/assets\/[^"]+\.js)"/.exec(html);
  return match ? match[1] : null;
}

// No ambient product setting reaches the booted package: a runner or a developer shell
// may carry CEZ_*/HSQ_* values that change what boots.
export function bootEnv(env, home) {
  const clean = Object.fromEntries(Object.entries(env).filter(([key]) => !/^(CEZ|HSQ)_/i.test(key)));
  const productHome = join(home, 'product');
  const userHome = join(home, 'user');
  return {
    ...clean, HOME: userHome, USERPROFILE: userHome,
    CEZ_HOME: productHome, HSQ_HOME: productHome,
    CEZ_DRY_RUN: '1', HSQ_DRY_RUN: '1', CEZ_AUTONAME: '0', HSQ_AUTONAME: '0', CEZ_REMOTE: '0', HSQ_REMOTE: '0',
  };
}

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

// A version published seconds ago can be missing from a registry mirror for a while.
async function install(prefix, spec) {
  mkdirSync(prefix, { recursive: true });
  for (let attempt = 1; ; attempt++) {
    try {
      execFileSync(npm, ['install', '--prefix', prefix, '--no-audit', '--no-fund', '--loglevel=error', spec],
        { stdio: 'inherit', shell: process.platform === 'win32' });
      return;
    } catch (error) {
      if (attempt >= 20) throw error;
      console.log(`release-smoke: ${spec} is not installable yet (attempt ${attempt}); retrying in 15 s.`);
      await delay(15_000);
    }
  }
}

function binary(prefix, name) {
  const dir = join(prefix, 'node_modules', ...name.split('/'));
  const bin = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).bin;
  const entry = typeof bin === 'string' ? bin : bin?.hsq ?? bin?.cez ?? Object.values(bin ?? {})[0];
  if (!entry) throw new Error(`${name} declares no binary`);
  return join(dir, entry);
}

async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  server.close();
  await once(server, 'close');
  return port;
}

// node:http, so an ambient HTTP proxy cannot intercept the loopback request.
function localGet(url) {
  return new Promise((resolve, reject) => {
    const request = get(url, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, type: response.headers['content-type'] ?? '', body }));
      response.on('error', reject);
    });
    request.on('error', reject);
    request.setTimeout(5_000, () => request.destroy(new Error(`Timed out: ${url}`)));
  });
}

async function boot({ bin, home, repo }) {
  const port = await freePort();
  const child = spawn(process.execPath, [bin, '--port', String(port), '--no-open', '--repo', repo],
    { cwd: repo, env: bootEnv(process.env, home), stdio: ['ignore', 'inherit', 'inherit'] });
  const exited = once(child, 'exit');
  const base = `http://127.0.0.1:${port}`;
  // bound: a cold first boot migrates the home and builds the project index.
  for (const deadline = Date.now() + 120_000; Date.now() < deadline;) {
    if (child.exitCode !== null) throw new Error(`The server exited with ${child.exitCode} before it answered`);
    try {
      const response = await localGet(`${base}/api/v1/health`);
      if (response.status === 200) return { base, health: JSON.parse(response.body), stop: () => stop(child, exited) };
    } catch { /* not listening yet */ }
    await delay(500);
  }
  await stop(child, exited);
  throw new Error('The server did not answer /api/v1/health within 120 s');
}

async function stop(child, exited) {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  const timer = delay(15_000).then(() => child.kill('SIGKILL'));
  await exited;
  timer.catch(() => {});
}

async function checkCockpit(base) {
  const page = await localGet(`${base}/`);
  const asset = page.status === 200 ? cockpitAsset(page.body) : null;
  if (!asset) throw new Error(`The cockpit page did not load its module script (HTTP ${page.status})`);
  const script = await localGet(`${base}${asset}`);
  if (script.status !== 200 || !/javascript/.test(script.type)) throw new Error(`The cockpit script ${asset} answered HTTP ${script.status} (${script.type})`);
}

async function run({ name, version, upgradeFrom }) {
  const root = mkdtempSync(join(tmpdir(), 'release-smoke-'));
  try {
    const repo = join(root, 'repo');
    mkdirSync(repo);
    const git = (...args) => execFileSync('git', ['-c', 'user.name=Release smoke', '-c', 'user.email=smoke@example.invalid', ...args], { cwd: repo, stdio: 'ignore' });
    git('init', '-q', '-b', 'main');
    git('commit', '--allow-empty', '-qm', 'fixture');
    const home = join(root, 'home');
    let before = [];
    if (upgradeFrom) {
      await install(join(root, 'previous'), `${name}@${upgradeFrom}`);
      const server = await boot({ bin: binary(join(root, 'previous'), name), home, repo });
      before = server.health.projects.map(project => project.id);
      await server.stop();
      if (!before.length) throw new Error(`${upgradeFrom} registered no project; the upgrade check has no state to keep`);
      console.log(`release-smoke: ${upgradeFrom} booted with projects ${before.join(', ')}.`);
    }
    await install(join(root, 'current'), `${name}@${version}`);
    const server = await boot({ bin: binary(join(root, 'current'), name), home, repo });
    try {
      if (server.health.version !== version) throw new Error(`Booted version ${server.health.version}, expected ${version}`);
      const after = new Set(server.health.projects.map(project => project.id));
      const lost = before.filter(id => !after.has(id));
      if (lost.length) throw new Error(`The upgrade lost projects: ${lost.join(', ')}`);
      if (!after.size) throw new Error('The booted server registered no project');
      await checkCockpit(server.base);
    } finally { await server.stop(); }
    console.log(`release-smoke: ${name}@${version} installed, booted and served the cockpit${upgradeFrom ? ` after ${upgradeFrom}` : ''} on Node ${process.version}.`);
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 5 }); }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  run(parseArgs(process.argv.slice(2))).catch(error => {
    console.error(`release-smoke: ${error.message}`);
    process.exitCode = 1;
  });
}
