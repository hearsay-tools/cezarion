import assert from 'node:assert/strict';
import { execFile as execFileCallback, spawn } from 'node:child_process';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

const execFile = promisify(execFileCallback);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const cli = join(packageRoot, 'dist/index.js');

interface Result { code: number; stdout: string; stderr: string; json: Record<string, unknown> }

/**
 * `cez task` (#504) through the BUILT CLI against a real `CEZ_DRY_RUN=1` cockpit: discovery by
 * this checkout's root on the default port range, idempotent start, waiting, steering and
 * stopping — and, with the cockpit gone, the `no-cockpit` exit 2.
 */
test('built cez task drives a dry-run cockpit it discovers from the checkout', { timeout: 180_000 }, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cez-task-e2e-')));
  const repo = join(root, 'repo');
  await mkdir(repo);
  await execFile('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  await execFile('git', ['-c', 'user.name=test', '-c', 'user.email=test@local', 'commit', '--allow-empty', '-qm', 'base'], { cwd: repo });
  const env = { ...process.env, CEZ_HOME: join(root, 'home'), CEZ_DRY_RUN: '1', CEZ_AUTONAME: '0', CEZ_NO_BANNER: '1',
    CEZ_REMOTE: '0', CEZ_URL: '', CEZ_DELEGATION_URL: '', CEZ_DELEGATION_TOKEN: '' };
  const task = async (args: string[]): Promise<Result> => {
    const result = await execFile(process.execPath, [cli, 'task', ...args], { cwd: repo, env, timeout: 150_000 })
      .then((ok) => ({ ...ok, code: 0 }), (error) => ({ stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? ''), code: Number(error.code) }));
    const lastLine = result.stdout.trim().split('\n').at(-1) ?? '';
    let json: Record<string, unknown> = {};
    try { json = JSON.parse(lastLine) as Record<string, unknown>; } catch { /* asserted by the caller */ }
    return { ...result, json };
  };

  const server = spawn(process.execPath, [cli, '--repo', repo, '--no-open'], { cwd: repo, env, stdio: 'ignore' });
  try {
    let listed: Result | undefined;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      listed = await task(['list']);
      if (listed.code === 0) break;
      await new Promise((done) => setTimeout(done, 200));
    }
    assert.equal(listed?.code, 0, `cockpit never became discoverable: ${listed?.stdout}`);

    const requestId = '3c9d2f1a-7b4e-4c5d-9e8f-0a1b2c3d4e5f';
    const started = await task(['start', 'mock:done', '--request-id', requestId, '--wait', '--timeout-seconds', '120']);
    assert.equal(started.code, 0, started.stdout + started.stderr);
    assert.equal(started.json.created, true);
    assert.match(String(started.json.status), /^(done|review)$/);
    const id = String(started.json.id);
    const origin = new URL(String(started.json.url)).origin;

    const retried = await task(['start', 'mock:done', '--request-id', requestId]);
    assert.equal(retried.code, 0);
    assert.equal(retried.json.id, id);
    assert.equal(retried.json.created, false);

    const runs = (await (await fetch(`${origin}/api/v1/runs`)).json()) as Array<{ id: string }>;
    assert.deepEqual(runs.map((run) => run.id), [id], 'the run lives in the cockpit, exactly once');

    const status = await task(['status', id]);
    assert.equal(status.code, 0);
    assert.equal(status.json.id, id);
    assert.equal('steps' in status.json, false, 'status is the slim projection');

    const log = await task(['log', id]);
    assert.equal(log.code, 0);
    assert.ok(log.stdout.trim().split('\n').every((line) => typeof JSON.parse(line).seq === 'number'));

    const refused = await task(['send', id, 'once more']);
    assert.equal(refused.code, 1);
    assert.equal(refused.json.delivery, 'not-delivered');
    const resumed = await task(['send', id, 'once more', '--resume']);
    assert.equal(resumed.code, 0, resumed.stdout);
    assert.equal(resumed.json.delivery, 'resumed');

    const stopped = await task(['stop', id]);
    assert.equal(stopped.code, 0, stopped.stdout);

    const headless = await execFile(process.execPath, [cli, 'run', 'mock:done', '--repo', repo], { cwd: repo, env, timeout: 60_000 });
    assert.match(headless.stderr, /a cockpit is running at http:\/\/127\.0\.0\.1:\d+; use "cez task start"/);
  } finally {
    server.kill('SIGTERM');
    if (server.exitCode === null) await new Promise<void>((done) => server.once('exit', () => done()));
  }

  const gone = await task(['list']);
  assert.equal(gone.code, 2);
  assert.equal(gone.json.code, 'no-cockpit');
  const help = await task(['--help']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /cez task start/);
  const usage = await task(['nope']);
  assert.equal(usage.code, 64);
  assert.equal(usage.json.code, 'invalid_input');
  await rm(root, { recursive: true, force: true });
});
