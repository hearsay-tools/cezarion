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

function claimIdle(db: DatabaseSync, start: string): string | undefined {
  db.exec('PRAGMA busy_timeout=1000'); db.exec('BEGIN IMMEDIATE');
  try {
    // Keep even stale or unreadable holders: only the lease owner may reclaim them.
    if (db.prepare('SELECT 1 FROM holders LIMIT 1').get()) { db.exec('COMMIT'); return undefined; }
    const claim = `destroy-${randomUUID()}`;
    db.prepare('INSERT INTO holders (id, token, pid, start, pgid) VALUES (?, ?, ?, ?, NULL)').run(claim, randomUUID(), process.pid, start);
    db.exec('COMMIT'); return claim;
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

function readApp(root: string) {
  const qa = join(root, '.ai/qa'); const database = join(qa, 'test-env-lease.sqlite');
  const descriptor = join(qa, 'test-env.json');
  if (!existsSync(database) || !samePath(realpathSync(qa), qa) || !samePath(realpathSync(database), database) || !samePath(realpathSync(descriptor), descriptor)) return undefined;
  const app = JSON.parse(readFileSync(descriptor, 'utf8'));
  const pid = app?.app?.pid; const start = app?.app?.start;
  if (app?.startedByThisRepo === true && app?.status === 'stopped' && pid === undefined && start === undefined) {
    return { app, pid: null, start: null, database, descriptor };
  }
  if (app?.startedByThisRepo !== true || !Number.isSafeInteger(pid) || pid <= 1 || typeof start !== 'string') return undefined;
  return { app, pid: pid as number, start, database, descriptor };
}

async function stopOwnedApp(root: string, entry: NonNullable<ReturnType<typeof readApp>>): Promise<boolean> {
  if (entry.pid === null) return false;
  const leader = { pid: entry.pid, start: entry.start! };
  const owned = process.platform === 'win32' ? windowsTestAppHolds(leader.pid, leader.start, root)
    : inspectGeneration({ paths: [root] }).pids.includes(leader.pid);
  if (!owned || startToken(leader.pid) !== leader.start || !await stopGroup(leader, { graceMs: 1000, readStart: startToken })) return false;
  entry.app.status = 'stopped'; delete entry.app.app.pid; delete entry.app.app.start;
  writeFileSync(entry.descriptor, JSON.stringify(entry.app, null, 2) + '\n');
  return true;
}

/** Claim the checkout's test environment while removing it. Any uncertain state fails closed. */
export async function withIdleTestApp<T>(root: string, remove: (stopped: boolean, busy: boolean) => Promise<T>): Promise<T> {
  let db: DatabaseSync | undefined; let claim: string | undefined; let claimDb: string | undefined; let stopped = false;
  let busy = present(join(root, '.ai/qa/test-env.json')) || present(join(root, '.ai/qa/test-env-lease.sqlite'));
  try {
   try {
    const entry = readApp(root);
    const ownStart = entry && startToken(process.pid);
    if (entry && ownStart) {
      db = new DatabaseSync(entry.database);
      claim = claimIdle(db, ownStart);
      // The durable row protects the environment after closing SQLite. Keeping the file
      // open here prevents Windows from removing the checkout that contains it.
      if (claim) {
        claimDb = entry.database; db.close(); db = undefined;
        // A descriptor alone cannot authorize signalling a process outside this checkout.
        stopped = entry.pid !== null && await stopOwnedApp(root, entry);
        busy = entry.pid !== null && !stopped;
      }
    }
   } catch { /* Unverifiable metadata or a failed stop must block even without a cwd scan. */ }
   return await remove(stopped, busy);
  }
  finally {
    if (claim && claimDb) {
      try {
        if (existsSync(claimDb) && samePath(realpathSync(claimDb), claimDb)) {
          const cleanup = new DatabaseSync(claimDb);
          try { cleanup.prepare('DELETE FROM holders WHERE id = ?').run(claim); } finally { cleanup.close(); }
        }
      } catch { /* checkout may already be gone */ }
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
