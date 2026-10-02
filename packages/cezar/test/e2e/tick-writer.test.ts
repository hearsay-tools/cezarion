import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import test from 'node:test';
import { tickWriterSource } from './tick-writer.js';
import { runTickWriterFixture } from './tick-writer-fixture.js';

test('a tick stays numeric when its writer is killed between truncation and content write', { timeout: 5000 }, async t => {
  let pid = 0;
  const finalTick = await runTickWriterFixture(path => `
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
`, t.signal, child => { pid = child.pid!; });
  assert.throws(() => process.kill(pid, 0), 'writer is reaped before reading ticks');
  assert.match(finalTick, /^\d+$/, 'last committed tick survives interrupted write');
  assert.equal(finalTick, '1');
});

test('cancelling a missing tick observation reaps its child and removes its fixture', { timeout: 5000 }, async () => {
  const controller = new AbortController();
  let child: ChildProcess | undefined;
  let root = '';
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const fixture = runTickWriterFixture(() => `process.on('message', () => {});`, controller.signal,
    (spawned, directory) => {
      child = spawned; root = directory;
      controller.abort(new Error('observation cancelled'));
    });
  try {
    // e2e-wait: process-deadline — fail if cancellation cannot settle fixture cleanup
    const overdue = new Promise<never>((_, reject) => { deadline = setTimeout(() => reject(new Error('cancellation did not settle')), 1000); });
    await assert.rejects(Promise.race([fixture, overdue]), /observation cancelled/);
    assert.ok(child?.pid);
    const pid = child!.pid!;
    assert.throws(() => process.kill(pid, 0), 'cancelled writer is reaped');
    assert.equal(existsSync(root), false, 'cancelled fixture directory is removed');
  } finally {
    clearTimeout(deadline);
    let rescueDeadline: ReturnType<typeof setTimeout> | undefined;
    try {
      // Independent rescue keeps a deliberately broken implementation from leaking in the red run.
      if (child && child.exitCode === null && child.signalCode === null) {
        const closed = once(child, 'close', { signal: AbortSignal.timeout(1000) });
        child.kill('SIGKILL');
        await closed;
      }
      // e2e-wait: process-deadline — bound rescue settlement when verifying a broken fixture
      const overdue = new Promise<never>((_, reject) => { rescueDeadline = setTimeout(() => reject(new Error('fixture rescue did not settle')), 1000); });
      await Promise.race([fixture.catch(() => {}), overdue]);
    } finally {
      clearTimeout(rescueDeadline);
      if (root) await rm(root, { recursive: true, force: true });
    }
  }
});
