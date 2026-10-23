// Isolate built-in probe instrumentation from the test runner and its observer.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const { acquireTestEnvLease } = await import(pathToFileURL(process.argv[2]).href);
const root = fs.mkdtempSync(join(tmpdir(), 'cez-diagnostic-snapshot-'));
const read = fs.readSync;
const spawn = childProcess.spawnSync;
let lease;
let commands = 0;
try {
  lease = await acquireTestEnvLease(root);
  fs.readSync = (...args) => { commands++; return read(...args); };
  childProcess.spawnSync = (file, args, options) => {
    if (args.includes('command=') || args.includes('command')) commands++;
    return spawn(file, args, options);
  };
  syncBuiltinESMExports();
  await assert.rejects(acquireTestEnvLease(root, { timeoutMs: 10_000, onWait: () => {
    // End the remaining time without changing the holder or querying its process.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10_100);
  } }), /timed out/);
  assert.equal(commands, 1, 'timeout must reuse the initial command snapshot');
} finally {
  fs.readSync = read;
  childProcess.spawnSync = spawn;
  syncBuiltinESMExports();
  lease?.release();
  fs.rmSync(root, { recursive: true, force: true });
}
