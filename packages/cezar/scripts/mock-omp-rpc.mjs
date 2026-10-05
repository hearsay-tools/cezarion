#!/usr/bin/env node
// Offline OMP (Oh My Pi) `--mode rpc` mock in OMP's own wire shape (v18.4.11, #595): the `ready`
// frame, id-echoed responses, `prompt_result`, `session_settled`. Startup argv and model errors
// are copied from the real binary (2026-10-05). Keep it standalone: optional scenario helpers
// are imported lazily.
import readline from 'node:readline';
import { appendFileSync } from 'node:fs';

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

const flags = new Map();
const extensions = [];
for (let i = 0; i < argv.length; i++) {
  const flag = argv[i];
  if (BOOLEAN_FLAGS.has(flag)) { flags.set(flag, true); continue; }
  if (!VALUE_FLAGS.has(flag)) startupError(2, `Error: unknown flag: ${flag}`);
  const value = argv[++i];
  if (flag === '--extension') extensions.push(value);
  flags.set(flag, value);
}

let tools = flags.has('--no-tools') ? [] : DEFAULT_TOOLS;
if (typeof flags.get('--tools') === 'string') {
  tools = flags.get('--tools').split(',');
  // An extension registers cezar's tool; an MCP name needs a configured server, which the mock
  // takes from CEZ_MOCK_OMP_MCP_TOOLS (none by default, like a home without .omp/mcp.json).
  const mcpTools = (process.env.CEZ_MOCK_OMP_MCP_TOOLS ?? '').split(',').filter(Boolean);
  const known = (name) => BUILTIN_TOOLS.includes(name) || mcpTools.includes(name) || (name === 'cezar_wait_for_ci' && extensions.length > 0);
  const unknown = tools.find((name) => !known(name));
  if (unknown) {
    startupError(2, `Error: Unknown tool in --tools: ${unknown}.\nBuilt-in tools: ${BUILTIN_TOOLS.join(', ')}. Other registered tools: goal, init_experiment, run_experiment, log_experiment, update_notes.`);
  }
  const gated = tools.filter((name) => GATED_TOOLS.has(name));
  if (gated.length > 0) startupError(2, `Error: Built-in tools unavailable in this session: ${gated.join(', ')}.`);
  // Tools a user setting disabled (`todo.enabled: false`, `lsp.enabled: false`, ...): real v18.4.11
  // rejects them the same way, in the singular for one name.
  const disabled = (process.env.CEZ_MOCK_OMP_DISABLED_TOOLS ?? '').split(',').filter(Boolean);
  const named = tools.filter((name) => disabled.includes(name));
  if (named.length > 0) startupError(2, `Error: Built-in tool${named.length > 1 ? 's' : ''} unavailable in this session: ${named.join(', ')}.`);
}

if (process.env.CEZ_MOCK_OMP_NO_AUTH === '1') {
  process.stderr.write('No models available. Use /login or set an API key environment variable. Then use /model to select a model.\n\nSet an API key environment variable:\n  ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, etc.\n\nOr create ~/.omp/agent/models.yml\n');
  process.exit(1);
}

// A fresh session mints a uuid v7; `--resume <id>` keeps the resumed session's id.
const sessionId = typeof flags.get('--resume') === 'string' ? flags.get('--resume') : '019a0000-0000-7000-8000-0000000000aa';
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

// Real startup order: `ready`, then three unsolicited frames before any command is answered.
write({ type: 'ready', protocolVersion: 1, supportedProtocolVersions: [1, 2], maxFrameBytes: 1048576, maxReassembledFrameBytes: 16777216 });
write({ type: 'extension_ui_request', id: 'mock-widget-1', method: 'setWidget', widgetKey: 'mock', widgetLines: [] });
write({ type: 'advisor_cost_changed' });
write({ type: 'available_commands_update', commands: [{ name: 'model', description: 'Select model' }] });

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
function endTurn({ status = 'completed', error, settle = true } = {}) {
  const turn = activeTurn;
  activeTurn = null;
  const readNow = steeringMode === 'all' ? turn.steers : turn.steers.slice(0, 1);
  const deferred = steeringMode === 'all' ? [] : turn.steers.slice(1);
  for (const steer of readNow) {
    userMessage(steer.message);
    assistantText([steer.message], { usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0 } } });
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
  const command = JSON.parse(line);
  if (command.type === 'prompt' && command.streamingBehavior === 'steer' && activeTurn) {
    record({ userText: command.message, imageCount: (command.images ?? []).length, streamingBehavior: 'steer' });
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
rl.on('close', () => { queue.then(() => process.exit(0)); });

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
        messageCount: 0,
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
      record({ userText: command.message, imageCount: (command.images ?? []).length });
      return prompt(command);
    default:
      write({ ...(command.id ? { id: command.id } : {}), type: 'response', command: command.type, success: false, error: `Unknown command: ${command.type}` });
  }
}

async function prompt(command) {
  const message = command.message;
  if (message.includes('mock:local-command')) {
    // A prompt OMP finished itself (a slash command): the response says so, no prompt_result.
    respond(command, { agentInvoked: false });
    return;
  }
  if (message.includes('mock:local-result')) {
    respond(command);
    write({ type: 'prompt_result', ...(command.id ? { id: command.id } : {}), agentInvoked: false, status: 'completed', sessionSettled: true });
    return;
  }
  if (message.includes('mock:prompt-error')) {
    // The prompt failed after admission, before the agent ran: the ack, an error response,
    // then its prompt_result (rpc-mode.ts `onError` + `RpcPromptResults.fail`).
    respond(command);
    fail(command, 'Model not found: anthropic/claude-missing');
    write({ type: 'prompt_result', ...(command.id ? { id: command.id } : {}), agentInvoked: false, status: 'error', error: { message: 'Model not found: anthropic/claude-missing', provider: 'anthropic', model: 'claude-missing', retryable: false }, sessionSettled: true });
    return;
  }
  if (message.includes('mock:prompt-rejected')) {
    // Rejected before admission (an input hook threw): the error response only, no prompt_result.
    fail(command, 'input hook rejected the prompt');
    return;
  }

  respond(command);
  beginTurn(command);
  if (message.includes('mock:steer-tool')) {
    write({ type: 'tool_execution_start', toolCallId: 'tool-steer', toolName: 'bash', args: { command: 'wait' } });
    await sleep(Number(process.env.CEZ_MOCK_STEER_MS ?? 600));
    write({ type: 'tool_execution_end', toolCallId: 'tool-steer', toolName: 'bash', result: { content: [{ type: 'text', text: 'waited' }] }, isError: false });
    assistantText(['steer tool done']);
    endTurn();
    return;
  }
  if (message.includes('mock:provider-error')) {
    const error = { message: 'Not Found', provider: 'anthropic', model: 'claude-mock', retryable: false };
    assistantText([], { stopReason: 'error', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } }, extra: { errorMessage: 'Not Found' } });
    endTurn({ status: 'error', error });
    return;
  }
  if (message.includes('mock:no-settle')) {
    // The stream ends mid-turn after a failed attempt: no agent_end, no settle.
    assistantText([], { stopReason: 'error', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } }, extra: { errorMessage: 'Overloaded' } });
    process.exit(0);
  }
  if (message.includes('mock:hold')) {
    // Content and the settle both trail the prompt ack, so a turn-end derived from the ack
    // (or a short deadline) is caught before any content arrives.
    await sleep(250);
    assistantText(['parity hold: content after the pause']);
    await sleep(250);
    endTurn();
    return;
  }
  if (message.includes('mock:done')) {
    assistantText(['parity done: the task is complete\n\nCEZ:DONE']);
    endTurn();
    return;
  }

  assistantText([`Investigating: `, message]);
  write({ type: 'tool_execution_start', toolCallId: 'tool-1', toolName: 'read', args: { path: 'README.md' } });
  write({ type: 'tool_execution_end', toolCallId: 'tool-1', toolName: 'read', result: { content: [{ type: 'text', text: 'mock file' }] }, isError: false });
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
