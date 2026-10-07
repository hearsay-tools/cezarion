#!/usr/bin/env node
// #486 review: buffers each `turn/steer` RPC response and writes it in the SAME
// stdout write as the following `turn/completed` (or `turn/failed`) notification,
// preserving order. Reproduces Codex humanPromptsPending lagging a coalesced chunk.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const child = spawn(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), 'mock-codex-app-server.mjs'), ...process.argv.slice(2)], {
  stdio: ['pipe', 'pipe', 'inherit'],
  env: process.env,
});
const steerIds = new Set();
let stdinBuf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  child.stdin.write(chunk);
  stdinBuf += chunk;
  let idx;
  while ((idx = stdinBuf.indexOf('\n')) >= 0) {
    const line = stdinBuf.slice(0, idx);
    stdinBuf = stdinBuf.slice(idx + 1);
    try {
      const msg = JSON.parse(line);
      if (msg.method === 'turn/steer' && typeof msg.id === 'number') steerIds.add(msg.id);
    } catch { /* ignore a partial or non-JSON line */ }
  }
});
process.stdin.on('end', () => child.stdin.end());

let outBuf = '';
const held = [];
child.stdout.setEncoding('utf8');
child.stdout.on('data', chunk => {
  outBuf += chunk;
  let idx;
  while ((idx = outBuf.indexOf('\n')) >= 0) {
    const line = outBuf.slice(0, idx + 1);
    outBuf = outBuf.slice(idx + 1);
    let msg;
    try { msg = JSON.parse(line); } catch { process.stdout.write(line); continue; }
    if (typeof msg.id === 'number' && steerIds.has(msg.id) && (msg.result !== undefined || msg.error !== undefined)) {
      steerIds.delete(msg.id);
      held.push(line);
      continue;
    }
    if ((msg.method === 'turn/completed' || msg.method === 'turn/failed') && held.length) {
      process.stdout.write(held.splice(0).join('') + line);
      continue;
    }
    process.stdout.write(line);
  }
});
child.on('exit', (code, signal) => {
  if (outBuf) process.stdout.write(outBuf);
  if (held.length) process.stdout.write(held.join(''));
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
