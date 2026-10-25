// The shared browser environment has mutable builds, a clone and a registry as well as a
// server. Keep one test invocation's lease until ALL of its setup/specs/teardown finish.
// Short SQLite transactions make join/release/reclamation atomic, including after SIGKILL.
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { connect, createServer } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

import { groupExists, startOwnedGroup, stopGroup, watchGroup } from '../../packages/cezar/src/detached-process.ts';

const windowsScript = resolve(import.meta.dirname, 'test-env-windows.ps1');
function windowsProbe(mode, payload, timeout = 15_000) {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', windowsScript, mode, payload], {
    encoding: 'utf8', windowsHide: true, timeout, maxBuffer: 64 * 1024,
  });
  if (result.status !== 0) return undefined;
  return result.stdout.trim();
}
// Windows command-line quoting, including trailing backslashes and empty args.
function windowsCommand(args) {
  return args.map(arg => '"' + arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1') + '"').join(' ');
}
const windowsPayload = value => Buffer.from(JSON.stringify(value)).toString('base64');

// A process's start identity. qa-fixture.mjs uses it too, so it never signals a reused pid.
export function identity(pid, timeout = 15_000) {
  try { process.kill(pid, 0); }
  catch (error) { return error.code === 'ESRCH' ? { dead: true } : {}; }
  if (process.platform === 'win32') {
    const start = windowsProbe('identity', String(pid), timeout);
    if (start === 'gone') return { dead: true };
    return /^\d+$/.test(start ?? '') ? { start } : {};
  }
  if (process.platform === 'linux') {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/);
      if (fields[0] === 'Z' || fields[0] === 'X') return { dead: true };
      const boot = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
      if (boot && /^\d+$/.test(fields[19] ?? '')) return { start: `${boot}:${fields[19]}` };
    } catch { /* Unreadable identity is not proof of death. */ }
  } else if (process.platform === 'darwin') {
    const ps = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8', timeout: Math.min(2000, timeout), env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
    });
    if (ps.status === 0 && ps.stdout.trim()) return { start: ps.stdout.trim() };
  }
  return {};
}
const readStart = pid => identity(pid).start;

// Diagnostics are transient and never participate in ownership or reclamation.
// Limit reads as well as display size; command lines can contain arbitrary arguments.
function commandLine(pid, timeout = 2000) {
  try {
    if (process.platform === 'linux') {
      const fd = openSync(`/proc/${pid}/cmdline`, 'r');
      try {
        const buffer = Buffer.alloc(16 * 1024);
        const length = readSync(fd, buffer, 0, buffer.length, 0);
        return buffer.subarray(0, length).toString('utf8').split('\0').filter(Boolean);
      } finally { closeSync(fd); }
    }
    const raw = process.platform === 'win32' ? windowsProbe('command', String(pid), timeout)
      : process.platform === 'darwin' ? spawnSync('ps', ['-ww', '-o', 'command=', '-p', String(pid)], {
        encoding: 'utf8', timeout, maxBuffer: 16 * 1024,
      }) : undefined;
    const text = typeof raw === 'string' ? raw : raw?.status === 0 ? raw.stdout.trim() : undefined;
    // ps and Windows expose a rendered command, not argv. Parse it conservatively
    // for safe process names and the unambiguous Node invocation used by Squeal.
    return text ? { text } : undefined;
  } catch { return undefined; }
}

function squealDaemon(argv) {
  const name = value => value?.split(/[\\/]/).at(-1);
  if (!['node', 'node.exe'].includes(name(argv[0]))) return false;
  let index = 1;
  while (['--no-warnings', '--disable-warning=ExperimentalWarning'].includes(argv[index])) index++;
  return /(?:^|[\\/])dist[\\/]cli[\\/]squeal\.mjs$/.test(argv[index] ?? '') && argv[index + 1] === 'daemon';
}

const SQUEAL_GUIDANCE = 'If Squeal covers this spec, read its result with squeal status --wait 60000; do not start a duplicate run.';

// Rendered process commands have no reliable argv boundary information. Recognize
// only individually quoted/simple tokens; ambiguous commands retain their PID.
function commandArgs(result) {
  if (Array.isArray(result)) return result;
  const text = result.text.trim();
  if (!/^(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s"']+)(?:\s+(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s"']+))*$/.test(text)) return [];
  return text.match(/"[^"\r\n]*"|'[^'\r\n]*'|[^\s"']+/g).map(arg => arg.replace(/^(?:"(.*)"|'(.*)')$/, '$1$2'));
}

// Argument values may be credentials or inline programs. Display only executable
// and recognized interpreter script basenames; never retain the remaining argv.
function safeCommand(argv, squeal) {
  const name = value => value?.split(/[\\/]/).at(-1);
  const executable = name(argv[0]);
  if (!/^[\w.+-]+$/.test(executable ?? '')) return undefined;
  let index = 1;
  while (['--no-warnings', '--disable-warning=ExperimentalWarning'].includes(argv[index])) index++;
  const script = name(argv[index]);
  const interpreter = /^(?:node(?:\.exe)?|python[\d.]*(?:\.exe)?|(?:ba|da|z)?sh(?:\.exe)?)$/.test(executable);
  const scriptName = interpreter && /^[\w.+-]+\.(?:[cm]?js|ts|py|sh)$/.test(script ?? '') ? ` ${script}` : '';
  const text = executable + scriptName + (squeal ? ' daemon' : '') + (argv.length > 1 ? ' [arguments omitted]' : '');
  return text.length > 200 ? text.slice(0, 199) + '…' : text;
}

function holderDescription(holders, snapshots) {
  let squeal = false;
  const owners = holders.map(holder => {
    const saved = snapshots.get(holder.id);
    // The latest lease transaction verified the row's PID/start. A retained group
    // whose leader exited, or whose identity became unreadable, gets PID-only text.
    if (!holder.diagnosticVerified || saved?.pid !== holder.pid || saved?.start !== holder.start) return `pid ${holder.pid}`;
    squeal ||= saved.squeal;
    return saved.owner;
  }).join(', ');
  return { owners, guidance: squeal ? `\n${SQUEAL_GUIDANCE}` : '' };
}

/** Best-effort snapshot outside the lease transaction, with one shared budget.
 * Probe overrides test unreadable/changing identities and an exhausted deadline.
 * Only safe rendered names enter snapshots; raw arguments never leave this call.
 */
export function describeTestEnvHolders(holders, {
  identify = identity, command = commandLine, now = () => performance.now(), deadline = now() + 2000, snapshots,
} = {}) {
  const remaining = () => Math.max(0, Math.min(2000, Math.floor(deadline - now())));
  let squeal = false;
  const owners = holders.map(holder => {
    const fallback = `pid ${holder.pid}`;
    try {
      let budget = remaining();
      if (!holder.start || !budget || identify(holder.pid, budget).start !== holder.start) return fallback;
      budget = remaining();
      if (!budget) return fallback;
      const result = command(holder.pid, budget);
      budget = remaining();
      if (!result || !budget || identify(holder.pid, budget).start !== holder.start || !remaining()) return fallback;
      const argv = commandArgs(result);
      const daemon = squealDaemon(argv);
      const summary = safeCommand(argv, daemon);
      if (!summary) return fallback;
      const owner = `${fallback} (${summary})`;
      snapshots?.set(holder.id, { pid: holder.pid, start: holder.start, owner, squeal: daemon });
      squeal ||= daemon;
      return owner;
    } catch { return fallback; }
  }).join(', ');
  return { owners, guidance: squeal ? `\n${SQUEAL_GUIDANCE}` : '' };
}

// A shell can die before its build/clone child. Retain its group claim until the
// last non-zombie member exits. Returns true (live), false (dead), or undefined
// (unknown). On Linux, unrelated process starts/exits can change the two /proc
// listings, so unknown is common under churn, even for a zombie-only group.
// Callers must retain ownership and retry on unknown, never treat it as stopped.
// Sustained churn can prevent reclamation until acquisition times out. One scan
// seeing only zombies cannot exclude a live member that forked an unseen child
// and exited during enumeration; a dead leader alone does not remove that race.
function groupLive(pgid) {
  if (process.platform === 'win32') {
    const live = windowsProbe('live', String(pgid));
    return live === 'true' ? true : live === 'false' ? false : undefined;
  }
  try { process.kill(-pgid, 0); }
  catch (error) { if (error.code === 'ESRCH') return false; }
  if (process.platform === 'linux') {
    let unknown = false;
    try {
      const snapshot = readdirSync('/proc').filter(name => /^\d+$/.test(name)).sort();
      let sawMember = false;
      for (const pid of snapshot) {
        try {
          const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
          const fields = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/);
          if (Number(fields[2]) === pgid) {
            sawMember = true;
            if (!['Z', 'X'].includes(fields[0])) return true;
          }
        } catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ESRCH') unknown = true; }
      }
      // A member can fork and exit between enumeration and stat. A changing
      // process list cannot prove that its successor is absent. Retry later.
      const after = readdirSync('/proc').filter(name => /^\d+$/.test(name)).sort();
      if (snapshot.join(',') !== after.join(',') || !sawMember) return undefined;
      return unknown ? undefined : false;
    } catch { return undefined; }
  }
  if (process.platform === 'darwin') {
    const ps = spawnSync('ps', ['-axo', 'pgid=,stat='], { encoding: 'utf8', timeout: 2000 });
    if (ps.status !== 0) return undefined;
    return ps.stdout.split('\n').some(line => {
      const [group, state] = line.trim().split(/\s+/);
      return Number(group) === pgid && state && !state.startsWith('Z');
    });
  }
  return undefined;
}

// Inside an open write transaction: drop the rows of dead holders, return the live ones.
function liveHolders(db) {
  return db.prepare('SELECT * FROM holders').all().filter(holder => {
    const current = identity(holder.pid);
    holder.diagnosticVerified = Boolean(holder.start && !current.dead && current.start === holder.start);
    const reused = holder.start && current.start && holder.start !== current.start;
    const dead = (reused || current.dead) && (!holder.pgid || groupLive(holder.pgid) === false);
    if (dead) db.prepare('DELETE FROM holders WHERE id = ?').run(holder.id);
    return !dead;
  });
}

function openLeaseDb(root, { create = true } = {}) {
  const dir = resolve(root, '.ai/qa');
  // The watcher must never recreate a checkout deleted under it.
  if (create) mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(resolve(dir, 'test-env-lease.sqlite'));
  try {
    db.exec('PRAGMA busy_timeout=1000');
    db.exec('CREATE TABLE IF NOT EXISTS holders (id TEXT PRIMARY KEY, token TEXT NOT NULL, pid INTEGER NOT NULL, start TEXT, pgid INTEGER)');
    // Rebuildable local state from an earlier development version remains usable.
    if (!db.prepare('PRAGMA table_info(holders)').all().some(column => column.name === 'pgid')) db.exec('ALTER TABLE holders ADD COLUMN pgid INTEGER');
    return db;
  } catch (error) { db.close(); throw error; }
}

/** A token admits only descendants of a still-live, verified holder. No token means a new run.
 * Each participant gets its OWN row: killing the wrapper cannot unprotect a live Vitest child.
 */
export async function acquireTestEnvLease(root, { token, pid = process.pid, group = false, timeoutMs = 300_000, onWait } = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('invalid test environment lease pid');
  const own = identity(pid);
  if (!own.start) throw new Error(`cannot verify test environment lease identity for pid ${pid}`);
  const db = openLeaseDb(root);
  const id = randomUUID();
  const deadline = performance.now() + timeoutMs;
  let logged = false;
  const snapshots = new Map();
  try {
    while (true) {
      db.exec('BEGIN IMMEDIATE');
      let holders;
      try {
        holders = liveHolders(db);
        if (token && !holders.some(holder => holder.token === token && holder.start && identity(holder.pid).start === holder.start)) {
          throw new Error('invalid inherited test environment lease: no verified live holder');
        }
        if (holders.length === 0 || (token && holders.every(holder => holder.token === token))) {
          token ??= randomUUID();
          db.prepare('INSERT INTO holders (id, token, pid, start, pgid) VALUES (?, ?, ?, ?, ?)').run(id, token, pid, own.start, group ? (process.platform === 'win32' ? (typeof group === 'string' ? group : process.env.TEST_ENV_LEASE_JOB) : pid) : null);
          db.exec('COMMIT');
          // Publish ownership only after its holder row is durable.
          let released = false;
          return {
            token,
            release() {
              if (released) return;
              db.prepare('DELETE FROM holders WHERE id = ?').run(id);
              released = true;
              db.close();
            },
          };
        }
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
      if (performance.now() >= deadline) {
        const { owners, guidance } = holderDescription(holders, snapshots);
        throw new Error(`timed out waiting for test environment held by ${owners}; the active environment was left unchanged${guidance}`);
      }
      if (!logged) {
        const { owners, guidance } = describeTestEnvHolders(holders, { deadline: Math.min(deadline, performance.now() + 2000), snapshots });
        onWait?.(`waiting for test environment held by ${owners}${guidance}`);
        logged = true;
      }
      await delay(Math.min(100, Math.max(1, deadline - performance.now())));
    }
  } catch (error) { db.close(); throw error; }
}

// Only the supervisor outside the mutation job can start the cached app.
// This local pipe admits the existing detach-app operation, never a shell command.
// The app starts through packages/cezar/src/detached-process.ts (hearsay-tools/cezarion#1717): a
// start identity nothing can read stops it again, since no later stop could name it.
async function detachApp(args, root, effectiveEnv = process.env) {
  const fd = openSync(resolve(root, args[0]), 'w');
  const env = { ...effectiveEnv };
  for (const key of Object.keys(env)) if (key.startsWith('TEST_ENV_LEASE_')) delete env[key];
  try {
    const { child, leader } = await startOwnedGroup(process.execPath, args.slice(1), {
      cwd: root, stdio: ['ignore', fd, fd], env, readStart, requireStart: true,
    });
    child.unref();
    // The app has no end of its own (#1448): a sibling watcher stops it once nothing uses it.
    // A failed watcher start leaves the app as before, stoppable by test-env-down.sh.
    const repo = args.indexOf('--repo');
    const served = repo >= 0 && args[repo + 1] ? resolve(root, args[repo + 1]) : root;
    // Its own log, next to the app's, so the app log holds only the app's output.
    let watchFd;
    try {
      watchFd = openSync(resolve(dirname(resolve(root, args[0])), 'test-env-watch.log'), 'a');
      const watcher = await startOwnedGroup(process.execPath, [import.meta.filename, 'watch-app', String(leader.pid), leader.start, root, served], {
        cwd: tmpdir(), stdio: ['ignore', watchFd, watchFd], env, windowsHide: true, readStart,
      });
      watcher.child.unref();
    } catch { /* best effort: the caller must still record the app it started */ }
    finally { if (watchFd !== undefined) closeSync(watchFd); }
    return leader;
  } finally { closeSync(fd); }
}

const IDLE_DEFAULT_MINUTES = 30;
const INTERVAL_DEFAULT_SECONDS = 30;
const STOP_GRACE_MS = 10_000;

// test-env-up.sh refuses a malformed value before boot; a bad value reaching here uses the default.
function envNumber(env, name, fallback, min, max) {
  const text = env[name];
  if (text === undefined || !/^\d+(\.\d+)?$/.test(text)) return fallback;
  const value = Number(text);
  return value >= min && value <= max ? value : fallback;
}

/** The app `.ai/qa/test-env.json` names, when this checkout started it. A descriptor written before
 * hearsay-tools/cezarion#1717 has no `app.start`; `stopApp` leaves its app to its watcher. */
function recordedApp(root) {
  try {
    const descriptor = JSON.parse(readFileSync(resolve(root, '.ai/qa/test-env.json'), 'utf8'));
    const { pid, start } = descriptor?.startedByThisRepo === true ? descriptor.app ?? {} : {};
    if (!Number.isSafeInteger(pid) || pid <= 1) return undefined;
    return typeof start === 'string' && start ? { pid, start } : { pid };
  } catch { return undefined; /* absent or corrupt: nothing safe to stop */ }
}

/** Stops the app's whole process group, and only the recorded incarnation. Throws when it would not stop. */
async function stopApp(app, graceMs) {
  const log = message => console.error(`[test-env] ${message}`);
  if (!app || !groupExists(app, readStart)) { log('app is already stopped'); return; }
  if (!app.start) {
    // Its pid may name another process now, and nothing tells them apart.
    log(`not stopping cezar pid ${app.pid}: its descriptor records no start identity (written before hearsay-tools/cezarion#1717); its watcher stops it once idle`);
    return;
  }
  log(`stopping cezar (pid ${app.pid})`);
  if (!await stopGroup(app, { graceMs, readStart })) throw new Error(`cezar pid ${app.pid} did not stop`);
}

function markStopped(root, pid) {
  const file = resolve(root, '.ai/qa/test-env.json');
  try {
    const descriptor = JSON.parse(readFileSync(file, 'utf8'));
    // A later boot owns a descriptor naming another app; leave it alone.
    if (descriptor?.app?.pid !== pid) return;
    descriptor.status = 'stopped';
    // The pid is free for reuse now: teardown_stale and test-env-down.sh must not signal it.
    delete descriptor.app.pid;
    delete descriptor.app.start;
    writeFileSync(file, JSON.stringify(descriptor, null, 2) + '\n');
  } catch { /* absent or corrupt: test-env-up.sh treats it as stale */ }
}

/** Stop the detached app when its checkout is deleted, or when no lease holder has existed for
 * the idle period (TEST_ENV_IDLE_EXIT_MINUTES, 0 = never). An app that exits on its own leaves
 * nothing behind: the rest of its group is stopped too. A stop that fails is tried again. */
async function watchApp(pid, start, root, served, env = process.env) {
  const idleMs = envNumber(env, 'TEST_ENV_IDLE_EXIT_MINUTES', IDLE_DEFAULT_MINUTES, 0, Infinity) * 60_000;
  // Node turns a timer delay outside its range into 1 ms, a busy loop: keep it inside 0.1–3600 s.
  const intervalMs = envNumber(env, 'TEST_ENV_WATCH_INTERVAL_SECONDS', INTERVAL_DEFAULT_SECONDS, 0.1, 3600) * 1000;
  const log = message => console.log(`[test-env] watcher ${message}`);
  log(`${process.pid} watching cezar pid ${pid}`);
  let lastBusy = performance.now();
  const stopping = reason => { log(`stopping cezar pid ${pid}: ${reason}`); return { reason }; };
  /** No lease holder for the idle period, or no served project. The verdict claims the environment
   * in the same transaction that saw no holder: a run that starts now waits for this row, then
   * cold-boots, instead of attaching to a stopping app. Settling the stop releases the claim. */
  const leaseVerdict = () => {
    let db;
    try {
      db = openLeaseDb(root, { create: false });
      db.exec('BEGIN IMMEDIATE');
      let reason;
      try {
        if (liveHolders(db).length > 0) lastBusy = performance.now();
        else if (!existsSync(served)) reason = 'served project deleted';
        else if (idleMs > 0 && performance.now() - lastBusy >= idleMs) reason = `idle ${idleMs / 60_000} minutes`;
        const own = reason && identity(process.pid).start;
        if (own) db.prepare('INSERT INTO holders (id, token, pid, start, pgid) VALUES (?, ?, ?, ?, NULL)').run(`watcher-${process.pid}`, randomUUID(), process.pid, own);
        else reason = undefined;
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      if (!reason) return undefined;
      const claim = db;
      db = undefined;
      return {
        ...stopping(reason),
        settle(stopped) {
          try {
            // An app that could not be confirmed gone keeps its descriptor, so down can still stop it.
            if (stopped) markStopped(root, pid);
            else log(`could not confirm cezar pid ${pid} stopped; trying again at the next poll`);
          } finally {
            claim.prepare('DELETE FROM holders WHERE id = ?').run(`watcher-${process.pid}`);
            claim.close();
          }
        },
      };
    } catch (error) {
      // A busy database, or state deleted mid-poll, is retried at the next poll.
      if (existsSync(resolve(root, '.ai/qa'))) log(`poll failed: ${error.message}`);
      return undefined;
    } finally { db?.close(); }
  };
  await watchGroup({
    leader: { pid, start }, intervalMs, readStart, stop: { graceMs: STOP_GRACE_MS },
    decide: () => {
      // The lease database was inside the checkout: no holder can remain.
      if (!existsSync(root)) return stopping('checkout deleted');
      // Its descriptor went with it, so no run can reuse this app.
      if (!existsSync(resolve(root, '.ai/qa'))) return stopping('test-env state deleted');
      return leaseVerdict();
    },
  });
}
async function cachedAppBroker(root, token) {
  const pipe = `\\\\.\\pipe\\cez-test-env-${randomUUID()}`;
  const sockets = new Set();
  const server = createServer(socket => {
    socket.setEncoding('utf8');
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    socket.setTimeout(15_000, () => socket.destroy());
    let data = '';
    let handled = false;
    socket.on('data', chunk => {
      if (handled) return;
      data += chunk;
      if (Buffer.byteLength(data) > 65536) { socket.destroy(); return; }
      if (!data.includes('\n')) return;
      handled = true;
      void (async () => {
        try {
          const request = JSON.parse(data);
          if (request.token !== token || request.operation !== 'detach-app' ||
              !Array.isArray(request.args) || request.args.length < 2 || request.args.length > 128 ||
              !request.args.every(arg => typeof arg === 'string' && !arg.includes('\0')) ||
              !request.env || typeof request.env !== 'object' || Array.isArray(request.env) ||
              !Object.entries(request.env).every(([key, value]) => key && !/[=\0]/.test(key) && typeof value === 'string' && !value.includes('\0'))) throw new Error('invalid cached-app request');
          const app = await detachApp(request.args, root, request.env);
          socket.end(JSON.stringify(app) + '\n');
        } catch (error) { socket.end(JSON.stringify({ error: error.message }) + '\n'); }
      })();
    });
  });
  await new Promise((done, fail) => { server.once('error', fail); server.listen(pipe, done); });
  return { pipe, close() { for (const socket of sockets) socket.destroy(); server.close(); } };
}
async function requestCachedApp(args) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('TEST_ENV_LEASE_')) delete env[key];
  return new Promise((done, fail) => {
    const socket = connect(process.env.TEST_ENV_LEASE_BROKER);
    socket.setEncoding('utf8');
    let data = '';
    socket.setTimeout(15_000, () => socket.destroy(new Error('cached-app broker timed out')));
    socket.on('error', fail);
    socket.on('connect', () => socket.write(JSON.stringify({ operation: 'detach-app', token: process.env.TEST_ENV_LEASE_TOKEN, args, env }) + '\n'));
    socket.on('data', chunk => { data += chunk; if (Buffer.byteLength(data) > 4096) socket.destroy(new Error('invalid cached-app receipt')); });
    socket.on('end', () => {
      try {
        const receipt = JSON.parse(data);
        if (!Number.isSafeInteger(receipt.pid) || receipt.pid <= 0) throw new Error(receipt.error || 'invalid cached-app receipt');
        done(typeof receipt.start === 'string' && receipt.start ? { pid: receipt.pid, start: receipt.start } : { pid: receipt.pid });
      } catch (error) { fail(error); }
    });
  });
}
const USAGE = 'usage: test-env-lease.mjs run sh <script> [args] | join <pid> | watch-app <pid> <start> <root> <served> | stop-app <grace-ms> [<pid> <start>]';

/** detach-app [--json] <log> <args...>: --json prints the app's start identity too, for the
 * descriptor; plain output is the bare pid. */
async function detachAppCommand(args, root) {
  const json = args[0] === '--json';
  const rest = args.slice(json ? 1 : 0);
  const brokered = process.platform === 'win32' && process.env.TEST_ENV_LEASE_JOB;
  if (brokered && !process.env.TEST_ENV_LEASE_BROKER) throw new Error('missing cached-app broker');
  const app = brokered ? await requestCachedApp(rest) : await detachApp(rest, root);
  console.log(json ? JSON.stringify(app) : app.pid);
}

/** stop-app <grace-ms> stops the app the descriptor names; <pid> <start> name one the descriptor
 * does not hold yet. */
async function stopAppCommand(args, root) {
  const [graceMs, pid] = [Number(args[0]), Number(args[1])];
  const named = args.length === 3 && Number.isSafeInteger(pid) && pid > 1;
  if (!Number.isSafeInteger(graceMs) || graceMs < 0 || (args.length !== 1 && !named)) throw new Error(USAGE);
  await stopApp(named ? (args[2] ? { pid, start: args[2] } : { pid }) : recordedApp(root), graceMs);
}

async function watchAppCommand(args) {
  const pid = Number(args[0]);
  if (!Number.isSafeInteger(pid) || pid <= 1 || !args[1] || !args[2] || !args[3]) throw new Error('usage: test-env-lease.mjs watch-app <pid> <start> <root> <served>');
  await watchApp(pid, args[1], args[2], args[3]);
}

async function joinCommand(args, root) {
  // The shell itself must be recorded, not this short-lived registration process. The
  // supervising `run` owns its lifetime; an abruptly orphaned shell stays protected too.
  const lease = await acquireTestEnvLease(root, { token: process.env.TEST_ENV_LEASE_TOKEN, pid: process.platform === 'win32' ? process.ppid : Number(args[0]), group: true });
  if (!process.env.TEST_ENV_LEASE_TOKEN) { lease.release(); throw new Error('missing inherited test environment lease'); }
}

/** Runs `command` under the lease and forwards SIGINT and SIGTERM to its group (its job on Windows). */
async function superviseCommand(command, env, job) {
  const child = spawn(command[0], command.slice(1), {
    stdio: 'inherit', detached: !job, env,
  });
  const forward = signal => {
    try { process.kill(job ? child.pid : -child.pid, signal); }
    catch (error) { if (error.code !== 'ESRCH') console.error(`[test-env] cannot signal command group: ${error.message}`); }
  };
  const term = () => forward('SIGTERM');
  const int = () => forward('SIGINT');
  process.on('SIGTERM', term);
  process.on('SIGINT', int);
  try {
    process.exitCode = await new Promise((resolveExit, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolveExit(code ?? (signal === 'SIGINT' ? 130 : 143)));
    });
  } finally {
    process.off('SIGTERM', term);
    process.off('SIGINT', int);
  }
}

/** run sh <script> [args]: holds the lease through the whole command. */
async function runCommand(args, root) {
  if (args[0] !== 'sh' || !args[1]) throw new Error(USAGE);
  const job = process.platform === 'win32' ? `Local\\CezTestEnv-${randomUUID()}` : undefined;
  const lease = await acquireTestEnvLease(root, {
    group: job,
    token: process.env.TEST_ENV_LEASE_TOKEN,
    onWait: message => console.error(`[test-env] ${message}`),
  });
  let broker;
  try {
    // A nested bootstrap is inside its caller's Job Object. Only the outer
    // supervisor's broker is outside every mutation job. acquire verified the
    // inherited token against a live holder before this pipe can be reused.
    const inheritedBroker = job && process.env.TEST_ENV_LEASE_TOKEN === lease.token
      ? process.env.TEST_ENV_LEASE_BROKER : undefined;
    if (job && !inheritedBroker) broker = await cachedAppBroker(root, lease.token);
    const env = { ...process.env, TEST_ENV_LEASE_TOKEN: lease.token, TEST_ENV_LEASE_ENTRY: args[1], ...(job ? { TEST_ENV_LEASE_JOB: job, TEST_ENV_LEASE_BROKER: inheritedBroker ?? broker.pipe } : {}) };
    const command = job ? ['powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', windowsScript, 'run', windowsPayload({ job, parent: process.pid, start: identity(process.pid).start, command: windowsCommand(args) })] : args;
    await superviseCommand(command, env, job);
  } finally { broker?.close(); lease.release(); }
}

const COMMANDS = { 'detach-app': detachAppCommand, 'stop-app': stopAppCommand, 'watch-app': watchAppCommand, join: joinCommand, run: runCommand };

async function main([name, ...args]) {
  const command = Object.hasOwn(COMMANDS, name ?? '') ? COMMANDS[name] : undefined;
  if (!command) throw new Error(USAGE);
  await command(args, resolve(import.meta.dirname, '../..'));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(error => {
    console.error(`[test-env] ${error.message}`);
    if (process.argv[4]?.endsWith('/e2e.sh')) console.error('TEST_E2E_STATUS=failed');
    process.exitCode = 1;
  });
}
