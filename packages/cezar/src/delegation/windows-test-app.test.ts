import { spawn, execFileSync } from 'node:child_process';
import childProcess from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { syncBuiltinESMExports } from 'node:module';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { windowsStartToken, windowsTestAppHolds, windowsTestAppOwned } from './windows-test-app.ts';
import { createOwnedWorkspace, removeOwnedWorkspace } from './workspace.ts';

describe('Windows test app ownership', () => {
  const root = 'C:\\work trees\\worker';
  const served = 'C:\\work trees\\worker\\.ai\\qa\\served\\worker';
  const script = '.ai\\qa\\build\\cezar\\dist\\index.js';
  it('accepts only the exact worker or its isolated served clone', () => {
    expect(windowsTestAppOwned(['node', script, '--repo', served], root)).toBe(true);
    expect(windowsTestAppOwned(['node', script, '--repo', root], root)).toBe(true);
    expect(windowsTestAppOwned(['node', script, '--repo', 'C:\\work trees\\other'], root)).toBe(false);
    expect(windowsTestAppOwned(['node', script, '--repo', `${served}-other`], root)).toBe(false);
    expect(windowsTestAppOwned(['node', script, '--repo', served, '--repo', 'C:\\work trees\\other'], root)).toBe(false);
    expect(windowsTestAppOwned(['node', script, served], root)).toBe(false);
    expect(windowsTestAppOwned(['node', 'other.js', '--repo', served], root)).toBe(false);
  });
});

afterEach(() => { vi.restoreAllMocks(); syncBuiltinESMExports(); });
it('requires the recorded start identity and refuses unreadable process evidence', () => {
  const root = 'C:\\work trees\\worker';
  const args = ['node.exe', '.ai\\qa\\build\\cezar\\dist\\index.js', '--repo', root];
  const probe = vi.spyOn(childProcess, 'spawnSync'); syncBuiltinESMExports();
  probe.mockReturnValue({ status: 0, stdout: JSON.stringify({ start: '123', args }) } as ReturnType<typeof childProcess.spawnSync>);
  expect(windowsTestAppHolds(42, '123', root)).toBe(true);
  expect(windowsTestAppHolds(42, '124', root)).toBe(false);
  probe.mockReturnValue({ status: 1, stdout: '' } as ReturnType<typeof childProcess.spawnSync>);
  expect(windowsTestAppHolds(42, '123', root)).toBe(false);
  expect(windowsStartToken(42)).toBeUndefined();
  probe.mockReturnValue({ status: 0, stdout: '123\r\n' } as ReturnType<typeof childProcess.spawnSync>);
  expect(windowsStartToken(42)).toBe('123');
});

it.runIf(process.platform === 'win32')('stops the owned app only after its live lease is released', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cez-windows-app-'));
  const children: Array<ReturnType<typeof spawn>> = [];
  let db: DatabaseSync | undefined;
  try {
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
    git('init', '-q', '-b', 'main'); git('config', 'user.name', 'test'); git('config', 'user.email', 'test@local');
    await writeFile(join(root, 'tracked'), 'test'); git('add', 'tracked'); git('commit', '-qm', 'initial');
    let workspace;
    try { workspace = await createOwnedWorkspace(root, randomUUID(), git('rev-parse', 'HEAD')); }
    catch (error) {
      const dir = join(root, '.git', 'cezar-owned-workspaces');
      const info = await lstat(dir);
      throw new Error(`workspace creation failed: mode=${(info.mode & 0o777).toString(8)} symlink=${info.isSymbolicLink()} realpath=${await realpath(dir)} expected=${dir}`, { cause: error });
    }
    const launch = async (cwd: string) => {
      const script = join(cwd, '.ai/qa/build/cezar/dist/index.js');
      await mkdir(join(cwd, '.ai/qa/build/cezar/dist'), { recursive: true });
      await writeFile(script, 'console.log("ready"); setInterval(() => {}, 1000);');
      const child = spawn(process.execPath, [script, '--repo', cwd], { cwd, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
      children.push(child); await once(child.stdout!, 'data'); return child;
    };
    const app = await launch(workspace.path); const other = await launch(root);
    const qa = join(workspace.path, '.ai/qa');
    const descriptor = (pid: number) => JSON.stringify({ startedByThisRepo: true, app: { pid, start: windowsStartToken(pid) } });
    await writeFile(join(qa, 'test-env.json'), descriptor(app.pid!));
    const watcher = spawn(process.execPath, [resolve(import.meta.dirname, '../../../../.ai/scripts/test-env-lease.mjs'), 'watch-app', String(app.pid), windowsStartToken(app.pid!)!, workspace.path, workspace.path], {
      cwd: tmpdir(), env: { ...process.env, TEST_ENV_WATCH_INTERVAL_SECONDS: '2' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    children.push(watcher);
    let watcherError = '';
    watcher.stderr!.on('data', chunk => { watcherError += String(chunk); });
    await Promise.race([
      once(watcher.stdout!, 'data'),
      once(watcher, 'exit').then(([code]) => { throw new Error(`watcher exited before ready (${code}): ${watcherError}`); }),
    ]);
    console.info('native cleanup: watcher ready');
    db = new DatabaseSync(join(qa, 'test-env-lease.sqlite'));
    db.exec('CREATE TABLE holders (id TEXT PRIMARY KEY, token TEXT NOT NULL, pid INTEGER NOT NULL, start TEXT, pgid INTEGER)');
    db.prepare('INSERT INTO holders VALUES (?, ?, ?, ?, NULL)').run('live', 'live', process.pid, windowsStartToken(process.pid)!);
    expect(await removeOwnedWorkspace(root, workspace)).toMatchObject({ state: 'incomplete' });
    expect(app.exitCode).toBeNull(); expect(other.exitCode).toBeNull();
    db.exec('DELETE FROM holders'); db.close(); db = undefined;
    await writeFile(join(qa, 'test-env.json'), descriptor(other.pid!));
    expect(await removeOwnedWorkspace(root, workspace)).toMatchObject({ state: 'incomplete' });
    expect(other.exitCode).toBeNull();
    await writeFile(join(qa, 'test-env.json'), descriptor(app.pid!));
    console.info('native cleanup: stopping owned app');
    const result = await removeOwnedWorkspace(root, workspace);
    if (result.state !== 'complete') {
      const state = await readFile(join(qa, 'test-env.json'), 'utf8').then(text => JSON.parse(text)).catch(() => null);
      console.info('native cleanup diagnostic:', JSON.stringify({
        appExit: app.exitCode, appSignal: app.signalCode, appIdentityLive: windowsStartToken(app.pid!) !== undefined,
        watcherExit: watcher.exitCode, watcherSignal: watcher.signalCode, watcherIdentityLive: windowsStartToken(watcher.pid!) !== undefined,
        descriptorStatus: state?.status ?? 'missing-or-running', descriptorHasPid: Number.isSafeInteger(state?.app?.pid),
      }));
    }
    expect(result, JSON.stringify(result)).toMatchObject({ state: 'complete', remaining: [] });
    expect(watcher.exitCode).not.toBeNull();
    expect(other.exitCode).toBeNull();
  } finally {
    db?.close();
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
      }
    }
    await rm(root, { recursive: true, force: true });
  }
}, 90_000);
