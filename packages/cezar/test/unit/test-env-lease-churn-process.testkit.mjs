// Linux-only isolated process fixture. Optional argv[2] selects source for proof runs.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

const source = process.argv[2] ?? resolve(import.meta.dirname, '../../../../.ai/scripts/test-env-lease.mjs');
const root = fs.mkdtempSync(join(tmpdir(), 'cez-lease-churn-'));
// Expose the private probe in a disposable copy, without adding a production API
// or changing its body. All process state below comes from real /proc stat files.
// The copy keeps the lease's place in a checkout, so its import of the process-group helper resolves.
const copy = join(root, '.ai/scripts/lease.mjs');
fs.mkdirSync(join(root, '.ai/scripts'), { recursive: true });
fs.mkdirSync(join(root, 'packages/cezar/src'), { recursive: true });
fs.copyFileSync(resolve(import.meta.dirname, '../../src/detached-process.ts'), join(root, 'packages/cezar/src/detached-process.ts'));
fs.writeFileSync(join(root, 'packages/cezar/src/package.json'), '{"type":"module"}\n');
fs.writeFileSync(copy, fs.readFileSync(source, 'utf8') + '\nexport { groupLive };\n');
const { acquireTestEnvLease, groupLive } = await import(pathToFileURL(copy).href);
const originalReadDir = fs.readdirSync;
const churn = [];
let owner;
let replacement;
let member;

function stat(pid) {
  const text = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
  return text.slice(text.lastIndexOf(')') + 1).trim().split(/\s+/);
}

async function until(predicate, message) {
  // bound: fixture setup/cleanup only; no production latency guarantee.
  const deadline = performance.now() + 5000;
  while (!predicate()) {
    assert.ok(performance.now() < deadline, message);
    await delay(10);
  }
}

// Node normally reaps children. Stop the parent before killing its detached
// child, so the child stays a zombie in its own group until cleanup resumes it.
const parent = spawn(process.execPath, ['--input-type=module', '-e', `
  import { spawn } from 'node:child_process';
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    detached: true, stdio: 'ignore',
  });
  child.once('spawn', () => console.log(child.pid));
  child.once('exit', () => console.log('reaped'));
  process.stdin.resume();
  process.stdin.once('end', () => process.exit(0));
`], { stdio: ['pipe', 'pipe', 'inherit'] });
const parentExit = once(parent, 'exit');

try {
  member = Number(String((await once(parent.stdout, 'data'))[0]).trim());
  assert.ok(Number.isSafeInteger(member) && member > 1, 'child must publish its PID');
  owner = await acquireTestEnvLease(root, { pid: member, group: true });
  process.kill(parent.pid, 'SIGSTOP');
  await until(() => stat(parent.pid)[0] === 'T', 'parent must stop before child exits');
  process.kill(member, 'SIGKILL');
  await until(() => stat(member)[0] === 'Z', 'child must become a zombie');
  assert.equal(Number(stat(member)[2]), member, 'zombie must stay in its own group');

  for (let i = 0; i < 2; i++) {
    churn.push(spawn('sh', ['-c', 'while :; do /bin/true; done'], { detached: true, stdio: 'ignore' }));
  }
  await Promise.all(churn.map(child => once(child, 'spawn')));
  const answers = { dead: 0, unknown: 0 };
  for (let i = 0; i < 30; i++) {
    const live = groupLive(member);
    assert.ok(live === false || live === undefined, 'zombie-only group must never answer live');
    answers[live === false ? 'dead' : 'unknown']++;
  }
  // Churn is real, but its overlap with a scan is not a portable timing contract.
  // Force changed/stable enumeration separately; do not require an unknown ratio.
  let reads = 0;
  fs.readdirSync = function (path, ...args) {
    if (path !== '/proc') return originalReadDir(path, ...args);
    return ++reads % 2 ? [String(member)] : [String(member), String(process.pid)];
  };
  syncBuiltinESMExports();
  assert.equal(groupLive(member), undefined, 'changed PID listing must answer unknown');
  const db = new DatabaseSync(join(root, '.ai/qa/test-env-lease.sqlite'));
  try {
    const before = db.prepare('SELECT * FROM holders').all();
    assert.equal(before.length, 1);
    await assert.rejects(acquireTestEnvLease(root, {
      timeoutMs: 150,
      onWait() {
        assert.deepEqual(db.prepare('SELECT * FROM holders').all(), before,
          'unknown visibility must retain the committed holder before waiting');
      },
    }), /timed out.*active environment was left unchanged/);
    assert.deepEqual(db.prepare('SELECT * FROM holders').all(), before,
      'timeout must not delete the committed zombie holder');

    fs.readdirSync = function (path, ...args) {
      return path === '/proc' ? [String(member)] : originalReadDir(path, ...args);
    };
    syncBuiltinESMExports();
    assert.equal(groupLive(member), false, 'stable readable zombie-only snapshot proves death');
    replacement = await acquireTestEnvLease(root, { timeoutMs: 150 });
    assert.notEqual(replacement.token, owner.token);
    const after = db.prepare('SELECT * FROM holders').all();
    assert.equal(after.length, 1);
    assert.equal(after[0].token, replacement.token, 'replacement row must already be committed');
    owner.release();
    assert.deepEqual(db.prepare('SELECT * FROM holders').all(), after,
      'old owner release must not remove its replacement');
    await assert.rejects(acquireTestEnvLease(root, { token: owner.token }), /invalid inherited/);
  } finally { db.close(); }
  console.log(JSON.stringify({ samples: answers, unknownRetained: true, stableReclaimed: true }));
} finally {
  fs.readdirSync = originalReadDir;
  syncBuiltinESMExports();
  replacement?.release();
  owner?.release();
  await Promise.all(churn.map(async child => {
    const exited = once(child, 'exit');
    try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    await exited;
  }));
  if (member) {
    try { process.kill(-member, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  process.kill(parent.pid, 'SIGCONT');
  // Resume lets Node reap its child before the parent exits; never orphan zombies.
  if (member) await until(() => !fs.existsSync(`/proc/${member}/stat`), 'parent must reap its child');
  parent.stdin.end();
  await parentExit;
  fs.rmSync(root, { recursive: true, force: true });
}
