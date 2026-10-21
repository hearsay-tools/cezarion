// Test-only scheduling probe. No repository files are changed.
// Usage: node <this-file> [absolute-path-to-test-env-lease.mjs]
// Exit 0: protected; exit 1: reproduced unsafe acquisition.
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

const helper = process.argv[2];
const { acquireTestEnvLease } = await import(pathToFileURL(helper).href);
const root = fs.mkdtempSync(join(tmpdir(), 'lease-group-review-'));
const script = join(root, 'member.mjs');
fs.writeFileSync(script, `
  import fs from 'node:fs';
  import { spawn } from 'node:child_process';
  const root = process.argv[3];
  const role = process.argv[2];
  if (role === 'leader') {
    spawn(process.execPath, [process.argv[1], 'worker', root], { stdio: 'ignore' });
    setInterval(() => {}, 1000);
  } else if (role === 'worker') {
    fs.writeFileSync(root + '/worker', String(process.pid));
    const timer = setInterval(() => {
      if (!fs.existsSync(root + '/go')) return;
      clearInterval(timer);
      const child = spawn(process.execPath, [process.argv[1], 'successor', root], { stdio: 'ignore' });
      child.once('spawn', () => process.exit(0));
    }, 5);
  } else {
    fs.writeFileSync(root + '/successor', String(process.pid));
    setInterval(() => {}, 1000);
  }
`);
const leader = spawn(process.execPath, [script, 'leader', root], { detached: true, stdio: 'ignore' });
const original = fs.readdirSync;
let lease;
let next;
try {
  const readyDeadline = Date.now() + 5000;
  while (!fs.existsSync(join(root, 'worker'))) {
    if (Date.now() > readyDeadline) throw new Error('startup timeout');
    await delay(10);
  }
  lease = await acquireTestEnvLease(root, { pid: leader.pid, group: true });
  const exited = once(leader, 'exit');
  leader.kill('SIGKILL');
  await exited;

  // Capture the REAL PID list, then schedule a REAL same-group fork and exit
  // before the helper reads any listed /proc/<pid>/stat. No stat data is forged.
  let intercepted = false;
  fs.readdirSync = function (path, ...args) {
    const snapshot = original(path, ...args);
    if (path === '/proc' && !intercepted) {
      intercepted = true;
      fs.writeFileSync(join(root, 'go'), 'go');
      const deadline = Date.now() + 3000;
      while (!fs.existsSync(join(root, 'successor')) && Date.now() < deadline) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      }
      if (!fs.existsSync(join(root, 'successor'))) throw new Error('handoff timeout');
    }
    return snapshot;
  };
  syncBuiltinESMExports();
  let blocked = false;
  try {
    next = await acquireTestEnvLease(root, { timeoutMs: 150 });
  } catch (error) {
    if (!/timed out/.test(error.message)) throw error;
    blocked = true;
  }
  const successor = fs.readFileSync(join(root, 'successor'), 'utf8').trim();
  if (!/^\d+$/.test(successor) || !fs.existsSync(`/proc/${successor}/stat`)) throw new Error('successor must remain alive');
  console.log(JSON.stringify({ interceptedProcSnapshot: intercepted, successorStillAlive: true, unrelatedLeaseGranted: !blocked }));
  if (!blocked) process.exitCode = 1;
} finally {
  fs.readdirSync = original;
  syncBuiltinESMExports();
  next?.release();
  lease?.release();
  try { process.kill(-leader.pid, 'SIGKILL'); } catch {}
  fs.rmSync(root, { recursive: true, force: true });
}
