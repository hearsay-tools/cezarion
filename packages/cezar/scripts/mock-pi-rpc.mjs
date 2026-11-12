#!/usr/bin/env node
import { PI_FAILURES } from './mock-provider-failures.mjs';
import { loadControls } from './mock-controls.mjs';
import { scenarioFor, play } from './mock-scenario.mjs';
import { closeSync } from 'node:fs';
import readline from 'node:readline';
import { appendFileSync } from 'node:fs';
import { rawMessage, stripCommandMessage } from './mock-session-context.mjs';
const { failureControl, delivery } = await loadControls({ delivery: ['reject', 'hold-ack', 'hold-response'] });
const { answerNudge } = await import('./mock-nudge.mjs');

if (process.env.CEZ_MOCK_ARGS_FILE) appendFileSync(process.env.CEZ_MOCK_ARGS_FILE, `${JSON.stringify(process.argv.slice(2))}\n`);

// Pi handles SIGTERM and reports 128 + signal, rather than a null exit code.
process.on('SIGTERM', () => process.exit(143));

if (process.env.CEZ_MOCK_CI_PR) { const { probeCiTool } = await import('./mock-ci-tool.mjs'); await probeCiTool('pi', process.argv.slice(2)); }
const sessionId = '00000000-0000-4000-8000-0000000000pi';
// No import or await on the ordinary mock path.
const wireRecorder = process.env.CEZ_MOCK_WIRE_FILE === undefined ? undefined
  : await import('./mock-wire-recorder.mjs');
wireRecorder?.installWireRecorder();
const write = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
// #505: like pi 0.87, a prompt with streamingBehavior 'steer' joins the running
// turn. Steers accepted by a scripted turn are read just before it settles: a user
// message_start/end, then an echo, unless the turn is `late` (never read).
let activeTurn = null;
// Pi 0.87 defaults steeringMode to one-at-a-time (#551). Squawk's runner must
// send set_steering_mode all for a burst to reach the same next step.
let steeringMode = 'one-at-a-time';
// The prompt a queued handler is running; pi records it as the turn's user message.
let currentPrompt;
const scenarioContext = {
  runner: 'pi', lifecycle, session: {}, unsupported: ['subagent-after-park'], nativeFailureControl: Boolean(failureControl),
  toolPrompt: async prompt => (await tools()).toolPrompt('pi', process.argv.slice(2), prompt),
  ciPrompt: async prompt => (await tools()).ciPrompt('pi', process.argv.slice(2), prompt),
  async crash(prompt) {
    const { crashWithStderr } = await import('./mock-runner-crash.mjs');
    crashWithStderr(prompt, '{"type":"tool_execution_update","toolCallId":"truncated');
  },
};
const deferredStart = message => scenarioFor(message, scenarioContext)?.name === 'deferred-turn-start';
const sendNow = (value) => {
  // Held frames can reach this path after a steer was admitted. A provider error
  // must also fail the model call that drains steering, rather than echoing success.
  if (value?.type === 'message_end' && value.message?.stopReason === 'error' && activeTurn) activeTurn.failure = value;
  if (value?.type === 'turn_start' && !activeTurn) {
    activeTurn = { steers: [], late: false };
    write(value);
    if (currentPrompt !== undefined && process.env.CEZ_MOCK_PI_NO_USER_START !== '1') {
      const message = { role: 'user', content: [{ type: 'text', text: currentPrompt }] };
      currentPrompt = undefined;
      write({ type: 'message_start', message });
      write({ type: 'message_end', message });
    }
    return;
  }
  if (value?.type === 'agent_settled' && activeTurn) {
    const turn = activeTurn; activeTurn = null;
    const deliverNow = turn.late ? [] : (steeringMode === 'all' ? turn.steers : turn.steers.slice(0, 1));
    const defer = turn.late ? turn.steers : (steeringMode === 'all' ? [] : turn.steers.slice(1));
    for (const text of deliverNow) replaySteer(text, turn.failure);
    write(value);
    // one-at-a-time leftover, or a late steer, runs as the next prompt.
    for (const text of defer) queue = queue.then(() => { currentPrompt = text; return handle({ type: 'prompt', message: text }); });
    return;
  }
  write(value);
};

function replaySteer(text, failure) {
  if (failure) {
    write({ type: 'turn_end', message: failure.message, toolResults: [] });
    write({ type: 'agent_end', messages: [], willRetry: false });
    write({ type: 'agent_start' });
    write({ type: 'turn_start' });
  }
  write({ type: 'message_start', message: { role: 'user', content: [{ type: 'text', text }] } });
  write({ type: 'message_end', message: { role: 'user', content: [{ type: 'text', text }] } });
  if (failure) write(failure);
  else {
    sendText([text]);
    write({ type: 'message_end', message: { role: 'assistant', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } } });
  }
}
// A configured delivery control decides when a prompt's acknowledgement and its turn content
// go out. Every scripted branch sends through here, so none of them needs its own hook.
const deliveryTexts = new Map();
let heldFrames;
const send = !delivery ? sendNow : (value) => {
  if (value?.type === 'response' && value.command === 'prompt' && value.success && deliveryTexts.has(value.id)) {
    const text = deliveryTexts.get(value.id);
    deliveryTexts.delete(value.id);
    delivery.ack(text, () => sendNow(value));
    return;
  }
  if (heldFrames && value?.type !== 'response' && value?.type !== 'agent_start' && value?.type !== 'turn_start') {
    heldFrames.push(value);
    return;
  }
  sendNow(value);
};
/** One queued prompt under a configured control, before any scenario branch answers it. A
 * rejected prompt still reached pi's RPC, so it is recorded. A held response keeps the prompt
 * queue pending until its frames are flushed: the next prompt's turn never starts inside it. */
async function handleControlled(command) {
  if (delivery.rejects(command.message)) {
    if (process.env.CEZ_MOCK_STDIN_FILE) appendFileSync(process.env.CEZ_MOCK_STDIN_FILE, `${JSON.stringify({ userText: rawMessage(command), imageCount: (command.images ?? []).length })}\n`);
    write({ id: command.id, type: 'response', command: 'prompt', success: false, error: { message: 'owned turn rejected' } });
    return;
  }
  if (command.id !== undefined) deliveryTexts.set(command.id, command.message);
  const hold = delivery.holdResponse(command.message);
  const frames = hold ? heldFrames = [] : undefined;
  await handleCommand(command);
  if (!hold) return;
  await hold;
  heldFrames = undefined;
  for (const frame of frames) send(frame);
}

// Tool execution stays on the native pi extension. Scenario scripts decide when to call it.
const tools = () => import('./mock-ci-tool.mjs');
async function lifecycle(call) { return (await tools()).lifecycleCall('pi', process.argv.slice(2), ...call); }

/** The text_start / text_delta* / text_end trio pi streams for one assistant block. */
function sendText(deltas) {
  const content = deltas.join('');
  send({ type: 'message_update', message: {}, assistantMessageEvent: { type: 'text_start', contentIndex: 0, partial: {} } });
  for (const delta of deltas) {
    send({ type: 'message_update', message: {}, assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta, partial: {} } });
  }
  send({ type: 'message_update', message: {}, assistantMessageEvent: { type: 'text_end', contentIndex: 0, content, partial: {} } });
}

/** Native thinking block — contentIndex 1 when a text block already occupied 0. */
function sendThinking(text, contentIndex = 0) {
  send({ type: 'message_update', message: {}, assistantMessageEvent: { type: 'thinking_start', contentIndex, partial: {} } });
  send({ type: 'message_update', message: {}, assistantMessageEvent: { type: 'thinking_delta', contentIndex, delta: text, partial: {} } });
  send({ type: 'message_update', message: {}, assistantMessageEvent: { type: 'thinking_end', contentIndex, content: text, partial: {} } });
}

/** The terminal quartet: usage-bearing message_end, then turn/agent settle. */
function sendTurnEnd(usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } }) {
  send({ type: 'message_end', message: { role: 'assistant', usage } });
  send({ type: 'turn_end', message: {}, toolResults: [] });
  send({ type: 'agent_end', messages: [], willRetry: false });
  send({ type: 'agent_settled' });
}

const rl = readline.createInterface({ input: process.stdin });
let queue = Promise.resolve();
rl.on('line', (line) => {
  const command = stripCommandMessage(JSON.parse(line));
  // hearsay-tools/cezarion#1112: a late-ack steer is admitted into the running turn after its
  // last model call: pi acknowledges it now, with the turn open, and reads it as its next
  // prompt once that turn settles (the `mock:steer-late` ordering), starting that run late.
  if (command.type === 'prompt' && command.streamingBehavior === 'steer' && deferredStart(command.message) && command.message.includes(':late-ack')) {
    const admit = () => {
      if (!activeTurn) { setTimeout(admit, 5); return; }
      if (process.env.CEZ_MOCK_STDIN_FILE) appendFileSync(process.env.CEZ_MOCK_STDIN_FILE, `${JSON.stringify({ userText: rawMessage(command), imageCount: 0, streamingBehavior: 'steer' })}\n`);
      activeTurn.steers.push(command.message);
      activeTurn.late = true;
      write({ id: command.id, type: 'response', command: 'prompt', success: true });
    };
    admit();
    return;
  }
  // hearsay-tools/cezarion#1112: a deferred-start steer is not admitted into the running turn;
  // pi acknowledges it as its next prompt once that turn settles, with no turn open.
  if (command.type === 'prompt' && command.streamingBehavior === 'steer' && activeTurn &&
    !deferredStart(command.message)) {
    if (process.env.CEZ_MOCK_STDIN_FILE) appendFileSync(process.env.CEZ_MOCK_STDIN_FILE, `${JSON.stringify({ userText: rawMessage(command), imageCount: 0, streamingBehavior: 'steer' })}\n`);
    activeTurn.steers.push(command.message);
    write({ id: command.id, type: 'response', command: 'prompt', success: true });
    return;
  }
  queue = queue.then(() => { currentPrompt = command.type === 'prompt' ? command.message : undefined; return handle(command); });
});
rl.on('close', () => { queue.then(() => process.exit(0)); });

function handle(command) {
  return delivery && command.type === 'prompt' ? handleControlled(command) : handleCommand(command);
}

function respondState(command) {
  send({
    id: command.id,
    type: 'response',
    command: 'get_state',
    success: true,
    data: {
      sessionId,
      thinkingLevel: 'medium',
      isStreaming: false,
      isCompacting: false,
      steeringMode,
      followUpMode: 'one-at-a-time',
      autoCompactionEnabled: true,
      messageCount: 0,
      pendingMessageCount: 0,
    },
  });
}

function respondProviderError(command) {
  // An assistant `message_end` whose stopReason is `error` — the wire shape of
  // `src/core/__fixtures__/pi/provider-error.ndjson`, with a 400 detail instead
  // of its transport diagnostic (hearsay-tools/squawk#3337). #54: this arrived
  // before `agent_settled` and the run parked as "Needs You" instead of
  // failing (harness parity S7).
  send({ id: command.id, type: 'response', command: 'prompt', success: true });
  send({ type: 'agent_start' });
  send({ type: 'turn_start' });
  sendProviderError();
}


function sendProviderError(kind = 'provider') {
  send({ type: 'message_end', message: {
    role: 'assistant',
    content: [],
    api: 'openai-codex-responses',
    provider: 'openai-codex',
    model: 'gpt-5.6-sol',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } },
    stopReason: 'error',
    errorMessage: PI_FAILURES[kind],
  } });
  send({ type: 'agent_settled' });
}

async function respondDefault(command) {
  send({ id: command.id, type: 'response', command: 'prompt', success: true });
  send({ type: 'agent_start' });
  send({ type: 'turn_start' });
  return sendDefaultReply(command);
}

function sendDefaultReply(command) {
  const responseText = `Investigating: ${command.message}`;
  send({
    type: 'message_update',
    message: {},
    assistantMessageEvent: { type: 'text_start', contentIndex: 0, partial: {} },
  });
  send({
    type: 'message_update',
    message: {},
    assistantMessageEvent: {
      type: 'text_delta',
      contentIndex: 0,
      delta: responseText,
      partial: {},
    },
  });
  send({
    type: 'message_update',
    message: {},
    assistantMessageEvent: {
      type: 'text_end',
      contentIndex: 0,
      content: responseText,
      partial: {},
    },
  });
  send({ type: 'tool_execution_start', toolCallId: 'tool-1', toolName: 'read', args: { path: 'README.md' } });
  send({
    type: 'tool_execution_end',
    toolCallId: 'tool-1',
    toolName: 'read',
    result: { content: [{ type: 'text', text: 'mock file' }] },
    isError: false,
  });
  sendText(['Done with the first pass.']);
  send({
    type: 'message_end',
    message: {
      role: 'assistant',
      usage: {
        input: 10,
        output: 5,
        cacheRead: 0,
        cacheWrite: 0,
        cost: { total: 0.001 },
      },
    },
  });
  send({ type: 'turn_end', message: {}, toolResults: [] });
  send({ type: 'agent_end', messages: [], willRetry: false });
  send({ type: 'agent_settled' });
  sendBackendResume(command);
}

/** Runner-only activity may resume a turn after either default reply path parks. */
function sendBackendResume(command) {
  if (command.message.includes('mock:backend-resume-text')) {
    setTimeout(() => {
      send({
        type: 'message_update',
        message: {},
        assistantMessageEvent: { type: 'text_start', contentIndex: 0, partial: {} },
      });
      send({
        type: 'message_update',
        message: {},
        assistantMessageEvent: {
          type: 'text_delta',
          contentIndex: 0,
          delta: 'Pi resumed without a prompt',
          partial: {},
        },
      });
      send({
        type: 'message_update',
        message: {},
        assistantMessageEvent: {
          type: 'text_end',
          contentIndex: 0,
          content: 'Pi resumed without a prompt',
          partial: {},
        },
      });
    }, 250);
  } else if (command.message.includes('mock:backend-resume')) {
    setTimeout(() => {
      send({
        type: 'tool_execution_start',
        toolCallId: 'pi-autonomous-edit',
        toolName: 'edit',
        args: { path: 'src/a.ts', oldText: 'old', newText: 'new' },
      });
      send({
        type: 'tool_execution_end',
        toolCallId: 'pi-autonomous-edit',
        toolName: 'edit',
        result: { content: [{ type: 'text', text: 'updated' }] },
        isError: false,
      });
    }, 250);
  }
}

function respondSteeringMode(command) {
  if (command.mode === 'all' || command.mode === 'one-at-a-time') steeringMode = command.mode;
  if (process.env.CEZ_MOCK_STDIN_FILE) {
    try { appendFileSync(process.env.CEZ_MOCK_STDIN_FILE, `${JSON.stringify({ type: 'set_steering_mode', mode: command.mode })}\n`); } catch { /* best effort */ }
  }
  send({ ...(command.id ? { id: command.id } : {}), type: 'response', command: 'set_steering_mode', success: true });
}

function recordPrompt(command) {
  // Testability hook, mirroring mock-claude: CEZ_MOCK_STDIN_FILE=<path> appends
  // each inbound prompt's text and image count, so tests can assert what the
  // runner actually wrote onto the RPC (harness parity's AgentRunSpec probes).
  if (process.env.CEZ_MOCK_STDIN_FILE) {
    try {
      appendFileSync(process.env.CEZ_MOCK_STDIN_FILE, `${JSON.stringify({ userText: rawMessage(command), imageCount: (command.images ?? []).length })}\n`);
    } catch {
      // best effort — never break the mock over the hook
    }
  }
}

/** Pi alone owns acknowledgements, native ids, usage and steering admission. */
function scenarioEncoder(command, scenario) {
  return {
    closeInput: () => closeSync(0),
    open(step) {
      if (!step.acknowledged) send({ id: command.id, type: 'response', command: 'prompt', success: true });
      if (step.ackOnly) {
        if (step.agentStart) send({ type: 'agent_start' });
        return;
      }
      if (!step.agentStarted) send({ type: 'agent_start' });
      send({ type: 'turn_start' });
    },
    reply: () => sendDefaultReply(command),
    text: step => sendText(step.parts),
    reasoning(step) {
      if (step.complete) send({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'thinking', thinking: step.text }], stopReason: 'stop' } });
      else sendThinking(step.text, step.index);
    },
    toolStart: ({ call }) => send({ type: 'tool_execution_start', toolCallId: call.id, toolName: call.name, args: call.input }),
    toolEnd: ({ call }) => send({ type: 'tool_execution_end', toolCallId: call.id, toolName: call.name, result: { content: [{ type: 'text', text: call.output }] }, isError: call.isError }),
    child() { throw new Error('Pi has no child wire'); },
    progress: () => send({ type: 'tool_execution_update', toolCallId: 'busy', toolName: 'bash', partialResult: { content: [{ type: 'text', text: 'working' }] } }),
    // Pi reads admitted steers in sendNow's settlement path, in native order.
    readSteers(step) { if (step.late) activeTurn.late = true; },
    end(step) {
      if (step.error) sendProviderError(step.error);
      else {
        sendTurnEnd();
        if (scenario.name === 'cezar-wait' || scenario.name === 'deferred-turn-start') sendBackendResume(command);
      }
    },
  };
}

async function handlePromptCommand(command) {
  const early = scenarioFor(command.message, scenarioContext);
  if (early?.early) {
    if (early.name === 'autonomous' && process.env.CEZ_MOCK_STDIN_FILE) appendFileSync(process.env.CEZ_MOCK_STDIN_FILE, `${JSON.stringify({ userText: rawMessage(command), imageCount: 0 })}\n`);
    if (await play(early, scenarioEncoder(command, early)) !== 'continue') return;
  }
  recordPrompt(command);
  command.message = answerNudge(command.message);
  const scenario = scenarioFor(command.message, { ...scenarioContext, unsupported: [...scenarioContext.unsupported, ...(early?.early ? [early.name] : [])] });
  if (scenario?.beforeFailure) return play(scenario, scenarioEncoder(command, scenario));
  if (failureControl && (await failureControl.failureFor(command.message)) === 'provider') return respondProviderError(command);
  if (scenario) return play(scenario, scenarioEncoder(command, scenario));
  return respondDefault(command);
}

async function handleCommand(command) {
  switch (command.type) {
    case 'prompt': return handlePromptCommand(command);
    case 'get_state': respondState(command); return;
    case 'set_steering_mode': respondSteeringMode(command); return;
    case 'abort': send({ type: 'response', command: 'abort', success: true });
  }
}
