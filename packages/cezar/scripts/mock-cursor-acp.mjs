#!/usr/bin/env node
// Offline Cursor ACP wire. Shapes: cursor.com/docs/cli/acp; ACP v1 schema.
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
const record = (file, value) => { if (file) appendFileSync(file, `${JSON.stringify(value)}\n`); };
record(process.env.CEZ_MOCK_ARGS_FILE, process.argv.slice(2));
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
const update = (value, id = sessionId) => emit({ method: 'session/update', params: { sessionId: id, update: value } });
const text = value => update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: value } });
const complete = id => reply(id, { stopReason: 'end_turn' });
const question = { id: 'tests', prompt: 'Which test runner?', options: [{ id: 'vitest', label: 'Vitest' }, { id: 'jest', label: 'Jest' }], allowMultiple: false };
async function prompt(id, content) {
  const input = content.filter(b => b.type === 'text').map(b => b.text).join('\n');
  if (input.includes('mock:hold')) await new Promise(r => setTimeout(r, 500));
  if (input.includes('mock:rpc-error')) { emit({ id, error: { code: -32603, message: 'Provider rejected request' } }); return; }
  if (input.includes('mock:provider-error')) { text('\n\nError: [unauthenticated] Backend rejected authentication.'); complete(id); return; }
  if (input.includes('mock:ask-bad')) { pendingAsk = { id }; emit({ id: 'bad-question', method: 'cursor/ask_question', params: { questions: [] } }); return; }
  if (input.includes('mock:plan')) { pendingAsk = { id }; emit({ id: 'plan-1', method: 'cursor/create_plan', params: { name: 'Test plan', overview: 'Approve the changes?', plan: 'Implement the change and run tests.' } }); return; }
  if (input.includes('mock:multi-ask')) { pendingAsk = { id }; emit({ id: 'multi-question', method: 'cursor/ask_question', params: { title: 'Choices', questions: [question, { ...question, id: 'build', prompt: 'Which build tool?', options: [{ id: 'vite', label: 'Vite' }, { id: 'webpack', label: 'Webpack' }] }] } }); return; }
  if (input.includes('mock:ask')) { pendingAsk = { id }; emit({ id: 'question-1', method: 'cursor/ask_question', params: { toolCallId: 'ask-tool', title: 'Tests', questions: [question] } }); return; }
  if (input.includes('mock:permission')) { pendingAsk = { id }; emit({ id: 'permission-1', method: 'session/request_permission', params: { sessionId, toolCall: { toolCallId: 'shell-1', title: 'echo hello', kind: 'execute' }, options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }, { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' }] } }); return; }
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
createInterface({ input: process.stdin }).on('line', line => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  record(process.env.CEZ_MOCK_ARGS_FILE, msg);
  record(process.env.CEZ_MOCK_STDIN_FILE, msg);
  if (!msg.method) {
    if (pendingAsk) {
      const pending = pendingAsk; pendingAsk = undefined;
      setTimeout(() => { text(msg.id === 'bad-question' ? 'Malformed question skipped.' : `Answer accepted: ${JSON.stringify(msg.result)}`); complete(pending.id); }, 40);
    }
    return;
  }
  switch (msg.method) {
    case 'initialize': reply(msg.id, { protocolVersion: 1, agentCapabilities: { loadSession: true, promptCapabilities: { image: true } } }); break;
    case 'cursor/list_available_models': reply(msg.id, { models: [{ value: model, name: model, configOptions: configOptions().filter(option => option.id !== 'model') }] }); break;
    case 'session/new': reply(msg.id, { sessionId, ...configuration() }); break;
    case 'session/load': sessionId = msg.params.sessionId; reply(msg.id, configuration()); break;
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
