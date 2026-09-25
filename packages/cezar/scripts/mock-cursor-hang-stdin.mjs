#!/usr/bin/env node
// #587: answers initialize, then dies on stdin while the child stays up.
// The parent's next write (session/new) must hit EPIPE and surface as a fast
// v1 error.
//
// Close before replying: a fast parent sends session/new as soon as it reads
// initialize, and that write must encounter the dead input pipe. The close is
// three steps, and the order matters. Closing fd 0 while readline's libuv
// handle still owns it aborts the child on some machines (SIGABRT — the
// fixture would become a process-death test); on other machines closeSync
// alone throws EBADF and never closes the read end, so the parent's write
// silently succeeds and only the 15s request timeout can catch the hang
// (#588). destroy() disarms the handle, closeSync(0) actually closes the
// pipe's read end (destroy alone leaves the fd open).
import { createInterface } from 'node:readline';
import { closeSync } from 'node:fs';
const emit = value => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...value })}\n`);
const rl = createInterface({ input: process.stdin });
process.stdin.on('error', () => { /* the EBADF below is intentional */ });
rl.on('line', line => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === 'initialize') {
    rl.close();
    process.stdin.destroy();
    try { closeSync(0); } catch { /* already closed */ }
    emit({ id: msg.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
  }
});
process.on('SIGTERM', () => { /* ignore — the child must outlive its stdin */ });
setInterval(() => {}, 1e6);
