#!/usr/bin/env node
// Load only when configured: ordinary mock turns retain their event-loop ordering.
const failureControl = process.env.CEZ_MOCK_FAILURE_CONTROL === undefined ? undefined
  : (await import('./mock-failure-control.mjs')).readFailureControl();
const delivery = process.env.CEZ_MOCK_DELIVERY_CONTROL === undefined ? undefined
  : (await import('./mock-delivery-control.mjs')).readDeliveryControl(['reject', 'hold-ack', 'hold-response']);
// Keep this fixture standalone: lifecycle tests copy the runner into a temp directory.
import { spawn as watchdogSpawn } from 'node:child_process';
import { closeSync as watchdogCloseInput, renameSync as watchdogRename, writeFileSync as watchdogWrite } from 'node:fs';
// Publish a pid atomically (temporary sibling, then rename): a test reading it sees no
// file or a whole pid, never the empty file whose Number() is 0 (hearsay-tools/cezarion#953).
function watchdogWritePid(file, pid) { const tmp = `${file}.${process.pid}.tmp`; watchdogWrite(tmp, pid); watchdogRename(tmp, file); }
function watchdogStall(prompt) {
  if (!prompt.includes('mock:no-progress')) return false;
  if (prompt.includes('input-closed')) {
    watchdogCloseInput(0);
    watchdogWritePid('input-closed.pid', String(process.pid));
    setTimeout(() => process.exit(0), 300);
  }
  if (prompt.includes('ignore-term')) {
    process.removeAllListeners('SIGTERM');
    process.on('SIGTERM', () => {});
    // Test-cleanup backstop, deliberately longer than the asserted teardown bound.
    setTimeout(() => process.exit(0), 12_000);
  }
  if (prompt.includes('held-pipe')) {
    watchdogSpawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { stdio: ['ignore', process.stdout, process.stderr] });
  }
  if (prompt.includes('leftover')) {
    // hearsay-tools/cezarion#890: one child stays in the session's process group and ignores
    // SIGTERM; one leaves the group with setsid. Both exit on their own as a cleanup backstop.
    const leftover = (file) => `process.on('SIGTERM',()=>{}); const fs = require('fs'); fs.writeFileSync(${JSON.stringify(`${file}.tmp`)}, String(process.pid)); fs.renameSync(${JSON.stringify(`${file}.tmp`)}, ${JSON.stringify(file)}); setTimeout(()=>{},20000)`;
    watchdogSpawn(process.execPath, ['-e', leftover('leftover-group.pid')], { stdio: 'ignore' });
    watchdogSpawn(process.execPath, ['-e', leftover('leftover-session.pid')], { stdio: 'ignore', detached: true }).unref();
  }
  // Publish readiness after mode setup: another process may signal us as soon as it sees it.
  watchdogWritePid('watchdog.pid', String(process.pid));
  return true;
}

// Bundled dry-run mock of `codex app-server` — speaks just enough JSON-RPC 2.0
// JSONL (§3 of agent-event-protocols.md) for the runner wiring test in
// `codex-ui-mapper.test.ts`: initialize/thread/turn handshake, one scripted
// turn with an agentMessage + a commandExecution (with live outputDelta),
// cumulative token usage, then exits on stdin EOF like the real server.
//
// `MOCK_CODEX_IGNORE_EOF=1` switches to the #703 teardown shape instead: the
// server stays deaf to stdin EOF (the CLI hang the EOF watchdog exists for)
// and handles SIGTERM itself, exiting 143 rather than dying from the signal.
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
// Dynamic, like every sibling import here, so a test's copy of this mock can repoint it.
const { answerNudge, silentNudge } = await import('./mock-nudge.mjs');

import * as parityGateFs from 'node:fs';
import { withoutSessionContextParts } from './mock-session-context.mjs';

// #401: let the test observe the actual monitoring park before releasing late wire frames.
async function afterParityPark(prompt) {
  const gate = /parity-release=([^\s"\\]+)/.exec(prompt)?.[1];
  if (!gate) throw new Error('post-park scenario requires a release path');
  while (!parityGateFs.existsSync(gate)) await new Promise(resolve => setTimeout(resolve, 10));
}

const write = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
// #505: like the real app-server, any active main-thread turn accepts `turn/steer`.
// Steers accepted by an ordinary scripted turn are read just before it completes:
// a userMessage item (echoing clientUserMessageId as clientId) and an echo reply.
let autonomousTurn = 0;
let activeTurnId = null;
let heldTurn = false;
let pendingSteers = [];
let steerEchoSerial = 0;
const emit = (obj) => {
  const ending = (obj.method === 'turn/completed' || obj.method === 'turn/failed') && (!obj.params?.threadId || obj.params.threadId === 'th_mock_1');
  // #486 review: CEZ_MOCK_CODEX_NO_STEER_ECHO=1 admits the steer (RPC result) but never
  // echoes its userMessage, so an accepted-but-unread follow-up can complete the turn.
  if (ending && obj.method === 'turn/completed' && pendingSteers.length && process.env.CEZ_MOCK_CODEX_NO_STEER_ECHO !== '1') {
    const turnId = activeTurnId ?? 'turn_mock_1';
    for (const entry of pendingSteers.splice(0)) {
      const item = { type: 'userMessage', id: `item_user_generic_${++steerEchoSerial}`, clientId: entry.clientId, content: [{ type: 'text', text: entry.text }] };
      write({ method: 'item/started', params: { threadId: 'th_mock_1', turnId, item } });
      write({ method: 'item/completed', params: { threadId: 'th_mock_1', turnId, item } });
      write({ method: 'item/completed', params: { threadId: 'th_mock_1', turnId, item: { type: 'agentMessage', id: `item_steer_echo_${steerEchoSerial}`, text: entry.text } } });
    }
  }
  if (ending) { activeTurnId = null; pendingSteers = []; heldTurn = false; }
  write(obj);
  // #505 review: CEZ_MOCK_CODEX_LATE_START_ACK=1 answers turn/start after the turn completed.
  if (ending && lateStartAck !== undefined) { const id = lateStartAck; lateStartAck = undefined; write({ id, result: { turn: { id: 'turn_mock_1' } } }); }
};
let lateStartAck;
let startSerial = 0;
let resumeAfterAsk = false;
let pendingApprovalTurn;
const rl = createInterface({ input: process.stdin });
let echoSerial = 0;
let ciWire;
// hearsay-tools/cezarion#1294: Codex 0.160.1 asks before an MCP tool call with an
// `mcpServer/elicitation/request` (codex-rs/core/src/mcp_tool_call.rs). The client
// answers `{ action, content, _meta }`; an error reply rejects the call.
const mcpToolApprovalRequest = (serverName, tool, overrides = {}) => ({
  threadId: 'th_mock_1', turnId: 'turn_mock_1', serverName, mode: 'form',
  _meta: { codex_approval_kind: 'mcp_tool_call', persist: ['session', 'always'], tool_description: `Mock ${tool} tool.`,
    tool_params: { query: 'cezar' }, tool_params_display: [{ name: 'query', value: 'cezar', display_name: 'query' }] },
  message: `Allow the ${serverName} MCP server to run tool "${tool}"?`,
  requestedSchema: { type: 'object', properties: {} }, ...overrides,
});
const cezarServer = () => Object.entries(ciWire?.config ?? {}).find(([key]) => key.startsWith('mcp_servers.cezar_ci_'));
const clientReplies = new Map();
const requestClient = (id, method, params) => new Promise((resolve) => { clientReplies.set(id, resolve); emit({ id, method, params }); });
let mcpGateSerial = 0;
// Codex gates every MCP tool call by the server's (or tool's) approval mode and asks
// unless it is `approve`, whatever `approval_policy` says.
async function mcpToolGate(tool) {
  const [key, server] = cezarServer() ?? [];
  if (!server || server.default_tools_approval_mode === 'approve') return true;
  const reply = await requestClient(`mcp-gate-${++mcpGateSerial}`, 'mcpServer/elicitation/request',
    mcpToolApprovalRequest(key.slice('mcp_servers.'.length), tool));
  return reply.result?.action === 'accept';
}
// hearsay-tools/cezarion#2397: a reply that finishes, asks or waits calls that cezar tool over
// the thread's MCP config (behind Codex's approval gate) before its turn ends. Returns '' or a
// note for the text.
const tools = () => import('./mock-ci-tool.mjs');
async function lifecycle([name, args]) {
  if (!await mcpToolGate(name)) return `\n\n(mock: ${name} rejected)`;
  return (await tools()).lifecycleCall('codex', ciWire, name, args);
}
// #505 steering scenarios: the one turn that accepts `turn/steer`, while it is open.
let steerTurn = null;
let steerSerial = 0;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitForMockRelease(fallbackMs, suffix = '') {
  const release = process.env.CEZ_MOCK_RELEASE_FILE;
  const file = release && `${release}${suffix}`;
  if (!file) { if (fallbackMs) await sleep(fallbackMs); return; }
  const deadline = Date.now() + 15_000;
  while (!parityGateFs.existsSync(file)) {
    if (Date.now() > deadline) throw new Error('CEZ_MOCK_RELEASE_FILE was not created');
    await sleep(10);
  }
}
const completeSteerTurn = (turnId) => {
  steerTurn = null;
  emit({ method: 'turn/completed', params: { threadId: 'th_mock_1', turn: { id: turnId, status: 'completed' } } });
};

// #708: requirements shape from Codex's generated ConfigRequirementsReadResponse.
// Retain an invalid requested override to reproduce fallback warnings on later turns.
const managedRequirements = process.env.MOCK_CODEX_REQUIREMENTS
  ? JSON.parse(process.env.MOCK_CODEX_REQUIREMENTS) : null;
let rejectedPermissionOverride = false;
const permissionWarning = () => emit({ method: 'warning', params: { message:
  "Configured value for 'permission_profile' is disallowed by requirements; falling back to required value Managed. DangerFullAccess is not in the allowed set [ReadOnly, WorkspaceWrite]",
} });
const ignoreEof = process.env.MOCK_CODEX_IGNORE_EOF === '1';
if (ignoreEof) {
  process.on('SIGTERM', () => process.exit(143));
  // Keep the event loop alive so EOF alone can never end the process.
  setInterval(() => {}, 60_000);
}

// Matcher order is scenario priority; terminal replies return without an extra await.
const messageReplies = [
  [msg => msg.id === 'ask-bad-1' && msg.error, replyToMalformedAsk],
  [msg => msg.id === 'ask-1' && msg.result, replyToAsk],
  [msg => msg.method === 'turn/steer', handleSteer],
  [msg => msg.method === 'initialize', replyToInitialize],
  [msg => msg.method === 'configRequirements/read', replyWithRequirements],
  [msg => msg.method === 'thread/start' || msg.method === 'thread/resume', handleThread],
  [msg => msg.method === 'turn/start', handleTurnStart],
];
const openingReplies = [
  [turnText => turnText.includes('mock:autonomous') || turnText.startsWith('Continue working autonomously until the task is fully complete.'), replyAutonomously],
  [turnText => turnText.includes('mock:silent-tail') || turnText.includes('mock:tool-tail') || silentNudge(turnText), replyWithSilentTail],
];
const afterSilentReplies = [
  [turnText => turnText.includes('mock:hook-after-park'), replyWithParkedHook],
  [turnText => turnText.includes('mock:subagent-after-park'), replyWithParkedSubagent],
  [turnText => turnText.includes('mock:multi-pr-refs'), replyWithMultiplePrs],
  [turnText => turnText.includes('mock:turn-messages:'), replyWithTurnMessages],
  [turnText => turnText.includes('mock:cezar-tool'), replyWithCezarTool],
  [turnText => turnText.includes('mock:ci-wait'), replyWithCiWait],
  [turnText => ['mock:steer-tool', 'mock:steer-late', 'mock:steer-race', 'mock:steer-strand'].find((marker) => turnText.includes(marker)), replyWithSteering],
  [turnText => turnText.includes('mock:agent-echo'), replyWithEcho],
  [turnText => turnText.includes('mock:ask-bad'), replyWithMalformedAsk],
  [turnText => turnText.includes('mock:hold-cezar-done'), replyWithHeldDone],
  [turnText => turnText.includes('mock:hold-cezar-ask'), replyWithHeldAsk],
  [turnText => turnText.includes('mock:cezar-done'), replyWithDone],
  [turnText => turnText.includes('mock:cezar-ask'), replyWithCezarAsk],
  [turnText => watchdogStall(turnText), acknowledgeWatchdog],
  [turnText => turnText.includes('mock:busy-progress'), replyWithBusyProgress],
  [turnText => turnText.includes('mock:hold-gated'), replyWithGatedHold],
  [turnText => turnText.includes('mock:hold'), replyWithHold],
  [turnText => turnText.includes('mock:stream-retry'), replyWithStreamRetry],
];
// These scenarios follow native failure selection, as in the original line handler.
const lateReplies = [
  [turnText => turnText.includes('mock:turn-failed'), replyWithFailedTurn],
  [turnText => turnText.includes('mock:subagent-activity'), replyWithSubagentActivity],
  [turnText => turnText.includes('mock:child-turn'), replyWithChildTurn],
  [turnText => /mock:mcp-approval(?:-(own|form|null-turn))?/.exec(turnText), replyWithMcpApproval],
  [turnText => turnText.includes('mock:approval'), replyWithApproval],
  [turnText => process.env.MOCK_CODEX_ASK === '1' || turnText.includes('mock:native-codex-ask'), replyWithAsk],
];

function dispatchAfterSilent(turnText, msg) {
  return dispatchScenario(afterSilentReplies, turnText, msg, handleNativeFailure);
}

function dispatchScenario(replies, turnText, msg, fallback) {
  for (const [matches, reply] of replies) {
    const match = matches(turnText);
    if (match) return reply(turnText, msg, match);
  }
  return fallback(turnText, msg);
}

async function handleLine(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (process.env.CEZ_MOCK_ARGS_FILE) appendFileSync(process.env.CEZ_MOCK_ARGS_FILE, `${JSON.stringify(msg)}\n`);
  if (Array.isArray(msg.params?.input)) msg.params.input = withoutSessionContextParts(msg.params.input);
  if (clientReplies.has(msg.id) && (msg.result || msg.error)) return resolveClientRequest(msg);
  if ((msg.id === 'approval-1' || msg.id === 'approval-unsupported-1' || msg.id === 'mcp-approval-1') && pendingApprovalTurn && (msg.result || msg.error)) return replyToApproval(msg);
  const route = messageReplies.find(([matches]) => matches(msg));
  if (route) return route[1](msg);
}

rl.on('line', handleLine);

function replyToMalformedAsk(msg) {
  // The runner rejected the malformed payload with -32602, as it must. A real
  // app-server carries on from there, so the turn still completes — a mock
  // that went silent here would make harness parity R4 pass by hanging
  // instead of by ending the turn.
  emit({ method: 'turn/completed', params: { turn: { id: 'turn_mock_1', status: 'completed' } } });
}

async function replyToAsk(msg) {
  const answer = msg.result.answers?.library?.answers;
  const freeText = msg.result.answers?.first?.answers;
  if (resumeAfterAsk && Array.isArray(answer) && answer[0] === 'Vitest') {
    resumeAfterAsk = false;
    const text = 'Implemented the choice.' + await lifecycle((await tools()).DONE);
    emit({ method: 'item/started', params: { threadId: 'th_mock_1', turnId: 'turn_mock_1', item: { type: 'agentMessage', id: 'item_answer', text: '' } } });
    emit({ method: 'item/agentMessage/delta', params: { threadId: 'th_mock_1', turnId: 'turn_mock_1', itemId: 'item_answer', delta: text } });
    emit({ method: 'item/completed', params: { threadId: 'th_mock_1', turnId: 'turn_mock_1', item: { type: 'agentMessage', id: 'item_answer', text } } });
  }
  completeAskedTurn(answer, freeText);
}

function completeAskedTurn(answer, freeText) {
  emit((Array.isArray(answer) && answer[0] === 'Vitest') || (Array.isArray(freeText) && freeText[0] === 'Use sensible defaults')
    ? { method: 'turn/completed', params: { turn: { id: 'turn_mock_1', status: 'completed' } } }
    : { method: 'turn/failed', params: { turn: { id: 'turn_mock_1', status: 'failed' }, error: { message: 'bad answer' } } });
}

function handleSteer(msg) {
  // #505 ambiguity: the transport dies with the steer unanswered.
  if (process.env.CEZ_MOCK_CODEX_EXIT_ON_STEER === '1') process.exit(1);
  const turn = steerTurn;
  // A held `mock:ack-only` turn runs the steered input as its own (hearsay-tools/cezarion#1301).
  if (isHeldSteer(msg)) {
    heldTurn = false;
    emit({ id: msg.id, result: {} });
    rl.emit('line', JSON.stringify({ ...msg, method: 'turn/start', mockHeldSteer: true }));
    return;
  }
  if (canQueueSteer(msg, turn)) {
    queueSteer(msg);
    emit({ id: msg.id, result: {} });
    return;
  }
  if (!turn || msg.params?.expectedTurnId !== turn.id) {
    emit({ id: msg.id, error: { code: -32600, message: 'no active turn matching expectedTurnId' } });
    return;
  }
  const text = steerText(msg);
  if (turn.strand) {
    // The turn completes first, then the server acknowledges the steer: nothing reads it.
    completeSteerTurn(turn.id);
    emit({ id: msg.id, result: {} });
    return;
  }
  if (turn.race) {
    // The turn ends before the server processes the steer: a definitive mismatch.
    completeSteerTurn(turn.id);
    emit({ id: msg.id, error: { code: -32600, message: 'no active turn matching expectedTurnId' } });
    return;
  }
  turn.steered.push({ clientId: msg.params?.clientUserMessageId ?? null, text });
  emit({ id: msg.id, result: {} });
}

function isHeldSteer(msg) {
  return heldTurn && activeTurnId && msg.params?.expectedTurnId === activeTurnId;
}

function canQueueSteer(msg, turn) {
  return !turn && activeTurnId && msg.params?.expectedTurnId === activeTurnId;
}

function queueSteer(msg) {
  pendingSteers.push({ clientId: msg.params?.clientUserMessageId ?? null, text: queuedSteerText(msg) });
}

function queuedSteerText(msg) {
  return msg.params?.input?.map?.((part) => part.text ?? '').join('\n') ?? '';
}

function steerText(msg) {
  return msg.params?.input?.map?.((part) => part.text ?? '').join('\n') ?? '';
}

function replyToInitialize(msg) {
  emit({ id: msg.id, result: { userAgent: 'mock-codex/0.0.0' } });
}

function replyWithRequirements(msg) {
  if (process.env.MOCK_CODEX_REQUIREMENTS_ERROR) {
    emit({ id: msg.id, error: { code: -32601, message: 'Method not found' } });
  } else {
    emit({ id: msg.id, result: process.env.MOCK_CODEX_REQUIREMENTS_MALFORMED
      ? { requirements: 'invalid' } : { requirements: managedRequirements } });
  }
}

async function handleThread(msg) {
  if (process.env.CEZ_MOCK_CI_PR) { const { probeCiTool } = await import('./mock-ci-tool.mjs'); await probeCiTool('codex', msg.params); }
  ciWire = msg.params;
  const expectedSandbox = process.env.CEZ_CODEX_NETWORK === '0' ? 'workspace-write' : 'danger-full-access';
  rejectedPermissionOverride = managedRequirements !== null && msg.params?.sandbox !== undefined;
  if (rejectedPermissionOverride) permissionWarning();
  if (rejectThreadPermissions(msg, expectedSandbox)) return;
  if (process.argv.includes('sandbox_workspace_write.network_access=true')) {
    emit({ id: msg.id, error: { code: -32602, message: 'workspace-write override is obsolete in full-access mode' } });
    return;
  }
  // Codex retains an allowed persisted profile unless the client explicitly
  // selects another (thread_processor::load_and_apply_persisted_resume_metadata).
  if (msg.method === 'thread/resume' && process.env.MOCK_CODEX_PERSISTED_PROFILE === ':read-only' && msg.params?.permissions && msg.params.permissions !== ':read-only') {
    emit({ id: msg.id, error: { code: -32602, message: 'client widened a persisted read-only profile' } });
    return;
  }
  const sandbox = threadSandbox(msg);
  if (msg.method === 'thread/start') {
    emit({ method: 'thread/started', params: { thread: { id: 'th_mock_1' } } });
    emit({ id: msg.id, result: { thread: { id: 'th_mock_1' }, sandbox } });
  } else if (process.env.MOCK_CODEX_REJECT_RESUME === '1') {
    emit({ id: msg.id, error: { code: -32603, message: `no rollout found for thread id ${msg.params?.threadId ?? ''}` } });
    rl.close();
  } else {
    emit({ id: msg.id, result: { thread: { id: msg.params?.threadId }, sandbox } });
  }
}

function rejectThreadPermissions(msg, expectedSandbox) {
  const unknownRequirements = process.env.MOCK_CODEX_REQUIREMENTS_ERROR || process.env.MOCK_CODEX_REQUIREMENTS_MALFORMED;
  if ((!managedRequirements && !unknownRequirements && msg.params?.sandbox !== expectedSandbox) || msg.params?.approvalPolicy !== undefined) {
    emit({ id: msg.id, error: { code: -32602, message: `expected ${expectedSandbox} managed permissions` } });
    return true;
  }
  return false;
}

function threadSandbox(msg) {
  return managedRequirements
    ? { type: 'readOnly', networkAccess: process.env.MOCK_CODEX_MANAGED_NETWORK === '1' }
    : msg.params?.sandbox === 'danger-full-access' ? { type: 'dangerFullAccess' }
    : { type: 'workspaceWrite', networkAccess: false, writableRoots: [], excludeTmpdirEnvVar: false, excludeSlashTmp: false };
}

async function replyAutonomously(turnText, msg) {
  const { autonomousReply } = await import('./mock-autonomous.mjs');
  emit({ method: 'item/completed', params: { threadId: 'th_mock_1', turnId: 'turn_mock_1', item: { type: 'agentMessage', id: `autonomous-${++autonomousTurn}`, text: await autonomousReply(turnText, lifecycle) } } });
  emit({ method: 'turn/completed', params: { threadId: 'th_mock_1', turn: { id: 'turn_mock_1', status: 'completed' } } });
  return;
}

async function replyWithSilentTail(turnText, msg) {
  const silent = await import('./mock-silent-tail.mjs');
  silent.noteSilentTailPrompt(turnText);
  if (silent.isFinalMessageNudge(turnText)) {
    return replyWithFinalMessageNudge(silent);
  }
  if (silent.isSilentTailScenario(turnText)) {
    emit({ method: 'item/completed', params: { threadId: 'th_mock_1', turnId: 'turn_mock_1', item: { type: 'agentMessage', id: 'silent-open', text: silent.SILENT_TAIL_OPENING } } });
    emit({ method: 'item/completed', params: { threadId: 'th_mock_1', turnId: 'turn_mock_1', item: { type: 'commandExecution', id: 'silent-gh', command: ['bash', '-lc', 'gh issue create'], cwd: '/repo', status: 'completed', exitCode: 0 } } });
    emit({ method: 'item/completed', params: { threadId: 'th_mock_1', turnId: 'turn_mock_1', item: { type: 'reasoning', id: 'silent-rsn', summary: silent.SILENT_TAIL_REASONING, content: silent.SILENT_TAIL_REASONING } } });
    emit({ method: 'turn/completed', params: { threadId: 'th_mock_1', turn: { id: 'turn_mock_1', status: 'completed' } } });
    return;
  }
  if (silent.isToolTailScenario(turnText)) {
    emit({ method: 'item/completed', params: { threadId: 'th_mock_1', turnId: 'turn_mock_1', item: { type: 'agentMessage', id: 'tool-tail-open', text: silent.TOOL_TAIL_OPENING } } });
    emit({ method: 'item/completed', params: { threadId: 'th_mock_1', turnId: 'turn_mock_1', item: { type: 'commandExecution', id: 'tool-tail-git', command: ['bash', '-lc', 'git status --short'], cwd: '/repo', status: 'completed', exitCode: 0 } } });
    emit({ method: 'turn/completed', params: { threadId: 'th_mock_1', turn: { id: 'turn_mock_1', status: 'completed' } } });
    return;
  }
  return dispatchScenario(afterSilentReplies, turnText, msg, handleNativeFailure);
}

async function replyWithFinalMessageNudge(silent) {
  const kind = silent.finalMessageNudgeKind();
  if (kind === 'silent') {
    emit({ method: 'item/completed', params: { threadId: 'th_mock_1', turnId: 'turn_mock_1', item: { type: 'reasoning', id: 'silent-nudge-rsn', summary: silent.SILENT_TAIL_REASONING, content: silent.SILENT_TAIL_REASONING } } });
  } else {
    if (kind === 'slow-done') {
      emit({ method: 'item/completed', params: { threadId: 'th_mock_1', turnId: 'turn_mock_1', item: { type: 'agentMessage', id: 'silent-nudge-prefix', text: silent.SLOW_DONE_PREFIX } } });
      await silent.sleep(silent.SLOW_DONE_TAIL_MS);
    }
    const text = await silent.finalNudgeText(kind, lifecycle);
    emit({ method: 'item/completed', params: { threadId: 'th_mock_1', turnId: 'turn_mock_1', item: { type: 'agentMessage', id: 'silent-nudge-done', text } } });
  }
  emit({ method: 'turn/completed', params: { threadId: 'th_mock_1', turn: { id: 'turn_mock_1', status: 'completed' } } });
  return;
}

// #961: `hook/completed` (0.160.1 schema) — one mid-turn, one after the run parked.
async function replyWithParkedHook(turnText, msg) {
  const hook = (id, eventName, text) => ({ method: 'hook/completed', params: { threadId: 'th_mock_1', turnId: 'turn_mock_1', run: {
    id, eventName, handlerType: 'command', executionMode: 'sync', scope: 'turn', sourcePath: '/mock/hooks.json',
    displayOrder: 0, startedAt: 1, status: 'completed', entries: [{ kind: 'context', text }],
  } } });
  emit(hook('hook-mid', 'postToolUse', 'Mid-turn hook context.'));
  const watching = 'Watching.' + await lifecycle((await tools()).wait());
  emit({ method: 'item/completed', params: { threadId: 'th_mock_1', item: { type: 'agentMessage', id: 'hook-parent', text: watching } } });
  emit({ method: 'turn/completed', params: { threadId: 'th_mock_1', turn: { id: 'turn_mock_1', status: 'completed' } } });
  await afterParityPark(turnText);
  emit(hook('hook-late', 'stop', 'Late hook processed.'));
  return;
}

// Native thread attribution from collab-agent-tool-call.ndjson (#121/#401).
async function replyWithParkedSubagent(turnText, msg) {
  emit({ method: 'item/started', params: { threadId: 'th_mock_1', item: { type: 'collabAgentToolCall', id: 'park-spawn', tool: 'spawnAgent', status: 'inProgress', receiverThreadIds: ['th_park_child'] } } });
  const watching = 'Watching the child.' + await lifecycle((await tools()).wait());
  emit({ method: 'item/completed', params: { threadId: 'th_mock_1', item: { type: 'agentMessage', id: 'park-parent', text: watching } } });
  emit({ method: 'turn/completed', params: { threadId: 'th_mock_1', turn: { id: 'turn_mock_1', status: 'completed' } } });
  await afterParityPark(turnText);
  emit({ method: 'item/started', params: { threadId: 'th_park_child', item: { type: 'commandExecution', id: 'late-read', command: 'cat README.md', status: 'inProgress' } } });
  emit({ method: 'item/completed', params: { threadId: 'th_park_child', item: { type: 'commandExecution', id: 'late-read', command: 'cat README.md', status: 'completed', exitCode: 0 } } });
  emit({ method: 'item/completed', params: { threadId: 'th_park_child', item: { type: 'agentMessage', id: 'late-child', text: 'Post-park child update processed.' } } });
  return;
}

// #401: agentMessage completion without deltas (same item envelope as baseline).
async function replyWithMultiplePrs(turnText, msg) {
  const { multiPrText, unrelatedPr } = await import('./mock-multi-pr.mjs');
  const text = await multiPrText(turnText, lifecycle);
  emit({ method: 'item/completed', params: { threadId: 'th_mock_1', item: { type: 'reasoning', id: 'multi-thinking', summary: [unrelatedPr] } } });
  emit({ method: 'item/completed', params: { threadId: 'th_mock_1', item: { type: 'commandExecution', id: 'multi-tool', command: 'cat other.txt', aggregatedOutput: unrelatedPr, status: 'completed', exitCode: 0 } } });
  emit({ method: 'item/started', params: { threadId: 'th_mock_1', item: { type: 'collabAgentToolCall', id: 'multi-spawn', tool: 'spawnAgent', status: 'inProgress', receiverThreadIds: ['th_foreign_child'] } } });
  emit({ method: 'item/completed', params: { threadId: 'th_foreign_child', item: { type: 'agentMessage', id: 'multi-child', text: unrelatedPr } } });
  emit({ method: 'item/started', params: { threadId: 'th_mock_1', turnId: 'turn_mock_1', item: { type: 'agentMessage', id: 'multi-message', text: '' } } });
  for (const delta of [text.slice(0, 5), text.slice(5)]) emit({ method: 'item/agentMessage/delta', params: { threadId: 'th_mock_1', turnId: 'turn_mock_1', itemId: 'multi-message', delta } });
  emit({ method: 'item/completed', params: { threadId: 'th_mock_1', turnId: 'turn_mock_1', item: { type: 'agentMessage', id: 'multi-message', text } } });
  emit({ method: 'turn/completed', params: { turn: { id: 'turn_mock_1', status: 'completed' } } });
  return;
}

async function replyWithTurnMessages(turnText, msg) {
  const { turnMessages } = await import('./mock-turn-messages.mjs');
  // `mock:channel-missing` / `mock:channel-refresh` → the second message's completion frame
  // diverges between channels: no snapshot text (delta only), or a refresh of the first
  // message's id with both texts (monitoring-channel-order.test.ts).
  const missing = turnText.includes('mock:channel-missing'), refresh = turnText.includes('mock:channel-refresh');
  if (missing || refresh) {
    emitChannelMessages(turnMessages(turnText), missing, refresh);
  } else {
    for (const text of turnMessages(turnText)) emit({ method: 'item/completed', params: { threadId: 'th_mock_1', turnId: 'turn_mock_1', item: { type: 'agentMessage', id: `item_multi_${++echoSerial}`, text } } });
  }
  emit({ method: 'turn/completed', params: { turn: { id: 'turn_mock_1', status: 'completed' } } });
  return;
}

function emitChannelMessages(messages, missing, refresh) {
  let firstId;
  for (let n = 0; n < messages.length; n++) {
    const text = messages[n], id = n === 1 && refresh ? firstId : `channel_${++echoSerial}`;
    if (n === 0) firstId = id;
    emitChannelMessage(messages, n, missing, refresh, id, text);
  }
}

function emitChannelMessage(messages, n, missing, refresh, id, text) {
  if (n === 1 && missing) {
    emit({ method: 'item/started', params: { threadId: 'th_mock_1', turnId: 'turn_mock_1', item: { type: 'agentMessage', id } } });
    emit({ method: 'item/agentMessage/delta', params: { threadId: 'th_mock_1', turnId: 'turn_mock_1', itemId: id, delta: text } });
    emit({ method: 'item/completed', params: { threadId: 'th_mock_1', turnId: 'turn_mock_1', item: { type: 'agentMessage', id } } });
  } else emit({ method: 'item/completed', params: { threadId: 'th_mock_1', turnId: 'turn_mock_1', item: { type: 'agentMessage', id, text: n === 1 && refresh ? `${messages[0]}\n${text}` : text } } });
}

async function replyWithCezarTool(turnText, msg) {
  const { toolPrompt } = await import('./mock-ci-tool.mjs');
  const tool = /mock:cezar-tool\s+([a-z_]+)/.exec(turnText)?.[1] ?? 'cezar_wait';
  const text = await mcpToolGate(tool) ? await toolPrompt('codex', ciWire, turnText) : 'user rejected MCP tool call';
  emit({ method: 'item/completed', params: { item: { type: 'agentMessage', id: 'tool-result', text } } });
  emit({ method: 'turn/completed', params: { turn: { id: 'turn_mock_1', status: 'completed' } } });
  return;
}

async function replyWithCiWait(turnText, msg) {
  const { ciPrompt } = await import('./mock-ci-tool.mjs');
  const text = await mcpToolGate('cezar_wait') ? await ciPrompt('codex', ciWire, turnText) : 'user rejected MCP tool call';
  emit({ method: 'item/completed', params: { item: { type: 'agentMessage', id: 'ci-result', text } } });
  emit({ method: 'turn/completed', params: { turn: { id: 'turn_mock_1', status: 'completed' } } });
  return;
}

async function replyWithSteering(turnText, msg, steerScenario) {
  const turnId = 'turn_mock_1';
  steerTurn = { id: turnId, steered: [], race: steerScenario === 'mock:steer-race', strand: steerScenario === 'mock:steer-strand' };
  const agent = (text) => emit({ method: 'item/completed', params: { threadId: 'th_mock_1', turnId, item: { type: 'agentMessage', id: `item_steer_${++steerSerial}`, text } } });
  if (steerScenario === 'mock:steer-late') {
    agent(`late window: final message already sent${turnText.includes('mock:late-cezar-done') ? await lifecycle((await tools()).DONE) : ''}`);
    await sleep(300);
    completeSteerTurn(turnId); // steers accepted in this window are never read
    return;
  }
  const exec = { type: 'commandExecution', id: 'exec_steer', command: 'wait', status: 'inProgress' };
  emit({ method: 'item/started', params: { threadId: 'th_mock_1', turnId, item: exec } });
  await sleep(Number(process.env.CEZ_MOCK_STEER_MS ?? 600));
  if (!steerTurn) return; // a race already ended it
  emit({ method: 'item/completed', params: { threadId: 'th_mock_1', turnId, item: { ...exec, status: 'completed' } } });
  const steered = steerTurn.steered;
  for (const entry of steered) {
    const item = { type: 'userMessage', id: `item_user_${++steerSerial}`, clientId: entry.clientId, content: [{ type: 'text', text: entry.text }] };
    emit({ method: 'item/started', params: { threadId: 'th_mock_1', turnId, item } });
    emit({ method: 'item/completed', params: { threadId: 'th_mock_1', turnId, item } });
  }
  agent(['steer tool done', ...steered.map((entry) => `saw: ${entry.text}`)].join('\n'));
  completeSteerTurn(turnId);
  return;
}

function replyWithEcho(turnText, msg) {
  // Same documented agentMessage/turn completion frames as the baseline below.
  emit({ method: 'item/completed', params: { threadId: 'th_mock_1', turnId: 'turn_mock_1', item: { type: 'agentMessage', id: `item_echo_${++echoSerial}`, text: turnText } } });
  emit({ method: 'turn/completed', params: { turn: { id: 'turn_mock_1', status: 'completed' } } });
  return;
}

function replyWithMalformedAsk(turnText, msg) {
  // `questions` is not an array of question objects, so `codexAskQuestions`
  // must reject it: no card renders, and the turn still ends once the
  // rejection lands above (harness parity R4).
  emit({ id: 'ask-bad-1', method: 'item/tool/requestUserInput', params: {
    threadId: 'th_mock_1', turnId: 'turn_mock_1', itemId: 'item_ask_bad', autoResolutionMs: null,
    questions: 'not-an-array',
  } });
  return;
}

/** One complete agent message, its usage, then the turn's end. */
function emitMessageTurn(itemId, text) {
  emit({ method: 'item/started', params: { threadId: 'th_mock_1', turnId: 'turn_mock_1', item: { type: 'agentMessage', id: itemId, text: '' } } });
  emit({ method: 'item/agentMessage/delta', params: { threadId: 'th_mock_1', turnId: 'turn_mock_1', itemId, delta: text } });
  emit({ method: 'item/completed', params: { threadId: 'th_mock_1', turnId: 'turn_mock_1', item: { type: 'agentMessage', id: itemId, text } } });
  emit({ method: 'thread/tokenUsage/updated', params: { threadId: 'th_mock_1', tokenUsage: { total: { totalTokens: 30, inputTokens: 20, outputTokens: 10 }, last: { totalTokens: 30, inputTokens: 20, outputTokens: 10 } } } });
  emit({ method: 'turn/completed', params: { turn: { id: 'turn_mock_1', status: 'completed' } } });
}

async function replyWithHeldDone(turnText, msg) {
  await waitForMockRelease(400);
  const full = 'parity hold-done: content after the pause' + await lifecycle((await tools()).DONE);
  emitMessageTurn('item_hd1', full);
  return;
}

async function replyWithHeldAsk(turnText, msg) {
  await waitForMockRelease(400);
  const ask = 'Pick one.' + await lifecycle((await tools()).ask());
  emitMessageTurn('item_ha1', ask);
  return;
}

async function replyWithDone(turnText, msg) {
  // A turn that calls cezar_done, so the run reaches cezar's review gate
  // instead of parking for the user. A turn that ends with no tool call
  // correctly parks as `waiting`, which is why harness parity R1 needs
  // this scenario rather than the baseline one.
  const full = 'parity done: the task is complete' + await lifecycle((await tools()).DONE);
  emitMessageTurn('item_d1', full);
  return;
}

// The portable ask: cezar_ask, then the turn ends (the native ask is `mock:native-codex-ask`).
async function replyWithCezarAsk(turnText, msg) {
  const ask = 'Pick one.' + await lifecycle((await tools()).ask());
  emit({ method: 'item/completed', params: { threadId: 'th_mock_1', turnId: 'turn_mock_1', item: { type: 'agentMessage', id: 'item_ca1', text: ask } } });
  emit({ method: 'turn/completed', params: { turn: { id: 'turn_mock_1', status: 'completed' } } });
  return;
}

function acknowledgeWatchdog() {}

async function replyWithBusyProgress(turnText, msg) {
  for (let i = 0; i < 24; i++) {
    emit({ method: 'item/commandExecution/outputDelta', params: { threadId: 'th_mock_1', turnId: 'turn_mock_1', itemId: 'busy', delta: 'working\n' } });
    await new Promise(r => setTimeout(r, 100));
  }
  const busy = 'busy complete' + await lifecycle((await tools()).DONE);
  emit({ method: 'item/started', params: { threadId: 'th_mock_1', turnId: 'turn_mock_1', item: { type: 'agentMessage', id: 'item_busy', text: '' } } });
  emit({ method: 'item/agentMessage/delta', params: { threadId: 'th_mock_1', turnId: 'turn_mock_1', itemId: 'item_busy', delta: busy } });
  emit({ method: 'item/completed', params: { threadId: 'th_mock_1', turnId: 'turn_mock_1', item: { type: 'agentMessage', id: 'item_busy', text: busy } } });
  emit({ method: 'turn/completed', params: { turn: { id: 'turn_mock_1', status: 'completed' } } });
  return;
}

async function replyWithGatedHold(turnText, msg) {
  await waitForMockRelease(250);
  const gated = 'parity hold-gated: content after the pause';
  emit({ method: 'item/started', params: { threadId: 'th_mock_1', turnId: 'turn_mock_1', item: { type: 'agentMessage', id: 'item_hg1', text: '' } } });
  emit({ method: 'item/agentMessage/delta', params: { threadId: 'th_mock_1', turnId: 'turn_mock_1', itemId: 'item_hg1', delta: gated } });
  emit({ method: 'item/completed', params: { threadId: 'th_mock_1', turnId: 'turn_mock_1', item: { type: 'agentMessage', id: 'item_hg1', text: gated } } });
  emit({ method: 'thread/tokenUsage/updated', params: { threadId: 'th_mock_1', tokenUsage: { total: { totalTokens: 30, inputTokens: 20, outputTokens: 10 }, last: { totalTokens: 30, inputTokens: 20, outputTokens: 10 } } } });
  emit({ method: 'turn/completed', params: { turn: { id: 'turn_mock_1', status: 'completed' } } });
  return;
}

function replyWithHold(turnText, msg) {
  // The `turn/start` response and `turn/started` above are the ack. Holding
  // the content AND `turn/completed` behind it is what makes harness parity
  // S2 meaningful: a runner deriving turn-end from the ack reports it before
  // this content ever arrives (the #4 failure mode on codex's wire).
  setTimeout(() => {
    const held = 'parity hold: content after the pause';
    emit({ method: 'item/started', params: { threadId: 'th_mock_1', turnId: 'turn_mock_1', item: { type: 'agentMessage', id: 'item_h1', text: '' } } });
    emit({ method: 'item/agentMessage/delta', params: { threadId: 'th_mock_1', turnId: 'turn_mock_1', itemId: 'item_h1', delta: held } });
    emit({ method: 'item/completed', params: { threadId: 'th_mock_1', turnId: 'turn_mock_1', item: { type: 'agentMessage', id: 'item_h1', text: held } } });
    emit({ method: 'thread/tokenUsage/updated', params: { threadId: 'th_mock_1', tokenUsage: { total: { totalTokens: 30, inputTokens: 20, outputTokens: 10 }, last: { totalTokens: 30, inputTokens: 20, outputTokens: 10 } } } });
    emit({ method: 'turn/completed', params: { turn: { id: 'turn_mock_1', status: 'completed' } } });
  }, 250);
  return;
}

async function replyWithStreamRetry(turnText, msg) {
  // Error payloads from the real 0.155.1 reconnect probe; see stream-retry.md.
  const frames = [{"method": "error", "params": {"error": {"message": "Reconnecting... 2/5", "codexErrorInfo": {"responseStreamDisconnected": {"httpStatusCode": null}}, "additionalDetails": "stream disconnected before completion: invalid peer certificate: UnknownIssuer"}, "willRetry": true}}, {"method": "error", "params": {"error": {"message": "Reconnecting... waiting for network", "additionalDetails": "Connection failed: error sending request"}, "willRetry": true}}];
  const send = frame => emit({ ...frame, params: { ...frame.params, threadId: 'th_mock_1', turnId: 'turn_mock_1' } });
  send(frames[0]);
  if (turnText.includes('recover')) {
    await sleep(20);
    emit({ method: 'item/completed', params: { threadId: 'th_mock_1', turnId: 'turn_mock_1', item: { type: 'agentMessage', id: 'recovered_message', text: 'Recovered after reconnect.' } } });
    emit({ method: 'turn/completed', params: { threadId: 'th_mock_1', turn: { id: 'turn_mock_1', status: 'completed' } } });
  } else {
    send(frames[1]);
    const retries = setInterval(() => send(frames[1]), 10_000);
    rl.once('close', () => clearInterval(retries));
  }
  return;
}

function replyWithFailedTurn(turnText, msg) {
  emit({ method: 'turn/failed', params: {
    turn: { id: 'turn_mock_1', status: 'failed' },
    error: { message: turnText.includes('mock:legacy-interrupt') ? 'Turn interrupted by user' : 'model unavailable' },
  } });
  return;
}

function replyWithSubagentActivity(turnText, msg) {
  emit({ method: 'item/started', params: { item: { type: 'subAgentActivity', id: 'activity_1', kind: 'started', agentThreadId: 'th_child', agentPath: '/root/scope_review' } } });
  emit({ method: 'item/completed', params: { item: { type: 'subAgentActivity', id: 'activity_1', kind: 'started', agentThreadId: 'th_child', agentPath: '/root/scope_review' } } });
  emit({ method: 'item/started', params: { item: { type: 'collabAgentToolCall', id: 'wait_1', tool: 'wait', status: 'inProgress', receiverThreadIds: [] } } });
  emit({ method: 'item/completed', params: { item: { type: 'collabAgentToolCall', id: 'wait_1', tool: 'wait', status: 'completed', receiverThreadIds: [] } } });
  emit({ method: 'turn/completed', params: { turn: { id: 'turn_mock_1', status: 'completed' } } });
  return;
}

async function replyWithChildTurn(turnText, msg) {
  // A spawned sub-agent runs in its OWN child thread that emits a full turn
  // lifecycle over the shared connection. Its turn/completed must not end the
  // parent turn (#600): the parent is still working after the child finishes.
  // Collaboration attribution from collab-agent-tool-call.ndjson; late text reproduces #149.
  emit({ method: 'item/started', params: { threadId: 'th_mock_1', item: { type: 'collabAgentToolCall', id: 'item_spawn', tool: 'spawnAgent', status: 'inProgress', receiverThreadIds: ['th_child'] } } });
  emit({ method: 'turn/started', params: { threadId: 'th_child', turn: { id: 'turn_child', status: 'inProgress', items: [] } } });
  emit({ method: 'item/started', params: { threadId: 'th_child', turnId: 'turn_child', item: { type: 'commandExecution', id: 'item_child', command: ['rg', 'requestUserInput'], cwd: '/repo', status: 'inProgress' } } });
  emit({ method: 'turn/completed', params: { threadId: 'th_child', turn: { id: 'turn_child', status: 'completed' } } });
  // Parent keeps streaming after the child's turn ended.
  const working = 'Still working after the sub-agent.' + await lifecycle((await tools()).wait('Re-check the sub-agent.'));
  emit({ method: 'item/started', params: { threadId: 'th_mock_1', turnId: 'turn_mock_1', item: { type: 'agentMessage', id: 'item_p1', text: '' } } });
  emit({ method: 'item/agentMessage/delta', params: { threadId: 'th_mock_1', turnId: 'turn_mock_1', itemId: 'item_p1', delta: working } });
  emit({ method: 'item/completed', params: { threadId: 'th_mock_1', turnId: 'turn_mock_1', item: { type: 'agentMessage', id: 'item_p1', text: working } } });
  emit({ method: 'item/completed', params: { threadId: 'th_child', turnId: 'turn_child', item: { type: 'agentMessage', id: 'item_child_text', text: 'Child review finished.' } } });
  // No completion for this second child item: parent turn-end must not flush it into v1.
  emit({ method: 'item/agentMessage/delta', params: { threadId: 'th_child', turnId: 'turn_child', itemId: 'item_child_partial', delta: 'Child review still streaming.' } });
  emit({ method: 'turn/completed', params: { threadId: 'th_mock_1', turn: { id: 'turn_mock_1', status: 'completed' } } });
  return;
}

// hearsay-tools/cezarion#1294: another server's tool approval by default; `-own` names
// cezar's own server, `-form` is a real form (no approval), `-null-turn` has no turn id.
function replyWithMcpApproval(turnText, msg, mcpApproval) {
  pendingApprovalTurn = 'turn_mock_1';
  const variant = mcpApproval[1];
  const server = approvalServer(variant);
  emit({ id: 'mcp-approval-1', method: 'mcpServer/elicitation/request', params: mcpToolApprovalRequest(server, 'search',
    variant === 'form' ? { _meta: null, message: 'Which region?', requestedSchema: { type: 'object', properties: { region: { type: 'string' } } } }
      : variant === 'null-turn' ? { turnId: null } : {}) });
  // No turn/completed until the matching native JSON-RPC response arrives.
  return;
}

function approvalServer(variant) {
  return variant === 'own' ? (cezarServer()?.[0].slice('mcp_servers.'.length) ?? 'cezar_ci_mock') : 'docs';
}

async function replyWithApproval(turnText, msg) {
  pendingApprovalTurn = 'turn_mock_1';
  emitApprovalRequest(turnText);
  // P3/P4: Codex settles the request itself, or ends the turn around it, once the test releases it.
  const resolved = turnText.includes('mock:approval-resolved');
  if (resolved || turnText.includes('mock:approval-turn-end')) {
    await waitForMockRelease();
    await emitSettledApproval(resolved);
  }
  // Otherwise no turn/completed until the matching native JSON-RPC response arrives.
  return;
}

function emitApprovalRequest(turnText) {
  const unsupported = turnText.includes('mock:approval-unsupported');
  // hearsay-tools/cezarion#1266 P6: no itemId, so cezar answers it with a JSON-RPC error.
  const malformed = turnText.includes('mock:approval-malformed');
  emit({ id: unsupported ? 'approval-unsupported-1' : 'approval-1',
    method: unsupported ? 'item/unsupported/requestApproval' : 'item/commandExecution/requestApproval',
    params: { threadId: 'th_mock_1', turnId: pendingApprovalTurn, ...(malformed ? {} : { itemId: 'item_approval_1' }),
      startedAtMs: 1, command: 'git status --short', cwd: '/repo', reason: 'Native approval requested',
      availableDecisions: ['accept', 'acceptForSession', 'decline', 'cancel'] } });
}

async function emitSettledApproval(resolved) {
  const turnId = pendingApprovalTurn; pendingApprovalTurn = undefined;
  if (resolved) emit({ method: 'serverRequest/resolved', params: { threadId: 'th_mock_1', requestId: 'approval-1' } });
  const text = (resolved ? 'Native approval settled without a cockpit answer.'
    : 'Turn ended with the approval still pending.') + await lifecycle((await tools()).DONE);
  emit({ method: 'item/completed', params: { threadId: 'th_mock_1', turnId, item: { type: 'agentMessage', id: 'item_approval_settled', text } } });
  emit({ method: 'turn/completed', params: { threadId: 'th_mock_1', turn: { id: turnId, status: 'completed' } } });
}

function replyWithAsk(turnText, msg) {
  resumeAfterAsk = turnText.includes('mock:resume-cezar-done');
  const questions = turnText.includes('multi free text')
    ? [{ id: 'first', header: 'First', question: 'First choice?', isOther: true, isSecret: false,
        options: [{ label: 'A', description: 'Option A.' }, { label: 'B', description: 'Option B.' }] },
      { id: 'second', header: 'Second', question: 'Second choice?', isOther: true, isSecret: false,
        options: [{ label: 'C', description: 'Option C.' }, { label: 'D', description: 'Option D.' }] }]
    : [{ id: 'library', header: 'Library', question: 'Which test library?', isOther: true,
        isSecret: false, options: [{ label: 'Vitest', description: 'Use the existing test runner.' },
          { label: 'Node test', description: 'Use node:test.' }] }];
  emit({ id: 'ask-1', method: 'item/tool/requestUserInput', params: {
    threadId: 'th_mock_1', turnId: 'turn_mock_1', itemId: 'item_ask_1', autoResolutionMs: null,
    questions,
  } });
  return;
}

function replyWithOrdinaryTurn() {
  emit({ method: 'item/started', params: { threadId: 'th_mock_1', turnId: 'turn_mock_1', item: { type: 'agentMessage', id: 'item_m1', text: '' } } });
  emit({ method: 'item/agentMessage/delta', params: { threadId: 'th_mock_1', turnId: 'turn_mock_1', itemId: 'item_m1', delta: 'Checking the working tree.' } });
  emit({ method: 'item/completed', params: { threadId: 'th_mock_1', turnId: 'turn_mock_1', item: { type: 'agentMessage', id: 'item_m1', text: 'Checking the working tree.' } } });
  emit({ method: 'item/started', params: { threadId: 'th_mock_1', turnId: 'turn_mock_1', item: { type: 'commandExecution', id: 'item_c1', command: ['bash', '-lc', 'git status --short'], cwd: '/repo', status: 'inProgress' } } });
  emit({ method: 'item/commandExecution/outputDelta', params: { threadId: 'th_mock_1', turnId: 'turn_mock_1', itemId: 'item_c1', delta: ' M src/example.ts\n' } });
  emit({ method: 'item/completed', params: { threadId: 'th_mock_1', turnId: 'turn_mock_1', item: { type: 'commandExecution', id: 'item_c1', command: ['bash', '-lc', 'git status --short'], cwd: '/repo', status: 'completed', exitCode: 0 } } });
  emit({ method: 'item/started', params: { threadId: 'th_mock_1', turnId: 'turn_mock_1', item: { type: 'agentMessage', id: 'item_m2', text: '' } } });
  emit({ method: 'item/agentMessage/delta', params: { threadId: 'th_mock_1', turnId: 'turn_mock_1', itemId: 'item_m2', delta: 'Done with the first pass.' } });
  emit({ method: 'item/completed', params: { threadId: 'th_mock_1', turnId: 'turn_mock_1', item: { type: 'agentMessage', id: 'item_m2', text: 'Done with the first pass.' } } });
  emit({ method: 'thread/tokenUsage/updated', params: { threadId: 'th_mock_1', tokenUsage: { total: { totalTokens: 1500, inputTokens: 1200, outputTokens: 300 }, last: { totalTokens: 1500, inputTokens: 1200, outputTokens: 300 } } } });
  emit({ method: 'turn/completed', params: { turn: { id: 'turn_mock_1', status: 'completed' } } });
}

async function handleNativeFailure(turnText, msg) {
  const selectedFailure = failureControl?.failureFor(turnText);
  const nativeFailure = selectedFailure instanceof Promise ? await selectedFailure : selectedFailure;
  if (failureControl ? nativeFailure === 'provider' : turnText.includes('mock:provider-error') || turnText.includes('mock:empty-success')) {
    // Derived from the 0.147 rollout and upstream envelope; see the source
    // core/__fixtures__/codex/provider-error.md and its independent golden NDJSON.
    const completion = {"method": "turn/completed", "params": {"threadId": "th_mock_1", "turn": {"id": "turn_mock_1", "items": [], "itemsView": "notLoaded", "status": "failed", "error": {"message": "{\"type\":\"error\",\"status\":400,\"error\":{\"type\":\"invalid_request_error\",\"message\":\"The 'gpt-6-astra' model requires a newer version of Codex. Please upgrade to the latest app or CLI and try again.\"}}", "codexErrorInfo": "other", "additionalDetails": null}, "startedAt": 1788632328, "completedAt": 1788632331, "durationMs": 3502}}};
    if (turnText.includes('mock:empty-success')) {
      completion.params.turn.status = 'completed';
      completion.params.turn.error = null;
    }
    emit(completion);
    return;
  }
  return dispatchScenario(lateReplies, turnText, msg, replyWithOrdinaryTurn);
}

async function handleTurnStart(msg) {
  const openingCrashText = openingPromptText(msg);
  if (rejectsOpeningPrompt(openingCrashText)) { emit({ id: msg.id, error: { code: -32603, message: 'owned turn rejected' } }); return; }
  if (openingCrashText.includes('mock:crash-stderr-pre-ack')) {
    const { crashWithStderr } = await import('./mock-runner-crash.mjs');
    crashWithStderr(openingCrashText, '{"method":"turn/started","params":');
    return;
  }
  if (rejectedPermissionOverride) permissionWarning();
  activeTurnId = 'turn_mock_1';
  acknowledgeTurnStart(msg, openingCrashText);
  const turnText = nudgedTurnText(msg);
  // `mock:ack-only` → turn/start is acknowledged and the turn does not start until a steer arrives
  // (hearsay-tools/cezarion#1301).
  if (turnText.includes('mock:ack-only')) { heldTurn = true; return; }
  let silent;
  if (needsSilentTailPreparation(turnText)) {
    silent = await import('./mock-silent-tail.mjs');
    silent.noteSilentTailPrompt(turnText);
    if (silent.isAckOnlyNudge(turnText)) return;
    if (silent.isLateTurnStartNudge(turnText)) await waitForMockRelease(silent.LATE_REPLY_MS);
    else if (silent.isLateNudge(turnText)) await waitForMockRelease(silent.LATE_REPLY_MS);
  }
  // hearsay-tools/cezarion#1112: the acknowledged turn/start reports turn/started late.
  if (turnText.includes('mock:deferred-turn-start')) await (await import('./mock-deferred-turn-start.mjs')).deferredTurnStart();
  if (!turnText.includes('mock:no-progress-ack-only')) {
  emit({ method: 'turn/started', params: { turn: { id: 'turn_mock_1', status: 'inProgress', items: [] } } });
  }
  if (delivery) await delivery.holdResponse(turnText);
  if (needsLateContentHold(silent, turnText)) await waitForMockRelease(silent.LATE_TURN_START_HOLD_MS, '.content');
  emitOpeningInput(msg, turnText);
  if (turnText.includes('mock:crash-stderr')) {
    const { crashWithStderr } = await import('./mock-runner-crash.mjs');
    await new Promise(resolve => setTimeout(resolve, 30));
    if (crashWithStderr(turnText, '{"method":"item/commandExecution/outputDelta","params":')) return;
  }
  return dispatchScenario(openingReplies, turnText, msg, dispatchAfterSilent);
}

function rejectsOpeningPrompt(openingCrashText) {
  return delivery?.rejects(openingCrashText);
}

function needsSilentTailPreparation(turnText) {
  return turnText.includes('mock:silent-tail') || silentNudge(turnText);
}

function needsLateContentHold(silent, turnText) {
  return silent?.isLateTurnStartNudge(turnText);
}

function openingPromptText(msg) {
  return msg.params?.input?.map?.((part) => part.text ?? '').join('\n') ?? '';
}

function nudgedTurnText(msg) {
  return answerNudge(msg.params?.input?.map?.((part) => part.text ?? '').join('\n') ?? '');
}

function acknowledgeTurnStart(msg, openingCrashText) {
  if (msg.mockHeldSteer) { /* the steer was acknowledged */ } else if (process.env.CEZ_MOCK_CODEX_LATE_START_ACK === '1' && startSerial++ > 0) lateStartAck = msg.id; else {
  const ack = () => emit({ id: msg.id, result: { turn: { id: 'turn_mock_1' } } });
  if (delivery) delivery.ack(openingCrashText, ack); else ack();
  }
}

function emitOpeningInput(msg, turnText) {
  // The real app-server records the turn's own input as a userMessage item,
  // echoing clientUserMessageId as clientId (probe 0.155.1, #505).
  const opening = { type: 'userMessage', id: `item_user_open_${++steerEchoSerial}`, clientId: msg.params?.clientUserMessageId ?? null, content: [{ type: 'text', text: turnText }] };
  if (process.env.CEZ_MOCK_CODEX_NO_USER_ITEM !== '1') {
    emit({ method: 'item/started', params: { threadId: 'th_mock_1', turnId: 'turn_mock_1', item: opening } });
    emit({ method: 'item/completed', params: { threadId: 'th_mock_1', turnId: 'turn_mock_1', item: opening } });
  }
}

function resolveClientRequest(msg) {
  const resolve = clientReplies.get(msg.id); clientReplies.delete(msg.id);
  emit({ method: 'serverRequest/resolved', params: { threadId: 'th_mock_1', requestId: msg.id } });
  resolve(msg);
  return;
}

async function replyToApproval(msg) {
  const turnId = pendingApprovalTurn; pendingApprovalTurn = undefined;
  const text = `${msg.error ? `Approval error: ${msg.error.code}` : `Approval response: ${JSON.stringify(msg.result)}`}` + await lifecycle((await tools()).DONE);
  emit({ method: 'item/completed', params: { threadId: 'th_mock_1', turnId,
    item: { type: 'agentMessage', id: 'item_approval_reply', text } } });
  emit({ method: 'serverRequest/resolved', params: { threadId: 'th_mock_1', requestId: msg.id } });
  emit({ method: 'turn/completed', params: { threadId: 'th_mock_1', turn: { id: turnId, status: msg.result?.decision === 'cancel' ? 'interrupted' : 'completed' } } });
  return;
}

rl.on('close', () => {
  if (!ignoreEof) process.exit(0);
});
