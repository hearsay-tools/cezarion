// The shared browser environment has mutable builds, a clone and a registry as well as a
// server. Keep one test invocation's lease until ALL of its setup/specs/teardown finish.
// Short SQLite transactions make join/release/reclamation atomic, including after SIGKILL.
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { connect, createServer } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

const windowsScript = resolve(import.meta.dirname, 'test-env-windows.ps1');
function windowsProbe(mode, payload) {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', windowsScript, mode, payload], {
    encoding: 'utf8', windowsHide: true, timeout: 15_000,
  });
  if (result.status !== 0) return undefined;
  return result.stdout.trim();
}
// Windows command-line quoting, including trailing backslashes and empty args.
function windowsCommand(args) {
  return args.map(arg => '"' + arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1') + '"').join(' ');
}
const windowsPayload = value => Buffer.from(JSON.stringify(value)).toString('base64');

function identity(pid) {
  try { process.kill(pid, 0); }
  catch (error) { return error.code === 'ESRCH' ? { dead: true } : {}; }
  if (process.platform === 'win32') {
    const start = windowsProbe('identity', String(pid));
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
      encoding: 'utf8', timeout: 2000, env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
    });
    if (ps.status === 0 && ps.stdout.trim()) return { start: ps.stdout.trim() };
  }
  return {};
}

// A shell can die before its build/clone child. Retain its group claim until the
// last non-zombie member exits. Unknown visibility never authorizes replacement.
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
      const owners = holders.map(holder => `pid ${holder.pid}`).join(', ');
      if (performance.now() >= deadline) throw new Error(`timed out waiting for test environment held by ${owners}; the active environment was left unchanged`);
      if (!logged) { onWait?.(`waiting for test environment held by ${owners}`); logged = true; }
      await delay(Math.min(100, Math.max(1, deadline - performance.now())));
    }
  } catch (error) { db.close(); throw error; }
}

// Only the supervisor outside the mutation job can start the cached app.
// This local pipe admits the existing detach-app operation, never a shell command.
async function detachApp(args, root, effectiveEnv = process.env) {
  const fd = openSync(resolve(root, args[0]), 'w');
  const env = { ...effectiveEnv };
  for (const key of Object.keys(env)) if (key.startsWith('TEST_ENV_LEASE_')) delete env[key];
  try {
    const child = spawn(process.execPath, args.slice(1), { cwd: root, detached: true, stdio: ['ignore', fd, fd], env });
    await new Promise((done, fail) => { child.once('spawn', done); child.once('error', fail); });
    child.unref();
    // The app has no end of its own (#1448): a sibling watcher stops it once nothing uses it.
    // A failed watcher start leaves the app as before, stoppable by test-env-down.sh.
    const start = identity(child.pid).start;
    const repo = args.indexOf('--repo');
    const served = repo >= 0 && args[repo + 1] ? resolve(root, args[repo + 1]) : root;
    // Its own log, next to the app's, so the app log holds only the app's output.
    if (start) {
      let watchFd;
      try {
        watchFd = openSync(resolve(dirname(resolve(root, args[0])), 'test-env-watch.log'), 'a');
        const watcher = spawn(process.execPath, [import.meta.filename, 'watch-app', String(child.pid), start, root, served], {
          cwd: tmpdir(), detached: true, stdio: ['ignore', watchFd, watchFd], env, windowsHide: true,
        });
        await new Promise(done => { watcher.once('spawn', done); watcher.once('error', done); });
        watcher.unref();
      } catch { /* best effort: the caller must still record the app it started */ }
      finally { if (watchFd !== undefined) closeSync(watchFd); }
    }
    return child.pid;
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

async function stopApp(pid, start) {
  // Only a verified identity may be signalled: an unreadable one could be a reused pid.
  const same = () => { const current = identity(pid); return !current.dead && current.start === start; };
  // The app can exit and its pid be reused between polls: never signal another process.
  if (!same()) return;
  try { process.kill(pid, 'SIGTERM'); } catch { return; }
  const deadline = performance.now() + STOP_GRACE_MS;
  while (same() && performance.now() < deadline) await delay(100);
  if (same()) try { process.kill(pid, 'SIGKILL'); } catch { /* exited meanwhile */ }
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
    writeFileSync(file, JSON.stringify(descriptor, null, 2) + '\n');
  } catch { /* absent or corrupt: test-env-up.sh treats it as stale */ }
}

/** Stop the detached app when its checkout is deleted, or when no lease holder has existed for
 * the idle period (TEST_ENV_IDLE_EXIT_MINUTES, 0 = never). Exit when the app exits on its own. */
async function watchApp(pid, start, root, served, env = process.env) {
  const idleMs = envNumber(env, 'TEST_ENV_IDLE_EXIT_MINUTES', IDLE_DEFAULT_MINUTES, 0, Infinity) * 60_000;
  // Node turns a timer delay outside its range into 1 ms, a busy loop: keep it inside 0.1–3600 s.
  const intervalMs = envNumber(env, 'TEST_ENV_WATCH_INTERVAL_SECONDS', INTERVAL_DEFAULT_SECONDS, 0.1, 3600) * 1000;
  const log = message => console.log(`[test-env] watcher ${message}`);
  log(`${process.pid} watching cezar pid ${pid}`);
  let lastBusy = performance.now();
  while (true) {
    await delay(intervalMs);
    const current = identity(pid);
    if (current.dead || (current.start && current.start !== start)) return;
    if (!existsSync(root)) {
      // The lease database was inside the checkout: no holder can remain.
      log(`stopping cezar pid ${pid}: checkout deleted`);
      await stopApp(pid, start);
      return;
    }
    if (!existsSync(resolve(root, '.ai/qa'))) {
      // Its descriptor went with it, so no run can reuse this app.
      log(`stopping cezar pid ${pid}: test-env state deleted`);
      await stopApp(pid, start);
      return;
    }
    let db;
    try {
      db = openLeaseDb(root, { create: false });
      db.exec('BEGIN IMMEDIATE');
      let reason;
      try {
        if (liveHolders(db).length > 0) lastBusy = performance.now();
        else if (!existsSync(served)) reason = 'served project deleted';
        else if (idleMs > 0 && performance.now() - lastBusy >= idleMs) reason = `idle ${idleMs / 60_000} minutes`;
        // Claim the environment in the same transaction that saw no holder: a run that starts
        // now waits for this row, then cold-boots, instead of attaching to a stopping app.
        const own = reason && identity(process.pid).start;
        if (own) db.prepare('INSERT INTO holders (id, token, pid, start, pgid) VALUES (?, ?, ?, ?, NULL)').run(`watcher-${process.pid}`, randomUUID(), process.pid, own);
        else reason = undefined;
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      if (reason) {
        try {
          log(`stopping cezar pid ${pid}: ${reason}`);
          await stopApp(pid, start);
          markStopped(root, pid);
        } finally { db.prepare('DELETE FROM holders WHERE id = ?').run(`watcher-${process.pid}`); }
        return;
      }
    } catch (error) {
      // A busy database, or state deleted mid-poll, is retried at the next poll.
      if (existsSync(resolve(root, '.ai/qa'))) log(`poll failed: ${error.message}`);
    } finally { db?.close(); }
  }
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
          const pid = await detachApp(request.args, root, request.env);
          socket.end(JSON.stringify({ pid }) + '\n');
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
        done(receipt.pid);
      } catch (error) { fail(error); }
    });
  });
}
async function main(args) {
  const root = resolve(import.meta.dirname, '../..');
  if (args[0] === 'detach-app') {
    if (process.platform === 'win32' && process.env.TEST_ENV_LEASE_JOB && !process.env.TEST_ENV_LEASE_BROKER) throw new Error('missing cached-app broker');
    console.log(process.platform === 'win32' && process.env.TEST_ENV_LEASE_JOB
      ? await requestCachedApp(args.slice(1)) : await detachApp(args.slice(1), root));
    return;
  }
  if (args[0] === 'watch-app') {
    const pid = Number(args[1]);
    if (!Number.isSafeInteger(pid) || pid <= 1 || !args[2] || !args[3] || !args[4]) throw new Error('usage: test-env-lease.mjs watch-app <pid> <start> <root> <served>');
    await watchApp(pid, args[2], args[3], args[4]);
    return;
  }
  if (args[0] === 'join') {
    // The shell itself must be recorded, not this short-lived registration process. The
    // supervising `run` owns its lifetime; an abruptly orphaned shell stays protected too.
    const lease = await acquireTestEnvLease(root, { token: process.env.TEST_ENV_LEASE_TOKEN, pid: process.platform === 'win32' ? process.ppid : Number(args[1]), group: true });
    if (!process.env.TEST_ENV_LEASE_TOKEN) { lease.release(); throw new Error('missing inherited test environment lease'); }
    return;
  }
  if (args[0] !== 'run' || args[1] !== 'sh' || !args[2]) throw new Error('usage: test-env-lease.mjs run sh <script> [args] | join <pid> | watch-app <pid> <start> <root> <served>');
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
    const env = { ...process.env, TEST_ENV_LEASE_TOKEN: lease.token, TEST_ENV_LEASE_ENTRY: args[2], ...(job ? { TEST_ENV_LEASE_JOB: job, TEST_ENV_LEASE_BROKER: inheritedBroker ?? broker.pipe } : {}) };
    const command = job ? ['powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', windowsScript, 'run', windowsPayload({ job, parent: process.pid, start: identity(process.pid).start, command: windowsCommand(args.slice(1)) })] : args.slice(1);
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
  } finally { broker?.close(); lease.release(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(error => {
    console.error(`[test-env] ${error.message}`);
    if (process.argv[4]?.endsWith('/e2e.sh')) console.error('TEST_E2E_STATUS=failed');
    process.exitCode = 1;
  });
}
