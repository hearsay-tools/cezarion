#!/usr/bin/env node
// Load only when configured: ordinary mock turns retain their event-loop ordering.
const failureControl = process.env.CEZ_MOCK_FAILURE_CONTROL === undefined ? undefined
  : (await import('./mock-failure-control.mjs')).readFailureControl(['provider', 'usage-limit', 'unread']);
// Claude acknowledges agent input with the local stdin write, so only a held response is native.
const delivery = process.env.CEZ_MOCK_DELIVERY_CONTROL === undefined ? undefined
  : (await import('./mock-delivery-control.mjs')).readDeliveryControl(['hold-response']);
// Keep this fixture standalone: lifecycle tests copy the runner into a temp directory.
import { spawn as watchdogSpawn } from 'node:child_process';
import { closeSync as watchdogCloseInput, renameSync as watchdogRename, writeFileSync as watchdogWrite } from 'node:fs';
// Publish a pid atomically (temporary sibling, then rename): a test reading it sees no
// file or a whole pid, never the empty file whose Number() is 0 (hearsay-tools/cezarion#953).
function watchdogWritePid(file, pid) { const tmp = `${file}.${process.pid}.tmp`; watchdogWrite(tmp, pid); watchdogRename(tmp, file); }
function watchdogStall(prompt) {
  if (!prompt.includes('mock:no-progress')) return false;
  if (prompt.includes('input-closed')) {
    watchdogCloseInput(0);
    watchdogWritePid('input-closed.pid', String(process.pid));
    setTimeout(() => process.exit(0), 300);
  }
  if (prompt.includes('ignore-term')) {
    process.removeAllListeners('SIGTERM');
    process.on('SIGTERM', () => {});
    // Test-cleanup backstop, deliberately longer than the asserted teardown bound.
    setTimeout(() => process.exit(0), 12_000);
  }
  if (prompt.includes('held-pipe')) {
    watchdogSpawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { stdio: ['ignore', process.stdout, process.stderr] });
  }
  if (prompt.includes('leftover')) {
    // hearsay-tools/cezarion#890: one child stays in the session's process group and ignores
    // SIGTERM; one leaves the group with setsid. Both exit on their own as a cleanup backstop.
    const leftover = (file) => `process.on('SIGTERM',()=>{}); const fs = require('fs'); fs.writeFileSync(${JSON.stringify(`${file}.tmp`)}, String(process.pid)); fs.renameSync(${JSON.stringify(`${file}.tmp`)}, ${JSON.stringify(file)}); setTimeout(()=>{},20000)`;
    watchdogSpawn(process.execPath, ['-e', leftover('leftover-group.pid')], { stdio: 'ignore' });
    watchdogSpawn(process.execPath, ['-e', leftover('leftover-session.pid')], { stdio: 'ignore', detached: true }).unref();
  }
  // Publish readiness after mode setup: another process may signal us as soon as it sees it.
  watchdogWritePid('watchdog.pid', String(process.pid));
  return true;
}

// Mock `claude` binary for CEZ_DRY_RUN=1 — emits a plausible stream-json
// session so the engine / store / GUI can be exercised without tokens.
// Mirrors the real CLI's contract in SESSION mode: keeps reading {type:user}
// NDJSON lines from stdin, answers each with a scripted turn (assistant
// events + a terminal `result`), and exits when stdin closes (EOF).

import { createInterface } from 'node:readline';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
// Dynamic, like every sibling import here, so a test's copy of this mock can repoint it.
const { answerNudge, silentNudge } = await import('./mock-nudge.mjs');

import * as parityGateFs from 'node:fs';
import { withoutSessionContext } from './mock-session-context.mjs';
async function waitForMockRelease(fallbackMs) {
  const file = process.env.CEZ_MOCK_RELEASE_FILE;
  if (!file) { if (fallbackMs) await sleep(fallbackMs); return; }
  const deadline = Date.now() + 15_000;
  while (!parityGateFs.existsSync(file)) {
    if (Date.now() > deadline) throw new Error('CEZ_MOCK_RELEASE_FILE was not created');
    await sleep(10);
  }
}

// #401: let the test observe the actual monitoring park before releasing late wire frames.
async function afterParityPark(prompt) {
  const gate = /parity-release=([^\s"\\]+)/.exec(prompt)?.[1];
  if (!gate) throw new Error('post-park scenario requires a release path');
  while (!parityGateFs.existsSync(gate)) await new Promise(resolve => setTimeout(resolve, 10));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// hearsay-tools/cezarion#2397: a reply that finishes, asks or waits calls that cezar tool over
// the session's MCP config before its turn ends. Returns '' or a failure note for the text.
const tools = () => import('./mock-ci-tool.mjs');
async function lifecycle(call) {
  return (await tools()).lifecycleCall('claude', process.argv.slice(2), ...call);
}
/** Leave a visible trace in the cwd (the task worktree under spec 006) so
 *  the Diff view has something real to show in dry runs. Exactly one line
 *  per spawned session: tests read this file back as a per-step trace, so
 *  a multi-line prompt must not become multiple lines here. CEZ_MOCK_NOTES=0 leaves the
 *  worktree clean, so a suite that never reads it pays no autosave commit (hearsay-tools/cezarion#1665). */
function writeNotesTrace(userText) {
  if (process.env.CEZ_MOCK_NOTES === '0') return;
  try {
    const head = userText.replace(/\s+/g, ' ').trim().slice(0, 400);
    appendFileSync('notes.md', `mock notes — ${new Date().toISOString()}: ${head}\n`);
  } catch {
    // read-only cwd — the mock still works, just without a diff
  }
}
// `mock:steer-tool` holds its tool call for CEZ_MOCK_STEER_MS, or, with CEZ_MOCK_STEER_LINES=<n>,
// until it has read n steered lines, so a loaded host cannot close the turn first (hearsay-tools/cezarion#1280).
async function holdSteerTool() {
  const lines = Number(process.env.CEZ_MOCK_STEER_LINES ?? 0);
  if (!lines) { await sleep(Number(process.env.CEZ_MOCK_STEER_MS ?? 600)); return; }
  const deadline = Date.now() + 15_000;
  while (steering.length < lines) {
    if (Date.now() > deadline) throw new Error(`CEZ_MOCK_STEER_LINES: ${steering.length} of ${lines} steered lines arrived`);
    await sleep(10);
  }
}
// Lines a `mock:ack-only` reply read and never answered (hearsay-tools/cezarion#1301): the turn they
// opened is still running, so the next turn's result settles them with its own, as Claude settles
// every line one turn consumed (#505).
let heldUuids = [];
let respondingUuid;
const emit = (obj) => {
  if (obj?.type === 'result' && heldUuids.length) obj = { ...obj, user_message_uuids: [...heldUuids.splice(0), ...(obj.user_message_uuids ?? [respondingUuid].filter(Boolean))] };
  process.stdout.write(`${JSON.stringify(obj)}\n`);
};

// `--help` lists the options cezar feature-detects (#505).
if (process.argv.includes('--help')) {
  process.stdout.write('Usage: claude [options]\n  --input-format <format>\n  --replay-user-messages  Re-emit user messages from stdin back on stdout\n  --include-hook-events  Include all hook lifecycle events in the output stream\n');
  process.exit(0);
}

// Testability hook: CEZ_MOCK_ARGS_FILE=<path> appends the argv this mock was
// spawned with (one JSON array per line), so tests and dry-run proofs can
// assert exactly what reached the CLI (e.g. `--append-system-prompt …`).
if (process.env.CEZ_MOCK_ARGS_FILE) {
  try {
    appendFileSync(process.env.CEZ_MOCK_ARGS_FILE, `${JSON.stringify(process.argv.slice(2))}\n`);
  } catch {
    // best effort — never break the mock over the hook
  }
}

if (process.env.CEZ_MOCK_CI_PR) { const { probeCiTool } = await import('./mock-ci-tool.mjs'); await probeCiTool('claude', process.argv.slice(2)); }
emit({ type: 'system', subtype: 'init' });

let turn = 0;
let resumeAfterAsk = false;
// #505: `--replay-user-messages` echoes each stdin line when the model consumes it.
const replay = process.argv.includes('--replay-user-messages') && process.env.CEZ_MOCK_CLAUDE_NO_REPLAY !== '1';
const emitReplay = (uuid, text) => {
  if (replay && uuid) emit({ type: 'user', isReplay: true, uuid, message: { role: 'user', content: [{ type: 'text', text }] } });
};
// Non-null while a `mock:steer-tool` turn is inside its tool: later lines join that turn.
let steering = null;
let droppedOnce = false;

// A tiny generated PNG (320x200) standing in for a browser screenshot.
const MOCK_SCREENSHOT_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAUAAAADICAIAAAAWZq/8AAACMklEQVR42u3csQnAIBRFUQdJY+b4tfvP4AhCLKyyghAMMRw4Ezz/bU0RBdhUMgEIGBAwIGAQMCBgQMCAgEHAgIABAYOAAQEDAgYEDAIGBAwsCLhfDdiUgEHAgIABAYOAAQEDAgYEDAIGBAwIGAT8vlEr/ImAQcACBgELGAQsYAQsYBCwgEHAAgYBe3IELGAQsIBBwAJGwAIGAQsYBCxgELCAEbCAQcACBgELGAQMAhYwCFjAIGABI2D/QgMCBgEDAgYEDAgYBAwIGBAwCBgQMCBgQMAgYEDAgIBBwCYAAQMCBgQMAgYEDAgYEDAIGBAwIGAQMCBgQMCAgEHAgIABAQMCBgEDAgYEDAIGBAwIGBAwCBgQMCBgQMAgYEDAgIBBwICAAQEDAgYBAwIGBAwCtgIIGBAwIGAQMCBgQMCAgEHAgIABAYOAeejMB/McjIAFLGABW0HAAhYwmhSwgAUsYAQsYAELGAELWMACRsACFrCAEbCABSxgBCxgAQtYwAhYwAIWMAIWsIAFjIAFLGABI2ABC1jACFjAAhYwAhawgAWMgAUsYAEjYAELWMACRsACFrCAEbCABSxgBCxgAQsYAQtYwAJGwAIWMCBgQMAgYEDAgIBBwICAAQEDAgYBAwIGBAwCBgQMCBgQMAgYEDAgYEDAIGBAwICAQcCAgAEBAwIGAQMCBgQMCBgEDAgYEDAIGBAwIGBAwCBgQMCAgAEBg4ABAQMCBgEDAgYEDAgYBAx8xQ1bxBr9kelHqgAAAABJRU5ErkJggg==';

// Spec 007: behave like an agent that read the handoff instructions —
// append a progress line to CEZ_HANDOFF_FILE so handoff continuity is testable without tokens.
function writeHandoff() {
  try {
    const handoff = process.env.CEZ_HANDOFF_FILE;
    if (handoff) {
      const text = readFileSync(handoff, 'utf8');
      const line = `- ${new Date().toISOString()} — mock: implemented the change (dry run)\n`;
      const marker = '## Progress log\n';
      const idx = text.indexOf(marker);
      const next =
        idx >= 0
          ? text.slice(0, idx + marker.length) + '\n' + line + text.slice(idx + marker.length).replace(/^\n+/, '')
          : text + line;
      writeFileSync(handoff, next, 'utf8');
    }
  } catch {
    // best effort — the mock still answers without a handoff file
  }
}

async function respond(userText, imageCount, uuid) {
  respondingUuid = uuid;
  if (delivery) await delivery.holdResponse(userText);
  // Native refusal and crash handling stay before deferred input and replay.
  // hearsay-tools/cezarion#1351: native refusals before any model work.
  if (userText.startsWith('mock:model-refusal')) {
    const { modelRefusalReply } = await import('./mock-claude-model-refusal.mjs');
    await modelRefusalReply(userText, uuid, emit, emitReplay);
    return;
  }
  if (userText.includes('mock:crash-stderr')) {
    const { crashWithStderr } = await import('./mock-runner-crash.mjs');
    if (crashWithStderr(userText, '{"type":"assistant","message":')) return;
  }
  // hearsay-tools/cezarion#1112: the line waits in the pipe before the model reads it.
  if (userText.includes('mock:deferred-turn-start')) await (await import('./mock-deferred-turn-start.mjs')).deferredTurnStart();
  emitReplay(uuid, userText);
  // Early scenarios do not advance the ordinary turn counter.
  if (await dispatchReply(earlyReplies, userText, uuid)) return;
  turn += 1;
  const markers = await markersFor(userText);
  // `mock:slow` → hold the turn for ~25 s so queue states are observable.
  if (userText.includes('mock:slow')) await sleep(25_000);
  if (await dispatchReply(timedReplies, userText, uuid)) return;
  // Failure selection stays after timed holds and before markdown/naming.
  if (await replyWithNativeFailure(userText)) return;
  if (await dispatchReply(trailingReplies, userText, uuid)) return;
  if (userText.includes('mock:schedule-wakeup')) await replyWithScheduleWakeup(userText);
  if (turn === 1) { await replyWithFirstTurn(userText, markers); return; }
  await replyWithFollowup(userText, imageCount, markers);
}

// `mock:ack-only` → the line is read (replayed) and its turn says nothing until more input
// arrives (hearsay-tools/cezarion#1301).
async function acknowledgeOnly(userText, uuid) {
  if (uuid) heldUuids.push(uuid); return;
}

async function replyAutonomously(userText, uuid) {
  const { autonomousReply } = await import('./mock-autonomous.mjs');
  const text = await autonomousReply(userText, lifecycle);
  emit({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
  emit({ type: 'result', subtype: 'success', result: text, user_message_uuids: [uuid].filter(Boolean), usage: { input_tokens: 10, output_tokens: 5 } });
  return;
}

async function replyToFinalMessageNudge(silent, uuid) {
  const kind = silent.finalMessageNudgeKind();
  if (kind === 'ack-only') return;
  if (kind === 'late') await waitForMockRelease(silent.LATE_REPLY_MS);
  if (kind === 'silent') {
    emit({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking', thinking: silent.SILENT_TAIL_REASONING }] } });
    emit({ type: 'result', subtype: 'success', result: '', user_message_uuids: [uuid].filter(Boolean), usage: { input_tokens: 10, output_tokens: 5 } });
  } else {
    await replyWithFinalTailText(silent, uuid, kind);
  }
  return;
}

async function replyWithFinalTailText(silent, uuid, kind) {
  if (kind === 'slow-done') {
    emit({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: silent.SLOW_DONE_PREFIX }] } });
    await silent.sleep(silent.SLOW_DONE_TAIL_MS);
}
const text = await silent.finalNudgeText(kind, lifecycle);
emit({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
emit({ type: 'result', subtype: 'success', result: text, user_message_uuids: [uuid].filter(Boolean), usage: { input_tokens: 10, output_tokens: 5 } });
}

async function replyWithSilentTail(silent, uuid) {
  emit({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: silent.SILENT_TAIL_OPENING }] } });
  emit({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_silent_gh', name: 'Bash', input: { command: 'gh issue create' } }] } });
  emit({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_silent_gh', content: 'created' }] } });
  emit({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking', thinking: silent.SILENT_TAIL_REASONING }] } });
  emit({ type: 'result', subtype: 'success', result: silent.SILENT_TAIL_OPENING, user_message_uuids: [uuid].filter(Boolean), usage: { input_tokens: 20, output_tokens: 10 } });
  return;
}

async function replyWithToolTail(silent, uuid) {
  emit({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: silent.TOOL_TAIL_OPENING }] } });
  emit({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_tool_tail', name: 'Bash', input: { command: 'git status --short' } }] } });
  emit({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_tool_tail', content: ' M src/example.ts' }] } });
  emit({ type: 'result', subtype: 'success', result: silent.TOOL_TAIL_OPENING, user_message_uuids: [uuid].filter(Boolean), usage: { input_tokens: 20, output_tokens: 10 } });
  return;
}

async function replyToSilentTail(userText, uuid) {
  const silent = await import('./mock-silent-tail.mjs');
  silent.noteSilentTailPrompt(userText);
  const scenarios = [
    [() => silent.isFinalMessageNudge(userText), replyToFinalMessageNudge],
    [() => silent.isSilentTailScenario(userText), replyWithSilentTail],
    [() => silent.isToolTailScenario(userText), replyWithToolTail]
  ];
  for (const [matches, reply] of scenarios) {
    if (matches()) { await reply(silent, uuid); return; }
  }
  return false;
}

// `mock:steer-tool` → one tool call; lines written while it runs are consumed after
// it (replayed with their uuid) and settled by the SAME result, like Claude 2.1.280 (#505).
async function replyToSteering(userText, uuid) {
  steering = [];
  emit({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_steer', name: 'Bash', input: { command: 'wait' } }] } });
  await holdSteerTool();
  const steered = steering; steering = null;
  emit({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_steer', content: 'waited' }] } });
  for (const s of steered) emitReplay(s.uuid, s.userText);
  const text = ['steer tool done', ...steered.map(s => `saw: ${s.userText}`)].join('\n');
  emit({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
  emit({ type: 'result', subtype: 'success', result: text, user_message_uuids: [uuid, ...steered.map(s => s.uuid)].filter(Boolean), usage: { input_tokens: 20, output_tokens: 10 } });
  return;
}

// #961: hook_response frames as `--include-hook-events` emits them (CLI 2.1.301) — one
// mid-turn, one after the run parked (Squeal's async `waiter` completes this late).
async function replyWithParkedHook(userText, uuid) {
  const hook = (id, event, text) => ({
    type: 'system', subtype: 'hook_response', hook_id: `hook-${id}-${turn}`, hook_name: event, hook_event: event,
    stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: text } }), stderr: '', exit_code: 0, outcome: 'success',
  });
  emit(hook('mid', 'PostToolBatch', 'Mid-turn hook context.'));
  const watching = 'Watching.' + await lifecycle((await tools()).wait());
  emit({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: watching }] } });
  emit({ type: 'result', subtype: 'success', result: watching, usage: { input_tokens: 10, output_tokens: 5 } });
  await afterParityPark(userText);
  emit(hook('late', 'Stop', 'Late hook processed.'));
  return;
}

// Native child attribution from __fixtures__/claude/subagent-task.ndjson.
async function replyWithParkedChild(userText, uuid) {
  const task = `toolu_park_${turn}`;
  emit({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: task, name: 'Task', input: { description: 'Review' } }] } });
  const watching = 'Watching the child.' + await lifecycle((await tools()).wait());
  emit({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: watching }] } });
  emit({ type: 'result', subtype: 'success', result: watching, usage: { input_tokens: 10, output_tokens: 5 } });
  await afterParityPark(userText);
  emit({ type: 'assistant', parent_tool_use_id: task, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'late-read', name: 'Read', input: { file_path: 'README.md' } }] } });
  emit({ type: 'user', parent_tool_use_id: task, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'late-read', content: 'Read the file.' }] } });
  emit({ type: 'assistant', parent_tool_use_id: task, message: { role: 'assistant', content: [{ type: 'text', text: 'Post-park child update processed.' }] } });
  return;
}

// hearsay-tools/cezarion#1284: a `context: fork` skill through the Skill tool, from
// __fixtures__/claude/forked-skill.ndjson (CLI 2.1.303). Real Claude starts the fork
// whatever --disallowedTools denies, so this branch ignores the argv too.
async function replyWithForkedSkill(userText, uuid) {
  const skill = `toolu_skill_fork_${turn}`;
  const bash = `toolu_fork_bash_${turn}`;
  const task = { task_id: `a1284f0000000f0a${turn}`, tool_use_id: skill };
  const child = { parent_tool_use_id: skill, agent_id: task.task_id, subagent_type: 'general-purpose' };
  const text = 'The fxfork skill returned: `FXFORK-2W`';
  emit({ type: 'assistant', parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'tool_use', id: skill, name: 'Skill', input: { skill: 'fxfork' } }] } });
  emit({ type: 'system', subtype: 'task_started', ...task, description: '/fxfork', subagent_type: 'general-purpose', spawn_depth: 1, task_type: 'local_agent' });
  emit({ type: 'user', ...child, message: { role: 'user', content: [{ type: 'text', text: 'Run the shell command `echo forked > /dev/null` and reply with exactly FXFORK-2W.' }] } });
  emit({ type: 'assistant', ...child, message: { role: 'assistant', content: [{ type: 'tool_use', id: bash, name: 'Bash', input: { command: 'echo forked > /dev/null' } }] } });
  emit({ type: 'user', ...child, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: bash, content: '(Bash completed with no output)', is_error: false }] } });
  emit({ type: 'system', subtype: 'task_notification', ...task, status: 'completed', summary: '/fxfork' });
  emit({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: skill, content: 'Skill "fxfork" completed (forked execution).\n\nResult:\nFXFORK-2W' }] } });
  emit({ type: 'assistant', parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'text', text }] } });
  emit({ type: 'result', subtype: 'success', result: text, usage: { input_tokens: 10, output_tokens: 5 } });
  return;
}

// #401: result-only full text; mapResult and v1 use the same fallback.
async function replyWithMultiplePrs(userText, uuid) {
  const { multiPrText, unrelatedPr } = await import('./mock-multi-pr.mjs');
  emit({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'multi-read', name: 'Read', input: { file_path: 'other.txt' } }] } });
  emit({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'multi-read', content: unrelatedPr }] } });
  emit({ type: 'assistant', parent_tool_use_id: 'multi-read', message: { role: 'assistant', content: [{ type: 'text', text: unrelatedPr }] } });
  emit({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking', thinking: unrelatedPr }] } });
  const text = await multiPrText(userText, lifecycle);
  for (const block of text.split('\n')) emit({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: block }] } });
  emit({ type: 'result', subtype: 'success', result: text, usage: { input_tokens: 10, output_tokens: 5 } });
  return;
}

async function replyWithTurnMessages(userText, uuid) {
  const { turnMessages } = await import('./mock-turn-messages.mjs');
  const messages = turnMessages(userText);
  for (const text of messages) emit({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
  emit({ type: 'result', subtype: 'success', result: messages.join('\n'), usage: { input_tokens: 10, output_tokens: 5 } });
  return;
}

/** The reply text a mock-ci-tool prompt helper makes over this session's real tool wire. */
async function replyWithToolText(helper, userText) {
  const text = await (await import('./mock-ci-tool.mjs'))[helper]('claude', process.argv.slice(2), userText);
  emit({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
  emit({ type: 'result', subtype: 'success', result: text, usage: { input_tokens: 20, output_tokens: 10 } });
}

const replyWithCezarTool = (userText) => replyWithToolText('toolPrompt', userText);

const replyWithCiWait = (userText) => replyWithToolText('ciPrompt', userText);

const replyWithPreview = (userText) => replyWithToolText('previewPrompt', userText);

// Same assistant/result envelopes as the baseline stream-json fixture.
async function replyWithEcho(userText, uuid) {
  emit({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: userText }] } });
  emit({ type: 'result', subtype: 'success', result: userText, usage: { input_tokens: 20, output_tokens: 10 } });
  return;
}

async function acknowledgeStall(userText, uuid) {
}

async function replyWithBusyProgress(userText, uuid) {
  for (let i = 0; i < 24; i++) { emit({ type: 'ping' }); await sleep(100); }
  const busy = 'busy complete' + await lifecycle((await tools()).DONE);
  emit({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: busy }], usage: { input_tokens: 20, output_tokens: 10 } } });
  emit({ type: 'result', subtype: 'success', result: busy });
  return;
}

async function replyWithHeldDone(userText, uuid) {
  await waitForMockRelease(400);
  const held = 'parity hold-done: content after the pause' + await lifecycle((await tools()).DONE);
  emit({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: held }], usage: { input_tokens: 20, output_tokens: 10 } },
  });
  emit({ type: 'result', subtype: 'success', result: held, usage: { input_tokens: 20, output_tokens: 10 }, total_cost_usd: 0.0001 });
  return;
}

async function replyWithHeldAsk(userText, uuid) {
  await waitForMockRelease(400);
  const ask = 'Pick one.' + await lifecycle((await tools()).ask());
  emit({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: ask }], usage: { input_tokens: 20, output_tokens: 10 } },
  });
  emit({ type: 'result', subtype: 'success', result: ask, usage: { input_tokens: 20, output_tokens: 10 }, total_cost_usd: 0.0001 });
  return;
}

async function replyWithGatedHold(userText, uuid) {
  await waitForMockRelease(250);
  const gated = 'parity hold-gated: content after the pause';
  emit({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: gated }], usage: { input_tokens: 20, output_tokens: 10 } },
  });
  await sleep(250);
  emit({ type: 'result', subtype: 'success', result: gated, usage: { input_tokens: 20, output_tokens: 10 }, total_cost_usd: 0.0001 });
  return;
}

// `mock:hold` → pause, THEN stream the content and the terminal `result`.
// The harness parity matrix's S2 row asserts turn-end follows the last
// content event, so the pause has to sit BEFORE the content: a runner that
// closed the turn on a timer after writing the prompt would report it early.
async function replyWithHold(userText, uuid) {
  // Short on purpose — `mock:slow` above is the 25 s queue-state hold.
  await sleep(250);
  const held = 'parity hold: content after the pause';
  emit({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: held }], usage: { input_tokens: 20, output_tokens: 10 } },
  });
  await sleep(250);
  emit({ type: 'result', subtype: 'success', result: held, usage: { input_tokens: 20, output_tokens: 10 }, total_cost_usd: 0.0001 });
  return;
}

// `mock:md` → answer with a markdown-rich reply (#346 QA: tables, nested
// lists, emphasis, fences, quotes) instead of the scripted turn.
async function replyWithMarkdown(userText, uuid) {
  const md = [
    '## Markdown fixture',
    'This paragraph is soft-wrapped\nacross two source lines.',
    '',
    '| Column | Align | Result |',
    '|:-------|:-----:|-------:|',
    '| left `code` | *center* | **42** |',
    '| ~~old~~ new | mid | $1.50 |',
    '',
    '- top item with *emphasis*',
    '  - nested child with `code`',
    '    - [x] deep done task',
    '  - [ ] nested todo',
    '- second top',
    '',
    '> quoted intro',
    '> - quoted list item',
    '',
    '```ts',
    'const answer: number = 42;',
    '```',
    'Literal guards: snake_case_name, 2*3 and <script>alert(1)</script>.',
  ].join('\n');
  emit({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: md }], usage: { input_tokens: 100, output_tokens: 200 } },
  });
  emit({ type: 'result', subtype: 'success', result: md, usage: { input_tokens: 100, output_tokens: 200 }, total_cost_usd: 0.001 });
  return;
}

// `mock:subagents` → a parallel fan-out: two `Task` spawns whose child items
// carry `parent_tool_use_id`, interleaved the way a real fan-out interleaves,
// then their results. Makes the Agents dock and its drill-down sheet reachable
// under CEZ_DRY_RUN=1 for QA, screenshots and the e2e smoke (spec
// `.ai/specs/2026-07-20-grouped-subagent-display.md` §"Testability hook", #474).
// Derived from the `subagent-task.ndjson` golden fixture's wire shape.
async function replyWithSubagents(userText, uuid) {
  const agents = [
    {
      id: `toolu_task_a_${turn}`,
      description: 'Audit the auth flow',
      subagent_type: 'general-purpose',
      steps: [
        { text: 'Scanning the auth middleware.' },
        { tool: 'Grep', id: `toolu_sub_a1_${turn}`, input: { pattern: 'session', path: 'src' }, result: 'src/middleware.ts:12:  clearSession()' },
        { tool: 'Read', id: `toolu_sub_a2_${turn}`, input: { file_path: 'src/middleware.ts' }, result: 'export function middleware() { clearSession() }' },
      ],
      result: 'The session cookie is dropped in src/middleware.ts:12 (clearSession on every redirect).',
    },
    {
      id: `toolu_task_b_${turn}`,
      description: 'Review the store layer',
      subagent_type: 'code-reviewer',
      steps: [
        { text: 'Reading the runs store.' },
        { tool: 'Bash', id: `toolu_sub_b1_${turn}`, input: { command: 'npm test -- runs/store' }, result: '12 passed' },
      ],
      result: 'Store layer looks correct; one debounce edge case worth a follow-up.',
    },
  ];
  await replyWithSubagentSpawns(agents);
  await replyWithSubagentSteps(agents);
  await replyWithSubagentResults(agents);
  const summary = 'Both sub-agents reported back: the redirect drops the cookie in src/middleware.ts:12, and the store layer is clean. (dry-run mock)'
    + await lifecycle((await tools()).wait('Re-check the sub-agents.'));
  emit({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: summary }], usage: { input_tokens: 400, output_tokens: 60 } },
    parent_tool_use_id: null,
  });
  // #149: a child assistant frame can arrive after the parent's final message.
  emit({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: 'Child review finished.' }] },
    parent_tool_use_id: agents[0].id,
  });
  await sleep(150);
  emit({
    type: 'result',
    subtype: 'success',
    result: summary,
    usage: { input_tokens: 2100, output_tokens: 380 },
    total_cost_usd: 0.0512,
  });
  return;
}

// Both spawns first — that is what makes it a FAN-OUT rather than two
// sequential agents, and what the dock's "N/M" odometer counts.
async function replyWithSubagentSpawns(agents) {
  for (const agent of agents) {
    emit({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: agent.id,
            name: 'Task',
            input: { description: agent.description, prompt: `${agent.description}.`, subagent_type: agent.subagent_type },
          },
        ],
        usage: { input_tokens: 900, output_tokens: 95 },
      },
      parent_tool_use_id: null,
    });
    await sleep(200);
  }
}

// Children, interleaved across agents so the activity lines visibly race.
async function replyWithSubagentSteps(agents) {
  const maxSteps = Math.max(...agents.map((agent) => agent.steps.length));
  for (let i = 0; i < maxSteps; i += 1) {
    for (const agent of agents) {
      const step = agent.steps[i];
      if (!step) continue;
      await replyWithSubagentStep(agent, step);
    }
  }
}

async function replyWithSubagentStep(agent, step) {
  if (step.text !== undefined) {
    emit({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: step.text }], usage: { input_tokens: 300, output_tokens: 25 } },
      parent_tool_use_id: agent.id,
    });
  } else {
    emit({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: step.id, name: step.tool, input: step.input }],
        usage: { input_tokens: 40, output_tokens: 50 },
      },
      parent_tool_use_id: agent.id,
    });
    await sleep(250);
    emit({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: step.id, content: step.result }] },
      parent_tool_use_id: agent.id,
    });
  }
  await sleep(250);
}

// The spawns settle — `parent_tool_use_id: null`, they belong to the main turn.
async function replyWithSubagentResults(agents) {
  for (const agent of agents) {
    emit({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: agent.id, content: agent.result }] },
      parent_tool_use_id: null,
    });
    await sleep(200);
  }
}

// Task auto-naming spec: a naming call (marked `[cez-namer]`) answers a
// deterministic short title + a PR classification of the sample number so
// dry-run tests can assert the full apply pipeline.
async function replyWithName(userText, uuid) {
  const numbered = /(?:^|\D)(\d{1,7})(?:\D|$)/.exec(userText);
  const name = JSON.stringify({
    title: 'implementing cr fixes',
    ...(numbered ? { pr: Number(numbered[1]) } : {}),
  });
  emit({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: name }],
      usage: { input_tokens: 200, output_tokens: 30 },
    },
  });
  emit({
    type: 'result',
    subtype: 'success',
    result: name,
    usage: { input_tokens: 200, output_tokens: 30 },
    total_cost_usd: 0.0002,
  });
  return;
}

// Spec 008: a planning call (marked `[cez-planner]` in the user prompt)
// gets a canned chain plan. The `code-review` skill is deliberately made up:
// the planner's sanitizer strips unknown skills, and the step survives on
// its prompt — which is exactly the path worth exercising in dry runs.
async function replyWithPlan(userText, uuid) {
  const plan = JSON.stringify({
    title: 'implement-verify-review',
    steps: [
      { name: 'Implement', prompt: '{{task}}' },
      { name: 'Verify', command: 'npm test' },
      { name: 'Review', skill: 'code-review', prompt: 'Review the changes for {{task}}' },
    ],
    rationale: 'Implement, verify with tests, then review.',
  });
  emit({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: plan }],
      usage: { input_tokens: 500, output_tokens: 120 },
    },
  });
  emit({
    type: 'result',
    subtype: 'success',
    result: plan,
    usage: { input_tokens: 500, output_tokens: 120 },
    total_cost_usd: 0.0011,
  });
  return;
}

// `mock:schedule-wakeup` → Claude's native park tool, without also calling
// cezar_wait. The workflow engine must recognize the completed turn's
// native tool use (#46).
// `mock:schedule-wakeup:<n>` sends the tool's `delaySeconds` (hearsay-tools/cezarion#1233).
async function replyWithScheduleWakeup(userText, uuid) {
  const id = `toolu_schedule_wakeup_${turn}`;
  const seconds = /mock:schedule-wakeup:(\d+)/.exec(userText)?.[1];
  emit({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id, name: 'ScheduleWakeup', input: seconds ? { delaySeconds: Number(seconds) } : { delay: '5m' } }],
      usage: { input_tokens: 40, output_tokens: 20 },
    },
  });
  emit({
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: id, content: 'Wakeup scheduled.' }],
    },
  });
}

async function replyWithFirstTurn(userText, { refsMarkers, calls }) {
  writeNotesTrace(userText);
  writeHandoff();
  emit({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: `Okay — looking into: ${userText.slice(0, 120)}` }],
      usage: { input_tokens: 850, output_tokens: 40 },
    },
  });
  emit({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id: `toolu_mock_${turn}`, name: 'Bash', input: { command: 'git status --short' } }],
      usage: { input_tokens: 120, output_tokens: 55 },
    },
  });
  emit({
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: `toolu_mock_${turn}`, content: ' M src/example.ts' }],
    },
  });
  // Agent screenshot in a tool result — exercises the image pipeline
  // (persist to <id>-images/, serve via /api/runs/:id/images/, zoomable
  // card + lightbox in the transcript).
  emit({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id: `toolu_mock_shot_${turn}`, name: 'Screenshot', input: { name: 'repro-login-redirect.png' } }],
      usage: { input_tokens: 80, output_tokens: 30 },
    },
  });
  emit({
    type: 'user',
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: `toolu_mock_shot_${turn}`,
          content: [
            { type: 'text', text: 'Repro captured: after reload the session toast appears and you are back on /login.' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: MOCK_SCREENSHOT_B64 } },
          ],
        },
      ],
    },
  });
  emit({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: `Done with the first pass — opened a draft PR: https://github.com/open-mercato/demo/pull/123. Anything to adjust? (dry-run mock)${refsMarkers}${await runCalls(calls)}` }],
      usage: { input_tokens: 300, output_tokens: 90 },
    },
  });
  emit({
    type: 'result',
    subtype: 'success',
    result: 'Done with the first pass (dry run).',
    usage: { input_tokens: 1270, output_tokens: 185 },
    total_cost_usd: 0.0342,
  });
  return;
}

async function replyWithFollowup(userText, imageCount, { refsMarkers, calls }) {
  const imgNote = imageCount > 0 ? ` I can see ${imageCount} image(s) you attached.` : '';
  const notes = await runCalls(calls);
  emit({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: `Follow-up #${turn - 1} received: "${userText.slice(0, 100)}".${imgNote} Applied (dry run).${refsMarkers}${notes}` }],
      usage: { input_tokens: 200, output_tokens: 60 },
    },
  });
  emit({
    type: 'result',
    subtype: 'success',
    result: `Follow-up #${turn - 1} handled (dry run).`,
    usage: { input_tokens: 200, output_tokens: 60 },
    total_cost_usd: 0.0051,
  });
}

// Mirrors the real Claude Code 2.1.148 revoked-token envelope: the CLI puts
// the credential failure in an `is_error` result even though its subtype is
// `success`, rather than emitting a dedicated error frame.
async function replyWithAuthenticationFailure(userText, uuid) {
  emit({
    type: 'result',
    subtype: 'success',
    is_error: true,
    result: 'Failed to authenticate. API Error: 401 OAuth access token has been revoked.',
    usage: { input_tokens: 0, output_tokens: 0 },
    total_cost_usd: 0,
  });
  return;
}

// `mock:limit` → the envelope Claude Code emits when the subscription window is
// exhausted: an `is_error` result whose text is the machine-readable
// `Claude AI usage limit reached|<epoch seconds>` marker. Makes the auto-resume path
// (spec 2026-08-03-auto-resume-after-usage-limit) reachable under CEZ_DRY_RUN=1 for QA and
// the e2e smoke. `CEZ_MOCK_LIMIT_RESET_SECONDS` moves the reset instant (default 60 s out),
// so a dry run can actually watch the resume fire instead of reading about it.
async function replyWithUsageLimit(userText, uuid) {
  const configured = Number(process.env.CEZ_MOCK_LIMIT_RESET_SECONDS ?? '60');
  const seconds = Number.isFinite(configured) ? configured : 60;
  emit({
    type: 'result',
    subtype: 'success',
    is_error: true,
    result: `Claude AI usage limit reached|${Math.floor(Date.now() / 1000) + seconds}`,
    usage: { input_tokens: 0, output_tokens: 0 },
    total_cost_usd: 0,
  });
  return;
}

async function replyWithNativeFailure(userText) {
  const selectedFailure = failureControl?.failureFor(userText);
  const nativeFailure = selectedFailure instanceof Promise ? await selectedFailure : selectedFailure;
  if (nativeFailure === 'unread') process.exit(1);
  if (failureControl?.failure === 'provider' ? nativeFailure === 'provider' : userText.includes('mock:auth-error')) { await replyWithAuthenticationFailure(); return true; }
  if (failureControl?.failure === 'usage-limit' ? nativeFailure === 'usage-limit' : userText.includes('mock:limit')) { await replyWithUsageLimit(); return true; }
  return false;
}

const MULTI_QUESTIONS = [
  { header: 'Library', question: 'Which test library?', options: [{ label: 'Vitest' }, { label: 'Node test' }] },
  { header: 'Build', question: 'Which build tool?', options: [{ label: 'Vite' }, { label: 'Webpack' }] },
];
const DATE_QUESTIONS = [{
  header: 'Library',
  question: 'Which date library should I standardize on?',
  options: [
    { label: 'date-fns', description: 'Tree-shakeable, functional' },
    { label: 'Luxon', description: 'Immutable, tz-aware' },
  ],
}];

/** The cezar tool calls a reply makes, in order, before its final text. */
async function runCalls(calls) {
  let notes = '';
  for (const call of calls) notes += await lifecycle(call);
  return notes;
}

// hearsay-tools/cezarion#2397: the lifecycle scenarios call the cezar tool, then end the turn.
// `mock:cezar-done` anywhere in the message → the reply calls cezar_done, so the auto-close
// path is testable dry (#347).
// `mock:cezar-wait` → the reply opens a 60 s timer wait with cezar_wait, the "still working on
// downstream work" park (#490).
// `mock:cezar-ask` → the reply asks with cezar_ask (#473), so the AskUser card path (park
// `waiting` + emit `ask.requested`) is testable dry.
// `mock:multi-cezar-ask` → ONE cezar_ask with two questions (Library, Build), for the
// voice-mode E2E (spec 2026-10-21-voice-mode).
// `mock:cezar-ask mock:resume-cezar-done` → the answer `Library: Vitest` then calls cezar_done.
// `mock:refs` → the reply carries the in-band task-reference markers
// (spec 2026-07-18-task-ref-markers), so the declaration path is testable dry.
async function markersFor(userText) {
  const answered = resumeAfterAsk && userText.trim() === 'Library: Vitest';
  resumeAfterAsk = userText.includes('mock:cezar-ask') && userText.includes('mock:resume-cezar-done');
  const calls = [];
  // Loaded only for a lifecycle scenario: ordinary turns keep their timing.
  const { DONE, wait, ask } = /mock:(cezar-|multi-cezar-)/.test(userText) || answered ? await tools() : {};
  if (userText.includes('mock:cezar-done') || answered) calls.push(DONE);
  if (userText.includes('mock:cezar-wait')) calls.push(wait());
  if (userText.includes('mock:multi-cezar-ask')) calls.push(ask(MULTI_QUESTIONS));
  else if (userText.includes('mock:cezar-ask')) calls.push(ask(DATE_QUESTIONS, 'Pick a date library before I continue.'));
  const refsMarkers = userText.includes('mock:refs')
    ? '\nCEZ:PR=4242\nCEZ:ISSUE=17\nCEZ:TITLE=implementing marker refs'
    : '';
  return { calls, refsMarkers };
}

// Ordered matchers preserve scenario priority and the silent-tail fall-through.
const earlyReplies = [
  [userText => userText.includes('mock:ack-only'), acknowledgeOnly],
  [userText => userText.includes('mock:autonomous') || userText.startsWith('Continue working autonomously until the task is fully complete.'), replyAutonomously],
  [userText => userText.includes('mock:silent-tail') || userText.includes('mock:tool-tail') || silentNudge(userText), replyToSilentTail],
  [userText => userText.includes('mock:steer-tool'), replyToSteering],
  [userText => !userText.includes('[cez-namer]') && userText.includes('mock:hook-after-park'), replyWithParkedHook],
  [userText => !userText.includes('[cez-namer]') && userText.includes('mock:subagent-after-park'), replyWithParkedChild],
  [userText => !userText.includes('[cez-namer]') && userText.includes('mock:forked-skill'), replyWithForkedSkill],
  [userText => userText.includes('mock:multi-pr-refs'), replyWithMultiplePrs],
  [userText => userText.includes('mock:turn-messages:'), replyWithTurnMessages],
  [userText => !userText.includes('[cez-namer]') && userText.includes('mock:cezar-tool'), replyWithCezarTool],
  [userText => userText.includes('mock:ci-wait'), replyWithCiWait],
  [userText => !userText.includes('[cez-namer]') && userText.includes('mock:preview-serve'), replyWithPreview]
];
const timedReplies = [
  [userText => userText.includes('mock:agent-echo'), replyWithEcho],
  [watchdogStall, acknowledgeStall],
  [userText => userText.includes('mock:busy-progress'), replyWithBusyProgress],
  [userText => userText.includes('mock:hold-cezar-done'), replyWithHeldDone],
  [userText => userText.includes('mock:hold-cezar-ask'), replyWithHeldAsk],
  [userText => userText.includes('mock:hold-gated'), replyWithGatedHold],
  [userText => userText.includes('mock:hold'), replyWithHold]
];
const trailingReplies = [
  [userText => userText.includes('mock:md'), replyWithMarkdown],
  [userText => userText.includes('mock:subagents'), replyWithSubagents],
  [userText => userText.includes('[cez-namer]'), replyWithName],
  [userText => userText.includes('[cez-planner]'), replyWithPlan]
];
async function dispatchReply(scenarios, userText, uuid) {
  for (const [matches, reply] of scenarios) {
    if (matches(userText) && await reply(userText, uuid) !== false) return true;
  }
  return false;
}

const rl = createInterface({ input: process.stdin });
let queue = Promise.resolve();
rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let userText = '(unparseable message)';
  let imageCount = 0;
  let uuid;
  try {
    const msg = JSON.parse(trimmed);
    if (msg.type === 'control_request' && msg.request?.subtype === 'list_models') {
      process.stdout.write(`${JSON.stringify({
        type: 'control_response',
        response: {
          subtype: 'success', request_id: msg.request_id,
          response: { models: ['opus', 'sonnet', 'haiku'].map(value => ({ value, displayName: value })) },
        },
      })}\n`);
      return;
    }
    uuid = typeof msg.uuid === 'string' ? msg.uuid : undefined;
    const blocks = msg?.message?.content ?? [];
    userText = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n') || '(no text)';
    imageCount = blocks.filter((b) => b.type === 'image').length;
  } catch {
    // keep placeholders
  }
  // Testability hook: CEZ_MOCK_STDIN_FILE=<path> appends the FULL inbound
  // text + image count (one JSON object per line) — the scripted replies
  // below only echo a truncated slice, so tests asserting exact wiring (e.g.
  // #357's pasted-attachment path note in the prompt) need the untruncated
  // text this hook captures.
  if (process.env.CEZ_MOCK_STDIN_FILE) {
    try {
      appendFileSync(process.env.CEZ_MOCK_STDIN_FILE, `${JSON.stringify({ userText, imageCount })}\n`);
    } catch {
      // best effort — never break the mock over the hook
    }
  }
  // #505 liveness tests: silently drop a matching line (a harness that accepted input
  // and never runs it). CEZ_MOCK_DROP_ONCE=1 drops only the first match.
  const drop = process.env.CEZ_MOCK_DROP_LINES;
  if (drop && userText.includes(drop) && !(process.env.CEZ_MOCK_DROP_ONCE === '1' && droppedOnce)) { droppedOnce = true; return; }
  userText = answerNudge(withoutSessionContext(userText));
  if (steering) { steering.push({ userText, uuid }); return; }
  queue = queue.then(() => respond(userText, imageCount, uuid));
});
rl.on('close', () => {
  // EOF = session over; finish any in-flight turn then exit cleanly.
  queue.then(() => process.exit(0));
});
