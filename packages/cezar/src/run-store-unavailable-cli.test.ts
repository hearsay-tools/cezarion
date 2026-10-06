import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, expect, it } from 'vitest';

/**
 * A project whose run database cannot be opened (#779, plan step 4), through the real CLI.
 *
 * `serve` still boots: the boot project answers with why, and nothing that would read its unknown
 * runs as "no runs" runs — an empty run list would make every task worktree an orphan to prune and
 * every agent scratch directory one to sweep. Headless `cez run` refuses to start a task it could
 * never save. Either way the damaged files are left exactly as they are.
 */

const exec = promisify(execFile);
const CLI = fileURLToPath(new URL('./index.ts', import.meta.url));
const PACKAGE_DIR = fileURLToPath(new URL('../', import.meta.url));
const DAMAGED = { 'runs.db': 'not a database '.repeat(400), 'runs.db-wal': 'wal '.repeat(300), 'runs.db-shm': 'shm '.repeat(300) };
const RUN_ID = '5b0f8d2e-6c1a-4f3b-9e7d-2a4c6e8f0b13';

let root: string;
let dataDir: string;
let server: ChildProcess | undefined;

const env = () => {
  const vars: NodeJS.ProcessEnv = { ...process.env, CEZ_DRY_RUN: '1', CEZ_HOME: join(root, 'home'), CEZ_NO_BANNER: '1' };
  delete vars.CEZ_AUTOMATIONS;
  return vars;
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cez-unavailable-cli-'));
  dataDir = join(root, '.ai/cezar');
  execFileSync('git', ['init', '-q', '-b', 'main', root]);
  execFileSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init']);
  mkdirSync(dataDir, { recursive: true });
  // A task's worktree, with uncommitted work in it, and its agent scratch.
  execFileSync('git', ['-C', root, 'worktree', 'add', '-q', '-b', `cez/${RUN_ID.slice(0, 8)}`, join(dataDir, 'worktrees', RUN_ID)]);
  writeFileSync(join(dataDir, 'worktrees', RUN_ID, 'work-in-progress.txt'), 'not committed yet');
  mkdirSync(join(dataDir, 'tmp', RUN_ID), { recursive: true });
  writeFileSync(join(dataDir, 'tmp', RUN_ID, 'scratch.txt'), 'agent scratch');
  for (const [name, text] of Object.entries(DAMAGED)) writeFileSync(join(dataDir, name), text);
});

afterEach(async () => {
  if (server && server.exitCode === null && server.signalCode === null) {
    const exited = once(server, 'exit');
    server.kill('SIGKILL');
    await exited;
  }
  server = undefined;
  rmSync(root, { recursive: true, force: true });
});

/** The run database and the history backups stay out of the user's repository, even when the
 *  open that created them failed. */
const runDataIgnored = () => {
  const ignore = existsSync(join(dataDir, '.gitignore')) ? readFileSync(join(dataDir, '.gitignore'), 'utf8').split('\n') : [];
  return ['runs.db', 'runs.db-wal', 'runs.db-shm', 'runs.json.pre-sqlite.bak', 'runs.json.pre-sqlite.*'].filter((entry) => !ignore.includes(entry));
};

const damagedFilesUnchanged = () => {
  for (const [name, text] of Object.entries(DAMAGED)) expect(readFileSync(join(dataDir, name), 'utf8'), name).toBe(text);
};

it('serve boots with the boot project unavailable, and prunes, sweeps and recovers nothing', async () => {
  server = spawn(process.execPath, ['--import', 'tsx', CLI, 'serve', '--repo', root, '--port', '0', '--no-open'], {
    cwd: PACKAGE_DIR, env: env(), stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  server.stderr!.on('data', (chunk) => { stderr += chunk; });
  let url: string | undefined;
  for await (const line of createInterface({ input: server.stdout! })) {
    url = /cockpit → (http:\/\/\S+)/.exec(line)?.[1];
    if (url) break;
  }
  expect(url, stderr).toBeDefined();
  // Boot has finished its sweeps and recovery before it listens.
  expect.soft(existsSync(join(dataDir, 'worktrees', RUN_ID, 'work-in-progress.txt')), 'task worktree').toBe(true);
  expect.soft(existsSync(join(dataDir, 'tmp', RUN_ID, 'scratch.txt')), 'agent scratch').toBe(true);
  for (const [name, text] of Object.entries(DAMAGED)) {
    expect.soft(existsSync(join(dataDir, name)) && readFileSync(join(dataDir, name), 'utf8') === text, name).toBe(true);
  }
  expect.soft(runDataIgnored(), 'not in .ai/cezar/.gitignore').toEqual([]);

  expect.soft(stderr).toMatch(/runs\.db is damaged/);
  const summaries = await fetch(`${url}/api/v1/run-summaries`);
  expect.soft(summaries.status).toBe(409);
  expect.soft(await summaries.text()).toMatch(/runs\.db is damaged .*then restart cezar\."\}$/);
  expect.soft((await fetch(`${url}/api/v1/health`)).status).toBe(200);
}, 60_000);

it('headless run refuses to start, says why, and leaves every file as it was', async () => {
  const result = await exec(process.execPath, ['--import', 'tsx', CLI, 'run', 'mock:done', '--repo', root], {
    cwd: PACKAGE_DIR, env: env(), timeout: 30_000,
  }).then(() => ({ code: 0, stderr: '' }), (error: { code?: number; stderr?: string }) => ({ code: error.code, stderr: error.stderr ?? '' }));
  expect(result.code).toBe(1);
  expect(result.stderr).toMatch(/runs\.db is damaged \(.*\)\. cezar left it and its -wal and -shm files exactly as they are/);
  damagedFilesUnchanged();
  expect(runDataIgnored(), 'not in .ai/cezar/.gitignore').toEqual([]);
  expect(existsSync(join(dataDir, 'worktrees', RUN_ID, 'work-in-progress.txt'))).toBe(true);
  expect(readdirSync(join(dataDir, 'worktrees'))).toEqual([RUN_ID]);
}, 60_000);
