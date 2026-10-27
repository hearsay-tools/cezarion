import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { processStartToken, stopGroup } from '../detached-process.ts';
import { inspectGeneration } from './process-liveness.ts';
import { windowsStartToken, windowsTestAppHolds } from './windows-test-app.ts';

// Process probes use the host OS even when a test simulates another platform.
const windowsWatchers = process.platform === 'win32';
const startToken = (pid: number) => process.platform === 'win32' ? windowsStartToken(pid) : processStartToken(pid);
const samePath = (a: string, b: string) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;

function present(path: string): boolean {
  try { lstatSync(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}

type IdleClaim = { id: string; token: string };
type PendingClaim = IdleClaim & { path: string; dev: number; ino: number };
const pendingClaims = new Map<string, PendingClaim[]>();
function sameDatabase(path: string, expected: { dev: number; ino: number }): boolean {
  const info = lstatSync(path);
  return info.isFile() && !info.isSymbolicLink() && samePath(realpathSync(path), path) &&
    info.dev === expected.dev && info.ino === expected.ino;
}

function claimIdle(db: DatabaseSync, start: string): IdleClaim | undefined {
  db.exec('PRAGMA busy_timeout=1000'); db.exec('BEGIN IMMEDIATE');
  try {
    // Keep even stale or unreadable holders: only the lease owner may reclaim them.
    if (db.prepare('SELECT 1 FROM holders LIMIT 1').get()) { db.exec('COMMIT'); return undefined; }
    const claim = { id: `destroy-${randomUUID()}`, token: randomUUID() };
    db.prepare('INSERT INTO holders (id, token, pid, start, pgid) VALUES (?, ?, ?, ?, NULL)').run(claim.id, claim.token, process.pid, start);
    db.exec('COMMIT'); return claim;
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

/** Release only claims this controller made against the same database object. */
function releasePending(path: string): boolean {
  const claims = pendingClaims.get(path);
  if (!claims?.length) return true;
  try {
    if (!present(path)) { pendingClaims.delete(path); return true; }
    if (claims.some(claim => !sameDatabase(path, claim))) return false;
    const db = new DatabaseSync(path);
    try {
      db.exec('PRAGMA busy_timeout=1000');
      for (const claim of [...claims]) {
        if (!sameDatabase(path, claim)) return false;
        db.prepare('DELETE FROM holders WHERE id = ? AND token = ?').run(claim.id, claim.token);
        if (db.prepare('SELECT 1 FROM holders WHERE id = ?').get(claim.id)) return false;
        claims.splice(claims.indexOf(claim), 1);
      }
      pendingClaims.delete(path);
      return true;
    } finally { db.close(); }
  } catch { return false; }
}

function readApp(root: string) {
  const qa = join(root, '.ai/qa'); const database = join(qa, 'test-env-lease.sqlite');
  const descriptor = join(qa, 'test-env.json');
  if (!existsSync(database) || !samePath(realpathSync(qa), qa) || !samePath(realpathSync(database), database) || !samePath(realpathSync(descriptor), descriptor)) return undefined;
  const app = JSON.parse(readFileSync(descriptor, 'utf8'));
  if (app?.startedByThisRepo !== true) return undefined;
  const pid = app.app?.pid; const start = app.app?.start;
  if (app.status === 'stopped' && pid === undefined && start === undefined) {
    return { app, pid: null, start: null, database, descriptor };
  }
  if (!Number.isSafeInteger(pid) || pid <= 1 || (start !== undefined && typeof start !== 'string')) return undefined;
  return { app, pid: pid as number, start: typeof start === 'string' ? start : null, database, descriptor };
}

function recordedAppGone(pid: number, start: string | null): boolean {
  const current = startToken(pid);
  if (current !== undefined) return start !== null && current !== start;
  try { process.kill(pid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
}

async function stopOwnedApp(root: string, entry: NonNullable<ReturnType<typeof readApp>>): Promise<boolean> {
  if (entry.pid === null) return false;
  const leader = { pid: entry.pid, start: entry.start };
  if (recordedAppGone(leader.pid, leader.start)) {
    if (!await waitForTestAppWatcher(root)) return false;
  } else {
    if (leader.start === null) return false; // Legacy PID alone never authorizes a signal.
    const owned = process.platform === 'win32' ? windowsTestAppHolds(leader.pid, leader.start, root)
      : inspectGeneration({ paths: [root] }).pids.includes(leader.pid);
    if (!owned || startToken(leader.pid) !== leader.start || !await stopGroup({ pid: leader.pid, start: leader.start }, { graceMs: 1000, readStart: startToken })) return false;
  }
  entry.app.status = 'stopped'; delete entry.app.app.pid; delete entry.app.app.start;
  writeFileSync(entry.descriptor, JSON.stringify(entry.app, null, 2) + '\n');
  return true;
}

/** Claim the checkout's test environment while removing it. Any uncertain state fails closed. */
export async function withIdleTestApp<T>(root: string, remove: (stopped: boolean, busy: boolean) => Promise<T>): Promise<T> {
  let db: DatabaseSync | undefined; let claim: PendingClaim | undefined; let stopped = false;
  let busy = present(join(root, '.ai/qa/test-env.json')) || present(join(root, '.ai/qa/test-env-lease.sqlite'));
  try {
   try {
    const entry = readApp(root);
    const ownStart = entry && startToken(process.pid);
    if (entry && ownStart && releasePending(entry.database)) {
      const info = lstatSync(entry.database);
      if (!sameDatabase(entry.database, info)) throw new Error('Test environment lease database changed');
      db = new DatabaseSync(entry.database);
      if (!sameDatabase(entry.database, info)) throw new Error('Test environment lease database changed');
      const acquired = claimIdle(db, ownStart);
      // The durable row protects the environment after closing SQLite. Keeping the file
      // open here prevents Windows from removing the checkout that contains it.
      if (acquired) {
        claim = { ...acquired, path: entry.database, dev: info.dev, ino: info.ino }; db.close(); db = undefined;
        if (!sameDatabase(entry.database, info)) throw new Error('Test environment lease database changed');
        // A descriptor alone cannot authorize signalling a process outside this checkout.
        stopped = entry.pid !== null && await stopOwnedApp(root, entry);
        busy = entry.pid !== null && !stopped;
      }
    }
   } catch { /* Unverifiable metadata or a failed stop must block even without a cwd scan. */ }
   return await remove(stopped, busy);
  }
  finally {
    if (claim) {
      const pending = pendingClaims.get(claim.path) ?? [];
      pending.push(claim); pendingClaims.set(claim.path, pending);
      releasePending(claim.path);
    }
    db?.close();
  }
}

/** Read command lines, not cwd: production watchers run from the system temp directory.
 * This probe never authorizes a signal. Ambiguous matches only delay/refuse removal. */
function watcherPresent(root: string): boolean {
  const windows = windowsWatchers;
  const script = "$ErrorActionPreference='Stop'; ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Process -Filter \"Name = 'node.exe'\" | ForEach-Object { if (!$_.CommandLine) { throw 'Unreadable node command line' }; $_.CommandLine })";
  const result = windows
    ? spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', timeout: 10_000, windowsHide: true })
    : spawnSync('ps', ['-axww', '-o', 'args='], { encoding: 'utf8', timeout: 2_000 });
  if (result.status !== 0) return true;
  try {
    const lines: string[] = windows ? JSON.parse(result.stdout || '[]') : result.stdout.split('\n');
    if (!Array.isArray(lines)) return true;
    const normalize = (value: string) => windows ? value.replaceAll('\\', '/').toLowerCase() : value;
    return lines.some(line => line.includes('test-env-lease.mjs') && line.includes('watch-app') && normalize(line).includes(normalize(root)));
  } catch { return true; }
}

/** A timeout or unreadable process table keeps the checkout intact for a later retry. */
export async function waitForTestAppWatcher(root: string): Promise<boolean> {
  const deadline = Date.now() + 32_000;
  while (watcherPresent(root)) {
    if (Date.now() >= deadline) return false;
    await delay(250);
  }
  return true;
}
