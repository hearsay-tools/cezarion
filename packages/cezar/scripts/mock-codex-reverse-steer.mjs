#!/usr/bin/env node
// #486 review round 2: buffers each `turn/steer` RPC response and writes it AFTER
// the following `turn/completed` (or `turn/failed`) notification. Codex reads
// stdout with `for await`, so microtasks run between those lines: the completed
// boundary settles before startOrSteerTurn sees the steer result.
// Do not wrap mock:steer-race / mock:steer-strand — those already emit completed
// then the steer response; this wrapper would hold that response until a later turn.
//
// Default (unread): drop the in-turn userMessage/agentMessage echo of the held
// steer so the follow-up was accepted and never read. CEZ_MOCK_REVERSE_ECHO=1
// keeps those echoes (read-in-turn) and still delays the steer response.
// CEZ_MOCK_DELAY_TURN_STARTED_MS holds stdout after a follow-up turn/start
// response so turn/started arrives later (review round 4).
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const echoInTurn = process.env.CEZ_MOCK_REVERSE_ECHO === '1';
const delayTurnStartedMs = Number.parseInt(process.env.CEZ_MOCK_DELAY_TURN_STARTED_MS ?? '0', 10) || 0;
const child = spawn(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), 'mock-codex-app-server.mjs'), ...process.argv.slice(2)], {
  stdio: ['pipe', 'pipe', 'inherit'],
  env: process.env,
});
const steerIds = new Set();
const steeredClientIds = new Set();
const steeredTexts = new Set();
const followUpStartIds = new Set();
let turnStartCount = 0;
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
      if (msg.method === 'turn/steer' && typeof msg.id === 'number') {
        steerIds.add(msg.id);
        const clientId = msg.params?.clientUserMessageId;
        if (typeof clientId === 'string') steeredClientIds.add(clientId);
        const text = msg.params?.input?.map?.((part) => part.text ?? '').join('\n') ?? '';
        if (text) steeredTexts.add(text);
      } else if (msg.method === 'turn/start' && typeof msg.id === 'number') {
        turnStartCount += 1;
        if (turnStartCount > 1) followUpStartIds.add(msg.id);
      }
    } catch { /* ignore a partial or non-JSON line */ }
  }
});
process.stdin.on('end', () => child.stdin.end());

let outBuf = '';
const held = [];
let stdoutPaused = false;
const pausedChunks = [];
let resumeTimer;
const resumeStdout = () => {
  stdoutPaused = false;
  resumeTimer = undefined;
  const pending = pausedChunks.splice(0);
  for (const chunk of pending) process.stdout.write(chunk);
};
child.stdout.setEncoding('utf8');
child.stdout.on('data', chunk => {
  outBuf += chunk;
  let idx;
  while ((idx = outBuf.indexOf('\n')) >= 0) {
    const line = outBuf.slice(0, idx + 1);
    outBuf = outBuf.slice(idx + 1);
    if (stdoutPaused) {
      pausedChunks.push(line);
      continue;
    }
    let msg;
    try { msg = JSON.parse(line); } catch { process.stdout.write(line); continue; }
    if (typeof msg.id === 'number' && steerIds.has(msg.id) && (msg.result !== undefined || msg.error !== undefined)) {
      steerIds.delete(msg.id);
      held.push(line);
      continue;
    }
    if (held.length && isSteerEcho(msg)) {
      if (echoInTurn) process.stdout.write(line);
      continue;
    }
    if ((msg.method === 'turn/completed' || msg.method === 'turn/failed') && held.length) {
      process.stdout.write(line + held.splice(0).join(''));
      continue;
    }
    process.stdout.write(line);
    if (delayTurnStartedMs > 0 && typeof msg.id === 'number' && followUpStartIds.has(msg.id) && msg.result !== undefined) {
      followUpStartIds.delete(msg.id);
      stdoutPaused = true;
      resumeTimer = setTimeout(resumeStdout, delayTurnStartedMs);
    }
  }
});
child.on('exit', (code, signal) => {
  if (resumeTimer) clearTimeout(resumeTimer);
  // A killed follow-up whose turn/started is still paused must not flush into a
  // closing runner; with the hold fix the delay elapses before close.
  if (!stdoutPaused) {
    if (outBuf) process.stdout.write(outBuf);
    if (held.length) process.stdout.write(held.join(''));
  }
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});

function isSteerEcho(msg) {
  const item = msg.params?.item;
  if (!item || typeof item !== 'object') return false;
  if (item.type === 'userMessage' && typeof item.clientId === 'string' && steeredClientIds.has(item.clientId)) return true;
  if (item.type === 'agentMessage' && typeof item.text === 'string' && steeredTexts.has(item.text)) return true;
  return false;
}
