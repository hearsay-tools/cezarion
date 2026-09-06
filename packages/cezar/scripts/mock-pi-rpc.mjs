#!/usr/bin/env node
import readline from 'node:readline';

// Pi handles SIGTERM and reports 128 + signal, rather than a null exit code.
process.on('SIGTERM', () => process.exit(143));

const sessionId = '00000000-0000-4000-8000-0000000000pi';
const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
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

for await (const line of readline.createInterface({ input: process.stdin })) {
  const command = JSON.parse(line);
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
        steeringMode: 'all',
        followUpMode: 'one-at-a-time',
        autoCompactionEnabled: true,
        messageCount: 0,
        pendingMessageCount: 0,
      },
    });
  } else if (command.type === 'prompt' && command.message.includes('mock:agent-echo')) {
    // rpc-lifecycle.ndjson's normal prompt/assistant/settled sequence.
    send({ type: 'response', command: 'prompt', success: true });
    send({ type: 'agent_start' });
    send({ type: 'turn_start' });
    sendText([command.message]);
    sendTurnEnd();
  } else if (command.type === 'prompt' && command.message.includes('mock:split-text')) {
    // Pi streams one text_delta per token (#2's root cause), so the marker is
    // split across deltas. Only a coalescer reassembles `CEZ:MONITORING`;
    // one v1 `text` per delta joins them with a newline and the park is lost
    // (harness parity S8).
    send({ type: 'response', command: 'prompt', success: true });
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
    send({ type: 'response', command: 'prompt', success: true });
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
    send({ type: 'response', command: 'prompt', success: true });
    send({ type: 'agent_start' });
    send({ type: 'turn_start' });
    sendText(['parity done: the task is complete\n\nCEZ:DONE']);
    sendTurnEnd();
  } else if (command.type === 'prompt' && command.message.includes('mock:ask-bad')) {
    // A marker whose JSON body is invalid. `parseAskMarker` must render no card
    // and the turn must still end (harness parity R4) — pi has no native ask
    // wire, so the `CEZ:ASK` marker is its only ask path, same as claude's.
    send({ type: 'response', command: 'prompt', success: true });
    send({ type: 'agent_start' });
    send({ type: 'turn_start' });
    sendText(['Pick one.\n\nCEZ:ASK {not valid json']);
    sendTurnEnd();
  } else if (command.type === 'prompt' && command.message.includes('mock:ask')) {
    // A well-formed `CEZ:ASK` marker, split so the marker and its JSON body land
    // in separate deltas — the #2 boundary that used to break assembly, and the
    // reason an ask row is worth driving through the real coalescer.
    send({ type: 'response', command: 'prompt', success: true });
    send({ type: 'agent_start' });
    send({ type: 'turn_start' });
    sendText(['Pick one.\n\n', 'CEZ:ASK', ' ', ASK_MARKER_BODY]);
    sendTurnEnd();
  } else if (command.type === 'prompt' && command.message.includes('mock:hold')) {
    // The `response` below is the ack. Holding the content AND the terminal
    // quartet behind it is what makes harness parity S2 meaningful: a runner
    // deriving turn-end from the ack reports it before this content arrives
    // (the #4 failure mode on pi's wire).
    send({ type: 'response', command: 'prompt', success: true });
    send({ type: 'agent_start' });
    send({ type: 'turn_start' });
    await sleep(250);
    sendText(['parity hold: content after the pause']);
    await sleep(250);
    sendTurnEnd();
  } else if (command.type === 'prompt') {
    const monitoringMarker = command.message.includes('mock:monitoring') ? '\n\nCEZ:MONITORING' : '';
    const responseText = `Investigating: ${command.message}${monitoringMarker}`;
    send({ type: 'response', command: 'prompt', success: true });
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
  } else if (command.type === 'abort') {
    send({ type: 'response', command: 'abort', success: true });
  }
}
