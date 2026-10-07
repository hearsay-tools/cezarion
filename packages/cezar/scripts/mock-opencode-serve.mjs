#!/usr/bin/env node
// Keep this fixture standalone: lifecycle tests copy the runner into a temp directory.
import { spawn as watchdogSpawn } from 'node:child_process';
import { writeFileSync as watchdogWritePid } from 'node:fs';
function watchdogStall(prompt) {
  if (!prompt.includes('mock:no-progress')) return false;
  watchdogWritePid('watchdog.pid', String(process.pid));
  if (prompt.includes('ignore-term')) {
    process.removeAllListeners('SIGTERM');
    process.on('SIGTERM', () => {});
    // Test-cleanup backstop, deliberately longer than the asserted teardown bound.
    setTimeout(() => process.exit(0), 12_000);
  }
  if (prompt.includes('held-pipe')) {
    watchdogSpawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { stdio: ['ignore', process.stdout, process.stderr] });
  }
  return true;
}

// Bundled dry-run mock of `opencode serve` — speaks just enough of the HTTP+SSE
// API (§4 of agent-event-protocols.md) for the runner wiring test in
// `opencode-ui-mapper.test.ts`: POST /session, GET /event (SSE bus), one
// scripted prompt turn. Like the real server's `prompt_async`, the HTTP
// response resolves immediately — every part and the closing `session.idle`
// arrive over SSE afterwards, so a correct stream (v1 and v2 alike) must
// take its turn-end from `session.idle`, never from the HTTP response.
import { createHash } from 'node:crypto';
// Aliased: owned-input-delivery.testkit.ts prepends its own `existsSync`/`writeFileSync` import,
// and a second import of the same name is a SyntaxError.
import { appendFileSync, existsSync as sessionStoreExists, mkdirSync, readFileSync, writeFileSync as sessionStoreWrite } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

// #872: the first N starts die before listening, the way opencode 1.18.33 did
// when started within ~2 s of SIGTERM to the previous server on the same DB.
// Starts are counted across processes in a file, so start N+1 listens normally.
const failStarts = Number(process.env.CEZ_MOCK_OPENCODE_SERVE_FAIL_STARTS ?? 0);
if (failStarts > 0) {
  const counter = process.env.CEZ_MOCK_OPENCODE_SERVE_FAIL_FILE
    || (process.env.CEZ_MOCK_ARGS_FILE ? `${process.env.CEZ_MOCK_ARGS_FILE}.opencode-serve-starts`
      : join(tmpdir(), `cez-mock-opencode-serve-starts-${createHash('sha256').update(process.cwd()).digest('hex')}`));
  const start = (sessionStoreExists(counter) ? Number(readFileSync(counter, 'utf8')) || 0 : 0) + 1;
  sessionStoreWrite(counter, String(start));
  if (start <= failStarts) {
    // Pipe writes to stderr are synchronous on POSIX, so exiting right away loses nothing.
    process.stderr.write(`Error: Unexpected error (start ${start})\nServeError\n`);
    process.exit(1);
  }
}

if (process.env.CEZ_MOCK_ARGS_FILE && process.env.OPENCODE_CONFIG_CONTENT) appendFileSync(process.env.CEZ_MOCK_ARGS_FILE, JSON.stringify({ type: 'runtime-config', config: JSON.parse(process.env.OPENCODE_CONFIG_CONTENT) }) + '\n');
if (process.env.CEZ_MOCK_CI_PR) { const { probeCiTool } = await import('./mock-ci-tool.mjs'); await probeCiTool('opencode', JSON.parse(process.env.OPENCODE_CONFIG_CONTENT ?? '{}')); }
import * as parityGateFs from 'node:fs';

// #401: let the test observe the actual monitoring park before releasing late wire frames.
async function afterParityPark(prompt) {
  const gate = /parity-release=([^\s"\\]+)/.exec(prompt)?.[1];
  if (!gate) throw new Error('post-park scenario requires a release path');
  while (!parityGateFs.existsSync(gate)) await new Promise(resolve => setTimeout(resolve, 10));
}

const args = process.argv.slice(2);
const arg = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};
const hostname = arg('--hostname', '127.0.0.1');

const DEFAULT_SESSION_ID = 'ses_mock_1';
let SESSION_ID = DEFAULT_SESSION_ID;
const MESSAGE_ID = 'msg_mock_1';

function sessionStorePath() {
  if (process.env.CEZ_MOCK_OPENCODE_SESSIONS_FILE) return process.env.CEZ_MOCK_OPENCODE_SESSIONS_FILE;
  // Keyed on the args file, not its directory: spec-support probes and D1 share a
  // cwd and would otherwise increment ses_mock_N across unrelated launches.
  if (process.env.CEZ_MOCK_ARGS_FILE) return `${process.env.CEZ_MOCK_ARGS_FILE}.opencode-sessions.json`;
  // Dry-run Continue (no args file) must resume in the same worktree: persist by cwd.
  const key = createHash('sha256').update(process.cwd()).digest('hex');
  return join(tmpdir(), `cez-mock-opencode-sessions-${key}.json`);
}
function emptySessionStore() {
  return { seq: 0, sessions: {} };
}
function readPersistedSessionStore() {
  const path = sessionStorePath();
  if (!path || !sessionStoreExists(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (parsed && typeof parsed === 'object' && parsed.sessions && typeof parsed.sessions === 'object') return parsed;
  } catch {
    // A corrupt store is treated as missing so a later POST can mint a session.
  }
  return null;
}
let memorySessionStore = readPersistedSessionStore() ?? emptySessionStore();
function loadSessionStore() {
  return readPersistedSessionStore() ?? memorySessionStore;
}
function saveSessionStore(store) {
  memorySessionStore = store;
  const path = sessionStorePath();
  if (!path) return;
  mkdirSync(dirname(path), { recursive: true });
  sessionStoreWrite(path, JSON.stringify(store));
}
function getSession(id) {
  return loadSessionStore().sessions[id] ?? null;
}
function createSession(body = {}) {
  const store = loadSessionStore();
  store.seq += 1;
  const id = store.seq === 1 ? DEFAULT_SESSION_ID : `ses_mock_${store.seq}`;
  store.sessions[id] = {
    id,
    title: typeof body.title === 'string' ? body.title : 'cezar task',
    prompts: [],
    ...(Array.isArray(body.permission) ? { permission: [...body.permission] } : {}),
  };
  saveSessionStore(store);
  return id;
}
function addPrompt(id, text) {
  const store = loadSessionStore();
  if (!store.sessions[id]) return;
  store.sessions[id].prompts = [...(store.sessions[id].prompts ?? []), text];
  saveSessionStore(store);
}
function patchSession(id, body) {
  const store = loadSessionStore();
  if (!store.sessions[id]) return null;
  // OpenCode 1.18.33: PATCH permission APPENDS (no replace, no dedupe); a
  // title-only PATCH leaves permission alone.
  const next = { ...store.sessions[id], ...body, id };
  if (Array.isArray(body.permission)) {
    const existing = Array.isArray(store.sessions[id].permission) ? store.sessions[id].permission : [];
    next.permission = [...existing, ...body.permission];
  }
  store.sessions[id] = next;
  saveSessionStore(store);
  return store.sessions[id];
}

let sse = null;
const write = (event) => {
  if (sse) sse.write(`data: ${JSON.stringify(event)}\n\n`);
};
// #505: like opencode 1.18.32, a prompt_async POSTed while the session is busy is
// steered into the running loop: its user message exists at once, and the next
// assistant message names it as parentID. Steers are read just before the turn's
// idle, unless the turn is `late` (the upstream lost wake: never read).
let turnActive = false;
let turnLate = false;
let steers = [];
let steerSerial = 0;
const send = (event) => {
  const ownIdle = event?.type === 'session.idle' && (!event.properties?.sessionID || event.properties.sessionID === SESSION_ID);
  if (ownIdle) {
    if (!turnLate) for (const steer of steers) {
      const id = `msg_steer_reply_${++steerSerial}`;
      write({ type: 'message.updated', properties: { info: { ...info({}), id, parentID: steer.userId } } });
      write({ type: 'message.part.updated', properties: { part: { id: `prt_${id}`, messageID: id, sessionID: SESSION_ID, type: 'text', text: steer.text } } });
    }
    steers = []; turnActive = false; turnLate = false;
  }
  write(event);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Questions the runner can look up an id for. `replyQuestion`/`rejectQuestion`
 *  resolve the id through `GET /question` before answering (see
 *  `opencode-server-runner.ts`), so a native ask needs an entry here. */
const pendingQuestions = [];
let echoSerial = 0;
let lateQuestionReply = false;
let answerDone = false;

/** The question tool arrives as a `tool` part whose state.input holds it —
 *  the shape `opencode-server-runner.test.ts`'s sendQuestion helper drives. */
const sendQuestionPart = (input) =>
  send({
    type: 'message.part.updated',
    properties: {
      part: {
        id: 'prt_mock_question',
        messageID: MESSAGE_ID,
        sessionID: SESSION_ID,
        type: 'tool',
        callID: 'call_mock_question',
        tool: 'question',
        state: { status: 'running', input },
      },
    },
  });
// The user message of the prompt being answered: opencode 1.18.32 creates it at the
// POST and names it as the assistant's parentID (#505 probe).
let currentUserId;
const info = (extra) => ({
  id: MESSAGE_ID,
  sessionID: SESSION_ID,
  role: 'assistant',
  ...(currentUserId ? { parentID: currentUserId } : {}),
  time: { created: 1760000000000 },
  modelID: 'mock-model',
  providerID: 'mock',
  mode: 'build',
  path: { cwd: '/repo', root: '/repo' },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  ...extra,
});

let autonomousTurn = 0;
let autonomousCap = false;
let autonomousReadinessIdle = false;
const server = createServer((req, res) => {
  const url = req.url ?? '';
  if (req.method === 'GET' && url === '/question') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(pendingQuestions));
    return;
  }
  if (req.method === 'GET' && url.startsWith('/event')) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    sse = res;
    send({ type: 'server.connected', properties: {} });
    return;
  }
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', async () => {
    if (process.env.CEZ_MOCK_ARGS_FILE) appendFileSync(process.env.CEZ_MOCK_ARGS_FILE, `${JSON.stringify({ method: req.method, url, body: body ? JSON.parse(body) : undefined })}\n`);
    if (req.method === 'POST' && /^\/question\/[^/]+\/(reply|reject)$/.test(url)) {
      // Native question reply resumes the held turn, then its own session.idle
      // ends it (same SSE lifecycle shape as the baseline; never the HTTP ack).
      const answered = pendingQuestions.some(question => question.id === 'q_mock_1');
      pendingQuestions.length = 0;
      if (answered && url.endsWith('/reply')) setTimeout(() => {
        send({ type: 'message.part.updated', properties: { part: {
          id: 'prt_answer', messageID: MESSAGE_ID, sessionID: SESSION_ID, type: 'text', text: `human answer: ${body}${answerDone ? '\n\nCEZ:DONE' : ''}`,
        } } });
        // #505 review: CEZ_MOCK_OPENCODE_REPLY_HOLD_MS keeps the answered turn running.
        setTimeout(() => send({ type: 'session.idle', properties: { sessionID: SESSION_ID } }), Number(process.env.CEZ_MOCK_OPENCODE_REPLY_HOLD_MS ?? 0));
      }, 30);
      const acknowledge = () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); };
      if (lateQuestionReply) setTimeout(acknowledge, 250);
      else acknowledge();
      return;
    }
    const sessionGet = req.method === 'GET' && /^\/session\/([^/]+)$/.exec(url);
    if (sessionGet) {
      const session = getSession(sessionGet[1]);
      if (!session) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'NotFoundError' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: session.id,
        title: session.title,
        ...(Array.isArray(session.permission) ? { permission: session.permission } : {}),
      }));
      return;
    }
    const sessionPatch = req.method === 'PATCH' && /^\/session\/([^/]+)$/.exec(url);
    if (sessionPatch) {
      const session = patchSession(sessionPatch[1], body ? JSON.parse(body) : {});
      if (!session) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'NotFoundError' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: session.id,
        title: session.title,
        ...(Array.isArray(session.permission) ? { permission: session.permission } : {}),
      }));
      return;
    }
    if (req.method === 'POST' && url === '/session') {
      const parsed = body ? JSON.parse(body) : {};
      SESSION_ID = createSession(parsed);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: SESSION_ID,
        title: parsed.title ?? 'cezar task',
        ...(Array.isArray(parsed.permission) ? { permission: parsed.permission } : {}),
      }));
      return;
    }
    const sessionPrompt = req.method === 'POST' && /^\/session\/([^/]+)\/(prompt_async|message)$/.exec(url);
    if (sessionPrompt && getSession(sessionPrompt[1])) {
      SESSION_ID = sessionPrompt[1];
      try {
        const text = body ? JSON.parse(body).parts?.map(part => part.text ?? '').join('\n') ?? '' : '';
        if (text) addPrompt(SESSION_ID, text);
      } catch {
        // Keep the scripted turn even when the body is not JSON.
      }
      if (body.includes('mock:crash-stderr-pre-ack')) {
        const { crashWithStderr } = await import('./mock-runner-crash.mjs');
        crashWithStderr(body);
        return;
      }
      if (body.includes('mock:reject-agent-post')) {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'agent prompt rejected' }));
        return;
      }
      if (turnActive && url.endsWith('/prompt_async')) {
        const text = JSON.parse(body).parts.map(part => part.text ?? '').join('\n');
        const userId = `msg_steer_user_${++steerSerial}`;
        // #505 review: acknowledge a steer later than the runner's lost-wake window.
        const ackDelay = Number(process.env.CEZ_MOCK_OPENCODE_STEER_ACK_MS ?? 0);
        if (ackDelay > 0) setTimeout(() => { res.writeHead(204); res.end(); }, ackDelay);
        else { res.writeHead(204); res.end(); }
        send({ type: 'message.updated', properties: { info: { id: userId, sessionID: SESSION_ID, role: 'user', time: { created: Date.now() } } } });
        send({ type: 'message.part.updated', properties: { part: { id: `prt_${userId}`, messageID: userId, sessionID: SESSION_ID, type: 'text', text } } });
        steers.push({ userId, text });
        return;
      }
      turnActive = true;
      // `prompt_async` semantics: acknowledge now, stream the turn over SSE.
      res.writeHead(200, { 'content-type': 'application/json' });
      // #426: a nudged turn can finish on SSE before its HTTP acceptance arrives.
      // Force that ordering in the cap scenario; the first opening stays ordinary.
      if (autonomousReadinessIdle && body.includes('Continue working autonomously until the task is fully complete.')) {
        // Keep the portable answer HTTP request unacknowledged while its SSE turn finishes.
      } else if (autonomousCap && body.includes('Continue working autonomously until the task is fully complete.')) {
        setTimeout(() => res.end(JSON.stringify({ info: info({}), parts: [] })), 100);
      } else if (body.includes('f7-delay-ack')) {
        // F7: SSE turn-end before HTTP ACK so parkAfterAck applies the silent-tail nudge.
        setTimeout(() => res.end(JSON.stringify({ info: info({}), parts: [] })), 250);
      } else {
      res.end(JSON.stringify({ info: info({}), parts: [] }));
      }
      if (body.includes('mock:autonomous-readiness-idle')) autonomousReadinessIdle = true;
      if (body.includes('mock:autonomous-cap') || body.includes('mock:autonomous-ask-cap')) autonomousCap = true;
      if (body.includes('mock:silent-tail') || body.includes('Your last turn ended without a message to the user.')) {
        const silent = await import('./mock-silent-tail.mjs');
        const prompt = (() => { try { return JSON.parse(body).parts.map(part => part.text ?? '').join('\n'); } catch { return body; } })();
        silent.noteSilentTailPrompt(prompt);
        if (silent.isAckOnlyNudge(prompt)) {
          const beats = setInterval(() => { if (sse) sse.write(': heartbeat\n\n'); }, 50);
          beats.unref?.();
          return;
        }
        if (silent.isLateNudge(prompt)) await silent.sleep(silent.LATE_REPLY_MS);
      }
      if (url.endsWith('/prompt_async')) {
        currentUserId = `msg_user_${++steerSerial}`;
        const text = JSON.parse(body).parts.map(part => part.text ?? '').join('\n');
        send({ type: 'message.updated', properties: { info: { id: currentUserId, sessionID: SESSION_ID, role: 'user', time: { created: Date.now() } } } });
        send({ type: 'message.part.updated', properties: { part: { id: `prt_${currentUserId}`, messageID: currentUserId, sessionID: SESSION_ID, type: 'text', text } } });
      }
      if (body.includes('mock:crash-stderr')) {
        const { crashWithStderr } = await import('./mock-runner-crash.mjs');
        if (body.includes('mock:crash-stderr-clean')) crashWithStderr(body);
        else { setTimeout(() => crashWithStderr(body), 30); return; }
      }
      if (body.includes('mock:steer-tool')) {
        send({ type: 'message.updated', properties: { info: info({}) } });
        send({ type: 'message.part.updated', properties: { part: { id: 'prt_steer_tool', messageID: MESSAGE_ID, sessionID: SESSION_ID, type: 'tool', callID: 'call_steer', tool: 'bash', state: { status: 'running', input: { command: 'wait' } } } } });
        await sleep(Number(process.env.CEZ_MOCK_STEER_MS ?? 600));
        send({ type: 'message.part.updated', properties: { part: { id: 'prt_steer_tool', messageID: MESSAGE_ID, sessionID: SESSION_ID, type: 'tool', callID: 'call_steer', tool: 'bash', state: { status: 'completed', input: { command: 'wait' }, output: 'waited' } } } });
        send({ type: 'session.idle', properties: { sessionID: SESSION_ID } });
        return;
      }
      if (body.includes('mock:steer-late')) {
        send({ type: 'message.updated', properties: { info: info({}) } });
        send({ type: 'message.part.updated', properties: { part: { id: 'prt_steer_late', messageID: MESSAGE_ID, sessionID: SESSION_ID, type: 'text', text: 'late window: final message already sent', time: { start: 1760000000000, end: 1760000000001 } } } });
        turnLate = true;
        await sleep(300);
        send({ type: 'session.idle', properties: { sessionID: SESSION_ID } });
        return;
      }
      // The raw body is enough to spot a `mock:` marker — the prompt text is
      // inside it whatever part shape the runner used to wrap it.
      if (body.includes('mock:ci-wait')) {
        const { ciPrompt } = await import('./mock-ci-tool.mjs');
        const text = await ciPrompt('opencode', JSON.parse(process.env.OPENCODE_CONFIG_CONTENT ?? '{}'), body);
        send({ type: 'message.part.updated', properties: { part: { id: 'ci-result', messageID: MESSAGE_ID, sessionID: SESSION_ID, type: 'text', text } } });
        send({ type: 'session.idle', properties: { sessionID: SESSION_ID } });
        return;
      }
      if (body.includes('mock:turn-messages:')) {
        const { turnMessages } = await import('./mock-turn-messages.mjs');
        send({ type: 'message.updated', properties: { info: info({}) } });
        for (const text of turnMessages(JSON.parse(body).parts.map(part => part.text ?? '').join('\n'))) {
          send({ type: 'message.part.updated', properties: { part: { id: `prt_multi_${++echoSerial}`, messageID: MESSAGE_ID, sessionID: SESSION_ID, type: 'text', text, time: { start: 1, end: 2 } } } });
        }
        send({ type: 'session.idle', properties: { sessionID: SESSION_ID } });
        return;
      }
      if (body.includes('mock:agent-echo')) {
        send({ type: 'message.updated', properties: { info: info({}) } });
        send({ type: 'message.part.updated', properties: { part: {
          id: `prt_echo_${++echoSerial}`, messageID: MESSAGE_ID, sessionID: SESSION_ID, type: 'text',
          text: JSON.parse(body).parts.map(part => part.text ?? '').join('\n'),
        } } });
        send({ type: 'session.idle', properties: { sessionID: SESSION_ID } });
        return;
      }
      // SSE child attribution from __fixtures__/opencode/subtask-nested.ndjson.
      if (body.includes('mock:subagent-after-park')) {
        send({ type: 'message.updated', properties: { info: info({}) } });
        send({ type: 'message.part.updated', properties: { part: { id: 'park-task', messageID: MESSAGE_ID, sessionID: SESSION_ID, type: 'subtask', prompt: 'Review', description: 'Review', agent: 'general' } } });
        send({ type: 'message.updated', properties: { info: { ...info({}), id: 'park-child-msg', sessionID: 'park-child', parentID: SESSION_ID, mode: 'subagent' } } });
        send({ type: 'message.part.updated', properties: { part: { id: 'early-child', messageID: 'park-child-msg', sessionID: 'park-child', type: 'text', text: 'Child review started.', time: { start: 1, end: 2 } } } });
        send({ type: 'message.part.updated', properties: { part: { id: 'park-parent', messageID: MESSAGE_ID, sessionID: SESSION_ID, type: 'text', text: 'Watching the child.\nCEZ:MONITORING', time: { start: 1, end: 2 } } } });
        send({ type: 'session.idle', properties: { sessionID: SESSION_ID } });
        await afterParityPark(body);
        send({ type: 'message.part.updated', properties: { part: { id: 'late-read', messageID: 'park-child-msg', sessionID: 'park-child', type: 'tool', tool: 'read', state: { status: 'running', input: { path: 'README.md' } } } } });
        send({ type: 'message.part.updated', properties: { part: { id: 'late-read', messageID: 'park-child-msg', sessionID: 'park-child', type: 'tool', tool: 'read', state: { status: 'completed', input: { path: 'README.md' }, output: 'Read the file.' } } } });
        send({ type: 'message.part.updated', properties: { part: { id: 'late-child-text', messageID: 'park-child-msg', sessionID: 'park-child', type: 'text', text: 'Late child text.', time: { start: 3, end: 4 } } } });
        // Closed child scopes are ignored. This passive usage snapshot proves the
        // preceding SSE frames have reached the runner before the test observes it.
        send({ type: 'message.updated', properties: { info: info({ tokens: { input: 424240, output: 2, reasoning: 0, cache: { read: 0, write: 0 } } }) } });
        return;
      }
      if (body.includes('mock:subagent')) {
        // Wire shape from `__fixtures__/opencode/subtask-nested.ndjson`: a
        // `subtask` part on the parent message, then a child message whose info
        // carries `parentID`, its parts, and the CHILD's own `session.idle`.
        // That child idle arrives first on purpose — the parent turn has to
        // survive it and close only on its own (#5, #600; harness parity S9).
        send({ type: 'message.updated', properties: { info: info({}) } });
        send({ type: 'message.part.updated', properties: { part: {
          id: 'prt_mock_subt', messageID: MESSAGE_ID, sessionID: SESSION_ID, type: 'subtask',
          prompt: 'Trace every caller of resolveSession', description: 'Trace resolveSession callers',
          agent: 'general',
        } } });
        send({ type: 'message.updated', properties: { info: {
          ...info({}), id: 'msg_mock_child', sessionID: 'ses_mock_child',
          parentID: SESSION_ID, mode: 'subagent',
        } } });
        send({ type: 'message.part.updated', properties: { part: {
          id: 'prt_mock_ctxt', messageID: 'msg_mock_child', sessionID: 'ses_mock_child',
          type: 'text', text: 'Two callers: router.ts and session.ts.',
          time: { start: 1760000008800, end: 1760000008900 },
        } } });
        send({ type: 'session.idle', properties: { sessionID: 'ses_mock_child' } });
        // A second child is still running when the parent declares monitoring.
        send({ type: 'message.part.updated', properties: { part: {
          id: 'prt_mock_late_subt', messageID: MESSAGE_ID, sessionID: SESSION_ID, type: 'subtask',
          prompt: 'Review the callers', description: 'Review callers', agent: 'general',
        } } });
        send({ type: 'message.updated', properties: { info: {
          ...info({}), id: 'msg_mock_late_child', sessionID: 'ses_mock_late_child',
          parentID: SESSION_ID, mode: 'subagent',
        } } });
        setTimeout(() => {
          send({ type: 'message.part.updated', properties: { part: {
            id: 'prt_mock_ptxt', messageID: MESSAGE_ID, sessionID: SESSION_ID,
            type: 'text', text: 'Still working after the sub-agent.\nCEZ:MONITORING',
            time: { start: 1760000009000, end: 1760000009200 },
          } } });
          // #149: foreign-session text after the parent's marker must stay v2-only.
          send({ type: 'message.part.updated', properties: { part: {
            id: 'prt_mock_late_child', messageID: 'msg_mock_late_child', sessionID: 'ses_mock_late_child',
            type: 'text', text: 'Child review finished.',
            time: { start: 1760000009200, end: 1760000009300 },
          } } });
          send({ type: 'message.updated', properties: { info: info({
            cost: 0.0001, tokens: { input: 20, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
          }) } });
          setTimeout(() => send({ type: 'session.idle', properties: { sessionID: SESSION_ID } }), 30);
        }, 60);
        return;
      }
      // #723: native GET /skill diagnostic captured on 1.18.33; upstream
      // packages/opencode/src/skill/index.ts:96-111 skips the unreadable skill.
      if (body.includes('mock:skill-warning')) {
        for (const root of ['.claude', '.agents']) send({ type: 'session.error', properties: {
          error: { name: 'UnknownError', data: { message: `Failed to parse skill /home/agent/${root}/skills/pen-design/SKILL.md` } },
        } });
      }
      if (body.includes('mock:unscoped-provider-failure') || body.includes('mock:scoped-skill-failure')) {
        send({ type: 'session.error', properties: {
          ...(body.includes('mock:scoped-skill-failure') ? { sessionID: SESSION_ID } : {}),
          error: { name: 'UnknownError', data: { message: body.includes('mock:scoped-skill-failure')
            ? 'Failed to parse skill /skills/required/SKILL.md' : 'provider unavailable — retry after restoring service' } },
        } });
        setTimeout(() => send({ type: 'session.idle', properties: { sessionID: SESSION_ID } }), 30);
        return;
      }
      if (body.includes('mock:provider-error-early')) {
        // #505 review: the provider rejects before any assistant message exists.
        send({ type: 'session.error', properties: { sessionID: SESSION_ID, error: { name: 'ProviderAuthError', data: { message: 'API key expired' } } } });
        setTimeout(() => send({ type: 'session.idle', properties: { sessionID: SESSION_ID } }), 30);
        return;
      }
      if (body.includes('mock:provider-error')) {
        // The session-level error frame, wire shape copied verbatim from
        // `__fixtures__/opencode/session-error.ndjson`. #53: a bare upstream
        // rejection used to read like a missing executable, and the run parked
        // as "Needs You" rather than failing (harness parity S7).
        send({ type: 'message.updated', properties: { info: info({}) } });
        send({ type: 'message.part.updated', properties: { part: {
          id: 'prt_mock_perr', messageID: MESSAGE_ID, sessionID: SESSION_ID,
          type: 'text', text: 'Starting the review',
        } } });
        send({ type: 'session.error', properties: { sessionID: SESSION_ID, error: {
          name: 'ProviderAuthError',
          data: { message: 'API key expired — run `opencode auth login`' },
        } } });
        setTimeout(() => send({ type: 'session.idle', properties: { sessionID: SESSION_ID } }), 30);
        return;
      }
      if (body.includes('mock:split-text')) {
        // OpenCode streams a text part as successive GROWING snapshots of the
        // same part id; only the final one carries `time.end`. A runner emitting
        // one v1 `text` per snapshot publishes the torn `…CEZ:` prefix, which is
        // #2 on opencode's wire (harness parity S8).
        const full = 'parity split text\n\nCEZ:MONITORING';
        send({ type: 'message.updated', properties: { info: info({}) } });
        for (const upto of [17, 24, full.length]) {
          send({ type: 'message.part.updated', properties: { part: {
            id: 'prt_mock_split', messageID: MESSAGE_ID, sessionID: SESSION_ID, type: 'text',
            text: full.slice(0, upto),
            ...(upto === full.length ? { time: { start: 1760000000500, end: 1760000000600 } } : {}),
          } } });
        }
        send({ type: 'message.updated', properties: { info: info({
          cost: 0.0001, tokens: { input: 20, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
        }) } });
        setTimeout(() => send({ type: 'session.idle', properties: { sessionID: SESSION_ID } }), 30);
        return;
      }
      if (body.includes('mock:autonomous') || body.includes('Continue working autonomously until the task is fully complete.')) {
        const { autonomousReply } = await import('./mock-autonomous.mjs');
        send({ type: 'message.updated', properties: { info: info({}) } });
        send({ type: 'message.part.updated', properties: { part: { id: `autonomous-${++autonomousTurn}`, messageID: MESSAGE_ID, sessionID: SESSION_ID, type: 'text', text: autonomousReply(JSON.parse(body).parts.map(part => part.text ?? '').join('\n')), time: { start: 1, end: 2 } } } });
        send({ type: 'session.idle', properties: { sessionID: SESSION_ID } });
        return;
      }
      if (body.includes('mock:silent-tail') || body.includes('mock:tool-tail') || body.includes('Your last turn ended without a message to the user.')) {
        const silent = await import('./mock-silent-tail.mjs');
        const prompt = (() => { try { return JSON.parse(body).parts.map(part => part.text ?? '').join('\n'); } catch { return body; } })();
        silent.noteSilentTailPrompt(prompt);
        if (silent.isFinalMessageNudge(prompt)) {
          const kind = silent.finalMessageNudgeKind();
          send({ type: 'message.updated', properties: { info: info({}) } });
          if (kind === 'silent') {
            send({ type: 'message.part.updated', properties: { part: { id: 'silent-nudge-rsn', messageID: MESSAGE_ID, sessionID: SESSION_ID, type: 'reasoning', text: silent.SILENT_TAIL_REASONING, time: { start: 1, end: 2 } } } });
          } else {
            if (kind === 'slow-done') {
              send({ type: 'message.part.updated', properties: { part: { id: 'silent-nudge-prefix', messageID: MESSAGE_ID, sessionID: SESSION_ID, type: 'text', text: silent.SLOW_DONE_PREFIX, time: { start: 1, end: 2 } } } });
              await silent.sleep(silent.SLOW_DONE_TAIL_MS);
            }
            const text = kind === 'standing' ? silent.FINAL_MESSAGE_STANDING : silent.SILENT_TAIL_DONE;
            send({ type: 'message.part.updated', properties: { part: { id: 'silent-nudge-done', messageID: MESSAGE_ID, sessionID: SESSION_ID, type: 'text', text, time: { start: 1, end: 2 } } } });
          }
          send({ type: 'session.idle', properties: { sessionID: SESSION_ID } });
          return;
        }
        if (silent.isSilentTailScenario(prompt)) {
          send({ type: 'message.updated', properties: { info: info({}) } });
          send({ type: 'message.part.updated', properties: { part: { id: 'silent-open', messageID: MESSAGE_ID, sessionID: SESSION_ID, type: 'text', text: silent.SILENT_TAIL_OPENING, time: { start: 1, end: 2 } } } });
          send({ type: 'message.part.updated', properties: { part: { id: 'silent-gh', messageID: MESSAGE_ID, sessionID: SESSION_ID, type: 'tool', callID: 'call_silent_gh', tool: 'bash', state: { status: 'completed', input: { command: 'gh issue create' }, output: 'created', time: { start: 1, end: 2 } } } } });
          send({ type: 'message.part.updated', properties: { part: { id: 'silent-rsn', messageID: MESSAGE_ID, sessionID: SESSION_ID, type: 'reasoning', text: silent.SILENT_TAIL_REASONING, time: { start: 1, end: 2 } } } });
          send({ type: 'session.idle', properties: { sessionID: SESSION_ID } });
          return;
        }
        if (silent.isToolTailScenario(prompt)) {
          send({ type: 'message.updated', properties: { info: info({}) } });
          send({ type: 'message.part.updated', properties: { part: { id: 'tool-tail-open', messageID: MESSAGE_ID, sessionID: SESSION_ID, type: 'text', text: silent.TOOL_TAIL_OPENING, time: { start: 1, end: 2 } } } });
          send({ type: 'message.part.updated', properties: { part: { id: 'tool-tail-git', messageID: MESSAGE_ID, sessionID: SESSION_ID, type: 'tool', callID: 'call_tool_tail', tool: 'bash', state: { status: 'completed', input: { command: 'git status --short' }, output: ' M src/example.ts', time: { start: 1, end: 2 } } } } });
          send({ type: 'session.idle', properties: { sessionID: SESSION_ID } });
          return;
        }
      }
      // #401: one completed text snapshot, without an earlier streaming part.
      if (body.includes('mock:ask-snapshot')) {
        send({ type: 'message.updated', properties: { info: info({}) } });
        send({ type: 'message.part.updated', properties: { part: { id: 'ask-snapshot', messageID: MESSAGE_ID, sessionID: SESSION_ID, type: 'text', text: body.includes('mock:ask-snapshot-bad') ? 'CEZ:ASK {not valid json' : 'Using the CEZ:ASK structured question format instead:\n\nCEZ:ASK {"questions":[{"header":"Library","question":"Which test library?","options":[{"label":"Vitest"},{"label":"Node test"}]}]}', time: { start: 1, end: 2 } } } });
        send({ type: 'session.idle', properties: { sessionID: SESSION_ID } });
        return;
      }
      if (body.includes('mock:ask-prose')) {
        send({ type: 'message.updated', properties: { info: info({}) } });
        send({ type: 'message.part.updated', properties: { part: { id: 'ask-prose', messageID: MESSAGE_ID, sessionID: SESSION_ID, type: 'text', text: 'Use `CEZ:ASK {"questions":[]}` in your reply.\n> CEZ:ASK {not valid json', time: { start: 1, end: 2 } } } });
        send({ type: 'session.idle', properties: { sessionID: SESSION_ID } });
        return;
      }
      if (body.includes('mock:ask-bad')) {
        // Malformed: `questions` is not an array, so the runner must REJECT the
        // native question and finish the turn rather than wait for an answer to
        // a card that can never render (#6's rejection path, harness parity R4).
        send({ type: 'message.updated', properties: { info: info({}) } });
        pendingQuestions.push({ id: 'q_mock_bad', sessionID: SESSION_ID });
        sendQuestionPart({ questions: 'not-an-array' });
        setTimeout(() => send({ type: 'session.idle', properties: { sessionID: SESSION_ID } }), 60);
        return;
      }
      if (body.includes('mock:ask')) {
        lateQuestionReply = body.includes('mock:ask-reply-late');
        answerDone = body.includes('mock:ask-reply-late-done') || body.includes('mock:resume-done');
        // The native question tool (#6). No `session.idle` follows: a real ask
        // holds the turn open until the answer is routed back.
        send({ type: 'message.updated', properties: { info: info({}) } });
        pendingQuestions.push({ id: 'q_mock_1', sessionID: SESSION_ID });
        sendQuestionPart({ questions: [{
          header: 'Library',
          question: 'Which test library?',
          options: [
            { label: 'Vitest', description: 'Use the existing test runner' },
            { label: 'Node test', description: 'Use node:test' },
          ],
        }] });
        return;
      }
      if (body.includes('mock:done')) {
        // Declares the task complete so the run reaches cezar's review gate; a
        // markerless turn-end correctly parks as `waiting` instead (harness
        // parity R1).
        send({ type: 'message.updated', properties: { info: info({}) } });
        send({ type: 'message.part.updated', properties: { part: {
          id: 'prt_mock_done', messageID: MESSAGE_ID, sessionID: SESSION_ID, type: 'text',
          text: 'parity done: the task is complete\n\nCEZ:DONE',
          time: { start: 1760000000500, end: 1760000000600 },
        } } });
        send({ type: 'message.updated', properties: { info: info({
          cost: 0.0001, tokens: { input: 20, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
        }) } });
        setTimeout(() => send({ type: 'session.idle', properties: { sessionID: SESSION_ID } }), 30);
        return;
      }
      if (body.includes('mock:hold-ask')) {
        // Portable CEZ:ASK after a pause, so a mid-turn sendMessage can queue
        // and then race the park (run.ts must discard that waiter).
        setTimeout(() => {
          const ask = 'Pick one.\n\nCEZ:ASK {"questions":[{"header":"Library","question":"Which date library should I standardize on?","options":[{"label":"date-fns","description":"Tree-shakeable, functional"},{"label":"Luxon","description":"Immutable, tz-aware"}]}]}';
          send({ type: 'message.updated', properties: { info: info({}) } });
          send({ type: 'message.part.updated', properties: { part: {
            id: 'prt_mock_hold_ask', messageID: MESSAGE_ID, sessionID: SESSION_ID, type: 'text',
            text: ask,
            time: { start: 1760000000500, end: 1760000000600 },
          } } });
          send({ type: 'message.updated', properties: { info: info({
            cost: 0.0001, tokens: { input: 20, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
          }) } });
          setTimeout(() => send({ type: 'session.idle', properties: { sessionID: SESSION_ID } }), 30);
        }, 250);
        return;
      }
      if (watchdogStall(body)) return;
      if (body.includes('mock:busy-progress')) {
        let ticks = 0;
        const timer = setInterval(() => {
          send({ type: 'server.heartbeat', properties: {} });
          if (++ticks === 24) { clearInterval(timer); send({ type: 'session.idle', properties: { sessionID: SESSION_ID } }); }
        }, 100);
        return;
      }
      if (body.includes('mock:hold')) {
        // The response above is the ack (this is the #4 wire: `prompt_async`
        // resolves immediately, the turn arrives over SSE afterwards). Holding
        // the content behind it is what makes harness parity S2 meaningful.
        setTimeout(() => {
          const held = 'parity hold: content after the pause';
          send({ type: 'message.updated', properties: { info: info({}) } });
          send({ type: 'message.part.updated', properties: { part: {
            id: 'prt_mock_hold', messageID: MESSAGE_ID, sessionID: SESSION_ID, type: 'text', text: held,
          } } });
          send({ type: 'message.updated', properties: { info: info({
            cost: 0.0001, tokens: { input: 20, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
          }) } });
          setTimeout(() => send({ type: 'session.idle', properties: { sessionID: SESSION_ID } }), 30);
        }, 250);
        return;
      }
      send({ type: 'message.updated', properties: { info: info({}) } });
      send({
        type: 'message.part.updated',
        properties: {
          part: { id: 'prt_mock_t1', messageID: MESSAGE_ID, sessionID: SESSION_ID, type: 'text', text: 'Checking the working tree.' },
        },
      });
      send({
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'prt_mock_c1',
            messageID: MESSAGE_ID,
            sessionID: SESSION_ID,
            type: 'tool',
            callID: 'call_mock_1',
            tool: 'bash',
            state: { status: 'pending', input: { command: 'git status --short' }, raw: '{}' },
          },
        },
      });
      send({
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'prt_mock_c1',
            messageID: MESSAGE_ID,
            sessionID: SESSION_ID,
            type: 'tool',
            callID: 'call_mock_1',
            tool: 'bash',
            state: { status: 'running', input: { command: 'git status --short' }, title: 'git status --short', time: { start: 1760000000100 } },
          },
        },
      });
      send({
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'prt_mock_c1',
            messageID: MESSAGE_ID,
            sessionID: SESSION_ID,
            type: 'tool',
            callID: 'call_mock_1',
            tool: 'bash',
            state: {
              status: 'completed',
              input: { command: 'git status --short' },
              output: ' M src/example.ts\n',
              title: 'git status --short',
              metadata: { exit: 0 },
              time: { start: 1760000000100, end: 1760000000400 },
            },
          },
        },
      });
      send({
        type: 'message.updated',
        properties: {
          info: info({ cost: 0.0021, tokens: { input: 1200, output: 300, reasoning: 0, cache: { read: 0, write: 0 } } }),
        },
      });
      setTimeout(() => {
        send({
          type: 'message.part.updated',
          properties: {
            part: {
              id: 'prt_mock_t2',
              messageID: MESSAGE_ID,
              sessionID: SESSION_ID,
              type: 'text',
              text: 'Done.',
              time: { start: 1760000000500, end: 1760000000600 },
            },
          },
        });
      }, 30);
      setTimeout(() => send({ type: 'session.idle', properties: { sessionID: SESSION_ID } }), 90);
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
});

// Test sessions share a host: let the OS allocate a port instead of racing
// the runner’s random requested port against other fixtures.
server.listen(0, hostname, () => {
  // The runner reads the bound URL back from stdout, like the real server.
  console.log(`opencode server listening on http://${hostname}:${server.address().port}`);
});
process.on('SIGTERM', () => {
  // Expose the end-request/process-exit interval to the root idle regression.
  if (autonomousReadinessIdle) setTimeout(() => process.exit(0), 250);
  else process.exit(0);
});
