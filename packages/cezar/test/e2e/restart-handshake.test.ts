import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { Agent, createServer, get } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { prepareOperatorHome } from '../../src/home/entry.ts';
import { Home } from '../../src/home/home.ts';

// Releases that shipped the cockpit Update button (v0.14.9 to v0.18.0) update into a newer
// release with their own restart helper. The helper starts the new entry with exactly these
// arguments and an IPC channel, then rolls the update back unless the new process reports its
// listener over IPC and serves a health response with the same version and repoRoot.
// Frozen from application-update/helper.ts `launch` and `verifyHealth`, the same in all of them.
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const cliArgs = process.env.TEST_COCKPIT_SOURCE_CLI === '1'
  ? ['--import', import.meta.resolve('tsx'), join(packageRoot, 'src/index.ts')]
  : [join(packageRoot, 'dist/index.js')];
const version = (JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as { version: string }).version;

// node:http, so an ambient HTTP proxy cannot intercept the loopback request.
async function health(port: number): Promise<{ version?: string; repoRoot?: string }> {
  const agent = new Agent();
  try {
    return await new Promise((done, reject) => {
      const request = get(`http://127.0.0.1:${port}/api/v1/health`, { agent }, (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => { body += chunk; });
        response.on('end', () => {
          try { assert.equal(response.statusCode, 200, body); done(JSON.parse(body)); } catch (error) { reject(error); }
        });
        response.on('error', reject);
      });
      request.on('error', reject);
      request.setTimeout(5_000, () => request.destroy(new Error('health request timed out')));
    });
  } finally { agent.destroy(); }
}

async function freePort(): Promise<number> {
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const address = probe.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise<void>((done) => probe.close(() => done()));
  return address.port;
}

// bound: a cold built CLI boot under CI load; the shipped helper itself waits 20 s for each step.
test('a shipped restart helper sees the listener acknowledgement and matching health', { timeout: 60_000 }, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cez-restart-handshake-')));
  const home = join(root, 'home');
  prepareOperatorHome(Home.sandbox(home), 'serve', { CEZ_HOME: home, HSQ_HOME: home });
  const repoRoot = join(root, 'repo');
  await mkdir(repoRoot);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
  execFileSync('git', ['commit', '--allow-empty', '-qm', 'fixture'], { cwd: repoRoot });
  const port = await freePort();
  const child = spawn(process.execPath, [...cliArgs, 'serve',
    '--bind-host', '127.0.0.1', '--port', String(port), '--repo', repoRoot, '--no-open', '--restart-exact'], {
    cwd: repoRoot,
    env: { ...process.env, CEZ_HOME: home, HSQ_HOME: home, CEZ_DRY_RUN: '1', HSQ_DRY_RUN: '1', CEZ_REMOTE: '0', HSQ_REMOTE: '0' },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  try {
    const [message] = await Promise.race([
      once(child, 'message') as Promise<[unknown]>,
      once(child, 'exit').then(([code]) => { throw new Error(`the new release exited before acknowledging: ${String(code)}`); }),
    ]);
    assert.deepEqual(message, { type: 'application-update-listening', host: '127.0.0.1', port, repoRoot, version });
    const answer = await health(port);
    assert.equal(answer.version, version);
    assert.equal(answer.repoRoot, repoRoot);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    }
    await rm(root, { recursive: true, force: true });
  }
});
