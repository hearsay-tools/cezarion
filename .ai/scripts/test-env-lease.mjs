// The shared browser environment has mutable builds, a clone and a registry as well as a
// server. Keep one test invocation's lease until ALL of its setup/specs/teardown finish.
// Short SQLite transactions make join/release/reclamation atomic, including after SIGKILL.
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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

/** A token admits only descendants of a still-live, verified holder. No token means a new run.
 * Each participant gets its OWN row: killing the wrapper cannot unprotect a live Vitest child.
 */
export async function acquireTestEnvLease(root, { token, pid = process.pid, group = false, timeoutMs = 300_000, onWait } = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('invalid test environment lease pid');
  const own = identity(pid);
  if (!own.start) throw new Error(`cannot verify test environment lease identity for pid ${pid}`);
  const dir = resolve(root, '.ai/qa');
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(resolve(dir, 'test-env-lease.sqlite'));
  db.exec('PRAGMA busy_timeout=1000');
  const id = randomUUID();
  const deadline = performance.now() + timeoutMs;
  let logged = false;
  try {
    db.exec('CREATE TABLE IF NOT EXISTS holders (id TEXT PRIMARY KEY, token TEXT NOT NULL, pid INTEGER NOT NULL, start TEXT, pgid INTEGER)');
    // Rebuildable local state from an earlier development version remains usable.
    if (!db.prepare('PRAGMA table_info(holders)').all().some(column => column.name === 'pgid')) db.exec('ALTER TABLE holders ADD COLUMN pgid INTEGER');
    while (true) {
      db.exec('BEGIN IMMEDIATE');
      let holders;
      try {
        holders = db.prepare('SELECT * FROM holders').all().filter(holder => {
          const current = identity(holder.pid);
          const reused = holder.start && current.start && holder.start !== current.start;
          const dead = (reused || current.dead) && (!holder.pgid || groupLive(holder.pgid) === false);
          if (dead) db.prepare('DELETE FROM holders WHERE id = ?').run(holder.id);
          return !dead;
        });
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
    return child.pid;
  } finally { closeSync(fd); }
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
  if (args[0] === 'join') {
    // The shell itself must be recorded, not this short-lived registration process. The
    // supervising `run` owns its lifetime; an abruptly orphaned shell stays protected too.
    const lease = await acquireTestEnvLease(root, { token: process.env.TEST_ENV_LEASE_TOKEN, pid: process.platform === 'win32' ? process.ppid : Number(args[1]), group: true });
    if (!process.env.TEST_ENV_LEASE_TOKEN) { lease.release(); throw new Error('missing inherited test environment lease'); }
    return;
  }
  if (args[0] !== 'run' || args[1] !== 'sh' || !args[2]) throw new Error('usage: test-env-lease.mjs run sh <script> [args] | join <pid>');
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
