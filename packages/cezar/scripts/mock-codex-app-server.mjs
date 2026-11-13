#!/usr/bin/env node
import { productEnv } from './product-env.mjs';
import { CODEX_FAILURES } from './mock-provider-failures.mjs';
import { loadControls } from './mock-controls.mjs';
import { waitForRelease } from './mock-lifecycle.mjs';
import { scenarioFor, play, afterParityPark, PROVIDER_HOLD_SCENARIOS } from './mock-scenario.mjs';
import { closeSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
import { withoutSessionContextParts } from './mock-session-context.mjs';
const { failureControl, delivery } = await loadControls({ delivery: ['reject', 'hold-ack', 'hold-response'] });
// Bundled dry-run mock of `codex app-server` — speaks just enough JSON-RPC 2.0
// JSONL (§3 of agent-event-protocols.md) for the runner wiring test in
// `codex-ui-mapper.test.ts`: initialize/thread/turn handshake, one scripted
// turn with an agentMessage + a commandExecution (with live outputDelta),
// cumulative token usage, then exits on stdin EOF like the real server.
//
// `MOCK_CODEX_IGNORE_EOF=1` switches to the #703 teardown shape instead: the
// server stays deaf to stdin EOF (the CLI hang the EOF watchdog exists for)
// and handles SIGTERM itself, exiting 143 rather than dying from the signal.
const { answerNudge } = await import('./mock-nudge.mjs');


// No import or await on the ordinary mock path.
const wireRecorder = process.env.CEZ_MOCK_WIRE_FILE === undefined ? undefined
  : await import('./mock-wire-recorder.mjs');
wireRecorder?.installWireRecorder();
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
  if (ending && obj.method === 'turn/completed' && obj.params?.turn?.status !== 'failed' && pendingSteers.length && process.env.CEZ_MOCK_CODEX_NO_STEER_ECHO !== '1') {
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
const squawkServer = () => Object.entries(ciWire?.config ?? {}).find(([key]) => key.startsWith('mcp_servers.cezar_ci_'));
const clientReplies = new Map();
const requestClient = (id, method, params) => new Promise((resolve) => { clientReplies.set(id, resolve); emit({ id, method, params }); });
let mcpGateSerial = 0;
// Codex gates every MCP tool call by the server's (or tool's) approval mode and asks
// unless it is `approve`, whatever `approval_policy` says.
async function mcpToolGate(tool) {
  const [key, server] = squawkServer() ?? [];
  if (!server || server.default_tools_approval_mode === 'approve') return true;
  const reply = await requestClient(`mcp-gate-${++mcpGateSerial}`, 'mcpServer/elicitation/request',
    mcpToolApprovalRequest(key.slice('mcp_servers.'.length), tool));
  return reply.result?.action === 'accept';
}
// hearsay-tools/cezarion#2397: a reply that finishes, asks or waits calls that Squawk tool over
// the thread's MCP config (behind Codex's approval gate) before its turn ends. Returns '' or a
// note for the text.
const tools = () => import('./mock-ci-tool.mjs');
async function lifecycle([name, args]) {
  if (!await mcpToolGate(name)) return `\n\n(mock: ${name} rejected)`;
  return (await tools()).lifecycleCall('codex', ciWire, name, args);
}
// Wire configuration and native MCP approval remain local to the app-server.
const scenarioContext = {
  runner: 'codex', lifecycle, session: {}, unsupported: ['cezar-wait'], nativeFailureControl: Boolean(failureControl),
  async toolPrompt(prompt) {
    const tool = (await tools()).squawkToolName(prompt) ?? 'cezar_wait';
    return await mcpToolGate(tool) ? (await tools()).toolPrompt('codex', ciWire, prompt) : 'user rejected MCP tool call';
  },
  async ciPrompt(prompt) {
    return await mcpToolGate('cezar_wait') ? (await tools()).ciPrompt('codex', ciWire, prompt) : 'user rejected MCP tool call';
  },
  async crash(prompt) {
    const { crashWithStderr } = await import('./mock-runner-crash.mjs');
    if (prompt.includes('mock:crash-stderr-pre-ack')) return crashWithStderr(prompt, '{"method":"turn/started","params":');
    await sleep(30);
    crashWithStderr(prompt, '{"method":"item/commandExecution/outputDelta","params":');
  },
};

function nativeUsage() {
  emit({ method: 'thread/tokenUsage/updated', params: { threadId: 'th_mock_1', tokenUsage: { total: { totalTokens: 30, inputTokens: 20, outputTokens: 10 }, last: { totalTokens: 30, inputTokens: 20, outputTokens: 10 } } } });
}

function nativeText(parts, id, streamed = false, threadId = 'th_mock_1', scope = 'turn') {
  const params = scope === 'none' ? {} : { threadId, ...(scope === 'turn' ? { turnId: 'turn_mock_1' } : {}) };
  if (streamed) {
    emit({ method: 'item/started', params: { ...params, item: { type: 'agentMessage', id, text: '' } } });
    for (const delta of parts) emit({ method: 'item/agentMessage/delta', params: { ...params, itemId: id, delta } });
  }
  emit({ method: 'item/completed', params: { ...params, item: { type: 'agentMessage', id, text: parts.join('') } } });
}

function nativeCommand(call, status, name, threadId = 'th_mock_1') {
  const silent = name === 'silent-tail' || name === 'tool-tail';
  const steering = name === 'steer-tool';
  const child = threadId !== 'th_mock_1';
  if (silent && status === 'inProgress') return;
  const command = silent ? ['bash', '-lc', call.input.command] : call.input.command ?? `cat ${call.input.path}`;
  const item = { type: 'commandExecution', id: call.id, command,
    ...(silent ? { cwd: '/repo' } : {}),
    ...(name === 'multi-pr-refs' ? { aggregatedOutput: call.output } : {}), status,
    ...(!steering && status === 'completed' ? { exitCode: 0 } : {}) };
  const params = { threadId, ...(!child && name !== 'multi-pr-refs' ? { turnId: 'turn_mock_1' } : {}), item };
  emit({ method: status === 'completed' ? 'item/completed' : 'item/started', params });
}

function nativeSpawn(id, threadId) {
  emit({ method: 'item/started', params: { threadId: 'th_mock_1', item: { type: 'collabAgentToolCall', id, tool: 'spawnAgent', status: 'inProgress', receiverThreadIds: [threadId] } } });
}

function scenarioEncoder(msg, prompt, scenario, alreadyOpened = false) {
  const name = scenario?.name;
  let opened = alreadyOpened;
  if (name === 'steer-tool' || name === 'steer-late') steerTurn = { id: 'turn_mock_1', steered: [] };
  let message = 0;
  const messages = [];
  let pendingTool;
  const ids = { 'hold-cezar-done': 'item_hd1', 'hold-cezar-ask': 'item_ha1', 'cezar-done': 'item_d1', 'cezar-ask': 'item_ca1', 'hold-gated': 'item_hg1', hold: 'item_h1', 'busy-progress': 'item_busy', 'cezar-tool': 'tool-result', 'ci-wait': 'ci-result', 'multi-pr-refs': 'multi-message' };
  const streamed = ['hold-cezar-done', 'hold-cezar-ask', 'cezar-done', 'hold-gated', 'hold', 'busy-progress', 'multi-pr-refs'].includes(name);
  return {
    closeInput: () => closeSync(0),
    open(step) {
      if (step.ackOnly) { if (name === 'ack-only') heldTurn = true; return; }
      if (opened) return;
      opened = true;
      if (!prompt.includes('mock:no-progress-ack-only')) emit({ method: 'turn/started', params: { turn: { id: 'turn_mock_1', status: 'inProgress', items: [] } } });
      const content = () => emitOpeningInput(msg, prompt);
      const hold = delivery?.holdResponse(prompt);
      if (hold) return hold.then(content);
      content();
    },
    reply: replyWithOrdinaryTurn,
    text(step) {
      if (name === 'turn-messages' && (prompt.includes('mock:channel-missing') || prompt.includes('mock:channel-refresh'))) { messages.push(step.parts.join('')); return; }
      const id = ids[name] ?? `item_scenario_${++echoSerial}`;
      if (name === 'steer-late' && prompt.includes('mock:late-cezar-done')) {
        return lifecycleCallText(step.parts, id);
      }
      const scope = name === 'cezar-tool' || name === 'ci-wait' ? 'none' : name === 'subagent-after-park' ? 'thread' : 'turn';
      nativeText(step.parts, name === 'autonomous' ? `autonomous-${++autonomousTurn}` : id, streamed, 'th_mock_1', scope);
      message++;
    },
    reasoning(step) {
      if (name === 'multi-pr-refs') {
        emit({ method: 'item/completed', params: { threadId: 'th_mock_1', item: { type: 'reasoning', id: 'multi-thinking', summary: [step.text] } } });
        nativeCommand(pendingTool, 'completed', name);
        nativeSpawn('multi-spawn', 'th_foreign_child');
        nativeText([step.text], 'multi-child', false, 'th_foreign_child', 'thread');
      } else emit({ method: 'item/completed', params: { threadId: 'th_mock_1', turnId: 'turn_mock_1', item: { type: 'reasoning', id: `scenario-reasoning-${message}`, summary: step.text, content: step.text } } });
    },
    toolStart({ call }) {
      if (call.name === 'task') return nativeSpawn('park-spawn', 'th_park_child');
      if (name === 'multi-pr-refs') return;
      nativeCommand(call, 'inProgress', name);
    },
    toolEnd({ call }) {
      if (call.name === 'task') return;
      if (name === 'multi-pr-refs') { pendingTool = call; return; }
      nativeCommand(call, 'completed', name);
    },
    child(step, playChild) {
      return playChild({
        ...this,
        text: childText => nativeText(childText.parts, `child-message-${++echoSerial}`, false, 'th_park_child', 'thread'),
        toolStart: ({ call }) => nativeCommand(call, 'inProgress', name, 'th_park_child'),
        toolEnd: ({ call }) => nativeCommand(call, 'completed', name, 'th_park_child'),
      });
    },
    progress() { emit({ method: 'item/commandExecution/outputDelta', params: { threadId: 'th_mock_1', turnId: 'turn_mock_1', itemId: 'busy', delta: 'working\n' } }); },
    readSteers(step) {
      if (step.late) return;
      const admitted = steerTurn.steered;
      for (const entry of admitted) {
        const item = { type: 'userMessage', id: `item_user_${++steerSerial}`, clientId: entry.clientId, content: [{ type: 'text', text: entry.text }] };
        emit({ method: 'item/started', params: { threadId: 'th_mock_1', turnId: 'turn_mock_1', item } });
        emit({ method: 'item/completed', params: { threadId: 'th_mock_1', turnId: 'turn_mock_1', item } });
      }
      return admitted.map(entry => entry.text);
    },
    end(step) {
      if (step.error === 'provider') return handleNativeFailure(prompt, msg, scenario, this);
      if (step.error) return emit(providerFailureCompletion(step.error));
      if (name === 'turn-messages' && messages.length) emitChannelMessages(messages, prompt.includes('mock:channel-missing'), prompt.includes('mock:channel-refresh'));
      if (['hold-cezar-done', 'hold-cezar-ask', 'cezar-done', 'hold-gated', 'hold'].includes(name)) nativeUsage();
      if (name === 'steer-tool' || name === 'steer-late') return completeSteerTurn('turn_mock_1');
      const scoped = ['autonomous', 'silent-tail', 'tool-tail', 'subagent-after-park'].includes(name);
      emit({ method: 'turn/completed', params: { ...(scoped ? { threadId: 'th_mock_1' } : {}), turn: { id: 'turn_mock_1', status: 'completed' } } });
    },
  };
}

async function lifecycleCallText(parts, id) {
  nativeText([...parts, await lifecycle((await tools()).DONE)], id);
}

// #505 steering scenarios: the one turn that accepts `turn/steer`, while it is open.
let steerTurn = null;
let steerSerial = 0;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const completeSteerTurn = (turnId) => {
  steerTurn = null;
  emit({ method: 'turn/completed', params: { threadId: 'th_mock_1', turn: { id: turnId, status: 'completed' } } });
};

// #708: requirements shape from Codex's generated ConfigRequirementsReadResponse.
// Retain an invalid requested override to reproduce fallback warnings on later turns. This
// models the reported diagnostic pattern; no enterprise-account trace was captured.
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
const turnReplies = [
  'autonomous', 'silent-tail', 'tool-tail',
  [turnText => turnText.includes('mock:hook-after-park'), replyWithParkedHook],
  'subagent-after-park',
  [turnText => turnText.includes('mock:subagent-background'), async turnText => (await import('./mock-codex-subagents.mjs')).replyWithBackgroundSubagents(turnText, { emit, afterParityPark })],
  'multi-pr-refs', 'turn-messages', 'cezar-tool', 'ci-wait', 'steer-tool', 'steer-late',
  [turnText => ['mock:steer-race', 'mock:steer-strand'].find(marker => turnText.includes(marker)), replyWithSteering],
  'agent-echo',
  [turnText => turnText.includes('mock:ask-bad'), replyWithMalformedAsk],
  'hold-cezar-done', 'hold-cezar-ask', 'cezar-done', 'cezar-ask', 'no-progress', 'busy-progress', 'hold-gated', 'hold',
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
  const expectedSandbox = productEnv('CODEX_NETWORK') === '0' ? 'workspace-write' : 'danger-full-access';
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

async function replyWithSteering(turnText, msg, steerScenario) {
  const turnId = 'turn_mock_1';
  steerTurn = { id: turnId, steered: [], race: steerScenario === 'mock:steer-race', strand: steerScenario === 'mock:steer-strand' };
  const agent = (text) => emit({ method: 'item/completed', params: { threadId: 'th_mock_1', turnId, item: { type: 'agentMessage', id: `item_steer_${++steerSerial}`, text } } });
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
// Squawk's own server, `-form` is a real form (no approval), `-null-turn` has no turn id.
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
  return variant === 'own' ? (squawkServer()?.[0].slice('mcp_servers.'.length) ?? 'cezar_ci_mock') : 'docs';
}

async function replyWithApproval(turnText, msg) {
  pendingApprovalTurn = 'turn_mock_1';
  emitApprovalRequest(turnText);
  // P3/P4: Codex settles the request itself, or ends the turn around it, once the test releases it.
  const resolved = turnText.includes('mock:approval-resolved');
  if (resolved || turnText.includes('mock:approval-turn-end')) {
    await waitForRelease();
    await emitSettledApproval(resolved);
  }
  // Otherwise no turn/completed until the matching native JSON-RPC response arrives.
  return;
}

function emitApprovalRequest(turnText) {
  const unsupported = turnText.includes('mock:approval-unsupported');
  // hearsay-tools/cezarion#1266 P6: no itemId, so Squawk answers it with a JSON-RPC error.
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


function providerFailureCompletion(kind) {
  const { status, type, message } = CODEX_FAILURES[kind];
  const error = { message: JSON.stringify({ type: 'error', status, error: { type, message } }), codexErrorInfo: 'other', additionalDetails: null };
  return { method: 'turn/completed', params: { threadId: 'th_mock_1', turn: { id: 'turn_mock_1', items: [], itemsView: 'notLoaded', status: 'failed', error, startedAt: 1788632328, completedAt: 1788632331, durationMs: 3502 } } };
}

async function handleNativeFailure(turnText, msg, scenario, encoder) {
  const selectedFailure = failureControl?.failureFor(turnText);
  const nativeFailure = selectedFailure instanceof Promise ? await selectedFailure : selectedFailure;
  const kind = (failureControl ? nativeFailure === 'provider' : scenario?.name === 'provider-error') ? 'provider' : undefined;
  if (kind || !failureControl && turnText.includes('mock:empty-success')) {
    const completion = providerFailureCompletion(kind ?? 'provider');
    if (!kind) {
      completion.params.turn.status = 'completed';
      completion.params.turn.error = null;
    }
    emit(completion);
    return;
  }
  if (scenario) return play(scenario, encoder);
  return dispatchScenario(lateReplies, turnText, msg, replyWithOrdinaryTurn);
}

/** Selection belongs to the module; Codex keeps its native interleaving and modifiers. */
function promptScenarios(prompt) {
  const selected = new Map();
  const unsupported = [...scenarioContext.unsupported];
  for (let scenario = scenarioFor(prompt, { ...scenarioContext, unsupported }); scenario;
    scenario = scenarioFor(prompt, { ...scenarioContext, unsupported })) {
    selected.set(scenario.name, scenario);
    unsupported.push(scenario.name);
  }
  return selected;
}

async function handleTurnStart(msg) {
  const prompt = openingPromptText(msg);
  if (delivery?.rejects(prompt)) { emit({ id: msg.id, error: { code: -32603, message: 'owned turn rejected' } }); return; }
  const crash = promptScenarios(prompt).get('crash-stderr');
  if (crash && prompt.includes('mock:crash-stderr-pre-ack')) return play(crash, scenarioEncoder(msg, prompt, crash));
  if (rejectedPermissionOverride) permissionWarning();
  activeTurnId = 'turn_mock_1';
  acknowledgeTurnStart(msg, prompt);
  const turnText = nudgedTurnText(msg);
  const scenarios = promptScenarios(turnText);
  const ackOnly = scenarios.get('ack-only');
  if (ackOnly) return play(ackOnly, scenarioEncoder(msg, turnText, ackOnly));
  const deferred = scenarios.get('deferred-turn-start');
  if (deferred) {
    const encoder = scenarioEncoder(msg, turnText, deferred);
    encoder.reply = () => dispatchOpenedTurn(msg, turnText, scenarios);
    return play(deferred, encoder);
  }
  if (!crash) {
    const early = scenarios.get('autonomous') ?? scenarios.get('silent-tail') ?? scenarios.get('tool-tail');
    if (early) return play(early, scenarioEncoder(msg, turnText, early));
  }
  const opening = scenarioEncoder(msg, turnText).open({ kind: 'open' });
  if (opening) await opening;
  return dispatchOpenedTurn(msg, turnText, scenarios);
}

async function dispatchOpenedTurn(msg, prompt, scenarios) {
  const crash = scenarios.get('crash-stderr');
  if (crash && await play(crash, scenarioEncoder(msg, prompt, crash, true)) !== 'continue') return;
  for (const route of turnReplies) {
    if (typeof route === 'string') {
      const scenario = scenarios.get(route);
      if (scenario) return play(scenario, scenarioEncoder(msg, prompt, scenario, true));
    } else {
      const [matches, reply] = route;
      const match = matches(prompt);
      if (match) return reply(prompt, msg, match);
    }
  }
  const failure = ['provider-error', ...PROVIDER_HOLD_SCENARIOS.map(([name]) => name)].map(name => scenarios.get(name)).find(Boolean);
  return handleNativeFailure(prompt, msg, failure, scenarioEncoder(msg, prompt, failure, true));
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
