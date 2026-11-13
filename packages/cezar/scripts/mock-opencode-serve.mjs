#!/usr/bin/env node
import { loadControls } from './mock-controls.mjs';
import { waitForRelease } from './mock-lifecycle.mjs';
import { scenarioFor, play, PROVIDER_HOLD_SCENARIOS } from './mock-scenario.mjs';
import { OPENCODE_FAILURES } from './mock-provider-failures.mjs';
import { isAckOnlyNudge, finalMessageNudgeKind } from './mock-silent-tail.mjs';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync as sessionStoreExists, mkdirSync, readFileSync, writeFileSync as sessionStoreWrite } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import * as parityGateFs from 'node:fs';
import { withoutSessionContextBody } from './mock-session-context.mjs';
const { failureControl, delivery } = await loadControls({ delivery: ['reject', 'hold-ack', 'hold-response'] });
let inputClosed = false;
// Bundled dry-run mock of `opencode serve` — speaks just enough of the HTTP+SSE
// API (§4 of agent-event-protocols.md) for the runner wiring test in
// `opencode-ui-mapper.test.ts`: POST /session, GET /event (SSE bus), one
// scripted prompt turn. Like the real server's `prompt_async`, the HTTP
// response resolves immediately — every part and the closing `session.idle`
// arrive over SSE afterwards, so a correct stream (v1 and v2 alike) must
// take its turn-end from `session.idle`, never from the HTTP response.
const { answerNudgeBody, silentNudge } = await import('./mock-nudge.mjs');
// #872: the first N starts die before listening, the way opencode 1.18.33 did
// when started within ~2 s of SIGTERM to the previous server on the same DB.
// Starts are counted across processes in a file, so start N+1 listens normally.
const wireRecorder = process.env.CEZ_MOCK_WIRE_FILE === undefined ? undefined : await import('./mock-wire-recorder.mjs'); wireRecorder?.installWireRecorder();
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

const args = process.argv.slice(2);
const arg = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};
const hostname = arg('--hostname', '127.0.0.1');

const DEFAULT_SESSION_ID = 'ses_mock_1';
let SESSION_ID = DEFAULT_SESSION_ID;
const MESSAGE_ID = 'msg_mock_1';
// hearsay-tools/cezarion#1265: the captured FrontmatterError text, verbatim,
// for a skill whose frontmatter holds `foo: "unterminated`.
const FRONTMATTER_ERROR = '/home/agent/.agents/skills/bad4/SKILL.md: Failed to parse YAML frontmatter: unexpected end of the stream within a double quoted scalar at line 6, column 1:\n    \n    ^';
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
// The heartbeats of a held `mock:ack-only` turn (hearsay-tools/cezarion#1301).
let heldBeats;
let turnLate = false;
let steers = [];
let steerSerial = 0;
// CEZ_MOCK_OPENCODE_FOLLOW_ON_MS: the server reads steers in a follow-on run that starts that long
// after the idle, and a prompt posted in between waits behind that run.
const followOnMs = Number(process.env.CEZ_MOCK_OPENCODE_FOLLOW_ON_MS ?? 0);
let followOn = null;
const runFollowOn = (held) => {
  followOn = sleep(followOnMs).then(() => {
    turnActive = true;
    for (const steer of held) {
      const id = `msg_steer_reply_${++steerSerial}`;
      write({ type: 'message.updated', properties: { info: { ...info({}), id, parentID: steer.userId } } });
      write({ type: 'message.part.updated', properties: { part: { id: `prt_${id}`, messageID: id, sessionID: SESSION_ID, type: 'text', text: steer.text, time: { start: 1, end: 2 } } } });
    }
    turnActive = false;
    followOn = null;
    write({ type: 'session.idle', properties: { sessionID: SESSION_ID } });
  });
};
const send = (event) => {
  const ownIdle = event?.type === 'session.idle' && (!event.properties?.sessionID || event.properties.sessionID === SESSION_ID);
  if (ownIdle && followOnMs > 0 && steers.length && !turnLate) {
    const held = steers;
    steers = []; turnActive = false;
    write(event);
    runFollowOn(held);
    return;
  }
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
// hearsay-tools/cezarion#2397: a reply that finishes, asks or waits calls that Squawk tool over
// OPENCODE_CONFIG_CONTENT's MCP entry before its turn ends. Returns '' or a note for the text.
const tools = () => import('./mock-ci-tool.mjs');
async function lifecycle(call) {
  return (await tools()).lifecycleCall('opencode', JSON.parse(process.env.OPENCODE_CONFIG_CONTENT ?? '{}'), ...call);
}
const finishText = async (text) => text + await lifecycle((await tools()).DONE);

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
/** hearsay-tools/cezarion#1266: OpenCode 1.18.35 `permission.asked`. No `session.idle`
 *  follows: the asking tool waits until `POST /permission/{id}/reply` answers it. */
const pendingPermissionAsks = new Set();
// hearsay-tools/cezarion#1266 lifecycle scenarios (harness parity P5, P7).
let failPermissionReplies = 0;
let classifyPending = false;
async function waitForMockFile(file) {
  // bound: hang guard for a test that never creates its gate file; the wait itself is the file.
  const deadline = Date.now() + 15_000;
  while (!parityGateFs.existsSync(file)) {
    if (Date.now() > deadline) throw new Error(`${file} was not created`);
    // bound: poll interval; the gate file is written by another process, with no event to await.
    await new Promise(r => setTimeout(r, 10));
  }
}
const textPart = (id, text) => send({ type: 'message.part.updated', properties: { part: {
  id, messageID: MESSAGE_ID, sessionID: SESSION_ID, type: 'text', text, time: { start: 1, end: 2 },
} } });
const sendPermissionAsk = (id, permission, patterns, always) => {
  pendingPermissionAsks.add(id);
  send({ type: 'permission.asked', properties: {
    id, sessionID: SESSION_ID, permission, patterns, metadata: {}, always,
    tool: { messageID: MESSAGE_ID, callID: 'call_mock_bash' },
  } });
};
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
const bodyRoutes = [
  [(req, url) => req.method === 'POST' && /^\/question\/[^/]+\/(reply|reject)$/.test(url), replyToQuestion],
  [(req, url) => req.method === 'POST' && /^\/permission\/([^/]+)\/reply$/.test(url), replyToPermission],
  [(req, url) => req.method === 'GET' && /^\/session\/([^/]+)$/.test(url), replyWithSession],
  [(req, url) => req.method === 'PATCH' && /^\/session\/([^/]+)$/.test(url), replyWithPatchedSession],
  [(req, url) => req.method === 'POST' && url === '/session', replyWithNewSession],
  [matchesSessionPrompt, handleSessionPrompt],
];
const nativeReplies = [
  [body => body.includes('mock:approval-resolved') || body.includes('mock:approval-turn-end'), replyWithSettledApproval],
  [body => body.includes('mock:approval-reply-fails'), replyWithFailedApprovalReply],
  [body => body.includes('mock:permission-malformed'), replyWithMalformedPermission],
  [body => body.includes('mock:permission-classify'), replyWithClassifyingPermission],
  [body => body.includes('mock:permission-late'), replyWithLatePermission],
  [body => body.includes('mock:permission-default'), replyWithDefaultPermission],
  [body => body.includes('mock:approval'), replyWithApproval],
  [body => body.includes('mock:ask-bad'), replyWithMalformedAsk],
  [body => body.includes('mock:ask'), replyWithAsk],
];
function matchesSessionPrompt(req, url) {
  const match = req.method === 'POST' && /^\/session\/([^/]+)\/(prompt_async|message)$/.exec(url);
  return match && getSession(match[1]);
}
async function dispatchReply(replies, body) {
  for (const [matches, reply] of replies) {
    if (matches(body) && await reply(body) !== false) return true;
  }
  return false;
}

const server = createServer(handleRequest);
function handleRequest(req, res) { wireRecorder?.recordHttpResponse(req, res);
  const url = req.url ?? '';
  if (inputClosed && req.method === 'POST') { req.socket.destroy(); return; }
  if (req.method === 'GET' && url === '/question') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(pendingQuestions));
    return;
  }
  // Only user-written config, as the real server returns it: this user configured `bash: ask`,
  // so `mock:approval` reaches the cockpit and the built-in `mock:permission-default` ask does not.
  if (req.method === 'GET' && url === '/config') {
    const answer = () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ permission: { bash: 'ask' } }));
    };
    if (!classifyPending) { answer(); return; }
    // P7: hold the config read, settle the ask natively while Squawk classifies it, then send a
    // marker ask. Files beside CEZ_MOCK_RELEASE_FILE hand each step to the test and back.
    classifyPending = false;
    const release = process.env.CEZ_MOCK_RELEASE_FILE;
    void (async () => {
      parityGateFs.writeFileSync(`${release}.config-read`, '');
      await waitForMockFile(`${release}.settle`);
      pendingPermissionAsks.delete('per_mock_classify');
      send({ type: 'permission.replied', properties: { sessionID: SESSION_ID, requestID: 'per_mock_classify', reply: 'reject' } });
      textPart('prt_classify_settled', 'OpenCode settled the ask itself.');
      await waitForMockFile(release);
      answer();
      sendPermissionAsk('per_mock_marker', 'bash', ['marker'], ['marker']);
    })();
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
  req.on('end', async () => { await handleRequestBody(req, res, url, body); });
}
async function handleSessionPrompt(req, res, url, body, received) {
  const sessionPrompt = /^\/session\/([^/]+)\/(prompt_async|message)$/.exec(url);
  SESSION_ID = sessionPrompt[1];
  recordSessionPrompt(body);
  const prepared = {};
  if (await preparePromptTurn(res, url, body, received, prepared)) return;
  await streamPrompt(url, body, prepared.silent);
}
async function handleRequestBody(req, res, url, body) {
  const prepared = prepareRequestBody(req, url, body);
  body = prepared.body;
  const route = bodyRoutes.find(([matches]) => matches(req, url));
  if (route) { await route[1](req, res, url, body, prepared.received); return; }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end('{}');
}
function prepareRequestBody(req, url, body) {
  if (process.env.CEZ_MOCK_ARGS_FILE) appendFileSync(process.env.CEZ_MOCK_ARGS_FILE, `${JSON.stringify({ method: req.method, url, body: body ? JSON.parse(body) : undefined })}\n`);
  // The delivery control also reads the prompt Squawk sent, before a nudge's scripted answer replaces it.
  if (req.method === 'POST' && /\/(prompt_async|message)$/.test(url)) body = withoutSessionContextBody(body);
  const received = body;
  if (req.method === 'POST' && /\/(prompt_async|message)$/.test(url)) body = answerNudgeBody(body);

  return { body, received };
}
function replyWithNewSession(req, res, url, body) {
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
function replyWithPatchedSession(req, res, url, body) {
  const sessionPatch = /^\/session\/([^/]+)$/.exec(url);
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
function replyWithSession(req, res, url, body) {
  const sessionGet = /^\/session\/([^/]+)$/.exec(url);
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
function replyToPermission(req, res, url, body) {
  const permissionReply = /^\/permission\/([^/]+)\/reply$/.exec(url);
  // The reply resumes the held turn, then its own session.idle ends it, as a question reply does.
  const id = decodeURIComponent(permissionReply[1]);
  const reply = body ? JSON.parse(body).reply : undefined;
  // P5: refuse the first answer; the ask stays pending, as a failed reply leaves it.
  if (failPermissionReplies > 0 && pendingPermissionAsks.has(id)) {
    failPermissionReplies -= 1;
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'mock: reply refused' }));
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end('true');
  if (pendingPermissionAsks.delete(id)) setTimeout(async () => {
    send({ type: 'permission.replied', properties: { sessionID: SESSION_ID, requestID: id, reply } });
    const text = await finishText(`Approval response: ${JSON.stringify({ reply })}`);
    send({ type: 'message.part.updated', properties: { part: {
      id: `prt_permission_${id}`, messageID: MESSAGE_ID, sessionID: SESSION_ID, type: 'text',
      text, time: { start: 1, end: 2 },
    } } });
    send({ type: 'session.idle', properties: { sessionID: SESSION_ID } });
  }, 30);
  return;
}
function replyToQuestion(req, res, url, body) {
  // Native question reply resumes the held turn, then its own session.idle
  // ends it (same SSE lifecycle shape as the baseline; never the HTTP ack).
  const answered = pendingQuestions.some(question => question.id === 'q_mock_1');
  pendingQuestions.length = 0;
  if (answered && url.endsWith('/reply')) setTimeout(async () => {
    const text = answerDone ? await finishText(`human answer: ${body}`) : `human answer: ${body}`;
    send({ type: 'message.part.updated', properties: { part: {
      id: 'prt_answer', messageID: MESSAGE_ID, sessionID: SESSION_ID, type: 'text', text,
    } } });
    // #505 review: CEZ_MOCK_OPENCODE_REPLY_HOLD_MS keeps the answered turn running.
    setTimeout(() => send({ type: 'session.idle', properties: { sessionID: SESSION_ID } }), Number(process.env.CEZ_MOCK_OPENCODE_REPLY_HOLD_MS ?? 0));
  }, 30);
  const acknowledge = () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); };
  if (lateQuestionReply) setTimeout(acknowledge, 250);
  else acknowledge();
  return;
}

async function replyWithSubagent(body) {
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
  setTimeout(async () => {
    const working = 'Still working after the sub-agent.' + await lifecycle((await tools()).wait('Re-check the sub-agent.'));
    send({ type: 'message.part.updated', properties: { part: {
      id: 'prt_mock_ptxt', messageID: MESSAGE_ID, sessionID: SESSION_ID,
      type: 'text', text: working,
      time: { start: 1760000009000, end: 1760000009200 },
    } } });
    // #149: foreign-session text after the parent's final text must stay v2-only.
    send({ type: 'message.part.updated', properties: { part: {
      id: 'prt_mock_late_child', messageID: 'msg_mock_late_child', sessionID: 'ses_mock_late_child',
      type: 'text', text: 'Child review finished.',
      time: { start: 1760000009200, end: 1760000009300 },
    } } });
    sendUsageThenIdle();
  }, 60);
  return;
}
async function replyWithSettledApproval(body) {
  // P3/P4: OpenCode settles the ask itself, or the turn ends around it, once the test releases it.
  const resolved = body.includes('mock:approval-resolved');
  send({ type: 'message.updated', properties: { info: info({}) } });
  sendPermissionAsk('per_mock_1', 'bash', ['git status --short'], ['git status *']);
  await waitForRelease();
  pendingPermissionAsks.delete('per_mock_1');
  if (resolved) send({ type: 'permission.replied', properties: { sessionID: SESSION_ID, requestID: 'per_mock_1', reply: 'once' } });
  textPart('prt_approval_settled', await finishText(resolved ? 'Native approval settled without a cockpit answer.'
    : 'Turn ended with the approval still pending.'));
  send({ type: 'session.idle', properties: { sessionID: SESSION_ID } });
  return;
}
async function replyWithFailedApprovalReply(body) {
  failPermissionReplies = 1;
  send({ type: 'message.updated', properties: { info: info({}) } });
  sendPermissionAsk('per_mock_1', 'bash', ['git status --short'], ['git status *']);
  return;
}
async function replyWithMalformedPermission(body) {
  // P6: `patterns` must be an array; Squawk rejects the ask by its id.
  send({ type: 'message.updated', properties: { info: info({}) } });
  pendingPermissionAsks.add('per_mock_bad');
  send({ type: 'permission.asked', properties: {
    id: 'per_mock_bad', sessionID: SESSION_ID, permission: 'bash', patterns: 'git status --short', metadata: {},
    always: ['git status *'], tool: { messageID: MESSAGE_ID, callID: 'call_mock_bash' },
  } });
  return;
}
async function replyWithClassifyingPermission(body) {
  classifyPending = true;
  send({ type: 'message.updated', properties: { info: info({}) } });
  sendPermissionAsk('per_mock_classify', 'bash', ['git status --short'], ['git status *']);
  return;
}
async function replyWithLatePermission(body) {
  // P8: the ask lands right after the idle, inside the runner's auto-end delay. As in real
  // OpenCode, it comes from a run the server started, which the answer resumes and its idle ends.
  send({ type: 'message.updated', properties: { info: info({}) } });
  textPart('prt_late_done', await finishText('The turn finished before the late request.'));
  send({ type: 'session.idle', properties: { sessionID: SESSION_ID } });
  sendPermissionAsk('per_mock_late', 'bash', ['git push'], ['git push *']);
  return;
}
async function replyWithDefaultPermission(body) {
  send({ type: 'message.updated', properties: { info: info({}) } });
  sendPermissionAsk('per_mock_default', 'external_directory', ['/outside/*'], ['/outside/*']);
  return;
}
async function replyWithApproval(body) {
  send({ type: 'message.updated', properties: { info: info({}) } });
  sendPermissionAsk('per_mock_1', 'bash', ['git status --short'], ['git status *']);
  return;
}
async function replyWithMalformedAsk(body) {
  // Malformed: `questions` is not an array, so the runner must REJECT the
  // native question and finish the turn rather than wait for an answer to
  // a card that can never render (#6's rejection path, harness parity R4).
  send({ type: 'message.updated', properties: { info: info({}) } });
  pendingQuestions.push({ id: 'q_mock_bad', sessionID: SESSION_ID });
  sendQuestionPart({ questions: 'not-an-array' });
  setTimeout(() => send({ type: 'session.idle', properties: { sessionID: SESSION_ID } }), 60);
  return;
}
async function replyWithAsk(body) {
  lateQuestionReply = body.includes('mock:ask-reply-late');
  answerDone = body.includes('mock:ask-reply-late-cezar-done') || body.includes('mock:resume-cezar-done');
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

/** The turn's usage, then the session goes idle. */
function sendUsageThenIdle() {
  send({ type: 'message.updated', properties: { info: info({
    cost: 0.0001, tokens: { input: 20, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
  }) } });
  setTimeout(() => send({ type: 'session.idle', properties: { sessionID: SESSION_ID } }), 30);
}

// #723: native GET /skill diagnostic captured on 1.18.33; upstream
// packages/opencode/src/skill/index.ts:96-111 skips the unreadable skill.
async function replyWithSkillWarning(body) {
  for (const root of ['.claude', '.agents']) send({ type: 'session.error', properties: {
    error: { name: 'UnknownError', data: { message: `Failed to parse skill /home/agent/${root}/skills/pen-design/SKILL.md` } },
  } });
  // hearsay-tools/cezarion#1265: unscoped FrontmatterError frame captured
  // from `opencode serve` 1.18.35 on 2026-10-18; upstream
  // skill/index.ts:105-116 skips the skill.
  send({ type: 'session.error', properties: { error: { name: 'UnknownError', data: { message: FRONTMATTER_ERROR } } } });
}
function replyWithFatalControl(body) {
  const fatalControl = Object.entries({
    'mock:scoped-skill-failure': { sessionID: SESSION_ID, message: 'Failed to parse skill /skills/required/SKILL.md' },
    'mock:scoped-frontmatter-failure': { sessionID: SESSION_ID, message: FRONTMATTER_ERROR },
    'mock:unscoped-provider-failure': { message: 'provider unavailable — retry after restoring service' },
  }).find(([marker]) => body.includes(marker))?.[1];
  if (fatalControl) {
    send({ type: 'session.error', properties: {
      ...(fatalControl.sessionID ? { sessionID: fatalControl.sessionID } : {}),
      error: { name: 'UnknownError', data: { message: fatalControl.message } },
    } });
    setTimeout(() => send({ type: 'session.idle', properties: { sessionID: SESSION_ID } }), 30);
    return true;
  }
  return false;
}
async function replyWithEarlyProviderError(body) {
  // #505 review: the provider rejects before any assistant message exists.
  send({ type: 'session.error', properties: { sessionID: SESSION_ID, error: { name: 'ProviderAuthError', data: { message: 'API key expired' } } } });
  setTimeout(() => send({ type: 'session.idle', properties: { sessionID: SESSION_ID } }), 30);
}
async function replyWithNativeFailure(body) {
  const selectedFailure = failureControl?.failureFor(body);
  const nativeFailure = selectedFailure instanceof Promise ? await selectedFailure : selectedFailure;
  if (failureControl ? nativeFailure === 'provider' : Boolean(scenarioAt(body, 'provider-error', false))) {
    send({ type: 'message.updated', properties: { info: info({}) } });
    sendProviderFailure();
    return true;
  }
  return false;
}
function replyWithOrdinaryTurn() {
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
  setImmediate(() => {
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
    setImmediate(() => send({ type: 'session.idle', properties: { sessionID: SESSION_ID } }));
  });
  return;
}
function recordSessionPrompt(body) {
  try {
    const text = body ? JSON.parse(body).parts?.map(part => part.text ?? '').join('\n') ?? '' : '';
    if (text) addPrompt(SESSION_ID, text);
  } catch {
    // Keep the scripted turn even when the body is not JSON.
  }
}
function deliveryPromptText(body, received) {
  // A configured control matches the prompt's text parts, never their JSON encoding.
  let deliveryText = body;
  // Both the prompt Squawk sent and a nudge's scripted answer match (hearsay-tools/cezarion#1525).
  const textOf = (raw) => JSON.parse(raw).parts.map(part => part.text ?? '').join('\n');
  if (delivery) try { deliveryText = received === body ? textOf(body) : `${textOf(received)}\n${textOf(body)}`; } catch { /* not a prompt body */ }
  return deliveryText;
}
async function acknowledgeSteer(body, res, deliveryText) {
  const text = JSON.parse(body).parts.map(part => part.text ?? '').join('\n');
  const userId = `msg_steer_user_${++steerSerial}`;
  const ackDelay = Number(process.env.CEZ_MOCK_OPENCODE_STEER_ACK_MS ?? 0);
  const ack = () => { res.writeHead(204); res.end(); };
  const acknowledge = () => { if (ackDelay > 0) setTimeout(ack, ackDelay); else ack(); };
  // Hold busy-input ACKs too; native consumption still streams (hearsay-tools/cezarion#2127).
  if (delivery) delivery.ack(deliveryText, acknowledge); else acknowledge();
  send({ type: 'message.updated', properties: { info: { id: userId, sessionID: SESSION_ID, role: 'user', time: { created: Date.now() } } } });
  send({ type: 'message.part.updated', properties: { part: { id: `prt_${userId}`, messageID: userId, sessionID: SESSION_ID, type: 'text', text } } });
  steers.push({ userId, text });
}
function acknowledgePrompt(res, body, deliveryText) {
  // `prompt_async` semantics: acknowledge now, stream the turn over SSE.
  res.writeHead(200, { 'content-type': 'application/json' });
  // #426: a nudged turn can finish on SSE before its HTTP acceptance arrives.
  // Force that ordering in the cap scenario; the first opening stays ordinary.
  if (autonomousCap && body.includes('Continue working autonomously until the task is fully complete.')) {
    setTimeout(() => res.end(JSON.stringify({ info: info({}), parts: [] })), 100);
  } else if (body.includes('f7-delay-ack')) {
    // F7: SSE turn-end before HTTP ACK so parkAfterAck applies the silent-tail nudge.
    setTimeout(() => res.end(JSON.stringify({ info: info({}), parts: [] })), 250);
  } else {
    const ack = () => res.end(JSON.stringify({ info: info({}), parts: [] }));
    if (delivery) delivery.ack(deliveryText, ack); else ack();
  }
}
function rejectsPrompt(body, deliveryText) {
  return delivery?.kind === 'reject' ? delivery.rejects(deliveryText) : body.includes('mock:reject-agent-post');
}

async function preparePromptTurn(res, url, body, received, prepared) {
  if (body.includes('mock:crash-stderr-pre-ack')) {
    const { crashWithStderr } = await import('./mock-runner-crash.mjs');
    crashWithStderr(body);
    return true;
  }
  const deliveryText = deliveryPromptText(body, received);
  // A configured rejection decides alone: it adds "once" and "until lifted" to the native token.
  if (rejectsPrompt(body, deliveryText)) {
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'agent prompt rejected' }));
    return true;
  }
  if (heldBeats && url.endsWith('/prompt_async')) { clearInterval(heldBeats); heldBeats = undefined; turnActive = false; }
  if (turnActive && url.endsWith('/prompt_async')) { await acknowledgeSteer(body, res, deliveryText); return true; }
  // A prompt posted while a follow-on run is due runs after it.
  if (followOn) await followOn;
  turnActive = true;
  acknowledgePrompt(res, body, deliveryText);
  if (delivery) await delivery.holdResponse(deliveryText);
  if (await playSlot(['ack-only'], url, body)) return true;
  if (scenarioAt(body, 'autonomous')?.variant) autonomousCap = true;
  const silent = scenarioAt(body, 'silent-tail');
  if (silent) {
    prepared.silent = await prepareSilentScenario(silent, url, body);
    if (!prepared.silent) return true;
  }
  return false;
}

const scenarioContext = {
  runner: 'opencode', lifecycle, session: {}, nativeFailureControl: Boolean(failureControl),
  // This token previously fell through to the ordinary reply; monitoring uses cezar-tool.
  unsupported: ['cezar-wait'],
  toolPrompt: async prompt => (await tools()).toolPrompt('opencode', JSON.parse(process.env.OPENCODE_CONFIG_CONTENT ?? '{}'), prompt),
  ciPrompt: async prompt => (await tools()).ciPrompt('opencode', JSON.parse(process.env.OPENCODE_CONFIG_CONTENT ?? '{}'), prompt),
  async crash(prompt) {
    const { crashWithStderr } = await import('./mock-runner-crash.mjs');
    if (prompt.includes('-clean')) crashWithStderr(prompt);
    else await new Promise(() => { setTimeout(() => crashWithStderr(prompt), 30); });
  },
};
function promptText(body) {
  try { return JSON.parse(body).parts.map(part => part.text ?? '').join('\n'); }
  catch { return body; }
}
function publishUser(url, body) {
  if (!url.endsWith('/prompt_async')) return;
  currentUserId = `msg_user_${++steerSerial}`;
  send({ type: 'message.updated', properties: { info: { id: currentUserId, sessionID: SESSION_ID, role: 'user', time: { created: Date.now() } } } });
  send({ type: 'message.part.updated', properties: { part: { id: `prt_${currentUserId}`, messageID: currentUserId, sessionID: SESSION_ID, type: 'text', text: promptText(body) } } });
}
function heartbeatHold() {
  heldBeats = setInterval(() => { if (sse) sse.write(': heartbeat\n\n'); }, 50);
  heldBeats.unref?.();
}
const TEXT_IDS = {
  'cezar-tool': 'tool-result', 'ci-wait': 'ci-result', 'multi-pr-refs': 'multi-message',
  'hold-cezar-done': 'prt_mock_hold_done', 'cezar-done': 'prt_mock_done',
  'hold-cezar-ask': 'prt_mock_hold_ask', 'cezar-ask': 'prt_mock_hold_ask',
  'hold-gated': 'prt_mock_hold_gated', hold: 'prt_mock_hold', 'busy-progress': 'prt_busy_done',
  'steer-late': 'prt_steer_late', 'subagent-after-park': 'park-parent',
};
/** Wire ids, SSE framing, usage, idle scheduling and steering remain native. */
function scenarioEncoder(scenario, url, body) {
  const name = scenario?.name;
  const nudge = silentNudge(promptText(body));
  let textIndex = 0;
  let opened = false;
  const encoder = {
    closeInput: () => { inputClosed = true; },
    open(step) {
      if (step.ackOnly) {
        if (name === 'ack-only') heartbeatHold();
        if (nudge && isAckOnlyNudge(promptText(body))) {
          const beats = setInterval(() => { if (sse) sse.write(': heartbeat\n\n'); }, 50);
          beats.unref?.();
        }
        return;
      }
      if (name === 'deferred-turn-start') { publishUser(url, body); return; }
      if (opened) return;
      opened = true;
      if (!['ci-wait', 'no-progress', 'busy-progress'].includes(name)) send({ type: 'message.updated', properties: { info: info({}) } });
    },
    reply: () => replyWithOrdinaryTurn(),
    text(step) {
      if (name === 'busy-progress') send({ type: 'message.updated', properties: { info: info({}) } });
      const id = scenarioTextId(name, textIndex++, nudge);
      const timed = !['agent-echo', 'ci-wait', 'hold', 'hold-gated'].includes(name);
      let text = '';
      for (const [index, part] of step.parts.entries()) {
        text += part;
        send({ type: 'message.part.updated', properties: { part: {
          id, messageID: MESSAGE_ID, sessionID: SESSION_ID, type: 'text', text,
          ...(timed && index === step.parts.length - 1 ? { time: scenarioTextTime(name) } : {}),
        } } });
      }
    },
    reasoning(step) {
      send({ type: 'message.part.updated', properties: { part: {
        id: name === 'multi-pr-refs' ? 'multi-reasoning' : nudge ? 'silent-nudge-rsn' : 'silent-rsn',
        messageID: MESSAGE_ID, sessionID: SESSION_ID, type: 'reasoning', text: step.text,
        ...(name === 'multi-pr-refs' ? {} : { time: { start: 1, end: 2 } }),
      } } });
    },
    toolStart({ call }) {
      // These native fixtures report completed snapshots, not a running transition.
      if (['multi-pr-refs', 'silent-tail'].includes(name)) return;
      if (name === 'subagent-after-park' && call.name === 'task') {
        send({ type: 'message.part.updated', properties: { part: { id: 'park-task', messageID: MESSAGE_ID, sessionID: SESSION_ID, type: 'subtask', prompt: 'Review', description: 'Review', agent: 'general' } } });
        return;
      }
      scenarioToolPart(name, call, 'running');
    },
    toolEnd({ call }) {
      if (name === 'subagent-after-park' && call.name === 'task') return;
      scenarioToolPart(name, call, 'completed');
    },
    child: (step, playChild) => playScenarioChild(step, playChild, encoder),
    progress: () => send({ type: 'server.heartbeat', properties: {} }),
    readSteers(step) { if (step.late) turnLate = true; },
    end(step) {
      if (step.error) { sendProviderFailure(step.error); return; }
      if (['hold', 'hold-gated', 'hold-cezar-ask', 'hold-cezar-done', 'cezar-ask', 'cezar-done'].includes(name)) sendUsageThenIdle();
      else {
        if (name === 'busy-progress') send({ type: 'message.updated', properties: { info: info({ cost: 0.0001, tokens: { input: 20, output: 10, reasoning: 0, cache: { read: 0, write: 0 } } }) } });
        send({ type: 'session.idle', properties: { sessionID: SESSION_ID } });
      }
    },
  };
  return encoder;
}
function scenarioTextTime(name) {
  if (['cezar-ask', 'cezar-done', 'hold-cezar-ask', 'hold-cezar-done'].includes(name)) return { start: 1760000000500, end: 1760000000600 };
  if (name === 'steer-late') return { start: 1760000000000, end: 1760000000001 };
  return { start: 1, end: 2 };
}
function scenarioTextId(name, index, nudge) {
  if (name === 'turn-messages') return `prt_multi_${++echoSerial}`;
  if (name === 'agent-echo') return `prt_echo_${++echoSerial}`;
  if (name === 'autonomous') return `autonomous-${++autonomousTurn}`;
  if (name === 'silent-tail') return nudge ? (index === 0 && finalMessageNudgeKind() === 'slow-done' ? 'silent-nudge-prefix' : 'silent-nudge-done') : 'silent-open';
  return TEXT_IDS[name] ?? `prt_scenario_${index}`;
}
function scenarioToolPart(name, call, status) {
  const ids = {
    'multi-pr-refs': ['multi-tool', 'multi-read'], 'silent-tail': ['silent-gh', 'call_silent_gh'],
    'steer-tool': ['prt_steer_tool', 'call_steer'],
  };
  const [id, callID] = ids[name] ?? [call.id, call.id];
  send({ type: 'message.part.updated', properties: { part: {
    id, messageID: MESSAGE_ID, sessionID: SESSION_ID, type: 'tool',
    ...(name === 'multi-pr-refs' ? { tool: call.name, callID } : { callID, tool: call.name }),
    state: { status, input: name === 'multi-pr-refs' ? { filePath: call.input.path } : call.input, ...(status === 'completed' ? { output: call.output } : {}),
      ...(['multi-pr-refs', 'silent-tail'].includes(name) ? { time: { start: 1, end: 2 } } : {}) },
  } } });
}
function playScenarioChild(step, playChild, encoder) {
  if (step.phase === 'start') send({ type: 'message.updated', properties: { info: { ...info({}), id: 'park-child-msg', sessionID: 'park-child', parentID: SESSION_ID, mode: 'subagent' } } });
  const part = ({ id, ...value }) => send({ type: 'message.part.updated', properties: { part: { id, messageID: 'park-child-msg', sessionID: 'park-child', ...value } } });
  const result = playChild({ ...encoder,
    text: value => part({ id: step.phase === 'start' ? 'early-child' : 'late-child-text', type: 'text', text: value.parts.join(''), time: step.phase === 'start' ? { start: 1, end: 2 } : { start: 3, end: 4 } }),
    toolStart: ({ call }) => part({ id: 'late-read', type: 'tool', tool: call.name, state: { status: 'running', input: call.input } }),
    toolEnd: ({ call }) => part({ id: 'late-read', type: 'tool', tool: call.name, state: { status: 'completed', input: call.input, output: call.output } }),
  });
  // Barrier snapshot proves late child frames reached the real runner after park.
  const barrier = () => { if (step.phase === 'end') send({ type: 'message.updated', properties: { info: info({ tokens: { input: 424240, output: 2, reasoning: 0, cache: { read: 0, write: 0 } } }) } }); };
  if (result instanceof Promise) return result.then(barrier);
  barrier();
}
function sendProviderFailure(kind = 'provider', [statusCode, message] = OPENCODE_FAILURES[kind]) {
  // A failed model call never reads steers queued behind its opening prompt.
  turnLate = true;
  send({ type: 'message.part.updated', properties: { part: { id: 'prt_mock_perr', messageID: MESSAGE_ID, sessionID: SESSION_ID, type: 'text', text: 'Starting the review' } } });
  send({ type: 'session.error', properties: { sessionID: SESSION_ID, error: { name: 'APIError', data: { message, statusCode, isRetryable: statusCode !== 400 } } } });
  setTimeout(() => send({ type: 'session.idle', properties: { sessionID: SESSION_ID } }), 30);
}

/** Play only preparation before the first assistant opening; retain its remaining steps. */
async function prepareSilentScenario(scenario, url, body) {
  const iterator = scenario.steps[Symbol.iterator]();
  let remaining;
  function* preparation() {
    for (let next = iterator.next(); !next.done; next = iterator.next()) {
      if (next.value.kind === 'open' && !next.value.ackOnly) {
        const first = next.value;
        remaining = { ...scenario, steps: (function* () { yield first; yield* iterator; })() };
        return;
      }
      yield next.value;
    }
  }
  await play({ steps: preparation() }, scenarioEncoder(scenario, url, body));
  return remaining;
}
/** Select a shared descriptor for one native dispatch slot, without copying token matches. */
function scenarioAt(body, name, nativeFailureControl = Boolean(failureControl)) {
  const unsupported = [...scenarioContext.unsupported];
  for (;;) {
    const selected = scenarioFor(promptText(body), { ...scenarioContext, unsupported, nativeFailureControl });
    if (!selected || selected.name === name) return selected;
    unsupported.push(selected.name);
  }
}
async function playSlot(names, url, body) {
  for (const name of names) {
    const selected = scenarioAt(body, name);
    if (selected && await play(selected, scenarioEncoder(selected, url, body)) === 'handled') return true;
  }
  return false;
}
async function dispatchNativeReply(body) {
  if (body.includes('mock:skill-warning')) await replyWithSkillWarning(body);
  if (replyWithFatalControl(body)) return true;
  if (body.includes('mock:provider-error-early')) { await replyWithEarlyProviderError(body); return true; }
  return replyWithNativeFailure(body);
}
async function streamPrompt(url, body, silent) {
  const deferred = scenarioAt(body, 'deferred-turn-start');
  if (deferred) {
    // This descriptor supplies the delay; native dispatch still decides the reply.
    await play(deferred, { ...scenarioEncoder(deferred, url, body), open() {}, reply() {} });
  }
  publishUser(url, body);
  if (await playSlot(['crash-stderr'], url, body)) return;
  if (await playSlot(['steer-tool', 'steer-late', 'cezar-tool', 'ci-wait', 'multi-pr-refs', 'turn-messages', 'agent-echo', 'subagent-after-park'], url, body)) return;
  if (body.includes('mock:subagent')) { await replyWithSubagent(body); return; }
  if (await dispatchNativeReply(body)) return;
  if (await playSlot([...PROVIDER_HOLD_SCENARIOS.map(([name]) => name), 'autonomous'], url, body)) return;
  if (silent && await play(silent, scenarioEncoder(silent, url, body)) === 'handled') return;
  if (await dispatchReply(nativeReplies, body)) return;
  if (await playSlot(['hold-cezar-done', 'cezar-done', 'hold-cezar-ask', 'cezar-ask', 'no-progress', 'busy-progress', 'hold-gated', 'hold'], url, body)) return;
  replyWithOrdinaryTurn();
}

// Test sessions share a host: let the OS allocate a port instead of racing
// the runner’s random requested port against other fixtures.
server.listen(0, hostname, () => {
  // The runner reads the bound URL back from stdout, like the real server.
  console.log(`opencode server listening on http://${hostname}:${server.address().port}`);
});
// hearsay-tools/cezarion#1449: the server leads its own session, so a test process that dies
// before its cleanup leaves it running. The runner never writes to or closes this stdin pipe,
// so end of input means the parent died (SIGKILL included). Exit directly, past any SIGTERM
// handler a shutdown scenario replaced.
process.stdin.on('end', () => process.exit(0));
process.stdin.resume();
process.on('SIGTERM', () => process.exit(0));
