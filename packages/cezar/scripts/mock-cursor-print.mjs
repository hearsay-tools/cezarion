#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const args = process.argv.slice(2);
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
const promptArg = args.at(-1) ?? '';
const promptBoundary = promptArg.lastIndexOf('\n\n---\n\n');
const prompt = promptBoundary < 0 ? promptArg : promptArg.slice(promptBoundary + '\n\n---\n\n'.length);
const taggedScenarios = [
  ['resume-done', 'a0000001'], ['autonomous-ask-cap', 'a0000002'],
  ['autonomous-cap', 'a0000003'], ['silent-tail-late-turn-start', 'a0000004'],
  ['silent-tail-no-reply', 'a0000005'], ['silent-tail-late-reply', 'a0000006'],
  ['silent-tail-slow-done', 'a0000007'], ['silent-tail-again', 'a0000008'],
  ['silent-tail', 'a0000009'], ['tool-tail', 'a000000a'],
];
const freshTag = taggedScenarios.find(([name]) => prompt.includes(`mock:${name}`))?.[1];
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
const waitForRelease = async (fallbackMs) => {
  const file = process.env.CEZ_MOCK_RELEASE_FILE;
  if (!file) { await new Promise(resolve => setTimeout(resolve, fallbackMs)); return; }
  const deadline = Date.now() + 15_000;
  while (!existsSync(file)) {
    if (Date.now() > deadline) throw new Error('CEZ_MOCK_RELEASE_FILE was not created');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
};
const finish = (text) => { assistant(text); result(text); };
const log = process.env.CEZ_MOCK_CURSOR_PRINT_LOG;
if (log) appendFileSync(log, `${JSON.stringify({ pid: process.pid, resumeId, id, args })}\n`);
if (process.env.CEZ_MOCK_ARGS_FILE) {
  appendFileSync(process.env.CEZ_MOCK_ARGS_FILE, `${JSON.stringify(args)}\n`);
  const pluginDir = flag('--plugin-dir');
  if (pluginDir) appendFileSync(process.env.CEZ_MOCK_ARGS_FILE,
    `${JSON.stringify({ type: 'cursor-print-plugin', ...JSON.parse(readFileSync(`${pluginDir}/mcp.json`, 'utf8')) })}\n`);
}
if (mode === 'delay-init') await new Promise(resolve => setTimeout(resolve, 10_000));
frame({ type: 'system', subtype: 'init', session_id: id, model: flag('--model') ?? 'auto', cwd: process.cwd() });
if (mode === 'no-result') process.exit(0);
if (mode === 'portable-ask' && !resumeId) {
  const ask = 'CEZ:ASK {"questions":[{"header":"Library","question":"Which library?","multiSelect":false,"options":[{"label":"Vitest","description":"Use Vitest"},{"label":"Jest","description":"Use Jest"}]}]}';
  frame({ type: 'assistant', session_id: id, message: { role: 'assistant', content: [{ type: 'text', text: `Choose one.\n${ask}` }] } });
  frame({ type: 'result', subtype: 'success', session_id: id, is_error: false, result: `Choose one.\n${ask}` });
  process.exit(0);
}
if (mode === 'native-question') {
  const args = { title: 'Choice', questions: [{ prompt: 'Choose', options: [{ label: 'Alpha' }, { label: 'Beta' }], allowMultiple: false }], runAsync: false };
  const call = { askQuestionToolCall: { args } };
  frame({ type: 'tool_call', subtype: 'started', call_id: 'question-1', session_id: id, tool_call: call });
  frame({ type: 'tool_call', subtype: 'completed', call_id: 'question-1', session_id: id,
    tool_call: { askQuestionToolCall: { args, result: { rejected: { reason: 'Questions skipped by the user, continue with the information you already have' } } } } });
  finish('I could not ask the question.'); process.exit(0);
}
if (mode === 'provider-error') {
  result('RetriableError: provider unavailable', true);
  process.exit(0);
}
if (prompt.includes('mock:crash-stderr')) {
  const { crashWithStderr } = await import('./mock-runner-crash.mjs');
  crashWithStderr(prompt, '{"type":"assistant",');
}
if (prompt.includes('mock:autonomous') || prompt.startsWith('Continue working autonomously until the task is fully complete.')) {
  const { autonomousReply } = await import('./mock-autonomous.mjs');
  if (origin === 'autonomous-ask-cap' && resumeId && prompt.startsWith('Continue working autonomously until the task is fully complete.')) {
    finish('Still working.'); process.exit(0);
  }
  const tagged = origin?.startsWith('autonomous') ? `${prompt} mock:${origin}` : prompt;
  finish(autonomousReply(tagged)); process.exit(0);
}
if (prompt.includes('mock:silent-tail') || prompt.includes('mock:tool-tail') ||
    prompt.includes('Your last turn ended without a message to the user.')) {
  const silent = await import('./mock-silent-tail.mjs');
  if (prompt.includes('Your last turn ended without a message to the user.')) {
    if (origin === 'silent-tail-no-reply') { setInterval(() => {}, 1000); await new Promise(() => {}); }
    if (origin === 'silent-tail-late-reply') await new Promise(resolve => setTimeout(resolve, silent.LATE_REPLY_MS));
    if (origin === 'silent-tail-slow-done') {
      assistant(silent.SLOW_DONE_PREFIX);
      await new Promise(resolve => setTimeout(resolve, silent.SLOW_DONE_TAIL_MS));
    }
    if (origin === 'silent-tail-again') { result(''); process.exit(0); }
    finish(origin === 'tool-tail' ? silent.FINAL_MESSAGE_STANDING : silent.SILENT_TAIL_DONE);
    process.exit(0);
  }
  assistant(prompt.includes('mock:tool-tail') ? silent.TOOL_TAIL_OPENING : silent.SILENT_TAIL_OPENING);
  readTool(origin === 'silent-tail-again' ? silent.SILENT_TAIL_REASONING : 'A project'); result(''); process.exit(0);
}
if (origin === 'resume-done' && resumeId) { finish('Resumed work finished.\nCEZ:DONE'); process.exit(0); }
if (prompt.includes('mock:ci-wait') || process.env.CEZ_MOCK_CI_PR) {
  const { ciPrompt, probeCiTool } = await import('./mock-ci-tool.mjs');
  const response = prompt.includes('mock:ci-wait') ? await ciPrompt('cursor', args, prompt)
    : JSON.stringify((await probeCiTool('cursor', args)).response);
  finish(response); process.exit(0);
}
if (prompt.includes('mock:no-progress')) {
  writeFileSync('watchdog.pid', String(process.pid));
  if (prompt.includes('ignore-term')) process.on('SIGTERM', () => {});
  if (prompt.includes('held-pipe')) spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'],
    { stdio: ['ignore', process.stdout, process.stderr] });
  setInterval(() => {}, 1000);
  await new Promise(() => {});
}
if (prompt.includes('mock:hold-done')) { await waitForRelease(400); finish('parity hold-done: content after the pause\nCEZ:DONE'); process.exit(0); }
if (prompt.includes('mock:hold-ask')) { await waitForRelease(400); finish('Pick one.\n\nCEZ:ASK {"questions":[{"header":"Library","question":"Which test library?","options":[{"label":"Vitest"},{"label":"Node test"}]}]}'); process.exit(0); }
if (prompt.includes('mock:hold-gated')) { await waitForRelease(500); finish('parity hold-gated: content after the pause'); process.exit(0); }
if (prompt.includes('mock:turn-messages:')) {
  const { turnMessages } = await import('./mock-turn-messages.mjs');
  for (const message of turnMessages(prompt)) assistant(message + '\n');
  result(''); process.exit(0);
}
if (prompt.includes('mock:ask-snapshot')) {
  finish(prompt.includes('mock:ask-snapshot-bad') ? 'CEZ:ASK {not valid json'
    : 'Using the CEZ:ASK structured question format instead:\n\nCEZ:ASK {"questions":[{"header":"Library","question":"Which test library?","options":[{"label":"Vitest"},{"label":"Node test"}]}]}');
  process.exit(0);
}
if (prompt.includes('mock:ask-prose')) { finish('Use `CEZ:ASK {"questions":[]}` in your reply.\n> CEZ:ASK {not valid json'); process.exit(0); }
if (prompt.includes('mock:ask-bad')) { finish('Malformed question skipped.'); process.exit(0); }
if (prompt.includes('mock:provider-error')) { result('RetriableError: provider unavailable', true); process.exit(0); }
if (prompt.includes('mock:split-text')) {
  const text = 'parity split text\nCEZ:MONITORING'; assistant(text); result(text); process.exit(0);
}
if (prompt.includes('mock:done') || (resumeId && /Library:|Tests:|Plan:/.test(prompt))) {
  const text = 'Done.\nCEZ:DONE'; assistant(text); result(text); process.exit(0);
}
if (prompt.includes('mock:ask') && (!resumeId || prompt.includes('mock:ask-reply-late'))) {
  const text = 'Pick one.\n\nCEZ:ASK {"questions":[{"header":"Library","question":"Which test library?","options":[{"label":"Vitest"},{"label":"Node test"}]}]}';
  assistant(text); result(text); process.exit(0);
}
if (prompt.includes('mock:hold')) await new Promise(resolve => setTimeout(resolve, 500));
if (prompt === 'inspect the working tree' || prompt.includes('mock:baseline')) {
  readTool(); const text = 'Cursor inspected the workspace.'; assistant(text); result(text); process.exit(0);
}
if (prompt.includes('mock:agent-echo')) { finish(prompt); process.exit(0); }
const text = `turn ${turn}: ${prompt}`;
if (mode === 'delay-work' && resumeId) await new Promise(resolve => setTimeout(resolve, 200));
assistant(text);
if (mode === 'crash-after-work') process.exit(1);
result(text);
if (mode === 'duplicate-result') frame({ type: 'result', subtype: 'success', session_id: id, is_error: false, result: text });
if (mode === 'late-frame') frame({ type: 'assistant', session_id: id,
  message: { role: 'assistant', content: [{ type: 'text', text: 'LATE_FRAME' }] } });
if (mode === 'result-before-exit') await new Promise(resolve => setTimeout(resolve, 250));
