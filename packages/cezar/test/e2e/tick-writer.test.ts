import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { tickWriterSource } from './tick-writer.js';

test('a tick stays numeric when its writer is killed between truncation and content write', { timeout: 5000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'cez-tick-write-'));
  const path = join(root, 'ticks');
  const child = spawn(process.execPath, ['--eval', `
const fs = require('node:fs');
${tickWriterSource(path)}
writeTick(1);
const originalWrite = fs.writeFileSync;
fs.writeFileSync = (path, value) => {
  // Pause at the real truncation/content seam, with no elapsed-time assumption.
  originalWrite(path, '');
  process.send({ truncated: true });
  while (true) {} // parent kills this writer upon the IPC observation
};
writeTick(2);
`], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  const closed = new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', () => resolve());
  });
  try {
    await new Promise<void>((resolve, reject) => {
      child.once('message', () => resolve());
      child.once('error', reject);
      child.once('exit', () => reject(new Error('writer exited before truncating')));
    });
    child.kill('SIGKILL');
    await closed;
    assert.throws(() => process.kill(child.pid!, 0), 'writer is reaped before reading ticks');
    assert.match(await readFile(path, 'utf8'), /^\d+$/, 'last committed tick survives interrupted write');
    assert.equal(await readFile(path, 'utf8'), '1');
  } finally {
    child.kill('SIGKILL');
    await closed;
    await rm(root, { recursive: true, force: true });
  }
});
