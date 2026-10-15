import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';
import { stopChild } from './stop-child.js';

test('stops a child that handles SIGTERM', async () => {
  const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => process.exit(0)); process.send('ready'); setInterval(() => {}, 1000);"],
    { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  try {
    await once(child, 'message');
    await stopChild(child, 'graceful fixture', 1_000);
    assert.equal(child.exitCode, 0);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
});

// hearsay-tools/cezarion#980: a cockpit's shutdown blocks its main thread on the runs.db close
// checkpoint's fsync; under load that measured past the old 3 s bound. A handler that blocks the
// same way for 3.5 s, then exits, is a graceful stop under the default bound, not a SIGKILL.
test('the default bound lets a shutdown that blocks on synchronous disk work finish', async () => {
  const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3500); process.exit(0); }); process.send('ready'); setInterval(() => {}, 1000);"],
    { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  try {
    await once(child, 'message');
    await stopChild(child, 'slow-closing fixture');
    assert.equal(child.exitCode, 0);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
});

test('kills and names a child that ignores SIGTERM', async () => {
  const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); process.send('ready'); setInterval(() => {}, 1000);"],
    { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  try {
    await once(child, 'message');
    const exited = once(child, 'exit');
    await assert.rejects(stopChild(child, 'stubborn fixture', 50), /stubborn fixture.*SIGTERM/);
    await exited;
    assert.equal(child.signalCode, 'SIGKILL');
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
});

test('returns when a child already exited from a signal', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  child.kill('SIGKILL');
  await once(child, 'exit');
  await stopChild(child, 'exited fixture', 50);
});
