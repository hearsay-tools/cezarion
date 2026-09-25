import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

// Observe the real fixture at its stdout boundary, before a fast parent could
// send session/new. Sampling fd 0 after reading stdout would itself be a race.
test('Cursor hang fixture closes stdin before publishing its initialize response', () => {
  const fixture = new URL('../../scripts/mock-cursor-hang-stdin.mjs', import.meta.url).href;
  const probe = `
    import { fstatSync } from 'node:fs';
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = chunk => {
      const response = JSON.parse(String(chunk));
      let stdinClosed = false;
      try { fstatSync(0); } catch (error) {
        if (error.code !== 'EBADF') throw error;
        stdinClosed = true;
      }
      return write(JSON.stringify({ response, stdinClosed }), () => process.exit(0));
    };
    await import(${JSON.stringify(fixture)});
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '--eval', probe], {
    input: `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1 } })}\n`,
    encoding: 'utf8', timeout: 5_000, killSignal: 'SIGKILL',
  });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, child.stderr);
  const observed = JSON.parse(child.stdout);
  assert.equal(observed.response.id, 1);
  assert.equal(observed.response.result.protocolVersion, 1);
  assert.equal(observed.stdinClosed, true, 'a fast parent must not send session/new into an open input pipe');
});
