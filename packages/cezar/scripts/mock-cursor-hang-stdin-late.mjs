#!/usr/bin/env node
// #587: the bootstrap write succeeds first, then stdin dies.
//
// The parent writes session/new while the pipe's read end is still open, so
// that write cannot fail. The child then drops the read end and never answers
// session/new. The runner's next write — the bootstrap stdin probe — is what
// must surface the death, not the 15s request timeout.
//
// The close is three steps, and the order matters. Closing fd 0 while
// readline's libuv handle still owns it aborts the child on some machines
// (SIGABRT — the fixture would become a process-death test); on other
// machines closeSync alone throws EBADF and never closes the read end, so the
// parent's write silently succeeds and only the 15s request timeout can catch
// the hang (#588). destroy() disarms the handle, closeSync(0) actually closes
// the pipe's read end (destroy alone leaves the fd open). The stdin 'error'
// handler swallows the EBADF from the next read attempt.
import { createInterface } from 'node:readline';
import { closeSync } from 'node:fs';
const emit = value => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...value })}\n`);
const rl = createInterface({ input: process.stdin });
process.stdin.on('error', () => { /* the EBADF below is intentional */ });
rl.on('line', line => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === 'initialize') {
    emit({ id: msg.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
  } else if (msg.method === 'session/new') {
    // The parent's write already succeeded into the kernel buffer; only now
    // does the read end die, with the child staying up.
    rl.close();
    process.stdin.destroy();
    try { closeSync(0); } catch { /* already closed */ }
  }
});
process.on('SIGTERM', () => { /* ignore — the child must outlive its stdin */ });
setInterval(() => {}, 1e6);
