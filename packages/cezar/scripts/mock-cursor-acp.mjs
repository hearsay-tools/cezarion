#!/usr/bin/env node
// Offline Cursor ACP wire. Shapes: cursor.com/docs/cli/acp; ACP v1 schema.
import { createInterface } from 'node:readline';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import * as parityGateFs from 'node:fs';

// #401: let the test observe the actual monitoring park before releasing late wire frames.
async function afterParityPark(prompt) {
  const gate = /parity-release=([^\s"\\]+)/.exec(prompt)?.[1];
  if (!gate) throw new Error('post-park scenario requires a release path');
  while (!parityGateFs.existsSync(gate)) await new Promise(resolve => setTimeout(resolve, 10));
}

const record = (file, value) => { if (file) appendFileSync(file, `${JSON.stringify(value, (key, value) => key === 'env' && Array.isArray(value) ? value.map(item => item.name?.startsWith('CEZ_TOOL_') ? { ...item, value: '[redacted]' } : item) : value)}\n`); };
record(process.env.CEZ_MOCK_ARGS_FILE, process.argv.slice(2));
/** #529: remaining-count file. Each session/new or session/load decrements; at >0 the process writes stderr and exits 1 before the reply. */
function consumeBootstrapCrash() {
  const file = process.env.CEZ_MOCK_CURSOR_CRASH_ON_LOAD;
  if (!file) return;
  let remaining = 0;
  try { remaining = Number(readFileSync(file, 'utf8')); } catch { return; }
  if (!Number.isFinite(remaining) || remaining <= 0) return;
  writeFileSync(file, String(remaining - 1));
  process.stderr.write(`${process.env.CEZ_MOCK_CURSOR_CRASH_STDERR ?? 'Cursor ACP mock bootstrap crash'}\n`);
  process.exit(1);
}
const emit = value => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...value })}\n`);
const reply = (id, result) => emit({ id, result });
let sessionId = 'cursor-offline-session';
let model = process.argv[process.argv.indexOf('--model') + 1];
if (!process.argv.includes('--model')) model = 'gpt-test';
const requestedModel = model;
if (process.env.CEZ_MOCK_CURSOR_INITIAL_MODEL) model = process.env.CEZ_MOCK_CURSOR_INITIAL_MODEL;
let effort = 'medium';
const configOptions = () => [
  { id: 'model', name: 'Model', type: 'select', currentValue: model, options: [...new Set([model, requestedModel])].map(value => ({ value, name: value })) },
  { id: model.startsWith('sonnet') ? 'effort' : 'reasoning', name: 'Reasoning', type: 'select', currentValue: effort, options: ['low', 'medium', 'high', 'xhigh', 'max'].map(value => ({ value, name: value })) },
];
const configuration = () => process.env.CEZ_MOCK_CURSOR_LEGACY === '1' ? {} : { configOptions: configOptions() };
let pendingAsk;
let ciWire;
let resumeDone = false;
let prompts = 0;
const update = (value, id = sessionId) => emit({ method: 'session/update', params: { sessionId: id, update: value } });
const text = value => update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: value } });
const complete = id => reply(id, { stopReason: 'end_turn' });
const question = { id: 'tests', prompt: 'Which test runner?', options: [{ id: 'vitest', label: 'Vitest' }, { id: 'jest', label: 'Jest' }], allowMultiple: false };
async function prompt(id, content) {
  const input = content.filter(b => b.type === 'text').map(b => b.text).join('\n');
  prompts += 1;
  if (input.includes('mock:ci-wait')) { const { ciPrompt } = await import('./mock-ci-tool.mjs'); text(await ciPrompt('cursor', ciWire, input)); complete(id); return; }
  if (resumeDone) { resumeDone = false; text('Resumed work finished.\nCEZ:DONE'); complete(id); return; }
  if (input.includes('mock:hold')) await new Promise(r => setTimeout(r, 500));
  if (input.includes('mock:rpc-error')) { emit({ id, error: { code: -32603, message: 'Provider rejected request' } }); return; }
  // #443 provider-error envelopes: the specific scenarios must be matched BEFORE the
  // bare 'mock:provider-error' prefix, which every one of them contains.
  // #508: observed Cursor 2026.09.18-9a7762b error envelope, followed by end_turn.
  if (input.includes('mock:provider-error-protocol') && (input.includes('-exhaust') || prompts === 1)) { text('\n\nError: RetriableError: [invalid_argument] protocol error: missing EndStreamResponse'); complete(id); return; }
  // #528: observed Cursor SSL record-layer envelope (run 4bcd5420 seq 2667). Matched
  // before the bare mock:provider-error prefix, same pattern as protocol.
  if (input.includes('mock:provider-error-ssl') && (input.includes('-exhaust') || prompts === 1)) { text('\n\nError: RetriableError: [internal] C0AC9346CC7B0000:error:0A000119:SSL routines:tls_get_more_records:decryption failed or bad record mac:../deps/openssl/openssl/ssl/record/methods/tls_common.c:869:'); complete(id); return; }
  // #531: observed run 2f891027 seq 2005 capacity envelope. Match before the bare prefix.
  // Do not reuse the protocol mock's `includes('-exhaust')` check: that token is a
  // substring of `resource-exhausted` and would never recover.
  if (input.includes('mock:provider-error-resource-exhausted-exhaust')) { text('\n\nError: RetriableError: [resource_exhausted] Error'); complete(id); return; }
  if (input.includes('mock:provider-error-resource-exhausted') && prompts === 1) { text('\n\nError: RetriableError: [resource_exhausted] Error'); complete(id); return; }
  if (input.includes('mock:provider-error-unknown-protocol')) { text('\n\nError: [invalid_argument] protocol error: unknown frame'); complete(id); return; }
  if (input.includes('mock:provider-error-transient') && prompts === 1) { text('\n\nError: 502 bad gateway.'); complete(id); return; }
  if (input.includes('mock:provider-error-bare')) { text('\n\nError: 502 bad gateway.'); complete(id); return; }
  if (input.includes('mock:provider-error-instant-near') && prompts === 1) { text(`\n\nError: 429 rate limited, try again at ${new Date(Date.now() + 300).toISOString()}.`); complete(id); return; }
  if (input.includes('mock:provider-error-instant-far')) { text(`\n\nError: usage limit reached, try again at ${new Date(Date.now() + 6 * 3600000).toISOString()}.`); complete(id); return; }
  if (input.includes('mock:provider-error-verbose')) { text(`\n\nError: usage limit reached. The request ${'x'.repeat(600)} could not be completed, try again at ${new Date(Date.now() + 6 * 3600000).toISOString()}.`); complete(id); return; }
  if (input.includes('mock:provider-error') && !input.includes('mock:provider-error-')) { text('\n\nError: [unauthenticated] Backend rejected authentication.'); complete(id); return; }
  // #401: ACP has chunks only, so completion must flush the same text to v1/v2.
  if (input.includes('mock:ask-snapshot')) {
    text('Choose a test library.\nCEZ:ASK {"questions":[{"header":"Library","question":"Which test library?","options":[{"label":"Vitest"},{"label":"Node test"}]}]}'); complete(id); return;
  }
  if (input.includes('mock:ask-bad')) { pendingAsk = { id }; emit({ id: 'bad-question', method: 'cursor/ask_question', params: { questions: [] } }); return; }
  if (input.includes('mock:plan')) { pendingAsk = { id, input }; emit({ id: 'plan-1', method: 'cursor/create_plan', params: { name: 'Test plan', overview: 'Approve the changes?', plan: 'Implement the change and run tests.' } }); return; }
  if (input.includes('mock:multi-ask')) { pendingAsk = { id }; emit({ id: 'multi-question', method: 'cursor/ask_question', params: { title: 'Choices', questions: [question, { ...question, id: 'build', prompt: 'Which build tool?', options: [{ id: 'vite', label: 'Vite' }, { id: 'webpack', label: 'Webpack' }] }] } }); return; }
  if (input.includes('mock:ask')) { pendingAsk = { id, input }; emit({ id: 'question-1', method: 'cursor/ask_question', params: { toolCallId: 'ask-tool', title: 'Tests', questions: [question] } }); return; }
  if (input.includes('mock:permission')) { pendingAsk = { id }; emit({ id: 'permission-1', method: 'session/request_permission', params: { sessionId, toolCall: { toolCallId: 'shell-1', title: 'echo hello', kind: 'execute' }, options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }, { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' }] } }); return; }
  // ACP subagent attribution from __fixtures__/cursor/acp-subagents.ndjson.
  if (input.includes('mock:subagent-after-park')) {
    update({ sessionUpdate: 'subagent_spawned', subagentSessionId: 'park-child', name: 'Reviewer', task: 'Review', capabilities: {}, _meta: { cursor: { toolCallId: 'park-task', agentId: 'park-agent' } } });
    update({ sessionUpdate: 'tool_call', toolCallId: 'late-read', kind: 'other', title: 'Inspect README', status: 'in_progress' }, 'park-child');
    update({ sessionUpdate: 'tool_call_update', toolCallId: 'late-read', status: 'completed' }, 'park-child');
    text('Watching the child.\nCEZ:MONITORING');
    complete(id);
    await afterParityPark(input);
    update({ sessionUpdate: 'tool_call_update', toolCallId: 'late-read', status: 'completed', rawOutput: 'Read the file.' }, 'park-child');
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Late child text.' } }, 'park-child');
    // Cursor task metadata can follow the regular completion (acp-subagents.ndjson).
    // Sessionless extensions are attributed by their known child toolCallId even
    // after prompt completion; this is the ordered barrier and a nested item update.
    emit({ method: 'cursor/task', params: { toolCallId: 'late-read', description: 'Post-park child update processed.' } });
    return;
  }
  if (input.includes('mock:subagent')) {
    update({ sessionUpdate: 'tool_call', toolCallId: 'task-1', title: 'Review', kind: 'other', rawInput: { description: 'Review' }, status: 'in_progress' });
    update({ sessionUpdate: 'subagent_spawned', subagentSessionId: 'child', name: 'Reviewer', task: 'Review', capabilities: {}, _meta: { cursor: { toolCallId: 'task-1', agentId: 'child-agent' } } });
    text('Parent monitoring.\nCEZ:MONITORING');
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Child review finished.' } }, 'child');
    update({ sessionUpdate: 'subagent_state_update', subagentSessionId: 'child', state: 'completed', _meta: { cursor: { toolCallId: 'task-1', agentId: 'child-agent' } } });
    complete(id); return;
  }
  if (input.includes('mock:split-text')) { text('parity split text\nCEZ:'); text('MONITORING'); complete(id); return; }
  if (input.includes('mock:done')) { text('Done.\nCEZ:DONE'); complete(id); return; }
  if (input.includes('mock:agent-echo')) { text(input); complete(id); return; }
  update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Inspecting the workspace.' } });
  update({ sessionUpdate: 'tool_call', toolCallId: 'read-1', title: 'Read README', kind: 'read', status: 'in_progress', rawInput: { path: 'README.md' } });
  update({ sessionUpdate: 'tool_call_update', toolCallId: 'read-1', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'A project' } }] });
  text('Cursor inspected the workspace.');
  complete(id);
}
createInterface({ input: process.stdin }).on('line', async line => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  record(process.env.CEZ_MOCK_ARGS_FILE, msg);
  record(process.env.CEZ_MOCK_STDIN_FILE, msg);
  if (!msg.method) {
    if (pendingAsk) {
      const pending = pendingAsk; pendingAsk = undefined;
      // #383 run f192490f seq188–194: native reply, tool closes, end_turn.
      // Variants exercise documented ACP terminal/ask frames at that boundary.
      setTimeout(() => {
        if ((pending.input ?? '').includes('mock:ask-error')) { text('\n\nError: 502 bad gateway.'); reply(pending.id, { stopReason: 'end_turn' }); return; }
        text(msg.id === 'bad-question' ? 'Malformed question skipped.' : `Answer accepted: ${JSON.stringify(msg.result)}`);
        const input = pending.input ?? '';
        resumeDone = input.includes('mock:resume-done');
        if (input.includes('mock:answer-done')) text('\nCEZ:DONE');
        if (input.includes('mock:answer-monitoring')) text('\nCEZ:MONITORING');
        if (input.includes('mock:answer-ask')) emit({ id: 'question-2', method: 'cursor/ask_question', params: { title: 'Tests', questions: [question] } });
        reply(pending.id, { stopReason: input.includes('mock:answer-cancelled') ? 'cancelled' : 'end_turn' });
      }, 40);
    }
    return;
  }
  if (process.env.CEZ_MOCK_CI_PR && ['session/new', 'session/load'].includes(msg.method)) { const { probeCiTool } = await import('./mock-ci-tool.mjs'); await probeCiTool('cursor', msg.params); }
  if (['session/new', 'session/load'].includes(msg.method)) ciWire = msg.params;
  switch (msg.method) {
    case 'initialize': reply(msg.id, { protocolVersion: 1, agentCapabilities: { loadSession: true, promptCapabilities: { image: true } } }); break;
    case 'cursor/list_available_models': reply(msg.id, { models: [{ value: model, name: model, configOptions: configOptions().filter(option => option.id !== 'model') }] }); break;
    case 'session/new': consumeBootstrapCrash(); reply(msg.id, { sessionId, ...configuration() }); break;
    case 'session/load': consumeBootstrapCrash(); sessionId = msg.params.sessionId; reply(msg.id, configuration()); break;
    case 'session/set_model': model = msg.params.modelId; reply(msg.id, {}); break;
    case 'session/set_config_option':
      if (msg.params.configId === 'model') model = msg.params.value;
      else if (process.env.CEZ_MOCK_CURSOR_STALE_CONFIG !== '1') effort = msg.params.value;
      reply(msg.id, { configOptions: configOptions() }); break;
    case 'session/prompt': void prompt(msg.id, msg.params.prompt); break;
    case 'session/cancel': break;
    default: emit({ id: msg.id, error: { code: -32601, message: 'Method not found' } });
  }
}).on('close', () => process.exit(0));
