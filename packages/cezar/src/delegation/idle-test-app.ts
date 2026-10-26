import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { processStartToken, stopGroup } from '../detached-process.ts';
import { inspectGeneration } from './process-liveness.ts';
import { windowsStartToken, windowsTestAppHolds } from './windows-test-app.ts';

const startToken = (pid: number) => process.platform === 'win32' ? windowsStartToken(pid) : processStartToken(pid);
const samePath = (a: string, b: string) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;

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
  if (app?.startedByThisRepo !== true || !Number.isSafeInteger(pid) || pid <= 1 || typeof start !== 'string') return undefined;
  return { app, pid: pid as number, start, database, descriptor };
}

/** Claim the checkout's test environment while removing it. Any uncertain state fails closed. */
export async function withIdleTestApp<T>(root: string, remove: (stopped: boolean, busy: boolean) => Promise<T>): Promise<T> {
  let db: DatabaseSync | undefined; let claim: string | undefined; let claimDb: string | undefined; let stopped = false; let busy = false;
  try {
   try {
    const entry = readApp(root);
    const ownStart = startToken(process.pid);
    busy = !!entry;
    if (entry && ownStart) {
      db = new DatabaseSync(entry.database);
      claim = claimIdle(db, ownStart);
      busy = !claim;
      // The durable row protects the environment after closing SQLite. Keeping the file
      // open here prevents Windows from removing the checkout that contains it.
      if (claim) { claimDb = entry.database; db.close(); db = undefined; }
      // A descriptor alone cannot authorize signalling a process outside this checkout.
      const owned = claim && (process.platform === 'win32' ? windowsTestAppHolds(entry.pid, entry.start, root) : inspectGeneration({ paths: [root] }).pids.includes(entry.pid));
      if (owned && startToken(entry.pid) === entry.start && await stopGroup(entry, { graceMs: 1000, readStart: startToken })) {
        stopped = true;
        entry.app.status = 'stopped'; delete entry.app.app.pid; delete entry.app.app.start;
        writeFileSync(entry.descriptor, JSON.stringify(entry.app, null, 2) + '\n');
      }
    }
   } catch { /* Missing, busy, corrupt or unverifiable state leaves the normal holder scan in charge. */ }
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

/** The app watcher checks its leader every 30 seconds and exits after the app stops. */
export async function waitForTestAppWatcher(root: string): Promise<void> {
  const deadline = Date.now() + 32_000;
  while (Date.now() < deadline && inspectGeneration({ paths: [root] }).liveness !== 'gone') await delay(250);
}
