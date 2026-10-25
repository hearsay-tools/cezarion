import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';

import { down, parseUpArgs, up } from '../.ai/scripts/qa-fixture.mjs';
import { identity } from '../.ai/scripts/test-env-lease.mjs';

// A stand-in for the e2e build: `dist/index.js` answers like `cezar serve` does for the checks
// qa-fixture makes. It records its argv and environment, and keeps a child in its own process
// group, so a test can see what reached the server and that `down` stops the whole group.
// CEZ_STUB_MODE (passed through --server-env) picks a failure, or `hang`, a boot that never
// prints its banner; CEZ_STUB_CHILD=stubborn makes
// the child ignore SIGTERM, and CEZ_STUB_CHILD=zombie makes it leave the group without reaping
// the process it forked, which then stays in the group as a zombie.
const STUB_SERVER = `
import { spawn } from 'node:child_process';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
const args = process.argv.slice(2);
const repo = realpathSync(args[args.indexOf('--repo') + 1]);
const mode = process.env.CEZ_STUB_MODE ?? 'serve';
if (mode === 'exit') process.exit(3);
const childScript = (process.env.CEZ_STUB_CHILD === 'stubborn' ? 'process.on("SIGTERM", () => {}); ' : '') + 'setInterval(() => {}, 1000)';
const child = process.env.CEZ_STUB_CHILD === 'zombie'
  ? spawn('sh', ['-c', 'true & exec setsid sleep 1000'], { stdio: 'ignore' })
  : spawn(process.execPath, ['-e', childScript], { stdio: 'ignore' });
// cezar creates its home on first write, as here.
mkdirSync(process.env.CEZ_HOME, { recursive: true });
writeFileSync(join(process.env.CEZ_HOME, 'stub.json'), JSON.stringify({ args, env: process.env, child: child.pid }));
const projects = mode === 'unregistered' ? [] : [{ id: 'qa-repo', root: repo }];
const server = createServer((req, res) => {
  if (req.url === '/exit') { res.end(); process.exit(0); }
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ projects, bootProject: 'qa-repo', projectsDir: '' }));
});
if (mode === 'hang') setInterval(() => {}, 1000);
else server.listen(0, '127.0.0.1', () => console.log('\\n  cockpit → http://127.0.0.1:' + server.address().port + '\\n'));
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

const stubStarted = (tmp) => readdirSync(tmp).some((entry) => existsSync(join(tmp, entry, 'home/stub.json')));

/** A stand-in for the process that runs `node qa-fixture.mjs up`, which exits once up returns.
 *  up runs in this test process, so a test kills the stand-in instead. */
async function upProcess(t) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  await new Promise((done) => child.once('spawn', done));
  t.after(() => child.kill('SIGKILL'));
  return { exit: () => child.kill('SIGKILL'), identity: { pid: child.pid, start: identity(child.pid).start } };
}

function groupAlive(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

function waitSync(predicate, what) {
  // bound: hang guard only; the stub server starts in well under a second.
  const deadline = performance.now() + 20_000;
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    Atomics.wait(sleeper, 0, 0, 50);
  }
}

// up starts the server first and the watcher second; `call` picks whose start identity reads empty.
for (const [which, call] of [['server', 1], ['watcher', 2]]) {
  test(`up stops the ${which} when it cannot read the ${which}'s start identity`, async (t) => {
    const f = fixture(t);
    const started = [];
    const readIdentity = (pid) => {
      started.push(pid);
      if (started.length !== call) return identity(pid);
      // Read once the stub has started its own child, so that only a stop of the whole group
      // ends it. Earlier, up's cleanup deletes the script before node loads it.
      if (which === 'server') waitSync(() => stubStarted(f.tmp), 'the stub server to start');
      return {};
    };
    // Only a failing run leaves a group behind; the descriptor that down would read is gone.
    t.after(() => started.filter(groupAlive).forEach((pid) => process.kill(-pid, 'SIGKILL')));
    await assert.rejects(up(f.options({ readIdentity })), /cannot read the start identity/);
    await until(() => !started.some(groupAlive), `the ${which}'s process group to exit`);
    assert.deepEqual(readdirSync(f.tmp), []);
    assert.equal(existsSync(descriptorPath(f.worktree)), false);
  });
}

test('the watcher stops the server once its descriptor is gone', async (t) => {
  const f = fixture(t);
  const starter = await upProcess(t);
  await up(f.options({ watchIntervalMs: 100, starter: starter.identity }));
  starter.exit();
  const { root, server, watcher } = descriptor(f.worktree);
  // What deleting the task worktree, or its .ai/qa, does to the only handle down has.
  rmSync(join(f.worktree, '.ai'), { recursive: true, force: true });
  await until(() => !alive(server.pid) && !existsSync(root) && !alive(watcher.pid), 'the watcher to stop the fixture');
});

test('the watcher stops what is left of a server that exited on its own, then cleans up', async (t) => {
  const f = fixture(t);
  const starter = await upProcess(t);
  await up(f.options({ watchIntervalMs: 100, starter: starter.identity }));
  starter.exit();
  const { root, watcher } = descriptor(f.worktree);
  const { child } = JSON.parse(readFileSync(join(root, 'home/stub.json'), 'utf8'));
  await fetch(`${values(f.stdout.text).QA_FIXTURE_BASE_URL}/exit`).catch(() => {});
  await until(() => !alive(child) && !existsSync(root) && !existsSync(descriptorPath(f.worktree)) && !alive(watcher.pid), 'the watcher to clean up');
});

test('down kills a group member that outlives the server and ignores SIGTERM', async (t) => {
  const f = fixture(t);
  await up(f.options({ args: ['--server-env=CEZ_STUB_CHILD=stubborn'] }));
  const { root, server } = descriptor(f.worktree);
  const { child } = JSON.parse(readFileSync(join(root, 'home/stub.json'), 'utf8'));
  await down(f.options({ stdout: sink(), stopGraceMs: 300 }));
  // SIGKILL is asynchronous; the kernel may need a moment to finish the child.
  await until(() => !alive(child), 'the stubborn child to exit');
  assert.equal(alive(server.pid), false);
  assert.equal(existsSync(root), false);
});

/** The state and process group of a process, from /proc (Linux only). */
function stat(pid) {
  try {
    const text = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = text.slice(text.lastIndexOf(')') + 1).trim().split(/\s+/);
    return { state: fields[0], pgid: Number(fields[2]) };
  } catch {
    return undefined;
  }
}

const groupStates = (pgid) => readdirSync('/proc').filter((name) => /^\d+$/.test(name))
  .map(stat).filter((entry) => entry?.pgid === pgid).map((entry) => entry.state);

test('down treats a process group of zombies only as stopped, while other processes start and exit', { skip: process.platform !== 'linux' && 'reads /proc' }, async (t) => {
  const f = fixture(t);
  await up(f.options({ args: ['--server-env=CEZ_STUB_CHILD=zombie'] }));
  const { root, server } = descriptor(f.worktree);
  const stub = JSON.parse(readFileSync(join(root, 'home/stub.json'), 'utf8'));
  // A busy host: the process list changes while down scans it (CI run 40158867000 attempt 1,
  // job 121065993069). Without this churn the scans of a quiet host hide the race.
  const churn = spawn('sh', ['-c', 'while :; do /bin/true; done'], { stdio: 'ignore' });
  try {
    await until(() => stat(stub.child)?.pgid !== server.pid && groupStates(server.pid).includes('Z'), 'a zombie left in the server group');
    await down(f.options({ stdout: sink(), stopGraceMs: 300 }));
  } finally {
    churn.kill('SIGKILL');
    // The sleeper left the group, so nothing else stops it; once it exits, its zombie is reaped.
    try { process.kill(stub.child, 'SIGKILL'); } catch { /* already gone */ }
  }
  assert.deepEqual(groupStates(server.pid).filter((state) => state !== 'Z'), []);
  assert.equal(existsSync(root), false, 'the temporary root survived down');
  assert.equal(existsSync(descriptorPath(f.worktree)), false, 'the descriptor survived down');
});

test('the watcher stops the server once its temporary root is gone', async (t) => {
  const f = fixture(t);
  const starter = await upProcess(t);
  await up(f.options({ watchIntervalMs: 100, starter: starter.identity }));
  starter.exit();
  const { root, server } = descriptor(f.worktree);
  rmSync(root, { recursive: true, force: true });
  await until(() => !alive(server.pid) && !existsSync(descriptorPath(f.worktree)), 'the watcher to stop the server');
});

test('the watcher stops the server when up is interrupted during boot', async (t) => {
  const f = fixture(t);
  const starter = await upProcess(t);
  const started = [];
  const readIdentity = (pid) => {
    started.push(pid);
    return identity(pid);
  };
  // Only a failing run leaves a group behind: nothing names it once up's process is gone.
  t.after(() => started.filter(groupAlive).forEach((pid) => process.kill(-pid, 'SIGKILL')));
  const booting = up(f.options({ args: ['--server-env=CEZ_STUB_MODE=hang'], starter: starter.identity, readIdentity, watchIntervalMs: 100, bootTimeoutMs: 120_000 }));
  const failed = assert.rejects(booting);
  await until(() => stubStarted(f.tmp), 'the stub server to start');
  // What Ctrl-C or a SIGKILL does to up's process: none of its cleanup runs.
  starter.exit();
  await until(() => !groupAlive(started[0]), 'the watcher to stop the server');
  await failed;
  await until(() => !started.some(groupAlive), 'the watcher to exit');
  assert.deepEqual(readdirSync(f.tmp), []);
  assert.equal(existsSync(descriptorPath(f.worktree)), false);
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

test('down acts on no descriptor that the temporary root it names does not confirm', async (t) => {
  const f = fixture(t);
  // A process group this script never started, with its real start identity.
  const foreign = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
  foreign.unref();
  t.after(() => { try { process.kill(-foreign.pid, 'SIGKILL'); } catch { /* already gone */ } });
  await until(() => identity(foreign.pid).start !== undefined, 'the foreign process to start');
  const foreignIdentity = { pid: foreign.pid, start: identity(foreign.pid).start };
  const bareRoot = mkdtempSync(join(f.tmp, 'cez-qa-fixture-'));
  const rootWithOtherOwner = mkdtempSync(join(f.tmp, 'cez-qa-fixture-'));
  writeFileSync(join(rootWithOtherOwner, 'owner.json'), JSON.stringify({ repoRoot: '/elsewhere', server: foreignIdentity }));

  for (const crafted of [
    { root: bareRoot, server: foreignIdentity },
    { root: rootWithOtherOwner, server: foreignIdentity },
    { root: bareRoot, server: { pid: 0, start: 'x' } },
    { root: '/', server: foreignIdentity },
  ]) {
    mkdirSync(join(f.worktree, '.ai/qa'), { recursive: true });
    writeFileSync(descriptorPath(f.worktree), JSON.stringify(crafted));
    const stopped = sink();
    await down(f.options({ stdout: stopped, stopGraceMs: 300 }));
    assert.equal(values(stopped.text).QA_FIXTURE_STATUS, 'stopped');
    assert.equal(existsSync(descriptorPath(f.worktree)), false, 'an unconfirmed descriptor stayed behind');
  }
  assert.equal(alive(foreign.pid), true, 'down signalled a process group it never started');
  assert.equal(existsSync(bareRoot), true, 'down deleted a directory no fixture owns');
  assert.equal(existsSync(rootWithOtherOwner), true, 'down deleted a directory another worktree owns');
  assert.match(f.stderr.text, /does not confirm/);
});
