#!/usr/bin/env node
import { productEnv } from './product-env.mjs';
import { OMP_FAILURES } from './mock-provider-failures.mjs';
import { loadControls } from './mock-controls.mjs';
import { scenarioFor, play } from './mock-scenario.mjs';
import readline from 'node:readline';
import { appendFileSync, closeSync } from 'node:fs';
import { rawMessage, stripCommandMessage } from './mock-session-context.mjs';
const { failureControl, delivery } = await loadControls({ delivery: ['reject', 'hold-ack', 'hold-response'] });
// Offline OMP (Oh My Pi) `--mode rpc` mock in OMP's own wire shape (v18.4.11, #595): the `ready`
// frame, id-echoed responses, `prompt_result`, `session_settled`. Startup argv and model errors
// are copied from the real binary (2026-10-05).
const { answerNudge } = await import('./mock-nudge.mjs');

const argv = process.argv.slice(2);
if (process.env.CEZ_MOCK_ARGS_FILE) appendFileSync(process.env.CEZ_MOCK_ARGS_FILE, `${JSON.stringify(argv)}\n`);

// OMP reports SIGTERM as 128 + 15 (real binary, 2026-10-05).
process.on('SIGTERM', () => process.exit(143));

const BUILTIN_TOOLS = ['read', 'bash', 'edit', 'ast_grep', 'ast_edit', 'ask', 'debug', 'ida', 'eval', 'github', 'glob', 'grep', 'find', 'lsp', 'checkpoint', 'rewind', 'context_notes', 'new_context', 'security_scan', 'task', 'wait', 'todo', 'web_search', 'write', 'memory_edit', 'retain', 'recall', 'reflect', 'learn', 'manage_skill'];
// Gated by `find.enabled` / `astGrep.enabled`, both off without user config.
const GATED_TOOLS = new Set(['find', 'ast_grep']);
const DEFAULT_TOOLS = ['read', 'bash', 'edit', 'eval', 'glob', 'grep', 'task', 'wait', 'todo', 'web_search', 'write'];
const VALUE_FLAGS = new Set(['--mode', '--extension', '--resume', '--append-system-prompt', '--model', '--thinking', '--add-dir', '--config', '--tools']);
const BOOLEAN_FLAGS = new Set(['--no-tools']);

function startupError(code, message) {
  process.stderr.write(`${message}\nRun \`omp --help\` for available flags.\n`);
  process.exit(code);
}

// No import or await on the ordinary mock path.
const wireRecorder = process.env.CEZ_MOCK_WIRE_FILE === undefined ? undefined
  : await import('./mock-wire-recorder.mjs');
wireRecorder?.installWireRecorder();
const flags = new Map();
const extensions = [];
// An older or different omp build without some flag: CEZ_MOCK_OMP_UNKNOWN_FLAGS=--add-dir.
const missingFlags = new Set((process.env.CEZ_MOCK_OMP_UNKNOWN_FLAGS ?? '').split(',').filter(Boolean));
const unknownFlags = [];
for (let i = 0; i < argv.length; i++) {
  const flag = argv[i];
  if (BOOLEAN_FLAGS.has(flag)) { flags.set(flag, true); continue; }
  if (!VALUE_FLAGS.has(flag) || missingFlags.has(flag)) { unknownFlags.push(flag); if (VALUE_FLAGS.has(flag)) i++; continue; }
  const value = argv[++i];
  if (flag === '--extension') extensions.push(value);
  flags.set(flag, value);
}
// OMP's parser reports every unrecognized occurrence in one error before any session work.
if (unknownFlags.length > 0) {
  startupError(2, `Error: unknown flag${unknownFlags.length === 1 ? '' : 's'}: ${unknownFlags.join(', ')}`);
}

let tools = flags.has('--no-tools') ? [] : DEFAULT_TOOLS;
if (typeof flags.get('--tools') === 'string') {
  tools = flags.get('--tools').split(',');
  // The CI extension registers cezar's tools (the preview tools only under CEZ_PREVIEW=1, the schedule tools unless CEZ_AUTOMATIONS=0); an MCP name needs a configured server, which the mock
  // takes from CEZ_MOCK_OMP_MCP_TOOLS (none by default, like a home without .omp/mcp.json).
  const mcpTools = (process.env.CEZ_MOCK_OMP_MCP_TOOLS ?? '').split(',').filter(Boolean);
  // Tools a user setting disabled (`todo.enabled: false`, `lsp.enabled: false`, ...) are built-ins
  // missing from the session, exactly like the settings-gated ones.
  const disabled = (process.env.CEZ_MOCK_OMP_DISABLED_TOOLS ?? '').split(',').filter(Boolean);
  const registered = (name) => (BUILTIN_TOOLS.includes(name) && !GATED_TOOLS.has(name) && !disabled.includes(name))
    || mcpTools.includes(name)
    || (extensions.length > 0 && (['cezar_wait', 'cezar_ask', 'cezar_cancel_wait', 'cezar_done'].includes(name) || ((name === 'cezar_preview_serve' || name === 'cezar_preview_stop') && productEnv('PREVIEW') === '1')
      || ((name === 'cezar_schedule_task' || name === 'cezar_scheduled_tasks') && productEnv('AUTOMATIONS') !== '0')));
  // Mirrors v18.4.11 `emt()`: every missing name in ONE error, unknown names first, then the
  // built-ins this session lacks, each line singular for one name.
  const missing = tools.filter((name) => !registered(name));
  const unknown = missing.filter((name) => !BUILTIN_TOOLS.includes(name));
  const unavailable = missing.filter((name) => BUILTIN_TOOLS.includes(name));
  const lines = [];
  if (unknown.length > 0) {
    lines.push(`Unknown tool${unknown.length === 1 ? '' : 's'} in --tools: ${unknown.join(', ')}.`);
    lines.push(`Built-in tools: ${BUILTIN_TOOLS.join(', ')}. Other registered tools: goal, init_experiment, run_experiment, log_experiment, update_notes.`);
  }
  if (unavailable.length > 0) lines.push(`Built-in tool${unavailable.length === 1 ? '' : 's'} unavailable in this session: ${unavailable.join(', ')}.`);
  if (lines.length > 0) startupError(2, `Error: ${lines.join('\n')}`);
}

if (process.env.CEZ_MOCK_OMP_NO_AUTH === '1') {
  process.stderr.write('No models available. Use /login or set an API key environment variable. Then use /model to select a model.\n\nSet an API key environment variable:\n  ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, etc.\n\nOr create ~/.omp/agent/models.yml\n');
  process.exit(1);
}

// The extension loads while OMP starts: with a CI target the mock lists and calls its tools now.
if (process.env.CEZ_MOCK_CI_PR) { const { probeCiTool } = await import('./mock-ci-tool.mjs'); await probeCiTool('omp', argv); }

// OMP v18.6.1 main.ts createSessionManager can implicitly continueRecent when autoResume
// is enabled. rpc-mode.ts get_state reports the restored conversation's messageCount.
const autoResume = process.env.CEZ_MOCK_OMP_AUTO_RESUME === '1';
const sessionId = typeof flags.get('--resume') === 'string' ? flags.get('--resume')
  : autoResume ? '019a0000-0000-7000-8000-0000000000bb' : '019a0000-0000-7000-8000-0000000000aa';
let steeringMode = 'one-at-a-time';
let messageUpdates = 'full';
const write = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const record = (value) => {
  if (!process.env.CEZ_MOCK_STDIN_FILE) return;
  try { appendFileSync(process.env.CEZ_MOCK_STDIN_FILE, `${JSON.stringify(value)}\n`); } catch { /* best effort */ }
};
const fail = (command, error) => write({ ...(command.id ? { id: command.id } : {}), type: 'response', command: command.type, success: false, error });
/** `RpcPromptResults.fail`/`completeLocal`: a prompt finished without the agent (v18.4.11). */
const localResult = (command, status, error) => write({ type: 'prompt_result', ...(command.id ? { id: command.id } : {}), agentInvoked: false, status, ...(error ? { error } : {}), sessionSettled: false });
const respond = (command, data) => write({ ...(command.id ? { id: command.id } : {}), type: 'response', command: command.type, success: true, ...(data === undefined ? {} : { data }) });

// A real broken input pipe before ready exercises the queued startup writes.
if (process.env.CEZ_MOCK_OMP_CLOSED_INPUT === '1') {
  closeSync(0);
  write({ type: 'ready' });
  setTimeout(() => process.exit(0), 300);
  await new Promise(() => {});
}

// Real startup order: `ready`, then three unsolicited frames before any command is answered.
write({ type: 'ready', protocolVersion: 1, supportedProtocolVersions: [1, 2], maxFrameBytes: 1048576, maxReassembledFrameBytes: 16777216 });
write({ type: 'extension_ui_request', id: 'mock-widget-1', method: 'setWidget', widgetKey: 'mock', widgetLines: [] });
write({ type: 'advisor_cost_changed' });
write({ type: 'available_commands_update', commands: [{ name: 'model', description: 'Select model' }] });

// Lifecycle calls use OMP's own extension configuration.
const ciTool = () => import('./mock-ci-tool.mjs');
const lifecycle = async (call) => (await ciTool()).lifecycleCall('omp', argv, ...call);
const scenarioContext = {
  runner: 'omp', lifecycle, session: {}, nativeFailureControl: Boolean(failureControl),
  toolPrompt: async prompt => (await ciTool()).toolPrompt('omp', argv, prompt),
  ciPrompt: async prompt => (await ciTool()).ciPrompt('omp', argv, prompt),
  async crash(prompt) {
    const { crashWithStderr } = await import('./mock-runner-crash.mjs');
    crashWithStderr(prompt, '{"type":"tool_execution_update","toolCallId":"truncated');
  },
};
const deferredStart = message => scenarioFor(message, scenarioContext)?.name === 'deferred-turn-start';
const isSteer = command => command.type === 'prompt' && command.streamingBehavior === 'steer';
// OMP's tool-approval error with no interactive UI (v18.4.11 tool wrapper, `runner.hasUI()` false).
const NO_UI_APPROVAL_ERROR = 'Tool "bash" requires approval but no interactive UI available.\nOptions:\n  1. Set tools.approvalMode: yolo in /settings\n  2. Add tools.approval.bash: allow to config\n  3. Use an interactive UI to approve the tool call';
/** The turn in flight: steers admitted into it are read before it ends (#505). */
let activeTurn = null;
let messageSeq = 0;

function messageUpdate(messageId, event) {
  const frame = { type: 'message_update', messageId, message: { role: 'assistant' }, assistantMessageEvent: event };
  // Without `messageUpdates: "delta"` each update also carries the message snapshot.
  if (messageUpdates !== 'delta') frame.assistantMessageEvent = { ...event, partial: { role: 'assistant', content: [] } };
  write(frame);
}

function userMessage(text) {
  const messageId = `msg-${++messageSeq}`;
  const message = { role: 'user', content: [{ type: 'text', text }] };
  write({ type: 'message_start', messageId, message });
  write({ type: 'message_end', messageId, message });
}

/** One assistant thinking block, then its usage-bearing message_end. */
function assistantThinking(text, { stopReason = 'stop', usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { total: 0.001 } } } = {}) {
  const messageId = `msg-${++messageSeq}`;
  write({ type: 'message_start', messageId, message: { role: 'assistant', content: [] } });
  messageUpdate(messageId, { type: 'thinking_start', contentIndex: 0 });
  messageUpdate(messageId, { type: 'thinking_delta', contentIndex: 0, delta: text });
  messageUpdate(messageId, { type: 'thinking_end', contentIndex: 0, content: text });
  write({ type: 'message_end', messageId, message: { role: 'assistant', content: [{ type: 'thinking', thinking: text }], provider: 'anthropic', model: 'claude-mock', usage, stopReason } });
}

/** One assistant message: text block (streamed as `deltas`), then its usage-bearing message_end. */
function assistantText(deltas, { stopReason = 'stop', usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { total: 0.001 } }, extra = {} } = {}) {
  const messageId = `msg-${++messageSeq}`;
  write({ type: 'message_start', messageId, message: { role: 'assistant', content: [] } });
  if (deltas.length > 0) {
    messageUpdate(messageId, { type: 'text_start', contentIndex: 0 });
    for (const delta of deltas) messageUpdate(messageId, { type: 'text_delta', contentIndex: 0, delta });
    messageUpdate(messageId, { type: 'text_end', contentIndex: 0, content: deltas.join('') });
  }
  write({ type: 'message_end', messageId, message: { role: 'assistant', content: [{ type: 'text', text: deltas.join('') }], provider: 'anthropic', model: 'claude-mock', usage, stopReason, ...extra } });
}

/** One complete sub-agent text message, wrapped in `subagent_event` (rpc-subagents.ndjson). */
function subagentText(id, text, usage) {
  const event = (inner) => write({ type: 'subagent_event', payload: { id, event: inner } });
  event({ type: 'message_start', message: { role: 'assistant', content: [] } });
  event({ type: 'message_update', message: { role: 'assistant' }, assistantMessageEvent: { type: 'text_start', contentIndex: 0 } });
  event({ type: 'message_update', message: { role: 'assistant' }, assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: text } });
  event({ type: 'message_update', message: { role: 'assistant' }, assistantMessageEvent: { type: 'text_end', contentIndex: 0, content: text } });
  event({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text }], stopReason: 'stop', ...(usage ? { usage } : {}) } });
}

function beginTurn(command) {
  activeTurn = { id: command?.id, steers: [] };
  write({ type: 'agent_start' });
  write({ type: 'turn_start' });
  if (command) userMessage(command.message);
}

/**
 * The terminal sequence: admitted steers are read in this turn (all of them under steering mode
 * `all`, the first otherwise), then the terminal `agent_end`, one `prompt_result` per admitted
 * prompt, and `session_settled` (rpc-prompt-results.ts, rpc-session-settle, v18.4.11).
 */
function endTurn({ status = 'completed', error, kind, settle = true } = {}) {
  const turn = activeTurn;
  activeTurn = null;
  const readNow = steeringMode === 'all' ? turn.steers : turn.steers.slice(0, 1);
  const deferred = steeringMode === 'all' ? [] : turn.steers.slice(1);
  if ((turn.late || status === 'error') && readNow.length > 0) {
    // A steer queued after the last model call: `AgentSession` rewrites this agent_end to
    // `isTerminal: false` while `agent.hasQueuedMessages()`, and the next run reads the queue
    // before the session settles (agent-session.ts, v18.4.11).
    write({ type: 'turn_end' });
    write({ type: 'agent_end', messages: [], isTerminal: false, yielded: false });
    write({ type: 'agent_start' });
    write({ type: 'turn_start' });
  }
  for (const steer of readNow) {
    userMessage(steer.message);
    if (status === 'error') providerFailure(kind);
    else assistantText([steer.message], { usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0 } } });
  }
  write({ type: 'turn_end' });
  write({ type: 'agent_end', messages: [], isTerminal: true, yielded: true });
  for (const prompt of [{ id: turn.id }, ...readNow]) {
    write({ type: 'prompt_result', ...(prompt.id ? { id: prompt.id } : {}), agentInvoked: true, status, ...(error ? { error } : {}), sessionSettled: settle });
  }
  if (settle) write({ type: 'session_settled' });
  for (const steer of deferred) queue = queue.then(() => handle({ type: 'prompt', id: steer.id, message: steer.message }));
}

const rl = readline.createInterface({ input: process.stdin });
let queue = Promise.resolve();
rl.on('line', (line) => {
  // Every raw command, in arrival order, for tests that pin what the runner wrote.
  if (process.env.CEZ_MOCK_OMP_COMMANDS_FILE) appendFileSync(process.env.CEZ_MOCK_OMP_COMMANDS_FILE, `${line}\n`);
  const command = stripCommandMessage(JSON.parse(line));
  // hearsay-tools/cezarion#1112: a late-ack steer is admitted after the turn's last model call.
  // OMP acknowledges it now and, never settling with a queued message, reads it in a further
  // run before `session_settled` (the endTurn `late` path).
  if (isSteer(command) && deferredStart(command.message) && command.message.includes(':late-ack')) {
    const admit = () => {
      if (!activeTurn) { setTimeout(admit, 5); return; }
      record({ userText: rawMessage(command), imageCount: (command.images ?? []).length, streamingBehavior: 'steer' });
      activeTurn.steers.push({ id: command.id, message: command.message });
      activeTurn.late = true;
      respond(command);
    };
    admit();
    return;
  }
  // hearsay-tools/cezarion#1112: a deferred-start steer is not admitted into the running turn;
  // OMP acknowledges it as its next prompt once that turn settles, with no turn open.
  if (isSteer(command) && activeTurn &&
    !deferredStart(command.message)) {
    record({ userText: rawMessage(command), imageCount: (command.images ?? []).length, streamingBehavior: 'steer' });
    // Steers OMP never hands to the running agent: none of them may end its turn.
    if (command.message.includes('mock:steer-rejected')) {
      // Rejected before admission: the error response only, the ticket is discarded.
      fail(command, 'input hook rejected the steer');
    } else if (command.message.includes('mock:steer-local-result')) {
      respond(command);
      localResult(command, 'completed');
    } else if (command.message.includes('mock:steer-local')) {
      respond(command, { agentInvoked: false });
    } else if (command.message.includes('mock:steer-failed')) {
      // Failed after admission: the ack, `onError`'s failure response, then `fail()`'s result.
      respond(command);
      fail(command, 'steer failed');
      localResult(command, 'error', { message: 'steer failed', retryable: false });
    } else {
      activeTurn.steers.push({ id: command.id, message: command.message });
      respond(command);
    }
    return;
  }
  queue = queue.then(() => handle(command));
});
// stdin EOF drains the queue and exits 0 (real binary, 2026-10-05).
/** Set by `mock:linger`: stdin EOF does not exit and SIGTERM is ignored (a wedged OMP). */
let linger = false;
rl.on('close', () => { if (!linger) queue.then(() => process.exit(0)); });

async function handle(command) {
  switch (command.type) {
    case 'get_state':
      respond(command, {
        sessionId,
        sessionFile: `/home/mock/.omp/agent/sessions/${sessionId}.jsonl`,
        model: { id: 'claude-mock', name: 'Claude Mock', api: 'anthropic-messages', provider: 'anthropic' },
        thinkingLevel: flags.get('--thinking') ?? 'medium',
        isStreaming: activeTurn !== null,
        isCompacting: false,
        isSettled: activeTurn === null,
        steeringMode,
        followUpMode: 'one-at-a-time',
        interruptMode: 'immediate',
        autoCompactionEnabled: true,
        messageCount: autoResume || flags.has('--resume') ? 4 : 0,
        ...(command.dumpTools ? { dumpTools: tools.map((name) => ({ name })) } : {}),
      });
      return;
    case 'set_steering_mode':
      if (command.mode === 'all' || command.mode === 'one-at-a-time') steeringMode = command.mode;
      record({ type: 'set_steering_mode', mode: command.mode });
      respond(command);
      return;
    case 'set_subagent_subscription':
      record({ type: 'set_subagent_subscription', level: command.level });
      respond(command, { level: command.level });
      return;
    case 'set_event_filter':
      messageUpdates = command.messageUpdates === 'delta' ? 'delta' : 'full';
      record({ type: 'set_event_filter', events: command.events, messageUpdates: command.messageUpdates });
      respond(command, { events: command.events ?? null, messageUpdates });
      return;
    case 'abort':
      respond(command);
      return;
    case 'prompt':
      record({ userText: rawMessage(command), imageCount: (command.images ?? []).length });
      // The delivery control reads both the prompt Cezar sent and a nudge's scripted answer.
      { const answered = answerNudge(command.message);
        return prompt({ ...command, message: answered }, answered === command.message ? answered : `${command.message}\n${answered}`); }
    default:
      write({ ...(command.id ? { id: command.id } : {}), type: 'response', command: command.type, success: false, error: `Unknown command: ${command.type}` });
  }
}

function respondLocalCommand(command, message, ack) {
  // A prompt OMP finished itself (a slash command): the response says so, no prompt_result.
  ack({ agentInvoked: false });
  return;
}

function respondLocalResult(command, message, ack) {
  ack();
  write({ type: 'prompt_result', ...(command.id ? { id: command.id } : {}), agentInvoked: false, status: 'completed', sessionSettled: true });
  return;
}

function respondPromptError(command, message, ack) {
  // The prompt failed after admission, before the agent ran: the ack, an error response,
  // then its prompt_result (rpc-mode.ts `onError` + `RpcPromptResults.fail`).
  ack();
  fail(command, 'Model not found: anthropic/claude-missing');
  write({ type: 'prompt_result', ...(command.id ? { id: command.id } : {}), agentInvoked: false, status: 'error', error: { message: 'Model not found: anthropic/claude-missing', provider: 'anthropic', model: 'claude-missing', retryable: false }, sessionSettled: true });
  return;
}

function respondPromptRejected(command, message, ack) {
  // Rejected before admission (an input hook threw): the error response only, no prompt_result.
  fail(command, 'input hook rejected the prompt');
}

async function respondSubagent(command, message, gated) {
  // #5/#600: the sub-agent's own terminal agent_end, nested under the parent's `task` call
  // (rpc-subagents.ndjson), must not end the parent turn; #149: its text stays nested.
  write({ type: 'tool_execution_start', toolCallId: 'toolu_task_1', toolName: 'task', args: { agent: 'explore', task: 'Review the change' } });
  write({ type: 'subagent_lifecycle', payload: { id: 'Reviewer', agent: 'explore', status: 'started', parentToolCallId: 'toolu_task_1', index: 0 } });
  write({ type: 'subagent_event', payload: { id: 'Reviewer', event: { type: 'agent_start' } } });
  write({ type: 'subagent_event', payload: { id: 'Reviewer', event: { type: 'tool_execution_start', toolCallId: 'toolu_child_grep', toolName: 'grep', args: { pattern: 'ask' } } } });
  write({ type: 'subagent_event', payload: { id: 'Reviewer', event: { type: 'tool_execution_end', toolCallId: 'toolu_child_grep', toolName: 'grep', result: { content: [{ type: 'text', text: '3 matches' }] } } } });
  write({ type: 'subagent_event', payload: { id: 'Reviewer', event: { type: 'agent_end', messages: [], isTerminal: true, yielded: true } } });
  write({ type: 'subagent_lifecycle', payload: { id: 'Reviewer', agent: 'explore', status: 'completed', parentToolCallId: 'toolu_task_1', index: 0 } });
  write({ type: 'tool_execution_end', toolCallId: 'toolu_task_1', toolName: 'task', result: { content: [{ type: 'text', text: 'Reviewer: done' }] }, isError: false });
  // The parent keeps streaming after the child's terminal frame.
  assistantText(['Still working after the sub-agent.' + await lifecycle((await ciTool()).wait('Re-check the sub-agent.'))]);
  // Late child text after the parent's text; the second block never completes.
  subagentText('Reviewer', 'Child review finished.', { input: 20, output: 10, cacheRead: 100, cacheWrite: 4, totalTokens: 134, cost: { total: 0.002 } });
  write({ type: 'subagent_event', payload: { id: 'Reviewer', event: { type: 'message_update', message: { role: 'assistant' }, assistantMessageEvent: { type: 'text_start', contentIndex: 0 } } } });
  write({ type: 'subagent_event', payload: { id: 'Reviewer', event: { type: 'message_update', message: { role: 'assistant' }, assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Child review still streaming.' } } } });
  endTurn();
  return;
}

function respondApprovalDenied(command, message, gated) {
  // A user's stricter `tools.approvalMode`: OMP fails the call closed when no UI can approve it.
  write({ type: 'tool_execution_start', toolCallId: 'tool-denied', toolName: 'bash', args: { command: 'rm -rf build' } });
  write({ type: 'tool_execution_end', toolCallId: 'tool-denied', toolName: 'bash', result: { content: [{ type: 'text', text: NO_UI_APPROVAL_ERROR }] }, isError: true });
  assistantText(['The command needs approval I cannot get here.']);
  endTurn();
  return;
}

function respondNoSettle(command, message) {
  // The stream ends mid-turn after a failed attempt: no agent_end, no settle.
  assistantText([], { stopReason: 'error', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } }, extra: { errorMessage: 'Overloaded' } });
  process.exit(0);
}

async function respondDefault(command, message) {
  assistantText([`Investigating: `, message]);
  write({ type: 'tool_execution_start', toolCallId: 'tool-1', toolName: 'read', args: { path: 'README.md' } });
  write({ type: 'tool_execution_end', toolCallId: 'tool-1', toolName: 'read', result: { content: [{ type: 'text', text: 'mock file' }] }, isError: false });
  assistantText(['Done with the first pass.'], { usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } } });
  endTurn();
  if (message.includes('mock:wake-after-settle')) {
    // OMP resumes on its own after settling (async work finished): a new agent run, no prompt.
    await sleep(250);
    beginTurn();
    assistantText(['woke after settle']);
    write({ type: 'turn_end' });
    write({ type: 'agent_end', messages: [], isTerminal: true, yielded: true });
    activeTurn = null;
    write({ type: 'session_settled' });
  }
}

// These prompts finish before a native agent turn opens. Keep their admission order.
const localPromptScenarios = [
  { matches: message => message.includes('mock:local-command'), respond: respondLocalCommand },
  { matches: message => message.includes('mock:local-result'), respond: respondLocalResult },
  { matches: message => message.includes('mock:prompt-error'), respond: respondPromptError },
  { matches: message => message.includes('mock:prompt-rejected'), respond: respondPromptRejected },
];

// Native OMP scenarios still run before its provider failure control.
const promptScenarios = [
  { matches: message => message.includes('mock:subagent'), respond: respondSubagent },
  { matches: message => message.includes('mock:approval-denied'), respond: respondApprovalDenied },
];

// Preserve OMP's pre-failure placement for scenarios that other mocks run later.
const beforeNativeFailure = new Set(['busy-progress', 'no-progress', 'cezar-ask',
  'subagent-after-park', 'steer-late', 'hold-cezar-done', 'hold-cezar-ask', 'cezar-done']);


function providerFailure(kind = 'provider') {
  const message = OMP_FAILURES[kind];
  const error = { message, provider: 'anthropic', model: 'claude-mock', retryable: kind !== 'provider' };
  assistantText([], { stopReason: 'error', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } }, extra: { errorMessage: message } });
  return error;
}

function providerError(kind = 'provider') {
  endTurn({ status: 'error', error: providerFailure(kind), kind });
}

function toolFrame(kind, call, child = false) {
  if (kind === 'start') return { type: 'tool_execution_start', toolCallId: call.id, toolName: call.name, args: call.input };
  return { type: 'tool_execution_end', toolCallId: call.id, toolName: call.name,
    result: { content: [{ type: 'text', text: call.output }] }, ...(!child ? { isError: call.isError } : {}) };
}

function scenarioChild(step, playChild) {
  const event = inner => write({ type: 'subagent_event', payload: { id: step.id, event: inner } });
  const lifecycle = status => write({ type: 'subagent_lifecycle', payload: { id: step.id, agent: 'explore', status, parentToolCallId: 'toolu_park_task', index: 0 } });
  if (step.phase === 'start') lifecycle('started');
  const result = playChild({
    ...scenarioEncoder(),
    text: ({ parts }) => subagentText(step.id, parts.join('')),
    toolStart: ({ call }) => event(toolFrame('start', call, true)),
    toolEnd: ({ call }) => event(toolFrame('end', call, true)),
  });
  const finish = () => {
    if (step.phase !== 'end') return;
    event({ type: 'agent_end', messages: [], isTerminal: true, yielded: true });
    lifecycle('completed');
  };
  if (result instanceof Promise) return result.then(finish);
  finish();
}

/** OMP owns acknowledgement, usage, message ids and admitted-steer replay. */
function scenarioEncoder(command, ack, state = { acknowledged: false, opened: false }) {
  return {
    closeInput: () => closeSync(0),
    open(step) {
      if (!state.acknowledged && !step.acknowledged) { ack(); state.acknowledged = true; }
      if (step.ackOnly || state.opened) return;
      beginTurn(command);
      state.opened = true;
      return delivery?.holdResponse(command.message);
    },
    text: ({ parts }) => assistantText(parts),
    reply: () => respondDefault(command, command.message),
    reasoning: ({ text }) => assistantThinking(text),
    toolStart: ({ call }) => write(toolFrame('start', call)),
    toolEnd: ({ call }) => write(toolFrame('end', call)),
    child: scenarioChild,
    progress: () => write({ type: 'tool_execution_update', toolCallId: 'busy', toolName: 'bash', args: { command: 'build' }, partialResult: { content: [{ type: 'text', text: 'working' }] } }),
    readSteers(step) { if (step.late) activeTurn.late = true; },
    end(step) { if (step.error) providerError(step.error); else endTurn(); },
  };
}

async function prompt(command, sent = command.message) {
  const message = command.message;
  // Rejected before admission: OMP's error response only, no prompt_result (rpc-mode.ts).
  if (delivery?.rejects(sent)) { fail(command, 'owned turn rejected'); return; }
  // Every successful admission acknowledges through here, so a configured hold-ack holds it
  // whichever scenario branch answers the prompt.
  const ack = (extra) => { if (delivery) delivery.ack(sent, () => respond(command, extra)); else respond(command, extra); };
  const local = localPromptScenarios.find(scenario => scenario.matches(message));
  if (local) { local.respond(command, message, ack); return; }

  if (message.includes('mock:linger')) {
    linger = true;
    process.removeAllListeners('SIGTERM');
    process.on('SIGTERM', () => {});
    // Test-cleanup backstop, deliberately longer than the asserted teardown bound.
    setTimeout(() => process.exit(0), 12_000).unref?.();
    setInterval(() => {}, 1_000);
  }

  if (message.includes('mock:self-kill')) {
    // An outside SIGKILL (OOM killer): close reports exitCode null with signalCode set.
    process.kill(process.pid, 'SIGKILL');
    return;
  }

  return respondScenarios(command, message, ack);
}

async function respondScenarios(command, message, ack) {
  const state = { acknowledged: false, opened: false };
  const encoder = scenarioEncoder(command, ack, state);
  const early = scenarioFor(message, scenarioContext);
  if (early?.early && await play(early, encoder) !== 'continue') return;
  const scenario = scenarioFor(message, { ...scenarioContext, unsupported: early?.early ? [early.name] : [] });
  if (scenario && (scenario.beforeFailure || beforeNativeFailure.has(scenario.name))) return play(scenario, encoder);
  // Deferred scripts delay their opening, then enter the same admitted native path.
  if (scenario?.name === 'deferred-turn-start') {
    encoder.reply = () => respondNativeTurn(command, message, undefined, encoder);
    return play(scenario, encoder);
  }
  const opening = encoder.open({});
  if (opening instanceof Promise) await opening;
  return respondNativeTurn(command, message, scenario, encoder);
}

async function respondNativeTurn(command, message, scenario, encoder) {
  const native = promptScenarios.find(scenario => scenario.matches(message));
  if (native) return native.respond(command, message);
  const selectedFailure = failureControl?.failureFor(message);
  const nativeFailure = selectedFailure instanceof Promise ? await selectedFailure : selectedFailure;
  if (nativeFailure === 'provider') return providerError();
  if (message.includes('mock:no-settle')) return respondNoSettle(command, message);
  if (scenario) return play(scenario, encoder);
  return respondDefault(command, message);
}
