import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { processStartToken } from '../detached-process.ts';
import { createOwnedWorkspace, removeOwnedWorkspace } from './workspace.ts';
import { withIdleTestApp } from './idle-test-app.ts';
import { execFileSync } from 'node:child_process';

const roots: string[] = [];
const children: Array<ReturnType<typeof spawn>> = [];
afterEach(async () => {
  for (const child of children.splice(0)) { try { process.kill(-child.pid!, 'SIGKILL'); } catch {} }
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

it.skipIf(process.platform !== 'linux')('keeps the lease claim durable after closing the database and clears it on refusal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cez-idle-claim-')); roots.push(root);
  const qa = join(root, '.ai/qa'); await mkdir(qa, { recursive: true });
  await writeFile(join(qa, 'test-env.json'), JSON.stringify({ startedByThisRepo: true, app: { pid: process.pid, start: processStartToken(process.pid) } }));
  const db = new DatabaseSync(join(qa, 'test-env-lease.sqlite'));
  db.exec('CREATE TABLE holders (id TEXT PRIMARY KEY, token TEXT NOT NULL, pid INTEGER NOT NULL, start TEXT, pgid INTEGER)'); db.close();
  await withIdleTestApp(root, async () => {
    const observer = new DatabaseSync(join(qa, 'test-env-lease.sqlite'));
    expect(observer.prepare('SELECT count(*) AS count FROM holders').get()).toMatchObject({ count: 1 });
    observer.close(); return false;
  });
  const observer = new DatabaseSync(join(qa, 'test-env-lease.sqlite'));
  expect(observer.prepare('SELECT count(*) AS count FROM holders').get()).toMatchObject({ count: 0 });
  observer.close();
});

it.skipIf(process.platform !== 'linux')('removes the idle worker app but preserves another checkout and live leases', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cez-idle-app-')); roots.push(root);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'test'); git('config', 'user.email', 'test@local');
  await writeFile(join(root, 'tracked'), 'test'); git('add', 'tracked'); git('commit', '-qm', 'initial');
  const workspace = await createOwnedWorkspace(root, randomUUID(), git('rev-parse', 'HEAD'));
  const launch = async (cwd: string) => {
    const child = spawn(process.execPath, ['-e', 'console.log("ready"); setInterval(() => {}, 1000)'], { cwd, detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
    children.push(child); await once(child.stdout!, 'data'); return child;
  };
  const app = await launch(workspace.path); const other = await launch(root);
  const qa = join(workspace.path, '.ai/qa'); await mkdir(qa, { recursive: true });
  await writeFile(join(qa, 'test-env.json'), JSON.stringify({ startedByThisRepo: true, app: { pid: app.pid, start: processStartToken(app.pid!) } }));
  const db = new DatabaseSync(join(qa, 'test-env-lease.sqlite'));
  db.exec('CREATE TABLE holders (id TEXT PRIMARY KEY, token TEXT NOT NULL, pid INTEGER NOT NULL, start TEXT, pgid INTEGER)');
  db.prepare('INSERT INTO holders VALUES (?, ?, ?, ?, NULL)').run('live', 'live', process.pid, processStartToken(process.pid)!);
  const watcher = spawn(process.execPath, [resolve(import.meta.dirname, '../../../../.ai/scripts/test-env-lease.mjs'), 'watch-app', String(app.pid), processStartToken(app.pid!)!, workspace.path, workspace.path], {
    cwd: tmpdir(), detached: true, env: { ...process.env, TEST_ENV_WATCH_INTERVAL_SECONDS: '2' }, stdio: ['ignore', 'pipe', 'ignore'],
  });
  children.push(watcher); await once(watcher.stdout!, 'data');
  expect(await removeOwnedWorkspace(root, workspace)).toMatchObject({ state: 'incomplete' });
  expect(app.exitCode).toBeNull(); expect(other.exitCode).toBeNull();
  db.exec('DELETE FROM holders'); db.close();
  // Even a descriptor that names another checkout's live process cannot stop it.
  await writeFile(join(qa, 'test-env.json'), JSON.stringify({ startedByThisRepo: true, app: { pid: other.pid, start: processStartToken(other.pid!) } }));
  expect(await removeOwnedWorkspace(root, workspace)).toMatchObject({ state: 'incomplete' });
  expect(other.exitCode).toBeNull();
  await writeFile(join(qa, 'test-env.json'), JSON.stringify({ startedByThisRepo: true, app: { pid: app.pid, start: processStartToken(app.pid!) } }));
  expect(await removeOwnedWorkspace(root, workspace)).toMatchObject({ state: 'complete', remaining: [] });
  expect(watcher.exitCode).not.toBeNull();
  expect(other.exitCode).toBeNull();
  expect(git('branch', '--list', workspace.branch)).toBe('');
}, 60_000);

it('clears a stale app descriptor after the recorded process exits', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cez-exited-app-')); roots.push(root);
  const qa = join(root, '.ai/qa'); await mkdir(qa, { recursive: true });
  const child = spawn(process.execPath, ['-e', 'console.log("ready"); setInterval(() => {}, 1000)'], { stdio: ['ignore', 'pipe', 'ignore'] });
  await once(child.stdout!, 'data');
  const start = processStartToken(child.pid!) ?? 'recorded-start';
  await writeFile(join(qa, 'test-env.json'), JSON.stringify({ startedByThisRepo: true, app: { pid: child.pid, start } }));
  const exited = once(child, 'exit'); child.kill(); await exited;
  const db = new DatabaseSync(join(qa, 'test-env-lease.sqlite'));
  db.exec('CREATE TABLE holders (id TEXT PRIMARY KEY, token TEXT NOT NULL, pid INTEGER NOT NULL, start TEXT, pgid INTEGER)'); db.close();
  await withIdleTestApp(root, async (_stopped, busy) => { expect(busy).toBe(false); });
});
