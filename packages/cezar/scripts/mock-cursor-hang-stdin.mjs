#!/usr/bin/env node
// #529 review: initialize, then close stdin and stay alive so bootstrap cannot hang.
import { createInterface } from 'node:readline';
import { closeSync } from 'node:fs';
const emit = value => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...value })}\n`);
const rl = createInterface({ input: process.stdin });
rl.on('line', line => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === 'initialize') {
    emit({ id: msg.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
    // Drop readline's hold on stdin before closing fd 0. closeSync(0) while readline still
    // owns the stream can throw EBADF and get swallowed, leaving the parent's write end
    // writable so session/new buffers and the hang test waits out 15s (#587).
    rl.close();
    try { closeSync(0); } catch { /* already closed */ }
  }
});
process.on('SIGTERM', () => { /* ignore — review: SIGTERM-only abort must not hang */ });
setInterval(() => {}, 1e6);
