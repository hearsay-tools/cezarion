// A registered throwaway project for a manual UI check (hearsay-tools/cezarion#1406).
//
//   node .ai/scripts/qa-fixture.mjs up [--server-env=CEZ_NAME=value]...
//   node .ai/scripts/qa-fixture.mjs down
//
// `up` builds the VITE_CEZ_E2E=1 cockpit into a temporary root and serves it under
// CEZ_DRY_RUN=1 on a new Git repository with its own CEZ_HOME. The repository is a registered
// project, so every project setting is reachable. The shared test env cannot do this from a
// task worktree: the clone it serves sits under `.ai/cezar/worktrees/`, where
// `shouldRegisterProject` suppresses registration. This script does not go through
// test-env-up.sh either. That script holds the test-env lease, which Squeal's browser tier
// keeps while its specs run, and every rebuild replaces its build directory.
//
// `down` stops the server's process group and removes the temporary root. A watcher stops the
// fixture when nobody runs `down`: when the descriptor goes (the worktree or its `.ai/qa` was
// deleted), when the temporary root goes, or when `up` dies before it writes the descriptor. It
// cleans up after a server that exits on its own.
// POSIX only: the stop signals a process group. Starting, stopping and watching both processes goes
// through packages/cezar/src/detached-process.ts (hearsay-tools/cezarion#1717).
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

import { leaderRunning, startOwnedGroup, stopGroup, watchGroup } from '../../packages/cezar/src/detached-process.ts';
import { identity } from './test-env-lease.mjs';

const DESCRIPTOR = '.ai/qa/qa-fixture.json';
// Inside the temporary root: what `up` started there, which confirms the descriptor.
const OWNER = 'owner.json';
const ROOT_PREFIX = 'cez-qa-fixture-';
// test-env-up.sh's default health budget: a boot on a loaded host is CPU-bound.
const BOOT_TIMEOUT_MS = 180_000;
const STOP_GRACE_MS = 10_000;
const WATCH_INTERVAL_MS = 30_000;
const BANNER = /^\s*cockpit → (http:\/\/127\.0\.0\.1:\d+)\s*$/m;

const log = (stderr, message) => stderr.write(`[qa-fixture] ${message}\n`);

/** The `--server-env` opt-ins, by test-env-up.sh's rule: CEZ_NAME=value, no whitespace, one
 *  per name, and never the two variables this script pins. */
export function parseUpArgs(args) {
  const optIns = {};
  for (const arg of args) {
    if (!arg.startsWith('--server-env=')) throw new Error(`unknown flag: ${arg}`);
    const assignment = arg.slice('--server-env='.length);
    const name = assignment.split('=', 1)[0];
    if (!/^CEZ_[A-Z0-9_]+=\S*$/.test(assignment) || name === 'CEZ_DRY_RUN' || name === 'CEZ_HOME') {
      throw new Error(`invalid --server-env: ${assignment} (want CEZ_NAME=value, no whitespace; CEZ_DRY_RUN and CEZ_HOME are pinned)`);
    }
    if (name in optIns) throw new Error(`invalid --server-env: ${name} is given twice`);
    optIns[name] = assignment.slice(name.length + 1);
  }
  return optIns;
}

/** No ambient CEZ_* or GIT_* reaches the server (hearsay-tools/cezarion#1045): an agent's shell
 *  carries the live cockpit's opt-ins and its per-task plumbing. */
function serverEnv(ambient, root, optIns) {
  const env = Object.fromEntries(Object.entries(ambient).filter(([key]) => !/^(CEZ|GIT)_/i.test(key)));
  return {
    ...env,
    GIT_CONFIG_GLOBAL: join(root, 'gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CEILING_DIRECTORIES: root,
    GIT_AUTHOR_NAME: 'Cezar Tests',
    GIT_AUTHOR_EMAIL: 'tests@cezar.invalid',
    GIT_COMMITTER_NAME: 'Cezar Tests',
    GIT_COMMITTER_EMAIL: 'tests@cezar.invalid',
    ...optIns,
    CEZ_DRY_RUN: '1', CEZ_HOME: join(root, 'home'),
  };
}

/** One commit, so a dry-run task can branch and the repo view has a history. */
function createRepo(repo, env) {
  mkdirSync(repo);
  writeFileSync(join(repo, 'README.md'), '# QA fixture\n\nA throwaway project served by .ai/scripts/qa-fixture.mjs.\n');
  for (const args of [['init', '-q', '-b', 'main'], ['add', '.'], ['commit', '-qm', 'QA fixture']]) {
    const result = spawnSync('git', args, { cwd: repo, env, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr || result.error?.message}`);
  }
}

/** The cockpit e2e build, into `out`. build-e2e.sh needs the workspace's installed dependencies. */
function buildE2e(repoRoot, out, logPath) {
  if (!existsSync(join(repoRoot, 'packages/cezar/node_modules/zod/package.json'))) {
    throw new Error('dependencies are not installed: run pnpm install --frozen-lockfile first');
  }
  const fd = openSync(logPath, 'w');
  try {
    const result = spawnSync('sh', [join(repoRoot, '.ai/scripts/build-e2e.sh'), out], { cwd: repoRoot, stdio: ['ignore', fd, fd] });
    if (result.status !== 0) throw new Error(`build failed (${logPath})`);
  } finally { closeSync(fd); }
}

/** The start identity test-env-lease.mjs reads, so a reused pid is never signalled. */
const readStart = (pid) => identity(pid).start;

/** Starts `cmd` detached, so it leads its own process group, with its output in `logPath`. */
async function detach(cmd, { cwd, env, logPath, readIdentity }) {
  const fd = openSync(logPath, 'a');
  try {
    const { child, leader } = await startOwnedGroup(process.execPath, cmd, {
      cwd, env, stdio: ['ignore', fd, fd], readStart: (pid) => readIdentity(pid).start, requireStart: true,
    });
    child.unref();
    return leader;
  } finally { closeSync(fd); }
}

async function waitForCockpit(server, logPath, timeoutMs) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const url = BANNER.exec(readFileSync(logPath, 'utf8'))?.[1];
    if (url) return url;
    if (!leaderRunning(server, readStart)) throw new Error('the server exited during boot');
    await delay(200);
  }
  throw new Error(`the server did not announce its address within ${timeoutMs / 1000} s`);
}

async function registeredProject(baseUrl, repo) {
  const response = await fetch(`${baseUrl}/api/v1/projects`);
  if (!response.ok) throw new Error(`GET /api/v1/projects answered ${response.status}`);
  const { projects = [] } = await response.json();
  const root = realpathSync(repo);
  const project = projects.find((entry) => entry.root === root);
  // cezar never registers a folder inside a task worktree, and the root comes from TMPDIR.
  if (!project) throw new Error(`the served project is not registered: ${root} is inside .ai/cezar/worktrees/. Set TMPDIR outside it, for example TMPDIR=/tmp`);
  return project.id;
}

function readDescriptor(repoRoot) {
  try {
    return JSON.parse(readFileSync(join(repoRoot, DESCRIPTOR), 'utf8'));
  } catch {
    return undefined;
  }
}

function writeDescriptor(repoRoot, fixture) {
  mkdirSync(join(repoRoot, '.ai/qa'), { recursive: true });
  writeFileSync(join(repoRoot, DESCRIPTOR), JSON.stringify(fixture, null, 2) + '\n');
}

const sameProcess = (a, b) => a?.pid === b.pid && a?.start === b.start;
const validProcess = (entry) => Number.isSafeInteger(entry?.pid) && entry.pid > 1 && typeof entry.start === 'string' && entry.start !== '';
const validRoot = (root) => typeof root === 'string' && resolve(root) === root && basename(root).startsWith(ROOT_PREFIX);

function writeOwner(repoRoot, fixture) {
  writeFileSync(join(fixture.root, OWNER), JSON.stringify({ repoRoot, server: fixture.server, watcher: fixture.watcher }) + '\n');
}

/** True when the descriptor is well formed and the temporary root it names confirms it with the
 *  same worktree and process identities. Only then may `down` signal or delete what it names. */
function confirmed(repoRoot, fixture) {
  if (!validRoot(fixture?.root) || !validProcess(fixture.server)) return false;
  if (fixture.watcher !== undefined && !validProcess(fixture.watcher)) return false;
  let owner;
  try {
    owner = JSON.parse(readFileSync(join(fixture.root, OWNER), 'utf8'));
  } catch {
    return false;
  }
  return owner?.repoRoot === repoRoot && sameProcess(owner.server, fixture.server)
    && (fixture.watcher === undefined || sameProcess(owner.watcher, fixture.watcher));
}

/** Only a root this script made: a prefix check on top of the callers' own. */
function removeRoot(root) {
  if (validRoot(root)) rmSync(root, { recursive: true, force: true });
}

/** Best effort, so a cleanup that calls it always finishes. */
function printLogTail(stderr, root) {
  try {
    const name = ['server.log', 'build.log'].find((file) => existsSync(join(root, file)));
    if (!name) return;
    const tail = readFileSync(join(root, name), 'utf8').trimEnd().split('\n').slice(-20).join('\n');
    log(stderr, `last lines of ${name}:\n${tail}`);
  } catch { /* the log went with its root */ }
}

/** Stops the fixture the descriptor names. The watcher goes first, so it cannot clean up at the
 *  same time. A server that would not stop keeps its descriptor, so `down` can try again. */
async function stopFixture(repoRoot, stderr, graceMs) {
  const fixture = readDescriptor(repoRoot);
  if (!fixture) return log(stderr, 'no fixture is running');
  if (!confirmed(repoRoot, fixture)) {
    // Removed without acting on it. A server whose temporary root is gone still has its
    // watcher, which stops it once this descriptor no longer names it.
    log(stderr, `ignoring ${DESCRIPTOR}: the temporary root it names does not confirm it`);
  } else {
    if (fixture.watcher) await stopGroup(fixture.watcher, { graceMs, readStart });
    log(stderr, `stopping cezar (pid ${fixture.server.pid})`);
    if (!await stopGroup(fixture.server, { graceMs, readStart })) throw new Error(`cezar pid ${fixture.server.pid} did not stop`);
    removeRoot(fixture.root);
  }
  rmSync(join(repoRoot, DESCRIPTOR), { force: true });
}

export async function down({ repoRoot, stdout = process.stdout, stderr = process.stderr, stopGraceMs = STOP_GRACE_MS }) {
  await stopFixture(repoRoot, stderr, stopGraceMs);
  stdout.write('QA_FIXTURE_STATUS=stopped\n');
}

export async function up({
  repoRoot,
  args = [],
  env = process.env,
  stdout = process.stdout,
  stderr = process.stderr,
  build = (out, logPath) => buildE2e(repoRoot, out, logPath),
  tmp = tmpdir(),
  bootTimeoutMs = BOOT_TIMEOUT_MS,
  watchIntervalMs = WATCH_INTERVAL_MS,
  stopGraceMs = STOP_GRACE_MS,
  readIdentity = identity,
  // The process the watcher waits for: while it runs, up owns the server. Tests pass a stand-in.
  starter = { pid: process.pid, start: identity(process.pid).start ?? '' },
}) {
  const optIns = parseUpArgs(args);
  if (process.platform !== 'linux' && process.platform !== 'darwin') {
    throw new Error('qa-fixture runs on Linux and macOS only: it stops the server by its process group');
  }
  await stopFixture(repoRoot, stderr, stopGraceMs);
  const root = mkdtempSync(join(realpathSync(tmp), ROOT_PREFIX));
  const repo = join(root, 'repo');
  let server;
  let watcher;
  try {
    const childEnv = serverEnv(env, root, optIns);
    writeFileSync(join(root, 'gitconfig'), '');
    createRepo(repo, childEnv);
    log(stderr, `building the e2e cockpit into ${join(root, 'build/cezar')}`);
    await build(join(root, 'build/cezar'), join(root, 'build.log'));
    server = await detach([join(root, 'build/cezar/dist/index.js'), 'serve', '--repo', repo, '--port', '0', '--no-open'],
      { cwd: repo, env: childEnv, logPath: join(root, 'server.log'), readIdentity });
    // Started at once: an up that dies during the boot, from Ctrl-C or SIGKILL, runs none of its
    // cleanup. The watcher leaves the server alone while up's process runs, and up writes the
    // descriptor before it exits, or stops both.
    watcher = await detach([import.meta.filename, 'watch', repoRoot, root, String(server.pid), server.start, String(watchIntervalMs), String(starter.pid), starter.start],
      { cwd: dirname(root), env, logPath: join(root, 'watch.log'), readIdentity });
    const baseUrl = await waitForCockpit(server, join(root, 'server.log'), bootTimeoutMs);
    const projectId = await registeredProject(baseUrl, repo);
    const fixture = { root, baseUrl, projectId, server, watcher, startedAt: new Date().toISOString() };
    // The owner record goes first, so no descriptor exists without its confirmation.
    writeOwner(repoRoot, fixture);
    writeDescriptor(repoRoot, fixture);
    stdout.write([
      'QA_FIXTURE_STATUS=running',
      `QA_FIXTURE_BASE_URL=${baseUrl}`,
      `QA_FIXTURE_PROJECT_ID=${projectId}`,
      `QA_FIXTURE_PROJECT_URL=${baseUrl}/p/${projectId}`,
      `QA_FIXTURE_REPO=${repo}`,
      `QA_FIXTURE_LOG=${join(root, 'server.log')}`,
      'QA_FIXTURE_STOP=node .ai/scripts/qa-fixture.mjs down',
    ].join('\n') + '\n');
  } catch (error) {
    // The watcher first, so it cannot clean up at the same time.
    if (watcher) await stopGroup(watcher, { graceMs: stopGraceMs, readStart });
    if (server) await stopGroup(server, { graceMs: stopGraceMs, readStart });
    printLogTail(stderr, root);
    removeRoot(root);
    rmSync(join(repoRoot, DESCRIPTOR), { force: true });
    throw error;
  }
}

/** The fixture's end when nobody runs `down`. While `starter`, up's process, runs, up owns the
 *  server. After that the descriptor is the only handle `down` has, so the server stops once the
 *  descriptor no longer names it, or its temporary root is gone. A server that exits on its own
 *  leaves nothing behind, members of its group included. */
export async function watch({ repoRoot, root, server, starter, intervalMs = WATCH_INTERVAL_MS }) {
  await watchGroup({
    leader: server, starter, intervalMs, readStart,
    decide: () => (sameProcess(readDescriptor(repoRoot)?.server, server) && existsSync(root) ? undefined : { reason: 'unowned' }),
  });
  removeRoot(root);
  if (sameProcess(readDescriptor(repoRoot)?.server, server)) rmSync(join(repoRoot, DESCRIPTOR), { force: true });
}

async function main([command, ...args]) {
  const repoRoot = resolve(import.meta.dirname, '../..');
  if (command === 'up') return up({ repoRoot, args });
  if (command === 'down' && args.length === 0) return down({ repoRoot });
  if (command === 'watch' && args.length === 7) {
    const [worktree, root, pid, start, intervalMs, starterPid, starterStart] = args;
    return watch({
      repoRoot: worktree, root, server: { pid: Number(pid), start }, starter: { pid: Number(starterPid), start: starterStart }, intervalMs: Number(intervalMs),
    });
  }
  throw new Error('usage: node .ai/scripts/qa-fixture.mjs up [--server-env=CEZ_NAME=value]... | down');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`[qa-fixture] ${error.message}`);
    process.exitCode = 1;
  });
}
