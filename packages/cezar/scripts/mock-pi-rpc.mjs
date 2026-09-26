#!/usr/bin/env node
import readline from 'node:readline';
import { appendFileSync } from 'node:fs';
if (process.env.CEZ_MOCK_ARGS_FILE) appendFileSync(process.env.CEZ_MOCK_ARGS_FILE, `${JSON.stringify(process.argv.slice(2))}\n`);

// Pi handles SIGTERM and reports 128 + signal, rather than a null exit code.
process.on('SIGTERM', () => process.exit(143));

if (process.env.CEZ_MOCK_CI_PR) { const { probeCiTool } = await import('./mock-ci-tool.mjs'); await probeCiTool('pi', process.argv.slice(2)); }
const sessionId = '00000000-0000-4000-8000-0000000000pi';
const write = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
// #505: like pi 0.87, a prompt with streamingBehavior 'steer' joins the running
// turn. Steers accepted by a scripted turn are read just before it settles: a user
// message_start/end, then an echo, unless the turn is `late` (never read).
let activeTurn = null;
// Pi 0.87 defaults steeringMode to one-at-a-time (#551). Cezar's runner must
// send set_steering_mode all for a burst to reach the same next step.
let steeringMode = 'one-at-a-time';
// The prompt a queued handler is running; pi records it as the turn's user message.
let currentPrompt;
const send = (value) => {
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
    for (const text of deliverNow) {
      write({ type: 'message_start', message: { role: 'user', content: [{ type: 'text', text }] } });
      write({ type: 'message_end', message: { role: 'user', content: [{ type: 'text', text }] } });
      sendText([text]);
      write({ type: 'message_end', message: { role: 'assistant', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } } });
    }
    write(value);
    // one-at-a-time leftover, or a late steer, runs as the next prompt.
    for (const text of defer) queue = queue.then(() => { currentPrompt = text; return handle({ type: 'prompt', message: text }); });
    return;
  }
  write(value);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** One valid CEZ:ASK payload (spec #473), used by the `mock:ask` scenario. */
const ASK_MARKER_BODY = "{\"questions\":[{\"header\":\"Library\",\"question\":\"Which test library?\",\"multiSelect\":false,\"options\":[{\"label\":\"Vitest\",\"description\":\"Use the existing test runner\"},{\"label\":\"Node test\",\"description\":\"Use node:test\"}]}]}";

/** The text_start / text_delta* / text_end trio pi streams for one assistant block. */
function sendText(deltas) {
  const content = deltas.join('');
  send({ type: 'message_update', message: {}, assistantMessageEvent: { type: 'text_start', contentIndex: 0, partial: {} } });
  for (const delta of deltas) {
    send({ type: 'message_update', message: {}, assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta, partial: {} } });
  }
  send({ type: 'message_update', message: {}, assistantMessageEvent: { type: 'text_end', contentIndex: 0, content, partial: {} } });
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
  const command = JSON.parse(line);
  if (command.type === 'prompt' && command.streamingBehavior === 'steer' && activeTurn) {
    if (process.env.CEZ_MOCK_STDIN_FILE) appendFileSync(process.env.CEZ_MOCK_STDIN_FILE, `${JSON.stringify({ userText: command.message, imageCount: 0, streamingBehavior: 'steer' })}\n`);
    activeTurn.steers.push(command.message);
    write({ id: command.id, type: 'response', command: 'prompt', success: true });
    return;
  }
  queue = queue.then(() => { currentPrompt = command.type === 'prompt' ? command.message : undefined; return handle(command); });
});
rl.on('close', () => { queue.then(() => process.exit(0)); });

async function handle(command) {
  // Testability hook, mirroring mock-claude: CEZ_MOCK_STDIN_FILE=<path> appends
  // each inbound prompt's text and image count, so tests can assert what the
  // runner actually wrote onto the RPC (harness parity's AgentRunSpec probes).
  if (command.type === 'prompt' && process.env.CEZ_MOCK_STDIN_FILE) {
    try {
      appendFileSync(process.env.CEZ_MOCK_STDIN_FILE, `${JSON.stringify({ userText: command.message, imageCount: (command.images ?? []).length })}\n`);
    } catch {
      // best effort — never break the mock over the hook
    }
  }
  if (command.type === 'get_state') {
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
  } else if (command.type === 'prompt' && command.message.includes('mock:ci-wait')) {
    send({ id: command.id, type: 'response', command: 'prompt', success: true });
    send({ type: 'agent_start' }); send({ type: 'turn_start' });
    const { ciPrompt } = await import('./mock-ci-tool.mjs');
    sendText([await ciPrompt('pi', process.argv.slice(2), command.message)]);
    sendTurnEnd();
  } else if (command.type === 'prompt' && command.message.includes('mock:steer-tool')) {
    send({ id: command.id, type: 'response', command: 'prompt', success: true });
    send({ type: 'agent_start' }); send({ type: 'turn_start' });
    send({ type: 'tool_execution_start', toolCallId: 'tool-steer', toolName: 'bash', args: { command: 'wait' } });
    await sleep(Number(process.env.CEZ_MOCK_STEER_MS ?? 600));
    send({ type: 'tool_execution_end', toolCallId: 'tool-steer', toolName: 'bash', result: { content: [{ type: 'text', text: 'waited' }] }, isError: false });
    sendText(['steer tool done']);
    sendTurnEnd();
  } else if (command.type === 'prompt' && command.message.includes('mock:steer-late')) {
    send({ id: command.id, type: 'response', command: 'prompt', success: true });
    send({ type: 'agent_start' }); send({ type: 'turn_start' });
    sendText(['late window: final message already sent']);
    activeTurn.late = true;
    await sleep(300);
    sendTurnEnd();
  } else if (command.type === 'prompt' && command.message.includes('mock:agent-echo')) {
    // rpc-lifecycle.ndjson's normal prompt/assistant/settled sequence.
    send({ id: command.id, type: 'response', command: 'prompt', success: true });
    send({ type: 'agent_start' });
    send({ type: 'turn_start' });
    sendText([command.message]);
    sendTurnEnd();
  } else if (command.type === 'prompt' && command.message.includes('mock:split-text')) {
    // Pi streams one text_delta per token (#2's root cause), so the marker is
    // split across deltas. Only a coalescer reassembles `CEZ:MONITORING`;
    // one v1 `text` per delta joins them with a newline and the park is lost
    // (harness parity S8).
    send({ id: command.id, type: 'response', command: 'prompt', success: true });
    send({ type: 'agent_start' });
    send({ type: 'turn_start' });
    sendText(['parity split text', '\n\n', 'CEZ:', 'MONITORING']);
    sendTurnEnd();
  } else if (command.type === 'prompt' && command.message.includes('mock:provider-error')) {
    // An assistant `message_end` whose stopReason is `error`, carrying the
    // transport diagnostic — wire shape copied from
    // `src/core/__fixtures__/pi/provider-error.ndjson`. #54: this arrived
    // before `agent_settled` and the run parked as "Needs You" instead of
    // failing (harness parity S7).
    send({ id: command.id, type: 'response', command: 'prompt', success: true });
    send({ type: 'agent_start' });
    send({ type: 'turn_start' });
    send({ type: 'message_end', message: {
      role: 'assistant',
      content: [],
      api: 'openai-codex-responses',
      provider: 'openai-codex',
      model: 'gpt-5.6-sol',
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } },
      stopReason: 'error',
      diagnostics: [{ type: 'provider_transport_failure', error: { name: 'Error', message: 'WebSocket error' } }],
      errorMessage: 'Not Found',
    } });
    send({ type: 'agent_settled' });
  } else if (command.type === 'prompt' && command.message.includes('mock:done')) {
    // Declares the task complete so the run reaches cezar's review gate; a
    // markerless turn-end correctly parks as `waiting` instead (harness
    // parity R1).
    send({ id: command.id, type: 'response', command: 'prompt', success: true });
    send({ type: 'agent_start' });
    send({ type: 'turn_start' });
    sendText(['parity done: the task is complete\n\nCEZ:DONE']);
    sendTurnEnd();
  } else if (command.type === 'prompt' && command.message.includes('mock:ask-snapshot')) {
    // #401: authoritative text_end without deltas, using rpc-lifecycle frames.
    send({ id: command.id, type: 'response', command: 'prompt', success: true });
    send({ type: 'agent_start' });
    send({ type: 'turn_start' });
    send({ type: 'message_update', message: {}, assistantMessageEvent: { type: 'text_end', contentIndex: 0, content: 'Choose a test library.\nCEZ:ASK {"questions":[{"header":"Library","question":"Which test library?","options":[{"label":"Vitest"},{"label":"Node test"}]}]}', partial: {} } });
    sendTurnEnd();
  } else if (command.type === 'prompt' && command.message.includes('mock:ask-bad')) {
    // A marker whose JSON body is invalid. `parseAskMarker` must render no card
    // and the turn must still end (harness parity R4) — pi has no native ask
    // wire, so the `CEZ:ASK` marker is its only ask path, same as claude's.
    send({ id: command.id, type: 'response', command: 'prompt', success: true });
    send({ type: 'agent_start' });
    send({ type: 'turn_start' });
    sendText(['Pick one.\n\nCEZ:ASK {not valid json']);
    sendTurnEnd();
  } else if (command.type === 'prompt' && command.message.includes('mock:ask')) {
    // A well-formed `CEZ:ASK` marker, split so the marker and its JSON body land
    // in separate deltas — the #2 boundary that used to break assembly, and the
    // reason an ask row is worth driving through the real coalescer.
    send({ id: command.id, type: 'response', command: 'prompt', success: true });
    send({ type: 'agent_start' });
    send({ type: 'turn_start' });
    sendText(['Pick one.\n\n', 'CEZ:ASK', ' ', ASK_MARKER_BODY]);
    sendTurnEnd();
  } else if (command.type === 'prompt' && command.message.includes('mock:hold')) {
    // The `response` below is the ack. Holding the content AND the terminal
    // quartet behind it is what makes harness parity S2 meaningful: a runner
    // deriving turn-end from the ack reports it before this content arrives
    // (the #4 failure mode on pi's wire).
    send({ id: command.id, type: 'response', command: 'prompt', success: true });
    send({ type: 'agent_start' });
    send({ type: 'turn_start' });
    await sleep(250);
    sendText(['parity hold: content after the pause']);
    await sleep(250);
    sendTurnEnd();
  } else if (command.type === 'prompt') {
    const monitoringMarker = command.message.includes('mock:monitoring') ? '\n\nCEZ:MONITORING' : '';
    const responseText = `Investigating: ${command.message}${monitoringMarker}`;
    send({ id: command.id, type: 'response', command: 'prompt', success: true });
    send({ type: 'agent_start' });
    send({ type: 'turn_start' });
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
  } else if (command.type === 'set_steering_mode') {
    if (command.mode === 'all' || command.mode === 'one-at-a-time') steeringMode = command.mode;
    if (process.env.CEZ_MOCK_STDIN_FILE) {
      try { appendFileSync(process.env.CEZ_MOCK_STDIN_FILE, `${JSON.stringify({ type: 'set_steering_mode', mode: command.mode })}\n`); } catch { /* best effort */ }
    }
    send({ ...(command.id ? { id: command.id } : {}), type: 'response', command: 'set_steering_mode', success: true });
  } else if (command.type === 'abort') {
    send({ type: 'response', command: 'abort', success: true });
  }
}
