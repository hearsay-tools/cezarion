#!/usr/bin/env node
import { CURSOR_FAILURES } from './mock-provider-failures.mjs';
import { loadControls } from './mock-controls.mjs';
import { scenarioFor, play, PROVIDER_HOLD_SCENARIOS } from './mock-scenario.mjs';
import { waitForRelease } from './mock-lifecycle.mjs';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
// Print acknowledges an input on its first model work and cannot refuse one, so a held
// acknowledgement and a held response both hold that first model work.
const { failureControl, delivery } = await loadControls({ delivery: ['hold-ack', 'hold-response'] });
const { answerNudge, NO_WAIT_NUDGE_PREFIX } = await import('./mock-nudge.mjs');

const args = process.argv.slice(2);
// No import or await on the ordinary mock path.
const wireRecorder = process.env.CEZ_MOCK_WIRE_FILE === undefined ? undefined
  : await import('./mock-wire-recorder.mjs');
wireRecorder?.installWireRecorder();
if (args.includes('--version')) { process.stdout.write('2026.10.01-e373342\n'); process.exit(0); }
if (args.includes('__cezar_probe_invalid__')) {
  process.stderr.write('Invalid --allowed-tools value(s): __cezar_probe_invalid__. Expected one of: '+
    'shell_tool_call, delete_tool_call, glob_tool_call, grep_tool_call, read_tool_call, update_todos_tool_call, read_todos_tool_call, edit_tool_call, ls_tool_call, read_lints_tool_call, mcp_tool_call, sem_search_tool_call, create_plan_tool_call, web_search_tool_call, list_mcp_resources_tool_call, read_mcp_resource_tool_call, apply_agent_diff_tool_call, ask_question_tool_call, fetch_tool_call, switch_mode_tool_call, generate_image_tool_call, record_screen_tool_call, computer_use_tool_call, write_shell_stdin_tool_call, reflect_tool_call, setup_vm_environment_tool_call, truncated_tool_call, web_fetch_tool_call, report_bugfix_results_tool_call, ai_attribution_tool_call, pr_management_tool_call, mcp_auth_tool_call, await_tool_call, blame_by_file_path_tool_call, get_mcp_tools_tool_call, report_bug_tool_call, set_active_branch_tool_call, communicate_update_tool_call, send_final_summary_tool_call, update_pr_code_tour_tool_call, replace_env_tool_call, edit_pr_labels_tool_call, record_ci_investigation_findings_tool_call, fetch_cloud_agent_data_tool_call, send_to_user_tool_call, pi_read_tool_call, pi_bash_tool_call, pi_edit_tool_call, pi_write_tool_call, pi_grep_tool_call, pi_find_tool_call, pi_ls_tool_call, connect_scm_tool_call, search_conversations_tool_call, create_goal_tool_call, update_goal_tool_call, get_pr_code_tour_tool_call, write_canvas_tool_call, read_canvas_tool_call, task_tool_call, create_agent_tool_call, adopt_tool_call, send_to_agent_tool_call, send_message_tool_call, get_agent_status_tool_call, stop_agent_tool_call, read_agent_transcript_tool_call, start_grind_execution_tool_call, start_grind_planning_tool_call\n');
  process.exit(1);
}
const flag = name => { const at = args.indexOf(name); return at < 0 ? undefined : args[at + 1]; };
const resumeId = flag('--resume');
const mode = process.env.CEZ_MOCK_CURSOR_PRINT_MODE ?? 'normal';
const turn = resumeId ? 2 : 1;
// Cursor accepts a print prompt on stdin. Preserve the positional form so a
// regression back to argv delivery is visible to the runner tests.
const valueFlags = new Set(['--output-format', '--model', '--resume', '--allowed-tools',
  '--add-dir', '--plugin-dir', '--image']);
let positionalPrompt = '';
for (let i = 0; i < args.length; i++) {
  if (valueFlags.has(args[i])) { i++; continue; }
  if (!args[i].startsWith('-')) positionalPrompt = args[i];
}
const stdinChunks = [];
if (!positionalPrompt) for await (const chunk of process.stdin) stdinChunks.push(chunk);
const stdinPrompt = Buffer.concat(stdinChunks).toString('utf8');
const promptArg = stdinPrompt || positionalPrompt;
const promptBoundary = promptArg.lastIndexOf('\n\n---\n\n');
const rawPrompt = promptBoundary < 0 ? promptArg : promptArg.slice(promptBoundary + '\n\n---\n\n'.length);
const taggedScenarios = [
  ['resume-cezar-done', 'a0000001'], ['autonomous-cezar-ask-cap', 'a0000002'],
  ['autonomous-cap', 'a0000003'], ['silent-tail-late-turn-start', 'a0000004'],
  ['silent-tail-no-reply', 'a0000005'], ['silent-tail-late-reply', 'a0000006'],
  ['silent-tail-slow-done', 'a0000007'], ['silent-tail', 'a0000009'],
];
const freshTag = taggedScenarios.find(([name]) => rawPrompt.includes(`mock:${name}`))?.[1];
const id = resumeId && mode !== 'mismatch-on-resume' ? resumeId
  : (freshTag ? freshTag + randomUUID().slice(8) : randomUUID());
const stateFile = join(process.cwd(), '.ai', 'cezar', 'mock-cursor-print', `${id}.json`);
let origin = taggedScenarios.find(([, tag]) => resumeId?.startsWith(tag))?.[0];
if (resumeId && existsSync(stateFile)) {
  try { origin = JSON.parse(readFileSync(stateFile, 'utf8')).origin ?? origin; } catch { /* isolated mock state */ }
}
if (freshTag) {
  origin = taggedScenarios.find(([, tag]) => tag === freshTag)?.[0];
  mkdirSync(join(process.cwd(), '.ai', 'cezar', 'mock-cursor-print'), { recursive: true });
  writeFileSync(stateFile, JSON.stringify({ origin }));
}
// One process per turn: the session's opening scenario comes from its tag, not a latch.
const silentOrigin = (origin ?? '').startsWith('silent-tail');
const prompt = silentOrigin ? rawPrompt : answerNudge(rawPrompt);
const frame = value => process.stdout.write(`${JSON.stringify(value)}\n`);
const assistant = text => frame({ type: 'assistant', session_id: id,
  message: { role: 'assistant', content: [{ type: 'text', text }] } });
const result = (text, error = false) => frame({ type: 'result', subtype: error ? 'error_during_execution' : 'success',
  session_id: id, is_error: error, result: text });
const readTool = (content = 'A project') => {
  const call = { readToolCall: { args: { path: 'README.md' } } };
  frame({ type: 'tool_call', subtype: 'started', call_id: 'read-1', session_id: id, tool_call: call });
  frame({ type: 'tool_call', subtype: 'completed', call_id: 'read-1', session_id: id,
    tool_call: { readToolCall: { ...call.readToolCall, result: { success: { content } } } } });
};

const finish = (text) => { assistant(text); result(text); };
// hearsay-tools/cezarion#2397: a reply that finishes, asks or waits calls that Squawk tool over
// the --plugin-dir MCP config before its turn ends. Returns '' or a note for the text.
const tools = () => import('./mock-ci-tool.mjs');
const lifecycle = async (call) => (await tools()).lifecycleCall('cursor', args, ...call);
const done = async (text) => text + await lifecycle((await tools()).DONE);
const log = process.env.CEZ_MOCK_CURSOR_PRINT_LOG;
if (log) appendFileSync(log, `${JSON.stringify({ pid: process.pid, resumeId, id, args,
  promptSource: stdinPrompt ? 'stdin' : 'argv', prompt: promptArg })}\n`);
if (process.env.CEZ_MOCK_ARGS_FILE) {
  appendFileSync(process.env.CEZ_MOCK_ARGS_FILE, `${JSON.stringify(args)}\n`);
  const pluginDir = flag('--plugin-dir');
  if (pluginDir) appendFileSync(process.env.CEZ_MOCK_ARGS_FILE,
    `${JSON.stringify({ type: 'cursor-print-plugin', ...JSON.parse(readFileSync(`${pluginDir}/mcp.json`, 'utf8')) })}\n`);
}
if (process.env.CEZ_MOCK_STDIN_FILE && stdinPrompt) {
  appendFileSync(process.env.CEZ_MOCK_STDIN_FILE,
    `${JSON.stringify({ method: 'cursor-print/stdin', prompt: stdinPrompt })}\n`);
}
if (mode === 'delay-init') await new Promise(resolve => setTimeout(resolve, 10_000));
// Reproduce a loaded host's per-process startup cost on every turn: Cursor print
// spawns one process per turn, so a cap row pays it MAX_AUTO_CONTINUES + 1 times
// (hearsay-tools/cezarion#1125).
const spawnDelayMs = Number.parseInt(process.env.CEZ_MOCK_CURSOR_SPAWN_DELAY_MS ?? '0', 10) || 0;
if (spawnDelayMs > 0) await new Promise(resolve => setTimeout(resolve, spawnDelayMs));
const attempt = log ? readFileSync(log, 'utf8').trim().split('\n').length : 1;
const rejectModel = () => process.stderr.write(`Cannot use this model: ${flag('--model')}. Available models: ${'other-model, '.repeat(1000)}\n`);
if (mode === 'model-rejection-always' || (mode === 'model-rejection-once' && attempt === 1) ||
  (mode === 'model-rejection-on-resume' && resumeId && attempt === 2)) {
  rejectModel(); process.exit(1);
}
if (mode === 'model-rejection-held') {
  rejectModel(); await waitForRelease(10_000); process.exit(1);
}
if (mode === 'unrelated-startup-error') { process.stderr.write('Account unavailable\n'); process.exit(1); }
const sharedNames = ['autonomous', 'silent-tail', 'crash-stderr', 'cezar-tool', 'ci-wait',
  'multi-pr-refs', 'turn-messages', 'agent-echo', 'provider-error', ...PROVIDER_HOLD_SCENARIOS.map(([name]) => name), 'hold-cezar-done', 'hold-cezar-ask',
  'cezar-done', 'cezar-ask', 'busy-progress', 'no-progress', 'hold-gated', 'hold', 'deferred-turn-start'];
// Print has no persistent input, steering, child transcript or cezar-wait reply.
const unsupported = ['ack-only', 'steer-tool', 'steer-late', 'subagent-after-park', 'cezar-wait'];
let crashContinues = false;
const session = {
  get resumeAfterAsk() { return origin === 'resume-cezar-done'; },
  set resumeAfterAsk(value) {
    if (!value) return;
    mkdirSync(join(process.cwd(), '.ai', 'cezar', 'mock-cursor-print'), { recursive: true });
    writeFileSync(stateFile, JSON.stringify({ origin: 'resume-cezar-done' }));
  },
};
function selectScenario(name, text = prompt) {
  return scenarioFor(text, {
    runner: 'cursor', lifecycle, session, nativeFailureControl: Boolean(failureControl),
    unsupported: [...unsupported, ...sharedNames.filter(candidate => candidate !== name)],
    toolPrompt: text => tools().then(module => module.toolPrompt('cursor', args, text)),
    ciPrompt: text => tools().then(module => module.ciPrompt('cursor', args, text)),
    async crash(text) { crashContinues = (await import('./mock-runner-crash.mjs')).crashWithStderr(text, '{"type":"assistant",') === true; },
  });
}
// A missing scenario is synchronous. The player alone awaits asynchronous steps.
function dispatch(replies, index = 0) {
  for (; index < replies.length; index++) {
    const route = replies[index];
    if (route.when && !route.when()) continue;
    if (route.reply) return route.reply();
    const selected = selectScenario(route.name, route.prompt?.() ?? prompt);
    if (!selected) continue;
    const next = index + 1;
    const finish = outcome => {
      if (selected.name === 'no-progress' || selected.name === 'silent-tail' && origin === 'silent-tail-no-reply' && prompt.includes(NO_WAIT_NUDGE_PREFIX)) {
        setInterval(() => {}, 1000); return new Promise(() => {});
      }
      return outcome === 'continue' || selected.name === 'crash-stderr' && crashContinues ? dispatch(replies, next) : undefined;
    };
    const outcome = play(selected, encoder(selected));
    return outcome instanceof Promise ? outcome.then(finish) : finish(outcome);
  }
}
function encoder(selected) {
  let text = '';
  return {
    open() {},
    text(step) { const block = step.parts.join(''); text = block; assistant(block); },
    reasoning(step) { frame({ type: 'assistant', session_id: id, message: { role: 'assistant', content: [{ type: 'thinking', thinking: step.text }] } }); },
    toolStart: ({ call }) => scenarioTool(call, false),
    toolEnd: ({ call }) => scenarioTool(call, true),
    child() { throw new Error('Cursor print has no child wire'); },
    readSteers() {},
    progress: () => assistant('working\n'),
    reply: () => prompt === 'inspect the working tree' || prompt.includes('mock:baseline') ? baselineReply() : defaultReply(),
    end(step) {
      const empty = selected.name === 'turn-messages' || selected.name === 'silent-tail' && !prompt.includes(NO_WAIT_NUDGE_PREFIX);
      result(step.error ? CURSOR_FAILURES[step.error] : empty ? '' : text, Boolean(step.error));
    },
  };
}
function scenarioTool(call, completed) {
  const key = call.name === 'read' ? 'readToolCall' : 'shellToolCall';
  const args = call.input;
  const success = call.name === 'read' ? { content: call.output } : { exitCode: call.isError ? 1 : 0, stdout: call.output, stderr: '' };
  frame({ type: 'tool_call', subtype: completed ? 'completed' : 'started', call_id: call.id, session_id: id,
    tool_call: { [key]: { args, ...(completed ? { result: { success } } : {}) } } });
}
// Delay admission through the shared script, but keep native init and modes in their slots.
const deferred = selectScenario('deferred-turn-start');
if (deferred) await play({ steps: [...deferred.steps].filter(step => step.kind === 'effect') }, encoder(deferred));
frame({ type: 'system', subtype: 'init', session_id: id, model: flag('--model') ?? 'auto', cwd: process.cwd() });
if (delivery) {
  await new Promise(resolve => delivery.ack(prompt, resolve));
  await delivery.holdResponse(prompt);
}
if (mode === 'model-rejection-after-init' || mode === 'model-rejection-after-work') {
  if (mode === 'model-rejection-after-work') assistant('Work already began');
  rejectModel(); process.exit(1);
}
if (mode === 'no-result') process.exit(0);
if (mode === 'native-question') {
  const args = { title: 'Choice', questions: [{ prompt: 'Choose', options: [{ label: 'Alpha' }, { label: 'Beta' }], allowMultiple: false }], runAsync: false };
  const call = { askQuestionToolCall: { args } };
  frame({ type: 'tool_call', subtype: 'started', call_id: 'question-1', session_id: id, tool_call: call });
  frame({ type: 'tool_call', subtype: 'completed', call_id: 'question-1', session_id: id,
    tool_call: { askQuestionToolCall: { args, result: { rejected: { reason: 'Questions skipped by the user, continue with the information you already have' } } } } });
  finish('I could not ask the question.'); process.exit(0);
}
const selectedFailure = failureControl?.failureFor(prompt);
const nativeFailure = selectedFailure instanceof Promise ? await selectedFailure : selectedFailure;
if (failureControl ? nativeFailure === 'provider' : mode === 'provider-error') {
  result(CURSOR_FAILURES.provider, true);
  process.exit(0);
}
if (silentOrigin) (await import('./mock-silent-tail.mjs')).noteSilentTailPrompt(`mock:${origin}`);
await dispatch([
  { name: 'crash-stderr' },
  { when: () => origin === 'autonomous-cezar-ask-cap' && resumeId && prompt.startsWith('Continue working autonomously until the task is fully complete.'), reply: () => finish('Still working.') },
  { name: 'autonomous', prompt: () => origin?.startsWith('autonomous') && selectScenario('autonomous') ? `${prompt} mock:${origin}` : prompt },
  { name: 'silent-tail' },
  { when: () => origin === 'resume-cezar-done' && resumeId, reply: async () => finish(await done('Resumed work finished.')) },
  { name: 'cezar-tool' }, { name: 'ci-wait' },
  { when: () => process.env.CEZ_MOCK_CI_PR, reply: async () => finish(JSON.stringify((await (await tools()).probeCiTool('cursor', args)).response)) },
  ...['no-progress', 'busy-progress', 'hold-cezar-done', 'hold-cezar-ask', 'hold-gated', 'multi-pr-refs', 'turn-messages'].map(name => ({ name })),
  { when: () => prompt.includes('mock:ask-bad'), reply: () => finish('Malformed question skipped.') },
  { name: 'provider-error' }, ...PROVIDER_HOLD_SCENARIOS.map(([name]) => ({ name })),
  { when: () => resumeId && /Library:|Tests:|Plan:/.test(prompt), reply: async () => finish(await done('Done.')) },
  { name: 'cezar-done' },
  { name: 'cezar-ask', when: () => !resumeId || prompt.includes('mock:cezar-ask-reply-late') },
  { name: 'hold' },
  { when: () => prompt === 'inspect the working tree' || prompt.includes('mock:baseline'), reply: baselineReply },
  { name: 'agent-echo' },
  { reply: defaultReply },
]);
function baselineReply() { readTool(); finish('Cursor inspected the workspace.'); }
async function defaultReply() {
  const text = `turn ${turn}: ${prompt}`;
  if (mode === 'delay-work' && resumeId) await new Promise(resolve => setTimeout(resolve, 200));
  assistant(text);
  if (mode === 'crash-after-work') process.exit(1);
  result(text);
  if (mode === 'duplicate-result') result(text);
  if (mode === 'late-frame') assistant('LATE_FRAME');
  if (mode === 'result-before-exit') await new Promise(resolve => setTimeout(resolve, 250));
}
