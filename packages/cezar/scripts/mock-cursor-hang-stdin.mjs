#!/usr/bin/env node
// #529 review: initialize, then close stdin and stay alive so bootstrap cannot hang.
import { createInterface } from 'node:readline';
import { closeSync } from 'node:fs';
const emit = value => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...value })}\n`);
createInterface({ input: process.stdin }).on('line', line => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === 'initialize') {
    // Close before replying: a fast parent sends session/new as soon as it
    // reads initialize, and that write must encounter the dead input pipe.
    try { closeSync(0); } catch { /* already closed */ }
    emit({ id: msg.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
  }
});
process.on('SIGTERM', () => { /* ignore — review: SIGTERM-only abort must not hang */ });
setInterval(() => {}, 1e6);
