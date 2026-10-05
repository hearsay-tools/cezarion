import assert from 'node:assert/strict';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { Agent, createServer, get, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { RunStore } from '../../src/runs/store.ts';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
// Child cwd is a temporary repo: resolve the source loader here, never there.
// Built CLI coverage must run plain JS without a development-only loader.
const cliArgs = process.env.TEST_COCKPIT_SOURCE_CLI === '1'
  ? ['--import', import.meta.resolve('tsx'), join(packageRoot, 'src/index.ts')]
  : [join(packageRoot, 'dist/index.js')];

// Use node:http so ambient HTTP proxies cannot intercept loopback aliases.
async function localGet(url: string): Promise<{ status: number | undefined; text: string }> {
  const agent = new Agent();
  try {
    return await new Promise((resolve, reject) => {
      const request = get(url, { agent }, (response) => {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => { text += chunk; });
        response.on('end', () => resolve({ status: response.statusCode, text }));
        response.on('error', reject);
      });
      request.on('error', reject);
      request.setTimeout(5_000, () => request.destroy(new Error(`Local request timed out: ${url}`)));
    });
  } finally { agent.destroy(); }
}

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cez-serve-port-')));
  const children: ChildProcess[] = [];
  const occupants: Server[] = [];
  const repo = async (name: string) => {
    const directory = join(root, name);
    await mkdir(directory);
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: directory });
    execFileSync('git', ['commit', '--allow-empty', '-qm', 'fixture'], { cwd: directory });
    return directory;
  };
  const occupy = async (port = 0, host = '127.0.0.1') => {
    const server = createServer((_request, response) => response.end('ordinary server'));
    occupants.push(server);
    server.listen(port, host);
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    return { server, port: address.port };
  };
  const start = (directory: string, args: string[] = []) => {
    const child = spawn(process.execPath, [...cliArgs, ...args, '--no-open'], {
      cwd: directory,
      env: { ...process.env, CEZ_HOME: join(root, 'home'), CEZ_DRY_RUN: '1', CEZ_NO_BANNER: '1', CEZ_SKILLS_AUTO_UPDATE: '0', CEZ_AUTONAME: '0', CEZ_REMOTE: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(child);
    let output = '';
    child.stdout.on('data', (chunk) => { output += String(chunk); });
    child.stderr.on('data', (chunk) => { output += String(chunk); });
    return {
      child,
      async outcome() {
        for (let i = 0; i < 600; i++) {
          const url = output.match(/cockpit → (http:\/\/\S+)/)?.[1];
          if (url || child.exitCode !== null || child.signalCode !== null) return { url, code: child.exitCode, output };
          // e2e-wait: condition-poll — retry interval follows the child state probe
          await new Promise((done) => setTimeout(done, 50));
        }
        throw new Error(`CLI neither started nor exited: ${output}`);
      },
    };
  };
  const close = async () => {
    await Promise.all(children.map(async (child) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    }));
    await Promise.all(occupants.map((server) => new Promise<void>((done) => server.close(() => done()))));
    await rm(root, { recursive: true, force: true });
  };
  return { root, repo, occupy, start, close };
}

function refused(result: { url?: string; code: number | null; output: string }, port: number) {
  assert.equal(result.code, 1, `occupied port must refuse, not bounce: ${result.output}`);
  assert.equal(result.url, undefined, result.output);
  assert.match(result.output, new RegExp(`port ${port}.*(in use|occupied)`, 'i'));
  assert.match(result.output, /existing cockpit/i);
  assert.match(result.output, /--port/);
  assert.match(result.output, /stop/i);
}

test('busy cockpit port from a different cwd refuses before recovery or startup resources', { timeout: 60_000 }, async () => {
  const f = await fixture();
  try {
    const firstRepo = await f.repo('first');
    const secondRepo = await f.repo('second');
    const first = await f.start(firstRepo, ['--port', '0']).outcome();
    assert.ok(first.url, first.output);
    const port = Number(new URL(first.url).port);
    const dataDir = join(secondRepo, '.ai/cezar');
    const store = RunStore.open(dataDir);
    store.createRun({ title: 'must not recover', workflow: 'quick-task', task: 'must not run', worktree: false,
      steps: [{ id: 'task', name: 'Task', kind: 'agent' }] });
    store.flush();
    const index = await readFile(join(dataDir, 'runs.json'), 'utf8');
    const orphan = join(dataDir, 'worktrees', 'orphan-sentinel');
    await mkdir(orphan, { recursive: true });
    await writeFile(join(orphan, 'sentinel'), 'preserve');
    const homeConfig = await readFile(join(f.root, 'home', 'config.json'), 'utf8');

    refused(await f.start(secondRepo, ['serve', '--port', String(port)]).outcome(), port);
    assert.equal(await readFile(join(dataDir, 'runs.json'), 'utf8'), index, 'rejected boot must not recover runs');
    assert.deepEqual(await readdir(join(dataDir, 'runs')), [], 'no recovery event or agent resources');
    assert.equal(await readFile(join(orphan, 'sentinel'), 'utf8'), 'preserve', 'no startup pruning');
    assert.equal(await readFile(join(f.root, 'home', 'config.json'), 'utf8'), homeConfig, 'no registry mutation');
    assert.equal(existsSync(join(dataDir, 'cockpit.lock')), false, 'rejection must release ownership');
    assert.equal((await localGet(`${first.url}/api/v1/health`)).status, 200, 'existing cockpit remains healthy');

    const deliberateRepo = await f.repo('deliberate');
    const free = await f.occupy();
    await new Promise<void>((done) => free.server.close(() => done()));
    const deliberate = await f.start(deliberateRepo, ['--port', String(free.port)]).outcome();
    assert.ok(deliberate.url, deliberate.output);
    assert.equal(Number(new URL(deliberate.url).port), free.port, 'explicit free port stays exact');
    assert.equal((await localGet(`${deliberate.url}/api/v1/health`)).status, 200);
  } finally { await f.close(); }
});

for (const host of ['127.0.0.1', '127.0.0.2']) for (const restartExact of [false, true]) test(`ordinary occupied port refuses on ${host} (restart-exact=${restartExact})`, { timeout: 40_000 }, async () => {
  const f = await fixture();
  try {
    const repo = await f.repo('repo');
    // A loopback-only probe on 127.0.0.1 would miss the 127.0.0.2 occupant.
    const { port } = await f.occupy(0, host);
    refused(await f.start(repo, ['--bind-host', host, '--port', String(port), ...(restartExact ? ['--restart-exact'] : [])]).outcome(), port);
    assert.equal(existsSync(join(repo, '.ai/cezar/runs')), false, 'no store initialized');
    assert.equal(existsSync(join(f.root, 'home', 'config.json')), false, 'no workspace initialized');
    assert.equal(existsSync(join(repo, '.ai/cezar/cockpit.lock')), false);
    assert.equal((await localGet(`http://${host}:${port}`)).text, 'ordinary server');
  } finally { await f.close(); }
});

test('default occupied port refuses; explicit zero still requests an ephemeral listener', { timeout: 40_000 }, async () => {
  const f = await fixture();
  try {
    const repo = await f.repo('repo');
    // A host cockpit may already own the default port. Either way it is occupied;
    // never stop or modify a pre-existing listener.
    try { await f.occupy(4321); }
    catch (error) { assert.equal((error as NodeJS.ErrnoException).code, 'EADDRINUSE'); }
    refused(await f.start(repo).outcome(), 4321);
    const ephemeral = await f.start(repo, ['--port', '0']).outcome();
    assert.ok(ephemeral.url, ephemeral.output);
    assert.ok(Number(new URL(ephemeral.url).port) > 0);
    assert.equal((await localGet(`${ephemeral.url}/api/v1/health`)).status, 200);
  } finally { await f.close(); }
});

test('free default port starts on the requested bind host', { timeout: 40_000 }, async () => {
  const f = await fixture();
  try {
    const repo = await f.repo('repo');
    // Keep the port default while isolating from the host cockpit's loopback address.
    const started = await f.start(repo, ['--bind-host', '::1']).outcome();
    assert.ok(started.url, started.output);
    assert.equal(started.url, 'http://[::1]:4321');
    assert.equal((await localGet(`${started.url}/api/v1/health`)).status, 200);
  } finally { await f.close(); }
});

test('different cwd contenders acquire the exact port once before either can recover', { timeout: 60_000 }, async () => {
  const f = await fixture();
  try {
    const repos = await Promise.all([f.repo('first'), f.repo('second')]);
    const indexes = [];
    for (const repo of repos) {
      const store = RunStore.open(join(repo, '.ai/cezar'));
      store.createRun({ title: 'recovery sentinel', workflow: 'quick-task', task: 'sentinel', worktree: false,
        steps: [{ id: 'task', name: 'Task', kind: 'agent' }] });
      store.flush();
      indexes.push(await readFile(join(repo, '.ai/cezar/runs.json'), 'utf8'));
    }
    const free = await f.occupy();
    await new Promise<void>((done) => free.server.close(() => done()));
    const contenders = repos.map((repo) => f.start(repo, ['--port', String(free.port)]));
    const outcomes = await Promise.all(contenders.map((child) => child.outcome()));
    assert.equal(outcomes.filter((outcome) => outcome.url).length, 1, JSON.stringify(outcomes));
    const loser = outcomes.findIndex((outcome) => outcome.code === 1);
    assert.ok(loser >= 0, JSON.stringify(outcomes));
    refused(outcomes[loser]!, free.port);
    assert.equal(await readFile(join(repos[loser]!, '.ai/cezar/runs.json'), 'utf8'), indexes[loser]);
    assert.deepEqual(await readdir(join(repos[loser]!, '.ai/cezar/runs')), []);
    assert.equal(existsSync(join(repos[loser]!, '.ai/cezar/cockpit.lock')), false);
    const winner = outcomes.find((outcome) => outcome.url)!;
    assert.equal(Number(new URL(winner.url!).port), free.port);
    assert.equal((await localGet(`${winner.url}/api/v1/health`)).status, 200);
  } finally { await f.close(); }
});
