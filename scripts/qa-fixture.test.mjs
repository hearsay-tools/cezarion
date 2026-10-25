import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';

import { down, parseUpArgs, up } from '../.ai/scripts/qa-fixture.mjs';

// A stand-in for the e2e build: `dist/index.js` answers like `cezar serve` does for the checks
// qa-fixture makes. It records its argv and environment, and keeps a child in its own process
// group, so a test can see what reached the server and that `down` stops the whole group.
// CEZ_STUB_MODE (passed through --server-env) picks a failure.
const STUB_SERVER = `
import { spawn } from 'node:child_process';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
const args = process.argv.slice(2);
const repo = realpathSync(args[args.indexOf('--repo') + 1]);
const mode = process.env.CEZ_STUB_MODE ?? 'serve';
if (mode === 'exit') process.exit(3);
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
// cezar creates its home on first write, as here.
mkdirSync(process.env.CEZ_HOME, { recursive: true });
writeFileSync(join(process.env.CEZ_HOME, 'stub.json'), JSON.stringify({ args, env: process.env, child: child.pid }));
const projects = mode === 'unregistered' ? [] : [{ id: 'qa-repo', root: repo }];
const server = createServer((req, res) => {
  if (req.url === '/exit') { res.end(); process.exit(0); }
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ projects, bootProject: 'qa-repo', projectsDir: '' }));
});
server.listen(0, '127.0.0.1', () => console.log('\\n  cockpit → http://127.0.0.1:' + server.address().port + '\\n'));
process.on('SIGTERM', () => process.exit(0));
`;

function stubBuild(out, logPath) {
  mkdirSync(join(out, 'dist'), { recursive: true });
  writeFileSync(join(out, 'package.json'), '{"type":"module"}\n');
  writeFileSync(join(out, 'dist/index.js'), STUB_SERVER);
  writeFileSync(logPath, 'stub build\n');
}

function sink() {
  let text = '';
  return { write: (chunk) => { text += chunk; return true; }, get text() { return text; } };
}

/** A stand-in task worktree (where the descriptor lives) and a private temp directory. */
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'cez-qa-fixture-test-'));
  const worktree = join(dir, 'worktree');
  const tmp = join(dir, 'tmp');
  mkdirSync(worktree);
  mkdirSync(tmp);
  const stdout = sink();
  const stderr = sink();
  const options = (extra = {}) => ({ repoRoot: worktree, tmp, build: stubBuild, stdout, stderr, watchIntervalMs: 60_000, ...extra });
  t.after(async () => {
    await down(options({ stdout: sink() }));
    rmSync(dir, { recursive: true, force: true });
  });
  return { worktree, tmp, stdout, stderr, options };
}

function values(text) {
  return Object.fromEntries(text.trim().split('\n').filter((line) => line.startsWith('QA_FIXTURE_')).map((line) => {
    const at = line.indexOf('=');
    return [line.slice(0, at), line.slice(at + 1)];
  }));
}

const descriptorPath = (worktree) => join(worktree, '.ai/qa/qa-fixture.json');
const descriptor = (worktree) => JSON.parse(readFileSync(descriptorPath(worktree), 'utf8'));

function alive(pid) {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  // A zombie still answers signal 0 until its parent reaps it.
  if (process.platform !== 'linux') return true;
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  return !/^[ZX]$/.test(stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/)[0]);
}

async function until(predicate, what) {
  // bound: hang guard only; the watcher under test polls every 100 ms.
  const deadline = performance.now() + 20_000;
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await delay(50);
  }
}

test('up serves a registered project and down leaves no process or directory behind', async (t) => {
  const f = fixture(t);
  const ambient = { ...process.env, CEZ_AMBIENT: 'leak', GIT_DIR: '/nowhere' };
  await up(f.options({ args: ['--server-env=CEZ_STUB_MODE=serve'], env: ambient }));

  const out = values(f.stdout.text);
  assert.equal(out.QA_FIXTURE_STATUS, 'running');
  assert.match(out.QA_FIXTURE_BASE_URL, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(out.QA_FIXTURE_PROJECT_ID, 'qa-repo');
  assert.equal(out.QA_FIXTURE_PROJECT_URL, `${out.QA_FIXTURE_BASE_URL}/p/qa-repo`);
  assert.equal(out.QA_FIXTURE_STOP, 'node .ai/scripts/qa-fixture.mjs down');
  const projects = await (await fetch(`${out.QA_FIXTURE_BASE_URL}/api/v1/projects`)).json();
  assert.equal(projects.projects[0].root, realpathSync(out.QA_FIXTURE_REPO));

  const fixtureDescriptor = descriptor(f.worktree);
  const root = fixtureDescriptor.root;
  assert.equal(out.QA_FIXTURE_REPO, join(root, 'repo'));
  assert.equal(execFileSync('git', ['-C', out.QA_FIXTURE_REPO, 'rev-list', '--count', 'HEAD'], { encoding: 'utf8' }).trim(), '1');

  const stub = JSON.parse(readFileSync(join(root, 'home/stub.json'), 'utf8'));
  assert.deepEqual(stub.args, ['serve', '--repo', join(root, 'repo'), '--port', '0', '--no-open']);
  assert.equal(stub.env.CEZ_DRY_RUN, '1');
  assert.equal(stub.env.CEZ_HOME, join(root, 'home'));
  assert.equal(stub.env.CEZ_STUB_MODE, 'serve');
  assert.equal(stub.env.CEZ_AMBIENT, undefined, 'an ambient CEZ_* reached the server');
  assert.equal(stub.env.GIT_DIR, undefined, 'an ambient GIT_* reached the server');
  assert.equal(stub.env.GIT_CONFIG_GLOBAL, join(root, 'gitconfig'));

  const pids = [fixtureDescriptor.server.pid, fixtureDescriptor.watcher.pid, stub.child];
  assert.deepEqual(pids.map(alive), [true, true, true]);

  const stopped = sink();
  await down(f.options({ stdout: stopped }));
  assert.equal(values(stopped.text).QA_FIXTURE_STATUS, 'stopped');
  // The group child gets the same SIGTERM; the kernel may need a moment to finish it.
  await until(() => !alive(stub.child), 'the server group to exit');
  assert.deepEqual(pids.map(alive), [false, false, false]);
  assert.equal(existsSync(root), false, 'the temporary root survived down');
  assert.equal(existsSync(descriptorPath(f.worktree)), false, 'the descriptor survived down');

  const again = sink();
  await down(f.options({ stdout: again }));
  assert.equal(values(again.text).QA_FIXTURE_STATUS, 'stopped');
  assert.deepEqual(readdirSync(f.tmp), []);
});

test('up replaces a fixture that is already running', async (t) => {
  const f = fixture(t);
  await up(f.options());
  const first = descriptor(f.worktree);
  await up(f.options({ stdout: sink() }));
  const second = descriptor(f.worktree);

  assert.notEqual(second.root, first.root);
  assert.equal(alive(first.server.pid), false, 'the first server survived the second up');
  assert.equal(alive(first.watcher.pid), false, 'the first watcher survived the second up');
  assert.equal(existsSync(first.root), false, 'the first temporary root survived the second up');
  assert.equal(alive(second.server.pid), true);
  assert.deepEqual(readdirSync(f.tmp), [basename(second.root)]);
});

test('a server that exits during boot fails up and leaves nothing behind', async (t) => {
  const f = fixture(t);
  await assert.rejects(up(f.options({ args: ['--server-env=CEZ_STUB_MODE=exit'] })), /exited during boot/);
  assert.deepEqual(readdirSync(f.tmp), []);
  assert.equal(existsSync(descriptorPath(f.worktree)), false);
  assert.equal(f.stdout.text, '');
});

test('a project the server did not register fails up with the TMPDIR hint', async (t) => {
  const f = fixture(t);
  await assert.rejects(up(f.options({ args: ['--server-env=CEZ_STUB_MODE=unregistered'] })), /not registered.*TMPDIR/s);
  assert.deepEqual(readdirSync(f.tmp), []);
  assert.equal(existsSync(descriptorPath(f.worktree)), false);
});

test('a failed build fails up with the end of its log and leaves nothing behind', async (t) => {
  const f = fixture(t);
  const failing = (out, logPath) => {
    writeFileSync(logPath, 'tsc: error TS2307\n');
    throw new Error(`build failed (${logPath})`);
  };
  await assert.rejects(up(f.options({ build: failing })), /build failed/);
  assert.match(f.stderr.text, /tsc: error TS2307/);
  assert.deepEqual(readdirSync(f.tmp), []);
});

test('the watcher stops the server once its descriptor is gone', async (t) => {
  const f = fixture(t);
  await up(f.options({ watchIntervalMs: 100 }));
  const { root, server, watcher } = descriptor(f.worktree);
  // What deleting the task worktree, or its .ai/qa, does to the only handle down has.
  rmSync(join(f.worktree, '.ai'), { recursive: true, force: true });
  await until(() => !alive(server.pid) && !existsSync(root) && !alive(watcher.pid), 'the watcher to stop the fixture');
});

test('the watcher removes the temporary root and descriptor of a server that exited on its own', async (t) => {
  const f = fixture(t);
  await up(f.options({ watchIntervalMs: 100 }));
  const { root, watcher } = descriptor(f.worktree);
  await fetch(`${values(f.stdout.text).QA_FIXTURE_BASE_URL}/exit`).catch(() => {});
  await until(() => !existsSync(root) && !existsSync(descriptorPath(f.worktree)) && !alive(watcher.pid), 'the watcher to clean up');
});

test('the watcher stops the server once its temporary root is gone', async (t) => {
  const f = fixture(t);
  await up(f.options({ watchIntervalMs: 100 }));
  const { root, server } = descriptor(f.worktree);
  rmSync(root, { recursive: true, force: true });
  await until(() => !alive(server.pid) && !existsSync(descriptorPath(f.worktree)), 'the watcher to stop the server');
});

test('up refuses a bad flag before it creates anything', async (t) => {
  const f = fixture(t);
  for (const [args, message] of [
    [['--force'], /unknown flag: --force/],
    [['--server-env=FOO=1'], /invalid --server-env: FOO=1/],
    [['--server-env=CEZ_HOME=/x'], /CEZ_DRY_RUN and CEZ_HOME are pinned/],
    [['--server-env=CEZ_DRY_RUN=0'], /CEZ_DRY_RUN and CEZ_HOME are pinned/],
    [['--server-env=CEZ_X=a b'], /no whitespace/],
    [['--server-env=CEZ_X=1', '--server-env=CEZ_X=2'], /CEZ_X is given twice/],
  ]) {
    await assert.rejects(up(f.options({ args })), message);
  }
  assert.deepEqual(readdirSync(f.tmp), []);
  assert.deepEqual(parseUpArgs(['--server-env=CEZ_AUTOMATIONS=1', '--server-env=CEZ_PREVIEW=']), { CEZ_AUTOMATIONS: '1', CEZ_PREVIEW: '' });
});
